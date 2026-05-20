// Zen Tab Wand — browser-context event hooks.
//
// Rule growth is now strictly user-initiated:
//   • Settings UI — direct editing of each rule's domain list.
//   • Tab right-click → "Add <hostname> to <group> rule" — explicit menu item
//     installed by setupTabContextMenu (this file).
//
// We REMOVED the previous global TabGrouped listener because Zen dispatches
// TabGrouped events asynchronously (and for non-user reasons like session
// restore reconciling state after we've programmatically ejected a tab).
// There's no reliable way to distinguish user-initiated grouping from Zen's
// internal re-attaches, so the listener was an endless source of phantom
// rule growth. The context menu item replaces it with explicit user intent.
//
// Remaining DOM hook + observer in this file:
//   TabGroupCreate   — re-apply rule colors when Zen restores groups on startup.
//   minimal-style    — re-run syncAllGroupColors when the user toggles the pref.
//
// On DOM hooks we stash the installed handler back onto its host element as a
// `_zaoXxxHook` expando. This prevents double-install if the entry script is
// re-evaluated (e.g. across module reloads during development).

import { CONFIG, LOG, BUILD_VERSION, isZenColorName, isUnsetLabel } from "./config.mjs";
import { getTabUrl, getHostname } from "./tabs.mjs";
import { readRulesPref, writeRulesPref, isMinimalStyle } from "./rules.mjs";
import { applyGroupColor, syncAllGroupColors } from "./groups.mjs";

// No-op shims for back-compat. The TabGrouped listener is gone, so there's
// nothing to suppress. These exports stay so existing callsites in pass1.mjs /
// ai.mjs / groups.mjs / click-handler.mjs don't need touching; they can be
// cleaned up in a future sweep.
export const pushTabGroupedHookSuppression = () => {};
export const popTabGroupedHookSuppression = () => {};
export const setTabGroupedHookSuppressed = (_val) => {};
export const markTabAsEjected = (_tab) => {};

// ─── Helpers (module level so they're reusable + easy to find) ───────────────

// Add the tab's hostname to an existing rule, or create a new rule if the group
// name isn't in the rules yet. Called from both the named-group and new-group paths.
const applyToRule = (tab, groupName, group) => {
  const hostname = getHostname(getTabUrl(tab));
  if (!hostname) return;

  const rules = readRulesPref() || [];
  const rule = rules.find((r) => r.name === groupName);

  if (rule) {
    if (rule.domains.includes(hostname)) {
      console.log(`${LOG} context-menu: "${hostname}" already in "${groupName}"`);
      return;
    }
    rule.domains.push(hostname);
    writeRulesPref(rules);
    console.log(`${LOG} context-menu: added "${hostname}" to existing rule "${groupName}"`);
  } else {
    const newRule = { name: groupName, domains: [hostname] };
    const groupColor = group?.color;
    if (isZenColorName(groupColor)) newRule.color = groupColor;
    rules.push(newRule);
    writeRulesPref(rules);
    console.log(
      `${LOG} context-menu: created new rule "${groupName}" with "${hostname}"` +
        (newRule.color ? ` (color: ${newRule.color})` : "")
    );
  }
};

// ─── Setup ───────────────────────────────────────────────────────────────────

// Install a tab right-click menu item that lets the user explicitly add the
// hovered tab's hostname to its current group's rule. Replaces the previous
// passive TabGrouped listener — which couldn't reliably distinguish user
// actions from Zen's async session-restore re-attaches. Explicit user click
// = explicit user intent.
//
// The menu item is hidden when:
//   • The hovered tab isn't in a group
//   • The group's label doesn't match any current rule
//   • The hostname is already in the matched rule's domains
//
// Otherwise it shows `Add "<hostname>" to "<group>" rule`.
const MENUITEM_ID = "zen-tab-wand-add-to-rule";

const findContextMenu = () =>
  document.getElementById("tabContextMenu") ||
  document.getElementById("zenTabContextMenu") ||
  null;

const computeMenuState = (tab) => {
  if (!tab) return { show: false, reason: "no-tab" };
  const groupEl = tab.closest?.("tab-group");
  const groupName = groupEl?.getAttribute?.("label");
  if (!groupName || isUnsetLabel(groupName)) return { show: false, reason: "not-in-group" };
  let hostname = null;
  try { hostname = getHostname(getTabUrl(tab)); } catch {}
  if (!hostname) return { show: false, reason: "no-hostname" };
  const rules = readRulesPref() || [];
  const rule = rules.find((r) => r.name === groupName);
  if (!rule) return { show: false, reason: "no-matching-rule" };
  if (rule.domains.includes(hostname)) return { show: false, reason: "already-in-rule" };
  return { show: true, tab, group: groupEl, groupName, hostname };
};

