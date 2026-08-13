'use strict';
/*
 * Generic inbound sync receiver  (Nova)
 * -------------------------------------
 * One front door for every partner that wants to POST JSON at Nova. Pulsar's
 * "syncer" is the first tenant; the shape is deliberately not Pulsar-specific,
 * because the next three integrations will want exactly this and nobody should
 * have to write the auth / storage / retry plumbing again.
 *
 * The contract, in order:
 *
 *   1. AUTHENTICATE off a shared secret in a header. The secret is stored as a
 *      SHA-256 hash in webhook_sources, never in plaintext, and compared with a
 *      constant-time compare so the endpoint cannot be used as a timing oracle.
 *   2. STORE the payload verbatim, raw body and all, in webhook_events. This
 *      happens BEFORE anything is interpreted. If the mapping code is wrong, or
 *      does not exist yet, the data is still on disk and can be replayed.
 *   3. ANSWER 200 immediately. A partner's syncer is usually on a timeout and a
 *      retry queue; making it wait on our processing turns our slow query into
 *      their duplicate delivery.
 *   4. PROCESS out of band, via the handler registered for that source in
 *      utils/webhookHandlers.js. A throw there is a retry, not a lost event.
 *
 * A new integration is therefore a ROW in webhook_sources plus one function in
 * the handler registry. Nothing in this file changes.
 *
 * NOTE: no backtick characters anywhere in this file (Windows-safe per the Nova
 * editing rules).
 */

var crypto = require('crypto');
var { pool } = require('../db');

var MAX_BODY_BYTES = Number(process.env.SYNC_MAX_BODY_BYTES || 2 * 1024 * 1024);

// A payload with no id of its own is treated as a duplicate if the identical
// bytes already arrived inside this window. That is the retry case: a partner
// who did not see our 200 and sent the same thing again. Beyond the window we
// assume a genuine re-sync and store it.
var BLIND_DEDUPE_MS = Number(process.env.SYNC_BLIND_DEDUPE_MS || 10 * 60 * 1000);

// Records per POST when a partner sends a top-level array.
//
// This was 1000 when each record cost its own INSERT. Now that a batch is a
// handful of bulk statements, the old number was just an arbitrary wall a
// partner could hit for no reason. 5000 records of Pulsar's envelope is about
// 1.25 MB, which sits comfortably under MAX_BODY_BYTES - so the two limits now
// bite at roughly the same point instead of one shadowing the other.
var MAX_BATCH = Number(process.env.SYNC_MAX_BATCH || 5000);

// Attempt N (1-based) waits this long before the next try. Past the end of the
// list the event is dead-lettered: status 'failed', next_attempt_at NULL, and
// it sits in the events list until a human replays it.
var BACKOFF_MS = [30e3, 120e3, 300e3, 900e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3];

// How long a worker may hold a claimed event before the sweep assumes it died
// and takes the event back. Comfortably longer than any sane handler and short
// enough that a Railway restart mid-handler is a blip, not a lost event.
var STUCK_LEASE_MS = Number(process.env.SYNC_STUCK_LEASE_MS || 15 * 60 * 1000);

/* --------------------------------------------------------------- primitives */

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// Compare two hex digests without leaking their difference through timing.
// Both sides are already fixed-length hex, so a length mismatch means the
// presented value was not a hash of anything and can be rejected outright.
function hashEquals(a, b) {
  var x = String(a || '');
  var y = String(b || '');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
}

