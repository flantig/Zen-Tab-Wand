# `modules/tabs.mjs` — Tab enumeration

Helpers to extract metadata from individual tabs + the eligibility filter used by Pass 1. Also exports the lightweight `domCache` used by the toolbar button injection.

## Exports

| Name | Notes |
|---|---|
| `getTabTitle(tab)` | label attribute → `.tab-label` text content fallback. |
| `getTabUrl(tab)` | `tab.linkedBrowser.currentURI.spec` (or fallbacks). |
| `getHostname(url)` | Returns `""` for `about:*` URLs. Strips leading `www.`. |
| `getEligibleTabs()` | Returns `{ workspaceId, tabs[] }` for the active workspace. Each tab info: `{ id, title, url, hostname, currentGroup, _tab }`. |
| `domCache` | Lazy lookup for `.pinned-tabs-container-separator` and `commandset#zenCommandSet`. Invalidate on workspace change. |

## Eligibility rules

A tab is eligible when it's:
- Connected to the DOM
- In the active workspace (`zen-workspace-id` matches `gZenWorkspaces.activeWorkspace`)
- NOT pinned, empty (`zen-empty-tab`), glance (`zen-glance-tab`), or essential (`zen-essential`)

Grouped tabs ARE eligible — Pass 1 may want to move them between groups if their current placement disagrees with the rules.

## Why `currentGroup` is included

Pass 1 buckets tabs into `byGroup` (needs to move), `unmatched` (no rule), and `alreadyCorrect` (already in the right group). Knowing the current group label upfront avoids a second DOM walk inside `runPass1`.
