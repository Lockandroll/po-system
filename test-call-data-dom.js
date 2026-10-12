'use strict';
/*
 * Pulsar Call Data - DOM test. Loads public/js/callData.js into jsdom, wires
 * api() to the real route over HTTP against a real Postgres, and drives the
 * page: empty state, CSV parse, chunked import, browse/filter/sort/paging,
 * column picker, summary, SQL, and the viewer-only tab set.
 */
var fs = require('fs');
var path = require('path');
var express = require('express');
var { JSDOM } = require('jsdom');
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

var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, ms) { var t = Date.now(); while (Date.now() - t < (ms || 8000)) { if (fn()) return true; await sleep(30); } return false; }

async function main() {
  var src = fs.readFileSync(process.env.DB_JS || path.join(__dirname, 'db.js'), 'utf8');
  var block = src.slice(src.indexOf('// --- Pulsar Call Data'), src.indexOf('// --- end Pulsar Call Data'));
  await pool.query('DROP TABLE IF EXISTS cd_calls, cd_columns, cd_imports CASCADE');
  await (new Function('client', 'return (async function(){' + block + '})();'))(pool);

  var app = express();
  app.use(express.json({ limit: '80mb' }));
  app.use('/api/call-data', require('./routes/callData'));
  var srv = app.listen(0);
  var base = 'http://127.0.0.1:' + srv.address().port;

  var dom = new JSDOM('<!doctype html><html><head></head><body><div id="content"></div></body></html>', { runScripts: 'outside-only', url: base + '/' });
  var w = dom.window;
  var calls = [];
  w.state = { token: 't', user: { role: 'admin' } };
  w.escHtml = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
  w.toasts = [];
  w.showToast = function (m, t) { w.toasts.push([m, t]); };
  w.apiBustCache = function () {};
  w.api = async function (method, p, body) {
    calls.push(method + ' ' + p);
    var r = await fetch(base + '/api' + p, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  };
  w.fetch = function (u, o) { return fetch(new URL(u, base).href, o); };
  w.eval(fs.readFileSync(path.join(__dirname, 'public/js/callData.js'), 'utf8'));
  var doc = w.document;
  var content = doc.getElementById('content');

  await w.renderCallData(content);
  ok(/Nothing here yet/.test(content.textContent), 'empty state message');
  ok(doc.querySelectorAll('.cd-tab').length === 4, 'admin sees 4 tabs');

  // ---- parser
  var csv = '﻿Call UID,DT Complete,Location,Task,Tech ID,Status,ATA (mins),Notes,Collected Cash,\r\n';
  for (var i = 1; i <= 2500; i++) {
    csv += 'U' + i + ',9/' + (1 + i % 28) + '/2026 3:0' + (i % 10) + ':00 PM,' + ['Orlando', 'Tampa'][i % 2] + ',ago.Jump,"Doe, J' + (i % 4) + '",' +
      (i % 9 ? 'Completed' : 'GOA') + ',' + (10 + i % 50) + ',"line one\nline ""two""",$5.00,\r\n';
  }
  var grid = w.cdParseCsv(csv);
  ok(grid.length === 2501, 'parser row count (got ' + grid.length + ')');
  ok(grid[0][0] === 'Call UID', 'parser strips BOM');
  ok(grid[1][4] === 'Doe, J1', 'parser quoted comma');
  ok(grid[1][7] === 'line one\nline "two"', 'parser embedded newline + doubled quote');

  // ---- no Call UID refused client-side
  w.cdGo('import');
  w._cdFile = { name: 'bad.csv', headers: ['Location', 'Task'], rows: [['a', 'b']] };
  w.cdDrawFilePreview();
  ok(/no Call UID column/.test(doc.getElementById('cd-imp').textContent), 'preview refuses file without Call UID');

  // ---- import
  w._cdFile = { name: 'calls.csv', headers: grid[0].map(function (h) { return h.trim(); }), rows: grid.slice(1) };
  w.cdDrawFilePreview();
  ok(/2,500 rows/.test(doc.getElementById('cd-imp').textContent), 'preview counts rows');
  await w.cdRunImport();
  ok(/2,500 new calls/.test(doc.getElementById('cd-imp').textContent), 'import result shown');
  ok(calls.filter(function (c) { return /\/rows$/.test(c); }).length === 3, 'posted in 3 batches of 1,000');
  ok(/2,500/.test(doc.getElementById('cd-cards').textContent), 'card shows count');
  ok(doc.querySelectorAll('#cd-imp ~ * table tbody tr, .table-container tbody tr').length >= 1, 'import history row');

  // re-import is all unchanged
  w._cdFile = { name: 'calls.csv', headers: grid[0].map(function (h) { return h.trim(); }), rows: grid.slice(1) };
  await w.cdRunImport();
  ok(/0 new calls, 0 changed, 2,500 unchanged/.test(doc.getElementById('cd-imp').textContent), 're-import unchanged');

  // ---- browse
  w.cdGo('browse');
  await until(function () { return doc.querySelector('.cd-tbl tbody tr td'); });
  ok(/2,500 calls match/.test(doc.getElementById('cd-count').textContent), 'browse count');
  var ths = Array.from(doc.querySelectorAll('.cd-tbl th')).map(function (t) { return t.getAttribute('data-col'); });
  ok(ths[0] === 'Call UID' && ths.indexOf('') === -1, 'browse columns in export order, no blank header');
  ok(doc.querySelectorAll('.cd-tbl tbody tr').length === 50, '50 rows a page');
  doc.getElementById('cdf-location').value = 'Tampa';
  doc.getElementById('cdf-status').value = 'GOA';
  w.cdApplyBrowse();
  await until(function () { return /calls match/.test(doc.getElementById('cd-count').textContent) && !/2,500/.test(doc.getElementById('cd-count').textContent); });
  var n = (await pool.query("SELECT COUNT(*)::int n FROM cd_calls WHERE location='Tampa' AND status='GOA'")).rows[0].n;
  ok(doc.getElementById('cd-count').textContent.indexOf(String(n)) === 0, 'filtered count matches db (' + n + ')');
  // sort by ATA uses the typed column
  w.cdClearFilters();
  await until(function () { return doc.querySelector('.cd-tbl th'); });
  w.cdSortBy('ATA (mins)');
  await until(function () { return calls.some(function (c) { return /sort=ata_mins&dir=asc/.test(c); }); });
  ok(calls.some(function (c) { return /sort=ata_mins/.test(c); }), 'ATA header sorts on typed ata_mins');
  await until(function () { return /&#9650;|▲/.test(doc.querySelector('.cd-tbl thead').innerHTML); });
  ok(/▲/.test(doc.querySelector('.cd-tbl thead').textContent), 'sort arrow shows on the ATA header');
  // paging
  w.cdPageTo(2);
  await until(function () { return /Page 2 of/.test(doc.getElementById('cd-grid').textContent); });
  ok(/Page 2 of 50/.test(doc.getElementById('cd-grid').textContent), 'paging');
  // column picker
  w.cdPickCols();
  w.cdColsAll(false);
  doc.querySelector('#cd-cols input[value="Notes"]').checked = true;
  doc.getElementById('cd-modal-ok').click();
  await until(function () { var t = doc.querySelectorAll('.cd-tbl th'); return t.length === 1; });
  ok(doc.querySelectorAll('.cd-tbl th').length === 1 && doc.querySelector('.cd-tbl th').getAttribute('data-col') === 'Notes', 'column picker');
  ok(JSON.parse(w.localStorage.getItem('nova_cd_cols'))[0] === 'Notes', 'columns remembered');

  // ---- summary
  w.cdGo('summary');
  await until(function () { var b = doc.getElementById('cd-sum'); return b && b.querySelector('table'); });
  var body = doc.getElementById('cd-sum').textContent;
  ok(/Orlando/.test(body) && /Tampa/.test(body), 'summary by location');
  doc.getElementById('cds-by').value = 'col';
  w.cdApplySummary();
  await until(function () { return doc.getElementById('cds-col'); });
  ok(!!doc.getElementById('cds-col'), 'pick-a-column summary shows column select');
  doc.getElementById('cds-col').value = 'Tech ID';
  w.cdApplySummary();
  await until(function () { return /Doe, J2/.test((doc.getElementById('cd-sum') || {}).textContent || ''); });
  ok(/Doe, J2/.test(doc.getElementById('cd-sum').textContent), 'summary by any export column');

  // ---- sql
  w.cdGo('sql');
  doc.getElementById('cd-sql-text').value = "SELECT data->>'Tech ID' AS tech, COUNT(*) AS n FROM cd_calls GROUP BY 1 ORDER BY 1";
  await w.cdRunSql();
  ok(doc.querySelectorAll('#cd-sql-out tbody tr').length === 4, 'sql result rows');
  doc.getElementById('cd-sql-text').value = 'SELECT * FROM users';
  await w.cdRunSql();
  ok(/Only the call data tables|outside/.test(doc.getElementById('cd-sql-out').textContent) || /not one of them/.test(doc.getElementById('cd-sql-out').textContent) || /does not exist/.test(doc.getElementById('cd-sql-out').textContent), 'sql error shown');

  // ---- viewer sees only Browse + Summary
  auth._cur.user = { id: 5, name: 'Viewer', role: 'manager' };
  auth._cur.perms = ['view_call_data'];
  w._cdTab = 'import';
  await w.renderCallData(content);
  var tabs = Array.from(doc.querySelectorAll('.cd-tab')).map(function (t) { return t.textContent; });
  ok(tabs.join(',') === 'Browse,Summary', 'viewer tabs (got ' + tabs.join(',') + ')');

  srv.close();
  await pool.end();
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
