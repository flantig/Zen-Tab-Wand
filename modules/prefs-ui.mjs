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

console.log(`[ZenTabWand] prefs-ui.mjs loaded — v${BUILD_VERSION}`);

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
    "Add groups plus URL-domain and page-title matches below; changes save instantly.",
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
    "Tweaks to how grouped tabs render and how URL/title rules are prioritized.",
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

// Subset of new-group-behavior values that are meaningful on the Local engine.
// Mirrors the same 3-way pattern as the existing-behavior dropdown:
//   - auto-add        → save the cluster as a rule (hostname-derived name)
//   - transient       → apply the move, don't write a rule
//   - fresh-categories → re-tidy ALL tabs into clusters, ignoring rules
// The other Ollama values (prompt / identify-only) require LLM-style semantic
// output (Zen edit modal expects a meaningful name; Plan Mode review is only
// useful when the names mean something abstract) so they're hidden on Local.
const LOCAL_NEW_GROUP_BEHAVIORS = new Set(["auto-add", "transient", "fresh-categories"]);

// Hide individual dropdown options based on a whitelist of valid values.
// Sine's settings page is HTML (not XUL), so it renders dropdowns as either
// native <option> elements OR custom elements (e.g. <li> with data-value).
// We try multiple selectors and report what we found so a missing-selector
// case is debuggable.
const filterDropdownOptions = (row, validValues) => {
  if (!row) return;
  // Try every selector we've ever seen Sine use. value-bearing children only.
  const items = [
    ...row.querySelectorAll("option"),
    ...row.querySelectorAll("menuitem"),
    ...row.querySelectorAll("[data-value]"),
    ...row.querySelectorAll('[role="option"]'),
  ];
  if (items.length === 0) {
    console.warn(
      `${LOG} filterDropdownOptions: NO option-like children under row`,
      row,
      "innerHTML sample:",
      (row.innerHTML || "").slice(0, 400)
    );
    return;
  }
  for (const item of items) {
    const v = item.getAttribute("value") || item.getAttribute("data-value");
    if (v == null) continue;
    const allow = validValues.has(v);
    item.hidden = !allow;
    item.style.display = allow ? "" : "none";
  }
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

  // Ollama: shows BOTH the existing-behavior and new-group-behavior rows
  //   (they govern different parts of the unified classifier).
  // Local: ONE row only — new-group-behavior with the 3-option filter applied.
  //   Existing-behavior is hidden because Local unifies both decisions into
  //   the single dropdown (auto-add = grow rules; transient = don't; fresh =
  //   re-cluster ignoring rules entirely).
  setHidden(findPrefRow(dialog, CONFIG.AI_EXISTING_BEHAVIOR_PREF), engine !== "ollama");
  const newGroupBehaviorRow = findPrefRow(dialog, CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF);
  setHidden(newGroupBehaviorRow, !isLocalOrOllama);
  if (engine === "local") {
    filterDropdownOptions(newGroupBehaviorRow, LOCAL_NEW_GROUP_BEHAVIORS);
    // If the user previously had an Ollama-only behavior selected (e.g.
    // prompt / identify-only), force it back to a valid Local value so the
    // dropdown doesn't display a now-hidden selection.
    try {
      const current = Services.prefs.getStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "");
      if (current && !LOCAL_NEW_GROUP_BEHAVIORS.has(current)) {
        console.log(`${LOG} new-group-behavior "${current}" not valid on Local — resetting to "transient"`);
        Services.prefs.setStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "transient");
      }
    } catch (e) {
      console.error(`${LOG} failed to reset new-group-behavior pref:`, e);
    }
  } else if (engine === "ollama") {
    // Restore all options for Ollama (whitelist matches preferences.json).
    filterDropdownOptions(newGroupBehaviorRow,
      new Set(["auto-add", "transient", "prompt", "fresh-categories", "identify-only"])
    );
  }
  setHidden(findPrefRow(dialog, CONFIG.AI_OLLAMA_HOST_PREF),        engine !== "ollama");
  setHidden(findPrefRow(dialog, CONFIG.AI_OLLAMA_MODEL_PREF),       engine !== "ollama");
  setHidden(findPrefRow(dialog, CONFIG.AI_OLLAMA_WARMUP_PREF),      engine !== "ollama");
  setHidden(findPrefRow(dialog, CONFIG.AI_LOCAL_BATCH_SIZE_PREF),   !isLocalOrOllama);
};

// First-time AI engine warning modals.
//
// Each engine (Local, Ollama) has its own one-shot warning that fires when
// the user picks it from the dropdown for the first time. Acknowledgement is
// recorded in a per-engine pref so each modal only ever appears once.
//
// The modals do NOT re-fire on settings reopen — that would be too
// aggressive. If the user ESC's, the way to re-see is to switch engines
// off and back.
//
// The "I Understand" button is disabled for 3 seconds with a live countdown
// in the label so the user has to actually read the warning before clicking.
const COUNTDOWN_SECONDS = 3;

