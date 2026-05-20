// Zen Tab Wand — browser-context event hooks for Zen's native tab-group actions.
//
// Two DOM hooks installed on `gBrowser.tabContainer`:
//   TabGrouped       — auto-add the tab's hostname to a matching rule, or create a
//                       new rule (handling the "New Group" naming flow).
//   TabGroupCreate   — re-apply rule colors when Zen restores groups on startup.
// Plus one pref observer:
//   minimal-style    — re-run syncAllGroupColors immediately when the user toggles
//                       the pref, so the change shows up without needing a tidy-click.
//
// On the DOM hooks we stash the installed handler back onto `tabContainer` as a
// `_zaoXxxHook` expando. This prevents double-install if the entry script is
// re-evaluated (e.g. across module reloads during development).

import { CONFIG, LOG, BUILD_VERSION, TAB_EJECTION_GRACE_MS, isZenColorName, isUnsetLabel } from "./config.mjs";
import { getTabUrl, getHostname } from "./tabs.mjs";
import { readRulesPref, writeRulesPref, isMinimalStyle } from "./rules.mjs";
import { applyGroupColor, syncAllGroupColors } from "./groups.mjs";

// Counter-based suppression. Any module about to do programmatic tab grouping /
// moving / ungrouping should pushTabGroupedHookSuppression() before the work
// and popTabGroupedHookSuppression() in a finally. Counter (vs boolean) lets
// suppressions nest — e.g. handleOrganizeClick suppresses the whole click AND
// applyPass1 / applyPass2 also suppress their inner work; the outer suppression
// stays effective when the inner one pops.
let _suppressionCount = 0;
export const pushTabGroupedHookSuppression = () => {
  _suppressionCount++;
};
export const popTabGroupedHookSuppression = () => {
  _suppressionCount = Math.max(0, _suppressionCount - 1);
};
// Legacy boolean-style API kept temporarily for any callers that haven't
// migrated. `true` ≈ push, `false` ≈ pop. New code should use push/pop.
export const setTabGroupedHookSuppressed = (val) => {
  if (val) pushTabGroupedHookSuppression();
  else popTabGroupedHookSuppression();
};
const isHookSuppressed = () => _suppressionCount > 0;

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
      console.log(`${LOG} TabGrouped: "${hostname}" already in "${groupName}"`);
      return;
    }
    rule.domains.push(hostname);
    writeRulesPref(rules);
    console.log(`${LOG} TabGrouped: added "${hostname}" to existing rule "${groupName}"`);
  } else {
    const newRule = { name: groupName, domains: [hostname] };
    const groupColor = group?.color;
    if (isZenColorName(groupColor)) newRule.color = groupColor;
    rules.push(newRule);
    writeRulesPref(rules);
    console.log(
      `${LOG} TabGrouped: created new rule "${groupName}" with "${hostname}"` +
        (newRule.color ? ` (color: ${newRule.color})` : "")
    );
  }
};

// Zen's "Create tab group" modal sets `group.label` on every keystroke AND fires
// TabGroupUpdate on every color swatch click. We can't commit on those events —
// they fire while the user is still composing. Wait for the modal to actually close.
//
// We listen for `popuphidden` on the document (any popup close). This unifies all the
// modal-dismiss paths: Done button, Escape, click-outside, etc. — vs `TabGroupCreateDone`
// which only fires from the Done path. Group state (label set + still connected) gates
// the commit, so unrelated popup closes are harmless.
//
// The setTimeout(0) defer is critical for the color: the swatch radio's `change` event
// updates `group.color` synchronously, but the user can pick a color and click outside
// in the same gesture. The microtask defer ensures any pending change handler has
// committed `group.color` before we read it.
//
// If the modal is never resolved (user closes the page mid-edit) we abandon after
// NEW_GROUP_ABANDON_MS so the document listener doesn't leak forever.
const NEW_GROUP_ABANDON_MS = 5 * 60 * 1000;

