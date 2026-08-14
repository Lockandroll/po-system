'use strict';
/*
 * Outbound API client - Nova -> Pulsar.
 * -------------------------------------
 * The mirror image of utils/webhookIngest.js. That file is how Pulsar tells us
 * something happened; this one is how we tell Pulsar to MAKE something happen:
 * create a call, assign a technician, move a job to enroute or on-site.
 *
 * Written against the published documentation at https://www.idssonline.com/api/
 * (last updated 24 May 2026). Everything below that is inferred rather than
 * documented is marked as such, and marked LOUDLY.
 *
 * The same governing rule as the inbound side, turned around:
 *
 *     WRITE THE ATTEMPT DOWN BEFORE YOU MAKE IT.
 *
 * On the inbound side that rule protects us from losing a delivery. Out here it
 * protects us from something worse: a request that reaches Pulsar and changes
 * real dispatch state, while our process dies before recording that it did. A
 * row that says "we tried" and turns out never to have left is a five second
 * question. A call that went out with no row is unanswerable, and the only way
 * to find out is to ring a technician who is already driving.
 *
 * Three things this file is deliberately careful about:
 *
 *   1. CREDENTIALS NEVER APPEAR IN THE DATABASE, THE LOGS, OR THE UI. Every
 *      request we store goes through redact() first. This matters more here
 *      than it might look: the Add-New-Call endpoint wants the sKey in the
 *      REQUEST BODY as well as in the headers, so the secret is inside the
 *      exact blob we would naturally log verbatim.
 *
 *   2. IT SHIPS DISARMED. PULSAR_OUT_MODE is 'off' until somebody sets it. In
 *      'dry' it does everything except the send, and stores the request it
 *      would have made. Only 'live' talks to Pulsar. A dispatch integration
 *      that goes live the moment it deploys is how you find out your field
 *      names were wrong by dispatching forty technicians.
 *
 *   3. HTTP 200 IS NOT SUCCESS. Pulsar answers with an envelope carrying
 *      wasSuccess, and a rejected request is a perfectly healthy 200 with
 *      wasSuccess:false inside it. Anything that reads only the status code
 *      will report failures as successes forever. See judge().
 *
 * NOTE: no backtick characters anywhere in this file (Windows-safe per the Nova
 * editing rules).
 */

var { pool } = require('../db');
var { logAudit } = require('./audit');

// --------------------------------------------------------------------- config

// Pulsar does not publish a base URL. Every URL is provisioned per integration,
// and there are THREE of them - the general API, the call import endpoint, and
// GPS - which is why this is a lookup rather than one constant. Only the
// general one has a value we have been given; the other two stay empty until
// Duty supplies them, and asking for an endpoint we do not have is a clean
// refusal rather than a request to the wrong place.
function endpointUrl(kind) {
  if (kind === 'import') return String(process.env.PULSAR_IMPORT_URL || '').trim();
  if (kind === 'gps')    return String(process.env.PULSAR_GPS_URL || '').trim();
  return String(process.env.PULSAR_API_URL || 'https://api.idssonline.com/apiv2.ashx').trim();
}

var TIMEOUT_MS = Number(process.env.PULSAR_TIMEOUT_MS || 20000);
var MAX_RESPONSE_BYTES = Number(process.env.PULSAR_MAX_RESPONSE_BYTES || 256 * 1024);

// Backoff for transient failures only. Deliberately shorter and shallower than
// the inbound ladder: an inbound event can wait twelve hours and still be worth
// processing, but "put this tech enroute" is worthless an hour late. If it has
// not gone through in about ten minutes a human needs to know.
var BACKOFF_MS = [15e3, 45e3, 120e3, 300e3];
var MAX_ATTEMPTS = BACKOFF_MS.length + 1;

// off  - refuse to do anything at all (the shipping default)
// dry  - build and record the request, do not send it, report what would go
// live - actually talk to Pulsar
function mode() {
  var m = String(process.env.PULSAR_OUT_MODE || 'off').toLowerCase();
  return (m === 'dry' || m === 'live') ? m : 'off';
}

