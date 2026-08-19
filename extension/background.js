// Per-tab side panel (like the Claude extension).
//
// The panel is DISABLED globally and enabled only on the tab where the user
// opened it. That makes Chrome itself scope the panel to that tab: switching to
// another tab closes the panel, and returning to the tab reopens it. Closing the
// panel on one tab does not affect the others. Contrast with a global side panel
// (manifest default_path, openPanelOnActionClick) which shows one shared panel on
// every tab of the window — that was the old behavior.

const PANEL_PATH = 'sidepanel.html';

// Panel off by default (per-tab only), and we open it ourselves so we can scope
// it to the clicked tab instead of letting Chrome open it globally.
async function initPerTabPanel() {
  try { await chrome.sidePanel.setOptions({ enabled: false }); } catch (_) {}
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch (_) {}
}

chrome.runtime.onInstalled.addListener(initPerTabPanel);
chrome.runtime.onStartup.addListener(initPerTabPanel);
initPerTabPanel();

// Clicking the toolbar icon opens the panel for THIS tab only.
// IMPORTANT: chrome.sidePanel.open() may only be called synchronously inside the
// user gesture — do NOT `await` anything before it, or the gesture is lost and the
// call rejects silently. So we fire setOptions (unawaited) and open() in the same tick.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  chrome.sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// ---- tab group indicator (like the "Claude" pill) -----------------------
// A tab that has ≥1 terminal pane (sidepanel.js -> ct_panes[tab].ids) is put in a
// colored tab group. The group TITLE shows the tab's session(s) — name + emoji,
// composed by sidepanel.js and stored in ct_tabtitle (e.g. "🖥️ remotion-882" for
// one, "🖥️🐍 rmtn+dnt-b" for two, "🖥️🐍⚡ Re+DB+VD" for 3+). Falls back to "PS".
// Marks in the tab strip which tabs own a terminal, and PERSISTS while the side
// panel is closed. Emptying a tab's panes (kill/close all) ungroups the tab.
const GROUP_TITLE = 'PS';
const GROUP_COLOR = 'orange';
let tabTitles = {};   // { tabId: composed title } mirror of ct_tabtitle

function titleFor(tabId) { return tabTitles[tabId] || GROUP_TITLE; }

async function ensureGrouped(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const want = titleFor(tabId);
    if (tab.groupId && tab.groupId !== -1) {
      const g = await chrome.tabGroups.get(tab.groupId);
      if (g.color === GROUP_COLOR) {   // one of ours → just keep the title current
        if (g.title !== want) await chrome.tabGroups.update(tab.groupId, { title: want });
        return;
      }
    }
    const gid = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(gid, { title: want, color: GROUP_COLOR });
  } catch (_) {}
}
async function ungroup(tabId) {
  try { await chrome.tabs.ungroup(tabId); } catch (_) {}
}

// tabs of a ct_panes map that currently hold ≥1 pane
function tabsWithPanes(store) {
  const set = new Set();
  for (const [t, rec] of Object.entries(store || {})) {
    if (rec && Array.isArray(rec.ids) && rec.ids.length) set.add(Number(t));
  }
  return set;
}

// React to pane / title changes written by the side panel.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ct_tabtitle) {
    const prev = tabTitles;
    tabTitles = changes.ct_tabtitle.newValue || {};
    // re-title any grouped tab whose composed title changed
    const ids = new Set([...Object.keys(prev), ...Object.keys(tabTitles)]);
    for (const id of ids) if (prev[id] !== tabTitles[id]) ensureGrouped(Number(id));
  }
  if (changes.ct_panes) {
    const oldTabs = tabsWithPanes(changes.ct_panes.oldValue);
    const newTabs = tabsWithPanes(changes.ct_panes.newValue);
    for (const t of newTabs) if (!oldTabs.has(t)) ensureGrouped(t);
    for (const t of oldTabs) if (!newTabs.has(t)) ungroup(t);
  }
});

