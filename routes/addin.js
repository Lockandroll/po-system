const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parseEmailToTask } = require('../utils/taskParse');
const { resolveAssignee, createTaskFromParsed } = require('../utils/taskFromEmail');
const { notifyTaskCc } = require('../jobs/taskReminders');

const router = express.Router();

// GET /api/addin/users — minimal active-user list for the assignee dropdown.
// Available to any authenticated user (the full /api/users is permission-gated).
router.get('/users', requireAuth, async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT id, name FROM users WHERE active = true ORDER BY name ASC');
    res.json(rows);
  } catch (e) {
    console.error('[addin] users failed:', e.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// POST /api/addin/parse  { subject, body, html }
// Runs the email through the AI parser and returns editable fields for the popup.
router.post('/parse', requireAuth, async function (req, res) {
  try {
    const b = req.body || {};
    const parsed = await parseEmailToTask({
      subject: b.subject || '',
      text: b.body || b.text || '',
      html: b.html || '',
      fromName: req.user.name
    });
    var assigneeId = null, assigneeName = null;
    if (parsed.assignee) {
      const u = await resolveAssignee(parsed.assignee);
      if (u) { assigneeId = u.id; assigneeName = u.name; }
    }
    res.json({
      title: parsed.title,
      description: parsed.description,
      priority: parsed.priority,
      due_date: parsed.due_date,
      assignee_id: assigneeId,
      assignee_name: assigneeName
    });
  } catch (e) {
    console.error('[addin] parse failed:', e.message);
    res.status(500).json({ error: 'Failed to parse email' });
  }
});

// POST /api/addin/create  { title, description, priority, due_date, assignee_id }
router.post('/create', requireAuth, async function (req, res) {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const PRI = ['low', 'medium', 'high', 'urgent'];
    var priority = String(b.priority || 'medium').toLowerCase();
    if (PRI.indexOf(priority) === -1) priority = 'medium';

    var due = b.due_date ? String(b.due_date).trim() : null;
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) due = null;

    const parsed = {
      title: title.slice(0, 200),
      description: String(b.description || '').trim(),
      priority: priority,
      due_date: due,
      assignee: null
    };
    const creator = { id: req.user.id, name: req.user.name };
    const result = await createTaskFromParsed(parsed, creator, 'outlook_addin', b.assignee_id || null);

    // FYI / copied-in users: awareness-only email, no task/SMS/push.
    var ccIds = Array.isArray(b.cc)
      ? b.cc.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); })
      : [];
    // Don't copy the assignee on their own task.
    ccIds = ccIds.filter(function (x) { return x !== result.assignee.id; });
    var ccNames = [];
    if (ccIds.length) {
      for (var i = 0; i < ccIds.length; i++) {
        await pool.query('INSERT INTO task_cc (task_id, user_id) VALUES ($1,$2) ON CONFLICT (task_id, user_id) DO NOTHING', [result.task.id, ccIds[i]]);
      }
      try {
        const cc = await pool.query('SELECT u.name FROM task_cc c JOIN users u ON c.user_id = u.id WHERE c.task_id = $1 ORDER BY u.name', [result.task.id]);
        ccNames = cc.rows.map(function (r) { return r.name; });
      } catch (e) {}
      try { await notifyTaskCc(result.task.id); } catch (e) {}
    }

    res.status(201).json({ id: result.task.id, assignee_name: result.assignee.name, cc_names: ccNames });
  } catch (e) {
    console.error('[addin] create failed:', e.message);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// POST /api/addin/token - exchange a valid session for a long-lived (90d)
// add-in token. The Outlook pane stores this so users sign in only once.
// requireAuth scopes addin tokens to /api/addin/* and renews them on every call.
router.post('/token', requireAuth, async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1 AND active = true', [req.user.id]);
    if (!rows.length) return res.status(403).json({ error: 'Account not found or deactivated' });
    const u = rows[0];
    const token = jwt.sign(
      { id: u.id, email: u.email, name: u.name, role: u.role, addin: true },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );
    res.json({ token: token });
  } catch (e) {
    console.error('[addin] token mint failed:', e.message);
    res.status(500).json({ error: 'Failed to issue add-in token' });
  }
});

module.exports = router;
