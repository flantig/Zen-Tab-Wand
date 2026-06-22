// Zen Tab Wand — color picker UI used inside the settings widget rows.
// Includes the swatch, the popover with 9 Zen presets + a hex input, and a runtime
// fetch of Zen's actual rendered palette so swatches match the live theme.

import {
  CONFIG,
  LOG,
  PRESET_COLORS,
  HEX_BY_NAME,
  h,
  bgForName,
  isZenColorName,
  isValidHex,
} from "./config.mjs";

// Zen's --tab-group-color-* CSS vars are defined in tabs.css which only loads in
// browser.xhtml, not in about:preferences. Reach into the main browser window and
// ask it to compute each color (using the same light-dark expression Zen uses to
// render a group label background), then update HEX_BY_NAME so picker swatches match
// the live theme.
export const fetchZenColorsFromBrowser = () => {
  try {
    const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
    if (!browserWin?.document?.documentElement) return;
    const browserDoc = browserWin.document;
    for (const { name } of PRESET_COLORS) {
      const probe = browserDoc.createElement("div");
      probe.style.cssText = `background: light-dark(var(--tab-group-color-${name}), var(--tab-group-color-${name}-invert)); display: none;`;
      browserDoc.documentElement.appendChild(probe);
      const computed = browserWin.getComputedStyle(probe).backgroundColor;
      probe.remove();
      // Filter the sentinel values getComputedStyle returns when a var() reference
      // doesn't resolve: pure black / fully transparent. (Zen's palette never
      // includes either, so this is a safe heuristic for "var was undefined".)
      if (computed && computed !== "rgb(0, 0, 0)" && computed !== "rgba(0, 0, 0, 0)") {
        HEX_BY_NAME.set(name, computed);
      }
    }
    console.log(`${LOG} fetched Zen tab-group palette (theme-rendered) from browser window`);
  } catch (e) {
    console.warn(`${LOG} fetchZenColorsFromBrowser failed:`, e);
  }
};

const swatchBackground = (color) => {
  if (color && isZenColorName(color)) {
    return bgForName(color);
  }
  if (color && isValidHex(color)) return color;
  return "";
};

export const updateSwatchAppearance = (swatch, color, color2) => {
  const bg1 = swatchBackground(color);
  const bg2 = swatchBackground(color2);
  if (!bg1 && !bg2) {
    swatch.style.background = "";
    swatch.classList.add("zao-swatch-empty");
    swatch.title = "Click to pick a color";
    return;
  }
  swatch.classList.remove("zao-swatch-empty");
  swatch.style.background = bg1 && bg2 ? `linear-gradient(90deg, ${bg1}, ${bg2})` : (bg1 || bg2);
  swatch.title = bg1 && bg2 ? `Gradient: ${color} to ${color2}` : `Color: ${color || color2}`;
};

// Open the color popover anchored above the given swatch element.
// `onChange` is called whenever the rule's color is mutated (so the caller can persist).
export const openColorPopover = (rule, swatch, onChange) => {
  document.querySelectorAll(".zao-color-popover").forEach((p) => p.remove());

  const pop = h("div");
  pop.className = "zao-color-popover";

  const presets = h("div");
  presets.className = "zao-presets";

  let hexInput; // declared up here so preset clicks can mirror the primary color

  for (const { name } of PRESET_COLORS) {
    const dot = h("div");
    dot.className = "zao-preset";
    dot.setAttribute("role", "button");
    dot.setAttribute("tabindex", "0");
    dot.dataset.zaoColor = name;
    dot.style.background = bgForName(name);
    if (rule.color === name) dot.classList.add("zao-preset-active");
    dot.title = name;
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      rule.color = name;
      onChange();
      updateSwatchAppearance(swatch, name, rule.color2);
      presets.querySelectorAll(".zao-preset").forEach((p) =>
        p.classList.toggle("zao-preset-active", p.dataset.zaoColor === name)
      );
      if (hexInput) hexInput.value = name;
    });
    presets.appendChild(dot);
  }
  pop.appendChild(presets);

  const fields = h("div", { class: "zao-color-fields" });
  const makeHexInput = (key, placeholder) => {
    const input = h("input");
    input.type = "text";
    input.className = "zao-color-hex";
    input.placeholder = placeholder;
    input.value = rule[key] || "";
    input.spellcheck = false;
    input.addEventListener("input", () => {
      const v = input.value.trim();
      if (v === "") {
        delete rule[key];
        onChange();
        updateSwatchAppearance(swatch, rule.color, rule.color2);
      } else if (isValidHex(v) || isZenColorName(v)) {
        rule[key] = v;
        onChange();
        updateSwatchAppearance(swatch, rule.color, rule.color2);
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        pop.remove();
        cleanup();
      }
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    return input;
  };
  hexInput = makeHexInput("color", "#start or name");
  fields.appendChild(hexInput);
  fields.appendChild(makeHexInput("color2", "#end or name"));
  pop.appendChild(fields);

  // Append INSIDE the dialog (not document.body) so the popover shares the
  // top-layer that .showModal() creates. Anything outside the dialog gets hidden
  // by the modal backdrop.
  const dialog = swatch.closest(".sineItemPreferenceDialog") || document.body;
  dialog.appendChild(pop);

  // Position above the swatch (fixed coords, relative to viewport).
  // Reading popRect right after appendChild works because layout has already run;
  // the popover starts off-screen at (0,0) until we set top/left below.
  const r = swatch.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const gap = CONFIG.POPOVER_GAP_PX;
  pop.style.left = `${Math.max(gap, r.left)}px`;
  const aboveTop = r.top - popRect.height - gap;
  pop.style.top = `${aboveTop >= gap ? aboveTop : r.bottom + gap}px`;

  const closeIfOutside = (e) => {
    if (!pop.contains(e.target) && e.target !== swatch) {
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
