// Zen Tab Wand — settings rules editor widget.
// Builds the pill table (Category | Domains) with +/- buttons, color swatch per row,
// hex input, and live persistence to the rules pref. Also wires a pref observer so
// external changes (TabGrouped hook) refresh the table in real time.

import { CONFIG, LOG, h } from "./config.mjs";
import { readRulesPref, writeRulesPref } from "./rules.mjs";
import {
  openColorPopover,
  updateSwatchAppearance,
} from "./color-picker.mjs";

let rulesPrefObserver = null;

export const buildRulesEditor = (rules) => {
  const container = h("div");
  container.className = "zao-rules-editor";

  const persist = () => writeRulesPref(rules);

  // Forward-declared because some helpers (e.g. renderPill's remove button) need
  // to call render() to redraw the whole table after a mutation. They're defined
  // BEFORE render() in source order, so without this hoisted `let` they couldn't
  // see it. Assigned in the `render = () => { ... }` block further down.
  let render;

  const renderPill = (rule, dIdx) => {
    const pill = h("span");
    pill.className = "zao-pill";

    const text = h("span");
    text.textContent = rule.domains[dIdx];
    pill.appendChild(text);

    const remove = h("button");
    remove.type = "button";
    remove.className = "zao-pill-remove";
    remove.textContent = "×";
    remove.title = "Remove this domain";
    remove.addEventListener("click", () => {
      rule.domains.splice(dIdx, 1);
      persist();
      render();
    });
    pill.appendChild(remove);

    return pill;
  };

  const renderAddPill = (rule) => {
    const addBtn = h("button");
    addBtn.type = "button";
    addBtn.className = "zao-pill-add";
    addBtn.textContent = "+";
    addBtn.title = "Add domain";
    addBtn.addEventListener("click", () => {
      const input = h("input");
      input.type = "text";
      input.className = "zao-pill-input";
      input.placeholder = "host.com or *.host.com";

      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const val = input.value.trim();
        if (val) {
          rule.domains.push(val);
          persist();
        }
        render();
      };
      const cancel = () => {
        if (done) return;
        done = true;
        render();
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
      input.addEventListener("blur", () => setTimeout(commit, 0));

      addBtn.replaceWith(input);
      input.focus();
    });
    return addBtn;
  };

  const renderColorCell = (rule) => {
    const cell = h("div");
    cell.className = "zao-color-cell";

    // Use <div role="button"> — a real <button> picks up chrome-button theming
    // that fights our 22×22 circle sizing.
    const swatch = h("div");
    swatch.className = "zao-swatch";
    swatch.setAttribute("role", "button");
    swatch.setAttribute("tabindex", "0");
    updateSwatchAppearance(swatch, rule.color);
    const open = (e) => {
      e.stopPropagation();
      openColorPopover(rule, swatch, persist);
    };
    swatch.addEventListener("click", open);
    swatch.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); }
    });
    cell.appendChild(swatch);
    return cell;
  };

  const renderRow = (rule, idx) => {
    const row = h("div");
    row.className = "zao-row";

    row.appendChild(renderColorCell(rule));

    const nameInput = h("input");
    nameInput.type = "text";
    nameInput.className = "zao-group-name";
    nameInput.placeholder = "Group name";
    nameInput.value = rule.name || "";
    nameInput.addEventListener("input", () => {
      rule.name = nameInput.value;
      persist();
    });
    row.appendChild(nameInput);

    const domainsEl = h("div");
    domainsEl.className = "zao-domains";
    if (!Array.isArray(rule.domains)) rule.domains = [];
    rule.domains.forEach((_, dIdx) => domainsEl.appendChild(renderPill(rule, dIdx)));
    domainsEl.appendChild(renderAddPill(rule));
    row.appendChild(domainsEl);

    const removeBtn = h("button");
    removeBtn.type = "button";
    removeBtn.className = "zao-remove-row";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove this group";
    removeBtn.addEventListener("click", () => {
      rules.splice(idx, 1);
      persist();
      render();
    });
    row.appendChild(removeBtn);

    return row;
  };

  render = () => {
    container.replaceChildren();

    const header = h("div");
    header.className = "zao-header";
    header.appendChild(h("div")); // color column (no label)
    const c1 = h("div");
    c1.textContent = "Category";
    header.appendChild(c1);
    const c2 = h("div");
    c2.textContent = "Domains";
    header.appendChild(c2);
    header.appendChild(h("div")); // remove column
    container.appendChild(header);

    if (rules.length === 0) {
      const empty = h("div");
      empty.className = "zao-empty";
      empty.textContent = "No groups yet — click \"+ Add group\" to start.";
      container.appendChild(empty);
    } else {
      rules.forEach((rule, idx) => container.appendChild(renderRow(rule, idx)));
    }

    const addRow = h("div");
    addRow.className = "zao-add-row";
    const addRowBtn = h("button");
    addRowBtn.type = "button";
    addRowBtn.className = "zao-add-row-btn";
    addRowBtn.textContent = "+ Add group";
    addRowBtn.addEventListener("click", () => {
      rules.push({ name: "", domains: [] });
      persist();
      render();
    });
    addRow.appendChild(addRowBtn);
    container.appendChild(addRow);
  };

  // Refresh widget state from the pref. Called by both the pref observer and the
  // dialog-open watcher to pick up external changes (e.g. from the TabGrouped hook).
  const refreshFromPref = (reason) => {
    if (!container.isConnected) return;
    const fresh = readRulesPref();
    if (!fresh) return;
    if (JSON.stringify(fresh) === JSON.stringify(rules)) return;
    console.log(`${LOG} widget refresh (${reason}): ${rules.length} → ${fresh.length} rule(s)`);
    rules.length = 0;
    rules.push(...fresh);
    render();
  };

  // Expose the refresh hook on the container as an expando. `prefs-ui.mjs` calls
  // this when the dialog reopens or its `[open]` attribute changes, to pick up
  // any pref edits that happened while the dialog was closed.
  container._zaoRefresh = refreshFromPref;

  // Watch for external changes to the rules pref.
  if (rulesPrefObserver) {
    try { Services.prefs.removeObserver(CONFIG.RULES_PREF, rulesPrefObserver); } catch {}
    rulesPrefObserver = null;
  }
  rulesPrefObserver = {
    observe(_, topic, data) {
      if (topic !== "nsPref:changed" || data !== CONFIG.RULES_PREF) return;
      if (!container.isConnected) {
        try { Services.prefs.removeObserver(CONFIG.RULES_PREF, rulesPrefObserver); } catch {}
        rulesPrefObserver = null;
        return;
      }
      refreshFromPref("pref change");
    },
  };
  try {
    Services.prefs.addObserver(CONFIG.RULES_PREF, rulesPrefObserver);
    console.log(`${LOG} registered rules pref observer for ${CONFIG.RULES_PREF}`);
  } catch (e) {
    console.error(`${LOG} failed to add rules pref observer:`, e);
  }

  render();
  return container;
};

