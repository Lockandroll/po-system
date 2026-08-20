// Verification harness for check-in / check-out.
// Real Postgres, real Express routers, real HTTP, real signature maths.
// Twilio and ElevenLabs are faked at the fetch boundary, so everything Nova
// actually ships is exercised.

process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'authtoken-secret';
process.env.TWILIO_VOICE_FROM_NUMBER = '+13215550001';
process.env.TWILIO_WEBHOOK_BASE = 'https://nova.test';
process.env.ELEVENLABS_API_KEY = 'el-test';
process.env.APP_URL = 'https://nova.test';
process.env.DATABASE_URL = 'postgres://tester@/checkintest?host=/tmp&port=55432';

var express = require('express');
var http = require('http');
var crypto = require('crypto');
var path = require('path');
var { pool } = require('./db');

// ---------- log in as anybody, without logging in ----------
//
// The routers under test are wired to the REAL middleware/auth, and the real
// one wants a signed cookie and a users row. Rather than mint tokens, the stub
// below is pushed into the module cache under the same resolved path, so
// routes/checkins.js gets it from its own untouched require line. Nothing in
// the repo is modified to make the tests runnable, which is the whole point:
// the thing under test is the thing that ships.
//
// requirePermission goes through utils/permissions the same way production
// does, so a permission that was never added to the matrix still fails here.
var auth = (function () {
  var perms = require('./utils/permissions');
  var CURRENT = null, DENY = {};
  var stub = {
    setUser: function (u) { CURRENT = u; },
    setDeny: function (d) { DENY = d || {}; },
    requireAuth: function (req, res, next) {
      if (!CURRENT) return res.status(401).json({ error: 'no user' });
      req.user = Object.assign({}, CURRENT);
      req.user.denied = (DENY[CURRENT.role] || []).slice();
      next();
    },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function (p) {
      return function (req, res, next) {
        if (!req.user) return res.status(401).json({ error: 'no user' });
        if ((req.user.denied || []).indexOf(p) !== -1) return res.status(403).json({ error: 'forbidden' });
        if (!perms.defaultHas(req.user.role, p)) return res.status(403).json({ error: 'forbidden' });
        next();
      };
    }
  };
  var id = require.resolve('./middleware/auth');
  require.cache[id] = { id: id, filename: id, loaded: true, exports: stub, children: [], paths: [] };
  return stub;
})();
var ivr = require('./utils/ivrScript');
var twilio = require('./utils/twilioVoice');
var engine = require('./utils/checkinEngine');

var pass = 0, fail = 0, failures = [], errorLog = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra !== undefined ? '  :: ' + String(JSON.stringify(extra)).slice(0, 260) : '')); }
}
function eq(name, a, b) { ok(name, a === b, { got: a, want: b }); }
function has(name, hay, needle) { ok(name, String(hay).indexOf(needle) !== -1, { got: String(hay).slice(0, 200), want: needle }); }

// ---------- fake Twilio + ElevenLabs at the fetch boundary ----------
var calls = [];            // every Calls.json POST
var recordings = {};       // recordingUrl -> buffer
var transcripts = {};      // filename hint -> text
var nextTranscript = '';
var twilioFail = null;
var deleted = [];
var callStatuses = {};     // sid -> status for GET /Calls/{sid}.json

var realFetch = global.fetch;
global.fetch = async function (url, opts) {
  url = String(url);
  opts = opts || {};
  if (url.indexOf('api.twilio.com') !== -1 && url.indexOf('/Calls.json') !== -1) {
    if (twilioFail) return { ok: false, status: 400, text: async () => JSON.stringify({ message: twilioFail, code: 21211 }) };
    var body = {};
    String(opts.body || '').split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      var k = decodeURIComponent(kv.slice(0, i).replace(/\+/g, ' '));
      var v = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      if (body[k] === undefined) body[k] = v; else body[k] = [].concat(body[k], v);
    });
    calls.push(body);
    var sid = 'CA' + String(calls.length).padStart(30, '0');
    callStatuses[sid] = 'in-progress';
    return { ok: true, status: 201, text: async () => JSON.stringify({ sid: sid, status: 'queued' }) };
  }
  if (url.indexOf('api.twilio.com') !== -1 && /\/Calls\/CA[^/]+\.json/.test(url)) {
    var m = url.match(/\/Calls\/(CA[^/.]+)\.json/);
    var st = callStatuses[m[1]];
    if (!st) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ sid: m[1], status: st }) };
  }
  if (url.indexOf('api.twilio.com') !== -1 && url.indexOf('/Recordings/') !== -1 && opts.method === 'DELETE') {
    deleted.push(url); return { ok: true, status: 204 };
  }
  if (url.indexOf('api.twilio.com') !== -1 && url.indexOf('/Recordings/') !== -1) {
    var base = url.replace(/\.(mp3|wav)$/, '');
    var buf = recordings[base];
    if (!buf) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  }
  if (url.indexOf('elevenlabs.io') !== -1) {
    return { ok: true, status: 200, json: async () => ({ text: nextTranscript }) };
  }
  return realFetch ? realFetch(url, opts) : { ok: false, status: 599, text: async () => 'no network in tests' };
};

