const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/feedbackIntake');

const router = express.Router();

const STATUSES = ['new', 'complaint_pending', 'customer_contacted', 'in_progress', 'resolved', 'closed'];
const CLOSED_STATES = ['resolved', 'closed'];

// Non-admins are scoped to feedback for the cities they manage.
async function cityScope(user) {
  if (user.role === 'admin') return null; // null = no restriction
  try {
    const r = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [user.id]);
    return r.rows.map(function (x) { return x.city_code; });
  } catch (e) { return []; }
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
      whereSql + ' ORDER BY f.last_interaction_at DESC NULLS LAST LIMIT ' + limit + ' OFFSET ' + offset,
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
    const acts = await pool.query('SELECT * FROM customer_feedback_activity WHERE feedback_id = $1 ORDER BY created_at DESC', [id]);
    res.json({ feedback: r.rows[0], activity: acts.rows });
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
    const acts = await pool.query('SELECT * FROM customer_feedback_activity WHERE feedback_id = $1 ORDER BY created_at DESC', [id]);
    res.json({ activity: acts.rows });
  } catch (e) {
    console.error('POST /feedback/:id/notes:', e.message);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

module.exports = router;
