# `modules/ai.mjs` — Pass 2 (local AI)

The AI fallback that runs after Pass 1, on tabs the domain rules didn't match. Uses Firefox's bundled ML engine — no network calls, no API keys.

## Scope

The Local engine does two jobs:

1. **Assigns unmatched tabs into EXISTING rule-matched groups** — the original, high-precision job. Threshold is set high (0.65 raw+boost) so this only fires on slam-dunk matches; rules do the real classification work.
2. **Clusters LEFTOVER tabs (ones that didn't fit any existing group) into brand-new groups** — added by TIDY_FUSION (ported from Firefox's own SmartTabGrouping / Tidy Tabs approach: greedy clustering at `CONFIG.TIDY_LOW`, names from the bundled `smart-tab-topic` model). Before this, Local AI could only file tabs into existing rule groups and looked completely dead on a fresh profile with few rules — `runPass2` always returned `newGroups: []`. It no longer does; callers must not assume local-engine new-group creation is a no-op.

`Mozilla/smart-tab-embedding`'s cosine sims are compressed into a narrow band, so both jobs use deliberately tuned thresholds (see "Tunable constants") rather than one universal cutoff. Full-vocabulary, LLM-driven classification (arbitrary category names, richer reasoning) is still the **Ollama engine**'s job — see [module-ollama.md](module-ollama.md).

## Models used

| Model | Task | Used for |
|---|---|---|
| `Mozilla/smart-tab-embedding` | feature-extraction | turning tab titles (+ hostname, + page snippet for Fresh) into vectors |
| `Mozilla/smart-tab-topic` | text2text-generation | naming a TIDY_FUSION cluster from its member titles/keywords |

Both ship with Zen/Firefox. First load of either takes 1–3s (model warm-up); each is cached for the lifetime of the window via its own module-level promise (`embeddingEnginePromise` / `topicEnginePromise`).

## Exports

| Name | Notes |
|---|---|
| `runPass2(unmatched, rules, workspaceId)` | Pure planning — returns assignment plan without mutating DOM. `newGroups` can now be non-empty (TIDY_FUSION), name-collision-deduped via `modules/dedupe.mjs` before returning. |
| `runPass2Fresh(tabs)` | "Fresh Rebuild" / Preview Only — ignores rules, re-clusters ALL eligible tabs from scratch using embedding similarity + og:type/keyword naming. Same `{assignedToExisting: [], newGroups, skipped}` shape. |
| `applyPass2(plan, workspaceId, rules)` | Executes the plan: moves tabs into existing groups, optionally grows domains, creates new domain rules for `newGroups`, and applies kept title-rule patches. Mutates the `rules` array and writes it to the pref. |
| `embedBatch(inputs, opts?)` | Exported so `modules/ollama.mjs` can reuse it for a one-off embedding call during its own post-collision name-dedupe check (see [module-dedupe.md](module-dedupe.md)) — it already fully encapsulates engine loading, batching, and dead-port retry, so there's no reason to build that twice. |

## Pipeline (`runPass2`)

```
unmatched tabs (from runPass1)
      │
      ▼
1.  Embed each tab's title+hostname (smart-tab-embedding)
      │
      ▼
2.  Embed every tab inside each existing rule-matched group
    (keep per-tab — do NOT average into a centroid; exclude
     any tabs that are themselves in the unmatched list, so
     a tab AI moved here last run as "transient" doesn't
     self-match against itself at cosine 1.0)
      │
      ▼
3.  For each unmatched tab, score each existing group as
    MAX cosine sim over the group's tab embeddings, plus the
    AI_EXISTING_GROUP_BOOST. Assign when the boosted score
    exceeds AI_EXISTING_GROUP_THRESHOLD; otherwise the tab
    becomes part of the "remainder".
      │
      ▼
4.  TIDY_FUSION — greedily cluster the remainder at CONFIG.TIDY_LOW
    (raw cosine, no boost). Singleton clusters demote to skipped.
    Each surviving cluster gets a name from smart-tab-topic
    (falls back to a hostname stitch if the model is unavailable
    or returns junk).
      │
      ▼
5.  Cross-engine name-collision dedupe (modules/dedupe.mjs) — two
    clusters that both got the same name merge (if content-similar)
    or get disambiguated (if not).
      │
      ▼
   { assignedToExisting, newGroups, skipped }
```

`runPass2Fresh` follows a parallel but independent pipeline: union-find clustering over per-hostname embeddings (not per-tab) at `FRESH_CLUSTER_THRESHOLD`, a centroid-merge pass at `FRESH_MERGE_THRESHOLD` to catch over-fragmented clusters, `nameClusterFromSignals` for naming (og:type intent label, extracted shared keywords, or hostname stitch), then the same shared `resolveNameCollisions` dedupe pass as TIDY_FUSION (previously its own naive exact-name-match `byName` merge).

## Tunable constants (in `config.mjs`)

