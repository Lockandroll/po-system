'use strict';
/*
 * PTO approvals context harness — runs against a REAL Postgres.
 * Covers: market resolution, city-scoped coverage cap, the balance preview on
 * the queue, and the /requests/:id/context payload (history, coverage names,
 * 3-week schedule window).
 *
 *   PGURL=postgres://postgres@127.0.0.1:5433/pto_test node test-pto-approvals.js
 */
var http = require('http');
var Module = require('module');
var { Pool } = require('pg');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) PASS++; else { FAIL++; console.error('  FAIL: ' + label); } }
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

var pool = new Pool({ connectionString: process.env.PGURL });

/* ---- stub the module graph so routes/pto.js loads standalone -------------- */
var CURRENT_USER = { id: 1, name: 'Admin', role: 'admin', isOwner: true };
var origResolve = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return { pool: pool, initDB: async function () {} };
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = Object.assign({}, CURRENT_USER); next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
  };
  if (request === '../utils/audit') return { logAudit: async function () {} };
  if (request === '../utils/notify') { var e = new Error('no notify'); e.code = 'MODULE_NOT_FOUND'; throw e; }
  if (request === '../utils/email' || request === '../utils/sms') { var e2 = new Error('no mailer'); e2.code = 'MODULE_NOT_FOUND'; throw e2; }
  if (request === '../utils/org') return {
    teamIds: async function () { return []; },
    inTeam: async function () { return true; }
  };
  return origResolve.apply(this, arguments);
};

var express = require('express');
var ptoRouter = require('./routes/pto.js');
var app = express();
app.use(express.json());
app.use('/api/pto', ptoRouter);
var server;

function req(method, path) {
  return new Promise(function (resolve, reject) {
    var r = http.request({ host: '127.0.0.1', port: server.address().port, method: method, path: path,
      headers: { 'content-type': 'application/json' } }, function (res) {
      var b = ''; res.on('data', function (c) { b += c; });
      res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: b }); });
    });
    r.on('error', reject); r.end();
  });
}

/* ---- schema: the slice of db.js these routes touch ----------------------- */
async function schema() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(
    'CREATE TABLE cities (code CHAR(3) PRIMARY KEY, name VARCHAR(120), color VARCHAR(20), active BOOLEAN DEFAULT true);' +
    'CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255), title VARCHAR(255),' +
    "  role VARCHAR(40) DEFAULT 'employee', pay_type VARCHAR(30) DEFAULT 'hourly', supervisor_id INTEGER," +
    '  hire_date DATE, home_city CHAR(3), org_level INTEGER,' +
    '  pto_balance_hours NUMERIC(8,2) NOT NULL DEFAULT 0, pto_exempt BOOLEAN NOT NULL DEFAULT false,' +
    "  employment_type VARCHAR(30) DEFAULT 'full_time', hide_from_schedule BOOLEAN NOT NULL DEFAULT false," +
    '  active BOOLEAN DEFAULT true);' +
    'CREATE TABLE user_cities (id SERIAL PRIMARY KEY, user_id INTEGER, city_code CHAR(3));' +
    'CREATE TABLE shift_positions (id SERIAL PRIMARY KEY, name VARCHAR(120), color VARCHAR(20), active BOOLEAN DEFAULT true);' +
    'CREATE TABLE shifts (id SERIAL PRIMARY KEY, user_id INTEGER, user_name VARCHAR(255), city_code CHAR(3),' +
    '  position_id INTEGER, prev_position_id INTEGER, shift_date DATE NOT NULL, start_time VARCHAR(5), end_time VARCHAR(5),' +
    "  break_minutes INTEGER DEFAULT 0, notes TEXT, status VARCHAR(20) DEFAULT 'draft', published_at TIMESTAMPTZ," +
    '  pto_generated BOOLEAN DEFAULT false, created_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());' +
    'CREATE TABLE pto_requests (id SERIAL PRIMARY KEY, user_id INTEGER, start_date DATE, end_date DATE,' +
    '  business_days INTEGER, hours NUMERIC(8,2), type VARCHAR(60), paid BOOLEAN DEFAULT true,' +
    "  status VARCHAR(30) DEFAULT 'pending', required_level INTEGER, approver_id INTEGER, decided_at TIMESTAMPTZ," +
    '  coverage_override BOOLEAN DEFAULT false, override_reason TEXT, retroactive BOOLEAN NOT NULL DEFAULT false,' +
    '  paid_days INTEGER DEFAULT 0, unpaid_days INTEGER DEFAULT 0, off_days INTEGER DEFAULT 0,' +
    '  cancel_memo TEXT, cancel_initiated_by INTEGER, cancel_initiated_at TIMESTAMP,' +
    '  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());' +
    'CREATE TABLE pto_request_days (id SERIAL PRIMARY KEY, request_id INTEGER, day_date DATE, kind VARCHAR(10));' +
    'CREATE TABLE pto_ledger (id SERIAL PRIMARY KEY, user_id INTEGER, entry_date DATE, kind VARCHAR(30),' +
    '  amount_hours NUMERIC(8,2), description TEXT, accrual_period VARCHAR(10), request_id INTEGER,' +
    '  created_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());' +
    'CREATE TABLE pto_cancellations (id SERIAL PRIMARY KEY, request_id INTEGER, user_id INTEGER, start_date DATE,' +
    '  end_date DATE, business_days INTEGER, hours NUMERIC(8,2), type VARCHAR(60), paid BOOLEAN, source VARCHAR(40),' +
    '  memo TEXT, initiated_by INTEGER, decided_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());' +
    'CREATE TABLE settings (key VARCHAR(120) PRIMARY KEY, value TEXT);'
  );
}

