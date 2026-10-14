// Clicking the toolbar icon opens the Cold side panel. Everything else happens in the panel.
chrome.runtime.onInstalled.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); });
// Optional Cold account sign-in (identity only). Held here, in the worker, so the panel and content scripts never see a token.
try { importScripts("dist/account-worker.js"); } catch (e) { /* the build has no account support; the panel then offers none */ }
