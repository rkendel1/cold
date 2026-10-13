// Last-resort logging for failures nothing else handled. Deliberately small: it only LOGS (so a real fault stays diagnosable in the console and in
// test output) and never changes state, shows UI, or swallows anything. Expected failures (a rejected save, an unreachable provider) are handled where
// they happen, by the operation that knows what the user can do about it.

/** Browser notices that are not faults. Chromium raises this one when auto-sizing text boxes resize inside a layout pass. */
export const isBenignBrowserNotice = message => /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/.test(String(message || ""));

/** @param {{ addEventListener: Function }} target the window  @param {{ error: Function }} log the console */
export function installGlobalErrorLogging(target = globalThis.window, log = console) {
  target.addEventListener("error", e => {
    if (isBenignBrowserNotice(e && e.message)) return;
    log.error("Uncaught error:", (e && e.error) || (e && e.message), e && e.filename ? `(${e.filename}:${e.lineno})` : "");
  });
  // Not prevented: the browser's own report of an unhandled rejection stays visible too.
  target.addEventListener("unhandledrejection", e => { log.error("Unhandled promise rejection:", e && e.reason); });
}
