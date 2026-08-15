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
// colored tab group named "PS". This marks in the tab strip which tabs own a
// terminal — and it PERSISTS while the side panel is closed, since the panes
// persist. Emptying a tab's panes (kill/close all) ungroups the tab.
const GROUP_TITLE = 'PS';
const GROUP_COLOR = 'orange';

async function ensureGrouped(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId && tab.groupId !== -1) {
      const g = await chrome.tabGroups.get(tab.groupId);
      if (g.title === GROUP_TITLE) return; // already in a PS group
    }
    const gid = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: GROUP_COLOR });
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

// React to pane changes written by the side panel.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ct_panes) return;
  const oldTabs = tabsWithPanes(changes.ct_panes.oldValue);
  const newTabs = tabsWithPanes(changes.ct_panes.newValue);
  for (const t of newTabs) if (!oldTabs.has(t)) ensureGrouped(t);
  for (const t of oldTabs) if (!newTabs.has(t)) ungroup(t);
});

// On SW start, re-apply groups for tabs (with panes) that still exist.
async function reconcileGroups() {
  try {
    const { ct_panes } = await chrome.storage.local.get('ct_panes');
    for (const id of tabsWithPanes(ct_panes)) {
      try { await chrome.tabs.get(id); } catch (_) { continue; }
      ensureGrouped(id);
    }
  } catch (_) {}
}
chrome.runtime.onStartup.addListener(reconcileGroups);
reconcileGroups();
