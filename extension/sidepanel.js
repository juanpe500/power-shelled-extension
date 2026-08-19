'use strict';

// ---- config -------------------------------------------------------------
// Terminals are always per-tab: a session is bound to the tab it was opened in,
// does not follow you to other tabs, and auto-reattaches when you return.
const DEFAULTS = { host: '127.0.0.1', port: '3777', token: '' };
let cfg = { ...DEFAULTS };
let paneStore = {};     // { tabId: {ids:[sessionId,...], orient:'cols'|'rows'} } (persisted as ct_panes)
let panes = [];         // live panes for the current tab: [{id, term, fit, ws, el, host, ic, nm, meta}]
let focusedId = null;   // which pane has focus (drives the top-bar title + conn dot)
let zoomStore = {};     // { sessionId: fontSizePx } — per-session zoom (persisted as ct_zoom)
let theme = {};         // global look overrides { border, termBg } (persisted as ct_theme)
const DEFAULT_THEME = { border: '#0e4c00', termBg: '#000000' };   // filled from :root at boot
const MAX_PANES = 6;
const DEFAULT_FONT = 13, MIN_FONT = 6, MAX_FONT = 40;
let currentTabId = null, currentWinId = null;
let lastList = [];

const $ = (id) => document.getElementById(id);
const httpBase = () => `http://${cfg.host}:${cfg.port}`;
const wsBase = () => `ws://${cfg.host}:${cfg.port}`;

function setStatus(msg) { $('status').textContent = msg; }
function setConnected(on) { $('dot').classList.toggle('on', !!on); $('dot').title = on ? 'connected' : 'disconnected'; }

async function api(path, opts = {}) {
  const r = await fetch(httpBase() + path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-ct-token': cfg.token, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`);
  return r.status === 204 ? null : r.json();
}

// ---- storage ------------------------------------------------------------
function loadState() {
  return new Promise((res) => {
    chrome.storage.local.get(['ct_cfg', 'ct_panes', 'ct_bindings', 'ct_zoom', 'ct_workspaces', 'ct_favorites', 'ct_theme'], (o) => {
      if (o.ct_cfg) cfg = { ...DEFAULTS, ...o.ct_cfg };
      zoomStore = o.ct_zoom || {};
      theme = o.ct_theme || {};
      workspaces = o.ct_workspaces || [];
      favorites = o.ct_favorites || [];
      if (o.ct_panes) paneStore = o.ct_panes;
      else if (o.ct_bindings) {                 // migrate old one-session-per-tab format
        paneStore = {};
        for (const [t, sid] of Object.entries(o.ct_bindings)) paneStore[t] = { ids: [sid], orient: 'cols' };
        chrome.storage.local.set({ ct_panes: paneStore });
      } else paneStore = {};
      res();
    });
  });
}
function saveCfg() { chrome.storage.local.set({ ct_cfg: cfg }); }
function savePanes() { chrome.storage.local.set({ ct_panes: paneStore }); }
function saveZoom() { chrome.storage.local.set({ ct_zoom: zoomStore }); }

// current tab's pane record + accessors
function tabRec() { return currentTabId != null ? paneStore[currentTabId] : null; }
function tabIds() { const r = tabRec(); return r && r.ids ? r.ids : []; }
function tabOrient() { const r = tabRec(); return (r && r.orient) || 'cols'; }
function setTabRec(ids, orient) {
  if (currentTabId == null) return;
  if (ids.length) paneStore[currentTabId] = { ids, orient: orient || tabOrient() };
  else delete paneStore[currentTabId];
  savePanes();
}

// ---- tab awareness ------------------------------------------------------
async function initTab() {
  try {
    const w = await chrome.windows.getCurrent();
    currentWinId = w.id;
    const tabs = await chrome.tabs.query({ active: true, windowId: w.id });
    currentTabId = tabs[0] ? tabs[0].id : null;
  } catch (_) {}
}
chrome.tabs.onActivated.addListener((info) => {
  if (info.windowId !== currentWinId) return;
  currentTabId = info.tabId;
  applyView();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (paneStore[tabId]) { delete paneStore[tabId]; savePanes(); }
});
// Keep our in-memory paneStore synced with what other panel documents write, so a
// stale copy never clobbers another tab's panes (and the background's tab-grouping
// stays correct).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ct_panes) { paneStore = changes.ct_panes.newValue || {}; applyView(); renderList(lastList); }
  if (changes.ct_workspaces) { workspaces = changes.ct_workspaces.newValue || []; renderWsChips(); renderWsEditor(); }
  if (changes.ct_favorites) { favorites = changes.ct_favorites.newValue || []; renderFavList(); renderDrawerFavs(); updateFavStar(); }
  if (changes.ct_theme) { theme = changes.ct_theme.newValue || {}; applyTheme(); populateCustomInputs(); }
});

// ---- panes (multi-terminal grid) ----------------------------------------
function termColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    background: cs.getPropertyValue('--term-bg').trim() || '#1a1b1e',
    foreground: cs.getPropertyValue('--term-fg').trim() || '#e6e6e6',
  };
}
// ---- global theme (Customization tab): border color + terminal background ---
function saveTheme() { chrome.storage.local.set({ ct_theme: theme }); }
// Snapshot the :root defaults once, before any override is applied, so "Reset"
// and the color pickers know the baseline.
function readDefaultTheme() {
  const cs = getComputedStyle(document.documentElement);
  const b = cs.getPropertyValue('--border').trim();
  const t = cs.getPropertyValue('--term-bg').trim();
  if (b) DEFAULT_THEME.border = b;
  if (t) DEFAULT_THEME.termBg = t;
}
function effTheme() {
  return { border: theme.border || DEFAULT_THEME.border, termBg: theme.termBg || DEFAULT_THEME.termBg };
}
// Push overrides onto :root (or clear them) and re-tint any live terminals.
function applyTheme() {
  const s = document.documentElement.style;
  if (theme.border) s.setProperty('--border', theme.border); else s.removeProperty('--border');
  if (theme.termBg) s.setProperty('--term-bg', theme.termBg); else s.removeProperty('--term-bg');
  retintPanes();
}
function retintPanes() {
  const t = termColors();
  for (const p of panes) {
    try { if (p.term.options) p.term.options.theme = t; else p.term.setOption('theme', t); } catch (_) {}
  }
}
function populateCustomInputs() {
  const e = effTheme();
  $('cust-border').value = e.border; $('cust-border-hex').textContent = e.border;
  $('cust-termbg').value = e.termBg; $('cust-termbg-hex').textContent = e.termBg;
}

