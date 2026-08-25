'use strict';

// Distinct series colors — mirror the TUI dashboard's SERIES_COLORS.
const SERIES = ['#8296ff', '#5ad278', '#ffb000', '#64d2dc', '#dc78dc'];
const POLL_MS = 3000;

const $ = (id) => document.getElementById(id);

function getCfg() {
  return new Promise((res) => {
    chrome.storage.local.get(['ct_cfg'], (o) => {
      const c = o.ct_cfg || {};
      res({ host: c.host || '127.0.0.1', port: c.port || '3777', token: c.token || '' });
    });
  });
}

// ---- formatting ----
function fmtUsd(n) { return '$' + (Number(n) || 0).toFixed(4); }
function fmtCompact(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (x) => String(x).padStart(2, '0');
  return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
}
function fmtKb(bytes) { return ((Number(bytes) || 0) / 1024).toFixed(1) + 'KB'; }
function shortModel(m) { return String(m || '').replace(/^claude-/, ''); }

// ---- renderers ----
function renderHeader(st) {
  const s = st.server;
  $('serverline').textContent =
    `${s.host}:${s.port} · v${s.version} · up ${fmtElapsed(s.uptimeMs)}` +
    (s.restored ? ` · restored ${s.restored}` : '');
}

function statCard(k, v, sub, cls) {
  return `<div class="stat"><div class="k">${k}</div>` +
    `<div class="v ${cls || ''}">${v}</div>` +
    (sub ? `<div class="sub2">${sub}</div>` : '') + `</div>`;
}
function renderCards(st) {
  const r = st.run;
  $('cards').innerHTML = [
    statCard('Cost (this run)', fmtUsd(r.costUsd), `${r.trackedSessionCount}/${r.totalSessions} tracked`, 'green'),
    statCard('Tokens in + out', fmtCompact(r.inputTokens + r.outputTokens), `${fmtCompact(r.inputTokens)} in · ${fmtCompact(r.outputTokens)} out`),
    statCard('Cache w / r', `${fmtCompact(r.cacheCreationTokens)} / ${fmtCompact(r.cacheReadTokens)}`, 'write / read tokens'),
    statCard('Sessions', String(r.totalSessions), `30d cost ${fmtUsd(st.history.windowTotals.costUsd)}`, 'cyan'),
  ].join('');
}

function bar(value, target, label, valStr) {
  const pct = target > 0 ? value / target : 0;
  const w = Math.max(0, Math.min(100, pct * 100));
  const cls = pct >= 0.9 ? 'hot' : pct >= 0.7 ? 'warn' : '';
  const pctStr = target > 0 ? Math.round(pct * 100) + '% used' : 'no target';
  return `<div class="bud"><div class="bud-top"><span>${label}</span>` +
    `<span class="r">${valStr} · ${pctStr}</span></div>` +
    `<div class="bar"><span class="${cls}" style="width:${w}%"></span></div></div>`;
}
function renderBudget(st) {
  const r = st.run, w = st.history.windowTotals, b = st.budget;
  $('budget').innerHTML =
    bar(r.costUsd, b.usd, 'Run cost', `${fmtUsd(r.costUsd)} / ${fmtUsd(b.usd)}`) +
    bar(w.inputTokens + w.outputTokens, b.tokens, '30d tokens',
      `${fmtCompact(w.inputTokens + w.outputTokens)} / ${fmtCompact(b.tokens)}`);
}

function renderHeatmap(st) {
  const days = st.history.days;
  const vals = days.map((d) => d.totals.inputTokens + d.totals.outputTokens);
  const max = Math.max(1, ...vals);
  const level = (v) => {
    if (v <= 0) return 0;
    const r = v / max;
    return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
  };
  const weeks = [];
  let cur = null;
  days.forEach((d, i) => {
    const wd = (new Date(d.date + 'T00:00:00').getDay() + 6) % 7; // Mon=0
    if (i === 0) cur = new Array(7).fill(null);
    else if (wd === 0) { weeks.push(cur); cur = new Array(7).fill(null); }
    cur[wd] = { lvl: level(vals[i]), v: vals[i], date: d.date };
  });
  if (cur) weeks.push(cur);
  $('heatmap').innerHTML = weeks.map((wk) =>
    '<div class="hm-week">' + wk.map((c) => {
      if (!c) return '<div class="hm-day"></div>';
      const cls = c.lvl ? ' l' + c.lvl : '';
      return `<div class="hm-day${cls}" title="${c.date}: ${fmtCompact(c.v)} tok"></div>`;
    }).join('') + '</div>'
  ).join('');
}

