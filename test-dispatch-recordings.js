'use strict';
/*
 * Customer call recordings on a dispatch call (Tony 2026-10-15) - real Postgres.
 * Run: DATABASE_URL=postgres://tester@localhost/nova?host=/tmp/pgs&port=55432 node test-dispatch-recordings.js
 * Real initDB(), real routes/dispatch.js, real utils/dispatchRecordings.js and the real
 * jobs/dispatch.js pass. Auth, push, duty, Judi and the GoTo network calls are stubbed;
 * goto_calls rows are written straight into the table the way the indexer writes them.
 * No backticks anywhere in this file (Windows corrupts them in .js).
 */
var http = require('http');
var express = require('express');
var Module = require('module');

var auth = { user: { id: 0, name: 'Test Admin', role: 'admin' } };
var gotoState = { connected: true, syncs: 0, failSync: false };
var judiState = { configured: false, calls: [], asked: [] };
var readyIds = {};
var _load = Module._load;
var realGoto = null;
Module._load = function (request, parent) {
  if (request === '../middleware/auth') {
    return {
      requireAuth: function (req, res, next) { req.user = auth.user; req._userRow = { extra_perms: auth.extra || [] }; next(); },
      // The real gate for play: role must hold it (admin always does).
      requirePermission: function (perm) {
        return async function (req, res, next) {
          if (perm === 'play_call_recordings' && req.user.role === 'locksmith' && (auth.extra || []).indexOf(perm) === -1) {
            return res.status(403).json({ error: 'Forbidden' });
          }
          next();
        };
      }
    };
  }
  if (request === '../utils/push') return { sendPushToUsers: async function () {} };
  if (request === '../utils/duty' || request === './duty') {
    var realDuty = _load.apply(this, arguments);
    return Object.assign({}, realDuty, { isReady: async function (id) { return !!readyIds[id]; } });
  }
  if (request === '../utils/judi' || request === './judi') {
    return {
      configured: function () { return judiState.configured; },
      callsForPhone: async function (digits) { judiState.asked.push(digits); return { calls: judiState.calls.filter(function (c) { return c._digits === digits; }).map(function (c) { var o = Object.assign({}, c); delete o._digits; return o; }) }; }
    };
  }
  if (request === './goto' || request === '../utils/goto') {
    if (!realGoto) realGoto = _load.apply(this, arguments);
    return Object.assign({}, realGoto, {
      configured: function () { return true; },
      status: async function () { return { connected: gotoState.connected, accountKey: gotoState.connected ? 'acct' : null }; },
      syncWindow: async function (o) {
        gotoState.syncs++; gotoState.lastWindow = o;
        if (gotoState.failSync) throw new Error('GoTo down');
        return { inserted: 0, updated: 0, seen: 0 };
      },
      drainPendingMedia: async function () { return { attached: 0 }; },
      playbackUrl: async function (id) { return { url: 'https://r2.example/call-' + id + '.mp3', mime: 'audio/mpeg', bytes: 1234 }; }
    });
  }
  return _load.apply(this, arguments);
};

var db = require('./db');
var pool = db.pool;
var router = require('./routes/dispatch');
var jobs = require('./jobs/dispatch');
var dispRec = require('./utils/dispatchRecordings');

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

var callSeq = 0;
async function gotoCall(digits, minsAgo, hasRec, dir) {
  callSeq++;
  var r = await pool.query(
    'INSERT INTO goto_calls (conversation_space_id, direction, call_started_at, call_ended_at, duration_sec, external_number, external_digits, recording_id, has_recording)' +
    " VALUES ($1, $2, NOW() - ($3 || ' minutes')::interval, NOW() - ($3 || ' minutes')::interval + interval '2 minutes', 120, $4, $4, $5, $6) RETURNING id",
    ['rectest-' + Date.now() + '-' + callSeq, dir || 'INBOUND', String(minsAgo), digits, hasRec ? 'rec-' + callSeq : null, !!hasRec]);
  return r.rows[0].id;
}
async function events(id) {
  return (await pool.query('SELECT event, detail FROM dispatch_job_events WHERE job_id = $1 ORDER BY id', [id])).rows;
}
async function jobRow(id) { return (await pool.query('SELECT * FROM dispatch_jobs WHERE id = $1', [id])).rows[0]; }

