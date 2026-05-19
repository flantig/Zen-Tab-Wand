# `modules/rules.mjs` — Rules data layer

All read/write access to the rules pref + the file fallback. Cleans malformed input so callers can trust the returned shape.

## Exports

| Name | Returns | Notes |
|---|---|---|
| `readRulesPref()` | `Rule[] \| null` | Reads the JSON pref, validates each entry, drops rules with empty `name` or no usable `domains`. Returns `null` if the pref is unset or unparseable. |
| `writeRulesPref(rules)` | void | Serializes and stores. |
| `validateRules(data)` | `Rule[]` | For rules.json file content — throws on bad input. |
| `loadRules()` | async `Rule[]` | Precedence: pref → rules.json file → `DEFAULT_RULES`. |
| `isMinimalStyle()` | bool | Reads the `minimal-style` pref. |

## Rule shape

```js
{
  name: "Calendar",
  domains: ["calendar.google.com", "connect.garmin.com"],
  color: "blue"  // optional — Zen palette name OR hex like "#abc"
}
```

`readRulesPref` is permissive on `color`: accepts both a Zen palette name and a hex value. Anything else gets dropped.

## Why the pref is a JSON string, not a struct

Sine's preference system only supports single-line `string`/`checkbox`/`dropdown`/`separator`. There's no array/textarea type. To store a list of rules at all, we encode as JSON. The widget reads/writes through this pref so all state is on the pref system (and observable by the widget's `nsPref:changed` listener).

## Pref change → UI refresh

External writes (from `browser-hooks.mjs` when the user organizes manually) trigger `nsPref:changed`. `widget.mjs` registers an `nsIPrefBranch.addObserver` and refreshes the visible table.