function renderLegend(models) {
  $('legend').innerHTML = models.length
    ? models.map((m, i) =>
        `<span class="item"><span class="dot" style="background:${SERIES[i % SERIES.length]}"></span>${shortModel(m)}</span>`
      ).join('')
    : '<span class="muted">no history yet — the server is scanning transcripts…</span>';
}

function renderChart(st) {
  const days = st.history.days;
  const models = st.history.topModels;
  renderLegend(models);

  const cvs = $('chart');
  const cssW = cvs.clientWidth || 600;
  const cssH = 220;
  const dpr = window.devicePixelRatio || 1;
  cvs.width = Math.round(cssW * dpr);
  cvs.height = Math.round(cssH * dpr);
  const ctx = cvs.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 46, padR = 12, padT = 12, padB = 24;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const series = models.map((m) => days.map((d) => {
    const t = d.perModel[m];
    return t ? (t.inputTokens + t.outputTokens) : 0;
  }));
  let max = 1;
  series.forEach((sv) => sv.forEach((v) => { if (v > max) max = v; }));

  const n = days.length;
  const xAt = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const yAt = (v) => padT + (1 - v / max) * plotH;

  // gridlines + y labels
  ctx.strokeStyle = '#242424';
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 2; g++) {
    const v = max * (1 - g / 2);
    const y = yAt(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.fillText(fmtCompact(v), padL - 6, y);
  }

  // x date labels (~4 ticks)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (n > 0) {
    const ticks = n <= 1 ? [0] : [0, Math.floor((n - 1) / 3), Math.floor(2 * (n - 1) / 3), n - 1];
    [...new Set(ticks)].forEach((i) => {
      const d = days[i].date.slice(5); // MM-DD
      ctx.fillText(d, xAt(i), padT + plotH + 6);
    });
  }

  // series lines
  series.forEach((sv, si) => {
    ctx.strokeStyle = SERIES[si % SERIES.length];
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const x = xAt(i), y = yAt(sv[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}

function renderSessions(st) {
  const tb = $('sessions').querySelector('tbody');
  if (!st.sessions.length) {
    tb.innerHTML = '<tr><td colspan="8" class="muted">no sessions</td></tr>';
    return;
  }
  tb.innerHTML = st.sessions.map((s) => {
    let cost = '<span class="cost none">—</span>';
    if (s.hasData) {
      cost = (s.unknownModel && s.costUsd === 0)
        ? '<span class="cost">?</span>'
        : `<span class="cost">${fmtUsd(s.costUsd)}</span>`;
    }
    let state = '<span class="muted">—</span>';
    if (s.isClaude && !s.exited) {
      const label = s.mode && s.mode !== 'default' ? s.mode : s.state;
      state = `<span class="badge"><span class="sdot ${s.state}"></span>${label}</span>`;
    }
    const models = s.isClaude ? (s.models.length ? s.models.map(shortModel).join(', ') : '…') : '—';
    return `<tr class="${s.exited ? 'dead' : ''}">` +
      `<td>${escapeHtml(s.name)}</td>` +
      `<td>${escapeHtml(s.shellId)}</td>` +
      `<td class="num">${fmtElapsed(s.elapsedMs)}</td>` +
      `<td class="num">${fmtKb(s.bufferBytes)}</td>` +
      `<td class="num">${s.clients}</td>` +
      `<td>${state}</td>` +
      `<td class="model">${escapeHtml(models)}</td>` +
      `<td class="num">${cost}</td></tr>`;
  }).join('');
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- load loop ----
let cfg = null;
let lastStats = null;

function renderUsage(st) {
  renderCards(st);
  renderBudget(st);
  renderHeatmap(st);
  renderChart(st);
  renderSessions(st);
}

async function tick() {
  if (!cfg) cfg = await getCfg();
  const base = `http://${cfg.host}:${cfg.port}`;
  try {
    const r = await fetch(base + '/dashboard/stats', { headers: { 'x-ct-token': cfg.token }, cache: 'no-store' });
    if (!r.ok) throw new Error('http ' + r.status);
    const st = await r.json();
    lastStats = st;
    $('offline').classList.add('hidden');
    $('conn').className = 'conn ok';
    renderHeader(st);
    if (currentView === 'usage') renderUsage(st);
    renderAgents(st);       // always: keeps badge/title/twin states fresh even on Usage
    restoreTwins(st);       // first-tick only: reopen terminals from the previous visit
  } catch (e) {
    $('conn').className = 'conn off';
    $('offline').classList.remove('hidden');
    $('serverline').textContent = 'disconnected';
  }
}

$('refresh').addEventListener('click', () => tick());
// re-read config if the user changes host/port/token in the side panel;
// track session↔tab links (ct_panes) live for the tab mirrors
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ct_cfg) { cfg = null; tick(); }
  if (changes.ct_panes) { panesMap = changes.ct_panes.newValue || {}; if (lastStats) renderAgents(lastStats); }
});
// redraw the chart crisply on resize
let rt = 0;
window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(tick, 150); });

