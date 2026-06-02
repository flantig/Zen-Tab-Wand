// Zen Tab Wand — tab enumeration + DOM helpers.

export const getTabTitle = (tab) => {
  if (!tab?.isConnected) return "";
  const labelAttr = tab.getAttribute("label");
  if (labelAttr && labelAttr.trim()) return labelAttr.trim();
  const labelEl = tab.querySelector(".tab-label, .tab-text");
  return (labelEl?.textContent || "").trim();
};

// Resolve a tab's URL through whatever linked-browser handle is currently populated.
// Each fallback covers a different lifecycle moment:
//   tab.linkedBrowser      — normal steady-state (set after the browser binding loads)
//   tab._linkedBrowser     — Zen's pre-binding cache during early init
//   gBrowser.getBrowserForTab — API-style lookup; covers exotic tab types
export const getTabUrl = (tab) => {
  const browser =
    tab.linkedBrowser ||
    tab._linkedBrowser ||
    gBrowser?.getBrowserForTab?.(tab);
  return browser?.currentURI?.spec || "";
};

export const getHostname = (url) => {
  if (!url || url.startsWith("about:")) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// ─── Page snippet for AI classification context ──────────────────────────────
//
// Fetches a tab's URL and extracts a structured signal block for the AI
// classifier: page type (article/video/product/profile/...), site brand,
// main heading, and description. The page TYPE is the strongest signal for
// Arc-style intent-driven groupings ("Articles I'm reading" vs "Shopping").
//
// Fetches happen from chrome-privileged code with the user's cookie jar
// (credentials: "include"), so authed pages return the real content rather
// than a login wall. CORS doesn't apply at chrome scope.

const SNIPPET_MAX_CHARS = 400;
const SNIPPET_FETCH_TIMEOUT_MS = 3000;

// Minimal HTML entity decoder — covers the entities that appear in meta tags.
const decodeHtmlEntities = (s) => s
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&#x27;/g, "'")
  .replace(/&nbsp;/g, " ");

const extractMetaContent = (html, name) => {
  // Match either name="..." or property="..." with content before OR after,
  // so we work for both `<meta name="x" content="y">` and the reversed order.
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1]).trim();
  }
  return "";
};

// First <h1> — usually the page's main topic. Strip any nested tags from the
// captured content. Returns "" if no h1 present (e.g. SPAs that hydrate later,
// or sites that use h1 for the site logo / navigation only).
const extractFirstH1 = (html) => {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m?.[1]) return "";
  return decodeHtmlEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
};

// Pull a structured signal block instead of just the meta description. Each
// element is tagged ([type: ...], [site: ...], [topic: ...]) so the LLM can
// see them as distinct features rather than one blurry sentence. Empty
// strings drop out — small sites with no OG metadata still get whatever's
// available.
const extractSnippetFromHtml = (html) => {
  const desc =
    extractMetaContent(html, "description") ||
    extractMetaContent(html, "og:description") ||
    extractMetaContent(html, "twitter:description");
  const ogType = extractMetaContent(html, "og:type");
  const ogSiteName = extractMetaContent(html, "og:site_name");
  const h1 = extractFirstH1(html);

  const parts = [];
  if (ogType) parts.push(`[type: ${ogType.slice(0, 30)}]`);
  if (ogSiteName) parts.push(`[site: ${ogSiteName.slice(0, 40)}]`);
  if (h1 && h1.toLowerCase() !== desc.toLowerCase()) {
    parts.push(`[topic: ${h1.slice(0, 100)}]`);
  }
  if (desc) parts.push(desc.slice(0, 250));

  if (parts.length === 0) return "";
  return parts.join(" ").replace(/\s+/g, " ").slice(0, SNIPPET_MAX_CHARS).trim();
};

// Returns "" on any failure (404, timeout, network error, non-HTML response,
// no usable meta tag). Caller treats empty as "no snippet, fall back to title".
export const fetchPageSnippet = async (url) => {
  if (!url) return "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNIPPET_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: "include", // send the user's cookies so authed pages return real content
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return "";
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("html")) return "";
    const html = await res.text();
    return extractSnippetFromHtml(html);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Snapshot eligible tabs in the active workspace.
 *
 * @returns { workspaceId, tabs } where each tab is:
 *   {
 *     id: number,           // positional index within this snapshot — NOT a stable tab id
 *     title: string,
 *     url: string,
 *     hostname: string,     // www.-stripped; "" for about:* URLs
 *     currentGroup: string | null,  // label of the tab-group it's currently in, or null
 *     _tab: <tab>           // live DOM element. underscore convention: "internal/not-serializable"
 *                           //   — callers may mutate via gBrowser.* APIs but should never
 *                           //     JSON.stringify a tab info object directly.
 *   }
 *
 * Grouped tabs ARE included — Pass 1 may want to move them between groups when their
 * current placement disagrees with the rules. Filters out: pinned, empty (placeholder),
 * glance, essential, and tabs from other workspaces.
 */
export const getEligibleTabs = () => {
  const workspaceId = window.gZenWorkspaces?.activeWorkspace;
  if (!workspaceId || typeof gBrowser === "undefined" || !gBrowser.tabs) {
    return { workspaceId: null, tabs: [] };
  }

  const tabs = Array.from(gBrowser.tabs)
    .filter((tab) => {
      if (!tab?.isConnected) return false;
      if (tab.getAttribute("zen-workspace-id") !== workspaceId) return false;
      if (tab.pinned) return false;
      if (tab.hasAttribute("zen-empty-tab")) return false;
      if (tab.hasAttribute("zen-glance-tab")) return false;
      if (tab.hasAttribute("zen-essential")) return false;
      return true;
    })
    .map((tab, idx) => {
      const url = getTabUrl(tab);
      const currentGroupEl = tab.closest("tab-group");
      return {
        id: idx,
        title: getTabTitle(tab) || "(untitled)",
        url,
        hostname: getHostname(url),
        currentGroup: currentGroupEl?.getAttribute("label") || null,
        _tab: tab,
      };
    });

  return { workspaceId, tabs };
};

// Cached DOM lookups for the toolbar button injection points.
// Invalidate on workspace changes (the active workspace's separator changes).
export const domCache = {
  separators: null,
  commandSet: null,

  getSeparators() {
    if (!this.separators || !this.separators.length) {
      this.separators = document.querySelectorAll(".pinned-tabs-container-separator");
    }
    return this.separators;
  },

  getCommandSet() {
    if (!this.commandSet) {
      this.commandSet = document.querySelector("commandset#zenCommandSet");
    }
    return this.commandSet;
  },

  invalidate() {
    this.separators = null;
    this.commandSet = null;
  },
};
