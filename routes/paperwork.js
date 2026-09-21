'use strict';
// Completion Paperwork auto-send - API (Nova).
//
// PHASE 1 (this file today): the Settings card only - read and write the
// delivery knobs in utils/paperworkSettings.js. The queue, the job review /
// Mark Ready to Send, the send endpoints and the daily cron arrive in later
// phases; nothing here can email a customer.
//
// Gated by manage_completion_paperwork, which ships dark (admin/owner only
// until an admin grants it). See utils/permissions.js.
//
// NOTE: no backtick/template-literal strings (Windows-safe per Nova rules).

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const SET = require('../utils/paperworkSettings');
const { pool } = require('../db');
const { logAudit } = require('../utils/audit');
const QUEUE = require('../utils/paperworkQueue');

// GET /api/paperwork/settings - the delivery knobs for the Settings card.
router.get('/settings', requireAuth, requirePermission('manage_completion_paperwork'), async function (req, res) {
  try {
    res.json(await SET.getAll());
  } catch (e) {
    console.error('paperwork settings read failed:', e && e.message);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

// PUT /api/paperwork/settings - save the knobs the card sends. Only known keys
// are written, each coerced to shape.
router.put('/settings', requireAuth, requirePermission('manage_completion_paperwork'), async function (req, res) {
  try {
    const saved = await SET.saveAll(req.body || {});
    res.json(saved);
  } catch (e) {
    console.error('paperwork settings save failed:', e && e.message);
    res.status(500).json({ error: 'Could not save settings' });
  }
});

// GET /api/paperwork/queue - the four tabs (needs review / ready / sent / held).
router.get('/queue', requireAuth, requirePermission('view_completion_paperwork'), async function (req, res) {
  try { res.json(await QUEUE.listQueue()); }
  catch (e) { console.error('paperwork queue failed:', e && e.message); res.status(500).json({ error: 'Could not load the queue' }); }
});

// GET /api/paperwork/job/:id - one job for the review screen.
router.get('/job/:id', requireAuth, requirePermission('view_completion_paperwork'), async function (req, res) {
  try {
    const job = await QUEUE.getJob(parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (e) { console.error('paperwork job failed:', e && e.message); res.status(500).json({ error: 'Could not load the job' }); }
});

// PUT /api/paperwork/job/:id/ready - queue a job for the next batch. Gate: the
// job must be job_completed with a finished invoice. body.overrides (optional)
// is stored for the send: { to:[...], cc:[...], attach:{signoffs,invoice,photos} }.
router.put('/job/:id/ready', requireAuth, requirePermission('send_completion_paperwork'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const job = await QUEUE.getJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.job.readiness.ready) return res.status(400).json({ error: 'This job is not ready yet - it needs a finished invoice.' });
    const overrides = (req.body && req.body.overrides) ? req.body.overrides : null;
    await pool.query(
      "UPDATE work_orders SET paperwork_state = 'ready', paperwork_ready_by = $2, paperwork_ready_at = NOW(), paperwork_last_error = NULL, paperwork_overrides = $3 " +
      "WHERE id = $1 AND status = 'job_completed' AND paperwork_state IN ('none','held')",
      [id, req.user.id, overrides ? JSON.stringify(overrides) : null]);
    try { await logAudit({ entity_type: 'paperwork', entity_id: id, entity_number: String(job.job.po_number || id), action: 'marked_ready', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json(await QUEUE.getJob(id));
  } catch (e) { console.error('paperwork ready failed:', e && e.message); res.status(500).json({ error: 'Could not mark ready' }); }
});

// PUT /api/paperwork/job/:id/hold - park a job so the batch skips it.
router.put('/job/:id/hold', requireAuth, requirePermission('send_completion_paperwork'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query("UPDATE work_orders SET paperwork_state = 'held', paperwork_ready_at = NULL WHERE id = $1 AND paperwork_state IN ('none','ready','failed')", [id]);
    try { await logAudit({ entity_type: 'paperwork', entity_id: id, action: 'held', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json((await QUEUE.getJob(id)) || { ok: true });
  } catch (e) { console.error('paperwork hold failed:', e && e.message); res.status(500).json({ error: 'Could not hold' }); }
});

// PUT /api/paperwork/job/:id/reset - back to needs-review (un-hold / un-ready).
router.put('/job/:id/reset', requireAuth, requirePermission('send_completion_paperwork'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query("UPDATE work_orders SET paperwork_state = 'none', paperwork_ready_by = NULL, paperwork_ready_at = NULL WHERE id = $1 AND paperwork_state IN ('ready','held','failed')", [id]);
    try { await logAudit({ entity_type: 'paperwork', entity_id: id, action: 'reset', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json((await QUEUE.getJob(id)) || { ok: true });
  } catch (e) { console.error('paperwork reset failed:', e && e.message); res.status(500).json({ error: 'Could not reset' }); }
});

module.exports = router;
