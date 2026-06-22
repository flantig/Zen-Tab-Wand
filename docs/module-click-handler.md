# `modules/click-handler.mjs` — Tidy-click orchestrator

The function the toolbar button invokes. Sequences all the passes.

## Export

| Name | Notes |
|---|---|
| `handleOrganizeClick()` | async. Idempotent: clicking with nothing to do is a no-op. |

## Sequence

```
1.  wiggleButton()                    — 600ms wand animation for feedback
2.  consolidateDuplicateGroups(ws)    — merge same-named groups
3.  loadRules() + readSkipDomainsPref()— pref → file → defaults; + skip-domain patterns
4.  dissolveStaleGroups(ws, rules)    — ungroup tabs from non-rule groups,
                                        move to top of workspace (via gBrowser.ungroupTab)
5.  getEligibleTabs()                 — fresh enumeration after #4
6.  skip-domain parking               — tabs matching the skip list are moved
                                        to the top via moveTabsToTop, excluded
                                        from the rest of the pipeline
7.  runPass1(tabs, rules)             — plan moves for non-skipped tabs
8.  console.groupCollapsed(...)       — dry-run logging
9.  applyPass1(byGroup, ws, rules)    — execute moves (skipped in fresh-like AI modes)
10. strict-rule ejection              — if strict-rules pref is on, eject any
                                        tab unmatched by URL/title rules that is
                                        still in a rule-named group
                                        via moveTabsToTop
11. getAIEngine() === "off" ? skip Pass 2 : continue
12. setButtonThinking(true)           — start wand pulse animation
13. runPass2()                        — branches on engine:
       "local"  → ai.mjs runPass2()       (existing groups or simple new groups)
       "ollama" → ollama.mjs runPass2Ollama() OR runPass2OllamaFresh()
                  depending on ai-new-group-behavior
14. Preview gate (if applicable):
       Preview Only always opens showPreviewModal(plan). Ollama rule-mutating
       flows (Always-add existing rules and/or Review and Save new rules) also open it
       so the user can approve rule changes first. If AI title learning is
       enabled, reviewed T chips are attached here before the modal opens; this
       can also open an audit-only modal for tabs already sitting in rule-named
       groups. Modal returns the user-edited plan. Apply waits for confirmation.
15. applyPass2(plan, ws, rules)       — execute moves; create new groups;
                                        optionally grow rules array
16. (fresh-categories mode) dissolve any group with zero tabs after rebuild
17. moveUngroupedToTop(ws)            — anything left ungrouped goes to top
18. syncAllGroupColors(ws, rules)     — push colors onto ALL rule-matched groups
19. logNestingDiagnostic()            — warn if any tab-group ended up nested
                                        (a Zen DOM-API edge case)
20. gZenWorkspaces.updateTabsContainers() + read gBrowser.tabs.length
                                      — tab-list settle: rebuild Firefox's _tPos
                                        cache so the first drag attempt on a
                                        sorted tab works (avoids Windows
                                        "sticky-drag" symptom).
21. setButtonThinking(false)          — restore wand
22. console.groupEnd()
```

## Why dissolve runs BEFORE Pass 1

If a rule named "Calendar" gets renamed to "Schedule":
- `Calendar` is no longer in the rules → dissolved → its tabs land at the top, ungrouped
- Pass 1 then sees these tabs as ungrouped (no `currentGroup`)
- If their hostname matches a rule (e.g. the new `Schedule`), they get moved into Schedule

Without dissolve, the tabs would still be inside `Calendar` and Pass 1 would have to also handle the rename.

## Logging output

Every click produces a collapsed console group with:
- Per-tab assignment table (action column shows leave/stay/move/group)
- Pending moves by group
- Unmatched tabs (left in place)
- Apply result counts
- Color-sync count

Useful for debugging "why didn't my tab get grouped?" type questions — the assignment table shows exactly which rule matched (or didn't).
