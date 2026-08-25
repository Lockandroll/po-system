'use strict';
/*
 * routes/feedback.js call-recordings harness, against a REAL Postgres.
 *
 * What it pins:
 *   - the payload now carries the index high-water mark and the complaint's
 *     own arrival time, which is the only way the panel can tell "not indexed
 *     yet" from "this customer never called"
 *   - 'indexed' SURVIVES in the payload, because a stale-while-revalidate
 *     service worker runs the PREVIOUS app.js against this response once after
 *     every deploy, and that bundle branches on it
 *   - the on-demand refresh is bounded (window, pages), single-flighted,
 *     cooled down, and scope-checked BEFORE it spends an upstream GoTo call
 *   - a refresh that fails still returns the list. Degrade, never empty.
 *
 *   PGURL=postgres://postgres@127.0.0.1:55432/novatest node test-feedback-recordings.js
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var Module = require('module');
var { Pool } = require('pg');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

var pool = new Pool({ connectionString: process.env.PGURL });

// ---- the REAL normaliser, lifted out of utils/goto.js ----------------------
// Copying it would let the test keep passing after the real one changed, which
// is the failure mode that produced the extension bug in the first place.
var GSRC = fs.readFileSync(path.join(__dirname, 'utils', 'goto.js'), 'utf8');
var ns = GSRC.indexOf('function normalizeDigits(input) {');
var ne = GSRC.indexOf('// Pretty form for display');
ok(ns > 0 && ne > ns, 'lifted normalizeDigits out of the real utils/goto.js');
var realNormalize = new Function(GSRC.slice(ns, ne) + '\nreturn normalizeDigits;')();
eq(realNormalize('(904) 651-0393'), '9046510393', 'normaliser: formatted number');
eq(realNormalize('904.651.0393 x22'), '9046510393', 'normaliser: extension stripped before digits');

// ---- fake goto -------------------------------------------------------------
var G = {
  configured: true,
  status: { connected: true, accountKey: '1842200297248054807' },
  syncCalls: [],
  drainCalls: 0,
  failSync: false,
  onSync: null
};
var gotoStub = {
  normalizeDigits: realNormalize,
  formatDigits: function (x) { return String(x); },
  configured: function () { return G.configured; },
  status: async function () { return G.status; },
  syncWindow: async function (opts) {
    G.syncCalls.push(opts);
    if (G.failSync) throw new Error('GoTo said no');
    if (typeof G.onSync === 'function') await G.onSync();
    return { inserted: 1, updated: 0, seen: 3, pages: 1 };
  },
  drainPendingMedia: async function () { G.drainCalls++; return { attached: 0 }; }
};

/* ---- stub the module graph so routes/feedback.js loads standalone --------- */
var USER = { id: 7, name: 'Tony', role: 'admin' };
var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return { pool: pool, initDB: async function () {} };
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = Object.assign({}, USER); req._userRow = { extra_perms: [] }; next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
  };
  if (request === '../utils/feedbackIntake') return { logActivity: async function () {} };
  if (request === '../utils/r2') return { configured: function () { return true; }, presignDownload: async function () { return 'x'; } };
  if (request === '../utils/permissions') return { hasPermission: async function () { return true; } };
  if (request === '../utils/audit') return { logAudit: async function () {} };
  if (request === '../utils/goto') return gotoStub;
  return origLoad.apply(this, arguments);
};

function freshRouter() {
  // routes/feedback.js holds the refresh cooldown and single-flight guard at
  // MODULE scope, so a scenario that needs a clean slate re-requires it.
  Object.keys(require.cache).forEach(function (k) {
    if (k.indexOf('routes' + path.sep + 'feedback.js') !== -1 || k.indexOf('routes/feedback.js') !== -1) delete require.cache[k];
  });
  return require('./routes/feedback.js');
}

