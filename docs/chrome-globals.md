# Chrome script globals reference

If you've never written a Firefox/Zen chrome script, the code uses several globals out of nowhere: `Services`, `gBrowser`, `gZenWorkspaces`, `MozXULElement`, etc. They aren't imported because they're injected by Firefox into the chrome runtime — same way the browser injects `window`/`document` into web pages.

## What's available where

| Global | Available in | What it's for | Searchfox |
|---|---|---|---|
| `Services` | every chrome script | Top-level access to Mozilla services. We use `Services.prefs` (read/write user prefs), `Services.wm` (find browser windows). | [Services.sys.mjs](https://searchfox.org/mozilla-central/search?q=path%3AServices.sys.mjs) |
| `gBrowser` | `browser.xhtml` only | The tab browser singleton. `gBrowser.tabs`, `gBrowser.addTabGroup`, `gBrowser.moveTabToExistingGroup`, `gBrowser.tabContainer`. | [tabbrowser.js](https://searchfox.org/mozilla-central/source/browser/components/tabbrowser/content/tabbrowser.js) |
| `gZenWorkspaces` | `browser.xhtml` only | Zen-specific. `.activeWorkspace` (id string), `.activeWorkspaceElement`. | Zen omni: `chrome/browser/content/zen-browser/` |
| `MozXULElement` | every chrome script | Helper for parsing XUL strings. We use `MozXULElement.parseXULToFragment(xulString)` to build `<toolbarbutton>`, `<menuitem>`, etc. | [MozElements.sys.mjs](https://searchfox.org/mozilla-central/search?q=path%3AMozElements) |
| `document.createXULElement(tag)` | every chrome script | Create a XUL element (`<vbox>`, `<menuitem>`, ...). Different from `createElement` which respects the document's default namespace. | DOM |
| `ChromeUtils.importESModule(url)` | every chrome script | Dynamically import a `.sys.mjs` system module. We don't use this directly but Sine does. | [ChromeUtils.webidl](https://searchfox.org/mozilla-central/search?q=ChromeUtils.webidl) |

## Why HTML namespace matters in `about:preferences`

`about:preferences` is rooted as a XUL document. In XUL documents, `document.createElement("button")` returns a XUL `<button>` (with chrome theming, min-widths, etc.) — not an HTML one. The XUL button picks up styling intended for native browser chrome.

To get an HTML element we use `document.createElementNS("http://www.w3.org/1999/xhtml", "button")`. The helper `h(tag)` in `config.mjs` is a one-liner for that.

`browser.xhtml` has the opposite mix: it's also XUL-rooted but mostly built from XUL elements (`<toolbarbutton>`, `<hbox>`, `<menuitem>`, ...). When we add a XUL toolbarbutton there, we use the XUL parser via `MozXULElement.parseXULToFragment`.

Rule of thumb in this mod:
- **Building widgets inside `about:preferences`** (the rules editor, color picker): use `h(tag)` → HTML.
- **Building chrome inside `browser.xhtml`** (the toolbar button, context menu items): use `parseXULToFragment` → XUL.

## Pref API cheat sheet

```js
// Read with default fallback
const value = Services.prefs.getStringPref("extensions.foo.bar", "default");
const flag  = Services.prefs.getBoolPref("extensions.foo.flag", false);

// Write
Services.prefs.setStringPref("extensions.foo.bar", "value");
Services.prefs.setBoolPref("extensions.foo.flag", true);

// Observe changes (fires whenever the pref is set)
const observer = {
  observe(subject, topic, data) {
    // topic === "nsPref:changed", data === the pref name that changed
  },
};
Services.prefs.addObserver("extensions.foo.bar", observer);
// remember to clean up: Services.prefs.removeObserver(name, observer);
```

## Window manager

```js
// Get the most-recently-active browser window (works from any chrome context)
const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
// `browserWin.document`, `browserWin.gBrowser`, etc. are then accessible.
```

We use this in `color-picker.mjs` to read Zen's live computed tab-group palette from the main browser window's CSS environment (which isn't available in `about:preferences`).

## Reading more

- **Searchfox** ([searchfox.org/mozilla-central](https://searchfox.org/mozilla-central/source/)): the Firefox codebase, fully indexed. Search for any global to find its definition + callers. Indispensable.
- **Firefox userChromeJS** docs (community wikis) explain `.uc.js` / `.uc.mjs` loading.
- **Sine source** lives in your Zen profile at `<profile>/chrome/JS/` — useful when you need to know how Sine itself wires things up.
