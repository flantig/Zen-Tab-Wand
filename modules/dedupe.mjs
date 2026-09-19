// Zen Tab Wand — cross-engine new-group consolidation.
//
// Two related jobs, both about avoiding needlessly-separate new groups,
// shared by all three group-creation pathways (Local/TIDY_FUSION, Local
// Fresh, Ollama):
//   1. Name-collision dedupe (resolveNameCollisions et al.) — when two
//      proposed new groups end up with the same (or near-identical) NAME,
//      decide whether they're actually the SAME topic (merge) or just a
//      naming coincidence (disambiguate with a distinguishing suffix).
//   2. Cluster-fragmentation merge (mergeSimilarClusters) — BEFORE naming
//      even happens, consolidate raw clusters (from a single-pass greedy
//      clusterer, or any other source) whose CONTENT is similar enough that
//      they're likely the same topic split apart by clustering noise, same
//      idea as Fresh's own inline "3rd pass" centroid merge over its
//      union-find clusters. Unlike (1), this isn't gated on a naming
//      coincidence at all — it fires whenever two clusters' centroids are
//      close enough, independent of whatever they'll eventually be named.
//
// "Dedupe" stays the right frame for both: (1) avoids two groups for the
// same topic under different names, (2) avoids two groups for the same
// topic that never even reached naming as one cluster.
//
// This module is a pure, synchronous, zero-I/O leaf: no Services, no
// ChromeUtils, no DOM, no console logging, no network/engine calls. Every
// caller supplies its own `getCentroid` accessor — this module never computes
// or fetches an embedding itself. That keeps it trivially unit-testable under
// plain Node (see the verification harness) and keeps the decision of
// "is it worth the cost of an embedding call" entirely with the caller (e.g.
// Ollama's consent-gated, only-on-actual-collision embedding attempt).
//
// Relocated here (not duplicated) from modules/ai.mjs: averageVectors,
// l2Normalize, cosineSimilarity, etld1, titleCase — every existing internal
// call site in ai.mjs keeps working unchanged via import, since the bare
// identifier names are unchanged. Relocating (rather than exporting in place
// and having this module import FROM ai.mjs) avoids a circular import, since
// ai.mjs also needs to import resolveNameCollisions back from here.
//
// Relocated here (not duplicated) from modules/ollama.mjs: normalizeNameForDedupe,
// TRAILING_GENERICS, lightStem — this normalization logic now has three
// consumers (TIDY_FUSION, Fresh, Ollama) instead of one.

// ─── Math helpers (relocated from ai.mjs) ────────────────────────────────────