function makePane(id) {
  const wrap = document.createElement('div'); wrap.className = 'pane'; wrap.dataset.id = id;
  const head = document.createElement('div'); head.className = 'pane-head';
  const ic = document.createElement('span'); ic.className = 'p-ic';
  const nm = document.createElement('span'); nm.className = 'p-name'; nm.textContent = '…';
  const hide = document.createElement('button'); hide.className = 'p-hide'; hide.textContent = '–';
  hide.title = 'Hide pane (session keeps running)';
  const close = document.createElement('button'); close.className = 'p-close'; close.textContent = '✕';
  close.title = 'Delete session (ends the process)';
  head.append(ic, nm, hide, close);
  const host = document.createElement('div'); host.className = 'pane-host';
  wrap.append(head, host);
  $('panes').appendChild(wrap);

  const term = new Terminal({
    cursorBlink: true, fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: zoomStore[id] || DEFAULT_FONT, theme: termColors(), scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host);
  const pane = { id, term, fit, ws: null, el: wrap, host, ic, nm, meta: null, closing: false, retry: null, backoff: 1000 };
  panes.push(pane);

  term.onData((d) => { if (pane.ws && pane.ws.readyState === 1) pane.ws.send(JSON.stringify({ t: 'in', d })); });
  // per-pane zoom: Ctrl +/- / Ctrl+0 (reset) — intercepted so it doesn't reach the shell or zoom the page
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomPane(pane, +1); return false; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomPane(pane, -1); return false; }
      if (e.key === '0') { e.preventDefault(); setZoom(pane, DEFAULT_FONT); return false; }
    }
    return true;
  });
  host.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); zoomPane(pane, e.deltaY < 0 ? +1 : -1); }, { passive: false });
  wrap.addEventListener('mousedown', () => setFocused(id));
  hide.addEventListener('click', (e) => { e.stopPropagation(); removePane(id); });
  close.addEventListener('click', (e) => { e.stopPropagation(); killSession(id, nm.textContent); });
  connectPane(pane);
  return pane;
}
function currentFont(pane) { return zoomStore[pane.id] || DEFAULT_FONT; }
function setZoom(pane, size) {
  size = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(size)));
  zoomStore[pane.id] = size; saveZoom();
  try { if (pane.term.options) pane.term.options.fontSize = size; else pane.term.setOption('fontSize', size); } catch (_) {}
  fitPane(pane);
  setStatus(`zoom: ${size}px`);
}
function zoomPane(pane, delta) { setZoom(pane, currentFont(pane) + delta); }
// Auto-reconnect a pane whose socket dropped (e.g. the server restarted) until
// its same-id session is back. Guarded so an intentional close never retries.
function scheduleReconnect(pane) {
  if (pane.closing || !panes.includes(pane)) return;
  const delay = pane.backoff || 1000;
  pane.backoff = Math.min(delay * 2, 10000);
  clearTimeout(pane.retry);
  pane.retry = setTimeout(() => { if (!pane.closing && panes.includes(pane)) connectPane(pane); }, delay);
}
function connectPane(pane) {
  const url = `${wsBase()}/attach?id=${encodeURIComponent(pane.id)}&token=${encodeURIComponent(cfg.token)}`;
  const sock = new WebSocket(url); pane.ws = sock;
  sock.onopen = () => { pane.backoff = 1000; fitPane(pane); updateConnDot(); };
  sock.onclose = () => { updateConnDot(); scheduleReconnect(pane); };
  sock.onerror = () => updateConnDot();
  sock.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'hello') { pane.meta = m.session; pane.nm.textContent = m.session.name; pane.ic.textContent = m.session.icon || ''; updateHeader(); }
    else if (m.t === 'out') pane.term.write(m.d);
    else if (m.t === 'exit') pane.term.write(`\r\n\x1b[90m[process exited: ${m.code}]\x1b[0m\r\n`);
    else if (m.t === 'killed') pane.term.write(`\r\n\x1b[90m[terminal killed]\x1b[0m\r\n`);
  };
}
function destroyPane(pane) {
  pane.closing = true;                       // stop the reconnect loop for an intentional close
  try { clearTimeout(pane.retry); } catch (_) {}
  try { pane.ws && pane.ws.close(); } catch (_) {}
  try { pane.term.dispose(); } catch (_) {}
  try { pane.el.remove(); } catch (_) {}
  panes = panes.filter((p) => p !== pane);
}
function fitPane(pane) {
  requestAnimationFrame(() => {
    try { pane.fit.fit(); } catch (_) {}
    if (pane.ws && pane.ws.readyState === 1) pane.ws.send(JSON.stringify({ t: 'resize', c: pane.term.cols, r: pane.term.rows }));
    try { pane.term.refresh(0, pane.term.rows - 1); } catch (_) {}
  });
}
function refitAll() { for (const p of panes) fitPane(p); }

function setFocused(id) {
  focusedId = id;
  for (const p of panes) p.el.classList.toggle('focused', p.id === id);
  const p = panes.find((x) => x.id === id); if (p) p.term.focus();
  updateConnDot(); updateHeader();
}
function updateConnDot() {
  const f = panes.find((p) => p.id === focusedId) || panes[0];
  setConnected(!!(f && f.ws && f.ws.readyState === 1));
}
function updateHeader() {
  if ($('title').querySelector('.name-edit')) return;   // mid inline rename — leave it be
  const n = panes.length;
  const f = panes.find((p) => p.id === focusedId) || panes[0];
  $('sicon').textContent = f && f.meta ? (f.meta.icon || '') : '';
  const nm = f && f.meta ? f.meta.name : (n ? '…' : 'Power Shell(ed)');
  $('title').textContent = n > 1 ? `${nm} · ${n} panes` : nm;
}

// Layouts per pane count. 1 = full · 2 = cols/rows · 3 = cols/rows/master-left/
// master-top · 4-6 = forced grid. The toolbar button cycles the options.
const LAYOUTS = {
  1: ['single'],
  2: ['cols', 'rows'],
  3: ['cols', 'rows', 'left', 'top'],
  4: ['grid2'],
  5: ['grid3'],
  6: ['grid3'],
};
const LAYOUT_ICON = { single: '▭', cols: '⬌', rows: '⬍', left: '◧', top: '⬓', grid2: '▦', grid3: '▦' };
const LAYOUT_NAME = {
  single: 'full', cols: 'side by side', rows: 'top / bottom',
  left: 'left master + stacked right', top: 'top master + split bottom', grid2: 'grid', grid3: 'grid',
};
function layoutsFor(n) { return LAYOUTS[Math.min(Math.max(n, 1), 6)] || ['single']; }
function currentLayout() {
  const opts = layoutsFor(panes.length);
  const k = tabOrient();
  return opts.includes(k) ? k : opts[0];
}