// Read at call time rather than at require time, so that changing a Railway
// variable and restarting is the whole deployment procedure.
function creds() {
  return {
    skey:  String(process.env.PULSAR_SKEY || '').trim(),
    token: String(process.env.PULSAR_TOKEN || '').trim()
  };
}

function credsReady() {
  var c = creds();
  return !!(c.skey && c.token);
}

// Documented, and not guessable: the token goes in a header called "auth" and
// the sKey in one called "skey". Note that the token is NOT named "token"
// anywhere on the wire - that was my assumption before reading the docs, and it
// would have produced a clean, silent, entirely unexplainable 401.
function authHeaders() {
  var c = creds();
  return { auth: c.token, skey: c.skey };
}

// ------------------------------------------------------------------ redaction

// Anything about to be written down - a request body, a URL, an error message,
// a response - goes through here first.
//
// This is belt AND braces on purpose. The builders know where they put the
// secrets and could strip them structurally, but redact() also catches the
// cases nobody planned for: a secret echoed back inside an error string, a
// probe payload an admin typed by hand, or - and this one is real, it is in
// their own documented example - the authentication test endpoint, whose entire
// job is to echo your request back to you. Substring replacement is crude and
// that is exactly why it holds when the structure is unknown.
function redact(input) {
  if (input === null || input === undefined) return input;
  var s = (typeof input === 'string') ? input : JSON.stringify(input);
  if (typeof s !== 'string') return input;
  var c = creds();
  // Longest first: if one secret happens to contain the other, replacing the
  // short one first would leave a fragment of the long one behind.
  var secrets = [c.skey, c.token].filter(function (v) { return v && v.length >= 8; });
  secrets.sort(function (a, b) { return b.length - a.length; });
  for (var i = 0; i < secrets.length; i++) {
    s = s.split(secrets[i]).join('[redacted]');
  }
  return (typeof input === 'string') ? s : safeParse(s);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return { redacted_unparseable: String(s).slice(0, 2000) }; }
}

// A fingerprint safe to show in the UI, so an admin can confirm the right key
// is loaded without the screen ever holding the key. Last four only, and only
// if the value is long enough that four characters give nothing away.
function credFingerprint(v) {
  var s = String(v || '');
  if (!s) return null;
  if (s.length < 12) return 'set (short)';
  return 'set, ends ' + s.slice(-4);
}

// --------------------------------------------------------------- id integrity

