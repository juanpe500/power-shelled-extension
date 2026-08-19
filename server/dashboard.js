// Live amber-on-black TUI dashboard drawn straight into the console window
// start-server.cmd/.ps1 already opens. Hand-rolled ANSI — no blessed/blessed-
// contrib (both effectively unmaintained, and blessed puts stdin in raw mode
// which risks Ctrl+C no longer cleanly killing every PTY). This module never
// reads stdin, never binds a key — the terminal's own Ctrl+C is the only quit.
'use strict';

const { createUsageTracker } = require('./claude-usage');

// Amber is the theme (borders/titles) — content uses a real palette on top of
// it, not amber-on-everything.
const AMBER = '\x1b[38;2;255;176;0m';
const AMBER_DIM = '\x1b[38;2;150;103;0m';
const WHITE = '\x1b[38;2;235;235;235m';
const GREY = '\x1b[38;2;130;130;130m';
const GREEN = '\x1b[38;2;90;210;120m';
const RED = '\x1b[38;2;255;90;90m';
const CYAN = '\x1b[38;2;100;210;220m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';
const CLEAR_EOL = '\x1b[K';   // erase from cursor to end of line
const CLEAR_EOS = '\x1b[J';   // erase from cursor to end of screen

const SPARK_CHARS = '▁▂▃▄▅▆▇█';
const HISTORY_LEN = 120;

function fmtUsd(n) { return '$' + (n || 0).toFixed(4); }
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return pad(h) + ':' + pad(m) + ':' + pad(sec);
}
function fmtKb(bytes) { return (bytes / 1024).toFixed(1) + 'KB'; }
function truncate(str, n) {
  str = String(str || '');
  return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + '…';
}
function padRight(str, n) { str = String(str); return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length); }
function padLeft(str, n) { str = String(str); return str.length >= n ? str.slice(0, n) : ' '.repeat(n - str.length) + str; }

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
function visibleLen(str) { return String(str).replace(ANSI_RE, '').length; }
// Pads by VISIBLE length only — box interior lines are usually built from
// several color-wrapped segments, whose escape sequences would otherwise
// count toward .length and truncate real trailing content (e.g. the token,
// or the "Cost" column). Never truncates — callers bound visible width
// themselves via truncate()/padRight on the underlying plain text.
function padRightVisible(str, n) {
  str = String(str);
  const vlen = visibleLen(str);
  return vlen >= n ? str : str + ' '.repeat(n - vlen);
}

// label(dim amber, fixed width) + value(given color) — the building block for
// every stat-box row so labels and values are visually distinct.
function stat(label, labelW, value, color) {
  return AMBER_DIM + padRight(label, labelW) + RESET + (color || WHITE) + value + RESET;
}

function box(title, width, lines) {
  const out = [];
  const top = '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, width - title.length - 4)) + '┐';
  out.push(AMBER + BOLD + top + RESET);
  for (const line of lines) {
    out.push(AMBER + '│' + RESET + ' ' + padRightVisible(line, width - 2) + ' ' + AMBER + '│' + RESET);
  }
  out.push(AMBER + '└' + '─'.repeat(width) + '┘' + RESET);
  return out;
}

function sideBySide(boxesLines, gap) {
  gap = gap || 1;
  const height = Math.max(...boxesLines.map((b) => b.length));
  const rows = [];
  for (let i = 0; i < height; i++) {
    rows.push(boxesLines.map((b) => b[i] || '').join(' '.repeat(gap)));
  }
  return rows;
}

function sparkline(values, width) {
  if (!values.length) return AMBER_DIM + '·'.repeat(width) + RESET;
  const slice = values.slice(-width);
  const max = Math.max(...slice, 0.000001);
  let out = '';
  for (const v of slice) {
    const idx = Math.min(SPARK_CHARS.length - 1, Math.floor((v / max) * (SPARK_CHARS.length - 1)));
    out += SPARK_CHARS[idx];
  }
  return AMBER + out + RESET + AMBER_DIM + '·'.repeat(Math.max(0, width - slice.length)) + RESET;
}

