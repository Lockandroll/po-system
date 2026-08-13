'use strict';
/*
 * Handler registry for the inbound sync receiver.
 * -----------------------------------------------
 * This is the ONLY file that knows what any partner's JSON means. Everything
 * else - auth, storage, dedupe, retries, the admin screens - is generic and
 * lives in utils/webhookIngest.js.
 *
 * Adding an integration:
 *   1. Create the source (POST /api/sync/sources) - that hands you the URL and
 *      the token to give the partner.
 *   2. Add a function here under the same key as the source's "handler" field
 *      (which defaults to the slug).
 *   3. Replay the events that piled up as 'parked' while you were writing it.
 *
 * A handler is:  async function (event, ctx) -> undefined | { note, skip }
 *
 *   event.payload      the parsed JSON body
 *   event.raw_body     the exact bytes, if the partner's shape ever surprises you
 *   event.event_type   whatever was at the source's event_type_path
 *   event.external_id  the partner's own id for this event, if they sent one
 *   event.headers      an allowlisted copy of the request headers
 *   ctx.pool           the pg pool
 *
 * Control flow:
 *   return                    -> 'done'
 *   return { skip: true, note } -> 'skipped'  (understood, deliberately ignored)
 *   throw                     -> retried on the backoff schedule
 *   throw with err.permanent = true -> dead-lettered now, no retries
 *
 * The distinction matters. A database blip is a throw; a payload we will never
 * be able to make sense of is a permanent throw. Retrying the second one just
 * fills the log with the same error eight times.
 *
 * NOTE: no backtick characters anywhere in this file (Windows-safe per the Nova
 * editing rules).
 */

function permanent(message) {
  var e = new Error(message);
  e.permanent = true;
  return e;
}

var handlers = {};

/* ---------------------------------------------------------------- pulsar --- */

// Pulsar's syncer. INTENTIONALLY not registered yet.
//
// The endpoint and the token go to Pulsar first so their syncer can start
// delivering; every one of those deliveries lands in webhook_events with
// status 'parked'. Once a few real payloads are in hand - the only honest way
// to learn what their codes mean - fill this in, register it below, and replay
// the parked rows. Nothing is lost in the meantime, which is the whole point of
// storing before interpreting.
//
// THE ENVELOPE (from Duty, 2026-08-13). Either one object or an array of them;
// utils/webhookIngest.js splits an array into one event per element, so a
// handler only ever sees ONE record.
//
//   { "autonum":    "0",
//     "dataTarget": "",
//     "dataHeader": 0,
//     "locationID": "0",
//     "targetID":   "0",
//     "accountID":  "0",
//     "gmtStamp":   "2026-08-13T00:00:00Z",
//     "targetUID":  "00000000-0000-0000-0000-000000000000" }
//
// Duty: "dataHeader is the one you kinda start off looking at" - it is the
// record-type discriminator, and it is the only bare number in the envelope.
// The source is configured with event_type_path = dataHeader, so the event log
// shows the code on every row. That means the distribution of what actually
// arrives can be read straight off the log before a line of mapping exists.
//
// WARNING: THIS ENVELOPE CARRIES NO DATA. It is a POINTER - "record of type
// dataHeader, id targetUID/targetID, changed at gmtStamp". Acting on it means
// fetching the record from Pulsar, which needs an API token Nova does not have.
// Until that is settled, parking these is not a limitation, it is the only
// correct thing to do with them.
//
// WARNING: "0" AND THE NIL GUID ARE SENTINELS, NOT VALUES. Every id in the
// sample is a string, and "0" / the all-zero GUID mean absent. Treating "0" as
// the number 0 and looking up location 0 is the obvious way to get this wrong,
// so ids go through pulsarId() rather than Number() or a truthiness check.

// Absent -> null. Never 0, never "0", never the nil GUID.
function pulsarId(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (!s) return null;
  if (s === '0') return null;
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s)) return null;
  return s;
}

async function pulsar(event, ctx) {
  var p = event.payload || {};

  // dataHeader may legitimately BE 0, so this tests presence, not truthiness.
  if (p.dataHeader === undefined || p.dataHeader === null || p.dataHeader === '') {
    throw permanent('Pulsar record carried no dataHeader, so there is nothing to route on.');
  }
  var header = Number(p.dataHeader);
  if (!isFinite(header)) throw permanent('Pulsar dataHeader is not a number: ' + JSON.stringify(p.dataHeader));

  var ref = {
    header: header,
    autonum: pulsarId(p.autonum),
    target: pulsarId(p.targetUID) || pulsarId(p.targetID),
    location: pulsarId(p.locationID),
    account: pulsarId(p.accountID),
    at: p.gmtStamp || null
  };

  switch (header) {
    // case 1: return upsertCall(ref, ctx);
    // case 2: return upsertLocation(ref, ctx);
    default:
      return { skip: true, note: 'Unmapped Pulsar dataHeader ' + header + ' (target ' + (ref.target || 'none') + ')' };
  }
}

// Uncomment to go live. Leaving it commented is what keeps deliveries parked
// instead of being silently marked done by a half-written mapping.
// handlers.pulsar = pulsar;

/* ------------------------------------------------------------------ echo --- */

// A always-succeeds handler. Point a throwaway source at it to prove the token,
// the URL and the plumbing work before a partner is involved.
handlers.echo = async function (event) {
  return { note: 'echo: ' + (event.event_type || 'no event type') + ', ' + Buffer.byteLength(event.raw_body || '', 'utf8') + ' bytes' };
};

/* --------------------------------------------------------------- registry --- */

function get(name) {
  var fn = handlers[String(name || '')];
  return typeof fn === 'function' ? fn : null;
}

// For tests and for a future plugin-style registration. Not used at boot.
function register(name, fn) {
  if (typeof fn !== 'function') throw new Error('Handler for "' + name + '" must be a function');
  handlers[String(name)] = fn;
}

function list() {
  return Object.keys(handlers).sort();
}

module.exports = { get: get, register: register, list: list, permanent: permanent, _pulsarDraft: pulsar, _pulsarId: pulsarId };
