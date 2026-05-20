// Zen Tab Wand — preferences-context setup.
// Watches for Sine's per-mod settings dialog and injects the rules editor widget
// after the "Group Rules" separator. Also injects our stylesheet (Sine's chrome CSS
// pipeline doesn't reach about:preferences scope).

import { CONFIG, LOG, DEFAULT_RULES, BUILD_VERSION, h } from "./config.mjs";
import { readRulesPref, writeRulesPref, getAIEngine } from "./rules.mjs";
import {
  buildRulesEditor,
  buildSkipDomainsEditor,
  buildBackupRestoreSection,
  teardownRulesPrefObserver,
  teardownSkipPrefObserver,
} from "./widget.mjs";
import { fetchZenColorsFromBrowser } from "./color-picker.mjs";

console.log(`[ZenTabWand] prefs-ui.mjs loaded — build ${BUILD_VERSION}`);

let settingsObserver = null;

// Returns true if `dialog` contains a Sine separator whose label starts with
// "Group Rules" — our marker for "this is our mod's settings dialog". We use
// this instead of matching on `[mod-id]` because Sine's exact attribute scheme
// has been inconsistent across versions and our id changed mid-flight.
const isOurDialog = (dialog) => {
  if (!dialog) return false;
  for (const lbl of dialog.querySelectorAll(".separator-label")) {
    if (lbl.textContent.trim().startsWith("Group Rules")) return true;
  }
  return false;
};

