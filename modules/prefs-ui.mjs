// Zen Tab Wand — preferences-context setup.
// Watches for Sine's per-mod settings dialog and injects the rules editor widget
// after the "Group Rules" separator. Also injects our stylesheet (Sine's chrome CSS
// pipeline doesn't reach about:preferences scope).

import { CONFIG, LOG, DEFAULT_RULES, BUILD_VERSION, h } from "./config.mjs";
import { readRulesPref, writeRulesPref, getAIEngine } from "./rules.mjs";
import {
  buildRulesEditor,
  buildSkipDomainsEditor,
  buildCustomIconsEditor,
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
    "Export your rules, skip list, and custom icons as JSON for safekeeping, or import a previously-saved file to restore them.",
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

const CHECKBOX_RIGHT_PREFS = [
  CONFIG.MINIMAL_STYLE_PREF,
  CONFIG.STRICT_RULES_PREF,
  CONFIG.AI_OLLAMA_WARMUP_PREF,
];

const CONTROL_ROW_PREFS = [
  CONFIG.MINIMAL_STYLE_PREF,
  CONFIG.STRICT_RULES_PREF,
  CONFIG.MATCH_MODE_PREF,
  CONFIG.GRADIENT_STYLE_PREF,
  CONFIG.AI_ENGINE_PREF,
  CONFIG.AI_TITLE_LEARNING_PREF,
  CONFIG.AI_EXISTING_BEHAVIOR_PREF,
  CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF,
  CONFIG.AI_OLLAMA_HOST_PREF,
  CONFIG.AI_OLLAMA_MODEL_PREF,
  CONFIG.AI_OLLAMA_WARMUP_PREF,
  CONFIG.AI_LOCAL_BATCH_SIZE_PREF,
];

const DROPDOWN_PREFS = [
  CONFIG.MATCH_MODE_PREF,
  CONFIG.GRADIENT_STYLE_PREF,
  CONFIG.AI_ENGINE_PREF,
  CONFIG.AI_TITLE_LEARNING_PREF,
  CONFIG.AI_EXISTING_BEHAVIOR_PREF,
  CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF,
];

const DROPDOWN_CONFIGS = {
  [CONFIG.MATCH_MODE_PREF]: {
    defaultValue: "url-then-title",
    options: [
      ["url-only", "URL only"],
      ["title-only", "Title only"],
      ["url-then-title", "URL then Title"],
      ["title-then-url", "Title then URL"],
    ],
  },
  [CONFIG.GRADIENT_STYLE_PREF]: {
    defaultValue: "left-right",
    options: [
      ["left-right", "Left to right"],
      ["right-left", "Right to left"],
      ["top-bottom", "Top to bottom"],
      ["bottom-top", "Bottom to top"],
      ["diagonal-down", "Diagonal down"],
      ["diagonal-up", "Diagonal up"],
      ["radial", "Radial"],
    ],
  },
  [CONFIG.AI_ENGINE_PREF]: {
    defaultValue: "off",
    options: [
      ["off", "None"],
      ["local", "Local — Built-in model, limited capability"],
      ["ollama", "Ollama — Stronger model, requires Ollama running locally"],
    ],
  },
  [CONFIG.AI_TITLE_LEARNING_PREF]: {
    defaultValue: "off",
    options: [
      ["off", "None"],
      ["review-save-simple", "Review and Save (Simple)"],
      ["review-save-complex", "Review and Save (Complex)"],
    ],
  },
  [CONFIG.AI_EXISTING_BEHAVIOR_PREF]: {
    defaultValue: "always-add",
    options: [
      ["always-add", "Move + Save Domain — Move the tab and add its domain to the matched rule"],
      ["transient", "Move Once — Move the tab now; do not update saved rules"],
    ],
  },
  [CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF]: {
    defaultValue: "auto-add",
    options: [
      ["auto-add", "Preview + Save Rule — Review first; kept groups become saved rules"],
      ["transient", "Group Once — Create groups now; do not save rules"],
      ["prompt", "Zen Edit Prompt — Create groups, then open Zen's rename/color dialog"],
      ["fresh-categories", "Fresh Rebuild — Ignore current rules and regroup all tabs from scratch"],
      ["identify-only", "Preview Only — Review/re-assign first; apply groups without saving rules"],
    ],
  },
};

const normalizeMatchModeLabel = (row) => {
  const label = row.querySelector(".sineItemPreferenceLabel") || row.firstElementChild;
  if (!label) return;
  label.textContent = label.textContent.replace(/^\s+/, "");
  for (const attr of ["value", "label"]) {
    if (label.hasAttribute?.(attr)) {
      label.setAttribute(attr, label.getAttribute(attr).replace(/^\s+/, ""));
    }
  }
};

const alignSettingRows = (dialog) => {
  for (const prefName of CONTROL_ROW_PREFS) {
    const row = findPrefRow(dialog, prefName);
    if (!row) continue;
    row.classList.add("zao-control-row");
    if (prefName === CONFIG.MATCH_MODE_PREF) {
      row.classList.add("zao-match-mode-row");
      normalizeMatchModeLabel(row);
    }
  }
  for (const prefName of CHECKBOX_RIGHT_PREFS) {
    const row = findPrefRow(dialog, prefName);
    if (!row) continue;
    row.classList.add("zao-checkbox-right");
    const checkbox = row.querySelector('input[type="checkbox"], checkbox, [role="checkbox"]');
    if (checkbox) {
      checkbox.classList.add("zao-checkbox-control");
      if (row.firstElementChild !== checkbox) {
        row.insertBefore(checkbox, row.firstElementChild);
      }
    }
  }
};

const setupAIEngineChangeFallback = (dialog) => {
  const row = findPrefRow(dialog, CONFIG.AI_ENGINE_PREF);
  if (!row || row._zaoAIEngineFallback) return;
  row._zaoAIEngineFallback = true;
  const refresh = () => {
    setTimeout(() => updateConditionalFields(dialog), 0);
    setTimeout(() => updateConditionalFields(dialog), 100);
  };
  row.addEventListener("change", refresh);
  row.addEventListener("input", refresh);
  row.addEventListener("command", refresh);
  row.addEventListener("click", refresh);
};

const shortOptionLabel = (label) =>
  String(label || "").split(/\s+(?:--|—)\s+/)[0].trim();

const dropdownConfig = (prefName) => DROPDOWN_CONFIGS[prefName];

const readStringPref = (prefName, fallback = "") => {
  try { return Services.prefs.getStringPref(prefName, fallback); }
  catch { return fallback; }
};

const writeStringPref = (prefName, value) => {
  try { Services.prefs.setStringPref(prefName, value); }
  catch (e) { console.warn(`${LOG} failed to set ${prefName}:`, e); }
};

const closeCustomDropdowns = (dialog, except = null) => {
  for (const wrap of dialog.querySelectorAll(".zao-custom-dropdown.zao-open")) {
    if (wrap === except) continue;
    wrap.classList.remove("zao-open");
    wrap.querySelector(".zao-custom-dropdown-button")?.setAttribute("aria-expanded", "false");
  }
};

const selectedDropdownOption = (config, value) =>
  config.options.find(([v]) => v === value) || config.options.find(([v]) => v === config.defaultValue) || config.options[0];

const syncCustomDropdown = (dialog, prefName) => {
  const row = findPrefRow(dialog, prefName);
  const wrap = row?.querySelector(".zao-custom-dropdown");
  const config = dropdownConfig(prefName);
  if (!row || !wrap || !config) return;

  const value = readStringPref(prefName, config.defaultValue);
  const selected = selectedDropdownOption(config, value);
  const button = wrap.querySelector(".zao-custom-dropdown-button");
  const label = selected?.[1] || "";
  button.textContent = shortOptionLabel(label);
  button.title = label;
  button.dataset.value = selected?.[0] || "";
  for (const item of wrap.querySelectorAll(".zao-custom-dropdown-item")) {
    const isSelected = item.dataset.value === button.dataset.value;
    item.classList.toggle("zao-selected", isSelected);
    item.setAttribute("aria-selected", isSelected ? "true" : "false");
  }
};

const installCustomDropdown = (dialog, prefName) => {
  const row = findPrefRow(dialog, prefName);
  const config = dropdownConfig(prefName);
  if (!row || !config || row._zaoCustomDropdown) return;
  row._zaoCustomDropdown = true;

  for (const control of row.querySelectorAll("select, menulist, button:not(.zao-custom-dropdown-button), [role='button']:not(.zao-custom-dropdown-button)")) {
    control.classList.add("zao-native-dropdown-hidden");
    control.setAttribute("aria-hidden", "true");
    control.tabIndex = -1;
  }

  const wrap = h("div", { class: "zao-custom-dropdown" });
  wrap.dataset.pref = prefName;
  const button = h("button", { class: "zao-custom-dropdown-button" });
  button.type = "button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const menu = h("div", { class: "zao-custom-dropdown-menu" });
  menu.setAttribute("role", "listbox");

  for (const [value, label] of config.options) {
    const item = h("button", { class: "zao-custom-dropdown-item", text: label });
    item.type = "button";
    item.dataset.value = value;
    item.dataset.fullLabel = label;
    item.setAttribute("role", "option");
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      writeStringPref(prefName, value);
      closeCustomDropdowns(dialog);
      syncCustomDropdown(dialog, prefName);
      updateConditionalFields(dialog);
    });
    menu.appendChild(item);
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !wrap.classList.contains("zao-open");
    closeCustomDropdowns(dialog, wrap);
    wrap.classList.toggle("zao-open", willOpen);
    button.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });
  button.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCustomDropdowns(dialog);
      button.focus();
    }
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      wrap.classList.add("zao-open");
      button.setAttribute("aria-expanded", "true");
      wrap.querySelector(".zao-custom-dropdown-item:not(.zao-option-hidden)")?.focus();
    }
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".zao-custom-dropdown-item:not(.zao-option-hidden)")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      closeCustomDropdowns(dialog);
      button.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[Math.min(i + 1, items.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[Math.max(i - 1, 0)]?.focus();
    }
  });

  wrap.appendChild(button);
  wrap.appendChild(menu);
  row.appendChild(wrap);
  syncCustomDropdown(dialog, prefName);
};

