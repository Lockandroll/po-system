'use strict';
/*
 * Schedule: publishing removed, manager-only notes, recurring-schedule (series)
 * update, and "Delete this + all future" - against a REAL Postgres.
 *
 * What it pins:
 *   - initDB() on a database that has never seen shift_series / manager_notes
 *     works, is safe to run twice, and promotes any lingering draft;
 *   - every writer stamps status='published' (single, recurring, copy-week);
 *   - POST /publish and bulk-ids publish/unpublish are gone;
 *   - manager_notes reach manager / admin / owner and are ABSENT for anyone
 *     else on every reader (/me, /city, /shifts, /shifts/:id, history) even when
 *     that someone holds manage_schedule;
 *   - a non-manager cannot write manager_notes, and a PUT that omits the field
 *     (drag move, older client) keeps the note;
 *   - /recurring creates a series and stamps series_id on every shift;
 *   - PUT /series/:id replaces shifts from apply_from onward only, keeps the
 *     rotation rhythm counted from start_date, and leaves earlier shifts alone;
 *   - POST /bulk {all_future:true} deletes from a date forward with no upper
 *     bound, honouring the caller's city scope.
 *
 *   PGURL=postgres://tester@localhost/sched_test node test-schedule-series.js
 */
var http = require('http');
var Module = require('module');
var { Pool } = require('pg');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) PASS++; else { FAIL++; console.error('  FAIL: ' + label); } }
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n== ' + t); }

process.env.DATABASE_URL = process.env.PGURL;
var pool = new Pool({ connectionString: process.env.PGURL });

var CURRENT_USER = { id: 1, name: 'Admin', role: 'admin', isOwner: true };
var AUDITS = [];

var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return require('./db.js');
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = Object.assign({}, CURRENT_USER); next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
  };
  if (request === '../utils/audit') return { logAudit: async function (e) { AUDITS.push(e); } };
  if (request === '../utils/email') return { sendEmail: async function () {}, emailTemplate: function (o) { return String((o && o.body) || ''); } };
  if (request === '../utils/sms') return { sendSms: async function () {} };
  if (request === '../utils/push') return { isReady: function () { return true; }, publicKey: function () { return 'k'; }, sendPushToUsers: async function () {} };
  return origLoad.apply(this, arguments);
};

var express = require('express');
var db = require('./db.js');
var router = require('./routes/schedule.js');
var app = express();
app.use(express.json());
app.use('/api/schedule', router);
var server;

function req(method, path, body) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : JSON.stringify(body);
    var r = http.request({ host: '127.0.0.1', port: server.address().port, method: method, path: path,
      headers: { 'content-type': 'application/json' } }, function (res) {
      var b = ''; res.on('data', function (c) { b += c; });
      res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: b }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
function as(u) { CURRENT_USER = u; }

// owner arrives at a route as role 'admin' + isOwner (middleware coerces it)
var OWNER = { id: 1, name: 'Tony McKeon', role: 'admin', isOwner: true };
var ADMIN = { id: 2, name: 'Ava Admin', role: 'admin' };
var MGR   = { id: 3, name: 'Dana Reed', role: 'manager' };
var COORD = { id: 4, name: 'Kay Coord', role: 'locksmith_coordinator' }; // holds manage_schedule in this test, still no mgr notes
var TECH  = { id: 5, name: 'Marcus Hale', role: 'locksmith' };
var TECH2 = { id: 6, name: 'Rosa Lin', role: 'locksmith' };
var CITYMGR = { id: 7, name: 'Cal City', role: 'manager' }; // scoped to ORL only

function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(ds, n) { var a = ds.split('-').map(Number); var dt = new Date(Date.UTC(a[0], a[1] - 1, a[2])); dt.setUTCDate(dt.getUTCDate() + n); return ymd(dt); }
var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function seed() {
  var people = [[1, 'Tony McKeon', 'owner', 'CHS'], [2, 'Ava Admin', 'admin', 'CHS'], [3, 'Dana Reed', 'manager', 'CHS'], [4, 'Kay Coord', 'locksmith_coordinator', 'CHS'], [5, 'Marcus Hale', 'locksmith', 'CHS'], [6, 'Rosa Lin', 'locksmith', 'ORL'], [7, 'Cal City', 'manager', 'ORL']];
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    await pool.query('INSERT INTO users (id, name, email, password_hash, role, home_city, active) ' + "VALUES ($1,$2,$3,'x',$4,$5,true) ON CONFLICT (id) DO NOTHING", [p[0], p[1], 'u' + p[0] + '@example.com', p[2], p[3]]);
  }
  await pool.query("INSERT INTO cities (code, name, active) VALUES ('CHS','Charleston',true),('ORL','Orlando',true) ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO user_cities (user_id, city_code) VALUES (7,'ORL') ON CONFLICT DO NOTHING");
  // a lingering draft from the old world
  await pool.query("INSERT INTO shifts (user_id, user_name, city_code, position_id, shift_date, start_time, end_time, status) VALUES (5,'Marcus Hale','CHS',NULL,$1,'09:00','17:00','draft')", ['2026-01-05']);
}

