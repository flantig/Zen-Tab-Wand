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

export const LOG = "[ZenTabWand]";

// +tag.N suffix (dev builds only) flags a stale module-cache load in the Browser Console.
export const BUILD_VERSION = "1.0.6";

export const CONFIG = {
  MAX_INIT_CHECKS: 50,
  INIT_CHECK_INTERVAL: 100,

  // Sine's loadPrefs() is async — the dialog is added to the DOM before its content is populated.
  INJECT_POLL_INTERVAL_MS: 100,
  INJECT_MAX_POLL_ATTEMPTS: 30,

  WIGGLE_DURATION_MS: 600,

  // Lower = lighter invert/pale variant when mixing the user's hex with white.
  HEX_INVERT_MIX_PERCENT: 55,
  HEX_PALE_MIX_PERCENT: 20,

  // Keep in sync with userChrome.css, preferences.json, and the Sine mod entry in mods.json.
  BUTTON_ID: "tab-wand-button",
  COMMAND_ID: "cmd_zenAutoOrganize",
  MOD_ID: "zen-tab-wand",

  RULES_PREF: "extensions.zen-auto-organize.rules-json",
  SKIP_DOMAINS_PREF: "extensions.zen-auto-organize.skip-domains-json",
  CUSTOM_ICONS_PREF: "extensions.zen-auto-organize.custom-icons-json",
  // Re-applied on every TabGroupCreate: Zen's own session save loses the `collapsed` attribute.
  COLLAPSED_GROUPS_PREF: "extensions.zen-auto-organize.collapsed-groups-json",
  MINIMAL_STYLE_PREF: "extensions.zen-auto-organize.minimal-style",
  STRICT_RULES_PREF: "extensions.zen-auto-organize.strict-rules",
  MATCH_MODE_PREF: "extensions.zen-auto-organize.match-mode",
  GRADIENT_STYLE_PREF: "extensions.zen-auto-organize.gradient-style",

  // AI_ENGINE_PREF values: "off" | "local" (modules/ai.mjs) | "ollama" (modules/ollama.mjs).
  AI_ENGINE_PREF: "extensions.zen-auto-organize.ai-engine",
  AI_TITLE_LEARNING_PREF: "extensions.zen-auto-organize.ai-title-learning",
  AI_EXISTING_BEHAVIOR_PREF: "extensions.zen-auto-organize.ai-existing-behavior",
  AI_NEW_GROUP_BEHAVIOR_PREF: "extensions.zen-auto-organize.ai-new-group-behavior",
  AI_OLLAMA_HOST_PREF: "extensions.zen-auto-organize.ai-ollama-host",
  AI_OLLAMA_MODEL_PREF: "extensions.zen-auto-organize.ai-ollama-model",
  AI_OLLAMA_WARMUP_PREF: "extensions.zen-auto-organize.ai-ollama-warmup",
  // Each AI engine gets its own one-shot resource-warning-modal acknowledgement.
  OLLAMA_ACKNOWLEDGED_PREF: "extensions.zen-auto-organize.ollama-acknowledged",
  LOCAL_ACKNOWLEDGED_PREF: "extensions.zen-auto-organize.local-acknowledged",
  AI_OLLAMA_HOST_DEFAULT: "http://localhost:11434",
  AI_OLLAMA_MODEL_DEFAULT: "qwen2.5:1.5b",

  // The smart-tab-embedding model compresses similarity scores into a narrow band —
  // correct picks land around 0.25-0.45 raw — so 0.65 (0.55 raw + 0.10 boost) is a
  // deliberately strict filter; rules do the heavy lifting, local AI only fires on slam dunks.
  AI_EXISTING_GROUP_THRESHOLD: 0.65,
  AI_EXISTING_GROUP_BOOST: 0.10,
  AI_EMBEDDING_BATCH_SIZE: 5,
  // Looser than AI_EXISTING_GROUP_THRESHOLD: these tabs already failed that strict bar,
  // so this is "loosely on the same topic" rather than "slam dunk" (TIDY_FUSION, ai.mjs clusterEmbeddings).
  TIDY_LOW: 0.45,
  // Looser than TIDY_LOW so a raw cluster that failed the first pass (or a lone tab) gets a
  // second, looser chance to merge (modules/dedupe.mjs mergeSimilarClusters). Kept distinct from
  // FRESH_MERGE_THRESHOLD (ai.mjs) and NAME_COLLISION_MERGE_THRESHOLD below so tuning one never
  // silently moves the others.
  TIDY_MERGE_THRESHOLD: 0.35,

  // Must stay below both FRESH_MERGE_THRESHOLD and TIDY_MERGE_THRESHOLD: this check runs on the
  // same centroids those merge passes already declined to merge, so an equal-or-higher bar would
  // make this merge branch dead code. A literal name collision is corroborating evidence beyond
  // content similarity, so a looser bar than either upstream pass is justified — gated by
  // dedupe.mjs's etld1FamilyOverlap to avoid merging unrelated groups that coincidentally land on
  // the same generic name.
  NAME_COLLISION_MERGE_THRESHOLD: 0.30,

  // Above this many unmatched tabs: dedupe embeddings by hostname (one embed call per unique
  // domain) and yield between batches so the browser doesn't freeze.
  AI_LOCAL_CHUNK_THRESHOLD: 75,
  AI_LOCAL_BATCH_SIZE_PREF: "extensions.zen-auto-organize.ai-local-batch-size",
  AI_LOCAL_BATCH_SIZE_DEFAULT: 30,
  AI_LOCAL_CONFIRM_THRESHOLD: 500,

  RULES_URL: "chrome://sine/content/zen-tab-wand/rules.json",
  CSS_URL: "chrome://sine/content/zen-tab-wand/userChrome.css",

  POPOVER_GAP_PX: 8,
};

