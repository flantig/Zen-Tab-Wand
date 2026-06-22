# `modules/custom-icons.mjs` — Custom icon storage

Stores uploaded custom icons locally in `extensions.zen-auto-organize.custom-icons-json`.

| Name | Notes |
|---|---|
| `readCustomIconsPref()` | Returns cleaned `{ id, name, dataUrl }` entries. Invalid/non-image entries are dropped. |
| `writeCustomIconsPref(icons)` | Writes the custom icon array back to prefs. |
| `findCustomIcon(id, icons)` | Looks up a `custom:<id>` entry. |
| `fileToIconDataUrl(file)` | Loads an uploaded image and stores it as a data URL normalized to a 128px longest side, preserving aspect ratio. |
| `dataUrlToIconDataUrl(dataUrl)` | Normalizes an imported icon data URL through the same 128px-longest-side sizing. |
| `makeCustomIcon(file, dataUrl)` | Builds a new icon entry using the uploaded file name as the display/search name. |

Icons are stored as image data URLs so they remain local to the browser profile and can render in both settings and browser chrome without extra file permissions. Upload accepts source files up to 8 MB, then scales images up or down to a 128px longest side before storing them. Backup restore also normalizes imported custom icons to the same size.