// On SW start, re-apply groups for tabs (with panes) that still exist.
async function reconcileGroups() {
  try {
    const { ct_panes, ct_tabtitle } = await chrome.storage.local.get(['ct_panes', 'ct_tabtitle']);
    tabTitles = ct_tabtitle || {};
    for (const id of tabsWithPanes(ct_panes)) {
      try { await chrome.tabs.get(id); } catch (_) { continue; }
      ensureGrouped(id);
    }
  } catch (_) {}
}
chrome.runtime.onStartup.addListener(reconcileGroups);
reconcileGroups();

// ==== browser control channel ============================================
// A persistent WS to the Power Shell(ed) server's /control endpoint. The server
// pushes browser commands ({t:'cmd', id, action, params, tabId}); we run them
// against the active web tab (chrome.scripting for DOM, chrome.debugger/CDP for
// trusted input + full-page capture) and reply {t:'result', id, ok, result|error}.
// This is what gives Claude Code (running in a terminal pane) eyes + hands on the
// page docked next to it.
let controlWS = null;
let controlConnecting = false;
let reconnectDelay = 1000;                       // backoff, capped at 10s
let HUD_ENABLED = true;                          // visual feedback overlay (ct_cfg.hud === false disables)

async function refreshHud() {
  try { const { ct_cfg } = await chrome.storage.local.get('ct_cfg'); HUD_ENABLED = !(ct_cfg && ct_cfg.hud === false); }
  catch (_) { /* keep previous */ }
}

async function getCfg() {
  const { ct_cfg } = await chrome.storage.local.get('ct_cfg');
  const c = ct_cfg || {};
  return { host: c.host || '127.0.0.1', port: c.port || 3777, token: c.token || '' };
}