// Zen uses U+200B (zero-width space) as the `label` placeholder for an unnamed tab
// group — invisible in source, so it's named here.
export const ZEN_UNSET_LABEL = "​";
export const isUnsetLabel = (label) => !label || label === ZEN_UNSET_LABEL;

// Used if rules.json is missing/malformed and the Sine pref is unset.
export const DEFAULT_RULES = [
  { name: "Calendar", domains: ["calendar.google.com", "connect.garmin.com"] },
  { name: "AI Tools", domains: ["chat.openai.com", "chatgpt.com", "gemini.google.com", "perplexity.ai", "claude.ai", "copilot.microsoft.com", "deepseek.com"] },
  { name: "Dev",      domains: ["dashboard.render.com", "github.com", "stackoverflow.com", "gitlab.com", "developer.mozilla.org", "npmjs.com", "docs.github.com"] },
  { name: "Shopping", domains: ["amazon.com", "staples.com", "ebay.com", "walmart.com", "target.com"] },
  { name: "Social",   domains: ["reddit.com", "x.com", "bsky.app", "linkedin.com", "threads.net"] },
  { name: "Music",    domains: ["open.spotify.com", "soundcloud.com", "music.youtube.com", "mixcloud.com"] },
  { name: "Search",   domains: ["google.com", "duckduckgo.com"] },
];

// Storing the color *name* (not hex) lets Zen handle light/dark variants via its native
// --tab-group-color-{name}* CSS vars; hex is only a fallback swatch for about:preferences,
// where those vars aren't defined (see color-picker.mjs for the runtime override).
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

export const GRADIENT_STYLES = {
  "left-right": (a, b) => `linear-gradient(90deg, ${a}, ${b})`,
  "right-left": (a, b) => `linear-gradient(270deg, ${a}, ${b})`,
  "top-bottom": (a, b) => `linear-gradient(180deg, ${a}, ${b})`,
  "bottom-top": (a, b) => `linear-gradient(0deg, ${a}, ${b})`,
  "diagonal-down": (a, b) => `linear-gradient(135deg, ${a}, ${b})`,
  "diagonal-up": (a, b) => `linear-gradient(45deg, ${a}, ${b})`,
  "radial": (a, b) => `radial-gradient(circle at center, ${a}, ${b})`,
};
export const DEFAULT_GRADIENT_STYLE = "left-right";

export const isValidHex = (s) => typeof s === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s);
export const isZenColorName = (s) => typeof s === "string" && ZEN_COLOR_NAMES.has(s);

// Falls back to our hex only when the live Zen CSS var isn't defined (e.g. preferences scope).
export const bgForName = (name) =>
  `var(--tab-group-color-${name}, ${HEX_BY_NAME.get(name) || "transparent"})`;

// about:preferences is a XUL-rooted document; elements need this namespace to avoid inheriting chrome theming.
export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const h = (tag, opts) => {
  const el = document.createElementNS(HTML_NS, tag);
  if (opts?.class) el.className = opts.class;
  if (opts?.text != null) el.textContent = opts.text;
  return el;
};
