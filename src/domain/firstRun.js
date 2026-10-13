// First-run checklist rules. Pure, no DOM. Every step's "done" is DERIVED from what actually exists (a ready model, a saved product, a recorded copy/handoff,
// imported leads); no step is ever stored as completed. The only thing remembered is whether the checklist was started or dismissed (a setting, like the others).

/** "" or "dismissed". Anything else is "". (An older build could store "active"; it means nothing now.) */
export const normalizeFirstRun = v => (v === "dismissed" ? v : "");

/**
 * Someone who has clearly used Cold already: any draft recorded as sent or replied, or several drafts. They never see the checklist, so an existing
 * library that arrives later (a paired library, a switch of library) can't bring it back. Derived, never stored.
 */
export const isEstablished = s => (s.emails || []).some(e => e && (e.status === "sent" || e.status === "replied")) || (s.emails || []).length >= 3;

/**
 * The checklist for this surface right now. `canConfigureModel` is whether this surface has a Settings screen where the user can choose a model
 * (desktop, extension, a local install); a hosted site's model belongs to whoever runs it, so the step explains that instead of offering a control.
 */
export function firstRunSteps({ products = [], emails = [], leads = [], sampleState = "pending", canConfigureModel = false } = {}) {
  const handedOff = e => e && (e.status === "sent" || e.status === "replied" || (Array.isArray(e.handoffs) && e.handoffs.some(h => h && (h.how === "copy" || h.how === "open"))));
  return [
    { id: "model", label: "Connect a model", optional: false, done: sampleState === "ready", checking: sampleState === "pending", canConfigure: !!canConfigureModel },
    { id: "product", label: "Add what you offer", optional: false, done: products.some(p => p && String(p.name || "").trim()) },
    { id: "draft", label: "Generate a draft and copy it", optional: false, done: emails.some(handedOff) },
    { id: "leads", label: "Import your leads", optional: true, done: leads.length > 0 },
  ];
}
export const requiredDone = steps => steps.filter(s => !s.optional).every(s => s.done);

/**
 * Whether to show the checklist. NOTHING is written for this: only an explicit dismissal is remembered (a setting). A settings write can rewrite every stored
 * list, so it must never happen because a page loaded or because a library arrived from sync.
 *  - dismissed: never.  - not loaded yet, or an established install: no.
 *  - required steps not all done: yes (and the session is marked started, in memory).
 *  - all required steps done: only for the session that watched them get done ("You're set up"), until dismissed or the page reloads.
 */
export function shouldShowFirstRun({ firstRun, ready, steps, established, sessionStarted }) {
  if (firstRun === "dismissed" || !ready || established) return false;
  return !requiredDone(steps) || !!sessionStarted;
}
