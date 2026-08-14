'use strict';
/*
 * Stubbed harness for the OUTBOUND Pulsar client.
 *
 * Fake pg pool + a real HTTP server standing in for the Pulsar API. The fake
 * Pulsar records exactly what it received and can be told to answer with any of
 * the envelopes their documentation shows, which is what makes these tests
 * worth anything: they assert against bytes that actually crossed a socket, and
 * against replies shaped like the real ones.
 *
 * No database and no network beyond loopback. Run with: node test-outbound.js
 */

var http = require('http');
var path = require('path');

var PASS = 0, FAIL = 0;
function ok(cond, label) {
  if (cond) { PASS++; }
  else { FAIL++; console.error('  FAIL: ' + label); }
}
function eq(a, b, label) { ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ------------------------------------------------------------- fake pg pool */

var DB = { calls: [], nextId: 1 };
var AUDITS = [];

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

var pool = {
  query: async function (sql, params) {
    params = params || [];
    var q = norm(sql);

    if (/^INSERT INTO outbound_calls/.test(q)) {
      var row = {
        id: DB.nextId++,
        target: params[0], action: params[1], params: JSON.parse(params[2]),
        request_shape: params[3], request_url: params[4], request_body: params[5],
        mode: params[6], status: 'sending',
        user_id: params[7], user_name: params[8], correlation: params[9], attempts: 0
      };
      DB.calls.push(row);
      return { rows: [row] };
    }
    if (/^UPDATE outbound_calls SET status/.test(q)) {
      var r = DB.calls.filter(function (c) { return c.id === params[0]; })[0];
      if (r) {
        r.status = params[1]; r.http_status = params[2]; r.response_body = params[3];
        r.error = params[4]; r.attempts = params[5]; r.next_attempt_at = params[6];
        r.duration_ms = params[7];
      }
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (/^UPDATE outbound_calls SET attempts/.test(q)) {
      var due = DB.calls.filter(function (c) {
        return c.status === 'failed' && c.next_attempt_at && new Date(c.next_attempt_at) <= new Date();
      });
      due.forEach(function (c) { c.attempts = Number(c.attempts) + 1; c.next_attempt_at = new Date(Date.now() + 3e5); });
      return { rows: due };
    }
    if (/^INSERT INTO audit_logs/.test(q)) {
      AUDITS.push({ entity_type: params[0], action: params[3], details: JSON.parse(params[6] || '{}') });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
};

var DB_PATH = path.join(__dirname, 'db.js');
require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: { pool: pool, initDB: async function () {} } };

/* ------------------------------------------------------- the fake Pulsar API */

var SEEN = [];
var NEXT = { status: 200, body: '{"result":{},"wasSuccess":true,"issueMessaage":""}', delayMs: 0 };

var fake = http.createServer(function (req, res) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    SEEN.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    var send = function () {
      res.writeHead(NEXT.status, { 'Content-Type': 'application/json' });
      res.end(NEXT.body);
    };
    if (NEXT.delayMs) setTimeout(send, NEXT.delayMs); else send();
  });
});

var API = null;
function last() { return SEEN[SEEN.length - 1]; }
function lastJson() { try { return JSON.parse(last().body); } catch (e) { return {}; } }
function okEnvelope() { NEXT.status = 200; NEXT.body = '{"result":{},"wasSuccess":true,"issueMessaage":""}'; }

/* ------------------------------------------------------------------- the run */

// Placeholder credentials. These are NOT the real ones and are not meant to be
// - the point of the redaction tests is that whatever is in the environment
// never reaches the database, and a fake secret proves that as well as a real
// one would.
var SKEY  = 'TEST-SKEY-0000000000000000AAAA';
var TOKEN = 'TEST-TOKEN-1111111111111111BBBB';

