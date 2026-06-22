// Zen Tab Wand — Ollama engine orchestrators.
//
// Talks to a local Ollama daemon (via modules/ollama-transport.mjs) to do
// AI-driven Pass 2 sorting. Two flavors:
//   - Unified classifier: assigns into existing rule-named groups AND invents
//     new groups for tabs that don't fit. Single call, then a merge pass to
//     consolidate over-specialized categories.
//   - Fresh classifier: ignores existing rules entirely, re-clusters every
//     tab from scratch. Powers the "Fresh categories" and Plan Mode flows.
//
// All transport (fetch, ping, warmup, JSON-validate) lives in
// ollama-transport.mjs. All prompt strings live in ollama-prompts.mjs. This
// file is just the orchestration of "send N prompts and merge their results
// into the shape applyPass2 expects".

import { LOG } from "./config.mjs";
import { getOllamaHost, getOllamaModel } from "./rules.mjs";
import { fetchPageSnippet } from "./tabs.mjs";
import { showToast } from "./ui-toast.mjs";
import { ollamaGenerateJson } from "./ollama-transport.mjs";
import {
  buildClassifyPrompt,
  buildClusterPrompt,
  buildUnifiedPrompt,
  buildFreshPrompt,
  buildMergePrompt,
  buildTitleTermPrompt,
} from "./ollama-prompts.mjs";

// Re-export the transport surface that callers outside this module still need
// (click-handler imports normalizeOllamaHost / checkOllamaReady / warmupOllama /
// reportOllamaError). Keeps the public API of "the Ollama module" stable even
// though the implementation is now split.
export {
  normalizeOllamaHost,
  checkOllamaReady,
  warmupOllama,
  reportOllamaError,
} from "./ollama-transport.mjs";

// Strip common meta-prefixes the model has been observed to echo back from
// the prompt's instructions. e.g. "New Category: Gaming" → "Gaming".
// Shared across classifiers — previously duplicated in two places.
const stripMetaPrefix = (s) => s
  .replace(/^\s*(?:new\s+)?(?:category|label|topic|bucket|group)\s*[:\-–]\s*/i, "")
  .trim();

const TITLE_TERM_LIMIT = 3;
const TITLE_CONTENT_FETCH_LIMIT = 30;
const TITLE_CANDIDATE_LIMIT = 24;
const TITLE_TERM_STOPWORDS = new Set([
  "about", "after", "again", "all", "and", "are", "article", "best", "blog",
  "buy", "can", "com", "comment", "comments", "content", "description",
  "download", "for", "from", "guide", "home", "how", "image", "images",
  "into", "latest", "login", "news", "official", "online", "order", "page",
  "pages", "photo", "photos", "platform", "platforms", "post", "privacy",
  "product", "profile", "read", "reddit", "search", "service", "services",
  "share", "site", "stream", "summary", "support", "the", "this", "tips",
  "today", "topic", "type", "upload", "video", "watch", "website", "with",
  "you", "your",
]);