async function seed() {
  await pool.query("INSERT INTO cities (code,name,color) VALUES ('ATL','Atlanta','#f00'),('NSH','Nashville','#0f0');");
  await pool.query("INSERT INTO shift_positions (id,name,color) VALUES (1,'Tech','#3b82f6'),(5,'Approved Vacation Day','#22c55e'),(7,'Unpaid Vacation Day','#eab308'),(9,'Scheduled Off','#6b7280');");
  // 1 admin/approver; 2..4 Atlanta; 5 Nashville.
  await pool.query(
    "INSERT INTO users (id,name,title,role,pay_type,supervisor_id,hire_date,home_city,pto_balance_hours,employment_type) VALUES " +
    "(1,'Ada Admin','COO','admin','salary',NULL,'2018-01-01','ATL',400,'full_time')," +
    "(2,'Kayleigh Young','Tech','employee','hourly',1,'2023-03-01','ATL',6,'full_time')," +      // 6 hrs: cannot afford 8
    "(3,'Christopher Benson','Tech','employee','commission',1,'2021-06-15','ATL',40,'full_time')," +
    "(4,'Benjamin Albright','Tech','employee','commission',1,'2024-02-01',NULL,80,'full_time')," + // no home_city -> shift/user_cities path
    "(5,'Nash Tech','Tech','employee','hourly',1,'2020-01-01','NSH',120,'full_time');"
  );
  await pool.query("SELECT setval('users_id_seq',(SELECT MAX(id) FROM users));");
  await pool.query("INSERT INTO user_cities (user_id,city_code) VALUES (4,'ATL'),(5,'NSH');");
  await pool.query("INSERT INTO settings (key,value) VALUES ('pto_coverage_default','2'),('pto_coverage_caps','{\"ATL\":1,\"NSH\":3}');");
}

function d(offsetDays) {
  var t = new Date(Date.UTC(2026, 8, 7)); // Mon 2026-09-07, a fixed Monday
  t.setUTCDate(t.getUTCDate() + offsetDays);
  return t.toISOString().slice(0, 10);
}

