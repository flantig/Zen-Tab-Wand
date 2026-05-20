// Zen Tab Wand — tidy-button click orchestrator.
// Sequences: wiggle → consolidate → load rules → dissolve stale → enumerate tabs
//            → Pass 1 → apply → ungrouped-to-top → sync colors.

import { CONFIG, LOG, BUILD_VERSION } from "./config.mjs";
// CONFIG also exposes the pref name we read inside the AI gate diagnostic below.
import { loadRules, readSkipDomainsPref, isMinimalStyle, isStrictRulesEnforced, getAIEngine, getOllamaHost, getOllamaModel, getAINewGroupBehavior, getAIExistingBehavior } from "./rules.mjs";
import { getEligibleTabs } from "./tabs.mjs";
import {
  consolidateDuplicateGroups,
  dissolveStaleGroups,
  dissolveEmptyGroups,
  moveTabsToTop,
  moveUngroupedToTop,
  syncAllGroupColors,
} from "./groups.mjs";
import { runPass1, applyPass1, matchesDomain } from "./pass1.mjs";
import { runPass2, applyPass2 } from "./ai.mjs";
import { checkOllamaReady, reportOllamaError, normalizeOllamaHost, runPass2Ollama, runPass2OllamaFresh, classifyExistingGroupsBatch } from "./ollama.mjs";
import { showPreviewModal } from "./preview-modal.mjs";
import { pushTabGroupedHookSuppression, popTabGroupedHookSuppression } from "./browser-hooks.mjs";

// Module-version stamp so we can confirm the latest copy is loaded in the running window.
// If you don't see this in the Browser Console after restart, ES module cache is stale.
console.log(`${LOG} click-handler.mjs loaded — build ${BUILD_VERSION}`);

const getTidyButton = () =>
  window.gZenWorkspaces?.activeWorkspaceElement?.querySelector(`#${CONFIG.BUTTON_ID}`) || null;

const wiggleButton = () => {
  try {
    const button = getTidyButton();
    if (!button) return;
    button.classList.remove("zao-wiggling");
    // Reading offsetWidth forces a synchronous layout flush. This is the standard
    // "restart a CSS animation" trick: without it, removing and immediately
    // re-adding the class is collapsed into one no-op by the browser, so rapid
    // re-clicks wouldn't see the animation play again.
    void button.offsetWidth;
    button.classList.add("zao-wiggling");
    setTimeout(() => {
      if (button.isConnected) button.classList.remove("zao-wiggling");
    }, CONFIG.WIGGLE_DURATION_MS);
  } catch (e) {
    console.error(`${LOG} wiggle error:`, e);
  }
};

// Mark the tidy button as "AI thinking" — applied when Pass 2 starts, removed
// when it finishes (success or failure). CSS animates a subtle pulse so the
// user knows the click is still in flight without a blocking modal.
const setButtonThinking = (thinking) => {
  try {
    const button = getTidyButton();
    if (!button) return;
    button.classList.toggle("zao-thinking", !!thinking);
  } catch (e) {
    console.error(`${LOG} setButtonThinking error:`, e);
  }
};

// Convert (currentGroup, targetGroup) into a single-word description of what
// Pass 1 will do for this tab. Used for the diagnostic table only.
const actionFor = (currentGroup, targetGroup) => {
  if (!targetGroup) return "leave";        // no rule matched
  if (targetGroup === currentGroup) return "stay";
  if (currentGroup) return "move";          // tab is in a different group
  return "group";                           // tab is currently ungrouped
};

