# `modules/groups.mjs` — Tab-group manipulation

Everything that pokes at `<tab-group>` elements: lookup, color application, dissolution, consolidation, the ungrouped-to-top sort.

## Exports

| Name | Notes |
|---|---|
| `findExistingGroup(name, workspaceId)` | Returns the group element or null. Tries the direct attribute selector first, falls back to label-only + child-tab verification. |
| `expandIfCollapsed(groupEl)` | If `[collapsed=true]`, flip to expanded. We rely on this before moving tabs in. |
| `applyGroupColor(groupEl, color)` | Two paths: named Zen color → `group.color = name` (Zen's setter wires up light/dark variants). Hex → override `--tab-group-color*` custom properties with derived `invert` and `pale` so collapsed state stays readable. |
| `applyGroupAppearance(groupEl, rule)` | Applies the rule's solid color, optional `color2` gradient, and optional icon custom property/class. |
| `clearGroupColor(groupEl)` | Strips our inline overrides. |
| `syncAllGroupColors(workspaceId, rules)` | Walks every rule-matched group in the workspace and either applies its rule color or toggles `.zao-minimal` (when minimal-style pref is on). |
| `moveUngroupedToTop(workspaceId)` | Pushes any remaining ungrouped tab to the top of the workspace's `tabsContainer`, preserving relative DOM order. |
| `dissolveStaleGroups(workspaceId, rules)` | Moves tabs out of any group whose label isn't in the rules, then removes the empty group. Runs BEFORE Pass 1. |
| `consolidateDuplicateGroups(workspaceId)` | Merges multiple groups sharing a label into the first; removes the empty duplicates. Runs FIRST so `findExistingGroup` sees a deduplicated state. |

## Named vs hex color application

Zen's tab-group has a native `color` JS property setter that writes:
```css
--tab-group-color: var(--tab-group-color-blue);
--tab-group-color-invert: var(--tab-group-color-blue-invert);
--tab-group-color-pale: var(--tab-group-color-blue-pale);
```

So `group.color = "blue"` cascades correctly through Zen's light/dark variant system. We use this path for any color stored as a Zen palette name.

For hex, the setter would write `var(--tab-group-color-#abc)` which is undefined → no effect. We bypass the setter and override the three CSS custom properties directly with the hex (and lighter `color-mix` variants for `invert`/`pale`).

## Gradients and icons

`color2` is optional. When both `color` and `color2` are valid, `applyGroupAppearance` writes `--zao-tab-group-gradient` and `.zao-has-gradient`; CSS paints the group label with a two-color linear gradient. `color` remains the solid fallback for line/readability variables.

`icon` is optional plain text. It is stored as `--zao-tab-group-icon` and rendered before the visible group label by CSS. Minimal style clears colors/gradients but keeps the icon.

## Stale group cleanup is destructive

`dissolveStaleGroups` removes any group whose label doesn't match a rule — including user-created ones the user might want to keep. To protect a manual group, add a same-named row to the rules table (the domains array can stay empty).

## Why a "consolidate" pass exists

Before the find-existing-by-fallback fix, applying Pass 1 against a workspace where Zen's `tab-group[zen-workspace-id="..."]` attribute lookup failed would create new groups even though same-name ones existed. Users ended up with duplicate "Shopping" groups. Consolidation self-heals: every tidy click merges any same-name groups back into one.
