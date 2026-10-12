// Clicking the toolbar icon opens the Cold side panel. Everything else happens in the panel.
chrome.runtime.onInstalled.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); });