/* ===================================================================== */
/* ============================ AGENTS HUB ============================= */
/* ===================================================================== */

const STATE_META = {
  waiting: { ord: 0, icon: '✋', label: 'needs you' },
  busy:    { ord: 1, icon: '⚡', label: 'working…' },
  idle:    { ord: 2, icon: '✔', label: 'idle — your turn' },
  shell:   { ord: 3, icon: '＞_', label: 'shell' },
  dead:    { ord: 4, icon: '✖', label: 'exited' },
};
// permission mode → icon; mirrors sidepanel.js / background.js
const MODE_EMOJI = { plan: '📋', acceptEdits: '⏩', bypassPermissions: '⚠️' };

function agentState(s) { return s.exited ? 'dead' : !s.isClaude ? 'shell' : (s.state || 'idle'); }
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; }

// ---- view switching ----
let currentView = location.hash === '#agents' ? 'agents' : 'usage';
function setView(v) {
  currentView = v;
  document.querySelectorAll('.vtab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('view-usage').classList.toggle('hidden', v !== 'usage');
  $('view-agents').classList.toggle('hidden', v !== 'agents');
  try { history.replaceState(null, '', v === 'agents' ? '#agents' : '#'); } catch (_) {}
  if (lastStats) {
    if (v === 'usage') renderUsage(lastStats);
    else { renderAgents(lastStats); refitTwins(); mirrorTick(); }
  }
}
$('viewTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.vtab'); if (b) setView(b.dataset.view);
});

// ---- session ↔ tab links (ct_panes, same store the side panel writes) ----
let panesMap = {};
chrome.storage.local.get(['ct_panes'], (o) => { panesMap = o.ct_panes || {}; });
function linkedTabs(id) {
  const out = [];
  for (const [tid, v] of Object.entries(panesMap)) {
    if (v && Array.isArray(v.ids) && v.ids.includes(id)) out.push(Number(tid));
  }
  return out;
}

// ---- agent cards ----
const cards = new Map();   // sessionId -> element refs
let cardOrderKey = '';

