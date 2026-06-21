# `modules/pass1.mjs` — Pass 1 matcher + apply

The deterministic rule engine. Takes tab metadata + rules, produces an assignment plan; then executes it.

## Exports

| Name | Notes |
|---|---|
| `matchesDomain(hostname, pattern)` | Pattern semantics, see below. |
| `matchesTitle(title, term)` | Case-insensitive substring match for page titles. |
| `findGroupForTab(tabInfo, rules)` | First-match-wins. Returns the rule name or null. |
| `runPass1(tabs, rules)` | Pure planning. Returns `{ assignments, byGroup, unmatched, alreadyCorrect }`. |
| `applyPass1(byGroup, workspaceId, rules)` | DOM mutation. Creates groups, moves tabs, applies colors. Returns counts + errors. |

## Pattern semantics

| Pattern | Matches |
|---|---|
| `host.com` | the bare host AND any subdomain (`www.host.com`, `mail.host.com`) |
| `*.host.com` | subdomains only — NOT the bare host |

Order in the `domains` array within a rule doesn't matter. Order BETWEEN rules in the rules array matters — first-match-wins, so list more specific groups before more general ones (e.g. put `Calendar` with `calendar.google.com` BEFORE `Search` with `google.com`).

Title terms live in `titleTerms[]` and match if the page title contains the term, case-insensitively. The global match mode pref decides which source is checked: URL only, Title only, URL then Title, or Title then URL. Within each source, rule order is still first-match-wins.

## The four assignment buckets

For each tab, `runPass1` decides:

| Action | Bucket | Description |
|---|---|---|
| `leave` | `unmatched` | No rule matched — leave the tab wherever it is. |
| `stay` | `alreadyCorrect` | Rule matched AND tab is already in that group. |
| `move` | `byGroup` (target) | Rule matched, tab is in a different group. Move it. |
| `group` | `byGroup` (target) | Rule matched, tab is currently ungrouped. Group it. |

Only `byGroup` actually causes DOM mutation in `applyPass1`. The others are logged for visibility.

## Color application timing

`applyPass1` calls `applyGroupAppearance` on the target group AFTER moving tabs in. This applies solid colors, optional gradients, and icons. Doing it last avoids interleaving Zen's color update side effects with tab moves.

A separate `syncAllGroupColors` pass (in `click-handler.mjs`) runs after `applyPass1` to catch rule-matched groups that `applyPass1` didn't touch because their tabs were already in the right place.
