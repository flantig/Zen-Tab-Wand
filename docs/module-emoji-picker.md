# `modules/emoji-picker.mjs` — Rule icon picker

Small no-dependency picker used by the rules editor.

## Exports

| Name | Notes |
|---|---|
| `updateIconButtonAppearance(button, icon)` | Updates the row icon button text, empty state, title, and accessible label. |
| `openEmojiPopover(rule, anchor, onChange)` | Opens a popover with search, a categorized local emoji grid, Clear, and Use text. Stores `rule.icon` as plain text and calls `onChange()` after edits. |

## Storage and rendering

The picker stores only a short plain-text `icon` string on the rule. It uses `textContent` for picker buttons and never parses user text as HTML. Browser-context rendering happens in `groups.mjs`, which writes the icon into a CSS custom property for the tab-group label.
