# Zen Tab Wand — Documentation

A Zen Browser Sine mod that auto-organizes tabs into groups using two passes:

1. **Pass 1 — Deterministic rules**: a URL/title-to-group map (e.g. `calendar.google.com → Calendar`, or title contains `invoice → Work`) defined in the settings widget, matched first-match-wins within the selected match source.
2. **Pass 2 — AI fallback** (shipped): unmatched tabs are sent to one of two engines:
   - **Local** (`modules/ai.mjs`): Firefox's bundled `Mozilla/smart-tab-embedding` model. Existing-group classification only; no new-group invention.
   - **Ollama** (`modules/ollama.mjs`): HTTP client to a local Ollama daemon at `localhost:11434`. Does both existing-group classification and AI-invented new-group clustering, with a merge pass and an optional interactive Preview Only modal for user review.

Rules grow via three explicit paths: the settings UI rule editor, the tab right-click "Add to Rule…" submenu (browser-hooks.mjs's `setupTabContextMenu`), and AI Pass 2 when it decides to grow rules.

## File map

| File | Purpose |
|---|---|
| `auto-organize.uc.mjs` | Entry point. Branches on `window.location` to wire browser-context or preferences-context modules. |
| `theme.json` | Sine mod manifest. Declares scripts, style, preferences. |
| `preferences.json` | Sine settings schema — section headers and AI controls. The rules editor is injected as a custom widget from JS, not declared here. |
| `userChrome.css` | Mod styling: pill table, color/emoji popovers, toolbar wand button + wiggle animation, minimal-style override, preview-modal layout. |
| `rules.json` | Legacy fallback rules used only if both the Sine pref and the built-in defaults somehow fail. |
| `modules/*.mjs` | One module per concern. See per-file docs below. |
| `modules/ai.mjs` | Pass 2 — local AI engine (Firefox's bundled ML, existing-group classification only). |
| `modules/ollama.mjs` | Pass 2 — Ollama engine (full classification + clustering + merge pass + warmup). |
| `modules/preview-modal.mjs` | Preview modal used by Preview Only and rule-learning confirmation flows (group keep/skip, re-assign-to-planned, re-assign-to-new). |
| `modules/ui-toast.mjs` | Shared toast/system-notification helper. |

## New to chrome scripting?

Read [chrome-globals.md](chrome-globals.md) first. It explains where `Services`, `gBrowser`, `gZenWorkspaces`, `MozXULElement`, and `document.createXULElement` come from — they're injected by Firefox, not imported.

## Architecture in one diagram

See [architecture.md](architecture.md) for the full picture; the short version:

- **Settings widget** (about:preferences) lets the user define domain/title rules, colors/gradients, and icons.
- **Tidy button** (browser.xhtml toolbar) triggers Pass 1, applies it, and runs cleanup passes.
- **Tab right-click submenu** (browser.xhtml) lets the user explicitly add a tab's hostname to any rule or to the skip-domains list.

## Per-module docs

- [chrome-globals.md](chrome-globals.md) — primer on Firefox chrome script globals (read this first)
- [auto-organize.md](auto-organize.md) — entry point
- [module-config.md](module-config.md) — constants, palette, AI tuning, pref-key map
- [module-rules.md](module-rules.md) — rules pref I/O + AI-engine accessor functions
- [module-tabs.md](module-tabs.md) — tab enumeration + DOM helpers
- [module-groups.md](module-groups.md) — tab-group manipulation + coloring
- [module-pass1.md](module-pass1.md) — domain matcher + apply
- [module-ai.md](module-ai.md) — Pass 2 local AI engine (embedding-only, existing groups)
- [module-ollama.md](module-ollama.md) — Pass 2 Ollama engine (transport + prompts + orchestrators)
- [module-click-handler.md](module-click-handler.md) — tidy click orchestrator
- [module-browser-ui.md](module-browser-ui.md) — wand button, command, workspace hooks
- [module-browser-hooks.md](module-browser-hooks.md) — tab right-click "Add to Rule" submenu + TabGroupCreate color re-apply + minimal-style observer
- [module-prefs-ui.md](module-prefs-ui.md) — Sine dialog detection, widget injection, conditional fields
- [module-widget.md](module-widget.md) — rules editor table + Backup & Restore
- [module-color-picker.md](module-color-picker.md) — color popover + palette fetch
- [module-custom-icons.md](module-custom-icons.md) — local uploaded icon storage
- [module-emoji-picker.md](module-emoji-picker.md) — local emoji/icon picker

Modules without dedicated docs (small / self-explanatory — see source comments):
- `modules/preview-modal.mjs` — preview `<dialog>` (keep/skip groups, re-assign actions, applied/cancelled signal)
- `modules/ui-toast.mjs` — `showToast(message, options)` wrapper around `gZenUIManager.showToast` with an alerts-service fallback