var S;
async function setup() {
  await db.initDB();
  await pool.query("DELETE FROM dispatch_jobs WHERE customer_name LIKE 'RecTest%'");
  await pool.query("DELETE FROM goto_calls WHERE conversation_space_id LIKE 'rectest-%'");
  await pool.query("DELETE FROM settings WHERE key LIKE 'dispatch_rec_%'");
  await pool.query("INSERT INTO cities (code, name, active, timezone) VALUES ('ZBH', 'Zbirmingham', true, 'America/Chicago') " +
    "ON CONFLICT (code) DO UPDATE SET timezone = 'America/Chicago', active = true");
  await pool.query("INSERT INTO service_categories (code, name) VALUES ('ztest', 'Ztest') ON CONFLICT (code) DO NOTHING");
  var st = await pool.query("INSERT INTO service_types (code, name, category_code, active) VALUES ('ZLOCK', 'Zlockout', 'ztest', true) " +
    "ON CONFLICT (code) DO UPDATE SET active = true RETURNING id");
  var adm = await pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('rec-admin@test', 'Rec Admin', 'x', 'admin') " +
    "ON CONFLICT (email) DO UPDATE SET role = 'admin' RETURNING id");
  var tech = await pool.query("INSERT INTO users (email, name, password_hash, role, home_city) VALUES ('rec-tech@test', 'Rec Tech', 'x', 'locksmith', 'ZBH') " +
    "ON CONFLICT (email) DO UPDATE SET home_city = 'ZBH', active = true, role = 'locksmith' RETURNING id");
  await pool.query("INSERT INTO user_service_categories (user_id, category_code, can_view, can_be_assigned) VALUES ($1, 'ztest', true, true) " +
    "ON CONFLICT DO NOTHING", [tech.rows[0].id]);
  return { st: st.rows[0].id, admin: adm.rows[0].id, tech: tech.rows[0].id };
}
function asAdmin() { auth.user = { id: S.admin, name: 'Rec Admin', role: 'admin' }; auth.extra = []; }
function asTech(extra) { auth.user = { id: S.tech, name: 'Rec Tech', role: 'locksmith' }; auth.extra = extra || []; readyIds[S.tech] = true; }

function newCall(o, extra) {
  return Object.assign({ callback_phone: '(205) 555-0142', customer_name: 'RecTest ' + (o || ''), service_type_id: S.st,
    address: '1 Main St', zip: '35203', city_code: 'ZBH', created_via: 'new_call' }, extra || {});
}

