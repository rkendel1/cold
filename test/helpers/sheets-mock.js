// An in-memory stand-in for the parts of the Google Sheets API (v4) that Cold uses. Tests verify Cold's behaviour against it; it is not Google.
const http = require("node:http");

function startSheetsMock({ token = "good-token" } = {}) {
  const books = new Map();                 // id -> { title, sheets: [{ id, title, rows: string[][] }] }
  const mock = { books, calls: [], token, failNext: 0, status: 0, n: 0 };
  const colNum = s => s.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
  const tabOf = (b, name) => b.sheets.find(s => s.title === name);
  const parseRange = r => {                // 'Leads'!A5:K5  |  Leads  |  'Leads'!A1
    const m = /^(?:'((?:[^']|'')+)'|([^!']+))(?:!\$?([A-Z]+)\$?(\d+)?(?::\$?([A-Z]+)\$?(\d+)?)?)?$/.exec(r);
    if (!m) return null;
    return { tab: (m[1] || m[2]).replace(/''/g, "'"), c1: m[3] ? colNum(m[3]) : 1, r1: m[4] ? Number(m[4]) : 1, c2: m[5] ? colNum(m[5]) : null, r2: m[6] ? Number(m[6]) : null };
  };
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, OPTIONS" };   // the real API allows browser calls with a bearer token
  const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", ...CORS }); res.end(JSON.stringify(body)); };
  const err = (res, code, message) => send(res, code, { error: { code, message } });

  mock.server = http.createServer((req, res) => {
    let raw = ""; req.on("data", c => raw += c); req.on("end", () => {
      if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
      const url = new URL(req.url, "http://x"); const path = decodeURIComponent(url.pathname).replace(/^\/v4\/spreadsheets/, "");
      mock.calls.push(`${req.method} ${path}${url.search ? "?…" : ""}`);
      if (req.headers.authorization !== `Bearer ${mock.token}`) return err(res, 401, "Invalid Credentials");
      if (mock.failNext > 0) { mock.failNext--; return err(res, mock.status || 500, "mock failure"); }
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "POST" && path === "") {
        const id = `1Mock${String(++mock.n).padStart(3, "0")}_${"x".repeat(32)}`; const b = { title: body.properties.title, sheets: [] };
        (body.sheets || []).forEach((s, i) => { const row = ((s.data || [])[0].rowData || [])[0]; b.sheets.push({ id: i + 1, title: s.properties.title, rows: [row ? row.values.map(v => v.userEnteredValue.stringValue) : []] }); });
        books.set(id, b);
        return send(res, 200, { spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`, sheets: b.sheets.map(s => ({ properties: { title: s.title, sheetId: s.id } })) });
      }
      const m = /^\/([^/:]+)(.*)$/.exec(path); const id = m && m[1], rest = m ? m[2] : "", b = books.get(id);
      if (!b) return err(res, 404, "Requested entity was not found.");
      if (req.method === "GET" && rest === "") return send(res, 200, { properties: { title: b.title }, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`, sheets: b.sheets.map(s => ({ properties: { title: s.title, sheetId: s.id } })) });
      if (req.method === "GET" && rest === "/values:batchGet") {
        const ranges = url.searchParams.getAll("ranges");
        return send(res, 200, { valueRanges: ranges.map(r => { const p = parseRange(r), t = p && tabOf(b, p.tab); return { values: t ? t.rows : [] }; }) });
      }
      let mm = /^\/values\/(.+):append$/.exec(rest);
      if (req.method === "POST" && mm) {
        const p = parseRange(mm[1]), t = tabOf(b, p.tab); if (!t) return err(res, 400, "Unable to parse range");
        const start = t.rows.length + 1; body.values.forEach(v => t.rows.push(v.map(String)));
        return send(res, 200, { updates: { updatedRange: `${p.tab}!A${start}:Z${start + body.values.length - 1}`, updatedRows: body.values.length } });
      }
      mm = /^\/values\/(.+)$/.exec(rest);
      if (req.method === "GET" && mm) { const p = parseRange(mm[1]), t = p && tabOf(b, p.tab); return t ? send(res, 200, { values: t.rows }) : err(res, 400, "Unable to parse range"); }
      if (req.method === "POST" && rest === "/values:batchUpdate") {
        for (const d of body.data) {
          const p = parseRange(d.range), t = p && tabOf(b, p.tab); if (!t) return err(res, 400, "Unable to parse range");
          d.values.forEach((vals, i) => { const r = p.r1 - 1 + i; while (t.rows.length <= r) t.rows.push([]); const row = t.rows[r]; vals.forEach((v, j) => { const c = p.c1 - 1 + j; while (row.length <= c) row.push(""); row[c] = String(v); }); });
        }
        return send(res, 200, { totalUpdatedCells: 1 });
      }
      if (req.method === "POST" && rest === ":batchUpdate") {
        for (const r of body.requests) {
          if (r.addSheet) { if (b.sheets.some(s => s.title === r.addSheet.properties.title)) return err(res, 400, "A sheet with that name already exists"); b.sheets.push({ id: 100 + b.sheets.length, title: r.addSheet.properties.title, rows: [[]] }); }
          if (r.deleteDimension) { const t = b.sheets.find(s => s.id === r.deleteDimension.range.sheetId); t.rows.splice(r.deleteDimension.range.startIndex, r.deleteDimension.range.endIndex - r.deleteDimension.range.startIndex); }
        }
        return send(res, 200, {});
      }
      return err(res, 400, "unsupported in mock");
    });
  });
  return new Promise(r => mock.server.listen(0, "127.0.0.1", () => { mock.url = `http://127.0.0.1:${mock.server.address().port}/v4/spreadsheets`; mock.close = () => new Promise(x => mock.server.close(x)); r(mock); }));
}
module.exports = { startSheetsMock };
