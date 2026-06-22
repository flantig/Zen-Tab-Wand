// Zen Tab Wand — local custom icon library stored in prefs as data URLs.

import { CONFIG, LOG } from "./config.mjs";

export const CUSTOM_ICON_MAX_DIMENSION = 128;

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

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Read failed"));
    reader.readAsDataURL(file);
  });

const loadImage = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = url;
  });

const cappedImageDataUrl = async ({ url, type, maxDimension, fallback }) => {
  const img = await loadImage(url);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) return fallback();
  if (width <= maxDimension && height <= maxDimension) return fallback();

  const scale = Math.min(maxDimension / width, maxDimension / height);
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const outputType = type === "image/jpeg" || type === "image/webp" ? type : "image/png";
  return canvas.toDataURL(outputType, 0.92);
};

export const fileToIconDataUrl = async (file, maxDimension = CUSTOM_ICON_MAX_DIMENSION) => {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await cappedImageDataUrl({
      url: objectUrl,
      type: file.type,
      maxDimension,
      fallback: () => readFileAsDataUrl(file),
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

export const dataUrlToIconDataUrl = async (dataUrl, maxDimension = CUSTOM_ICON_MAX_DIMENSION) => {
  const type = String(dataUrl).match(/^data:([^;,]+)/)?.[1] || "";
  try {
    return await cappedImageDataUrl({
      url: dataUrl,
      type,
      maxDimension,
      fallback: () => dataUrl,
    });
  } catch {
    return dataUrl;
  }
};

export const makeCustomIcon = (file, dataUrl) => {
  const rawId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id: `custom:${rawId}`,
    name: cleanName(file?.name),
    dataUrl,
  };
};
