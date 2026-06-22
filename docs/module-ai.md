# `modules/ai.mjs` — Pass 2 (local AI)

The AI fallback that runs after Pass 1, on tabs the domain rules didn't match. Uses Firefox's bundled ML engine — no network calls, no API keys.

## Scope

Local AI is intentionally limited to **assigning unmatched tabs into EXISTING rule-matched groups**. It does NOT form new clusters or invent new group names. The `Mozilla/smart-tab-embedding` model is too weak for either job in practice:

- Cosine sims are compressed into a narrow band, so no single threshold cleanly separates right answers from wrong ones.
- Tabs cluster by *stylistic* similarity (homepage-style brand titles) rather than topic.
- The model frequently picks wrong-direction matches (e.g. `amazon.com` closer to Google services than to Shopping retailers).

The threshold is therefore set high (0.65) to make local AI a **high-precision / low-recall** filter — it should only fire when the model is genuinely confident, otherwise stay quiet. Rules do the real classification work.

For new-group invention, full-vocabulary classification, and any flow involving cluster naming, use the **Ollama engine** (`modules/ollama.mjs`) instead. See [module-ollama.md](module-ollama.md) for that path.

## Models used

| Model | Task | Used for |
|---|---|---|
| `Mozilla/smart-tab-embedding` | feature-extraction | turning tab titles into vectors |

Ships with Zen/Firefox. First load takes 1–3s (model warm-up). Subsequent calls are fast; the engine is cached for the lifetime of the window via a module-level promise.

## Exports

| Name | Notes |
|---|---|
| `runPass2(unmatched, rules, workspaceId)` | Pure planning — returns assignment plan without mutating DOM. `newGroups` is always `[]` in the local-AI path. |
| `applyPass2(plan, workspaceId, rules)` | Executes the plan: moves tabs into existing groups, optionally grows domains, creates new domain rules, and applies kept title-rule patches. Mutates the `rules` array and writes it to the pref. |

## Pipeline

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
    exceeds AI_EXISTING_GROUP_THRESHOLD; otherwise leave
    the tab unmatched.
      │
      ▼
   { assignedToExisting, newGroups: [], skipped }
```

## Tunable constants (in `config.mjs`)

| Constant | Default | What it controls |
|---|---|---|
| `AI_EXISTING_GROUP_THRESHOLD` | 0.65 | min (raw + boost) cosine sim for "tab belongs to existing group". High by design — prefer false-negatives over false-positives |
| `AI_EXISTING_GROUP_BOOST` | 0.10 | added to existing-group sim. Historical — kept for parity with Tidy Tabs's tuning |
| `AI_EMBEDDING_BATCH_SIZE` | 5 | tabs per parallel embedding batch (memory vs latency) |

**Why max-over-tabs instead of a centroid?** Averaging a group's tab embeddings into one centroid dilutes specific-tab signals — e.g. an unmatched `amazon.com` tab is similar to an existing `staples.com` tab (shared retail vocabulary), but that signal vanishes when staples is averaged with non-retail tabs in the same group. Scoring against the MAX similarity to any single tab in the group preserves it.

## User-configurable behavior

### `ai-existing-behavior` — when AI moves a tab into an existing rule's group

| Value | Effect |
|---|---|
| `always-add` (default) | Move the tab AND append its hostname to the rule's `domains[]`. Rules grow over time. |
| `transient` | Move the tab only. Rules untouched — next click would have to re-classify the same tabs. |

### Local Fresh title context

Local Fresh Categories uses title + hostname + fetched page snippet text as transient clustering input. It never persists `titleTerms`; title persistence is Ollama-only and reviewed in the preview modal as separate title-rule proposals.

When the modal is applied, `applyPass2()` treats reviewed title proposals as rule patches: existing rules get deduped `titleTerms[]`, and new title-only rules can be created with empty `domains[]`. Skipped title cards and individually skipped title chips are ignored.

### `ai-new-group-behavior`

For Local, only Fresh Categories and Review and Save create new groups. Transient title learning is ignored locally. For full reviewed rule-learning behavior, use the Ollama engine. See [module-ollama.md](module-ollama.md).

## Failure modes

- **Model load fails** (older Zen, AI disabled in Firefox prefs): caught in `runPass2`, surfaces a toast + console error, returns `{ failed: "..." }`. Pass 1's results are unaffected.
- **Per-tab embedding fails**: that single tab is added to `skipped`, others continue.

## Performance

- Engine is loaded lazily on first AI use and cached as a promise. The cache is per-window (chrome script module scope).
- Embeddings are batched in groups of `AI_EMBEDDING_BATCH_SIZE` to balance memory vs latency. Each batch is parallel internally; batches run sequentially.
- An L2-normalization step is applied to every embedding so cosine similarity is a plain dot product downstream.
