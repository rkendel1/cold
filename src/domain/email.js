export const emailText = (e, signature = "") =>
  e.mode && e.mode !== "email" ? e.what : `${String(e.what || "").trim()} ${String(e.why || "").trim()}\n\n${String(e.ask || "").trim()}${signature ? `\n\n${signature}` : ""}`.trim();

export function parseLooseJson(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw { code: "invalid_json", message: "No JSON in reply", text: t };
}