async function connectControl() {
  if (controlConnecting) return;
  if (controlWS && (controlWS.readyState === 0 || controlWS.readyState === 1)) return;
  controlConnecting = true;
  let cfg;
  try { cfg = await getCfg(); } catch (_) { controlConnecting = false; return; }
  if (!cfg.token) { controlConnecting = false; return; }   // not configured yet; alarm retries
  let ws;
  try {
    ws = new WebSocket(`ws://${cfg.host}:${cfg.port}/control?token=${encodeURIComponent(cfg.token)}`);
  } catch (_) { controlConnecting = false; return; }
  controlWS = ws;
  ws.onopen = () => { controlConnecting = false; reconnectDelay = 1000; };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'cmd') handleCommand(m);
    else if (m.t === 'ping') { try { ws.send(JSON.stringify({ t: 'pong' })); } catch (_) {} }
  };
  const retry = () => {
    controlConnecting = false;
    if (controlWS === ws) controlWS = null;
    setTimeout(connectControl, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
  ws.onclose = retry;
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

// Reconnect triggers: SW wake (module load), startup, config change, and a 1-min
// alarm backstop. An active WS also keeps the MV3 service worker alive.
chrome.runtime.onStartup.addListener(connectControl);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ct_cfg) {
    refreshHud();
    try { if (controlWS) controlWS.close(); } catch (_) {}
    controlWS = null; reconnectDelay = 1000; connectControl();
  }
});
chrome.alarms.create('ct-control', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ct-control') connectControl(); });
refreshHud();
connectControl();

function reply(id, ok, payload) {
  if (!controlWS || controlWS.readyState !== 1) return;
  const msg = ok ? { t: 'result', id, ok: true, result: payload }
                 : { t: 'result', id, ok: false, error: String(payload && payload.message || payload) };
  try { controlWS.send(JSON.stringify(msg)); } catch (_) {}
}

async function handleCommand(cmd) {
  try {
    const result = await runAction(cmd);
    reply(cmd.id, true, result);
  } catch (e) {
    reply(cmd.id, false, e);
  }
}

// ---- tab targeting ----
// Which tabs is this terminal session docked in? (ct_panes: {tabId:{ids:[sessionId]}})
// A session can be open in several tabs — return them all.
async function linkedTabIds(sessionId) {
  if (!sessionId) return [];
  let store;
  try { ({ ct_panes: store } = await chrome.storage.local.get('ct_panes')); } catch (_) { return []; }
  const out = [];
  for (const [tid, rec] of Object.entries(store || {})) {
    if (rec && Array.isArray(rec.ids) && rec.ids.includes(sessionId)) out.push(Number(tid));
  }
  return out;
}
async function resolveTab(cmd) {
  const p = cmd.params || {};
  const sid = cmd.sessionId;
  const explicit = cmd.tabId != null ? Number(cmd.tabId) : (p.tabId != null ? Number(p.tabId) : null);

  // A linked terminal session is ISOLATED to its own docked tab(s): it can never
  // see or drive a tab it isn't docked next to. The default target is the ACTIVE
  // one among its linked tabs (the page in front of the user), never some other
  // window's active tab.
  if (sid) {
    const linked = await linkedTabIds(sid);
    if (!linked.length) throw new Error('this terminal session is not docked in any browser tab — nothing to control');
    if (explicit != null) {
      if (!linked.includes(explicit)) throw new Error('tab ' + explicit + ' is not linked to this terminal session');
      return await chrome.tabs.get(explicit);
    }
    const tabs = [];
    for (const id of linked) { try { tabs.push(await chrome.tabs.get(id)); } catch (_) {} }
    if (!tabs.length) throw new Error('linked tab(s) no longer open');
    return tabs.find((t) => t.active) || tabs[0];
  }

  // No session context (e.g. the debug /browser/command route): unrestricted.
  if (explicit != null) return await chrome.tabs.get(explicit);
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
  const t = win && win.tabs && win.tabs.find((x) => x.active);
  if (!t) throw new Error('no target tab (no linked tab and no active tab)');
  return t;
}

// ---- CDP (chrome.debugger) helpers ----
const attached = new Set();          // tabIds we hold a debugger session on
const idleTimers = new Map();        // tabId -> detach timer

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}
function attachDbg(tabId) {
  return new Promise((resolve, reject) => {
    if (attached.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      attached.add(tabId); resolve();
    });
  });
}
function detachDbg(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError); } catch (_) {}
}
// drop the "being debugged" banner shortly after the last CDP action
function scheduleDetach(tabId) {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.set(tabId, setTimeout(() => { detachDbg(tabId); idleTimers.delete(tabId); }, 3000));
}
chrome.debugger.onDetach.addListener((src) => { if (src.tabId != null) attached.delete(src.tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); clearTimeout(idleTimers.get(tabId)); idleTimers.delete(tabId); });

const KEY_CODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};
async function cdpKey(tabId, key) {
  const vk = KEY_CODES[key];
  if (vk == null) { await cdp(tabId, 'Input.insertText', { text: key }); return; }
  const base = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// ---- injected functions (run in the page) ----
function injRead() {
  return {
    title: document.title,
    url: location.href,
    text: (document.body ? document.body.innerText : '').slice(0, 20000),
  };
}
function injEval(code) {
  try {
    // eslint-disable-next-line no-eval
    const r = (0, eval)(code);
    let value;
    if (r === undefined) value = null;
    else { try { value = JSON.parse(JSON.stringify(r)); } catch (_) { value = String(r); } }
    return { ok: true, value };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
function injClick(sel) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, error: 'no element matches ' + sel };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { ok: true };
}
function injType(sel, text, submit) {
  const el = sel ? document.querySelector(sel) : document.activeElement;
  if (!el) return { ok: false, error: sel ? ('no element matches ' + sel) : 'no focused element' };
  el.focus();
  if ('value' in el) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    return { ok: false, error: 'element is not typable' };
  }
  if (submit) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }
  return { ok: true };
}