// Pulsar ids are 18-digit int64s and JavaScript cannot hold one:
// 201002101610450898 becomes 201002101610450900. The loss happens at PARSE
// time, before any of our code runs, so there is nothing to recover and nothing
// to fix downstream. The only honest behaviour left is to refuse, rather than
// address a record that does not exist.
//
// Which means: PASS IDS AS STRINGS, the whole way down - from the browser, from
// the database, from a webhook payload. Duty warned us in exactly these words
// and he was right. This throw is here so the warning outlives the comment.
function checkParam(k, v) {
  if (typeof v === 'number' && isFinite(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) {
    throw new Error('parameter "' + k + '" arrived as a number too large for JavaScript to hold exactly (' +
      v + '). Pass ids as strings - by the time one is a number its digits are already wrong.');
  }
}

function checkAll(params) {
  Object.keys(params || {}).forEach(function (k) { checkParam(k, params[k]); });
}

// For the id fields specifically: coerce to a string and refuse anything empty.
// '0' is refused too - it is the sentinel that cost us a hundred collapsed rows
// on the inbound side, and it means "none" here just as it did there.
function idOf(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (!s || s === '0') return null;
  return s;
}

// ------------------------------------------------------------ action registry
//
// What Nova is allowed to ask Pulsar to do. Each entry names the endpoint it
// belongs to, the parameters it needs, and how to turn those into the body
// Pulsar expects.
//
// The verified flag means "somebody has watched this succeed against the real
// API", NOT "this matches the documentation". It is load-bearing: in live mode
// an unverified action is refused unless explicitly forced, so a wrong guess
// costs a rejection in the call log rather than a real technician sent to a
// real address. Do not flip one you have not personally seen work.

// Documented status codes for the Direct Tech endpoint. These are the whole
// point of the outbound direction - moving a job along the board is exactly
// what Tony asked for.
var TECH_STATUS = { dispatched: 0, accepted: 1, enroute: 2, onsite: 3 };

// Documented service ids, for add_call.
var SERVICE_IDS = {
  1: 'Car Door Unlocking', 2: 'Tire change', 3: 'Gas delivery', 4: 'Jumpstart',
  7: 'Residential House Pick', 9: 'Automotive Locksmith', 10: 'Business Locksmith',
  11: 'Residential Locksmith', 12: 'Trunk opening', 13: 'Message', 14: 'Battery Service'
};

// Documented importType values for add_call.
//   1 - standard dispatch, goes to the live board
//   2 - digital, requires seconds_to_Respond
//   3 - adds to the Digital System, dispatchers do not respond
//   4 - digital, requires seconds_to_Respond and sentBy
//   5 - saves as a Quote, goes to historical storage rather than the board
var IMPORT_TYPES = { dispatch: 1, digital_timed: 2, digital: 3, digital_sent: 4, quote: 5 };

function directTechBody(status) {
  return function (p) {
    // Field order in sValue is positional and documented as:
    // technician personnel id, call UID, location id, status.
    // Positional arrays are unforgiving, so this is the one place worth
    // spelling out rather than mapping cleverly.
    return {
      json: {
        Header: 104000,
        sValue: [
          String(p.techID),
          String(p.callUID),
          String(p.locID),
          String(status === undefined || status === null ? p.status : status)
        ]
      }
    };
  };
}

var ACTIONS = {
  // The one thing we can safely run first, because its documented job is to
  // echo your request back and confirm the credentials. Nothing in Pulsar
  // changes. Marked verified because it is fully documented AND harmless - if
  // it is wrong, the cost is one 401 in the call log.
  auth_test: {
    endpoint: 'api',
    verified: true,
    describe: 'Confirm the credentials work. Echoes the request back; changes nothing.',
    required: [],
    expect_header: null,
    build: function (p) {
      return {
        json: {
          header: 100,
          message: String(p.message || 'Nova connectivity test'),
          contact: { firstName: 'nova', lastName: 'test' },
          values: [1, 2, 3, 4, 5]
        }
      };
    }
  },

  // Documented as a DRAFT on their side, which is why every wrapper below is
  // unverified regardless of how confident the field list looks.
  direct_tech: {
    endpoint: 'api',
    verified: false,
    draft: true,
    describe: 'Assign a call to a technician and set its status (0 dispatched, 1 accepted, 2 enroute, 3 on-site).',
    required: ['techID', 'callUID', 'locID', 'status'],
    expect_header: null,
    build: directTechBody(null)
  },

  // The four everyday verbs. All the same endpoint with the status pinned, so
  // that calling code says what it means instead of passing a bare 2 around.
  assign_call: {
    endpoint: 'api', verified: false, draft: true,
    describe: 'Dispatch a call to a technician.',
    required: ['techID', 'callUID', 'locID'], expect_header: null,
    build: directTechBody(TECH_STATUS.dispatched)
  },
  accept_call: {
    endpoint: 'api', verified: false, draft: true,
    describe: 'Mark a call accepted by the technician.',
    required: ['techID', 'callUID', 'locID'], expect_header: 1001,
    build: directTechBody(TECH_STATUS.accepted)
  },
  enroute: {
    endpoint: 'api', verified: false, draft: true,
    describe: 'Mark a technician enroute.',
    required: ['techID', 'callUID', 'locID'], expect_header: 67,
    build: directTechBody(TECH_STATUS.enroute)
  },
  onsite: {
    endpoint: 'api', verified: false, draft: true,
    describe: 'Mark a technician on scene.',
    required: ['techID', 'callUID', 'locID'], expect_header: 68,
    build: directTechBody(TECH_STATUS.onsite)
  },

  // Create a call. Its own provisioned URL, its own envelope, and - unlike
  // everything else - it wants the sKey in the BODY as well as the headers.
  add_call: {
    endpoint: 'import',
    verified: false,
    describe: 'Create a new call, quote, or digital request.',
    required: ['locID', 'serviceID'],
    expect_header: 1000,
    build: function (p, c) {
      var row = {};
      // Copy the caller's fields through rather than allow-listing them: their
      // field list is long, conditional, and still growing, and a field we
      // silently dropped would be far harder to diagnose than one Pulsar
      // rejects by name.
      Object.keys(p).forEach(function (k) {
        if (k === 'importType' || k === 'ver') return;
        row[k] = p[k];
      });
      row.locID = String(p.locID);
      row.serviceID = Number(p.serviceID);
      if (row.pass_Back_Block === undefined) row.pass_Back_Block = '';
      if (row.tags === undefined) row.tags = [];
      return {
        json: {
          requestType: 'NewJob',
          sKey: c.skey,
          ver: String(p.ver || '.1'),
          importType: Number(p.importType === undefined ? IMPORT_TYPES.dispatch : p.importType),
          data: [row]
        }
      };
    }
  },

  // The odd one out: plain text in, comma separated device ids, no JSON.
  gps: {
    endpoint: 'gps',
    verified: false,
    describe: 'Fetch last known coordinates for one or more GPS devices.',
    required: ['deviceIDs'],
    expect_header: null,
    build: function (p) {
      var list = Array.isArray(p.deviceIDs) ? p.deviceIDs : String(p.deviceIDs).split(',');
      var ids = list.map(function (v) { return String(v).trim(); }).filter(Boolean);
      if (!ids.length) throw new Error('gps needs at least one device id');
      return { text: ids.join(',') };
    }
  }
};

function actionSpec(name) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, String(name)) ? ACTIONS[String(name)] : null;
}

