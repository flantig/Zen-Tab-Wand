// Zen Tab Wand — Pass 2 (local AI) using Firefox's bundled ML engine.
//
// SCOPE: this engine ONLY assigns unmatched tabs into EXISTING rule-matched
// groups. It does not invent new groups or name clusters — that role belongs
// to the Ollama engine (modules/ollama.mjs). The local-AI path here uses just
// the embedding model:
//   - Mozilla/smart-tab-embedding (feature-extraction) — title → vector
//
// Pipeline:
//   1. Embed each Pass-1-unmatched tab title (with hostname appended).
//   2. For each existing rule-matched group in the workspace, embed each of
//      its tabs (NOT a centroid — we score against the MAX similarity to any
//      single tab in the group, which preserves specific-tab signal that
//      averaging dilutes).
//   3. Assign each unmatched tab to the group whose max similarity clears
//      AI_EXISTING_GROUP_THRESHOLD (with AI_EXISTING_GROUP_BOOST added).
//
// applyPass2 actually moves tabs / creates groups / updates rules per the
// "AI existing behavior" + "AI new-group behavior" prefs. (`newGroups` is
// always returned empty by runPass2; new-group creation in non-Ollama flows
// is a no-op.)

import { CONFIG, LOG, PRESET_COLORS } from "./config.mjs";
import {
  writeRulesPref,
  getAIExistingBehavior,
  getAINewGroupBehavior,
} from "./rules.mjs";
import { getTabTitle } from "./tabs.mjs";
import { findExistingGroup, expandIfCollapsed, applyGroupColor, findSafeInsertAnchor } from "./groups.mjs";
import { setTabGroupedHookSuppressed } from "./browser-hooks.mjs";
import { showToast } from "./ui-toast.mjs";

// ─── Engine loaders (lazy + cached for the lifetime of the window) ───────────
//
// Zen ships Firefox's local ML engine but disables it by default (`browser.ml.enabled`
// pref defaults to false in Zen). The user opting in to "Enable AI sorting" in our
// settings is implicit consent to flip it, so we force it on before trying to load
// the engine. Same approach Tidy Tabs takes via `force: true` on its preferences.json.
// NOTE the pref name is `browser.ml.enable` (no trailing "d") — Firefox's
// EngineProcess.sys.mjs:1100 checks exactly this string. Easy to typo.
const ensureMLEnginePref = () => {
  try {
    if (!Services.prefs.getBoolPref("browser.ml.enable", false)) {
      Services.prefs.setBoolPref("browser.ml.enable", true);
      console.log(`${LOG} AI: enabled browser.ml.enable pref`);
    }
  } catch (e) {
    console.warn(`${LOG} AI: could not toggle browser.ml.enable:`, e);
  }
};

let embeddingEnginePromise = null;

const loadEmbeddingEngine = () => {
  if (embeddingEnginePromise) return embeddingEnginePromise;
  embeddingEnginePromise = (async () => {
    ensureMLEnginePref();
    const { createEngine } = ChromeUtils.importESModule(
      "chrome://global/content/ml/EngineProcess.sys.mjs"
    );
    return createEngine({
      taskName: "feature-extraction",
      modelId: "Mozilla/smart-tab-embedding",
      modelHub: "huggingface",
      engineId: "zao-embedding",
    });
  })().catch((e) => {
    embeddingEnginePromise = null; // allow retry on next click
    throw e;
  });
  return embeddingEnginePromise;
};

// ─── Math + normalization helpers ─────────────────────────────────────────────

// The embedding engine sometimes returns nested results — flatten / pool here so
// callers always get a flat number[] back.
const poolEmbedding = (raw) => {
  if (!raw) return null;
  if (raw?.[0]?.embedding && Array.isArray(raw[0].embedding)) return averageVectors(raw[0].embedding);
  if (Array.isArray(raw?.[0])) return averageVectors(raw[0]);
  if (Array.isArray(raw)) return averageVectors(raw);
  return null;
};

const averageVectors = (arrays) => {
  if (!Array.isArray(arrays) || arrays.length === 0) return null;
  if (typeof arrays[0] === "number") return arrays; // already flat
  const len = arrays[0].length;
  const avg = new Array(len).fill(0);
  for (const a of arrays) {
    for (let i = 0; i < len; i++) avg[i] += a[i];
  }
  for (let i = 0; i < len; i++) avg[i] /= arrays.length;
  return avg;
};

