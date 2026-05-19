# `auto-organize.uc.mjs` — Entry point

The single script Sine loads. Branches on `window.location.href` to wire the right modules for each context, then sets up the load + unload listeners.

## Contexts

| `window.location.href` | Action |
|---|---|
| `chrome://browser/content/browser.xhtml` | `initializeBrowserScript()` — installs the toolbar button, commands, workspace hooks, and tab-group event hooks |
| `about:preferences*` or `chrome://browser/content/preferences/preferences.xhtml*` | `setupSettingsObserver()` — watches for our mod's settings dialog and injects the rules editor |

## Init polling

Browser context init waits until **gBrowser**, **gZenWorkspaces**, the **commandset**, and the **pinned-tabs separator** are all present. Polled with `INIT_CHECK_INTERVAL` (default 100ms) up to `MAX_INIT_CHECKS` (default 50). Without polling, Sine sometimes loads the script before Zen's UI is ready.

## Cleanup

`unload` and `beforeunload` both call `cleanup()`:
- invalidates `domCache`
- disconnects the settings MutationObserver

The pref observer registered by `widget.mjs` self-detaches when its container is no longer connected to the DOM.

## Why one entry instead of two

Sine has no concept of "this script is only for browser context" vs "this script is only for prefs context" beyond the `include` URL list. Putting both under the same script + branching keeps the build/import paths simpler.
