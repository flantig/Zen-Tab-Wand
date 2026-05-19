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
      ├── setupTabGroupedHook()       ──▶ browser-hooks.mjs
      ├── setupTabGroupCreateHook()   ──▶ browser-hooks.mjs
      └── syncAllGroupColors()        ──▶ groups.mjs


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
            ├── injectStylesheet()    ──▶ prefs-ui.mjs (internal)
            └── performInject()       ──▶ prefs-ui.mjs (internal)
                  └── buildRulesEditor() ──▶ widget.mjs
                        └── openColorPopover() ──▶ color-picker.mjs
```

## Module dependency graph

```
config.mjs            (no deps; pure constants + helpers)
   ▲
   │
rules.mjs   tabs.mjs
   ▲           ▲
   │           │
   └─── groups.mjs
            ▲
            │
        pass1.mjs
            ▲
            │
   click-handler.mjs
            ▲
            │
   ┌────────┴────────────────────────┐
   │                                 │
browser-ui.mjs     browser-hooks.mjs  (browser context)
   │                                 │
   └─────────────┬───────────────────┘
                 │
        auto-organize.uc.mjs
                 │
   ┌─────────────┴──────────┐
   │                        │
prefs-ui.mjs ─── widget.mjs ─── color-picker.mjs   (prefs context)
```

## The tidy-button click flow

When the user clicks the wand button, `handleOrganizeClick` runs:

1. **wiggle** — CSS animation on the wand for feedback
2. **consolidate duplicates** (groups.mjs) — merge multiple tab-groups with the same label into the first
3. **load rules** (rules.mjs) — pref > rules.json > defaults
4. **dissolve stale groups** (groups.mjs) — any tab-group whose name isn't in the current rule set gets its tabs ejected to the top of the workspace; the empty group is removed
5. **enumerate eligible tabs** (tabs.mjs) — non-pinned, non-empty, in the current workspace
6. **runPass1** (pass1.mjs) — assign each tab a target group via first-match-wins
7. **applyPass1** (pass1.mjs) — move tabs into their target groups; create new groups when needed
8. **moveUngroupedToTop** (groups.mjs) — anything still ungrouped is shoved to the top
9. **syncAllGroupColors** (groups.mjs) — push per-rule colors onto every rule-matched group (catches groups Pass 1 didn't touch)

## State persistence

- **Rules** live in the `extensions.zen-auto-organize.rules-json` pref (a JSON-encoded array). Read/written by `rules.mjs`. Observed by the widget so external changes (e.g. context-menu auto-add) refresh the table live.
- **Minimal-style toggle** lives in `extensions.zen-auto-organize.minimal-style`. Read each click; not observed.
- **Rule colors** are stored inline on each rule (`{ name, domains, color }`). The color is either a Zen palette name (`"blue"`) or a hex string (`"#abc"`).
