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
  getLocalAIBatchSize,
} from "./rules.mjs";
import { getTabTitle, fetchPageSnippet } from "./tabs.mjs";
import { findExistingGroup, expandIfCollapsed, applyGroupColor, findSafeInsertAnchor } from "./groups.mjs";
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

// Cap on what we send to the embedder. Mozilla's smart-tab-embedding has an
// internal token limit; we truncate at ~1000 chars (well under any reasonable
// token cap, but generous enough to fit title + hostname + rich snippet).
const MAX_EMBED_INPUT_CHARS = 1000;

// The MLEngineParent port can die between clicks (Firefox tears it down when
// the engine pref flips, or when memory pressure kicks in). When that happens
// the cached `embeddingEnginePromise` still resolves to a dead engine whose
// `.run()` throws "Port does not exist" for every call. This sentinel lets
// embed() report the dead-port case to embedBatch so it can invalidate the
// cache and retry the whole batch once.
const DEAD_PORT_SENTINEL = Symbol("dead-port");

const embed = async (input) => {
  let text = buildEmbedText(input);
  if (!text || typeof text !== "string") return null;
  if (text.length > MAX_EMBED_INPUT_CHARS) text = text.slice(0, MAX_EMBED_INPUT_CHARS);
  try {
    const engine = await loadEmbeddingEngine();
    const result = await engine.run({ args: [text] });
    const pooled = poolEmbedding(result);
    return pooled ? l2Normalize(pooled) : null;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("Port does not exist")) {
      // Don't log noise here — embedBatch logs once per dead-port batch.
      return DEAD_PORT_SENTINEL;
    }
    console.error(`${LOG} embedding failed for "${text}":`, e);
    return null;
  }
};