const titleTokens = (title) => {
  const text = String(title || "").replace(/\s+/g, " ");
  return text.match(/[A-Za-z0-9][A-Za-z0-9'’-]{1,38}/g) || [];
};

const normalizeTitleTerm = (term) =>
  String(term || "").toLocaleLowerCase().replace(/[’]/g, "'").trim();

const isUsefulTitleToken = (token, hostname = "") => {
  const cleaned = String(token || "").replace(/^[^\w]+|[^\w]+$/g, "");
  const norm = normalizeTitleTerm(cleaned);
  if (norm.length < 3) return false;
  if (TITLE_TERM_STOPWORDS.has(norm)) return false;
  if (/^\d+$/.test(norm)) return false;
  if (hostname && normalizeTitleTerm(hostname).split(".").includes(norm)) return false;
  return true;
};

const looksDistinctive = (token) => {
  const text = String(token || "");
  const norm = normalizeTitleTerm(text);
  if (text.length >= 4 && text === text.toLocaleUpperCase() && /[A-Z]/.test(text)) return true;
  if (/^[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)*$/.test(text)) return true;
  if (norm.length >= 6 && /[a-z]/.test(norm)) return true;
  return false;
};

const allPlanGroups = (plan) => {
  const byName = new Map();
  for (const g of plan?.titleAuditGroups || []) {
    byName.set(g.name, { name: g.name, tabs: [...(g.tabs || [])] });
  }
  for (const g of plan?.newGroups || []) {
    byName.set(g.name, { name: g.name, tabs: [...(g.tabs || [])] });
  }
  for (const a of plan?.assignedToExisting || []) {
    if (!byName.has(a.groupName)) byName.set(a.groupName, { name: a.groupName, tabs: [] });
    byName.get(a.groupName).tabs.push(a.tabInfo);
  }
  return [...byName.values()];
};

const existingTitleTermKeys = (rules) => {
  const out = new Set();
  for (const rule of rules || []) {
    for (const term of rule.titleTerms || []) {
      const key = normalizeTitleTerm(term);
      if (key) out.add(key);
    }
  }
  return out;
};

const addTitleCandidate = (byKey, existingTerms, group, tab, raw, snippet = "") => {
  const term = String(raw || "").replace(/^[^\w]+|[^\w]+$/g, "");
  if (!isUsefulTitleToken(term, tab?.hostname)) return;
  const key = normalizeTitleTerm(term);
  if (existingTerms.has(key)) return;
  if (!byKey.has(key)) {
    byKey.set(key, { term, count: 0, hosts: new Set(), titles: new Set(), urls: new Set(), snippets: new Set(), sourceGroups: new Set() });
  }
  const candidate = byKey.get(key);
  candidate.count++;
  if (tab?.hostname) candidate.hosts.add(tab.hostname);
  if (tab?.title) candidate.titles.add(tab.title);
  if (tab?.url) candidate.urls.add(tab.url);
  if (snippet) candidate.snippets.add(snippet);
  if (group.name) candidate.sourceGroups.add(group.name);
  if (candidate.term === candidate.term.toLocaleLowerCase() && term !== term.toLocaleLowerCase()) {
    candidate.term = term;
  }
};

const fetchContentCandidateSnippets = async (groups) => {
  const seen = new Set();
  const jobs = [];
  for (const group of groups) {
    for (const tab of group.tabs || []) {
      const url = tab?.url || "";
      if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      jobs.push({ group, tab });
      if (jobs.length >= TITLE_CONTENT_FETCH_LIMIT) break;
    }
    if (jobs.length >= TITLE_CONTENT_FETCH_LIMIT) break;
  }

  const snippets = await Promise.all(jobs.map(async ({ group, tab }) => ({
    group,
    tab,
    snippet: await fetchPageSnippet(tab.url),
  })));
  return snippets.filter((entry) => entry.snippet);
};

const collectTitleTermCandidates = async (plan, rules, mode) => {
  const groups = allPlanGroups(plan);
  if (groups.length === 0) return [];

  const existingTerms = existingTitleTermKeys(rules);
  const byKey = new Map();
  for (const group of groups) {
    for (const tab of group.tabs || []) {
      const seenInTab = new Set();
      for (const raw of titleTokens(tab?.title)) {
        const term = raw.replace(/^[^\w]+|[^\w]+$/g, "");
        if (!isUsefulTitleToken(term, tab?.hostname)) continue;
        const key = normalizeTitleTerm(term);
        if (existingTerms.has(key) || seenInTab.has(key)) continue;
        seenInTab.add(key);
        addTitleCandidate(byKey, existingTerms, group, tab, term);
      }
    }
  }

  if (mode === "review-save-complex") {
    const contentEntries = await fetchContentCandidateSnippets(groups);
    for (const { group, tab, snippet } of contentEntries) {
      const seenInSnippet = new Set();
      for (const raw of titleTokens(snippet)) {
        const term = raw.replace(/^[^\w]+|[^\w]+$/g, "");
        const key = normalizeTitleTerm(term);
        if (existingTerms.has(key) || seenInSnippet.has(key)) continue;
        seenInSnippet.add(key);
        if (!looksDistinctive(term)) continue;
        addTitleCandidate(byKey, existingTerms, group, tab, term, snippet);
      }
    }
  }

  return [...byKey.values()]
    .filter((c) => c.count >= 2 || c.hosts.size >= 2 || (c.snippets.size > 0 && looksDistinctive(c.term)))
    .sort((a, b) =>
      (b.hosts.size - a.hosts.size) ||
      (b.count - a.count) ||
      (a.term.length - b.term.length)
    )
    .slice(0, TITLE_CANDIDATE_LIMIT)
    .map((c) => ({
      term: c.term,
      titles: [...c.titles],
      urls: [...c.urls],
      snippets: [...c.snippets],
      sourceGroups: [...c.sourceGroups],
    }));
};

export const proposeTitleTermPatches = async (plan, rules, host, model, mode = "review-save-simple") => {
  const candidates = await collectTitleTermCandidates(plan, rules, mode);
  if (candidates.length === 0) return [];

  const prompt = buildTitleTermPrompt(rules, candidates, mode === "review-save-complex" ? "complex" : "simple");
  const r = await ollamaGenerateJson(host, model, prompt);
  if (!r.ok) {
    console.warn(`${LOG} Ollama title learning failed (${r.errorType}: ${r.error})`);
    return [];
  }
  const parsed = r.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`${LOG} Ollama title learning returned non-object JSON`);
    return [];
  }

  const existingRuleNameByLower = new Map(
    (rules || []).filter((r) => r?.name).map((r) => [r.name.toLocaleLowerCase(), r.name])
  );
  const candidateByKey = new Map(candidates.map((c) => [normalizeTitleTerm(c.term), c]));
  const byGroup = new Map();

  for (const [rawTerm, rawValue] of Object.entries(parsed)) {
    const idx = Number.parseInt(rawTerm, 10);
    const candidate = candidateByKey.get(normalizeTitleTerm(rawTerm)) ||
      (Number.isFinite(idx) ? candidates[idx] : null);
    if (!candidate) continue;
    const rawGroupName = rawValue && typeof rawValue === "object"
      ? (rawValue.category || rawValue.groupName || rawValue.label || rawValue.name)
      : rawValue;
    const groupRaw = stripMetaPrefix(String(rawGroupName || "").trim());
    const groupLower = groupRaw.toLocaleLowerCase();
    if (!groupRaw || groupLower === "none" || groupLower === "skipped") continue;

    const groupName = existingRuleNameByLower.get(groupLower) || groupRaw;
    const groupKey = groupName.toLocaleLowerCase();
    if (!byGroup.has(groupKey)) byGroup.set(groupKey, { groupName, titleTerms: [] });
    const item = { term: candidate.term };
    if (!existingRuleNameByLower.has(groupKey)) item.warning = "Creates a title-only rule";
    if (candidate.sourceGroups.length > 1) {
      item.warning = item.warning
        ? `${item.warning}; also appeared in ${candidate.sourceGroups.join(", ")}`
        : `Also appeared in ${candidate.sourceGroups.join(", ")}`;
    }
    byGroup.get(groupKey).titleTerms.push(item);
  }

  return [...byGroup.values()].map((patch) => ({
    groupName: patch.groupName,
    titleTerms: patch.titleTerms.slice(0, TITLE_TERM_LIMIT),
  }));
};

