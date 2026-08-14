'use strict';
/*
 * Outbound Pulsar control surface.  /api/pulsar-out
 * ------------------------------------------------
 * The admin side of utils/pulsarOut.js. Four things live here:
 *
 *   GET  /status          what is configured and what is armed (no secrets)
 *   GET  /calls           the outbound call log
 *   POST /actions/:name   run one of the known actions
 *   POST /probe           send an arbitrary request to any of the three URLs
 *
 * /probe is the unusual one and it is here on purpose. Pulsar's published docs
 * cover five endpoints and describe two of them as drafts, so there will be
 * things we need to try that the registry does not know about. The alternative
 * to a probe screen is a redeploy per guess, and a redeploy per guess means the
 * person who finds the answer is whoever has the patience for twenty deploys
 * rather than whoever knows the system.
 *
 * Every route below requires pulsar_write, which is separate from manage_sync.
 * Reading someone else's events and CHANGING someone else's dispatch board are
 * not the same privilege and should not be the same permission.
 *
 * NOTE: no backtick characters anywhere in this file (Windows-safe per the Nova
 * editing rules).
 */

var express = require('express');
var { pool } = require('../db');
var { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
var out = require('../utils/pulsarOut');

var router = express.Router();

function who(req) {
  return {
    user_id: req.user && req.user.id,
    user_name: (req.user && (req.user.name || req.user.email)) || 'unknown',
    ip: req.ip
  };
}

// --------------------------------------------------------------------- status
// Deliberately readable by view_sync: knowing whether the integration is armed
// is operational information, and it contains nothing sensitive.
router.get('/status', requireAuth, requirePermission('view_sync'), function (req, res) {
  res.json(Object.assign({ ok: true }, out.status()));
});

// ----------------------------------------------------------------- call log
router.get('/calls', requireAuth, requirePermission('view_sync'), async function (req, res) {
  var limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  var where = [];
  var args = [];
  if (req.query.status) { args.push(String(req.query.status)); where.push('status = $' + args.length); }
  if (req.query.action) { args.push(String(req.query.action)); where.push('action = $' + args.length); }
  var sql = 'SELECT id, target, action, params, request_shape, request_url, request_body, mode, status, ' +
            'http_status, response_body, error, attempts, next_attempt_at, duration_ms, user_name, ' +
            'correlation, created_at, finished_at FROM outbound_calls' +
            (where.length ? ' WHERE ' + where.join(' AND ') : '') +
            ' ORDER BY id DESC LIMIT ' + limit;
  var r = await pool.query(sql, args);
  res.json({ ok: true, calls: r.rows });
});

// --------------------------------------------------------------------- action
// The normal path. The action must exist in the registry, its required
// parameters must be present, and in live mode it must either be verified or
// the caller must have ticked "send it anyway".
router.post('/actions/:name', requireAuth, requirePermission('pulsar_write'), async function (req, res) {
  var body = req.body || {};
  var result = await out.call(String(req.params.name), body.params || {}, Object.assign(who(req), {
    force: body.force === true,
    correlation: body.correlation || null
  }));
  // A refusal by our own guards is a 400 - the caller asked for something we
  // will not do. A refusal by Pulsar is a 200 carrying ok:false, because the
  // request was fine and the answer is the answer.
  if (result.blocked) return res.status(400).json(result);
  res.json(result);
});

// ---------------------------------------------------------------------- probe
// Discovery. Admin-only rather than pulsar_write, because it will send any
// action name to any URL with our credentials attached, and that is a bigger
// gun than "accept this digital".
router.post('/probe', requireAuth, requireRole('admin'), async function (req, res) {
  var b = req.body || {};
  if (!b.action) return res.status(400).json({ ok: false, error: 'An action name is required. If you do not know one yet, try the API with no action and read the complaint.' });
  var result = await out.probe(Object.assign({}, b, who(req)));
  res.json(result);
});

// --------------------------------------------------------------------- resend
// Re-run a logged call. Uses the STORED parameters, not a fresh copy of
// whatever the caller sends now, so "resend #12" means the same thing tomorrow
// as it does today.
router.post('/calls/:id/resend', requireAuth, requirePermission('pulsar_write'), async function (req, res) {
  var r = await pool.query('SELECT * FROM outbound_calls WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
  if (!r.rows.length) return res.status(404).json({ ok: false, error: 'No such call.' });
  var row = r.rows[0];
  var p = row.params;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
  var result = await out.call(row.action, p || {}, Object.assign(who(req), {
    force: true,
    correlation: 'resend:' + row.id
  }));
  res.json(result);
});

module.exports = router;
