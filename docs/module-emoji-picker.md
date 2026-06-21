# `modules/emoji-picker.mjs` — Rule icon picker

Small no-dependency picker used by the rules editor.

## Exports

| Name | Notes |
|---|---|
| `updateIconButtonAppearance(button, icon)` | Updates the row icon button text, empty state, title, and accessible label. |
| `openEmojiPopover(rule, anchor, onChange)` | Opens a popover with a current-icon clear slot, search, a 4x3 paged local emoji grid, and appended custom icons. Search matches category names, emoji characters, bundled Unicode-style emoji names, and custom icon names. Stores the selected icon id/text in `rule.icon` and calls `onChange()` after edits. |

## Storage and rendering

The picker stores either selected emoji text or a `custom:<id>` reference on the rule. Missing custom icon references render as blank. It uses `textContent` for emoji buttons and `<img>` for custom icon data URLs; it never parses user text as HTML. Browser-context rendering happens in `groups.mjs`, which writes either text content or a background image custom property for the tab-group label.
