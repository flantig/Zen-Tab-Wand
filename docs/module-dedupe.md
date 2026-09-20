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
| `resolveNameCollisions(groups, { getCentroid, threshold, existingNames, noCentroidAction })` | The one shared entry point all three pathways call. See below. |
| `findNameCollisionBuckets(groups)` | Buckets `{name, tabs}[]` by `normalizeNameForDedupe(name)`. A bucket of length 1 means no collision — callers use this to skip all embedding cost when nothing collides (see Ollama). |
| `decideCollisionAction(centroidA, centroidB, threshold, noCentroidAction = "disambiguate")` | `cosineSimilarity(...) >= threshold ? "merge" : "disambiguate"`. Missing/invalid centroid on either side → falls back to `noCentroidAction`. Default `"disambiguate"` is for a GENUINE failure (consent given, embedding attempted, came back missing) — uncertainty must fail toward the non-destructive choice there. `"merge"` is for a DELIBERATE POLICY STATE where no centroid was ever attempted at all (Ollama's no-consent path) — restores the pre-`dedupe.mjs` behavior of merging unconditionally on a name collision alone. Conflating these two was a real regression (fixed): treating "never attempted" the same as "attempted and failed" silently disabled Ollama's dedupe for the common no-consent case. |
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
2. **Consent gate**: if `isLocalAIAcknowledged()` (`rules.mjs`, reading the existing `CONFIG.LOCAL_ACKNOWLEDGED_PREF` the Local engine's own one-shot consent modal already uses) is false, skip the embedding attempt entirely and **merge unconditionally on the name collision alone** (`getCentroid: () => null, noCentroidAction: "merge"`). An Ollama-only user has never seen or acknowledged the Local engine's resource-cost warning; silently loading Firefox's ML model as a side effect of a dedupe check would bypass that consent flow — but no consent means no centroid was ever ATTEMPTED, a deliberate policy state, not a failure, so this must NOT fall back to the default "disambiguate" (that's reserved for a genuine embedding failure, see step 3). Passing `noCentroidAction: "merge"` here restores the pre-`dedupe.mjs` behavior of the engine this replaced (`dedupeSimilarNewGroups`), which merged unconditionally on a normalized-name match with no centroid at all. (Fixed regression: an earlier version of this call used the default "disambiguate", which silently disabled Ollama's dedupe for this — the common, no-consent — case; reproduced with this file's own motivating example, "Content Unavailable"/"Content Unavailability" staying two groups instead of merging.)
3. If acknowledged, builds one representative string per COLLIDING group only (member titles + hostnames, capped at ~8 tabs — same shape as `runPass2Fresh`'s `repInputs` pattern) and calls `embedBatch` (exported from `ai.mjs` for exactly this — it already fully encapsulates engine loading, batching, and dead-port retry). On any embedding failure, falls through to `resolveNameCollisions` with all centroids `null` and the DEFAULT `noCentroidAction` ("disambiguate") — this is a genuine failure (consent was given, the attempt was made), unlike step 2's deliberate no-attempt case, so it correctly stays on the safe "disambiguate everything" default.
4. Calls the shared `resolveNameCollisions`.

This is a new cross-import direction (`ollama.mjs` → `ai.mjs` for `embedBatch`, plus `ollama.mjs` → `dedupe.mjs`) — not a cycle, since `ai.mjs` never imports from `ollama.mjs`.

## Tunable constant (`config.mjs`)

| Constant | Default | Notes |
|---|---|---|
| `NAME_COLLISION_MERGE_THRESHOLD` | 0.30 | Cosine-similarity bar for merge vs. disambiguate. Distinct constant from `ai.mjs`'s `FRESH_MERGE_THRESHOLD` (0.40) and `config.mjs`'s `TIDY_MERGE_THRESHOLD` (0.35) — it governs a conceptually different decision, so future tuning of one shouldn't silently move the others. **Must stay meaningfully below both** those thresholds: this check runs on the same centroids the fragmentation-merge pass already ran on, in that pass, for groups it declined to merge — if this bar sat at or above that pass's own bar, nothing could ever clear it, making the merge branch dead code. (Fixed regression: at the previous value of 0.40 — equal to `FRESH_MERGE_THRESHOLD` and above `TIDY_MERGE_THRESHOLD` — two separate "Google" clusters that used to correctly merge via the old exact-name-match safety net instead produced "Google" and "Google (Google)"; verified live via the Marionette harness, see `config.mjs`'s own comment for the exact repro.) A literal name collision is itself corroborating evidence beyond raw content similarity, so it's correct for this bar to be looser than either upstream content-only pass — but this looseness has a real, evidenced cost: two genuinely unrelated groups landing on the same GENERIC fallback name (e.g. both hitting the bare hostname-stitch fallback) can now merge if their real content similarity happens to clear 0.30, a band real embeddings don't reliably distinguish. See `config.mjs`'s comment for the concrete repro and the open product question about whether to accept this trade-off as-is. |

## Verification

`dedupe.mjs` has zero Firefox-global dependencies, so it can be `import()`-ed directly under plain Node — no copy-pasted-logic harness needed, unlike modules that touch `Services`/`ChromeUtils`/DOM. The verification harness exercises every exported function directly with synthetic groups and hand-crafted embedding vectors: near-identical vectors under colliding names merge; orthogonal vectors disambiguate (hostname-brand suffix, or numeric fallback when the brand is absent or itself collides); a missing/null centroid on either side always disambiguates; a 3-way chained merge re-averages correctly; and `normalizeNameForDedupe` is re-checked against the real-world collision strings documented in `ollama.mjs`'s original comments (`"Content Unavailable"`/`"Content Unavailability"`, etc.) to confirm no regression from the relocation.
