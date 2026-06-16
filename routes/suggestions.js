const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');

const router = express.Router();

function appUrl(path) {
  return (process.env.APP_URL || '').replace(/\/$/, '') + path;
}

// POST — submit a suggestion (all authenticated users)
router.post('/', requireAuth, async (req, res) => {
  try {
    const { category, suggestion, anonymous } = req.body;
    if (!suggestion || !suggestion.trim()) {
      return res.status(400).json({ error: 'Suggestion text is required' });
    }
    if (!category) {
      return res.status(400).json({ error: 'Category is required' });
    }
    const isAnon = anonymous === true;
    const submitter_id = isAnon ? null : req.user.id;
    const submitter_name = isAnon ? null : req.user.name;
    const { rows } = await pool.query(
      'INSERT INTO suggestions (category, suggestion, anonymous, submitter_id, submitter_name) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [category, suggestion.trim(), isAnon, submitter_id, submitter_name]
    );
    const s = rows[0];
    // Notify admins and managers
    try {
      const { rows: notifyUsers } = await pool.query(
        "SELECT email, name, phone, receive_emails, receive_sms FROM users WHERE role IN ('admin', 'manager') AND active = true"
      );
      const emailUsers = notifyUsers.filter(function(u) { return u.receive_emails; });
      const smsUsers = notifyUsers.filter(function(u) { return u.receive_sms && u.phone; });
      const submittedBy = isAnon ? 'Anonymous' : req.user.name;
      const preview = suggestion.trim().slice(0, 100) + (suggestion.trim().length > 100 ? '...' : '');
      if (emailUsers.length) {
        const emails = emailUsers.map(function(u) { return u.email; });
        const html = emailTemplate({
          badge: 'New Suggestion',
          title: 'A new suggestion has been submitted',
          body: '<strong>' + submittedBy + '</strong> submitted a new suggestion.',
          details: [
            { label: 'Category', value: category },
            { label: 'Suggestion', value: suggestion.trim() },
            { label: 'Submitted By', value: submittedBy }
          ],
          buttonText: 'View Suggestions',
          buttonUrl: appUrl('/?view=suggestions')
        });
        await sendEmail(emails, 'New Suggestion [' + category + ']', html);
      }
      if (smsUsers.length) {
        const phones = smsUsers.map(function(u) { return u.phone; });
        await sendSms(phones, 'Nova: New suggestion from ' + submittedBy + ' [' + category + ']: ' + preview + ' ' + appUrl('/?view=suggestions'));
      }
    } catch(e) {
      console.error('Suggestion notification failed:', e);
    }
    res.status(201).json(s);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to submit suggestion' });
  }
});

// GET — list all suggestions (managers and admins only)
router.get('/', requireAuth, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM suggestions ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// PUT /:id — update status and/or notes (managers and admins only)
router.put('/:id', requireAuth, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { status, admin_notes } = req.body;
    const setClauses = [];
    const values = [];
    let i = 1;
    if (status !== undefined) { setClauses.push('status=$' + i++); values.push(status); }
    if (admin_notes !== undefined) { setClauses.push('admin_notes=$' + i++); values.push(admin_notes); }
    if (!setClauses.length) return res.status(400).json({ error: 'Nothing to update' });
    setClauses.push('updated_at=NOW()');
    values.push(req.params.id);
    const { rows } = await pool.query(
      'UPDATE suggestions SET ' + setClauses.join(', ') + ' WHERE id=$' + i + ' RETURNING *',
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Suggestion not found' });
    res.json(rows[0]);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update suggestion' });
  }
});

module.exports = router;