const injectStylesheet = async () => {
  try {
    // ?t=<timestamp> defeats Gecko's chrome:// fetch cache so iterative CSS edits
    // show up after a simple dialog close+reopen (no Zen restart needed).
    const res = await fetch(`${CONFIG.CSS_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const css = await res.text();
    const existing = document.querySelector("style[data-zao-style]");
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.setAttribute("data-zao-style", "1");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {
    console.warn(`${LOG} failed to inject stylesheet:`, e);
  }
};

// Inline section descriptions injected as siblings AFTER a Sine separator.
// We can't put paragraph-length text in the separator's label itself — Sine
// renders that as a bold section header and the long string visually breaks the
// surrounding layout. Each entry: [labelPrefix, descriptionText].
const SECTION_DESCRIPTIONS = [
  [
    "Group Rules",
    "Add groups and domains below; changes save instantly.",
  ],
  [
    "Skip Domains",
    "Hostnames in this list are never touched by the tidy click — matching tabs are ejected from any group and parked at the top of the workspace. Useful for tabs you want to always keep visible and ungrouped.",
  ],
  [
    "Backup & Restore",
    "Export your rules and skip list as JSON for safekeeping, or import a previously-saved file to restore them.",
  ],
  [
    "Look & Feel",
    "Tweaks to how grouped tabs render in Zen's sidebar.",
  ],
  [
    "AI Sorting",
    "Optional second pass after the rule engine. Two backends available: a small built-in model (fast but only handles obvious matches into existing groups) or a local Ollama daemon (much smarter, also forms new groups — requires Ollama running on your machine).",
  ],
];

// Tag each separator's outer container so CSS can style the row (border-bottom,
// margins) without applying layout properties to the XUL <label> itself —
// XUL labels behave unpredictably with `display: block` and pseudo-element
// overrides.
const tagSeparatorContainers = (dialog) => {
  for (const lbl of dialog.querySelectorAll(".separator-label")) {
    const container = lbl.closest("vbox") || lbl.parentElement;
    container?.classList?.add("zao-section-header-row");
  }
};

const injectSectionDescriptions = (dialog) => {
  const seps = Array.from(dialog.querySelectorAll(".separator-label"));
  for (const [prefix, text] of SECTION_DESCRIPTIONS) {
    const sep = seps.find((lbl) => lbl.textContent.trim().startsWith(prefix));
    if (!sep) continue;
    const container = sep.closest("vbox") || sep.parentElement;
    // Idempotency — re-injecting on dialog reopen shouldn't pile up <div>s.
    if (container.nextElementSibling?.classList?.contains("zao-pref-description")) continue;
    const desc = h("div");
    desc.className = "zao-pref-description";
    desc.textContent = text;
    container.parentNode.insertBefore(desc, container.nextSibling);
  }
};

// ─── Conditional field visibility ────────────────────────────────────────────
// Sine's preferences.json has no native conditional show/hide, so each control
// renders unconditionally and we toggle a `.zao-pref-hidden` class based on the
// current AI engine value.
//
// Strategy for locating a control's row:
//   1. element with `[pref=...]` or `[property=...]` set to the pref name
//   2. fallback: walk labels, match on text, climb to nearest vbox/hbox
// Sine's exact DOM is opaque to us, so we try both.

// Sine assigns each pref's outer container an `id` derived from the pref name
// with dots replaced by dashes. e.g. `extensions.zen-auto-organize.ai-engine`
// becomes id="extensions-zen-auto-organize-ai-engine". Targeting that id
// directly is way more reliable than guessing at class names.
const findPrefRow = (dialog, prefName) => {
  const id = prefName.replace(/\./g, "-");
  return dialog.querySelector(`#${CSS.escape(id)}`);
};

const updateConditionalFields = (dialog) => {
  // Always go through getAIEngine() so unknown / empty / "None" pref values
  // normalize to "off" the same way as everywhere else in the codebase.
  const engine = getAIEngine();
  const isLocalOrOllama = engine === "local" || engine === "ollama";

  const setHidden = (row, hidden) => {
    if (!row) return;
    row.classList.toggle("zao-pref-hidden", hidden);
  };

  setHidden(findPrefRow(dialog, CONFIG.AI_EXISTING_BEHAVIOR_PREF), !isLocalOrOllama);
  setHidden(findPrefRow(dialog, CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF), engine !== "ollama");
  setHidden(findPrefRow(dialog, CONFIG.AI_OLLAMA_HOST_PREF),        engine !== "ollama");
  setHidden(findPrefRow(dialog, CONFIG.AI_OLLAMA_MODEL_PREF),       engine !== "ollama");
  setHidden(findPrefRow(dialog, CONFIG.AI_OLLAMA_WARMUP_PREF),      engine !== "ollama");
};

// Re-run the show/hide pass whenever the engine pref flips. One observer per
// preferences-window context, torn down with the rest on window unload.
let enginePrefObserver = null;
const setupEnginePrefObserver = () => {
  if (enginePrefObserver) return;
  enginePrefObserver = {
    observe(_subject, topic, data) {
      if (topic !== "nsPref:changed") return;
      if (data !== CONFIG.AI_ENGINE_PREF) return;
      for (const d of document.querySelectorAll(".sineItemPreferenceDialog")) {
        if (isOurDialog(d)) { updateConditionalFields(d); break; }
      }
    },
  };
  Services.prefs.addObserver(CONFIG.AI_ENGINE_PREF, enginePrefObserver);
};

const teardownEnginePrefObserver = () => {
  if (!enginePrefObserver) return;
  try { Services.prefs.removeObserver(CONFIG.AI_ENGINE_PREF, enginePrefObserver); } catch {}
  enginePrefObserver = null;
};

// Locate a Sine separator by the prefix of its visible label, returning the
// outer container element (so injectAfter places content as a sibling of it).
const findSeparatorContainer = (dialog, prefix) => {
  for (const lbl of dialog.querySelectorAll(".separator-label")) {
    if (lbl.textContent.trim().startsWith(prefix)) {
      return lbl.closest("vbox") || lbl.parentElement;
    }
  }
  return null;
};

const insertAfter = (parent, newNode, refNode) => {
  if (refNode && refNode.parentNode === parent) {
    parent.insertBefore(newNode, refNode.nextSibling);
  } else {
    parent.insertBefore(newNode, parent.firstChild);
  }
};

const performInject = (dialog) => {
  if (dialog.querySelector(".zao-rules-editor")) return;

  const content = dialog.querySelector(".sineItemPreferenceDialogContent");
  if (!content) return;

  // Seed the rules pref with defaults on first open if currently empty.
  let initial = readRulesPref();
  if (!initial || initial.length === 0) {
    initial = JSON.parse(JSON.stringify(DEFAULT_RULES));
    writeRulesPref(initial);
  }

  const rulesEditor = buildRulesEditor(initial);
  const skipEditor = buildSkipDomainsEditor();
  const backupSection = buildBackupRestoreSection();

  // Each section's content lives as a sibling immediately after its Sine
  // separator. injectSectionDescriptions runs next and will insert its
  // description paragraph BETWEEN the separator and our content (because it
  // checks `nextElementSibling` for a description and inserts at separator+1
  // when not found).
  insertAfter(content, rulesEditor, findSeparatorContainer(dialog, "Group Rules"));
  insertAfter(content, skipEditor, findSeparatorContainer(dialog, "Skip Domains"));
  insertAfter(content, backupSection, findSeparatorContainer(dialog, "Backup & Restore"));

  tagSeparatorContainers(dialog);
  injectSectionDescriptions(dialog);
  setupEnginePrefObserver();
  updateConditionalFields(dialog);
  console.log(`${LOG} injected rules + skip + backup sections into Sine settings dialog`);
};

// Sine's loadPrefs() is async — the dialog is added to DOM before its content is
// populated. Poll for the "Group Rules" separator (or legacy "Rules") to appear,
// then inject once. Also wire a re-render hook for when the dialog is reopened.
const onOurDialogFound = (dialog) => {
  // Marker class — scopes our separator-restyling CSS to our dialog only,
  // so we don't restyle SuperPins or any other mod's section headers.
  dialog.classList.add("zao-our-dialog");

  if (dialog.querySelector(".zao-rules-editor")) {
    const editor = dialog.querySelector(".zao-rules-editor");
    editor?._zaoRefresh?.("dialog reopened");
    return;
  }

  if (!dialog._zaoOpenWatcher) {
    const watcher = new MutationObserver(() => {
      if (dialog.hasAttribute("open")) {
        const editor = dialog.querySelector(".zao-rules-editor");
        editor?._zaoRefresh?.("dialog open attr");
        // Re-sync visibility — Sine may have re-rendered controls on reopen.
        updateConditionalFields(dialog);
      }
    });
    watcher.observe(dialog, { attributes: true, attributeFilter: ["open"] });
    dialog._zaoOpenWatcher = watcher;
  }

  injectStylesheet();

  let attempts = 0;
  const poll = () => {
    // If the dialog was removed mid-poll (user closed the prefs page), abandon —
    // querying a detached node burns CPU and pollutes the console with warnings.
    if (!dialog.isConnected) return;
    if (dialog.querySelector(".zao-rules-editor")) return;
    let separator = null;
    for (const lbl of dialog.querySelectorAll(".separator-label")) {
      const text = lbl.textContent.trim();
      if (text.startsWith("Group Rules") || text.startsWith("Rules")) {
        separator = lbl.closest("vbox") || lbl.parentElement;
        break;
      }
    }
    if (separator) {
      try { performInject(dialog); }
      catch (e) { console.error(`${LOG} inject failed:`, e); }
      return;
    }
    attempts++;
    if (attempts >= CONFIG.INJECT_MAX_POLL_ATTEMPTS) {
      console.warn(`${LOG} Rules separator not found after ${attempts * CONFIG.INJECT_POLL_INTERVAL_MS}ms; injecting at content top`);
      try { performInject(dialog); }
      catch (e) { console.error(`${LOG} inject failed:`, e); }
      return;
    }
    setTimeout(poll, CONFIG.INJECT_POLL_INTERVAL_MS);
  };
  poll();
};

// Watch for Sine's per-mod settings dialog. Identify by the presence of a
// "Group Rules" separator inside any .sineItemPreferenceDialog — robust against
// Sine's mod-id attribute scheme changing across versions.
export const setupSettingsObserver = () => {
  if (settingsObserver) return;

  // Pull Zen's live tab-group palette so the picker matches the native modal exactly.
  fetchZenColorsFromBrowser();

  const scanForOurDialog = (root) => {
    if (!root || root.nodeType !== 1) return;
    const dialogs = [];
    if (root.matches?.(".sineItemPreferenceDialog")) dialogs.push(root);
    root.querySelectorAll?.(".sineItemPreferenceDialog").forEach((d) => dialogs.push(d));
    for (const d of dialogs) {
      if (isOurDialog(d)) onOurDialogFound(d);
    }
  };

  settingsObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        scanForOurDialog(node);
      }
      // Also: a child separator-label may be added LATER to an existing dialog
      // (Sine's loadPrefs is async). Re-check the dialog the mutation happened in.
      if (m.target?.closest) {
        const dialog = m.target.closest(".sineItemPreferenceDialog");
        if (dialog && isOurDialog(dialog)) onOurDialogFound(dialog);
      }
    }
  });
  settingsObserver.observe(document.body, { childList: true, subtree: true });

  // Catch any dialog already in the DOM at init time.
  document.querySelectorAll(".sineItemPreferenceDialog").forEach((d) => {
    if (isOurDialog(d)) onOurDialogFound(d);
  });
  console.log(`${LOG} settings observer installed`);
};

export const teardownSettingsObserver = () => {
  if (settingsObserver) {
    settingsObserver.disconnect();
    settingsObserver = null;
  }
  teardownEnginePrefObserver();
  teardownRulesPrefObserver();
  teardownSkipPrefObserver();
};