// ─── Classify into existing rules ────────────────────────────────────────────
// Returns Map<tabIndex, groupName | null>. Throws on transport / parse errors;
// caller surfaces to the user. Used both directly (re-assign-to-planned in
// the Plan Mode modal) and indirectly via the Ollama Pass 2 driver.

export const classifyExistingGroupsBatch = async (unmatched, rules, host, model) => {
  if (!unmatched?.length || !rules?.length) return new Map();
  const prompt = buildClassifyPrompt(rules, unmatched);
  const groupNames = rules.map((r) => r?.name).filter(Boolean);

  const r = await ollamaGenerateJson(host, model, prompt);
  if (!r.ok) {
    throw new Error(`Ollama classify: ${r.error}`);
  }
  const parsed = r.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Ollama classify: returned non-object JSON");
  }

  console.debug(`${LOG} Ollama raw classification:`, parsed);

  // Validate categories — small models occasionally hallucinate names that
  // weren't in the list. Case-insensitive match to be forgiving of "shopping"
  // vs "Shopping". Anything still unmatched is dropped to null.
  const nameByLower = new Map(groupNames.map((n) => [n.toLowerCase(), n]));
  const rejections = [];
  const out = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    const idx = Number.parseInt(key, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= unmatched.length) continue;
    const v = String(value || "").trim();
    if (!v || v.toLowerCase() === "none") { out.set(idx, null); continue; }
    const canonical = nameByLower.get(v.toLowerCase());
    if (canonical) {
      out.set(idx, canonical);
    } else {
      rejections.push(`${unmatched[idx]?.hostname || `tab${idx}`} → "${v}"`);
      out.set(idx, null);
    }
  }
  if (rejections.length > 0) {
    console.warn(`${LOG} Ollama returned ${rejections.length} category name(s) not in rules — treated as no match: ${rejections.join(", ")}`);
  }
  for (let i = 0; i < unmatched.length; i++) if (!out.has(i)) out.set(i, null);
  return out;
};

