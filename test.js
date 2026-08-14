'use strict';
/*
 * Stubbed harness for the inbound sync receiver.
 * Fake pg pool + a real express app on a real socket. No database needed.
 */
var http = require('http');
var path = require('path');
var Module = require('module');

var PASS = 0, FAIL = 0;
function ok(cond, label) {
  if (cond) { PASS++; }
  else { FAIL++; console.error('  FAIL: ' + label); }
}
function eq(a, b, label) { ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ------------------------------------------------------------- fake pg pool */

var DB = { sources: [], events: [], stats: {}, rejects: {}, nextEventId: 1, nextSourceId: 1 };
var QUERY_LOG = [];
var FORCE_ERROR = null;

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

var pool = {
  query: async function (sql, params) {
    params = params || [];
    var q = norm(sql);
    QUERY_LOG.push(q);
    if (FORCE_ERROR) { var e = new Error(FORCE_ERROR); FORCE_ERROR = null; throw e; }

    if (/^SELECT id, slug, name, secret_hash/.test(q)) {
      return { rows: DB.sources.filter(function (s) { return s.slug === params[0]; }) };
    }
    if (/^UPDATE webhook_sources SET last_event_at/.test(q)) return { rows: [], rowCount: 1 };

    if (/^INSERT INTO webhook_rejections/.test(q)) {
      var rk = params[0] + '|' + params[1] + '|' + params[2];
      DB.rejects[rk] = (DB.rejects[rk] || 0) + Number(params[3]);
      return { rows: [], rowCount: 1 };
    }

    if (/^INSERT INTO webhook_event_stats/.test(q)) {
      var sk = params[0] + '|' + params[1];
      var st = DB.stats[sk] || (DB.stats[sk] = { stored: 0, dropped: 0, duplicate: 0 });
      st.stored += Number(params[2]); st.dropped += Number(params[3]); st.duplicate += Number(params[4] || 0);
      return { rows: [], rowCount: 1 };
    }

    // Handles BOTH the single-row insert and the multi-row bulk insert: the
    // parameter arity per row is the same either way, so the tuple count is
    // just params.length / arity.
    if (/^INSERT INTO webhook_events/.test(q)) {
      var hasExternal = q.indexOf('ON CONFLICT') !== -1;
      var arity = hasExternal ? 10 : 9;
      var out = [];
      for (var off = 0; off < params.length; off += arity) {
        var p2 = params.slice(off, off + arity);
        var row;
        if (hasExternal) {
          var clash = DB.events.filter(function (e) { return e.source_slug === p2[0] && e.dedupe_key && e.dedupe_key === p2[3]; });
          if (clash.length) continue;                     // ON CONFLICT DO NOTHING
          row = {
            id: DB.nextEventId++, source_slug: p2[0], event_type: p2[1], external_id: p2[2], dedupe_key: p2[3],
            body_hash: p2[4], payload: JSON.parse(p2[5]), raw_body: p2[6],
            headers: JSON.parse(p2[7]), ip: p2[8], sig_state: p2[9] || null, status: 'pending', attempts: 0,
            last_error: null, next_attempt_at: Date.now(), received_at: Date.now(), processed_at: null
          };
        } else {
          row = {
            id: DB.nextEventId++, source_slug: p2[0], event_type: p2[1], external_id: p2[2], dedupe_key: null,
            body_hash: p2[3], payload: JSON.parse(p2[4]), raw_body: p2[5],
            headers: JSON.parse(p2[6]), ip: p2[7], sig_state: p2[8] || null, status: 'pending', attempts: 0,
            last_error: null, next_attempt_at: Date.now(), received_at: Date.now(), processed_at: null
          };
        }
        DB.events.push(row);
        out.push(/RETURNING id, dedupe_key/.test(q) ? { id: row.id, dedupe_key: row.dedupe_key } : { id: row.id });
      }
      return { rows: out };
    }

    if (/^SELECT DISTINCT body_hash FROM webhook_events/.test(q)) {
      var win2 = Number(params[2]);
      var want = params[1] || [];
      var seenH = {};
      DB.events.forEach(function (e) {
        if (e.source_slug === params[0] && want.indexOf(e.body_hash) !== -1 && (Date.now() - e.received_at) < win2) {
          seenH[e.body_hash] = true;
        }
      });
      return { rows: Object.keys(seenH).map(function (h) { return { body_hash: h }; }) };
    }

    if (/^SELECT id FROM webhook_events WHERE source_slug = \$1 AND dedupe_key = \$2/.test(q)) {
      return { rows: DB.events.filter(function (e) { return e.source_slug === params[0] && e.dedupe_key === params[1]; }).map(function (e) { return { id: e.id }; }) };
    }
    if (/^SELECT id FROM webhook_events WHERE source_slug = \$1 AND body_hash = \$2/.test(q)) {
      var win = Number(params[2]);
      var hits = DB.events.filter(function (e) {
        return e.source_slug === params[0] && e.body_hash === params[1] && (Date.now() - e.received_at) < win;
      });
      return { rows: hits.length ? [{ id: hits[hits.length - 1].id }] : [] };
    }

    if (/^UPDATE webhook_events SET status = 'processing'/.test(q)) {
      var ev = DB.events.filter(function (e) { return e.id === Number(params[0]) && (e.status === 'pending' || e.status === 'failed'); })[0];
      if (!ev) return { rows: [] };
      ev.status = 'processing'; ev.attempts++;
      ev.next_attempt_at = Date.now() + Number(params[1]);   // lease
      return { rows: [Object.assign({}, ev)] };
    }
    if (/^UPDATE webhook_events SET status = 'parked'/.test(q)) {
      var p = DB.events.filter(function (e) { return e.id === Number(params[0]); })[0];
      if (p) { p.status = 'parked'; p.processed_at = Date.now(); p.next_attempt_at = null; p.last_error = params[1]; }
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE webhook_events SET status = \$2, processed_at = NOW\(\)/.test(q)) {
      var d = DB.events.filter(function (e) { return e.id === Number(params[0]); })[0];
      if (d) { d.status = params[1]; d.processed_at = Date.now(); d.next_attempt_at = null; d.last_error = params[2]; }
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE webhook_events SET status = \$2, last_error = \$3/.test(q)) {
      var f = DB.events.filter(function (e) { return e.id === Number(params[0]); })[0];
      if (f) {
        f.status = params[1]; f.last_error = params[2];
        f.next_attempt_at = (params.length > 3) ? Date.now() + Number(params[3]) : null;
      }
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE webhook_events SET status = 'pending' WHERE status = 'processing'/.test(q)) {
      var rec = DB.events.filter(function (e) {
        return e.status === 'processing' && e.next_attempt_at !== null && e.next_attempt_at <= Date.now();
      });
      rec.forEach(function (e) { e.status = 'pending'; });
      return { rows: rec.map(function (e) { return { id: e.id }; }) };
    }
    if (/^SELECT id FROM webhook_events WHERE status IN \('pending','failed'\)/.test(q)) {
      var due = DB.events.filter(function (e) {
        return (e.status === 'pending' || e.status === 'failed') && e.next_attempt_at !== null && e.next_attempt_at <= Date.now();
      }).slice(0, Number(params[0]));
      return { rows: due.map(function (e) { return { id: e.id }; }) };
    }
    if (/^UPDATE webhook_events SET status = 'pending', next_attempt_at = NOW\(\)/.test(q)) {
      var r = DB.events.filter(function (e) { return e.id === Number(params[0]); })[0];
      if (r) { r.status = 'pending'; r.next_attempt_at = Date.now(); r.last_error = null; }
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Harness has no stub for: ' + q.slice(0, 120));
  }
};

// Intercept require('../db') for the modules under test.
var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db' || request === './db') return { pool: pool, initDB: async function () {} };
  // The admin router is not under test here (it is ordinary requireAuth CRUD);
  // stub its dependencies so the receiver can be loaded from the same file.
  if (request === '../middleware/auth') {
    return {
      requireAuth: function (req, res, next) { next(); },
      requirePermission: function () { return function (req, res, next) { next(); }; }
    };
  }
  if (request === '../utils/audit') return { logAudit: async function () {} };
  return origLoad.apply(this, arguments);
};

var ingest = require(path.join(__dirname, 'utils/webhookIngest'));
var handlers = require(path.join(__dirname, 'utils/webhookHandlers'));
var express = require(path.join(__dirname, 'node_modules/express'));
var syncRoutes = require(path.join(__dirname, 'routes/sync'));

/* ----------------------------------------------------------------- fixtures */

var TOKEN = 'tok_live_abc123_this_is_the_shared_secret';
function seedSource(over) {
  var s = Object.assign({
    id: DB.nextSourceId++, slug: 'pulsar', name: 'Pulsar Syncer',
    secret_hash: ingest.sha256(TOKEN), handler: 'pulsar', enabled: true,
    dedupe_path: null, dedupe_mode: 'id', event_type_path: null, accept_types: null,
    secret_header: null, hmac_mode: 'off', hmac_header: null, hmac_ts_header: null,
    hmac_secret_enc: null, hmac_format: null, hmac_max_skew_s: 300
  }, over || {});
  DB.sources.push(s);
  ingest.cacheBust();
  return s;
}
function reset() {
  DB.sources = []; DB.events = []; DB.stats = {}; DB.rejects = {}; DB.nextEventId = 1; DB.nextSourceId = 1;
  QUERY_LOG = []; FORCE_ERROR = null;
  ingest.cacheBust();
}

/* -------------------------------------------------------------- http client */

var app = express();
app.use('/api/sync/in', syncRoutes.inboundRouter);
var server = http.createServer(app);
var PORT = 0;

function post(pathname, body, headers) {
  return new Promise(function (resolve, reject) {
    var data = typeof body === 'string' ? body : JSON.stringify(body);
    var req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {})
    }, function (res) {
      var chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () {
        var json = null;
        try { json = JSON.parse(chunks); } catch (e) {}
        resolve({ status: res.statusCode, body: json, text: chunks });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
function get(pathname) {
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, function (res) {
      var c = ''; res.on('data', function (d) { c += d; });
      res.on('end', function () { resolve({ status: res.statusCode, body: JSON.parse(c || 'null') }); });
    }).on('error', reject);
  });
}
function settle() { return new Promise(function (r) { setTimeout(r, 60); }); }

/* -------------------------------------------------------------------- tests */

async function run() {
  console.log('\n== auth ==');
  reset(); seedSource();
  var r = await post('/api/sync/in/pulsar', { id: 'e1' });
  eq(r.status, 401, 'no token is 401');
  eq(r.body.error, 'unauthorized', 'no token error code');
  eq(DB.events.length, 0, 'no token stores nothing');

  r = await post('/api/sync/in/pulsar', { id: 'e1' }, { 'X-Nova-Token': 'wrong' });
  eq(r.status, 401, 'wrong token is 401');

  r = await post('/api/sync/in/pulsar', { id: 'e1' }, { 'X-Nova-Token': TOKEN });
  eq(r.status, 200, 'X-Nova-Token accepted');
  eq(DB.events.length, 1, 'accepted delivery stored');

  reset(); seedSource();
  r = await post('/api/sync/in/pulsar', { id: 'e2' }, { 'Authorization': 'Bearer ' + TOKEN });
  eq(r.status, 200, 'Authorization: Bearer accepted');
  reset(); seedSource();
  r = await post('/api/sync/in/pulsar', { id: 'e3' }, { 'X-Webhook-Token': TOKEN });
  eq(r.status, 200, 'X-Webhook-Token accepted');
  reset(); seedSource();
  r = await post('/api/sync/in/pulsar?token=' + TOKEN, { id: 'e4' });
  eq(r.status, 200, 'query string token accepted');

  reset(); seedSource();
  r = await post('/api/sync/in/nonexistent', { id: 'x' }, { 'X-Nova-Token': TOKEN });
  eq(r.status, 401, 'unknown slug is 401, not 404 (no enumeration)');
  ok(!r.body.detail, 'unknown slug leaks no detail');

  reset(); seedSource({ enabled: false });
  r = await post('/api/sync/in/pulsar', { id: 'x' }, { 'X-Nova-Token': TOKEN });
  eq(r.status, 503, 'disabled source is 503 so a syncer retries');
  eq(r.body.error, 'source_disabled', 'disabled error code');
  eq(DB.events.length, 0, 'disabled source stores nothing');

  console.log('== body handling ==');
  reset(); seedSource();
  r = await post('/api/sync/in/pulsar', 'not json at all', { 'X-Nova-Token': TOKEN });
  eq(r.status, 400, 'malformed JSON is 400');
  eq(r.body.error, 'invalid_json', 'malformed JSON error code');
  eq(DB.events.length, 0, 'malformed JSON stores nothing');

  r = await post('/api/sync/in/pulsar', '', { 'X-Nova-Token': TOKEN });
  eq(r.status, 400, 'empty body is 400');

  reset(); seedSource();
  var big = JSON.stringify({ id: 'big', blob: 'x'.repeat(ingest.MAX_BODY_BYTES + 1000) });
  r = await post('/api/sync/in/pulsar', big, { 'X-Nova-Token': TOKEN });
  ok(r.status === 413, 'oversize body rejected (got ' + r.status + ')');

  reset(); seedSource();
  r = await post('/api/sync/in/pulsar', { id: 'ct' }, { 'X-Nova-Token': TOKEN, 'Content-Type': 'text/plain' });
  eq(r.status, 200, 'text/plain content-type still accepted');

  reset(); seedSource();
  var exact = '{"id":"raw1",  "b":2,\n "a":1}';
  await post('/api/sync/in/pulsar', exact, { 'X-Nova-Token': TOKEN });
  eq(DB.events[0].raw_body, exact, 'raw_body is the exact bytes, whitespace and key order intact');

  console.log('== dedupe ==');
  reset(); seedSource();
  r = await post('/api/sync/in/pulsar', { id: 'dup1', v: 1 }, { 'X-Nova-Token': TOKEN });
  eq(r.body.duplicate, false, 'first delivery not a duplicate');
  r = await post('/api/sync/in/pulsar', { id: 'dup1', v: 999 }, { 'X-Nova-Token': TOKEN });
  eq(r.status, 200, 'a duplicate answers the same success status as anything else');
  eq(r.body.duplicate, true, 'same id is a duplicate even with different content');
  eq(DB.events.length, 1, 'duplicate stored nothing new');
  eq(r.body.id, 1, 'duplicate returns the original id');

  reset(); seedSource({ dedupe_path: 'data.event_id' });
  await post('/api/sync/in/pulsar', { data: { event_id: 'nested-7' } }, { 'X-Nova-Token': TOKEN });
  eq(DB.events[0].external_id, 'nested-7', 'dedupe_path reads a nested id');
  r = await post('/api/sync/in/pulsar', { data: { event_id: 'nested-7' } }, { 'X-Nova-Token': TOKEN });
  eq(r.body.duplicate, true, 'nested id dedupes');

  reset(); seedSource();
  await post('/api/sync/in/pulsar', { no_id_here: 1 }, { 'X-Nova-Token': TOKEN, 'X-Event-Id': 'hdr-9' });
  eq(DB.events[0].external_id, 'hdr-9', 'falls back to X-Event-Id header');

  reset(); seedSource();
  var blind = { anything: 'no id field' };
  await post('/api/sync/in/pulsar', blind, { 'X-Nova-Token': TOKEN });
  r = await post('/api/sync/in/pulsar', blind, { 'X-Nova-Token': TOKEN });
  eq(r.body.duplicate, true, 'identical id-less bytes inside the window are a duplicate');
  eq(DB.events.length, 1, 'blind duplicate stored nothing new');
  r = await post('/api/sync/in/pulsar', { anything: 'different' }, { 'X-Nova-Token': TOKEN });
  eq(r.body.duplicate, false, 'different id-less bytes are a new event');
  eq(DB.events.length, 2, 'different id-less bytes stored');

  reset(); seedSource();
  await post('/api/sync/in/pulsar', blind, { 'X-Nova-Token': TOKEN });
  DB.events[0].received_at = Date.now() - (11 * 60 * 1000);   // outside the blind window
  r = await post('/api/sync/in/pulsar', blind, { 'X-Nova-Token': TOKEN });
  eq(r.body.duplicate, false, 'identical bytes OUTSIDE the window are a genuine re-sync');

  console.log('== event type ==');
  reset(); seedSource({ event_type_path: 'type' });
  await post('/api/sync/in/pulsar', { id: 't1', type: 'call.created' }, { 'X-Nova-Token': TOKEN });
  eq(DB.events[0].event_type, 'call.created', 'event_type_path read');
  reset(); seedSource();
  await post('/api/sync/in/pulsar', { id: 't2', event: 'job.updated' }, { 'X-Nova-Token': TOKEN });
  eq(DB.events[0].event_type, 'job.updated', 'default event_type_path is "event"');
  reset(); seedSource();
  await post('/api/sync/in/pulsar', { id: 't3' }, { 'X-Nova-Token': TOKEN, 'X-Event-Type': 'from.header' });
  eq(DB.events[0].event_type, 'from.header', 'falls back to X-Event-Type header');

  console.log('== secret never stored or echoed ==');
  reset(); seedSource();
  await post('/api/sync/in/pulsar', { id: 'h1' }, { 'X-Nova-Token': TOKEN, 'User-Agent': 'PulsarSyncer/1.0', 'X-Secret-Thing': 'leak-me' });
  var hdrs = JSON.stringify(DB.events[0].headers);
  ok(hdrs.indexOf(TOKEN) === -1, 'token is not in the stored headers');
  ok(hdrs.indexOf('leak-me') === -1, 'unknown headers are not stored (positive allowlist)');
  ok(hdrs.indexOf('PulsarSyncer/1.0') !== -1, 'user-agent IS stored');
  ok(JSON.stringify(DB.events[0]).indexOf(TOKEN) === -1, 'token appears nowhere in the stored row');

  console.log('== processing / handlers ==');
  reset(); seedSource({ handler: 'nope-not-registered' });
  await post('/api/sync/in/pulsar', { id: 'p1' }, { 'X-Nova-Token': TOKEN });
  await settle();
  eq(DB.events[0].status, 'parked', 'no registered handler parks the event');
  ok(/No handler registered/.test(DB.events[0].last_error), 'parked reason explains itself');
  eq(DB.events[0].next_attempt_at, null, 'parked event is not retried');

  reset(); seedSource({ handler: 'echo' });
  await post('/api/sync/in/pulsar', { id: 'p2', event: 'x' }, { 'X-Nova-Token': TOKEN });
  await settle();
  eq(DB.events[0].status, 'done', 'registered handler marks done');
  ok(DB.events[0].processed_at !== null, 'done event has processed_at');

  reset(); seedSource({ handler: 'skipper' });
  handlers.register('skipper', async function () { return { skip: true, note: 'not interesting' }; });
  await post('/api/sync/in/pulsar', { id: 'p3' }, { 'X-Nova-Token': TOKEN });
  await settle();
  eq(DB.events[0].status, 'skipped', 'skip result marks skipped');
  eq(DB.events[0].last_error, 'not interesting', 'skip note kept');

  reset(); seedSource({ handler: 'thrower' });
  var calls = 0;
  handlers.register('thrower', async function () { calls++; throw new Error('downstream is down'); });
  await post('/api/sync/in/pulsar', { id: 'p4' }, { 'X-Nova-Token': TOKEN });
  await settle();
  eq(DB.events[0].status, 'failed', 'throwing handler marks failed');
  eq(DB.events[0].attempts, 1, 'one attempt recorded');
  ok(DB.events[0].next_attempt_at > Date.now(), 'failed event is scheduled for a retry');
  ok(/downstream is down/.test(DB.events[0].last_error), 'error message kept');

  // The retry sweep should not touch it before its backoff elapses.
  var swept = await ingest.runDue(50);
  eq(swept.considered, 0, 'sweep ignores an event still inside its backoff');
  eq(calls, 1, 'handler not re-run early');

  DB.events[0].next_attempt_at = Date.now() - 1;
  await ingest.runDue(50);
  eq(calls, 2, 'sweep re-runs the handler once the backoff elapses');
  eq(DB.events[0].attempts, 2, 'attempt count advanced');
  // Attempt 2 must wait BACKOFF_MS[1], not BACKOFF_MS[2]. This is the assertion
  // that caught the double-counted attempt in the catch block.
  var waited = DB.events[0].next_attempt_at - Date.now();
  ok(waited > ingest.BACKOFF_MS[1] - 5000 && waited <= ingest.BACKOFF_MS[1] + 1000,
    'backoff step matches the attempt number (waited ' + Math.round(waited / 1000) + 's, want ' + (ingest.BACKOFF_MS[1] / 1000) + 's)');

  // Walk it to the dead letter.
  for (var i = 0; i < 20 && DB.events[0].next_attempt_at !== null; i++) {
    DB.events[0].next_attempt_at = Date.now() - 1;
    await ingest.runDue(50);
  }
  eq(DB.events[0].status, 'failed', 'exhausted event stays failed');
  eq(DB.events[0].next_attempt_at, null, 'exhausted event is dead-lettered, not retried forever');
  eq(DB.events[0].attempts, ingest.BACKOFF_MS.length + 1, 'stopped at the end of the backoff schedule');
  var before = calls;
  await ingest.runDue(50);
  eq(calls, before, 'dead-lettered event is never picked up again');

  console.log('== permanent failure ==');
  reset(); seedSource({ handler: 'perm' });
  var permCalls = 0;
  handlers.register('perm', async function () { permCalls++; throw handlers.permanent('this will never parse'); });
  await post('/api/sync/in/pulsar', { id: 'p5' }, { 'X-Nova-Token': TOKEN });
  await settle();
  eq(DB.events[0].status, 'failed', 'permanent throw fails');
  eq(DB.events[0].next_attempt_at, null, 'permanent throw is dead-lettered on the FIRST attempt');
  eq(permCalls, 1, 'permanent throw is not retried');

  console.log('== replay ==');
  reset(); seedSource({ handler: 'later' });
  await post('/api/sync/in/pulsar', { id: 'r1' }, { 'X-Nova-Token': TOKEN });
  await post('/api/sync/in/pulsar', { id: 'r2' }, { 'X-Nova-Token': TOKEN });
  await settle();
  eq(DB.events[0].status, 'parked', 'events park while the handler does not exist');
  eq(DB.events[1].status, 'parked', 'second event parks too');
  var seen = [];
  handlers.register('later', async function (ev) { seen.push(ev.payload.id); });
  await ingest.replay(1);
  await ingest.replay(2);
  eq(DB.events[0].status, 'done', 'replay processes a parked event');
  eq(DB.events[1].status, 'done', 'replay processes the second one');
  eq(seen.join(','), 'r1,r2', 'handler saw the stored payloads, in order');

  console.log('== crash recovery ==');
  reset(); seedSource({ handler: 'echo' });
  await post('/api/sync/in/pulsar', { id: 'c1' }, { 'X-Nova-Token': TOKEN });
  DB.events[0].status = 'pending';           // simulate a restart before inline processing
  DB.events[0].processed_at = null;
  DB.events[0].attempts = 0;
  DB.events[0].next_attempt_at = Date.now();
  var out = await ingest.runDue(50);
  eq(out.processed, 1, 'sweep picks up an orphaned pending event');
  eq(DB.events[0].status, 'done', 'orphan gets processed');

  reset(); seedSource({ handler: 'echo' });
  await post('/api/sync/in/pulsar', { id: 'c2' }, { 'X-Nova-Token': TOKEN });
  await settle();
  DB.events[0].status = 'processing';                        // died inside the handler
  DB.events[0].next_attempt_at = Date.now() + 60000;         // lease still held
  out = await ingest.runDue(50);
  eq(DB.events[0].status, 'processing', 'a live lease is left alone');
  DB.events[0].next_attempt_at = Date.now() - 1;             // lease expired
  await ingest.runDue(50);
  eq(DB.events[0].status, 'done', 'an expired lease is reclaimed and reprocessed');

  console.log('== double claim ==');
  reset(); seedSource({ handler: 'slow' });
  var slowCalls = 0;
  handlers.register('slow', async function () { slowCalls++; await new Promise(function (r) { setTimeout(r, 40); }); });
  await post('/api/sync/in/pulsar', { id: 'd1' }, { 'X-Nova-Token': TOKEN });
  await Promise.all([ingest.runEvent(1), ingest.runEvent(1), ingest.runEvent(1)]);
  await settle();
  eq(slowCalls, 1, 'concurrent workers cannot both claim the same event');

  console.log('== nova is down ==');
  reset(); seedSource();
  FORCE_ERROR = 'connection terminated';
  r = await post('/api/sync/in/pulsar', { id: 'z1' }, { 'X-Nova-Token': TOKEN });
  eq(r.status, 503, 'a database failure answers 503 so the partner retries');
  eq(r.body.error, 'nova_unavailable', '503 error code');

  console.log('== discovery GET ==');
  reset(); seedSource();
  var g = await get('/api/sync/in/pulsar');
  eq(g.status, 200, 'GET on the endpoint answers 200');
  ok(/POST/.test(g.body.message), 'GET explains it wants a POST');
  var g2 = await get('/api/sync/in/does-not-exist');
  eq(g2.status, 200, 'GET on an unknown slug answers identically (no enumeration)');

  console.log('== batches (Pulsar may send an array) ==');
  var PULSAR = function (over) {
    return Object.assign({
      autonum: '0', dataTarget: '', dataHeader: 0, locationID: '0', targetID: '0',
      gmtStamp: '2026-08-13T00:00:00Z', targetUID: '00000000-0000-0000-0000-000000000000'
    }, over || {});
  };

  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader', handler: 'echo' });
  r = await post('/api/sync/in/pulsar', [PULSAR({ autonum: '1', dataHeader: 1000 }), PULSAR({ autonum: '2', dataHeader: 2000 })], { 'X-Nova-Token': TOKEN });
  eq(r.status, 200, 'array body accepted');
  eq(r.body.batch, true, 'response flags a batch');
  eq(r.body.accepted, 2, 'both records accepted');
  eq(DB.events.length, 2, 'array is SPLIT into one event per record');
  eq(DB.events[0].external_id, '1', 'record 1 deduped on autonum');
  eq(DB.events[1].event_type, '2000', 'dataHeader stored as the event type');
  eq(DB.events[0].event_type, '1000', 'numeric dataHeader survives as a string');

  // Half-overlapping resend: only the new record should store.
  r = await post('/api/sync/in/pulsar', [PULSAR({ autonum: '2', dataHeader: 2000 }), PULSAR({ autonum: '3', dataHeader: 2001 })], { 'X-Nova-Token': TOKEN });
  eq(r.body.duplicates, 1, 'overlapping record recognised as a duplicate');
  eq(DB.events.length, 3, 'only the genuinely new record was stored');

  r = await post('/api/sync/in/pulsar', [PULSAR({ autonum: '1', dataHeader: 1000 })], { 'X-Nova-Token': TOKEN });
  eq(r.status, 200, 'an all-duplicate batch is still a success');

  reset(); seedSource({ dedupe_path: 'autonum' });
  r = await post('/api/sync/in/pulsar', [], { 'X-Nova-Token': TOKEN });
  eq(r.status, 200, 'empty array is a clean success');
  eq(r.body.accepted, 0, 'empty array stores nothing');

  reset(); seedSource({ dedupe_path: 'autonum' });
  r = await post('/api/sync/in/pulsar', [PULSAR({ autonum: '1' }), 'not an object'], { 'X-Nova-Token': TOKEN });
  eq(r.status, 400, 'a bad element rejects the batch');
  eq(DB.events.length, 0, 'a rejected batch stores NOTHING - never half of it');

  reset(); seedSource({ dedupe_path: 'autonum' });
  var huge = [];
  for (var b = 0; b < ingest.MAX_BATCH + 1; b++) huge.push(PULSAR({ autonum: String(b) }));
  r = await post('/api/sync/in/pulsar', huge, { 'X-Nova-Token': TOKEN });
  eq(r.status, 413, 'oversize batch rejected');
  eq(DB.events.length, 0, 'oversize batch stores nothing');

  reset(); seedSource();
  r = await post('/api/sync/in/pulsar', '"just a string"', { 'X-Nova-Token': TOKEN });
  eq(r.status, 400, 'a bare JSON string is rejected');
  eq(r.body.error, 'invalid_payload', 'bare scalar error code');

  console.log('== type filter (the firehose) ==');
  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader', accept_types: '2000,2001', handler: 'echo' });
  r = await post('/api/sync/in/pulsar', PULSAR({ autonum: '10', dataHeader: 1000 }), { 'X-Nova-Token': TOKEN });
  eq(r.status, 200, 'a filtered record still answers success, never an error');
  eq(r.body.filtered, true, 'response says it was filtered');
  eq(DB.events.length, 0, 'unwanted type is NOT stored');

  r = await post('/api/sync/in/pulsar', PULSAR({ autonum: '11', dataHeader: 2000 }), { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 1, 'wanted type IS stored');
  eq(DB.events[0].event_type, '2000', 'stored record carries its type');

  r = await post('/api/sync/in/pulsar', [
    PULSAR({ autonum: '20', dataHeader: 1000 }), PULSAR({ autonum: '21', dataHeader: 2001 }),
    PULSAR({ autonum: '22', dataHeader: 1001 }), PULSAR({ autonum: '23', dataHeader: 2000 })
  ], { 'X-Nova-Token': TOKEN });
  eq(r.body.filtered, 2, 'batch reports how many were filtered');
  eq(r.body.accepted, 2, 'batch accepted only the wanted types');
  eq(DB.events.length, 3, 'only wanted records reached the table');

  // Quoted vs bare numbers must not matter.
  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader', accept_types: '2000' });
  await post('/api/sync/in/pulsar', PULSAR({ autonum: '30', dataHeader: 2000 }), { 'X-Nova-Token': TOKEN });
  await post('/api/sync/in/pulsar', PULSAR({ autonum: '31', dataHeader: '2000' }), { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 2, 'accept list matches whether the type was quoted or bare');

  // A record with NO type must survive a filter it cannot be matched against.
  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader', accept_types: '2000' });
  await post('/api/sync/in/pulsar', { autonum: '40' }, { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 1, 'a typeless record is kept, never silently dropped');

  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader', accept_types: '   ' });
  await post('/api/sync/in/pulsar', PULSAR({ autonum: '50', dataHeader: 9999 }), { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 1, 'a blank accept list means accept everything');

  console.log('== traffic counters ==');
  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader', accept_types: '2000' });
  // The counter buffer is module state and survives reset(), so drain what the
  // earlier tests accumulated before measuring this one.
  await ingest.flushStats();
  DB.stats = {};
  await post('/api/sync/in/pulsar', [
    PULSAR({ autonum: '60', dataHeader: 1000 }), PULSAR({ autonum: '61', dataHeader: 1000 }),
    PULSAR({ autonum: '62', dataHeader: 1000 }), PULSAR({ autonum: '63', dataHeader: 2000 })
  ], { 'X-Nova-Token': TOKEN });
  await ingest.flushStats();
  eq(DB.stats['pulsar|1000'].dropped, 3, 'DROPPED types are still counted - this is how you size a firehose');
  eq(DB.stats['pulsar|1000'].stored, 0, 'dropped types are not counted as stored');
  eq(DB.stats['pulsar|2000'].stored, 1, 'stored types counted');
  var again = await ingest.flushStats();
  eq(again.flushed, 0, 'flush clears the buffer, so counts are never doubled');

  // A duplicate is a real delivery that produced no event. Counting it as
  // 'stored' is what made "traffic is arriving but the log is empty" unexplainable.
  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader' });
  await ingest.flushStats(); DB.stats = {};
  await post('/api/sync/in/pulsar', PULSAR({ autonum: '70', dataHeader: 1000 }), { 'X-Nova-Token': TOKEN });
  await post('/api/sync/in/pulsar', PULSAR({ autonum: '70', dataHeader: 1000 }), { 'X-Nova-Token': TOKEN });
  await post('/api/sync/in/pulsar', PULSAR({ autonum: '70', dataHeader: 1000 }), { 'X-Nova-Token': TOKEN });
  await ingest.flushStats();
  eq(DB.events.length, 1, 'only the first of three identical ids stored');
  eq(DB.stats['pulsar|1000'].stored, 1, 'one counted as stored');
  eq(DB.stats['pulsar|1000'].duplicate, 2, 'the other two counted as DUPLICATES, not as stored');

  console.log('== pulsar sentinel handling ==');
  var pid = handlers._pulsarId;
  eq(pid('0'), null, '"0" is absent, not id zero');
  eq(pid(0), null, 'numeric 0 is absent');
  eq(pid('00000000-0000-0000-0000-000000000000'), null, 'nil GUID is absent');
  eq(pid(''), null, 'empty string is absent');
  eq(pid('  '), null, 'whitespace is absent');
  eq(pid(null), null, 'null is absent');
  eq(pid('4021'), '4021', 'a real id survives as a string');
  eq(pid('3f55d9e3-20ee-4100-9556-1b5533312087'), '3f55d9e3-20ee-4100-9556-1b5533312087', 'a real GUID survives');
  eq(pid('01'), '01', 'a leading zero is NOT the sentinel');

  var draft = handlers._pulsarDraft;
  var sk = await draft({ payload: PULSAR({ dataHeader: 1000, targetUID: 'abc' }) }, {});
  eq(sk.skip, true, 'an unmapped dataHeader is skipped, not failed');
  ok(/1000/.test(sk.note), 'skip note names the code');
  var threw = null;
  try { await draft({ payload: { autonum: '1' } }, {}); } catch (e) { threw = e; }
  ok(threw && threw.permanent, 'a record with no dataHeader fails PERMANENTLY - retrying cannot help');
  // dataHeader 0 must be treated as a real code, not as missing.
  var zero = await draft({ payload: PULSAR({ dataHeader: 0 }) }, {});
  eq(zero.skip, true, 'dataHeader 0 is a valid code, not a missing field');

  console.log('== custom auth header (Pulsar sends "auth") ==');
  var crypto = require('crypto');
  reset(); seedSource({ secret_header: 'auth' });
  r = await post('/api/sync/in/pulsar', { id: 'a1' }, { 'auth': TOKEN });
  eq(r.status, 200, 'token accepted in a custom header named auth');
  reset(); seedSource({ secret_header: 'auth' });
  r = await post('/api/sync/in/pulsar', { id: 'a2' }, { 'auth': 'nope' });
  eq(r.status, 401, 'wrong value in the custom header is still 401');
  reset(); seedSource({ secret_header: 'auth' });
  r = await post('/api/sync/in/pulsar', { id: 'a3' }, { 'X-Nova-Token': TOKEN });
  eq(r.status, 200, 'the built-in headers keep working alongside a custom one');
  reset(); seedSource();
  r = await post('/api/sync/in/pulsar', { id: 'a4' }, { 'auth': TOKEN });
  eq(r.status, 401, 'a custom header is NOT honoured unless the source opts in');

  console.log('== signing key at rest ==');
  process.env.SYNC_SECRET_KEY = crypto.randomBytes(32).toString('base64');
  ok(ingest.sboxReady(), 'a 32-byte SYNC_SECRET_KEY is accepted');
  var sealed = ingest.sealSecret('the-signing-key');
  ok(sealed !== 'the-signing-key', 'the key is not stored in the clear');
  ok(sealed.indexOf('the-signing-key') === -1, 'plaintext does not appear inside the sealed blob');
  eq(ingest.openSecret(sealed), 'the-signing-key', 'sealed key round-trips');
  ok(ingest.sealSecret('x') !== ingest.sealSecret('x'), 'same key seals differently each time (fresh IV)');
  eq(ingest.openSecret('not-a-real-blob'), null, 'a garbage blob opens as null, never a throw');
  var tampered = Buffer.from(sealed, 'base64'); tampered[tampered.length - 1] ^= 0xff;
  eq(ingest.openSecret(tampered.toString('base64')), null, 'a tampered blob fails the auth tag');

  console.log('== signature verification ==');
  var SIGKEY = 'pulsar-signing-key-abc';
  var TS = '2026-08-13T00:00:00Z';
  function sign(fmt, body, ts, enc) {
    var msg = fmt === 'body' ? body : fmt === 'ts.body' ? (ts + '.' + body) : fmt === 'ts+body' ? (ts + body) : (body + '.' + ts);
    return crypto.createHmac('sha256', SIGKEY).update(msg, 'utf8').digest(enc || 'hex');
  }

  function hmacSource(over) {
    return seedSource(Object.assign({
      secret_header: 'auth',
      hmac_mode: 'observe',
      hmac_header: 'pulsar-signature',
      hmac_ts_header: 'pulsar-timestamp',
      hmac_secret_enc: ingest.sealSecret(SIGKEY),
      hmac_format: null,
      hmac_max_skew_s: 300
    }, over || {}));
  }

  // observe: a correct signature is recorded, and so is a wrong one, and both
  // are stored either way.
  reset(); hmacSource();
  var bodyStr = JSON.stringify({ id: 's1' });
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': sign('body', bodyStr), 'Pulsar-Timestamp': TS });
  eq(r.status, 200, 'observe mode accepts a correctly signed request');
  eq(DB.events[0].sig_state, 'ok:body', 'the matching formulation is recorded on the event');

  reset(); hmacSource();
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': 'deadbeef', 'Pulsar-Timestamp': TS });
  eq(r.status, 200, 'observe mode still ACCEPTS a bad signature - that is the point');
  eq(DB.events[0].sig_state, 'mismatch', 'the bad signature is recorded, not hidden');

  reset(); hmacSource();
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN });
  eq(DB.events[0].sig_state, 'missing', 'a missing signature header is recorded as missing');

  // every formulation is diagnosed by name
  var FMTS = ['body', 'ts.body', 'ts+body', 'body.ts'];
  for (var fi = 0; fi < FMTS.length; fi++) {
    reset(); hmacSource();
    r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': sign(FMTS[fi], bodyStr, TS), 'Pulsar-Timestamp': TS });
    eq(DB.events[0].sig_state, 'ok:' + FMTS[fi], 'formulation ' + FMTS[fi] + ' is identified by name');
  }

  reset(); hmacSource();
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': sign('body', bodyStr, TS, 'base64'), 'Pulsar-Timestamp': TS });
  eq(DB.events[0].sig_state, 'ok:body', 'base64 signatures match as well as hex');

  reset(); hmacSource();
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': 'sha256=' + sign('body', bodyStr), 'Pulsar-Timestamp': TS });
  eq(DB.events[0].sig_state, 'ok:body', 'a "sha256=" prefix is tolerated');

  reset(); hmacSource();
  var plainHash = crypto.createHash('sha256').update(SIGKEY + bodyStr, 'utf8').digest('hex');
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': plainHash, 'Pulsar-Timestamp': TS });
  eq(DB.events[0].sig_state, 'ok:sha256(token+body)', 'the common non-HMAC misreading is recognised by name');

  console.log('== signature enforcement ==');
  reset(); hmacSource({ hmac_mode: 'require', hmac_format: 'body' });
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': sign('body', bodyStr), 'Pulsar-Timestamp': TS });
  eq(r.status, 200, 'require mode accepts a correct signature');

  reset(); hmacSource({ hmac_mode: 'require', hmac_format: 'body' });
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': 'deadbeef', 'Pulsar-Timestamp': TS });
  eq(r.status, 401, 'require mode REJECTS a bad signature');
  eq(r.body.error, 'bad_signature', 'rejection names the reason');
  ok(!r.body.detail, 'the 401 does not explain WHICH part failed (no signature oracle)');
  eq(DB.events.length, 0, 'a rejected request stores nothing');

  reset(); hmacSource({ hmac_mode: 'require', hmac_format: 'body' });
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Timestamp': TS });
  eq(r.status, 401, 'require mode rejects a request with no signature at all');

  // A pinned format must not accept a different one - otherwise pinning is decorative.
  reset(); hmacSource({ hmac_mode: 'require', hmac_format: 'body' });
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': sign('ts.body', bodyStr, TS), 'Pulsar-Timestamp': TS });
  eq(r.status, 401, 'a pinned format rejects a DIFFERENT valid formulation');

  reset(); hmacSource({ hmac_mode: 'require', hmac_format: 'body', hmac_secret_enc: null });
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': sign('body', bodyStr) });
  eq(r.status, 401, 'require mode with no stored key fails CLOSED');

  // Body tampering is what the signature is actually for.
  reset(); hmacSource({ hmac_mode: 'require', hmac_format: 'body' });
  r = await post('/api/sync/in/pulsar', JSON.stringify({ id: 's1', tampered: true }),
    { 'auth': TOKEN, 'Pulsar-Signature': sign('body', bodyStr), 'Pulsar-Timestamp': TS });
  eq(r.status, 401, 'a signature from a DIFFERENT body is rejected');

  console.log('== timestamp skew ==');
  reset(); hmacSource({ hmac_mode: 'require', hmac_format: 'ts.body', hmac_max_skew_s: 300 });
  var oldTs = new Date(Date.now() - 3600e3).toISOString();
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': sign('ts.body', bodyStr, oldTs), 'Pulsar-Timestamp': oldTs });
  eq(r.status, 401, 'a correctly signed but STALE request is rejected when ts is inside the signature');

  reset(); hmacSource({ hmac_mode: 'require', hmac_format: 'ts.body', hmac_max_skew_s: 300 });
  var freshTs = new Date().toISOString();
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': sign('ts.body', bodyStr, freshTs), 'Pulsar-Timestamp': freshTs });
  eq(r.status, 200, 'a fresh timestamp passes');

  // Skew must NOT be enforced when the timestamp is not signed - it would be
  // theatre, and it would reject good traffic over a clock difference.
  reset(); hmacSource({ hmac_mode: 'require', hmac_format: 'body', hmac_max_skew_s: 300 });
  r = await post('/api/sync/in/pulsar', bodyStr, { 'auth': TOKEN, 'Pulsar-Signature': sign('body', bodyStr), 'Pulsar-Timestamp': oldTs });
  eq(r.status, 200, 'an unsigned stale timestamp is ignored rather than enforced as theatre');

  console.log('== batches carry one verdict ==');
  reset(); hmacSource({ dedupe_path: 'autonum', hmac_mode: 'observe' });
  var arr = [{ autonum: '1' }, { autonum: '2' }];
  var arrRaw = JSON.stringify(arr);
  r = await post('/api/sync/in/pulsar', arrRaw, { 'auth': TOKEN, 'Pulsar-Signature': sign('body', arrRaw), 'Pulsar-Timestamp': TS });
  eq(DB.events.length, 2, 'batch split as usual');
  eq(DB.events[0].sig_state, 'ok:body', 'record 1 carries the request verdict');
  eq(DB.events[1].sig_state, 'ok:body', 'record 2 carries the same verdict (signed over the whole request)');

  console.log('== signing off by default ==');
  reset(); seedSource();
  r = await post('/api/sync/in/pulsar', { id: 'n1' }, { 'X-Nova-Token': TOKEN });
  eq(DB.events[0].sig_state, null, 'a source that does not sign records no verdict');
  delete process.env.SYNC_SECRET_KEY;

  console.log('== BULK: the timeout bug ==');
  // Every query the fake pool sees is logged, so "how many round trips did that
  // request cost" is directly measurable. This is the regression guard: the
  // first version issued one INSERT per record and Pulsar timed out.
  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader' });
  var big = [];
  for (var q1 = 0; q1 < 500; q1++) big.push(PULSAR({ autonum: 'b' + q1, dataHeader: 1000 + (q1 % 4) }));
  QUERY_LOG = [];
  var t0 = Date.now();
  r = await post('/api/sync/in/pulsar', big, { 'X-Nova-Token': TOKEN });
  var elapsed = Date.now() - t0;
  var inserts = QUERY_LOG.filter(function (x) { return /^INSERT INTO webhook_events/.test(x); }).length;
  eq(r.status, 200, '500-record batch accepted');
  eq(r.body.accepted, 500, 'all 500 accepted');
  eq(DB.events.length, 500, 'all 500 stored');
  ok(inserts <= 5, '500 records cost ' + inserts + ' INSERT statements, not 500');
  ok(elapsed < 2000, '500-record batch answered in ' + elapsed + 'ms');

  // Dedupe must survive the rewrite - this is the whole reason batches are
  // split per record in the first place.
  QUERY_LOG = [];
  var overlap = [];
  for (var q2 = 400; q2 < 600; q2++) overlap.push(PULSAR({ autonum: 'b' + q2, dataHeader: 1000 }));
  r = await post('/api/sync/in/pulsar', overlap, { 'X-Nova-Token': TOKEN });
  eq(r.body.duplicates, 100, 'the 100 overlapping records are recognised as duplicates');
  eq(r.body.accepted, 100, 'only the 100 genuinely new ones are accepted');
  eq(DB.events.length, 600, 'exactly 100 new rows stored');

  // A record repeated INSIDE one array must not race itself.
  reset(); seedSource({ dedupe_path: 'autonum' });
  r = await post('/api/sync/in/pulsar', [PULSAR({ autonum: '7' }), PULSAR({ autonum: '7' }), PULSAR({ autonum: '8' })], { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 2, 'a repeat within one array is collapsed, not inserted twice');
  eq(r.body.duplicates, 1, 'the in-array repeat is reported as a duplicate');

  // The id-less path must also be one lookup, not N.
  reset(); seedSource();
  var noIds = [];
  for (var q3 = 0; q3 < 100; q3++) noIds.push({ thing: q3 });
  QUERY_LOG = [];
  r = await post('/api/sync/in/pulsar', noIds, { 'X-Nova-Token': TOKEN });
  var selects = QUERY_LOG.filter(function (x) { return /^SELECT DISTINCT body_hash/.test(x); }).length;
  eq(DB.events.length, 100, '100 id-less records stored');
  eq(selects, 1, 'id-less dedupe is ONE lookup for the whole batch, not one per record');

  reset(); seedSource();
  var dupBytes = { same: 'payload' };
  r = await post('/api/sync/in/pulsar', [dupBytes, dupBytes, dupBytes], { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 1, 'identical id-less records inside one array collapse to one');
  eq(r.body.duplicates, 2, 'and the other two are reported as duplicates');

  // Filtering still happens before any query at all.
  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader', accept_types: '2000' });
  var mixed = [];
  for (var q4 = 0; q4 < 50; q4++) mixed.push(PULSAR({ autonum: 'f' + q4, dataHeader: q4 < 40 ? 1000 : 2000 }));
  QUERY_LOG = [];
  r = await post('/api/sync/in/pulsar', mixed, { 'X-Nova-Token': TOKEN });
  eq(r.body.filtered, 40, '40 filtered out of the batch');
  eq(DB.events.length, 10, 'only the 10 wanted records stored');

  console.log('== SENTINEL ids must not collapse a batch ==');
  reset(); seedSource({ dedupe_path: 'autonum', event_type_path: 'dataHeader' });
  var sentinelBatch = [];
  for (var z = 0; z < 100; z++) sentinelBatch.push(PULSAR({ autonum: '0', dataHeader: 1000 + z, locationID: String(z) }));
  r = await post('/api/sync/in/pulsar', sentinelBatch, { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 100, '100 records with autonum "0" all stored - "0" is not an id');
  eq(r.body.duplicates, 0, 'and none of them are called duplicates');
  eq(DB.events[0].external_id, '0', 'the sentinel value is still RECORDED as the partner sent it');
  eq(DB.events[0].dedupe_key, null, 'but it is never used as a dedupe key');

  reset(); seedSource({ dedupe_path: 'autonum' });
  var nilBatch = [];
  for (var z2 = 0; z2 < 5; z2++) nilBatch.push(PULSAR({ autonum: '00000000-0000-0000-0000-000000000000', locationID: String(z2) }));
  r = await post('/api/sync/in/pulsar', nilBatch, { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 5, 'nil-GUID ids do not collapse either');

  // But identical BYTES with a sentinel id are still a genuine duplicate.
  reset(); seedSource({ dedupe_path: 'autonum' });
  var sameRec = PULSAR({ autonum: '0', dataHeader: 1000 });
  r = await post('/api/sync/in/pulsar', [sameRec, sameRec, sameRec], { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 1, 'sentinel id falls back to byte comparison, which still catches true repeats');
  eq(r.body.duplicates, 2, 'and reports them');

  // A REAL id must still dedupe.
  reset(); seedSource({ dedupe_path: 'autonum' });
  r = await post('/api/sync/in/pulsar', [PULSAR({ autonum: '5' }), PULSAR({ autonum: '5', locationID: '9' })], { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 1, 'a real repeated id still dedupes');

  var did = ingest.dedupeId;
  eq(did('0'), null, '"0" is not an id');
  eq(did(0), null, 'numeric 0 is not an id');
  eq(did('-1'), null, '"-1" is not an id');
  eq(did('null'), null, '"null" as text is not an id');
  eq(did('00000000-0000-0000-0000-000000000000'), null, 'nil GUID is not an id');
  eq(did('  '), null, 'blank is not an id');
  eq(did('1'), '1', '"1" IS a real id');
  eq(did('01'), '01', '"01" is a real id, not a sentinel');
  eq(did('0.0'), '0.0', '"0.0" is not the sentinel');

  console.log('== duplicate checking OFF ==');
  reset(); seedSource({ dedupe_path: 'autonum', dedupe_mode: 'off' });
  var same = PULSAR({ autonum: '5', dataHeader: 1000 });
  r = await post('/api/sync/in/pulsar', [same, same, same], { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 3, 'mode off stores every record, even byte-identical ones');
  eq(r.body.duplicates, 0, 'and reports no duplicates');
  eq(DB.events[0].external_id, '5', 'the partner id is STILL recorded when checking is off');
  eq(DB.events[0].dedupe_key, null, 'but nothing is enforced on it');

  reset(); seedSource({ dedupe_path: 'autonum', dedupe_mode: 'off' });
  await post('/api/sync/in/pulsar', PULSAR({ autonum: '9' }), { 'X-Nova-Token': TOKEN });
  await post('/api/sync/in/pulsar', PULSAR({ autonum: '9' }), { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 2, 'mode off does not dedupe across separate requests either');

  console.log('== duplicate checking by BYTES ==');
  reset(); seedSource({ dedupe_path: 'autonum', dedupe_mode: 'bytes' });
  r = await post('/api/sync/in/pulsar', [PULSAR({ autonum: '1' }), PULSAR({ autonum: '2' })], { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 2, 'bytes mode ignores the id field, so different records both store');
  eq(DB.events[0].external_id, '1', 'id still recorded in bytes mode');
  eq(DB.events[0].dedupe_key, null, 'id not enforced in bytes mode');
  var rec = PULSAR({ autonum: '3' });
  r = await post('/api/sync/in/pulsar', [rec, rec], { 'X-Nova-Token': TOKEN });
  eq(r.body.duplicates, 1, 'bytes mode still catches a genuine byte-for-byte repeat');

  console.log('== id mode still works ==');
  reset(); seedSource({ dedupe_path: 'autonum', dedupe_mode: 'id' });
  r = await post('/api/sync/in/pulsar', [PULSAR({ autonum: '1' }), PULSAR({ autonum: '1', locationID: '9' })], { 'X-Nova-Token': TOKEN });
  eq(DB.events.length, 1, 'id mode still dedupes on a repeated id');
  eq(DB.events[0].dedupe_key, '1', 'dedupe_key is set in id mode');
  eq(DB.events[0].external_id, '1', 'and external_id matches it');

  eq(ingest.dedupeMode({ dedupe_mode: 'off' }), 'off', 'mode off parsed');
  eq(ingest.dedupeMode({ dedupe_mode: 'bytes' }), 'bytes', 'mode bytes parsed');
  eq(ingest.dedupeMode({ dedupe_mode: 'nonsense' }), 'id', 'an unknown mode falls back to id, never to off');
  eq(ingest.dedupeMode({}), 'id', 'missing mode defaults to id');

  console.log('== REJECTIONS are recorded ==');
  reset(); seedSource({ secret_header: 'auth' });
  await ingest.flushRejections(); DB.rejects = {};

  await post('/api/sync/in/pulsar', { id: 'x' }, {});                              // no token
  await post('/api/sync/in/pulsar', { id: 'x' }, { 'auth': 'wrong' });             // wrong token
  await post('/api/sync/in/pulsar', { id: 'x' }, { 'auth': 'wrong' });             // again
  await post('/api/sync/in/nope', { id: 'x' }, { 'auth': TOKEN });                 // unknown slug
  await post('/api/sync/in/pulsar', 'not json', { 'auth': TOKEN });                // bad json
  await ingest.flushRejections();

  var keys = Object.keys(DB.rejects).join(' ');
  ok(/pulsar\|no_token/.test(keys), 'a missing token is recorded');
  ok(/pulsar\|wrong_token/.test(keys), 'a wrong token is recorded');
  ok(/nope\|unknown_source/.test(keys), 'a post to an unknown slug is recorded');
  ok(/pulsar\|invalid_json/.test(keys), 'malformed JSON is recorded');
  var wrongKey = Object.keys(DB.rejects).filter(function (k) { return /wrong_token/.test(k); })[0];
  eq(DB.rejects[wrongKey], 2, 'repeat rejections are counted, not duplicated');
  eq(DB.events.length, 0, 'and none of them stored an event');

  // The rejection log must never become a way to write content without a token.
  ok(JSON.stringify(DB.rejects).indexOf('not json') === -1, 'no rejected payload body is stored');
  ok(JSON.stringify(DB.rejects).indexOf(TOKEN) === -1, 'no token is stored in the rejection log');

  var again2 = await ingest.flushRejections();
  eq(again2.flushed, 0, 'the rejection buffer clears, so counts are not doubled');

  // A scanner must not be able to grow the buffer without bound.
  for (var sc = 0; sc < 500; sc++) ingest.countReject('slug' + sc, 'unknown_source', '1.2.3.' + sc);
  var flushed = await ingest.flushRejections();
  ok(flushed.flushed <= 200, 'the in-memory rejection buffer is capped (' + flushed.flushed + ')');

  console.log('== helpers ==');
  eq(ingest.pluck({ a: { b: { c: 5 } } }, 'a.b.c'), 5, 'pluck walks a dot path');
  eq(ingest.pluck({ a: [{ id: 'q' }] }, 'a.0.id'), 'q', 'pluck walks an array index');
  eq(ingest.pluck({ a: 1 }, 'a.b.c'), undefined, 'pluck on a missing path is undefined, not a throw');
  eq(ingest.pluck(null, 'a'), undefined, 'pluck on null is undefined');
  ok(ingest.newSecret().length >= 60, 'generated secret is long');
  ok(ingest.newSecret() !== ingest.newSecret(), 'generated secrets differ');
  ok(!/[+/=]/.test(ingest.newSecret()), 'generated secret is URL-safe');
  eq(ingest.sha256('a').length, 64, 'sha256 returns hex');
  ok(handlers.list().indexOf('echo') !== -1, 'echo handler is registered');
  ok(handlers.get('pulsar') === null || typeof handlers.get('pulsar') === 'function', 'pulsar handler slot resolves');
  eq(ingest.accepts({ accept_types: null }, '1000'), true, 'no accept list accepts everything');
  eq(ingest.accepts({ accept_types: '2000,2001' }, '1000'), false, 'accept list rejects an unlisted type');
  eq(ingest.accepts({ accept_types: '2000, 2001 ' }, '2001'), true, 'accept list tolerates spaces');

  console.log('\n' + PASS + '/' + (PASS + FAIL) + ' assertions passed' + (FAIL ? ('  (' + FAIL + ' FAILED)') : ''));
  server.close();
  process.exit(FAIL ? 1 : 0);
}

server.listen(0, '127.0.0.1', function () {
  PORT = server.address().port;
  run().catch(function (e) { console.error(e); process.exit(1); });
});
