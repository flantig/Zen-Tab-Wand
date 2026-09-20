// Zen Tab Wand — Pass 2 (local AI) using Firefox's bundled ML engine.
// Assigns unmatched tabs into existing rule-matched groups, and clusters leftovers
// into new groups (TIDY_FUSION, below). Models used:
//   - Mozilla/smart-tab-embedding (feature-extraction) — title → vector
//   - Mozilla/smart-tab-topic (text2text-generation) — cluster → name
//
// applyPass2's `newGroups` can be non-empty from this engine too — callers must not
// assume local-engine new-group creation is a no-op.

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
// Math/naming primitives live in dedupe.mjs — a standalone leaf both this file
// and ollama.mjs depend on, avoiding a circular import. See docs/module-dedupe.md.
import {
  averageVectors,
  l2Normalize,
  cosineSimilarity,
  etld1,
  titleCase,
  resolveNameCollisions,
  mergeSimilarClusters,
} from "./dedupe.mjs";

// ─── Engine loaders (lazy + cached for the lifetime of the window) ───────────
//
// Zen ships Firefox's local ML engine but disables it by default, so opting into
// "Enable AI sorting" implies consent to flip the pref.
// NOTE: the pref is `browser.ml.enable` (no trailing "d") — easy to typo.
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
// callers always get a flat number[] back. Without "pooling: mean" in the run options,
// the engine returns the raw per-token tensor, the parser yields null, and Local AI
// silently sorts nothing.
const poolEmbedding = (raw) => {
  let embedding;
  if (raw?.[0]?.embedding && Array.isArray(raw[0].embedding)) {
    embedding = raw[0].embedding;
  } else if (raw?.[0] && Array.isArray(raw[0])) {
    embedding = raw[0]; // batched: one vector per input text
  } else if (Array.isArray(raw) && typeof raw[0] === "number") {
    embedding = raw; // squeezed batch dimension: flat vector
  } else if (raw?.data) {
    try { embedding = Array.from(raw.data); } // raw Tensor ({ data, dims })
    catch { return null; }
  } else {
    return null;
  }
  return averageVectors(embedding);
};

// Hostname is a strong signal the model often learns (e.g. "amazon.com" hints at
// shopping even if the title doesn't).
const buildEmbedText = (titleOrInfo) => {
  if (typeof titleOrInfo === "string") return titleOrInfo;
  const { title = "", hostname = "" } = titleOrInfo;
  if (hostname) return `${title} (${hostname})`.trim();
  return title;
};

// Well under smart-tab-embedding's internal token limit, generous enough for
// title + hostname + rich snippet.
const MAX_EMBED_INPUT_CHARS = 1000;

// The MLEngineParent port can die between clicks (pref flip, memory pressure);
// the cached `embeddingEnginePromise` then resolves to a dead engine whose
// `.run()` throws "Port does not exist" for every call. This sentinel lets
// embed() report that to embedBatch so it can invalidate the cache and retry.
const DEAD_PORT_SENTINEL = Symbol("dead-port");

