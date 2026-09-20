// Zen Tab Wand — cross-engine new-group consolidation.
//
// Two jobs shared by all three group-creation pathways (Local/TIDY_FUSION,
// Local Fresh, Ollama):
//   1. Name-collision dedupe (resolveNameCollisions et al.) — two proposed
//      groups with the same/near-identical name: merge (same topic) or
//      disambiguate (naming coincidence).
//   2. Cluster-fragmentation merge (mergeSimilarClusters) — before naming,
//      consolidate raw clusters whose CENTROIDS are close enough, independent
//      of what they'll eventually be named (same idea as Fresh's own inline
//      3rd-pass centroid merge over its union-find clusters).
//
// Pure, synchronous, zero-I/O: no Services/ChromeUtils/DOM/console/network.
// Every caller supplies its own `getCentroid` accessor; this module never
// computes an embedding itself, which keeps it plain-Node-testable and keeps
// "is this worth an embedding call" a caller decision (e.g. Ollama's
// consent-gated, only-on-collision embedding attempt).
//
// averageVectors/l2Normalize/cosineSimilarity/etld1/titleCase are relocated
// (not duplicated) from ai.mjs, and normalizeNameForDedupe/TRAILING_GENERICS/
// lightStem from ollama.mjs, both to avoid a circular import (ai.mjs imports
// resolveNameCollisions back from here).

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

// Not exported — averageVectors/l2Normalize remain the public API for a single group's centroid.
const scaleVector = (v, k) => v.map((x) => x * k);
const addVectors = (a, b) => a.map((x, i) => x + b[i]);

// Falls back to 1 for a missing/empty tabs array so a malformed group can't zero out the running sum.
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
// Stems each word and drops trailing generic words (Tools/Apps/Platforms/...)
// so e.g. "Communication Apps" and "Communication Tools" bucket together.

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

// Buckets by normalizeNameForDedupe(name); a length-1 bucket means no collision
// (callers use this to skip embedding cost entirely when nothing collides).
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

// noCentroidAction distinguishes WHY a centroid is missing: "disambiguate" (default) is a
// genuine embedding failure — fail non-destructively. "merge" is a deliberate policy state
// (no embedding was ever attempted, e.g. Ollama's no-consent path) — merge on the name
// collision alone, matching this module's pre-existing behavior for that case.
export const decideCollisionAction = (centroidA, centroidB, threshold, noCentroidAction = "disambiguate") => {
  if (!Array.isArray(centroidA) || !Array.isArray(centroidB)) return noCentroidAction;
  return cosineSimilarity(centroidA, centroidB) >= threshold ? "merge" : "disambiguate";
};

// Majority-vote brand across a cluster's tabs, for disambiguation naming (e.g. "Reading (Github)").
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

// Corroborating-evidence gate for a REAL content-similarity merge (not the noCentroidAction
// no-data fallback, which has no content signal to gate). NAME_COLLISION_MERGE_THRESHOLD alone
// sits in the compressed similarity band real embeddings don't reliably discriminate, so a name
// collision plus a similarity score in that band isn't sufficient evidence — also requiring the
// two groups' hostnames to share a registrable-domain family is. etld1's naive 2-label split is
// hardened below against known false-"overlap" shapes it would otherwise report: bare IPs and
// single-label hosts (e.g. "localhost") only count via an exact hostname match, never a partial
// split; MULTI_TENANT_SUFFIXES excludes shared free-hosting domains (github.io, wordpress.com,
// etc.) where unrelated tenants would otherwise "share a family"; TWO_LABEL_PUBLIC_SUFFIXES
// handles ccTLD patterns (co.uk etc.) where etld1's 2-label answer is the suffix itself, not the
// real registrable domain. None of this is a full Public Suffix List — a suffix/pattern not in
// either (deliberately small, non-exhaustive) denylist is a known residual gap, not a regression.
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MULTI_TENANT_SUFFIXES = new Set([
  "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev",
  "herokuapp.com", "onrender.com", "web.app", "firebaseapp.com",
  "appspot.com", "azurewebsites.net", "workers.dev", "surge.sh",
  "glitch.me", "repl.co", "blogspot.com", "wordpress.com", "tumblr.com",
  "wixsite.com", "weebly.com", "squarespace.com", "notion.site",
]);
const TWO_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "co.kr", "co.nz", "co.za",
  "co.in", "com.au", "com.br", "com.mx", "com.sg",
]);

const familySignal = (hostname) => {
  if (!hostname) return null;
  if (IPV4_RE.test(hostname) || !hostname.includes(".")) return null;
  const e = etld1(hostname);
  if (TWO_LABEL_PUBLIC_SUFFIXES.has(e)) {
    const parts = hostname.split(".");
    return parts.length >= 3 ? parts.slice(-3).join(".") : null;
  }
  return MULTI_TENANT_SUFFIXES.has(e) ? null : e;
};

export const etld1FamilyOverlap = (tabsA, tabsB) => {
  const hostsA = new Set((tabsA || []).map((t) => t?.hostname).filter(Boolean));
  const familiesA = new Set([...hostsA].map(familySignal).filter(Boolean));
  for (const t of tabsB || []) {
    const hostB = t?.hostname;
    if (!hostB) continue;
    if (hostsA.has(hostB)) return true; // exact match always counts, even for IPs/single-label hosts
    const sig = familySignal(hostB);
    if (sig && familiesA.has(sig)) return true;
  }
  return false;
};

