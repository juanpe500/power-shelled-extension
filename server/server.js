// chrome-terminal server — spawns persistent PowerShell PTYs and streams them
// to the Chrome side-panel extension over WebSocket. Bind is 127.0.0.1 only.
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

// MCP (served in-process at /mcp — the surface Claude Code talks to)
const { Server: McpServer } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const VERSION = '0.1.0';
const HOST = process.env.CT_HOST || '127.0.0.1';
const PORT = parseInt(process.env.CT_PORT || '3777', 10);
const MAX_BUF = 256 * 1024; // scrollback bytes kept per session for reattach

// ---- auth token ---------------------------------------------------------
const TOKEN_FILE = path.join(__dirname, '.token');
function loadToken() {
  if (process.env.CT_TOKEN) return process.env.CT_TOKEN;
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch (_) {}
  const t = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 }); } catch (_) {}
  return t;
}
const TOKEN = loadToken();

// ---- shell detection ----------------------------------------------------
function has(cmd) {
  try { execFileSync('where', [cmd], { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}
function detectShells() {
  const list = [];
  if (has('powershell.exe')) list.push({ id: 'powershell', label: 'Windows PowerShell', cmd: 'powershell.exe', args: ['-NoLogo'] });
  if (has('pwsh.exe')) list.push({ id: 'pwsh', label: 'PowerShell 7 (pwsh)', cmd: 'pwsh.exe', args: ['-NoLogo'] });
  if (has('cmd.exe')) list.push({ id: 'cmd', label: 'Command Prompt', cmd: 'cmd.exe', args: [] });
  if (!list.length) list.push({ id: 'powershell', label: 'Windows PowerShell', cmd: 'powershell.exe', args: ['-NoLogo'] });
  return list;
}
const SHELLS = detectShells();
function shellById(id) { return SHELLS.find(s => s.id === id) || SHELLS[0]; }

// ---- session store ------------------------------------------------------
/** @type {Map<string, Session>} */
const sessions = new Map();
let seq = 0;

// Persistence: snapshot of open sessions so they survive a server restart.
const SESSIONS_FILE = process.env.CT_SESSIONS_FILE || path.join(__dirname, '.sessions.json');
const { resolveClaudeCmd, resumeCmd, isClaudeCmd, projectDirFor, stripSessionFlags } = require('./session-cmd');

// The claude session UUID is pinned at spawn with --session-id (see session-cmd.js),
// so we always know a session's transcript id up front — no directory scraping.

// If this server was itself launched from inside a Claude Code session (the common
// case — JP starts it from a terminal), its process.env carries that parent's
// session markers. CLAUDE_CODE_CHILD_SESSION in particular makes every claude we
// spawn think it's a subagent and DISABLE transcript saving → resumes come back
// empty. Strip the whole parent-session marker family so each PTY's claude starts
// as a clean standalone parent. (We keep the rest of the env intact.)
const CLAUDE_PARENT_ENV = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID',
  'CLAUDECODE',
];
function ptyBaseEnv() {
  const env = { ...process.env };
  for (const k of CLAUDE_PARENT_ENV) delete env[k];
  return env;
}

class Session {
  constructor({ name, shellId, cwd, cols, rows, initialCommand, icon, id, claudeUuid }) {
    if (id) {
      this.id = id;
      const n = parseInt((/^s(\d+)-/.exec(id) || [])[1], 10);
      if (Number.isFinite(n) && n > seq) seq = n;   // keep new ids from colliding
    } else {
      this.id = 's' + (++seq) + '-' + crypto.randomBytes(3).toString('hex');
    }
    const sh = shellById(shellId);
    this.name = (name && name.trim()) || sh.label + ' ' + seq;
    this.icon = (icon && String(icon).trim().slice(0, 4)) || '🖥️';
    this.shellId = sh.id;
    this.shellLabel = sh.label;
    this.cwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    this.cols = clampInt(cols, 20, 500, 100);
    this.rows = clampInt(rows, 5, 200, 30);
    const resolved = resolveClaudeCmd(initialCommand);
    this.initialCommand = resolved.cmd;
    // The transcript id is pinned via --session-id (fresh launch) or carried over
    // from the snapshot (restore) — known up front, so --resume is deterministic.
    this.claudeUuid = claudeUuid || resolved.uuid || null;
    this.isClaude = isClaudeCmd(this.initialCommand);
    this.createdAt = Date.now();
    this.exited = false;
    this.exitCode = null;
    this.buffer = '';
    this.clients = new Set();

    this.pty = pty.spawn(sh.cmd, sh.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      // CT_SESSION_ID lets the claude in this PTY tell the MCP server which
      // terminal it is (via .mcp.json header) → browser commands target the tab
      // this session is docked next to.
      env: { ...ptyBaseEnv(), CT_SESSION_ID: this.id },
    });

    this.pty.onData((d) => {
      this.append(d);
      this.broadcast({ t: 'out', d });
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.broadcast({ t: 'exit', code: exitCode });
      persistSessions();   // a self-exited session drops out of the snapshot
    });

    if (this.initialCommand) {
      setTimeout(() => {
        try { this.pty.write(this.initialCommand + '\r'); } catch (_) {}
      }, 350);
    }
  }

  append(d) {
    this.buffer += d;
    if (this.buffer.length > MAX_BUF) this.buffer = this.buffer.slice(this.buffer.length - MAX_BUF);
  }

  write(d) { if (!this.exited) { try { this.pty.write(d); } catch (_) {} } }

  resize(cols, rows) {
    this.cols = clampInt(cols, 20, 500, this.cols);
    this.rows = clampInt(rows, 5, 200, this.rows);
    if (!this.exited) { try { this.pty.resize(this.cols, this.rows); } catch (_) {} }
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) { if (ws.readyState === 1) { try { ws.send(s); } catch (_) {} } }
  }

  kill() {
    this.broadcast({ t: 'killed' });
    if (!this.exited) { try { this.pty.kill(); } catch (_) {} }
    this.exited = true;
  }

  meta() {
    return {
      id: this.id, name: this.name, icon: this.icon, shellId: this.shellId, shellLabel: this.shellLabel,
      cwd: this.cwd, cols: this.cols, rows: this.rows, createdAt: this.createdAt,
      exited: this.exited, exitCode: this.exitCode, clients: this.clients.size,
    };
  }
}