function injWaitFor(sel, timeoutMs, visible) {
  const start = Date.now();
  const isVisible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const match = () => {
    const el = document.querySelector(sel);
    return el && (!visible || isVisible(el)) ? el : null;
  };
  return new Promise((resolve) => {
    if (match()) return resolve({ ok: true, waitedMs: Date.now() - start });
    const timer = setInterval(() => {
      if (match()) { clearInterval(timer); resolve({ ok: true, waitedMs: Date.now() - start }); }
      else if (Date.now() - start >= timeoutMs) { clearInterval(timer); resolve({ ok: false, waitedMs: Date.now() - start }); }
    }, 100);
  });
}

async function inject(tabId, world, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world, func, args: args || [] });
  return res ? res.result : undefined;
}

// Ensure the HUD is installed in the tab (idempotent). Returns true if the
// overlay is available for this action, false if disabled or injection failed
// (e.g. a chrome:// page) — callers fall back to plain, feedback-less behavior.
async function ensureHud(tabId, silent) {
  if (!HUD_ENABLED || silent) return false;
  try { await inject(tabId, 'ISOLATED', injHud); return true; }
  catch (_) { return false; }
}

// ---- visual feedback HUD (baked in, so actions are watchable) -------------
// The ISOLATED world persists across executeScript calls in a frame, so we
// install a HUD (a fake cursor + highlight/ripple/toast primitives) ONCE on
// window.__CTHUD; every action then calls into it. This is why the visuals
// don't have to be re-invented as ad-hoc eval'd JS each time. A navigation
// drops it → ensureHud() reinstalls (idempotent, version-guarded).
function injHud() {
  const V = 2;
  if (window.__CTHUD && window.__CTHUD.v === V) return { ready: true };
  const Z = 2147483600;
  const HOLD = 2500;   // how long decorations linger before fading (ms)
  const doc = document;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mk = (style, parent) => {
    const e = doc.createElement('div');
    if (style) Object.assign(e.style, style);
    (parent || doc.body).appendChild(e);
    return e;
  };
  const CURSOR_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M5 3l14 8-6 1.5L9.5 19 5 3z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  const H = {
    v: V,
    cursor() {
      let c = doc.getElementById('__ct_cursor');
      if (!c) {
        c = mk({
          position: 'fixed', left: '50%', top: '50%', zIndex: String(Z + 5),
          pointerEvents: 'none', width: '22px', height: '22px', transform: 'translate(-3px,-2px)',
          transition: 'left .5s cubic-bezier(.22,.61,.36,1), top .5s cubic-bezier(.22,.61,.36,1)',
          filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))', willChange: 'left, top',
        });
        c.id = '__ct_cursor';
        c.innerHTML = CURSOR_SVG;
      }
      return c;
    },
    pos() {
      const c = this.cursor();
      return { x: parseFloat(c.style.left) || innerWidth / 2, y: parseFloat(c.style.top) || innerHeight / 2 };
    },
    async moveTo(x, y, settle = 480) {
      const c = this.cursor();
      c.style.left = Math.round(x) + 'px';
      c.style.top = Math.round(y) + 'px';
      await sleep(settle);
    },
    center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
    inView(r) { return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; },
    async scrollTo(node) {
      if (!node) return;
      if (!this.inView(node.getBoundingClientRect())) {
        node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        await sleep(450);
      }
    },
    highlight(node, opts) { if (node) this.highlightRect(node.getBoundingClientRect(), opts); },
    highlightRect(r, opts) {
      opts = opts || {};
      const pad = opts.pad == null ? 3 : opts.pad;
      const color = opts.color || '#3b82f6';
      const dur = opts.duration == null ? HOLD : opts.duration;
      const box = mk({
        position: 'fixed', left: (r.left - pad) + 'px', top: (r.top - pad) + 'px',
        width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
        border: '2px solid ' + color, borderRadius: '6px', zIndex: String(Z + 3),
        pointerEvents: 'none', boxShadow: '0 0 0 3px ' + color + '33, 0 4px 18px ' + color + '55',
        opacity: '0', transform: 'scale(1.04)', boxSizing: 'border-box',
        transition: 'opacity .16s ease, transform .16s ease',
      });
      let tag = null;
      if (opts.label) {
        tag = mk({
          position: 'fixed', left: (r.left - pad) + 'px', top: (r.top - pad - 20) + 'px',
          font: '600 11px/1 -apple-system,"Segoe UI",Roboto,sans-serif', color: '#fff',
          background: color, padding: '3px 7px', borderRadius: '5px', zIndex: String(Z + 4),
          pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: '60vw', overflow: 'hidden',
          textOverflow: 'ellipsis', opacity: '0', transition: 'opacity .16s ease',
        });
        tag.textContent = opts.label;
      }
      requestAnimationFrame(() => {
        box.style.opacity = '1'; box.style.transform = 'scale(1)';
        if (tag) tag.style.opacity = '1';
      });
      if (!opts.persist) {
        setTimeout(() => {
          box.style.opacity = '0'; if (tag) tag.style.opacity = '0';
          setTimeout(() => { box.remove(); if (tag) tag.remove(); }, 250);
        }, dur);
      }
    },
    ripple(x, y, color) {
      color = color || '#22c55e';
      const r = mk({
        position: 'fixed', left: x + 'px', top: y + 'px', width: '12px', height: '12px',
        marginLeft: '-6px', marginTop: '-6px', borderRadius: '50%', border: '2px solid ' + color,
        zIndex: String(Z + 4), pointerEvents: 'none', opacity: '1', transform: 'scale(1)',
        transition: 'transform .45s ease-out, opacity .45s ease-out',
      });
      requestAnimationFrame(() => { r.style.transform = 'scale(3.6)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 470);
      // a lingering dot so the click point stays marked ~HOLD ms
      const dot = mk({
        position: 'fixed', left: x + 'px', top: y + 'px', width: '10px', height: '10px',
        marginLeft: '-5px', marginTop: '-5px', borderRadius: '50%', background: color,
        zIndex: String(Z + 4), pointerEvents: 'none', opacity: '0.9',
        transition: 'opacity ' + HOLD + 'ms ease-out',
      });
      requestAnimationFrame(() => { dot.style.opacity = '0'; });
      setTimeout(() => dot.remove(), HOLD + 100);
    },
    toast(text, kind) {
      const p = this.pos();
      const t = mk({
        position: 'fixed', left: p.x + 'px', top: (p.y - 18) + 'px',
        transform: 'translate(-50%,-100%) scale(.9)', padding: '5px 11px', borderRadius: '7px',
        font: '600 12px/1.2 -apple-system,"Segoe UI",Roboto,sans-serif', color: '#fff',
        background: kind === 'bad' ? '#d23c33' : kind === 'info' ? '#2563eb' : '#1f9d3f',
        boxShadow: '0 4px 14px rgba(0,0,0,.4)', zIndex: String(Z + 6), pointerEvents: 'none',
        opacity: '0', whiteSpace: 'nowrap', transition: 'opacity .18s ease, transform .18s ease',
      });
      t.textContent = text;
      requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translate(-50%,-100%) scale(1)'; });
      setTimeout(() => {
        t.style.opacity = '0'; t.style.transform = 'translate(-50%,-120%) scale(.95)';
        setTimeout(() => t.remove(), 220);
      }, HOLD);
    },
    // scroll to a node, glide the cursor onto its center, return that point
    async aim(node) {
      await this.scrollTo(node);
      const c = this.center(node.getBoundingClientRect());
      await this.moveTo(c.x, c.y);
      return c;
    },
  };
  window.__CTHUD = H;
  H.cursor();
  return { ready: true };
}

