'use strict';
/*
 * Scheduled dispatch calls (Tony 2026-10-15) - API tests against a real Postgres.
 * Run: DATABASE_URL=postgres://tester@localhost/nova?host=/tmp/pgs&port=55432 node test-dispatch-scheduled.js
 * Runs the real initDB() from db.js, mounts the real routes/dispatch.js (auth and
 * push stubbed), and the real release + unassigned-alert jobs from jobs/dispatch.js.
 * No backticks anywhere in this file (Windows corrupts them in .js).
 */
var http = require('http');
var express = require('express');
var Module = require('module');

var pushes = [];
var auth = { user: { id: 0, name: 'Test Admin', role: 'admin' } };
var _load = Module._load;
Module._load = function (request) {
  if (request === '../middleware/auth') {
    return {
      requireAuth: function (req, res, next) { req.user = auth.user; req._userRow = { extra_perms: [] }; next(); },
      requirePermission: function () { return function (req, res, next) { next(); }; }
    };
  }
  if (request === '../utils/push') {
    return { sendPushToUsers: async function (ids, msg) { pushes.push({ ids: ids, msg: msg }); } };
  }
  return _load.apply(this, arguments);
};

var db = require('./db');
var pool = db.pool;
var router = require('./routes/dispatch');
var jobs = require('./jobs/dispatch');

var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