(async function main() {
  section('initDB: fresh, twice, promotes drafts');
  await db.initDB();
  await seed();
  await db.initDB(); // second run: idempotent + promotes the seeded draft
  var cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='shifts'")).rows.map(function (r) { return r.column_name; });
  ok(cols.indexOf('manager_notes') !== -1, 'shifts.manager_notes exists');
  ok(cols.indexOf('series_id') !== -1, 'shifts.series_id exists');
  ok((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name='shift_series'")).rows.length === 1, 'shift_series table exists');
  eq((await pool.query("SELECT status FROM shifts WHERE shift_date='2026-01-05'")).rows[0].status, 'published', 'old draft promoted to published');
  eq((await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name='shifts' AND column_name='status'")).rows[0].column_default, "'published'::character varying", 'status default is published');
  var posId = (await pool.query("SELECT id FROM shift_positions WHERE lower(name)='on call' LIMIT 1")).rows[0];
  if (!posId) { await pool.query("INSERT INTO shift_positions (name, color) VALUES ('On Call','#a855f7')"); posId = (await pool.query("SELECT id FROM shift_positions WHERE lower(name)='on call' LIMIT 1")).rows[0]; }
  var POS = posId.id;

  server = app.listen(0); await new Promise(function (r) { server.once('listening', r); });

  section('publishing is gone');
  as(OWNER);
  var r = await req('POST', '/api/schedule/publish', { from: TODAY, to: addDays(TODAY, 6) });
  eq(r.status, 404, 'POST /publish no longer exists');
  var d1 = addDays(TODAY, 7);
  r = await req('POST', '/api/schedule/shifts', { user_id: 5, shift_date: d1, start_time: '09:00', end_time: '17:00', position_id: POS, city_code: 'CHS', notes: 'plain', manager_notes: 'called out last Tuesday', publish: false });
  eq(r.status, 201, 'single shift created');
  var S1 = r.body.shift.id;
  eq(r.body.shift.status, 'published', 'single shift is live immediately (publish:false ignored)');
  ok(!!r.body.shift.published_at, 'published_at stamped');
  eq(r.body.shift.manager_notes, 'called out last Tuesday', 'owner gets manager_notes back on create');
  r = await req('POST', '/api/schedule/bulk-ids', { action: 'unpublish', ids: [S1] });
  eq(r.status, 400, 'bulk unpublish is an unknown action now');
  eq((await pool.query('SELECT status FROM shifts WHERE id=$1', [S1])).rows[0].status, 'published', 'still published');

  section('manager-only notes: who sees them');
  async function seen(u, path) { as(u); var x = await req('GET', path); return x; }
  var wk = '?from=' + d1 + '&to=' + d1;
  r = await seen(OWNER, '/api/schedule/shifts' + wk); eq(r.body[0].manager_notes, 'called out last Tuesday', 'owner sees on grid');
  r = await seen(ADMIN, '/api/schedule/shifts' + wk); eq(r.body[0].manager_notes, 'called out last Tuesday', 'admin sees on grid');
  r = await seen(MGR, '/api/schedule/shifts' + wk); eq(r.body[0].manager_notes, 'called out last Tuesday', 'manager sees on grid');
  r = await seen(COORD, '/api/schedule/shifts' + wk); ok(!('manager_notes' in r.body[0]), 'coordinator with manage_schedule: key ABSENT on grid');
  eq(r.body[0].notes, 'plain', 'regular notes still visible to coordinator');
  r = await seen(COORD, '/api/schedule/shifts/' + S1); ok(!('manager_notes' in r.body), 'coordinator: absent on single read');
  r = await seen(MGR, '/api/schedule/shifts/' + S1); eq(r.body.manager_notes, 'called out last Tuesday', 'manager: single read has it');
  r = await seen(TECH, '/api/schedule/me' + wk); eq(r.body.length, 1, 'tech sees own shift on /me'); ok(!('manager_notes' in r.body[0]), 'tech: absent on /me');
  r = await seen(TECH, '/api/schedule/city' + wk + '&city=CHS'); ok(r.body.shifts.length >= 1 && !('manager_notes' in r.body.shifts[0]), 'tech: absent on /city');
  r = await seen(MGR, '/api/schedule/city' + wk + '&city=CHS'); eq(r.body.shifts[0].manager_notes, 'called out last Tuesday', 'manager: /city has it');

  section('manager-only notes: who writes them');
  as(COORD);
  var full = { user_id: 5, shift_date: d1, start_time: '09:00', end_time: '17:30', position_id: POS, city_code: 'CHS', notes: 'plain', manager_notes: 'HACKED' };
  r = await req('PUT', '/api/schedule/shifts/' + S1, full);
  eq(r.status, 200, 'coordinator can edit the shift');
  eq((await pool.query('SELECT manager_notes, end_time FROM shifts WHERE id=$1', [S1])).rows[0], { manager_notes: 'called out last Tuesday', end_time: '17:30' }, 'coordinator PUT changed the time but NOT the manager note');
  as(COORD);
  r = await req('POST', '/api/schedule/shifts', { user_id: 6, shift_date: d1, start_time: '09:00', end_time: '17:00', position_id: POS, city_code: 'ORL', manager_notes: 'nope' });
  eq(r.status, 201, 'coordinator creates a shift'); var S2 = r.body.shift.id;
  eq((await pool.query('SELECT manager_notes FROM shifts WHERE id=$1', [S2])).rows[0].manager_notes, null, 'coordinator-supplied manager_notes dropped on create');
  as(MGR);
  var noField = { user_id: 5, shift_date: addDays(d1, 1), start_time: '09:00', end_time: '17:30', position_id: POS, city_code: 'CHS', notes: 'plain', via: 'drag' };
  r = await req('PUT', '/api/schedule/shifts/' + S1, noField);
  eq(r.status, 200, 'manager drag-move PUT (no manager_notes key)');
  eq((await pool.query('SELECT manager_notes FROM shifts WHERE id=$1', [S1])).rows[0].manager_notes, 'called out last Tuesday', 'drag move keeps the note');
  r = await req('PUT', '/api/schedule/shifts/' + S1, Object.assign({}, noField, { manager_notes: 'covered by Rosa', via: undefined }));
  eq(r.body.shift.manager_notes, 'covered by Rosa', 'manager edits the note');
  r = await req('PUT', '/api/schedule/shifts/' + S1, Object.assign({}, noField, { manager_notes: '', via: undefined }));
  eq(r.body.shift.manager_notes, null, 'manager clears the note (blank -> null)');
  as(MGR); r = await req('GET', '/api/schedule/shifts/' + S1 + '/history');
  var mgrHist = r.body.filter(function (e) { return e.details && e.details.changes && e.details.changes.manager_notes; });
  ok(mgrHist.length >= 2, 'history logs manager_notes changes for a manager');
  as(COORD); r = await req('GET', '/api/schedule/shifts/' + S1 + '/history');
  var leaked = r.body.filter(function (e) { return e.details && e.details.changes && e.details.changes.manager_notes; });
  eq(leaked.length, 0, 'history hides manager_notes changes from the coordinator');
  ok(r.body.some(function (e) { return e.details && e.details.changes && e.details.changes.end_time; }), 'coordinator still sees ordinary changes');

  section('recurring: series created, all live');
  as(MGR);
  var start = addDays(TODAY, 14); // a future Monday-agnostic start
  r = await req('POST', '/api/schedule/recurring', { user_id: 5, mode: 'rotation', days_on: 4, days_off: 2, start_date: start, weeks: 6, start_time: '06:00', end_time: '18:00', position_id: POS, city_code: 'CHS', notes: 'rot', manager_notes: 'series note', publish: false });
  eq(r.status, 200, 'recurring created');
  ok(r.body.series_id > 0, 'series_id returned'); var SER = r.body.series_id;
  eq(r.body.created, 28, '6 weeks of 4-on/2-off = 42 days -> 28 shifts');
  var rows = (await pool.query('SELECT shift_date, status, series_id, manager_notes FROM shifts WHERE series_id=$1 ORDER BY shift_date', [SER])).rows;
  eq(rows.length, 28, 'all 28 carry series_id');
  ok(rows.every(function (x) { return x.status === 'published'; }), 'every generated shift is published');
  ok(rows.every(function (x) { return x.manager_notes === 'series note'; }), 'manager note copied onto each shift');
  // rhythm check: day 0..3 on, 4..5 off
  var dates = rows.map(function (x) { return ymd(x.shift_date); });
  eq(dates.slice(0, 4), [start, addDays(start, 1), addDays(start, 2), addDays(start, 3)], 'first 4 days on');
  eq(dates[4], addDays(start, 6), 'then 2 off, back on day 6');
  as(COORD); r = await req('GET', '/api/schedule/series/' + SER);
  eq(r.status, 200, 'coordinator can read the series'); ok(!('manager_notes' in r.body), 'series manager_notes absent for coordinator');
  as(MGR); r = await req('GET', '/api/schedule/series/' + SER);
  eq(r.body.manager_notes, 'series note', 'series manager_notes for manager');
  eq(r.body.future_shifts, 28, 'future_shifts counted'); eq(r.body.start_date, start, 'start_date as YYYY-MM-DD'); eq(r.body.mode, 'rotation', 'mode');

  section('recurring: update from a date forward');
  // Someone edited one future shift by hand; the series update replaces it (series wins).
  var handEdited = rows[10].shift_date; var handId = (await pool.query('SELECT id FROM shifts WHERE series_id=$1 AND shift_date=$2', [SER, handEdited])).rows[0].id;
  await pool.query("UPDATE shifts SET notes='hand edit' WHERE id=$1", [handId]);
  var applyFrom = addDays(start, 12); // day 12 = start of the 3rd cycle
  as(MGR);
  r = await req('PUT', '/api/schedule/series/' + SER, { start_time: '07:00', end_time: '19:00', apply_from: applyFrom, notes: 'rot2' });
  eq(r.status, 200, 'series updated'); eq(r.body.apply_from, applyFrom, 'apply_from echoed');
  // before applyFrom: days 0-3, 6-9 = 8 shifts kept; after: days 12..41 -> 30 days = 5 cycles -> 20 shifts
  eq(r.body.removed, 20, 'removed the 20 future shifts'); eq(r.body.created, 20, 'regenerated 20');
  rows = (await pool.query('SELECT shift_date, start_time, notes FROM shifts WHERE series_id=$1 ORDER BY shift_date', [SER])).rows;
  eq(rows.length, 28, 'still 28 shifts in the series');
  ok(rows.slice(0, 8).every(function (x) { return x.start_time === '06:00' && x.notes === 'rot'; }), 'the 8 earlier shifts untouched');
  ok(rows.slice(8).every(function (x) { return x.start_time === '07:00' && x.notes === 'rot2'; }), 'the 20 later shifts carry the new times/notes');
  eq(ymd(rows[8].shift_date), applyFrom, 'first regenerated day is apply_from (rhythm preserved from start_date)');
  eq(ymd(rows[12].shift_date), addDays(start, 18), 'cycle still counts from the original start_date');
  var mgrSer = (await pool.query('SELECT manager_notes, start_time, notes FROM shift_series WHERE id=$1', [SER])).rows[0];
  eq(mgrSer, { manager_notes: 'series note', start_time: '07:00', notes: 'rot2' }, 'series row updated, manager note kept when not sent');
  // switch the pattern to weekly Mon-Fri from a later date, coordinator may do it but cannot touch manager notes
  as(COORD);
  var applyFrom2 = addDays(start, 24);
  r = await req('PUT', '/api/schedule/series/' + SER, { mode: 'weekly', weekdays: [1, 2, 3, 4, 5], apply_from: applyFrom2, manager_notes: 'HACK' });
  eq(r.status, 200, 'coordinator switches the series to weekly');
  eq((await pool.query('SELECT manager_notes, mode FROM shift_series WHERE id=$1', [SER])).rows[0], { manager_notes: 'series note', mode: 'weekly' }, 'coordinator cannot change the series manager note');
  var after = (await pool.query('SELECT shift_date FROM shifts WHERE series_id=$1 AND shift_date >= $2 ORDER BY shift_date', [SER, applyFrom2])).rows;
  ok(after.length > 0 && after.every(function (x) { var d = x.shift_date.getUTCDay(); return d >= 1 && d <= 5; }), 'weekday-only from applyFrom2 (' + after.length + ' shifts)');
  as(CITYMGR); r = await req('PUT', '/api/schedule/series/' + SER, { start_time: '08:00' });
  eq(r.status, 403, 'ORL-only manager cannot touch a CHS series');
  as(MGR); r = await req('PUT', '/api/schedule/series/' + SER, { mode: 'weekly', weekdays: [] });
  eq(r.status, 400, 'invalid definition rejected');
  r = await req('GET', '/api/schedule/series/999999'); eq(r.status, 404, 'unknown series 404');

  section('delete this + all future');
  as(MGR);
  var cut = addDays(start, 20);
  var beforeCount = (await pool.query('SELECT COUNT(*)::int AS n FROM shifts WHERE user_id=5 AND shift_date < $1', [cut])).rows[0].n;
  var futureCount = (await pool.query('SELECT COUNT(*)::int AS n FROM shifts WHERE user_id=5 AND shift_date >= $1', [cut])).rows[0].n;
  ok(futureCount > 5, 'there are future shifts to remove (' + futureCount + ')');
  r = await req('POST', '/api/schedule/bulk', { user_id: 5, from: cut, all_future: true, action: 'delete' });
  eq(r.status, 200, 'all_future delete ok'); eq(r.body.affected, futureCount, 'removed exactly the future shifts');
  eq((await pool.query('SELECT COUNT(*)::int AS n FROM shifts WHERE user_id=5 AND shift_date >= $1', [cut])).rows[0].n, 0, 'nothing left from cut onward');
  eq((await pool.query('SELECT COUNT(*)::int AS n FROM shifts WHERE user_id=5 AND shift_date < $1', [cut])).rows[0].n, beforeCount, 'earlier shifts untouched');
  ok(AUDITS.some(function (a) { return a.action === 'delete_future_shifts' && a.details.count === futureCount; }), 'audit row written');
  r = await req('POST', '/api/schedule/bulk', { user_id: 5, from: cut, action: 'delete' });
  eq(r.status, 400, 'without all_future a `to` is still required');
  // city scope: ORL-only manager cannot wipe a CHS person's future
  as(OWNER); await req('POST', '/api/schedule/shifts', { user_id: 6, shift_date: addDays(TODAY, 30), start_time: '09:00', end_time: '17:00', position_id: POS, city_code: 'CHS' });
  await req('POST', '/api/schedule/shifts', { user_id: 6, shift_date: addDays(TODAY, 31), start_time: '09:00', end_time: '17:00', position_id: POS, city_code: 'ORL' });
  as(CITYMGR); r = await req('POST', '/api/schedule/bulk', { user_id: 6, from: addDays(TODAY, 29), all_future: true, action: 'delete' });
  eq(r.body.affected, 1, 'city-scoped manager removed only the ORL shift');
  eq((await pool.query("SELECT COUNT(*)::int AS n FROM shifts WHERE user_id=6 AND city_code='CHS' AND shift_date >= $1", [addDays(TODAY, 29)])).rows[0].n, 1, 'CHS shift survived');

  section('copy week is live too');
  as(OWNER);
  var mon = (function () { var d = new Date(addDays(TODAY, 40) + 'T00:00:00Z'); var back = (d.getUTCDay() + 6) % 7; return addDays(ymd(d), -back); })();
  await req('POST', '/api/schedule/shifts', { user_id: 5, shift_date: mon, start_time: '09:00', end_time: '17:00', position_id: POS, city_code: 'CHS' });
  r = await req('POST', '/api/schedule/copy-week', { source_monday: mon, target_monday: addDays(mon, 7) });
  eq(r.body.copied, 1, 'copied one');
  eq((await pool.query('SELECT status FROM shifts WHERE user_id=5 AND shift_date=$1', [addDays(mon, 7)])).rows[0].status, 'published', 'copy is published');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  server.close(); await pool.end();
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(2); });
