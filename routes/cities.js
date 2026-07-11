const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

const router = express.Router();

// List active cities (all authenticated users — for dropdown)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, code, color, invoice_prefix FROM cities WHERE active=true ORDER BY name ASC');
  res.json(rows);
});

// List the cities the current user may use: their assigned cities, or all
// active cities if they have none assigned (or are admin/manager).
router.get('/mine', requireAuth, async (req, res) => {
  const all = (await pool.query('SELECT id, name, code, color FROM cities WHERE active=true ORDER BY name ASC')).rows;
  if (['admin', 'manager'].includes(req.user.role)) return res.json(all);
  const mine = (await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [req.user.id])).rows
    .map(function (r) { return (r.city_code || '').trim().toUpperCase(); });
  if (!mine.length) return res.json(all);
  res.json(all.filter(function (c) { return mine.indexOf((c.code || '').trim().toUpperCase()) !== -1; }));
});

// List all cities including inactive (admin only). Includes the primary manager's
// name so the Cities table can show who owns each city.
router.get('/all', requireAuth, requirePermission('manage_cities'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT c.*, u.name AS manager_name FROM cities c ' +
    'LEFT JOIN users u ON u.id = c.manager_user_id ' +
    'ORDER BY c.active DESC, c.name ASC'
  );
  res.json(rows);
});

// '' / undefined -> null; otherwise an int. Used for manager_user_id + invoice_prefix.
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// Create city (admin only)
router.post('/', requireAuth, requirePermission('manage_cities'), async (req, res) => {
  const { name, code, color, invoice_prefix, manager_user_id } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
  if (code.length !== 3) return res.status(400).json({ error: 'Code must be exactly 3 characters' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO cities (name, code, color, invoice_prefix, manager_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, code.toUpperCase(), color || '#f97316', intOrNull(invoice_prefix), intOrNull(manager_user_id)]
    );
    res.status(201).json(rows[0]);
  } catch(err) {
    if (err.code === '23505') return res.status(400).json({ error: 'City code already in use' });
    throw err;
  }
});

// Update city (admin only)
router.put('/:id', requireAuth, requirePermission('manage_cities'), async (req, res) => {
  const { name, code, color, invoice_prefix, manager_user_id } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
  if (code.length !== 3) return res.status(400).json({ error: 'Code must be exactly 3 characters' });
  try {
    const { rows } = await pool.query(
      'UPDATE cities SET name=$1, code=$2, color=$3, invoice_prefix=$4, manager_user_id=$5 WHERE id=$6 RETURNING *',
      [name, code.toUpperCase(), color || '#f97316', intOrNull(invoice_prefix), intOrNull(manager_user_id), req.params.id]
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