// A layout spec: grid of ncol×nrow real tracks, where cells place panes and
// gutters mark draggable boundaries. from/to are real cross-track indices (1-based).
function layoutSpec(key, n) {
  const cols = (m) => ({ ncol: m, nrow: 1,
    cells: Array.from({ length: m }, (_, i) => ({ c: i + 1, r: 1 })),
    gutters: Array.from({ length: m - 1 }, (_, i) => ({ axis: 'x', at: i + 1, from: 1, to: 1 })) });
  const rows = (m) => ({ ncol: 1, nrow: m,
    cells: Array.from({ length: m }, (_, i) => ({ c: 1, r: i + 1 })),
    gutters: Array.from({ length: m - 1 }, (_, i) => ({ axis: 'y', at: i + 1, from: 1, to: 1 })) });
  switch (key) {
    case 'single': return { ncol: 1, nrow: 1, cells: [{ c: 1, r: 1 }], gutters: [] };
    case 'cols': return cols(n);
    case 'rows': return rows(n);
    case 'left': return { ncol: 2, nrow: 2,
      cells: [{ c: 1, r: 1, rs: 2 }, { c: 2, r: 1 }, { c: 2, r: 2 }],
      gutters: [{ axis: 'x', at: 1, from: 1, to: 2 }, { axis: 'y', at: 1, from: 2, to: 2 }] };
    case 'top': return { ncol: 2, nrow: 2,
      cells: [{ c: 1, r: 1, cs: 2 }, { c: 1, r: 2 }, { c: 2, r: 2 }],
      gutters: [{ axis: 'y', at: 1, from: 1, to: 2 }, { axis: 'x', at: 1, from: 2, to: 2 }] };
    case 'grid2': return { ncol: 2, nrow: 2,
      cells: [{ c: 1, r: 1 }, { c: 2, r: 1 }, { c: 1, r: 2 }, { c: 2, r: 2 }],
      gutters: [{ axis: 'x', at: 1, from: 1, to: 2 }, { axis: 'y', at: 1, from: 1, to: 2 }] };
    case 'grid3': return { ncol: 3, nrow: 2,
      cells: Array.from({ length: n }, (_, i) => ({ c: (i % 3) + 1, r: Math.floor(i / 3) + 1 })),
      gutters: [{ axis: 'x', at: 1, from: 1, to: 2 }, { axis: 'x', at: 2, from: 1, to: 2 }, { axis: 'y', at: 1, from: 1, to: 3 }] };
  }
  return { ncol: 1, nrow: 1, cells: [{ c: 1, r: 1 }], gutters: [] };
}

const GUT = 6; // px gutter track width
function trackList(fr) { return fr.map((f, i) => (i ? GUT + 'px ' : '') + f + 'fr').join(' '); }
// per-tab, per-(layout+count) fr sizes; defaults to equal tracks
function sizeState(key, spec) {
  const rec = tabRec();
  const def = { cols: Array(spec.ncol).fill(1), rows: Array(spec.nrow).fill(1) };
  if (!rec) return def;
  rec.sizes = rec.sizes || {};
  const sk = key + ':' + panes.length;
  let s = rec.sizes[sk];
  if (!s || s.cols.length !== spec.ncol || s.rows.length !== spec.nrow) { s = def; rec.sizes[sk] = s; }
  return s;
}

function layoutPanes() {
  const el = $('panes');
  const key = currentLayout();
  const spec = layoutSpec(key, panes.length);
  const sizes = sizeState(key, spec);
  el.classList.toggle('solo', panes.length <= 1);
  el.style.gridTemplateColumns = trackList(sizes.cols);
  el.style.gridTemplateRows = trackList(sizes.rows);
  el.querySelectorAll('.pane-gutter').forEach((g) => g.remove());
  panes.forEach((p, idx) => {
    const cell = spec.cells[idx] || { c: 1, r: 1 };
    p.el.style.gridColumn = `${2 * cell.c - 1} / span ${2 * (cell.cs || 1) - 1}`;
    p.el.style.gridRow = `${2 * cell.r - 1} / span ${2 * (cell.rs || 1) - 1}`;
  });
  for (const g of spec.gutters) addGutter(el, g, sizes);
  const opts = layoutsFor(panes.length);
  const btn = $('orientBtn');
  btn.classList.toggle('hidden', opts.length <= 1);
  btn.textContent = LAYOUT_ICON[key] || '▦';
  btn.title = 'Layout: ' + (LAYOUT_NAME[key] || key) + ' — click to change';
}

// ---- draggable gutters --------------------------------------------------
function addGutter(el, g, sizes) {
  const d = document.createElement('div');
  d.className = 'pane-gutter ' + g.axis;
  if (g.axis === 'x') { d.style.gridColumn = String(2 * g.at); d.style.gridRow = `${2 * g.from - 1} / ${2 * g.to}`; }
  else { d.style.gridRow = String(2 * g.at); d.style.gridColumn = `${2 * g.from - 1} / ${2 * g.to}`; }
  d.addEventListener('pointerdown', (e) => startDrag(e, g, sizes, d));
  el.appendChild(d);
}
let drag = null, dragRaf = 0;
function startDrag(e, g, sizes, dEl) {
  e.preventDefault();
  const rect = $('panes').getBoundingClientRect();
  const arr = g.axis === 'x' ? sizes.cols : sizes.rows;
  drag = {
    axis: g.axis, sizes, dEl, i: g.at, arr,
    containerPx: g.axis === 'x' ? rect.width : rect.height,
    startPos: g.axis === 'x' ? e.clientX : e.clientY,
    a0: arr[g.at - 1], b0: arr[g.at],
  };
  dEl.classList.add('dragging');
  dEl.setPointerCapture && dEl.setPointerCapture(e.pointerId);
  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', endDrag, { once: true });
}
function onDrag(e) {
  if (!drag) return;
  const pos = drag.axis === 'x' ? e.clientX : e.clientY;
  const totalFr = drag.arr.reduce((s, v) => s + v, 0);
  const realPx = drag.containerPx - (drag.arr.length - 1) * GUT - 6; // minus gutters + padding
  const pxPerFr = realPx / totalFr || 1;
  const min = 0.15;
  let df = (pos - drag.startPos) / pxPerFr;
  df = Math.max(-(drag.a0 - min), Math.min(drag.b0 - min, df));
  drag.arr[drag.i - 1] = drag.a0 + df;
  drag.arr[drag.i] = drag.b0 - df;
  const el = $('panes');
  if (drag.axis === 'x') el.style.gridTemplateColumns = trackList(drag.sizes.cols);
  else el.style.gridTemplateRows = trackList(drag.sizes.rows);
  if (!dragRaf) dragRaf = requestAnimationFrame(() => { dragRaf = 0; refitAll(); });
}
function endDrag() {
  if (!drag) return;
  drag.dEl.classList.remove('dragging');
  window.removeEventListener('pointermove', onDrag);
  drag = null;
  savePanes();   // sizes live in paneStore[tab].sizes → persisted
  refitAll();
}
function cycleLayout() {
  const opts = layoutsFor(panes.length);
  if (opts.length <= 1) return;
  const i = Math.max(0, opts.indexOf(currentLayout()));
  setOrient(opts[(i + 1) % opts.length]);
}

