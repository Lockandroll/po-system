const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// List all users (admin only)
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, phone, role, active, receive_emails, created_at FROM users ORDER BY active DESC, name ASC'
  );
  res.json(rows);
});

// Create user (admin only)
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, email, password, role, phone, receive_emails } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Name, email, password, and role are required' });
  }
  if (!['requester', 'approver', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Role must be requester, approver, or admin' });
  }
  const password_hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, phone, receive_emails) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, phone, role, active, receive_emails',
      [name, email, password_hash, role, phone || null, receive_emails !== false]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already in use' });
    throw err;
  }
});

// Update user (admin only)
router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, email, role, password, phone, receive_emails } = req.body;
  const { id } = req.params;
  let query, params;
  if (password) {
    const password_hash = await bcrypt.hash(password, 12);
    query = 'UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4, phone=$5, receive_emails=$6 WHERE id=$7 RETURNING id, name, email, phone, role, active, receive_emails';
    params = [name, email, role, password_hash, phone || null, receive_emails !== false, id];
  } else {
    query = 'UPDATE users SET name=$1, email=$2, role=$3, phone=$4, receive_emails=$5 WHERE id=$6 RETURNING id, name, email, phone, role, active, receive_emails';
    params = [name, email, role, phone || null, receive_emails !== false, id];
  }
  const { rows } = await pool.query(query, params);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

// Deactivate user (admin only)
router.post('/:id/deactivate', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }
  const { rows } = await pool.query('UPDATE users SET active=false WHERE id=$1 RETURNING id', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
});

// Reactivate user (admin only)
router.post('/:id/reactivate', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query('UPDATE users SET active=true WHERE id=$1 RETURNING id', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
});

// Delete user (admin only — only if no POs)
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const { rows: poRows } = await pool.query('SELECT COUNT(*) FROM purchase_orders WHERE requester_id=$1', [id]);
  if (parseInt(poRows[0].count) > 0) {
    return res.status(400).json({ error: 'Cannot delete user — they have existing purchase orders. Deactivate instead.' });
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ success: true });
});

module.exports = router;