// ---- HUD-aware injected actions (call into window.__CTHUD) ----
// NOTE: these run in the page via executeScript — they are serialized on their
// own, so they can only use window/DOM globals and window.__CTHUD, never other
// module-scope helpers. Keep the label helper inline.
async function injClickHud(sel) {
  const H = window.__CTHUD;
  const el = document.querySelector(sel);
  if (!el) return { ok: false, error: 'no element matches ' + sel };
  const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.tagName || '').toString().trim().replace(/\s+/g, ' ').slice(0, 40);
  const c = H ? await H.aim(el) : (el.scrollIntoView({ block: 'center' }), null);
  if (H) { H.highlight(el, { color: '#22c55e', label }); H.ripple(c.x, c.y); await new Promise(r => setTimeout(r, 120)); }
  el.click();
  return { ok: true };
}

async function injTypeHud(sel, text, submit) {
  const H = window.__CTHUD;
  const el = sel ? document.querySelector(sel) : document.activeElement;
  if (!el) return { ok: false, error: sel ? ('no element matches ' + sel) : 'no focused element' };
  const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.tagName || '').toString().trim().replace(/\s+/g, ' ').slice(0, 40);
  if (H) { await H.aim(el); H.highlight(el, { color: '#2563eb', label, duration: 2500 }); }
  el.focus();
  if ('value' in el) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    return { ok: false, error: 'element is not typable' };
  }
  if (submit) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }
  return { ok: true };
}

