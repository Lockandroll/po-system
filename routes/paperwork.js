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
const DELIVER = require('../utils/paperworkDeliver');

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

// GET /api/paperwork/job/:id/pdf?kind=signoff|invoice&ref=<sheet or invoice id>
// The exact PDF the email would attach, built by the send path itself.
router.get('/job/:id/pdf', requireAuth, requirePermission('view_completion_paperwork'), async function (req, res) {
  try {
    const kind = String(req.query.kind || '');
    if (kind !== 'signoff' && kind !== 'invoice') return res.status(400).json({ error: 'Unknown attachment' });
    const out = await DELIVER.buildOnePdf(parseInt(req.params.id, 10), kind, req.query.ref);
    if (!out) return res.status(404).json({ error: 'That PDF could not be built for this job' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + out.filename.replace(/"/g, '') + '"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.buffer);
  } catch (e) { console.error('paperwork pdf failed:', e && e.message); res.status(500).json({ error: 'Could not build the PDF' }); }
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
    if (job.account && job.account.delivery === 'portal') return res.status(400).json({ error: 'This account takes paperwork through its portal, so it never goes in the email batch. Upload it there, then click Submitted in portal.' });
    const overrides = (req.body && req.body.overrides) ? req.body.overrides : null;
    // COALESCE: marking ready must not wipe recipients set per job with Edit
    // recipients. Before 2026-09-24 this overwrote them with NULL.
    await pool.query(
      "UPDATE work_orders SET paperwork_state = 'ready', paperwork_ready_by = $2, paperwork_ready_at = NOW(), paperwork_last_error = NULL, paperwork_overrides = COALESCE($3::jsonb, paperwork_overrides) " +
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
    // A SENT job can be put back too (Tony 2026-09-24: a test send). That needs
    // manage_completion_paperwork, not just send, because it rewinds the work
    // order from paperwork_sent to job_completed. It does NOT unsend anything:
    // the email already went out, and its paperwork_sends row stays as history.
    const cur = (await pool.query('SELECT paperwork_state, status FROM work_orders WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Job not found' });
    const wasSent = cur.paperwork_state === 'sent' || cur.status === 'paperwork_sent';
    if (wasSent) {
      const perms = require('../utils/permissions');
      const ep = (req._userRow && Array.isArray(req._userRow.extra_perms)) ? req._userRow.extra_perms : [];
      const ok = (await perms.hasPermission(req.user.role, 'manage_completion_paperwork')) || ep.indexOf('manage_completion_paperwork') !== -1;
      if (!ok) return res.status(403).json({ error: 'Only a Completion Paperwork manager can reopen a sent job.' });
      await pool.query(
        "UPDATE work_orders SET paperwork_state = 'none', paperwork_ready_by = NULL, paperwork_ready_at = NULL, paperwork_sent_at = NULL, paperwork_last_error = NULL, " +
        "status = CASE WHEN status = 'paperwork_sent' THEN 'job_completed' ELSE status END, updated_at = NOW() WHERE id = $1", [id]);
      // The billed date goes with it, so A/R does not age an invoice from a
      // send that was taken back; the next real send stamps it again.
      try {
        const j0 = await QUEUE.getJob(id);
        if (j0 && j0.job && j0.job.invoice_id) await pool.query('UPDATE invoices SET billed_at = NULL, billed_via = NULL WHERE id = $1', [j0.job.invoice_id]);
      } catch (e) {}
    } else {
      await pool.query("UPDATE work_orders SET paperwork_state = 'none', paperwork_ready_by = NULL, paperwork_ready_at = NULL WHERE id = $1 AND paperwork_state IN ('ready','held','failed')", [id]);
    }
    try { await logAudit({ entity_type: 'paperwork', entity_id: id, action: wasSent ? 'reopened_after_send' : 'reset', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json((await QUEUE.getJob(id)) || { ok: true });
  } catch (e) { console.error('paperwork reset failed:', e && e.message); res.status(500).json({ error: 'Could not reset' }); }
});

// POST /api/paperwork/job/:id/send-now - send one job immediately (skip the batch).
router.post('/job/:id/send-now', requireAuth, requirePermission('send_completion_paperwork'), async function (req, res) {
  try {
    const out = await DELIVER.sendJob(parseInt(req.params.id, 10), { actor: { id: req.user.id, name: req.user.name } });
    if (out.ok) res.json(out); else res.status(out.skipped ? 409 : 400).json(out);
  } catch (e) { console.error('paperwork send-now failed:', e && e.message); res.status(500).json({ error: 'Could not send' }); }
});

// PUT /api/paperwork/job/:id/recipients - change To / Cc for THIS job only
// (Tony 2026-09-24). body { to, cc } (comma strings or arrays) or { clear: true }
// to go back to the account's saved recipients. Stored in paperwork_overrides
// next to any attach overrides, and read by both the review screen and the send.
router.put('/job/:id/recipients', requireAuth, requirePermission('send_completion_paperwork'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = (await pool.query('SELECT paperwork_state, paperwork_overrides FROM work_orders WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Job not found' });
    if (['none', 'ready', 'held', 'failed'].indexOf(cur.paperwork_state) === -1) return res.status(409).json({ error: 'This job has already gone out. Use Resend to send it somewhere else.' });
    const ov = Object.assign({}, cur.paperwork_overrides || {});
    const b = req.body || {};
    if (b.clear) { delete ov.to; delete ov.cc; }
    else {
      const to = SET.cleanEmails(b.to);
      if (!to.length) return res.status(400).json({ error: 'Enter at least one To address' });
      ov.to = to;
      ov.cc = SET.cleanEmails(b.cc);
    }
    const store = Object.keys(ov).length ? JSON.stringify(ov) : null;
    await pool.query('UPDATE work_orders SET paperwork_overrides = $2::jsonb WHERE id = $1', [id, store]);
    try { await logAudit({ entity_type: 'paperwork', entity_id: id, action: b.clear ? 'recipients_reset' : 'recipients_changed', user_id: req.user.id, user_name: req.user.name, details: b.clear ? {} : { to: ov.to, cc: ov.cc } }); } catch (e) {}
    res.json(await QUEUE.getJob(id));
  } catch (e) { console.error('paperwork recipients failed:', e && e.message); res.status(500).json({ error: 'Could not save recipients' }); }
});

// POST /api/paperwork/job/:id/resend - same package to another address (Sent tab).
router.post('/job/:id/resend', requireAuth, requirePermission('send_completion_paperwork'), async function (req, res) {
  try {
    const b = req.body || {};
    const out = await DELIVER.resendJob(parseInt(req.params.id, 10), { to: b.to, cc: b.cc, actor: { id: req.user.id, name: req.user.name } });
    if (out.ok) res.json(out); else res.status(400).json(out);
  } catch (e) { console.error('paperwork resend failed:', e && e.message); res.status(500).json({ error: 'Could not resend' }); }
});

// POST /api/paperwork/job/:id/portal-submitted - the liaison uploaded it in the
// account's portal. body { ref } (optional confirmation #).
router.post('/job/:id/portal-submitted', requireAuth, requirePermission('send_completion_paperwork'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const out = await DELIVER.markPortalSubmitted(id, { ref: (req.body || {}).ref, actor: { id: req.user.id, name: req.user.name } });
    if (!out.ok) return res.status(out.skipped ? 409 : 400).json(out);
    res.json(await QUEUE.getJob(id));
  } catch (e) { console.error('paperwork portal-submitted failed:', e && e.message); res.status(500).json({ error: 'Could not record the submission' }); }
});

// POST /api/paperwork/stale-check - preview (body.dry_run) or send the stale
// digest now, from the Settings card.
router.post('/stale-check', requireAuth, requirePermission('manage_completion_paperwork'), async function (req, res) {
  try { res.json(await DELIVER.staleDigest({ dryRun: !!(req.body && req.body.dry_run) })); }
  catch (e) { console.error('paperwork stale-check failed:', e && e.message); res.status(500).json({ error: 'Could not run the check' }); }
});

// POST /api/paperwork/run-now - run the whole batch now (every job marked Ready).
router.post('/run-now', requireAuth, requirePermission('manage_completion_paperwork'), async function (req, res) {
  try { res.json(await DELIVER.runBatch({ triggeredBy: 'manual' })); }
  catch (e) { console.error('paperwork run-now failed:', e && e.message); res.status(500).json({ error: 'Could not run the batch' }); }
});

// POST /api/paperwork/dry-run - build without sending (one job with body.work_order_id, else the batch).
router.post('/dry-run', requireAuth, requirePermission('manage_completion_paperwork'), async function (req, res) {
  try {
    if (req.body && req.body.work_order_id) res.json(await DELIVER.sendJob(parseInt(req.body.work_order_id, 10), { dryRun: true }));
    else res.json(await DELIVER.runBatch({ triggeredBy: 'manual', dryRun: true }));
  } catch (e) { console.error('paperwork dry-run failed:', e && e.message); res.status(500).json({ error: 'Could not dry-run' }); }
});

// GET /api/paperwork/run-status - last-run summary for the Settings card.
router.get('/run-status', requireAuth, requirePermission('manage_completion_paperwork'), async function (req, res) {
  try {
    const last = await SET.get('completion_last_run_date', '');
    const recent = (await pool.query("SELECT id, work_order_id, status, subject, created_at FROM paperwork_sends ORDER BY id DESC LIMIT 10")).rows;
    const today = (await pool.query("SELECT COUNT(*) FILTER (WHERE status='sent') AS sent, COUNT(*) FILTER (WHERE status='failed') AS failed FROM paperwork_sends WHERE created_at::date = NOW()::date")).rows[0];
    res.json({ last_run_date: last, today: today, recent: recent });
  } catch (e) { console.error('paperwork run-status failed:', e && e.message); res.status(500).json({ error: 'Could not load status' }); }
});

module.exports = router;
