'use strict';
/*
 * Inbound sync: the public receiver + the admin screens behind it.
 * ----------------------------------------------------------------
 * Two routers, mounted separately in server.js, for the same reason
 * routes/inbound and routes/square are mounted early:
 *
 *   inboundRouter  ->  /api/sync/in/:slug   mounted BEFORE express.json()
 *   router         ->  /api/sync/...        mounted with everything else
 *
 * The receiver takes the body as a RAW Buffer. Two reasons, and the second one
 * is the one that bites later: the stored raw_body has to be the exact bytes
 * that arrived, or a hash-based dedupe drifts the moment a partner changes
 * their key order; and if any source ever moves to HMAC signing, the signature
 * is computed over raw bytes and express.json() will already have eaten them.
 *
 * The receiver is UNAUTHENTICATED in Nova's sense - no JWT, no user. Its access
 * control is the per-source shared secret checked in utils/webhookIngest.js. It
 * can do exactly one thing: append a row to webhook_events. It cannot touch any
 * other table. Whatever the payload eventually means is decided later, by a
 * handler, running as nobody.
 *
 * NOTE: no backtick characters anywhere in this file (Windows-safe per the Nova
 * editing rules).
 */

var express = require('express');
var { pool } = require('../db');
var { requireAuth, requirePermission } = require('../middleware/auth');
var { logAudit } = require('../utils/audit');
var ingest = require('../utils/webhookIngest');
var handlers = require('../utils/webhookHandlers');

/* =========================================================== public receiver */

var inboundRouter = express.Router();

// Accept any content-type. Partners send application/json, text/plain and the
// occasional application/x-www-form-urlencoded-with-a-JSON-body; all three are
// the same bytes to us, and rejecting on a header is a support ticket, not
// security.
inboundRouter.use(express.raw({ type: function () { return true; }, limit: ingest.MAX_BODY_BYTES }));

// A GET on the same URL so anyone (including the partner) can confirm they have
// the right address without sending data. It reveals nothing: no token check,
// no source lookup, no indication of whether that slug exists.
inboundRouter.get('/:slug', function (req, res) {
  res.json({
    ok: true,
    message: 'Nova sync endpoint. POST JSON here with your token in the X-Nova-Token header.',
    method: 'POST',
    content_type: 'application/json'
  });
});

inboundRouter.post('/:slug', async function (req, res) {
  var slug = String(req.params.slug || '').slice(0, 64);
  var out;
  try {
    out = await ingest.receive(req, slug);
  } catch (err) {
    // Our fault, and the one case where a partner SHOULD retry. Say 503 so a
    // well-behaved syncer requeues instead of dropping the event.
    console.error('[sync] receive failed for "' + slug + '": ' + (err && err.message));
    return res.status(503).json({ ok: false, error: 'nova_unavailable', detail: 'Could not store the event. Please retry.' });
  }

  if (!out.ok) {
    return res.status(out.status).json({ ok: false, error: out.error, detail: out.detail || undefined });
  }

  // Answer first, work second. The partner's syncer is on a timeout and a retry
  // queue; making it wait on our processing turns our slow query into their
  // duplicate delivery.
  //
  // 202 means "we stored something new", 200 means "we already had all of it".
  // Both are success; the distinction exists only so a partner can see whether
  // a retry actually did anything.
  if (out.batch) {
    res.status(out.fresh.length ? 202 : 200).json({
      ok: true,
      batch: true,
      accepted: out.accepted,
      duplicates: out.duplicates,
      filtered: out.filtered,
      ids: out.ids,
      received: true
    });
    out.fresh.forEach(function (id) { ingest.runEventDetached(id); });
    return;
  }

  res.status(out.duplicate ? 200 : 202).json({
    ok: true,
    id: out.id,
    duplicate: !!out.duplicate,
    filtered: !!out.filtered,
    received: true
  });

  if (!out.duplicate && out.id) ingest.runEventDetached(out.id);
});

/* ============================================================ admin surface */

var router = express.Router();

function scrub(row) {
  if (!row) return row;
  var o = Object.assign({}, row);
  delete o.secret_hash;   // never leaves the server, not even to an admin
  return o;
}

