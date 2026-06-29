const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parseEmailToTask } = require('../utils/taskParse');
const { resolveAssignee, createTaskFromParsed } = require('../utils/taskFromEmail');

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
    res.status(201).json({ id: result.task.id, assignee_name: result.assignee.name });
  } catch (e) {
    console.error('[addin] create failed:', e.message);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

module.exports = router;