async function main() {
  await schema();
  await seed();
  server = app.listen(0);
  await new Promise(function (r) { server.once('listening', r); });

  console.log('\n== market resolution ==');
  // Kayleigh (2) requests Wed-Thu of the anchor week; pending.
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days) VALUES (10,2,$1,$2,2,16,'Vacation',true,'pending',4,2)", [d(2), d(3)]);
  await pool.query("INSERT INTO pto_request_days (request_id,day_date,kind) VALUES (10,$1,'paid'),(10,$2,'paid')", [d(2), d(3)]);
  // Benjamin (4) has no home_city but is scheduled in ATL -> should resolve ATL.
  await pool.query("INSERT INTO shifts (user_id,user_name,city_code,position_id,shift_date,start_time,end_time,status) VALUES (4,'Benjamin Albright','ATL',1,$1,'06:00','18:00','published'),(4,'Benjamin Albright','ATL',1,$2,'06:00','18:00','published')", [d(-3), d(1)]);
  // Spans Wed-Fri so it overlaps BOTH Kayleigh's pending block and Christopher's
  // approved day — the case where a manager most needs to see the whole picture.
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,off_days) VALUES (11,4,$1,$2,3,0,'Vacation',false,'pending',4,3)", [d(2), d(4)]);
  // Nash tech already approved off across the same week (different market).
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days,approver_id,decided_at) VALUES (12,5,$1,$2,3,24,'Vacation',true,'approved',4,3,1,NOW())", [d(1), d(3)]);
  // Christopher (3, ATL) approved off overlapping Kayleigh -> ATL cap of 1 is blown.
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days,approver_id,decided_at) VALUES (13,3,$1,$1,1,8,'Vacation',true,'approved',4,1,1,NOW())", [d(2)]);
  await pool.query("SELECT setval('pto_requests_id_seq',100);");

  var q = await req('GET', '/api/pto/approvals');
  eq(q.status, 200, 'approvals 200');
  var rows = q.body || [];
  eq(rows.length, 2, 'two pending rows visible to admin');
  var k = rows.filter(function (x) { return x.id === 10; })[0];
  var b = rows.filter(function (x) { return x.id === 11; })[0];

  eq(k.coverage_city, 'ATL', 'Kayleigh resolves to ATL via home_city');
  eq(b.coverage_city, 'ATL', 'Benjamin resolves to ATL via published shifts (no home_city)');

  console.log('== city-scoped coverage ==');
  eq(k.coverage_cap, 1, 'ATL cap comes from pto_coverage_caps, not the default');
  eq(k.coverage_used, 2, 'Kayleigh + Christopher = 2 in ATL (Nashville excluded)');
  eq(k.coverage_over, true, 'over the ATL cap');
  eq(b.coverage_used, 2, 'Benjamin + Christopher in ATL; the Nashville absence is not counted');

  console.log('== balance preview ==');
  eq(Number(k.balance_hours), 6, 'Kayleigh balance 6 hrs');
  eq(Number(k.cost_hours), 16, 'Kayleigh cost 16 hrs (2 paid days)');
  eq(Number(k.balance_after), -10, 'after = -10');
  eq(k.insufficient, true, 'flagged insufficient');
  eq(Number(b.cost_hours), 0, 'an off-day request costs nothing');
  eq(b.insufficient, false, 'off-day request never insufficient');
  eq(Number(b.balance_after), 80, 'off-day request leaves the balance alone');

  console.log('== approve gate agrees with the badge ==');
  var ap = await req('POST', '/api/pto/requests/10/approve');
  eq(ap.status, 400, 'approve refused');
  eq(ap.body && ap.body.error, 'coverage_override_required', 'refused for the same cap the badge showed');
  eq(ap.body && ap.body.coverage_cap, 1, 'gate used the ATL cap too');

  console.log('== context: auth ==');
  CURRENT_USER = { id: 9, name: 'Outsider', role: 'employee', isOwner: false };
  var forb = await req('GET', '/api/pto/requests/10/context');
  eq(forb.status, 403, 'a non-approver is refused');
  CURRENT_USER = { id: 1, name: 'Ada Admin', role: 'admin', isOwner: true };
  var miss = await req('GET', '/api/pto/requests/999/context');
  eq(miss.status, 404, 'unknown request 404s');

  console.log('== context: payload ==');
  // Give Kayleigh some history inside and outside the 12-month window.
  await pool.query("INSERT INTO pto_ledger (user_id,entry_date,kind,amount_hours,description) VALUES (2,$1,'usage',-16,'PTO spring'),(2,$2,'usage',-8,'PTO older'),(2,$1,'accrual',10,'monthly')", [d(-120), d(-800)]);
  await pool.query("INSERT INTO pto_requests (user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days,approver_id,decided_at) VALUES (2,$1,$1,1,8,'Vacation',true,'denied',4,1,1,NOW()),(2,$2,$2,1,8,'Vacation',true,'approved',4,1,1,NOW())", [d(-60), d(-800)]);

  var c = await req('GET', '/api/pto/requests/10/context');
  eq(c.status, 200, 'context 200');
  var C = c.body;
  eq(C.employee.name, 'Kayleigh Young', 'employee name');
  eq(C.employee.pay_type, 'hourly', 'pay type');
  eq(C.balance.current_hours, 6, 'context current balance');
  eq(C.balance.cost_hours, 16, 'context cost');
  eq(C.balance.after_hours, -10, 'context after');
  eq(C.balance.insufficient, true, 'context insufficient');
  eq(C.request.days.length, 2, 'day tags returned');
  eq(C.request.days[0].kind, 'paid', 'day tag kind');
  eq(C.request.tier_label, 'Direct supervisor', '2 days routes to the direct supervisor');

  eq(C.history.used_hours, 16, 'used_hours counts usage inside the window only');
  eq(C.history.requests.length, 1, 'history holds the in-window request only');
  eq(C.history.requests[0].status, 'denied', 'a denied request still shows in history');
  ok(C.history.ledger.length === 2, 'ledger holds in-window lines only  (got ' + C.history.ledger.length + ')');
  ok(C.history.requests.every(function (x) { return x.id !== 10; }), 'history excludes the request being decided');

  eq(C.coverage.city_code, 'ATL', 'context coverage city');
  eq(C.coverage.city_name, 'Atlanta', 'context city name resolved');
  eq(C.coverage.cap, 1, 'context cap');
  eq(C.coverage.used, 2, 'context used');
  eq(C.coverage.over, true, 'context over');
  eq(C.coverage.others_off.length, 1, 'one other person already off in ATL');
  eq(C.coverage.others_off[0].name, 'Christopher Benson', 'named, not just counted');
  eq(C.coverage.others_pending.length, 1, 'Benjamin shows as a pending overlap');
  eq(C.coverage.others_pending[0].name, 'Benjamin Albright', 'pending overlap named');
  ok(C.coverage.others_off.concat(C.coverage.others_pending).every(function (x) { return x.name !== 'Nash Tech'; }), 'Nashville never appears in ATL coverage');

  console.log('== context: schedule window ==');
  eq(C.schedule.from, d(-7), 'starts the Monday of the week before');
  eq(C.schedule.to, d(13), 'ends the Sunday of the week after');
  eq(C.schedule.city_code, 'ATL', 'schedule scoped to the market');
  eq(C.schedule.shifts.length, 2, 'both published ATL shifts in range');
  ok(C.schedule.shifts.every(function (s) { return String(s.city_code).trim() === 'ATL'; }), 'no other market leaks in');
  eq(C.schedule.shifts[0].position_name, 'Tech', 'position joined');
  eq(C.schedule.shifts[0].user_name, 'Benjamin Albright', 'shift carries the person');
  eq(typeof C.schedule.shifts[0].shift_date, 'string', 'shift_date is a plain YYYY-MM-DD');
  eq(C.schedule.shifts[0].shift_date.length, 10, 'shift_date not a timestamp');

  // A draft shift and a hidden user must both stay out of the grid.
  await pool.query("INSERT INTO shifts (user_id,user_name,city_code,position_id,shift_date,start_time,end_time,status) VALUES (3,'Christopher Benson','ATL',1,$1,'06:00','18:00','draft')", [d(0)]);
  await pool.query("UPDATE users SET hide_from_schedule = true WHERE id = 4;");
  var c2 = await req('GET', '/api/pto/requests/10/context');
  eq(c2.body.schedule.shifts.length, 0, 'draft shifts and hidden staff are excluded');
  await pool.query("UPDATE users SET hide_from_schedule = false WHERE id = 4;");

  console.log('== long request is capped at 6 weeks ==');
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days) VALUES (20,2,$1,$2,40,0,'Leave',false,'pending',1,0)", [d(0), d(70)]);
  var c3 = await req('GET', '/api/pto/requests/20/context');
  var span = (new Date(c3.body.schedule.to) - new Date(c3.body.schedule.from)) / 86400000 + 1;
  eq(span, 42, 'window clamped to 6 weeks');
  eq(c3.body.request.tier_label, 'CEO approval', '40 days escalates to CEO');

  console.log('== a long request keeps its own days in the grid ==');
  eq(c3.body.schedule.truncated, true, 'truncation is reported, not silent');
  ok(c3.body.schedule.requested_to > c3.body.schedule.to, 'payload says how much was cut');
  ok(c3.body.schedule.from <= d(0), 'the request start is still inside the window');

  console.log('== history window is anchored on today, not the request ==');
  // Request 20 starts today and runs 70 days out; a far-future request must not
  // drag the 12-month window forward and hide real history.
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days) VALUES (21,2,$1,$1,1,8,'Vacation',true,'pending',4,1)", [d(300)]);
  var c5 = await req('GET', '/api/pto/requests/21/context');
  eq(c5.body.history.requests.length, 1, 'the denied request 240 days back is still visible');
  eq(c5.body.history.requests[0].status, 'denied', 'and it is the right one');
  ok(c5.body.history.requests.every(function (x) { return x.start_date <= c5.body.history.window_to; }), 'no future request filed under "previous"');
  eq(c5.body.history.upcoming.length, 2, 'both of her still-live future requests are listed as booked ahead');
  ok(c5.body.history.upcoming.map(function (x) { return x.id; }).indexOf(20) !== -1, 'the long pending request is one of them');
  ok(c5.body.history.upcoming.every(function (x) { return x.start_date > c5.body.history.window_to; }), 'booked-ahead really is in the future');

  console.log('== used_hours nets out reversals ==');
  var beforeUsed = (await req('GET', '/api/pto/requests/10/context')).body.history.used_hours;
  eq(beforeUsed, 16, 'usage counted');
  await pool.query("INSERT INTO pto_ledger (user_id,entry_date,kind,amount_hours,description) VALUES (2,$1,'reversal',16,'PTO cancelled')", [d(-119)]);
  var afterUsed = (await req('GET', '/api/pto/requests/10/context')).body.history.used_hours;
  eq(afterUsed, 0, 'a cancelled PTO no longer counts as used');
  await pool.query("DELETE FROM pto_ledger WHERE kind = 'reversal';");

  console.log('== a market with no configured cap must not get LOOSER ==');
  // MIA has no entry in pto_coverage_caps. Before per-market caps worked, this
  // request was measured company-wide against the default of 2. Scoping the
  // count to MIA while still using the default would let it through unaudited.
  await pool.query("INSERT INTO cities (code,name) VALUES ('MIA','Miami');");
  await pool.query("INSERT INTO users (id,name,role,pay_type,supervisor_id,hire_date,home_city,pto_balance_hours) VALUES (6,'Mia Tech','employee','hourly',1,'2022-01-01','MIA',200);");
  await pool.query("SELECT setval('users_id_seq',(SELECT MAX(id) FROM users));");
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days) VALUES (30,6,$1,$1,1,8,'Vacation',true,'pending',4,1)", [d(2)]);
  var c6 = await req('GET', '/api/pto/requests/30/context');
  eq(c6.body.coverage.city_code, 'MIA', 'MIA resolved');
  eq(c6.body.coverage.scoped, false, 'not scoped, because MIA has no cap of its own');
  eq(c6.body.coverage.cap, 2, 'measured against the company default');
  eq(c6.body.coverage.used, 3, 'counted company-wide, exactly as before this change');
  eq(c6.body.coverage.over, true, 'still over the default cap — the gate did not loosen');

  console.log('== a junk per-city cap does not disable the gate ==');
  await pool.query("UPDATE settings SET value = '{\"ATL\":\"none\",\"NSH\":3}' WHERE key = 'pto_coverage_caps';");
  var c7 = await req('GET', '/api/pto/requests/10/context');
  eq(c7.body.coverage.scoped, false, 'an unparseable cap is treated as unset');
  eq(c7.body.coverage.cap, 2, 'falls back to the default rather than NaN');
  eq(c7.body.coverage.over, true, 'the gate still fires');
  await pool.query("UPDATE settings SET value = '{\"ATL\":1,\"NSH\":3}' WHERE key = 'pto_coverage_caps';");

  console.log('== roster cannot drift from the resolver ==');
  // Benjamin has no home_city, a stale NSH user_cities row, and all his published
  // shifts in ATL. He must count against ATL (where he works), never NSH.
  await pool.query("UPDATE user_cities SET city_code = 'NSH' WHERE user_id = 4;");
  await pool.query("UPDATE pto_requests SET status = 'approved', approver_id = 1, decided_at = NOW() WHERE id = 11;");
  var c8 = await req('GET', '/api/pto/requests/10/context');
  eq(c8.body.coverage.city_code, 'ATL', 'requester still ATL');
  ok(c8.body.coverage.others_off.some(function (x) { return x.name === 'Benjamin Albright'; }), 'Benjamin counts against ATL via his shifts, not his stale NSH row');
  await pool.query("UPDATE user_cities SET city_code = 'ATL' WHERE user_id = 4;");
  await pool.query("UPDATE pto_requests SET status = 'pending', approver_id = NULL, decided_at = NULL WHERE id = 11;");

  console.log('== draft shifts do not decide a market ==');
  await pool.query("DELETE FROM shifts WHERE user_id = 4;");
  await pool.query("DELETE FROM user_cities WHERE user_id = 4;");
  await pool.query("INSERT INTO shifts (user_id,user_name,city_code,position_id,shift_date,start_time,end_time,status) VALUES (4,'Benjamin Albright','ATL',1,$1,'06:00','18:00','draft')", [d(1)]);
  var c9 = await req('GET', '/api/pto/requests/11/context');
  eq(c9.body.coverage.city_code, null, 'a draft-only week is not evidence of a market');

  console.log('== PTO markers do not out-vote real work ==');
  // One real ATL shift, three Nashville PTO markers. The market is where he works.
  await pool.query("DELETE FROM shifts WHERE user_id = 4;");
  await pool.query("INSERT INTO shifts (user_id,user_name,city_code,position_id,shift_date,start_time,end_time,status) VALUES (4,'Benjamin Albright','ATL',1,$1,'06:00','18:00','published'),(4,'Benjamin Albright','NSH',5,$2,'06:00','18:00','published'),(4,'Benjamin Albright','NSH',5,$3,'06:00','18:00','published'),(4,'Benjamin Albright','NSH',5,$4,'06:00','18:00','published')", [d(-2), d(-5), d(-6), d(-7)]);
  var c10 = await req('GET', '/api/pto/requests/11/context');
  eq(c10.body.coverage.city_code, 'ATL', 'the one worked shift beats three vacation markers');

  console.log('== an unresolvable person still counts against a scoped cap ==');
  // Larry is an ATL tech on a long approved absence. Approving that absence
  // rewrote his shifts to PTO markers, which the resolver ignores, so his own
  // market comes back null. He must still count, or the gate loses exactly the
  // people it exists to catch.
  await pool.query("DELETE FROM shifts;");
  await pool.query("UPDATE users SET home_city = 'ATL' WHERE id = 2;");
  await pool.query("INSERT INTO user_cities (user_id,city_code) SELECT 2,'ATL' WHERE NOT EXISTS (SELECT 1 FROM user_cities WHERE user_id = 2);");
  await pool.query("UPDATE users SET home_city = NULL WHERE id = 3;");
  await pool.query("DELETE FROM user_cities WHERE user_id = 3;");
  await pool.query("INSERT INTO shifts (user_id,user_name,city_code,position_id,shift_date,start_time,end_time,status) VALUES (3,'Christopher Benson','ATL',5,$1,'06:00','18:00','published')", [d(2)]);
  await pool.query("UPDATE pto_requests SET status = 'pending' WHERE id = 11;");
  var cL = await req('GET', '/api/pto/requests/10/context');
  eq(cL.body.coverage.city_code, 'ATL', 'requester still resolves');
  eq(cL.body.coverage.scoped, true, 'ATL has its own cap, so the count is scoped');
  eq(await (async function () { return cL.body.coverage.used; })(), 2, 'the unresolvable colleague is still counted');
  eq(cL.body.coverage.over, true, 'so the gate still fires');
  ok(cL.body.coverage.others_off.some(function (x) { return x.name === 'Christopher Benson'; }), 'and he is still named');
  await pool.query("DELETE FROM shifts;");
  await pool.query("UPDATE users SET home_city = 'ATL' WHERE id = 3;");

  console.log('== the count is never truncated by a display limit ==');
  // 70 people off at once, well past the 60-name display cap.
  await pool.query("INSERT INTO users (name,role,pay_type,supervisor_id,hire_date,home_city,pto_balance_hours) SELECT 'Bulk ' || g, 'employee','hourly',1,'2020-01-01','ATL',200 FROM generate_series(1,70) g;");
  await pool.query("INSERT INTO pto_requests (user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days,approver_id,decided_at) SELECT id,$1,$1,1,8,'Vacation',true,'approved',4,1,1,NOW() FROM users WHERE name LIKE 'Bulk %'", [d(2)]);
  var cB = await req('GET', '/api/pto/requests/10/context');
  eq(cB.body.coverage.used, 72, 'all 71 overlapping absences counted, plus the requester');
  eq(cB.body.coverage.names_truncated, true, 'the NAME list is flagged as partial');
  ok(cB.body.coverage.others_off.length <= 60, 'names capped for display');
  eq(cB.body.coverage.over, true, 'the gate sees the real number');
  await pool.query("DELETE FROM pto_requests WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'Bulk %');");
  await pool.query("DELETE FROM users WHERE name LIKE 'Bulk %';");

  console.log('== the market memo is per window, not per person ==');
  // One person, no home_city, ATL shifts around the near request and NSH shifts
  // around a far one. Two rows in the same queue must not share a market.
  await pool.query("UPDATE users SET home_city = NULL WHERE id = 4;");
  await pool.query("DELETE FROM user_cities WHERE user_id = 4;");
  await pool.query("DELETE FROM shifts;");
  await pool.query("INSERT INTO shifts (user_id,user_name,city_code,position_id,shift_date,start_time,end_time,status) VALUES (4,'Benjamin Albright','ATL',1,$1,'06:00','18:00','published'),(4,'Benjamin Albright','NSH',1,$2,'06:00','18:00','published')", [d(1), d(101)]);
  await pool.query("UPDATE pto_requests SET start_date = $1, end_date = $1 WHERE id = 11", [d(2)]);
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days) VALUES (40,4,$1,$1,1,8,'Vacation',true,'pending',4,1)", [d(100)]);
  var qq = await req('GET', '/api/pto/approvals');
  var near = qq.body.filter(function (x) { return x.id === 11; })[0];
  var far = qq.body.filter(function (x) { return x.id === 40; })[0];
  eq(near.coverage_city, 'ATL', 'the near request resolves to ATL');
  eq(far.coverage_city, 'NSH', 'the far request resolves to NSH, not ATL from the memo');
  var farCtx = await req('GET', '/api/pto/requests/40/context');
  eq(farCtx.body.coverage.city_code, far.coverage_city, 'dialog agrees with the badge');
  eq(farCtx.body.coverage.cap, far.coverage_cap, 'and so does the cap');
  eq(farCtx.body.coverage.over, far.coverage_over, 'and the over flag');
  await pool.query("DELETE FROM pto_requests WHERE id = 40;");
  await pool.query("DELETE FROM shifts;");
  await pool.query("UPDATE users SET home_city = 'ATL' WHERE id = 4;");

  console.log('== a future denied request is not lost ==');
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days,approver_id,decided_at) VALUES (41,2,$1,$1,1,8,'Vacation',true,'denied',4,1,1,NOW())", [d(200)]);
  var cD = await req('GET', '/api/pto/requests/11/context');
  var cD2 = await req('GET', '/api/pto/requests/10/context');
  var allIds = cD2.body.history.requests.map(function (x) { return x.id; }).concat(cD2.body.history.upcoming.map(function (x) { return x.id; }));
  ok(allIds.indexOf(41) !== -1, 'a request denied for future dates appears somewhere');
  ok(cD2.body.history.requests.some(function (x) { return x.id === 41; }), 'and it is filed under previous decisions, not booked-ahead');
  ok(cD2.body.history.upcoming.every(function (x) { return x.id !== 41; }), 'a denied request is never "booked ahead"');

  console.log('== used_hours ignores PTO that has not happened yet ==');
  await pool.query("DELETE FROM pto_ledger WHERE user_id = 2;");
  await pool.query("INSERT INTO pto_ledger (user_id,entry_date,kind,amount_hours,description) VALUES (2,$1,'usage',-8,'past trip'),(2,$2,'usage',-40,'approved future trip')", [d(-60), d(90)]);
  var cU = await req('GET', '/api/pto/requests/10/context');
  eq(cU.body.history.used_hours, 8, 'only the trip already taken counts as used');
  ok(cU.body.history.ledger.every(function (x) { return x.entry_date <= cU.body.history.window_to; }), 'and no future line sits under a "last 12 months" heading');

  console.log('== unresolvable market falls back, never loosens ==');
  await pool.query("DELETE FROM shifts;");
  await pool.query("UPDATE users SET home_city = NULL WHERE id = 2;");
  await pool.query("DELETE FROM user_cities WHERE user_id = 2;");
  var c4 = await req('GET', '/api/pto/requests/10/context');
  eq(c4.body.coverage.city_code, null, 'no market resolved');
  eq(c4.body.coverage.cap, 2, 'falls back to pto_coverage_default');
  eq(c4.body.coverage.scoped, false, 'flagged as unscoped');
  eq(c4.body.coverage.used, 3, 'company-wide count when the market is unknown');
  eq(c4.body.schedule.shifts.length, 0, 'no market means no schedule grid');

  server.close();
  await pool.end();
  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