function clampInt(v, min, max, dflt) {
  v = parseInt(v, 10);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(min, Math.min(max, v));
}

// ---- session persistence (survive a server restart) ---------------------
// Snapshot the open sessions on every structural change; on boot, recreate each
// one (reusing its id) and resume its exact conversation by UUID.
function persistSessions() {
  const data = [...sessions.values()].filter(s => !s.exited).map(s => ({
    id: s.id, name: s.name, icon: s.icon, shellId: s.shellId, cwd: s.cwd,
    initialCommand: s.initialCommand, claudeUuid: s.claudeUuid || null,
  }));
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
}

// Does the transcript claude would --resume actually exist on disk? A pinned uuid
// whose <uuid>.jsonl is gone (session lost/orphaned, e.g. a pre-pin session or a
// deleted transcript) would make `--resume <uuid>` fail with "No conversation
// found" and leave a dead PTY. We check first and fall back to a fresh launch.
function hasTranscript(cwd, uuid) {
  if (!uuid) return false;
  try { return fs.existsSync(path.join(projectDirFor(cwd), uuid + '.jsonl')); }
  catch (_) { return false; }
}

function restoreSessions() {
  if (process.env.CT_NO_RESTORE) return 0;
  let saved;
  try { saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (_) { return 0; }
  if (!Array.isArray(saved) || !saved.length) return 0;
  let n = 0;
  for (const e of saved) {
    if (!e || !e.id) continue;
    try {
      let cmd, uuid;
      if (e.claudeUuid && !hasTranscript(e.cwd, e.claudeUuid)) {
        // Pinned uuid but no transcript to resume → launch a clean base command
        // so the Session ctor mints and pins a fresh --session-id (recoverable
        // from here on) instead of issuing a doomed --resume.
        cmd = stripSessionFlags(e.initialCommand);
        uuid = null;
      } else {
        cmd = resumeCmd(e.initialCommand, e.claudeUuid);
        uuid = e.claudeUuid || null;
      }
      const s = new Session({
        name: e.name, icon: e.icon, shellId: e.shellId, cwd: e.cwd,
        initialCommand: cmd, id: e.id, claudeUuid: uuid,
      });
      sessions.set(s.id, s);
      n++;
    } catch (_) {}
  }
  return n;
}

// ---- browser control channel --------------------------------------------
// The extension's background service worker holds one WS to /control. Browser
// commands (read/eval/click/screenshot/...) are pushed to it and the result is
// awaited here, so both the /mcp tools and the /browser/command debug route can
// drive the active web tab. If no control client is connected the caller gets a
// fast, explicit failure (never a hang).
const controlClients = new Set();   // live /control sockets
const pending = new Map();          // id -> { resolve, reject, timer, ws }

class NoControlClient extends Error {}

function attachControl(ws) {
  controlClients.add(ws);
  try { ws.send(JSON.stringify({ t: 'welcome', version: VERSION })); } catch (_) {}

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (m.t === 'result') {
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error || 'browser command failed'));
    }
    // {t:'pong'} and anything else: ignored
  });

  const drop = () => {
    controlClients.delete(ws);
    for (const [id, p] of pending) {
      if (p.ws === ws) {
        clearTimeout(p.timer);
        pending.delete(id);
        p.reject(new NoControlClient('control client disconnected'));
      }
    }
  };
  ws.on('close', drop);
  ws.on('error', drop);
}

