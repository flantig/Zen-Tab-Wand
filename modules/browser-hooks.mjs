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
import { readRulesPref, writeRulesPref, readSkipDomainsPref, writeSkipDomainsPref, readCollapsedGroupsPref, writeCollapsedGroupsPref, isMinimalStyle } from "./rules.mjs";
import { applyGroupColor, syncAllGroupColors, moveTabsToTop } from "./groups.mjs";

// ─── Helpers (module level so they're reusable + easy to find) ───────────────

// Add the tab's hostname to an existing rule, or create a new rule if the group
// name isn't in the rules yet. Called from both the named-group and new-group paths.
const applyToRule = (tab, groupName, group) => {
  const hostname = getHostname(getTabUrl(tab));
  if (!hostname) return;

  // keepIncomplete: true so we can find an existing in-progress rule by
  // name and grow it, rather than creating a duplicate with the same name.
  const rules = readRulesPref({ keepIncomplete: true }) || [];
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

// Install a tab right-click submenu `Add "<hostname>" to Rule…` that lists
// every current rule as a child menuitem. User picks a rule → the hostname is
// added to that rule's domains. The current group is irrelevant — this lets
// the user grow ANY rule for the hostname, not just the rule matching the
// tab's existing group.
//
// Replaces the previous global TabGrouped listener (which couldn't reliably
// distinguish user actions from Zen's async session-restore re-attaches) with
// an explicit user-driven flow: no events, no race conditions.
const PARENT_MENU_ID = "zen-tab-wand-add-to-rule-menu";

const findContextMenu = () =>
  document.getElementById("tabContextMenu") ||
  document.getElementById("zenTabContextMenu") ||
  null;

const getTabHostname = (tab) => {
  if (!tab) return null;
  try { return getHostname(getTabUrl(tab)); } catch { return null; }
};

export const setupTabContextMenu = () => {
  const menu = findContextMenu();
  if (!menu) {
    console.warn(`${LOG} tab context menu not found — context menu integration skipped`);
    return;
  }
  if (menu._zaoContextMenuInstalled) return;

  // Build the submenu skeleton. Submenu items are rebuilt each popupshowing
  // so rule edits in settings are immediately reflected.
  const parent = document.createXULElement("menu");
  parent.id = PARENT_MENU_ID;
  parent.setAttribute("label", "Add to Rule…");
  parent.setAttribute("hidden", "true");

  const popup = document.createXULElement("menupopup");
  parent.appendChild(popup);
  menu.appendChild(parent);

  // Captured on the outer popupshowing and read by the inner command handler.
  let currentTab = null;
  let currentHostname = null;

  const onOuterShowing = (e) => {
    // Only react to the outer (tab) context menu opening — submenu popupshowing
    // also bubbles through here.
    if (e.target !== menu) return;
    currentTab = window.TabContextMenu?.contextTab || window.gBrowser?.selectedTab;
    currentHostname = getTabHostname(currentTab);
    if (!currentTab || !currentHostname) {
      parent.hidden = true;
      return;
    }
    parent.hidden = false;
    parent.setAttribute("label", `Add "${currentHostname}" to Rule…`);
  };

  const onSubmenuShowing = () => {
    while (popup.firstChild) popup.firstChild.remove();
    // keepIncomplete: true so a named-but-domainless in-progress rule
    // shows up here — clicking it adds the current tab's hostname as its
    // first domain (which is exactly the natural way to populate a fresh
    // rule). A blank-name placeholder row (still untitled in the editor)
    // is suppressed below so we don't surface an empty menu entry.
    const allRules = readRulesPref({ keepIncomplete: true }) || [];
    const rules = allRules.filter((r) => r.name && r.name.length > 0);
    const skipList = readSkipDomainsPref() || [];
    if (rules.length === 0) {
      const placeholder = document.createXULElement("menuitem");
      placeholder.setAttribute("label", "(no rules defined yet)");
      placeholder.setAttribute("disabled", "true");
      popup.appendChild(placeholder);
    } else {
      for (const rule of rules) {
        const item = document.createXULElement("menuitem");
        const inRule = currentHostname && rule.domains.includes(currentHostname);
        // Checkmark for rules that already contain this hostname (disabled
        // to make it clear the action is a no-op).
        item.setAttribute("label", inRule ? `✓ ${rule.name}` : rule.name);
        if (inRule) item.setAttribute("disabled", "true");
        item.dataset.zaoRuleName = rule.name;
        popup.appendChild(item);
      }
    }

    // Skip-domains entry: a distinct "destination" for the hostname (parks
    // the tab at the top of the workspace on every tidy click instead of
    // grouping it). Separated from rules with a menuseparator. Shows ✓ +
    // disabled if the hostname is already in the skip list.
    popup.appendChild(document.createXULElement("menuseparator"));
    const skipItem = document.createXULElement("menuitem");
    const inSkip = currentHostname && skipList.includes(currentHostname);
    skipItem.setAttribute("label", inSkip ? "✓ Skip" : "Skip");
    if (inSkip) skipItem.setAttribute("disabled", "true");
    skipItem.dataset.zaoSkip = "true";
    popup.appendChild(skipItem);
  };

  const onCommand = (e) => {
    const item = e.target;
    if (!currentTab || !currentHostname) return;
    if (item?.dataset?.zaoSkip === "true") {
      const skipList = readSkipDomainsPref() || [];
      if (skipList.includes(currentHostname)) return;
      skipList.push(currentHostname);
      writeSkipDomainsPref(skipList);
      console.log(`${LOG} context-menu: added "${currentHostname}" to skip-domains`);
      return;
    }
    const ruleName = item?.dataset?.zaoRuleName;
    if (!ruleName) return;
    // applyToRule reads the hostname off the tab itself; pass the tab's
    // current group element so its color is preserved if applyToRule has to
    // create a new rule (defensive — the submenu only lists existing rules,
    // but applyToRule is safe either way).
    const groupEl = currentTab.closest?.("tab-group");
    applyToRule(currentTab, ruleName, groupEl);
  };

  menu.addEventListener("popupshowing", onOuterShowing);
  popup.addEventListener("popupshowing", onSubmenuShowing);
  popup.addEventListener("command", onCommand);
  menu._zaoContextMenuInstalled = { onOuterShowing, onSubmenuShowing, onCommand, parent, popup };
  console.log(`${LOG} tab context submenu installed (build ${BUILD_VERSION})`);
};

export const teardownTabContextMenu = () => {
  const menu = findContextMenu();
  if (!menu?._zaoContextMenuInstalled) return;
  const { onOuterShowing, onSubmenuShowing, onCommand, parent, popup } = menu._zaoContextMenuInstalled;
  try { menu.removeEventListener("popupshowing", onOuterShowing); } catch {}
  try { popup.removeEventListener("popupshowing", onSubmenuShowing); } catch {}
  try { popup.removeEventListener("command", onCommand); } catch {}
  if (parent?.isConnected) try { parent.remove(); } catch {}
  menu._zaoContextMenuInstalled = null;
};

// ─── Tab-group right-click: "Dissolve group" ─────────────────────────────────
//
// Zen routes right-clicks on tab-group labels to Firefox's standard toolbar
// context menu (#toolbar-context-menu) — the same menu used for empty
// sidebar / toolbar customization. We append a "Dissolve group" entry that's
// only visible when the right-click happened on a tab-group label.
//
// "Dissolve group" — ungroup all tabs in the group AND move them to the top
// of the workspace. The matching rule in settings stays intact so the next
// wand click would re-create the group from whatever tabs match the rule.

const TOOLBAR_CONTEXT_MENU_ID = "toolbar-context-menu";

// Most recent tab-group that was right-clicked. Set by our capture-phase
// contextmenu listener; read by the menu's popupshowing handler to decide
// whether to show the "Dissolve group" item.
let _pendingDissolveTargetGroup = null;

const dissolveTabGroup = (group) => {
  if (!group?.isConnected) return;
  const workspaceId = window.gZenWorkspaces?.activeWorkspace;
  if (!workspaceId) {
    console.warn(`${LOG} dissolveTabGroup: no active workspace`);
    return;
  }
  const tabs = Array.from(group.querySelectorAll(`tab[zen-workspace-id="${workspaceId}"]`))
    .filter((t) => t.isConnected);
  if (tabs.length === 0) {
    // Empty group — just remove the element.
    try { group.remove(); } catch {}
    return;
  }
  const groupName = group.getAttribute?.("label") || "(unnamed)";
  // moveTabsToTop handles gBrowser.ungroupTab + DOM reparent to top, the same
  // path strict-mode ejection and skip-domain parking use.
  const moved = moveTabsToTop(tabs, workspaceId);
  console.log(`${LOG} dissolved group "${groupName}" — ejected ${moved} tab(s) to top of workspace`);
  // Group element typically auto-removes when empty, but defensively remove
  // it ourselves if it lingered.
  setTimeout(() => {
    if (group.isConnected && !group.querySelector("tab")) {
      try { group.remove(); } catch {}
    }
  }, 50);
};

// Capture-phase contextmenu listener — fires BEFORE the toolbar context menu
// opens so the pending-target is set in time for popupshowing.
const onContextMenuCapture = (e) => {
  _pendingDissolveTargetGroup = e.target?.closest?.("tab-group") || null;
};

let _onMenuShowing = null;
let _onMenuHidden = null;
let _onMenuItemCommand = null;

export const setupTabGroupContextMenu = () => {
  const menu = document.getElementById(TOOLBAR_CONTEXT_MENU_ID);
  if (!menu) {
    console.warn(`${LOG} #${TOOLBAR_CONTEXT_MENU_ID} not found — Dissolve group menuitem not installed`);
    return;
  }
  if (menu._zaoDissolveInstalled) return;
  menu._zaoDissolveInstalled = true;

  // Build menuitem + separator. Hidden by default; shown on popupshowing when
  // the most recent right-click was on a tab-group.
  const separator = document.createXULElement("menuseparator");
  separator.id = "zen-tab-wand-dissolve-separator";
  separator.setAttribute("hidden", "true");

  const item = document.createXULElement("menuitem");
  item.id = "zen-tab-wand-dissolve-group";
  item.setAttribute("label", "Dissolve group");
  item.setAttribute("hidden", "true");

  // Insert at the top of the menu so it's prominent when shown. (The native
  // Zen items remain in their normal positions below.)
  menu.prepend(separator);
  menu.prepend(item);

  _onMenuShowing = () => {
    const group = _pendingDissolveTargetGroup;
    const show = !!group;
    item.hidden = !show;
    separator.hidden = !show;
    if (show) {
      const name = group.getAttribute?.("label") || "(unnamed)";
      item.setAttribute("label", `Dissolve group "${name}"`);
    }
  };
  _onMenuHidden = () => {
    // Clear after the menu closes (whether from click or dismiss) so a
    // subsequent non-group right-click doesn't surface our item stale.
    _pendingDissolveTargetGroup = null;
  };
  _onMenuItemCommand = () => {
    const group = _pendingDissolveTargetGroup;
    if (!group) {
      console.warn(`${LOG} dissolve clicked but no target group captured`);
      return;
    }
    dissolveTabGroup(group);
  };

  menu.addEventListener("popupshowing", _onMenuShowing);
  menu.addEventListener("popuphidden", _onMenuHidden);
  item.addEventListener("command", _onMenuItemCommand);
  document.addEventListener("contextmenu", onContextMenuCapture, true);

  console.log(`${LOG} #${TOOLBAR_CONTEXT_MENU_ID}: 'Dissolve group' menuitem installed`);
};

export const teardownTabGroupContextMenu = () => {
  const menu = document.getElementById(TOOLBAR_CONTEXT_MENU_ID);
  if (menu) {
    if (_onMenuShowing) menu.removeEventListener("popupshowing", _onMenuShowing);
    if (_onMenuHidden) menu.removeEventListener("popuphidden", _onMenuHidden);
    menu._zaoDissolveInstalled = false;
    const item = menu.querySelector?.("#zen-tab-wand-dissolve-group");
    const sep = menu.querySelector?.("#zen-tab-wand-dissolve-separator");
    if (item?.isConnected) try { item.remove(); } catch {}
    if (sep?.isConnected) try { sep.remove(); } catch {}
  }
  document.removeEventListener("contextmenu", onContextMenuCapture, true);
  _onMenuShowing = null;
  _onMenuHidden = null;
  _onMenuItemCommand = null;
  _pendingDissolveTargetGroup = null;
};

// On every tab-group creation (including session restore on startup), re-apply the
// rule's color so it survives across browser restarts even if Zen's session storage
// dropped our previously-set color.
// Apply our saved state to a tab-group: re-collapse if its label is in the
// collapsed-set pref, and re-apply its rule color. Used both as the
// TabGroupCreate event handler (for newly-created groups) and at install
// time (for groups Zen restored before our script loaded).
const applyTabGroupRestoreState = (group) => {
  try {
    if (!group?.isConnected) return;
    const label = group.getAttribute?.("label");
    if (!label) return;

    // Restore collapsed state. Deferred so Zen's own group setup finishes
    // before we toggle. Use the property setter, not setAttribute, so
    // Firefox also updates aria-hidden on inner tabs (which the collapse
    // CSS rule relies on).
    const collapsedSet = readCollapsedGroupsPref();
    if (collapsedSet.has(label)) {
      setTimeout(() => {
        if (!group.isConnected) return;
        let applied = false;
        try { group.collapsed = true; applied = true; } catch {}
        if (!applied) {
          try { group.setAttribute("collapsed", ""); } catch {}
          // Property setter wasn't available — manually mark aria-hidden on
          // non-selected tabs so our CSS rule actually hides them.
          for (const tab of group.querySelectorAll("tab")) {
            if (!tab.hasAttribute("selected")) {
              try { tab.setAttribute("aria-hidden", "true"); } catch {}
            }
          }
        }
      }, 0);
    }

    const rules = readRulesPref() || [];
    const rule = rules.find((r) => r.name === label);
    if (rule?.color) {
      // Defer one tick so Zen's own color setup (which runs synchronously
      // during group construction) is done before we override.
      setTimeout(() => {
        if (group.isConnected) applyGroupColor(group, rule.color);
      }, 0);
    }
  } catch (e) {
    console.error(`${LOG} applyTabGroupRestoreState error:`, e);
  }
};

export const setupTabGroupCreateHook = () => {
  if (typeof gBrowser === "undefined" || !gBrowser.tabContainer) return;
  if (gBrowser.tabContainer._zaoTabGroupCreateHook) return;

  const handler = (event) => applyTabGroupRestoreState(event.target);
  gBrowser.tabContainer.addEventListener("TabGroupCreate", handler);
  gBrowser.tabContainer._zaoTabGroupCreateHook = handler;

  // Already-existing tab-groups — session restore likely fired
  // TabGroupCreate BEFORE we installed the listener. Process them now.
  const existing = document.querySelectorAll("tab-group");
  if (existing.length > 0) {
    console.log(`${LOG} TabGroupCreate hook: applying restore state to ${existing.length} pre-existing tab-group(s)`);
    existing.forEach(applyTabGroupRestoreState);
  }
  console.log(`${LOG} TabGroupCreate hook installed`);
};

// Watch every tab-group's `collapsed` attribute and persist the current set
// of collapsed labels to the pref. Re-applied on TabGroupCreate (above) so
// the user's collapse choices survive browser restarts.
export const setupCollapsedStatePersistence = () => {
  if (window._zaoCollapseObserverInstalled) return;
  window._zaoCollapseObserverInstalled = true;

  const persist = (group) => {
    const label = group.getAttribute?.("label");
    if (!label) return;
    const isCollapsed = group.hasAttribute("collapsed");
    const set = readCollapsedGroupsPref();
    const had = set.has(label);
    if (isCollapsed && !had) set.add(label);
    else if (!isCollapsed && had) set.delete(label);
    else return; // no change
    writeCollapsedGroupsPref(set);
  };

  const watch = (group) => {
    if (group._zaoCollapseAttrObs) return;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "collapsed") persist(group);
      }
    });
    obs.observe(group, { attributes: true, attributeFilter: ["collapsed"] });
    group._zaoCollapseAttrObs = obs;
  };

  // Existing tab-groups
  document.querySelectorAll("tab-group").forEach(watch);

  // Future tab-groups (e.g. session restore, user-created via "New Group")
  const containerObs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName?.toLowerCase() === "tab-group") watch(n);
        else n.querySelectorAll?.("tab-group").forEach(watch);
      }
    }
  });
  containerObs.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  console.log(`${LOG} collapsed-state persistence observer installed`);
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
