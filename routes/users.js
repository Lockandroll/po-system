const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// List all users (admin only)
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, role, created_at FROM users ORDER BY name');
  res.json(rows);
});

// Create user (admin only)
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Name, email, password, and role are required' });
  }
  if (!['requester', 'approver', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Role must be requester, approver, or admin' });
  }
  const password_hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, password_hash, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already in use' });
    throw err;
  }
});

// Update user (admin only)
router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, email, role, password } = req.body;
  const { id } = req.params;
  let query, params;
  if (password) {
    const password_hash = await bcrypt.hash(password, 12);
    query = 'UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4 WHERE id=$5 RETURNING id, name, email, role';
    params = [name, email, role, password_hash, id];
  } else {
    query = 'UPDATE users SET name=$1, email=$2, role=$3 WHERE id=$4 RETURNING id, name, email, role';
    params = [name, email, role, id];
  }
  const { rows } = await pool.query(query, params);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

// Delete user (admin only)
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ success: true });
});

module.exports = router;
