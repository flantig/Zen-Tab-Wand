# `modules/browser-hooks.mjs` — Tab context menu + restore-color hook + pref observer

Three pieces of browser-context wiring:

1. **Tab right-click submenu** — `Add "<hostname>" to Rule…` injected into the tab context menu.
2. **TabGroupCreate listener** — re-applies rule colors when Zen restores groups on startup.
3. **`minimal-style` pref observer** — re-syncs group styling immediately when the user toggles the pref.

## Exports

| Name | Notes |
|---|---|
| `setupTabContextMenu()` | Installs the right-click submenu. Idempotent — guarded with a `_zaoContextMenuInstalled` expando. |
| `teardownTabContextMenu()` | Removes the submenu + its listeners. Called from `auto-organize.uc.mjs`'s `cleanup()`. |
| `setupTabGroupCreateHook()` | Listens on `gBrowser.tabContainer` for `TabGroupCreate` to re-apply per-rule colors. |
| `setupMinimalStylePrefObserver()` / `teardownMinimalStylePrefObserver()` | `Services.prefs.addObserver` for live minimal-style toggling across all workspaces. |

## Tab context submenu

When the user opens the tab right-click menu on any tab, our parent `<menu>` element shows:

```
Add "<hostname>" to Rule…   ← parent label, dynamically updated
  ├── Calendar                ← every current rule as a child <menuitem>
  ├── Dev
  ├── ✓ Google Utils          ← rules already containing this hostname: ✓ + disabled
  ├── Shopping
  ├── ──────────────          ← <menuseparator>
  └── Skip                    ← or ✓ Skip if already in the skip list
```

Click a rule → `applyToRule(tab, ruleName, currentGroupEl)` appends the hostname to that rule's `domains[]`. Click Skip → the hostname is appended to `extensions.zen-auto-organize.skip-domains-json`. The tab is NOT moved — only the persisted lists grow. The user runs the wand afterwards to actually sort.

The submenu rebuilds on every `popupshowing` so rule edits made in the settings UI are reflected immediately. The parent is hidden when the right-clicked tab has no hostname (e.g. `about:blank`).

### Why not a passive event listener?

A previous design listened to Zen's `TabGrouped` event globally and auto-added the hostname whenever a tab joined a group. It had to be deleted because Zen dispatches `TabGrouped` asynchronously and for non-user reasons: after we explicitly ungroup a tab via `gBrowser.ungroupTab`, Zen's session bookkeeping fires a stale `TabGrouped` to re-attach it. Distinguishing genuine user actions from these re-attaches turned out to be impossible from event metadata alone. The explicit submenu replaces all that with one click of explicit user intent — no events, no race windows, no markers.

## TabGroupCreate flow

Fires when any tab-group element connects to the DOM — including ALL groups restored from session on Zen startup. The handler:

1. Reads the group's `label`.
2. Looks up a matching rule.
3. If the group has a matching rule, defers one tick (so Zen's own color setup finishes) then calls `applyGroupAppearance(group, rule)`.

This is why custom rule colors, gradients, and icons survive across Zen restarts even when Zen's session storage forgets them.

## minimal-style pref observer

`Services.prefs.addObserver` attaches to the global prefs branch and would survive window close (leaking a window reference) if we didn't tear it down. The observer is installed in `setupMinimalStylePrefObserver` and removed in `teardownMinimalStylePrefObserver`, wired into the entry script's `cleanup()`.

On change, it calls `syncAllGroupColors(null, rules)` (null = walk every workspace, not just the active one) so the minimal-style change is visible everywhere immediately.
