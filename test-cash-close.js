// test-cash-close.js - Weekly Cash Close end-to-end check (2026-09-27).
// Mounts the real deposits / pulsar / cash-close routers behind the real
// requireAuth and drives them over HTTP with real JWTs.
// RUN ONLY AGAINST A THROWAWAY POSTGRES (it creates users, deposits, imports):
//   DATABASE_URL=postgres://...scratch... node -e "require('./db').initDB()" && node test-cash-close.js
process.env.JWT_SECRET = 'x';
var express = require('express'); var jwt = require('jsonwebtoken'); var ExcelJS = require('exceljs');
var { pool } = require('./db');
var pass = 0, fail = 0;
function ok(c, m, extra) { if (c) pass++; else { fail++; console.log('FAIL', m, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } }
async function main() {
  await pool.query("INSERT INTO cities (name, code) VALUES ('Orlando','ORL'),('Tampa','TPA') ON CONFLICT (code) DO NOTHING");
  async function mk(name, role, extra) {
    return (await pool.query("INSERT INTO users (name, email, password_hash, role, active, extra_perms) VALUES ($1,$2,'x',$3,true,$4) RETURNING id",
      [name, name.replace(/ /g, '') + Math.random() + '@t.t', role, extra || []])).rows[0].id;
  }
  var A = await mk('Ada Admin', 'admin'); var M = await mk('Mo Manager', 'manager'); var M2 = await mk('Max Manager', 'manager', ['weekly_cash_close']);
  await pool.query("INSERT INTO user_cities (user_id, city_code) VALUES ($1,'ORL')", [M2]);
  var J = await mk('Jordan Reyes', 'locksmith'); var C = await mk('Casey Nguyen', 'roadside_technician'); var P = await mk('Pat Quinn', 'locksmith'); var X = await mk('Xavier Stone', 'locksmith');
  function tok(id, role) { return jwt.sign({ id: id, role: role }, 'x'); }
  var TA = tok(A, 'admin'), TM = tok(M, 'manager'), TM2 = tok(M2, 'manager'), TJ = tok(J, 'locksmith');
  var app = express(); app.use(express.json({ limit: '20mb' }));
  app.use('/api/deposits', require('./routes/deposits')); app.use('/api/pulsar', require('./routes/pulsar')); app.use('/api/cash-close', require('./routes/cashClose'));
  var srv = app.listen(0); var base = 'http://127.0.0.1:' + srv.address().port + '/api';
  async function call(m, p, t, b) {
    var r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined });
    var j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j: j };
  }
  var PW = '2026-09-07', W = '2026-09-14';
  var H = 'Call UID,Tech ID,Pay Period,Task,Location,Collected Cash,Collected Tax,Status,Invoice';
  function row(uid, tech, date, task, loc, cash, tax) { return [uid, '"' + tech + '"', date + ' 12:00:00 AM', task, loc, cash, tax, 'Completed', 'I' + uid].join(','); }

  // --- gates
  ok((await call('GET', '/cash-close/week/' + W, TM)).s === 403, 'manager w/o perm blocked');
  ok((await call('GET', '/cash-close/week/' + W, TJ)).s === 403, 'tech blocked');
  ok((await call('GET', '/cash-close/week/2026-09-15', TA)).s === 400, 'non-Monday rejected');
  var cats = await call('GET', '/cash-close/categories', TJ); ok(cats.s === 200 && cats.j.categories.length === 7 && cats.j.classes.length === 3, 'categories for anyone with view_deposits', cats.j);

  // --- mapping
  var cfgR = await call('GET', '/cash-close/config', TM2); ok(cfgR.s === 200 && !cfgR.j.can_edit && cfgR.j.problems.length >= 4, 'mgr reads config', cfgR.j.problems);
  ok((await call('PUT', '/cash-close/config', TM2, { config: {} })).s === 403, 'mgr cannot edit config');
  var cfg = cfgR.j.config;
  cfg.bank_account = 'Checking'; cfg.over_short_account = 'Cash Over and Short'; cfg.held_account = 'Cash Held by Techs'; cfg.tax_account = 'Sales Tax Payable:FL';
  cfg.city_tax_accounts = { TPA: 'Sales Tax Payable:FL Hillsborough' };
  cfg.income_accounts = { Locksmith: 'Sales:Locksmith', Roadside: 'Sales:Roadside', Dispatch: 'Sales:Dispatch' };
  cfg.categories[0].account = 'Auto:Fuel'; cfg.categories[1].account = 'COGS:Parts';
  var sv = await call('PUT', '/cash-close/config', TA, { config: cfg }); ok(sv.s === 200 && sv.j.problems.length === 0, 'admin saves mapping', sv.j);

  // --- week P import: strict missing column
  var bad = 'Call UID,Tech ID,Pay Period,Task,Location,Collected Cash,Status\n' + '1,"Quinn, Pat",9/8/2026 12:00:00 AM,JS,Orlando,50,Completed';
  var pv = await call('POST', '/pulsar/preview', TM2, { csv: bad, strict: true });
  ok(pv.s === 400 && /Collected Tax/.test(pv.j.error) && /Weekly Cash Close/.test(pv.j.error), 'strict preview names missing column', pv.j);
  var pvLoose = await call('POST', '/pulsar/preview', TM2, { csv: bad });
  ok(pvLoose.s === 200, 'non-strict still accepts (verification card unchanged)', pvLoose.j && pvLoose.j.error);

  // week P via XLSX
  var wb = new ExcelJS.Workbook(); var ws = wb.addWorksheet('Calls');
  ws.addRow(['Call UID', 'Tech ID', 'Pay Period', 'Task', 'Location', 'Collected Cash', 'Collected Tax', 'Status']);
  ws.addRow(['P1', 'Quinn, Pat', new Date(Date.UTC(2026, 8, 8)), 'JS', 'Orlando', 50, 0, 'Completed']);
  ws.addRow(['P2', 'Reyes, Jordan', new Date(Date.UTC(2026, 8, 9)), 'Rekey.LS', 'Orlando', 100, 6.54, 'Completed']);
  var xb64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  var px = await call('POST', '/pulsar/preview', TM2, { xlsx: xb64, strict: true, filename: 'p.xlsx' });
  ok(px.s === 200 && px.j.period.start === PW && px.j.meta.cashRows === 2 && px.j.required.length === 8, 'xlsx preview', px.j);
  var ix = await call('POST', '/pulsar/import', TM2, { xlsx: xb64, strict: true, filename: 'p.xlsx', period_start: PW });
  ok(ix.s === 201 && ix.j.cash_rows === 2, 'xlsx import', ix.j);
  // Jordan deposits for P, Pat nothing
  async function dep(num, uid, wk, date, amt, city, exps) {
    var d = (await pool.query("INSERT INTO deposits (deposit_number, user_id, user_name, city_code, amount, deposit_date, period_start, period_end, pulsar_owed) VALUES ($1,$2,'x',$3,$4,$5,$6,($6::date + 6),0) RETURNING id",
      [num, uid, city, amt, date, wk])).rows[0].id;
    for (var i = 0; i < (exps || []).length; i++) {
      var e = exps[i];
      e.id = (await pool.query('INSERT INTO deposit_expenses (deposit_id, description, amount, no_receipt, no_receipt_reason) VALUES ($1,$2,$3,true,$4) RETURNING id', [d, e.d, e.a, 'x'])).rows[0].id;
    }
    return d;
  }
  var dJP = await dep('DEP-2026-0100', J, PW, '2026-09-14', 100, 'ORL');
  var wkP = await call('GET', '/cash-close/week/' + PW, TM2);
  ok(wkP.s === 200 && wkP.j.units.length === 2, 'week P units', wkP.j.units && wkP.j.units.map(function (u) { return u.kind + u.user_name + u.problems; }));
  var cP = await call('POST', '/cash-close/week/' + PW + '/close', TM2);
  ok(cP.s === 400 && /reconciliation/.test(cP.j.error), 'close needs reconcile sign-off', cP.j);
  ok((await call('PUT', '/cash-close/week/' + PW + '/reconciled', TM2, { done: true })).s === 200, 'reconciled');
  cP = await call('POST', '/cash-close/week/' + PW + '/close', TM2);
  ok(cP.s === 200 && cP.j.entries === 2, 'close P', cP.j);
  var held = (await pool.query('SELECT * FROM cash_close_held')).rows;
  ok(held.length === 1 && held[0].user_id === P && parseFloat(held[0].amount) === 50, 'Pat held $50', held);

  // --- week W
  var csvW = [H,
    row('W1', 'Reyes, Jordan', '9/15/2026', 'Rekey.LS', 'Orlando', '200.00', '13.09'),
    row('W2', 'Reyes, Jordan', '9/16/2026', 'Car Key.LS', 'Orlando', '100.00', '6.54'),
    row('W3', 'Reyes, Jordan', '9/17/2026', 'JS', 'Orlando', '175.50', '11.48'),
    row('W4', 'Nguyen, Casey', '9/18/2026', 'CDU', 'Tampa', '95.00', '6.22'),
    row('W5', 'Nobody, Real', '9/18/2026', 'JS', 'Tampa', '40.00', '0')].join('\n');
  var iw = await call('POST', '/pulsar/import', TM2, { csv: csvW, strict: true, period_start: W });
  ok(iw.s === 201 && iw.j.cash_rows === 5, 'import W', iw.j);
  var dJ = await dep('DEP-2026-0412', J, W, '2026-09-21', 400, 'ORL', [{ d: 'Gas', a: 45.25 }, { d: 'Blanks', a: 30.25 }]);
  var dPl = await dep('DEP-2026-0413', P, PW, '2026-09-22', 45, 'ORL');   // late, for closed week P
  var dX = await dep('DEP-2026-0414', X, W, '2026-09-21', 20, 'ORL');      // no Pulsar cash
  var ex = (await pool.query('SELECT id, description FROM deposit_expenses WHERE deposit_id = $1 ORDER BY id', [dJ])).rows;

  var wk = await call('GET', '/cash-close/week/' + W, TM2);
  ok(wk.s === 200 && wk.j.status === 'open', 'week W loads');
  ok(wk.j.steps.imported && !wk.j.steps.names_tasks && !wk.j.steps.expenses && !wk.j.steps.reconciled, 'steps', wk.j.steps);
  ok(wk.j.unlinked.length === 1 && wk.j.unlinked[0].tech_raw === 'Nobody, Real', 'unlinked name', wk.j.unlinked);
  var cdu = wk.j.tasks.filter(function (t) { return t.task === 'CDU'; })[0];
  ok(cdu && !cdu.cls && cdu.group === 'Opening', 'CDU unmapped (Opening is Tony call)', wk.j.tasks);
  ok(wk.j.queue.length === 2 && wk.j.kpis.pending_expenses === 2, 'queue', wk.j.kpis);
  var kinds = {}; wk.j.units.forEach(function (u) { kinds[u.user_name] = u.kind; });
  ok(kinds['Jordan Reyes'] === 'normal' && kinds['Casey Nguyen'] === 'held' && kinds['Pat Quinn'] === 'late' && kinds['Xavier Stone'] === 'normal', 'unit kinds', kinds);
  var uX = wk.j.units.filter(function (u) { return u.user_name === 'Xavier Stone'; })[0];
  ok(uX.problems.some(function (p) { return /No Pulsar cash/.test(p); }), 'no-pulsar deposit flagged', uX.problems);
  ok(wk.j.kpis.pulsar_cash === 61050 && wk.j.kpis.no_deposit === 1 && wk.j.kpis.late_deposits === 1, 'kpis', wk.j.kpis);

  // --- expense review
  ok((await call('POST', '/deposits/' + dJ + '/expenses/' + ex[0].id + '/review', TJ, { status: 'approved', category: 'fuel', qbo_class: 'split' })).s === 403, 'tech cannot review');
  var r0 = await call('POST', '/deposits/' + dJ + '/expenses/' + ex[0].id + '/review', TM2, { status: 'approved' });
  ok(r0.s === 400 && /category/.test(r0.j.error), 'approve needs category', r0.j);
  var r1 = await call('POST', '/deposits/' + dJ + '/expenses/' + ex[0].id + '/review', TM2, { status: 'approved', category: 'fuel' });
  ok(r1.s === 400 && /class/.test(r1.j.error), 'approve needs class', r1.j);
  ok((await call('POST', '/deposits/' + dJ + '/expenses/' + ex[0].id + '/review', TM2, { status: 'approved', category: 'fuel', qbo_class: 'Bogus' })).s === 400, 'bad class');
  var r2 = await call('POST', '/deposits/' + dJ + '/expenses/' + ex[0].id + '/review', TM2, { status: 'approved', category: 'fuel', qbo_class: 'split' });
  ok(r2.s === 200 && r2.j.expenses[0].category === 'fuel' && r2.j.expenses[0].qbo_class === 'split', 'approve fuel split', r2.j && r2.j.expenses);
  var r3 = await call('POST', '/deposits/' + dJ + '/expenses/' + ex[1].id + '/review', TM2, { status: 'approved', category: 'parts', qbo_class: 'Locksmith' });
  ok(r3.s === 200, 'approve parts');

  // --- names + tasks
  var tm = await call('GET', '/pulsar/tech-map', TM2); var map = tm.j.map || {}; map['nobody, real'] = X;
  ok((await call('PUT', '/pulsar/tech-map', TM2, { map: map })).s === 200, 'link name');
  ok((await call('PUT', '/cash-close/task-class', TM2, { task: 'CDU', cls: 'Roadside' })).s === 200, 'map CDU');
  ok((await call('PUT', '/cash-close/task-class', TM2, { task: 'CDU', cls: 'Nope' })).s === 400, 'bad task class');

  wk = await call('GET', '/cash-close/week/' + W, TM2);
  ok(wk.j.steps.names_tasks && wk.j.steps.expenses, 'steps 2+3 done', wk.j.steps);
  var byName = {}; wk.j.units.forEach(function (u) { byName[u.user_name] = u; });
  var uJ = byName['Jordan Reyes'];
  ok(uJ.problems.length === 0 && uJ.total === 47550 && uJ.over_short === 0, 'Jordan entry', uJ.problems);
  var accts = uJ.lines.map(function (l) { return l.account + ':' + (l.debit || -l.credit) + ':' + l.cls; });
  ok(accts.indexOf('Auto:Fuel:2855:Locksmith') !== -1 && accts.indexOf('Auto:Fuel:1670:Roadside') !== -1 && accts.indexOf('Sales:Locksmith:-28037:Locksmith') !== -1 &&
     accts.indexOf('Sales:Roadside:-16402:Roadside') !== -1 && accts.indexOf('Sales Tax Payable:FL:-3111:') !== -1, 'Jordan lines', accts);
  var uC = byName['Casey Nguyen'];
  ok(uC.kind === 'held' && uC.held_amount === 9500 && uC.lines.some(function (l) { return l.account === 'Sales Tax Payable:FL Hillsborough' && l.credit === 622; }), 'Casey held + Tampa tax account', uC.lines);
  var uP = byName['Pat Quinn'];
  ok(uP.kind === 'late' && uP.problems.length === 0 && uP.lines.some(function (l) { return l.account === 'Cash Held by Techs' && l.credit === 5000; }) &&
     uP.lines.some(function (l) { return l.account === 'Cash Over and Short' && l.debit === 500; }), 'Pat late clears held, $5 short', uP.lines);
  var uX2 = byName['Xavier Stone'];
  ok(uX2.problems.length === 0 && uX2.pulsar_cash === 4000 && uX2.over_short === -2000, 'Xavier now linked, $20 short', uX2);

  // draft CSV
  var dcsv = await call('GET', '/cash-close/week/' + W + '/csv', TM2);
  ok(dcsv.s === 200 && /DRAFT/.test(dcsv.j.filename) && dcsv.j.csv.split('\r\n').filter(Boolean).length > 10, 'draft csv', dcsv.j && dcsv.j.filename);
  ok((await pool.query('SELECT COUNT(*)::int n FROM deposits WHERE qbo_export_batch = $1', [W])).rows[0].n === 0, 'draft download changes nothing');

  // close
  ok((await call('PUT', '/cash-close/week/' + W + '/reconciled', TM2, { done: true })).s === 200, 'reconciled W');
  var cw = await call('POST', '/cash-close/week/' + W + '/close', TM2);
  ok(cw.s === 200 && cw.j.entries === 4, 'close W', cw.j);
  var lines = cw.j.csv.trim().split('\r\n');
  ok(lines[0] === 'Journal No.,Journal Date,Account Name,Debits,Credits,Description,Name,Location,Class', 'csv header');
  // every journal balances
  var bal = {}; lines.slice(1).forEach(function (l) {
    var m = l.match(/^([^,]+),[^,]+,("[^"]*"|[^,]*),([^,]*),([^,]*),/); var jn = m[1];
    bal[jn] = (bal[jn] || 0) + Math.round((parseFloat(m[3] || 0) - parseFloat(m[4] || 0)) * 100);
  });
  ok(Object.keys(bal).length === 4 && Object.keys(bal).every(function (k) { return bal[k] === 0; }), 'every journal balances', bal);
  var closedWk = await call('GET', '/cash-close/week/' + W, TM2);
  ok(closedWk.j.status === 'closed' && closedWk.j.units.length === 4, 'closed snapshot view');
  var cc = await call('GET', '/cash-close/week/' + W + '/csv', TM2); ok(cc.j.csv === cw.j.csv && !/DRAFT/.test(cc.j.filename), 'closed csv is frozen copy');
  held = (await pool.query('SELECT user_id, amount, to_char(week_start,\'YYYY-MM-DD\') w, to_char(cleared_in_week,\'YYYY-MM-DD\') c FROM cash_close_held ORDER BY id')).rows;
  ok(held.length === 2 && held[0].c === W && held[1].user_id === C && parseFloat(held[1].amount) === 95, 'held rows after W', held);

  // locks
  var put = await call('PUT', '/deposits/' + dJ, TA, { amount: '1', deposit_date: '2026-09-21', pulsar_owed: '0', city_code: 'ORL', expenses: [] });
  ok(put.s === 409 && put.j.locked, 'deposit locked', put.j);
  ok((await call('DELETE', '/deposits/' + dJ, TA)).s === 409, 'delete locked');
  ok((await call('POST', '/deposits/' + dJ + '/expenses/' + ex[0].id + '/review', TA, { status: 'denied', reason: 'x' })).s === 409, 'review locked');
  ok((await call('POST', '/pulsar/import', TM2, { csv: csvW, strict: true, period_start: W })).s === 409, 'reimport closed week blocked');

  // reopen
  ok((await call('POST', '/cash-close/week/' + W + '/reopen', TM2, { reason: 'x' })).s === 403, 'mgr cannot reopen');
  ok((await call('POST', '/cash-close/week/' + W + '/reopen', TA, {})).s === 400, 'reopen needs reason');
  var rp = await call('POST', '/cash-close/week/' + PW + '/reopen', TA, { reason: 'fix' });
  ok(rp.s === 409 && /2026-09-14/.test(rp.j.error), 'P reopen blocked (W cleared its held)', rp.j);
  rp = await call('POST', '/cash-close/week/' + W + '/reopen', TA, { reason: 'Bookkeeper found a typo' });
  ok(rp.s === 200, 'reopen W');
  held = (await pool.query('SELECT user_id, cleared_in_week FROM cash_close_held ORDER BY id')).rows;
  ok(held.length === 1 && held[0].cleared_in_week === null, 'held restored', held);
  ok((await call('DELETE', '/deposits/' + dX, TA)).s === 200, 'unlocked after reopen');
  var wk3 = await call('GET', '/cash-close/week/' + W, TM2);
  ok(wk3.j.status === 'open' && wk3.j.reopen_reason === 'Bookkeeper found a typo' && wk3.j.units.length === 4 && wk3.j.units.some(function (u) { return u.user_name === 'Xavier Stone' && u.kind === 'held'; }), 'reopened view (Xavier now held)', wk3.j.units && wk3.j.units.length);
  var au = (await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'cash_week' ORDER BY id")).rows.map(function (r) { return r.action; });
  ok(au.join(',') === 'closed,csv_downloaded,closed,csv_downloaded,reopened', 'audit trail', au);

  srv.close(); await pool.end();
  console.log('PASS', pass, 'FAIL', fail); process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