// heartbeat: an active WS keeps the MV3 service worker alive (resets its idle timer)
setInterval(() => {
  const ping = JSON.stringify({ t: 'ping' });
  for (const ws of controlClients) { if (ws.readyState === 1) { try { ws.send(ping); } catch (_) {} } }
}, 20000);

function sendBrowserCommand({ action, params, tabId, sessionId, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const ws = [...controlClients].find(w => w.readyState === 1);
    if (!ws) return reject(new NoControlClient('no browser control client connected'));
    const id = crypto.randomBytes(8).toString('hex');
    const ms = clampInt(timeoutMs, 1000, 120000, action === 'navigate' ? 60000 : 30000);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('browser command timed out'));
    }, ms);
    pending.set(id, { resolve, reject, timer, ws });
    try {
      ws.send(JSON.stringify({ t: 'cmd', id, action, params: params || {}, tabId, sessionId }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

// ---- MCP server (in-process, mounted at /mcp) ---------------------------
const numTab = { tabId: { type: 'number', description: 'Target tab id from browser_list_tabs. Omit to use the active tab.' } };
const MCP_TOOLS = [
  { name: 'browser_list_tabs', description: 'List open browser tabs: id, title, url, active.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_read', description: 'Read the current page — returns { title, url, text } (visible text).',
    inputSchema: { type: 'object', properties: { ...numTab } } },
  { name: 'browser_eval', description: 'Run JavaScript in the page (MAIN world) and return the result. The value of the last expression is returned; it must be JSON-serializable.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript to evaluate in the page.' }, ...numTab }, required: ['code'] } },
  { name: 'browser_click', description: 'Click an element by CSS selector, OR at page coordinates (x,y). Coordinates use a trusted CDP mouse click.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector to click.' }, x: { type: 'number' }, y: { type: 'number' }, ...numTab } } },
  { name: 'browser_type', description: 'Type text. With a selector it focuses that element and sets its value; with trusted:true it sends real keystrokes via CDP to the focused element. submit:true presses Enter afterward.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, selector: { type: 'string' }, trusted: { type: 'boolean' }, submit: { type: 'boolean' }, ...numTab }, required: ['text'] } },
  { name: 'browser_key', description: 'Press a single key as a real CDP key event, e.g. Enter, Tab, Escape, ArrowDown.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, ...numTab }, required: ['key'] } },
  { name: 'browser_screenshot', description: 'Capture a PNG screenshot. fullPage:true captures the whole scrollable page via CDP; otherwise the visible viewport.',
    inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' }, ...numTab } } },
  { name: 'browser_navigate', description: 'Navigate a tab to a URL and wait for it to finish loading.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, ...numTab }, required: ['url'] } },
  { name: 'browser_wait_for', description: 'Wait until a CSS selector appears on the page, polling until it matches or timeoutMs elapses. visible:true also requires the element to be visible (rendered, non-zero size). Returns { found:true, waitedMs }; errors on timeout.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector to wait for.' }, timeoutMs: { type: 'number', description: 'Max time to wait in ms (default 10000).' }, visible: { type: 'boolean', description: 'Also require the element to be visible, not just present in the DOM.' }, ...numTab }, required: ['selector'] } },
];
const TOOL_ACTION = {
  browser_list_tabs: 'list_tabs', browser_read: 'read_page', browser_eval: 'eval',
  browser_click: 'click', browser_type: 'type', browser_key: 'key',
  browser_screenshot: 'screenshot', browser_navigate: 'navigate', browser_wait_for: 'wait_for',
};

