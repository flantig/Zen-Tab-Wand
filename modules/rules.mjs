// Zen Tab Wand — rules data layer.
// Reads/writes the rules JSON pref, validates rules.json file contents, and exposes
// the precedence chain (pref > file > built-in defaults).

import {
  CONFIG,
  DEFAULT_GRADIENT_STYLE,
  DEFAULT_RULES,
  GRADIENT_STYLES,
  LOG,
  ZEN_COLOR_NAMES,
  isValidHex,
} from "./config.mjs";

const cleanStringList = (value) =>
  Array.isArray(value)
    ? value.map((d) => String(d).trim()).filter((d) => d.length > 0)
    : [];

const keepColor = (value) => {
  if (typeof value !== "string") return null;
  const c = value.trim();
  return ZEN_COLOR_NAMES.has(c) || isValidHex(c) ? c : null;
};

const cleanRule = (r) => {
  const out = {
    name: typeof r?.name === "string" ? r.name.trim() : "",
    domains: cleanStringList(r?.domains),
    titleTerms: cleanStringList(r?.titleTerms),
  };
  const color = keepColor(r?.color);
  const color2 = keepColor(r?.color2);
  if (color) out.color = color;
  if (color2) out.color2 = color2;
  if (typeof r?.icon === "string") {
    const icon = r.icon.trim();
    if (icon) out.icon = icon.startsWith("custom:") ? icon.slice(0, 128) : icon.slice(0, 12);
  }
  return out;
};

const isRunnableRule = (r) =>
  r.name.length > 0 && (r.domains.length > 0 || r.titleTerms.length > 0);

// One sanitizer for every rule ingestion path. Keeping import, prefs, and
// rules.json on this path prevents compatibility fixes from drifting apart.
export const sanitizeRules = (rules, { keepIncomplete = false } = {}) => {
  const cleaned = Array.isArray(rules) ? rules.map(cleanRule) : [];
  return keepIncomplete ? cleaned : cleaned.filter(isRunnableRule);
};

/**
 * Read the rules pref.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.keepIncomplete=false]
 *   When true, in-progress rules (empty name or no match terms) are returned
 *   alongside complete ones. The settings widget passes this so a user can
 *   add a blank row, close the browser, and find it still waiting to be
 *   filled in next session. The wand-click pipeline (`loadRules`) uses the
 *   default — incomplete rules are no-ops at apply-time anyway, but keeping
 *   them out of the logs is cleaner.
 */
export const readRulesPref = ({ keepIncomplete = false } = {}) => {
  try {
    const raw = Services.prefs.getStringPref(CONFIG.RULES_PREF, "");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return sanitizeRules(parsed, { keepIncomplete });
  } catch (e) {
    console.warn(`${LOG} rules pref parse failed:`, e);
    return null;
  }
};

export const writeRulesPref = (rules) => {
  try {
    Services.prefs.setStringPref(CONFIG.RULES_PREF, JSON.stringify(rules));
  } catch (e) {
    console.error(`${LOG} failed to write rules pref:`, e);
  }
};

// Skip-domain list: hostnames or `*.host` patterns the tidy click never touches.
// Tabs matching any pattern are ejected from their group and parked at the top
// of the workspace before Pass 1 runs (see click-handler.mjs).
export const readSkipDomainsPref = () => {
  try {
    const raw = Services.prefs.getStringPref(CONFIG.SKIP_DOMAINS_PREF, "");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((d) => String(d).trim()).filter((d) => d.length > 0);
  } catch (e) {
    console.warn(`${LOG} skip-domains pref parse failed:`, e);
    return [];
  }
};

export const writeSkipDomainsPref = (domains) => {
  try {
    Services.prefs.setStringPref(CONFIG.SKIP_DOMAINS_PREF, JSON.stringify(domains));
  } catch (e) {
    console.error(`${LOG} failed to write skip-domains pref:`, e);
  }
};

