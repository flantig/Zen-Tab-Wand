// Zen Tab Wand — constants, color palette, basic helpers.
// Loaded by every other module. Holds no runtime state.
//
// Chrome globals this codebase relies on (provided by Firefox/Zen, NOT imported):
//   Services         — Cu.import-equivalent global. We use Services.prefs and
//                      Services.wm. Docs: searchfox.org "Services.sys.mjs".
//   gBrowser         — the tab browser singleton inside browser.xhtml.
//   gZenWorkspaces   — Zen's workspaces manager (also in browser.xhtml).
//   MozXULElement    — Firefox helper for parseXULToFragment.
//   document.createXULElement(tag) — create a XUL element (vs HTML).
// See docs/chrome-globals.md for a longer reference.

export const LOG = "[AutoOrganize]";

export const CONFIG = {
  // Init polling — wait for gBrowser/gZenWorkspaces/separator to appear at startup.
  MAX_INIT_CHECKS: 50,
  INIT_CHECK_INTERVAL: 100,

  // Settings dialog inject polling — Sine's loadPrefs() is async, the dialog is added
  // to the DOM before its content is populated.
  INJECT_POLL_INTERVAL_MS: 100,
  INJECT_MAX_POLL_ATTEMPTS: 30,

  // Toolbar wand button: how long the click animation runs.
  WIGGLE_DURATION_MS: 600,

  // Hex-color application derives lighter "invert" / "pale" variants by mixing
  // the user's hex with white. Lower = lighter result.
  HEX_INVERT_MIX_PERCENT: 55,
  HEX_PALE_MIX_PERCENT: 20,

  // DOM ids + pref names — keep in sync with userChrome.css, preferences.json, and
  // the Sine mod entry in mods.json.
  BUTTON_ID: "tab-wand-button",
  COMMAND_ID: "cmd_zenAutoOrganize",
  MOD_ID: "zen-tab-wand",

  RULES_PREF: "extensions.zen-auto-organize.rules-json",
  MINIMAL_STYLE_PREF: "extensions.zen-auto-organize.minimal-style",

  // AI Sorting (Pass 2). Engine governed by AI_ENGINE_PREF:
  //   "off"    — no AI pass
  //   "local"  — Firefox's bundled ML engine (modules/ai.mjs), existing-groups only
  //   "ollama" — local Ollama daemon (modules/ollama.mjs), existing + new groups
  AI_ENGINE_PREF: "extensions.zen-auto-organize.ai-engine",
  AI_EXISTING_BEHAVIOR_PREF: "extensions.zen-auto-organize.ai-existing-behavior",
  AI_NEW_GROUP_BEHAVIOR_PREF: "extensions.zen-auto-organize.ai-new-group-behavior",
  AI_OLLAMA_HOST_PREF: "extensions.zen-auto-organize.ai-ollama-host",
  AI_OLLAMA_MODEL_PREF: "extensions.zen-auto-organize.ai-ollama-model",
  AI_OLLAMA_WARMUP_PREF: "extensions.zen-auto-organize.ai-ollama-warmup",
  AI_OLLAMA_HOST_DEFAULT: "http://localhost:11434",
  AI_OLLAMA_MODEL_DEFAULT: "qwen2.5:1.5b",

  // Local-AI thresholds. The smart-tab-embedding model's similarity scores are
  // compressed into a narrow band — correct picks land around 0.25-0.45 raw —
  // so 0.65 (with the 0.10 boost giving effective raw of 0.55) acts as a
  // deliberately strict high-precision filter. Rules do the heavy lifting;
  // local AI only fires on slam dunks.
  AI_EXISTING_GROUP_THRESHOLD: 0.65,    // min (raw + boost) cosine sim for "tab belongs to existing group"
  AI_EXISTING_GROUP_BOOST: 0.10,        // added to existing-group sim
  AI_EMBEDDING_BATCH_SIZE: 5,           // tabs per parallel embedding batch

  // chrome:// URLs served by Sine from this mod's directory.
  RULES_URL: "chrome://sine/content/zen-tab-wand/rules.json",
  CSS_URL: "chrome://sine/content/zen-tab-wand/userChrome.css",

  // Color picker popover: gap (px) between the popover and its swatch anchor.
  POPOVER_GAP_PX: 8,
};

// Zen uses U+200B (zero-width space) as the `label` attribute placeholder for a
// brand-new "Create tab group" that the user hasn't named yet. It's invisible in
// the source so we name it.
export const ZEN_UNSET_LABEL = "​";
export const isUnsetLabel = (label) => !label || label === ZEN_UNSET_LABEL;

// Fallback rules if rules.json is missing or malformed AND the Sine pref is unset.
export const DEFAULT_RULES = [
  { name: "Calendar", domains: ["calendar.google.com", "connect.garmin.com"] },
  { name: "AI Tools", domains: ["chat.openai.com", "gemini.google.com", "perplexity.ai"] },
  { name: "Dev",      domains: ["dashboard.render.com", "github.com", "stackoverflow.com"] },
  { name: "Shopping", domains: ["amazon.com", "staples.com", "ebay.com"] },
  { name: "Social",   domains: ["reddit.com", "x.com", "bsky.app"] },
  { name: "Search",   domains: ["google.com", "duckduckgo.com"] },
];

// Zen's named tab-group palette. Storing the *name* lets Zen handle light/dark variants
// via its native --tab-group-color-{name}* CSS variables. The hex column is the picker's
// fallback for rendering swatches in about:preferences (where Zen's chrome CSS vars
// aren't defined); we'll override it at runtime with the live theme color (see color-picker.mjs).
export const PRESET_COLORS = [
  { name: "blue",   hex: "#77A1E6" },
  { name: "purple", hex: "#E7AEFC" },
  { name: "cyan",   hex: "#88D6E0" },
  { name: "orange", hex: "#FFBC8C" },
  { name: "yellow", hex: "#F0D471" },
  { name: "pink",   hex: "#FFB0DD" },
  { name: "green",  hex: "#99F28D" },
  { name: "gray",   hex: "#B0BAC0" },
  { name: "red",    hex: "#E87474" },
];

export const ZEN_COLOR_NAMES = new Set(PRESET_COLORS.map((c) => c.name));
export const HEX_BY_NAME = new Map(PRESET_COLORS.map((c) => [c.name, c.hex]));

export const isValidHex = (s) => typeof s === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s);
export const isZenColorName = (s) => typeof s === "string" && ZEN_COLOR_NAMES.has(s);

// Background CSS for a swatch showing a named Zen color. Use the live var if defined
// (browser scope), fall back to our hex (preferences scope).
export const bgForName = (name) =>
  `var(--tab-group-color-${name}, ${HEX_BY_NAME.get(name) || "transparent"})`;

// HTML namespace for createElementNS. Needed in about:preferences (XUL-rooted document)
// so dynamically-created elements don't inherit chrome theming.
export const HTML_NS = "http://www.w3.org/1999/xhtml";
// Optional opts: { class, text } — convenience for common cases. Callers that
// need more (attributes, multiple children) can mutate the returned element.
export const h = (tag, opts) => {
  const el = document.createElementNS(HTML_NS, tag);
  if (opts?.class) el.className = opts.class;
  if (opts?.text != null) el.textContent = opts.text;
  return el;
};