// ─── Cluster leftover tabs into new groups ───────────────────────────────────
// Older fallback. The unified classifier replaced this for the main flow, but
// it's still used when there are no existing rules (no categories to slot
// into) — the unified prompt has nothing to compare against in that case.

const clusterUnmatchedNewGroups = async (leftover, host, model) => {
  if (!leftover?.length) return { groups: [], skipped: [] };
  const prompt = buildClusterPrompt(leftover);

  const r = await ollamaGenerateJson(host, model, prompt);
  if (!r.ok) throw new Error(`Ollama cluster: ${r.error}`);

  console.debug(`${LOG} Ollama raw clustering:`, r.parsed);

  const validIdx = (i) => Number.isFinite(i) && i >= 0 && i < leftover.length;
  const seen = new Set();
  const groups = [];
  for (const g of Array.isArray(r.parsed?.groups) ? r.parsed.groups : []) {
    const name = String(g?.name || "").trim();
    if (!name) continue;
    const indices = Array.isArray(g?.tabs) ? g.tabs.filter(validIdx) : [];
    const tabs = [];
    for (const i of indices) {
      if (seen.has(i)) continue;
      seen.add(i);
      tabs.push(leftover[i]);
    }
    if (tabs.length > 0) groups.push({ name, tabs });
  }
  const skipped = leftover.filter((_, i) => !seen.has(i));
  return { groups, skipped };
};

// ─── Unified classification ──────────────────────────────────────────────────
// Single Ollama call that asks the model, for each tab, EITHER an existing
// rule category OR a new category name OR "skipped". Followed by a merge pass
// to consolidate. Used when the engine is Ollama and the flow isn't fresh /
// Plan Mode (i.e., auto-add / always-add / transient / prompt modes).

