# `modules/rules.mjs` — Rules data layer

All read/write access to the rules pref + the file fallback. Cleans malformed input so callers can trust the returned shape.

## Exports

| Name | Returns | Notes |
|---|---|---|
| `readRulesPref()` | `Rule[] \| null` | Reads the JSON pref, validates each entry, drops rules with empty `name` or no usable `domains`/`titleTerms`. Returns `null` if the pref is unset or unparseable. |
| `sanitizeRules(rules, opts?)` | `Rule[]` | Shared rule cleaner used by pref reads, `rules.json` validation, and Backup & Restore import. Trims strings, drops invalid colors, clamps icons, and drops incomplete rules unless `keepIncomplete` is true. |
| `writeRulesPref(rules)` | void | Serializes and stores. |
| `validateRules(data)` | `Rule[]` | For rules.json file content — throws on bad input. |
| `loadRules()` | async `Rule[]` | Precedence: pref → rules.json file → `DEFAULT_RULES`. |
| `isMinimalStyle()` | bool | Reads the `minimal-style` pref. |
| `isStrictRulesEnforced()` | bool | Reads the `strict-rules` pref (default false). When on, click-handler ejects tabs that do not match their current group under the active match mode. |
| `getMatchMode()` | `"url-only" \| "title-only" \| "url-then-title" \| "title-then-url"` | Reads the global URL/title matching priority. Unknown values fall back to `"url-then-title"`. |
| `getGradientStyle()` | string | Reads the global two-color gradient style. Unknown values fall back to `"left-right"`. |
| `readSkipDomainsPref()` | `string[]` | Reads the JSON skip-domains pref. Returns `[]` if unset. |
| `writeSkipDomainsPref(domains)` | void | Serializes and stores the skip-domains list. |
| `getAIEngine()` | `"off" \| "local" \| "ollama"` | Normalized read of the engine pref (unknown / empty → `"off"`). |
| `getOllamaHost()` | string | Ollama base URL, falls back to default. |
| `getOllamaModel()` | string | Ollama model name, falls back to default. |
| `isOllamaWarmupEnabled()` | bool | Whether to preload + keep the model warm. |
| `getAIExistingBehavior()` | `"always-add" \| "transient"` | What to do when AI moves a tab into an existing rule-matched group. |
| `getAINewGroupBehavior()` | string | One of: `"auto-add"`, `"transient"`, `"prompt"`, `"fresh-categories"`, `"identify-only"`. |

## Rule shape

```js
{
  name: "Calendar",
  domains: ["calendar.google.com", "connect.garmin.com"],
  titleTerms: ["schedule"], // optional — case-insensitive substring matches
  color: "blue",   // optional — Zen palette name OR hex like "#abc"
  color2: "#8cf",  // optional — second color for a gradient
  icon: "📅"       // optional — plain-text icon or custom:<id>
}
```

`domains` and `titleTerms` are both optional at the JSON boundary, but a runnable rule needs a name plus at least one domain or title term. `sanitizeRules` is permissive on `color` and `color2`: accepts both a Zen palette name and a hex value. Anything else gets dropped. Plain emoji/text icons are capped to 12 characters; custom icon references are capped to 128 characters.

The built-in defaults intentionally stay small and only seed fresh installs or fallback loads: Calendar, AI Tools, Dev, Shopping, Social, Music, and Search. Once a user has a rules pref, default changes do not overwrite it.

## Why the pref is a JSON string, not a struct

Sine's preference system only supports single-line `string`/`checkbox`/`dropdown`/`separator`. There's no array/textarea type. To store a list of rules at all, we encode as JSON. The widget reads/writes through this pref so all state is on the pref system (and observable by the widget's `nsPref:changed` listener).

## Pref change → UI refresh

External writes — from the tab right-click "Add to Rule…" submenu (browser-hooks.mjs), the Backup & Restore import (widget.mjs), or AI Pass 2 (ai.mjs / ollama.mjs) — trigger `nsPref:changed`. The settings widget registers an `nsIPrefBranch.addObserver` and refreshes the visible table on every change.
