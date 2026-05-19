# `modules/widget.mjs` — Rules editor table widget

Builds the pill table inside the settings dialog. One export, lots of internal helpers.

## Export

| Name | Notes |
|---|---|
| `buildRulesEditor(rules)` | Returns the `<div class="zao-rules-editor">` container element. Mutations to the `rules` array auto-persist to the pref. The container exposes a `_zaoRefresh(reason)` method for external refresh triggers. |

## DOM structure

```
<div class="zao-rules-editor">
  <div class="zao-header">           ← column titles: color / Category / Domains / —
    <div></div> <div>Category</div> <div>Domains</div> <div></div>
  </div>
  <div class="zao-row">              ← one row per rule
    <div class="zao-color-cell">
      <div class="zao-swatch" role="button" />
    </div>
    <input class="zao-group-name" />
    <div class="zao-domains">
      <span class="zao-pill">…<button class="zao-pill-remove">×</button></span>
      <button class="zao-pill-add">+</button>
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
| Click `+` pill | Replaces the button with an `<input>`. Enter commits and re-renders. Escape cancels. Blur commits (via 0ms timeout so a click on another pill button registers first). |
| Click `×` on pill | Removes the domain, persists, re-renders. |
| Click `×` on row | Removes the rule, persists, re-renders. |
| Click `+ Add group` | Pushes a blank rule, persists, re-renders. |
| Click swatch | Opens `color-picker.mjs` popover. |

## Why a full re-render on each mutation

The data model is small (typically <10 rules, <20 domains total). A full `render()` is faster to reason about than fine-grained DOM diffing and avoids stale event-handler bugs from mutated references. Focus is occasionally lost from inputs during re-render — acceptable trade-off.

## Pref observer

Inside `buildRulesEditor` we register an `nsIPrefBranch.addObserver` for the rules pref. When it fires (typically from `browser-hooks.mjs` adding a hostname via the TabGrouped path), we re-read the pref, do a JSON-equal diff against the current `rules` array, and only re-render if they actually differ. This avoids clobbering focus on the very write we just triggered ourselves.

A module-level `rulesPrefObserver` ensures only one observer is registered at a time — calling `buildRulesEditor` again unregisters the previous observer.