export const unifiedClassifyOllama = async (unmatched, rules, host, model) => {
  if (!unmatched?.length) return { assignedToExisting: [], newGroups: [], skipped: [] };

  // No existing rules → degrades to pure clustering. Use the dedicated cluster
  // prompt (it's tuned for that case, the unified prompt would have no
  // categories section to render).
  if (!rules.some((r) => r?.name)) {
    const c = await clusterUnmatchedNewGroups(unmatched, host, model);
    return { assignedToExisting: [], newGroups: c.groups, skipped: c.skipped };
  }

  // Dedup logically-identical tabs (same hostname + title). Two open copies
  // of costco.com previously got classified independently — leading to
  // "costco → Shopping" for one and "costco → skipped" for the other in the
  // same run. We send each unique combo once and replicate the model's
  // answer back to every original.
  const dedupKey = (t) => `${t.hostname || ""}\x00${t.title || ""}`;
  const dedupIndexByKey = new Map();
  const deduped = [];
  const origToDeduped = unmatched.map((t) => {
    const k = dedupKey(t);
    if (dedupIndexByKey.has(k)) return dedupIndexByKey.get(k);
    const i = deduped.length;
    dedupIndexByKey.set(k, i);
    deduped.push(t);
    return i;
  });
  if (deduped.length < unmatched.length) {
    console.log(`${LOG} Ollama: deduplicated ${unmatched.length} tabs → ${deduped.length} unique`);
  }

  // Fetch page snippets in parallel. Each is bounded by its own 3s timeout,
  // and any failure (auth, timeout, non-HTML, no meta tag) returns "" so the
  // tab just falls back to title-only context — never blocks classification.
  const t0 = performance.now();
  const snippets = await Promise.all(deduped.map((t) => {
    const url = t.url || "";
    if (!url.startsWith("http://") && !url.startsWith("https://")) return "";
    return fetchPageSnippet(url);
  }));
  const hit = snippets.filter((s) => s).length;
  console.log(`${LOG} Ollama: fetched page snippets for ${hit}/${deduped.length} tab(s) in ${Math.round(performance.now() - t0)}ms`);
  console.groupCollapsed(`${LOG} Ollama snippet detail (collapse)`);
  console.log(
    `${LOG} Ollama snippet detail:\n` +
    deduped.map((t, i) => `  ${t.hostname || "(no host)"} → ${snippets[i] ? `"${snippets[i].slice(0, 80)}${snippets[i].length > 80 ? "…" : ""}"` : "(no snippet)"}`).join("\n")
  );
  console.groupEnd();

  const prompt = buildUnifiedPrompt(rules, deduped, snippets);
  const r = await ollamaGenerateJson(host, model, prompt);
  if (!r.ok) throw new Error(`Ollama unified: ${r.error}`);
  const parsed = r.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Ollama unified: returned non-object JSON");
  }

  console.debug(`${LOG} Ollama unified classification:`, parsed);

  // Lookup table for canonicalizing an existing rule name (case-insensitive).
  const ruleNameByLower = new Map(
    rules.filter((r) => r?.name).map((r) => [r.name.toLowerCase(), r.name])
  );

  const assignedToExisting = [];
  const newGroupsByKey = new Map();
  const skipped = [];

  for (let i = 0; i < unmatched.length; i++) {
    const dedupIdx = origToDeduped[i];
    const value = parsed[dedupIdx] !== undefined ? parsed[dedupIdx] : parsed[String(dedupIdx)];
    const raw = stripMetaPrefix(value == null ? "" : String(value).trim());
    const lower = raw.toLowerCase();

    if (!raw || lower === "skipped" || lower === "none") {
      skipped.push(unmatched[i]);
      continue;
    }

    const canonicalExisting = ruleNameByLower.get(lower);
    if (canonicalExisting) {
      assignedToExisting.push({ tabInfo: unmatched[i], groupName: canonicalExisting, similarity: 1.0 });
      continue;
    }

    // Brand-new category. Group tabs by case-insensitive key so the model
    // saying "Gaming" once and "gaming" later still co-clusters.
    if (!newGroupsByKey.has(lower)) {
      newGroupsByKey.set(lower, { name: raw, tabs: [] });
    }
    newGroupsByKey.get(lower).tabs.push(unmatched[i]);
  }

  // Merge pass — consolidate over-specialized categories. No post-filter:
  // 1-tab survivors are honored as the model's intent rather than dropped.
  let newGroups = [...newGroupsByKey.values()];
  if (newGroups.length >= 2) {
    try {
      newGroups = await mergeNewCategoriesPass(newGroups, host, model);
    } catch (e) {
      console.warn(`${LOG} Ollama merge-pass errored — keeping un-merged groups:`, e);
    }
  }
  // 3rd phase — fuzzy name dedupe (catches what the LLM merge missed).
  newGroups = dedupeSimilarNewGroups(newGroups);

  return { assignedToExisting, newGroups, skipped };
};

// ─── 3rd-phase name-based dedupe ─────────────────────────────────────────────
// Catches near-identical names the LLM merge pass missed. Symptoms we've seen
// in the wild that motivated this:
//   - "Content Unavailable" + "Content Unavailability"     (morphology drift)
//   - "Communication Apps" + "Communication Tools"         (different suffix)
//   - "Project Management" + "Project Management Tools"    (substring extra)
// Strategy: normalize each name to a stem + drop trailing generic words
// (Tools / Apps / Platforms / ...), then merge groups with the same normalized
// form. The canonical name kept is whichever group appears FIRST in the input
// — typically the LLM's "cleaner" first proposal.

const TRAILING_GENERICS = new Set([
  "tools", "tool", "apps", "app", "platforms", "platform",
  "services", "service", "sites", "site", "websites", "website",
  "products", "product", "stuff", "things",
]);

const lightStem = (word) =>
  word
    .replace(/(ability|ibility)$/i, "")
    .replace(/(able|ible)$/i, "")
    .replace(/(ation|ization)$/i, "")
    .replace(/(ing)$/i, "")
    .replace(/(ies)$/i, "y")
    .replace(/(s)$/i, "");

