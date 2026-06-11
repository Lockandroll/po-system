const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET all addresses for a city code
router.get('/', requireAuth, async (req, res) => {
  const { city_code } = req.query;
  if (!city_code) return res.json([]);
  const { rows } = await pool.query(
    'SELECT * FROM shipping_addresses WHERE city_code = $1 ORDER BY name ASC',
    [city_code.toUpperCase()]
  );
  res.json(rows);
});

// GET all addresses (admin — for settings page)
router.get('/all', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM shipping_addresses ORDER BY city_code, name ASC'
  );
  res.json(rows);
});

// POST create address
router.post('/', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const { city_code, name, address } = req.body;
  if (!city_code || !name || !address) {
    return res.status(400).json({ error: 'City code, name, and address are required' });
  }
  const { rows } = await pool.query(
    'INSERT INTO shipping_addresses (city_code, name, address) VALUES ($1, $2, $3) RETURNING *',
    [city_code.toUpperCase(), name, address]
  );
  res.status(201).json(rows[0]);
});

// PUT update address
router.put('/:id', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const { name, address } = req.body;
  if (!name || !address) {
    return res.status(400).json({ error: 'Name and address are required' });
  }
  const { rows } = await pool.query(
    'UPDATE shipping_addresses SET name=$1, address=$2 WHERE id=$3 RETURNING *',
    [name, address, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Address not found' });
  res.json(rows[0]);
});

// DELETE address
router.delete('/:id', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  await pool.query('DELETE FROM shipping_addresses WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
