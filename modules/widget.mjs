// Zen Tab Wand — rules editor widget. Watches the rules pref so external
// changes (right-click menu, AI grow, Import) refresh the table live.

import { CONFIG, LOG, h } from "./config.mjs";
import {
  readRulesPref,
  sanitizeRules,
  writeRulesPref,
  readSkipDomainsPref,
  writeSkipDomainsPref,
  getOrderedMatches,
} from "./rules.mjs";
import {
  openColorPopover,
  updateSwatchAppearance,
} from "./color-picker.mjs";
import {
  openEmojiPopover,
  updateIconButtonAppearance,
} from "./emoji-picker.mjs";
import { syncAllGroupColors } from "./groups.mjs";
import {
  dataUrlToIconDataUrl,
  fileToIconDataUrl,
  makeCustomIcon,
  readCustomIconsPref,
  writeCustomIconsPref,
} from "./custom-icons.mjs";

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

  // Hoisted: helpers defined above render() (e.g. renderPill's remove button)
  // still need to call it after mutating.
  let render;

  const ensureRuleLists = (rule) => {
    if (!Array.isArray(rule.domains)) rule.domains = [];
    if (!Array.isArray(rule.titleTerms)) rule.titleTerms = [];
  };

  const renderPill = (rule, key, idx) => {
    const pill = h("span");
    const isTitle = key === "titleTerms";
    const type = isTitle ? "title" : "domain";
    const value = rule[key][idx];
    pill.className = `zao-pill ${isTitle ? "zao-title-pill" : "zao-domain-pill"}`;

    // Tagged by (type, value), not idx — render() rebuilds the DOM on every mutation.
    pill.setAttribute("draggable", "true");
    pill.dataset.zaoType = type;
    pill.dataset.zaoValue = value;
    pill.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/zao-pill", "1"); // presence-only marker
      pillDragRule = rule;
      pillDragType = type;
      pillDragValue = value;
      pill.classList.add("zao-pill-dragging");
    });
    pill.addEventListener("dragend", () => {
      pill.classList.remove("zao-pill-dragging");
      clearPillDropIndicators();
      resetPillDragState();
    });

    const kind = h("span");
    kind.className = "zao-pill-kind";
    kind.textContent = isTitle ? "T" : "@";
    kind.title = isTitle ? "Title match" : "Domain match";
    pill.appendChild(kind);

    const text = h("span");
    text.textContent = value;
    pill.appendChild(text);

    const remove = h("button");
    remove.type = "button";
    remove.className = "zao-pill-remove";
    remove.textContent = "×";
    remove.title = isTitle ? "Remove this title match" : "Remove this domain";
    remove.setAttribute("aria-label", remove.title);
    // By the time dragstart fires, e.target already IS the pill, so
    // e.target.closest() can't tell the button was the press point;
    // draggable="false" here stops drag resolution before it reaches the pill.
    remove.setAttribute("draggable", "false");
    remove.addEventListener("mousedown", (e) => e.stopPropagation());
    remove.addEventListener("click", () => {
      rule[key].splice(idx, 1);
      if (Array.isArray(rule.matchOrder)) {
        const mIdx = rule.matchOrder.findIndex((entry) => entry.type === type && entry.value === value);
        if (mIdx !== -1) rule.matchOrder.splice(mIdx, 1);
      }
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
        // Duplicate (type, value) pairs would be indistinguishable to the
        // pill-drag code below, which identifies pills that way.
        const isDuplicate = val && (isTitle
          ? (rule.titleTerms || []).some((t) => t.toLocaleLowerCase() === val.toLocaleLowerCase())
          : (rule.domains || []).includes(val));
        if (val && !isDuplicate) {
          ensureRuleLists(rule);
          rule[key].push(val);
          // matchOrder is lazily created — only synced if already present.
          if (Array.isArray(rule.matchOrder)) {
            rule.matchOrder.push({ type: isTitle ? "title" : "domain", value: val });
          }
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

    // <div role="button">, not <button> — a real button's chrome theming fights the circle sizing.
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

  // Rules array order is match priority (Pass 1 is first-match-wins), so
  // reordering here changes which rule claims an ambiguous domain.
  // `dragToIdx` is the single source of truth for both the drop indicator
  // and the actual move, so what's shown is exactly what gets applied.
  let dragFromIdx = null;
  let dragToIdx = null;

  const clearDropIndicators = () => {
    container.querySelectorAll(".zao-row-drop-before, .zao-row-drop-after")
      .forEach((el) => el.classList.remove("zao-row-drop-before", "zao-row-drop-after"));
  };

  const reorderRules = (fromIdx, toIdx) => {
    if (fromIdx === toIdx || fromIdx === toIdx - 1) return; // no-op moves
    const [moved] = rules.splice(fromIdx, 1);
    // Splicing out an earlier item shifts every later index down by one.
    const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
    rules.splice(adjustedTo, 0, moved);
    persist();
    render();
  };

  // Pill reorder within a rule's Matches cell, same container-listener
  // pattern as the row reorder above. Identifies pills by (rule, type, value)
  // rather than DOM index since render() rebuilds the DOM on every mutation.
  let pillDragRule = null;
  let pillDragType = null;   // "domain" | "title"
  let pillDragValue = null;
  let pillDropType = null;
  let pillDropValue = null;
  let pillDropPos = null;    // "before" | "after"

  const clearPillDropIndicators = () => {
    container.querySelectorAll(".zao-pill-drop-before, .zao-pill-drop-after")
      .forEach((el) => el.classList.remove("zao-pill-drop-before", "zao-pill-drop-after"));
  };

  const resetPillDragState = () => {
    pillDragRule = null;
    pillDragType = null;
    pillDragValue = null;
    pillDropType = null;
    pillDropValue = null;
    pillDropPos = null;
  };

  // The only place that unconditionally sets `rule.matchOrder` — it stays
  // absent until the first pill drag.
  const reorderPill = (rule, srcType, srcValue, targetType, targetValue, pos) => {
    const order = getOrderedMatches(rule);
    const srcIdx = order.findIndex((entry) => entry.type === srcType && entry.value === srcValue);
    if (srcIdx === -1) return;
    const [moved] = order.splice(srcIdx, 1);
    const targetIdx = order.findIndex((entry) => entry.type === targetType && entry.value === targetValue);
    if (targetIdx === -1) {
      order.push(moved); // target vanished mid-drag — append defensively
    } else {
      order.splice(pos === "before" ? targetIdx : targetIdx + 1, 0, moved);
    }
    rule.matchOrder = order;
    persist();
    render();
  };

  const renderRow = (rule, idx) => {
    const row = h("div");
    row.className = "zao-row";
    row.dataset.zaoIdx = String(idx);

    // Only the grip is draggable, so drags can't start from the name/domain inputs.
    const grip = h("div", { class: "zao-row-grip", text: "⋮⋮" });
    grip.title = "Drag to reorder";
    grip.setAttribute("draggable", "true");
    grip.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/zao-rule-idx", String(idx));
      dragFromIdx = idx;
      dragToIdx = null;
      // Use the whole row as the drag image — the grip alone would look detached.
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
    // Tagged with the rule object so pill-drag listeners can reject drops outside this rule by reference equality.
    domainsEl._zaoRule = rule;
    ensureRuleLists(rule);
    // Consumed-index tracking (not indexOf) so duplicate string values don't collapse two pills onto the same index.
    const usedDomainIdx = new Set();
    const usedTitleIdx = new Set();
    for (const { type, value } of getOrderedMatches(rule)) {
      const key = type === "domain" ? "domains" : "titleTerms";
      const usedIdx = type === "domain" ? usedDomainIdx : usedTitleIdx;
      const pillIdx = rule[key].findIndex((v, i) => v === value && !usedIdx.has(i));
      if (pillIdx === -1) continue; // shouldn't happen — getOrderedMatches already drops stale entries
      usedIdx.add(pillIdx);
      domainsEl.appendChild(renderPill(rule, key, pillIdx));
    }
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

  // Listened at the container, not per-row: some browsers don't fire
  // dragover on the source element during its own drag.
  if (!container._zaoContainerDragListenersInstalled) {
    container._zaoContainerDragListenersInstalled = true;
    container.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/zao-rule-idx")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rows = Array.from(container.querySelectorAll(".zao-row"));
      if (rows.length === 0) return;
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

  // Separate flag + MIME type ("text/zao-pill") from the row listeners above,
  // so the two drag features don't interfere. Container-level, not per-
  // domainsEl, since render() rebuilds every domainsEl on each mutation.
  if (!container._zaoContainerPillDragListenersInstalled) {
    container._zaoContainerPillDragListenersInstalled = true;
    container.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/zao-pill")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const domainsEl = e.target.closest(".zao-domains");
      // Reject drop targets outside the dragged pill's own rule.
      if (!domainsEl || domainsEl._zaoRule !== pillDragRule) {
        clearPillDropIndicators();
        pillDropType = pillDropValue = pillDropPos = null;
        return;
      }

      const pills = Array.from(domainsEl.querySelectorAll(".zao-pill"));
      if (pills.length === 0) return;

      // Pills wrap (flex-wrap), so vertical-only comparison (like the row
      // code above) fails — nearest-by-2D-distance handles wrapping instead.
      let nearest = null;
      let nearestDist = Infinity;
      for (const pill of pills) {
        const r = pill.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        const dist = dx * dx + dy * dy;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = { pill, cx };
        }
      }
      if (!nearest) return;

      const targetType = nearest.pill.dataset.zaoType;
      const targetValue = nearest.pill.dataset.zaoValue;
      // Hovering the dragged pill itself has no sensible before/after — show nothing.
      if (targetType === pillDragType && targetValue === pillDragValue) {
        clearPillDropIndicators();
        pillDropType = pillDropValue = pillDropPos = null;
        return;
      }

      const before = e.clientX < nearest.cx;
      const pos = before ? "before" : "after";
      if (pillDropType === targetType && pillDropValue === targetValue && pillDropPos === pos) {
        return; // no DOM update needed
      }
      pillDropType = targetType;
      pillDropValue = targetValue;
      pillDropPos = pos;
      clearPillDropIndicators();
      nearest.pill.classList.toggle("zao-pill-drop-before", before);
      nearest.pill.classList.toggle("zao-pill-drop-after", !before);
    });
    container.addEventListener("drop", (e) => {
      if (!e.dataTransfer.types.includes("text/zao-pill")) return;
      e.preventDefault();
      const rule = pillDragRule;
      const srcType = pillDragType;
      const srcValue = pillDragValue;
      const targetType = pillDropType;
      const targetValue = pillDropValue;
      const pos = pillDropPos;
      clearPillDropIndicators();
      resetPillDragState();
      if (!rule || !targetType || !pos) return;
      if (srcType === targetType && srcValue === targetValue) return; // dropped on itself
      reorderPill(rule, srcType, srcValue, targetType, targetValue, pos);
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

  // keepIncomplete: true so a blank row the user just added survives the
  // read-back round-trip instead of vanishing from the editor.
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

  // Expando: prefs-ui.mjs calls this when the dialog reopens to pick up edits made while it was closed.
  container._zaoRefresh = refreshFromPref;

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

// Skip-domains editor. Hostnames here are excluded from the tidy click and
// parked at the top of the workspace instead of grouped.

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
  const row = h("div", { class: "zao-action-pref" });
  const text = h("div", { class: "zao-action-pref-text" });
  text.appendChild(h("div", {
    class: "zao-action-pref-title",
    text: "Custom Icons — Upload local image icons and manage the custom-only picker list. Recommended 128x128; will resize if different.",
  }));
  const bar = h("div", { class: "zao-action-pref-actions" });
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
        if (file.size > 8 * 1024 * 1024) {
          alert(`${file.name} is too large. Please use an image under 8 MB.`);
          continue;
        }
        try {
          const dataUrl = await fileToIconDataUrl(file);
          icons.push(makeCustomIcon(file, dataUrl));
        } catch (e) {
          console.warn(`${LOG} failed to resize custom icon "${file.name}":`, e);
          alert(`${file.name} could not be imported. Please try another image.`);
        }
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
  row.appendChild(text);
  row.appendChild(bar);
  container.appendChild(row);
  return container;
};

// Export shape: { rules, skipDomains, customIcons }. Import also accepts a
// bare array, treated as rules-only, for backwards compat with v0 exports.
export const buildBackupRestoreSection = () => {
  const section = h("div", { class: "zao-backup-section" });
  const row = h("div", { class: "zao-action-pref zao-backup-actions-row" });
  const bar = h("div", { class: "zao-action-pref-actions" });

  const exportBtn = h("button", { class: "zao-backup-btn", text: "Export" });
  exportBtn.type = "button";
  exportBtn.title = "Download current rules, skip domains, and custom icons as a JSON file";
  exportBtn.addEventListener("click", async () => {
    const payload = {
      // keepIncomplete: true so in-progress rules are included in the backup.
      rules: readRulesPref({ keepIncomplete: true }) || [],
      skipDomains: readSkipDomainsPref() || [],
      customIcons: readCustomIconsPref(),
    };
    const json = JSON.stringify(payload, null, 2);
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\..*$/, "")
      .replace(/^(\d{8})(\d{6})$/, "$1-$2");
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

    // Writes straight to the Downloads folder via Firefox's Downloads API,
    // so it shows up in the downloads panel with no save dialog.
    try {
      const { Downloads } = ChromeUtils.importESModule(
        "resource://gre/modules/Downloads.sys.mjs"
      );
      const downloadsDir = await Downloads.getPreferredDownloadsDirectory();
      const targetPath = PathUtils.join(downloadsDir, filename);
      // Write bytes directly, then register the already-completed file with
      // Firefox's download list (simpler than Downloads.createDownload's async start()).
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
        // Non-fatal — file is already saved, it just won't appear in the downloads panel.
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
  importBtn.title = "Replace rules, skip domains, and custom icons from a JSON file";
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
          throw new Error("Top-level must be an array or { rules, skipDomains, customIcons } object");
        }
        if (!importedRules && !importedSkip && !importedIcons) throw new Error("Nothing to import (no rules, skipDomains, or customIcons found)");

        let validRules = null;
        if (importedRules) {
          validRules = sanitizeRules(importedRules);
          if (validRules.length === 0 && !importedSkip && !importedIcons) {
            throw new Error("No valid rules in import (each needs a name plus domains or title matches)");
          }
        }

        let validSkip = null;
        if (importedSkip) {
          validSkip = importedSkip.map((d) => String(d).trim()).filter(Boolean);
        }
        const validIcons = importedIcons
          ? (await Promise.all(importedIcons.map(async (icon) => {
            const dataUrl = typeof icon?.dataUrl === "string" ? icon.dataUrl.trim() : "";
            if (!dataUrl.startsWith("data:image/")) return null;
            return {
              id: typeof icon?.id === "string" ? icon.id.trim() : "",
              name: typeof icon?.name === "string" ? icon.name.trim() : "",
              dataUrl: await dataUrlToIconDataUrl(dataUrl),
            };
          }))).filter((icon) => icon?.id.startsWith("custom:"))
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
          // keepIncomplete to match what the editor shows, not the filtered wand-click count.
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

  row.appendChild(bar);
  section.appendChild(row);
  return section;
};

// Services.prefs lives in the parent process and survives window close, so
// without this the observer (and its closure) leaks on every dialog reopen.
export const teardownRulesPrefObserver = () => {
  if (!rulesPrefObserver) return;
  try { Services.prefs.removeObserver(CONFIG.RULES_PREF, rulesPrefObserver); } catch {}
  rulesPrefObserver = null;
};