const normalizeNameForDedupe = (name) => {
  const words = String(name || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (words.length > 1 && TRAILING_GENERICS.has(words[words.length - 1])) {
    words.pop();
  }
  return words.map(lightStem).join(" ");
};

const dedupeSimilarNewGroups = (newGroups) => {
  if (!newGroups || newGroups.length < 2) return newGroups || [];
  const byNorm = new Map(); // normalized → index in `out`
  const out = [];
  let mergedCount = 0;
  for (const g of newGroups) {
    const norm = normalizeNameForDedupe(g.name);
    if (byNorm.has(norm)) {
      const existing = out[byNorm.get(norm)];
      console.log(`${LOG} Ollama 3rd-pass dedupe: "${g.name}" → "${existing.name}" (normalized match: "${norm}")`);
      existing.tabs.push(...g.tabs);
      mergedCount++;
    } else {
      byNorm.set(norm, out.length);
      out.push({ ...g });
    }
  }
  if (mergedCount > 0) {
    console.log(`${LOG} Ollama 3rd-pass dedupe: collapsed ${mergedCount} similar-named cluster(s) (${newGroups.length} → ${out.length})`);
  }
  return out;
};

// ─── Merge pass ──────────────────────────────────────────────────────────────
// Asks the model to consolidate the newGroups it just proposed into fewer,
// broader categories. Schema is a flat { "Original Name": "Target Name" }
// map — nested arrays-of-objects consistently produced bad JSON in testing.
// Falls back to the input newGroups on any error (logged, no throw).

const mergeNewCategoriesPass = async (newGroups, host, model) => {
  if (!newGroups || newGroups.length < 2) return newGroups;
  const prompt = buildMergePrompt(newGroups);
  const t0 = performance.now();

  const r = await ollamaGenerateJson(host, model, prompt);
  if (!r.ok) {
    console.warn(`${LOG} Ollama merge-pass failed (${r.errorType}: ${r.error}), keeping original groups`);
    return newGroups;
  }
  const parsed = r.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`${LOG} Ollama merge-pass returned non-object, keeping original groups (got ${Array.isArray(parsed) ? "array" : typeof parsed})`);
    return newGroups;
  }

  console.log(`${LOG} Ollama merge-pass took ${Math.round(performance.now() - t0)}ms`);
  console.debug(`${LOG} Ollama merge-pass raw response:`, parsed);

  // Schema: { "Original Name": "Target Name", ... } — for each original, the
  // model picks a target. Originals sharing a target get merged into one
  // final group whose name is that target.
  const origByLower = new Map(newGroups.map((g) => [g.name.toLowerCase(), g]));
  const consumed = new Set();
  const byTarget = new Map();

  for (const [origName, targetRaw] of Object.entries(parsed)) {
    const origKey = String(origName || "").trim().toLowerCase();
    const targetName = String(targetRaw || "").trim();
    if (!origKey || !targetName) continue;
    const src = origByLower.get(origKey);
    if (!src) continue;
    if (consumed.has(origKey)) continue;
    consumed.add(origKey);

    const targetKey = targetName.toLowerCase();
    if (!byTarget.has(targetKey)) {
      byTarget.set(targetKey, { name: targetName, tabs: [] });
    }
    byTarget.get(targetKey).tabs.push(...src.tabs);
  }

  const merged = [...byTarget.values()];

  // Defensive: any original category the model omitted from the merge plan
  // gets kept as-is. The model isn't allowed to silently drop tabs just
  // because it forgot to mention them.
  for (const g of newGroups) {
    if (!consumed.has(g.name.toLowerCase())) {
      console.log(`${LOG} Ollama merge-pass omitted "${g.name}" — keeping unchanged`);
      merged.push(g);
    }
  }
  return merged;
};

// ─── Pass 2 drivers (public API for click-handler) ───────────────────────────

/**
 * Pass 2 driver for the Ollama engine. Same return shape as runPass2 in
 * ai.mjs so applyPass2() can consume the result unchanged.
 *
 * @returns Promise<{ assignedToExisting, newGroups, skipped, failed? }>
 */
export const runPass2Ollama = async (unmatched, rules) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!unmatched?.length) return empty;

  const host = getOllamaHost();
  const model = getOllamaModel();
  try {
    return await unifiedClassifyOllama(unmatched, rules, host, model);
  } catch (e) {
    console.error(`${LOG} Ollama unified classification failed:`, e);
    showToast(`Ollama classification failed: ${e.message || e}`);
    return { ...empty, skipped: unmatched, failed: e.message || String(e) };
  }
};