const l2Normalize = (v) => {
  if (!Array.isArray(v) || v.length === 0) return v;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
};

const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

// Combine the title with the hostname for the embedding input. The hostname is
// a strong signal the model often learns (e.g. "amazon.com" hints at shopping
// even if the page title doesn't contain shopping vocabulary).
const buildEmbedText = (titleOrInfo) => {
  if (typeof titleOrInfo === "string") return titleOrInfo;
  const { title = "", hostname = "" } = titleOrInfo;
  if (hostname) return `${title} (${hostname})`.trim();
  return title;
};

const embed = async (input) => {
  const text = buildEmbedText(input);
  if (!text || typeof text !== "string") return null;
  try {
    const engine = await loadEmbeddingEngine();
    const result = await engine.run({ args: [text] });
    const pooled = poolEmbedding(result);
    return pooled ? l2Normalize(pooled) : null;
  } catch (e) {
    console.error(`${LOG} embedding failed for "${text}":`, e);
    return null;
  }
};

const embedBatch = async (inputs) => {
  const out = [];
  for (let i = 0; i < inputs.length; i += CONFIG.AI_EMBEDDING_BATCH_SIZE) {
    const chunk = inputs.slice(i, i + CONFIG.AI_EMBEDDING_BATCH_SIZE);
    const results = await Promise.all(chunk.map(embed));
    out.push(...results);
  }
  return out;
};

// ─── Per-tab embeddings for existing rule-matched groups ─────────────────────

