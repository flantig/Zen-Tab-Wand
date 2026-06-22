# `modules/prefs-ui.mjs` — Settings dialog injection

Watches Sine's preferences page for our mod's settings dialog and injects the rules editor widget, the Backup & Restore section, section descriptions, and runs the conditional-visibility passes that hide AI fields when the engine pref is off. Also handles the stylesheet (Sine's chrome CSS pipeline doesn't reach `about:preferences`).

## Exports

| Name | Notes |
|---|---|
| `setupSettingsObserver()` | Registers the `MutationObserver` watching for our `<dialog>` element, plus an immediate scan of the existing DOM in case our dialog is already mounted. |
| `teardownSettingsObserver()` | Disconnects the observer + tears down the engine-pref observer + the rules-pref observer (so window unload doesn't leak observers into the parent process). |

## How we find OUR dialog

Sine creates a `<dialog class="sineItemPreferenceDialog">` inside each mod card. We DON'T match on `[mod-id="zen-tab-wand"]` — that attribute proved unreliable across the rename and across Sine versions. Instead, `isOurDialog(d)` looks for a `.separator-label` element whose text starts with `"Group Rules"` somewhere inside the dialog. That string only appears in our preferences.json, so it's a reliable marker.

The MutationObserver watches `document.body { childList, subtree }`. Sine builds the mods list once when the preferences page is initialized; we usually catch the dialog right then. There's also a fallback that scans for an already-present dialog at observer-setup time, plus a mutation-target check so a separator-label added LATER to an existing dialog (Sine's loadPrefs is async) still triggers the inject path.

When we identify our dialog we also tag it with the `zao-our-dialog` class — a hook for any future scoped CSS overrides.

## Polling for content readiness

Sine's `loadPrefs()` is async — the dialog element is appended to DOM BEFORE its content (separators, inputs, etc.) is populated. We poll for the "Group Rules" separator label (or legacy "Rules") with `INJECT_POLL_INTERVAL_MS` between checks, up to `INJECT_MAX_POLL_ATTEMPTS`. If the separator never appears, we inject the widget at the top of the content area as a fallback.

## What `performInject` does

In order, after the rules editor is appended:

1. **buildRulesEditor + buildSkipDomainsEditor + buildBackupRestoreSection** — three custom blocks inserted as siblings of their respective Sine separators (Group Rules / Skip Domains / Backup & Restore) declared in `preferences.json`. `findSeparatorContainer(dialog, "Group Rules")` locates the separator container, then `insertAfter()` drops our content as its next sibling. All three sections inherit Sine's native separator styling.
2. **tagSeparatorContainers** — adds `.zao-section-header-row` to the parent `<vbox>` of each `.separator-label`. Tagging is consistent across our injected header and Sine's native ones, even though we don't currently style on it.
3. **injectSectionDescriptions** — adds a `.zao-pref-description` paragraph as a sibling of each separator container, sourced from a constant list in this module. Idempotent (skips if a description already follows).
4. **alignCheckboxRows** — tags checkbox preference rows so their controls align on the right, matching the dropdown/action-row layout.
5. **setupEnginePrefObserver** — installs an `nsIPrefBranch.addObserver` on `extensions.zen-auto-organize.ai-engine`. On change, re-runs the conditional-fields pass.
6. **updateConditionalFields** — toggles the `.zao-pref-hidden` class on each AI-related row based on the engine pref. Engine `"off"` hides existing-behavior + new-group-behavior + all Ollama rows; `"local"` shows only existing-behavior; `"ollama"` shows everything.

## Stylesheet injection

`userChrome.css` is loaded into the browser chrome via Sine's `style.chrome` directive — but Sine's stylesheet manager only applies to `chrome://` URLs, not `about:preferences`. So we fetch the CSS file via `chrome://sine/content/zen-tab-wand/userChrome.css` and inject it as an inline `<style>` tag in the preferences document.

Refetched on every dialog open with a `?t=<timestamp>` cache-buster, so iterative CSS edits show up without reloading the prefs tab.

## Dialog re-open refresh

Sine reuses the same `<dialog>` element across open/close cycles. Our injected widget persists in DOM. When the dialog opens, we want the widget to reflect any pref changes that happened while it was closed (e.g. via the tab right-click "Add to Rule…" submenu or an AI Pass 2 rule-grow).

Two refresh paths converge here:
1. **Pref observer in widget.mjs** — fires immediately if the rules pref changes while the dialog is open.
2. **MutationObserver on dialog `[open]` attribute** — fires when `showModal()` is called, refreshing the widget from the pref AND re-running `updateConditionalFields` (in case Sine re-rendered the AI rows on reopen).

Both call the widget's `_zaoRefresh()` hook (set on the widget container by `widget.mjs`).