const installCustomDropdowns = (dialog) => {
  if (!dialog._zaoCustomDropdownClose) {
    dialog._zaoCustomDropdownClose = true;
    document.addEventListener("click", (e) => {
      if (!dialog.isConnected || dialog.contains(e.target)) return;
      closeCustomDropdowns(dialog);
    });
    dialog.addEventListener("click", (e) => {
      if (!e.target.closest?.(".zao-custom-dropdown")) closeCustomDropdowns(dialog);
    });
  }
  for (const prefName of DROPDOWN_PREFS) installCustomDropdown(dialog, prefName);
};

const normalizeAIEngineValue = (value) => {
  const v = String(value || "").toLocaleLowerCase();
  if (v === "") return "";
  if (v === "off") return "off";
  if (v === "local") return "local";
  if (v === "ollama") return "ollama";
  const hasLocal = v.includes("local");
  const hasOllama = v.includes("ollama");
  if (hasLocal && !hasOllama) return "local";
  if (hasOllama && !hasLocal) return "ollama";
  if (v === "none") return "off";
  return "";
};

const readSelectedAIEngineFromDialog = (dialog) => {
  const row = findPrefRow(dialog, CONFIG.AI_ENGINE_PREF);
  if (!row) return "";

  const customValue = normalizeAIEngineValue(row.querySelector(".zao-custom-dropdown-button")?.dataset.value);
  if (customValue) return customValue;

  for (const control of row.querySelectorAll("select, menulist, button, input")) {
    const value = normalizeAIEngineValue(control.value || control.getAttribute?.("value"));
    if (value) return value;
    const label = normalizeAIEngineValue(control.label || control.getAttribute?.("label"));
    if (label) return label;
    const text = normalizeAIEngineValue(control.textContent);
    if (text) return text;
  }

  const selected = row.querySelector(
    "option:checked, [selected], [aria-selected='true'], [data-selected='true']"
  );
  const selectedValue = normalizeAIEngineValue(
    selected?.getAttribute?.("value") ||
    selected?.getAttribute?.("data-value") ||
    selected?.textContent
  );
  if (selectedValue) return selectedValue;

  return "";
};