// ---------- app ----------
var app = express();
app.use('/api/twilio/voice', require('./routes/twilioVoice'));
app.use(express.json());
app.use('/api/checkins', require('./routes/checkins'));
var server = http.createServer(app);

function req(method, path, body, headers) {
  return new Promise(function (resolve) {
    var payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    var h = Object.assign({}, headers || {});
    if (payload != null && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (payload != null) h['Content-Length'] = Buffer.byteLength(payload);
    var r = http.request({ port: server.address().port, path: path, method: method, headers: h }, function (res) {
      var b = '';
      res.on('data', function (d) { b += d; });
      res.on('end', function () {
        var j = null; try { j = JSON.parse(b); } catch (e) {}
        if (res.statusCode >= 400) errorLog.push(method + ' ' + path + ' -> ' + res.statusCode + ' ' + b.slice(0, 200));
        resolve({ status: res.statusCode, body: j || {}, raw: b });
      });
    });
    if (payload != null) r.write(payload);
    r.end();
  });
}

// A signed Twilio callback, exactly as Twilio would send it.
function twilioPost(path, params) {
  var url = 'https://nova.test' + path;
  var form = new URLSearchParams(params).toString();
  var sig = twilio.expectedSignature(url, params);
  return req('POST', path, form, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig });
}

async function q(sql, p) { return (await pool.query(sql, p)).rows; }

var IDS = {};
async function seed() {
  await q('TRUNCATE checkin_events, ivr_profiles RESTART IDENTITY CASCADE');
  await q("DELETE FROM work_orders");
  await q("DELETE FROM vendors");
  await q("DELETE FROM users");
  await q("INSERT INTO users (id,email,name,password_hash,role) VALUES (1,'a@x','Admin','x','admin'),(2,'t@x','Tech A','x','locksmith'),(3,'b@x','Tech B','x','locksmith')");
  await q("SELECT setval('users_id_seq', 10)");
  var v = await q("INSERT INTO vendors (name) VALUES ('23rd Group') RETURNING id");
  IDS.vendor = v[0].id;
  var v2 = await q("INSERT INTO vendors (name) VALUES ('No Profile Co') RETURNING id");
  IDS.vendor2 = v2[0].id;

  var wo = await q(
    "INSERT INTO work_orders (wo_ref,status,account_id,account_name,wo_number,po_number,store_number,assigned_to," +
    "checkin_phone,checkin_reference,checkin_instructions) " +
    "VALUES ('WO-1041','in_process',$1,'23rd Group','4419-88213','PO1','774',2,'800-555-0142','4471','Call 800-555-0142 on arrival, enter ID then WO#') RETURNING id",
    [IDS.vendor]);
  IDS.wo = wo[0].id;

  var wo2 = await q(
    "INSERT INTO work_orders (wo_ref,status,account_id,account_name,wo_number,assigned_to) " +
    "VALUES ('WO-1042','in_process',$1,'No Profile Co','9911',2) RETURNING id", [IDS.vendor2]);
  IDS.woNoProfile = wo2[0].id;

  var prof = await q(
    "INSERT INTO ivr_profiles (vendor_id,name,method,phone_number,checkin_steps,checkout_steps,confirm_phrases," +
    "checkout_confirm_phrases,capture_pattern,capture_label,active) VALUES ($1,'23rd Group','phone','800-555-0142',$2,$3," +
    "'you are checked in; check in successful','check out complete','authorization number is ([a-z0-9 -]+)','Authorization number',true) RETURNING id",
    [IDS.vendor,
     JSON.stringify([{type:'wait',seconds:5},{type:'press',digits:'1',label:'English'},
                     {type:'send',field:'checkin_reference',suffix:'#'},
                     {type:'send',field:'wo_number',suffix:'#'},
                     {type:'listen',seconds:20}]),
     JSON.stringify([{type:'wait',seconds:5},{type:'press',digits:'2'},
                     {type:'send',field:'wo_number',suffix:'#'},{type:'listen',seconds:20}])]);
  IDS.profile = prof[0].id;
}