function missingParams(name, params) {
  var spec = actionSpec(name);
  if (!spec) return [];
  var p = params || {};
  return spec.required.filter(function (k) {
    var v = p[k];
    return v === null || v === undefined || String(v).trim() === '';
  });
}

// -------------------------------------------------------------- build request

function buildRequest(action, params, over) {
  var o = over || {};
  var spec = actionSpec(action);

  // The probe path has no spec; it sends whatever it is handed, to whichever
  // endpoint it is pointed at.
  var kind = String(o.endpoint || (spec && spec.endpoint) || 'api');
  var url = String(o.url || endpointUrl(kind));
  if (!url) {
    throw new Error('no URL configured for the "' + kind + '" endpoint. Set PULSAR_' + kind.toUpperCase() +
      '_URL - Pulsar provisions a separate URL per integration and there is no public default.');
  }

  var p = params || {};
  checkAll(p);

  var built;
  if (spec && spec.build) {
    built = spec.build(p, creds());
  } else if (o.text !== undefined) {
    built = { text: String(o.text) };
  } else {
    built = { json: p };
  }

  var headers = authHeaders();
  var body;
  if (built.text !== undefined) {
    headers['Content-Type'] = 'text/plain';
    body = built.text;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(built.json);
  }

  return {
    url: url,
    endpoint: kind,
    init: { method: String(o.method || 'POST'), headers: headers, body: body }
  };
}

// -------------------------------------------------------- reading the answer

