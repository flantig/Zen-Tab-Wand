// Zen Tab Wand — tab-group manipulation: find/create/dissolve/consolidate,
// color application (named via Zen API; hex via CSS variable overrides), and the
// sort-ungrouped-to-top pass.

import { CONFIG, LOG, TAB_EJECTION_GRACE_MS, isZenColorName, isValidHex } from "./config.mjs";
import { isMinimalStyle } from "./rules.mjs";
import { setTabGroupedHookSuppressed } from "./browser-hooks.mjs";

// Find an existing tab-group with the given label in the given workspace.
// Tries direct attribute match first (which doesn't always work because Zen doesn't
// reliably set zen-workspace-id on the tab-group itself), then falls back to label-only
// + verifying a child tab is in the workspace.
export const findExistingGroup = (name, workspaceId) => {
  if (!name || !workspaceId) return null;
  // Escape backslashes and double-quotes so the name is safe to drop into a CSS
  // attribute selector like `[label="<name>"]`.
  const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    const direct = document.querySelector(
      `tab-group[label="${escapedName}"][zen-workspace-id="${workspaceId}"]`
    );
    if (direct?.isConnected) return direct;

    const candidates = document.querySelectorAll(`tab-group[label="${escapedName}"]`);
    for (const candidate of candidates) {
      if (!candidate.isConnected) continue;
      if (candidate.querySelector(`tab[zen-workspace-id="${workspaceId}"]`)) {
        return candidate;
      }
    }
    return null;
  } catch (e) {
    console.error(`${LOG} findExistingGroup error for "${name}":`, e);
    return null;
  }
};

export const expandIfCollapsed = (groupEl) => {
  if (!groupEl?.isConnected) return;
  if (groupEl.getAttribute("collapsed") === "true") {
    groupEl.setAttribute("collapsed", "false");
    const labelEl = groupEl.querySelector(".tab-group-label");
    if (labelEl) labelEl.setAttribute("aria-expanded", "true");
  }
};

// Apply a color to a Zen tab-group. Two paths:
//   - Named Zen color: use Zen's native `group.color = name` setter so light/dark
//     variants are picked up via --tab-group-color-{name}*.
//   - Hex: override the CSS custom properties directly, deriving lighter "invert"
//     and "pale" variants so the collapsed-state CSS keeps readable contrast.
export const applyGroupColor = (groupEl, color) => {
  if (!groupEl?.isConnected || !color) return;

  if (isZenColorName(color)) {
    try {
      groupEl.style.removeProperty("--tab-group-color");
      groupEl.style.removeProperty("--tab-group-color-invert");
      groupEl.style.removeProperty("--tab-group-color-pale");
      groupEl.style.removeProperty("--tab-group-line-color");
      groupEl.color = color;
      console.log(`${LOG} colored "${groupEl.getAttribute("label")}" → ${color} (named)`);
    } catch (e) {
      console.error(`${LOG} group.color setter failed:`, e);
    }
    return;
  }

  if (isValidHex(color)) {
    try {
      const invert = `color-mix(in srgb, ${color} ${CONFIG.HEX_INVERT_MIX_PERCENT}%, white)`;
      const pale = `color-mix(in srgb, ${color} ${CONFIG.HEX_PALE_MIX_PERCENT}%, white)`;
      groupEl.style.setProperty("--tab-group-color", color, "important");
      groupEl.style.setProperty("--tab-group-color-invert", invert, "important");
      groupEl.style.setProperty("--tab-group-color-pale", pale, "important");
      groupEl.style.setProperty("--tab-group-line-color", color, "important");
      console.log(`${LOG} colored "${groupEl.getAttribute("label")}" → ${color} (hex)`);
    } catch (e) {
      console.error(`${LOG} style.setProperty failed:`, e);
    }
  }
};

// Strip our custom color overrides (used when minimal style is on, or when a rule's
// color is cleared).
export const clearGroupColor = (groupEl) => {
  if (!groupEl?.isConnected) return;
  try {
    groupEl.style.removeProperty("--tab-group-color");
    groupEl.style.removeProperty("--tab-group-color-invert");
    groupEl.style.removeProperty("--tab-group-color-pale");
    groupEl.style.removeProperty("--tab-group-line-color");
  } catch (e) {
    console.error(`${LOG} clearGroupColor failed:`, e);
  }
};

