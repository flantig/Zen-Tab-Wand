# Zen Tab Wand — Documentation

A Zen Browser Sine mod that auto-organizes tabs into groups using two passes:

1. **Pass 1 — Deterministic domain rules**: a hostname-to-group map (e.g. `calendar.google.com → Calendar`) defined in the settings widget, matched first-match-wins.
2. **Pass 2 — AI fallback** (shipped): unmatched tabs are sent to one of two engines:
   - **Local** (`modules/ai.mjs`): Firefox's bundled `Mozilla/smart-tab-embedding` model. Existing-group classification only; no new-group invention.
   - **Ollama** (`modules/ollama.mjs`): HTTP client to a local Ollama daemon at `localhost:11434`. Does both existing-group classification and AI-invented new-group clustering, with a merge pass and an optional interactive Plan Mode modal for user review.

The mod also auto-records new rules when the user uses Zen's native "Add Tab to Group" submenu, so the rules table grows organically as you organize manually.

## File map

| File | Purpose |
|---|---|
| `auto-organize.uc.mjs` | Entry point. Branches on `window.location` to wire browser-context or preferences-context modules. |
| `theme.json` | Sine mod manifest. Declares scripts, style, preferences. |
| `preferences.json` | Sine settings schema — section headers and AI controls. The rules editor is injected as a custom widget from JS, not declared here. |
| `userChrome.css` | Mod styling: pill table, color picker popover, toolbar wand button + wiggle animation, minimal-style override, preview-modal layout. |
| `rules.json` | Legacy fallback rules used only if both the Sine pref and the built-in defaults somehow fail. |
| `modules/*.mjs` | One module per concern. See per-file docs below. |
| `modules/ai.mjs` | Pass 2 — local AI engine (Firefox's bundled ML, existing-group classification only). |
| `modules/ollama.mjs` | Pass 2 — Ollama engine (full classification + clustering + merge pass + warmup). |
| `modules/preview-modal.mjs` | Plan Mode interactive modal (group keep/skip, re-assign-to-planned, re-assign-to-new). |
| `modules/ui-toast.mjs` | Shared toast/system-notification helper. |

## New to chrome scripting?

Read [chrome-globals.md](chrome-globals.md) first. It explains where `Services`, `gBrowser`, `gZenWorkspaces`, `MozXULElement`, and `document.createXULElement` come from — they're injected by Firefox, not imported.

## Architecture in one diagram

See [architecture.md](architecture.md) for the full picture; the short version:

- **Settings widget** (about:preferences) lets the user define rules + colors.
- **Tidy button** (browser.xhtml toolbar) triggers Pass 1, applies it, and runs cleanup passes.
- **Event hooks** (browser.xhtml) listen to Zen's native tab-group actions and auto-extend the rules pref.

## Per-module docs

- [chrome-globals.md](chrome-globals.md) — primer on Firefox chrome script globals (read this first)
- [auto-organize.md](auto-organize.md) — entry point
- [module-config.md](module-config.md) — constants + palette
- [module-rules.md](module-rules.md) — rules pref I/O + load chain
- [module-tabs.md](module-tabs.md) — tab enumeration + DOM helpers
- [module-groups.md](module-groups.md) — tab-group manipulation + coloring
- [module-pass1.md](module-pass1.md) — domain matcher + apply
- [module-ai.md](module-ai.md) — Pass 2 local AI engine (embedding-only, existing groups)
- [module-click-handler.md](module-click-handler.md) — tidy click orchestrator
- [module-browser-ui.md](module-browser-ui.md) — button, command, workspace hooks
- [module-browser-hooks.md](module-browser-hooks.md) — TabGrouped / TabGroupCreate
- [module-prefs-ui.md](module-prefs-ui.md) — Sine dialog detection + widget injection
- [module-widget.md](module-widget.md) — rules editor table widget
- [module-color-picker.md](module-color-picker.md) — color popover + palette fetch