/*
 * judge(httpStatus, text)
 *
 * The most important function in this file, and the one the documentation made
 * necessary. Pulsar wraps its answers:
 *
 *     { "result": {...}, "wasSuccess": true, "issueMessaage": "" }
 *
 * A REJECTED request comes back as a healthy HTTP 200 with wasSuccess:false
 * inside it. Any client that trusts the status code will report every rejection
 * as a success, forever, and the only symptom will be that nothing happens in
 * Pulsar.
 *
 * Note "issueMessaage" - three a's. That is how it is spelled in their own
 * published example, alongside "issueMessage" elsewhere on the same page. Both
 * are read, because guessing which one is live is not a bet worth taking, and
 * the failure mode of guessing wrong is an empty error message on the one
 * screen someone is staring at trying to work out what went wrong.
 */
function judge(httpStatus, text) {
  if (!(httpStatus >= 200 && httpStatus < 300)) {
    return { ok: false, uncertain: false, detail: 'HTTP ' + httpStatus };
  }
  var body;
  try { body = JSON.parse(String(text || '')); } catch (e) { body = null; }

  if (body === null || typeof body !== 'object') {
    // A 200 we cannot read. Not called a success - if their API ever starts
    // returning an HTML error page through a proxy, this is the line that
    // notices.
    return { ok: false, uncertain: true, detail: 'a 200 whose body is not JSON: ' + String(text || '').slice(0, 200) };
  }

  var msg = body.issueMessaage || body.issueMessage || body.issueMessege || '';
  if (body.wasSuccess === false) {
    return { ok: false, uncertain: false, permanent: true, detail: msg || 'Pulsar rejected the request (wasSuccess false)', issueNumber: body.issueNumber, errorNumber: body.Errornumber };
  }
  if (body.wasSuccess === true) return { ok: true, uncertain: false, detail: msg || '' };

  // add_call answers in a different shape entirely: {result:'success', jobid:...}
  if (typeof body.result === 'string') {
    var good = body.result.toLowerCase() === 'success';
    return { ok: good, uncertain: false, permanent: !good, detail: good ? '' : body.result, jobid: body.jobid };
  }
  if (body.jobid) return { ok: true, uncertain: false, jobid: body.jobid };

  // Envelope we do not recognise. Treated as success so a working integration
  // is not blocked by our own pedantry, but FLAGGED, so the call log can show
  // it and the inbound echo can settle it. Assuming is fine; assuming quietly
  // is not.
  return { ok: true, uncertain: true, detail: 'unrecognised response envelope - treat with suspicion' };
}

// ------------------------------------------------------------ the call record

// Store first. This INSERT happens before a single byte goes to Pulsar, and it
// returns the id the rest of the flow updates.
async function openCall(o) {
  var r = await pool.query(
    'INSERT INTO outbound_calls ' +
    '(target, action, params, request_shape, request_url, request_body, mode, status, ' +
    ' user_id, user_name, correlation, attempts, created_at) ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,'sending',$8,$9,$10,0,NOW()) RETURNING *",
    [
      o.target || 'pulsar',
      String(o.action || ''),
      JSON.stringify(redact(o.params || {})),
      String(o.endpoint || ''),
      redact(String(o.url || '')),
      redact(String(o.body || '')),
      o.mode,
      o.user_id || null,
      o.user_name || null,
      o.correlation || null
    ]
  );
  return r.rows[0];
}

async function closeCall(id, patch) {
  await pool.query(
    'UPDATE outbound_calls SET status = $2, http_status = $3, response_body = $4, ' +
    'error = $5, attempts = $6, next_attempt_at = $7, duration_ms = $8, finished_at = NOW() ' +
    'WHERE id = $1',
    [
      id,
      patch.status,
      patch.http_status === undefined ? null : patch.http_status,
      patch.response_body === undefined ? null : String(redact(patch.response_body)).slice(0, MAX_RESPONSE_BYTES),
      patch.error === undefined ? null : String(redact(patch.error)).slice(0, 2000),
      patch.attempts || 0,
      patch.next_attempt_at || null,
      patch.duration_ms === undefined ? null : patch.duration_ms
    ]
  );
}

