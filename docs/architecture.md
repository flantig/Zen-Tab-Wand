# Architecture

## Two execution contexts

The same `auto-organize.uc.mjs` is loaded into two different documents by Sine:

```
                 chrome://browser/content/browser.xhtml
                            (main window)
                                 │
                                 ▼
              ┌────────────────────────────────────┐
              │ entry: auto-organize.uc.mjs        │
              │   isBrowserContext = true          │
              ▼                                    │
   tryInitializeBrowser()                          │
      ├── setupCommand()              ──▶ browser-ui.mjs
      ├── addButtonToAllSeparators()  ──▶ browser-ui.mjs
      ├── setupWorkspaceHooks()       ──▶ browser-ui.mjs
      ├── setupTabContextMenu()       ──▶ browser-hooks.mjs  ("Add to Rule…" submenu)
      ├── setupTabGroupCreateHook()   ──▶ browser-hooks.mjs
      ├── setupMinimalStylePrefObserver() ──▶ browser-hooks.mjs
      ├── syncAllGroupColors()        ──▶ groups.mjs
      └── (if Ollama selected + warmup enabled)
          warmupOllama()              ──▶ ollama-transport.mjs


                  about:preferences#sine-mods
                       (settings page)
                             │
                             ▼
              ┌────────────────────────────────────┐
              │ entry: auto-organize.uc.mjs        │
              │   isPrefsContext = true            │
              ▼                                    │
   setupSettingsObserver()            ──▶ prefs-ui.mjs
      ├── fetchZenColorsFromBrowser() ──▶ color-picker.mjs
      ├── MutationObserver(document.body)
      └── onOurDialogFound(dialog)
            ├── injectStylesheet()         ──▶ prefs-ui.mjs (internal)
            └── performInject()            ──▶ prefs-ui.mjs (internal)
                  ├── buildRulesEditor()        ──▶ widget.mjs
                  │     ├── openColorPopover()       ──▶ color-picker.mjs
                  │     └── openEmojiPopover()       ──▶ emoji-picker.mjs
                  ├── buildBackupRestoreSection() ──▶ widget.mjs
                  ├── tagSeparatorContainers()
                  ├── injectSectionDescriptions()
                  ├── setupEnginePrefObserver()
                  └── updateConditionalFields()
```

## Module dependency graph

```
config.mjs            (no deps; pure constants + helpers)
   ▲
   │
rules.mjs   tabs.mjs   ui-toast.mjs
   ▲           ▲              ▲
   │           │              │
   └─── groups.mjs             │
            ▲                  │
            │                  │
        pass1.mjs              │
            ▲                  │
            │                  │
            │  ┌── ai.mjs ─────┤    (Pass 2: local embedding engine)
            │  │               │
            │  │  ollama-transport.mjs ── ollama-prompts.mjs
            │  │       ▲                       ▲
            │  │       └────── ollama.mjs ─────┘
            │  │                  ▲
            │  │                  │
            │  │           preview-modal.mjs   (preview UI)
            │  │                  ▲
            │  └──────────────────┤
            │                     │
            └─── click-handler.mjs
                       ▲
                       │
   ┌───────────────────┴─────────────────┐
   │                                     │
browser-ui.mjs    browser-hooks.mjs   (browser context)
   │                                     │
   └─────────────┬───────────────────────┘
                 │
        auto-organize.uc.mjs
                 │
   ┌─────────────┴──────────┐
   │                        │
prefs-ui.mjs ─── widget.mjs ─── color-picker.mjs / emoji-picker.mjs   (prefs context)
```

## The tidy-button click flow

When the user clicks the wand button, `handleOrganizeClick` runs:

1. **wiggle** — CSS animation on the wand for feedback
2. **consolidate duplicates** (groups.mjs) — merge multiple tab-groups with the same label into the first
3. **load rules + skip-domains** (rules.mjs) — pref > rules.json > defaults; separate `readSkipDomainsPref()` for the skip list
4. **dissolve stale groups** (groups.mjs) — any tab-group whose name isn't in the current rule set gets its tabs ungrouped via `gBrowser.ungroupTab` then DOM-moved to the top of the workspace; the empty group is removed
5. **enumerate eligible tabs** (tabs.mjs) — non-pinned, non-empty, in the current workspace
6. **skip-domain parking** — any tab whose hostname matches a pattern in the skip list is ungrouped + parked at the top via `moveTabsToTop`, then excluded from the rest of the pipeline
7. **runPass1** (pass1.mjs) — assign each remaining tab a target group via first-match-wins
8. **applyPass1** (pass1.mjs) — move tabs into their target groups; create new groups when needed (skipped in fresh-like AI modes since Pass 2 will reclassify everything)
9. **strict-rule ejection** (opt-in via the `strict-rules` pref) — after `applyPass1`, any unmatched tab that's still inside a rule-named group is ungrouped + parked at the top via `moveTabsToTop`

