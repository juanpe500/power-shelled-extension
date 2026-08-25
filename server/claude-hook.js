// Claude Code hook → reports a session's state/mode back to the chrome-terminal
// server, so the extension can color the tab group + panel chip and show the mode.
//
// Invoked by the injected hooks settings (see server.js writeHookSettings) as:
//   node claude-hook.js <event>       event ∈ prompt | stop | notify | start
//
// Correlation: the PTY that runs this claude was spawned with CT_SESSION_ID in its
// env (server.js), which this hook inherits — that id IS the server's session key.
// CT_TOKEN / CT_PORT / CT_HOST are injected the same way so we can POST back.
//
// Claude Code passes the hook's JSON on stdin; we read `permission_mode` from it.
// This must be fast and NEVER hang or throw upward (a stuck hook stalls claude), so
// everything is best-effort with a short timeout and we always exit 0.
'use strict';

const http = require('http');

const EVENT = (process.argv[2] || '').toLowerCase();
const STATE_BY_EVENT = { prompt: 'busy', stop: 'idle', notify: 'waiting', start: 'idle' };
const state = STATE_BY_EVENT[EVENT] || 'idle';

const id = process.env.CT_SESSION_ID;
const token = process.env.CT_TOKEN || '';
const host = process.env.CT_HOST || '127.0.0.1';
const port = parseInt(process.env.CT_PORT || '3777', 10);

// Nothing to correlate to → this claude wasn't spawned by the manager; do nothing.
function bail() { try { process.exit(0); } catch (_) {} }
if (!id) bail();

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; if (data.length > 1 << 20) finish(); });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch (_) { finish(); }
    setTimeout(finish, 500);   // don't wait forever if no stdin arrives
  });
}

function modeFrom(raw) {
  try {
    const o = JSON.parse(raw);
    const m = o && o.permission_mode;
    return typeof m === 'string' && m ? m : 'default';
  } catch (_) { return 'default'; }
}

function post(body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host, port, method: 'POST',
      path: `/sessions/${encodeURIComponent(id)}/state`,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-ct-token': token },
    }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);        // server down / refused → silent
    req.setTimeout(2000, () => { try { req.destroy(); } catch (_) {} resolve(); });
    req.write(payload);
    req.end();
  });
}

(async () => {
  const raw = await readStdin();
  await post({ state, mode: modeFrom(raw) });
  bail();
})().catch(bail);
