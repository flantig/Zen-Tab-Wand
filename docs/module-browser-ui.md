# `modules/browser-ui.mjs` — Toolbar button + command + workspace hooks

Everything that puts visible chrome into `browser.xhtml`. Loaded only in the browser context.

## Exports

| Name | Notes |
|---|---|
| `addButtonToAllSeparators()` | Idempotent: skips separators that already have our button. |
| `setupCommand()` | Registers `cmd_zenAutoOrganize` in `commandset#zenCommandSet` and wires its `command` event to `handleOrganizeClick`. |
| `setupWorkspaceHooks()` | Monkey-patches `gZenWorkspaces.onTabBrowserInserted` and `updateTabsContainers` so the button is re-injected when workspaces switch. |

## Button placement

The button is inserted into every `.pinned-tabs-container-separator` element (one per workspace). It's placed BEFORE the native clear button if that exists, otherwise appended. This matches what Tidy Tabs does so the layout stays consistent.

The XUL is a `<toolbarbutton>` with `command="cmd_zenAutoOrganize"`. The wand icon SVG is inline. CSS in `userChrome.css` handles the wiggle animation on the `.zao-wiggling` class (added/removed by `handleOrganizeClick`'s `wiggleButton`).

## Why workspace hooks

Each workspace has its own separator element. When you switch workspaces, Zen recreates the separator. Our button on the previous separator is still there but invisible; the new separator has no button. We invalidate `domCache.separators` and re-run `addButtonToAllSeparators()` to put a button on the new one.

## The command pattern

Standard Firefox/Zen wires menu items and toolbar buttons via `command` IDs in a central commandset. The element that triggers the action sets `command="cmd_zenAutoOrganize"`, and a single listener on the commandset dispatches based on `event.target.id`. We use that pattern for consistency — anything else that wants to trigger a tidy can just reference the same command.