| Constant | Default | What it controls |
|---|---|---|
| `AI_EXISTING_GROUP_THRESHOLD` | 0.65 | min (raw + boost) cosine sim for "tab belongs to existing group". High by design — prefer false-negatives over false-positives |
| `AI_EXISTING_GROUP_BOOST` | 0.10 | added to existing-group sim. Historical — kept for parity with Tidy Tabs's tuning |
| `AI_EMBEDDING_BATCH_SIZE` | 5 | tabs per parallel embedding batch (memory vs latency) |
| `TIDY_LOW` | 0.45 | raw cosine bar for TIDY_FUSION's greedy leftover-clustering. Deliberately looser than the existing-group bar's effective ~0.55 raw — these tabs already failed that strict bar, so this is a lower bar for "loosely on the same topic" rather than "slam dunk" |
| `NAME_COLLISION_MERGE_THRESHOLD` | 0.30 | shared with Fresh and Ollama (`modules/dedupe.mjs`) — cosine bar for merging two same/similar-named new groups vs. renaming one. See [module-dedupe.md](module-dedupe.md) |

**Why max-over-tabs instead of a centroid?** Averaging a group's tab embeddings into one centroid dilutes specific-tab signals — e.g. an unmatched `amazon.com` tab is similar to an existing `staples.com` tab (shared retail vocabulary), but that signal vanishes when staples is averaged with non-retail tabs in the same group. Scoring against the MAX similarity to any single tab in the group preserves it. (TIDY_FUSION's own clustering and its dedupe-pass centroids DO use averaging/centroids — that tension is deliberate: existing-group matching wants to catch a specific-tab signal, while clustering leftovers into a NEW group is inherently "what do these tabs have in common", which a centroid answers better.)

## User-configurable behavior

### `ai-existing-behavior` — when AI moves a tab into an existing rule's group

| Value | Effect |
|---|---|
| `always-add` / Move + Save Domain (default) | Move the tab AND append its hostname to the rule's `domains[]`. Rules grow over time. |
| `transient` / Move Once | Move the tab only. Rules untouched — next click would have to re-classify the same tabs. |

On the Local engine this row is hidden in settings — `getAIExistingBehavior()` derives it FROM `ai-new-group-behavior` instead (`"auto-add"` → `always-add`, everything else → `transient`), so there's only one dropdown to configure both decisions for Local.

### Local Fresh title context

Local Fresh Rebuild uses title + hostname + fetched page snippet text as transient clustering input. It never persists `titleTerms`; title persistence is Ollama-only and reviewed in the preview modal as separate title-rule proposals.

When the modal is applied, `applyPass2()` treats reviewed title proposals as rule patches: existing rules get deduped `titleTerms[]`, and new title-only rules can be created with empty `domains[]`. Skipped title cards and individually skipped title chips are ignored.

### `ai-new-group-behavior`

| Value | Local engine effect |
|---|---|
| `auto-add` / Preview + Save Rule (default) | TIDY_FUSION clusters leftovers into new groups; `applyPass2` creates the tab-group AND a matching rule. `click-handler.mjs` shows the confirmation modal for this specifically when a run actually produces a new group — a run that only did existing-group work still applies directly, matching the historical "Local applies existing-group work directly without a preview" behavior (see [module-click-handler.md](module-click-handler.md)). |
| `transient` / Group Once | New groups get created but no rule is saved. |
| `fresh-categories` / Fresh Rebuild | Routes to `runPass2Fresh` instead of `runPass2` — re-clusters ALL eligible tabs, ignoring rules. No rule mutations happen regardless of this pref's other values. |
| `identify-only` / Preview Only | Also routes to `runPass2Fresh`; always shows the preview modal so the user can rename/re-assign clusters before applying, for either engine. |
| `prompt` / Zen Edit Prompt | New groups get created and Zen's own per-group edit modal opens for renaming — no rule saved unless the user separately uses the tab right-click "Add to Rule…" submenu afterwards. |

For full LLM-driven rule-learning (title-term proposals reviewed and saved), use the Ollama engine. See [module-ollama.md](module-ollama.md).

## Failure modes

- **Embedding model load fails** (older Zen, AI disabled in Firefox prefs): caught in `runPass2`/`runPass2Fresh`, surfaces a toast + console error, returns `{ failed: "..." }`. Pass 1's results are unaffected.
- **Per-tab embedding fails**: that single tab is added to `skipped`, others continue.
- **Topic model (`smart-tab-topic`) load or generation fails**: `nameClusterWithTopic` catches the error and falls back to the hostname-stitch namer (`nameClusterFromHostnames`) — the cluster still gets created, just with a plainer name. Unlike the embedding engine, the topic engine has no dead-port self-heal: a mid-session port death degrades naming to the hostname fallback for the rest of the browser session (no user-visible signal beyond a console warning).

## Performance

- Both engines are loaded lazily on first use and cached as a promise each. The cache is per-window (chrome script module scope).
- Embeddings are batched in groups of `AI_EMBEDDING_BATCH_SIZE` (or the user-configurable `AI_LOCAL_BATCH_SIZE_PREF` on large workspaces) to balance memory vs latency. Each batch is parallel internally; batches run sequentially.
- An L2-normalization step is applied to every embedding so cosine similarity is a plain dot product downstream.