// Collapsed-group persistence. Zen's session manager doesn't save the
// `collapsed` attribute on tab-groups, so they all come back expanded after
// a browser restart. We track which group labels were collapsed in a pref
// and re-apply on TabGroupCreate (session restore).
export const readCollapsedGroupsPref = () => {
  try {
    const raw = Services.prefs.getStringPref(CONFIG.COLLAPSED_GROUPS_PREF, "");
    if (!raw.trim()) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : []);
  } catch (e) {
    console.warn(`${LOG} collapsed-groups pref parse failed:`, e);
    return new Set();
  }
};

export const writeCollapsedGroupsPref = (labels) => {
  try {
    const arr = Array.from(labels);
    Services.prefs.setStringPref(CONFIG.COLLAPSED_GROUPS_PREF, JSON.stringify(arr));
  } catch (e) {
    console.error(`${LOG} failed to write collapsed-groups pref:`, e);
  }
};

// Validate the structure of a rules.json file payload. Throws on bad input.
export const validateRules = (data) => {
  if (!data || !Array.isArray(data.rules)) {
    throw new Error("rules.json must have a top-level 'rules' array");
  }
  for (const [i, rule] of data.rules.entries()) {
    if (!rule || typeof rule.name !== "string" || !rule.name.trim()) {
      throw new Error(`rule[${i}] missing or empty 'name'`);
    }
    const hasDomains = Array.isArray(rule.domains);
    const hasTitles = Array.isArray(rule.titleTerms);
    if (hasDomains && rule.domains.some((d) => typeof d !== "string")) {
      throw new Error(`rule[${i}] '${rule.name}': 'domains' must be a string array`);
    }
    if (hasTitles && rule.titleTerms.some((d) => typeof d !== "string")) {
      throw new Error(`rule[${i}] '${rule.name}': 'titleTerms' must be a string array`);
    }
    if (!hasDomains && !hasTitles) {
      throw new Error(`rule[${i}] '${rule.name}': needs 'domains' or 'titleTerms'`);
    }
  }
  return sanitizeRules(data.rules);
};