// ---- view: reconcile live panes with the current tab's stored ids -------
async function applyView() {
  const ids = tabIds();
  if (!ids.length) { showEmpty(); return; }
  $('empty').classList.add('hidden');
  for (const p of panes.slice()) if (!ids.includes(p.id)) destroyPane(p);
  for (const id of ids) if (!panes.find((p) => p.id === id)) makePane(id);
  panes.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  for (const id of ids) { const p = panes.find((x) => x.id === id); if (p) $('panes').appendChild(p.el); }
  if (!focusedId || !ids.includes(focusedId)) focusedId = ids[0];
  layoutPanes();
  refitAll();
  updateHeader(); updateConnDot();
  renderList(lastList);
  syncTabTitles();
}
function showEmpty(msg) {
  for (const p of panes.slice()) destroyPane(p);
  panes = []; focusedId = null;
  $('empty').classList.remove('hidden');
  $('empty-msg').textContent = msg || 'No terminal attached to this tab.';
  $('sicon').textContent = ''; $('title').textContent = 'Power Shell(ed)';
  $('orientBtn').classList.add('hidden');
  setConnected(false);
  renderList(lastList);
}

// ---- pane operations ----------------------------------------------------
function addPane(id) {
  const ids = tabIds().slice();
  if (ids.includes(id)) { setFocused(id); return; }
  if (ids.length >= MAX_PANES) { setStatus(`max ${MAX_PANES} panes`); return; }
  ids.push(id);
  focusedId = id;
  setTabRec(ids);
  applyView();
}
function removePane(id) {
  setTabRec(tabIds().filter((x) => x !== id));
  applyView();
}
function setOrient(o) {
  const r = tabRec(); if (!r) return;
  setTabRec(r.ids, o);
  layoutPanes(); refitAll();
}

// Repair a stale render when the side panel becomes visible / focused again.
function repair() { if (panes.length) refitAll(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) repair(); });
window.addEventListener('focus', repair);
window.addEventListener('resize', refitAll);

// User picks a session (menu click / create) → add it as a pane.
function selectSession(id) { addPane(id); }