// Standalone Backup & Restore section, injected by prefs-ui.mjs as a sibling
// after the rules editor (not part of the editor card itself). Reads/writes the
// rules pref directly so any open editor refreshes via its own pref observer.
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

export const buildBackupRestoreSection = () => {
  const section = h("div", { class: "zao-backup-section" });

  // Mirror Sine's separator markup *exactly* so styling is shared:
  //   <vbox class="zao-section-header-row">
  //     <hr/>
  //     <label class="separator-label">Backup & Restore</label>
  //   </vbox>
  // Using the same elements/classes means our header inherits every chrome CSS
  // rule Sine applies to its own separators, and there's nothing to maintain
  // in parallel when Sine's styling evolves.
  const headerRow = document.createElementNS(XUL_NS, "vbox");
  headerRow.className = "zao-section-header-row";
  const rule = document.createElementNS("http://www.w3.org/1999/xhtml", "hr");
  headerRow.appendChild(rule);
  const label = document.createElementNS("http://www.w3.org/1999/xhtml", "label");
  label.className = "separator-label";
  label.textContent = "Backup & Restore";
  headerRow.appendChild(label);
  section.appendChild(headerRow);

  const desc = h("div", {
    class: "zao-pref-description",
    text: "Export your rules as JSON for safekeeping, or import a previously-saved file to restore them.",
  });
  section.appendChild(desc);

  const bar = h("div", { class: "zao-backup-row" });

  const exportBtn = h("button", { class: "zao-backup-btn", text: "Export" });
  exportBtn.type = "button";
  exportBtn.title = "Copy current rules as JSON to the clipboard";
  exportBtn.addEventListener("click", () => {
    const current = readRulesPref() || [];
    const json = JSON.stringify(current, null, 2);
    try {
      navigator.clipboard.writeText(json);
      const original = exportBtn.textContent;
      exportBtn.textContent = "Copied!";
      setTimeout(() => { exportBtn.textContent = original; }, 1200);
    } catch (e) {
      console.warn(`${LOG} clipboard write failed; logging JSON to console:`, e);
      console.log(json);
      alert("Couldn't copy. The JSON has been logged to the Browser Console.");
    }
  });
  bar.appendChild(exportBtn);

  const importBtn = h("button", { class: "zao-backup-btn", text: "Import…" });
  importBtn.type = "button";
  importBtn.title = "Replace rules with a JSON file";
  importBtn.addEventListener("click", () => {
    const picker = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    picker.type = "file";
    picker.accept = "application/json,.json";
    picker.style.display = "none";
    picker.addEventListener("change", async () => {
      const file = picker.files?.[0];
      picker.remove();
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error("Top-level must be an array");
        const valid = parsed
          .map((r) => ({
            name: typeof r?.name === "string" ? r.name.trim() : "",
            domains: Array.isArray(r?.domains)
              ? r.domains.map((d) => String(d).trim()).filter(Boolean)
              : [],
            ...(typeof r?.color === "string" ? { color: r.color } : {}),
          }))
          .filter((r) => r.name && r.domains.length);
        if (valid.length === 0) throw new Error("No valid rules found (each needs name + domains)");
        const current = readRulesPref() || [];
        if (!window.confirm(`Replace your ${current.length} current rule(s) with ${valid.length} imported rule(s)?`)) return;
        writeRulesPref(valid);
        console.log(`${LOG} imported ${valid.length} rule(s)`);
      } catch (e) {
        console.error(`${LOG} rules import failed:`, e);
        alert(`Import failed: ${e.message}`);
      }
    });
    document.documentElement.appendChild(picker);
    picker.click();
  });
  bar.appendChild(importBtn);

  section.appendChild(bar);
  return section;
};

// Called from prefs-ui.mjs's teardownSettingsObserver on window unload. The
// observer is registered against the global Services.prefs, which lives in
// the parent process and survives window close — without this explicit
// removal it'd leak one observer + closure (over `container`, `rules`,
// `window`) per open/close cycle of the settings dialog.
export const teardownRulesPrefObserver = () => {
  if (!rulesPrefObserver) return;
  try { Services.prefs.removeObserver(CONFIG.RULES_PREF, rulesPrefObserver); } catch {}
  rulesPrefObserver = null;
};
