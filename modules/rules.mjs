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

// Drops matchOrder entries whose value no longer exists in domains/titleTerms
// (stale pills) and dedupes. Returns undefined (not []) so cleanRule can omit
// the field entirely for rules that never used it.
const cleanMatchOrder = (value, domains, titleTerms) => {
  if (!Array.isArray(value)) return undefined;
  const domainSet = new Set(domains);
  const titleSet = new Set(titleTerms);
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const type = entry.type;
    const val = entry.value;
    if (type !== "domain" && type !== "title") continue;
    if (typeof val !== "string") continue;
    const set = type === "domain" ? domainSet : titleSet;
    if (!set.has(val)) continue;
    const key = `${type}\x00${val}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, value: val });
  }
  return out.length > 0 ? out : undefined;
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
  // cleanRule rebuilds output from known fields only, so matchOrder must be
  // explicitly copied here or it's silently stripped on every pref read.
  if (Array.isArray(r?.matchOrder)) {
    const cleaned = cleanMatchOrder(r.matchOrder, out.domains, out.titleTerms);
    if (cleaned) out.matchOrder = cleaned;
  }
  return out;
};

// No matchOrder -> default order (domains then titleTerms), for legacy rules.
// Otherwise follows matchOrder, then appends any domains/titleTerms not listed
// in it (e.g. added by AI rule-growing, which doesn't know matchOrder exists).
export const getOrderedMatches = (rule) => {
  const domains = Array.isArray(rule?.domains) ? rule.domains : [];
  const titleTerms = Array.isArray(rule?.titleTerms) ? rule.titleTerms : [];
  const order = Array.isArray(rule?.matchOrder) ? rule.matchOrder : null;
  if (!order) {
    return [
      ...domains.map((value) => ({ type: "domain", value })),
      ...titleTerms.map((value) => ({ type: "title", value })),
    ];
  }
  // Pools are mutable so a duplicate value is consumed one occurrence at a
  // time, not matched by every occurrence of the same matchOrder entry.
  const domainPool = [...domains];
  const titlePool = [...titleTerms];
  const consumeFrom = (pool, value) => {
    const idx = pool.indexOf(value);
    if (idx === -1) return false;
    pool.splice(idx, 1);
    return true;
  };
  const result = [];
  for (const entry of order) {
    if (!entry || (entry.type !== "domain" && entry.type !== "title")) continue;
    const pool = entry.type === "domain" ? domainPool : titlePool;
    if (consumeFrom(pool, entry.value)) {
      result.push({ type: entry.type, value: entry.value });
    }
    // else: stale entry referencing a value no longer present — dropped.
  }
  for (const value of domainPool) result.push({ type: "domain", value });
  for (const value of titlePool) result.push({ type: "title", value });
  return result;
};

const isRunnableRule = (r) =>
  r.name.length > 0 && (r.domains.length > 0 || r.titleTerms.length > 0);

// Shared by every ingestion path (pref, file, import) so compatibility fixes
// don't drift apart between them.
export const sanitizeRules = (rules, { keepIncomplete = false } = {}) => {
  const cleaned = Array.isArray(rules) ? rules.map(cleanRule) : [];
  return keepIncomplete ? cleaned : cleaned.filter(isRunnableRule);
};

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.keepIncomplete=false]
 *   When true, in-progress rules (empty name or no match terms) are included
 *   too — used by the settings widget so a blank row survives a session.
 *   loadRules() uses the default, since incomplete rules are no-ops anyway.
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

// Skip-domain list: hostnames or `*.host` patterns the tidy click never touches
// (see click-handler.mjs — matching tabs are ejected and parked at the top before Pass 1).
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

// Zen's session manager doesn't persist tab-group `collapsed` state across
// restarts, so we track it ourselves and re-apply on TabGroupCreate.
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
  // Cache-busts Gecko's chrome:// fetch cache so rules.json edits are picked
  // up without restarting Zen.
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

// When ON, ejects tabs from a rule-named group if their hostname isn't in that
// rule's domains[]. Off by default to preserve legacy behavior (Pass 1 only moves matches).
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

// Returns "off" | "local" | "ollama" — Sine's "None" option stores "" here, which maps to "off".
export const getAIEngine = () => {
  try {
    const engine = Services.prefs.getStringPref(CONFIG.AI_ENGINE_PREF, "");
    if (engine === "local" || engine === "ollama") return engine;
    return "off";
  } catch {
    return "off";
  }
};

export const getAITitleLearning = () => {
  try {
    const value = Services.prefs.getStringPref(CONFIG.AI_TITLE_LEARNING_PREF, "off");
    if (value === "review-save" || value === "review-save-simple") return "review-save-simple";
    if (value === "review-save-complex") return "review-save-complex";
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

// Default true (low-latency clicks). Off saves idle VRAM, but the first click
// after Ollama's ~5min idle unload pays a cold-start cost.
export const isOllamaWarmupEnabled = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.AI_OLLAMA_WARMUP_PREF, true);
  } catch {
    return true;
  }
};

// Set when the user dismisses maybeShowLocalWarning (prefs-ui.mjs). Gates
// ollama.mjs's dedupe check from silently loading the Local embedding model
// for an Ollama-only user who's never seen that warning.
export const isLocalAIAcknowledged = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.LOCAL_ACKNOWLEDGED_PREF, false);
  } catch {
    return false;
  }
};

// Stored as a string pref (Sine's schema has no native int type); parsed and
// clamped on read so a stray about:config edit can't break the pipeline.
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

// "always-add" appends the tab's hostname to the matched rule (default);
// "transient" moves the tab without touching the rule. The Local engine hides
// this row in settings and derives the answer from new-group-behavior instead
// (auto-add -> always-add, else transient).
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

// "auto-add" creates the group and a matching rule (default); "transient"
// creates the group without saving a rule; "prompt" also opens Zen's edit
// modal to confirm.
export const getAINewGroupBehavior = () => {
  try {
    return Services.prefs.getStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "auto-add");
  } catch {
    return "auto-add";
  }
};