export const averageVectors = (arrays) => {
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

export const l2Normalize = (v) => {
  if (!Array.isArray(v) || v.length === 0) return v;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
};

export const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

// Internal-only vector helpers for resolveNameCollisions' weighted running
// centroid sum (see there for why this is a sum, not a repeated average).
// Not exported — averageVectors/l2Normalize above remain the public API for
// computing a single group's own centroid from its member embeddings.
const scaleVector = (v, k) => v.map((x) => x * k);
const addVectors = (a, b) => a.map((x, i) => x + b[i]);

// How much weight a group's centroid should carry when merging into another
// (by tab count — a group representing more tabs should pull the combined
// direction proportionally more). Falls back to 1 for a missing/empty tabs
// array so a malformed group can't collapse the running sum to zero weight.
const weightOf = (group) =>
  (Array.isArray(group?.tabs) && group.tabs.length > 0) ? group.tabs.length : 1;

// ─── Naming helpers (relocated from ai.mjs) ──────────────────────────────────

export const etld1 = (hostname) => {
  if (!hostname) return "";
  const parts = hostname.split(".");
  if (parts.length < 2) return hostname;
  return parts.slice(-2).join(".");
};

export const titleCase = (s) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

// ─── Name normalization (relocated from ollama.mjs) ──────────────────────────
// Catches near-identical names a naming heuristic (LLM or hostname-stitch)
// produced separately for what's really the same topic. Symptoms seen in the
// wild that motivated this (originally in ollama.mjs's merge/dedupe pass):
//   - "Content Unavailable" + "Content Unavailability"     (morphology drift)
//   - "Communication Apps" + "Communication Tools"         (different suffix)
//   - "Project Management" + "Project Management Tools"    (substring extra)
// Strategy: normalize each name to a stem + drop trailing generic words
// (Tools / Apps / Platforms / ...), then bucket groups with the same
// normalized form as name-collision candidates.

export const TRAILING_GENERICS = new Set([
  "tools", "tool", "apps", "app", "platforms", "platform",
  "services", "service", "sites", "site", "websites", "website",
  "products", "product", "stuff", "things",
]);

export const lightStem = (word) =>
  word
    .replace(/(ability|ibility)$/i, "")
    .replace(/(able|ible)$/i, "")
    .replace(/(ation|ization)$/i, "")
    .replace(/(ing)$/i, "")
    .replace(/(ies)$/i, "y")
    .replace(/(s)$/i, "");

export const normalizeNameForDedupe = (name) => {
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

// ─── Collision detection ──────────────────────────────────────────────────────

// Bucket `{name, tabs}[]` groups by normalizeNameForDedupe(name). Returns an
// array of buckets (each an array of the original group objects, first-seen
// order preserved both across and within buckets). A bucket of length 1 means
// no collision — every caller should skip real work when every bucket it gets
// back is a singleton (see the "skip all embedding cost" short-circuit Ollama
// uses this for).
export const findNameCollisionBuckets = (groups) => {
  const order = [];
  const indexByNorm = new Map();
  for (const g of groups || []) {
    const norm = normalizeNameForDedupe(g?.name);
    if (!indexByNorm.has(norm)) {
      indexByNorm.set(norm, order.length);
      order.push([g]);
    } else {
      order[indexByNorm.get(norm)].push(g);
    }
  }
  return order;
};

// Merge-vs-disambiguate arbiter for one colliding pair. Uncertainty must fail
// toward the non-destructive choice, never toward merging unrelated tabs —
// so ANY missing/invalid centroid on either side always disambiguates.
export const decideCollisionAction = (centroidA, centroidB, threshold) => {
  if (!Array.isArray(centroidA) || !Array.isArray(centroidB)) return "disambiguate";
  return cosineSimilarity(centroidA, centroidB) >= threshold ? "merge" : "disambiguate";
};

// Majority-vote brand across a cluster's tabs, for disambiguation naming
// (e.g. two colliding "Reading" clusters → "Reading (Github)"). Same
// etld1-majority + titleCase pattern as ai.mjs's nameClusterFromHostnames.
export const dominantBrand = (tabs) => {
  const counts = new Map();
  for (const t of tabs || []) {
    const e = etld1(t?.hostname);
    if (!e) continue;
    const base = e.split(".")[0];
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  if (counts.size === 0) return "";
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return titleCase(sorted[0][0]);
};

// Fallback chain per colliding entry BEYOND THE FIRST in a bucket: hostname-
// brand suffix ("Reading (Github)") if that brand exists and isn't itself
// already taken, else a numeric suffix ("Reading (2)") that keeps counting up
// until it finds a name nothing else (in this bucket OR anything already
// resolved) is using.
export const applyDisambiguationNames = (survivors, existingResolved) => {
  const usedNames = new Set((existingResolved || []).map((g) => g?.name));
  const out = [];
  for (const g of survivors) {
    let candidateName = g.name;
    const brand = dominantBrand(g.tabs);
    if (brand) {
      const withBrand = `${g.name} (${brand})`;
      if (!usedNames.has(withBrand)) candidateName = withBrand;
    }
    if (candidateName === g.name) {
      // Brand absent, or the brand-suffixed name itself collided — number
      // starting from the ORIGINAL name, not the failed brand attempt.
      let n = 2;
      let numbered = `${g.name} (${n})`;
      while (usedNames.has(numbered)) {
        n++;
        numbered = `${g.name} (${n})`;
      }
      candidateName = numbered;
    }
    usedNames.add(candidateName);
    out.push({ ...g, name: candidateName });
  }
  return out;
};

// ─── Cluster-fragmentation merge ──────────────────────────────────────────────
// Generalizes the union-find + centroid-similarity "3rd pass" ai.mjs's
// runPass2Fresh already does inline (merge cluster pairs whose CENTROIDS —
// not raw member-to-member pairs — clear a threshold, catching
// over-fragmentation a single-pass/pairwise clusterer left behind). Not
// wired into runPass2Fresh itself (its inline version stays as-is — no
// reason to risk regressing an already-working, already-tested path just to
// share this), but written generally enough to be reusable there later.
//
// Takes CENTROIDS directly (not raw items) and returns groupings of INDICES
// into that centroid array, mirroring ai.mjs's own clusterEmbeddings return
// shape — the caller (which knows what each index actually represents, e.g.
// an index-array of tab indices for TIDY_FUSION) does the actual flattening.
//
// A null/invalid centroid at some index never merges with anything (stays
// its own singleton output group) — same "missing data fails toward the
// non-destructive choice" rule as decideCollisionAction.
export const mergeSimilarClusters = (centroids, threshold) => {
  if (!Array.isArray(centroids) || centroids.length === 0 || typeof threshold !== "number") {
    return (centroids || []).map((_, i) => [i]);
  }
  const n = centroids.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { parent[find(i)] = find(j); };
  for (let i = 0; i < n; i++) {
    const a = centroids[i];
    if (!Array.isArray(a)) continue;
    for (let j = i + 1; j < n; j++) {
      const b = centroids[j];
      if (!Array.isArray(b)) continue;
      if (cosineSimilarity(a, b) >= threshold) union(i, j);
    }
  }
  const groups = new Map(); // root index -> member indices, insertion order
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()];
};

/**
 * The one shared entry point all three group-creation pathways call.
 *
 * @param {{name: string, tabs: Array}[]} groups
 * @param {Object} opts
 * @param {(group) => number[]|null} opts.getCentroid — caller-supplied pure
 *   accessor; returning null/undefined/non-array always forces disambiguate
 *   for any comparison involving that group. No embedding calls happen here.
 * @param {number} opts.threshold — cosine-similarity bar for merge vs.
 *   disambiguate (see CONFIG.NAME_COLLISION_MERGE_THRESHOLD).
 * @param {string[]} [opts.existingNames] — already-persisted names (e.g. the
 *   caller's current rule names) to seed disambiguation's "already taken"
 *   set with, so a freshly disambiguated name doesn't collide with a name
 *   from a PAST run — dedupe only sees the groups proposed in THIS run, so
 *   without this seed a name like "Reading (Github)" chosen to disambiguate
 *   one run's collision could independently get re-chosen by a LATER run's
 *   unrelated collision, with nothing here to know the first one is already
 *   in use. Optional and best-effort: this only covers callers that have
 *   their current rules on hand at the time they call this (TIDY_FUSION and
 *   Ollama's unified classifier do; Fresh-mode paths intentionally don't —
 *   Fresh ignores rules by design). It also doesn't cover names already used
 *   by DOM tab-groups that aren't backed by a rule (transient/prompt-mode
 *   groups) — that would need a check against the live DOM, which this
 *   module deliberately never touches (see "pure, synchronous, zero-I/O").
 * @returns {{name: string, tabs: Array}[]} same shape as the input, with
 *   colliding entries merged or renamed. Any extra fields present on input
 *   group objects (e.g. a caller's temporary `_centroid`) ride along
 *   unchanged on entries that don't merge, and are copied — possibly
 *   stale after a merge — onto the merged survivor; callers that attach such
 *   fields are expected to strip them from the result themselves.
 */
export const resolveNameCollisions = (groups, { getCentroid, threshold, existingNames }) => {
  const buckets = findNameCollisionBuckets(groups);

  // Pass 1 — merge decisions. These are bucket-local (don't depend on any
  // OTHER bucket's contents), so every bucket can be walked independently.
  // Anchors always keep their original name, so the full anchor-name set is
  // fixed and known as soon as this pass finishes — collect the leftover
  // (non-merged) survivors per bucket rather than naming them yet.
  const anchors = [];
  const pendingSurvivorGroups = []; // Array<group[]>, one per bucket that had any
  for (const bucket of buckets) {
    if (bucket.length === 1) {
      anchors.push(bucket[0]);
      continue;
    }
    // Walk the bucket: the first entry anchors it. Every subsequent entry
    // either merges into the anchor (tabs concatenated) or survives to be
    // disambiguated in pass 2.
    //
    // Merged-in centroids are combined as a running WEIGHTED SUM (weighted by
    // each merged group's tab count) rather than repeatedly re-averaging
    // PAIRS. This fixes a real equal-weighting bug the earlier pairwise
    // version had: `l2Normalize(averageVectors([anchorCentroid, candidate]))`
    // always gives the NEWEST candidate 50% weight against the anchor,
    // regardless of how many groups the anchor already absorbed — so in a
    // 3+-way chained merge, the FIRST group's influence on the running
    // centroid decays with every subsequent merge instead of staying
    // proportional to its own tab count. The weighted running sum gives each
    // merged group's centroid a stable, order-independent share of the final
    // combined direction (cosineSimilarity is scale-invariant, so comparing
    // against the unnormalized sum vs. a normalized version never changes a
    // decision — only relative weighting between merged-in groups does).
    //
    // What this does NOT fix, because it's not a bug but an inherent property
    // of any greedy/sequential clustering (the same "order-dependent but fast
    // and predictable" trade-off ai.mjs's own clusterEmbeddings already makes
    // deliberately): once B has genuinely merged into A, the combined A+B
    // identity legitimately differs from A alone, so a THIRD candidate C that
    // was similar only to original-A (not to the A+B blend) can validly stop
    // clearing the merge threshold against the blended anchor. This is
    // expected sequential-clustering behavior, not something a within-bucket
    // weighting formula can or should eliminate.
    const anchor = { ...bucket[0] };
    const anchorWeight0 = weightOf(bucket[0]);
    const initialCentroid = getCentroid(bucket[0]);
    // Once null, stays null forever: decideCollisionAction never returns
    // "merge" when either side is missing/invalid, so nothing ever adds to
    // an already-null running sum.
    let anchorSum = initialCentroid ? scaleVector(initialCentroid, anchorWeight0) : null;
    const survivors = [];
    for (let i = 1; i < bucket.length; i++) {
      const candidate = bucket[i];
      const candidateCentroid = getCentroid(candidate);
      const action = decideCollisionAction(anchorSum, candidateCentroid, threshold);
      if (action === "merge") {
        anchor.tabs = [...anchor.tabs, ...candidate.tabs];
        anchorSum = addVectors(anchorSum, scaleVector(candidateCentroid, weightOf(candidate)));
      } else {
        survivors.push(candidate);
      }
    }
    anchors.push(anchor);
    if (survivors.length > 0) pendingSurvivorGroups.push(survivors);
  }

  if (pendingSurvivorGroups.length === 0) return anchors;

  // Pass 2 — disambiguation naming, against the COMPLETE anchor-name set from
  // the start (not just whatever's been resolved so far in bucket order),
  // PLUS any caller-supplied existingNames. Without this two-pass split, a
  // bucket processed early could disambiguate into a name that a DIFFERENT,
  // not-yet-processed bucket's untouched singleton was already using (e.g.
  // one "Reading" collision resolving to "Reading (Github)" while an
  // unrelated later group is already literally named "Reading (Github)") —
  // bucket iteration order would then determine whether that collision got
  // caught, which isn't a real fix.
  //
  // `usedNameTracker` is a SEPARATE, growing accumulator from `resolved`: it
  // includes plain-string existingNames stand-ins purely for uniqueness
  // checking, which must never leak into the actual returned group list.
  const resolved = [...anchors];
  const usedNameTracker = [...anchors, ...(existingNames || []).map((name) => ({ name }))];
  for (const survivors of pendingSurvivorGroups) {
    const named = applyDisambiguationNames(survivors, usedNameTracker);
    resolved.push(...named);
    usedNameTracker.push(...named);
  }
  return resolved;
};