async function run() {
  process.env.PULSAR_SKEY = SKEY;
  process.env.PULSAR_TOKEN = TOKEN;
  process.env.PULSAR_API_URL = API;
  process.env.PULSAR_IMPORT_URL = API + '?import';
  process.env.PULSAR_GPS_URL = API + '?gps';

  var out = require('./utils/pulsarOut');

  // Almost every action is deliberately unverified, so live mode refuses it
  // unless forced. These tests are exercising the wire format, not the safety
  // catch, so they force; the safety catch gets its own section below.
  function go(action, params) { return out.call(action, params || {}, { force: true }); }

  console.log('== disarmed by default ==');
  process.env.PULSAR_OUT_MODE = 'off';
  var offRes = await out.call('auth_test', {}, {});
  eq(offRes.blocked, 'off', 'mode off refuses to send anything');
  eq(SEEN.length, 0, 'mode off did not touch the network');
  eq(DB.calls.length, 0, 'mode off did not even write a row');

  console.log('== dry run ==');
  process.env.PULSAR_OUT_MODE = 'dry';
  var dry = await out.call('enroute', { techID: 'sean', callUID: '2ba67338-1fa8-496f-8215-73c8dd617343', locID: '201002101605558713' }, { user_name: 'tony' });
  ok(dry.ok && dry.dry, 'dry mode reports success without sending');
  eq(SEEN.length, 0, 'dry mode sent nothing');
  eq(DB.calls.length, 1, 'dry mode still wrote the row it would have sent');
  eq(DB.calls[0].status, 'dry', 'the row is marked dry, not done');
  ok(dry.would_send.body.indexOf('201002101605558713') !== -1, 'the dry body carries the location id');

  console.log('== documented auth headers ==');
  process.env.PULSAR_OUT_MODE = 'live';
  okEnvelope();
  var t = await go('auth_test', { message: 'hello' });
  ok(t.ok, 'the documented auth test succeeds');
  eq(last().headers.auth, TOKEN, 'the TOKEN goes in the header named auth, not one named token');
  eq(last().headers.skey, SKEY, 'the sKey goes in the header named skey');
  eq(last().headers['content-type'], 'application/json', 'JSON body');
  eq(lastJson().header, 100, 'the auth test sends header 100 as documented');

  console.log('== credentials never reach the database ==');
  var stored = DB.calls[DB.calls.length - 1];
  ok(JSON.stringify(DB.calls).indexOf(SKEY) === -1, 'no stored row anywhere contains the sKey');
  ok(JSON.stringify(DB.calls).indexOf(TOKEN) === -1, 'no stored row anywhere contains the token');
  eq(out.redact('a ' + TOKEN + ' b'), 'a [redacted] b', 'redact strips a bare secret from any string');
  eq(out.redact('nothing to see'), 'nothing to see', 'redact leaves ordinary text alone');
  eq(out.redact(null), null, 'redact tolerates null');
  ok(String(out.credFingerprint(TOKEN)).indexOf(TOKEN) === -1, 'the fingerprint does not contain the secret');
  ok(String(out.credFingerprint(TOKEN)).indexOf('BBBB') !== -1, 'the fingerprint shows the last four so you can tell keys apart');
  eq(out.credFingerprint(''), null, 'an unset credential has no fingerprint');

  console.log('== 200 is not success ==');
  NEXT.body = '{"result":{},"wasSuccess":false,"issueMessaage":"serviceID is missing or incorrect","issueNumber":3}';
  var rej = await go('auth_test', {});
  ok(!rej.ok, 'a 200 carrying wasSuccess:false is a FAILURE, not a success');
  eq(rej.http_status, 200, 'even though the HTTP status was a perfectly healthy 200');
  eq(rej.error, 'serviceID is missing or incorrect', 'the message is read from issueMessaage - their spelling, three a s');
  eq(rej.issue_number, 3, 'the issue number is surfaced');
  eq(rej.status, 'dead', 'a business rejection is permanent - retrying it four times helps nobody');
  ok(!rej.retrying, 'and the caller is told it will not be retried');

  NEXT.body = '{"wasSuccess":false,"issueMessage":"other spelling"}';
  var rej2 = await go('auth_test', {});
  eq(rej2.error, 'other spelling', 'the correctly spelled issueMessage is read too');

  NEXT.body = '<html>502 Bad Gateway</html>';
  var htmlish = await go('auth_test', {});
  ok(!htmlish.ok, 'a 200 whose body is not JSON is not called a success');
  ok(String(htmlish.error).indexOf('not JSON') !== -1, 'and says why: ' + htmlish.error);

  NEXT.body = '{"something":"we have never seen"}';
  var odd = await go('auth_test', {});
  ok(odd.ok, 'an unrecognised envelope is not treated as failure');
  ok(odd.uncertain, 'but IS flagged uncertain rather than quietly assumed good');

  console.log('== judge() directly ==');
  eq(out.judge(200, '{"wasSuccess":true}').ok, true, 'wasSuccess true is success');
  eq(out.judge(200, '{"wasSuccess":false}').ok, false, 'wasSuccess false is failure');
  eq(out.judge(200, '{"wasSuccess":false}').permanent, true, 'and is permanent');
  eq(out.judge(401, '{"wasSuccess":true}').ok, false, 'a 401 is a failure whatever the body claims');
  eq(out.judge(200, '{"result":"success","jobid":"abc"}').ok, true, 'the add-call shape is understood');
  eq(out.judge(200, '{"result":"success","jobid":"abc"}').jobid, 'abc', 'and the job id is picked up');
  eq(out.judge(200, '{"result":"failed"}').ok, false, 'result:failed is a failure');

  console.log('== direct tech: the positional sValue array ==');
  okEnvelope();
  await go('enroute', { techID: 'sean', callUID: '2ba67338-1fa8-496f-8215-73c8dd617343', locID: '201002101605558713' });
  var dt = lastJson();
  eq(dt.Header, 104000, 'direct tech sends Header 104000, capital H as documented');
  eq(dt.sValue.length, 4, 'sValue has four positional entries');
  eq(dt.sValue[0], 'sean', 'position 0 is the technician');
  eq(dt.sValue[1], '2ba67338-1fa8-496f-8215-73c8dd617343', 'position 1 is the call UID');
  eq(dt.sValue[2], '201002101605558713', 'position 2 is the location id');
  eq(dt.sValue[3], '2', 'position 3 is the status, and enroute pins it to 2');

  await go('assign_call', { techID: 'sean', callUID: 'u', locID: '1' });
  eq(lastJson().sValue[3], '0', 'assign_call pins status 0 (dispatched)');
  await go('accept_call', { techID: 'sean', callUID: 'u', locID: '1' });
  eq(lastJson().sValue[3], '1', 'accept_call pins status 1');
  await go('onsite', { techID: 'sean', callUID: 'u', locID: '1' });
  eq(lastJson().sValue[3], '3', 'onsite pins status 3');

  console.log('== add call: its own URL, its own envelope ==');
  NEXT.body = '{"result":"success","jobid":"3dab55a7-2ae6-4101-98d6-e57c369388c7"}';
  var add = await go('add_call', {
    locID: '201002101605558713', serviceID: 1, address: '509 Test St', city: 'Lafayette',
    state: 'La', customerName: 'Test', quoted: 59.95
  });
  ok(add.ok, 'add_call succeeds on the documented response shape');
  eq(add.jobid, '3dab55a7-2ae6-4101-98d6-e57c369388c7', 'the returned job id is handed back to the caller');
  ok(last().url.indexOf('import') !== -1, 'add_call went to the IMPORT url, not the general api url');
  var body = lastJson();
  eq(body.requestType, 'NewJob', 'the documented requestType');
  eq(body.importType, 1, 'importType defaults to 1, standard dispatch to the live board');
  eq(body.sKey, SKEY, 'the sKey DID go in the body - this endpoint wants it there as well as in the header');
  eq(body.data.length, 1, 'the row is wrapped in the data array');
  eq(body.data[0].address, '509 Test St', 'caller fields pass through');
  eq(body.data[0].quoted, 59.95, 'and a real number stays a number');
  eq(body.data[0].pass_Back_Block, '', 'pass_Back_Block defaults to empty rather than being omitted');
  ok(Array.isArray(body.data[0].tags), 'tags defaults to an array');
  ok(String(DB.calls[DB.calls.length - 1].request_body).indexOf(SKEY) === -1, 'and the sKey in the BODY is still stripped before storage');

  var q = await go('add_call', { locID: '1', serviceID: 5, importType: 5 });
  eq(lastJson().importType, 5, 'importType 5 (save as quote) passes through');

  console.log('== gps: plain text, not JSON ==');
  NEXT.body = '{"wasSuccess":true,"gpsResults":[]}';
  await go('gps', { deviceIDs: ['705335589989673', '20230232077561'] });
  eq(last().headers['content-type'], 'text/plain', 'gps sends text/plain as documented');
  eq(last().body, '705335589989673,20230232077561', 'comma separated, no JSON, no spaces');
  ok(last().url.indexOf('gps') !== -1, 'and to the gps url');
  await go('gps', { deviceIDs: ' 1 , 2 ,, 3 ' });
  eq(last().body, '1,2,3', 'a messy comma string is cleaned up');

  console.log('== the guards ==');
  var unknown = await go('definitely_not_an_action', {});
  eq(unknown.blocked, 'unknown_action', 'an action outside the registry is refused');
  var before = SEEN.length;
  var missing = await go('enroute', { techID: 'sean' });
  eq(missing.blocked, 'missing_params', 'a missing required parameter is refused before sending');
  ok(missing.error.indexOf('callUID') !== -1, 'the refusal names what was missing');
  eq(SEEN.length, before, 'the refusals reached no network');

  process.env.PULSAR_IMPORT_URL = '';
  var noUrl = await out.call('add_call', { locID: '1', serviceID: 1 }, { force: true });
  eq(noUrl.blocked, 'bad_request', 'an endpoint with no provisioned URL is a clean refusal');
  ok(String(noUrl.error).indexOf('PULSAR_IMPORT_URL') !== -1, 'and names the variable to set');
  process.env.PULSAR_IMPORT_URL = API + '?import';

  console.log('== unverified actions are held back in live mode ==');
  // Everything except auth_test is unverified until somebody watches it work.
  var st0 = out.status();
  eq(st0.actions.filter(function (a) { return a.verified; }).length, 1, 'exactly one action ships verified: the harmless auth test');
  var seenBefore = SEEN.length;
  var held = await out.call('enroute', { techID: 't', callUID: 'u', locID: '1' }, {});
  eq(held.blocked, 'unverified', 'an unverified action is refused in live mode when not forced');
  ok(String(held.error).indexOf('draft') !== -1, 'and mentions that Pulsar documents it as a draft');
  eq(SEEN.length, seenBefore, 'the held call never reached the network');
  var allowed = await out.call('auth_test', {}, {});
  ok(allowed.ok, 'the verified action needs no force');

  console.log('== big ids ==');
  // The hazard Duty warned about, pinned down. A JavaScript number cannot hold
  // an 18-digit id, and the loss happens at PARSE time - before any code of
  // ours runs. There is nothing to fix downstream; the only safe move is to
  // refuse.
  eq(201002101610450898, 201002101610450900, 'proof: the digits are already gone the moment it is a number');
  var b4 = SEEN.length;
  await go('enroute', { techID: 't', callUID: 'u', locID: '201002101610450898' });
  ok(last().body.indexOf('201002101610450898') !== -1, 'an id passed as a STRING goes out with all 18 digits');
  ok(last().body.indexOf('201002101610450900') === -1, 'and is not rounded on the way');
  var numeric = await go('enroute', { techID: 't', callUID: 'u', locID: 201002101610450898 });
  eq(numeric.blocked, 'bad_request', 'the same id passed as a NUMBER is refused outright');
  ok(String(numeric.error).indexOf('as strings') !== -1, 'and the error tells you what to do instead');
  eq(SEEN.length, b4 + 1, 'the refused call never reached the API - no wrong record was addressed');
  eq(out.idOf('0'), null, 'idOf refuses the 0 sentinel, same as the inbound side');
  eq(out.idOf(' 123 '), '123', 'idOf trims');

  console.log('== failure handling ==');
  eq(out.retryable(500, null), true, 'a 500 is worth retrying');
  eq(out.retryable(429, null), true, 'a rate limit is worth retrying');
  eq(out.retryable(null, 'ECONNRESET'), true, 'a network error is worth retrying');
  eq(out.retryable(400, null), false, 'a 400 is not worth retrying');
  eq(out.retryable(401, null), false, 'an auth failure is not worth retrying');

  NEXT.status = 401; NEXT.body = 'no';
  var unauth = await go('auth_test', {});
  eq(unauth.status, 'dead', 'a 401 is dead on arrival - the credentials will not fix themselves');
  NEXT.status = 503; NEXT.body = 'busy';
  var soft = await go('auth_test', {});
  eq(soft.status, 'failed', 'a 503 is parked as failed');
  ok(soft.retrying, 'and the caller is told it will be retried');

  console.log('== the retry sweep ==');
  okEnvelope();
  var parked = DB.calls.filter(function (c) { return c.status === 'failed'; });
  eq(parked.length, 1, 'exactly one call is parked waiting to retry');
  parked[0].next_attempt_at = new Date(Date.now() - 1000);
  var swept = await out.runDue(10);
  eq(swept.claimed, 1, 'the sweep claimed the parked call');
  eq(swept.done, 1, 'and it succeeded on the retry');
  eq(DB.calls.filter(function (c) { return c.status === 'failed'; }).length, 0, 'nothing is left parked');

  console.log('== timeouts ==');
  process.env.PULSAR_TIMEOUT_MS = '150';
  delete require.cache[require.resolve('./utils/pulsarOut')];
  var out2 = require('./utils/pulsarOut');
  NEXT.delayMs = 600;
  var slow = await out2.call('auth_test', {}, { force: true });
  NEXT.delayMs = 0;
  ok(!slow.ok, 'a request that outlasts the timeout fails');
  ok(String(slow.error).indexOf('no response within') !== -1, 'and says so in words a human can act on: ' + slow.error);
  eq(slow.status, 'failed', 'a timeout is retryable, not fatal');

  console.log('== the audit trail ==');
  ok(AUDITS.length > 0, 'live sends are audited');
  ok(AUDITS.every(function (a) { return a.entity_type === 'pulsar_out'; }), 'audited under their own entity type');
  ok(AUDITS.every(function (a) { return JSON.stringify(a).indexOf(SKEY) === -1; }), 'no audit row contains the sKey');
  ok(AUDITS.every(function (a) { return JSON.stringify(a).indexOf(TOKEN) === -1; }), 'no audit row contains the token');

  console.log('== status screen ==');
  var st = out.status();
  eq(st.ready, true, 'status reports ready when both credentials are set');
  ok(JSON.stringify(st).indexOf(SKEY) === -1, 'the status payload does not leak the sKey');
  ok(JSON.stringify(st).indexOf(TOKEN) === -1, 'the status payload does not leak the token');
  ok(st.actions.filter(function (a) { return a.name === 'direct_tech'; })[0].draft, 'direct_tech is flagged as a draft endpoint on their side');
  process.env.PULSAR_SKEY = '';
  eq(out.status().ready, false, 'status reports not-ready with a credential missing');
  var nocreds = await go('auth_test', {});
  eq(nocreds.blocked, 'no_credentials', 'a missing credential is caught before anything is sent');
  process.env.PULSAR_SKEY = SKEY;

  console.log('\n' + PASS + '/' + (PASS + FAIL) + ' assertions passed' + (FAIL ? ('  (' + FAIL + ' FAILED)') : ''));
  fake.close();
  process.exit(FAIL ? 1 : 0);
}

fake.listen(0, '127.0.0.1', function () {
  API = 'http://127.0.0.1:' + fake.address().port + '/apiv2.ashx';
  run().catch(function (e) { console.error(e); process.exit(1); });
});