const waitForGroupName = (tab, group) => {
  let applied = false;

  const cleanup = () => {
    document.removeEventListener("popuphidden", onPopupHidden);
    clearTimeout(abandonTimer);
  };

  const tryCommit = () => {
    if (applied) return;
    if (!group.isConnected) { cleanup(); return; }
    const lbl = group.getAttribute("label");
    // If label is still the placeholder, the popup that closed wasn't the one we're
    // waiting on (or the user dismissed the modal without naming). Stay subscribed —
    // either the abandon timer fires, or the group is removed (cancel path).
    if (isUnsetLabel(lbl)) return;
    applied = true;
    cleanup();
    console.log(`${LOG} TabGrouped: committing on modal close, label="${lbl}", color="${group?.color ?? "(none)"}"`);
    applyToRule(tab, lbl, group);
  };

  const onPopupHidden = () => {
    // Defer one tick so Zen's swatch-change handler has time to flush the user's
    // color pick into group.color before applyToRule reads it.
    setTimeout(tryCommit, 0);
  };

  const abandonTimer = setTimeout(() => {
    if (applied) return;
    console.log(`${LOG} TabGrouped: abandoning "New Group" wait after ${NEW_GROUP_ABANDON_MS / 1000}s`);
    cleanup();
  }, NEW_GROUP_ABANDON_MS);

  document.addEventListener("popuphidden", onPopupHidden);
};

// ─── Setup ───────────────────────────────────────────────────────────────────

export const setupTabGroupedHook = () => {
  if (typeof gBrowser === "undefined" || !gBrowser.tabContainer) return;
  if (gBrowser.tabContainer._zaoTabGroupedHook) return;

  const handler = (event) => {
    const group = event.target;
    const tab = event.detail;
    const groupLabel = group?.getAttribute?.("label") ?? "(no-label)";
    const hostname = tab ? (() => { try { return getHostname(getTabUrl(tab)); } catch { return "(err)"; } })() : "(no-tab)";
    if (isHookSuppressed()) {
      console.log(`${LOG} TabGrouped: SUPPRESSED (suppressionCount=${_suppressionCount}) for "${hostname}" → "${groupLabel}"`);
      return;
    }
    // Recently-ejected guard: Zen fires a stale TabGrouped to re-attach a
    // tab seconds after we ejected it (asynchronously, outside our
    // suppression window). Skip those — that's Zen restoring state we
    // intentionally undid, not a real user action.
    const ejectedAt = tab?._zaoEjectedAt;
    if (ejectedAt && (Date.now() - ejectedAt) < TAB_EJECTION_GRACE_MS) {
      const age = Date.now() - ejectedAt;
      console.log(`${LOG} TabGrouped: IGNORED — "${hostname}" was ejected ${age}ms ago; Zen is re-attaching it to "${groupLabel}", rule will NOT grow`);
      // Clear the marker so a genuine user grouping later still works.
      delete tab._zaoEjectedAt;
      return;
    }
    console.log(`${LOG} TabGrouped: FIRED (unsuppressed) for "${hostname}" → "${groupLabel}"`);
    try {
      // TabGrouped is dispatched on the tab-group element with the tab in
      // event.detail (see tab.js #updateOnTabGrouped in the Zen source).
      // event.target is the GROUP, NOT the tab — known Zen quirk.
      if (!tab?.isConnected || !group) return;

      const groupName = group.getAttribute?.("label");
      if (!isUnsetLabel(groupName)) {
        // Picked an existing group (or created one with an immediate label).
        applyToRule(tab, groupName, group);
        return;
      }

      // "New Group" flow: name is pending while the modal is open.
      console.log(`${LOG} TabGrouped: waiting for "New Group" to be named...`);
      waitForGroupName(tab, group);
    } catch (e) {
      console.error(`${LOG} TabGrouped handler error:`, e);
    }
  };

  gBrowser.tabContainer.addEventListener("TabGrouped", handler);
  gBrowser.tabContainer._zaoTabGroupedHook = handler;
  console.log(`${LOG} TabGrouped hook installed`);
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