// Build + show a warning modal. `contentNodes` are appended to the dialog
// body in order, before the action button. `ackPref` is the pref key whose
// boolean tracks acknowledgement (skip if true, set true on confirm).
const showAckModal = ({ ackPref, contentNodes, logTag }) => {
  let alreadyAck = false;
  try { alreadyAck = Services.prefs.getBoolPref(ackPref, false); } catch {}
  console.debug(`${LOG} [${logTag}] maybeShow called — acknowledged=${alreadyAck}`);
  if (alreadyAck) {
    console.debug(`${LOG} [${logTag}] skipping — already acknowledged. To re-show, unset ${ackPref} in about:config.`);
    return;
  }
  if (document.querySelector(".zao-warning-dialog[open]")) {
    console.debug(`${LOG} [${logTag}] skipping — another warning modal already open`);
    return;
  }
  console.debug(`${LOG} [${logTag}] building modal`);

  const modal = h("dialog", { class: "zao-warning-dialog" });
  for (const n of contentNodes) modal.appendChild(n);

  const actions = h("div", { class: "zao-warning-actions" });
  const btn = h("button", { class: "zao-warning-confirm" });
  btn.type = "button";
  btn.setAttribute("disabled", "true");
  let remaining = COUNTDOWN_SECONDS;
  const updateLabel = () => {
    btn.textContent = remaining > 0 ? `${remaining}  I Understand` : "I Understand";
  };
  updateLabel();
  const tick = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(tick);
      btn.removeAttribute("disabled");
    }
    updateLabel();
  }, 1000);

  btn.addEventListener("click", () => {
    if (btn.hasAttribute("disabled")) return;
    try { Services.prefs.setBoolPref(ackPref, true); }
    catch (e) { console.warn(`${LOG} failed to set ${ackPref}:`, e); }
    try { modal.close(); } catch {}
    modal.remove();
  });
  // On ESC / external close, stop the countdown so it doesn't keep firing
  // against a detached DOM node.
  modal.addEventListener("close", () => { clearInterval(tick); });

  actions.appendChild(btn);
  modal.appendChild(actions);
  // Append to documentElement (top-level), NOT inside Sine's dialog. Nested
  // <dialog>.showModal() doesn't reliably layer above the parent and can
  // get clipped by its boundaries.
  document.documentElement.appendChild(modal);
  try {
    modal.showModal();
    console.debug(`${LOG} [${logTag}] modal shown`);
  } catch (e) {
    console.warn(`${LOG} [${logTag}] showModal() failed — falling back to confirm():`, e);
    modal.remove();
  }
};

const maybeShowOllamaWarning = () => {
  const title = h("h3", { class: "zao-warning-title", text: "Heads up: Ollama runs on your machine" });

  const lead = h("p", { class: "zao-warning-lead" });
  lead.appendChild(document.createTextNode("Ollama uses your computer's "));
  lead.appendChild(h("strong", { text: "RAM and VRAM" }));
  lead.appendChild(document.createTextNode(" to run AI models."));

  const list = h("ul", { class: "zao-warning-list" });

  const li1 = h("li");
  li1.appendChild(h("strong", { text: "Risk: " }));
  li1.appendChild(document.createTextNode("a model too big for your hardware can slow or crash your system."));

  const li2 = h("li");
  li2.appendChild(h("strong", { text: "Safe default: " }));
  li2.appendChild(document.createTextNode("qwen2.5:1.5b (~1 GB) — runs on most machines."));

  const li3 = h("li");
  li3.appendChild(h("strong", { text: "Going bigger? " }));
  const link = h("a", { class: "zao-warning-link", text: "See the model guide" });
  link.href = "https://github.com/flantig/Zen-Tab-Wand";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  li3.appendChild(link);
  li3.appendChild(document.createTextNode(" first."));

  list.appendChild(li1);
  list.appendChild(li2);
  list.appendChild(li3);

  showAckModal({
    ackPref: CONFIG.OLLAMA_ACKNOWLEDGED_PREF,
    contentNodes: [title, lead, list],
    logTag: "ollama-warning",
  });
};

const maybeShowLocalWarning = () => {
  const title = h("h3", { class: "zao-warning-title", text: "Heads up: Local AI runs inside Firefox" });

  const lead = h("p", { class: "zao-warning-lead" });
  lead.appendChild(document.createTextNode("The Local engine uses "));
  lead.appendChild(h("strong", { text: "Firefox's built-in ML model" }));
  lead.appendChild(document.createTextNode(" — no extra setup, but it runs inside the browser."));

  const list = h("ul", { class: "zao-warning-list" });

  const li1 = h("li");
  li1.appendChild(h("strong", { text: "Risk: " }));
  li1.appendChild(document.createTextNode("with hundreds of tabs, the AI pass can briefly spike CPU and lag the browser."));

  const li2 = h("li");
  li2.appendChild(h("strong", { text: "Limited: " }));
  li2.appendChild(document.createTextNode("only assigns tabs to existing groups. Won't invent new categories."));

  const li3 = h("li");
  li3.appendChild(h("strong", { text: "Want stronger results? " }));
  li3.appendChild(document.createTextNode("Try Ollama for cluster-and-name. "));
  const link = h("a", { class: "zao-warning-link", text: "See the model guide" });
  link.href = "https://github.com/flantig/Zen-Tab-Wand";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  li3.appendChild(link);
  li3.appendChild(document.createTextNode("."));

  list.appendChild(li1);
  list.appendChild(li2);
  list.appendChild(li3);

  showAckModal({
    ackPref: CONFIG.LOCAL_ACKNOWLEDGED_PREF,
    contentNodes: [title, lead, list],
    logTag: "local-warning",
  });
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
      const engine = getAIEngine();
      console.log(`${LOG} [ollama-warning] engine pref changed → "${engine}"`);
      for (const d of document.querySelectorAll(".sineItemPreferenceDialog")) {
        if (isOurDialog(d)) {
          updateConditionalFields(d);
          // First-time engine warning. Each engine has its own one-shot
          // acknowledgement pref; neither modal re-fires once acknowledged.
          if (engine === "ollama") maybeShowOllamaWarning();
          else if (engine === "local") maybeShowLocalWarning();
          break;
        }
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
  // keepIncomplete: true so a blank row the user added in a previous session
  // (saved as `{name:"", domains:[]}`) reappears in the editor and can be
  // filled in. The wand-click pipeline (`loadRules`) still filters these out.
  let initial = readRulesPref({ keepIncomplete: true });
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