var server, base;
function call(method, path, body) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var u = new URL(base + path);
    var r = http.request({ method: method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      function (res) {
        var buf = '';
        res.on('data', function (c) { buf += c; });
        res.on('end', function () {
          var j = null; try { j = JSON.parse(buf); } catch (e) { j = buf; }
          resolve({ status: res.statusCode, body: j });
        });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Wall clock in a zone, N days from now, as "YYYY-MM-DDTHH:MM".
function localIn(tz, days, hhmm) {
  var p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Date.now() + days * 86400000)).forEach(function (x) { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day + 'T' + hhmm;
}
function wallClock(at, tz) {
  var p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
    .forEach(function (x) { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
}

async function setup() {
  await db.initDB();
  await pool.query("DELETE FROM dispatch_jobs WHERE customer_name LIKE 'SchedTest%'");
  await pool.query("INSERT INTO cities (code, name, active, timezone) VALUES ('ZBH', 'Zbirmingham', true, 'America/Chicago') " +
    "ON CONFLICT (code) DO UPDATE SET timezone = 'America/Chicago', active = true");
  await pool.query("INSERT INTO service_categories (code, name) VALUES ('ztest', 'Ztest') ON CONFLICT (code) DO NOTHING");
  var st = await pool.query("INSERT INTO service_types (code, name, category_code, active) VALUES ('ZLOCK', 'Zlockout', 'ztest', true) " +
    "ON CONFLICT (code) DO UPDATE SET active = true RETURNING id");
  var adm = await pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('sched-admin@test', 'Sched Admin', 'x', 'admin') " +
    "ON CONFLICT (email) DO UPDATE SET role = 'admin' RETURNING id");
  var tech = await pool.query("INSERT INTO users (email, name, password_hash, role, home_city) VALUES ('sched-tech@test', 'Sched Tech', 'x', 'locksmith', 'ZBH') " +
    "ON CONFLICT (email) DO UPDATE SET home_city = 'ZBH', active = true RETURNING id");
  await pool.query("INSERT INTO user_service_categories (user_id, category_code, can_view, can_be_assigned) VALUES ($1, 'ztest', true, true) " +
    "ON CONFLICT DO NOTHING", [tech.rows[0].id]);
  await pool.query("DELETE FROM settings WHERE key = 'dispatch_schedule_lead_minutes'");
  auth.user = { id: adm.rows[0].id, name: 'Sched Admin', role: 'admin' };
  return { st: st.rows[0].id, tech: tech.rows[0].id };
}

function newCall(o, extra) {
  return Object.assign({ callback_phone: '2055550142', customer_name: 'SchedTest ' + (o || ''), service_type_id: S.st,
    address: '1 Main St', zip: '35203', city_code: 'ZBH', created_via: 'new_call' }, extra || {});
}

var S;
async function main() {
  S = await setup();
  var app = express();
  app.use(express.json());
  app.use('/api/dispatch', router);
  server = app.listen(0);
  base = 'http://127.0.0.1:' + server.address().port + '/api/dispatch';

  // ---- create a scheduled call, Birmingham clock
  var when = localIn('America/Chicago', 2, '14:30');
  var r = await call('POST', '/jobs', newCall('A', { scheduled_for: when, eta_minutes: '30' }));
  eq(r.status, 200, 'create scheduled 200 ' + JSON.stringify(r.body).slice(0, 200));
  var A = r.body;
  eq(A.status, 'scheduled', 'status scheduled');
  eq(wallClock(A.scheduled_for, 'America/Chicago'), when, 'scheduled_for is Birmingham wall clock');
  eq(A.eta_promised_at, A.scheduled_for, 'promise = appointment');
  eq(A.eta_minutes, null, 'no minutes ETA on a scheduled call');
  eq(A.eta_source, 'scheduled', 'eta_source scheduled');
  eq(A.city_tz, 'America/Chicago', 'city_tz comes back on the job');
  var ev = await pool.query("SELECT event, detail FROM dispatch_job_events WHERE job_id = $1 ORDER BY id", [A.id]);
  ok(ev.rows.some(function (e) { return e.event === 'scheduled' && /2:30 PM/.test(e.detail); }), 'scheduled event names 2:30 PM');

  // ---- rejections
  r = await call('POST', '/jobs', newCall('past', { scheduled_for: localIn('America/Chicago', -1, '09:00') }));
  eq(r.status, 400, 'past time rejected');
  r = await call('POST', '/jobs', newCall('edu', { scheduled_for: when, is_edu: true }));
  eq(r.status, 400, 'EDU cannot be scheduled');
  r = await call('POST', '/jobs', newCall('bad', { scheduled_for: '2027-02-30T10:00' }));
  eq(r.status, 400, 'impossible date rejected');
  r = await call('POST', '/jobs', newCall('far', { scheduled_for: localIn('America/Chicago', 120, '10:00') }));
  eq(r.status, 400, 'more than 90 days rejected');

  // ---- pre-assigned scheduled call: heads-up push only, acknowledge clock not started
  pushes = [];
  r = await call('POST', '/jobs', newCall('B', { scheduled_for: when, assigned_to: S.tech }));
  var B = r.body;
  eq(B.status, 'scheduled', 'pre-assigned stays scheduled');
  eq(B.assigned_to, S.tech, 'assigned_to kept');
  eq(B.assigned_at, null, 'assigned_at not stamped yet');
  ok(pushes.length === 1 && /^Scheduled call/.test(pushes[0].msg.title), 'heads-up push, not New call');

  // ---- tech status moves are refused while scheduled
  r = await call('POST', '/jobs/' + B.id + '/status', { status: 'accepted' });
  eq(r.status, 409, 'cannot acknowledge a scheduled call');

  // ---- assign on a scheduled call keeps it scheduled
  pushes = [];
  r = await call('POST', '/jobs/' + A.id + '/assign', { user_id: S.tech });
  eq(r.status, 200, 'assign scheduled 200');
  eq(r.body.job.status, 'scheduled', 'assign keeps scheduled');
  eq(r.body.job.assigned_at, null, 'assign does not start the clock');
  ok(pushes.length === 1 && /^Scheduled call/.test(pushes[0].msg.title), 'assign sends heads-up');
  r = await call('POST', '/jobs/' + A.id + '/assign', { user_id: null });
  eq(r.body.job.status, 'scheduled', 'unassign keeps scheduled');

  // ---- board + lookup see it
  r = await call('GET', '/jobs');
  ok(r.body.jobs.some(function (j) { return j.id === A.id && j.status === 'scheduled'; }), 'board lists scheduled');
  eq(r.body.scheduleLeadMinutes, 60, 'board reports lead minutes');
  r = await call('GET', '/lookup?phone=2055550142');
  ok((r.body.open || []).some(function (j) { return j.id === A.id; }), 'lookup shows scheduled as open');

  // ---- quote preview prices for the scheduled time
  r = await call('GET', '/quote-preview?service_type_id=' + S.st + '&city_code=ZBH&scheduled_for=' + encodeURIComponent(when));
  ok(r.body && /2:30 PM/.test(r.body.scheduled_label || ''), 'quote preview labels the scheduled time');

  // ---- release job: nothing due yet
  var n = await router.releaseDueScheduled();
  eq(n, 0, 'nothing released 2 days out');

  // Make A due (30 min out, inside the 60 min lead), B due too, and backdate created_at.
  await pool.query("UPDATE dispatch_jobs SET scheduled_for = NOW() + interval '30 minutes', created_at = NOW() - interval '2 days' WHERE id = ANY($1)", [[A.id, B.id]]);
  pushes = [];
  await jobs.runScheduledRelease();
  var rows = (await pool.query('SELECT id, status, released_at, assigned_at, assigned_to FROM dispatch_jobs WHERE id = ANY($1) ORDER BY id', [[A.id, B.id]])).rows;
  eq(rows[0].status, 'new', 'unassigned scheduled call released to new');
  ok(!!rows[0].released_at, 'released_at stamped');
  eq(rows[1].status, 'assigned', 'pre-assigned call released to assigned');
  ok(!!rows[1].assigned_at, 'acknowledge clock starts at release');
  ok(pushes.some(function (p) { return /^New call/.test(p.msg.title) && p.ids[0] === S.tech; }), 'tech gets the New call push at release');
  n = await router.releaseDueScheduled();
  eq(n, 0, 'second tick releases nothing (no double send)');

  // Unassigned alert counts from release, not from creation two days ago.
  await jobs.runUnassignedAlerts();
  var al = await pool.query('SELECT unassigned_alert_at FROM dispatch_jobs WHERE id = $1', [A.id]);
  eq(al.rows[0].unassigned_alert_at, null, 'no instant unassigned alert after release');
  await pool.query("UPDATE dispatch_jobs SET released_at = NOW() - interval '10 minutes' WHERE id = $1", [A.id]);
  await jobs.runUnassignedAlerts();
  al = await pool.query('SELECT unassigned_alert_at FROM dispatch_jobs WHERE id = $1', [A.id]);
  ok(!!al.rows[0].unassigned_alert_at, 'unassigned alert fires 10 min after release');

  // ---- push a live call to later, reschedule it, then Dispatch now
  r = await call('POST', '/jobs', newCall('C'));
  var C = r.body;
  eq(C.status, 'new', 'plain call is new');
  var later = localIn('America/Chicago', 3, '08:15');
  r = await call('POST', '/jobs/' + C.id + '/schedule', { scheduled_for: later });
  eq(r.status, 200, 'schedule a live call 200');
  eq(r.body.status, 'scheduled', 'live call moved to scheduled');
  eq(wallClock(r.body.scheduled_for, 'America/Chicago'), later, 'moved time correct');
  var later2 = localIn('America/Chicago', 4, '16:45');
  r = await call('POST', '/jobs/' + C.id + '/schedule', { scheduled_for: later2 });
  eq(wallClock(r.body.scheduled_for, 'America/Chicago'), later2, 'rescheduled time correct');
  ev = await pool.query("SELECT event FROM dispatch_job_events WHERE job_id = $1 ORDER BY id", [C.id]);
  ok(ev.rows.some(function (e) { return e.event === 'rescheduled'; }), 'rescheduled event logged');
  r = await call('POST', '/jobs/' + C.id + '/release', {});
  eq(r.status, 200, 'dispatch now 200');
  eq(r.body.status, 'new', 'dispatch now -> new');
  r = await call('POST', '/jobs/' + C.id + '/release', {});
  eq(r.status, 409, 'dispatch now twice -> 409');

  // An acknowledged call cannot be pushed to later.
  await pool.query("UPDATE dispatch_jobs SET status = 'accepted' WHERE id = $1", [C.id]);
  r = await call('POST', '/jobs/' + C.id + '/schedule', { scheduled_for: later });
  eq(r.status, 409, 'acknowledged call cannot be scheduled');

  // ---- lead minutes setting
  r = await call('POST', '/settings', { dispatch_schedule_lead_minutes: '90' });
  eq(r.body.changed && r.body.changed.dispatch_schedule_lead_minutes, '90', 'lead minutes saved');
  r = await call('GET', '/reference');
  eq(r.body.schedule_lead_minutes, 90, 'reference reports lead minutes');
  ok(r.body.cities.some(function (c) { return c.code === 'ZBH' && c.timezone === 'America/Chicago'; }), 'reference cities carry timezone');

  // Edit (PUT) on a released scheduled call does not move the promise.
  var before = (await pool.query('SELECT eta_promised_at FROM dispatch_jobs WHERE id = $1', [B.id])).rows[0].eta_promised_at;
  var full = (await call('GET', '/jobs/' + B.id)).body.job;
  r = await call('PUT', '/jobs/' + B.id, Object.assign({}, full, { eta_minutes: 15 }));
  eq(r.status, 200, 'edit released call 200');
  var after = (await pool.query('SELECT eta_promised_at FROM dispatch_jobs WHERE id = $1', [B.id])).rows[0].eta_promised_at;
  eq(new Date(after).getTime(), new Date(before).getTime(), 'edit keeps the appointment as the promise');

  await pool.query("DELETE FROM dispatch_jobs WHERE customer_name LIKE 'SchedTest%'");
  await pool.query("DELETE FROM settings WHERE key = 'dispatch_schedule_lead_minutes'");
  server.close();
  console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