async function main() {
  S = await setup();
  asAdmin();
  var app = express();
  app.use(express.json());
  app.use('/api/dispatch', router);
  server = app.listen(0);
  base = 'http://127.0.0.1:' + server.address().port + '/api/dispatch';

  // ---- pure helpers
  var nums = dispRec.numbersOf({ callback_phone: '205-555-0142', customer_phone: '2055550142', caller_id: '+1 (800) 555-0199' });
  eq(nums.map(function (n) { return n.digits; }), ['2055550142', '8005550199'], 'numbers deduped to 10 digits');
  eq(nums[0].labels, ['Call back'], 'customer_phone duplicate of call back is not a second label');
  eq(nums[1].labels, ['Caller ID'], 'caller id labelled');
  var cfg = { beforeHours: 6, afterHours: 6 };
  var w = dispRec.windowOf({ status: 'new', created_at: new Date(Date.now() - 3600000) }, cfg);
  ok(w.active && w.pullUntil === null, 'open call: active, no end');
  w = dispRec.windowOf({ status: 'done', created_at: new Date(Date.now() - 20 * 3600000), completed_at: new Date(Date.now() - 10 * 3600000) }, cfg);
  ok(!w.active, 'closed 10h ago with 6h after: no longer active');

  // ---- a new call says, from its first second, that Nova is pulling
  var r = await call('POST', '/jobs', newCall('A', { caller_id: '8005550199' }));
  eq(r.status, 200, 'create 200 ' + JSON.stringify(r.body).slice(0, 160));
  var A = r.body;
  eq(A.rec_status, 'pulling', 'new call comes back as pulling');
  var ev = await events(A.id);
  ok(ev.some(function (e) { return e.event === 'rec_pulling' && /Working on pulling/.test(e.detail); }), 'event log says Nova is working on pulling the calls');

  // GET: nothing indexed yet for the number -> still pulling, no rows
  r = await call('GET', '/jobs/' + A.id + '/recordings');
  eq(r.status, 200, 'recordings GET 200');
  eq(r.body.state, 'pulling', 'GET state pulling');
  eq(r.body.calls.length, 0, 'no calls yet');
  eq(r.body.numbers, ['Call back', 'Caller ID'], 'numbers come back as labels');
  ok(JSON.stringify(r.body).indexOf('5550142') === -1, 'the customer number never appears in the payload');

  // ---- the customer's call lands in the index, no recording yet
  var c1 = await gotoCall('2055550142', 3, false);
  var noise = await gotoCall('2055550142', 60 * 30, true);          // 30h ago: outside the window
  var other = await gotoCall('4075550100', 2, true);                  // someone else
  r = await call('GET', '/jobs/' + A.id + '/recordings');
  eq(r.body.state, 'pulling', 'call found without recording: still pulling');
  eq(r.body.calls.map(function (c) { return c.call_id; }), [c1], 'only the in-window call for these numbers');
  eq(r.body.found, 1, 'found 1');
  eq(r.body.recorded, 0, 'recorded 0');
  eq(r.body.calls[0].matched, 'Call back', 'row says which number matched');
  ev = await events(A.id);
  ok(ev.some(function (e) { return e.event === 'rec_found' && /not posted yet/.test(e.detail); }), 'log: call found, recording not posted yet');

  // ---- recording attaches -> still settling for the first 15 min, then complete
  await pool.query("UPDATE goto_calls SET has_recording = true, recording_id = 'r-late' WHERE id = $1", [c1]);
  r = await call('GET', '/jobs/' + A.id + '/recordings');
  eq(r.body.state, 'pulling', 'all recorded but the call is 1 min old: still pulling (settle time)');
  await pool.query("UPDATE dispatch_jobs SET created_at = NOW() - interval '20 minutes' WHERE id = $1", [A.id]);
  await pool.query("UPDATE goto_calls SET has_recording = true, recording_id = 'r-late' WHERE id = $1", [c1]);
  r = await call('GET', '/jobs/' + A.id + '/recordings');
  eq(r.body.state, 'complete', 'all found calls recorded: complete');
  eq(r.body.recorded, 1, 'recorded 1');
  ev = await events(A.id);
  eq(ev.filter(function (e) { return e.event === 'rec_found' && /1 customer call recording pulled/.test(e.detail); }).length, 1, 'one "pulled" line');
  ok(ev.some(function (e) { return e.event === 'rec_found' && /1 customer call recording pulled from GoTo\.$/.test(e.detail); }), 'pulled line reads cleanly');
  r = await call('GET', '/jobs/' + A.id + '/recordings');
  ev = await events(A.id);
  eq(ev.filter(function (e) { return e.event === 'rec_found'; }).length, 2, 'reloading does not repeat log lines');
  eq((await jobRow(A.id)).rec_status, 'complete', 'stored state complete');

  // ---- play: logged, number-checked
  r = await call('GET', '/jobs/' + A.id + '/recordings/' + c1 + '/play');
  eq(r.status, 200, 'play 200');
  ok(/call-/.test(r.body.url), 'play returns a url');
  ev = await events(A.id);
  ok(ev.some(function (e) { return e.event === 'rec_played'; }), 'play is written into the call log');
  r = await call('GET', '/jobs/' + A.id + '/recordings/' + other + '/play');
  eq(r.status, 403, 'cannot play a call from a number not on this job');

  // ---- caller id call (shared motor club line) can be hidden
  var club = await gotoCall('8005550199', 1, false);
  r = await call('GET', '/jobs/' + A.id + '/recordings');
  eq(r.body.state, 'pulling', 'a new call without recording reopens pulling');
  r = await call('PATCH', '/jobs/' + A.id + '/recordings/' + club, { hidden: true });
  eq(r.status, 200, 'hide 200');
  r = await call('GET', '/jobs/' + A.id + '/recordings');
  eq(r.body.state, 'complete', 'hidden call no longer holds it in pulling');
  eq(r.body.hidden, 1, 'hidden count');
  ok(r.body.calls.some(function (c) { return c.call_id === club && c.hidden; }), 'hidden row still returned, flagged');
  r = await call('PATCH', '/jobs/' + A.id + '/recordings/' + other, { hidden: true });
  eq(r.status, 403, 'cannot hide a call from another number');
  r = await call('PATCH', '/jobs/' + A.id + '/recordings/' + club, { hidden: false });
  r = await call('GET', '/jobs/' + A.id + '/recordings');
  eq(r.body.state, 'pulling', 'unhide puts it back');

  // ---- closes, window passes with a call still unrecorded -> partial
  await pool.query("UPDATE dispatch_jobs SET status = 'done', completed_at = NOW() - interval '7 hours', status_since = NOW() - interval '7 hours', created_at = NOW() - interval '8 hours' WHERE id = $1", [A.id]);
  await pool.query("UPDATE goto_calls SET call_started_at = NOW() - interval '7 hours 30 minutes' WHERE id = ANY($1)", [[c1, club]]);
  r = await call('GET', '/jobs/' + A.id + '/recordings');
  eq(r.body.state, 'partial', 'closed past the window with one unrecorded: partial');
  eq(r.body.active, false, 'no longer active');
  ev = await events(A.id);
  ok(ev.some(function (e) { return e.event === 'rec_partial' && /never got a recording/.test(e.detail); }), 'log: stopped looking, recording missing');

  // ---- a call with no customer calls at all -> none after the window
  r = await call('POST', '/jobs', newCall('B', { callback_phone: '205-555-0777' }));
  var B = r.body;
  eq(B.rec_status, 'pulling', 'B starts pulling');
  await pool.query("UPDATE dispatch_jobs SET status = 'cancelled', status_since = NOW() - interval '7 hours', created_at = NOW() - interval '7 hours 10 minutes' WHERE id = $1", [B.id]);
  r = await call('GET', '/jobs/' + B.id + '/recordings');
  eq(r.body.state, 'none', 'nothing found after the window: none');
  ev = await events(B.id);
  ok(ev.some(function (e) { return e.event === 'rec_none'; }), 'log: no customer calls found');

  // Settings knob widens the window and Nova looks again.
  await pool.query("INSERT INTO settings (key, value) VALUES ('dispatch_rec_after_hours', '12') ON CONFLICT (key) DO UPDATE SET value = '12'");
  r = await call('GET', '/jobs/' + B.id + '/recordings');
  eq(r.body.state, 'pulling', 'raising dispatch_rec_after_hours reopens the window');
  await pool.query("DELETE FROM settings WHERE key = 'dispatch_rec_after_hours'");

  // ---- GoTo disconnected: says so, then recovers
  gotoState.connected = false;
  r = await call('POST', '/jobs', newCall('C', { callback_phone: '205-555-0888' }));
  var C = r.body;
  eq(C.rec_status, 'not_connected', 'disconnected GoTo is stated on create');
  ev = await events(C.id);
  ok(ev.some(function (e) { return e.event === 'rec_unavailable'; }), 'log: GoTo not connected');
  r = await call('POST', '/jobs/' + C.id + '/recordings/refresh', {});
  eq(r.body.refreshed.reason, 'not_connected', 'refresh reports not_connected');
  gotoState.connected = true;

  // ---- the cron: picks up waiting jobs, pulls ONCE, writes the transition
  dispRec._resetForTests();
  gotoState.syncs = 0;
  await jobs.runRecordingPull();
  eq(gotoState.syncs, 1, 'cron pulled from GoTo once for all waiting jobs');
  eq((await jobRow(C.id)).rec_status, 'pulling', 'cron moved C from not_connected to pulling');
  ev = await events(C.id);
  ok(ev.some(function (e) { return e.event === 'rec_pulling' && /GoTo is back/.test(e.detail); }), 'log: GoTo is back, pulling');
  ok(new Date(gotoState.lastWindow.endIso) - new Date(gotoState.lastWindow.startIso) <= 3 * 3600000 + 1000, 'cron pull window is the last 3h only');
  await jobs.runRecordingPull();
  eq(gotoState.syncs, 1, 'second tick inside the 45s gap does not hit GoTo again');

  // A job created before this feature (rec_status NULL) is adopted by the cron.
  var legacy = await pool.query("INSERT INTO dispatch_jobs (status, customer_name, callback_phone, customer_phone, city_code, created_at) VALUES ('new', 'RecTest legacy', '2055550999', '2055550999', 'ZBH', NOW() - interval '20 minutes') RETURNING id");
  await jobs.runRecordingPull();
  eq((await jobRow(legacy.rows[0].id)).rec_status, 'pulling', 'pre-existing open call adopted as pulling');

  // ---- manual refresh: bounded window, cooldown, shared, failure
  dispRec._resetForTests();
  gotoState.syncs = 0;
  r = await call('POST', '/jobs/' + C.id + '/recordings/refresh', {});
  eq(r.status, 200, 'refresh 200');
  eq(r.body.refreshed.ran, true, 'refresh ran');
  eq(gotoState.syncs, 1, 'refresh hit GoTo once');
  ok(new Date(gotoState.lastWindow.endIso) - new Date(gotoState.lastWindow.startIso) <= 24 * 3600000 + 1000, 'refresh window capped at 24h');
  r = await call('POST', '/jobs/' + C.id + '/recordings/refresh', {});
  eq(r.body.refreshed.reason, 'cooldown', 'second click inside 45s is a cooldown');
  eq(gotoState.syncs, 1, 'cooldown did not hit GoTo');
  dispRec._resetForTests();
  gotoState.failSync = true;
  r = await call('POST', '/jobs/' + C.id + '/recordings/refresh', {});
  eq(r.status, 200, 'GoTo failure still answers 200 with what Nova has');
  eq(r.body.refreshed.reason, 'failed', 'failure is reported');
  gotoState.failSync = false;

  // ---- edit: changing the number re-evaluates against the new number
  await pool.query("UPDATE dispatch_jobs SET created_at = NOW() - interval '20 minutes' WHERE id = $1", [C.id]);
  var full = (await call('GET', '/jobs/' + C.id)).body.job;
  var c9 = await gotoCall('2055550555', 2, true);
  r = await call('PUT', '/jobs/' + C.id, Object.assign({}, full, { callback_phone: '205-555-0555', customer_phone: '205-555-0555' }));
  eq(r.status, 200, 'edit 200');
  eq(r.body.rec_status, 'complete', 'edited number finds its recorded call');
  r = await call('GET', '/jobs/' + C.id + '/recordings');
  eq(r.body.calls.map(function (c) { return c.call_id; }), [c9], 'list follows the new number');

  // ---- Judi: fetched live, filtered to the window, number stripped
  judiState.configured = true;
  judiState.calls = [
    { _digits: '2055550555', short_code: 'J1', started_at: new Date(Date.now() - 600000).toISOString(), number: '2055550555', has_recording: true },
    { _digits: '2055550555', short_code: 'J0', started_at: new Date(Date.now() - 3 * 86400000).toISOString(), number: '2055550555', has_recording: true }
  ];
  r = await call('GET', '/jobs/' + C.id + '/recordings');
  eq(r.body.judi.configured, true, 'judi configured');
  eq(r.body.judi.calls.map(function (c) { return c.short_code; }), ['J1'], 'judi filtered to the window');
  ok(!('number' in r.body.judi.calls[0]), 'judi row carries no phone number');
  eq(r.body.judi.calls[0].matched, 'Call back', 'judi row labelled');
  judiState.configured = false;

  // ---- who can see it
  asTech();
  r = await call('GET', '/jobs/' + C.id + '/recordings');
  eq(r.status, 403, 'a ready tech without play_call_recordings gets 403');
  r = await call('GET', '/jobs/' + C.id + '/recordings/' + c9 + '/play');
  eq(r.status, 403, 'tech cannot play');
  asTech(['play_call_recordings']);
  r = await call('GET', '/jobs/' + C.id + '/recordings');
  eq(r.status, 200, 'tech granted play_call_recordings can see the list');
  eq(r.body.canEdit, false, 'but cannot hide');
  r = await call('GET', '/jobs/' + C.id);
  ok(!('customer_phone' in r.body.job), 'tech still never gets the phone on the job');
  readyIds[S.tech] = false;
  r = await call('GET', '/jobs/' + C.id + '/recordings');
  eq(r.status, 403, 'not-ready tech is stopped by the board gate');
  asAdmin();

  await pool.query("DELETE FROM dispatch_jobs WHERE customer_name LIKE 'RecTest%'");
  await pool.query("DELETE FROM goto_calls WHERE conversation_space_id LIKE 'rectest-%'");
  server.close();
  console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
