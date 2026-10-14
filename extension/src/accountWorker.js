// Background service worker entry for account sign-in (bundled to dist/account-worker.js and loaded by background.js).
import { createAccountWorker } from "./account.js";
const worker = createAccountWorker({ chrome });
chrome.runtime.onMessage.addListener(worker.onMessage);