// accept_types is stored as a comma-separated string but is settable as either
// that or a JSON array, because whoever configures this is holding a list of
// numbers a partner pasted into a chat window, not a formatted string.
// An empty result becomes NULL, which means "accept everything" - so clearing
// the filter is one obvious action rather than a magic sentinel.
function normTypes(v) {
  if (v === null || v === undefined) return null;
  var parts = Array.isArray(v) ? v : String(v).split(',');
  var clean = parts.map(function (t) { return String(t).trim(); }).filter(Boolean);
  return clean.length ? clean.join(',') : null;
}

// Anything unrecognised falls back to 'off' rather than to enforcement. A typo
// in this field must never be the thing that starts rejecting a partner's
// traffic, and must never silently disable a check that WAS enforcing either -
// hence the explicit three-way.
function hmacMode(v) {
  var m = String(v || '').trim().toLowerCase();
  return (m === 'observe' || m === 'require') ? m : 'off';
}

function baseUrl(req) {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/+$/, '');
  var proto = String((req.headers['x-forwarded-proto'] || req.protocol || 'https')).split(',')[0].trim();
  return proto + '://' + req.get('host');
}

/* ------------------------------------------------------------------ sources */

router.get('/sources', requireAuth, requirePermission('view_sync'), async function (req, res) {
  var r = await pool.query(
    'SELECT s.id, s.slug, s.name, s.secret_hint, s.secret_header, s.handler, s.enabled, s.dedupe_path, s.event_type_path, s.accept_types, ' +
    's.hmac_mode, s.hmac_header, s.hmac_ts_header, s.hmac_format, s.hmac_max_skew_s, (s.hmac_secret_enc IS NOT NULL) AS hmac_key_set, ' +
    's.last_event_at, s.created_at, u.name AS created_by_name, ' +
    '(SELECT COUNT(*) FROM webhook_events e WHERE e.source_slug = s.slug) AS event_count, ' +
    "(SELECT COUNT(*) FROM webhook_events e WHERE e.source_slug = s.slug AND e.status = 'failed') AS failed_count, " +
    "(SELECT COUNT(*) FROM webhook_events e WHERE e.source_slug = s.slug AND e.status = 'parked') AS parked_count " +
    'FROM webhook_sources s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.slug'
  );
  res.json({
    sources: r.rows.map(function (row) {
      row.url = baseUrl(req) + '/api/sync/in/' + row.slug;
      row.handler_registered = !!handlers.get(row.handler || row.slug);
      return scrub(row);
    }),
    handlers: handlers.list(),
    // The UI needs to know whether signing can be turned on at all, because
    // without a server key the honest answer is "not until Railway has one"
    // rather than a form that silently fails to save.
    signing_available: ingest.sboxReady(),
    hmac_formats: ingest.HMAC_FORMATS.map(function (f) { return f.key; }).concat(['sha256(token+body)'])
  });
});

// Creating a source is the ONLY moment the token exists in plaintext anywhere.
// It is returned once, in this response, and then only its SHA-256 is kept. If
// it is lost, rotate; there is no recovery, by design.
router.post('/sources', requireAuth, requirePermission('manage_sync'), async function (req, res) {
  var slug = String(req.body.slug || '').trim().toLowerCase();
  var name = String(req.body.name || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(slug)) {
    return res.status(400).json({ error: 'Slug must be 2-64 characters: lowercase letters, numbers, dash or underscore.' });
  }
  if (!name) return res.status(400).json({ error: 'Name is required' });

  var exists = await pool.query('SELECT id FROM webhook_sources WHERE slug = $1', [slug]);
  if (exists.rows.length) return res.status(409).json({ error: 'A sync source with that slug already exists.' });

  // A partner who has already chosen the value wins. Duty picked Pulsar's token
  // and is not going to change it because we would rather generate one, so an
  // explicit token is accepted and only a missing one is generated.
  var supplied = String(req.body.token || '').trim();
  if (supplied && supplied.length < 12) {
    return res.status(400).json({ error: 'A supplied token must be at least 12 characters.' });
  }
  var secret = supplied || ingest.newSecret();

  var r = await pool.query(
    'INSERT INTO webhook_sources (slug, name, secret_hash, secret_hint, secret_header, handler, enabled, dedupe_path, event_type_path, accept_types, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
    [
      slug, name, ingest.sha256(secret), secret.slice(-4),
      String(req.body.secret_header || '').trim().toLowerCase() || null,
      String(req.body.handler || slug).trim() || slug,
      req.body.enabled === false ? false : true,
      String(req.body.dedupe_path || '').trim() || null,
      String(req.body.event_type_path || '').trim() || null,
      normTypes(req.body.accept_types),
      req.user.id
    ]
  );
  ingest.cacheBust(slug);

  await logAudit({
    entity_type: 'sync_source', entity_id: r.rows[0].id, entity_number: slug,
    action: 'created', user_id: req.user.id, user_name: req.user.name,
    details: { slug: slug, name: name }, ip: req.ip
  });

  res.status(201).json({
    id: r.rows[0].id,
    slug: slug,
    url: baseUrl(req) + '/api/sync/in/' + slug,
    header: String(req.body.secret_header || '').trim() || 'X-Nova-Token',
    token: secret,
    supplied: !!supplied,
    warning: supplied
      ? 'Stored. Nova keeps only a fingerprint of it, so keep your own copy.'
      : 'This token is shown once and is not recoverable. Copy it now.'
  });
});

