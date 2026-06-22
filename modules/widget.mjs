// Zen Tab Wand — settings rules editor widget.
// Builds the pill table (Category | Matches) with +/- buttons, color/icon controls per row,
// hex input, and live persistence to the rules pref. Also wires a pref observer so
// external changes (right-click "Add to Rule…" submenu, AI Pass 2, Import) refresh the table in real time.

import { CONFIG, LOG, h } from "./config.mjs";
import { readRulesPref, writeRulesPref, readSkipDomainsPref, writeSkipDomainsPref } from "./rules.mjs";
import {
  openColorPopover,
  updateSwatchAppearance,
} from "./color-picker.mjs";
import {
  openEmojiPopover,
  updateIconButtonAppearance,
} from "./emoji-picker.mjs";
import { syncAllGroupColors } from "./groups.mjs";
import { makeCustomIcon, readCustomIconsPref, writeCustomIconsPref } from "./custom-icons.mjs";

let rulesPrefObserver = null;

export const syncLiveGroupAppearances = (rules) => {
  try {
    const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
    const browserDoc = browserWin?.document;
    if (!browserDoc) return;
    syncAllGroupColors(null, rules, browserDoc);
  } catch (e) {
    console.warn(`${LOG} live group appearance sync failed:`, e);
  }
};

