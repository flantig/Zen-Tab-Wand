// Zen Tab Wand — settings rules editor widget.
// Builds the pill table (Category | Domains) with +/- buttons, color swatch per row,
// hex input, and live persistence to the rules pref. Also wires a pref observer so
// external changes (right-click "Add to Rule…" submenu, AI Pass 2, Import) refresh the table in real time.

import { CONFIG, LOG, h } from "./config.mjs";
import { readRulesPref, writeRulesPref, readSkipDomainsPref, writeSkipDomainsPref } from "./rules.mjs";
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
  // dialog-open watcher to pick up external changes (e.g. via the tab right-click submenu, AI Pass 2 grow, or Backup Import).
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
// ──────────────────────────────────────────────────────────────────────────────
// Skip-domains editor — simple pill list. Hostnames in this list never get
// touched by the tidy click; they're ejected from any group and parked at the
// top of the workspace before Pass 1 runs (see click-handler.mjs).
// ──────────────────────────────────────────────────────────────────────────────

let skipPrefObserver = null;

export const buildSkipDomainsEditor = () => {
  const initial = readSkipDomainsPref();
  const domains = Array.isArray(initial) ? [...initial] : [];
  const container = h("div", { class: "zao-skip-editor" });
  const persist = () => writeSkipDomainsPref(domains);

  let render;

  const renderPill = (idx) => {
    const pill = h("span", { class: "zao-pill" });
    const text = h("span", { text: domains[idx] });
    pill.appendChild(text);
    const remove = h("button", { class: "zao-pill-remove", text: "×" });
    remove.type = "button";
    remove.title = "Remove from skip list";
    remove.addEventListener("click", () => {
      domains.splice(idx, 1);
      persist();
      render();
    });
    pill.appendChild(remove);
    return pill;
  };

  const renderAddPill = () => {
    const addBtn = h("button", { class: "zao-pill-add", text: "+" });
    addBtn.type = "button";
    addBtn.title = "Add a domain to skip";
    addBtn.addEventListener("click", () => {
      const input = h("input", { class: "zao-pill-input" });
      input.type = "text";
      input.placeholder = "host.com or *.host.com";

      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const val = input.value.trim();
        if (val && !domains.includes(val)) {
          domains.push(val);
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

  render = () => {
    container.replaceChildren();
    const row = h("div", { class: "zao-skip-row" });
    if (domains.length === 0) {
      const empty = h("span", {
        class: "zao-skip-empty",
        text: "No domains skipped — add hostnames you never want the tidy click to touch.",
      });
      row.appendChild(empty);
    } else {
      domains.forEach((_, idx) => row.appendChild(renderPill(idx)));
    }
    row.appendChild(renderAddPill());
    container.appendChild(row);
  };

  // Refresh on external writes (e.g. Import overwriting the pref).
  const refreshFromPref = () => {
    if (!container.isConnected) return;
    const fresh = readSkipDomainsPref();
    if (JSON.stringify(fresh) === JSON.stringify(domains)) return;
    domains.length = 0;
    domains.push(...fresh);
    render();
  };
  container._zaoSkipRefresh = refreshFromPref;

  if (skipPrefObserver) {
    try { Services.prefs.removeObserver(CONFIG.SKIP_DOMAINS_PREF, skipPrefObserver); } catch {}
    skipPrefObserver = null;
  }
  skipPrefObserver = {
    observe(_, topic, data) {
      if (topic !== "nsPref:changed" || data !== CONFIG.SKIP_DOMAINS_PREF) return;
      if (!container.isConnected) {
        try { Services.prefs.removeObserver(CONFIG.SKIP_DOMAINS_PREF, skipPrefObserver); } catch {}
        skipPrefObserver = null;
        return;
      }
      refreshFromPref();
    },
  };
  try { Services.prefs.addObserver(CONFIG.SKIP_DOMAINS_PREF, skipPrefObserver); } catch {}

  render();
  return container;
};

export const teardownSkipPrefObserver = () => {
  if (!skipPrefObserver) return;
  try { Services.prefs.removeObserver(CONFIG.SKIP_DOMAINS_PREF, skipPrefObserver); } catch {}
  skipPrefObserver = null;
};

// ──────────────────────────────────────────────────────────────────────────────
// Backup & Restore — just the Export / Import buttons. The section header and
// description come from Sine's native separator (declared in preferences.json)
// and our SECTION_DESCRIPTIONS list (injected by prefs-ui.mjs).
//
// Export shape (v1):  { "rules": [...], "skipDomains": [...] }
// Import accepts:
//   • that object shape (overwrites both prefs)
//   • a bare array (treated as rules-only, for backwards compat with v0 exports)
// ──────────────────────────────────────────────────────────────────────────────
export const buildBackupRestoreSection = () => {
  const section = h("div", { class: "zao-backup-section" });
  const bar = h("div", { class: "zao-backup-row" });

  const exportBtn = h("button", { class: "zao-backup-btn", text: "Export" });
  exportBtn.type = "button";
  exportBtn.title = "Download current rules + skip-domains as a JSON file";
  exportBtn.addEventListener("click", async () => {
    const payload = {
      rules: readRulesPref() || [],
      skipDomains: readSkipDomainsPref() || [],
    };
    const json = JSON.stringify(payload, null, 2);
    // Filename: wand-backup-<N>groups-YYYYMMDD-HHmmss.json — encodes which
    // mod produced it, how many rules were saved, and exact-second timestamp.
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\..*$/, "")
      .replace(/^(\d{8})(\d{6})$/, "$1-$2"); // 20260519-223045
    const filename = `wand-backup-${payload.rules.length}groups-${ts}.json`;

    const finish = (label) => {
      const original = exportBtn.textContent;
      exportBtn.textContent = label;
      setTimeout(() => { exportBtn.textContent = original; }, 1500);
    };
    const fallbackToClipboard = () => {
      try {
        navigator.clipboard.writeText(json);
        finish("Copied!");
      } catch (e) {
        console.error(`${LOG} clipboard fallback failed:`, e);
        console.log(json);
        alert("Couldn't save or copy. The JSON has been logged to the Browser Console.");
      }
    };

    // Direct download into the user's default Downloads folder. Uses
    // Firefox's Downloads API so the saved file also shows up in the browser's
    // downloads panel (Ctrl+Shift+J) like any other download, with no save
    // dialog interrupting the flow.
    try {
      const { Downloads } = ChromeUtils.importESModule(
        "resource://gre/modules/Downloads.sys.mjs"
      );
      const downloadsDir = await Downloads.getPreferredDownloadsDirectory();
      const targetPath = PathUtils.join(downloadsDir, filename);
      // Write the bytes directly — simpler and more reliable than the
      // Downloads.createDownload route, which needs a source URI that survives
      // the async start() call. We then register the completed file with
      // Firefox's download list so it appears in the downloads panel.
      await IOUtils.writeUTF8(targetPath, json);
      try {
        const list = await Downloads.getList(Downloads.PUBLIC);
        const download = await Downloads.createDownload({
          source: { url: "data:application/json,zen-tab-wand-export" },
          target: { path: targetPath },
        });
        download.succeeded = true;
        download.stopped = true;
        download.canceled = false;
        download.error = null;
        download.progress = 100;
        download.hasProgress = true;
        download.totalBytes = json.length;
        download.currentBytes = json.length;
        await list.add(download);
      } catch (e) {
        // Non-fatal — the file is already saved. The downloads panel just
        // won't have a record. Most users won't notice.
        console.warn(`${LOG} could not register download with Firefox's download list:`, e);
      }
      console.log(`${LOG} exported ${payload.rules.length} rule(s) + ${payload.skipDomains.length} skip-domain(s) → ${targetPath}`);
      finish("Downloaded!");
    } catch (e) {
      console.error(`${LOG} export failed:`, e);
      fallbackToClipboard();
    }
  });
  bar.appendChild(exportBtn);

  const importBtn = h("button", { class: "zao-backup-btn", text: "Import…" });
  importBtn.type = "button";
  importBtn.title = "Replace rules + skip-domains from a JSON file";
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
        let importedRules = null;
        let importedSkip = null;
        if (Array.isArray(parsed)) {
          // Legacy v0 format — array of rules only.
          importedRules = parsed;
        } else if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed.rules)) importedRules = parsed.rules;
          if (Array.isArray(parsed.skipDomains)) importedSkip = parsed.skipDomains;
        } else {
          throw new Error("Top-level must be an array or { rules, skipDomains } object");
        }
        if (!importedRules && !importedSkip) throw new Error("Nothing to import (no rules or skipDomains found)");

        let validRules = null;
        if (importedRules) {
          validRules = importedRules
            .map((r) => ({
              name: typeof r?.name === "string" ? r.name.trim() : "",
              domains: Array.isArray(r?.domains)
                ? r.domains.map((d) => String(d).trim()).filter(Boolean)
                : [],
              ...(typeof r?.color === "string" ? { color: r.color } : {}),
            }))
            .filter((r) => r.name && r.domains.length);
          if (validRules.length === 0 && !importedSkip) {
            throw new Error("No valid rules in import (each needs name + domains)");
          }
        }

        let validSkip = null;
        if (importedSkip) {
          validSkip = importedSkip.map((d) => String(d).trim()).filter(Boolean);
        }

        const current = {
          rules: (readRulesPref() || []).length,
          skip: (readSkipDomainsPref() || []).length,
        };
        const summaryLines = [];
        if (validRules) summaryLines.push(`Rules:  ${current.rules} → ${validRules.length}`);
        if (validSkip) summaryLines.push(`Skip:   ${current.skip} → ${validSkip.length}`);
        if (!window.confirm(`Replace your settings?\n\n${summaryLines.join("\n")}`)) return;
        if (validRules) writeRulesPref(validRules);
        if (validSkip) writeSkipDomainsPref(validSkip);
        console.log(`${LOG} imported${validRules ? ` ${validRules.length} rule(s)` : ""}${validSkip ? ` ${validSkip.length} skip-domain(s)` : ""}`);
      } catch (e) {
        console.error(`${LOG} import failed:`, e);
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