// Embed an array of {title, hostname} inputs in chunks.
//
// `opts.batchSize` overrides the default chunk width. `opts.yieldBetween`
// inserts an `await setTimeout(0)` after each chunk so the event loop stays
// responsive — used on the large-workspace path (>75 unmatched tabs) where
// without yielding the browser tab can freeze for many seconds.
//
// Dead-engine recovery: if every entry in a chunk reports dead-port, we
// invalidate the cached engine promise and retry the chunk ONCE. This handles
// the common case where the user toggled engine prefs and the ML engine's
// port closed — recreating loads a fresh engine. Limited to one retry per
// batch to avoid infinite recreation loops when the engine genuinely won't
// load.
const embedBatch = async (inputs, opts = {}) => {
  const batchSize = opts.batchSize ?? CONFIG.AI_EMBEDDING_BATCH_SIZE;
  const yieldBetween = !!opts.yieldBetween;
  const out = [];
  let alreadyRecreated = false;
  for (let i = 0; i < inputs.length; i += batchSize) {
    const chunk = inputs.slice(i, i + batchSize);
    let results = await Promise.all(chunk.map(embed));
    // A genuinely dead engine yields SENTINEL for every input it touches. Inputs that buildEmbedText
    // rejected as empty come back as plain null. Treat the chunk as "dead-port suspected" when at
    // least one says SENTINEL and nothing succeeded.
    const someDead = results.some((r) => r === DEAD_PORT_SENTINEL);
    const allDeadOrNull = results.every((r) => r === DEAD_PORT_SENTINEL || r === null);
    if (someDead && allDeadOrNull && !alreadyRecreated) {
      console.warn(`${LOG} embedBatch: every embed reported "Port does not exist" — invalidating engine cache and retrying chunk`);
      embeddingEnginePromise = null;
      alreadyRecreated = true;
      results = await Promise.all(chunk.map(embed));
    }
    // Normalize sentinels back to null so downstream code sees a clean
    // "couldn't embed this one" signal.
    for (const r of results) out.push(r === DEAD_PORT_SENTINEL ? null : r);
    if (yieldBetween && i + batchSize < inputs.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
const computeExistingGroupTabEmbeddings = async (workspaceId, rules, excludeTabs = new Set(), opts = {}) => {
  // Forward chunking opts so large-workspace callers can pass batchSize +
  // yieldBetween through to embedBatch and avoid a long blocking embed pass.
  const { batchSize, yieldBetween } = opts;
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
    const embs = (await embedBatch(inputs, { batchSize, yieldBetween })).filter((v) => v);
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

  // Chunking decision. On large workspaces (>CHUNK_THRESHOLD unmatched tabs)
  // we switch to a more conservative path:
  //   - Hostname dedupe: embed one representative tab per unique hostname;
  //     reuse the embedding for all siblings (50 amazon.com tabs → 1 embed).
  //   - Yield between batches: avoid freezing the browser.
  // Below the threshold we use the original 1-embed-per-tab flow with the
  // small AI_EMBEDDING_BATCH_SIZE — there's no point chunking when there's
  // little work to do.
  const useChunking = unmatched.length > CONFIG.AI_LOCAL_CHUNK_THRESHOLD;
  const batchSize = useChunking ? getLocalAIBatchSize() : CONFIG.AI_EMBEDDING_BATCH_SIZE;

  // Resolve a per-tab embedding. Without chunking, `tabEmbeddings[i]`.
  // With chunking, the embedding for the tab's hostname (one per hostname).
  let getEmbeddingForTab;

  try {
    if (useChunking) {
      // Dedupe by hostname: pick the first tab encountered per hostname as
      // the representative. Group siblings get the same embedding/result.
      // Guard truthy hostname so hostless tabs (about:*, chrome://, file://)
      // don't all collapse onto one rep — they fall through to the skipped path.
      const repByHostname = new Map();
      for (const t of unmatched) {
        if (t.hostname && !repByHostname.has(t.hostname)) repByHostname.set(t.hostname, t);
      }
      const reps = [...repByHostname.values()];
      console.log(`${LOG} AI: large workspace (${unmatched.length} > ${CONFIG.AI_LOCAL_CHUNK_THRESHOLD}) — chunking on, deduped to ${reps.length} unique hostname(s), batchSize=${batchSize}`);

      const repEmbeddings = await embedBatch(
        reps.map((t) => ({ title: t.title, hostname: t.hostname })),
        { batchSize, yieldBetween: true },
      );
      const hostToEmb = new Map();
      reps.forEach((t, i) => {
        if (repEmbeddings[i]) hostToEmb.set(t.hostname, repEmbeddings[i]);
      });
      getEmbeddingForTab = (tabInfo) => hostToEmb.get(tabInfo.hostname);
    } else {
      const tabEmbeddings = await embedBatch(
        unmatched.map((t) => ({ title: t.title, hostname: t.hostname })),
        { batchSize },
      );
      getEmbeddingForTab = (_tabInfo, idx) => tabEmbeddings[idx];
    }
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
  const groupTabEmbeddings = await computeExistingGroupTabEmbeddings(workspaceId, rules, excludeSet, {
    batchSize: useChunking ? batchSize : undefined,
    yieldBetween: useChunking,
  });
  console.log(`${LOG} AI: collected per-tab embeddings for ${groupTabEmbeddings.size} existing group(s): ${[...groupTabEmbeddings.keys()].map((n) => `${n}(${groupTabEmbeddings.get(n).length})`).join(", ") || "(none)"}`);

  // 3. Try to slot each unmatched tab into an existing group using MAX similarity
  //    against any individual tab in the group (not a centroid average).
  const assignedToExisting = [];
  const remainder = []; // { info, embedding } for tabs that didn't fit
  for (let i = 0; i < unmatched.length; i++) {
    const tabInfo = unmatched[i];
    const emb = getEmbeddingForTab(tabInfo, i);
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
      // Per-tab firing in the unmatched loop — debug so it only surfaces when
      // Verbose log level is enabled; still genuinely useful for diagnosing
      // threshold/embedding issues.
      console.debug(`${LOG} AI sim for "${tabInfo.hostname || tabInfo.title}": ${allSims.join(", ")} → ${verdict}`);
    }
    if (best) {
      assignedToExisting.push({ tabInfo, groupName: best.groupName, similarity: best.sim });
    } else {
      remainder.push({ info: tabInfo, embedding: emb });
    }
  }

  // Local AI is intentionally limited to assigning into EXISTING groups only.
  // New-cluster formation is opt-in via `runPass2Fresh` below — see its comment
  // for the trade-offs (no LLM means no abstract names, and smart-tab-embedding
  // clusters by stylistic title similarity rather than topic).

  return {
    assignedToExisting,
    newGroups: [],
    skipped: [...empty.skipped, ...remainder.map((r) => r.info)],
  };
};

// ─── Local Fresh: cluster-from-scratch into new groups ────────────────────────
//
// No LLM, so no abstract naming — clusters are named from member hostnames:
//   - 1 unique brand        → "Github"
//   - 2 unique brands       → "Github & Gitlab"
//   - 3 unique brands       → "Github, Gitlab & Bitbucket"
//   - 4+                    → "Github + 3 more"
//
// Use Plan Mode (identify-only) so the user can rename clusters before applying.
// Caveat: Mozilla's smart-tab-embedding model clusters by stylistic title
// similarity (homepage-style pages cluster together regardless of topic), so
// results are quirky vs. Ollama. The user gets the option; the modal is the
// safety net.

const FRESH_CLUSTER_THRESHOLD = 0.55; // raw cosine — broader than existing-group matching
const FRESH_MERGE_THRESHOLD = 0.40;   // 3rd-pass centroid-merge — looser than initial pairing
const FRESH_MIN_CLUSTER_SIZE = 2;     // singletons demoted to skipped

const etld1 = (hostname) => {
  if (!hostname) return "";
  const parts = hostname.split(".");
  if (parts.length < 2) return hostname;
  return parts.slice(-2).join(".");
};

const titleCase = (s) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

const nameClusterFromHostnames = (tabs) => {
  const counts = new Map();
  for (const t of tabs) {
    const e = etld1(t.hostname);
    if (!e) continue;
    counts.set(e, (counts.get(e) || 0) + 1);
  }
  if (counts.size === 0) return "Cluster";
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const baseOf = (e) => titleCase(e.split(".")[0]);
  if (counts.size === 1) return baseOf(sorted[0][0]);
  if (counts.size === 2) return `${baseOf(sorted[0][0])} & ${baseOf(sorted[1][0])}`;
  if (counts.size === 3) return `${baseOf(sorted[0][0])}, ${baseOf(sorted[1][0])} & ${baseOf(sorted[2][0])}`;
  return `${baseOf(sorted[0][0])} + ${counts.size - 1} more`;
};

// Map an Open Graph `type` value to an Arc-tidy-style intent label. These
// describe the NATURE of the page (what the user is doing with it) rather
// than the brand. og:type is the most reliable signal we have without an
// LLM — and modern sites populate it widely.
const INTENT_BY_OG_TYPE = {
  article: "Reading",
  blog: "Reading",
  book: "Reading",
  website: null,           // too generic — fall through to hostname naming
  video: "Watching",
  "video.movie": "Watching",
  "video.episode": "Watching",
  "video.tv_show": "Watching",
  "video.other": "Watching",
  music: "Listening",
  "music.song": "Listening",
  "music.album": "Listening",
  "music.playlist": "Listening",
  "music.radio_station": "Listening",
  product: "Shopping",
  "product.group": "Shopping",
  "product.item": "Shopping",
  profile: "Social",
  place: "Places",
  event: "Events",
};

const intentFromOgType = (type) => {
  if (!type) return null;
  const lower = type.toLowerCase().trim();
  if (INTENT_BY_OG_TYPE[lower] !== undefined) return INTENT_BY_OG_TYPE[lower];
  // Prefix match — covers nonstandard subtypes like "video.foo".
  for (const [k, v] of Object.entries(INTENT_BY_OG_TYPE)) {
    if (lower.startsWith(k + ".")) return v;
  }
  return null;
};

const parseOgTypeFromSnippet = (snippet) => {
  if (!snippet) return null;
  const m = snippet.match(/\[type:\s*([^\]]+)\]/i);
  return m ? m[1].trim().toLowerCase() : null;
};

// English stopwords + page-chrome boilerplate that frequently appears in tab
// titles but says nothing about the cluster's topic. Intentionally
// conservative — too aggressive a list filters real signal too.
const STOPWORDS = new Set([
  // articles, pronouns, common verbs
  "the","a","an","and","or","but","of","to","in","on","at","for","with","by","from","as",
  "is","are","was","were","be","been","being","have","has","had","do","does","did","will",
  "would","could","should","may","might","can","this","that","these","those","you","your",
  "we","our","i","my","me","it","its","they","their","them","he","she","his","her","not",
  // page chrome
  "page","home","site","website","official","login","sign","search","menu","welcome",
  "404","error","found","settings","preferences","dashboard","profile","account",
  // ranking adjectives that appear in too many headlines to mean anything
  "best","top","latest","new","more","less","free","all","most","least","good","great",
]);

const tokenizeForKeywords = (text) =>
  text.toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/gi, " ")     // strip HTML entities
    .replace(/[^\w\s'-]/g, " ")            // keep hyphens + apostrophes inside words
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

// Pull a [topic: ...] phrase from a snippet, if present.
const parseTopicFromSnippet = (snippet) => {
  if (!snippet) return "";
  const m = snippet.match(/\[topic:\s*([^\]]+)\]/i);
  return m ? m[1].trim() : "";
};

// Find words that recur across multiple distinct hostnames in the cluster.
// Counting by HOSTNAME (not raw token frequency) prevents a chatty
// single-site cluster from inflating its own brand into the cluster label.
const extractClusterKeywords = (tabs, snippetByHostname) => {
  const tokensByHostname = new Map();
  for (const t of tabs) {
    // Skip hostless tabs so they don't bucket under the empty-string fake host
    // and inflate uniqueHosts (which would skew the minShare threshold).
    const hostname = t.hostname;
    if (!hostname) continue;
    const topic = parseTopicFromSnippet(snippetByHostname.get(hostname));
    const text = `${t.title || ""} ${topic}`;
    const tokens = new Set(tokenizeForKeywords(text));
    // Don't let a token win just because the brand IS the word (yugipedia
    // tabs containing "yugipedia") — strip hostname-derived tokens so the
    // shared content words dominate.
    const hostBaseTokens = tokenizeForKeywords(hostname.replace(/\./g, " "));
    for (const ht of hostBaseTokens) tokens.delete(ht);
    if (!tokensByHostname.has(hostname)) tokensByHostname.set(hostname, new Set());
    const acc = tokensByHostname.get(hostname);
    for (const tok of tokens) acc.add(tok);
  }
  const wordToHosts = new Map();
  for (const [hostname, tokens] of tokensByHostname) {
    for (const tok of tokens) {
      if (!wordToHosts.has(tok)) wordToHosts.set(tok, new Set());
      wordToHosts.get(tok).add(hostname);
    }
  }
  const uniqueHosts = tokensByHostname.size;
  // Require the word to appear in at least min(half-the-hosts, 2) so it's a
  // shared signal, not single-site noise.
  const minShare = Math.max(2, Math.ceil(uniqueHosts / 2));
  return [...wordToHosts.entries()]
    .filter(([, hosts]) => hosts.size >= minShare)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 2)
    .map(([word]) => word);
};

// Light Title-Case for arbitrary tokens that may already contain hyphens
// (e.g. "yu-gi-oh" → "Yu-Gi-Oh") or apostrophes ("don't" → "Don't").
const titleCaseToken = (s) =>
  s.split(/(\s|-|')/).map((p) => p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p).join("");

// Pick a cluster name from page signals. Priority:
//   1. shared keyword(s) + intent label   → "Yu-Gi-Oh Reading"
//   2. shared keyword(s) alone            → "Yu-Gi-Oh"
//   3. intent label alone                 → "Reading"
//   4. hostname stitch                    → "Github & Gitlab"
const nameClusterFromSignals = (tabs, snippetByHostname) => {
  // 1+3 — intent label from og:type majority
  const intentCounts = new Map();
  for (const t of tabs) {
    const snip = snippetByHostname.get(t.hostname);
    const ogType = parseOgTypeFromSnippet(snip);
    const intent = intentFromOgType(ogType);
    if (intent) intentCounts.set(intent, (intentCounts.get(intent) || 0) + 1);
  }
  let intentName = null;
  if (intentCounts.size > 0) {
    const sorted = [...intentCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [topIntent, topCount] = sorted[0];
    if (topCount >= Math.ceil(tabs.length / 2)) intentName = topIntent;
  }
  // 1+2 — keyword extraction from titles + [topic:] across distinct hostnames
  const keywords = extractClusterKeywords(tabs, snippetByHostname);
  if (keywords.length > 0 && intentName) {
    return `${titleCaseToken(keywords[0])} ${intentName}`;
  }
  if (keywords.length > 0) {
    return keywords.map(titleCaseToken).join(" ");
  }
  if (intentName) return intentName;
  // 4 — hostname stitch fallback
  return nameClusterFromHostnames(tabs);
};

/**
 * Cluster eligible tabs into NEW groups using embedding similarity alone.
 * Returns the same shape as `runPass2Ollama`/`runPass2OllamaFresh` so the
 * caller can treat them uniformly.
 *
 * @param {Array} tabs — all eligible tab info objects (Pass 2 fresh-like input)
 */
export const runPass2Fresh = async (tabs) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!tabs || tabs.length === 0) return empty;

  // Hostname-dedupe + chunked embed (same infra as runPass2's chunked path).
  const repByHostname = new Map();
  for (const t of tabs) {
    if (t.hostname && !repByHostname.has(t.hostname)) repByHostname.set(t.hostname, t);
  }
  const reps = [...repByHostname.values()];
  const useChunking = tabs.length > CONFIG.AI_LOCAL_CHUNK_THRESHOLD;
  const batchSize = useChunking ? getLocalAIBatchSize() : CONFIG.AI_EMBEDDING_BATCH_SIZE;
  console.log(
    `${LOG} Local Fresh: ${tabs.length} tab(s) → ${reps.length} unique hostname(s), batchSize=${batchSize}, chunking=${useChunking}`
  );

  // Fetch page snippets for each unique hostname so the embedding model has
  // real page context — og:type, og:site_name, h1, description — not just the
  // bare title. This is the same enriched signal block we feed to Ollama, and
  // it produces noticeably better clusters on Local since the embedder gets
  // semantic content beyond just the homepage-style title pattern.
  // Bounded parallel: fetchPageSnippet has its own 3s timeout per request; we
  // fire them all in parallel and let the slow ones drop to "" silently.
  const snippetT0 = performance.now();
  const snippets = await Promise.all(reps.map((t) => {
    const url = t.url || "";
    // Only fetch the tab's actual http(s) URL. Non-http(s) tabs (about:*, chrome://, file://,
    // javascript:, data:, blob:) have no real-world snippet — falling back to a synthetic
    // https://hostname/ URL would fetch the wrong page (someone else's homepage).
    if (!url.startsWith("http://") && !url.startsWith("https://")) return "";
    return fetchPageSnippet(url);
  }));
  const hitCount = snippets.filter((s) => s).length;
  console.log(
    `${LOG} Local Fresh: fetched page snippets for ${hitCount}/${reps.length} tab(s) in ${Math.round(performance.now() - snippetT0)}ms`
  );
  // Index by hostname so nameClusterFromSignals can look up og:type when
  // picking an intent-style name later.
  const snippetByHostname = new Map();
  reps.forEach((t, i) => {
    if (snippets[i]) snippetByHostname.set(t.hostname, snippets[i]);
  });

  let hostToEmb;
  try {
    // Build a richer text input per representative: title + (hostname) +
    // snippet. The embed function accepts strings directly (bypassing the
    // default {title, hostname} → "title (hostname)" formatter).
    const repInputs = reps.map((t, i) => {
      const parts = [];
      if (t.title) parts.push(t.title);
      if (t.hostname) parts.push(`(${t.hostname})`);
      if (snippets[i]) parts.push(snippets[i]);
      return parts.join(" ").trim() || t.hostname || t.title || "";
    });
    const repEmbeddings = await embedBatch(repInputs, { batchSize, yieldBetween: useChunking });
    hostToEmb = new Map();
    reps.forEach((t, i) => {
      if (repEmbeddings[i]) hostToEmb.set(t.hostname, repEmbeddings[i]);
    });
  } catch (e) {
    console.error(`${LOG} Local Fresh: embedding engine failed:`, e);
    showToast("Local clustering unavailable — embedding model failed to load");
    return { ...empty, skipped: tabs, failed: "embedding engine load failed" };
  }

  // Union-find over UNIQUE hostnames (same hostname always clusters together
  // since they share an embedding — no point comparing per-tab).
  const hostnames = [...hostToEmb.keys()];
  const parent = Array.from({ length: hostnames.length }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { parent[find(i)] = find(j); };

  for (let i = 0; i < hostnames.length; i++) {
    const a = hostToEmb.get(hostnames[i]);
    for (let j = i + 1; j < hostnames.length; j++) {
      const b = hostToEmb.get(hostnames[j]);
      if (cosineSimilarity(a, b) >= FRESH_CLUSTER_THRESHOLD) union(i, j);
    }
  }

  const hostnameToCluster = new Map();
  for (let i = 0; i < hostnames.length; i++) {
    hostnameToCluster.set(hostnames[i], find(i));
  }

  // ── 3rd pass: centroid-similarity merge ─────────────────────────────────────
  // After the tight per-pair clustering, over-fragmented clusters often have
  // very similar centroids that didn't quite cross the tight threshold (e.g.
  // multiple TCG sites split into 3 clusters because no single pair hit 0.55).
  // We compute a centroid per cluster and merge cluster pairs whose centroids
  // hit a looser threshold. This is hierarchical-clustering-lite without the
  // bookkeeping cost of true single-linkage on every iteration.
  const groupHostnamesByCluster = new Map(); // clusterId → [hostname, ...]
  for (let i = 0; i < hostnames.length; i++) {
    const cid = find(i);
    if (!groupHostnamesByCluster.has(cid)) groupHostnamesByCluster.set(cid, []);
    groupHostnamesByCluster.get(cid).push(hostnames[i]);
  }
  const centroids = new Map();
  for (const [cid, hosts] of groupHostnamesByCluster) {
    const embs = hosts.map((h) => hostToEmb.get(h)).filter(Boolean);
    if (embs.length === 0) continue;
    const avg = averageVectors(embs);
    if (avg) centroids.set(cid, l2Normalize(avg));
  }
  const mergeCids = [...centroids.keys()];
  const mergeParent = new Map(mergeCids.map((c) => [c, c]));
  const findM = (c) => {
    let r = c;
    while (mergeParent.get(r) !== r) r = mergeParent.get(r);
    let cur = c;
    while (mergeParent.get(cur) !== r) {
      const next = mergeParent.get(cur);
      mergeParent.set(cur, r);
      cur = next;
    }
    return r;
  };
  let mergedPairs = 0;
  for (let i = 0; i < mergeCids.length; i++) {
    const a = centroids.get(mergeCids[i]);
    for (let j = i + 1; j < mergeCids.length; j++) {
      const b = centroids.get(mergeCids[j]);
      const sim = cosineSimilarity(a, b);
      if (sim >= FRESH_MERGE_THRESHOLD && findM(mergeCids[i]) !== findM(mergeCids[j])) {
        mergeParent.set(findM(mergeCids[i]), findM(mergeCids[j]));
        mergedPairs++;
      }
    }
  }
  if (mergedPairs > 0) {
    console.log(`${LOG} Local Fresh: merge pass linked ${mergedPairs} cluster pair(s) at centroid-sim ≥ ${FRESH_MERGE_THRESHOLD}`);
    // Re-apply merge to hostname→cluster mapping
    for (const h of hostnameToCluster.keys()) {
      const oldCid = hostnameToCluster.get(h);
      hostnameToCluster.set(h, findM(oldCid));
    }
  }

  // Bucket every input tab into its cluster (or skip if its hostname had no
  // embedding — e.g. about:* tabs).
  const clusters = new Map();
  const skipped = [];
  for (const t of tabs) {
    const cid = hostnameToCluster.get(t.hostname);
    if (cid === undefined) { skipped.push(t); continue; }
    if (!clusters.has(cid)) clusters.set(cid, []);
    clusters.get(cid).push(t);
  }

  // Demote singletons to skipped; everything else becomes a new group.
  const rawGroups = [];
  for (const members of clusters.values()) {
    if (members.length < FRESH_MIN_CLUSTER_SIZE) {
      skipped.push(...members);
    } else {
      rawGroups.push({ name: nameClusterFromSignals(members, snippetByHostname), tabs: members });
    }
  }

  // ── Name-dedupe: if the hostname-naming heuristic produced collisions
  // (e.g. two separate Google-flavored clusters both named "Google"), merge
  // them into one. Final safety net beyond the centroid pass.
  const byName = new Map();
  const newGroups = [];
  let nameDedupes = 0;
  for (const g of rawGroups) {
    if (byName.has(g.name)) {
      byName.get(g.name).tabs.push(...g.tabs);
      nameDedupes++;
    } else {
      byName.set(g.name, g);
      newGroups.push(g);
    }
  }
  if (nameDedupes > 0) {
    console.log(`${LOG} Local Fresh: deduped ${nameDedupes} duplicate-named cluster(s)`);
  }

  console.log(
    `${LOG} Local Fresh: ${newGroups.length} cluster(s), ${skipped.length} singleton(s)/no-host tab(s) skipped`
  );
  return { assignedToExisting: [], newGroups, skipped };
};

// ─── Apply the AI decisions ───────────────────────────────────────────────────

const addDomainToRule = (ruleName, hostname, rules) => {
  const rule = rules.find((r) => r.name === ruleName);
  if (!rule) return false;
  if (!hostname || rule.domains.includes(hostname)) return false;
  rule.domains.push(hostname);
  return true;
};

const cleanTitleTerm = (term) => String(term || "").trim();

const titleTermsForGroup = (patches, groupName) => {
  const key = String(groupName || "").toLocaleLowerCase();
  return (patches.find((patch) => String(patch.groupName || "").toLocaleLowerCase() === key)?.titleTerms || [])
    .map((item) => cleanTitleTerm(item?.term))
    .filter(Boolean);
};

const addTitleTermsToRule = (ruleName, terms, rules) => {
  const rule = rules.find((r) => r.name === ruleName);
  if (!rule || !terms?.length) return 0;
  if (!Array.isArray(rule.titleTerms)) rule.titleTerms = [];
  const seen = new Set(rule.titleTerms.map((term) => term.toLocaleLowerCase()));
  let added = 0;
  for (const term of terms) {
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rule.titleTerms.push(term);
    added++;
  }
  return added;
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
  let titleTermsGrown = 0;
  let newGroupsCreated = 0;
  let newRulesCreated = 0;
  const rulePatches = Array.isArray(pass2Result.rulePatches) ? pass2Result.rulePatches : [];

  // Seed the in-use color set from existing rules so new AI groups don't
  // duplicate them. Updated as each new group is created within this batch.
  const usedColors = new Set(
    rules.map((r) => r.color).filter((c) => typeof c === "string" && c.length > 0)
  );

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
        titleTermsGrown += addTitleTermsToRule(a.groupName, titleTermsForGroup(rulePatches, a.groupName), rules);
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
          const titleTerms = titleTermsForGroup(rulePatches, cluster.name);
          rules.push({
            name: cluster.name,
            domains: hostnames,
            ...(titleTerms.length ? { titleTerms } : {}),
            color,
          });
          newRulesCreated++;
          titleTermsGrown += titleTerms.length;
        }
      } else if (newGroupBehavior === "prompt") {
        openZenEditModalForGroup(newGroup);
        // The user can rename / recolor via Zen's edit modal. They'll need
        // to use the tab right-click "Add to Rule…" submenu afterwards if
        // they want the chosen name persisted as a rule.
      }
      // "transient" — group exists in sidebar (with color) but we don't touch rules.
    } catch (e) {
      console.error(`${LOG} AI: failed to create new group "${cluster.name}":`, e);
    }
  }

  // Persist any rule changes (rule grow + new rules).
  if (rulesGrown > 0 || titleTermsGrown > 0 || newRulesCreated > 0) writeRulesPref(rules);

  return { movedToExisting, rulesGrown, titleTermsGrown, newGroupsCreated, newRulesCreated };
};