// ---- session list -------------------------------------------------------
async function refreshList() {
  let list;
  try { list = await api('/sessions'); }
  catch (e) { renderList([]); updateConnDot(); setStatus('server offline — check ⚙ settings & that the server is running'); return; }
  updateConnDot();
  // prune dead session ids out of every tab's panes
  let changed = false;
  for (const [tid, rec] of Object.entries(paneStore)) {
    const before = rec.ids.length;
    rec.ids = rec.ids.filter((sid) => list.some((s) => s.id === sid));
    if (rec.ids.length !== before) changed = true;
    if (!rec.ids.length) delete paneStore[tid];
  }
  if (changed) { savePanes(); applyView(); }
  // drop zoom entries for sessions that no longer exist
  const alive = new Set(list.map((s) => s.id));
  let zChanged = false;
  for (const sid of Object.keys(zoomStore)) if (!alive.has(sid)) { delete zoomStore[sid]; zChanged = true; }
  if (zChanged) saveZoom();
  lastList = list;
  renderList(list);
  syncTabTitles();   // names/icons may have changed → refresh the tab-group pills
}
function renderList(list) {
  // Don't wipe an in-progress inline rename (the 3s poll would otherwise clobber it).
  if (document.querySelector('#sessList .name-edit, #emptyList .name-edit')) return;
  const boundIds = new Set(Object.values(paneStore).flatMap((r) => r.ids || []));
  const openIds = new Set(tabIds());
  const hasSessions = list.length > 0;
  $('sessEmpty').classList.toggle('hidden', hasSessions);
  $('emptyListEmpty').classList.toggle('hidden', hasSessions);
  // Same list is shown in the drawer (☰) and directly in the empty state.
  for (const ul of [$('sessList'), $('emptyList')]) {
    ul.innerHTML = '';
    for (const s of list) ul.appendChild(buildSessItem(s, boundIds, openIds));
  }
}
// Render a name so a trailing "-<number>" slug suffix (e.g. chrome-terminal-916)
// is NEVER truncated: the head ellipsizes ("chrom…") while the suffix ("-916")
// stays pinned. Falls back to a plain ellipsizing head when there's no suffix.
function setNameParts(el, name) {
  el.textContent = '';
  const m = /^(.*\S)(-\d+)$/.exec(name);
  const head = document.createElement('span'); head.className = 's-name-head';
  head.textContent = m ? m[1] : name;
  el.appendChild(head);
  if (m) { const suf = document.createElement('span'); suf.className = 's-name-suf'; suf.textContent = m[2]; el.appendChild(suf); }
}
function buildSessItem(s, boundIds, openIds) {
  const here = openIds.has(s.id);
  const li = document.createElement('li');
  li.className = (here ? 'active ' : '') + (s.exited ? 'dead' : '');
  // 📌 only when docked in ANOTHER tab — for this tab the green highlight already says so.
  const pinTag = (boundIds.has(s.id) && !here) ? '<span class="s-meta" title="open in another tab">📌</span>' : '';
  li.innerHTML = `
    <span class="s-dot ${s.exited ? 'dead' : ''}"></span>
    <span class="s-ic"></span>
    <span class="s-name"></span>
    ${pinTag}
    <span class="s-meta">${s.shellId}${s.clients ? ' · ' + s.clients + '👁' : ''}</span>
    <button class="s-kill" title="Kill">✕</button>`;
  const icEl = li.querySelector('.s-ic');
  icEl.textContent = s.icon || '';
  icEl.title = 'Change icon';
  icEl.addEventListener('click', (e) => {
    e.stopPropagation();
    openEmojiPop(icEl, (emoji) => changeSessionIcon(s, emoji || '🖥️'));
  });
  const nameEl = li.querySelector('.s-name');
  setNameParts(nameEl, s.name);
  nameEl.title = 'Double-click to rename';
  nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(nameEl, s, refreshList); });
  li.title = here ? 'Click to remove from this tab' : 'Click to add as a pane in this tab';
  li.addEventListener('click', (e) => {
    if (e.target.classList.contains('s-kill') || e.target.classList.contains('s-ic')) return;
    if (e.target.tagName === 'INPUT') return;   // don't toggle while renaming inline
    if (here) removePane(s.id); else addPane(s.id);  // toggle in/out of the grid
  });
  li.querySelector('.s-kill').addEventListener('click', (e) => {
    e.stopPropagation();
    killSession(s.id, s.name);
  });
  return li;
}
// Change the emoji of a running session (rename endpoint), then reflect it in the
// live pane header, the top bar and the tab-group pill.
async function changeSessionIcon(s, icon) {
  try { await api(`/sessions/${s.id}/rename`, { method: 'POST', body: JSON.stringify({ icon }) }); }
  catch (e) { setStatus('icon change failed: ' + e.message); return; }
  const p = panes.find((x) => x.id === s.id);
  if (p) { if (p.meta) p.meta.icon = icon; p.ic.textContent = icon; updateHeader(); }
  refreshList();   // re-renders lists with the new icon + re-syncs the tab-group titles
}
// Change the display name of a running session (same rename endpoint), then
// reflect it in the live pane header, the top bar and the tab-group pill.
async function changeSessionName(s, name) {
  try { await api(`/sessions/${s.id}/rename`, { method: 'POST', body: JSON.stringify({ name }) }); }
  catch (e) { setStatus('rename failed: ' + e.message); refreshList(); updateHeader(); return; }
  const p = panes.find((x) => x.id === s.id);
  if (p) { if (p.meta) p.meta.name = name; p.nm.textContent = name; updateHeader(); }
  refreshList();   // re-renders lists with the new name + re-syncs the tab-group titles
}
// Swap element `el` into an inline text input to rename session `s`.
// Enter or blur commits, Escape cancels; `onDone` redraws el's host on cancel.
function startRename(el, s, onDone) {
  if (el.querySelector('input')) return;   // already editing this element
  const input = document.createElement('input');
  input.className = 'name-edit';
  input.value = s.name;
  el.textContent = '';
  el.appendChild(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const val = input.value.trim();
    input.remove();              // drop the editor first so the redraw guards let it through
    if (save && val && val !== s.name) changeSessionName(s, val);
    else if (onDone) onDone();   // revert to plain text
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();   // keep terminal / global keys from stealing input
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}
// The session backing the top-bar header = the focused pane's (or first pane's).
function focusedSession() {
  const f = panes.find((p) => p.id === focusedId) || panes[0];
  return f && f.meta ? f.meta : null;
}

// ---- tab-group title (name + emoji in the "PS" pill) --------------------
// The tab strip pill shows the tab's session(s): 1 → "🖥️ full-name",
// same-named panes collapse to "🖥️ xN full-name" (suffix dropped), and mixed
// names shorten to "i1i2 rmtn+dnt-b" (3+ → "i1i2i3 Re+DB+VD"), still collapsing
// dupes as "…xN". sidepanel composes the string (it has names+icons via lastList)
// and stores it in ct_tabtitle; background.js applies it as the group title.
// Names drop a trailing numeric segment first.
function nameWords(name) {
  return String(name || '').split('-').map((s) => s.trim()).filter((s) => s && !/^\d+$/.test(s));
}
// Full name without the trailing -xxx suffix: 'chrome-terminal-481' → 'chrome-terminal'.
function baseName(name) {
  const w = nameWords(name);
  return w.length ? w.join('-') : String(name || '').trim();
}
function noVowels(s) { return s.replace(/[aeiou]/gi, ''); }
// medium abbrev (~5 chars): first word devowelled (3 if more words, else 5) + initial of each rest
function abbrMed(name) {
  const w = nameWords(name);
  if (!w.length) return String(name || '').slice(0, 5).toLowerCase();
  if (w.length === 1) return (noVowels(w[0]) || w[0]).slice(0, 5).toLowerCase();
  const head = (noVowels(w[0]) || w[0]).slice(0, 3).toLowerCase();
  return [head, ...w.slice(1).map((s) => s[0].toLowerCase())].join('-');
}
// short abbrev (2 chars): initials of first two words uppercased, or first two letters titlecased
function abbrShort(name) {
  const w = nameWords(name);
  if (!w.length) { const s = String(name || '?'); return (s[0] || '?').toUpperCase() + (s[1] || '').toLowerCase(); }
  if (w.length === 1) return w[0].charAt(0).toUpperCase() + (w[0].charAt(1) || '').toLowerCase();
  return (w[0][0] + w[1][0]).toUpperCase();
}
function tabTitleFor(ids) {
  const meta = ids.map((id) => lastList.find((s) => s.id === id)).filter(Boolean);
  if (!meta.length) return null;
  if (meta.length === 1) return `${meta[0].icon || ''} ${meta[0].name}`.trim();
  // Collapse same-named sessions (ignoring the -xxx suffix) into "name xN".
  const groups = [];
  for (const m of meta) {
    const b = baseName(m.name);
    const g = groups.find((x) => x.base === b);
    if (g) g.count++; else groups.push({ base: b, count: 1, icon: m.icon || '' });
  }
  // All the same name → count before the full base name, e.g. "🖥️ x2 chrome-terminal".
  if (groups.length === 1) {
    const g = groups[0];
    return `${g.icon} ${g.count > 1 ? 'x' + g.count + ' ' : ''}${g.base}`.trim();
  }
  // Mixed names → compact abbreviations, still collapsing duplicates (e.g. "rmtnx2+dnt").
  const icons = groups.map((g) => g.icon).join('');
  const abbr = groups.map((g) => {
    const a = groups.length === 2 ? abbrMed(g.base) : abbrShort(g.base);
    return g.count > 1 ? `${a}x${g.count}` : a;
  });
  return `${icons} ${abbr.join('+')}`;
}
let tabTitleCache = '';
function syncTabTitles() {
  const titles = {};
  for (const [t, rec] of Object.entries(paneStore)) {
    if (!rec || !rec.ids || !rec.ids.length) continue;
    const title = tabTitleFor(rec.ids);
    if (title) titles[t] = title;
  }
  const j = JSON.stringify(titles);
  if (j === tabTitleCache) return;
  tabTitleCache = j;
  chrome.storage.local.set({ ct_tabtitle: titles });
}

async function loadShells() {
  const sel = $('f-shell');
  try {
    const shells = await api('/shells');
    sel.innerHTML = shells.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  } catch (_) { sel.innerHTML = '<option value="powershell">Windows PowerShell</option>'; }
}

// ---- folder picker (New terminal) ---------------------------------------
let pickCwd = null;      // selected working dir (abs) or null → server uses home
let pickCrumbs = [];     // [{name, path}] from workspace root down to current
let cmdAuto = true;      // keep auto-filling Run-on-start until the user edits it
let nameAuto = true;     // keep auto-filling the Name field with the RC name
let contFlag = false;    // append --continue to the generated claude command
let pickName = '';       // '<slug>-<rand>' — stable per selection, not regenerated on toggle
let lastNamedPath = null;
let favPick = false;     // a favorite is the current selection → keep the subfolder browser hidden
let workspaces = [];     // [{name, path}] user-configured roots (persisted as ct_workspaces)
let favorites = [];      // [{path, crumbs:[{name,path}]}] saved folders (persisted as ct_favorites)
let wsSel = '';          // selected workspace: '' = none (home dir), or a workspace index

function saveWorkspaces() { chrome.storage.local.set({ ct_workspaces: workspaces }); }

// ---- favorites (saved folders in the New-terminal form) -----------------
function saveFavorites() { chrome.storage.local.set({ ct_favorites: favorites }); }
function favNorm(p) { return (p || '').replace(/[\\/]+$/, '').toLowerCase(); }
function favIndex(path) { const k = favNorm(path); return favorites.findIndex((f) => favNorm(f.path) === k); }
// Restore workspace + drill-down for a saved favorite so its folder is the cwd,
// no manual navigation needed. Handles nested paths (e.g. VICLIX › dashboard).
function applyFav(fav) {
  pickCrumbs = fav.crumbs.map((c) => ({ name: c.name, path: c.path }));
  // Reflect the root in the workspace chips when it matches a configured one.
  const root = pickCrumbs[0] ? favNorm(pickCrumbs[0].path) : '';
  const wi = workspaces.findIndex((w) => favNorm(w.path) === root);
  wsSel = wi >= 0 ? String(wi) : ''; renderWsChips();
  // A favorite is a direct pick — don't open the subfolder browser (that's only
  // for navigating a workspace); just set the cwd + auto Name/Run-on-start.
  favPick = true;
  updateCwd();
  // Restore the icon saved with this favorite so it doesn't have to be set again.
  $('f-icon').value = fav.icon || '';
}
// Favorites strip at the top of the terminals drawer (☰). Clicking one opens the
// New-terminal (＋) panel with that folder preloaded — exactly as if the favorite
// had been clicked inside ＋ — so the last details can still be tweaked before Create.
function renderDrawerFavs() {
  const ul = $('d-fav-list'); if (!ul) return;
  ul.innerHTML = '';
  $('d-fav-empty').classList.toggle('hidden', favorites.length > 0);
  favorites.forEach((fav) => {
    const tip = fav.crumbs[fav.crumbs.length - 1];
    const li = document.createElement('li');
    li.innerHTML = `<span class="d-ic"></span><span class="fav-name"></span>`;
    li.querySelector('.d-ic').textContent = fav.icon || '⭐';
    li.querySelector('.fav-name').textContent = tip ? tip.name : fav.path;
    li.title = fav.path + ' — open in ＋ with this folder preloaded';
    li.addEventListener('click', () => openNewFormWithFav(fav));
    ul.appendChild(li);
  });
}
function renderFavList() {
  const ul = $('f-fav-list'); if (!ul) return;
  ul.innerHTML = '';
  $('f-fav-empty').classList.toggle('hidden', favorites.length > 0);
  favorites.forEach((fav, i) => {
    const tip = fav.crumbs[fav.crumbs.length - 1];
    const trail = fav.crumbs.map((c) => c.name).join(' › ');
    const li = document.createElement('li');
    if (favPick && favNorm(fav.path) === favNorm(pickCwd)) li.className = 'active';
    li.innerHTML = `<span class="d-ic"></span><span class="fav-name"></span><span class="fav-trail"></span>` +
      `<button class="fav-ic-btn" title="Set the icon for this favorite">🎨</button>` +
      `<button class="s-kill" title="Remove favorite">✕</button>`;
    li.querySelector('.d-ic').textContent = fav.icon || '⭐';
    li.querySelector('.fav-name').textContent = tip ? tip.name : fav.path;
    li.querySelector('.fav-trail').textContent = trail;
    li.title = fav.path;
    li.addEventListener('click', (e) => { if (e.target.closest('button')) return; applyFav(fav); });
    li.querySelector('.fav-ic-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openEmojiPop(e.currentTarget, (emoji) => {
        if (emoji) fav.icon = emoji; else delete fav.icon;
        saveFavorites(); renderFavList();
        // if this favorite is the current pick, reflect its icon in the form field
        if (favPick && favNorm(fav.path) === favNorm(pickCwd)) $('f-icon').value = fav.icon || '';
      });
    });
    li.querySelector('.s-kill').addEventListener('click', async (e) => {
      e.stopPropagation();
      const label = tip ? tip.name : fav.path;
      const safe = label.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const ok = await confirmDialog({ message: `Remove <b>${safe}</b> from favorites?` });
      if (!ok) return;
      const j = favIndex(fav.path);              // re-find: index may have shifted
      if (j >= 0) favorites.splice(j, 1);
      saveFavorites(); renderFavList(); updateFavStar();
    });
    ul.appendChild(li);
  });
}
function toggleFav() {
  if (!pickCwd) return;
  const i = favIndex(pickCwd);
  if (i >= 0) favorites.splice(i, 1);
  else favorites.push({ path: pickCwd, crumbs: pickCrumbs.map((c) => ({ name: c.name, path: c.path })) });
  saveFavorites(); renderFavList(); updateFavStar();
}
// Favorite a subfolder straight from the dir list, without descending into it.
function toggleFavDir(d) {
  const i = favIndex(d.path);
  if (i >= 0) favorites.splice(i, 1);
  else favorites.push({
    path: d.path,
    crumbs: [...pickCrumbs.map((c) => ({ name: c.name, path: c.path })), { name: d.name, path: d.path }],
  });
  saveFavorites(); renderFavList(); updateFavStar(); loadDirs();
}
function updateFavStar() {
  const star = $('f-fav-star'); if (!star) return;
  const on = !!pickCwd && favIndex(pickCwd) >= 0;
  star.textContent = on ? '★' : '☆';
  star.classList.toggle('on', on);
  star.title = on ? 'Remove this folder from favorites' : 'Save this folder as a favorite';
}
// The workspace picker in the New-terminal form: horizontal chips (from user config).
function renderWsChips() {
  const box = $('f-ws-chips'); if (!box) return;
  box.innerHTML = '';
  const mk = (val, label, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ws-chip' + (String(wsSel) === String(val) ? ' active' : '');
    b.textContent = label; if (title) b.title = title;
    b.addEventListener('click', () => selectWorkspace(val));
    box.appendChild(b);
  };
  mk('', '⌂ home', 'No workspace — start in the home dir');
  workspaces.forEach((w, i) => mk(String(i), w.name, w.path));
}
// Pick a workspace chip: '' = home (reset), or an index → navigate that root.
async function selectWorkspace(val) {
  wsSel = val;
  renderWsChips();
  if (val === '') { resetPicker(); return; }
  const w = workspaces[Number(val)];
  if (!w) { wsSel = ''; renderWsChips(); resetPicker(); return; }
  pickCrumbs = [{ name: w.name, path: w.path }]; favPick = false;
  await refreshBrowser();
}
// Workspace manager (in ⚙ settings): add/remove your own roots.
function renderWsEditor() {
  const ul = $('wsList'); ul.innerHTML = '';
  $('wsEmpty').classList.toggle('hidden', workspaces.length > 0);
  workspaces.forEach((w, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="s-name"></span><span class="s-meta ws-path"></span><button class="s-kill" title="Remove">✕</button>`;
    li.querySelector('.s-name').textContent = w.name;
    li.querySelector('.ws-path').textContent = w.path;
    li.querySelector('.ws-path').title = w.path;
    li.querySelector('.s-kill').addEventListener('click', () => {
      workspaces.splice(i, 1); saveWorkspaces(); renderWsEditor();
    });
    ul.appendChild(li);
  });
}

// RC name for a folder: '<slug>-<rand>' so remote-control names don't collide.
function makeName(dir) {
  const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'session';
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'session';
  return `${slug}-${Math.floor(Math.random() * 900) + 100}`;
}
// The "claude" launch command: opus model + Remote Control named '<slug>-<rand>'
// (pickName) so the session shows up in the phone's RC list. The server still
// appends --session-id after this for deterministic resume; on restart resumeCmd
// strips the session flags but KEEPS --remote-control <name>, so the same RC name
// survives the resume.
function buildCmd() {
  if (!pickCwd) return '';
  return `claude --model claude-opus-4-8 --remote-control ${pickName}${contFlag ? ' --continue' : ''}`;
}

function updateCwd() {
  pickCwd = pickCrumbs.length ? pickCrumbs[pickCrumbs.length - 1].path : null;
  const browsingWs = !!pickCwd && !favPick;   // a workspace root is picked & being navigated
  $('f-browser').classList.toggle('hidden', !browsingWs);
  $('f-favs').classList.toggle('hidden', browsingWs);   // favorites only when not browsing a workspace
  $('f-cwd-label').textContent = pickCwd || '(home)';
  // Regenerate the RC name only when the selected path actually changes (so the
  // --continue toggle keeps the same random suffix).
  if (pickCwd && pickCwd !== lastNamedPath) { pickName = makeName(pickCwd); lastNamedPath = pickCwd; }
  if (!pickCwd) { pickName = ''; lastNamedPath = null; }
  if (cmdAuto) $('f-cmd').value = buildCmd();
  if (nameAuto) $('f-name').value = pickName;   // Name mirrors the RC name (e.g. mdgraphs-481)
  updateFavStar(); renderFavList();             // keep star + active favorite highlight in sync
}
function renderCrumbs() {
  const c = $('f-crumbs'); c.innerHTML = '';
  pickCrumbs.forEach((cr, i) => {
    if (i) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›'; c.appendChild(s); }
    const b = document.createElement('button'); b.textContent = cr.name; b.title = cr.path;
    b.addEventListener('click', () => jumpCrumb(i));
    c.appendChild(b);
  });
}
async function loadDirs() {
  const ul = $('f-dirs'); ul.innerHTML = '';
  const empty = $('f-dirs-empty'); empty.classList.add('hidden');
  const root = pickCrumbs[0] ? pickCrumbs[0].path : pickCwd;
  let data;
  try { data = await api('/dirs?path=' + encodeURIComponent(pickCwd) + '&root=' + encodeURIComponent(root)); }
  catch (e) {
    const m = String(e.message || '');
    empty.textContent = m.startsWith('404')
      ? 'Server is out of date — restart it (start-server.ps1).'
      : 'Cannot read this folder' + (m ? ' — ' + m : '') + '.';
    empty.classList.remove('hidden'); return;
  }
  if (!data.dirs.length) { empty.textContent = 'No subfolders here.'; empty.classList.remove('hidden'); return; }
  for (const d of data.dirs) {
    const li = document.createElement('li');
    const on = favIndex(d.path) >= 0;
    li.innerHTML = `<span class="d-ic">📁</span><span class="d-name"></span>` +
      `<button class="fav-star${on ? ' on' : ''}" title="Favorite this folder">${on ? '★' : '☆'}</button>` +
      `<span class="d-into">›</span>`;
    li.querySelector('.d-name').textContent = d.name;
    li.querySelector('.fav-star').addEventListener('click', (e) => { e.stopPropagation(); toggleFavDir(d); });
    li.addEventListener('click', () => descend(d));
    ul.appendChild(li);
  }
}
async function refreshBrowser() { renderCrumbs(); updateCwd(); await loadDirs(); }
async function descend(d) { pickCrumbs.push({ name: d.name, path: d.path }); await refreshBrowser(); }
async function jumpCrumb(i) { pickCrumbs = pickCrumbs.slice(0, i + 1); await refreshBrowser(); }
function resetPicker() {
  pickCrumbs = []; favPick = false;
  $('f-crumbs').innerHTML = ''; $('f-dirs').innerHTML = '';
  $('f-dirs-empty').classList.add('hidden');
  updateCwd();
}
$('f-fav-star').addEventListener('click', toggleFav);
$('f-cmd').addEventListener('input', () => { cmdAuto = false; });
$('f-name').addEventListener('input', () => { nameAuto = false; });
$('f-cont').addEventListener('change', () => {
  contFlag = $('f-cont').checked;
  if (cmdAuto) $('f-cmd').value = buildCmd();
});

// ---- emoji picker (icon field) ------------------------------------------
const EMOJIS = ['🖥️','💻','⌨️','🐚','⚡','🔧','🛠️','🚀','🔥','🐍','📦','🗄️','🧠','🤖','⚙️','📁',
  '🌐','🔌','🧪','🐳','🦊','🐙','✨','💾','🧩','🎯','🏗️','📡','🔬','💡','🎨','🕹️','🧰','📊','🔒','🌩️',
  '🪄','🧵','📝','🔗','🏷️','🧭','🛰️','🦾'];
let emojiHandler = null;    // (emoji) => void — where the next pick is delivered
let emojiAnchor = null;     // element the pop is floating under (kept open on its click)
function buildEmojiPop() {
  const pop = $('emojiPop');
  if (pop.childElementCount) return;
  const clear = document.createElement('button');
  clear.type = 'button'; clear.className = 'emoji emoji-clear'; clear.textContent = '∅'; clear.title = 'No icon';
  clear.addEventListener('click', () => { if (emojiHandler) emojiHandler(''); pop.classList.add('hidden'); });
  pop.appendChild(clear);
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'emoji'; b.textContent = e;
    b.addEventListener('click', () => { if (emojiHandler) emojiHandler(e); pop.classList.add('hidden'); });
    pop.appendChild(b);
  }
}
// Float the picker under `anchor`; each pick is routed to `handler`.
function openEmojiPop(anchor, handler) {
  buildEmojiPop();
  emojiHandler = handler || ((e) => { $('f-icon').value = e; });
  emojiAnchor = anchor;
  const pop = $('emojiPop');
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth || 240;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
  pop.style.left = left + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
}
$('f-icon').addEventListener('click', () => openEmojiPop($('f-icon')));
$('f-icon').addEventListener('focus', () => openEmojiPop($('f-icon')));
document.addEventListener('click', (e) => {
  const pop = $('emojiPop');
  if (pop.classList.contains('hidden')) return;
  if (e.target === emojiAnchor || pop.contains(e.target)) return;
  pop.classList.add('hidden');
});

// ---- custom confirmation dialog (native confirm() is blocked in the panel) --
let confirmResolve = null;
function confirmDialog({ title, message, icon, okText } = {}) {
  if (title != null) $('confirmTitle').textContent = title;
  $('confirmIcon').textContent = icon || '🗑️';
  $('confirmMsg').innerHTML = message || '';
  $('confirmOk').textContent = okText || 'Remove';
  $('confirmBackdrop').classList.remove('hidden');
  $('confirmOk').focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirm(result) {
  if (!confirmResolve) return;
  const r = confirmResolve; confirmResolve = null;
  $('confirmBackdrop').classList.add('hidden');
  r(result);
}
$('confirmOk').addEventListener('click', () => closeConfirm(true));
$('confirmCancel').addEventListener('click', () => closeConfirm(false));
$('confirmBackdrop').addEventListener('click', (e) => { if (e.target === $('confirmBackdrop')) closeConfirm(false); });
document.addEventListener('keydown', (e) => {
  if ($('confirmBackdrop').classList.contains('hidden')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
  else if (e.key === 'Enter') { e.preventDefault(); closeConfirm(true); }
});

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// Kill a session for good (ends its PTY/process), after a custom confirmation.
// Used by both the pane header delete button and the drawer terminal list.
async function killSession(id, name) {
  const ok = await confirmDialog({
    title: 'Delete terminal?', icon: '🗑️', okText: 'Delete',
    message: `Delete <b>${escHtml(name || 'this terminal')}</b>?<br>This ends the session and its process.`,
  });
  if (!ok) return;
  try { await api(`/sessions/${id}`, { method: 'DELETE' }); } catch (_) {}
  removePane(id);     // drop the pane if it was shown (no-op otherwise)
  refreshList();
}

// ---- panels -------------------------------------------------------------
// Each header button reflects whether ITS panel is open (stays highlighted while
// open; click again to close — see the newBtn/menuBtn/cfgBtn handlers).
const PANEL_BTN = { drawer: 'menuBtn', newForm: 'newBtn', cfgForm: 'cfgBtn' };
function syncPanelBtns() {
  for (const [panel, btn] of Object.entries(PANEL_BTN)) {
    $(btn).classList.toggle('active', !$(panel).classList.contains('hidden'));
  }
}
function hidePanels() { for (const p of ['drawer', 'newForm', 'cfgForm']) $(p).classList.add('hidden'); syncPanelBtns(); refitAll(); }
function toggle(id) {
  const el = $(id); const wasHidden = el.classList.contains('hidden');
  hidePanels(); if (wasHidden) el.classList.remove('hidden');
  syncPanelBtns(); refitAll();
}

// ---- wire up ------------------------------------------------------------
$('menuBtn').addEventListener('click', () => { toggle('drawer'); refreshList(); renderDrawerFavs(); });
$('orientBtn').addEventListener('click', cycleLayout);
// Header icon + title edit the focused session in place, mirroring the drawer.
$('sicon').addEventListener('click', () => {
  const s = focusedSession(); if (!s) return;
  openEmojiPop($('sicon'), (emoji) => changeSessionIcon(s, emoji || '🖥️'));
});
$('title').addEventListener('click', () => {
  const s = focusedSession(); if (!s) return;
  startRename($('title'), s, updateHeader);
});
$('cfgBtn').addEventListener('click', () => {
  $('c-host').value = cfg.host; $('c-port').value = cfg.port;
  $('c-token').value = cfg.token;
  renderWsEditor(); populateCustomInputs(); cfgSelectTab('tab-server');
  toggle('cfgForm');
});
// settings tabs (Server / Workspaces / Customization)
function cfgSelectTab(id) {
  for (const b of $('cfgTabs').querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === id);
  for (const p of ['tab-server', 'tab-ws', 'tab-custom']) $(p).classList.toggle('hidden', p !== id);
}
$('cfgTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab'); if (btn) cfgSelectTab(btn.dataset.tab);
});
// customization color pickers — live preview on input, persist on commit
$('cust-border').addEventListener('input', (e) => {
  theme.border = e.target.value; $('cust-border-hex').textContent = e.target.value; applyTheme();
});
$('cust-border').addEventListener('change', saveTheme);
$('cust-termbg').addEventListener('input', (e) => {
  theme.termBg = e.target.value; $('cust-termbg-hex').textContent = e.target.value; applyTheme();
});
$('cust-termbg').addEventListener('change', saveTheme);
$('cust-reset').addEventListener('click', () => {
  theme = {}; applyTheme(); saveTheme(); populateCustomInputs();
});
$('ws-add').addEventListener('click', () => {
  const name = $('ws-name').value.trim();
  const path = $('ws-path').value.trim();
  if (!name || !path) { setStatus('workspace needs a name and a path'); return; }
  workspaces.push({ name, path });
  saveWorkspaces(); renderWsEditor(); renderWsChips();
  $('ws-name').value = ''; $('ws-path').value = '';
});
function openNewForm() {
  loadShells(); renderFavList();
  wsSel = ''; renderWsChips();
  $('f-icon').value = '';
  $('f-cont').checked = false; $('emojiPop').classList.add('hidden');
  cmdAuto = true; nameAuto = true; contFlag = false;
  resetPicker();                          // clears cwd + Name + Run-on-start
  hidePanels(); $('newForm').classList.remove('hidden'); syncPanelBtns();
}
// Open ＋ and preload a favorite, same as clicking it inside the ＋ panel's fav list.
function openNewFormWithFav(fav) {
  openNewForm();     // resets the picker + populates dropdowns first
  applyFav(fav);     // then restore workspace/cwd/name/cmd/icon (updateCwd re-highlights the fav)
}
// Toggle: click ＋ to open the New-terminal panel, click it again to close it.
$('newBtn').addEventListener('click', () => {
  if ($('newForm').classList.contains('hidden')) openNewForm(); else hidePanels();
});
$('empty-new').addEventListener('click', openNewForm);
// Click anywhere outside an open dropdown panel (terminals list / settings) closes it.
// Runs on bubble, after the header buttons' own click handlers (which live in #bar).
document.addEventListener('click', (e) => {
  const openDrop = ['drawer', 'cfgForm'].find((id) => !$(id).classList.contains('hidden'));
  if (!openDrop) return;
  if ($('bar').contains(e.target)) return;             // header buttons handle their own toggle
  if ($(openDrop).contains(e.target)) return;          // clicks inside the panel stay
  if ($('confirmBackdrop').contains(e.target)) return; // don't close under a confirm dialog
  hidePanels();
});
$('tabBtn').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') }); });

$('f-cancel').addEventListener('click', hidePanels);
$('f-create').addEventListener('click', async () => {
  const body = {
    name: $('f-name').value, icon: $('f-icon').value.trim() || undefined,
    shellId: $('f-shell').value,
    cwd: pickCwd || undefined,
    initialCommand: $('f-cmd').value.trim() || undefined,
  };
  try {
    const s = await api('/sessions', { method: 'POST', body: JSON.stringify(body) });
    $('f-name').value = ''; $('f-cmd').value = ''; $('f-icon').value = '';
    wsSel = ''; renderWsChips();
    $('f-cont').checked = false;
    cmdAuto = true; nameAuto = true; contFlag = false; resetPicker();
    await refreshList();          // pull the new session into lastList so the tab-group title resolves now, not on next drawer open
    hidePanels(); selectSession(s.id);
  } catch (e) { setStatus('create failed: ' + e.message); }
});

$('c-cancel').addEventListener('click', hidePanels);
$('c-save').addEventListener('click', () => {
  cfg = {
    host: $('c-host').value.trim() || '127.0.0.1',
    port: $('c-port').value.trim() || '3777',
    token: $('c-token').value.trim(),
  };
  saveCfg(); hidePanels();
  refreshList();
});

// ---- boot ---------------------------------------------------------------
(async function boot() {
  await loadState();
  readDefaultTheme();   // snapshot :root baseline before applying any override
  applyTheme();         // paint saved border/terminal-bg overrides (if any)
  await initTab();
  await refreshList();
  applyView();
  if (!cfg.token) setStatus('no token set — open ⚙ and paste the server token');
  setInterval(() => {
    const drawerOpen = !$('drawer').classList.contains('hidden');
    const emptyShown = !$('empty').classList.contains('hidden');
    if (drawerOpen || emptyShown) refreshList();
  }, 3000);
})();