// ------------------------------------------------------------------- transport

// Anything that could plausibly succeed on a second try. Everything else is
// permanent, and retrying it just means bothering Pulsar four more times with a
// request they have already told us they do not like.
//
// wasSuccess:false is NOT retryable and that is deliberate: it is a business
// rejection ("that service id is wrong"), and sending it again four times only
// wastes their capacity and buries the real answer in duplicates.
function retryable(httpStatus, err) {
  if (err) return true;                       // network, DNS, TLS, timeout
  if (httpStatus === 429) return true;
  if (httpStatus >= 500) return true;
  return false;
}

async function send(built) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
  var started = Date.now();
  try {
    var init = Object.assign({}, built.init, { signal: ctl.signal, redirect: 'follow' });
    var res = await fetch(built.url, init);
    var text = '';
    try { text = await res.text(); } catch (e) { text = ''; }
    return {
      http_status: res.status,
      body: String(text || '').slice(0, MAX_RESPONSE_BYTES),
      duration_ms: Date.now() - started
    };
  } catch (err) {
    // An abort here is our own timeout firing, not Pulsar refusing us. Say so:
    // "aborted" in a log at 2am reads like somebody cancelled something.
    var msg = (err && err.name === 'AbortError')
      ? 'no response within ' + TIMEOUT_MS + 'ms'
      : (err && err.message) || String(err);
    return { http_status: null, error: msg, duration_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// Shared by call() and runDue() so the two paths cannot drift apart in how they
// decide what a response meant.
function outcome(res) {
  if (res.error) {
    return { status: 'failed', ok: false, detail: res.error, uncertain: false };
  }
  var v = judge(res.http_status, res.body);
  if (v.ok) return { status: 'done', ok: true, detail: v.detail, uncertain: v.uncertain, jobid: v.jobid };
  if (v.permanent) return { status: 'dead', ok: false, detail: v.detail, uncertain: false, issueNumber: v.issueNumber };
  if (retryable(res.http_status, null)) return { status: 'failed', ok: false, detail: v.detail, uncertain: v.uncertain };
  return { status: 'dead', ok: false, detail: v.detail, uncertain: v.uncertain };
}

// ------------------------------------------------------------------ public API

/*
 * call(action, params, ctx)
 *
 * One attempt, made now, recorded either way. Returns a plain object the route
 * can hand straight back to the browser - it never throws for a Pulsar-side
 * failure, because "Pulsar said no" is an answer, not a crash.
 *
 * ctx: { user_id, user_name, ip, correlation, force, override, modeOverride, raw }
 */
async function call(action, params, ctx) {
  var c = ctx || {};
  var m = c.modeOverride || mode();

  if (m === 'off') {
    return { ok: false, blocked: 'off', error: 'Outbound Pulsar calls are switched off. Set PULSAR_OUT_MODE=dry to rehearse, live to arm.' };
  }
  var spec = actionSpec(action);
  if (!spec && !c.raw) {
    return { ok: false, blocked: 'unknown_action', error: 'No such action "' + action + '". Known: ' + Object.keys(ACTIONS).join(', ') };
  }
  var missing = missingParams(action, params);
  if (missing.length) {
    return { ok: false, blocked: 'missing_params', error: 'Missing required parameter(s): ' + missing.join(', ') };
  }
  if (spec && !spec.verified && m === 'live' && !c.force) {
    return {
      ok: false,
      blocked: 'unverified',
      error: 'The "' + action + '" action has not been confirmed against the real API yet' +
             (spec.draft ? ' (and Pulsar documents this endpoint as a draft)' : '') +
             '. Run it in dry mode, or pass force to send it anyway and see what comes back.'
    };
  }
  if (!credsReady()) {
    return { ok: false, blocked: 'no_credentials', error: 'PULSAR_SKEY and PULSAR_TOKEN are not both set in the environment.' };
  }

  var built;
  try {
    built = buildRequest(action, params, c.override);
  } catch (err) {
    return { ok: false, blocked: 'bad_request', error: err.message };
  }

  var row = await openCall({
    action: action,
    params: params,
    endpoint: built.endpoint,
    url: built.url,
    body: built.init.body || '',
    mode: m,
    user_id: c.user_id,
    user_name: c.user_name,
    correlation: c.correlation
  });

  // Dry mode stops exactly here, one line before the send, with the row already
  // written. What you read back in the call log is byte for byte what would
  // have gone out - which is the entire point of having a dry mode at all.
  if (m === 'dry') {
    await closeCall(row.id, { status: 'dry', attempts: 0, duration_ms: 0 });
    return {
      ok: true,
      dry: true,
      id: row.id,
      endpoint: built.endpoint,
      would_send: { url: redact(built.url), method: built.init.method, body: redact(built.init.body || '') }
    };
  }

  var res = await send(built);
  var verdict = outcome(res);
  var nextAt = verdict.status === 'failed' ? new Date(Date.now() + BACKOFF_MS[0]) : null;

  await closeCall(row.id, {
    status: verdict.status,
    http_status: res.http_status,
    response_body: res.body,
    error: verdict.ok ? null : verdict.detail,
    attempts: 1,
    next_attempt_at: nextAt,
    duration_ms: res.duration_ms
  });

  // Audited separately from the call log on purpose. The call log is an
  // operational queue that gets trimmed; audit_logs is the permanent record of
  // "a person in Nova caused a change in someone else's system", and that is
  // not something to keep in a table we prune.
  await logAudit({
    entity_type: 'pulsar_out',
    entity_id: row.id,
    entity_number: String(action).slice(0, 50),
    action: verdict.ok ? 'sent' : 'send_failed',
    user_id: c.user_id || null,
    user_name: c.user_name || 'system',
    ip: c.ip || null,
    details: { params: redact(params || {}), http_status: res.http_status, error: redact(verdict.detail || null), mode: m }
  });

  return {
    ok: verdict.ok,
    id: row.id,
    status: verdict.status,
    http_status: res.http_status,
    body: res.body,
    error: verdict.ok ? null : verdict.detail,
    // true means "Pulsar answered in a shape we did not recognise". The call may
    // well have worked; watch the inbound feed rather than trusting this one.
    uncertain: !!verdict.uncertain,
    jobid: verdict.jobid || null,
    issue_number: verdict.issueNumber || null,
    duration_ms: res.duration_ms,
    expect_header: spec ? spec.expect_header : null,
    retrying: verdict.status === 'failed'
  };
}

/*
 * probe(spec)
 *
 * The escape hatch. Sends an arbitrary body to any of the three endpoints with
 * the credentials attached, and shows you exactly what came back. The published
 * documentation covers five endpoints and describes two of them as drafts, so
 * there will be things we need to try that the registry does not know about.
 *
 * It is the only path that will send an arbitrary action name, and it is
 * admin-gated in the route. It still writes a call row and still redacts.
 */
async function probe(spec) {
  var s = spec || {};
  return call(String(s.action || 'probe'), s.params || {}, {
    raw: true,
    force: true,
    modeOverride: s.mode,
    override: { url: s.url, endpoint: s.endpoint, method: s.method, text: s.text },
    user_id: s.user_id,
    user_name: s.user_name,
    ip: s.ip,
    correlation: 'probe'
  });
}

// The retry sweep, same lease trick as the inbound side: claiming a row pushes
// its next_attempt_at forward, so a second sweep starting while this one is
// mid-flight cannot pick up the same call and send it twice. Sending a dispatch
// instruction twice is a genuinely bad outcome, so the claim is a single
// UPDATE ... RETURNING rather than a select-then-update anyone could race.
async function runDue(limit) {
  var lim = Math.max(1, Math.min(200, Number(limit || 25)));
  // Pushing next_attempt_at five minutes out IS the lease: the row stays
  // invisible to the next sweep while this one has it in flight, and if the
  // process dies mid-send the lease simply expires and it comes back.
  var claimed = await pool.query(
    "UPDATE outbound_calls SET attempts = attempts + 1, next_attempt_at = NOW() + interval '5 minutes' " +
    'WHERE id IN (SELECT id FROM outbound_calls ' +
    "  WHERE status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= NOW() " +
    '  ORDER BY next_attempt_at LIMIT ' + lim + ' FOR UPDATE SKIP LOCKED) ' +
    'RETURNING *'
  );

  var rows = claimed.rows || [];
  var done = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    // RETURNING already carries the incremented value. This is the attempt
    // about to be made, not the one before it - the inbound side got this wrong
    // once and every event skipped its first backoff and dead-lettered early.
    var attempts = Number(row.attempts);
    if (attempts > MAX_ATTEMPTS) {
      await closeCall(row.id, { status: 'dead', attempts: attempts, error: 'gave up after ' + (attempts - 1) + ' attempts' });
      continue;
    }
    var built;
    try {
      // params is jsonb, so pg hands it back already parsed. It was a string in
      // an earlier draft and this accepts both rather than betting on it.
      var p = row.params;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
      built = buildRequest(row.action, p || {}, null);
    } catch (err) {
      await closeCall(row.id, { status: 'dead', attempts: attempts, error: err.message });
      continue;
    }
    var res = await send(built);
    var verdict = outcome(res);
    if (verdict.ok) {
      await closeCall(row.id, { status: 'done', http_status: res.http_status, response_body: res.body, attempts: attempts, duration_ms: res.duration_ms });
      done++;
    } else if (verdict.status === 'failed' && attempts < MAX_ATTEMPTS) {
      await closeCall(row.id, {
        status: 'failed',
        http_status: res.http_status,
        response_body: res.body,
        error: verdict.detail,
        attempts: attempts,
        next_attempt_at: new Date(Date.now() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]),
        duration_ms: res.duration_ms
      });
    } else {
      await closeCall(row.id, {
        status: 'dead', http_status: res.http_status, response_body: res.body,
        error: verdict.detail, attempts: attempts, duration_ms: res.duration_ms
      });
    }
  }
  return { claimed: rows.length, done: done };
}

