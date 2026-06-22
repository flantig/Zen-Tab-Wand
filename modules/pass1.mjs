// Zen Tab Wand — Pass 1: deterministic domain → group matching.
// Pure logic over rules + tab info; applyPass1 mutates the DOM via gBrowser APIs.

import { LOG } from "./config.mjs";
import { findExistingGroup, expandIfCollapsed, collapseGroup, applyGroupAppearance, findSafeInsertAnchor } from "./groups.mjs";
import { getMatchMode } from "./rules.mjs";

// Match a hostname against a single rule-domain pattern.
//   "host.com"    matches the bare host AND any subdomain
//   "*.host.com"  matches subdomains only (NOT the bare host)
export const matchesDomain = (hostname, pattern) => {
  if (!hostname || !pattern) return false;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return hostname.endsWith("." + base);
  }
  return hostname === pattern || hostname.endsWith("." + pattern);
};

export const matchesTitle = (title, term) => {
  if (!title || !term) return false;
  return title.toLocaleLowerCase().includes(term.toLocaleLowerCase());
};

const ruleMatchesDomain = (tabInfo, rule) =>
  (rule.domains || []).some((d) => matchesDomain(tabInfo.hostname, d));

const ruleMatchesTitle = (tabInfo, rule) =>
  (rule.titleTerms || []).some((t) => matchesTitle(tabInfo.title, t));

const findByDomain = (tabInfo, rules) => {
  for (const rule of rules) {
    if (ruleMatchesDomain(tabInfo, rule)) return rule.name;
  }
  return null;
};

const findByTitle = (tabInfo, rules) => {
  for (const rule of rules) {
    if (ruleMatchesTitle(tabInfo, rule)) return rule.name;
  }
  return null;
};

// First-match-wins within the active match source. Global mode decides whether
// URL or title terms are considered, and which source gets first crack.
export const findGroupForTab = (tabInfo, rules) => {
  const mode = getMatchMode();
  if (mode === "url-only") return findByDomain(tabInfo, rules);
  if (mode === "title-only") return findByTitle(tabInfo, rules);
  if (mode === "title-then-url") {
    return findByTitle(tabInfo, rules) || findByDomain(tabInfo, rules);
  }
  return findByDomain(tabInfo, rules) || findByTitle(tabInfo, rules);
};

/**
 * Plan what to do with each eligible tab based on the current rules. PURE — no DOM
 * mutation. `applyPass1` consumes the byGroup bucket to actually move tabs.
 *
 * @param {Array} tabs   — output of `getEligibleTabs().tabs`
 * @param {Array} rules  — output of `loadRules()`
 * @returns {{
 *   assignments,    // tabs with .group set (target rule name) or null
 *   byGroup,        // Map<groupName, items[]> — tabs to MOVE into the named group
 *   unmatched,      // items[] — no rule matches; left wherever they are
 *   alreadyCorrect, // items[] — matched and already in the right group; no-op
 * }}
 */
export const runPass1 = (tabs, rules) => {
  const assignments = tabs.map((t) => ({ ...t, group: findGroupForTab(t, rules) }));
  const byGroup = new Map();
  const unmatched = [];
  const alreadyCorrect = [];
  for (const a of assignments) {
    if (!a.group) {
      unmatched.push(a);
    } else if (a.group === a.currentGroup) {
      alreadyCorrect.push(a);
    } else {
      if (!byGroup.has(a.group)) byGroup.set(a.group, []);
      byGroup.get(a.group).push(a);
    }
  }
  return { assignments, byGroup, unmatched, alreadyCorrect };
};

/**
 * Execute the moves planned by `runPass1`. Creates new tab-groups when needed,
 * reuses existing ones, and applies per-rule colors after placement.
 *
 * @returns {{ movedToExisting, createdGroups, movedToNew, errors[] }} counts + per-group error messages.
 */
export const applyPass1 = (byGroup, workspaceId, rules) => {
  let movedToExisting = 0;
  let createdGroups = 0;
  let movedToNew = 0;
  const errors = [];

  const ruleByName = new Map(rules.map((r) => [r.name, r]));

  for (const [groupName, items] of byGroup) {
    // Resolve each item's tab info to its live DOM node (`_tab`) and re-check the
    // current group from the DOM. We re-check (rather than trusting the `currentGroup`
    // field set by runPass1) because the DOM may have changed between planning and
    // applying — e.g. the user dragged a tab, or the consolidate/dissolve passes ran.
    const tabsForGroup = items
      .map((item) => item._tab)
      .filter((t) => {
        if (!t?.isConnected) return false;
        const currentGroupName = t.closest("tab-group")?.getAttribute("label");
        return currentGroupName !== groupName;
      });

    if (tabsForGroup.length === 0) continue;

    const existing = findExistingGroup(groupName, workspaceId);

    if (existing?.isConnected) {
      console.log(`${LOG} reusing existing group "${groupName}" (${tabsForGroup.length} tab(s) to move in)`);
      try {
        // Remember if the group was collapsed BEFORE we touched it. If so,
        // we re-collapse after adding the new tabs so the user's collapse
        // state isn't lost AND the new tabs get properly aria-hidden'd
        // via the property setter on collapse.
        const wasCollapsed = expandIfCollapsed(existing);
        for (const tab of tabsForGroup) {
          if (!tab.isConnected) continue;
          if (tab.closest("tab-group") === existing) continue;
          gBrowser.moveTabToExistingGroup(tab, existing);
          movedToExisting++;
        }
        if (ruleByName.has(groupName)) applyGroupAppearance(existing, ruleByName.get(groupName));
        if (wasCollapsed) {
          // Defer one tick so Firefox's tab-insertion bookkeeping completes
          // before we collapse — otherwise the new tab's aria-hidden may
          // not be set in the same paint.
          const groupRef = existing;
          setTimeout(() => collapseGroup(groupRef), 0);
        }
      } catch (e) {
        console.error(`${LOG} error moving tabs into "${groupName}":`, e);
        errors.push({ group: groupName, error: e.message });
      }
    } else {
      console.log(`${LOG} creating new group "${groupName}" (${tabsForGroup.length} tab(s))`);
      try {
        const newGroup = gBrowser.addTabGroup(tabsForGroup, {
          label: groupName,
          // Anchor at a DOM position OUTSIDE any enclosing tab-group; otherwise
          // Zen creates the new group as a child of the old one (nesting bug).
          insertBefore: findSafeInsertAnchor(),
        });
        if (newGroup) {
          createdGroups++;
          movedToNew += tabsForGroup.length;
          if (ruleByName.has(groupName)) applyGroupAppearance(newGroup, ruleByName.get(groupName));
        } else {
          console.warn(`${LOG} addTabGroup returned no element for "${groupName}"`);
          errors.push({ group: groupName, error: "addTabGroup returned null" });
        }
      } catch (e) {
        console.error(`${LOG} error creating group "${groupName}":`, e);
        errors.push({ group: groupName, error: e.message });
      }
    }
  }

  return { movedToExisting, createdGroups, movedToNew, errors };
};