// Per colliding entry beyond the first: hostname-brand suffix ("Reading (Github)") if free,
// else a numeric suffix ("Reading (2)") counting up until unused (in this bucket or already resolved).
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
// Generalizes Fresh's inline union-find + centroid-merge 3rd pass. Takes centroids
// directly and returns groupings of INDICES (mirrors ai.mjs's clusterEmbeddings
// shape); the caller does the flattening since only it knows what each index is.
// Not wired into runPass2Fresh itself — its inline version stays as-is. A null/
// invalid centroid never merges (stays its own singleton), matching
// decideCollisionAction's "missing data fails non-destructively" rule.
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
 * @param {(group) => number[]|null} opts.getCentroid — pure accessor; null/invalid forces
 *   disambiguate for any comparison involving that group. No embedding calls happen here.
 * @param {number} opts.threshold — cosine-similarity bar (CONFIG.NAME_COLLISION_MERGE_THRESHOLD).
 * @param {"disambiguate"|"merge"} [opts.noCentroidAction="disambiguate"] — see
 *   decideCollisionAction. Only pass "merge" when getCentroid returns null UNIFORMLY for every
 *   group in the call (Ollama's no-consent path). A mixed bucket is defended internally (a real
 *   centroid found mid-bucket gets promoted into the running comparison, see below), but that's a
 *   safety net, not a guarantee of optimal use of partial data.
 * @param {string[]} [opts.existingNames] — already-persisted names (e.g. current rule names) to
 *   seed disambiguation's "taken" set, so a name chosen this run doesn't collide with a past run's.
 *   Best-effort: only covers callers with rules on hand (not Fresh, which ignores rules by design),
 *   and never covers DOM-only tab-group names (this module never touches the live DOM).
 * @returns {{name: string, tabs: Array}[]} same shape as input, colliding entries merged or
 *   renamed. Extra fields on input groups (e.g. a caller's `_centroid`) ride along unchanged, or
 *   are copied (possibly stale) onto a merge survivor — callers should strip them from the result.
 */
export const resolveNameCollisions = (groups, { getCentroid, threshold, existingNames, noCentroidAction = "disambiguate" }) => {
  const buckets = findNameCollisionBuckets(groups);

  // Pass 1 — bucket-local merge decisions. Anchors keep their original name, so pass 2 can
  // disambiguate survivors against the complete anchor set.
  const anchors = [];
  const pendingSurvivorGroups = []; // Array<group[]>, one per bucket that had any
  for (const bucket of buckets) {
    if (bucket.length === 1) {
      anchors.push(bucket[0]);
      continue;
    }
    // Merged centroids combine as a running WEIGHTED SUM (by tab count), not repeated pairwise
    // re-averaging — the latter gives every new candidate 50% weight regardless of how much the
    // anchor already represents, so a 3+-way chain lets the first group's influence decay with
    // each merge. This doesn't make greedy/sequential clustering order-independent (an accepted,
    // inherent trade-off, same as ai.mjs's own clusterEmbeddings) — a candidate compared only
    // against the anchor's running sum can miss merging with an equally-similar SIBLING candidate
    // it was never compared against directly (known gap, not fixed here).
    const anchor = { ...bucket[0] };
    const anchorWeight0 = weightOf(bucket[0]);
    const initialCentroid = getCentroid(bucket[0]);
    // noCentroidAction="merge" assumes getCentroid is null for every group in the call, so
    // anchorSum stays null throughout and every comparison merges unconditionally. If the anchor
    // itself is null but a LATER candidate has a real centroid, that centroid gets "promoted" into
    // anchorSum so anything after it is compared against real data instead of being swept in blind.
    let anchorSum = initialCentroid ? scaleVector(initialCentroid, anchorWeight0) : null;
    const survivors = [];
    for (let i = 1; i < bucket.length; i++) {
      const candidate = bucket[i];
      const candidateCentroid = getCentroid(candidate);
      const rawAction = decideCollisionAction(anchorSum, candidateCentroid, threshold, noCentroidAction);
      // Only gate a merge reached via a REAL cosine-similarity comparison, never one supplied by
      // the noCentroidAction fallback (which has no content signal to gate).
      const isRealContentMerge = rawAction === "merge" && Array.isArray(anchorSum) && Array.isArray(candidateCentroid);
      const action = (isRealContentMerge && !etld1FamilyOverlap(anchor.tabs, candidate.tabs))
        ? "disambiguate"
        : rawAction;
      if (action === "merge") {
        anchor.tabs = [...anchor.tabs, ...candidate.tabs];
        if (anchorSum && candidateCentroid) {
          anchorSum = addVectors(anchorSum, scaleVector(candidateCentroid, weightOf(candidate)));
        } else if (!anchorSum && candidateCentroid) {
          anchorSum = scaleVector(candidateCentroid, weightOf(candidate)); // promotion, see above
        }
      } else {
        survivors.push(candidate);
      }
    }
    anchors.push(anchor);
    if (survivors.length > 0) pendingSurvivorGroups.push(survivors);
  }

  if (pendingSurvivorGroups.length === 0) return anchors;

  // Pass 2 — disambiguate against the COMPLETE anchor set (not just what's resolved so far) plus
  // existingNames, so bucket iteration order can't determine whether a cross-bucket collision is caught.
  const resolved = [...anchors];
  const usedNameTracker = [...anchors, ...(existingNames || []).map((name) => ({ name }))]; // string stand-ins, never leak into `resolved`
  for (const survivors of pendingSurvivorGroups) {
    const named = applyDisambiguationNames(survivors, usedNameTracker);
    resolved.push(...named);
    usedNameTracker.push(...named);
  }
  return resolved;
};