export const setupTabContextMenu = () => {
  const menu = findContextMenu();
  if (!menu) {
    console.warn(`${LOG} tab context menu not found — context menu integration skipped`);
    return;
  }
  if (menu._zaoContextMenuInstalled) return;

  const item = document.createXULElement("menuitem");
  item.id = MENUITEM_ID;
  item.setAttribute("hidden", "true");
  menu.appendChild(item);

  let currentState = null;

  const onShowing = () => {
    const tab = window.TabContextMenu?.contextTab || window.gBrowser?.selectedTab;
    const state = computeMenuState(tab);
    currentState = state;
    if (state.show) {
      item.hidden = false;
      item.setAttribute("label", `Add "${state.hostname}" to "${state.groupName}" rule`);
    } else {
      item.hidden = true;
    }
  };

  const onCommand = (e) => {
    if (e.target !== item) return;
    if (!currentState?.show) return;
    applyToRule(currentState.tab, currentState.groupName, currentState.group);
  };

  menu.addEventListener("popupshowing", onShowing);
  menu.addEventListener("command", onCommand);
  menu._zaoContextMenuInstalled = { onShowing, onCommand, item };
  console.log(`${LOG} tab context menu installed (build ${BUILD_VERSION})`);
};

export const teardownTabContextMenu = () => {
  const menu = findContextMenu();
  if (!menu?._zaoContextMenuInstalled) return;
  const { onShowing, onCommand, item } = menu._zaoContextMenuInstalled;
  try { menu.removeEventListener("popupshowing", onShowing); } catch {}
  try { menu.removeEventListener("command", onCommand); } catch {}
  if (item?.isConnected) try { item.remove(); } catch {}
  menu._zaoContextMenuInstalled = null;
};

// On every tab-group creation (including session restore on startup), re-apply the
// rule's color so it survives across browser restarts even if Zen's session storage
// dropped our previously-set color.
export const setupTabGroupCreateHook = () => {
  if (typeof gBrowser === "undefined" || !gBrowser.tabContainer) return;
  if (gBrowser.tabContainer._zaoTabGroupCreateHook) return;

  const handler = (event) => {
    try {
      const group = event.target;
      if (!group?.isConnected) return;
      const label = group.getAttribute?.("label");
      if (!label) return;

      const rules = readRulesPref() || [];
      const rule = rules.find((r) => r.name === label);
      if (!rule?.color) return;

      // Defer one tick so Zen's own color setup (which runs synchronously during
      // group construction) is done before we override.
      setTimeout(() => {
        if (group.isConnected) applyGroupColor(group, rule.color);
      }, 0);
    } catch (e) {
      console.error(`${LOG} TabGroupCreate handler error:`, e);
    }
  };

  gBrowser.tabContainer.addEventListener("TabGroupCreate", handler);
  gBrowser.tabContainer._zaoTabGroupCreateHook = handler;
  console.log(`${LOG} TabGroupCreate hook installed`);
};

// ─── Pref observers ──────────────────────────────────────────────────────────

// Live re-apply of group styling when the user toggles the minimal-style pref.
// Without this the change is invisible until the next tidy-click.
//
// Services.prefs.addObserver attaches to the *global* prefs service (lives in the
// parent process) and would survive window close, leaking a window reference if
// we don't remove it. Hence the explicit teardown — wired into the entry
// script's cleanup() handler.
let minimalStylePrefObserver = null;

export const setupMinimalStylePrefObserver = () => {
  if (minimalStylePrefObserver) return;
  minimalStylePrefObserver = {
    observe(_subject, topic, data) {
      if (topic !== "nsPref:changed") return;
      if (data !== CONFIG.MINIMAL_STYLE_PREF) return;
      try {
        // Pass null so we walk every workspace's tab-groups — minimal-style is a
        // global pref and a user toggling it expects the change to apply everywhere,
        // not just whichever workspace happens to be active at the moment.
        const rules = readRulesPref() || [];
        const touched = syncAllGroupColors(null, rules);
        console.log(`${LOG} minimal-style toggled → resynced ${touched} group(s) across all workspaces (minimal=${isMinimalStyle()})`);
      } catch (e) {
        console.error(`${LOG} minimal-style pref observer error:`, e);
      }
    },
  };
  Services.prefs.addObserver(CONFIG.MINIMAL_STYLE_PREF, minimalStylePrefObserver);
  console.log(`${LOG} minimal-style pref observer installed`);
};

export const teardownMinimalStylePrefObserver = () => {
  if (!minimalStylePrefObserver) return;
  try {
    Services.prefs.removeObserver(CONFIG.MINIMAL_STYLE_PREF, minimalStylePrefObserver);
  } catch (e) {
    console.warn(`${LOG} failed to remove minimal-style pref observer:`, e);
  }
  minimalStylePrefObserver = null;
};