// Glide the cursor to a viewport point (+ optional ripple) — for CDP-driven
// trusted clicks/keys where the real interaction happens outside the page.
async function injPointAt(x, y, ripple) {
  const H = window.__CTHUD;
  if (!H) return { ok: true };
  await H.moveTo(x, y);
  if (ripple) H.ripple(x, y);
  return { ok: true };
}

// Read with a visible "scanning" cue: a frame flash + toast near the cursor.
function injReadHud() {
  const H = window.__CTHUD;
  const out = {
    title: document.title,
    url: location.href,
    text: (document.body ? document.body.innerText : '').slice(0, 20000),
  };
  if (H) {
    H.highlightRect({ left: 4, top: 4, width: innerWidth - 8, height: innerHeight - 8 }, { color: '#a855f7', duration: 2500, pad: 0 });
    H.toast('reading page', 'info');
  }
  return out;
}

function injToast(text, kind) {
  const H = window.__CTHUD;
  if (H) H.toast(text, kind);
  return { ok: true };
}

async function injHighlightSel(sel, color, label) {
  const H = window.__CTHUD;
  const el = document.querySelector(sel);
  if (!el) return { ok: false };
  if (H) { await H.scrollTo(el); H.highlight(el, { color: color || '#3b82f6', label: label || undefined }); }
  return { ok: true };
}