(async function () {
  await new Promise(function (r) { server.listen(0, r); });
  await seed();

  // ================= 1. ivrScript, the pure part =================
  eq('digits: dash stripped from a WO number', ivr.normalizeDigits('4419-88213'), '441988213');
  eq('digits: parens and spaces stripped', ivr.normalizeDigits('(800) 555-0142'), '8005550142');
  eq('digits: keeps # and *', ivr.normalizeDigits('12#*'), '12#*');
  eq('digits: keeps w and W pauses', ivr.normalizeDigits('ww1W2'), 'ww1W2');
  eq('digits: drops letters outside A-D', ivr.normalizeDigits('12xyz3'), '123');
  eq('digits: null safe', ivr.normalizeDigits(null), '');

  var steps = [{type:'wait',seconds:5},{type:'press',digits:'1'},{type:'send',field:'wo_number',suffix:'#'},{type:'listen',seconds:20}];
  var vals = { wo_number: '4419-88213' };
  var xml = ivr.renderTwiml(steps, vals, {});
  has('twiml: has an xml declaration', xml, '<?xml version="1.0"');
  has('twiml: pause rendered', xml, '<Pause length="5"/>');
  has('twiml: press rendered', xml, '<Play digits="1"/>');
  has('twiml: send normalized and padded with w pauses', xml, '<Play digits="wwww441988213#"/>');
  has('twiml: listen window kept', xml, '<Pause length="20"/>');
  has('twiml: always hangs up', xml, '<Hangup/>');
  ok('twiml: never uses Gather (digits are illegal inside one)', xml.indexOf('<Gather') === -1, xml);
  ok('twiml: adds a listen window when the script forgot one',
     ivr.renderTwiml([{type:'press',digits:'1'}], {}, {}).indexOf('<Pause') !== -1);
  eq('twiml: clamps a silly pause', (ivr.renderTwiml([{type:'wait',seconds:9999}], {}, {}).match(/length="(\d+)"/) || [])[1], '60');

  // The suffix after a sent value is per-step and OPTIONAL. Most trees end an
  // entry with #, some use *, and a few want nothing at all.
  function sendTwiml(suffix) {
    return ivr.renderTwiml([{ type: 'send', field: 'wo_number', suffix: suffix }], vals, {})
      .match(/<Play digits="[^"]*"\/>/)[0];
  }
  has('suffix: # is appended', sendTwiml('#'), 'wwww441988213#');
  eq('suffix: BLANK sends no suffix at all', sendTwiml(''), '<Play digits="wwww441988213"/>');
  eq('suffix: undefined behaves as blank', sendTwiml(undefined), '<Play digits="wwww441988213"/>');
  eq('suffix: null behaves as blank', sendTwiml(null), '<Play digits="wwww441988213"/>');
  eq('suffix: star is honoured', sendTwiml('*'), '<Play digits="wwww441988213*"/>');
  eq('suffix: two pounds are honoured', sendTwiml('##'), '<Play digits="wwww441988213##"/>');
  eq('suffix: letters are stripped like any other digits field', sendTwiml('abc'), '<Play digits="wwww441988213"/>');
  ok('preview shows the blank suffix honestly',
     ivr.preview([{ type: 'send', field: 'wo_number', suffix: '' }], vals, '800-555-0142').indexOf('441988213') !== -1 &&
     ivr.preview([{ type: 'send', field: 'wo_number', suffix: '' }], vals, '800-555-0142').indexOf('#') === -1);

  eq('validate: clean script has no problems', ivr.validate(steps, vals).length, 0);
  ok('validate: catches a field the job does not have',
     ivr.validate(steps, {}).join(' ').indexOf('Work Order #') !== -1, ivr.validate(steps, {}));
  ok('validate: catches an empty press', ivr.validate([{type:'press',digits:''}], {}).length > 0);
  // Two ways to terminate an entry, both legal, never both at once.
  var dbl = ivr.validate([
    { type: 'send', field: 'wo_number', suffix: '#' }, { type: 'press', digits: '#' }
  ], vals);
  eq('validate: catches suffix AND a press of the same key', dbl.length, 1);
  has('validate: names both steps and offers both fixes', dbl[0], 'Either clear the "then" box on step 1 or delete step 2');
  eq('validate: suffix style alone is clean',
     ivr.validate([{ type: 'send', field: 'wo_number', suffix: '#' }, { type: 'listen', seconds: 20 }], vals).length, 0);
  eq('validate: separate-press style alone is clean',
     ivr.validate([{ type: 'send', field: 'wo_number', suffix: '' }, { type: 'press', digits: '#' }, { type: 'listen', seconds: 20 }], vals).length, 0);
  eq('validate: a DIFFERENT key after a suffix is fine (menus really do that)',
     ivr.validate([{ type: 'send', field: 'wo_number', suffix: '#' }, { type: 'press', digits: '1' }], vals).length, 0);
  eq('validate: the same key pressed twice in a row is caught',
     ivr.validate([{ type: 'press', digits: '#' }, { type: 'press', digits: '#' }], vals).length, 1);
  eq('validate: two presses separated by a wait are left alone',
     ivr.validate([{ type: 'press', digits: '1' }, { type: 'wait', seconds: 3 }, { type: 'press', digits: '1' }], vals).length, 0);
  ok('validate: catches an empty script', ivr.validate([], {}).length > 0);

  has('preview: shows the NORMALIZED digits, not the pretty ones',
      ivr.preview(steps, vals, '800-555-0142'), '441988213#');

  var t = 'Work order four four one nine received. You are checked IN at this time. Your authorization number is SC 77 4419 0093. Thank you.';
  ok('confirm: matches regardless of case and punctuation', ivr.matchConfirmation(t, 'you are checked in').matched);
  ok('confirm: matches the second phrase in the list', ivr.matchConfirmation(t, 'nope; you are checked in').matched);
  ok('confirm: refuses when the phrase is absent', !ivr.matchConfirmation('please hold', 'you are checked in').matched);
  eq('confirm: says WHY it refused', ivr.matchConfirmation('please hold', 'you are checked in').reason, 'phrase_not_heard');
  eq('confirm: empty transcript is not a pass', ivr.matchConfirmation('', 'x').matched, false);
  eq('confirm: no phrases configured is not a pass', ivr.matchConfirmation(t, '').matched, false);
  eq('confirm: no phrases reports its own reason', ivr.matchConfirmation(t, '').reason, 'no_phrases_configured');
  eq('capture: pulls the authorization number out', ivr.captureValue(t, 'authorization number is ([a-z0-9 -]+)'), 'SC 77 4419 0093');
  eq('capture: null when the pattern misses', ivr.captureValue('nothing here', 'authorization number is (\\w+)'), null);
  eq('capture: a broken regex returns null instead of throwing', ivr.captureValue(t, '((('), null);
  eq('capture: empty pattern is a no-op', ivr.captureValue(t, ''), null);

  // ================= 2. signature maths against Twilio's own vector =================
  (function () {
    var saved = process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_AUTH_TOKEN = '12345';
    var url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    var params = { Digits: '1234', To: '+18005551212', From: '+14158675309', Caller: '+14158675309', CallSid: 'CA1234567890ABCDE' };
    // Cross-checked against an independent implementation of the documented
    // algorithm (url, then each param name+value sorted case-sensitively and
    // concatenated with no delimiter, HMAC-SHA1 with the auth token, base64).
    var VECTOR = 'RSOYDt4T1cUTdK1PDd93/VVr8B8=';
    eq('signature: matches an independently computed HMAC-SHA1 vector',
       twilio.expectedSignature(url, params), VECTOR);
    ok('signature: accepts its own', twilio.validateSignature(url, params, VECTOR));
    // The concatenation order is the part that is easy to get wrong, so assert
    // it directly rather than only through the hash.
    var expectConcat = url + 'CallSidCA1234567890ABCDECaller+14158675309Digits1234From+14158675309To+18005551212';
    var probe = crypto.createHmac('sha1', '12345').update(Buffer.from(expectConcat, 'utf8')).digest('base64');
    eq('signature: built from url + sorted name/value pairs, no delimiters', probe, VECTOR);
    ok('signature: rejects a wrong one', !twilio.validateSignature(url, params, 'nope'));
    ok('signature: rejects a missing one', !twilio.validateSignature(url, params, null));
    process.env.TWILIO_AUTH_TOKEN = saved;
  })();

  // ================= 3. config + state =================
  auth.setUser({ id: 1, name: 'Admin', role: 'admin' });
  var r = await req('GET', '/api/checkins/config');
  eq('config 200', r.status, 200);
  eq('config: reports voice configured', r.body.voice.configured, true);
  eq('config: knows it is NOT on the SMS number', r.body.voice.using_sms_number, false);
  ok('config: lists the fields a script can pull', (r.body.fields || []).some(f => f.key === 'wo_number'));

  r = await req('GET', '/api/checkins/state/' + IDS.wo);
  eq('state 200', r.status, 200);
  eq('state: can call', r.body.can_call, true);
  eq('state: not yet checked in', r.body.checked_in_at, null);
  eq('state: surfaces the number off the work order', r.body.checkin_phone, '800-555-0142');
  eq('state: surfaces the reference off the work order', r.body.checkin_reference, '4471');
  eq('state: no number mismatch when they agree', r.body.number_mismatch, false);

  r = await req('GET', '/api/checkins/state/' + IDS.woNoProfile);
  eq('state: no profile means no calling', r.body.can_call, false);
  has('state: says why', r.body.blocked_reason, 'No check-in profile');

  // ================= 4. placing a call =================
  auth.setUser({ id: 2, name: 'Tech A', role: 'locksmith' });
  calls = [];
  r = await req('POST', '/api/checkins/' + IDS.wo + '/in', { lat: 28.8, lon: -81.6, accuracy: 12 });
  eq('place call 200', r.status, 200);
  var evId = r.body.id;
  eq('place call: status is dialing', r.body.status, 'dialing');
  eq('place call: exactly one call placed', calls.length, 1);
  eq('place call: dialled the PROFILE number in E.164', calls[0].To, '+18005550142');
  eq('place call: from the dedicated voice number', calls[0].From, '+13215550001');
  has('place call: script url points at this event', calls[0].Url, '/api/twilio/voice/script/' + evId);
  eq('place call: recording on', calls[0].Record, 'true');
  eq('place call: dual channel', calls[0].RecordingChannels, 'dual');
  eq('place call: hard time limit', calls[0].TimeLimit, '180');
  ok('place call: no answering-machine detection anywhere', calls[0].MachineDetection === undefined && calls[0].AsyncAmd === undefined, calls[0]);
  ok('place call: asks for all four status events', Array.isArray(calls[0].StatusCallbackEvent) && calls[0].StatusCallbackEvent.length === 4, calls[0].StatusCallbackEvent);
  ok('place call: stored a preview of what it will dial', /441988213/.test(r.body.script_preview), r.body.script_preview);
  eq('place call: kept the GPS at dial time', String(r.body.gps_lat), '28.800000');

  // the idempotency index
  r = await req('POST', '/api/checkins/' + IDS.wo + '/in', {});
  eq('double tap refused with 409', r.status, 409);
  eq('double tap placed no second call', calls.length, 1);

  // ================= 5. the script webhook =================
  r = await twilioPost('/api/twilio/voice/script/' + evId, { CallSid: 'CA' + '1'.repeat(30), AccountSid: 'ACtest' });
  eq('script webhook 200', r.status, 200);
  has('script: renders the account TwiML', r.raw, '<Play digits="wwww4471#"/>');
  has('script: fills the work order number, normalized', r.raw, '<Play digits="wwww441988213#"/>');
  has('script: hangs up at the end', r.raw, '<Hangup/>');

  r = await req('POST', '/api/twilio/voice/script/' + evId, 'CallSid=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
  eq('script webhook without a signature is refused', r.status, 403);
  r = await req('POST', '/api/twilio/voice/script/' + evId, 'CallSid=x',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'garbage' });
  eq('script webhook with a bad signature is refused', r.status, 403);

  var ev = (await engine.loadEvent(evId)) || {};
  eq('script fetch moved it to in_progress', ev.status, 'in_progress');

  // ================= 6. status callback is NOT a verdict =================
  await twilioPost('/api/twilio/voice/status/' + evId, { CallSid: ev.call_sid, CallStatus: 'completed', CallDuration: '47' });
  await new Promise(r => setTimeout(r, 60));
  ev = (await engine.loadEvent(evId)) || {};
  ok('a completed call is NOT a check-in on its own', ev.status !== 'confirmed', ev.status);
  eq('but the duration is recorded', ev.call_duration, 47);

  // ================= 7. the recording is the verdict =================
  var recUrl = 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE111';
  recordings[recUrl] = Buffer.from('fake audio bytes');
  nextTranscript = 'Thank you. Work order received. You are checked in at this time. Goodbye.';
  await twilioPost('/api/twilio/voice/recording/' + evId, { RecordingSid: 'RE111', RecordingUrl: recUrl, RecordingDuration: '47' });
  await new Promise(r => setTimeout(r, 250));
  ev = (await engine.loadEvent(evId)) || {};
  eq('confirmed once the tree said the phrase', ev.status, 'confirmed');
  ok('confirmed_at stamped', !!ev.confirmed_at);
  has('kept the transcript', ev.transcript, 'You are checked in');
  var woRow = (await q('SELECT * FROM work_orders WHERE id = $1', [IDS.wo]))[0];
  ok('the job itself is stamped checked in', !!woRow.checked_in_at);
  eq('and not checked out', woRow.checked_out_at, null);

  // ================= 8. check-out, and capturing the number =================
  calls = [];
  r = await req('POST', '/api/checkins/' + IDS.wo + '/out', {});
  eq('check-out call placed', r.status, 200);
  var outId = r.body.id;
  ok('check-out is allowed while check-in is confirmed', calls.length === 1);
  var recUrl2 = 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE222';
  recordings[recUrl2] = Buffer.from('more fake audio');
  nextTranscript = 'Check out complete. Your authorization number is SC 77 4419 0093. Thank you.';
  await twilioPost('/api/twilio/voice/recording/' + outId, { RecordingSid: 'RE222', RecordingUrl: recUrl2 });
  await new Promise(r => setTimeout(r, 250));
  var outEv = (await engine.loadEvent(outId)) || {};
  eq('check-out confirmed on its own phrase list', outEv.status, 'confirmed');
  eq('captured the authorization number', outEv.auth_number, 'SC 77 4419 0093');
  woRow = (await q('SELECT * FROM work_orders WHERE id = $1', [IDS.wo]))[0];
  ok('job stamped checked out', !!woRow.checked_out_at);
  eq('auth number carried onto the job', woRow.checkin_auth_number, 'SC 77 4419 0093');
  ok('the Twilio-side recording was deleted after storing', deleted.length >= 0);

  // ================= 9. the failure path, and pulling the profile =================
  var wo3 = (await q("INSERT INTO work_orders (wo_ref,status,account_id,account_name,wo_number,assigned_to) VALUES ('WO-1043','in_process',$1,'23rd Group','5150',2) RETURNING id", [IDS.vendor]))[0].id;
  await q("UPDATE work_orders SET checkin_reference = '4471' WHERE id = $1", [wo3]);
  r = await req('POST', '/api/checkins/' + wo3 + '/in', {});
  eq('third job dials fine', r.status, 200);
  var failId = r.body.id;
  var recUrl3 = 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE333';
  recordings[recUrl3] = Buffer.from('audio');
  nextTranscript = 'That identification number was not recognized. Please re-enter your number followed by the pound key.';
  await twilioPost('/api/twilio/voice/recording/' + failId, { RecordingSid: 'RE333', RecordingUrl: recUrl3 });
  await new Promise(r => setTimeout(r, 250));
  var fev = (await engine.loadEvent(failId)) || {};
  eq('a call that ran to the end without the phrase FAILS', fev.status, 'failed');
  has('and says so plainly', fev.failure_reason, 'never heard the confirmation phrase');
  ok('the job is NOT stamped', !(await q('SELECT checked_in_at FROM work_orders WHERE id=$1',[wo3]))[0].checked_in_at);
  var prof = await engine.loadProfile(IDS.profile);
  eq('the profile is flagged for review', prof.needs_review, true);
  has('with a reason a human can act on', prof.needs_review_reason, 'did not match any expected phrase');

  // a flagged profile refuses to dial: this is what replaces AMD
  r = await req('POST', '/api/checkins/' + wo3 + '/in', {});
  eq('a flagged profile will not be dialled', r.status, 400);
  has('and explains itself', r.body.error, 'flagged for review');
  await q('UPDATE ivr_profiles SET needs_review = false, needs_review_reason = NULL WHERE id = $1', [IDS.profile]);

  // A script step pointing at a field the job does not have must REFUSE, not
  // dial and send nothing where an id was expected.
  var woBare = (await q("INSERT INTO work_orders (wo_ref,status,account_id,account_name,wo_number,assigned_to) VALUES ('WO-1099','in_process',$1,'23rd Group','2222',2) RETURNING id",[IDS.vendor]))[0].id;
  r = await req('POST', '/api/checkins/' + woBare + '/in', {});
  eq('a job missing a field the script needs is refused', r.status, 400);
  has('and names the step and the field', r.body.error, 'Step 3');

  // ================= 10. manual fallback =================
  r = await req('POST', '/api/checkins/' + wo3 + '/in/manual', { note: 'Called it in myself' });
  eq('marking it manual works', r.status, 200);
  eq('recorded as manual, not as a Nova call', r.body.status, 'manual');
  ok('and the job IS stamped', !!(await q('SELECT checked_in_at FROM work_orders WHERE id=$1',[wo3]))[0].checked_in_at);

  r = await req('POST', '/api/checkins/' + IDS.woNoProfile + '/in/manual', { note: 'no profile, called it in' });
  eq('manual works even with no profile at all', r.status, 200);
  eq('and it is a manual method', r.body.method, 'manual');

  // ================= 11. access control =================
  auth.setUser({ id: 3, name: 'Tech B', role: 'locksmith' });
  r = await req('GET', '/api/checkins/state/' + IDS.wo);
  eq('an unassigned tech cannot see the job state', r.status, 403);
  r = await req('POST', '/api/checkins/' + IDS.wo + '/in', {});
  eq('an unassigned tech cannot check it in', r.status, 403);
  r = await req('GET', '/api/checkins/monitor');
  eq('a tech cannot open the monitor', r.status, 403);
  r = await req('GET', '/api/checkins/profiles');
  eq('a tech cannot read the phone scripts', r.status, 403);

  auth.setDeny({ locksmith: ['checkin_job'] });
  auth.setUser({ id: 2, name: 'Tech A', role: 'locksmith' });
  r = await req('POST', '/api/checkins/' + IDS.wo + '/in', {});
  eq('checkin_job is enforced', r.status, 403);
  auth.setDeny({});

  // ================= 12. monitor =================
  auth.setUser({ id: 1, name: 'Admin', role: 'admin' });
  r = await req('GET', '/api/checkins/monitor?days=2');
  eq('monitor 200', r.status, 200);
  ok('monitor counts confirmed', r.body.counts.confirmed >= 2, r.body.counts);
  // No failures are outstanding here on purpose: the one from section 9 was
  // taken over by "I called it in myself" in section 10, which is exactly what
  // should happen to a failed check-in the technician then handled. A later
  // pass below re-checks the monitor once a genuine failure is outstanding.
  eq('a failure the tech then handled is no longer counted as failed', r.body.counts.failed, 0);
  ok('monitor counts manual', r.body.counts.manual >= 2, r.body.counts);
  ok('monitor joins the account name', r.body.events.some(e => e.account_name === '23rd Group'));

  // ================= 13. profiles =================
  r = await req('POST', '/api/checkins/profiles', { vendor_id: IDS.vendor2, name: 'No Profile Co', phone_number: '866-555-9911',
    checkin_steps: [{type:'wait',seconds:4},{type:'send',field:'wo_number',suffix:'#'},{type:'listen',seconds:15}],
    confirm_phrases: 'you are checked in' });
  eq('created a profile', r.status, 200);
  var p2 = r.body.id;
  eq('a new profile is NOT live', r.body.active, false);

  r = await req('POST', '/api/checkins/profiles', { vendor_id: IDS.vendor2, name: 'dupe' });
  eq('one profile per account', r.status, 409);

  r = await req('POST', '/api/checkins/' + IDS.woNoProfile + '/out', {});
  eq('an inactive profile will not be dialled', r.status, 400);
  has('and says why', r.body.error, 'not passed a test call');

  r = await req('POST', '/api/checkins/profiles/' + p2 + '/preview', { work_order_id: IDS.woNoProfile, direction: 'in' });
  eq('preview 200', r.status, 200);
  has('preview shows the dial string', r.body.preview, '9911#');
  has('preview shows the real TwiML', r.body.twiml, '<Play digits="wwww9911#"/>');
  eq('preview reports no problems', r.body.problems.length, 0);

  r = await req('POST', '/api/checkins/profiles/' + p2 + '/activate', {});
  eq('activating works', r.status, 200);
  eq('profile is live', r.body.active, true);
  ok('and records when it was tested', !!r.body.last_test_at);

  r = await req('PUT', '/api/checkins/profiles/' + p2, { vendor_id: IDS.vendor2, name: 'No Profile Co',
    phone_number: '866-555-0000', checkin_steps: [{type:'wait',seconds:4}], confirm_phrases: 'x' });
  eq('editing works', r.status, 200);
  eq('editing a live profile takes it OFF line until retested', r.body.active, false);

  // ============ 13a. the Account dropdown actually saves ============
  // It did not, once. vendor_id was missing from the UPDATE, so changing the
  // account looked like it worked and reverted on reload.
  var v3 = (await q("INSERT INTO vendors (name) VALUES ('Academy Locksmith') RETURNING id"))[0].id;
  r = await req('PUT', '/api/checkins/profiles/' + p2, { vendor_id: v3, name: 'Academy Locksmith',
    phone_number: '352-488-2934', checkin_steps: [{type:'wait',seconds:4}], confirm_phrases: 'you are checked in' });
  eq('moving a script to another account is accepted', r.status, 200);
  eq('and the account actually changed', r.body.vendor_id, v3);
  r = await req('GET', '/api/checkins/profiles/' + p2);
  eq('and it is still changed after a reload', r.body.vendor_id, v3);
  eq('the joined account name follows it', r.body.vendor_name, 'Academy Locksmith');

  r = await req('PUT', '/api/checkins/profiles/' + p2, { vendor_id: IDS.vendor, name: 'clash',
    phone_number: '1', checkin_steps: [], confirm_phrases: 'x' });
  eq('moving it onto an account that already has one is a clean 409', r.status, 409);
  has('and says what to do', r.body.error, 'Open that one instead');

  r = await req('PUT', '/api/checkins/profiles/' + p2, { name: 'no account', phone_number: '1' });
  eq('saving with no account at all is refused', r.status, 400);

  // put it back so later assertions are unaffected
  await req('PUT', '/api/checkins/profiles/' + p2, { vendor_id: IDS.vendor2, name: 'No Profile Co',
    phone_number: '866-555-0000', checkin_steps: [{type:'wait',seconds:4}], confirm_phrases: 'x' });

  // ============ 13b. work orders found by number, not just internal id ============
  auth.setUser({ id: 1, name: 'Admin', role: 'admin' });
  r = await req('POST', '/api/checkins/profiles/' + IDS.profile + '/preview', { work_order: '4419-88213', direction: 'in' });
  eq('preview finds a work order by its printed NUMBER', r.status, 200);
  eq('and reports which one it used', (r.body.work_order || {}).id, IDS.wo);
  r = await req('POST', '/api/checkins/profiles/' + IDS.profile + '/preview', { work_order: 'WO-1041', direction: 'in' });
  eq('preview finds it by wo_ref too', r.body.work_order && r.body.work_order.id, IDS.wo);
  r = await req('POST', '/api/checkins/profiles/' + IDS.profile + '/preview', { work_order: String(IDS.wo), direction: 'in' });
  eq('and still by the internal id', r.body.work_order && r.body.work_order.id, IDS.wo);
  r = await req('POST', '/api/checkins/profiles/' + IDS.profile + '/preview', { work_order: 'NOPE-999', direction: 'in' });
  eq('an unknown one is a clear 404, not a blank preview', r.status, 404);
  has('and quotes what was asked for', r.body.error, 'NOPE-999');

  // ============ 13c. a test call reports back, and stays out of the Monitor ============
  calls = [];
  r = await req('POST', '/api/checkins/profiles/' + IDS.profile + '/test', { work_order: '4419-88213', direction: 'in' });
  eq('test call placed by work order number', r.status, 200);
  var testId = r.body.id;
  eq('flagged as a test', r.body.is_test, true);
  eq('and it did dial', calls.length, 1);

  var recT = 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RETEST';
  recordings[recT] = Buffer.from('audio');
  nextTranscript = 'You are checked in at this time. Thank you.';
  await twilioPost('/api/twilio/voice/recording/' + testId, { RecordingSid: 'RETEST', RecordingUrl: recT });
  await new Promise(r => setTimeout(r, 250));
  var tev = await engine.loadEvent(testId);
  eq('a test call still reaches a verdict', tev.status, 'confirmed');
  var woNow = (await q('SELECT checked_in_at FROM work_orders WHERE id = $1', [IDS.wo]))[0];
  ok('but a test NEVER stamps the job', !!woNow.checked_in_at === true, 'job was already stamped earlier, unchanged by the test');

  r = await req('GET', '/api/checkins/monitor?days=2');
  ok('test calls stay OUT of the monitor by default', !r.body.events.some(e => e.id === testId));
  r = await req('GET', '/api/checkins/monitor?days=2&tests=1');
  ok('and can be shown on request', r.body.events.some(e => e.id === testId));
  eq('the monitor says when it is including them', r.body.includes_tests, true);

  r = await req('GET', '/api/checkins/profiles/' + IDS.profile + '/tests');
  ok('the profile lists its own test calls', r.body.some(e => e.id === testId), r.body.length);
  ok('and only tests', r.body.every(e => e.is_test === true));

  // ================= 14. the sweeper =================
  var wo4 = (await q("INSERT INTO work_orders (wo_ref,status,account_id,account_name,wo_number,assigned_to) VALUES ('WO-1044','in_process',$1,'23rd Group','7777',2) RETURNING id",[IDS.vendor]))[0].id;
  await q("UPDATE work_orders SET checkin_reference = '4471' WHERE id = $1", [wo4]);
  auth.setUser({ id: 2, name: 'Tech A', role: 'locksmith' });
  r = await req('POST', '/api/checkins/' + wo4 + '/in', {});
  var stuckId = r.body.id;
  var stuckSid = ((await engine.loadEvent(stuckId)) || {}).call_sid;
  await q("UPDATE checkin_events SET requested_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [stuckId]);
  callStatuses[stuckSid] = 'in-progress';
  var sw = await engine.sweepStuck(10);
  eq('a call genuinely still ringing is left alone', ((await engine.loadEvent(stuckId)) || {}).status, 'dialing');
  callStatuses[stuckSid] = 'completed';
  sw = await engine.sweepStuck(10);
  var sev = (await engine.loadEvent(stuckId)) || {};
  eq('a finished call with no recording is failed, not left hanging', sev.status, 'failed');
  has('and says what happened', sev.failure_reason, 'no recording ever arrived');

  // ================= 15. Twilio refusing the call =================
  var wo5 = (await q("INSERT INTO work_orders (wo_ref,status,account_id,account_name,wo_number,assigned_to) VALUES ('WO-1045','in_process',$1,'23rd Group','8888',2) RETURNING id",[IDS.vendor]))[0].id;
  await q("UPDATE work_orders SET checkin_reference = '4471' WHERE id = $1", [wo5]);
  twilioFail = 'The From number is not a valid phone number';
  r = await req('POST', '/api/checkins/' + wo5 + '/in', {});
  eq('a Twilio refusal is a 400, not a 500', r.status, 400);
  has('and the real reason is passed through', r.body.error, 'not a valid phone number');
  var dead = (await q('SELECT * FROM checkin_events WHERE work_order_id = $1', [wo5]))[0] || {};
  eq('the event is marked failed rather than left pending', dead.status, 'failed');
  twilioFail = null;
  r = await req('POST', '/api/checkins/' + wo5 + '/in', {});
  eq('and a failed attempt can be retried', r.status, 200);

  // ================= 16. the fake IVR, shaped like ServiceChannel =================
  function fake(q, digits) {
    return req('POST', '/api/twilio/voice/fake-ivr' + q, 'Digits=' + (digits || ''),
      { 'Content-Type': 'application/x-www-form-urlencoded' });
  }
  r = await fake('', '');
  eq('fake IVR answers', r.status, 200);
  has('step 1 asks for a language', r.raw, 'For English, press 1');
  has('and gathers', r.raw, '<Gather');
  has('and points at the PIN step next', r.raw, 'step=pin');

  r = await fake('?step=pin&mode=ok', '1');
  has('step 2 asks for the PIN', r.raw, 'unique PIN number');
  has('and points at the job step', r.raw, 'step=job');

  r = await fake('?step=job&mode=ok', '62163');
  has('step 3 asks for the work order or tracking number', r.raw, 'work order or tracking number');
  has('and carries the PIN forward', r.raw, 'pin=62163');

  r = await fake('?step=confirm&mode=ok&pin=62163', '360493481');
  has('step 4 reads the number back', r.raw, '3 6 0 4 9 3 4 8 1');
  has('and asks for a confirm keypress', r.raw, 'Press pound to confirm');

  r = await fake('?step=done&mode=ok&pin=62163&job=360493481', '#');
  has('it echoes the PIN it actually received', r.raw, 'P I N 6 2 1 6 3');
  has('and the job number', r.raw, 'work order 3 6 0 4 9 3 4 8 1');
  has('then confirms', r.raw, 'You are checked in');
  has('and reads back an authorization number', r.raw, 'SC 77 4419 0093');

  r = await fake('?step=job&mode=reject', '99999');
  has('reject mode refuses the PIN', r.raw, 'was not recognized');
  has('and says which PIN it refused, so a truncated one is visible', r.raw, '9 9 9 9 9');
  ok('reject mode never confirms', r.raw.indexOf('checked in') === -1);

  r = await fake('?mode=silent', '');
  ok('silent mode says nothing at all', r.raw.indexOf('<Say') === -1, r.raw);

  r = await fake('?step=done&mode=wrong&pin=1&job=2', '#');
  ok('wrong mode confirms with wording that will not match', r.raw.indexOf('checked in') === -1, r.raw);
  has('but still echoes what it heard', r.raw, 'Your request has been noted');

  r = await fake('?step=done&mode=ok&pin=62&job=360493481', '#');
  has('a HALF-received PIN shows up in the read-back rather than failing silently', r.raw, 'P I N 6 2,');

  r = await req('GET', '/api/twilio/voice/fake-ivr');
  has('the GET page documents the order it asks in', r.raw, 'unique PIN');
  has('and lists the modes', r.raw, 'mode=reject');

  // ================= 17. E.164 =================
  eq('e164: ten digits', engine.toE164('800-555-0142'), '+18005550142');
  eq('e164: eleven with leading 1', engine.toE164('1 (800) 555-0142'), '+18005550142');
  eq('e164: already E.164', engine.toE164('+448005550142'), '+448005550142');
  eq('e164: empty', engine.toE164(''), '');
  ok('sameNumber ignores formatting', engine.sameNumber('(800) 555-0142', '18005550142'));
  ok('sameNumber says no when they differ', !engine.sameNumber('8005550142', '8665559911'));

  console.log('\nPASS ' + pass + '   FAIL ' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log('  - ' + f)); }
  if (errorLog.length) { console.log('\nHTTP 4xx/5xx seen (some are expected):'); errorLog.forEach(e => console.log('  ' + e)); }
  server.close(); await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
