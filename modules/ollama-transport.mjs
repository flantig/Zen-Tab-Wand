// Zen Tab Wand — Ollama HTTP transport layer.
//
// Everything that talks to the Ollama daemon over HTTP lives here: timeouts,
// AbortController-backed fetch, ping/health-check, warmup, the JSON
// generate-call wrapper, and the user-facing error toast helpers. The
// classifier orchestrators (in ollama.mjs) call `ollamaGenerateJson` and
// `checkOllamaReady` — they don't need to know anything about how the bytes
// flow.

import { CONFIG, LOG } from "./config.mjs";
import { isOllamaWarmupEnabled } from "./rules.mjs";
import { showToast } from "./ui-toast.mjs";

const PING_TIMEOUT_MS = 3000;
// Classification calls: generous because the FIRST request after the daemon
// has been idle includes a model warm-up (~5–10s for 1.5B on CPU/GPU, longer
// for bigger models). Subsequent calls are sub-second.
const GENERATE_TIMEOUT_MS = 60000;
const WARMUP_TIMEOUT_MS = 30000;

// Returns the keep_alive fragment to spread into a generate-call body —
// `{ keep_alive: "30m" }` when warmup is on, `{}` otherwise. Single source
// of truth for the keep-alive policy.
const withKeepAlive = () =>
  isOllamaWarmupEnabled() ? { keep_alive: "30m" } : {};

// Normalize a user-entered host. Tolerates trailing slashes and missing scheme
// so settings like "localhost:11434" or "http://192.168.1.5:11434/" both work.
export const normalizeOllamaHost = (host) => {
  let h = (host || "").trim();
  if (!h) h = CONFIG.AI_OLLAMA_HOST_DEFAULT;
  if (!/^https?:\/\//i.test(h)) h = "http://" + h;
  return h.replace(/\/+$/, "");
};

// AbortController-based timeout — without this a fetch to a down daemon
// would hang until the OS TCP timeout (often 60s+), blocking the tidy click.
const fetchWithTimeout = async (url, opts = {}, timeoutMs = PING_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

// GET /api/tags — Ollama's "list models" endpoint. Cheap, no model load.
const pingOllama = async (host) => {
  const base = normalizeOllamaHost(host);
  try {
    const res = await fetchWithTimeout(`${base}/api/tags`, { cache: "no-store" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    return { ok: true, models };
  } catch (e) {
    return {
      ok: false,
      error: e.name === "AbortError" ? `timeout after ${PING_TIMEOUT_MS}ms` : (e.message || String(e)),
    };
  }
};

// Two-stage check: is the daemon reachable, AND is the chosen model pulled?
// We distinguish these because they need different remediation messages
// (install/start daemon vs. run `ollama pull <model>`).
//
// Match strategy: Ollama's `name` field is the full tag (e.g. "qwen2.5:1.5b").
// We accept either an exact match or a "family + any tag" match so users who
// configured "qwen2.5" still resolve to "qwen2.5:1.5b" being pulled.
export const checkOllamaReady = async (host, model) => {
  const ping = await pingOllama(host);
  if (!ping.ok) {
    return { reachable: false, modelAvailable: false, error: ping.error };
  }
  const target = (model || "").trim().toLowerCase();
  const targetFamily = target.split(":")[0];
  const have = ping.models.map((m) => String(m?.name || "").toLowerCase());
  const found = have.some((n) => n === target || (targetFamily && n.startsWith(targetFamily + ":")));
  return { reachable: true, modelAvailable: found, availableModels: have };
};

/**
 * POST /api/generate with format=json and parse the response into a JS object.
 *
 * This wraps the 5-step boilerplate (fetch with timeout → HTTP status check →
 * read body → JSON parse → empty/shape sanity) into one call. Each classifier
 * in ollama.mjs used to duplicate this; one place to fix bugs now.
 *
 * Result shape:
 *   { ok: true,  parsed }
 *   { ok: false, error, errorType: "network"|"http"|"empty"|"parse" }
 *
 * The caller decides whether `parsed` is the right shape (object vs array).
 */
export const ollamaGenerateJson = async (host, model, prompt) => {
  const base = normalizeOllamaHost(host);
  let res;
  try {
    res = await fetchWithTimeout(
      `${base}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          format: "json",
          options: { temperature: 0, seed: 42 },
          ...withKeepAlive(),
        }),
      },
      GENERATE_TIMEOUT_MS
    );
  } catch (e) {
    return {
      ok: false,
      errorType: "network",
      error: e.name === "AbortError" ? `timeout after ${GENERATE_TIMEOUT_MS}ms` : (e.message || String(e)),
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, errorType: "http", error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }
  const data = await res.json();
  const text = (data?.response || "").trim();
  if (!text) {
    return { ok: false, errorType: "empty", error: "Ollama returned empty response" };
  }
  try {
    return { ok: true, parsed: JSON.parse(text) };
  } catch {
    return { ok: false, errorType: "parse", error: `Invalid JSON: ${text.slice(0, 200)}` };
  }
};

// Preload a model into VRAM without generating any output. Fire-and-forget at
// browser startup so the first tidy click doesn't pay the cold-start cost.
// Silent on failure — daemon may not be running yet at startup, which is fine,
// the next tidy click will just see the normal cold-start latency.
export const warmupOllama = async (host, model) => {
  const base = normalizeOllamaHost(host);
  const t0 = performance.now();
  try {
    const res = await fetchWithTimeout(
      `${base}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: "",
          stream: false,
          ...withKeepAlive(),
        }),
      },
      WARMUP_TIMEOUT_MS
    );
    if (res.ok) {
      console.log(`${LOG} Ollama: warmed up "${model}" on ${base} in ${Math.round(performance.now() - t0)}ms`);
    } else {
      console.log(`${LOG} Ollama warmup non-OK (HTTP ${res.status}) — first click will cold-start`);
    }
  } catch (e) {
    // Daemon not running, network error, timeout — all expected at startup.
    console.log(`${LOG} Ollama warmup skipped (${e.name === "AbortError" ? "timeout" : "unreachable"})`);
  }
};

// User-facing error surfacing — toast + console.warn. Pass the result of
// checkOllamaReady. No-op when the status is fully healthy.
export const reportOllamaError = (host, model, status) => {
  const base = normalizeOllamaHost(host);
  if (!status.reachable) {
    const msg = `Ollama not reachable at ${base} (${status.error || "unknown error"})`;
    console.warn(`${LOG} ${msg}`);
    showToast(msg);
    return;
  }
  if (!status.modelAvailable) {
    const have = (status.availableModels || []).join(", ") || "(no models pulled)";
    const msg = `Ollama running at ${base}, but model "${model}" not found. Run: ollama pull ${model}`;
    console.warn(`${LOG} ${msg} — installed models: ${have}`);
    showToast(msg);
    return;
  }
};