const AI_NEW_GROUP_OPTIONS = {
  local: new Set(["auto-add", "transient", "fresh-categories"]),
  ollama: new Set(["auto-add", "transient", "prompt", "fresh-categories", "identify-only"]),
};

const optionValue = (option) =>
  option?.value || option?.getAttribute?.("value") || option?.getAttribute?.("data-value") || "";

const setNewGroupOptionsForEngine = (dialog, engine) => {
  const row = findPrefRow(dialog, CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF);
  if (!row) return;
  const allowed = AI_NEW_GROUP_OPTIONS[engine];
  if (!allowed) return;

  try {
    const stored = Services.prefs.getStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "auto-add");
    if (!allowed.has(stored)) Services.prefs.setStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "auto-add");
  } catch {}

  for (const option of row.querySelectorAll("option, menuitem")) {
    const value = optionValue(option);
    const hidden = value && !allowed.has(value);
    option.hidden = hidden;
    option.disabled = hidden;
    option.setAttribute("aria-hidden", hidden ? "true" : "false");
  }

  for (const control of row.querySelectorAll("select, menulist")) {
    const value = optionValue(control);
    if (value && !allowed.has(value)) {
      control.value = "auto-add";
      try { Services.prefs.setStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "auto-add"); } catch {}
    }
  }

  const custom = row.querySelector(".zao-custom-dropdown");
  if (custom) {
    for (const item of custom.querySelectorAll(".zao-custom-dropdown-item")) {
      const hidden = !allowed.has(item.dataset.value);
      item.classList.toggle("zao-option-hidden", hidden);
      item.disabled = hidden;
      item.setAttribute("aria-hidden", hidden ? "true" : "false");
    }
    syncCustomDropdown(dialog, CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF);
  }
};