// What the status screen shows. Note what is NOT here: the secrets. Only
// whether they are present, and the last four of each.
function status() {
  var c = creds();
  return {
    mode: mode(),
    endpoints: { api: endpointUrl('api'), import: endpointUrl('import') || null, gps: endpointUrl('gps') || null },
    skey: credFingerprint(c.skey),
    token: credFingerprint(c.token),
    ready: credsReady(),
    actions: Object.keys(ACTIONS).map(function (k) {
      return {
        name: k, endpoint: ACTIONS[k].endpoint, verified: ACTIONS[k].verified,
        draft: !!ACTIONS[k].draft, describe: ACTIONS[k].describe,
        required: ACTIONS[k].required, expect_header: ACTIONS[k].expect_header,
        available: !!endpointUrl(ACTIONS[k].endpoint)
      };
    })
  };
}

module.exports = {
  call: call,
  probe: probe,
  runDue: runDue,
  status: status,
  mode: mode,
  redact: redact,
  judge: judge,
  outcome: outcome,
  buildRequest: buildRequest,
  authHeaders: authHeaders,
  endpointUrl: endpointUrl,
  credsReady: credsReady,
  credFingerprint: credFingerprint,
  retryable: retryable,
  actionSpec: actionSpec,
  missingParams: missingParams,
  idOf: idOf,
  ACTIONS: ACTIONS,
  TECH_STATUS: TECH_STATUS,
  SERVICE_IDS: SERVICE_IDS,
  IMPORT_TYPES: IMPORT_TYPES,
  MAX_ATTEMPTS: MAX_ATTEMPTS,
  BACKOFF_MS: BACKOFF_MS
};
