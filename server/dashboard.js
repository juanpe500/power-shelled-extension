// Live amber-on-black TUI dashboard drawn straight into the console window
// start-server.cmd/.ps1 already opens. Hand-rolled ANSI — no blessed/blessed-
// contrib (both effectively unmaintained, and blessed puts stdin in raw mode
// which risks Ctrl+C no longer cleanly killing every PTY). This module never
// reads stdin, never binds a key — the terminal's own Ctrl+C is the only quit.
'use strict';

const { createUsageTracker } = require('./claude-usage');
const { createHistoryAggregator, localDayKey } = require('./claude-history');

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
// Ctrl+R exits with this code; the launcher script loops on it to relaunch.
const RESTART_EXIT_CODE = 42;

// Distinct fg colors for the per-day line chart's model series (+ legend dots).
const SERIES_COLORS = [
  '\x1b[38;2;130;150;255m', // periwinkle
  '\x1b[38;2;90;210;120m',  // green
  '\x1b[38;2;255;176;0m',   // amber
  '\x1b[38;2;100;210;220m', // cyan
  '\x1b[38;2;220;120;220m', // magenta
];
// Heatmap intensity ramp (index 1..4 = low..high). Empty/zero days use grey dots.
const HEAT_COLORS = [
  null,
  '\x1b[38;2;80;54;0m',
  '\x1b[38;2;140;95;0m',
  '\x1b[38;2;200;138;0m',
  '\x1b[38;2;255;176;0m',
];
const HEAT_EMPTY = '\x1b[38;2;70;70;70m';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Braille dot bit masks, indexed [dy][dx] (dx 0..1, dy 0..3). A cell is
// U+2800 + OR of the masks of its lit dots — 2×4 sub-pixels per character.
const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

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

function fmtCompact(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(Math.round(n));
}
function shortModel(m) { return String(m || '').replace(/^claude-/, ''); }

