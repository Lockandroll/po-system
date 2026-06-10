const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Initial setup — creates first admin account (only works when no users exist)
router.post('/setup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) > 0) {
    return res.status(400).json({ error: 'Setup already complete' });
  }
  const password_hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
    [name, email, password_hash, 'admin']
  );
  const user = result.rows[0];
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user });
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// Get current user
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, role, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json(rows[0]);
});

// Check if setup is needed
router.get('/setup-needed', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  res.json({ needed: parseInt(rows[0].count) === 0 });
});

module.exports = router;