const loadRulesFromFile = async () => {
  // Gecko aggressively caches chrome:// fetches across reloads of the running
  // browser. The ?t=<timestamp> query string busts that cache so iterative edits
  // to rules.json are picked up without restarting Zen.
  const url = `${CONFIG.RULES_URL}?t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return validateRules(await res.json());
};

// Priority: settings widget pref > rules.json file > hardcoded defaults.
export const loadRules = async () => {
  const prefRules = readRulesPref();
  if (prefRules && prefRules.length > 0) {
    console.log(`${LOG} loaded ${prefRules.length} rule(s) from settings widget`);
    return prefRules;
  }
  try {
    const fileRules = await loadRulesFromFile();
    console.log(`${LOG} loaded ${fileRules.length} rule(s) from rules.json (settings unset)`);
    return fileRules;
  } catch (e) {
    console.warn(`${LOG} rules.json load failed (${e.message}) — using built-in defaults`);
    return DEFAULT_RULES;
  }
};

export const isMinimalStyle = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.MINIMAL_STYLE_PREF, false);
  } catch {
    return false;
  }
};

// When ON, the tidy click ejects any tab from a rule-named group if its
// hostname isn't in that rule's `domains[]`. Off by default — preserves the
// historical behavior where Pass 1 only moves matching tabs, leaving mismatched
// tabs where the user (or AI) put them.
export const isStrictRulesEnforced = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.STRICT_RULES_PREF, false);
  } catch {
    return false;
  }
};

export const getMatchMode = () => {
  try {
    const mode = Services.prefs.getStringPref(CONFIG.MATCH_MODE_PREF, "url-then-title");
    if (
      mode === "url-only" ||
      mode === "title-only" ||
      mode === "url-then-title" ||
      mode === "title-then-url"
    ) {
      return mode;
    }
  } catch {}
  return "url-then-title";
};

export const getGradientStyle = () => {
  try {
    const style = Services.prefs.getStringPref(CONFIG.GRADIENT_STYLE_PREF, DEFAULT_GRADIENT_STYLE);
    if (Object.prototype.hasOwnProperty.call(GRADIENT_STYLES, style)) return style;
  } catch {}
  return DEFAULT_GRADIENT_STYLE;
};

// Which AI engine is selected. Returns one of: "off" | "local" | "ollama".
// Any unrecognized value (Sine's "None" is the empty string) maps to "off".
export const getAIEngine = () => {
  try {
    const engine = Services.prefs.getStringPref(CONFIG.AI_ENGINE_PREF, "");
    if (engine === "local" || engine === "ollama") return engine;
    return "off";
  } catch {
    return "off";
  }
};

export const getOllamaHost = () => {
  try {
    const v = Services.prefs.getStringPref(CONFIG.AI_OLLAMA_HOST_PREF, "").trim();
    return v || CONFIG.AI_OLLAMA_HOST_DEFAULT;
  } catch {
    return CONFIG.AI_OLLAMA_HOST_DEFAULT;
  }
};

export const getOllamaModel = () => {
  try {
    const v = Services.prefs.getStringPref(CONFIG.AI_OLLAMA_MODEL_PREF, "").trim();
    return v || CONFIG.AI_OLLAMA_MODEL_DEFAULT;
  } catch {
    return CONFIG.AI_OLLAMA_MODEL_DEFAULT;
  }
};

// Whether to preload the model at browser start AND keep it warm between
// classification calls. Default true — most users want low-latency clicks.
// Turning off saves VRAM when idle but every first click after the model
// unloads (Ollama default 5min idle) pays a cold-start cost.
export const isOllamaWarmupEnabled = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.AI_OLLAMA_WARMUP_PREF, true);
  } catch {
    return true;
  }
};

// User-configurable batch size for the Local-AI chunking path. Larger values
// = more parallel embedding calls per chunk (faster but heavier on RAM/CPU).
// Smaller values = gentler on the system but slower overall.
//
// Stored as a string pref because Sine's preferences.json schema doesn't have
// a native int type — we parse + clamp on read so any stray about:config
// edit can't break the pipeline.
export const getLocalAIBatchSize = () => {
  try {
    const raw = Services.prefs.getStringPref(
      CONFIG.AI_LOCAL_BATCH_SIZE_PREF,
      String(CONFIG.AI_LOCAL_BATCH_SIZE_DEFAULT),
    );
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v) || v < 1) return CONFIG.AI_LOCAL_BATCH_SIZE_DEFAULT;
    return Math.min(200, Math.max(1, v));
  } catch {
    return CONFIG.AI_LOCAL_BATCH_SIZE_DEFAULT;
  }
};

// What to do when AI assigns a tab to an existing rule-matched group.
//   "always-add" — append the tab's hostname to that rule's domains (default)
//   "transient"  — move the tab into the group, but don't touch the rule
//
// On the Local engine the existing-behavior row is hidden in settings — the
// new-group-behavior dropdown drives BOTH decisions instead. Map:
//   Auto-add  → always-add  (grow the rule)
//   Transient → transient   (don't grow)
//   Fresh     → transient   (Fresh ignores rules; the answer doesn't matter)
export const getAIExistingBehavior = () => {
  try {
    if (getAIEngine() === "local") {
      return getAINewGroupBehavior() === "auto-add" ? "always-add" : "transient";
    }
    return Services.prefs.getStringPref(CONFIG.AI_EXISTING_BEHAVIOR_PREF, "always-add");
  } catch {
    return "always-add";
  }
};

// What to do when AI clusters a set of unmatched tabs into a new group.
//   "auto-add"  — create the tab-group AND a matching rule (default)
//   "transient" — create the tab-group but don't add a rule
//   "prompt"    — create the tab-group and open Zen's edit modal so user can confirm
export const getAINewGroupBehavior = () => {
  try {
    return Services.prefs.getStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "auto-add");
  } catch {
    return "auto-add";
  }
};