// ── Per-day line chart (braille) ──────────────────────────────────────────
// dailySeries: [{date, perModel:Map}], models: modelIds to plot (one line each).
// Returns chart rows (with left y-axis labels) plus an x-axis date row.
function lineChartLines(dailySeries, models, cellW, cellH) {
  const n = dailySeries.length;
  const pxW = cellW * 2, pxH = cellH * 4;
  const seriesVals = models.map((m) => dailySeries.map((d) => {
    const t = d.perModel.get(m);
    return t ? (t.inputTokens + t.outputTokens) : 0;
  }));
  let max = 0;
  for (const sv of seriesVals) for (const v of sv) if (v > max) max = v;
  if (max <= 0) max = 1;

  const bits = Array.from({ length: cellH }, () => new Uint8Array(cellW));
  const colr = Array.from({ length: cellH }, () => new Int16Array(cellW).fill(-1));
  const setPx = (px, py, ci) => {
    if (px < 0 || px >= pxW || py < 0 || py >= pxH) return;
    const cx = px >> 1, cy = py >> 2;
    bits[cy][cx] |= DOT[py & 3][px & 1];
    colr[cy][cx] = ci; // last series to touch a cell owns its color
  };
  const drawLine = (x0, y0, x1, y1, ci) => { // integer Bresenham
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
    for (;;) {
      setPx(x0, y0, ci);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  };
  const xAt = (i) => (n <= 1 ? 0 : Math.round(i / (n - 1) * (pxW - 1)));
  const yAt = (v) => Math.round((1 - v / max) * (pxH - 1));
  seriesVals.forEach((sv, si) => {
    if (n === 1) { if (sv[0] > 0) setPx(xAt(0), yAt(sv[0]), si); return; }
    for (let i = 0; i < n - 1; i++) {
      // Skip flat baseline segments — a mostly-idle model would otherwise paint a
      // solid noisy line along y=0 across the whole width.
      if (sv[i] === 0 && sv[i + 1] === 0) continue;
      drawLine(xAt(i), yAt(sv[i]), xAt(i + 1), yAt(sv[i + 1]), si);
    }
  });

  const yLabelW = 5;
  const rows = [];
  const denom = cellH > 1 ? cellH - 1 : 1; // so the bottom row labels exactly 0
  for (let cy = 0; cy < cellH; cy++) {
    let s = AMBER_DIM + padLeft(fmtCompact(max * (denom - cy) / denom), yLabelW) + RESET + ' ';
    for (let cx = 0; cx < cellW; cx++) {
      const b = bits[cy][cx];
      if (!b) { s += ' '; continue; }
      s += (SERIES_COLORS[colr[cy][cx] % SERIES_COLORS.length] || WHITE) + String.fromCharCode(0x2800 + b) + RESET;
    }
    rows.push(s);
  }
  // x-axis date labels at ~4 ticks
  const cells = new Array(cellW).fill(' ');
  const ticks = n <= 1 ? [0] : [0, Math.floor((n - 1) / 3), Math.floor(2 * (n - 1) / 3), n - 1];
  const seen = new Set();
  for (const i of ticks) {
    if (seen.has(i)) continue;
    seen.add(i);
    const d = dailySeries[i].date;
    const label = MONTHS[d.getMonth()] + ' ' + d.getDate();
    let col = n <= 1 ? 0 : Math.round(i / (n - 1) * (cellW - 1));
    col = Math.max(0, Math.min(col, cellW - label.length));
    for (let k = 0; k < label.length && col + k < cellW; k++) cells[col + k] = label[k];
  }
  rows.push(' '.repeat(yLabelW + 1) + AMBER_DIM + cells.join('') + RESET);
  return rows;
}
function legendLine(models) {
  return models.map((m, si) =>
    SERIES_COLORS[si % SERIES_COLORS.length] + '●' + RESET + ' ' + WHITE + shortModel(m) + RESET
  ).join('   ');
}

// ── Activity heatmap (weekday rows × week columns) ─────────────────────────
function heatmapLines(dailySeries) {
  const map = new Map();
  let max = 0;
  for (const d of dailySeries) {
    const v = d.totals.inputTokens + d.totals.outputTokens;
    map.set(localDayKey(d.date), v);
    if (v > max) max = v;
  }
  const first = dailySeries[0].date;
  const last = dailySeries[dailySeries.length - 1].date;
  const gs = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  gs.setDate(gs.getDate() - ((gs.getDay() + 6) % 7)); // back to Monday
  const lastMid = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime();

  const weeks = [];
  const cur = new Date(gs);
  while (cur.getTime() <= lastMid) {
    const col = [];
    for (let r = 0; r < 7; r++) {
      const key = localDayKey(cur);
      col.push({ date: new Date(cur), v: map.has(key) ? map.get(key) : -1, inWin: map.has(key) });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(col);
  }
  const level = (v) => {
    if (v <= 0) return 0;
    const r = v / (max || 1);
    return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
  };
  const cellStr = (c) => {
    const L = c.inWin ? level(c.v) : 0;
    return L === 0 ? HEAT_EMPTY + '··' + RESET : HEAT_COLORS[L] + '██' + RESET;
  };

  const gridW = weeks.length * 2;
  const hdr = new Array(gridW).fill(' ');
  let prevM = -1;
  weeks.forEach((col, ci) => {
    const mth = col[0].date.getMonth();
    if (mth !== prevM) {
      prevM = mth;
      const lab = MONTHS[mth];
      for (let k = 0; k < lab.length && ci * 2 + k < gridW; k++) hdr[ci * 2 + k] = lab[k];
    }
  });
  const rowLabels = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  const lines = ['   ' + AMBER_DIM + hdr.join('') + RESET];
  for (let r = 0; r < 7; r++) {
    let s = AMBER_DIM + padRight(rowLabels[r], 3) + RESET;
    for (const col of weeks) s += cellStr(col[r]);
    lines.push(s);
  }
  lines.push('');
  lines.push(AMBER_DIM + 'Less ' + RESET +
    HEAT_COLORS[1] + '█' + HEAT_COLORS[2] + '█' + HEAT_COLORS[3] + '█' + HEAT_COLORS[4] + '█' + RESET +
    AMBER_DIM + ' More' + RESET);
  return { lines, width: 3 + gridW };
}

// ── Budget bars ────────────────────────────────────────────────────────────
function budgetBar(value, target, barW) {
  const pct = target > 0 ? value / target : 0;
  const filled = Math.max(0, Math.min(barW, Math.round(pct * barW)));
  const color = pct >= 0.9 ? RED : pct >= 0.7 ? AMBER : GREEN;
  return color + '█'.repeat(filled) + RESET + AMBER_DIM + '░'.repeat(barW - filled) + RESET;
}
function budgetLines(runCost, budgetUsd, windowTokens, budgetTokens, barW) {
  const pctStr = (v, t) => (t > 0 ? Math.round(v / t * 100) + '% used' : 'no target');
  return [
    stat('run cost   ', 11, fmtUsd(runCost)) + AMBER_DIM + ' / ' + fmtUsd(budgetUsd) + RESET,
    budgetBar(runCost, budgetUsd, barW) + ' ' + WHITE + pctStr(runCost, budgetUsd) + RESET,
    '',
    stat('30d tokens ', 11, fmtCompact(windowTokens)) + AMBER_DIM + ' / ' + fmtCompact(budgetTokens) + RESET,
    budgetBar(windowTokens, budgetTokens, barW) + ' ' + WHITE + pctStr(windowTokens, budgetTokens) + RESET,
  ];
}

function startDashboard({ getSessions, host, port, token, version, shells, restoredCount }) {
  const tracker = createUsageTracker();
  const history = createHistoryAggregator({ windowDays: 30, intervalMs: 20000 });
  const startedAt = Date.now();
  const costHistory = [];
  let lastAggCost = 0;

  // Budget-bar targets (env-configurable). Defaults are round numbers, not limits.
  const budgetUsd = parseFloat(process.env.CT_BUDGET_USD) || 20;
  const budgetTokens = parseFloat(process.env.CT_BUDGET_TOKENS) || 100e6;

  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR);

  // Key handling. We put stdin in raw mode so Ctrl+R (restart) is catchable —
  // but raw mode ALSO suppresses the terminal's automatic SIGINT on Ctrl+C, so
  // we must detect 0x03 ourselves and run the exact same stop path. Exiting with
  // RESTART_EXIT_CODE tells the launcher script (start-server.cmd/.ps1) to relaunch;
  // the fresh server restores the persisted sessions on boot.
  const stdin = process.stdin;
  const rawCapable = stdin && stdin.isTTY && typeof stdin.setRawMode === 'function';
  function onKey(data) {
    for (const byte of data) {
      if (byte === 0x03) { cleanupAndExit(); process.exit(0); }                  // Ctrl+C — stop
      if (byte === 0x12) { cleanupAndExit(); process.exit(RESTART_EXIT_CODE); }  // Ctrl+R — restart
    }
  }
  if (rawCapable) {
    try { stdin.setRawMode(true); stdin.resume(); stdin.on('data', onKey); } catch (_) {}
  }

  let closing = false;
  function cleanupAndExit() {
    if (closing) return;
    closing = true;
    // Leave the terminal usable: drop raw mode before restoring the main screen,
    // or the parent shell inherits a raw stdin (no echo, no line editing).
    if (rawCapable) { try { stdin.setRawMode(false); stdin.pause(); } catch (_) {} }
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

    // History graphs (per-day, 30-day window) — read from the background
    // aggregator's in-memory buckets; render is instant.
    const series = history.getSeries();
    const models = history.getTopModels(4);
    const winTot = history.getWindowTotals();

    const chartCellW = Math.max(20, fullWidth - 8); // interior(fullWidth-2) minus y-label(5)+space(1)
    const chartRows = models.length
      ? [...lineChartLines(series, models, chartCellW, 6), '', legendLine(models)]
      : [GREY + '(no history yet — scanning transcripts…)' + RESET];
    const lineChartBox = box('Tokens / day (30d)', fullWidth, chartRows);

    const heat = heatmapLines(series);
    const heatBoxWidth = Math.max(heat.width, 20);
    const budgetBoxWidth = Math.max(24, fullWidth - heatBoxWidth - 1);
    const heatBox = box('Activity (30d)', heatBoxWidth, heat.lines);
    const barW = Math.max(10, budgetBoxWidth - 24);
    const budgetBox = box('Budget', budgetBoxWidth,
      budgetLines(agg.costUsd, budgetUsd, winTot.inputTokens + winTot.outputTokens, budgetTokens, barW));
    const histRow = sideBySide([heatBox, budgetBox]);

    const footer = GREY + 'Ctrl+C to stop · Ctrl+R to restart (sessions restored) · refreshing every 1s' + RESET;

    // Clear-to-end-of-line after every line + clear-to-end-of-screen after the
    // last one, so a narrower window or a shrinking session list never leaves
    // ghost characters from the previous (larger) frame on screen.
    const lines = [
      ...serverBox, '', ...statsRow, '', ...sparkBox, '', ...sessionsBox, '',
      ...lineChartBox, '', ...histRow, '', footer,
    ];
    const frame = HOME + lines.join(CLEAR_EOL + '\r\n') + CLEAR_EOL + CLEAR_EOS;
    try { process.stdout.write(frame); } catch (_) {}
  }

  // Cost/token tracking runs on its own async loop, off the render path — the
  // render only reads the in-memory totals it accumulates.
  tracker.start(getSessions, 1000);
  // Historical per-day aggregation runs on its own slow loop (every 20s); the
  // render reads its in-memory day buckets, never the disk.
  history.start();

  const safeRender = () => { try { renderFrame(); } catch (_) {} };
  safeRender();
  setInterval(safeRender, 1000);
  // Redraw immediately on window resize (clear-to-end handles stale cells) so
  // the layout re-fits without waiting for the next tick.
  if (process.stdout.on) process.stdout.on('resize', safeRender);
}

module.exports = { startDashboard };
