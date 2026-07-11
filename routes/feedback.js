const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/feedbackIntake');
const r2 = require('../utils/r2');
const crypto = require('crypto');

const router = express.Router();

const STATUSES = ['new', 'complaint_pending', 'customer_contacted', 'in_progress', 'resolved', 'closed'];
const CLOSED_STATES = ['resolved', 'closed'];

// Non-admins are scoped to feedback for the cities they manage.
async function cityScope(user) {
  if (user.role === 'admin' || user.role === 'owner') return null; // null = no restriction
  try {
    const r = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [user.id]);
    return r.rows.map(function (x) { return x.city_code; });
  } catch (e) { return []; }
}

// Record that someone opened a complaint. Every open is logged - no dedupe.
// Owners are invisible (never logged). Deliberately does NOT touch
// last_interaction_at - a view is not an interaction with the customer.
async function logView(feedbackId, user) {
  try {
    if (!user || user.isOwner || user.role === 'owner') return;
    await pool.query(
      "INSERT INTO customer_feedback_activity (feedback_id, user_id, user_name, type, body) VALUES ($1,$2,$3,'view','viewed this complaint.')",
      [feedbackId, user.id, user.name]
    );
  } catch (e) { console.error('[feedback] logView:', e.message); }
}

// GET /api/feedback - filtered list.
router.get('/', requireAuth, requirePermission('view_feedback'), async function (req, res) {
  try {
    const where = [];
    const params = [];
    function add(clause, val) { params.push(val); where.push(clause.replace('$$', '$' + params.length)); }

    const scope = await cityScope(req.user);
    if (scope !== null) {
      if (!scope.length) return res.json({ feedback: [], total: 0 });
      params.push(scope); where.push('city_code = ANY($' + params.length + ')');
    }
    if (req.query.city) add('city_code = $$', req.query.city);
    if (req.query.category) add('category = $$', req.query.category);
    if (req.query.severity) add('severity = $$', req.query.severity);
    if (req.query.status) add('status = $$', req.query.status);
    if (req.query.tech) add('tech_user_id = $$', parseInt(req.query.tech, 10));
    if (req.query.resolved === 'true') where.push('is_resolved = true');
    if (req.query.resolved === 'false') where.push('is_resolved = false');
    if (req.query.from) add('received_at >= $$', req.query.from);
    if (req.query.to) add('received_at <= $$', req.query.to);
    if (req.query.search) { params.push('%' + req.query.search + '%'); where.push('(customer_name ILIKE $' + params.length + ' OR incident_text ILIKE $' + params.length + ')'); }

    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;

    const countRes = await pool.query('SELECT COUNT(*) FROM customer_feedback ' + whereSql, params);
    const listRes = await pool.query(
      'SELECT f.*, u.name AS assigned_name, t.name AS tech_name, c.name AS city_name ' +
      'FROM customer_feedback f ' +
      'LEFT JOIN users u ON u.id = f.assigned_to ' +
      'LEFT JOIN users t ON t.id = f.tech_user_id ' +
      'LEFT JOIN cities c ON c.code = f.city_code ' +
      whereSql + " ORDER BY (CASE WHEN f.status IN ('resolved','closed') THEN 1 ELSE 0 END) ASC, f.last_interaction_at DESC NULLS LAST LIMIT " + limit + ' OFFSET ' + offset,
      params
    );
    res.json({ feedback: listRes.rows, total: parseInt(countRes.rows[0].count, 10) });
  } catch (e) {
    console.error('GET /feedback:', e.message);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

// GET /api/feedback/:id - record + activity timeline.
router.get('/:id', requireAuth, requirePermission('view_feedback'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      'SELECT f.*, u.name AS assigned_name, t.name AS tech_name, c.name AS city_name ' +
      'FROM customer_feedback f ' +
      'LEFT JOIN users u ON u.id = f.assigned_to ' +
      'LEFT JOIN users t ON t.id = f.tech_user_id ' +
      'LEFT JOIN cities c ON c.code = f.city_code WHERE f.id = $1',
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const scope = await cityScope(req.user);
    if (scope !== null && scope.indexOf(r.rows[0].city_code) === -1) {
      return res.status(403).json({ error: 'Not in your cities' });
    }
    // Don't log views made while an admin is previewing as another user.
    if (!req.viewingAs) await logView(id, req.user);
    // View rows are admin/owner-only. Managers and below never see who opened a record
    // (they can't tell views are being tracked at all). Owner is coerced to 'admin' upstream.
    const seesViews = req.user.role === 'admin';
    const acts = await pool.query(
      'SELECT * FROM customer_feedback_activity WHERE feedback_id = $1' +
      (seesViews ? '' : " AND type <> 'view'") +
      ' ORDER BY created_at DESC',
      [id]
    );
    const atts = await pool.query("SELECT id, file_name, mime_type, size_bytes, uploaded_by_name, created_at FROM customer_feedback_attachments WHERE feedback_id = $1 AND status = 'ready' ORDER BY created_at DESC", [id]);
    res.json({ feedback: r.rows[0], activity: acts.rows, attachments: atts.rows, storageReady: r2.configured() });
  } catch (e) {
    console.error('GET /feedback/:id:', e.message);
    res.status(500).json({ error: 'Failed to load record' });
  }
});

// PATCH /api/feedback/:id - update lifecycle fields with the closing gate.
router.patch('/:id', requireAuth, requirePermission('manage_feedback'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query('SELECT * FROM customer_feedback WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const f = cur.rows[0];
    const b = req.body || {};

    // Resolve the post-update values to validate the closing gate.
    const next = {
      status: b.status !== undefined ? b.status : f.status,
      tech_user_id: b.tech_user_id !== undefined ? b.tech_user_id : f.tech_user_id,
      tech_at_fault: b.tech_at_fault !== undefined ? b.tech_at_fault : f.tech_at_fault,
      total_damages: b.total_damages !== undefined ? b.total_damages : f.total_damages,
      refunded: b.refunded !== undefined ? b.refunded : f.refunded,
      is_resolved: b.is_resolved !== undefined ? b.is_resolved : f.is_resolved
    };
    const closing = (b.is_resolved === true) || CLOSED_STATES.indexOf(next.status) !== -1;
    if (closing) {
      const missing = [];
      if (!next.tech_user_id) missing.push('tech');
      if (next.tech_at_fault === null || next.tech_at_fault === undefined) missing.push('tech at fault (yes/no)');
      if (next.total_damages === null || next.total_damages === undefined) missing.push('total damages');
      if (next.refunded === null || next.refunded === undefined) missing.push('refunded');
      if (missing.length) {
        return res.status(400).json({ error: 'Cannot close: set ' + missing.join(', ') + ' first.' });
      }
    }

    const sets = [];
    const params = [];
    const events = [];
    function setField(col, val) { params.push(val); sets.push(col + ' = $' + params.length); }

    if (b.status !== undefined && STATUSES.indexOf(b.status) !== -1 && b.status !== f.status) {
      setField('status', b.status); events.push('changed status to ' + b.status.replace(/_/g, ' '));
    }
    if (b.status_notes !== undefined) setField('status_notes', b.status_notes);
    if (b.tech_user_id !== undefined && b.tech_user_id !== f.tech_user_id) {
      setField('tech_user_id', b.tech_user_id || null); events.push('updated the assigned tech');
    }
    if (b.tech_at_fault !== undefined && b.tech_at_fault !== f.tech_at_fault) {
      setField('tech_at_fault', b.tech_at_fault); events.push('set tech at fault to ' + (b.tech_at_fault === true ? 'Yes' : b.tech_at_fault === false ? 'No' : 'TBD'));
    }
    if (b.total_damages !== undefined) setField('total_damages', b.total_damages);
    if (b.refunded !== undefined) setField('refunded', b.refunded);
    if (b.refunded_amount !== undefined) setField('refunded_amount', b.refunded_amount);
    if (b.assigned_to !== undefined && b.assigned_to !== f.assigned_to) {
      setField('assigned_to', b.assigned_to || null); events.push('reassigned the record');
    }
    if (b.followup_needed !== undefined) setField('followup_needed', b.followup_needed);
    if (b.followup_at !== undefined) { setField('followup_at', b.followup_at || null); setField('followup_sent_at', null); }
    if (b.followup_notes !== undefined) setField('followup_notes', b.followup_notes);
    if (b.is_resolved !== undefined && b.is_resolved !== f.is_resolved) {
      setField('is_resolved', b.is_resolved);
      if (b.is_resolved) { setField('resolved_at', new Date().toISOString()); events.push('marked the feedback resolved'); }
      else { setField('resolved_at', null); }
    }
    if (b.resolved_notes !== undefined) setField('resolved_notes', b.resolved_notes);

    if (!sets.length) return res.json({ feedback: f, unchanged: true });
    params.push(id);
    const upd = await pool.query('UPDATE customer_feedback SET ' + sets.join(', ') + ', updated_at = NOW(), last_interaction_at = NOW() WHERE id = $' + params.length + ' RETURNING *', params);

    const actor = { id: req.user.id, name: req.user.name };
    for (var i = 0; i < events.length; i++) { await logActivity(id, actor, 'event', events[i] + '.', null); }
    res.json({ feedback: upd.rows[0] });
  } catch (e) {
    console.error('PATCH /feedback/:id:', e.message);
    res.status(500).json({ error: 'Failed to update record' });
  }
});

// POST /api/feedback/:id/notes - add a manual note to the timeline.
router.post('/:id/notes', requireAuth, requirePermission('manage_feedback'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const body = (req.body && req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Note is empty' });
    const exists = await pool.query('SELECT id FROM customer_feedback WHERE id = $1', [id]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity(id, { id: req.user.id, name: req.user.name }, 'note', body, 'app');
    const acts = await pool.query(
      'SELECT * FROM customer_feedback_activity WHERE feedback_id = $1' +
      (req.user.role === 'admin' ? '' : " AND type <> 'view'") +
      ' ORDER BY created_at DESC',
      [id]
    );
    res.json({ activity: acts.rows });
  } catch (e) {
    console.error('POST /feedback/:id/notes:', e.message);
    res.status(500).json({ error: 'Failed to add note' });
  }
});


// ---- Attachments (bytes live in Cloudflare R2; only metadata lives here) ----
function sanitizeName(s) {
  return String(s || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'file';
}

// Step 1: presigned upload URL (browser uploads bytes straight to R2).
router.post('/:id/attachments/upload-url', requireAuth, requirePermission('manage_feedback'), async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured. Add the R2_* environment variables in Railway.' });
    const id = parseInt(req.params.id, 10);
    const exists = await pool.query('SELECT id FROM customer_feedback WHERE id = $1', [id]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Not found' });
    const fileName = (req.body && req.body.file_name || '').trim();
    if (!fileName) return res.status(400).json({ error: 'File name is required' });
    const mime = (req.body && req.body.mime_type || 'application/octet-stream').slice(0, 255);
    const key = 'feedback/' + id + '/' + crypto.randomUUID() + '/' + sanitizeName(fileName);
    const ins = await pool.query(
      "INSERT INTO customer_feedback_attachments (feedback_id, r2_key, file_name, mime_type, uploaded_by, uploaded_by_name, status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id",
      [id, key, fileName.slice(0, 255), mime, req.user.id, req.user.name]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ attachment_id: ins.rows[0].id, uploadUrl: uploadUrl });
  } catch (e) { console.error('feedback upload-url:', e.message); res.status(500).json({ error: 'Failed to start upload' }); }
});

// Step 2: confirm upload finished; mark ready + record size + timeline note.
router.post('/:id/attachments/:attId/confirm', requireAuth, requirePermission('manage_feedback'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const attId = parseInt(req.params.attId, 10);
    const ar = await pool.query('SELECT id, file_name FROM customer_feedback_attachments WHERE id = $1 AND feedback_id = $2', [attId, id]);
    if (!ar.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const size = Math.max(0, parseInt(req.body && req.body.size_bytes, 10) || 0);
    await pool.query("UPDATE customer_feedback_attachments SET size_bytes = $1, status = 'ready' WHERE id = $2", [size, attId]);
    await logActivity(id, { id: req.user.id, name: req.user.name }, 'event', 'attached a file: ' + ar.rows[0].file_name + '.', null);
    res.json({ success: true });
  } catch (e) { console.error('feedback att confirm:', e.message); res.status(500).json({ error: 'Failed to confirm upload' }); }
});

// Presigned download / preview URL.
router.get('/:id/attachments/:attId/url', requireAuth, requirePermission('view_feedback'), async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured.' });
    const id = parseInt(req.params.id, 10);
    const attId = parseInt(req.params.attId, 10);
    const ar = await pool.query("SELECT r2_key, file_name FROM customer_feedback_attachments WHERE id = $1 AND feedback_id = $2 AND status = 'ready'", [attId, id]);
    if (!ar.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const url = await r2.presignDownload(ar.rows[0].r2_key, ar.rows[0].file_name, req.query.inline === '1');
    res.json({ url: url });
  } catch (e) { console.error('feedback att url:', e.message); res.status(500).json({ error: 'Failed to generate link' }); }
});

// Delete an attachment (from R2 and the table).
router.delete('/:id/attachments/:attId', requireAuth, requirePermission('manage_feedback'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const attId = parseInt(req.params.attId, 10);
    const ar = await pool.query('SELECT r2_key, file_name FROM customer_feedback_attachments WHERE id = $1 AND feedback_id = $2', [attId, id]);
    if (!ar.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    try { await r2.deleteObject(ar.rows[0].r2_key); } catch (e) { console.error('R2 delete failed:', e.message); }
    await pool.query('DELETE FROM customer_feedback_attachments WHERE id = $1', [attId]);
    await logActivity(id, { id: req.user.id, name: req.user.name }, 'event', 'removed an attachment: ' + ar.rows[0].file_name + '.', null);
    res.json({ success: true });
  } catch (e) { console.error('feedback att delete:', e.message); res.status(500).json({ error: 'Failed to delete attachment' }); }
});

module.exports = router;