/**
 * Walk every rule-named tab-group and either apply its rule.color or toggle the
 * `.zao-minimal` class (when minimal style pref is on). Catches groups that
 * Pass 1 didn't touch because their tabs were already correctly placed.
 *
 * @param workspaceId — scope to one workspace, or pass null/falsy to walk every
 *                      tab-group across all workspaces (rules are global, so
 *                      pref toggles like minimal-style should sync everywhere).
 * @returns number — count of groups visited (NOT count of mutated; some visits are no-ops).
 */
export const syncAllGroupColors = (workspaceId, rules) => {
  const minimal = isMinimalStyle();
  const colorByName = new Map(rules.filter((r) => r.color).map((r) => [r.name, r.color]));
  const ruleNames = new Set(rules.map((r) => r.name));

  let touched = 0;
  const selector = workspaceId
    ? `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`
    : `tab-group`;
  const groups = document.querySelectorAll(selector);
  for (const groupEl of groups) {
    const label = groupEl.getAttribute("label");
    if (!label || !ruleNames.has(label)) continue;

    if (minimal) {
      groupEl.classList.add("zao-minimal");
      clearGroupColor(groupEl);
    } else {
      groupEl.classList.remove("zao-minimal");
      if (colorByName.has(label)) applyGroupColor(groupEl, colorByName.get(label));
      else clearGroupColor(groupEl);
    }
    touched++;
  }
  return touched;
};

// Eject specific tabs out of whatever group they're in and park them at the top
// of the workspace's tab list. Used for skip-domain matches before Pass 1, so
// those tabs become ungrouped and stay ungrouped for the rest of the pipeline.
// Returns the number of tabs moved.
export const moveTabsToTop = (tabs, workspaceId) => {
  if (!workspaceId || !tabs?.length) {
    console.log(`${LOG} moveTabsToTop: short-circuit — workspaceId=${workspaceId}, tabs=${tabs?.length}`);
    return 0;
  }
  const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
  if (!tabsContainer) {
    console.log(`${LOG} moveTabsToTop: tabsContainer not found on activeWorkspaceElement`);
    return 0;
  }
  // gBrowser.ungroupTab is Firefox's real "remove from group" API (see
  // mozilla-central tabbrowser tabgroup.js). Just reparenting the DOM via
  // insertBefore leaves Zen's tab-group bookkeeping intact — Zen then fires a
  // TabGrouped event asynchronously to re-attach the tab, which both undoes
  // our move AND grows the rule via the auto-add hook (because the async
  // event escapes our synchronous suppression window).
  const ungroupApi = typeof gBrowser?.ungroupTab === "function" ? gBrowser.ungroupTab.bind(gBrowser) : null;
  if (!ungroupApi) {
    console.warn(`${LOG} moveTabsToTop: gBrowser.ungroupTab not available — falling back to DOM-only move (may be silently re-grouped by Zen)`);
  }
  const topAnchor = tabsContainer.firstChild;
  let moved = 0;
  let skipped = 0;
  let ungrouped = 0;
  for (const tab of tabs) {
    if (!tab?.isConnected) { skipped++; continue; }
    try {
      // Tell Zen's grouping system the tab is leaving its group BEFORE we
      // reparent. This emits TabUngrouped (not TabGrouped) so the auto-add
      // hook stays quiet.
      if (ungroupApi && tab.closest("tab-group")) {
        try { ungroupApi(tab); ungrouped++; } catch (e) {
          console.warn(`${LOG} moveTabsToTop: ungroupTab failed for tab, continuing with DOM move:`, e);
        }
      }
      if (topAnchor && topAnchor.isConnected) {
        tabsContainer.insertBefore(tab, topAnchor);
      } else {
        tabsContainer.insertBefore(tab, tabsContainer.firstChild);
      }
      // Mark the tab as recently-ejected so the async TabGrouped event Zen
      // fires shortly after (re-attaching the tab to its old group) is
      // ignored by the auto-add hook. See browser-hooks.mjs.
      tab._zaoEjectedAt = Date.now();
      moved++;
    } catch (e) {
      console.error(`${LOG} moveTabsToTop: failed:`, e);
    }
  }
  if (skipped > 0) console.log(`${LOG} moveTabsToTop: skipped ${skipped} disconnected tab(s)`);
  if (ungrouped > 0) console.log(`${LOG} moveTabsToTop: ungrouped ${ungrouped} tab(s) via gBrowser.ungroupTab before move`);
  return moved;
};

