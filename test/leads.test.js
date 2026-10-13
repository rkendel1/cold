const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

test('the example file people download is exactly what the code produces, and Cold would skip its sample rows', async () => {
  const L = await load('src/domain/leads.js');
  assert.equal(fs.readFileSync(path.join(__dirname, '../examples/leads-template.csv'), 'utf8'), L.templateCsv(), 'examples/leads-template.csv is generated from LEAD_FIELDS (run: node -e "import(\'./src/domain/leads.js\').then(m=>fs.writeFileSync(\'examples/leads-template.csv\',m.templateCsv()))")');
  assert.deepEqual(L.TEMPLATE_HEADERS, ['name', 'company', 'role', 'email', 'profile_url', 'why', 'product', 'goal', 'list', 'notes']);
  assert.deepEqual(L.LEAD_FIELDS.filter(f => f.required).map(f => f.key), ['name']);
  const plan = L.planImport(L.templateCsv(), []);
  assert.equal(plan.ok, true); assert.deepEqual([plan.total, plan.adds.length, plan.examples.length, plan.invalid.length], [3, 0, 3, 0], 'the three sample rows are recognised and never imported');
});

test('CSV reading copes with what spreadsheets produce', async () => {
  const { parseCsv } = await load('src/domain/leads.js');
  const r = parseCsv('﻿name,why,notes\r\n"Smith, Jo","said ""hello""\nthen left","a"\r\n\r\n  \r\nBo,plain,\r\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map(x => x.cells), [['name', 'why', 'notes'], ['Smith, Jo', 'said "hello"\nthen left', 'a'], ['Bo', 'plain', '']]);   // BOM, quotes, newline in a cell, blank lines
  assert.deepEqual(r.rows.map(x => x.line), [1, 2, 6], 'line numbers point at the row in the file');
  assert.equal(parseCsv('name;company\nJo;Acme\n').delimiter, ';');
  assert.deepEqual(parseCsv('name\tcompany\nJo\tAcme').rows[1].cells, ['Jo', 'Acme']);
  assert.deepEqual(parseCsv('name,company\nJo,Acme').rows[1].cells, ['Jo', 'Acme']);                  // no trailing newline
  assert.match(parseCsv('name,why\nJo,"never closes\nBo,x').message, /starts on line 2 never closes/);
  assert.match(parseCsv('name\u0000\u0001binary').message, /doesn't look like a text CSV/);
  assert.deepEqual(parseCsv('').rows, []);
});

test('columns are found by name, in any order, with common alternative headings; unknown columns are reported, not guessed', async () => {
  const { mapHeaders } = await load('src/domain/leads.js');
  const m = mapHeaders(['Job Title', 'Full Name', 'Organization', 'LinkedIn', 'Reason', 'Email Address', 'Favourite colour', 'Campaign', 'Comments']);
  assert.deepEqual(m.columns, { name: 1, company: 2, role: 0, email: 5, profileUrl: 3, why: 4, list: 7, notes: 8 });
  assert.deepEqual(m.ignored, ['Favourite colour']);
  const fl = mapHeaders(['First Name', 'Last Name', 'Company']);
  assert.deepEqual([fl.ok, fl.first, fl.last, fl.columns.company], [true, 0, 1, 2]);
  assert.match(mapHeaders(['Company', 'Email']).message, /Couldn't find a name column/);
  // the template's own headings always map
  const t = mapHeaders((await load('src/domain/leads.js')).TEMPLATE_HEADERS);
  assert.deepEqual(Object.keys(t.columns).length, 10); assert.deepEqual(t.ignored, []);
});

test('an import is planned without saving anything: adds, invalid rows, warnings, duplicates and examples are all accounted for', async () => {
  const { planImport, leadKey } = await load('src/domain/leads.js');
  const existing = [
    { id: 'l1', name: 'Ada Park', company: 'PipeCo', email: 'ada@pipeco.io', list: 'Old', notes: 'keep me' },
    { id: 'l2', name: 'Bo Chen', company: 'BoCo', email: '', profileUrl: 'https://www.linkedin.com/in/bo-chen' },
    { id: 'l3', name: 'Cy Diaz', company: 'CyCo', email: '' },
  ];
  const csv = [
    'name,company,role,email,profile_url,why,goal,list',
    'New Person,NewCo,CTO,new@newco.io,linkedin.com/in/new-person,Wrote about edge,Advice,Spring',     // add; profile link tidied; goal read from its label
    ',NoName Inc,,nobody@noname.io,,,,',                                                               // invalid: no name
    'Ada Park,PipeCo,COO,ADA@PIPECO.IO,,Posted about onboarding,advice,',                              // duplicate by email (case-insensitive)
    'Bo Chen,Elsewhere,,,x.com/bochen,,,',                                                             // not a duplicate: different profile link, no email
    'Bo Again,BoCo,,,https://linkedin.com/in/bo-chen/,,,',                                             // duplicate by LinkedIn profile
    'Cy Diaz,CyCo,Founder,,,,,',                                                                       // duplicate by name + company
    'Dee Evans,DeeCo,,not-an-email,https://example.org/dee,,somewhere,',                               // add with three warnings
    'Dee Evans,DeeCo,,not-an-email,,,,',                                                               // duplicate of the row above (within the file)
    'Sample Person,Acme,,jordan.rivera@example.com,,,,',                                                      // the template\'s sample
  ].join('\n');
  const p = planImport(csv, existing, { list: 'Imported', now: 1000 });
  assert.equal(p.ok, true); assert.equal(p.total, 9);
  assert.deepEqual(p.adds.map(l => l.name), ['New Person', 'Bo Chen', 'Dee Evans']);
  assert.deepEqual(p.adds[0], { ...p.adds[0], name: 'New Person', profileUrl: 'https://www.linkedin.com/in/new-person', goal: 'advice', list: 'Spring', source: 'csv', createdAt: 1000, updatedAt: 1000 });
  assert.ok(p.adds.every(l => /^l_/.test(l.id)) && new Set(p.adds.map(l => l.id)).size === 3);
  assert.deepEqual(p.adds.map(l => l.createdAt), [1000, 1001, 1002], 'each row keeps its place in the file');
  assert.equal(p.adds[1].list, 'Imported', 'rows without their own list get the one chosen for the import');
  assert.deepEqual(p.invalid, [{ line: 3, name: '(no name)', reasons: ['Name is required.'] }]);
  assert.deepEqual(p.duplicates.map(d => [d.line, d.reason]), [[4, 'Already in your leads.'], [6, 'Already in your leads.'], [7, 'Already in your leads.'], [9, 'Appears earlier in this file.']]);
  assert.deepEqual(p.examples, [{ line: 10, name: 'Sample Person' }]);
  assert.deepEqual(p.warnings.map(w => [w.name, w.messages.length]), [['Dee Evans', 3]]);
  assert.match(p.warnings[0].messages.join(' '), /Goal “somewhere”.*left blank/); assert.match(p.warnings[0].messages.join(' '), /email address doesn't look valid/); assert.match(p.warnings[0].messages.join(' '), /isn't a LinkedIn or X profile/);
  assert.equal(p.adds.length + p.duplicates.length + p.invalid.length + p.examples.length, p.total, 'every row is accounted for');
  assert.equal(existing[0].notes, 'keep me');
});

test('updating duplicates fills blank fields only; it never blanks or overwrites with empty values', async () => {
  const { planImport } = await load('src/domain/leads.js');
  const existing = [{ id: 'l1', name: 'Ada Park', company: 'PipeCo', role: '', email: 'ada@pipeco.io', why: 'my own reason', notes: 'keep me', list: 'Old' }];
  const csv = 'name,company,role,email,why,notes,list\nAda Park,PipeCo,COO,ada@pipeco.io,,,\n';
  const p = planImport(csv, existing, { duplicates: 'update', now: 5 });
  assert.equal(p.updates.length, 1); assert.deepEqual(p.updates[0].changed, ['role']);
  assert.deepEqual(p.updates[0].next, { ...existing[0], role: 'COO', updatedAt: 5 });
  assert.equal(p.updates[0].next.why, 'my own reason'); assert.equal(p.updates[0].next.notes, 'keep me');
  assert.deepEqual([planImport('name,email\nAda Park,ada@pipeco.io\n', existing, { duplicates: 'update' }).unchanged], [1]);
  assert.equal(planImport(csv, existing).updates.length, 0, 'the default leaves existing leads alone');
});

test('limits and bad files are refused with a reason, never half-imported', async () => {
  const { planImport, MAX_IMPORT_ROWS } = await load('src/domain/leads.js');
  assert.match(planImport('', []).message, /empty/);
  assert.match(planImport('name,company\n', []).message, /no rows of leads/);
  assert.match(planImport('company,email\nAcme,a@b.co\n', []).message, /name column/);
  const big = 'name\n' + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `P${i}`).join('\n');
  assert.match(planImport(big, []).message, /5001 rows\. Import up to 5000/);
  assert.equal(planImport('name\n' + Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `P${i}`).join('\n'), []).adds.length, MAX_IMPORT_ROWS);
  assert.match(planImport('x'.repeat(2.5 * 1024 * 1024), []).message, /larger than 2 MB/);
});

test('export and import round-trip, and spreadsheet formulas are defused on the way out and restored on the way in', async () => {
  const { leadsToCsv, planImport, normalizeLead } = await load('src/domain/leads.js');
  const leads = [
    { id: 'a', name: 'Smith, Jo "JJ"', company: '=HYPERLINK("http://evil","x")', role: '+1 cmd', email: 'jo@acme.io', why: 'line one\nline two, with comma', notes: '@SUM(A1)', list: 'L', goal: 'advice', product: 'P', profileUrl: '' },
    { id: 'b', name: ' padded ', company: '-2+3', role: '', email: '', why: '', notes: '', list: '', goal: '', product: '', profileUrl: '' },
  ];
  const csv = leadsToCsv(leads);
  assert.ok(csv.includes("'=HYPERLINK") && csv.includes("'+1 cmd") && csv.includes("'@SUM(A1)") && csv.includes("'-2+3"), 'no cell can start with = + - @');
  const back = planImport(csv, []);
  assert.deepEqual(back.adds.map(l => [l.name, l.company, l.role, l.email, l.why, l.notes, l.list, l.goal, l.product]),
    [['Smith, Jo "JJ"', '=HYPERLINK("http://evil","x")', '+1 cmd', 'jo@acme.io', 'line one\nline two, with comma', '@SUM(A1)', 'L', 'advice', 'P'], ['padded', '-2+3', '', '', '', '', '', '', '']]);
  assert.equal(normalizeLead(null), null); assert.equal(normalizeLead({ name: 'no id' }), null);
  assert.deepEqual(normalizeLead({ id: 'x', name: 5, goal: 'bogus', extra: { keep: true } }), { id: 'x', name: '5', company: '', role: '', email: '', profileUrl: '', why: '', product: '', goal: '', list: '', notes: '', source: 'manual', createdAt: 0, extra: { keep: true } });
});

test('progress comes from the drafts written to a lead, and filters combine', async () => {
  const { leadProgress, filterLeads } = await load('src/domain/leads.js');
  const leads = [{ id: 'a', name: 'Ada', company: 'PipeCo', list: 'Q4' }, { id: 'b', name: 'Bo', company: 'BoCo', list: 'Q4' }, { id: 'c', name: 'Cy', company: 'CyCo', list: '' }];
  const emails = [{ status: 'draft', recipient: { leadId: 'a' } }, { status: 'sent', recipient: { leadId: 'a' } }, { status: 'draft', recipient: { leadId: 'b' } }, { status: 'replied', recipient: { leadId: 'zzz' } }, { status: 'sent', recipient: {} }];
  assert.deepEqual(leads.map(l => leadProgress(l, emails)), ['sent', 'draft', 'none']);
  assert.deepEqual(filterLeads(leads, { list: 'Q4' }).map(l => l.id), ['a', 'b']);
  assert.deepEqual(filterLeads(leads, { list: '' }).map(l => l.id), ['c'], 'the empty list means "no list"');
  assert.deepEqual(filterLeads(leads, { progress: 'none', emails }).map(l => l.id), ['c']);
  assert.deepEqual(filterLeads(leads, { query: 'boco' }).map(l => l.id), ['b']);
  assert.deepEqual(filterLeads(leads, { query: 'q4', progress: 'sent', emails }).map(l => l.id), ['a']);
});

test('a column mapping turns any file layout into Cold\'s fields, and extra columns can be kept as extra fields', async () => {
  const L = await load('src/domain/leads.js');
  const csv = ['Who,Employer,Mail,Lead score,Region', 'Ana Ruiz,Acme,ana@acme.io,87,EMEA', 'Bo Lee,Beta,bo@beta.io,,APAC'].join('\n');
  // unmapped columns are not imported until chosen; nothing here is recognised as a name
  const first = L.planImport(csv, []);
  assert.equal(first.ok, false); assert.deepEqual(first.headers, ['Who', 'Employer', 'Mail', 'Lead score', 'Region']);
  assert.match(first.message, /Choose which column holds the name/);
  assert.deepEqual(first.samples.slice(0, 2), ['Ana Ruiz', 'Acme']);
  const p = L.planImport(csv, [], { mapping: ['name', 'company', 'email', 'x:Lead score', 'x:Region'] });
  assert.equal(p.ok, true); assert.equal(p.adds.length, 2);
  assert.deepEqual(p.adds[0].custom, { 'Lead score': '87', Region: 'EMEA' });
  assert.deepEqual(p.adds[1].custom, { Region: 'APAC' }, 'blank extra values are not stored');
  assert.equal(p.adds[0].company, 'Acme');
  // a field chosen twice keeps its first column and says so; first + last name join; unmapped columns are listed as ignored
  const q = L.planImport('A,B,C\nAda,Lovelace,x', [], { mapping: ['first', 'last', ''] });
  assert.equal(q.adds[0].name, 'Ada Lovelace'); assert.deepEqual(q.ignored, ['C']);
  const r = L.planImport('A,B\nAda,Bob', [], { mapping: ['name', 'name'] });
  assert.deepEqual(r.repeated, ['name']); assert.equal(r.adds[0].name, 'Ada');
  // extra fields are cleaned, kept through save/load, searchable and exported; exported files re-import into the same extra fields
  assert.deepEqual(L.cleanCustom({ ' a  b ': ' 1 ', empty: '  ', n: 5, o: { x: 1 }, __proto__: 'x' }), { 'a b': '1', n: '5' });
  const leads = p.adds.map(a => L.normalizeLead(a));
  assert.deepEqual(L.customNames(leads), ['Lead score', 'Region']);
  assert.equal(L.filterLeads(leads, { query: 'apac' }).length, 1);
  const out = L.leadsToCsv(leads);
  assert.match(out.split('\r\n')[0], /,notes,Lead score,Region$/);
  const again = L.planImport(out, leads, { duplicates: 'update' });
  assert.deepEqual(again.mapping.slice(-2), ['x:Lead score', 'x:Region']); assert.equal(again.updates.length + again.unchanged, 2);
  const upd = L.planImport('name,email,Region\nAna Ruiz,ana@acme.io,LATAM', leads, { duplicates: 'update' });
  assert.deepEqual(upd.updates[0].next.custom, { 'Lead score': '87', Region: 'LATAM' });
});
