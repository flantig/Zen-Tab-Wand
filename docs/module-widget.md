# `modules/widget.mjs` — Rules editor table widget

Builds the pill table inside the settings dialog. One export, lots of internal helpers.

## Exports

| Name | Notes |
|---|---|
| `buildRulesEditor(rules)` | Returns the `<div class="zao-rules-editor">` container element. Mutations to the `rules` array auto-persist to the pref. The container exposes a `_zaoRefresh(reason)` method for external refresh triggers. |
| `buildSkipDomainsEditor()` | Returns a `<div class="zao-skip-editor">` pill-row editor for the skip-domains list. Reads/writes `extensions.zen-auto-organize.skip-domains-json` directly. Refreshes via its own pref observer when the pref changes externally (e.g. via Backup & Restore import or the tab right-click "Skip" submenu entry). |
| `buildBackupRestoreSection()` | Returns a `<div class="zao-backup-section">` containing Export / Import… buttons (the section header + description come from Sine's native separator declared in preferences.json, NOT from this widget). **Export** saves `{ rules, skipDomains }` JSON to the user's default Downloads folder via `IOUtils.writeUTF8` and registers it with `Downloads.PUBLIC` so it appears in Firefox's downloads panel. Filename: `wand-backup-<N>groups-<YYYYMMDD-HHmmss>.json`. Falls back to clipboard copy if the Downloads API is unavailable. **Import…** opens a file picker, validates, and writes both prefs. Accepts the `{ rules, skipDomains }` object shape or a legacy bare rules array for back-compat. |
| `teardownRulesPrefObserver()` / `teardownSkipPrefObserver()` | Remove the pref observers registered inside the editor builders. Called from `prefs-ui.mjs`'s `teardownSettingsObserver` on window unload to prevent observer leaks. |

## DOM structure

```
<div class="zao-rules-editor">
  <div class="zao-header">           ← column titles: color+icon / Category / Matches / —
    <div></div> <div>Category</div> <div>Matches</div> <div></div>
  </div>
  <div class="zao-row">              ← one row per rule
    <div class="zao-color-cell">
      <div class="zao-swatch" role="button" />
      <button class="zao-icon-button">…</button>
    </div>
    <input class="zao-group-name" />
    <div class="zao-domains">
      <span class="zao-pill zao-domain-pill"><span class="zao-pill-kind">@</span>…</span>
      <span class="zao-pill zao-title-pill"><span class="zao-pill-kind">T</span>…</span>
      <button class="zao-pill-add zao-domain-add">+@</button>
      <button class="zao-pill-add zao-title-add">+T</button>
    </div>
    <button class="zao-remove-row">×</button>
  </div>
  …
  <div class="zao-add-row">
    <button class="zao-add-row-btn">+ Add group</button>
  </div>
</div>
```

All elements created via `h(tag)` from `config.mjs` (the HTML namespace helper) so they don't pick up XUL chrome theming inside the XUL-rooted preferences document.

## Edit interactions

| Action | What happens |
|---|---|
| Type in group-name input | `rule.name = value` on every keystroke; `persist()` |
| Click `+@` pill | Adds a domain/hostname match chip. Enter commits and re-renders. Escape cancels. Blur commits. |
| Click `+T` pill | Adds a page-title substring match chip. Enter commits and re-renders. Escape cancels. Blur commits. |
| Click `×` on pill | Removes the domain/title match, persists, re-renders. |
| Click `×` on row | Removes the rule, persists, re-renders. |
| Click `+ Add group` | Pushes a blank rule, persists, re-renders. |
| Click swatch | Opens `color-picker.mjs` popover for solid/gradient colors. |
| Click icon button | Opens `emoji-picker.mjs` popover. Pick from the local emoji grid, search by category, clear, or paste custom text. |

## Why a full re-render on each mutation

The data model is small (typically <10 rules, <20 domains total). A full `render()` is faster to reason about than fine-grained DOM diffing and avoids stale event-handler bugs from mutated references. Focus is occasionally lost from inputs during re-render — acceptable trade-off.

## Pref observer

Inside `buildRulesEditor` we register an `nsIPrefBranch.addObserver` for the rules pref. When it fires (typically from `browser-hooks.mjs` adding a hostname via the TabGrouped path), we re-read the pref, do a JSON-equal diff against the current `rules` array, and only re-render if they actually differ. This avoids clobbering focus on the very write we just triggered ourselves.

A module-level `rulesPrefObserver` ensures only one observer is registered at a time — calling `buildRulesEditor` again unregisters the previous observer.
