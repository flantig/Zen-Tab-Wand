# `modules/prefs-ui.mjs` — Settings dialog injection

Watches Sine's preferences page for our mod's settings dialog and injects the rules editor widget. Also handles the stylesheet (Sine's chrome CSS pipeline doesn't reach `about:preferences`).

## Exports

| Name | Notes |
|---|---|
| `setupSettingsObserver()` | Registers the `MutationObserver` watching for our `<dialog>` element. |
| `teardownSettingsObserver()` | Disconnects on unload. |

## How we find OUR dialog

Sine creates a `<dialog class="sineItemPreferenceDialog">` inside each mod card. The card itself is a `<vbox class="sineItem" mod-id="...">`. We look for `[mod-id="zen-tab-wand"]` to identify ours — the dialog's own title is a generic "Settings" string and not reliable.

The MutationObserver watches `document.body { childList, subtree }`. Sine builds the mods list once when the preferences page is initialized, so we usually catch the dialog right then; there's also a fallback that scans for an already-present dialog at observer-setup time.

## Polling for content readiness

Sine's `loadPrefs()` is async — the dialog element is appended to DOM BEFORE its content (separators, inputs, etc.) is populated. We poll for the "Group Rules" separator label (or legacy "Rules") with `INJECT_POLL_INTERVAL_MS` between checks, up to `INJECT_MAX_POLL_ATTEMPTS`. If the separator never appears, we inject the widget at the top of the content area as a fallback.

## Stylesheet injection

`userChrome.css` is loaded into the browser chrome via Sine's `style.chrome` directive — but Sine's stylesheet manager only applies to `chrome://` URLs, not `about:preferences`. So we fetch the CSS file via `chrome://sine/content/zen-tab-wand/userChrome.css` and inject it as an inline `<style>` tag in the preferences document.

Refetched on every dialog open (cheap, local file) so iterative CSS edits show up without reloading the prefs tab.

## Dialog re-open refresh

Sine reuses the same `<dialog>` element across open/close cycles. Our injected widget persists in DOM. When the dialog opens, we want the widget to reflect any pref changes that happened while it was closed (e.g. via the TabGrouped hook).

Two refresh paths converge here:
1. **Pref observer in widget.mjs** — fires immediately if the pref changes while the dialog is open.
2. **MutationObserver on dialog `[open]` attribute** — fires when `showModal()` is called, refreshing the widget from the pref.

Both call the widget's `_zaoRefresh()` hook (set on the widget container by `widget.mjs`).
