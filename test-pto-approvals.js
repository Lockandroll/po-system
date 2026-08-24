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
  if (request === '../utils/audit') return { logAudit: async function (e) {
    await pool.query('INSERT INTO audit_logs (entity_type, entity_id, action, user_id, user_name, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [e.entity_type, e.entity_id, e.action, e.user_id, e.user_name, JSON.stringify(e.details || {})]);
  } };
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
function reqBody(method, path, body) {
  var data = JSON.stringify(body || {});
  return new Promise(function (resolve, reject) {
    var r = http.request({ host: '127.0.0.1', port: server.address().port, method: method, path: path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, function (res) {
      var b = ''; res.on('data', function (c) { b += c; });
      res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: b }); });
    });
    r.on('error', reject); r.write(data); r.end();
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
    '  cancel_memo TEXT, cancel_initiated_by INTEGER, cancel_initiated_at TIMESTAMP, decision_reason TEXT,' +
    '  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());' +
    "CREATE TABLE pto_request_days (id SERIAL PRIMARY KEY, request_id INTEGER NOT NULL, day_date DATE NOT NULL," +
    "  kind VARCHAR(12) NOT NULL DEFAULT 'paid', hours NUMERIC(6,2), UNIQUE(request_id, day_date));" +
    'CREATE TABLE pto_ledger (id SERIAL PRIMARY KEY, user_id INTEGER, entry_date DATE, kind VARCHAR(30),' +
    '  amount_hours NUMERIC(8,2), description TEXT, accrual_period VARCHAR(10), request_id INTEGER,' +
    '  created_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());' +
    'CREATE TABLE pto_cancellations (id SERIAL PRIMARY KEY, request_id INTEGER, user_id INTEGER, start_date DATE,' +
    '  end_date DATE, business_days INTEGER, hours NUMERIC(8,2), type VARCHAR(60), paid BOOLEAN, source VARCHAR(40),' +
    '  memo TEXT, initiated_by INTEGER, decided_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());' +
    'CREATE TABLE settings (key VARCHAR(120) PRIMARY KEY, value TEXT);' +
    'CREATE TABLE audit_logs (id SERIAL PRIMARY KEY, entity_type VARCHAR(60), entity_id INTEGER, action VARCHAR(60),' +
    '  user_id INTEGER, user_name VARCHAR(255), details JSONB, created_at TIMESTAMPTZ DEFAULT NOW());'
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

  console.log('== approver re-tags days at approval time ==');
  // Fresh, self-contained: Tara has exactly 24 hrs and asks for 3 paid days.
  await pool.query("UPDATE settings SET value = '{}' WHERE key = 'pto_coverage_caps';");
  await pool.query("UPDATE settings SET value = '99' WHERE key = 'pto_coverage_default';");
  await pool.query("INSERT INTO users (id,name,role,pay_type,supervisor_id,hire_date,home_city,pto_balance_hours) VALUES (7,'Tara Ridge','employee','hourly',1,'2021-01-01','ATL',24);");
  await pool.query("SELECT setval('users_id_seq',(SELECT MAX(id) FROM users));");
  async function freshReq(rid) {
    await pool.query("DELETE FROM pto_request_days WHERE request_id = $1", [rid]);
    await pool.query("DELETE FROM pto_requests WHERE id = $1", [rid]);
    await pool.query("DELETE FROM pto_ledger WHERE user_id = 7;");
    await pool.query("DELETE FROM shifts WHERE user_id = 7;");
    await pool.query("UPDATE users SET pto_balance_hours = 24 WHERE id = 7;");
    await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days) VALUES ($1,7,$2,$3,3,24,'Vacation',true,'pending',4,3)", [rid, d(50), d(52)]);
    await pool.query("INSERT INTO pto_request_days (request_id,day_date,kind) VALUES ($1,$2,'paid'),($1,$3,'paid'),($1,$4,'paid')", [rid, d(50), d(51), d(52)]);
  }

  await freshReq(50);
  var reA = await req('POST', '/api/pto/requests/50/approve');
  eq(reA.status, 200, 'plain approve still works with no days supplied');
  var rowA = (await pool.query('SELECT hours, paid_days, unpaid_days, off_days, paid, business_days FROM pto_requests WHERE id = 50')).rows[0];
  eq(Number(rowA.hours), 24, 'all three days still paid');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 7')).rows[0].b), 0, 'balance deducted in full');

  await freshReq(51);
  var reB = await reqBody('POST', '/api/pto/requests/51/approve', { days: [
    { date: d(50), kind: 'paid' }, { date: d(51), kind: 'unpaid' }, { date: d(52), kind: 'off' } ] });
  eq(reB.status, 200, 're-tagged approve accepted');
  eq(reB.body.retagged.length, 2, 'two changes reported back');
  eq(reB.body.hours, 8, 'only the remaining paid day costs anything');
  var rowB = (await pool.query('SELECT hours, paid_days, unpaid_days, off_days, paid, business_days, required_level FROM pto_requests WHERE id = 51')).rows[0];
  eq(Number(rowB.hours), 8, 'stored hours recomputed from the FINAL tags');
  eq(Number(rowB.paid_days), 1, 'paid_days recomputed');
  eq(Number(rowB.unpaid_days), 1, 'unpaid_days recomputed');
  eq(Number(rowB.off_days), 1, 'off_days recomputed');
  eq(Number(rowB.business_days), 2, 'a day tagged off is no longer an absence');
  eq(rowB.paid, true, 'still a paid request while one paid day remains');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 7')).rows[0].b), 16, 'only 8 hrs deducted, not 24');
  var ledB = (await pool.query("SELECT amount_hours FROM pto_ledger WHERE user_id = 7 AND kind = 'usage'")).rows;
  eq(ledB.length, 1, 'one usage line');
  eq(Number(ledB[0].amount_hours), -8, 'and it matches the corrected hours');
  var daysB = (await pool.query('SELECT kind FROM pto_request_days WHERE request_id = 51 ORDER BY day_date')).rows.map(function (x) { return x.kind; });
  eq(daysB.join(','), 'paid,unpaid,off', 'the corrected tags are persisted');
  var posB = (await pool.query('SELECT position_id FROM shifts WHERE user_id = 7 ORDER BY shift_date')).rows.map(function (x) { return Number(x.position_id); });
  eq(posB.join(','), '5,7,9', 'the schedule is marked from the CORRECTED tags, not the submitted ones');

  console.log('== every paid day removed ==');
  await freshReq(52);
  var reC = await reqBody('POST', '/api/pto/requests/52/approve', { days: [
    { date: d(50), kind: 'unpaid' }, { date: d(51), kind: 'unpaid' }, { date: d(52), kind: 'off' } ] });
  eq(reC.status, 200, 'approve with nothing paid');
  eq(reC.body.hours, 0, 'costs nothing');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 7')).rows[0].b), 24, 'balance untouched');
  eq((await pool.query("SELECT COUNT(*)::int c FROM pto_ledger WHERE user_id = 7 AND kind = 'usage'")).rows[0].c, 0, 'no ledger line at all');
  eq((await pool.query('SELECT paid FROM pto_requests WHERE id = 52')).rows[0].paid, false, 'the request is no longer a paid one');

  console.log('== a re-tag can rescue an unaffordable request ==');
  await freshReq(53);
  await pool.query("UPDATE users SET pto_balance_hours = 8 WHERE id = 7;");
  var reD = await req('POST', '/api/pto/requests/53/approve');
  eq(reD.status, 400, 'as submitted it exceeds the balance');
  ok(String(reD.body.error).indexOf('balance') !== -1, 'and says so');
  var reE = await reqBody('POST', '/api/pto/requests/53/approve', { days: [
    { date: d(50), kind: 'paid' }, { date: d(51), kind: 'unpaid' }, { date: d(52), kind: 'unpaid' } ] });
  eq(reE.status, 200, 'the same request approves once two days go unpaid');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 7')).rows[0].b), 0, 'balance lands exactly at zero');

  console.log('== a re-tag cannot become a different request ==');
  await freshReq(54);
  var badA = await reqBody('POST', '/api/pto/requests/54/approve', { days: [
    { date: d(50), kind: 'paid' }, { date: d(51), kind: 'paid' } ] });
  eq(badA.status, 400, 'dropping a day is refused');
  ok(String(badA.body.error).indexOf('do not match') !== -1, 'with a message that says what to do instead');
  var badB = await reqBody('POST', '/api/pto/requests/54/approve', { days: [
    { date: d(50), kind: 'paid' }, { date: d(51), kind: 'paid' }, { date: d(52), kind: 'paid' }, { date: d(53), kind: 'paid' } ] });
  eq(badB.status, 400, 'adding a day is refused');
  var badC = await reqBody('POST', '/api/pto/requests/54/approve', { days: [
    { date: d(50), kind: 'paid' }, { date: d(51), kind: 'paid' }, { date: d(60), kind: 'paid' } ] });
  eq(badC.status, 400, 'swapping a date is refused');
  eq((await pool.query('SELECT status FROM pto_requests WHERE id = 54')).rows[0].status, 'pending', 'and the request is untouched by any of it');
  var junk = await reqBody('POST', '/api/pto/requests/54/approve', { days: [
    { date: d(50), kind: 'sabbatical' }, { date: d(51), kind: 'paid' }, { date: d(52), kind: 'paid' } ] });
  eq(junk.status, 200, 'an unknown kind falls back to paid rather than erroring');
  eq(Number((await pool.query('SELECT hours FROM pto_requests WHERE id = 54')).rows[0].hours), 24, 'and is treated as paid');

  console.log('== the re-tag is written to the audit trail ==');
  var aud = (await pool.query("SELECT details FROM audit_logs WHERE entity_type = 'pto_request' AND entity_id = 51 ORDER BY id DESC LIMIT 1")).rows;
  ok(aud.length > 0, 'an audit row exists');
  var det = typeof aud[0].details === 'string' ? JSON.parse(aud[0].details) : aud[0].details;
  ok(det && String(det.retagged || '').indexOf('paid 8.0h \u2192 unpaid') !== -1, 'and it names the change, hours and all  (got ' + JSON.stringify(det && det.retagged) + ')');
  eq(det.hours, 8, 'with the final hours');


  console.log('== partial days: an employee asks for part of a day ==');
  // Tara submits for herself. 3 hours on one day, a full day on the next.
  CURRENT_USER = { id: 7, name: 'Tara Ridge', role: 'employee', isOwner: false };
  await pool.query('DELETE FROM pto_request_days; DELETE FROM pto_requests; DELETE FROM pto_ledger; DELETE FROM shifts;');
  await pool.query('UPDATE users SET pto_balance_hours = 24 WHERE id = 7;');
  var pA = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [
    { date: d(70), kind: 'paid', hours: 3 }, { date: d(71), kind: 'paid', hours: 8 } ] });
  eq(pA.status, 200, 'a part-day request is accepted');
  eq(Number(pA.body.hours), 11, 'it costs 3 + 8, not 16');
  eq(Number(pA.body.business_days), 2, 'a 3-hour day is still a day away for scheduling');
  eq(Number(pA.body.paid_days), 2, 'and still counts as a paid day');
  var pADays = (await pool.query('SELECT day_date, kind, hours FROM pto_request_days WHERE request_id = $1 ORDER BY day_date', [pA.body.id])).rows;
  eq(pADays.map(function (x) { return Number(x.hours); }).join(','), '3,8', 'the per-day amounts are stored');

  console.log('== 0.1 is the grid, and nothing smaller ==');
  var pB = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(72), kind: 'paid', hours: 2.55 }] });
  eq(pB.status, 200, 'a fractional amount is accepted');
  eq(Number(pB.body.hours), 2.6, 'and snapped to the nearest tenth');
  var pC = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(73), kind: 'paid', hours: 0.1 }] });
  eq(pC.status, 200, 'a tenth of an hour is a legal request');
  eq(Number(pC.body.hours), 0.1, 'and costs exactly that');

  console.log('== a paid day with no usable amount is refused, never charged as 8 ==');
  var badH = [0, -3, 'abc', 0.04];
  for (var bi = 0; bi < badH.length; bi++) {
    var pD = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(74), kind: 'paid', hours: badH[bi] }] });
    eq(pD.status, 400, 'hours of ' + JSON.stringify(badH[bi]) + ' is refused');
    ok(String(pD.body.error).indexOf('positive number') !== -1, 'with a message that says what is wrong');
  }
  var pE = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(74), kind: 'paid' }] });
  eq(pE.status, 200, 'no amount at all still means a full day');
  eq(Number(pE.body.hours), 8, 'which costs 8');
  var pF = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [
    { date: d(75), kind: 'unpaid', hours: 0 }, { date: d(76), kind: 'off', hours: 0 } ] });
  eq(pF.status, 200, 'unpaid and off days need no amount');
  eq(Number(pF.body.hours), 0, 'and cost nothing');

  console.log('== the balance is the only ceiling ==');
  await pool.query('DELETE FROM pto_request_days; DELETE FROM pto_requests;');
  await pool.query('UPDATE users SET pto_balance_hours = 6 WHERE id = 7;');
  var wallA = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(80), kind: 'paid', hours: 8 }] });
  eq(wallA.status, 400, 'a full day is out of reach on a 6-hour balance');
  var wallB = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(80), kind: 'paid', hours: 3 }] });
  eq(wallB.status, 200, 'but the 3 hours she actually needs go through');
  var wallC = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(81), kind: 'paid', hours: 12 }] });
  eq(wallC.status, 400, 'and nothing above the balance is allowed, cap or no cap');
  await pool.query('UPDATE users SET pto_balance_hours = 24 WHERE id = 7;');
  var wallD = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(82), kind: 'paid', hours: 12 }] });
  eq(wallD.status, 200, 'a 12-hour shift can be taken whole when the balance covers it');
  eq(Number(wallD.body.hours), 12, 'at its real length');

  console.log('== approving a partial day deducts the partial amount ==');
  CURRENT_USER = { id: 1, name: 'Ada Admin', role: 'admin', isOwner: true };
  await pool.query('DELETE FROM pto_request_days; DELETE FROM pto_requests; DELETE FROM pto_ledger; DELETE FROM shifts;');
  await pool.query('UPDATE users SET pto_balance_hours = 24 WHERE id = 7;');
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days) VALUES (60,7,$1,$1,1,3,'Vacation',true,'pending',4,1)", [d(90)]);
  await pool.query("INSERT INTO pto_request_days (request_id,day_date,kind,hours) VALUES (60,$1,'paid',3)", [d(90)]);
  var apA = await req('POST', '/api/pto/requests/60/approve');
  eq(apA.status, 200, 'approved as submitted');
  eq(Number(apA.body.hours), 3, 'three hours, not eight');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 7')).rows[0].b), 21, 'balance down by exactly 3');
  var ledP = (await pool.query("SELECT amount_hours FROM pto_ledger WHERE user_id = 7 AND kind = 'usage'")).rows;
  eq(Number(ledP[0].amount_hours), -3, 'and the ledger line matches');
  eq(Number((await pool.query('SELECT position_id FROM shifts WHERE user_id = 7')).rows[0].position_id), 5, 'the day is still marked on the schedule');

  console.log('== the approver can change the hours, not just the classification ==');
  await pool.query('DELETE FROM pto_request_days; DELETE FROM pto_requests; DELETE FROM pto_ledger; DELETE FROM shifts;');
  await pool.query('UPDATE users SET pto_balance_hours = 24 WHERE id = 7;');
  await pool.query("INSERT INTO pto_requests (id,user_id,start_date,end_date,business_days,hours,type,paid,status,required_level,paid_days) VALUES (61,7,$1,$2,2,16,'Vacation',true,'pending',4,2)", [d(95), d(96)]);
  await pool.query("INSERT INTO pto_request_days (request_id,day_date,kind,hours) VALUES (61,$1,'paid',8),(61,$2,'paid',8)", [d(95), d(96)]);
  var apB = await reqBody('POST', '/api/pto/requests/61/approve', { days: [
    { date: d(95), kind: 'paid', hours: 3 }, { date: d(96), kind: 'paid', hours: 8 } ] });
  eq(apB.status, 200, 'an hours-only correction is accepted');
  eq(apB.body.retagged.length, 1, 'and reported as one change');
  eq(apB.body.retagged[0].from_hours, 8, 'from 8');
  eq(apB.body.retagged[0].to_hours, 3, 'to 3');
  eq(Number(apB.body.hours), 11, 'the request now costs 11');
  eq(Number((await pool.query('SELECT hours FROM pto_requests WHERE id = 61')).rows[0].hours), 11, 'stored on the request');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 7')).rows[0].b), 13, 'and deducted from the balance');
  eq((await pool.query('SELECT hours FROM pto_request_days WHERE request_id = 61 ORDER BY day_date')).rows.map(function (x) { return Number(x.hours); }).join(','), '3,8', 'the corrected per-day amounts are persisted');
  var audP = (await pool.query("SELECT details FROM audit_logs WHERE entity_id = 61 ORDER BY id DESC LIMIT 1")).rows[0];
  var detP = typeof audP.details === 'string' ? JSON.parse(audP.details) : audP.details;
  ok(String(detP.retagged || '').indexOf('paid 8.0h → paid 3.0h') !== -1, 'the audit trail names the hours change  (got ' + JSON.stringify(detP.retagged) + ')');

  console.log('== an approver cannot zero a paid day out ==');
  await pool.query("UPDATE pto_requests SET status = 'pending' WHERE id = 61;");
  var apC = await reqBody('POST', '/api/pto/requests/61/approve', { days: [
    { date: d(95), kind: 'paid', hours: 0 }, { date: d(96), kind: 'paid', hours: 8 } ] });
  eq(apC.status, 400, 'zero hours on a paid day is refused');
  ok(String(apC.body.error).indexOf('positive number') !== -1, 'with the same message the employee gets');
  eq((await pool.query('SELECT status FROM pto_requests WHERE id = 61')).rows[0].status, 'pending', 'and the request is untouched');

  console.log('== hours ride through the balance wall and the context payload ==');
  await pool.query("UPDATE users SET pto_balance_hours = 4 WHERE id = 7;");
  var apD = await reqBody('POST', '/api/pto/requests/61/approve', { days: [
    { date: d(95), kind: 'paid', hours: 8 }, { date: d(96), kind: 'paid', hours: 8 } ] });
  eq(apD.status, 400, '16 hours is refused against a 4-hour balance');
  var ctxP = await req('GET', '/api/pto/requests/61/context');
  eq(ctxP.status, 200, 'context loads');
  eq(ctxP.body.request.days.map(function (x) { return x.hours; }).join(','), '3,8', 'and hands the approver the per-day amounts');
  var apE = await reqBody('POST', '/api/pto/requests/61/approve', { days: [
    { date: d(95), kind: 'paid', hours: 2 }, { date: d(96), kind: 'paid', hours: 2 } ] });
  eq(apE.status, 200, 'cutting the hours rescues it, exactly as re-tagging does');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 7')).rows[0].b), 0, 'landing exactly at zero');

  console.log('== cancelling a partial day restores the partial amount ==');
  var canP = await req('POST', '/api/pto/requests/61/cancel');
  eq(canP.status, 200, 'cancel accepted');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 7')).rows[0].b), 4, 'the 4 hours come back, not 16');


  console.log('== a retroactive log spreads its hours across the days it covers ==');
  await pool.query('DELETE FROM pto_request_days; DELETE FROM pto_requests; DELETE FROM pto_ledger; DELETE FROM shifts;');
  await pool.query('UPDATE users SET pto_balance_hours = 24 WHERE id = 7;');
  var logA = await reqBody('POST', '/api/pto/log', { user_id: 7, start_date: d(-10), end_date: d(-8), kind: 'paid', hours: 11, reason: 'Called out, converting to PTO' });
  eq(logA.status, 200, 'logged after the fact');
  var lrow = (await pool.query('SELECT hours FROM pto_requests WHERE id = $1', [logA.body.request_id])).rows[0];
  eq(Number(lrow.hours), 11, 'the request carries the total that was entered');
  var lday = (await pool.query('SELECT hours FROM pto_request_days WHERE request_id = $1 ORDER BY day_date', [logA.body.request_id])).rows.map(function (x) { return Number(x.hours); });
  eq(lday.reduce(function (a, b) { return Math.round((a + b) * 100) / 100; }, 0), 11, 'and the per-day amounts add back up to it');
  ok(lday.every(function (x) { return x >= 0; }), 'with no day coming out negative');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 7')).rows[0].b), 13, 'the balance is docked once, by the total');
  var logB = await reqBody('POST', '/api/pto/log', { user_id: 7, start_date: d(-20), end_date: d(-20), kind: 'paid', hours: 0.5, reason: 'Half an hour short' });
  eq(logB.status, 200, 'a half-hour log is legal');
  eq(Number((await pool.query('SELECT hours FROM pto_request_days WHERE request_id = $1', [logB.body.request_id])).rows[0].hours), 0.5, 'stored on the day');


  console.log('== commission staff take whole days, never part days ==');
  // Christopher (id 3) is commission: his balance is reported in days, so an
  // hours-level deduction has nowhere to live on his record.
  await pool.query('DELETE FROM pto_request_days; DELETE FROM pto_requests; DELETE FROM pto_ledger; DELETE FROM shifts;');
  await pool.query('UPDATE users SET pto_balance_hours = 40 WHERE id = 3;');
  CURRENT_USER = { id: 3, name: 'Christopher Benson', role: 'employee', isOwner: false };
  var comA = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(100), kind: 'paid', hours: 3 }] });
  eq(comA.status, 400, 'a 3-hour ask from a commission employee is refused');
  ok(String(comA.body.error).indexOf('whole days') !== -1, 'and says why');
  eq((await pool.query('SELECT COUNT(*)::int c FROM pto_requests')).rows[0].c, 0, 'nothing was written');
  var comB = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(100), kind: 'paid' }] });
  eq(comB.status, 200, 'a whole day goes through as it always did');
  eq(Number(comB.body.hours), 8, 'costing one full day');
  var comC = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(101), kind: 'paid', hours: 8 }] });
  eq(comC.status, 200, 'an explicit full day is fine too');
  var comD = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [
    { date: d(102), kind: 'paid' }, { date: d(103), kind: 'paid', hours: 6 } ] });
  eq(comD.status, 400, 'one part day anywhere in the request is enough to refuse it');

  console.log('== and an approver cannot cut a commission day to part of one ==');
  CURRENT_USER = { id: 1, name: 'Ada Admin', role: 'admin', isOwner: true };
  var comReq = comB.body.id;
  var comE = await reqBody('POST', '/api/pto/requests/' + comReq + '/approve', { days: [{ date: d(100), kind: 'paid', hours: 4 }] });
  eq(comE.status, 400, 'the approver is held to the same rule');
  ok(String(comE.body.error).indexOf('whole days') !== -1, 'with the same explanation');
  eq((await pool.query('SELECT status FROM pto_requests WHERE id = $1', [comReq])).rows[0].status, 'pending', 'and the request is untouched');
  var comF = await reqBody('POST', '/api/pto/requests/' + comReq + '/approve', { days: [{ date: d(100), kind: 'unpaid' }] });
  eq(comF.status, 200, 're-classifying the whole day is still allowed');
  eq(Number(comF.body.hours), 0, 'and costs nothing');
  eq(Number((await pool.query('SELECT pto_balance_hours b FROM users WHERE id = 3')).rows[0].b), 40, 'the commission balance is untouched');

  console.log('== an hourly employee is not caught by the commission rule ==');
  CURRENT_USER = { id: 7, name: 'Tara Ridge', role: 'employee', isOwner: false };
  await pool.query('UPDATE users SET pto_balance_hours = 24 WHERE id = 7;');
  var hrlyOK = await reqBody('POST', '/api/pto/requests', { type: 'Vacation', days: [{ date: d(105), kind: 'paid', hours: 3 }] });
  eq(hrlyOK.status, 200, 'the same 3-hour ask goes through for an hourly person');
  eq(Number(hrlyOK.body.hours), 3, 'at three hours');
  CURRENT_USER = { id: 1, name: 'Ada Admin', role: 'admin', isOwner: true };

  console.log('== a non-approver still cannot re-tag ==');
  await freshReq(55);
  CURRENT_USER = { id: 99, name: 'Nobody', role: 'employee', isOwner: false };
  var forb2 = await reqBody('POST', '/api/pto/requests/55/approve', { days: [{ date: d(50), kind: 'off' }, { date: d(51), kind: 'off' }, { date: d(52), kind: 'off' }] });
  eq(forb2.status, 403, 'refused before any re-tag is considered');
  eq((await pool.query('SELECT status FROM pto_requests WHERE id = 55')).rows[0].status, 'pending', 'request untouched');
  CURRENT_USER = { id: 1, name: 'Ada Admin', role: 'admin', isOwner: true };

  server.close();
  await pool.end();
  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
