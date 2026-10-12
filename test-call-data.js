'use strict';
/*
 * Pulsar Call Data - API tests against a real Postgres.
 * Run: TEST_DATABASE_URL=... node test-call-data.js   (see CLAUDE.md test notes)
 * Exercises the schema block from db.js verbatim, the chunked import, the
 * merge/upsert semantics, filters, export, summary, and the SQL guard.
 */
var fs = require('fs');
var path = require('path');
var express = require('express');
var Module = require('module');
var { Pool } = require('pg');
// Self-contained like test-revenue-report.js: the route's requires are
// intercepted, the pool points at PGURL, and the schema is read straight out
// of db.js (the "Pulsar Call Data" block) so the test exercises the real DDL.
//   PGURL=postgres://tester@/nova?host=/tmp/pgs&port=55432 node <this file>
var pool = new Pool({ connectionString: process.env.PGURL });
var auth = { _cur: { user: { id: 1, name: 'Tony McKeon', role: 'admin' }, perms: [] } };
auth.requireAuth = function (req, res, next) { req.user = auth._cur.user; next(); };
auth.requirePermission = function (p) { return function (req, res, next) {
  var u = auth._cur.user;
  if (u.role === 'admin' || u.role === 'owner' || auth._cur.perms.indexOf(p) !== -1) return next();
  res.status(403).json({ error: 'Forbidden' }); }; };
var _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return { pool: pool };
  if (request === '../middleware/auth') return auth;
  if (request === '../utils/audit') return { logAudit: async function () {} };
  if (request === '../utils/permissions') return { hasPermission: async function (role, p) {
    return role === 'admin' || role === 'owner' || auth._cur.perms.indexOf(p) !== -1; } };
  return _origLoad.apply(this, arguments);
};
var CD = require('./utils/callDataCsv');

var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

async function schema() {
  var src = fs.readFileSync(process.env.DB_JS || path.join(__dirname, 'db.js'), 'utf8');
  var a = src.indexOf('// --- Pulsar Call Data');
  var b = src.indexOf('// --- end Pulsar Call Data');
  if (a < 0 || b < 0) throw new Error('schema markers not found');
  var block = src.slice(a, b);
  var fn = new Function('client', 'return (async function(){' + block + '})();');
  await pool.query('DROP TABLE IF EXISTS cd_calls, cd_columns, cd_imports, users, settings CASCADE');
  await pool.query("CREATE TABLE users (id int, extra_perms jsonb, password_hash text); CREATE TABLE settings (k text)");
  await fn(pool);
  await fn(pool);                                  // idempotent on restart
}

var H = ['Call UID', 'DT Complete', 'Location', 'Task', 'Tech ID', 'Status', 'Account', 'ATA (mins)',
  'Onsite (mins)', 'GPS Lat', 'GPS Lon', 'Car Make', 'Collected Cash', 'Collected Check', 'Collected CC', 'Collected Account', ''];

function mk(i, over) {
  var locs = ['Orlando', 'Tampa', 'Birmingham'];
  var r = {
    'Call UID': 'U' + i, 'DT Complete': '9/' + (1 + (i % 28)) + '/2026 ' + (1 + (i % 12)) + ':05:00 ' + (i % 2 ? 'PM' : 'AM'),
    'Location': locs[i % 3], 'Task': ['GEICO.CDU', 'ago.Jump', 'AL.Bus.LS', 'RP.Bat'][i % 4],
    'Tech ID': 'Tech, ' + (i % 5), 'Status': i % 10 === 0 ? 'GOA' : (i % 13 === 0 ? 'Canceled' : 'Completed'),
    'Account': i % 2 ? 'GEICO' : 'Agero', 'ATA (mins)': String(20 + (i % 40)), 'Onsite (mins)': '',
    'GPS Lat': '28.5', 'GPS Lon': '-81.3', 'Car Make': 'Chev', 'Collected Cash': '$10.00',
    'Collected Check': '', 'Collected CC': '($2.50)', 'Collected Account': '$1,000.00', '': ''
  };
  return Object.assign(r, over || {});
}