const embed = async (input) => {
  let text = buildEmbedText(input);
  if (!text || typeof text !== "string") return null;
  if (text.length > MAX_EMBED_INPUT_CHARS) text = text.slice(0, MAX_EMBED_INPUT_CHARS);
  try {
    const engine = await loadEmbeddingEngine();
    const result = await engine.run({
      args: [[text]],
      options: { pooling: "mean", normalize: true },
    });
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

// Embed an array of {title, hostname} inputs in chunks. `opts.yieldBetween` inserts
// an `await setTimeout(0)` between chunks so the event loop stays responsive on the
// large-workspace path. If a whole chunk comes back dead-port, the cached engine
// promise is invalidated and the chunk retried once (bounded, to avoid a reload loop
// if the engine genuinely won't load).
//
// Exported for ollama.mjs's post-collision name-dedupe check, which reuses this
// rather than re-implementing engine loading + dead-port retry.
export const embedBatch = async (inputs, opts = {}) => {
  const batchSize = opts.batchSize ?? CONFIG.AI_EMBEDDING_BATCH_SIZE;
  const yieldBetween = !!opts.yieldBetween;
  const out = [];
  let alreadyRecreated = false;
  for (let i = 0; i < inputs.length; i += batchSize) {
    const chunk = inputs.slice(i, i + batchSize);
    let results = await Promise.all(chunk.map(embed));
    // A genuinely dead engine yields SENTINEL for every input; empty-input rejections come
    // back as plain null, so require at least one SENTINEL and nothing succeeding.
    const someDead = results.some((r) => r === DEAD_PORT_SENTINEL);
    const allDeadOrNull = results.every((r) => r === DEAD_PORT_SENTINEL || r === null);
    if (someDead && allDeadOrNull && !alreadyRecreated) {
      console.warn(`${LOG} embedBatch: every embed reported "Port does not exist" — invalidating engine cache and retrying chunk`);
      embeddingEnginePromise = null;
      alreadyRecreated = true;
      results = await Promise.all(chunk.map(embed));
    }
    // Normalize sentinels back to null for a clean "couldn't embed this one" signal.
    for (const r of results) out.push(r === DEAD_PORT_SENTINEL ? null : r);
    if (yieldBetween && i + batchSize < inputs.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return out;
};

// ─── Per-tab embeddings for existing rule-matched groups ─────────────────────

// Returns per-tab embeddings (NOT a centroid) — downstream scores candidates by MAX
// similarity to any single tab in the group, since averaging dilutes strong
// specific-tab signals into a generic centroid.
//
// excludeTabs is skipped when collecting the group's embedding set: without it, a tab
// AI moved into a group last run under "transient" behavior (so not claimed by the
// rule) would show up here AND as an unmatched candidate this run, self-matching at
// cosine 1.0.
const computeExistingGroupTabEmbeddings = async (workspaceId, rules, excludeTabs = new Set(), opts = {}) => {
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
    // Same title+hostname format as the unmatched candidates, so embeddings share a semantic space.
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

// ─── TIDY_FUSION: greedy clustering + smart-tab-topic naming ────────────────
// Ported from Firefox's tidy-tabs.uc.js. Turns leftover unmatched tabs into NEW
// groups — without this, Local AI can only file tabs into existing rule groups.

// Greedy single-pass clustering: seed a group per unused vector, absorb every
// unused vector above threshold. Order-dependent, but fast.
const clusterEmbeddings = (vectors, threshold) => {
  if (!Array.isArray(vectors) || vectors.length === 0 || typeof threshold !== "number") {
    return [];
  }
  const groups = [];
  const used = new Array(vectors.length).fill(false);
  for (let i = 0; i < vectors.length; i++) {
    if (used[i]) continue;
    const group = [i];
    used[i] = true;
    for (let j = 0; j < vectors.length; j++) {
      if (i !== j && !used[j] && cosineSimilarity(vectors[i], vectors[j]) > threshold) {
        group.push(j);
        used[j] = true;
      }
    }
    groups.push(group);
  }
  return groups;
};

const TIDY_KEYWORD_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
  "how", "man", "new", "now", "old", "see", "two", "way", "who", "boy",
  "did", "its", "let", "put", "say", "she", "too", "use",
]);

const extractTidyKeywords = (titles) => {
  const wordCount = {};
  for (const w of titles.join(" ").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((word) => word.length > 2)) {
    wordCount[w] = (wordCount[w] || 0) + 1;
  }
  return Object.entries(wordCount)
    .filter(([word]) => !TIDY_KEYWORD_STOPWORDS.has(word))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
};

let topicEnginePromise = null;

const loadTopicEngine = () => {
  if (topicEnginePromise) return topicEnginePromise;
  topicEnginePromise = (async () => {
    ensureMLEnginePref();
    const { createEngine } = ChromeUtils.importESModule(
      "chrome://global/content/ml/EngineProcess.sys.mjs"
    );
    return createEngine({
      taskName: "text2text-generation",
      modelId: "Mozilla/smart-tab-topic",
      modelHub: "huggingface",
      engineId: "group-namer",
    });
  })().catch((e) => {
    topicEnginePromise = null; // allow retry on next click
    throw e;
  });
  return topicEnginePromise;
};

// Name a fresh cluster with the bundled topic model; fall back to Wand's
// hostname stitch when the model is unavailable or returns junk.
const nameClusterWithTopic = async (members) => {
  const titles = members.map((m) => m.title).filter(Boolean);
  const fallback = () => nameClusterFromHostnames(members);
  if (titles.length === 0) return fallback();
  try {
    const keywords = extractTidyKeywords(titles);
    const input = `Topic from keywords: ${keywords.join(", ")}. titles:\n${titles.join("\n")}`;
    const engine = await loadTopicEngine();
    const aiResult = await engine.run({
      args: [input],
      options: { max_new_tokens: 8, temperature: 0.7 },
    });
    let name = (aiResult[0]?.generated_text || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l);
    if (!name || /none|adult content/i.test(name)) return fallback();
    // Strip wrapping quotes/punctuation BEFORE title-casing: a leading quote (the model
    // sometimes wraps its answer in one) would otherwise occupy titleCaseToken's
    // "first character" slot and the real first letter would stay lower-cased.
    name = name
      .replace(/^['"`]+|['"`]+$/g, "")
      .replace(/[.?!,:;]+$/, "");
    // titleCaseToken, not titleCase — the model's output is a multi-word phrase and
    // titleCase only capitalizes the string's first character, not each word.
    name = titleCaseToken(name).slice(0, 24);
    return name || fallback();
  } catch (e) {
    console.warn(`${LOG} AI: topic naming failed, hostname fallback:`, e);
    return fallback();
  }
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

  // Above CONFIG.AI_LOCAL_CHUNK_THRESHOLD unmatched tabs, switch to hostname-deduped
  // embedding (one representative per unique hostname, e.g. 50 amazon.com tabs → 1
  // embed) with yielding between batches, to avoid freezing the browser.
  const useChunking = unmatched.length > CONFIG.AI_LOCAL_CHUNK_THRESHOLD;
  const batchSize = useChunking ? getLocalAIBatchSize() : CONFIG.AI_EMBEDDING_BATCH_SIZE;

  // Resolve a per-tab embedding: without chunking, `tabEmbeddings[i]`; with chunking,
  // the embedding for the tab's hostname.
  let getEmbeddingForTab;

  try {
    if (useChunking) {
      // First tab encountered per hostname becomes the representative; siblings share
      // its embedding. Guard truthy hostname so hostless tabs (about:*, chrome://,
      // file://) don't all collapse onto one rep — they fall through to skipped.
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

  // 2. Collect per-tab embeddings for existing rule-matched groups (excludes the
  //    unmatched tabs themselves — see computeExistingGroupTabEmbeddings).
  const excludeSet = new Set(unmatched.map((t) => t._tab).filter((t) => t));
  const groupTabEmbeddings = await computeExistingGroupTabEmbeddings(workspaceId, rules, excludeSet, {
    batchSize: useChunking ? batchSize : undefined,
    yieldBetween: useChunking,
  });
  console.log(`${LOG} AI: collected per-tab embeddings for ${groupTabEmbeddings.size} existing group(s): ${[...groupTabEmbeddings.keys()].map((n) => `${n}(${groupTabEmbeddings.get(n).length})`).join(", ") || "(none)"}`);

  // 3. Slot each unmatched tab into an existing group using MAX similarity against
  //    any individual tab in the group (not a centroid average).
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
      // debug level — fires per unmatched tab, only surfaces at Verbose log level.
      console.debug(`${LOG} AI sim for "${tabInfo.hostname || tabInfo.title}": ${allSims.join(", ")} → ${verdict}`);
    }
    if (best) {
      assignedToExisting.push({ tabInfo, groupName: best.groupName, similarity: best.sim });
    } else {
      remainder.push({ info: tabInfo, embedding: emb });
    }
  }

  // TIDY_FUSION — cluster leftovers into NEW groups. Uses the Tidy bar
  // (CONFIG.TIDY_LOW) and topic-model names; singletons stay skipped.
  const rawNewGroups = [];
  const skipped = [...empty.skipped];
  if (remainder.length >= 2) {
    const idxGroups = clusterEmbeddings(
      remainder.map((r) => r.embedding),
      CONFIG.TIDY_LOW
    );
    // Fragmentation-merge pass (mergeSimilarClusters): clusterEmbeddings is single-pass
    // greedy with no refinement, so related tabs (including size-1 loners) can end up
    // split across raw clusters purely from pairing order. Merge cluster pairs whose
    // centroids clear CONFIG.TIDY_MERGE_THRESHOLD (looser than TIDY_LOW), before naming
    // and before the name-collision dedupe pass further down.
    const rawCentroids = idxGroups.map((idx) =>
      idx.length > 0 ? l2Normalize(averageVectors(idx.map((k) => remainder[k].embedding))) : null
    );
    const mergedGroupings = mergeSimilarClusters(rawCentroids, CONFIG.TIDY_MERGE_THRESHOLD);
    const consolidatedIdxGroups = mergedGroupings.map((rawGroupIndices) =>
      rawGroupIndices.flatMap((gi) => idxGroups[gi])
    );
    if (consolidatedIdxGroups.length !== idxGroups.length) {
      console.log(`${LOG} AI: fragmentation merge collapsed ${idxGroups.length} → ${consolidatedIdxGroups.length} raw cluster(s)`);
    }
    // Defensive: track what's actually covered so a partitioning bug degrades to "tab
    // reported as skipped" rather than silently vanishing from the Pass-2 result.
    const covered = new Set();
    for (const idx of consolidatedIdxGroups) {
      idx.forEach((k) => covered.add(k));
      if (idx.length < 2) {
        idx.forEach((k) => skipped.push(remainder[k].info));
        continue;
      }
      const members = idx.map((k) => remainder[k].info);
      const name = await nameClusterWithTopic(members);
      // `_centroid` is internal bookkeeping for the name-collision dedupe pass below;
      // stripped before this function returns.
      const centroid = l2Normalize(averageVectors(idx.map((k) => remainder[k].embedding)));
      rawNewGroups.push({ name, tabs: members, _centroid: centroid });
      console.log(`${LOG} AI: new cluster "${name}" (${members.length} tab(s))`);
    }
    remainder.forEach((r, k) => {
      if (!covered.has(k)) skipped.push(r.info);
    });
  } else {
    remainder.forEach((r) => skipped.push(r.info));
  }

  // Two leftover clusters that the topic model named the same (e.g. both "Shopping")
  // get merged if actually similar in content, or disambiguated otherwise.
  // existingNames seeds disambiguation with current rule names, since dedupe only sees
  // this run's own groups otherwise.
  const newGroups = resolveNameCollisions(rawNewGroups, {
    getCentroid: (g) => g._centroid || null,
    threshold: CONFIG.NAME_COLLISION_MERGE_THRESHOLD,
    existingNames: rules.map((r) => r?.name).filter(Boolean),
  }).map(({ _centroid, ...g }) => g);
  if (newGroups.length !== rawNewGroups.length) {
    console.log(`${LOG} AI: name-collision dedupe collapsed ${rawNewGroups.length} → ${newGroups.length} new cluster(s)`);
  }

  return { assignedToExisting, newGroups, skipped };
};

// ─── Local Fresh: cluster-from-scratch into new groups ────────────────────────
//
// No LLM, so clusters are named from hostnames/page signals rather than abstract
// naming. Caveat: smart-tab-embedding clusters by stylistic title similarity
// (homepage-style pages cluster together regardless of topic), so results are
// quirkier than Ollama's — Preview Only lets the user rename before applying.

const FRESH_CLUSTER_THRESHOLD = 0.55; // raw cosine — broader than existing-group matching
const FRESH_MERGE_THRESHOLD = 0.40;   // 3rd-pass centroid-merge — looser than initial pairing
const FRESH_MIN_CLUSTER_SIZE = 2;     // singletons demoted to skipped

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

// Maps an Open Graph `type` to an intent label describing what the user is doing with
// the page, rather than the brand. og:type is the most reliable non-LLM signal available.
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

  // Fetch page snippets (og:type, og:site_name, h1, description) so the embedder gets
  // real page context, not just the bare title. fetchPageSnippet has its own 3s
  // timeout per request; fired in parallel, slow ones drop to "" silently.
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
  // Tight per-pair clustering can over-fragment (similar clusters whose centroids
  // never quite crossed the tight threshold); merge cluster pairs whose centroids
  // hit a looser threshold instead — hierarchical-clustering-lite without full
  // single-linkage bookkeeping.
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

  // Demote singletons to skipped; attach each group's centroid (reusing hostToEmb, no
  // new embedding calls) for the name-collision dedupe pass below.
  const rawGroups = [];
  for (const members of clusters.values()) {
    if (members.length < FRESH_MIN_CLUSTER_SIZE) {
      skipped.push(...members);
    } else {
      const embs = members.map((t) => hostToEmb.get(t.hostname)).filter(Boolean);
      const centroid = embs.length > 0 ? l2Normalize(averageVectors(embs)) : null;
      rawGroups.push({
        name: nameClusterFromSignals(members, snippetByHostname),
        tabs: members,
        _centroid: centroid,
      });
    }
  }

  // Name-dedupe: if hostname naming produced collisions (e.g. two Google-flavored
  // clusters both named "Google"), merge content-similar groups or disambiguate ones
  // that just share a name coincidentally.
  const newGroups = resolveNameCollisions(rawGroups, {
    getCentroid: (g) => g._centroid || null,
    threshold: CONFIG.NAME_COLLISION_MERGE_THRESHOLD,
  }).map(({ _centroid, ...g }) => g);
  if (newGroups.length !== rawGroups.length) {
    console.log(`${LOG} Local Fresh: name-collision dedupe collapsed ${rawGroups.length} → ${newGroups.length} cluster(s)`);
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

const titleTermsFromPatch = (patch) =>
  (patch?.titleTerms || [])
    .map((item) => cleanTitleTerm(item?.term))
    .filter(Boolean);

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
  // Falls back silently if no API is available — the group is still created, the
  // user just doesn't get the rename prompt.
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
      }
    } catch (e) {
      console.error(`${LOG} AI: failed to move tab into "${a.groupName}":`, e);
    }
  }

  // 2. Create new groups from each cluster.
  for (const cluster of pass2Result.newGroups) {
    const tabs = cluster.tabs.map((t) => t._tab).filter((t) => t?.isConnected);
    if (tabs.length === 0) continue;

    const color = pickAvailableColor(usedColors);

    try {
      const newGroup = gBrowser.addTabGroup(tabs, {
        label: cluster.name,
        // Must anchor OUTSIDE any enclosing tab-group, or Zen nests the new group
        // inside the old one — common in fresh-categories mode where tabs[0] is
        // usually already grouped under a rule.
        insertBefore: findSafeInsertAnchor(),
        color,
      });
      if (!newGroup) continue;
      newGroupsCreated++;

      // Defensive: Zen's addTabGroup may ignore the color option on older APIs.
      applyGroupColor(newGroup, color);

      if (newGroupBehavior === "auto-add") {
        // Include the chosen color so syncAllGroupColors keeps it on future tidy-clicks.
        const hostnames = [...new Set(cluster.tabs.map((t) => t.hostname).filter((h) => h))];
        if (hostnames.length > 0 && !rules.some((r) => r.name === cluster.name)) {
          rules.push({
            name: cluster.name,
            domains: hostnames,
            color,
          });
          newRulesCreated++;
        }
      } else if (newGroupBehavior === "prompt") {
        openZenEditModalForGroup(newGroup);
        // Persisting the renamed group as a rule requires the tab's "Add to Rule…" submenu.
      }
      // "transient" — group exists in sidebar (with color) but rules aren't touched.
    } catch (e) {
      console.error(`${LOG} AI: failed to create new group "${cluster.name}":`, e);
    }
  }

  // 3. Apply reviewed title-learning patches independently from tab/domain
  // grouping. These can grow existing rules or create title-only rules.
  for (const patch of rulePatches) {
    const name = String(patch.groupName || "").trim();
    const titleTerms = titleTermsFromPatch(patch);
    if (!name || titleTerms.length === 0) continue;
    let rule = rules.find((r) => String(r.name || "").toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!rule) {
      const color = pickAvailableColor(usedColors);
      rule = { name, domains: [], titleTerms: [], color };
      rules.push(rule);
      newRulesCreated++;
    }
    titleTermsGrown += addTitleTermsToRule(rule.name, titleTerms, rules);
  }

  if (rulesGrown > 0 || titleTermsGrown > 0 || newRulesCreated > 0) writeRulesPref(rules);

  return { movedToExisting, rulesGrown, titleTermsGrown, newGroupsCreated, newRulesCreated };
};
