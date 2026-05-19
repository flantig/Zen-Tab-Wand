# `modules/config.mjs` — Constants & palette

Holds every magic value the rest of the codebase references. No runtime state, no DOM access.

## Exports

| Name | Type | Purpose |
|---|---|---|
| `LOG` | string | Prefix for all console messages (`"[AutoOrganize]"`) |
| `CONFIG` | object | Pref names, IDs, polling intervals, chrome:// URLs |
| `DEFAULT_RULES` | array | Hardcoded fallback if rules.json + pref are both missing/malformed |
| `PRESET_COLORS` | array | The 9 Zen palette colors + hex fallback for picker swatches |
| `ZEN_COLOR_NAMES` | Set | Set of valid Zen color names for fast lookup |
| `HEX_BY_NAME` | Map | name → hex (overwritten at runtime by `color-picker.mjs` with live theme values) |
| `isValidHex(s)` | fn | true for `#abc` or `#abcdef` |
| `isZenColorName(s)` | fn | true if `s` is one of Zen's 9 palette names |
| `bgForName(name)` | fn | CSS `var(--tab-group-color-name, fallback-hex)` string for swatches |
| `HTML_NS` | string | `"http://www.w3.org/1999/xhtml"` |
| `h(tag)` | fn | `document.createElementNS(HTML_NS, tag)` — needed in about:preferences (XUL-rooted) |

## Why HTML_NS / h()

`about:preferences` is a XUL document. `document.createElement("button")` creates a XUL button, which picks up chrome theming (min-width, padding) that fights our custom layout. Forcing the HTML namespace makes our widget elements behave like normal HTML in any document.

## CONFIG fields cheat-sheet

```js
RULES_PREF        // string pref holding the JSON-encoded rules array
MINIMAL_STYLE_PREF // bool pref for the address-bar styling toggle
RULES_URL         // chrome:// path to rules.json (legacy fallback)
CSS_URL           // chrome:// path to userChrome.css (fetched into prefs scope)
BUTTON_ID         // toolbar wand button DOM id
COMMAND_ID        // XUL command id for the button
MOD_ID            // matches the entry in mods.json — used to identify our settings dialog
```