const updateConditionalFields = (dialog) => {
  // Prefer the visible control because Sine may update the UI before the pref
  // observer sees the committed value. Fall back to the stored pref on reopen.
  const uiEngine = readSelectedAIEngineFromDialog(dialog);
  const prefEngine = getAIEngine();
  const engine = uiEngine || prefEngine;
  const isLocalOrOllama = engine === "local" || engine === "ollama";

  const setHidden = (row, hidden) => {
    if (!row) return;
    row.classList.toggle("zao-pref-hidden", hidden);
  };

  // Ollama: shows BOTH the existing-behavior and new-group-behavior rows
  //   (they govern different parts of the unified classifier).
  // Local: ONE row only — new-group-behavior.
  //   Existing-behavior is hidden because Local unifies both decisions into
  //   the single dropdown (auto-add = grow rules; transient = don't; fresh =
  //   re-cluster ignoring rules entirely).
  const rows = {
    engine: findPrefRow(dialog, CONFIG.AI_ENGINE_PREF),
    titleLearning: findPrefRow(dialog, CONFIG.AI_TITLE_LEARNING_PREF),
    existingBehavior: findPrefRow(dialog, CONFIG.AI_EXISTING_BEHAVIOR_PREF),
    newGroupBehavior: findPrefRow(dialog, CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF),
    ollamaHost: findPrefRow(dialog, CONFIG.AI_OLLAMA_HOST_PREF),
    ollamaModel: findPrefRow(dialog, CONFIG.AI_OLLAMA_MODEL_PREF),
    ollamaWarmup: findPrefRow(dialog, CONFIG.AI_OLLAMA_WARMUP_PREF),
    localBatchSize: findPrefRow(dialog, CONFIG.AI_LOCAL_BATCH_SIZE_PREF),
  };

  setHidden(rows.existingBehavior, engine !== "ollama");
  setHidden(rows.titleLearning, engine !== "ollama");
  setHidden(rows.newGroupBehavior, !isLocalOrOllama);
  setHidden(rows.ollamaHost,        engine !== "ollama");
  setHidden(rows.ollamaModel,       engine !== "ollama");
  setHidden(rows.ollamaWarmup,      engine !== "ollama");
  setHidden(rows.localBatchSize,    !isLocalOrOllama);
  setNewGroupOptionsForEngine(dialog, engine);
  for (const prefName of DROPDOWN_PREFS) syncCustomDropdown(dialog, prefName);
  alignSettingRows(dialog);
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
  if (alreadyAck) {
    return;
  }
  if (document.querySelector(".zao-warning-dialog[open]")) {
    return;
  }

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
  li2.appendChild(document.createTextNode("creates simpler hostname/intent-based groups than Ollama."));

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
  const customIconsEditor = buildCustomIconsEditor();
  const backupSection = buildBackupRestoreSection();

  // Each section's content lives as a sibling immediately after its Sine
  // separator. injectSectionDescriptions runs next and will insert its
  // description paragraph BETWEEN the separator and our content (because it
  // checks `nextElementSibling` for a description and inserts at separator+1
  // when not found).
  insertAfter(content, rulesEditor, findSeparatorContainer(dialog, "Group Rules"));
  insertAfter(content, skipEditor, findSeparatorContainer(dialog, "Skip Domains"));
  insertAfter(content, customIconsEditor, findSeparatorContainer(dialog, "Look & Feel"));
  insertAfter(content, backupSection, findSeparatorContainer(dialog, "Backup & Restore"));

  tagSeparatorContainers(dialog);
  injectSectionDescriptions(dialog);
  installCustomDropdowns(dialog);
  setupEnginePrefObserver();
  updateConditionalFields(dialog);
  setupAIEngineChangeFallback(dialog);
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