// For each rule-matched tab-group in the workspace, return the per-tab embeddings
// (NOT a centroid). Downstream we score candidates by taking the MAX similarity
// against any single tab in the group — Tidy Tabs's approach. Averaging dilutes
// strong specific-tab signals (e.g. retail-vocabulary similarity between amazon
// and staples gets diluted into a generic centroid).
//
// excludeTabs: any tab references in here are SKIPPED when collecting the group's
// embedding set. Used to exclude "unmatched" tabs from polluting the group's
// rule-defined identity. Without this, a tab that AI moved into a group last run
// with the "transient" behavior — but isn't claimed by the rule — would show up
// here AND as an unmatched candidate this run, causing a self-match (cosine 1.0).
const computeExistingGroupTabEmbeddings = async (workspaceId, rules, excludeTabs = new Set()) => {
  const ruleNames = new Set(rules.map((r) => r.name));
  const groupEmbeddings = new Map(); // groupName → number[][]
  const groups = document.querySelectorAll(
    `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`
  );
  for (const groupEl of groups) {
    const label = groupEl.getAttribute("label");
    if (!label || !ruleNames.has(label)) continue;
    const tabsInGroup = Array.from(
      groupEl.querySelectorAll(`tab[zen-workspace-id="${workspaceId}"]`)
    ).filter((t) => !excludeTabs.has(t));
    if (tabsInGroup.length === 0) continue;
    // Same title+hostname format we use for the unmatched candidates so the
    // embeddings live in the same semantic space.
    const inputs = tabsInGroup.map((t) => ({
      title: getTabTitle(t),
      hostname: (() => {
        try { return new URL(t.linkedBrowser?.currentURI?.spec || "").hostname.replace(/^www\./, ""); }
        catch { return ""; }
      })(),
    })).filter((i) => i.title);
    if (inputs.length === 0) continue;
    const embs = (await embedBatch(inputs)).filter((v) => v);
    if (embs.length === 0) continue;
    groupEmbeddings.set(label, embs);
  }
  return groupEmbeddings;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run Pass 2 AI sorting over the Pass-1-unmatched tabs.
 *
 * @param {Array} unmatched   — tab info objects from runPass1 result
 * @param {Array} rules       — current rules (read by caller)
 * @param {string} workspaceId
 * @returns {Promise<{
 *   assignedToExisting: { tabInfo, groupName, similarity }[],
 *   newGroups: { name, tabs[] }[],
 *   skipped: tabInfo[],
 *   failed?: string,
 * }>}
 */
export const runPass2 = async (unmatched, rules, workspaceId) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!unmatched || unmatched.length === 0) return empty;

  // 1. Embed every unmatched tab using title + hostname as the input text.
  let tabEmbeddings;
  try {
    tabEmbeddings = await embedBatch(
      unmatched.map((t) => ({ title: t.title, hostname: t.hostname }))
    );
  } catch (e) {
    console.error(`${LOG} AI: failed to load embedding engine:`, e);
    showToast("AI sorting unavailable — embedding model failed to load");
    return { ...empty, failed: "embedding engine load failed" };
  }

  // 2. Collect per-tab embeddings for existing rule-matched groups. Exclude the
  //    unmatched tabs themselves — otherwise a tab AI moved into a group last
  //    run (with the "transient" behavior, so no rule update) would self-match
  //    against itself at cosine 1.0 this run.
  const excludeSet = new Set(unmatched.map((t) => t._tab).filter((t) => t));
  const groupTabEmbeddings = await computeExistingGroupTabEmbeddings(workspaceId, rules, excludeSet);
  console.log(`${LOG} AI: collected per-tab embeddings for ${groupTabEmbeddings.size} existing group(s): ${[...groupTabEmbeddings.keys()].map((n) => `${n}(${groupTabEmbeddings.get(n).length})`).join(", ") || "(none)"}`);

  // 3. Try to slot each unmatched tab into an existing group using MAX similarity
  //    against any individual tab in the group (not a centroid average).
  const assignedToExisting = [];
  const remainder = []; // { info, embedding } for tabs that didn't fit
  for (let i = 0; i < unmatched.length; i++) {
    const tabInfo = unmatched[i];
    const emb = tabEmbeddings[i];
    if (!emb) { empty.skipped.push(tabInfo); continue; }

    let best = null;
    const allSims = [];
    for (const [groupName, embs] of groupTabEmbeddings) {
      let rawMax = -Infinity;
      for (const tabEmb of embs) {
        const s = cosineSimilarity(emb, tabEmb);
        if (s > rawMax) rawMax = s;
      }
      const raw = rawMax === -Infinity ? 0 : rawMax;
      const sim = raw + CONFIG.AI_EXISTING_GROUP_BOOST;
      allSims.push(`${groupName}=${sim.toFixed(3)}(maxRaw ${raw.toFixed(3)})`);
      if (sim > CONFIG.AI_EXISTING_GROUP_THRESHOLD && (!best || sim > best.sim)) {
        best = { groupName, sim };
      }
    }
    // Diagnostics: inline scores so they show up in the log without needing to expand objects.
    if (allSims.length > 0) {
      const verdict = best
        ? `picked ${best.groupName} (${best.sim.toFixed(3)})`
        : `no match (threshold ${CONFIG.AI_EXISTING_GROUP_THRESHOLD})`;
      console.log(`${LOG} AI sim for "${tabInfo.hostname || tabInfo.title}": ${allSims.join(", ")} → ${verdict}`);
    }
    if (best) {
      assignedToExisting.push({ tabInfo, groupName: best.groupName, similarity: best.sim });
    } else {
      remainder.push({ info: tabInfo, embedding: emb });
    }
  }

  // Local AI is intentionally limited to assigning into EXISTING groups only.
  // New-cluster formation (and the smart-tab-topic naming model) produced unreliable
  // results — the embedding model clusters by stylistic similarity (homepage-style
  // titles) rather than topic, and the score range is too compressed to threshold
  // safely. New-group classification is left to a future Ollama-backed path.
  // clusterEmbeddings / generateClusterName are kept around for that integration.

  return {
    assignedToExisting,
    newGroups: [],
    skipped: [...empty.skipped, ...remainder.map((r) => r.info)],
  };
};

// ─── Apply the AI decisions ───────────────────────────────────────────────────

const addDomainToRule = (ruleName, hostname, rules) => {
  const rule = rules.find((r) => r.name === ruleName);
  if (!rule) return false;
  if (!hostname || rule.domains.includes(hostname)) return false;
  rule.domains.push(hostname);
  return true;
};

// Pick a Zen palette color that isn't yet in `usedSet`. Falls back to a random
// preset if all are taken. Mutates `usedSet` to reserve the chosen color so
// subsequent calls within one apply pass don't double-up.
const pickAvailableColor = (usedSet) => {
  const available = PRESET_COLORS.filter((c) => !usedSet.has(c.name));
  const pool = available.length > 0 ? available : PRESET_COLORS;
  const pick = pool[Math.floor(Math.random() * pool.length)].name;
  usedSet.add(pick);
  return pick;
};