// After Pass 1, push any remaining ungrouped tab in the workspace to the top of the
// workspace's tab list (preserving relative DOM order).
export const moveUngroupedToTop = (workspaceId) => {
  if (!workspaceId) return 0;
  const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
  if (!tabsContainer) return 0;

  const ungrouped = [];
  for (const child of tabsContainer.children) {
    if (child.tagName?.toLowerCase() !== "tab") continue;
    if (
      child.isConnected &&
      child.getAttribute("zen-workspace-id") === workspaceId &&
      !child.pinned &&
      !child.hasAttribute("zen-empty-tab") &&
      !child.hasAttribute("zen-glance-tab") &&
      !child.hasAttribute("zen-essential")
    ) {
      ungrouped.push(child);
    }
  }
  if (ungrouped.length === 0) return 0;

  let cursor = null;
  let moved = 0;
  for (const tab of ungrouped) {
    try {
      if (cursor === null) {
        tabsContainer.insertBefore(tab, tabsContainer.firstChild);
      } else if (cursor.nextSibling) {
        tabsContainer.insertBefore(tab, cursor.nextSibling);
      } else {
        tabsContainer.appendChild(tab);
      }
      cursor = tab;
      moved++;
    } catch (e) {
      console.error(`${LOG} error moving ungrouped tab to top:`, e);
    }
  }
  return moved;
};

/**
 * Move every tab out of any tab-group whose label isn't in the current rule set
 * to the top of the workspace's tab list, then remove the now-empty group.
 * Runs BEFORE Pass 1 so Pass 1 sees clean state and can regroup the freed tabs.
 *
 * @returns {{ dissolved, ungrouped }} where:
 *   dissolved — number of stale groups whose <tab-group> element was removed
 *   ungrouped — number of tabs that were moved out of stale groups (NOT a count of
 *               previously-ungrouped tabs in the workspace)
 */
export const dissolveStaleGroups = (workspaceId, rules) => {
  if (!workspaceId) return { dissolved: 0, ungrouped: 0 };

  const ruleNames = new Set(rules.map((r) => r.name));
  const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
  if (!tabsContainer) {
    console.warn(`${LOG} dissolveStaleGroups: workspace tabsContainer not found`);
    return { dissolved: 0, ungrouped: 0 };
  }

  const groups = document.querySelectorAll(
    `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`
  );

  let dissolved = 0;
  let ungrouped = 0;
  // Snapshot of the workspace's first child BEFORE we start moving tabs in.
  // Inserting before this same anchor on every iteration places the freed tabs
  // at the top of the list in the order we discovered them.
  const topAnchor = tabsContainer.firstChild;

  for (const groupEl of groups) {
    if (!groupEl.isConnected) continue;
    const label = groupEl.getAttribute("label");
    if (!label || ruleNames.has(label)) continue;

    const tabsInGroup = Array.from(
      groupEl.querySelectorAll(`tab[zen-workspace-id="${workspaceId}"]`)
    );

    // Tell Zen the tabs are leaving their group via the real API before
    // DOM-reparenting, so Zen doesn't fire a stale-target TabGrouped after
    // we've ripped the group out (which would race into the auto-add hook).
    const ungroupApi = typeof gBrowser?.ungroupTab === "function" ? gBrowser.ungroupTab.bind(gBrowser) : null;
    for (const tab of tabsInGroup) {
      if (!tab.isConnected) continue;
      try {
        if (ungroupApi) {
          try { ungroupApi(tab); } catch (e) {
            console.warn(`${LOG} dissolveStaleGroups: ungroupTab failed, continuing with DOM move:`, e);
          }
        }
        if (topAnchor && topAnchor.isConnected) {
          tabsContainer.insertBefore(tab, topAnchor);
        } else {
          tabsContainer.insertBefore(tab, tabsContainer.firstChild);
        }
        tab._zaoEjectedAt = Date.now();
        ungrouped++;
      } catch (e) {
        console.error(`${LOG} error ungrouping tab from stale group "${label}":`, e);
      }
    }

    if (groupEl.isConnected && !groupEl.querySelector("tab")) {
      try {
        groupEl.remove();
        dissolved++;
        console.log(`${LOG} dissolved stale group "${label}" (${tabsInGroup.length} tab(s) → top of list)`);
      } catch (e) {
        console.error(`${LOG} error removing stale group "${label}":`, e);
      }
    }
  }

  return { dissolved, ungrouped };
};

