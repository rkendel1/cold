// A small client for the Google Sheets API (v4): just what Cold needs to keep leads and outreach in a spreadsheet it created.
// `token()` returns an access token (and refreshes it when asked to, after a 401). Nothing here stores or logs a token.
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const enc = encodeURIComponent;

/** Google's errors, as the app understands them. `code` is stable; `message` is for people. */
export function apiError(status, body) {
  const msg = body && body.error && body.error.message ? String(body.error.message) : "";
  if (status === 401) return { code: "google_auth", status, message: "Google needs you to sign in again." };
  if (status === 403) return { code: /quota|rate/i.test(msg) ? "google_quota" : "google_forbidden", status, message: /quota|rate/i.test(msg) ? "Google is limiting requests right now. Try again in a minute." : "Cold doesn't have access to that spreadsheet. Cold can only open spreadsheets it created for you." };
  if (status === 404) return { code: "google_missing", status, message: "That spreadsheet wasn't found. It may have been deleted, or it isn't one Cold created for you." };
  if (status === 429) return { code: "google_quota", status, message: "Google is limiting requests right now. Try again in a minute." };
  return { code: "storage_unavailable", status, message: msg ? `Google Sheets said: ${msg}` : "Couldn't reach Google Sheets." };
}

export function createSheetsApi({ token, base = API, fetchImpl = (...a) => globalThis.fetch(...a), sleep = ms => new Promise(r => setTimeout(r, ms)), retries = 2 } = {}) {
  async function call(path, { method = "GET", body, refresh = false } = {}) {
    let t;
    try { t = await token(refresh); } catch (e) { throw { code: "google_auth", message: (e && e.message) || "Sign in to Google to use your spreadsheet." }; }
    let r;
    try { r = await fetchImpl(base + path, { method, headers: { authorization: `Bearer ${t}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw { code: "storage_unavailable", message: "Couldn't reach Google Sheets. Check your connection." }; }
    const data = await r.json().catch(() => ({}));
    if (r.ok) return data;
    if (r.status === 401 && !refresh) return call(path, { method, body, refresh: true });   // an expired token: get a fresh one once
    throw apiError(r.status, data);
  }
  /** A call that waits and tries again when Google asks us to slow down (or has a brief problem). */
  async function go(path, init) {
    for (let n = 0; ; n++) {
      try { return await call(path, init); }
      catch (e) { const again = e && (e.code === "google_quota" || (e.status >= 500 && e.status < 600)); if (!again || n >= retries) throw e; await sleep(800 * 2 ** n); }
    }
  }
  const range = (tab, a1) => `${enc(`'${tab.replace(/'/g, "''")}'`)}${a1 ? `!${a1}` : ""}`;

  return {
    /** A new spreadsheet with one tab per entry: [{ title, headers }]. Header rows are frozen. */
    async create(title, tabs) {
      const made = await go("", { method: "POST", body: { properties: { title }, sheets: tabs.map(t => ({ properties: { title: t.title, gridProperties: { frozenRowCount: 1 } }, data: [{ startRow: 0, startColumn: 0, rowData: [{ values: t.headers.map(h => ({ userEnteredValue: { stringValue: h }, userEnteredFormat: { textFormat: { bold: true } } })) }] }] })) } });
      return { spreadsheetId: made.spreadsheetId, url: made.spreadsheetUrl, sheets: Object.fromEntries((made.sheets || []).map(s => [s.properties.title, s.properties.sheetId])) };
    },
    /** What is there: the title, link, and each tab's numeric id (needed to delete rows). */
    async meta(id) {
      const m = await go(`/${enc(id)}?fields=properties.title,spreadsheetUrl,sheets.properties`);
      return { title: m.properties && m.properties.title, url: m.spreadsheetUrl, sheets: Object.fromEntries((m.sheets || []).map(s => [s.properties.title, s.properties.sheetId])) };
    },
    /** Every row of a tab as strings (row 1 is the heading). */
    async read(id, tab) { const r = await go(`/${enc(id)}/values/${range(tab)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`); return r.values || []; },
    /** Several tabs in one call: { Leads: [[…]], Outreach: [[…]] }. */
    async readMany(id, tabs) {
      const r = await go(`/${enc(id)}/values:batchGet?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&${tabs.map(t => `ranges=${range(t)}`).join("&")}`);
      return Object.fromEntries(tabs.map((t, i) => [t, (r.valueRanges && r.valueRanges[i] && r.valueRanges[i].values) || []]));
    },
    /** Write cells: [{ tab, a1: "A5:K5", values: [[…]] }]. Text only (RAW): nothing is ever run as a formula. */
    async write(id, updates) {
      if (!updates.length) return;
      await go(`/${enc(id)}/values:batchUpdate`, { method: "POST", body: { valueInputOption: "RAW", data: updates.map(u => ({ range: `${u.tab.includes(" ") ? `'${u.tab}'` : u.tab}!${u.a1}`, majorDimension: "ROWS", values: u.values })) } });
    },
    /** Add rows at the bottom; returns the row numbers they got. */
    async append(id, tab, rows) {
      if (!rows.length) return [];
      const r = await go(`/${enc(id)}/values/${range(tab, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", body: { majorDimension: "ROWS", values: rows } });
      const m = /!\$?[A-Z]+\$?(\d+)(?::\$?[A-Z]+\$?(\d+))?$/.exec((r.updates && r.updates.updatedRange) || "");
      const first = m ? Number(m[1]) : NaN;
      return Number.isFinite(first) ? rows.map((_, i) => first + i) : [];
    },
    /** Remove whole rows (by sheet row number, 1-based, never the heading). */
    async deleteRows(id, sheetId, rowNumbers) {
      const rows = [...new Set(rowNumbers)].filter(n => n > 1).sort((a, b) => b - a);   // bottom first, so numbers above don't shift
      if (!rows.length) return;
      await go(`/${enc(id)}:batchUpdate`, { method: "POST", body: { requests: rows.map(n => ({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: n - 1, endIndex: n } } })) } });
    },
    /** Add a tab if it isn't there, with its heading row. */
    async addTab(id, title, headers) {
      await go(`/${enc(id)}:batchUpdate`, { method: "POST", body: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] } });
      await this.write(id, [{ tab: title, a1: "A1", values: [headers] }]);
    },
  };
}