export const buildRulesEditor = (rules) => {
  const container = h("div");
  container.className = "zao-rules-editor";

  const persist = () => {
    writeRulesPref(rules);
    syncLiveGroupAppearances(rules);
  };

  // Forward-declared because some helpers (e.g. renderPill's remove button) need
  // to call render() to redraw the whole table after a mutation. They're defined
  // BEFORE render() in source order, so without this hoisted `let` they couldn't
  // see it. Assigned in the `render = () => { ... }` block further down.
  let render;

  const ensureRuleLists = (rule) => {
    if (!Array.isArray(rule.domains)) rule.domains = [];
    if (!Array.isArray(rule.titleTerms)) rule.titleTerms = [];
  };

  const renderPill = (rule, key, idx) => {
    const pill = h("span");
    const isTitle = key === "titleTerms";
    pill.className = `zao-pill ${isTitle ? "zao-title-pill" : "zao-domain-pill"}`;

    const kind = h("span");
    kind.className = "zao-pill-kind";
    kind.textContent = isTitle ? "T" : "@";
    kind.title = isTitle ? "Title match" : "Domain match";
    pill.appendChild(kind);

    const text = h("span");
    text.textContent = rule[key][idx];
    pill.appendChild(text);

    const remove = h("button");
    remove.type = "button";
    remove.className = "zao-pill-remove";
    remove.textContent = "×";
    remove.title = isTitle ? "Remove this title match" : "Remove this domain";
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => {
      rule[key].splice(idx, 1);
      persist();
      render();
    });
    pill.appendChild(remove);

    return pill;
  };

  const renderAddPill = (rule, key) => {
    const isTitle = key === "titleTerms";
    const addBtn = h("button");
    addBtn.type = "button";
    addBtn.className = `zao-pill-add ${isTitle ? "zao-title-add" : "zao-domain-add"}`;
    addBtn.textContent = isTitle ? "+T" : "+@";
    addBtn.title = isTitle ? "Add title match" : "Add domain";
    addBtn.setAttribute("aria-label", addBtn.title);
    addBtn.addEventListener("click", () => {
      const input = h("input");
      input.type = "text";
      input.className = "zao-pill-input";
      input.placeholder = isTitle ? "title contains..." : "host.com or *.host.com";

      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const val = input.value.trim();
        if (val) {
          ensureRuleLists(rule);
          rule[key].push(val);
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
    updateSwatchAppearance(swatch, rule.color, rule.color2);
    const open = (e) => {
      e.stopPropagation();
      openColorPopover(rule, swatch, persist);
    };
    swatch.addEventListener("click", open);
    swatch.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); }
    });
    cell.appendChild(swatch);

    const icon = h("button");
    icon.type = "button";
    icon.className = "zao-icon-button";
    updateIconButtonAppearance(icon, rule.icon);
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      openEmojiPopover(rule, icon, persist);
    });
    cell.appendChild(icon);
    return cell;
  };

  // Drag-and-drop reorder. Pass 1 is first-match-wins, so the rules array
  // order determines which group a domain lands in when multiple rules could
  // claim it. Reordering here changes that priority AND the sidebar's group
  // display order on next wand click.
  //
  // Drag state lives at the editor scope so all rows share it. The DOM
  // indicator and the actual reorder target both read from `dragToIdx`, so
  // what the user SEES is exactly what gets applied on drop — no recompute
  // from clientY at drop-time (which would disagree if the cursor jittered
  // in the moment between the final dragover and the mouseup).
  let dragFromIdx = null;
  let dragToIdx = null;

  const clearDropIndicators = () => {
    container.querySelectorAll(".zao-row-drop-before, .zao-row-drop-after")
      .forEach((el) => el.classList.remove("zao-row-drop-before", "zao-row-drop-after"));
  };

  const reorderRules = (fromIdx, toIdx) => {
    if (fromIdx === toIdx || fromIdx === toIdx - 1) return; // no-op moves
    const [moved] = rules.splice(fromIdx, 1);
    // Adjust toIdx down by one if we removed an item earlier in the list.
    const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
    rules.splice(adjustedTo, 0, moved);
    persist();
    render();
  };

  const renderRow = (rule, idx) => {
    const row = h("div");
    row.className = "zao-row";
    row.dataset.zaoIdx = String(idx);

    // Drag-handle grip. Only this element is `draggable`, so the user must
    // grab it explicitly — accidental drags from the name/domain inputs are
    // impossible. Visual: a six-dot "⋮⋮" glyph.
    const grip = h("div", { class: "zao-row-grip", text: "⋮⋮" });
    grip.title = "Drag to reorder";
    grip.setAttribute("draggable", "true");
    grip.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/zao-rule-idx", String(idx));
      dragFromIdx = idx;
      dragToIdx = null;
      // Drag the whole row visually (DataTransfer.setDragImage uses an
      // element + offset). The grip alone would look strange detached.
      try { e.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2); } catch {}
      row.classList.add("zao-row-dragging");
    });
    grip.addEventListener("dragend", () => {
      row.classList.remove("zao-row-dragging");
      clearDropIndicators();
      dragFromIdx = null;
      dragToIdx = null;
    });
    row.appendChild(grip);

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
    ensureRuleLists(rule);
    rule.domains.forEach((_, dIdx) => domainsEl.appendChild(renderPill(rule, "domains", dIdx)));
    rule.titleTerms.forEach((_, tIdx) => domainsEl.appendChild(renderPill(rule, "titleTerms", tIdx)));
    domainsEl.appendChild(renderAddPill(rule, "domains"));
    domainsEl.appendChild(renderAddPill(rule, "titleTerms"));
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

  // Container-level dragover/drop. Some browsers don't fire dragover on the
  // source element during a drag, so per-row listeners miss events when the
  // cursor is still over the row being dragged. Listening at the container
  // covers all rows uniformly — we hit-test the cursor's clientY against
  // each row's bounding rect to figure out where the drop would land.
  if (!container._zaoContainerDragListenersInstalled) {
    container._zaoContainerDragListenersInstalled = true;
    container.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/zao-rule-idx")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rows = Array.from(container.querySelectorAll(".zao-row"));
      if (rows.length === 0) return;
      // Find the row whose vertical range contains the cursor. If the cursor
      // is above the first row, target index 0 / top half. If below the last
      // row, target the last row's bottom half.
      let targetRow = null;
      let targetIdx = -1;
      let above = true;
      const firstRect = rows[0].getBoundingClientRect();
      const lastRect = rows[rows.length - 1].getBoundingClientRect();
      if (e.clientY < firstRect.top) {
        targetRow = rows[0];
        targetIdx = 0;
        above = true;
      } else if (e.clientY > lastRect.bottom) {
        targetRow = rows[rows.length - 1];
        targetIdx = rows.length - 1;
        above = false;
      } else {
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i].getBoundingClientRect();
          if (e.clientY >= r.top && e.clientY <= r.bottom) {
            targetRow = rows[i];
            targetIdx = i;
            above = (e.clientY - r.top) < r.height / 2;
            break;
          }
        }
      }
      if (!targetRow) return;
      const newToIdx = above ? targetIdx : targetIdx + 1;
      if (dragToIdx === newToIdx) return; // no DOM update needed
      dragToIdx = newToIdx;
      clearDropIndicators();
      targetRow.classList.toggle("zao-row-drop-before", above);
      targetRow.classList.toggle("zao-row-drop-after", !above);
    });
    container.addEventListener("drop", (e) => {
      const fromStr = e.dataTransfer.getData("text/zao-rule-idx");
      if (!fromStr) return;
      e.preventDefault();
      const fromIdx = parseInt(fromStr, 10);
      const toIdx = dragToIdx;
      clearDropIndicators();
      dragFromIdx = null;
      dragToIdx = null;
      if (toIdx === null) return;
      reorderRules(fromIdx, toIdx);
    });
  }

  render = () => {
    container.replaceChildren();

    const header = h("div");
    header.className = "zao-header";
    header.appendChild(h("div")); // grip column (no label)
    header.appendChild(h("div")); // color/icon column (no label)
    const c1 = h("div");
    c1.textContent = "Category";
    header.appendChild(c1);
    const c2 = h("div");
    c2.textContent = "Matches";
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
      rules.push({ name: "", domains: [], titleTerms: [] });
      persist();
      render();
    });
    addRow.appendChild(addRowBtn);
    container.appendChild(addRow);
  };

  // Refresh widget state from the pref. Called by both the pref observer and
  // the dialog-open watcher to pick up external changes (e.g. via the tab
  // right-click submenu, AI Pass 2 grow, or Backup Import). Passes
  // `keepIncomplete: true` so a blank row the user just added (and which
  // persists to disk as `{name:"", domains:[]}`) survives the round-trip
  // and continues to appear in the editor across browser restarts.
  const refreshFromPref = (reason) => {
    if (!container.isConnected) return;
    const fresh = readRulesPref({ keepIncomplete: true });
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

export const buildCustomIconsEditor = () => {
  let icons = readCustomIconsPref();
  const container = h("div", { class: "zao-custom-icons-editor" });
  const bar = h("div", { class: "zao-custom-icons-bar" });
  const upload = h("button", { class: "zao-backup-btn", text: "Upload icons..." });
  upload.type = "button";
  const manage = h("button", { class: "zao-backup-btn", text: "Manage icons" });
  manage.type = "button";

  const persistIcons = () => writeCustomIconsPref(icons);
  const clearDeletedIconFromRules = (id) => {
    const rules = readRulesPref({ keepIncomplete: true }) || [];
    let changed = false;
    for (const rule of rules) {
      if (rule.icon === id) {
        delete rule.icon;
        changed = true;
      }
    }
    if (changed) {
      writeRulesPref(rules);
      syncLiveGroupAppearances(rules);
    }
  };

  const renderPopoverGrid = (grid) => {
    grid.replaceChildren();
    for (const icon of icons) {
      const btn = h("button", { class: "zao-custom-icon-choice" });
      btn.type = "button";
      btn.title = `Remove ${icon.name}`;
      btn.setAttribute("aria-label", `Remove ${icon.name}`);
      const img = h("img", { class: "zao-emoji-img" });
      img.src = icon.dataUrl;
      img.alt = "";
      btn.appendChild(img);
      btn.addEventListener("click", () => {
        icons = icons.filter((item) => item.id !== icon.id);
        persistIcons();
        clearDeletedIconFromRules(icon.id);
        renderPopoverGrid(grid);
      });
      grid.appendChild(btn);
    }
    if (!icons.length) {
      grid.appendChild(h("div", { class: "zao-custom-icons-empty", text: "No custom icons" }));
    }
  };

  const openManager = (anchor) => {
    document.querySelectorAll(".zao-custom-icons-popover").forEach((p) => p.remove());
    const pop = h("div", { class: "zao-custom-icons-popover" });
    const grid = h("div", { class: "zao-custom-icons-grid" });
    pop.appendChild(grid);
    renderPopoverGrid(grid);

    const dialog = anchor.closest(".sineItemPreferenceDialog") || document.body;
    dialog.appendChild(pop);

    const r = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const gap = CONFIG.POPOVER_GAP_PX;
    const maxLeft = Math.max(gap, window.innerWidth - popRect.width - gap);
    pop.style.left = `${Math.min(Math.max(gap, r.left), maxLeft)}px`;
    const aboveTop = r.top - popRect.height - gap;
    pop.style.top = `${aboveTop >= gap ? aboveTop : r.bottom + gap}px`;

    const closeIfOutside = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor) {
        pop.remove();
        cleanup();
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        pop.remove();
        cleanup();
      }
    };
    const cleanup = () => {
      document.removeEventListener("mousedown", closeIfOutside, true);
      document.removeEventListener("keydown", onKey, true);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", closeIfOutside, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
  };

  upload.addEventListener("click", () => {
    const picker = h("input");
    picker.type = "file";
    picker.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    picker.multiple = true;
    picker.addEventListener("change", async () => {
      const files = Array.from(picker.files || []);
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        if (file.size > 256 * 1024) {
          alert(`${file.name} is too large. Please use an icon under 256 KB.`);
          continue;
        }
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error || new Error("Read failed"));
          reader.readAsDataURL(file);
        });
        icons.push(makeCustomIcon(file, dataUrl));
      }
      persistIcons();
      picker.remove();
    });
    document.documentElement.appendChild(picker);
    picker.click();
  });
  manage.addEventListener("click", (e) => {
    e.stopPropagation();
    icons = readCustomIconsPref();
    openManager(manage);
  });

  bar.appendChild(upload);
  bar.appendChild(manage);
  container.appendChild(bar);
  return container;
};

