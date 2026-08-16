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
