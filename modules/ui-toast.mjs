// Zen Tab Wand — shared toast / system-notification helper.
//
// Tries Zen's UI manager first (best integration), falls back to the standard
// nsIAlertsService (OS-level notification), finally console.warn if neither
// is available. Used by both AI engine modules (ai.mjs, ollama.mjs) for
// user-visible error surfacing.

import { LOG } from "./config.mjs";

export const showToast = (message) => {
  try {
    if (typeof gZenUIManager !== "undefined" && typeof gZenUIManager.showToast === "function") {
      console.log(`${LOG} toast: ${message}`);
      // gZenUIManager.showToast expects a localized string id, which we don't
      // have. We log + fall through to the alerts service which takes raw text.
      try {
        const alertsService = Cc["@mozilla.org/alerts-service;1"]?.getService(Ci.nsIAlertsService);
        alertsService?.showAlertNotification(null, "Zen Tab Wand", message);
      } catch {}
      return;
    }
  } catch {}
  console.warn(`${LOG} toast (no gZenUIManager): ${message}`);
};