function makeCard(s) {
  const el = document.createElement('div');
  el.className = 'acard'; el.dataset.id = s.id; el.title = 'Open terminal';
  el.innerHTML =
    '<div class="acard-top"><span class="adot"></span><span class="acard-ic"></span>' +
    '<div style="min-width:0;flex:1"><div class="acard-name"></div><div class="acard-cwd"></div></div></div>' +
    '<div class="acard-state"><span class="lbl"></span><span class="mode"></span></div>' +
    '<div class="m-slot"></div>' +
    '<div class="acard-meta"><span class="elapsed"></span><span class="cost"></span><span class="mdl"></span></div>' +
    '<div class="acard-btns"><button class="b-term">⌨ Terminal</button></div>';
  const q = (sel) => el.querySelector(sel);
  const c = { el, dot: q('.adot'), ic: q('.acard-ic'), name: q('.acard-name'), cwd: q('.acard-cwd'),
    lbl: q('.lbl'), mode: q('.mode'), slot: q('.m-slot'),
    elapsed: q('.elapsed'), cost: q('.cost'), mdl: q('.mdl') };
  el.addEventListener('click', (e) => {
    if (e.target.closest('.mirror')) return;   // mirror clicks jump to the tab instead
    openTwin(s.id, {}, el);                    // spawn the window next to this card
  });
  return c;
}

function updateCard(c, s) {
  const st = agentState(s);
  const opened = twins.has(s.id) && !twins.get(s.id).min;
  c.el.className = 'acard st-' + st + (st === 'dead' ? ' dead' : '') + (opened ? ' opened' : '');
  c.dot.className = 'adot ' + st;
  c.ic.textContent = s.icon || '🖥️';
  c.name.textContent = s.name;
  c.cwd.textContent = baseName(s.cwd) || s.shellId;
  const M = STATE_META[st];
  c.lbl.className = 'lbl ' + st;
  c.lbl.textContent = M.icon + ' ' + M.label;
  c.mode.textContent = (s.isClaude && !s.exited && MODE_EMOJI[s.mode]) || '';
  c.mode.title = s.mode && s.mode !== 'default' ? s.mode + ' mode' : '';
  c.elapsed.textContent = '⏱ ' + fmtElapsed(s.elapsedMs);
  c.cost.textContent = s.hasData ? fmtUsd(s.costUsd) : '';
  c.mdl.textContent = s.isClaude ? (s.models || []).map(shortModel).join(', ') : '';
}

function renderAgents(st) {
  const sessions = st.sessions.slice().sort((a, b) => {
    const d = STATE_META[agentState(a)].ord - STATE_META[agentState(b)].ord;
    return d || String(a.name).localeCompare(String(b.name));
  });
  const counts = { waiting: 0, busy: 0, idle: 0, shell: 0, dead: 0 };
  sessions.forEach((s) => counts[agentState(s)]++);
  updateBadge(counts);
  updateDocTitle(counts);
  updateTwinStates(st);
  if (currentView !== 'agents') return;

  // summary pills
  const pills = [];
  const pill = (dotCls, n, label) =>
    `<span class="ag-pill"><span class="adot ${dotCls}"></span><b>${n}</b> ${label}</span>`;
  if (counts.waiting) pills.push(pill('waiting', counts.waiting, counts.waiting > 1 ? 'need you' : 'needs you'));
  if (counts.busy) pills.push(pill('busy', counts.busy, 'working'));
  if (counts.idle) pills.push(pill('idle', counts.idle, 'idle'));
  if (counts.shell) pills.push(pill('shell', counts.shell, counts.shell > 1 ? 'plain shells' : 'plain shell'));
  if (counts.dead) pills.push(pill('dead', counts.dead, 'exited'));
  pills.push(`<span class="ag-pill">💸 <b>${fmtUsd(st.run.costUsd)}</b> this run</span>`);
  $('agentsSummary').innerHTML = pills.join('');

  // reconcile cards (update in place — rebuilding would reload the mirror iframes)
  const grid = $('agentsGrid');
  if (!sessions.length) {
    for (const [id, c] of cards) { c.el.remove(); cards.delete(id); removeMirror(id); }
    grid.innerHTML = '<div class="muted">no sessions — open one from the side panel</div>';
    cardOrderKey = '';
    return;
  }
  if (!cards.size) grid.innerHTML = '';
  const seen = new Set();
  for (const s of sessions) {
    seen.add(s.id);
    let c = cards.get(s.id);
    if (!c) { c = makeCard(s); cards.set(s.id, c); grid.appendChild(c.el); }
    updateCard(c, s);
  }
  for (const [id, c] of cards) {
    if (!seen.has(id)) { c.el.remove(); cards.delete(id); removeMirror(id); }
  }
  const key = sessions.map((s) => s.id).join(',');
  if (key !== cardOrderKey) {   // reorder only on real change — moving nodes reloads iframes
    cardOrderKey = key;
    sessions.forEach((s) => grid.appendChild(cards.get(s.id).el));
  }
  syncMirrors(st);
}