function newSecret() {
  // 48 bytes of base64url. Long enough that nobody will ever brute force it and
  // short enough to paste into a chat window without wrapping.
  return crypto.randomBytes(48).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Walk a dot path into a parsed payload: 'data.event.id' or 'id'. Array indexes
// work too ('items.0.id'). Anything missing returns undefined rather than
// throwing, because a partner changing their envelope should degrade to "no
// dedupe key", not to a 500.
function pluck(obj, path) {
  if (!obj || !path) return undefined;
  var parts = String(path).split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

// Values that mean "this record has no id", even though they are technically
// present. Every system has them and they are never a real key.
//
// THIS IS THE BUG THAT ATE A BATCH: Pulsar's envelope uses "0" and the nil GUID
// as its empty markers. utils/webhookHandlers.js already knew that, but the
// DEDUPE key did not - so a run of records that all carried autonum "0" every
// one looked like the same id, the first was stored, and the rest were
// discarded as duplicates. Silently, with a 200 to the partner.
//
// A record with no usable id is not a duplicate. It falls through to byte
// comparison instead, which is blunter but cannot invent a collision.
var DEDUPE_SENTINELS = {
  '0': true, '-1': true, 'null': true, 'undefined': true, 'none': true, 'false': true,
  '00000000-0000-0000-0000-000000000000': true
};

function dedupeId(v) {
  var id = scalar(v);
  if (!id) return null;
  if (DEDUPE_SENTINELS[id.toLowerCase()]) return null;
  return id;
}

function scalar(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  var s = String(v).trim();
  if (!s) return null;
  return s.slice(0, 200);
}

/* ---------------------------------------------------- reversible secret box */

// AES-256-GCM, same scheme as utils/hrCrypto.js.
//
// This exists because of an asymmetry that is easy to get wrong: a BEARER token
// can be stored as a one-way hash, because verifying it only means hashing what
// the caller presented and comparing. An HMAC KEY cannot - to recompute a
// signature we need the key itself. So it has to be stored reversibly, and the
// only honest options are plaintext or encrypted-at-rest. This is the second.
//
// Key comes from SYNC_SECRET_KEY, falling back to HR_DOC_ENC_KEY so an existing
// deploy does not need a new variable. 32 bytes, base64 or hex. With neither
// set, HMAC simply cannot be enabled and every surface says so plainly rather
// than quietly downgrading to plaintext.
var SBOX_IV = 12, SBOX_TAG = 16;

function sboxKey() {
  var raw = String(process.env.SYNC_SECRET_KEY || process.env.HR_DOC_ENC_KEY || '').trim();
  if (!raw) return null;
  try { var b = Buffer.from(raw, 'base64'); if (b.length === 32) return b; } catch (e) {}
  try { var h = Buffer.from(raw, 'hex'); if (h.length === 32) return h; } catch (e) {}
  return null;
}

function sboxReady() { return !!sboxKey(); }

function sealSecret(plain) {
  var key = sboxKey();
  if (!key) throw new Error('Set SYNC_SECRET_KEY (or HR_DOC_ENC_KEY) to a 32-byte base64/hex value before storing a signing key.');
  var iv = crypto.randomBytes(SBOX_IV);
  var c = crypto.createCipheriv('aes-256-gcm', key, iv);
  var enc = Buffer.concat([c.update(Buffer.from(String(plain), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function openSecret(packed) {
  var key = sboxKey();
  if (!key || !packed) return null;
  try {
    var buf = Buffer.from(String(packed), 'base64');
    if (buf.length < SBOX_IV + SBOX_TAG + 1) return null;
    var d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, SBOX_IV));
    d.setAuthTag(buf.subarray(SBOX_IV, SBOX_IV + SBOX_TAG));
    return Buffer.concat([d.update(buf.subarray(SBOX_IV + SBOX_TAG)), d.final()]).toString('utf8');
  } catch (e) {
    // Wrong key or tampered blob. Never throw into a delivery.
    console.error('[sync] could not open a stored signing key: ' + e.message);
    return null;
  }
}

/* -------------------------------------------------------- signature checking */

// Partners describe their signature scheme in a sentence, and a sentence is not
// a specification. "The HMAC of the token and the body" is at least four
// different byte strings, times two encodings.
//
// Rather than guess one and spend a week trading "still 401" messages, every
// plausible formulation is computed and the one that MATCHES is recorded on the
// event. In observe mode that costs nothing and tells you the real answer from
// the partner's own traffic; you then pin it and switch to require.
var HMAC_FORMATS = [
  { key: 'body',        build: function (ts, body) { return body; } },
  { key: 'ts.body',     build: function (ts, body) { return ts + '.' + body; } },
  { key: 'ts+body',     build: function (ts, body) { return ts + body; } },
  { key: 'body.ts',     build: function (ts, body) { return body + '.' + ts; } }
];

function normalizeSig(v) {
  // Partners send bare hex, bare base64, or a prefixed form like "sha256=...".
  var s = String(v || '').trim();
  var eq = s.indexOf('=');
  if (eq > 0 && eq < 12 && /^[a-z0-9_-]+$/i.test(s.slice(0, eq))) s = s.slice(eq + 1);
  return s;
}

function sigCandidates(secret, ts, body) {
  var out = {};
  HMAC_FORMATS.forEach(function (f) {
    var msg = f.build(ts, body);
    var mac = crypto.createHmac('sha256', secret).update(msg, 'utf8').digest();
    out[f.key] = { hex: mac.toString('hex'), b64: mac.toString('base64') };
  });
  // Not an HMAC at all, but a common misreading of "hash the token and the
  // body" that partners really do ship. Worth recognising so the diagnosis
  // names it instead of reporting a blanket mismatch.
  var plain = crypto.createHash('sha256').update(String(secret) + body, 'utf8').digest();
  out['sha256(token+body)'] = { hex: plain.toString('hex'), b64: plain.toString('base64') };
  return out;
}

function safeEq(a, b) {
  var x = String(a || ''), y = String(b || '');
  if (!x.length || x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')); }
  catch (e) { return false; }
}

// Returns { state, format, detail }
//   off        this source does not use signatures
//   no_key     configured but no signing key stored (or SYNC_SECRET_KEY unset)
//   missing    the partner sent no signature header
//   stale      the timestamp is outside the allowed skew
//   ok         a formulation matched; 'format' names which one
//   mismatch   nothing matched
function verifySignature(source, req, rawBody) {
  var mode = String(source.hmac_mode || 'off');
  if (mode === 'off') return { state: 'off' };

  var secret = openSecret(source.hmac_secret_enc);
  if (!secret) return { state: 'no_key', detail: sboxReady() ? 'No signing key stored for this source.' : 'SYNC_SECRET_KEY is not set on the server.' };

  var h = req.headers || {};
  var sigHeader = String(source.hmac_header || 'x-signature').toLowerCase();
  var tsHeader = String(source.hmac_ts_header || '').toLowerCase();
  var presented = normalizeSig(h[sigHeader]);
  if (!presented) return { state: 'missing', detail: 'No ' + sigHeader + ' header on the request.' };

  var ts = tsHeader ? String(h[tsHeader] || '') : '';

  // Freshness. Only meaningful when the timestamp is INSIDE the signed string -
  // an unsigned timestamp can be edited by whoever is replaying, so checking it
  // then is theatre. Enforced only once a format is pinned and that format
  // includes ts.
  var skew = Number(source.hmac_max_skew_s || 0);
  if (skew > 0 && ts && String(source.hmac_format || '').indexOf('ts') !== -1) {
    var t = Date.parse(ts);
    if (!isFinite(t)) return { state: 'stale', detail: 'Unparseable timestamp: ' + ts };
    var drift = Math.abs(Date.now() - t) / 1000;
    if (drift > skew) return { state: 'stale', detail: 'Timestamp is ' + Math.round(drift) + 's off; limit is ' + skew + 's.' };
  }

  var cands = sigCandidates(secret, ts, rawBody);
  var pinned = String(source.hmac_format || '');

  // Once pinned, ONLY that formulation counts. Continuing to accept any of the
  // others would mean the pin bought nothing.
  var keys = pinned && cands[pinned] ? [pinned] : Object.keys(cands);
  for (var i = 0; i < keys.length; i++) {
    var c = cands[keys[i]];
    if (safeEq(presented, c.hex) || safeEq(presented, c.b64)) {
      return { state: 'ok', format: keys[i] };
    }
  }
  return { state: 'mismatch', detail: 'No formulation matched (tried ' + keys.join(', ') + ').' };
}

/* ------------------------------------------------------------ secret lookup */

// webhook_sources is read on every inbound request, so it is cached briefly.
// The TTL is short on purpose: rotating a token should take effect within
// seconds, not on the next deploy.
var _cache = new Map();
var CACHE_MS = Number(process.env.SYNC_SOURCE_CACHE_MS || 20000);

function cacheBust(slug) {
  if (slug) _cache.delete(String(slug));
  else _cache.clear();
}

async function loadSource(slug) {
  var key = String(slug || '');
  var hit = _cache.get(key);
  var now = Date.now();
  if (hit && hit.expires > now) return hit.row;
  var r = await pool.query(
    'SELECT id, slug, name, secret_hash, secret_header, handler, enabled, dedupe_path, dedupe_mode, event_type_path, accept_types, ' +
    'hmac_mode, hmac_header, hmac_ts_header, hmac_secret_enc, hmac_format, hmac_max_skew_s FROM webhook_sources WHERE slug = $1',
    [key]
  );
  var row = r.rows[0] || null;
  _cache.set(key, { row: row, expires: now + CACHE_MS });
  return row;
}

// Pull the presented secret out of the request. Four spellings are accepted
// because every partner has a different habit and none of them is worth a
// round trip to argue about:
//
//   X-Nova-Token: <secret>
//   X-Webhook-Token: <secret>
//   Authorization: Bearer <secret>
//   ?token=<secret>            (last resort - it lands in access logs)
function presentedSecret(req, source) {
  var h = req.headers || {};
  // A source may name the header it actually uses. Partners pick their own
  // spelling and will not change it for us; Pulsar sends plain 'auth'.
  var custom = source && source.secret_header ? String(source.secret_header).toLowerCase() : '';
  var v = (custom && h[custom]) || h['x-nova-token'] || h['x-webhook-token'] || h['x-api-key'] || '';
  if (!v) {
    var auth = String(h['authorization'] || '');
    var m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) v = m[1];
  }
  if (!v && req.query && req.query.token) v = req.query.token;
  return String(v || '').trim();
}

function clientIp(req) {
  var fwd = String((req.headers || {})['x-forwarded-for'] || '');
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
  return String(req.ip || '').slice(0, 64);
}

// Headers are stored for debugging, so the secret must not be among them. The
// allowlist is positive rather than a blocklist: a partner who invents a new
// header carrying a credential should not silently end up in our database.
var KEEP_HEADERS = [
  'content-type', 'user-agent', 'x-request-id', 'x-correlation-id',
  'x-event-type', 'x-event-id', 'x-signature', 'x-timestamp'
];

function safeHeaders(req) {
  var out = {};
  var h = req.headers || {};
  KEEP_HEADERS.forEach(function (k) { if (h[k]) out[k] = String(h[k]).slice(0, 500); });
  return out;
}

/* ------------------------------------------------- type filter + traffic log */

// Pulsar's feed is EVERY event in their system - Duty: "there are LOTS of them
// and it'll spam ya". Storing a firehose forever to use 2% of it is how a
// Railway bill quietly triples, so a source may declare which event types it
// actually wants. Anything else is counted and dropped at the door.
//
// accept_types empty/NULL means accept everything, which is the right default:
// a new integration should watch real traffic for a day BEFORE deciding what to
// throw away. The counters below are what make that day's watching possible
// without storing a single unwanted payload.
//
// Matching is on the STRING form of the type, so '2000' and 2000 are the same
// thing and nobody has to remember which side quoted it.
var _acceptCache = new Map();

function acceptSet(source) {
  var raw = String(source.accept_types || '').trim();
  if (!raw) return null;                        // null = accept everything
  var hit = _acceptCache.get(raw);
  if (hit) return hit;
  var set = new Set(raw.split(',').map(function (t) { return t.trim(); }).filter(Boolean));
  if (!set.size) return null;
  _acceptCache.set(raw, set);
  return set;
}

function accepts(source, eventType) {
  var set = acceptSet(source);
  if (!set) return true;
  // A record with no type at all is always kept. It cannot be matched against
  // the list, and silently dropping the one delivery whose shape we did not
  // anticipate is exactly the failure this whole design exists to avoid.
  if (eventType === null || eventType === undefined || eventType === '') return true;
  return set.has(String(eventType));
}

// Per-type traffic counters, held in memory and flushed to webhook_event_stats
// on a timer by jobs/webhookRetry.js.
//
// In memory rather than an UPSERT per delivery on purpose: on a feed that
// carries every event in a partner's system, one counter row per type becomes
// the hottest row in the database and every delivery queues behind it. The cost
// is that a hard restart loses up to one flush interval of counts. That is an
// acceptable trade for a statistics table and a terrible one for event data,
// which is why events are never handled this way.
var _stats = new Map();

// kind: 'stored' | 'dropped' | 'duplicate'
//
// Duplicates are counted SEPARATELY rather than as stored. They used to be
// lumped in with stored, which produced the worst possible reporting: the
// traffic screen said records were arriving and being kept, the event log
// showed nothing new, and there was no number anywhere that explained the gap.
// A deduped record is a real delivery that deliberately produced no event, and
// that is exactly the thing an operator needs to be able to see.
function countEvent(slug, eventType, kind) {
  var key = slug + '\u0000' + (eventType === null || eventType === undefined ? '' : String(eventType));
  var row = _stats.get(key);
  if (!row) { row = { stored: 0, dropped: 0, duplicate: 0 }; _stats.set(key, row); }
  if (kind === 'dropped') row.dropped++;
  else if (kind === 'duplicate') row.duplicate++;
  else row.stored++;
}

async function flushStats() {
  if (!_stats.size) return { flushed: 0 };
  // Swapped out first, so deliveries arriving during the flush accumulate into
  // the new map instead of being double counted or lost.
  var batch = _stats;
  _stats = new Map();
  var n = 0;
  var entries = Array.from(batch.entries());
  for (var i = 0; i < entries.length; i++) {
    var parts = entries[i][0].split('\u0000');
    var v = entries[i][1];
    try {
      await pool.query(
        'INSERT INTO webhook_event_stats (source_slug, event_type, stored_count, dropped_count, duplicate_count, first_seen, last_seen) ' +
        'VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) ' +
        'ON CONFLICT (source_slug, event_type) DO UPDATE SET ' +
        'stored_count = webhook_event_stats.stored_count + EXCLUDED.stored_count, ' +
        'dropped_count = webhook_event_stats.dropped_count + EXCLUDED.dropped_count, ' +
        'duplicate_count = webhook_event_stats.duplicate_count + EXCLUDED.duplicate_count, ' +
        'last_seen = NOW()',
        [parts[0], parts[1] || '', v.stored, v.dropped, v.duplicate || 0]
      );
      n++;
    } catch (e) {
      console.error('[sync] stats flush failed for ' + parts[0] + '/' + parts[1] + ': ' + e.message);
    }
  }
  return { flushed: n };
}

/* ------------------------------------------------------------------ receive */

// Store ONE record. Shared by the single-object and the batch paths below.
//
// itemRaw is the exact text this record is stored as: the request's own bytes
// for a single object, the re-serialized element for a member of a batch.
// id    dedupe on the partner's own id  (default, safest once the id is trusted)
// bytes  no id, compare the raw bytes inside a short window
// off    store everything, never suppress anything
//
// The mode is per source because "is their id actually unique" is a question
// about THEM, and the honest answer early in an integration is "nobody knows
// yet". Getting it wrong in the 'id' direction is silent data loss, which is
// far worse than a few duplicate rows - so 'off' is a legitimate place to sit
// while you find out.
function dedupeMode(source) {
  var m = String(source.dedupe_mode || 'id').toLowerCase();
  return (m === 'bytes' || m === 'off') ? m : 'id';
}

async function storeOne(source, req, itemRaw, item, sigNote) {
  var eventType = scalar(pluck(item, source.event_type_path || 'event'))
    || scalar((req.headers || {})['x-event-type']);

  // The filter runs BEFORE the hash and before any query, so an unwanted record
  // costs one Set lookup rather than a round trip.
  if (!accepts(source, eventType)) {
    countEvent(source.slug, eventType, 'dropped');
    return { id: null, duplicate: false, filtered: true };
  }

  var bodyHash = sha256(itemRaw);
  var mode = dedupeMode(source);

  // externalId is ALWAYS recorded - it is the partner's id and belongs on the
  // row whatever we do about duplicates. dedupeKey is what the unique index
  // actually enforces, and it is only set when we are deduping on the id.
  // Keeping them as one column was what made "turn duplicate checking off"
  // mean "lose the id from the screen".
  var externalId = scalar(pluck(item, source.dedupe_path || 'id'))
    || scalar((req.headers || {})['x-event-id']);
  var dedupeKey = mode === 'id'
    ? (dedupeId(pluck(item, source.dedupe_path || 'id')) || dedupeId((req.headers || {})['x-event-id']))
    : null;

  // Dedupe path 1: the source gave us its own event id. The partial unique
  // index does the work, so a race between two concurrent deliveries of the
  // same id resolves in the database rather than in application logic.
  if (dedupeKey) {
    var ins = await pool.query(
      'INSERT INTO webhook_events (source_slug, event_type, external_id, dedupe_key, body_hash, payload, raw_body, headers, ip, status, next_attempt_at, sig_state) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW(),$10) " +
      'ON CONFLICT (source_slug, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING ' +
      'RETURNING id',
      [source.slug, eventType, externalId, dedupeKey, bodyHash, JSON.stringify(item), itemRaw, JSON.stringify(safeHeaders(req)), clientIp(req), sigNote || null]
    );
    if (!ins.rows.length) {
      var prior = await pool.query(
        'SELECT id FROM webhook_events WHERE source_slug = $1 AND dedupe_key = $2',
        [source.slug, dedupeKey]
      );
      countEvent(source.slug, eventType, 'duplicate');
      console.warn('[sync] ' + source.slug + ' duplicate ' + (eventType ? 'type ' + eventType + ' ' : '') +
        'id "' + dedupeKey + '" - already stored as event ' + (prior.rows[0] ? prior.rows[0].id : '?') +
        ', nothing new written. If this id was expected to be NEW, the dedupe field is wrong.');
      return { id: prior.rows[0] ? Number(prior.rows[0].id) : null, duplicate: true };
    }
    countEvent(source.slug, eventType, 'stored');
    return { id: Number(ins.rows[0].id), duplicate: false };
  }

  // Dedupe path 2: no id anywhere. Identical bytes inside the blind window are
  // a retry of a delivery whose 200 got lost. Outside it, assume a real
  // re-send and store it.
  if (mode !== 'off') {
    var dup = await pool.query(
      'SELECT id FROM webhook_events WHERE source_slug = $1 AND body_hash = $2 AND received_at > NOW() - ($3::bigint * INTERVAL ' + "'1 millisecond'" + ') ORDER BY id DESC LIMIT 1',
      [source.slug, bodyHash, BLIND_DEDUPE_MS]
    );
    if (dup.rows.length) {
      countEvent(source.slug, eventType, 'duplicate');
      return { id: Number(dup.rows[0].id), duplicate: true };
    }
  }

  var ins2 = await pool.query(
    'INSERT INTO webhook_events (source_slug, event_type, external_id, dedupe_key, body_hash, payload, raw_body, headers, ip, status, next_attempt_at, sig_state) ' +
    "VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,'pending',NOW(),$9) RETURNING id",
    [source.slug, eventType, externalId, bodyHash, JSON.stringify(item), itemRaw, JSON.stringify(safeHeaders(req)), clientIp(req), sigNote || null]
  );
  countEvent(source.slug, eventType, 'stored');
  return { id: Number(ins2.rows[0].id), duplicate: false };
}

// Rows per INSERT statement. Postgres caps a statement at 65535 parameters and
// this uses 9 per row, so the ceiling is ~7000 - but a smaller chunk keeps any
// single statement quick and keeps the partner's connection moving.
var INSERT_CHUNK = 200;

// Store a whole array in a handful of statements instead of one per record.
//
// THIS IS WHY: the first version looped storeOne() and awaited a round trip per
// record, all BEFORE the response was sent. One object was two queries; a
// 500-record array was over a thousand, with the partner's syncer sitting on
// its timeout the whole time. Pulsar timed out. The receiver was built around
// "answer fast" and the batch path was quietly doing the opposite.
//
// Dedupe survives the rewrite intact: the partial unique index still decides,
// via ON CONFLICT DO NOTHING, so a resent batch overlapping an earlier one
// still stores only what is new. Records the database did not return are the
// duplicates.
async function storeMany(source, req, items, sigNote) {
  var hdrs = JSON.stringify(safeHeaders(req));
  var ip = clientIp(req);
  var mode = dedupeMode(source);

  // 1. Shape every record once, and drop the filtered ones without a query.
  var rows = [];
  var filtered = 0;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var eventType = scalar(pluck(item, source.event_type_path || 'event'))
      || scalar((req.headers || {})['x-event-type']);
    if (!accepts(source, eventType)) {
      countEvent(source.slug, eventType, 'dropped');
      filtered++;
      continue;
    }
    var itemRaw = JSON.stringify(item);
    rows.push({
      raw: itemRaw,
      hash: sha256(itemRaw),
      // Always recorded; only enforced when the mode says so. See storeOne.
      externalId: scalar(pluck(item, source.dedupe_path || 'id')) || scalar((req.headers || {})['x-event-id']),
      dedupeKey: mode === 'id'
        ? (dedupeId(pluck(item, source.dedupe_path || 'id')) || dedupeId((req.headers || {})['x-event-id']))
        : null,
      type: eventType,
      payload: itemRaw
    });
  }
  if (!rows.length) return { ids: [], fresh: [], duplicates: 0, filtered: filtered };

  var ids = [], fresh = [], duplicates = 0;

  // 2. Collapse repeats WITHIN this request before touching the database. A
  // partner that includes the same record twice in one array should not race
  // itself, and Postgres cannot resolve an in-statement conflict for us.
  var withId = [], withoutId = [], seenId = {}, seenHash = {};
  rows.forEach(function (r) {
    if (r.dedupeKey) {
      if (seenId[r.dedupeKey]) { duplicates++; countEvent(source.slug, r.type, 'duplicate'); return; }
      seenId[r.dedupeKey] = true;
      withId.push(r);
    } else {
      // With duplicate checking off, nothing is collapsed - not even bytes that
      // repeat inside the same request. That is the whole point of 'off'.
      if (mode !== 'off') {
        if (seenHash[r.hash]) { duplicates++; countEvent(source.slug, r.type, 'duplicate'); return; }
        seenHash[r.hash] = true;
      }
      withoutId.push(r);
    }
  });

  // 3. Records carrying an id: one INSERT per chunk. Whatever comes back is
  // new; whatever does not was already here.
  for (var c = 0; c < withId.length; c += INSERT_CHUNK) {
    var chunk = withId.slice(c, c + INSERT_CHUNK);
    var vals = [], params = [];
    chunk.forEach(function (r, n) {
      var b = n * 10;
      vals.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) +
        ',$' + (b + 6) + ',$' + (b + 7) + ',$' + (b + 8) + ',$' + (b + 9) + ",'pending',NOW(),$" + (b + 10) + ')');
      params.push(source.slug, r.type, r.externalId, r.dedupeKey, r.hash, r.payload, r.raw, hdrs, ip, sigNote || null);
    });
    var ins = await pool.query(
      'INSERT INTO webhook_events (source_slug, event_type, external_id, dedupe_key, body_hash, payload, raw_body, headers, ip, status, next_attempt_at, sig_state) ' +
      'VALUES ' + vals.join(',') + ' ' +
      'ON CONFLICT (source_slug, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING ' +
      'RETURNING id, dedupe_key',
      params
    );
    var got = {};
    ins.rows.forEach(function (row) { got[row.dedupe_key] = Number(row.id); });
    chunk.forEach(function (r) {
      if (got[r.dedupeKey] !== undefined) {
        ids.push(got[r.dedupeKey]);
        fresh.push(got[r.dedupeKey]);
        countEvent(source.slug, r.type, 'stored');
      } else {
        duplicates++;
        countEvent(source.slug, r.type, 'duplicate');
      }
    });
  }

  // 4. Records with no id of their own: ONE lookup for the whole set rather
  // than one per record, then insert the survivors.
  if (withoutId.length) {
    var toInsert = [];
    if (mode === 'off') {
      toInsert = withoutId;                 // no lookup at all
    } else {
      var hashes = withoutId.map(function (r) { return r.hash; });
      var prior = await pool.query(
        'SELECT DISTINCT body_hash FROM webhook_events WHERE source_slug = $1 AND body_hash = ANY($2::text[]) ' +
        "AND received_at > NOW() - ($3::bigint * INTERVAL '1 millisecond')",
        [source.slug, hashes, BLIND_DEDUPE_MS]
      );
      var seen = {};
      prior.rows.forEach(function (row) { seen[row.body_hash] = true; });
      withoutId.forEach(function (r) {
        if (seen[r.hash]) { duplicates++; countEvent(source.slug, r.type, 'duplicate'); }
        else toInsert.push(r);
      });
    }

    for (var c2 = 0; c2 < toInsert.length; c2 += INSERT_CHUNK) {
      var chunk2 = toInsert.slice(c2, c2 + INSERT_CHUNK);
      var vals2 = [], params2 = [];
      chunk2.forEach(function (r, n) {
        var b2 = n * 9;
        vals2.push('($' + (b2 + 1) + ',$' + (b2 + 2) + ',$' + (b2 + 3) + ',NULL,$' + (b2 + 4) + ',$' + (b2 + 5) +
          ',$' + (b2 + 6) + ',$' + (b2 + 7) + ',$' + (b2 + 8) + ",'pending',NOW(),$" + (b2 + 9) + ')');
        params2.push(source.slug, r.type, r.externalId, r.hash, r.payload, r.raw, hdrs, ip, sigNote || null);
      });
      var ins2 = await pool.query(
        'INSERT INTO webhook_events (source_slug, event_type, external_id, dedupe_key, body_hash, payload, raw_body, headers, ip, status, next_attempt_at, sig_state) ' +
        'VALUES ' + vals2.join(',') + ' RETURNING id',
        params2
      );
      ins2.rows.forEach(function (row, n) {
        ids.push(Number(row.id));
        fresh.push(Number(row.id));
        countEvent(source.slug, chunk2[n] ? chunk2[n].type : null, 'stored');
      });
    }
  }

  return { ids: ids, fresh: fresh, duplicates: duplicates, filtered: filtered };
}

// Turn a raw request into one or more stored webhook_events rows.
//
// Returns one of:
//   { ok: true,  id, duplicate }                        single object
//   { ok: true,  batch: true, accepted, duplicates, ids, fresh }
//   { ok: false, status, error, detail }                caller sends that status
//
// A TOP-LEVEL ARRAY IS SPLIT INTO ONE EVENT PER ELEMENT rather than stored as a
// single blob. Three reasons, all of which show up the first time a partner
// sends a batch of 200:
//
//   * dedupe is per record, so a resent batch that overlaps an earlier one by
//     190 records stores 10, not 200 duplicates.
//   * a retry re-runs only the records that failed, instead of reprocessing the
//     190 that already succeeded.
//   * one malformed record cannot hold the other 199 hostage.
//
// The cost is that raw_body for a batched record is the re-serialized element,
// not the original request bytes. Everything inside the element is preserved
// exactly; only the surrounding whitespace and array brackets are lost.
//
// Nothing in here interprets the payload beyond parsing the JSON and reading
// two optional paths out of it. Interpretation is the handler's job.
async function receive(req, slug) {
  var source = await loadSource(slug);
  if (!source) {
    // Deliberately the same shape and status as a bad token. An unauthenticated
    // caller must not be able to enumerate which sources exist.
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  var presented = presentedSecret(req, source);
  if (!presented || !hashEquals(sha256(presented), source.secret_hash)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  if (!source.enabled) {
    // Authenticated, so it is safe to be specific. 503 rather than 403 because
    // this is a temporary state and a well-behaved syncer should retry.
    return { ok: false, status: 503, error: 'source_disabled', detail: 'This sync source is turned off in Nova.' };
  }

  var raw = req.body;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  else if (typeof raw !== 'string') raw = raw ? JSON.stringify(raw) : '';

  if (!raw) return { ok: false, status: 400, error: 'empty_body' };
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large', detail: 'Limit is ' + MAX_BODY_BYTES + ' bytes.' };
  }

  // Signature is checked over the RAW REQUEST, before the array split, because
  // that is what the partner signed. Every record produced from this request
  // therefore carries the same verdict.
  var sig = verifySignature(source, req, raw);
  var mode = String(source.hmac_mode || 'off');
  if (mode === 'require' && sig.state !== 'ok') {
    // Deliberately terse to the caller and detailed in the log. A signature
    // oracle that explains exactly which part was wrong is a gift to whoever is
    // probing it; the admin can read the real reason in the Nova log.
    console.warn('[sync] ' + source.slug + ' signature rejected: ' + sig.state + (sig.detail ? ' - ' + sig.detail : ''));
    return { ok: false, status: 401, error: 'bad_signature' };
  }
  if (mode === 'observe' && sig.state !== 'ok') {
    // The whole point of observe: say what would have happened, keep taking the
    // data. This is the same two-stage rollout server.js uses for CORS_STRICT.
    console.warn('[sync] ' + source.slug + ' signature would have been REJECTED (observe mode): ' +
      sig.state + (sig.detail ? ' - ' + sig.detail : ''));
  }
  // NULL rather than 'off' for a source that does not sign. Stamping every row
  // of every unsigned source with a constant would make the sig_state column
  // useless for the one query it exists to answer.
  var sigNote = sig.state === 'off' ? null : (sig.state === 'ok' ? ('ok:' + sig.format) : sig.state);

  var payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    // Never a retry. Sending the same malformed bytes again will fail the same
    // way, so say so plainly instead of letting a syncer loop on it.
    return { ok: false, status: 400, error: 'invalid_json', detail: e.message };
  }

  if (Array.isArray(payload)) {
    // An empty array is a well-formed "nothing changed". Answer cleanly rather
    // than making the partner wonder whether we choked.
    if (!payload.length) {
      await touchSource(source.slug);
      return { ok: true, batch: true, accepted: 0, duplicates: 0, filtered: 0, ids: [], fresh: [], signature: sigNote };
    }
    if (payload.length > MAX_BATCH) {
      return { ok: false, status: 413, error: 'batch_too_large', detail: 'Limit is ' + MAX_BATCH + ' records per POST.' };
    }
    // Validated BEFORE anything is stored, so a batch is all-or-nothing at the
    // door. Half-storing a batch and returning 400 is the worst of both: the
    // partner retries and we get partial duplicates of a request we rejected.
    for (var v = 0; v < payload.length; v++) {
      var it = payload[v];
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        return { ok: false, status: 400, error: 'invalid_batch_item', detail: 'Element ' + v + ' is not a JSON object.' };
      }
    }
    var many = await storeMany(source, req, payload, sigNote);
    await touchSource(source.slug);
    return { ok: true, batch: true, accepted: many.ids.length, duplicates: many.duplicates,
      filtered: many.filtered, ids: many.ids, fresh: many.fresh, signature: sigNote };
  }

  if (typeof payload !== 'object' || payload === null) {
    // A bare string, number or null parsed fine but carries nothing we could
    // ever route. Permanent, so say 400 rather than let a syncer loop on it.
    return { ok: false, status: 400, error: 'invalid_payload', detail: 'Body must be a JSON object or an array of objects.' };
  }

  var single = await storeOne(source, req, raw, payload, sigNote);
  await touchSource(source.slug);
  // A filtered record is a SUCCESS, not an error. Anything that looks like a
  // failure would make a well-behaved syncer retry the very traffic we just
  // said we did not want, forever.
  return { ok: true, id: single.id, duplicate: single.duplicate, filtered: !!single.filtered, signature: sigNote };
}

async function touchSource(slug) {
  try {
    await pool.query('UPDATE webhook_sources SET last_event_at = NOW() WHERE slug = $1', [slug]);
  } catch (e) { /* a stats column is never worth failing a delivery over */ }
}

/* ------------------------------------------------------------------ process */

// Claim one pending event and run its handler.
//
// The claim is a conditional UPDATE, so two workers (the inline call after a
// delivery and the cron sweep) cannot both take the same row. Everything that
// follows is therefore single-owner.
async function runEvent(id) {
  // next_attempt_at doubles as a LEASE while the row is 'processing'. If this
  // process dies inside a handler the row would otherwise sit in 'processing'
  // forever, invisible to both the inline path and the sweep - the one failure
  // mode a retry queue must not have. runDue reclaims any expired lease, so a
  // crash costs STUCK_LEASE_MS, not the event.
  var claim = await pool.query(
    "UPDATE webhook_events SET status = 'processing', attempts = attempts + 1, " +
    "next_attempt_at = NOW() + ($2::bigint * INTERVAL '1 millisecond') " +
    "WHERE id = $1 AND status IN ('pending','failed') RETURNING *",
    [id, STUCK_LEASE_MS]
  );
  if (!claim.rows.length) return { claimed: false };
  var ev = claim.rows[0];

  var handlers = require('./webhookHandlers');
  var src = await loadSource(ev.source_slug);
  var name = (src && src.handler) || ev.source_slug;
  var fn = handlers.get(name);

  // No handler yet is a normal state, not an error: the endpoint goes live
  // first so the partner can start sending, and the mapping is written against
  // real payloads afterwards. 'parked' rows are exactly the ones to replay
  // once that mapping exists.
  if (!fn) {
    await pool.query(
      "UPDATE webhook_events SET status = 'parked', processed_at = NOW(), next_attempt_at = NULL, " +
      'last_error = $2 WHERE id = $1',
      [ev.id, 'No handler registered for "' + name + '". Payload stored; replay after adding one.']
    );
    return { claimed: true, status: 'parked' };
  }

  try {
    var result = await fn(ev, { pool: pool });
    var note = result && result.note ? String(result.note).slice(0, 2000) : null;
    var skipped = !!(result && result.skip);
    await pool.query(
      'UPDATE webhook_events SET status = $2, processed_at = NOW(), next_attempt_at = NULL, last_error = $3 WHERE id = $1',
      [ev.id, skipped ? 'skipped' : 'done', note]
    );
    return { claimed: true, status: skipped ? 'skipped' : 'done' };
  } catch (err) {
    // The claim's RETURNING * already carries the incremented value, so this is
    // the attempt that just failed - do NOT add one here. Getting that wrong
    // silently skips the first backoff step and dead-letters an event one
    // attempt early.
    var attempts = Number(ev.attempts);
    var permanent = !!err.permanent || attempts > BACKOFF_MS.length;
    var wait = permanent ? null : BACKOFF_MS[attempts - 1];
    await pool.query(
      'UPDATE webhook_events SET status = $2, last_error = $3, next_attempt_at = ' +
      (permanent ? 'NULL' : "NOW() + ($4::bigint * INTERVAL '1 millisecond')") +
      ' WHERE id = $1',
      permanent
        ? [ev.id, 'failed', String(err.message || err).slice(0, 4000)]
        : [ev.id, 'failed', String(err.message || err).slice(0, 4000), wait]
    );
    console.error('[sync] ' + ev.source_slug + ' event ' + ev.id + ' attempt ' + attempts +
      (permanent ? ' FAILED PERMANENTLY: ' : ' failed, retrying: ') + (err.message || err));
    return { claimed: true, status: 'failed', permanent: permanent };
  }
}

// Fire-and-forget processing right after a delivery. Wrapped so a throw can
// never surface on the HTTP response we have already sent.
function runEventDetached(id) {
  setImmediate(function () {
    runEvent(id).catch(function (e) {
      console.error('[sync] detached processing crashed for event ' + id + ': ' + (e && e.message));
    });
  });
}

// Drain a batch of freshly stored events with a small amount of concurrency.
// Detached on purpose: the HTTP response has already gone out, and nothing here
// may surface on it. Anything this misses is still 'pending' with a
// next_attempt_at in the past, so runDue() collects it.
var BATCH_CONCURRENCY = Number(process.env.SYNC_BATCH_CONCURRENCY || 4);

function runBatchDetached(ids) {
  if (!ids || !ids.length) return;
  var queue = ids.slice();
  var workers = Math.min(BATCH_CONCURRENCY, queue.length);
  for (var w = 0; w < workers; w++) {
    setImmediate(async function drain() {
      while (queue.length) {
        var id = queue.shift();
        try { await runEvent(id); }
        catch (e) { console.error('[sync] batch processing failed for event ' + id + ': ' + (e && e.message)); }
      }
    });
  }
}

// The cron sweep: everything whose retry time has come, plus anything that was
// stored but never picked up (a crash between the INSERT and the setImmediate).
async function runDue(limit) {
  var cap = Number(limit) || 50;

  // Reclaim abandoned leases first, so they are in the pending set below rather
  // than waiting another whole minute.
  var stuck = await pool.query(
    "UPDATE webhook_events SET status = 'pending' " +
    "WHERE status = 'processing' AND next_attempt_at IS NOT NULL AND next_attempt_at <= NOW() RETURNING id"
  );
  if (stuck.rows.length) {
    console.warn('[sync] reclaimed ' + stuck.rows.length + ' event(s) abandoned mid-processing');
  }

  var r = await pool.query(
    "SELECT id FROM webhook_events WHERE status IN ('pending','failed') " +
    'AND next_attempt_at IS NOT NULL AND next_attempt_at <= NOW() ORDER BY id ASC LIMIT $1',
    [cap]
  );
  var done = 0;
  for (var i = 0; i < r.rows.length; i++) {
    try {
      var out = await runEvent(r.rows[i].id);
      if (out.claimed) done++;
    } catch (e) {
      console.error('[sync] runDue error on event ' + r.rows[i].id + ': ' + (e && e.message));
    }
  }
  return { considered: r.rows.length, processed: done };
}

// A row that has been dead-lettered has next_attempt_at NULL, so runDue will
// never look at it again. This is what the Replay button calls.
async function replay(id) {
  await pool.query(
    "UPDATE webhook_events SET status = 'pending', next_attempt_at = NOW(), last_error = NULL WHERE id = $1",
    [id]
  );
  return runEvent(id);
}

module.exports = {
  receive: receive,
  runEvent: runEvent,
  runEventDetached: runEventDetached,
  runBatchDetached: runBatchDetached,
  runDue: runDue,
  replay: replay,
  loadSource: loadSource,
  cacheBust: cacheBust,
  accepts: accepts,
  storeMany: storeMany,
  INSERT_CHUNK: INSERT_CHUNK,
  verifySignature: verifySignature,
  sealSecret: sealSecret,
  openSecret: openSecret,
  sboxReady: sboxReady,
  HMAC_FORMATS: HMAC_FORMATS,
  countEvent: countEvent,
  flushStats: flushStats,
  newSecret: newSecret,
  sha256: sha256,
  pluck: pluck,
  dedupeId: dedupeId,
  dedupeMode: dedupeMode,
  presentedSecret: presentedSecret,
  MAX_BODY_BYTES: MAX_BODY_BYTES,
  MAX_BATCH: MAX_BATCH,
  BACKOFF_MS: BACKOFF_MS
};