Then, if the AI engine is set to anything other than `"off"`:

10. **setButtonThinking(true)** — start the wand's pulse animation while AI runs
11. **runPass2** (ai.mjs **or** ollama.mjs) — depends on `ai-engine` pref:
    - `"local"` → existing-group classification, or Fresh Rebuild clustering when selected
    - `"ollama"` → unified classify-and-cluster; can also invent new groups
12. **Preview gate** — Preview Only always opens `showPreviewModal`; Ollama rule-mutating flows also open it before writing rules. With AI title learning enabled, reviewed `T` chips are proposed from actual tab titles as separate title-rule proposals before the modal opens, including an audit of tabs already inside rule-named groups
13. **applyPass2** — execute the (possibly user-edited) plan: move tabs into existing groups, create new ones, optionally grow rule domains and apply kept title-rule proposals
14. **fresh-categories cleanup** — if mode is `"fresh-categories"`, dissolve any group that has zero tabs after the rebuild

Finally for every click:

15. **moveUngroupedToTop** (groups.mjs) — anything still ungrouped is shoved to the top
16. **syncAllGroupColors** (groups.mjs) — push per-rule colors onto every rule-matched group (catches groups Pass 1 didn't touch)
17. **nesting diagnostic** — log a warning if any tab-group ended up nested inside another (a Zen DOM-API edge case)
18. **tab-list settle** — call `gZenWorkspaces.updateTabsContainers()` and read `gBrowser.tabs.length` to force Firefox to rebuild its `_tPos` cache. Without this, dragging a sorted tab requires two attempts on Windows because the first drag uses the stale tab-position cache (sticky-drag symptom)
19. **setButtonThinking(false)** — restore the wand

## State persistence

All prefs use the `extensions.zen-auto-organize.*` prefix (legacy; preserved across the rename to `zen-tab-wand` so existing users keep their data).

- **Rules** live in `extensions.zen-auto-organize.rules-json` (a JSON-encoded array). Read/written by `rules.mjs`. Observed by the widget so external changes (right-click "Add to Rule" submenu, Backup & Restore import, AI Pass 2) refresh the table live.
- **Skip domains** live in `extensions.zen-auto-organize.skip-domains-json` (a JSON-encoded array of hostname patterns). Read by click-handler step 6 to park matching tabs at the top of the workspace.
- **Strict rule enforcement** lives in `extensions.zen-auto-organize.strict-rules` (boolean, default false). When true, click-handler step 9 ejects any tab that does not match its current group under the active URL/title match mode.
- **Rule matching priority** lives in `extensions.zen-auto-organize.match-mode` (`"url-only" | "title-only" | "url-then-title" | "title-then-url"`, default `"url-then-title"`).
- **Gradient style** lives in `extensions.zen-auto-organize.gradient-style` (`"left-right"` by default) and controls how two-color rule gradients are drawn.
- **Minimal style** lives in `extensions.zen-auto-organize.minimal-style`. Observed by `setupMinimalStylePrefObserver` (browser-hooks.mjs) so the style flips live across all workspaces.
- **AI engine + behaviors** live in `extensions.zen-auto-organize.ai-engine` (`"" | "local" | "ollama"`), `.ai-existing-behavior`, `.ai-new-group-behavior`, `.ai-ollama-host`, `.ai-ollama-model`, `.ai-ollama-warmup`.
- **Rule appearance** is stored inline on each rule (`{ name, domains, titleTerms, color, color2, icon }`). `color`/`color2` are Zen palette names or hex strings; `icon` is plain text.
- **Custom icons** live in `extensions.zen-auto-organize.custom-icons-json` as local image data URLs. Rules reference them by `custom:<id>`.
