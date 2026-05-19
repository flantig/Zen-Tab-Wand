// Zen Tab Wand — entry point.
// Loaded by Sine in both `chrome://browser/content/browser.xhtml` (the main browser
// window) and `about:preferences*` (the settings page). Branches on window.location
// to wire the right submodules in each context.

import { CONFIG, LOG } from "./modules/config.mjs";
import { domCache } from "./modules/tabs.mjs";
import { readRulesPref, getAIEngine, getOllamaHost, getOllamaModel, isOllamaWarmupEnabled } from "./modules/rules.mjs";
import { syncAllGroupColors } from "./modules/groups.mjs";
import { warmupOllama } from "./modules/ollama.mjs";
import {
  setupCommand,
  setupWorkspaceHooks,
  addButtonToAllSeparators,
} from "./modules/browser-ui.mjs";
import {
  setupTabGroupedHook,
  setupTabGroupCreateHook,
  setupMinimalStylePrefObserver,
  teardownMinimalStylePrefObserver,
} from "./modules/browser-hooks.mjs";
import {
  setupSettingsObserver,
  teardownSettingsObserver,
} from "./modules/prefs-ui.mjs";

const url = window.location.href;
const isBrowserContext = url === "chrome://browser/content/browser.xhtml";
const isPrefsContext =
  url.startsWith("about:preferences") ||
  url.startsWith("chrome://browser/content/preferences/");

const tryInitializeBrowser = () => {
  try {
    const separatorExists = domCache.getSeparators().length > 0;
    const commandSetExists = !!domCache.getCommandSet();
    const gBrowserReady = typeof gBrowser !== "undefined" && gBrowser?.tabContainer;
    const gZenWorkspacesReady = typeof window.gZenWorkspaces !== "undefined";

    if (gBrowserReady && commandSetExists && separatorExists && gZenWorkspacesReady) {
      setupCommand();
      addButtonToAllSeparators();
      setupWorkspaceHooks();
      setupTabGroupedHook();
      setupTabGroupCreateHook();
      setupMinimalStylePrefObserver();

      // Apply colors to groups that were restored before our hook installed
      // (the TabGroupCreate event already fired by the time the listener registered).
      const workspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (workspaceId) {
        const rules = readRulesPref();
        if (rules) syncAllGroupColors(workspaceId, rules);
      }

      // If the user has Ollama selected AND opted into warmup, preload the
      // model in the background so the first tidy click doesn't pay the
      // cold-start cost. Fire-and-forget — silent on failure (daemon may not
      // be running yet).
      if (getAIEngine() === "ollama" && isOllamaWarmupEnabled()) {
        warmupOllama(getOllamaHost(), getOllamaModel());
      }

      console.log(`${LOG} initialized (browser)`);
      return true;
    }
  } catch (e) {
    console.error(`${LOG} init error:`, e);
  }
  return false;
};

// Sine occasionally loads our entry script BEFORE Zen has finished setting up
// `gBrowser` and `gZenWorkspaces`. We try once immediately, then poll every
// INIT_CHECK_INTERVAL ms up to MAX_INIT_CHECKS times — default total ~5s before
// giving up with a warning. We track the interval id so cleanup() can stop it
// if the window is closed mid-poll (otherwise the timer keeps firing against
// a detached window until checkCount runs out).
let initInterval = null;
const initializeBrowserScript = () => {
  if (tryInitializeBrowser()) return;
  let checkCount = 0;
  initInterval = setInterval(() => {
    checkCount++;
    if (tryInitializeBrowser()) {
      clearInterval(initInterval);
      initInterval = null;
    } else if (checkCount > CONFIG.MAX_INIT_CHECKS) {
      clearInterval(initInterval);
      initInterval = null;
      console.warn(`${LOG} init timed out`);
    }
  }, CONFIG.INIT_CHECK_INTERVAL);
};

const cleanup = () => {
  try {
    if (initInterval) {
      clearInterval(initInterval);
      initInterval = null;
    }
    domCache.invalidate();
    teardownSettingsObserver();
    teardownMinimalStylePrefObserver();
  } catch (e) {
    console.error(`${LOG} cleanup error:`, e);
  }
};

const entryPoint = () => {
  if (isBrowserContext) {
    initializeBrowserScript();
  } else if (isPrefsContext) {
    console.log(`${LOG} initialized (preferences) at ${url}`);
    setupSettingsObserver();
  }
};

if (document.readyState === "complete") {
  entryPoint();
} else {
  window.addEventListener("load", entryPoint, { once: true });
}
// Belt-and-suspenders: `beforeunload` runs synchronously while the window is still
// usable (best chance to disconnect observers cleanly); `unload` is the safety net
// in case the browser skipped `beforeunload`. Both are guarded by `{ once: true }`.
window.addEventListener("unload", cleanup, { once: true });
window.addEventListener("beforeunload", cleanup, { once: true });