function buildMcpServer(sessionId) {
  const srv = new McpServer({ name: 'chrome-browser', version: VERSION }, { capabilities: { tools: {} } });
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));
  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const action = TOOL_ACTION[name];
    if (!action) return { isError: true, content: [{ type: 'text', text: 'unknown tool ' + name }] };
    const { tabId, ...params } = (req.params.arguments || {});
    try {
      // wait_for polls in-page up to timeoutMs; give the WS command extra headroom so the
      // page-side timeout is what fires (clean 'timed out' error) rather than the WS timeout.
      const timeoutMs = name === 'browser_wait_for' ? Number(params.timeoutMs || 10000) + 5000 : undefined;
      const result = await sendBrowserCommand({ action, params, tabId, sessionId, timeoutMs });
      if (name === 'browser_screenshot') {
        const raw = typeof result === 'string' ? result : (result && result.data) || '';
        const data = String(raw).replace(/^data:image\/png;base64,/, '');
        return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
      }
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
  return srv;
}

// ---- HTTP API -----------------------------------------------------------
const app = express();
app.use(express.json());

// permissive CORS for a local personal tool; the token is the real gate
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'content-type, x-ct-token');
  res.set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function checkToken(req) {
  const t = req.headers['x-ct-token'] || req.query.token;
  return t === TOKEN;
}
app.use((req, res, next) => {
  // /health and /mcp are open: bind is 127.0.0.1 only, and /mcp needs no rotating
  // token in the Claude Code config. Everything else stays token-gated.
  if (req.path === '/health' || req.path === '/mcp' || req.path.startsWith('/mcp/')) return next();
  if (!checkToken(req)) return res.status(401).json({ error: 'bad token' });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));
app.get('/shells', (_req, res) => res.json(SHELLS.map(s => ({ id: s.id, label: s.label }))));

// ---- directory browsing -------------------------------------------------
// Workspaces (the named roots the folder picker starts from) are configured in
// the extension and stored in the browser — NOT hardcoded here. The extension
// passes the chosen root with each request; the server only lists subfolders and
// refuses to escape that root (blocks `..` traversal). Also lets the picker exist
// for '/path/exists' checks. Nothing machine-specific lives in this file.
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv', '.idea', '.vscode']);

// resolved path must stay inside the resolved root (equal or a descendant)
function withinRoot(p, root) {
  const rp = path.resolve(p);
  const rr = path.resolve(root);
  return rp === rr || rp.startsWith(rr + path.sep);
}

app.get('/exists', (req, res) => {
  const p = req.query.path;
  res.json({ exists: !!(p && fs.existsSync(p) && (() => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } })()) });
});

app.get('/dirs', (req, res) => {
  const p = req.query.path;
  const root = req.query.root || p;
  if (!p || !root || !withinRoot(p, root)) return res.status(400).json({ error: 'path escapes its workspace root' });
  const rp = path.resolve(p);
  let entries;
  try { entries = fs.readdirSync(rp, { withFileTypes: true }); }
  catch (_) { return res.status(400).json({ error: 'cannot read dir' }); }
  const dirs = entries
    .filter(e => {
      try { return e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name); }
      catch (_) { return false; }
    })
    .map(e => ({ name: e.name, path: path.join(rp, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ path: rp, dirs });
});

app.get('/sessions', (_req, res) => {
  res.json([...sessions.values()].map(s => s.meta()));
});

app.post('/sessions', (req, res) => {
  const s = new Session(req.body || {});
  sessions.set(s.id, s);
  persistSessions();
  res.json(s.meta());
});

app.post('/sessions/:id/rename', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  const n = (req.body && req.body.name || '').trim();
  const ic = (req.body && req.body.icon || '').trim();
  if (n) s.name = n;
  if (ic) s.icon = ic.slice(0, 4);
  persistSessions();
  res.json(s.meta());
});