function updateBadge(c) {
  const b = $('agentsBadge');
  if (c.waiting) { b.textContent = c.waiting; b.className = 'badge-n'; }
  else if (c.busy) { b.textContent = c.busy; b.className = 'badge-n busy'; }
  else b.className = 'badge-n hidden';
}
function updateDocTitle(c) {
  const parts = [];
  if (c.waiting) parts.push('✋' + c.waiting);
  if (c.busy) parts.push('⚡' + c.busy);
  document.title = (parts.length ? parts.join(' ') + ' · ' : '') + 'Power Shell(ed)';
}

// ---- live tab mirrors (DOM captured via chrome.scripting — no debugger banner) ----
const mirrors = new Map();   // sessionId -> mirror

function makeMirror(id, tabId) {
  const el = document.createElement('div');
  el.className = 'mirror'; el.title = 'Jump to this tab';
  el.innerHTML =
    '<div class="mirror-cap"><img class="fav" alt=""><span class="ttl">…</span><span class="live">● LIVE</span></div>' +
    '<div class="mirror-view"></div>';
  const m = { id, tabId, el, view: el.querySelector('.mirror-view'),
    fav: el.querySelector('.fav'), ttl: el.querySelector('.ttl'), iframe: null, lastHtml: '' };
  m.fav.style.display = 'none';   // until a real favicon URL arrives
  el.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const t = await chrome.tabs.get(m.tabId);
      await chrome.tabs.update(m.tabId, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
    } catch (_) {}
  });
  return m;
}

function syncMirrors(st) {
  for (const s of st.sessions) {
    const c = cards.get(s.id); if (!c) continue;
    const tabs = s.exited ? [] : linkedTabs(s.id);
    let m = mirrors.get(s.id);
    if (!tabs.length) { if (m) removeMirror(s.id); continue; }
    if (!m || !tabs.includes(m.tabId)) {
      if (m) removeMirror(s.id);
      m = makeMirror(s.id, tabs[0]);
      mirrors.set(s.id, m);
      c.slot.appendChild(m.el);
      captureMirror(m);
    } else if (m.el.parentNode !== c.slot) {
      c.slot.appendChild(m.el);
    }
  }
  for (const id of [...mirrors.keys()]) if (!cards.has(id)) removeMirror(id);
}
function removeMirror(id) {
  const m = mirrors.get(id);
  if (m) { m.el.remove(); mirrors.delete(id); }
}

// Runs INSIDE the target tab (serialized — must be self-contained).
function grabDom() {
  try {
    const de = document.documentElement;
    let html = de ? de.outerHTML : '';
    if (html.length > 1500000) html = html.slice(0, 1500000);
    return { ok: true, html, base: document.baseURI,
      w: innerWidth, h: innerHeight, sy: scrollY, title: document.title };
  } catch (e) { return { ok: false, err: String(e) }; }
}

async function captureMirror(m) {
  let tab = null;
  try { tab = await chrome.tabs.get(m.tabId); } catch (_) { return mirrorFallback(m, 'tab closed'); }
  m.ttl.textContent = tab.title || tab.url || '';
  if (tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)) { m.fav.src = tab.favIconUrl; m.fav.style.display = ''; }
  else m.fav.style.display = 'none';
  let cap = null;
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: m.tabId }, func: grabDom });
    cap = res && res[0] && res[0].result;
  } catch (_) {}
  if (!cap || !cap.ok) return mirrorFallback(m, 'preview unavailable for this page');
  applyCapture(m, cap);
}

function mirrorFallback(m, msg) {
  if (m.iframe) { m.iframe = null; m.lastHtml = ''; }
  const f = m.view.querySelector('.mirror-fallback');
  if (f) f.textContent = msg;
  else m.view.innerHTML = `<div class="mirror-fallback">${escapeHtml(msg)}</div>`;
  m.view.style.height = '';
}

