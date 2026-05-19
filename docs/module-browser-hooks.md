# `modules/browser-hooks.mjs` — Zen tab-group event hooks

Hooks Zen's native `TabGrouped` and `TabGroupCreate` events so manual organization auto-grows the rules pref.

## Exports

| Name | Notes |
|---|---|
| `setupTabGroupedHook()` | Auto-add hostnames to rules when tabs join groups. |
| `setupTabGroupCreateHook()` | Re-apply rule colors when Zen restores groups on startup. |

## TabGrouped flow

When the user picks "Add Tab to Group → X" from Zen's native context menu (or drags a tab into a group), Zen dispatches a `TabGrouped` event:

- `event.target` is the **tab-group element** (NOT the tab — quirk of Zen's implementation, see `tab.js #updateOnTabGrouped` in the Zen source).
- `event.detail` is the tab that was grouped.

The handler:

1. If the group has a real label → call `applyToRule(tab, label, group)` directly.
2. If the label is empty / U+200B (the "New Group" case where Zen prompts the user to name it):
   - Listen for `popuphidden` on document. Any way the create-tab-group modal closes (Done click, Escape, click-outside, etc.) fires this event.
   - When it fires, defer one tick (`setTimeout(0)`) so the swatch-radio's `change` handler can flush the user's color pick into `group.color` before we read it.
   - Group state (label set + still connected) gates the actual commit — popuphidden fires for unrelated popups too, but they don't match.
   - Set a long abandon timer (`NEW_GROUP_ABANDON_MS`, 5 minutes) so the document listener doesn't leak if the modal is never resolved.
3. `applyToRule` either appends the hostname to an existing rule or creates a brand-new rule from the user-chosen name (inheriting the color the user picked in Zen's modal if it's a named palette color).

## Why popuphidden (not TabGroupCreateDone or debounce)

The history of this signal choice, since it tripped us up a few times:

1. **Debounced TabGroupUpdate** — first attempt. `tabgroup-menu.js` sets `activeGroup.label = value` on every keystroke, so TabGroupUpdate fires per character. Debouncing for 1.5s after the last update was supposed to wait until the user finished typing. **Bug**: if the user typed the name first and paused for >1.5s while reading the color palette before picking, the debounce fired with the still-default color. Removed.

2. **TabGroupCreateDone only** — second attempt. Zen dispatches `TabGroupCreateDone` from `on_popuphidden` when `#keepNewlyCreatedGroup` is true. Works for the Done button. **Bug**: click-outside also resolves the modal (Zen keeps the group), but if the user picked a color and clicked outside in the same gesture, `group.color` hadn't flushed yet when our handler read it. Replaced.

3. **popuphidden + setTimeout(0)** — current. Catches every dismissal path uniformly. The microtask defer guarantees pending event handlers (swatch change, etc.) have committed before we read `group.color`.

## TabGroupCreate flow

Fires when any tab-group element connects to the DOM — including ALL groups restored from session on Zen startup. The handler:

1. Reads the group's `label`.
2. Looks up a matching rule.
3. If the rule has a `color`, defers one tick (so Zen's own color setup finishes) then calls `applyGroupColor(group, rule.color)`.

This is why custom rule colors survive across Zen restarts even though Zen's session storage might forget them.