const openZenEditModalForGroup = (groupEl) => {
  // Try common Zen entry points to surface the "edit tab group" panel for an
  // existing group. Falls back silently if no API is available — the group is
  // still created, the user just doesn't get the rename prompt.
  try {
    const tgm = window.gBrowser?.tabGroupMenu;
    if (tgm) {
      if (typeof tgm.openEditModal === "function") { tgm.openEditModal(groupEl); return true; }
      if (typeof tgm.openCreate === "function")    { tgm.openCreate(groupEl); return true; }
    }
    // Generic last-resort: click the group's label to invoke the inline rename, if any.
    const label = groupEl.querySelector(".tab-group-label");
    if (label) { label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return true; }
  } catch (e) {
    console.warn(`${LOG} could not open Zen edit modal:`, e);
  }
  return false;
};

export const applyPass2 = (pass2Result, workspaceId, rules) => {
  const existingBehavior = getAIExistingBehavior();
  const newGroupBehavior = getAINewGroupBehavior();

  let movedToExisting = 0;
  let rulesGrown = 0;
  let newGroupsCreated = 0;
  let newRulesCreated = 0;

  // Seed the in-use color set from existing rules so new AI groups don't
  // duplicate them. Updated as each new group is created within this batch.
  const usedColors = new Set(
    rules.map((r) => r.color).filter((c) => typeof c === "string" && c.length > 0)
  );

  // gBrowser.moveTabToExistingGroup and gBrowser.addTabGroup both fire TabGrouped
  // events. Without suppressing the hook, AI's "transient" mode is silently
  // overridden — the hook adds rules anyway. The hook stays suppressed for the
  // duration of this synchronous apply pass.
  setTabGroupedHookSuppressed(true);
  try {

  // 1. Move tabs into existing rule-matched groups.
  for (const a of pass2Result.assignedToExisting) {
    const groupEl = findExistingGroup(a.groupName, workspaceId);
    if (!groupEl?.isConnected) continue;
    try {
      expandIfCollapsed(groupEl);
      const tab = a.tabInfo._tab;
      if (tab?.isConnected && tab.closest("tab-group") !== groupEl) {
        gBrowser.moveTabToExistingGroup(tab, groupEl);
        movedToExisting++;
      }
      if (existingBehavior === "always-add") {
        if (addDomainToRule(a.groupName, a.tabInfo.hostname, rules)) rulesGrown++;
      }
    } catch (e) {
      console.error(`${LOG} AI: failed to move tab into "${a.groupName}":`, e);
    }
  }

  // 2. Create new groups from each cluster.
  for (const cluster of pass2Result.newGroups) {
    const tabs = cluster.tabs.map((t) => t._tab).filter((t) => t?.isConnected);
    if (tabs.length === 0) continue;

    // Pick a not-yet-used palette color so the new group is visually distinct.
    const color = pickAvailableColor(usedColors);

    try {
      const newGroup = gBrowser.addTabGroup(tabs, {
        label: cluster.name,
        // Anchor at a DOM position OUTSIDE any enclosing tab-group; otherwise
        // Zen creates the new group as a child of the old one (nesting bug).
        // Critical in fresh-categories mode where tabs[0] is usually already
        // grouped under a rule.
        insertBefore: findSafeInsertAnchor(),
        color,
      });
      if (!newGroup) continue;
      newGroupsCreated++;

      // Defensive — also set the color via our helper in case Zen's addTabGroup
      // ignored the option (older API), or didn't fully wire the variant vars.
      applyGroupColor(newGroup, color);

      // Per-behavior persistence:
      if (newGroupBehavior === "auto-add") {
        // Build a rule from the cluster's hostnames, including the chosen color
        // so syncAllGroupColors on future tidy-clicks keeps the same color.
        const hostnames = [...new Set(cluster.tabs.map((t) => t.hostname).filter((h) => h))];
        if (hostnames.length > 0 && !rules.some((r) => r.name === cluster.name)) {
          rules.push({ name: cluster.name, domains: hostnames, color });
          newRulesCreated++;
        }
      } else if (newGroupBehavior === "prompt") {
        openZenEditModalForGroup(newGroup);
        // If the user picks a different color in the modal, our existing
        // TabGrouped hook will save the rule with that color on modal close.
      }
      // "transient" — group exists in sidebar (with color) but we don't touch rules.
    } catch (e) {
      console.error(`${LOG} AI: failed to create new group "${cluster.name}":`, e);
    }
  }

  // Persist any rule changes (rule grow + new rules).
  if (rulesGrown > 0 || newRulesCreated > 0) writeRulesPref(rules);

  } finally {
    // Re-enable the TabGrouped hook for any further user-driven mutations.
    setTabGroupedHookSuppressed(false);
  }

  return { movedToExisting, rulesGrown, newGroupsCreated, newRulesCreated };
};