// ---- tiny http driver ------------------------------------------------------
var express = require('express');
var server = null, port = 0, app = null;
function mount(router) {
  app = express();
  app.use(express.json());
  app.use('/api/feedback', router);
  return new Promise(function (res) {
    if (server) server.close();
    server = app.listen(0, function () { port = server.address().port; res(); });
  });
}
function call(method, p) {
  return new Promise(function (resolve, reject) {
    var req = http.request({ host: '127.0.0.1', port: port, method: method, path: '/api/feedback' + p,
      headers: { 'content-type': 'application/json' } }, function (r) {
      var b = '';
      r.on('data', function (c) { b += c; });
      r.on('end', function () {
        var j = null; try { j = JSON.parse(b); } catch (e) {}
        resolve({ status: r.statusCode, body: j });
      });
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

// ---- schema ----------------------------------------------------------------
async function schema() {
  await pool.query('DROP TABLE IF EXISTS feedback_call_recordings, goto_calls, customer_feedback, user_cities CASCADE');
  await pool.query(
    'CREATE TABLE customer_feedback (' +
    ' id SERIAL PRIMARY KEY, city_code CHAR(3), customer_phone VARCHAR(50),' +
    ' received_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
  );
  await pool.query(
    'CREATE TABLE goto_calls (' +
    ' id SERIAL PRIMARY KEY, conversation_space_id VARCHAR(64) UNIQUE NOT NULL, direction VARCHAR(16),' +
    ' call_started_at TIMESTAMPTZ, call_ended_at TIMESTAMPTZ, duration_sec INTEGER,' +
    ' external_number VARCHAR(32), external_digits VARCHAR(20), internal_number VARCHAR(32),' +
    ' agent_name VARCHAR(255), recording_id VARCHAR(128), transcript_id VARCHAR(128),' +
    ' has_recording BOOLEAN NOT NULL DEFAULT false, r2_key VARCHAR(512),' +
    ' last_seen_revision TIMESTAMPTZ)'
  );
  await pool.query(
    'CREATE TABLE feedback_call_recordings (' +
    ' id SERIAL PRIMARY KEY, feedback_id INTEGER REFERENCES customer_feedback(id) ON DELETE CASCADE,' +
    ' call_id INTEGER REFERENCES goto_calls(id) ON DELETE CASCADE, link_type VARCHAR(16) DEFAULT $$auto$$,' +
    ' linked_by INTEGER, linked_by_name VARCHAR(255), is_primary BOOLEAN DEFAULT false,' +
    ' hidden BOOLEAN DEFAULT false, note VARCHAR(255), UNIQUE (feedback_id, call_id))'
  );
  await pool.query('CREATE TABLE user_cities (user_id INTEGER, city_code CHAR(3))');
}

function ago(min) { return new Date(Date.now() - min * 60000).toISOString(); }

async function seed() {
  await pool.query('TRUNCATE feedback_call_recordings, goto_calls, customer_feedback, user_cities RESTART IDENTITY CASCADE');
  // Jennifer's complaint: arrived 5 minutes ago, about a call 8 minutes ago.
  await pool.query(
    'INSERT INTO customer_feedback (id, city_code, customer_phone, received_at) VALUES' +
    " (1,'JAX','(904) 651-0393',$1), (2,'JAX','',$2), (3,'BHM','(205) 555-0134',$3)",
    [ago(5), ago(5), ago(5)]
  );
  await pool.query("SELECT setval('customer_feedback_id_seq', 3)");
}

async function addCall(id, digits, startedAgoMin, hasRec) {
  await pool.query(
    'INSERT INTO goto_calls (conversation_space_id, direction, call_started_at, call_ended_at,' +
    ' duration_sec, external_number, external_digits, has_recording, last_seen_revision)' +
    " VALUES ($1,'INBOUND',$2,$2,208,$3,$4,$5,NOW())",
    [id, ago(startedAgoMin), '+1' + digits, digits, !!hasRec]
  );
}

// ---------------------------------------------------------------------------
async function main() {
  await schema();

  // ===== 1. freshness reaches the client ===================================
  await seed();
  await mount(freshRouter());
  // Index high-water mark is 40 minutes old; the complaint is 5 minutes old.
  await addCall('csid-old', '9995550001', 40, true);

  var r = await call('GET', '/1/recordings');
  eq(r.status, 200, 'GET recordings 200s');
  ok(r.body.index && typeof r.body.index === 'object', 'payload carries an index block');
  ok(!!r.body.index.newest, 'index.newest is populated');
  ok(!!r.body.index.last_sync, 'index.last_sync is populated');
  eq(r.body.index.empty, false, 'index is not reported empty when it holds a call');
  ok(!!r.body.complaint_at, 'payload carries the complaint arrival time');
  ok(new Date(r.body.index.newest).getTime() < new Date(r.body.complaint_at).getTime(),
    'the fixture really is a LAGGING index (newest call older than the complaint)');
  eq(typeof r.body.indexed, 'number', 'legacy "indexed" field survives for the stale cached bundle');
  eq(r.body.indexed, 1, 'legacy "indexed" is the real row count');
  eq(r.body.calls.length, 0, 'no calls matched for this number yet');

  // ===== 2. matching still works, and on the real normaliser ===============
  await addCall('csid-jen', '9046510393', 8, true);
  r = await call('GET', '/1/recordings');
  eq(r.body.calls.length, 1, 'the customer call is matched on external_digits');
  eq(r.body.calls[0].has_recording, true, 'has_recording rides along');
  ok(r.body.calls[0].number === '+19046510393', 'external number returned');
  ok(!('agent_name' in r.body.calls[0]), 'agent_name is still NOT returned (this is not staff surveillance)');

  // A complaint whose phone carries an extension must still match.
  await pool.query("UPDATE customer_feedback SET customer_phone = '904.651.0393 x22' WHERE id = 1");
  r = await call('GET', '/1/recordings');
  eq(r.body.calls.length, 1, 'an extension on the complaint phone does not break the match');
  await pool.query("UPDATE customer_feedback SET customer_phone = '(904) 651-0393' WHERE id = 1");

  // ===== 3. no phone ========================================================
  r = await call('GET', '/2/recordings');
  eq(r.body.reason, 'no_phone', 'a complaint with no phone says so');
  ok(r.body.index && !r.body.index.empty, 'the no_phone payload still carries the index block');

  // ===== 4. empty index reads as empty, not as "no calls" ==================
  await pool.query('TRUNCATE goto_calls CASCADE');
  r = await call('GET', '/1/recordings');
  eq(r.body.index.empty, true, 'an empty index is reported as empty');
  eq(r.body.indexed, 0, 'legacy indexed is 0 on an empty index');
  eq(r.body.index.newest, null, 'no high-water mark on an empty index');

  // ===== 5. city scope ======================================================
  USER.role = 'manager';
  await pool.query("INSERT INTO user_cities (user_id, city_code) VALUES (7,'JAX')");
  r = await call('GET', '/3/recordings');
  eq(r.status, 403, 'a manager cannot read a complaint outside their cities');
  r = await call('GET', '/1/recordings');
  eq(r.status, 200, 'a manager CAN read a complaint inside their cities');
  r = await call('GET', '/999/recordings');
  eq(r.status, 404, 'a missing complaint 404s');

  // ===== 6. refresh: the happy path ========================================
  G.syncCalls = []; G.drainCalls = 0;
  await mount(freshRouter());
  G.onSync = function () { return addCall('csid-fresh', '9046510393', 2, false); };
  r = await call('POST', '/1/recordings/refresh');
  eq(r.status, 200, 'refresh 200s');
  eq(G.syncCalls.length, 1, 'refresh ran exactly one upstream sync');
  eq(G.drainCalls, 1, 'refresh drained parked recording notifications');
  eq(r.body.refreshed.ran, true, 'refreshed.ran is true');
  eq(r.body.refreshed.inserted, 1, 'refreshed.inserted is reported');
  eq(r.body.calls.length, 1, 'the response is the FRESH list, in one round trip');

  var w = G.syncCalls[0];
  var startMs = Date.parse(w.startIso), endMs = Date.parse(w.endIso);
  ok(endMs > startMs, 'sync window has end after start');
  ok(endMs - startMs <= 24 * 3600000 + 1000, 'sync window never reaches back more than 24h');
  ok(endMs - startMs >= 120000, 'sync window is at least 2 minutes wide');
  ok(w.maxPages && w.maxPages <= 20, 'sync is page-bounded so it cannot become a backfill');

  // ===== 7. cooldown ========================================================
  G.onSync = null;
  r = await call('POST', '/1/recordings/refresh');
  eq(G.syncCalls.length, 1, 'a second click inside the gap does NOT hit GoTo again');
  eq(r.body.refreshed.reason, 'cooldown', 'the client is told it was a cooldown');
  eq(r.body.refreshed.ran, false, 'a cooldown did not run');
  eq(r.body.calls.length, 1, 'a cooldown still returns the list');

  // ===== 8. single flight ===================================================
  G.syncCalls = []; G.drainCalls = 0;
  await mount(freshRouter());
  var release = null;
  G.onSync = function () { return new Promise(function (res) { release = res; }); };
  var a = call('POST', '/1/recordings/refresh');
  await new Promise(function (r2) { setTimeout(r2, 120); });
  var b = call('POST', '/1/recordings/refresh');
  await new Promise(function (r2) { setTimeout(r2, 120); });
  release();
  var both = await Promise.all([a, b]);
  eq(G.syncCalls.length, 1, 'two concurrent refreshes share ONE upstream sync');
  eq(both[1].body.refreshed.reason, 'shared', 'the second caller is told it shared a sync');
  eq(both[1].body.refreshed.ran, true, 'the shared caller still counts as run');

  // ===== 9. not configured / not connected =================================
  G.onSync = null;
  G.syncCalls = [];
  G.configured = false;
  await mount(freshRouter());
  r = await call('POST', '/1/recordings/refresh');
  eq(r.body.refreshed.reason, 'not_configured', 'unconfigured GoTo is reported, not thrown');
  eq(G.syncCalls.length, 0, 'unconfigured GoTo spends no upstream call');
  eq(r.status, 200, 'unconfigured GoTo still returns the list');
  ok(Array.isArray(r.body.calls), 'the list is still there when GoTo is unconfigured');

  G.configured = true;
  G.status = { connected: false, accountKey: null };
  await mount(freshRouter());
  r = await call('POST', '/1/recordings/refresh');
  eq(r.body.refreshed.reason, 'not_connected', 'disconnected GoTo is reported');
  eq(G.syncCalls.length, 0, 'disconnected GoTo spends no upstream call');

  // ===== 10. a failing sync degrades, never empties ========================
  G.status = { connected: true, accountKey: 'k' };
  G.failSync = true;
  await mount(freshRouter());
  r = await call('POST', '/1/recordings/refresh');
  eq(r.status, 200, 'a GoTo failure is NOT a 500 - the panel must still render');
  eq(r.body.refreshed.reason, 'failed', 'the failure is stated out loud');
  eq(r.body.calls.length, 1, 'the list Nova already had survives a failed refresh');
  G.failSync = false;

  // ===== 11. scope is checked BEFORE the upstream call ====================
  G.syncCalls = [];
  await mount(freshRouter());
  r = await call('POST', '/3/recordings/refresh');
  eq(r.status, 403, 'refresh on another city 403s');
  eq(G.syncCalls.length, 0, 'a denied refresh never reaches GoTo');
  r = await call('POST', '/999/recordings/refresh');
  eq(r.status, 404, 'refresh on a missing complaint 404s');
  eq(G.syncCalls.length, 0, 'a 404 refresh never reaches GoTo');

  // ===== 12. an OLD complaint still gets a bounded window =================
  G.syncCalls = [];
  await pool.query("UPDATE customer_feedback SET received_at = NOW() - INTERVAL '40 days' WHERE id = 1");
  await mount(freshRouter());
  r = await call('POST', '/1/recordings/refresh');
  eq(G.syncCalls.length, 1, 'an old complaint still refreshes');
  var w2 = G.syncCalls[0];
  ok(Date.parse(w2.endIso) - Date.parse(w2.startIso) <= 24 * 3600000 + 1000,
    'a 40-day-old complaint does NOT turn the refresh into a 40-day backfill');

  // ===== 13. hidden/primary joins still work ==============================
  await pool.query("UPDATE customer_feedback SET received_at = NOW() WHERE id = 1");
  var cid = (await pool.query("SELECT id FROM goto_calls WHERE external_digits='9046510393' LIMIT 1")).rows[0].id;
  await pool.query('INSERT INTO feedback_call_recordings (feedback_id, call_id, is_primary, hidden) VALUES (1,$1,true,false)', [cid]);
  await mount(freshRouter());
  r = await call('GET', '/1/recordings');
  eq(r.body.calls[0].is_primary, true, 'the primary flag still joins through');
  eq(r.body.calls[0].hidden, false, 'the hidden flag still joins through');

  if (server) server.close();
  await pool.end();
  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
