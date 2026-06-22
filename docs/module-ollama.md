# `modules/ollama.mjs` (+ ollama-transport + ollama-prompts) — Pass 2 Ollama engine

The smarter Pass 2 backend. Talks to a local Ollama daemon (default `http://localhost:11434`), classifying unmatched tabs into existing groups AND inventing new groups for clusters of related tabs. Unlike the local-AI engine in `ai.mjs`, this path does the full classification — including cluster naming and an aggressive merge pass — so it's the engine to use when you want the AI to make real decisions, not just slam-dunk matches.

The implementation is split across three files for clarity:

| File | Responsibility |
|---|---|
| `modules/ollama-transport.mjs` | HTTP plumbing — fetch wrapper with timeout, host normalization, `/api/tags` readiness check, `/api/generate` JSON wrapper, warmup, error reporting. No prompt strings, no orchestration. |
| `modules/ollama-prompts.mjs` | Pure string-building. One function per prompt template: `buildClassifyPrompt`, `buildClusterPrompt`, `buildUnifiedPrompt`, `buildFreshPrompt`, `buildMergePrompt`. Plus shared formatting helpers. No DOM, no Services. |
| `modules/ollama.mjs` | Orchestrators that compose the two above. The exports the rest of the codebase imports. |

## Exports (from `ollama.mjs`)

| Name | Purpose |
|---|---|
| `runPass2Ollama(unmatched, rules, workspaceId, host, model)` | Unified classify + cluster + merge pass. Returns the standard Pass 2 plan shape `{ assignedToExisting, newGroups, skipped }`. |
| `runPass2OllamaFresh(allTabs, host, model)` | Fresh-categories mode — ignores rules entirely, lets the model invent groups from scratch. Used when `ai-new-group-behavior = "fresh-categories"`. |
| `classifyExistingGroupsBatch(tabs, rules, host, model)` | Single-pass "assign these tabs into one of these existing groups" call. Used by the Plan Mode modal's **Re-assign to existing** action. |
| `proposeTitleTermPatches(plan, rules, host, model)` | Extracts title keyword candidates from grouped tab titles, then asks Ollama which rule category each title term should teach. |
| `unifiedClassifyOllama` / `clusterUnmatchedNewGroups` / `mergeNewCategoriesPass` | Internal-but-exported building blocks. |
| `warmupOllama(host, model)`, `checkOllamaReady(host)`, `reportOllamaError(...)` | Re-exported from `ollama-transport.mjs` for callers that don't want to know about the split. |

## Why JSON-mode + temperature 0 + seed 42

All `/api/generate` calls use `format: "json"`, `temperature: 0`, and a fixed `seed`. This pins outputs to be parseable JSON, deterministic (same inputs → same outputs across runs), and reproducible across model versions. Without these, qwen2.5 frequently emits free-form text or wraps JSON in markdown fences that break the parser.

## Why a flat key-value schema for the merge prompt

Earlier merge-prompt iterations asked the model to return nested `[{name, from: [...]}, ...]` arrays. qwen2.5:1.5b consistently emitted malformed nested arrays — missing closing brackets, hallucinated extra fields. Switching to a flat `{ "OriginalGroup": "MergedTarget" }` map fixed it. Same semantic information, far higher success rate.

## Title learning

When `ai-title-learning` is `"review-save-simple"` or `"review-save-complex"`, Ollama rule-mutating flows can add reviewed `T` chips to rules. Simple mode proposes chips from title text only. Complex mode also fetches a bounded set of page snippets and can propose chips from that content. Candidate collection is intentionally small: it drops generic metadata/action words, caps fetched pages and model candidates, and asks the model to map each chip to an existing or newly named rule category. The helper can audit tabs already inside rule-named groups via `plan.titleAuditGroups`, so title proposals can appear even when Pass 2 has no unmatched tabs to move. The preview modal shows title proposals in their own section; users can skip individual chips or the whole title-rule card, and applying the modal saves only kept chips.

## Lifecycle: warmup + keep-alive

The Ollama API supports a `keep_alive` parameter on `/api/generate` that controls how long the model stays resident in VRAM after the call. We default to a long keep-alive when `ai-ollama-warmup` is enabled, so the next click doesn't pay the cold-start (~3-8s on a 7B model).

If the user enables the **Keep Ollama model warm** preference, `auto-organize.uc.mjs` calls `warmupOllama` at browser startup (only if the engine is `"ollama"`). That's a single `/api/generate` with `keep_alive` set — Ollama loads the model and holds it.

## Tunable model

The model name is user-configurable via the `ai-ollama-model` pref. Default is `qwen2.5:1.5b` for compatibility with low-end GPUs; `qwen2.5:7b` gives noticeably better grouping accuracy at the cost of ~5 GB more VRAM.

## Failure modes

- **Daemon not running** — `checkOllamaReady` returns `{ ok: false, errorType: "network" }`. A toast directs the user to `ollama serve` / install.
- **Model not pulled** — `/api/generate` returns an error string mentioning the model name. Surfaced as a toast.
- **Timeout** — `fetchWithTimeout` aborts via `AbortController`. Each prompt's call site decides whether to retry (we generally don't — the user can click again).
- **Bad JSON from model** — the orchestrators catch `JSON.parse` failures and treat them as "no assignments from this call", continuing with what they have. The unrecovered tabs go into `skipped` for the user to see.
