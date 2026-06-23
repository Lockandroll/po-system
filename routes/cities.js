const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

const router = express.Router();

// List active cities (all authenticated users — for dropdown)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, code FROM cities WHERE active=true ORDER BY name ASC');
  res.json(rows);
});

// List the cities the current user may use: their assigned cities, or all
// active cities if they have none assigned (or are admin/manager).
router.get('/mine', requireAuth, async (req, res) => {
  const all = (await pool.query('SELECT id, name, code FROM cities WHERE active=true ORDER BY name ASC')).rows;
  if (['admin', 'manager'].includes(req.user.role)) return res.json(all);
  const mine = (await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [req.user.id])).rows
    .map(function (r) { return (r.city_code || '').trim().toUpperCase(); });
  if (!mine.length) return res.json(all);
  res.json(all.filter(function (c) { return mine.indexOf((c.code || '').trim().toUpperCase()) !== -1; }));
});

// List all cities including inactive (admin only)
router.get('/all', requireAuth, requirePermission('manage_cities'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM cities ORDER BY active DESC, name ASC');
  res.json(rows);
});

// Create city (admin only)
router.post('/', requireAuth, requirePermission('manage_cities'), async (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
  if (code.length !== 3) return res.status(400).json({ error: 'Code must be exactly 3 characters' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO cities (name, code) VALUES ($1, $2) RETURNING *',
      [name, code.toUpperCase()]
    );
    res.status(201).json(rows[0]);
  } catch(err) {
    if (err.code === '23505') return res.status(400).json({ error: 'City code already in use' });
    throw err;
  }
});

// Update city (admin only)
router.put('/:id', requireAuth, requirePermission('manage_cities'), async (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
  if (code.length !== 3) return res.status(400).json({ error: 'Code must be exactly 3 characters' });
  try {
    const { rows } = await pool.query(
      'UPDATE cities SET name=$1, code=$2 WHERE id=$3 RETURNING *',
      [name, code.toUpperCase(), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'City not found' });
    res.json(rows[0]);
  } catch(err) {
    if (err.code === '23505') return res.status(400).json({ error: 'City code already in use' });
    throw err;
  }
});

// Deactivate city (admin only)
router.post('/:id/deactivate', requireAuth, requirePermission('manage_cities'), async (req, res) => {
  const { rows } = await pool.query('UPDATE cities SET active=false WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'City not found' });
  res.json({ success: true });
});

// Reactivate city (admin only)
router.post('/:id/reactivate', requireAuth, requirePermission('manage_cities'), async (req, res) => {
  const { rows } = await pool.query('UPDATE cities SET active=true WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'City not found' });
  res.json({ success: true });
});

module.exports = router;