function applyCapture(m, cap) {
  // strip scripts (the sandbox blocks them anyway) + anchor relative URLs on the page origin
  let html = String(cap.html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '');
  const baseTag = `<base href="${String(cap.base || '').replace(/"/g, '&quot;')}">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (t) => t + baseTag) : baseTag + html;

  const w = Math.max(320, cap.w || 1280);
  const h = Math.max(200, cap.h || 800);
  const sy = Math.max(0, cap.sy || 0);
  const viewW = m.view.clientWidth || m.el.clientWidth || 280;
  const scale = viewW / w;
  m.view.style.height = Math.round(Math.min(170, h * scale)) + 'px';
  if (!m.iframe) {
    m.view.innerHTML = '';
    m.iframe = document.createElement('iframe');
    m.iframe.setAttribute('sandbox', '');       // fully sandboxed: no scripts, opaque origin
    m.iframe.setAttribute('scrolling', 'no');
    m.view.appendChild(m.iframe);
  }
  m.iframe.style.width = w + 'px';
  m.iframe.style.height = (sy + h + 50) + 'px';   // lay content out down to the viewport bottom
  m.iframe.style.transform = `scale(${scale})`;
  m.iframe.style.top = (-sy * scale) + 'px';      // show what the tab is actually scrolled to
  if (html !== m.lastHtml) { m.lastHtml = html; m.iframe.srcdoc = html; }
}

let mirrorBusy = false;
async function mirrorTick() {
  if (currentView !== 'agents' || document.visibilityState !== 'visible' || mirrorBusy) return;
  mirrorBusy = true;
  try { for (const m of [...mirrors.values()]) await captureMirror(m); }
  finally { mirrorBusy = false; }
}
setInterval(mirrorTick, 6000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') mirrorTick();
});

// ---- floating terminal windows ----
const twins = new Map();   // sessionId -> twin
const TERM_THEME = { background: '#0c0c0c', foreground: '#e8e8e8', cursor: '#ffb000' };
let zTop = 50;
function bringToFront(t) { t.el.style.zIndex = ++zTop; }

// spawn next to the clicked card when it fits, else cascade from the top-left
function spawnPos(anchorEl, w, h) {
  if (anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    let x = r.right + 12;
    if (x + w > innerWidth - 8) x = r.left - w - 12;
    if (x < 8) x = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const y = Math.max(66, Math.min(r.top, innerHeight - h - 10));
    return { x: Math.round(x), y: Math.round(y) };
  }
  const n = twins.size % 6;
  return { x: 90 + n * 36, y: 90 + n * 30 };
}

function openTwin(id, opts = {}, anchorEl = null) {
  let t = twins.get(id);
  if (t) { if (t.min) restoreTwin(t); else { bringToFront(t); t.term.focus(); } return; }

  const el = document.createElement('div');
  el.className = 'twin'; el.dataset.id = id;
  el.innerHTML =
    '<div class="twin-head"><span class="adot"></span><span class="t-ic"></span><span class="t-name">…</span>' +
    '<button class="t-max" title="Expand">⛶</button>' +
    '<button class="t-min" title="Minimize to tray">–</button>' +
    '<button class="t-close" title="Close view (session keeps running)">✕</button></div>' +
    '<div class="twin-body"></div>';
  document.body.appendChild(el);

  const w = Math.max(380, opts.w || 640);
  const h = Math.max(220, opts.h || 420);
  const pos = (opts.x != null && opts.y != null) ? { x: opts.x, y: opts.y } : spawnPos(anchorEl, w, h);
  const g = {
    x: Math.max(0, Math.min(pos.x, innerWidth - 120)),
    y: Math.max(0, Math.min(pos.y, innerHeight - 80)),
    w, h,
  };
  el.style.left = g.x + 'px'; el.style.top = g.y + 'px';
  el.style.width = g.w + 'px'; el.style.height = g.h + 'px';
  const body = el.querySelector('.twin-body');
  const term = new Terminal({
    cursorBlink: true, fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 13, theme: TERM_THEME, scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(body);
  t = { id, el, term, fit, ws: null, chip: null, min: false, max: !!opts.max, geom: g,
    closing: false, retry: null, backoff: 1000,
    dot: el.querySelector('.adot'), ic: el.querySelector('.t-ic'), nm: el.querySelector('.t-name') };
  twins.set(id, t);
  if (t.max) el.classList.add('max');
  bringToFront(t);
  el.addEventListener('mousedown', () => bringToFront(t));

  // drag by the header (buttons excluded)
  const head = el.querySelector('.twin-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || t.max) return;
    e.preventDefault();
    bringToFront(t);
    const dx = e.clientX - el.offsetLeft, dy = e.clientY - el.offsetTop;
    const move = (ev) => {
      el.style.left = Math.max(-el.offsetWidth + 90, Math.min(ev.clientX - dx, innerWidth - 50)) + 'px';
      el.style.top = Math.max(0, Math.min(ev.clientY - dy, innerHeight - 40)) + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      t.geom.x = el.offsetLeft; t.geom.y = el.offsetTop;
      persistTwins();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // corner resize (CSS resize:both) → refit the terminal + remember the size
  t.ro = new ResizeObserver(() => {
    clearTimeout(t._rt);
    t._rt = setTimeout(() => {
      if (!t.min) {
        fitTwin(t);
        if (!t.max) { t.geom.w = el.offsetWidth; t.geom.h = el.offsetHeight; persistTwins(); }
      }
    }, 100);
  });
  t.ro.observe(el);

  term.onData((d) => { if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ t: 'in', d })); });
  // Same Claude-friendly keys as the side panel: Shift/Ctrl+Enter = newline, Ctrl+V paste combo
  term.attachCustomKeyEventHandler((e) => {
    const send = (d) => { if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ t: 'in', d })); };
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault(); send('\x0a'); return false;
    }
    if (e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === 'Enter') { e.preventDefault(); send('\x0a'); return false; }
      if (e.key === 'v' || e.key === 'V') { e.preventDefault(); send('\x1bv\x16'); return false; }
      const cur = term.options ? term.options.fontSize : 13;
      const setFs = (n) => { n = Math.max(6, Math.min(40, n)); try { term.options.fontSize = n; } catch (_) {} fitTwin(t); };
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setFs(cur + 1); return false; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); setFs(cur - 1); return false; }
      if (e.key === '0') { e.preventDefault(); setFs(13); return false; }
    }
    return true;
  });

  el.querySelector('.t-close').addEventListener('click', () => closeTwin(t));
  el.querySelector('.t-min').addEventListener('click', () => minimizeTwin(t));
  el.querySelector('.t-max').addEventListener('click', () => {
    t.max = !t.max; el.classList.toggle('max', t.max); fitTwin(t); persistTwins();
  });

  connectTwin(t);
  if (opts.min) minimizeTwin(t); else fitTwin(t);
  persistTwins();
  if (lastStats) renderAgents(lastStats);
}

function connectTwin(t) {
  if (!cfg) return;
  const url = `ws://${cfg.host}:${cfg.port}/attach?id=${encodeURIComponent(t.id)}&token=${encodeURIComponent(cfg.token)}`;
  const ws = new WebSocket(url); t.ws = ws;
  ws.onopen = () => { t.backoff = 1000; fitTwin(t); };
  ws.onclose = () => {
    if (t.closing || !twins.has(t.id)) return;
    clearTimeout(t.retry);
    t.retry = setTimeout(() => { if (!t.closing && twins.has(t.id)) connectTwin(t); }, t.backoff);
    t.backoff = Math.min(t.backoff * 2, 10000);
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'hello') {
      t.nm.textContent = m.session.name;
      t.ic.textContent = m.session.icon || '';
      if (t.chip) {
        t.chip.querySelector('.c-nm').textContent = m.session.name;
        t.chip.querySelector('.c-ic').textContent = m.session.icon || '';
      }
    }
    else if (m.t === 'out') t.term.write(m.d);
    else if (m.t === 'exit') t.term.write(`\r\n\x1b[90m[process exited: ${m.code}]\x1b[0m\r\n`);
    else if (m.t === 'killed') { t.closing = true; t.term.write('\r\n\x1b[90m[terminal killed]\x1b[0m\r\n'); }
  };
}

