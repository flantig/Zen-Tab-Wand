# `modules/config.mjs` — Constants & palette

Holds every magic value the rest of the codebase references. No runtime state, no DOM access.

## Exports

| Name | Type | Purpose |
|---|---|---|
| `LOG` | string | Prefix for all console messages (`"[ZenTabWand]"`) |
| `BUILD_VERSION` | string | Mirrors theme.json's `version` for shipped releases (e.g. `"1.0.1"`); for in-progress iterative builds gets a `+tag.N` suffix so the Browser Console reveals which build is loaded vs. a stale module cache. |
| `CONFIG` | object | Pref names, IDs, polling intervals, chrome:// URLs, AI-tuning constants |
| `ZEN_UNSET_LABEL` | string | U+200B placeholder Zen uses for new unnamed tab-groups |
| `isUnsetLabel(label)` | fn | Detects an unnamed group |
| `DEFAULT_RULES` | array | Hardcoded fallback if rules.json + pref are both missing/malformed |
| `PRESET_COLORS` | array | The 9 Zen palette colors + hex fallback for picker swatches |
| `ZEN_COLOR_NAMES` | Set | Set of valid Zen color names for fast lookup |
| `HEX_BY_NAME` | Map | name → hex (overwritten at runtime by `color-picker.mjs` with live theme values) |
| `GRADIENT_STYLES` / `DEFAULT_GRADIENT_STYLE` | object / string | Maps stored gradient-style pref values to CSS gradient builders. Default is `"left-right"`. |
| `isValidHex(s)` | fn | true for `#abc` or `#abcdef` |
| `isZenColorName(s)` | fn | true if `s` is one of Zen's 9 palette names |
| `bgForName(name)` | fn | CSS `var(--tab-group-color-name, fallback-hex)` string for swatches |
| `HTML_NS` | string | `"http://www.w3.org/1999/xhtml"` |
| `h(tag, opts?)` | fn | `document.createElementNS(HTML_NS, tag)`; optional `{ class, text }` for the common case. Needed in about:preferences (XUL-rooted) |

## Why HTML_NS / h()

`about:preferences` is a XUL document. `document.createElement("button")` creates a XUL button, which picks up chrome theming (min-width, padding) that fights our custom layout. Forcing the HTML namespace makes our widget elements behave like normal HTML in any document.

## CONFIG fields cheat-sheet

```js
RULES_PREF                    // string pref holding the JSON-encoded rules array
SKIP_DOMAINS_PREF             // string pref holding the JSON-encoded skip-domains array
MINIMAL_STYLE_PREF            // bool pref for the address-bar styling toggle
STRICT_RULES_PREF             // bool pref — eject unmatched tabs from rule-named groups
MATCH_MODE_PREF               // string: url-only | title-only | url-then-title | title-then-url
GRADIENT_STYLE_PREF           // string: left-right | right-left | top-bottom | bottom-top | diagonal-down | diagonal-up | radial
AI_ENGINE_PREF                // string: "" | "local" | "ollama"
AI_EXISTING_BEHAVIOR_PREF     // "always-add" | "transient"
AI_NEW_GROUP_BEHAVIOR_PREF    // "auto-add" | "transient" | "prompt" | "fresh-categories" | "identify-only"
AI_OLLAMA_HOST_PREF           // string, default http://localhost:11434
AI_OLLAMA_MODEL_PREF          // string, default qwen2.5:1.5b
AI_OLLAMA_WARMUP_PREF         // bool, default true
RULES_URL                     // chrome:// path to rules.json (legacy fallback)
CSS_URL                       // chrome:// path to userChrome.css (fetched into prefs scope)
BUTTON_ID                     // toolbar wand button DOM id ("tab-wand-button")
COMMAND_ID                    // XUL command id for the button
MOD_ID                        // "zen-tab-wand" — kept for historical/debug use;
                              // dialog detection lives in prefs-ui.mjs's
                              // isOurDialog() which keys off the "Group Rules"
                              // separator label, not this id.

// AI tuning (local engine)
AI_EXISTING_GROUP_THRESHOLD   // 0.65 cosine-sim cutoff
AI_EXISTING_GROUP_BOOST       // 0.10 added to existing-group sim
AI_EMBEDDING_BATCH_SIZE       // 5 tabs per parallel batch

// Color picker
HEX_INVERT_MIX_PERCENT        // 55 — how much to lighten when mixing with white
HEX_PALE_MIX_PERCENT          // 20
POPOVER_GAP_PX                // 8 — popover offset from its swatch anchor
```

> **Note:** the pref-key prefix is `extensions.zen-auto-organize.*`. That's a legacy from the mod's earlier name; we kept it across the rename to `zen-tab-wand` so existing users' rules and settings carry over unchanged.
