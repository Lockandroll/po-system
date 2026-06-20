const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// List SOP documents (metadata only - no full text) - admin only
router.get('/', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, filename, char_count, active, uploaded_by_name, created_at FROM sop_documents ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('SOP list error:', err);
    res.status(500).json({ error: 'Failed to load SOP documents' });
  }
});

// Create a SOP document (extracted text, sent from the browser) - admin only
router.post('/', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const { title, filename, content } = req.body;
    if (!title || !content || !content.trim()) {
      return res.status(400).json({ error: 'Title and extracted content are required' });
    }
    const text = content.trim();
    const { rows } = await pool.query(
      'INSERT INTO sop_documents (title, filename, content, char_count, uploaded_by, uploaded_by_name) ' +
      'VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [title.trim().slice(0, 255), (filename || '').slice(0, 255), text, text.length, req.user.id, req.user.name]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    console.error('SOP create error:', err);
    res.status(500).json({ error: 'Failed to save SOP document' });
  }
});

// Update a SOP document (toggle active, or rename) - admin only
router.put('/:id', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const { active, title } = req.body;
    const sets = [];
    const params = [];
    if (typeof active === 'boolean') { params.push(active); sets.push('active = $' + params.length); }
    if (typeof title === 'string' && title.trim()) { params.push(title.trim().slice(0, 255)); sets.push('title = $' + params.length); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    await pool.query('UPDATE sop_documents SET ' + sets.join(', ') + ' WHERE id = $' + params.length, params);
    res.json({ success: true });
  } catch (err) {
    console.error('SOP update error:', err);
    res.status(500).json({ error: 'Failed to update SOP document' });
  }
});

// Delete a SOP document - admin only
router.delete('/:id', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    await pool.query('DELETE FROM sop_documents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('SOP delete error:', err);
    res.status(500).json({ error: 'Failed to delete SOP document' });
  }
});

module.exports = router;
