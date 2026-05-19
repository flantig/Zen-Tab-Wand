# `modules/color-picker.mjs` — Color picker popover + Zen palette fetch

## Exports

| Name | Notes |
|---|---|
| `fetchZenColorsFromBrowser()` | Reads Zen's live computed tab-group palette from the main browser window and overwrites `HEX_BY_NAME` so swatches in the picker match Zen's actual rendered colors. |
| `updateSwatchAppearance(swatch, color)` | Sets background + title + empty/non-empty state on a swatch div. |
| `openColorPopover(rule, swatch, onChange)` | Opens the popover anchored above `swatch`. `onChange` is called after every preset pick or hex input change so the caller can persist. |

## Why fetch Zen colors at runtime

Zen defines `--tab-group-color-{name}` (the rendering vars) in `tabs.css` which is only loaded for `browser.xhtml`. In `about:preferences` those vars are undefined, so `var(--tab-group-color-blue, #77A1E6)` falls back to our hardcoded hex.

The hardcoded hex is an approximation — it doesn't match what Zen actually paints in the user's current theme. So we reach into the main browser window via `Services.wm.getMostRecentWindow("navigator:browser")`, create a probe `<div>` with `background: light-dark(var(--tab-group-color-{name}), var(--tab-group-color-{name}-invert))` (the same expression Zen uses to render a group label background), and read `getComputedStyle(probe).backgroundColor` to get the actual rendered RGB. That value overwrites `HEX_BY_NAME[name]`.

End result: swatches in the picker match the actual rendered group pill background in the user's theme.

## Popover positioning

The popover is `position: fixed`. We compute `getBoundingClientRect()` on the swatch and place the popover above it (or below if there's not enough room above).

**Critical**: the popover is appended INSIDE Sine's `<dialog class="sineItemPreferenceDialog">` element — not on `document.body`. Reason: the dialog is opened via `showModal()` which puts it in the browser's top layer; anything outside the dialog is hidden underneath. Appending the popover as a child of the dialog inherits the top-layer visibility.

## Outside-click + Escape close

Two document-level listeners attached with `setTimeout(..., 0)` so the click that opens the popover doesn't immediately close it:

- `mousedown` (capture) — closes if the target is outside both the popover and the swatch.
- `keydown` — closes on Escape.

Both call a shared `cleanup()` that removes both listeners.

## Color storage on the rule

| User action | Stored value |
|---|---|
| Click preset dot | the name string (`"blue"`) |
| Type hex into input | the hex string (`"#abc123"`) |
| Clear hex input | `rule.color` is `delete`d |

The downstream `applyGroupColor` (in `groups.mjs`) handles both forms — see [module-groups.md](module-groups.md).