export const handleOrganizeClick = async () => {
  wiggleButton();

  const workspaceId = window.gZenWorkspaces?.activeWorkspace;
  if (!workspaceId) {
    console.warn(`${LOG} no active workspace`);
    return;
  }

  // Suppress the TabGrouped auto-add hook for the ENTIRE click. Any programmatic
  // tab movement that happens during the click (Pass 1 moves, dedupe, strict-mode
  // ejection, skip-domain parking, AI Pass 2, etc.) should be invisible to the
  // hook — only USER-initiated grouping (drags, "Add to Group" menu) should grow
  // rules. The push/pop counter survives nested suppressions inside applyPass1 /
  // applyPass2 / consolidateDuplicateGroups.
  pushTabGroupedHookSuppression();
  console.log(`${LOG} click START — build ${BUILD_VERSION} — suppression pushed`);
  try {

  // 1. Merge any duplicate-name groups before lookups assume uniqueness.
  const consolidation = consolidateDuplicateGroups(workspaceId);
  if (consolidation.mergedLabels > 0) {
    console.log(`${LOG} pre-pass consolidation: merged ${consolidation.mergedLabels} duplicate label(s), moved ${consolidation.tabsMoved} tab(s)`);
  }

  // 2. Load rules BEFORE the stale-group sweep so we know which group names are valid.
  const rules = await loadRules();

  // 3. Dissolve groups whose names don't match any current rule.
  const dissolution = dissolveStaleGroups(workspaceId, rules);
  if (dissolution.dissolved > 0) {
    console.log(`${LOG} dissolved ${dissolution.dissolved} stale group(s), ungrouped ${dissolution.ungrouped} tab(s)`);
  }

  // 4. Enumerate eligible tabs (post-dissolution state).
  const allTabs = getEligibleTabs().tabs;
  if (allTabs.length === 0) {
    console.log(`${LOG} no eligible tabs in workspace ${workspaceId}`);
    return;
  }

  // 4b. Handle skip-domains. Tabs whose hostname matches any skip pattern get
  // ejected from any current group and parked at the top of the workspace,
  // then excluded from the rest of the pipeline (Pass 1 + Pass 2). The skip
  // list is authoritative — re-applied on every click, so manually moving a
  // skipped tab into a group is reverted on the next tidy.
  const skipPatterns = readSkipDomainsPref();
  let tabs = allTabs;
  if (skipPatterns.length > 0) {
    const skipped = allTabs.filter((t) =>
      skipPatterns.some((p) => matchesDomain(t.hostname, p))
    );
    if (skipped.length > 0) {
      const moved = moveTabsToTop(skipped.map((s) => s._tab), workspaceId);
      console.log(`${LOG} skip-domains: parked ${moved} tab(s) at the top of the workspace`);
      const skippedSet = new Set(skipped);
      tabs = allTabs.filter((t) => !skippedSet.has(t));
    }
  }
  if (tabs.length === 0) {
    console.log(`${LOG} no non-skipped eligible tabs in workspace ${workspaceId}`);
    return;
  }

  // 5. Pass 1 matching + diagnostic logging.
  const { assignments, byGroup, unmatched, alreadyCorrect } = runPass1(tabs, rules);

  // Always-visible diagnostic (outside the collapsed group below) so we can see
  // the AI gate decision regardless of console group expansion state.
  const aiEngine = getAIEngine();
  const newGroupBehavior = aiEngine === "ollama" ? getAINewGroupBehavior() : "";
  const isFreshMode = newGroupBehavior === "fresh-categories";
  const isIdentifyOnly = newGroupBehavior === "identify-only";
  // Both fresh and identify-only reclassify ALL tabs and bypass Pass 1's apply.
  // Identify-only also gates the apply step on user confirmation via modal.
  const isFreshLike = isFreshMode || isIdentifyOnly;
  console.log(`${LOG} AI gate (pre-pass): engine=${aiEngine}${newGroupBehavior ? `, new-group=${newGroupBehavior}` : ""}, unmatched=${unmatched.length}`);

  // Wrapped in try/finally so console.groupEnd always runs even if a later step
  // throws — otherwise the next click's logs would nest inside this group.
  console.groupCollapsed(
    `${LOG} Pass 1 — ${tabs.length} tabs · ${alreadyCorrect.length} already correct · ${byGroup.size} group(s) to update · ${unmatched.length} unmatched`
  );
  try {
    console.log("Per-tab assignments:");
    console.table(
      assignments.map(({ id, hostname, title, currentGroup, group }) => ({
        id,
        hostname,
        from: currentGroup || "—",
        to: group || "—",
        action: actionFor(currentGroup, group),
        title,
      }))
    );

    if (byGroup.size > 0) {
      console.log("Pending moves by group:");
      console.table(
        Array.from(byGroup.entries()).map(([name, items]) => ({
          target: name,
          count: items.length,
          from: items.map((t) => t.currentGroup || "—").join(", "),
          hosts: items.map((t) => t.hostname).join(", "),
        }))
      );
    }

    if (unmatched.length > 0) {
      console.log(`${unmatched.length} unmatched tab(s) — left in place:`);
      console.table(
        unmatched.map(({ id, hostname, title, currentGroup }) => ({
          id,
          hostname,
          currentGroup: currentGroup || "—",
          title,
        }))
      );
    }

    // 6. Apply Pass 1 moves — UNLESS we're in a fresh-like mode, where AI
    // is about to re-tidy everything (and identify-only may even cancel).
    if (!isFreshLike) {
      const result = applyPass1(byGroup, workspaceId, rules);
      console.log(`${LOG} Applied: created ${result.createdGroups} new group(s), moved ${result.movedToNew} tab(s) into new groups, ${result.movedToExisting} tab(s) into existing groups.`);
      if (result.errors.length > 0) {
        console.warn(`${LOG} ${result.errors.length} error(s) during apply:`, result.errors);
      }

      // 6b. Strict rule enforcement (opt-in via Look & Feel toggle). After
      // Pass 1's moves, eject any unmatched tab that's still parked inside a
      // group — e.g. a `photos.google.com` tab that's inside "Google Utils"
      // but isn't in that rule's `domains[]`. Ejected tabs go to the top of
      // the workspace; if AI Pass 2 runs next, it gets a crack at re-placing
      // them. Strict mode never fires in fresh/identify-only modes — those
      // bypass Pass 1 entirely.
      const strictOn = isStrictRulesEnforced();
      console.log(`${LOG} Strict: pref=${strictOn}, unmatched-total=${unmatched.length}`);
      if (strictOn) {
        const candidatesInGroups = unmatched.filter((t) => t.currentGroup);
        const candidatesConnected = candidatesInGroups.filter((t) => t._tab?.isConnected);
        console.log(`${LOG} Strict: candidates in groups=${candidatesInGroups.length}, connected=${candidatesConnected.length}`);
        if (candidatesInGroups.length > 0) {
          console.table(candidatesInGroups.map((t) => ({
            hostname: t.hostname,
            currentGroup: t.currentGroup,
            tabConnected: !!t._tab?.isConnected,
            tabHasParent: !!t._tab?.parentElement,
            closestGroupLabel: t._tab?.closest?.("tab-group")?.getAttribute?.("label") ?? "(none)",
          })));
        }
        if (candidatesConnected.length > 0) {
          const ejected = moveTabsToTop(candidatesConnected.map((t) => t._tab), workspaceId);
          console.log(`${LOG} Strict: ejected ${ejected} of ${candidatesConnected.length} candidate(s) from rule groups`);
          if (ejected > 0) {
            // The unmatched array's items now have currentGroup === null
            // (their on-DOM state changed). Update the planning shape so
            // downstream Pass 2 / diagnostics see the new reality.
            for (const t of candidatesConnected) t.currentGroup = null;
          }
        } else if (candidatesInGroups.length === 0) {
          console.log(`${LOG} Strict: no candidates — every unmatched tab is already ungrouped`);
        }
      }
    } else {
      console.log(`${LOG} Pass 1 apply skipped — ${newGroupBehavior} mode will ${isIdentifyOnly ? "preview" : "reclassify"} all ${tabs.length} tab(s)`);
    }

    // 7. Pass 2 (AI). Fresh-like modes run even when unmatched is empty — they
    // see ALL tabs and may re-cluster rule-matched ones. Other modes only fire
    // when there's something Pass 1 couldn't place.
    const shouldRunPass2 = aiEngine !== "off" && (isFreshLike ? tabs.length > 0 : unmatched.length > 0);
    if (shouldRunPass2) {
      const inputCount = isFreshLike ? tabs.length : unmatched.length;
      const inputLabel = isFreshLike ? "ALL eligible tab(s)" : "unmatched tab(s)";
      const modeSuffix = isIdentifyOnly ? " (identify-only)" : isFreshMode ? " (fresh-categories)" : "";
      console.log(`${LOG} Pass 2 — running ${aiEngine}${modeSuffix} AI over ${inputCount} ${inputLabel}...`);
      // Visual feedback on the toolbar wand while AI thinks (can be several
      // seconds, especially on cold start). Cleared in the finally below
      // regardless of success/failure/modal-cancellation.
      setButtonThinking(true);
      try {
        let pass2;
        if (aiEngine === "ollama") {
          const host = getOllamaHost();
          const model = getOllamaModel();
          const status = await checkOllamaReady(host, model);
          if (!status.reachable || !status.modelAvailable) {
            reportOllamaError(host, model, status);
            pass2 = { assignedToExisting: [], newGroups: [], skipped: isFreshMode ? tabs : unmatched };
          } else {
            console.log(`${LOG} Ollama ready at ${normalizeOllamaHost(host)} (model: ${model})`);
            const t0 = performance.now();
            if (isFreshLike) {
              pass2 = await runPass2OllamaFresh(tabs);
            } else {
              pass2 = await runPass2Ollama(unmatched, rules);
            }
            console.log(`${LOG} Ollama Pass 2 took ${Math.round(performance.now() - t0)}ms`);
          }
        } else {
          // Local engine — never runs in fresh mode; that's Ollama-only.
          pass2 = await runPass2(unmatched, rules, workspaceId);
        }
        if (pass2.assignedToExisting.length > 0 || pass2.newGroups.length > 0) {
          console.log(`${LOG} Pass 2 plan: ${pass2.assignedToExisting.length} to existing group(s), ${pass2.newGroups.length} new group(s), ${pass2.skipped.length} skipped`);
          if (pass2.assignedToExisting.length > 0) {
            console.table(pass2.assignedToExisting.map((a) => ({
              hostname: a.tabInfo.hostname,
              "→ existing group": a.groupName,
              similarity: a.similarity.toFixed(3),
            })));
          }
          if (pass2.newGroups.length > 0) {
            console.table(pass2.newGroups.map((g) => ({
              "new group": g.name,
              tabs: g.tabs.map((t) => t.hostname).join(", "),
            })));
          }

          // Decide whether to show the Plan Mode modal:
          //   - Plan Mode (identify-only) → always show (it IS the modal mode)
          //   - Auto-add / Always-add → show so user can veto rule mutations
          //     before they hit the rules table
          //   - Transient (either) → no modal (it's just a temp move per user)
          //   - Prompt → no modal (Zen handles per-group via its own edit modal)
          //   - Fresh-categories → no modal (no rule mutations happen here)
          let planToApply = pass2;
          let showModal = false;
          let modalReason = "";
          if (aiEngine === "ollama") {
            if (isIdentifyOnly) {
              showModal = true;
              modalReason = "Plan Mode";
            } else if (!isFreshMode && newGroupBehavior !== "prompt") {
              const existingBehavior = getAIExistingBehavior();
              const flags = [];
              if (existingBehavior === "always-add") flags.push("always-add");
              if (newGroupBehavior === "auto-add") flags.push("auto-add");
              if (flags.length > 0) {
                showModal = true;
                modalReason = flags.join(" + ");
              }
            }
          }

          if (showModal) {
            console.log(`${LOG} Plan Mode modal opening (${modalReason}) — user must confirm before rules mutate`);
            planToApply = await showPreviewModal({
              plan: pass2,
              // "Re-assign to new" — open-ended clustering for pending tabs.
              // Always uses the fresh classifier so the model isn't biased
              // by existing-rule context (the user explicitly wants NEW).
              onReassignToNew: async (pendingTabs) => {
                const r = await runPass2OllamaFresh(pendingTabs);
                return { newGroups: r.newGroups, skipped: r.skipped };
              },
              // "Re-assign to planned" — constrained-vocabulary classification.
              // Treats each kept bucket (new group or existing-target) as a
              // fake rule whose domains are its tabs' hostnames, then runs
              // Phase-3-style classification into one of those names.
              onAssignToPlanned: async (pendingTabs, keptBuckets) => {
                const host = getOllamaHost();
                const model = getOllamaModel();
                const fakeRules = keptBuckets.map((g) => ({
                  name: g.name,
                  domains: [...new Set(g.tabs.map((t) => t.hostname).filter((h) => h))],
                }));
                const assignmentMap = await classifyExistingGroupsBatch(pendingTabs, fakeRules, host, model);
                const assignments = [];
                const skipped = [];
                for (let i = 0; i < pendingTabs.length; i++) {
                  const groupName = assignmentMap.get(i);
                  if (groupName) assignments.push({ tabInfo: pendingTabs[i], groupName });
                  else skipped.push(pendingTabs[i]);
                }
                return { assignments, skipped };
              },
              // "Re-assign to existing" — classifies pending tabs against the
              // user's full rules table, regardless of what's currently kept
              // in the modal. Lets the user route a tab into any rule-named
              // group (e.g., "Dev") that the AI didn't propose this run. The
              // callback is only provided when rules actually exist — modal
              // disables the button when undefined.
              onAssignToExisting: rules.length > 0 ? async (pendingTabs) => {
                const host = getOllamaHost();
                const model = getOllamaModel();
                const assignmentMap = await classifyExistingGroupsBatch(pendingTabs, rules, host, model);
                const assignments = [];
                const skipped = [];
                for (let i = 0; i < pendingTabs.length; i++) {
                  const groupName = assignmentMap.get(i);
                  if (groupName) assignments.push({ tabInfo: pendingTabs[i], groupName });
                  else skipped.push(pendingTabs[i]);
                }
                return { assignments, skipped };
              } : undefined,
            });
            if (planToApply === null) {
              console.log(`${LOG} ${modalReason}: user cancelled — no changes applied`);
            }
          }

          if (planToApply) {
            const ai = applyPass2(planToApply, workspaceId, rules);
            console.log(`${LOG} Pass 2 applied: ${ai.movedToExisting} tab(s) → existing groups, ${ai.newGroupsCreated} new group(s), ${ai.rulesGrown} rule(s) grown, ${ai.newRulesCreated} new rule(s)`);
            // Use the filtered plan's skipped list for the post-apply cleanup
            // (in Plan Mode, this includes tabs from un-kept groups, which
            // should also get ungrouped from their pre-tidy containers).
            pass2 = planToApply;

            // Fresh-like cleanup: AI's contract is "re-org everything", but
            // applyPass2 only moves tabs AI explicitly placed. Skipped tabs
            // (singletons dropped, "skipped" picks) would stay in their pre-tidy
            // groups, leaving e.g. Google Utils alive just to hold one orphan.
            // Yank them out to workspace top, then dissolveEmptyGroups can
            // remove the newly-emptied containers.
            if (isFreshLike) {
              const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
              if (tabsContainer) {
                let movedSkipped = 0;
                for (const tabInfo of pass2.skipped) {
                  const tab = tabInfo?._tab;
                  if (!tab?.isConnected) continue;
                  // Use closest() rather than parentElement — Zen often wraps
                  // a tab in an intermediate container inside the tab-group,
                  // so parentElement isn't the tab-group element directly.
                  if (tab.closest("tab-group")) {
                    try {
                      tabsContainer.insertBefore(tab, tabsContainer.firstChild);
                      movedSkipped++;
                    } catch (e) {
                      console.error(`${LOG} error ungrouping skipped tab:`, e);
                    }
                  }
                }
                if (movedSkipped > 0) console.log(`${LOG} ${newGroupBehavior} mode: ungrouped ${movedSkipped} AI-skipped tab(s) from their previous groups`);
              }
              const dropped = dissolveEmptyGroups();
              if (dropped > 0) console.log(`${LOG} dissolved ${dropped} empty group(s) after re-tidy`);
            }
          }
        } else if (pass2.skipped.length > 0) {
          console.log(`${LOG} Pass 2: nothing to group (skipped ${pass2.skipped.length} ${inputLabel})`);
        }
      } catch (e) {
        console.error(`${LOG} Pass 2 failed:`, e);
      } finally {
        setButtonThinking(false);
      }
    }

    // 8. Push any remaining ungrouped tabs to the top of the list.
    const movedUp = moveUngroupedToTop(workspaceId);
    if (movedUp > 0) console.log(`${LOG} moved ${movedUp} ungrouped tab(s) to the top of the list`);

    // 9. Sync per-rule styling on every rule-matched group (covers groups Pass 1 didn't touch).
    const colored = syncAllGroupColors(workspaceId, rules);
    if (colored > 0) console.log(`${LOG} synced styling on ${colored} group(s) (minimal=${isMinimalStyle()})`);

    // DIAGNOSTIC: detect tab-group nesting. tab-group inside another tab-group
    // is a Zen-API bug (their tab-group system isn't designed to nest). If we
    // ever see nested > 0, our addTabGroup call is anchoring at a tab inside
    // an existing group and Zen ends up creating a child group.
    try {
      const allGroups = document.querySelectorAll("tab-group").length;
      const nestedGroups = document.querySelectorAll("tab-group tab-group").length;
      if (nestedGroups > 0) {
        console.warn(`${LOG} ⚠ NESTED TAB-GROUPS DETECTED: ${nestedGroups} group(s) inside other groups (total ${allGroups}). This is the "subgroup" bug — investigating anchor points for gBrowser.addTabGroup.`);
        // Log each nested pair so we can identify which groups are the parent/child.
        for (const inner of document.querySelectorAll("tab-group tab-group")) {
          const parent = inner.parentElement?.closest("tab-group");
          console.warn(`  nested: "${inner.getAttribute("label") || "(unlabeled)"}" inside "${parent?.getAttribute("label") || "(unlabeled)"}"`);
        }
      } else {
        console.log(`${LOG} post-tidy structure: ${allGroups} tab-group(s), 0 nested (flat ✓)`);
      }
    } catch (e) {
      console.error(`${LOG} nesting diagnostic failed:`, e);
    }
  } finally {
    console.groupEnd();
  }

  } finally {
    popTabGroupedHookSuppression();
    console.log(`${LOG} click END — suppression popped`);
  }
};