// ──────────────────────────────────────────────────────────────────────────────
// Backup & Restore — just the Export / Import buttons. The section header and
// description come from Sine's native separator (declared in preferences.json)
// and our SECTION_DESCRIPTIONS list (injected by prefs-ui.mjs).
//
// Export shape (v1):  { "rules": [...], "skipDomains": [...], "customIcons": [...] }
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
      // keepIncomplete: true so a user's in-progress rules are included in
      // the backup — otherwise restoring would silently drop them.
      rules: readRulesPref({ keepIncomplete: true }) || [],
      skipDomains: readSkipDomainsPref() || [],
      customIcons: readCustomIconsPref(),
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
        let importedIcons = null;
        if (Array.isArray(parsed)) {
          // Legacy v0 format — array of rules only.
          importedRules = parsed;
        } else if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed.rules)) importedRules = parsed.rules;
          if (Array.isArray(parsed.skipDomains)) importedSkip = parsed.skipDomains;
          if (Array.isArray(parsed.customIcons)) importedIcons = parsed.customIcons;
        } else {
          throw new Error("Top-level must be an array or { rules, skipDomains } object");
        }
        if (!importedRules && !importedSkip && !importedIcons) throw new Error("Nothing to import (no rules, skipDomains, or customIcons found)");

        let validRules = null;
        if (importedRules) {
          validRules = importedRules
            .map((r) => ({
              name: typeof r?.name === "string" ? r.name.trim() : "",
              domains: Array.isArray(r?.domains)
                ? r.domains.map((d) => String(d).trim()).filter(Boolean)
                : [],
              titleTerms: Array.isArray(r?.titleTerms)
                ? r.titleTerms.map((d) => String(d).trim()).filter(Boolean)
                : [],
              ...(typeof r?.color === "string" ? { color: r.color } : {}),
              ...(typeof r?.color2 === "string" ? { color2: r.color2 } : {}),
              ...(typeof r?.icon === "string" ? { icon: r.icon } : {}),
            }))
            .filter((r) => r.name && (r.domains.length || r.titleTerms.length));
          if (validRules.length === 0 && !importedSkip) {
            throw new Error("No valid rules in import (each needs a name plus domains or title matches)");
          }
        }

        let validSkip = null;
        if (importedSkip) {
          validSkip = importedSkip.map((d) => String(d).trim()).filter(Boolean);
        }
        const validIcons = importedIcons
          ? importedIcons
            .map((icon) => ({
              id: typeof icon?.id === "string" ? icon.id.trim() : "",
              name: typeof icon?.name === "string" ? icon.name.trim() : "",
              dataUrl: typeof icon?.dataUrl === "string" ? icon.dataUrl.trim() : "",
            }))
            .filter((icon) => icon.id.startsWith("custom:") && icon.dataUrl.startsWith("data:image/"))
          : null;
        if (validRules) {
          const iconIds = new Set((validIcons || readCustomIconsPref()).map((icon) => icon.id));
          for (const rule of validRules) {
            if (typeof rule.icon === "string" && rule.icon.startsWith("custom:") && !iconIds.has(rule.icon)) {
              delete rule.icon;
            }
          }
        }

        const current = {
          // Match the widget's view (includes in-progress rules) so the
          // "N → M" confirmation reflects what the user actually sees in
          // the editor, not the filtered wand-click count.
          rules: (readRulesPref({ keepIncomplete: true }) || []).length,
          skip: (readSkipDomainsPref() || []).length,
          icons: readCustomIconsPref().length,
        };
        const summaryLines = [];
        if (validRules) summaryLines.push(`Rules:  ${current.rules} → ${validRules.length}`);
        if (validSkip) summaryLines.push(`Skip:   ${current.skip} → ${validSkip.length}`);
        if (validIcons) summaryLines.push(`Icons:  ${current.icons} → ${validIcons.length}`);
        if (!window.confirm(`Replace your settings?\n\n${summaryLines.join("\n")}`)) return;
        if (validIcons) writeCustomIconsPref(validIcons);
        if (validRules) writeRulesPref(validRules);
        if (validSkip) writeSkipDomainsPref(validSkip);
        if (validRules) syncLiveGroupAppearances(validRules);
        console.log(`${LOG} imported${validRules ? ` ${validRules.length} rule(s)` : ""}${validSkip ? ` ${validSkip.length} skip-domain(s)` : ""}${validIcons ? ` ${validIcons.length} custom icon(s)` : ""}`);
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
