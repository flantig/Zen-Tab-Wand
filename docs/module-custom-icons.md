# `modules/custom-icons.mjs` — Custom icon storage

Stores uploaded custom icons locally in `extensions.zen-auto-organize.custom-icons-json`.

| Name | Notes |
|---|---|
| `readCustomIconsPref()` | Returns cleaned `{ id, name, dataUrl }` entries. Invalid/non-image entries are dropped. |
| `writeCustomIconsPref(icons)` | Writes the custom icon array back to prefs. |
| `findCustomIcon(id, icons)` | Looks up a `custom:<id>` entry. |
| `makeCustomIcon(file, dataUrl)` | Builds a new icon entry using the uploaded file name as the display/search name. |

Icons are stored as image data URLs so they remain local to the browser profile and can render in both settings and browser chrome without extra file permissions.
