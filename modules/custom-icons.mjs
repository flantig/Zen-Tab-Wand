// Zen Tab Wand — local custom icon library stored in prefs as data URLs.

import { CONFIG, LOG } from "./config.mjs";

const cleanName = (name) =>
  String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40) || "Custom icon";

const cleanIcon = (icon) => {
  if (!icon || typeof icon !== "object") return null;
  const id = typeof icon.id === "string" ? icon.id.trim() : "";
  const name = cleanName(icon.name);
  const dataUrl = typeof icon.dataUrl === "string" ? icon.dataUrl.trim() : "";
  if (!id.startsWith("custom:") || !dataUrl.startsWith("data:image/")) return null;
  return { id, name, dataUrl };
};

export const readCustomIconsPref = () => {
  try {
    const raw = Services.prefs.getStringPref(CONFIG.CUSTOM_ICONS_PREF, "");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(cleanIcon).filter(Boolean);
  } catch (e) {
    console.warn(`${LOG} custom icons pref parse failed:`, e);
    return [];
  }
};

export const writeCustomIconsPref = (icons) => {
  try {
    Services.prefs.setStringPref(CONFIG.CUSTOM_ICONS_PREF, JSON.stringify(icons));
  } catch (e) {
    console.error(`${LOG} failed to write custom icons pref:`, e);
  }
};

export const findCustomIcon = (id, icons = readCustomIconsPref()) =>
  icons.find((icon) => icon.id === id) || null;

export const makeCustomIcon = (file, dataUrl) => {
  const rawId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id: `custom:${rawId}`,
    name: cleanName(file?.name),
    dataUrl,
  };
};