async function main() {
  // ---- pure helpers
  eq(CD.parseWhen('9/13/2026 4:07:11 PM'), '2026-09-13 16:07:11', 'parseWhen PM');
  eq(CD.parseWhen('9/13/2026 12:07:11 AM'), '2026-09-13 00:07:11', 'parseWhen 12 AM');
  eq(CD.parseWhen('9/13/2026'), '2026-09-13 00:00:00', 'parseWhen date only');
  eq(CD.parseWhen('2026-09-13 16:07'), '2026-09-13 16:07:00', 'parseWhen ISO');
  eq(CD.parseWhen('2/31/2026'), null, 'parseWhen rejects 2/31');
  eq(CD.parseWhen(''), null, 'parseWhen blank');
  eq(CD.money('($25.00)'), -25, 'money negative');
  eq(CD.money('$1,234.56'), 1234.56, 'money commas');
  eq(CD.money(''), null, 'money blank is null');
  eq(CD.minutes('1:05'), 65, 'minutes h:mm');
  eq(CD.minutes('45'), 45, 'minutes plain');
  var m = CD.detectColumns(H);
  eq([m.uid, m.when, m.location, m.task, m.tech, m.status, m.account, m.ata, m.onsite],
    ['Call UID', 'DT Complete', 'Location', 'Task', 'Tech ID', 'Status', 'Account', 'ATA (mins)', 'Onsite (mins)'], 'detectColumns');
  eq(m.money, ['Collected Cash', 'Collected Check', 'Collected CC', 'Collected Account'], 'detect money cols');
  eq(CD.detectColumns(['call uid', 'DT Received', 'dt complete']).when, 'dt complete', 'DT Complete beats DT Received');
  var it = CD.interpret(mk(1), m);
  eq(it.revenue, 1007.5, 'revenue sums collected incl negative');
  ok(!('' in it.data), 'blank-header column dropped');
  eq(it.data['Onsite (mins)'], '', 'empty cell kept as ""');
  eq(it.onsite_mins, null, 'empty onsite -> null');

  await schema();
  var app = express();
  app.use(express.json({ limit: '80mb' }));
  app.use('/api/call-data', require('./routes/callData'));
  var srv = app.listen(0);
  var base = 'http://127.0.0.1:' + srv.address().port + '/api/call-data';
  async function call(method, p, body) {
    var r = await fetch(base + p, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    var t = await r.text(); var d; try { d = JSON.parse(t); } catch (e) { d = t; }
    return { status: r.status, data: d };
  }
  async function importRows(rows, headers, name) {
    var o = await call('POST', '/imports', { filename: name || 'a.csv', columns: headers || H, total_rows: rows.length });
    if (o.status !== 201) return o;
    var tot = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
    for (var i = 0; i < rows.length; i += 2000) {
      var b = await call('POST', '/imports/' + o.data.id + '/rows', { rows: rows.slice(i, i + 2000) });
      if (b.status !== 200) return b;
      Object.keys(tot).forEach(function (k) { tot[k] += b.data[k]; });
    }
    var f = await call('POST', '/imports/' + o.data.id + '/finish', {});
    tot.finish = f.data; tot.id = o.data.id;
    return tot;
  }

  // ---- empty store
  var meta = await call('GET', '/meta');
  eq(meta.status, 200, 'meta 200 on empty store');
  eq(meta.data.calls, 0, 'empty count');

  // ---- refuse a file without Call UID
  var bad = await call('POST', '/imports', { filename: 'x.csv', columns: ['DT Complete', 'Location'], total_rows: 1 });
  eq(bad.status, 400, 'no Call UID -> 400');
  ok(/Call UID/.test(bad.data.error), 'error names Call UID');

  // ---- big first import: 5,200 rows across 3 batches, plus a blank uid and an in-file duplicate
  var rows = [];
  for (var i = 1; i <= 5200; i++) rows.push(mk(i));
  rows.push(mk(9999, { 'Call UID': '' }));
  rows.push(mk(7, { 'Account': 'DUPLICATE-LATER' }));   // same batch? row 7 is in batch 1, this lands in batch 3
  var r1 = await importRows(rows);
  eq([r1.inserted, r1.skipped], [5200, 1], 'first import inserts 5200, skips blank uid');
  eq(r1.updated, 1, 'cross-batch duplicate counts as one update');
  eq(r1.finish.status, 'done', 'import finished');
  eq([r1.finish.first_date, r1.finish.last_date], ['2026-09-01', '2026-09-28'], 'import date range');
  var c = await pool.query('SELECT COUNT(*)::int n FROM cd_calls');
  eq(c.rows[0].n, 5200, 'one row per Call UID');
  var u7 = await pool.query("SELECT account FROM cd_calls WHERE call_uid='U7'");
  eq(u7.rows[0].account, 'DUPLICATE-LATER', 'later row wins');

  // ---- re-import same file: nothing changes
  var r2 = await importRows(rows);
  // U7 is in this file twice with different values, so it legitimately flips
  // back and forth (2 updates). Every other call is untouched.
  eq([r2.inserted, r2.updated, r2.unchanged], [0, 2, 5199], 're-import changes nothing but the in-file duplicate');
  // ---- correction: overlapping export with 3 calls changed + 2 new
  var corr = [mk(10, { 'Status': 'Completed', 'Collected Cash': '$50.00' }), mk(11), mk(12, { 'ATA (mins)': '99' }), mk(6001), mk(6002)];
  var r3 = await importRows(corr);
  eq([r3.inserted, r3.updated, r3.unchanged], [2, 2, 1], 'correction: 2 new, 2 changed, 1 unchanged');
  var u10 = await pool.query("SELECT status, revenue FROM cd_calls WHERE call_uid='U10'");
  eq([u10.rows[0].status, Number(u10.rows[0].revenue)], ['Completed', 1047.5], 'corrected call overwrote');

  // ---- different layout merges into the same record
  var H2 = ['Call UID', 'Invoice', 'Pay Period'];
  var r4 = await importRows([{ 'Call UID': 'U20', 'Invoice': 'INV-20', 'Pay Period': '9/7/2026' }], H2, 'b.csv');
  eq([r4.inserted, r4.updated], [0, 1], 'new layout updates existing call');
  var u20 = await pool.query("SELECT data, location, call_date FROM cd_calls WHERE call_uid='U20'");
  eq(u20.rows[0].data['Invoice'], 'INV-20', 'new column merged in');
  eq(u20.rows[0].data['Location'], 'Birmingham', 'old columns kept');
  eq(u20.rows[0].location, 'Birmingham', 'typed field kept when new file lacks it');
  ok(u20.rows[0].call_date != null, 'date kept when new file lacks it');

  meta = await call('GET', '/meta');
  eq(meta.data.calls, 5202, 'meta count');
  ok(meta.data.columns.indexOf('Invoice') !== -1 && meta.data.columns.indexOf('GPS Lat') !== -1, 'meta lists union of columns');
  eq(meta.data.columns[0], 'Call UID', 'columns keep export order');
  ok(meta.data.columns.indexOf('') === -1, 'blank header not registered');
  eq(meta.data.locations.length, 3, 'meta locations');
  ok(meta.data.imports.length === 4 && meta.data.canImport && meta.data.canSql, 'meta imports + flags');

  // ---- rows + filters
  var rr = await call('GET', '/rows?limit=10&location=Tampa&status=goa');
  var exp = await pool.query("SELECT COUNT(*)::int n FROM cd_calls WHERE location='Tampa' AND lower(status)='goa'");
  eq(rr.data.total, exp.rows[0].n, 'location+status filter count');
  ok(rr.data.rows.length <= 10 && rr.data.rows.every(function (x) { return x.data.Location === 'Tampa'; }), 'rows honor filter');
  rr = await call('GET', '/rows?from=2026-09-05&to=2026-09-05');
  exp = await pool.query("SELECT COUNT(*)::int n FROM cd_calls WHERE call_date='2026-09-05'");
  eq(rr.data.total, exp.rows[0].n, 'date filter');
  rr = await call('GET', '/rows?q=INV-20');
  eq(rr.data.total, 1, 'free text search');
  rr = await call('GET', '/rows?col=Invoice&op=notempty');
  eq(rr.data.total, 1, 'column notempty');
  rr = await call('GET', '/rows?col=Car%20Make&op=equals&val=chev');
  eq(rr.data.total, 5202, 'column equals, case-insensitive');
  rr = await call('GET', '/rows?sort=ATA%20(mins)&dir=desc&limit=1');
  eq(rr.status, 200, 'sort by export column works');
  rr = await call('GET', '/rows?sort=ata_mins&dir=desc&limit=1');
  eq(rr.data.rows[0].call_uid, 'U12', 'sort by typed ATA');
  rr = await call('GET', "/rows?sort=x');drop table cd_calls;--");
  eq(rr.status, 200, 'hostile sort key is just a parameter');
  rr = await call('GET', '/rows?limit=99999');
  eq(rr.data.limit, 500, 'limit capped');

  // ---- export
  var ex = await fetch(base + '/export?location=Birmingham');
  var txt = await ex.text();
  var lines = txt.trim().split('\r\n');
  exp = await pool.query("SELECT COUNT(*)::int n FROM cd_calls WHERE location='Birmingham'");
  eq(lines.length - 1, exp.rows[0].n, 'export row count = filtered count');
  ok(lines[0].replace('﻿', '').split(',')[0] === 'Call UID', 'export header first col');
  ok(/"Tech, \d"/.test(txt), 'export quotes commas');
  var full = await (await fetch(base + '/export')).text();
  eq(full.trim().split('\r\n').length - 1, 5202, 'full export spans >1 keyset page');

  // ---- summary
  var s = await call('GET', '/summary?group=none&by=location');
  var sumCalls = s.data.rows.reduce(function (a, x) { return a + x.calls; }, 0);
  eq(sumCalls, 5202, 'summary calls add up');
  var db = await pool.query("SELECT ROUND(SUM(revenue),2)::float8 r, percentile_cont(0.5) WITHIN GROUP (ORDER BY ata_mins) FILTER (WHERE ata_mins>0) m FROM cd_calls WHERE location='Orlando'");
  var orl = s.data.rows.filter(function (x) { return x.key === 'Orlando'; })[0];
  eq(orl.revenue, db.rows[0].r, 'summary revenue matches SQL');
  eq(orl.ata_median, Math.round(db.rows[0].m * 10) / 10, 'summary median ATA');
  s = await call('GET', '/summary?group=week&by=service');
  ok(s.data.rows.some(function (x) { return x.key === 'Locksmith'; }) && s.data.rows.some(function (x) { return x.key === 'Battery'; }), 'service classes');
  ok(s.data.rows.every(function (x) { return /^2026-(08|09)-\d\d$/.test(x.period); }), 'week periods are dates');
  var mon = s.data.rows.map(function (x) { return new Date(x.period + 'T00:00:00Z').getUTCDay(); });
  ok(mon.every(function (d) { return d === 1; }), 'weeks start Monday');
  s = await call('GET', '/summary?group=none&by=col&byCol=Car%20Make');
  ok(s.data.rows.some(function (x) { return x.key === 'Chev'; }), 'summary by any export column');
  s = await call('GET', '/summary?group=none&by=dow');
  ok(s.data.rows.length === 7 || s.data.rows.length > 0, 'summary by day of week');
  s = await call('GET', '/summary?group=none&by=status');
  var st = {}; s.data.rows.forEach(function (x) { st[x.key] = x; });
  eq(st.GOA.goa, st.GOA.calls, 'GOA counter');

  // ---- sql
  var q1 = await call('POST', '/sql', { sql: "SELECT location, COUNT(*) n FROM cd_calls GROUP BY 1 ORDER BY 1;" });
  eq(q1.status, 200, 'sql select ok');
  eq(q1.data.columns, ['location', 'n'], 'sql columns');
  var q2 = await call('POST', '/sql', { sql: "SELECT * FROM users" });
  eq(q2.status, 400, 'sql blocks other tables');
  var q3 = await call('POST', '/sql', { sql: "SELECT 1; DELETE FROM cd_calls" });
  eq(q3.status, 400, 'sql blocks two statements');
  var q4 = await call('POST', '/sql', { sql: "DELETE FROM cd_calls" });
  eq(q4.status, 400, 'sql blocks delete');
  var q5 = await call('POST', '/sql', { sql: "SELECT pg_read_file('x')" });
  eq(q5.status, 400, 'sql blocks pg_ functions');
  var q6 = await call('POST', '/sql', { sql: "WITH x AS (DELETE FROM cd_calls RETURNING 1) SELECT * FROM x" });
  eq(q6.status, 400, 'sql: data-modifying CTE refused by read-only tx');
  c = await pool.query('SELECT COUNT(*)::int n FROM cd_calls');
  eq(c.rows[0].n, 5202, 'nothing deleted by hostile sql');
  var q7 = await call('POST', '/sql', { sql: "SELECT * FROM cd_calls" });
  ok(q7.data.truncated === true && q7.data.rows.length === 2000, 'sql row cap');
  var q8 = await call('POST', '/sql', { sql: 'SELECT * FROM public."settings"' });
  eq(q8.status, 400, 'sql blocks quoted/qualified other table');
  var q9 = await call('POST', '/sql', { sql: "SELECT data->>'Car Make' mk, COUNT(*) FROM cd_calls GROUP BY 1" });
  eq(q9.status, 200, 'sql JSON access ok');

  // ---- permissions
  auth._cur.user = { id: 2, name: 'Mgr', role: 'manager' };
  auth._cur.perms = [];
  eq((await call('GET', '/meta')).status, 403, 'no perm -> 403');
  auth._cur.perms = ['view_call_data'];
  var mm = await call('GET', '/meta');
  eq([mm.status, mm.data.canImport, mm.data.canSql], [200, false, false], 'viewer flags');
  eq((await call('POST', '/imports', { columns: H })).status, 403, 'viewer cannot import');
  eq((await call('POST', '/sql', { sql: 'SELECT 1' })).status, 403, 'manager cannot sql');
  auth._cur.perms = ['view_call_data', 'manage_call_data'];
  eq((await call('POST', '/imports', { columns: H, filename: 'm.csv' })).status, 201, 'manage can import');

  // finished import refuses more rows
  var fin = await call('POST', '/imports/' + r1.id + '/rows', { rows: [mk(1)] });
  eq(fin.status, 409, 'finished import refuses rows');
  var big = await call('POST', '/imports/' + r1.id + '/rows', { rows: new Array(2001).fill(mk(1)) });
  eq(big.status, 400, 'batch size capped');

  srv.close();
  await pool.end();
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