router.put('/sources/:id', requireAuth, requirePermission('manage_sync'), async function (req, res) {
  var cur = await pool.query('SELECT * FROM webhook_sources WHERE id = $1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
  var s = cur.rows[0];

  // The slug is the URL the partner has already been given, so it is not
  // editable here. Renaming an integration means creating a new source.
  var name = req.body.name !== undefined ? String(req.body.name).trim() : s.name;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  var r = await pool.query(
    'UPDATE webhook_sources SET name = $2, handler = $3, enabled = $4, dedupe_path = $5, event_type_path = $6, accept_types = $7, ' +
    'secret_header = $8, hmac_mode = $9, hmac_header = $10, hmac_ts_header = $11, hmac_format = $12, hmac_max_skew_s = $13, updated_at = NOW() ' +
    'WHERE id = $1 RETURNING id, slug, name, handler, enabled, dedupe_path, event_type_path, accept_types, ' +
    'secret_header, hmac_mode, hmac_header, hmac_ts_header, hmac_format, hmac_max_skew_s',
    [
      s.id, name,
      req.body.handler !== undefined ? (String(req.body.handler).trim() || s.slug) : s.handler,
      req.body.enabled !== undefined ? !!req.body.enabled : s.enabled,
      req.body.dedupe_path !== undefined ? (String(req.body.dedupe_path).trim() || null) : s.dedupe_path,
      req.body.event_type_path !== undefined ? (String(req.body.event_type_path).trim() || null) : s.event_type_path,
      req.body.accept_types !== undefined ? normTypes(req.body.accept_types) : s.accept_types,
      req.body.secret_header !== undefined ? (String(req.body.secret_header).trim().toLowerCase() || null) : s.secret_header,
      req.body.hmac_mode !== undefined ? hmacMode(req.body.hmac_mode) : s.hmac_mode,
      req.body.hmac_header !== undefined ? (String(req.body.hmac_header).trim().toLowerCase() || null) : s.hmac_header,
      req.body.hmac_ts_header !== undefined ? (String(req.body.hmac_ts_header).trim().toLowerCase() || null) : s.hmac_ts_header,
      req.body.hmac_format !== undefined ? (String(req.body.hmac_format).trim() || null) : s.hmac_format,
      req.body.hmac_max_skew_s !== undefined ? Math.max(0, Number(req.body.hmac_max_skew_s) || 0) : s.hmac_max_skew_s
    ]
  );
  ingest.cacheBust(s.slug);

  await logAudit({
    entity_type: 'sync_source', entity_id: s.id, entity_number: s.slug,
    action: 'updated', user_id: req.user.id, user_name: req.user.name,
    details: { before: { name: s.name, handler: s.handler, enabled: s.enabled }, after: r.rows[0] }, ip: req.ip
  });
  res.json(scrub(r.rows[0]));
});

// Rotate rather than delete. The old token stops working the instant this
// returns; the partner gets the new one whenever they are ready. Events already
// received are untouched.
router.post('/sources/:id/rotate', requireAuth, requirePermission('manage_sync'), async function (req, res) {
  var cur = await pool.query('SELECT id, slug FROM webhook_sources WHERE id = $1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });

  var secret = ingest.newSecret();
  await pool.query(
    'UPDATE webhook_sources SET secret_hash = $2, secret_hint = $3, updated_at = NOW() WHERE id = $1',
    [cur.rows[0].id, ingest.sha256(secret), secret.slice(-4)]
  );
  ingest.cacheBust(cur.rows[0].slug);

  await logAudit({
    entity_type: 'sync_source', entity_id: cur.rows[0].id, entity_number: cur.rows[0].slug,
    action: 'token_rotated', user_id: req.user.id, user_name: req.user.name, ip: req.ip
  });

  res.json({
    slug: cur.rows[0].slug,
    url: baseUrl(req) + '/api/sync/in/' + cur.rows[0].slug,
    header: 'X-Nova-Token',
    token: secret,
    warning: 'The previous token stopped working immediately. This one is shown once.'
  });
});

// Deleting a source does NOT delete its events - the data a partner sent is
// still yours, and losing it because someone tidied up a config row would be
// the worst kind of surprise. Disable is almost always the right action.
router.delete('/sources/:id', requireAuth, requirePermission('manage_sync'), async function (req, res) {
  var cur = await pool.query('SELECT id, slug FROM webhook_sources WHERE id = $1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
  await pool.query('DELETE FROM webhook_sources WHERE id = $1', [cur.rows[0].id]);
  ingest.cacheBust(cur.rows[0].slug);
  await logAudit({
    entity_type: 'sync_source', entity_id: cur.rows[0].id, entity_number: cur.rows[0].slug,
    action: 'deleted', user_id: req.user.id, user_name: req.user.name,
    details: { note: 'Stored events were kept.' }, ip: req.ip
  });
  res.json({ success: true, events_kept: true });
});

// The signing key is WRITE ONLY. It is encrypted on the way in and never comes
// back out of the API - not to an admin, not in the source list. If it is lost,
// ask the partner for it again; that is a two-minute conversation and the
// alternative is an endpoint that hands out the key to whoever can read it.
router.put('/sources/:id/signing-key', requireAuth, requirePermission('manage_sync'), async function (req, res) {
  var cur = await pool.query('SELECT id, slug FROM webhook_sources WHERE id = $1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });

  var key = String(req.body.key === undefined || req.body.key === null ? '' : req.body.key);
  if (!key) {
    await pool.query("UPDATE webhook_sources SET hmac_secret_enc = NULL, hmac_mode = 'off', updated_at = NOW() WHERE id = $1", [cur.rows[0].id]);
    ingest.cacheBust(cur.rows[0].slug);
    await logAudit({
      entity_type: 'sync_source', entity_id: cur.rows[0].id, entity_number: cur.rows[0].slug,
      action: 'signing_key_cleared', user_id: req.user.id, user_name: req.user.name, ip: req.ip
    });
    return res.json({ success: true, key_set: false, note: 'Signature checking turned off with the key.' });
  }

  var sealed;
  try { sealed = ingest.sealSecret(key); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  await pool.query('UPDATE webhook_sources SET hmac_secret_enc = $2, updated_at = NOW() WHERE id = $1', [cur.rows[0].id, sealed]);
  ingest.cacheBust(cur.rows[0].slug);
  await logAudit({
    entity_type: 'sync_source', entity_id: cur.rows[0].id, entity_number: cur.rows[0].slug,
    action: 'signing_key_set', user_id: req.user.id, user_name: req.user.name,
    details: { length: key.length }, ip: req.ip
  });
  res.json({ success: true, key_set: true });
});

// Which signature formulations have actually been seen, per source. This is the
// observe-mode report: run it after some real traffic, confirm one value is
// winning consistently, pin that as hmac_format, then switch to require.
router.get('/signatures', requireAuth, requirePermission('view_sync'), async function (req, res) {
  var params = [];
  var where = 'WHERE sig_state IS NOT NULL ';
  if (req.query.source) { params.push(String(req.query.source)); where += 'AND source_slug = $1 '; }
  var r = await pool.query(
    'SELECT source_slug, sig_state, COUNT(*)::int AS n, MAX(received_at) AS last_seen ' +
    'FROM webhook_events ' + where + 'GROUP BY source_slug, sig_state ORDER BY n DESC',
    params
  );
  res.json({ verdicts: r.rows });
});

/* -------------------------------------------------------------------- stats */

// What is actually coming down the pipe, including everything the filter threw
// away. This is the screen you watch for a day before deciding what a firehose
// source should accept - the dropped column is the whole point, because a type
// you are not storing is otherwise invisible.
router.get('/stats', requireAuth, requirePermission('view_sync'), async function (req, res) {
  var params = [];
  var where = '';
  if (req.query.source) { params.push(String(req.query.source)); where = 'WHERE source_slug = $1 '; }
  var r = await pool.query(
    'SELECT source_slug, event_type, stored_count, dropped_count, first_seen, last_seen ' +
    'FROM webhook_event_stats ' + where +
    'ORDER BY (stored_count + dropped_count) DESC, event_type',
    params
  );
  res.json({
    types: r.rows,
    note: 'Counts are flushed from memory once a minute, so the newest deliveries may not be included yet.'
  });
});

/* ------------------------------------------------------------------- events */

router.get('/events', requireAuth, requirePermission('view_sync'), async function (req, res) {
  var where = [];
  var params = [];
  if (req.query.source) { params.push(String(req.query.source)); where.push('source_slug = $' + params.length); }
  if (req.query.status) { params.push(String(req.query.status)); where.push('status = $' + params.length); }
  if (req.query.q) {
    params.push('%' + String(req.query.q) + '%');
    where.push('(external_id ILIKE $' + params.length + ' OR event_type ILIKE $' + params.length + ' OR raw_body ILIKE $' + params.length + ')');
  }
  var limit = Math.min(Number(req.query.limit) || 100, 500);
  params.push(limit);

  // raw_body and payload are deliberately NOT in the list query. Some partners
  // send megabytes per event and a list screen must not drag that across the
  // wire; the detail route below returns them one at a time.
  var r = await pool.query(
    'SELECT id, source_slug, event_type, external_id, status, attempts, last_error, ' +
    'received_at, processed_at, next_attempt_at, ip, sig_state, LENGTH(raw_body) AS bytes ' +
    'FROM webhook_events ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY id DESC LIMIT $' + params.length,
    params
  );
  var counts = await pool.query('SELECT status, COUNT(*)::int AS n FROM webhook_events GROUP BY status');
  res.json({ events: r.rows, counts: counts.rows });
});

router.get('/events/:id', requireAuth, requirePermission('view_sync'), async function (req, res) {
  var r = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(r.rows[0]);
});

// Replay is how a 'parked' backlog becomes real data once a handler exists, and
// how a dead-lettered event gets another chance after the underlying bug is
// fixed. It re-runs the handler against the stored payload; nothing is re-sent
// by the partner and nothing is re-authenticated.
router.post('/events/:id/replay', requireAuth, requirePermission('manage_sync'), async function (req, res) {
  var r = await pool.query('SELECT id, source_slug, status FROM webhook_events WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  var out = await ingest.replay(r.rows[0].id);
  await logAudit({
    entity_type: 'sync_event', entity_id: r.rows[0].id, entity_number: String(r.rows[0].id),
    action: 'replayed', user_id: req.user.id, user_name: req.user.name,
    details: { source: r.rows[0].source_slug, was: r.rows[0].status, now: out.status }, ip: req.ip
  });
  res.json({ success: true, result: out });
});

// Bulk replay, for the ordinary case: a handler was just written and there are
// two hundred parked rows waiting for it. Capped per call so one click cannot
// hold a connection open for ten minutes.
router.post('/replay-batch', requireAuth, requirePermission('manage_sync'), async function (req, res) {
  var source = String(req.body.source || '').trim();
  var status = String(req.body.status || 'parked').trim();
  if (!source) return res.status(400).json({ error: 'source is required' });
  if (['parked', 'failed', 'skipped'].indexOf(status) === -1) {
    return res.status(400).json({ error: 'status must be parked, failed or skipped' });
  }
  var limit = Math.min(Number(req.body.limit) || 100, 500);

  var r = await pool.query(
    'SELECT id FROM webhook_events WHERE source_slug = $1 AND status = $2 ORDER BY id ASC LIMIT $3',
    [source, status, limit]
  );
  var results = { total: r.rows.length, done: 0, skipped: 0, failed: 0, parked: 0 };
  for (var i = 0; i < r.rows.length; i++) {
    try {
      var out = await ingest.replay(r.rows[i].id);
      if (out && results[out.status] !== undefined) results[out.status]++;
    } catch (e) { results.failed++; }
  }
  await logAudit({
    entity_type: 'sync_event', entity_number: source, action: 'replay_batch',
    user_id: req.user.id, user_name: req.user.name, details: { status: status, results: results }, ip: req.ip
  });
  res.json(results);
});

module.exports = router;
module.exports.inboundRouter = inboundRouter;