/**
 * Remove any tab-group element with zero tabs. Useful after operations that
 * yank tabs out of their groups (Phase 4c "Fresh categories" Arc-Tidy mode
 * is the main caller) — Zen sometimes auto-collapses empties but not always,
 * so this is a defensive cleanup.
 *
 * NOTE: this walks ALL tab-groups in the DOM, not just one workspace — empty
 * groups in other workspaces are equally invalid. workspaceId parameter is
 * accepted only for log consistency with the other dissolve helpers.
 *
 * @returns number — count of group elements removed.
 */
/**
 * Find a DOM-safe `insertBefore` anchor for gBrowser.addTabGroup.
 *
 * Bug context: passing any element that's INSIDE a <tab-group> as
 * `insertBefore` causes Zen to nest the new group inside the existing one
 * (the "subgroups" bug). Even passing the tab-group ELEMENT itself does this
 * — Zen treats `insertBefore: aTabGroup` as "create me INSIDE that group."
 *
 * Workaround: always anchor at the workspace's tabsContainer.firstChild,
 * which is guaranteed to be at workspace top-level (sibling of all groups,
 * not inside any). New groups thus appear at the top of the workspace —
 * an acceptable tradeoff vs the alternative of broken nested groups.
 *
 * The `tab` parameter is ignored in the current implementation but retained
 * for API compatibility with callers that pass `tabs[0]` for documentation.
 *
 * @returns {Element|null}
 */
export const findSafeInsertAnchor = () => {
  const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
  return tabsContainer?.firstChild || null;
};

export const dissolveEmptyGroups = () => {
  let removed = 0;
  for (const groupEl of document.querySelectorAll("tab-group")) {
    if (!groupEl.isConnected) continue;
    if (groupEl.querySelector("tab")) continue;
    const label = groupEl.getAttribute("label") || "(unnamed)";
    try {
      groupEl.remove();
      removed++;
      console.log(`${LOG} dissolved empty group "${label}"`);
    } catch (e) {
      console.error(`${LOG} error removing empty group "${label}":`, e);
    }
  }
  return removed;
};

/**
 * Merge tab-groups in the current workspace that share a label.
 * First DOM-order occurrence is the "canonical" winner; tabs from later duplicates
 * move into it, then the empty duplicate is removed.
 *
 * @returns {{ mergedLabels, tabsMoved }} where:
 *   mergedLabels — number of labels that had duplicates (count of dedupe operations)
 *   tabsMoved    — total tabs migrated from duplicates into their canonical group
 */
export const consolidateDuplicateGroups = (workspaceId) => {
  if (!workspaceId) return { mergedLabels: 0, tabsMoved: 0 };

  const groups = document.querySelectorAll(
    `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`
  );

  const byLabel = new Map();
  for (const groupEl of groups) {
    if (!groupEl.isConnected) continue;
    const label = groupEl.getAttribute("label");
    if (!label) continue;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(groupEl);
  }

  let mergedLabels = 0;
  let totalTabsMoved = 0;

  // Suppress the TabGrouped auto-add hook — these are programmatic dedupe
  // moves, not user-initiated grouping, and we don't want them growing rules.
  setTabGroupedHookSuppressed(true);
  try {
    for (const [label, groupEls] of byLabel) {
      if (groupEls.length < 2) continue;

      const canonical = groupEls[0];
      expandIfCollapsed(canonical);
      let movedThisLabel = 0;

      for (let i = 1; i < groupEls.length; i++) {
        const dup = groupEls[i];
        if (!dup.isConnected) continue;

        const dupTabs = Array.from(
          dup.querySelectorAll(`tab[zen-workspace-id="${workspaceId}"]`)
        );
        for (const tab of dupTabs) {
          if (!tab.isConnected) continue;
          try {
            gBrowser.moveTabToExistingGroup(tab, canonical);
            movedThisLabel++;
          } catch (e) {
            console.error(`${LOG} error merging tab into "${label}":`, e);
          }
        }

        if (dup.isConnected && !dup.querySelector("tab")) {
          try { dup.remove(); } catch (e) {
            console.error(`${LOG} error removing empty duplicate "${label}":`, e);
          }
        }
      }

      mergedLabels++;
      totalTabsMoved += movedThisLabel;
      console.log(`${LOG} consolidated ${groupEls.length} "${label}" groups → 1 (moved ${movedThisLabel} tab(s))`);
    }
  } finally {
    setTabGroupedHookSuppressed(false);
  }

  return { mergedLabels, tabsMoved: totalTabsMoved };
};