function startDashboard({ getSessions, host, port, token, version, shells, restoredCount }) {
  const tracker = createUsageTracker();
  const startedAt = Date.now();
  const costHistory = [];
  let lastAggCost = 0;

  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR);

  let closing = false;
  function cleanupAndExit() {
    if (closing) return;
    closing = true;
    try { process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF); } catch (_) {}
  }
  process.on('SIGINT', () => { cleanupAndExit(); process.exit(0); });
  process.on('SIGTERM', () => { cleanupAndExit(); process.exit(0); });
  process.on('exit', cleanupAndExit);

  function renderFrame() {
    const sessions = getSessions();
    const agg = tracker.getAggregate();
    costHistory.push(Math.max(0, agg.costUsd - lastAggCost));
    if (costHistory.length > HISTORY_LEN) costHistory.shift();
    lastAggCost = agg.costUsd;

    const cols = process.stdout.columns || 100;
    const fullWidth = cols - 2;

    // Full-width Server row — the token needs the room to be selectable/copyable whole.
    const serverBox = box('Server', fullWidth, [
      stat('host       ', 11, `${host}:${port}`) + '   ' + stat('version    ', 11, version),
      stat('token      ', 11, String(token || '')),
      stat('uptime     ', 11, fmtElapsed(Date.now() - startedAt)) + '   ' + stat('restored   ', 11, String(restoredCount || 0)),
      stat('shells     ', 11, (shells || []).map((s) => s.id).join(', ')),
    ]);

    const halfWidth = Math.max(20, Math.floor((cols - 5) / 2));
    const costBox = box('Cost (this run)', halfWidth, [
      stat('total      ', 11, fmtUsd(agg.costUsd), GREEN),
      stat('input      ', 11, `${agg.inputTokens} tok`),
      stat('output     ', 11, `${agg.outputTokens} tok`),
      stat('cache w/r  ', 11, `${agg.cacheCreationTokens} / ${agg.cacheReadTokens}`),
      stat('tracked    ', 11, `${agg.trackedSessionCount}/${sessions.size} sessions`, CYAN),
    ]);
    const tokBox = box('Tokens', halfWidth, [
      stat('in + out   ', 11, `${agg.inputTokens + agg.outputTokens} tok`),
      stat('cache w    ', 11, `${agg.cacheCreationTokens} tok`),
      stat('cache r    ', 11, `${agg.cacheReadTokens} tok`),
      stat('sessions   ', 11, `${sessions.size} total`, CYAN),
    ]);
    const statsRow = sideBySide([costBox, tokBox]);

    const sparkWidth = Math.max(10, cols - 24);
    const sparkBox = box('Cost / tick ($)', fullWidth, [
      sparkline(costHistory, sparkWidth) + '  ' + stat('latest ', 7, fmtUsd(costHistory[costHistory.length - 1] || 0), GREEN),
    ]);

    const nameW = 18, shellW = 10, elW = 10, sizeW = 8, clW = 3, modelW = 20, costW = 10;
    const header = AMBER + BOLD +
      padRight('Name', nameW) + ' ' + padRight('Shell', shellW) + ' ' +
      padRight('Elapsed', elW) + ' ' + padRight('Size', sizeW) + ' ' + padRight('Cli', clW) + ' ' +
      padRight('Model(s)', modelW) + ' ' + padLeft('Cost', costW) + RESET;
    const rows = [header];
    const list = [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
    for (const s of list) {
      const summary = tracker.getSummary(s.id);
      const dead = s.exited;
      const attached = !dead && s.clients.size > 0;

      let costStr = '—', costColor = GREY;
      if (summary.hasData) {
        if (summary.unknownModel && summary.costUsd === 0) { costStr = '?'; costColor = AMBER; }
        else { costStr = fmtUsd(summary.costUsd); costColor = GREEN; }
      }
      const modelStr = s.isClaude ? (summary.models.length ? summary.models.join(',') : '…') : '—';
      const nameColor = dead ? RED : (attached ? WHITE + BOLD : WHITE);
      const cliColor = dead ? GREY : (attached ? GREEN : GREY);
      const bodyColor = dead ? GREY : WHITE;

      const line =
        nameColor + padRight(truncate(s.name, nameW), nameW) + RESET + ' ' +
        bodyColor + padRight(truncate(s.shellId, shellW), shellW) + RESET + ' ' +
        bodyColor + padRight(fmtElapsed(Date.now() - s.createdAt), elW) + RESET + ' ' +
        bodyColor + padRight(fmtKb(s.buffer ? s.buffer.length : 0), sizeW) + RESET + ' ' +
        cliColor + padRight(String(s.clients.size), clW) + RESET + ' ' +
        (dead ? GREY : CYAN) + padRight(truncate(modelStr, modelW), modelW) + RESET + ' ' +
        costColor + padLeft(costStr, costW) + RESET;
      rows.push(line);
    }
    if (!list.length) rows.push(GREY + '(no sessions)' + RESET);
    const sessionsBox = box('Sessions', fullWidth, rows);

    const footer = GREY + 'Ctrl+C to stop (stops running sessions; restored on restart) · refreshing every 1s' + RESET;

    // Clear-to-end-of-line after every line + clear-to-end-of-screen after the
    // last one, so a narrower window or a shrinking session list never leaves
    // ghost characters from the previous (larger) frame on screen.
    const lines = [...serverBox, '', ...statsRow, '', ...sparkBox, '', ...sessionsBox, '', footer];
    const frame = HOME + lines.join(CLEAR_EOL + '\r\n') + CLEAR_EOL + CLEAR_EOS;
    try { process.stdout.write(frame); } catch (_) {}
  }

  // Cost/token tracking runs on its own async loop, off the render path — the
  // render only reads the in-memory totals it accumulates.
  tracker.start(getSessions, 1000);

  const safeRender = () => { try { renderFrame(); } catch (_) {} };
  safeRender();
  setInterval(safeRender, 1000);
  // Redraw immediately on window resize (clear-to-end handles stale cells) so
  // the layout re-fits without waiting for the next tick.
  if (process.stdout.on) process.stdout.on('resize', safeRender);
}

module.exports = { startDashboard };
