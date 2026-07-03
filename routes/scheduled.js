const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { runScheduledMessage } = require('../jobs/scheduledMessages');

const router = express.Router();

const VALID_ROLES = ['locksmith', 'locksmith_coordinator', 'dispatcher', 'roadside_technician', 'manager', 'admin', 'owner'];

function clean(b) {
  let roles = [];
  try { roles = Array.isArray(b.audience_roles) ? b.audience_roles : JSON.parse(b.audience_roles || '[]'); } catch (e) { roles = []; }
  roles = roles.filter(function (r) { return VALID_ROLES.indexOf(r) !== -1; });
  const channel = ['sms', 'email', 'both'].indexOf(b.channel) !== -1 ? b.channel : 'sms';
  let dow = parseInt(b.day_of_week, 10);
  if (isNaN(dow) || dow < 0 || dow > 6) dow = 1;
  const t = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.send_time) ? b.send_time : '09:00';
  return {
    name: (b.name || '').trim() || 'Untitled reminder',
    enabled: b.enabled !== false,
    channel: channel,
    audience_roles: JSON.stringify(roles),
    ignore_opt_out: b.ignore_opt_out === true || b.ignore_opt_out === 'true',
    day_of_week: dow,
    send_time: t,
    subject: (b.subject || '').trim() || null,
    message: (b.message || '').trim()
  };
}

router.get('/', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM scheduled_messages ORDER BY id ASC');
  res.json(rows);
});

router.post('/', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  const c = clean(req.body || {});
  if (!c.message) return res.status(400).json({ error: 'Message text is required' });
  const { rows } = await pool.query(
    'INSERT INTO scheduled_messages (name, enabled, channel, audience_roles, ignore_opt_out, day_of_week, send_time, subject, message, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [c.name, c.enabled, c.channel, c.audience_roles, c.ignore_opt_out, c.day_of_week, c.send_time, c.subject, c.message, req.user.id]
  );
  res.status(201).json(rows[0]);
});

router.put('/:id', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  const c = clean(req.body || {});
  if (!c.message) return res.status(400).json({ error: 'Message text is required' });
  const { rows } = await pool.query(
    'UPDATE scheduled_messages SET name=$1, enabled=$2, channel=$3, audience_roles=$4, ignore_opt_out=$5, day_of_week=$6, send_time=$7, subject=$8, message=$9, updated_at=NOW() WHERE id=$10 RETURNING *',
    [c.name, c.enabled, c.channel, c.audience_roles, c.ignore_opt_out, c.day_of_week, c.send_time, c.subject, c.message, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Scheduled message not found' });
  res.json(rows[0]);
});

router.delete('/:id', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  await pool.query('DELETE FROM scheduled_messages WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// Send a one-off test of this message to the requesting admin only.
router.post('/:id/test', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM scheduled_messages WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Scheduled message not found' });
  try {
    // req.user (from the JWT) has no phone/opt-out fields, so SMS tests
    // silently sent nothing. Load the full user row for the test delivery.
    const ur = await pool.query('SELECT name, phone, email, receive_sms, receive_emails FROM users WHERE id=$1', [req.user.id]);
    const sent = await runScheduledMessage(rows[0], { testUser: ur.rows[0] || req.user });
    res.json({ success: true, sent: sent });
  } catch (err) {
    res.status(500).json({ error: 'Test failed: ' + err.message });
  }
});

module.exports = router;