/**
 * Phase 4c — "Fresh categories" mode. Considers ALL eligible tabs (matched
 * and unmatched) and proposes a complete re-grouping from scratch, ignoring
 * the existing rule names entirely. `assignedToExisting` is always empty.
 *
 * @returns Promise<{ assignedToExisting, newGroups, skipped, failed? }>
 */
export const runPass2OllamaFresh = async (allTabs) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!allTabs?.length) return empty;

  const host = getOllamaHost();
  const model = getOllamaModel();

  try {
    // Dedup duplicate tabs (same hostname + title) — same reasoning as the
    // unified path. Avoids inconsistent answers across copies of the same tab.
    const dedupKey = (t) => `${t.hostname || ""}\x00${t.title || ""}`;
    const dedupIndexByKey = new Map();
    const deduped = [];
    const origToDeduped = allTabs.map((t) => {
      const k = dedupKey(t);
      if (dedupIndexByKey.has(k)) return dedupIndexByKey.get(k);
      const i = deduped.length;
      dedupIndexByKey.set(k, i);
      deduped.push(t);
      return i;
    });
    if (deduped.length < allTabs.length) {
      console.log(`${LOG} Ollama fresh: deduplicated ${allTabs.length} tabs → ${deduped.length} unique`);
    }

    const t0 = performance.now();
    const snippets = await Promise.all(deduped.map((t) => {
      const url = t.url || "";
      if (!url.startsWith("http://") && !url.startsWith("https://")) return "";
      return fetchPageSnippet(url);
    }));
    const hit = snippets.filter((s) => s).length;
    console.log(`${LOG} Ollama fresh: fetched snippets for ${hit}/${deduped.length} tab(s) in ${Math.round(performance.now() - t0)}ms`);

    const prompt = buildFreshPrompt(deduped, snippets);
    const r = await ollamaGenerateJson(host, model, prompt);
    if (!r.ok) {
      console.error(`${LOG} Ollama fresh failed (${r.errorType}):`, r.error);
      showToast(`Ollama fresh classification failed: ${r.error}`);
      return { ...empty, skipped: allTabs, failed: r.error };
    }
    const parsed = r.parsed;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`${LOG} Ollama fresh: non-object JSON, returning all as skipped`);
      return { ...empty, skipped: allTabs };
    }

    console.debug(`${LOG} Ollama fresh classification:`, parsed);

    const newGroupsByKey = new Map();
    const skipped = [];
    for (let i = 0; i < allTabs.length; i++) {
      const dedupIdx = origToDeduped[i];
      const value = parsed[dedupIdx] !== undefined ? parsed[dedupIdx] : parsed[String(dedupIdx)];
      const raw = stripMetaPrefix(value == null ? "" : String(value).trim());
      const lower = raw.toLowerCase();
      if (!raw || lower === "skipped" || lower === "none") {
        skipped.push(allTabs[i]);
        continue;
      }
      if (!newGroupsByKey.has(lower)) {
        newGroupsByKey.set(lower, { name: raw, tabs: [] });
      }
      newGroupsByKey.get(lower).tabs.push(allTabs[i]);
    }

    // Run the merge pass to consolidate over-specialized categories. No
    // post-filter — we trust whatever survives. See unifiedClassifyOllama
    // for the rationale (singletons honor model intent rather than discard it).
    let newGroups = [...newGroupsByKey.values()];
    if (newGroups.length >= 2) {
      try {
        newGroups = await mergeNewCategoriesPass(newGroups, host, model);
      } catch (e) {
        console.warn(`${LOG} Ollama merge-pass errored — keeping un-merged groups:`, e);
      }
    }
    // 3rd phase — fuzzy name dedupe (catches what the LLM merge missed).
    newGroups = dedupeSimilarNewGroups(newGroups);
    return { assignedToExisting: [], newGroups, skipped };
  } catch (e) {
    console.error(`${LOG} Ollama fresh classification failed:`, e);
    showToast(`Ollama fresh classification failed: ${e.message || e}`);
    return { ...empty, skipped: allTabs, failed: e.message || String(e) };
  }
};