app.post('/sessions/:id/kill', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  s.kill();
  persistSessions();
  res.json(s.meta());
});

app.delete('/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) { s.kill(); sessions.delete(s.id); }
  persistSessions();
  res.json({ ok: true });
});

// ---- browser automation (relay + MCP) -----------------------------------
// Debug/CLI surface: POST a raw browser command straight to the relay.
app.post('/browser/command', async (req, res) => {
  const { action, params, tabId, timeoutMs } = req.body || {};
  if (!action) return res.status(400).json({ ok: false, error: 'action required' });
  try {
    const result = await sendBrowserCommand({ action, params, tabId, timeoutMs });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(e instanceof NoControlClient ? 503 : 504).json({ ok: false, error: e.message });
  }
});

// MCP endpoint (stateless streamable-HTTP). A fresh server+transport per request.
app.post('/mcp', async (req, res) => {
  try {
    // Which terminal issued this? The caller's claude sends its server session id
    // as x-ct-session (from CT_SESSION_ID in its env, via .mcp.json). Lets the
    // extension default to the tab this conversation is docked next to.
    let sessionId = req.headers['x-ct-session'] || req.query.s || '';
    sessionId = String(sessionId).trim();
    if (sessionId.startsWith('${')) sessionId = '';   // unexpanded placeholder → treat as none
    const srv = buildMcpServer(sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { try { transport.close(); } catch (_) {} try { srv.close(); } catch (_) {} });
    await srv.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
  }
});
const mcpMethodNotAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed' }, id: null });
app.get('/mcp', mcpMethodNotAllowed);
app.delete('/mcp', mcpMethodNotAllowed);

// ---- WebSocket attach ---------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { return socket.destroy(); }
  if (url.pathname === '/control') {
    if (url.searchParams.get('token') !== TOKEN) return socket.destroy();
    return wss.handleUpgrade(req, socket, head, (ws) => attachControl(ws));
  }
  if (url.pathname !== '/attach') return socket.destroy();
  if (url.searchParams.get('token') !== TOKEN) return socket.destroy();
  const id = url.searchParams.get('id');
  const s = sessions.get(id);
  if (!s) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, s));
});

function attach(ws, s) {
  s.clients.add(ws);
  ws.send(JSON.stringify({ t: 'hello', session: s.meta() }));
  if (s.buffer) ws.send(JSON.stringify({ t: 'out', d: s.buffer }));
  if (s.exited) ws.send(JSON.stringify({ t: 'exit', code: s.exitCode }));

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (m.t === 'in') s.write(m.d);
    else if (m.t === 'resize') s.resize(m.c, m.r);
  });
  ws.on('close', () => s.clients.delete(ws));
  ws.on('error', () => s.clients.delete(ws));
}

const restored = restoreSessions();

function printBanner(restoredCount) {
  console.log('');
  console.log('  Power Shell(ed) server v' + VERSION);
  console.log('  listening  http://' + HOST + ':' + PORT);
  console.log('  token      ' + TOKEN);
  console.log('  shells     ' + SHELLS.map(s => s.id).join(', '));
  if (restoredCount) console.log('  restored   ' + restoredCount + ' session(s) from last run');
  console.log('');
  console.log('  Paste the port + token into the extension popup (⚙).');
  console.log('');
}

server.listen(PORT, HOST, () => {
  const useTui = process.stdout.isTTY && !process.env.CT_NO_TUI;
  if (useTui) {
    try {
      const { startDashboard } = require('./dashboard');
      startDashboard({
        getSessions: () => sessions, host: HOST, port: PORT, token: TOKEN,
        version: VERSION, shells: SHELLS, restoredCount: restored,
      });
      return;
    } catch (err) {
      console.error('dashboard failed to start, falling back to plain banner:', err.message);
    }
  }
  printBanner(restored);
});
