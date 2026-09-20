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

// Build tag — mirrors theme.json's `version` for shipped releases, and gets a
// `+tag.N` suffix for in-progress iterative builds so the Browser Console
// reveals which build is actually running (vs. a stale module cache).
export const BUILD_VERSION = "1.0.6";

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
  SKIP_DOMAINS_PREF: "extensions.zen-auto-organize.skip-domains-json",
  CUSTOM_ICONS_PREF: "extensions.zen-auto-organize.custom-icons-json",
  // Set of tab-group LABELS currently collapsed. JSON-encoded string array.
  // Updated on every collapse-toggle; re-applied on every TabGroupCreate so
  // session restore preserves collapsed/expanded state across browser
  // restarts (Zen's own session save loses the `collapsed` attribute).
  COLLAPSED_GROUPS_PREF: "extensions.zen-auto-organize.collapsed-groups-json",
  MINIMAL_STYLE_PREF: "extensions.zen-auto-organize.minimal-style",
  STRICT_RULES_PREF: "extensions.zen-auto-organize.strict-rules",
  MATCH_MODE_PREF: "extensions.zen-auto-organize.match-mode",
  GRADIENT_STYLE_PREF: "extensions.zen-auto-organize.gradient-style",

  // AI Sorting (Pass 2). Engine governed by AI_ENGINE_PREF:
  //   "off"    — no AI pass
  //   "local"  — Firefox's bundled ML engine (modules/ai.mjs), existing + new groups
  //              (new-group clustering added via TIDY_FUSION — see ai.mjs)
  //   "ollama" — local Ollama daemon (modules/ollama.mjs), existing + new groups
  AI_ENGINE_PREF: "extensions.zen-auto-organize.ai-engine",
  AI_TITLE_LEARNING_PREF: "extensions.zen-auto-organize.ai-title-learning",
  AI_EXISTING_BEHAVIOR_PREF: "extensions.zen-auto-organize.ai-existing-behavior",
  AI_NEW_GROUP_BEHAVIOR_PREF: "extensions.zen-auto-organize.ai-new-group-behavior",
  AI_OLLAMA_HOST_PREF: "extensions.zen-auto-organize.ai-ollama-host",
  AI_OLLAMA_MODEL_PREF: "extensions.zen-auto-organize.ai-ollama-model",
  AI_OLLAMA_WARMUP_PREF: "extensions.zen-auto-organize.ai-ollama-warmup",
  // One-shot flags: set true after the user dismisses the first-time AI
  // engine resource-warning modal. Each engine has its own acknowledgement.
  OLLAMA_ACKNOWLEDGED_PREF: "extensions.zen-auto-organize.ollama-acknowledged",
  LOCAL_ACKNOWLEDGED_PREF: "extensions.zen-auto-organize.local-acknowledged",
  AI_OLLAMA_HOST_DEFAULT: "http://localhost:11434",
  AI_OLLAMA_MODEL_DEFAULT: "qwen2.5:1.5b",

  // Local-AI thresholds. The smart-tab-embedding model's similarity scores are
  // compressed into a narrow band — correct picks land around 0.25-0.45 raw —
  // so 0.65 (with the 0.10 boost giving effective raw of 0.55) acts as a
  // deliberately strict high-precision filter. Rules do the heavy lifting;
  // local AI only fires on slam dunks.
  AI_EXISTING_GROUP_THRESHOLD: 0.65,    // min (raw + boost) cosine sim for "tab belongs to existing group"
  AI_EXISTING_GROUP_BOOST: 0.10,        // added to existing-group sim
  AI_EMBEDDING_BATCH_SIZE: 5,           // tabs per parallel embedding batch (small-workspace default)
  // Raw cosine bar for greedily clustering LEFTOVER (no-existing-group-match)
  // tabs into brand-new groups (TIDY_FUSION, modules/ai.mjs clusterEmbeddings).
  // Deliberately looser than AI_EXISTING_GROUP_THRESHOLD's effective ~0.55 raw —
  // these tabs already failed the strict existing-group bar, so this is a
  // lower bar for "loosely on the same topic" rather than "slam dunk".
  TIDY_LOW: 0.45,
  // Cosine-similarity bar for TIDY_FUSION's post-clustering fragmentation
  // merge (modules/dedupe.mjs mergeSimilarClusters — same idea as
  // ai.mjs's own inline Fresh 3rd-pass centroid merge, FRESH_MERGE_THRESHOLD
  // — a LOCAL const in ai.mjs, not part of this CONFIG object). Looser than
  // TIDY_LOW, in the same DIRECTION as the gap between Fresh's own two
  // thresholds (0.55 -> 0.40) though not the same magnitude (0.45 -> 0.35
  // here is a 0.10 gap, Fresh's is 0.15) — for a MULTI-member raw cluster, a
  // centroid average tends to sit closer to other related clusters'
  // centroids than any single raw pairwise comparison did, since per-tab
  // noise gets averaged out, so a looser bar stays meaningfully selective
  // while catching what TIDY_LOW's single-pass greedy pairing missed. NOTE
  // (found by adversarial review): this rationale doesn't hold for a
  // loner-vs-loner comparison — a size-1 raw cluster's "centroid" IS its
  // one raw embedding, no averaging happens, so two loners can merge here
  // purely because 0.35 < TIDY_LOW even though TIDY_LOW already rejected
  // that same pairwise similarity as not even loosely related. That's
  // intentional (a loner deserves a second, looser chance to join
  // something), not a bug, but it's a deliberate 0.10 relaxation of
  // TIDY_LOW's own calibration for that specific case, not "noise
  // averaging out" — don't read too much precision into this number. Kept
  // as its own constant rather than reusing ai.mjs's FRESH_MERGE_THRESHOLD
  // or this file's NAME_COLLISION_MERGE_THRESHOLD below — same "don't
  // couple unrelated tuning knobs" reasoning as keeping
  // NAME_COLLISION_MERGE_THRESHOLD itself distinct from FRESH_MERGE_THRESHOLD.
  TIDY_MERGE_THRESHOLD: 0.35,

  // Cosine-similarity bar for the shared name-collision merge/disambiguate
  // decision (modules/dedupe.mjs), used by TIDY_FUSION, Fresh's safety net,
  // and Ollama's post-collision check. Distinct from ai.mjs's local
  // FRESH_MERGE_THRESHOLD and this file's TIDY_MERGE_THRESHOLD because it
  // governs a conceptually different decision — future tuning of one
  // shouldn't silently move the others.
  //
  // MUST stay meaningfully BELOW both FRESH_MERGE_THRESHOLD (0.40) and
  // TIDY_MERGE_THRESHOLD (0.35), not just "distinct" from them — this check
  // runs on the SAME centroids the fragmentation-merge pass already ran on,
  // AFTER that pass, for groups that pass already declined to merge. If this
  // bar sits at or above that pass's own bar, nothing can ever clear it
  // (anything that would have cleared an equal-or-lower bar already got
  // merged by the earlier pass), making the merge branch of
  // resolveNameCollisions dead code for Local/Fresh. This was a real,
  // reproduced regression (found by adversarial review) at the previous
  // value of 0.40: two separate "Google" clusters (mail.google.com vs
  // docs.google.com) that used to correctly merge via the old exact-name-
  // match safety net instead produced "Google" and "Google (Google)" — a
  // redundant, broken name for the exact case this mechanism exists to
  // catch. Set below TIDY_MERGE_THRESHOLD (the lower of the two upstream
  // bars) rather than just below FRESH_MERGE_THRESHOLD, so the safety net
  // stays live for BOTH paths, not just Fresh. A literal name collision is
  // itself corroborating evidence beyond raw content similarity — two
  // clusters landing on the same name isn't just "somewhat similar
  // content", it's "somewhat similar content AND agreement on what to call
  // it" — so it's correct for that extra signal to tip the balance toward
  // merging at a looser content-similarity bar than either upstream pass
  // used alone.
  //
  // Verified via the Marionette harness (phase4_name_collision_threshold.py):
  // the Google/Google scenario now merges correctly at this value and did
  // NOT merge at the old 0.40 (confirmed both ways, real embeddings,
  // temporarily reverting the constant for a true before/after). NOTE —
  // corrected after an earlier draft of this comment overclaimed:
  // phase3_merge_scenarios.py's same-hostname-unrelated-topics guard
  // exercises TIDY_MERGE_THRESHOLD / mergeSimilarClusters (a DIFFERENT
  // upstream pass), not this threshold or resolveNameCollisions at all — it
  // is NOT evidence for this specific mechanism and citing it here was
  // wrong (found by adversarial review).
  //
  // KNOWN, ACCEPTED-BUT-FLAGGED TRADE-OFF (also found by adversarial
  // review, using this session's own Marionette test data): at 0.30, two
  // GENUINELY UNRELATED real groups that happen to land on the same
  // GENERIC fallback name (e.g. both hit nameClusterFromHostnames' bare
  // hostname-stitch fallback, or both get a generic single-word intent
  // label like "Reading") can merge if their real content similarity
  // clears 0.30 — a band this file's own AI_EXISTING_GROUP_THRESHOLD
  // comment already describes as "compressed, hard-to-discriminate" even
  // for genuinely correct picks. Demonstrated concretely: two unrelated
  // synthetic pages ("Google Drive - My Drive" / "Notion - Getting
  // Started") both fell through to the same degenerate hostname-stitch
  // name and merged at a real ~0.31 similarity — see
  // phase4_name_collision_threshold.py / phase4_fixed3.log. This is a
  // strictly LOOSER safety net than the old pre-dedupe.mjs behavior it's
  // restoring parity with for Ollama's no-consent case (merge on name
  // alone, zero content check), so it's not a new category of risk, but it
  // is a real, evidenced increase in false-positive surface for Local/
  // Fresh's own safety net vs. the immediately-prior 0.40 value. Left as-is
  // pending a product decision on whether to accept this trade-off or add
  // a secondary signal (e.g. requiring the colliding name to be
  // non-generic, or a minimum-confidence gate) before merging on name-
  // collision alone at this similarity band.
  NAME_COLLISION_MERGE_THRESHOLD: 0.30,

  // Local-AI chunking. When the count of unmatched tabs to embed exceeds the
  // chunking threshold, the engine switches to a more conservative pipeline:
  //   - Hostname dedupe: only one tab per unique hostname is embedded; the
  //     resulting embedding is reused for all siblings on the same domain.
  //   - Yield between batches: `await setTimeout(0)` after each batch keeps
  //     the event loop alive so the browser doesn't freeze.
  // Together these keep the AI pass responsive on very large workspaces.
  AI_LOCAL_CHUNK_THRESHOLD: 75,         // unmatched count above which chunking + dedupe kicks in
  AI_LOCAL_BATCH_SIZE_PREF: "extensions.zen-auto-organize.ai-local-batch-size",
  AI_LOCAL_BATCH_SIZE_DEFAULT: 30,      // pref default; user-overridable
  AI_LOCAL_CONFIRM_THRESHOLD: 500,      // unmatched count above which a confirmation modal is shown before Pass 2

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
  { name: "AI Tools", domains: ["chat.openai.com", "chatgpt.com", "gemini.google.com", "perplexity.ai", "claude.ai", "copilot.microsoft.com", "deepseek.com"] },
  { name: "Dev",      domains: ["dashboard.render.com", "github.com", "stackoverflow.com", "gitlab.com", "developer.mozilla.org", "npmjs.com", "docs.github.com"] },
  { name: "Shopping", domains: ["amazon.com", "staples.com", "ebay.com", "walmart.com", "target.com"] },
  { name: "Social",   domains: ["reddit.com", "x.com", "bsky.app", "linkedin.com", "threads.net"] },
  { name: "Music",    domains: ["open.spotify.com", "soundcloud.com", "music.youtube.com", "mixcloud.com"] },
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