function fitTwin(t) {
  if (t.min) return;
  requestAnimationFrame(() => {
    try { t.fit.fit(); } catch (_) {}
    if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ t: 'resize', c: t.term.cols, r: t.term.rows }));
    try { t.term.refresh(0, t.term.rows - 1); } catch (_) {}
  });
}
function refitTwins() { for (const t of twins.values()) fitTwin(t); }
window.addEventListener('resize', () => { clearTimeout(refitTwins._t); refitTwins._t = setTimeout(refitTwins, 160); });

function closeTwin(t) {
  t.closing = true;
  clearTimeout(t.retry);
  try { t.ro && t.ro.disconnect(); } catch (_) {}
  try { t.ws && t.ws.close(); } catch (_) {}
  try { t.term.dispose(); } catch (_) {}
  t.el.remove();
  removeChip(t); updateTray();
  twins.delete(t.id);
  persistTwins(); refitTwins();
  if (lastStats) renderAgents(lastStats);
}

function minimizeTwin(t) {
  t.min = true; t.el.style.display = 'none';
  const chip = document.createElement('span');
  chip.className = 'tray-chip'; chip.dataset.id = t.id; chip.title = 'Restore terminal';
  chip.innerHTML = '<span class="adot"></span><span class="c-ic"></span><span class="c-nm"></span><span class="x" title="Close">✕</span>';
  chip.querySelector('.adot').className = t.dot.className;
  chip.querySelector('.c-ic').textContent = t.ic.textContent;
  chip.querySelector('.c-nm').textContent = t.nm.textContent;
  chip.addEventListener('click', (e) => {
    if (e.target.classList.contains('x')) closeTwin(t); else restoreTwin(t);
  });
  $('tray').appendChild(chip);
  t.chip = chip;
  updateTray(); persistTwins();
  if (lastStats) renderAgents(lastStats);
}

