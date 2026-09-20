# `modules/dedupe.mjs` — cross-engine new-group name-collision dedupe

Shared by all three group-creation pathways — Local/TIDY_FUSION (`ai.mjs` `runPass2`), Local Fresh (`ai.mjs` `runPass2Fresh`), and Ollama (`ollama.mjs`) — for one decision: when two proposed new groups end up with the same (or near-identical) name, are they the SAME topic (merge) or just a naming coincidence (disambiguate)?

## Why this module exists

Each engine previously had its own bespoke (or missing) answer: TIDY_FUSION had none, Fresh did a naive exact-string match, Ollama did a fuzzy stem match with no content awareness. None could distinguish "two clusters both named 'Shopping' because they're both shopping tabs" from "two clusters both named 'Shopping' by coincidence." This module adds embedding-based content similarity as the arbiter everywhere, including Ollama (which doesn't otherwise compute embeddings — see the Ollama call site below).

## Design constraint: pure, synchronous, zero-I/O

No `Services`/`ChromeUtils`/DOM/`console.log`/network calls. Every caller supplies its own `getCentroid` accessor; this module never computes an embedding itself. Keeps it plain-Node-testable and keeps "is this worth an embedding call" a caller decision.

`averageVectors`/`l2Normalize`/`cosineSimilarity`/`etld1`/`titleCase` are relocated (not duplicated) from `ai.mjs`, and `normalizeNameForDedupe`/`TRAILING_GENERICS`/`lightStem` from `ollama.mjs`, both to avoid a circular import (`ai.mjs` imports `resolveNameCollisions` back from here).

## Exports

| Name | Purpose |
|---|---|
| `resolveNameCollisions(groups, { getCentroid, threshold, existingNames, noCentroidAction })` | The one shared entry point all three pathways call. See below. |
| `findNameCollisionBuckets(groups)` | Buckets `{name, tabs}[]` by `normalizeNameForDedupe(name)`. A length-1 bucket means no collision — callers skip embedding cost entirely when nothing collides. |
| `decideCollisionAction(centroidA, centroidB, threshold, noCentroidAction = "disambiguate")` | `cosineSimilarity(...) >= threshold ? "merge" : "disambiguate"`. A missing/invalid centroid on either side falls back to `noCentroidAction` instead. Default `"disambiguate"` is for a genuine embedding failure. `"merge"` is a deliberate policy state — no embedding was ever attempted (Ollama's no-consent path) — restoring the pre-`dedupe.mjs` behavior of merging unconditionally on a name collision alone. |
| `dominantBrand(tabs)` | `etld1` majority vote + `titleCase`, for disambiguation naming (e.g. `"Reading (Github)"`). |
| `etld1FamilyOverlap(tabsA, tabsB)` | Corroborating-evidence gate: do the two groups' hostnames share a registrable-domain family? Required, in addition to the similarity check, before `resolveNameCollisions` accepts a real content-similarity merge (never applied to the `noCentroidAction: "merge"` fallback, which has no content signal to gate). Hardens `etld1`'s naive last-2-labels split against known false-"overlap" shapes: bare IPs and single-label hosts (e.g. `localhost`) only count via an exact hostname match; a small denylist excludes shared multi-tenant hosting domains (`github.io`, `wordpress.com`, etc.); a small denylist handles 2-label ccTLD patterns (`co.uk`, `com.au`, etc.) by falling back to a 3-label split. Not a full Public Suffix List — an unlisted suffix/pattern is a known, accepted residual gap. |
| `applyDisambiguationNames(survivors, existingResolved)` | Fallback chain per colliding entry beyond the first: hostname-brand suffix, else a numeric suffix if the brand is absent or already taken. |
| `normalizeNameForDedupe`, `TRAILING_GENERICS`, `lightStem` | Name normalization (relocated from `ollama.mjs`, unchanged behavior). |
| `averageVectors`, `l2Normalize`, `cosineSimilarity`, `etld1`, `titleCase` | Math/naming primitives (relocated from `ai.mjs`, unchanged behavior). |

## `resolveNameCollisions` — two-pass design

Pass 1 walks each bucket independently: the first entry anchors it, each later entry either merges into the anchor (content-similar) or survives to pass 2. Pass 2 disambiguates every survivor against the *complete* anchor-name set collected in pass 1 (plus any caller-supplied `existingNames`) — not just whatever an earlier bucket resolved to, since a single-pass walk would let bucket-iteration order determine correctness (e.g. an early "Reading" collision resolving to "Reading (Github)" could later collide with an unrelated, not-yet-processed group already literally named that).

A merge concatenates `tabs` and combines centroids as a running sum weighted by each merged group's tab count (not repeated pairwise re-averaging, which would give every new candidate equal weight against the anchor regardless of how much content it already represents) — so a third colliding entry in the bucket compares against the updated combined direction, not just the original anchor's. A candidate is only compared against the anchor's running sum, never against another candidate directly, so two candidates that are similar to *each other* but not to the anchor can end up as separate disambiguated survivors instead of merging with each other — a known limitation of this bucket-local design, not fixed here.

Any extra field a caller attaches to its group objects (e.g. a temporary `_centroid`) rides along on entries that don't merge, and is copied — possibly stale — onto a merged survivor; callers strip such fields from the result themselves.

## Call sites

### TIDY_FUSION (`ai.mjs`, `runPass2`)

Attaches each new cluster's centroid (over the per-tab embeddings already computed for clustering — no new embedding calls) before pushing to `rawNewGroups`, then calls `resolveNameCollisions(rawNewGroups, { getCentroid: g => g._centroid || null, threshold: CONFIG.NAME_COLLISION_MERGE_THRESHOLD })` and strips `_centroid`.

### Fresh's safety net (`ai.mjs`, `runPass2Fresh`)

Replaces the previous naive `byName` exact-string-match merge. Reuses `hostToEmb` (already in scope) to compute each raw group's centroid — zero new embedding calls.

### Ollama (`ollama.mjs`, `resolveOllamaNameCollisions`, used by `unifiedClassifyOllama` and `runPass2OllamaFresh`)

Ollama doesn't otherwise compute embeddings, so this is the one call site that can't reuse embeddings already on hand:

1. `findNameCollisionBuckets` first — nothing collides, return `newGroups` untouched.
2. If `isLocalAIAcknowledged()` is false, skip the embedding attempt entirely: `getCentroid: () => null, noCentroidAction: "merge"`. No consent means no centroid was ever attempted — a policy state, not a failure — so this must not fall back to the default `"disambiguate"`, which is reserved for a genuine attempt that failed.
3. If acknowledged, builds one representative string per colliding group (member titles + hostnames, capped at ~8 tabs) and calls `embedBatch` (from `ai.mjs`). On any embedding failure, falls through to `resolveNameCollisions` with all centroids `null` and the *default* `noCentroidAction` — this is a genuine failure, unlike step 2.
4. Calls the shared `resolveNameCollisions`.

New cross-import direction (`ollama.mjs` → `ai.mjs` for `embedBatch`, plus `ollama.mjs` → `dedupe.mjs`) — not a cycle, since `ai.mjs` never imports from `ollama.mjs`.

## Tunable constant (`config.mjs`)

| Constant | Default | Notes |
|---|---|---|
| `NAME_COLLISION_MERGE_THRESHOLD` | 0.30 | Cosine-similarity bar for merge vs. disambiguate, distinct from `ai.mjs`'s `FRESH_MERGE_THRESHOLD` (0.40) and `config.mjs`'s `TIDY_MERGE_THRESHOLD` (0.35). Must stay below both: this check runs on the same centroids those merge passes already declined to merge, so an equal-or-higher bar would make this merge branch dead code. A name collision is corroborating evidence beyond raw similarity, justifying a looser bar than either upstream pass — but that alone isn't sufficient at this similarity band (two unrelated groups can coincidentally land on the same generic fallback name), so a real-content merge additionally requires `etld1FamilyOverlap` (see above). |

## Verification

Zero Firefox-global dependencies, so it's `import()`-able directly under plain Node — no copy-pasted-logic harness needed. The verification suite exercises every exported function with synthetic groups and hand-crafted embedding vectors: near-identical vectors under colliding names merge (subject to `etld1FamilyOverlap`); orthogonal vectors disambiguate; a missing/null centroid always disambiguates unless `noCentroidAction: "merge"`; a chained multi-way merge weights correctly by tab count; and `normalizeNameForDedupe` is checked against real-world collision strings (`"Content Unavailable"`/`"Content Unavailability"`, etc.).
