// Zen Tab Wand — rules data layer.
// Reads/writes the rules JSON pref, validates rules.json file contents, and exposes
// the precedence chain (pref > file > built-in defaults).

import { CONFIG, DEFAULT_RULES, LOG, ZEN_COLOR_NAMES, isValidHex } from "./config.mjs";

/**
 * Read the rules pref written by the settings widget.
 *
 * Three return states callers should know about:
 *   - `null`     — pref is unset, blank, or unparseable JSON
 *   - `[]`       — pref exists but every entry was malformed (and got dropped)
 *   - `Rule[]`   — one or more valid rules
 *
 * Each Rule has shape: `{ name: string, domains: string[], color?: string }`.
 * Color is preserved if it's either a Zen palette name (e.g. "blue") or a hex (`#abc`).
 *
 * Malformed entries are silently dropped — invalid rules don't break valid ones.
 */
export const readRulesPref = () => {
  try {
    const raw = Services.prefs.getStringPref(CONFIG.RULES_PREF, "");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed
      .map((r) => {
        const out = {
          name: typeof r?.name === "string" ? r.name.trim() : "",
          domains: Array.isArray(r?.domains)
            ? r.domains.map((d) => String(d).trim()).filter((d) => d.length > 0)
            : [],
        };
        if (typeof r?.color === "string") {
          const c = r.color.trim();
          if (ZEN_COLOR_NAMES.has(c) || isValidHex(c)) out.color = c;
        }
        return out;
      })
      .filter((r) => r.name.length > 0 && r.domains.length > 0);
    return cleaned;
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

// Validate the structure of a rules.json file payload. Throws on bad input.
export const validateRules = (data) => {
  if (!data || !Array.isArray(data.rules)) {
    throw new Error("rules.json must have a top-level 'rules' array");
  }
  for (const [i, rule] of data.rules.entries()) {
    if (!rule || typeof rule.name !== "string" || !rule.name.trim()) {
      throw new Error(`rule[${i}] missing or empty 'name'`);
    }
    if (!Array.isArray(rule.domains) || rule.domains.some((d) => typeof d !== "string")) {
      throw new Error(`rule[${i}] '${rule.name}': 'domains' must be a string array`);
    }
  }
  return data.rules;
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

// What to do when AI assigns a tab to an existing rule-matched group.
//   "always-add" — append the tab's hostname to that rule's domains (default)
//   "transient"  — move the tab into the group, but don't touch the rule
export const getAIExistingBehavior = () => {
  try {
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
