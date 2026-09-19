# `modules/dedupe.mjs` — cross-engine new-group name-collision dedupe

Shared by all three group-creation pathways — Local/TIDY_FUSION (`ai.mjs` `runPass2`), Local Fresh (`ai.mjs` `runPass2Fresh`), and Ollama (`ollama.mjs`) — for the same decision: when two proposed new groups end up with the same (or a near-identical) name, is that because they're actually the SAME topic (merge them) or just a naming coincidence (rename one so they don't collide)?

## Why this module exists

Before this module, each engine had its own bespoke answer to "what if two new groups get the same name":

- TIDY_FUSION had none at all — a genuine gap.
- Fresh had a naive exact-string-match merge (`byName` map).
- Ollama had `dedupeSimilarNewGroups`, a fuzzy morphological-stem match with no content awareness.

None of the three could tell the difference between "two clusters both named 'Shopping' because they're both actually shopping tabs" (should merge) and "two clusters both named 'Shopping' by coincidence — one's actually about board games, the other electronics" (should NOT merge, would blend unrelated tabs into one group). This module adds that missing signal — embedding-based content similarity — as the arbiter, everywhere, including Ollama (which doesn't otherwise compute embeddings at all; see "Ollama's embedding call" below).

## Design constraint: pure, synchronous, zero-I/O

No `Services`, no `ChromeUtils`, no DOM, no `console.log`, no network/engine calls. Every caller supplies its own `getCentroid` accessor — this module never computes or fetches an embedding itself. That keeps it:

- Trivially unit-testable under plain Node (`node --check` plus a standalone harness with hand-crafted embedding vectors — no Firefox chrome context needed).
- Decoupled from the decision of "is it worth the cost of an embedding call", which stays entirely with the caller (see Ollama's consent-gated, only-on-actual-collision embedding attempt below).

## Why this module exists separately from `ai.mjs`

No cross-import existed between `ai.mjs` and `ollama.mjs` before this (both were only imported by `click-handler.mjs`). A new single-purpose module matches this codebase's existing convention (`color-picker.mjs`, `emoji-picker.mjs`, `custom-icons.mjs`, `groups.mjs` all follow this pattern) and avoids making the two engine modules depend on each other directly.

Relocating (not duplicating) `averageVectors`/`l2Normalize`/`cosineSimilarity`/`etld1`/`titleCase` out of `ai.mjs` and into this module — rather than exporting them in place and having this module import FROM `ai.mjs` — avoids a circular import, since `ai.mjs` also needs to import `resolveNameCollisions` back from here. Every existing internal call site in `ai.mjs` (e.g. `runPass2Fresh`'s clustering, `nameClusterFromHostnames`) kept working unchanged via import, since the bare identifier names didn't change.

`normalizeNameForDedupe`/`TRAILING_GENERICS`/`lightStem` were similarly relocated out of `ollama.mjs` — that normalization logic now has three consumers instead of one.

## Exports

| Name | Purpose |
|---|---|
| `resolveNameCollisions(groups, { getCentroid, threshold })` | The one shared entry point all three pathways call. See below. |
| `findNameCollisionBuckets(groups)` | Buckets `{name, tabs}[]` by `normalizeNameForDedupe(name)`. A bucket of length 1 means no collision — callers use this to skip all embedding cost when nothing collides (see Ollama). |
| `decideCollisionAction(centroidA, centroidB, threshold)` | `cosineSimilarity(...) >= threshold ? "merge" : "disambiguate"`. Missing/invalid centroid on either side → always `"disambiguate"` — uncertainty must fail toward the non-destructive choice, never toward merging unrelated tabs. |
| `dominantBrand(tabs)` | `etld1` majority vote + `titleCase`, for disambiguation naming (e.g. `"Reading (Github)"`). |
| `applyDisambiguationNames(survivors, existingResolved)` | Fallback chain per colliding entry beyond the first: hostname-brand suffix → numeric suffix if the brand is absent or the brand-suffixed name itself collides. |
| `normalizeNameForDedupe`, `TRAILING_GENERICS`, `lightStem` | Name normalization (relocated from `ollama.mjs`, unchanged behavior). |
| `averageVectors`, `l2Normalize`, `cosineSimilarity`, `etld1`, `titleCase` | Math/naming primitives (relocated from `ai.mjs`, unchanged behavior). |

## `resolveNameCollisions` — two-pass design

```
groups → findNameCollisionBuckets → buckets
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                      ▼
         Pass 1 — merge decisions              (bucket-local; every bucket
         walked independently: anchor          walked independently — no
         = first entry, each later entry       cross-bucket dependency)
         merges into it (content-similar)
         or survives to pass 2
                    │
                    ▼
         anchors[]  +  pendingSurvivorGroups[]
                    │
                    ▼
         Pass 2 — disambiguation naming,       (against the COMPLETE anchor
         against the full anchor-name set      set from the START, not just
         collected in pass 1                   whatever pass 1 resolved so
                                                far in bucket-iteration order)
```

The two-pass split matters: a single-pass walk that disambiguates each bucket's survivors as soon as that bucket finishes would let bucket-iteration order determine correctness. Concretely — one "Reading" collision resolving early to "Reading (Github)" could later collide with an unrelated, not-yet-processed singleton group that's already literally named "Reading (Github)". Collecting every anchor name FIRST, then disambiguating all survivors against that complete, order-independent set, closes that gap. (Caught by the verification harness, not by inspection — see Verification below.)

Anchors always keep their original name. A merge concatenates `tabs` and re-averages + re-normalizes the centroid (`l2Normalize(averageVectors([anchorCentroid, candidateCentroid]))`) so a THIRD colliding entry in the same bucket compares against the updated combined content, not just the original anchor's.

Any extra field a caller attaches to its group objects (e.g. a temporary `_centroid`) rides along on entries that don't merge, and is copied — possibly stale — onto a merged survivor. Callers that attach such fields are expected to strip them from the result themselves (all three current callers do: `.map(({ _centroid, ...g }) => g)`).

## Call sites

### TIDY_FUSION (`ai.mjs`, `runPass2`)

Attaches each new cluster's centroid (`l2Normalize(averageVectors(...))` over the per-tab embeddings already computed for clustering — no new embedding calls) before pushing to a `rawNewGroups` array. After the cluster loop, calls `resolveNameCollisions(rawNewGroups, { getCentroid: g => g._centroid || null, threshold: CONFIG.NAME_COLLISION_MERGE_THRESHOLD })`, then strips `_centroid`.

### Fresh's safety net (`ai.mjs`, `runPass2Fresh`)

Replaces the previous naive `byName` exact-string-match merge entirely. `hostToEmb` (a `Map<hostname, embedding>`) is already in scope from earlier in the function — each raw group's centroid is computed from it (zero new embedding calls), same shared helper call as TIDY_FUSION.

### Ollama (`ollama.mjs`, `resolveOllamaNameCollisions`, used by both `unifiedClassifyOllama` and `runPass2OllamaFresh`)

Ollama doesn't otherwise compute embeddings at all, so this is the one call site that can't just reuse embeddings already on hand:

1. `findNameCollisionBuckets` first — if nothing collides, return `newGroups` untouched (skip all embedding cost).
2. **Consent gate**: if `isLocalAIAcknowledged()` (`rules.mjs`, reading the existing `CONFIG.LOCAL_ACKNOWLEDGED_PREF` the Local engine's own one-shot consent modal already uses) is false, skip the embedding attempt entirely and disambiguate unconditionally (`getCentroid: () => null`). An Ollama-only user has never seen or acknowledged the Local engine's resource-cost warning; silently loading Firefox's ML model as a side effect of a dedupe check would bypass that consent flow. This is intentionally stricter than "try, then fall back on failure" — never attempt at all without consent.
3. If acknowledged, builds one representative string per COLLIDING group only (member titles + hostnames, capped at ~8 tabs — same shape as `runPass2Fresh`'s `repInputs` pattern) and calls `embedBatch` (exported from `ai.mjs` for exactly this — it already fully encapsulates engine loading, batching, and dead-port retry). On any embedding failure, falls through to `resolveNameCollisions` with all centroids `null` (same safe "disambiguate everything" default).
4. Calls the shared `resolveNameCollisions`.

This is a new cross-import direction (`ollama.mjs` → `ai.mjs` for `embedBatch`, plus `ollama.mjs` → `dedupe.mjs`) — not a cycle, since `ai.mjs` never imports from `ollama.mjs`.

## Tunable constant (`config.mjs`)

| Constant | Default | Notes |
|---|---|---|
| `NAME_COLLISION_MERGE_THRESHOLD` | 0.40 | Cosine-similarity bar for merge vs. disambiguate. Same initial value as `ai.mjs`'s `FRESH_MERGE_THRESHOLD` but kept as a distinct constant — it governs a conceptually different decision (name-collision arbitration vs. Fresh's own pairwise-cluster merge pass), so future tuning of one shouldn't silently move the other. |

## Verification

`dedupe.mjs` has zero Firefox-global dependencies, so it can be `import()`-ed directly under plain Node — no copy-pasted-logic harness needed, unlike modules that touch `Services`/`ChromeUtils`/DOM. The verification harness exercises every exported function directly with synthetic groups and hand-crafted embedding vectors: near-identical vectors under colliding names merge; orthogonal vectors disambiguate (hostname-brand suffix, or numeric fallback when the brand is absent or itself collides); a missing/null centroid on either side always disambiguates; a 3-way chained merge re-averages correctly; and `normalizeNameForDedupe` is re-checked against the real-world collision strings documented in `ollama.mjs`'s original comments (`"Content Unavailable"`/`"Content Unavailability"`, etc.) to confirm no regression from the relocation.