function restoreTwin(t) {
  t.min = false; t.el.style.display = '';
  // clamp back into the current viewport (window may have changed while minimized)
  t.geom.x = Math.max(0, Math.min(t.geom.x, innerWidth - 120));
  t.geom.y = Math.max(0, Math.min(t.geom.y, innerHeight - 80));
  t.el.style.left = t.geom.x + 'px'; t.el.style.top = t.geom.y + 'px';
  removeChip(t); updateTray(); bringToFront(t);
  fitTwin(t); persistTwins();
  if (lastStats) renderAgents(lastStats);
}
function removeChip(t) { if (t.chip) { t.chip.remove(); t.chip = null; } }
function updateTray() { $('tray').classList.toggle('hidden', !$('tray').children.length); }

function updateTwinStates(st) {
  for (const t of twins.values()) {
    const s = st.sessions.find((x) => x.id === t.id);
    if (!s) continue;
    const cls = 'adot ' + agentState(s);
    t.dot.className = cls;
    if (t.chip) t.chip.querySelector('.adot').className = cls;
  }
}

// remember which terminals were open (per browser, survives dashboard reloads)
function persistTwins() {
  try {
    localStorage.setItem('ct_dash_twins',
      JSON.stringify([...twins.values()].map((t) => ({
        id: t.id, min: t.min, max: t.max,
        x: t.geom.x, y: t.geom.y, w: t.geom.w, h: t.geom.h,
      }))));
  } catch (_) {}
}
let twinsRestored = false;
function restoreTwins(st) {
  if (twinsRestored) return;
  twinsRestored = true;
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('ct_dash_twins')) || []; } catch (_) {}
  const live = new Set(st.sessions.filter((s) => !s.exited).map((s) => s.id));
  for (const o of saved) if (o && live.has(o.id)) openTwin(o.id, o);
}

setView(currentView);
tick();
setInterval(tick, POLL_MS);
