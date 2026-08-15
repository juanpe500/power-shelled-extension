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

class Session {
  constructor({ name, shellId, cwd, cols, rows, initialCommand, icon }) {
    this.id = 's' + (++seq) + '-' + crypto.randomBytes(3).toString('hex');
    const sh = shellById(shellId);
    this.name = (name && name.trim()) || sh.label + ' ' + seq;
    this.icon = (icon && String(icon).trim().slice(0, 4)) || '🖥️';
    this.shellId = sh.id;
    this.shellLabel = sh.label;
    this.cwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    this.cols = clampInt(cols, 20, 500, 100);
    this.rows = clampInt(rows, 5, 200, 30);
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
      env: process.env,
    });

    this.pty.onData((d) => {
      this.append(d);
      this.broadcast({ t: 'out', d });
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.broadcast({ t: 'exit', code: exitCode });
    });

    if (initialCommand && initialCommand.trim()) {
      setTimeout(() => { try { this.pty.write(initialCommand + '\r'); } catch (_) {} }, 350);
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
  if (req.path === '/health') return next();
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
  res.json(s.meta());
});

app.post('/sessions/:id/rename', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  const n = (req.body && req.body.name || '').trim();
  const ic = (req.body && req.body.icon || '').trim();
  if (n) s.name = n;
  if (ic) s.icon = ic.slice(0, 4);
  res.json(s.meta());
});

app.post('/sessions/:id/kill', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  s.kill();
  res.json(s.meta());
});

app.delete('/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) { s.kill(); sessions.delete(s.id); }
  res.json({ ok: true });
});

// ---- WebSocket attach ---------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { return socket.destroy(); }
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

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Power Shell(ed) server v' + VERSION);
  console.log('  listening  http://' + HOST + ':' + PORT);
  console.log('  token      ' + TOKEN);
  console.log('  shells     ' + SHELLS.map(s => s.id).join(', '));
  console.log('');
  console.log('  Paste the port + token into the extension popup (⚙).');
  console.log('');
});