// ---- action dispatch ----
async function runAction(cmd) {
  const action = cmd.action;
  const p = cmd.params || {};

  if (action === 'list_tabs') {
    const tabs = await chrome.tabs.query({});
    // A linked session sees ONLY its own docked tab(s) — never the rest of the browser.
    if (cmd.sessionId) {
      const linked = new Set(await linkedTabIds(cmd.sessionId));
      return tabs.filter((t) => linked.has(t.id))
        .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, linked: true }));
    }
    // No session context (debug route): show everything.
    return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, linked: false }));
  }

  const tab = await resolveTab(cmd);
  const tabId = tab.id;

  switch (action) {
    case 'read_page': {
      const hud = await ensureHud(tabId, p.silent);
      return await inject(tabId, 'ISOLATED', hud ? injReadHud : injRead);
    }

    case 'eval': {
      const out = await inject(tabId, 'MAIN', injEval, [String(p.code || '')]);
      if (out && out.ok) return out.value;
      throw new Error((out && out.error) || 'eval failed');
    }

    case 'click': {
      const hud = await ensureHud(tabId, p.silent);
      if (p.selector) {
        const out = await inject(tabId, 'ISOLATED', hud ? injClickHud : injClick, [String(p.selector)]);
        if (out && out.ok) return { clicked: p.selector };
        throw new Error((out && out.error) || 'click failed');
      }
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        if (hud) await inject(tabId, 'ISOLATED', injPointAt, [p.x, p.y, true]);
        await attachDbg(tabId);
        const base = { x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 };
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
        scheduleDetach(tabId);
        return { clicked: { x: p.x, y: p.y } };
      }
      throw new Error('click needs a selector or x,y coordinates');
    }

    case 'type': {
      const hud = await ensureHud(tabId, p.silent);
      if (p.trusted) {
        if (hud && p.selector) await inject(tabId, 'ISOLATED', injTypeHud, [String(p.selector), '', false]);
        await attachDbg(tabId);
        if (p.text) await cdp(tabId, 'Input.insertText', { text: String(p.text) });
        if (p.submit) await cdpKey(tabId, 'Enter');
        scheduleDetach(tabId);
        return { typed: true, trusted: true };
      }
      const out = await inject(tabId, 'ISOLATED', hud ? injTypeHud : injType, [p.selector ? String(p.selector) : null, String(p.text || ''), !!p.submit]);
      if (out && out.ok) return { typed: true };
      throw new Error((out && out.error) || 'type failed');
    }

    case 'key': {
      const hud = await ensureHud(tabId, p.silent);
      if (hud) await inject(tabId, 'ISOLATED', injToast, [String(p.key || ''), 'info']);
      await attachDbg(tabId);
      await cdpKey(tabId, String(p.key || ''));
      scheduleDetach(tabId);
      return { key: p.key };
    }

    case 'scroll': {
      await attachDbg(tabId);
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: typeof p.x === 'number' ? p.x : 300,
        y: typeof p.y === 'number' ? p.y : 300,
        deltaX: p.deltaX || 0,
        deltaY: typeof p.deltaY === 'number' ? p.deltaY : 600,
      });
      scheduleDetach(tabId);
      return { scrolled: true };
    }

    case 'screenshot': {
      // captureVisibleTab only grabs the VISIBLE tab of its window — so it's only
      // correct when the target IS the active tab. For a full-page shot, or when
      // the target isn't the visible tab, use CDP so we capture the right tab.
      if (p.fullPage || !tab.active) {
        await attachDbg(tabId);
        await cdp(tabId, 'Page.enable');
        const opts = { format: 'png' };
        if (p.fullPage) {
          const metrics = await cdp(tabId, 'Page.getLayoutMetrics');
          const size = metrics.cssContentSize || metrics.contentSize || { width: tab.width || 1280, height: tab.height || 800 };
          opts.captureBeyondViewport = true;
          opts.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
        }
        const shot = await cdp(tabId, 'Page.captureScreenshot', opts);
        scheduleDetach(tabId);
        return 'data:image/png;base64,' + shot.data;
      }
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    }

    case 'wait_for': {
      const sel = String(p.selector || '');
      if (!sel) throw new Error('wait_for needs a selector');
      const timeoutMs = typeof p.timeoutMs === 'number' ? p.timeoutMs : 10000;
      const out = await inject(tabId, 'ISOLATED', injWaitFor, [sel, timeoutMs, !!p.visible]);
      if (out && out.ok) {
        const hud = await ensureHud(tabId, p.silent);
        if (hud) await inject(tabId, 'ISOLATED', injHighlightSel, [sel, '#22c55e', 'found']);
        return { found: true, waitedMs: out.waitedMs };
      }
      throw new Error('timed out after ' + timeoutMs + 'ms waiting for ' + sel);
    }

    case 'navigate': {
      const url = String(p.url || '');
      if (!url) throw new Error('navigate needs a url');
      await chrome.tabs.update(tabId, { url });
      await new Promise((resolve) => {
        const done = (id, info) => {
          if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); resolve(); }
        };
        chrome.tabs.onUpdated.addListener(done);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 45000);
      });
      const t = await chrome.tabs.get(tabId);
      return { url: t.url, title: t.title, status: 'complete' };
    }

    default:
      throw new Error('unknown action: ' + action);
  }
}
