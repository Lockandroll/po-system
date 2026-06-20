const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

const router = express.Router();

// GET active vehicles — requires city_code for non-admin/manager; returns city-filtered list
router.get('/', requireAuth, async function(req, res) {
  try {
    var city_code = req.query.city_code || null;
    var isPrivileged = ['admin', 'manager'].includes(req.user.role);
    // Non-privileged users must supply a city_code — prevents full fleet enumeration
    if (!city_code && !isPrivileged) return res.json([]);
    var query = 'SELECT v.*, u.name as driver_name FROM vehicles v LEFT JOIN users u ON v.assigned_user_id = u.id WHERE v.active = true';
    var params = [];
    if (city_code) { params.push(city_code); query += ' AND v.city_code = $' + params.length; }
    query += ' ORDER BY v.year DESC, v.make_model ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

// GET all vehicles including inactive — admin/manager only
router.get('/all', requireAuth, requirePermission('manage_vehicles'), async function(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT v.*, u.name as driver_name FROM vehicles v LEFT JOIN users u ON v.assigned_user_id = u.id ORDER BY v.active DESC, v.year DESC, v.make_model ASC'
    );
    res.json(rows);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

// GET single vehicle
router.get('/:id', requireAuth, async function(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT v.*, u.name as driver_name FROM vehicles v LEFT JOIN users u ON v.assigned_user_id = u.id WHERE v.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    res.json(rows[0]);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicle' });
  }
});

// POST create vehicle — admin/manager only
router.post('/', requireAuth, requirePermission('manage_vehicles'), async function(req, res) {
  const { year, make_model, vin, key_codes, assigned_user_id, city_code, date_of_assignment, license_plate, mileage, notes } = req.body;
  if (!year || !make_model) return res.status(400).json({ error: 'Year and Make/Model are required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO vehicles (year, make_model, vin, key_codes, assigned_user_id, city_code, date_of_assignment, license_plate, mileage, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [parseInt(year), make_model, vin || null, key_codes || null, assigned_user_id || null, city_code || null, date_of_assignment || null, license_plate || null, mileage ? parseInt(mileage) : null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create vehicle' });
  }
});

// PUT update vehicle — admin/manager only
router.put('/:id', requireAuth, requirePermission('manage_vehicles'), async function(req, res) {
  const { year, make_model, vin, key_codes, assigned_user_id, city_code, date_of_assignment, license_plate, mileage, notes } = req.body;
  if (!year || !make_model) return res.status(400).json({ error: 'Year and Make/Model are required' });
  try {
    const { rows } = await pool.query(
      'UPDATE vehicles SET year=$1, make_model=$2, vin=$3, key_codes=$4, assigned_user_id=$5, city_code=$6, date_of_assignment=$7, license_plate=$8, mileage=$9, notes=$10, updated_at=NOW() WHERE id=$11 RETURNING *',
      [parseInt(year), make_model, vin || null, key_codes || null, assigned_user_id || null, city_code || null, date_of_assignment || null, license_plate || null, mileage ? parseInt(mileage) : null, notes || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    res.json(rows[0]);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update vehicle' });
  }
});

// POST deactivate vehicle — admin/manager only
router.post('/:id/deactivate', requireAuth, requirePermission('manage_vehicles'), async function(req, res) {
  try {
    const { rows } = await pool.query('UPDATE vehicles SET active=false, updated_at=NOW() WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to deactivate vehicle' });
  }
});

// POST reactivate vehicle — admin/manager only
router.post('/:id/reactivate', requireAuth, requirePermission('manage_vehicles'), async function(req, res) {
  try {
    const { rows } = await pool.query('UPDATE vehicles SET active=true, updated_at=NOW() WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to reactivate vehicle' });
  }
});

// POST sell vehicle — admin/manager only
router.post('/:id/sell', requireAuth, requirePermission('manage_vehicles'), async function(req, res) {
  const { sold_to, sold_for, sold_date } = req.body;
  if (!sold_to || !sold_date) return res.status(400).json({ error: 'Buyer name and sale date are required' });
  try {
    const { rows } = await pool.query(
      'UPDATE vehicles SET active=false, sold_to=$1, sold_for=$2, sold_date=$3, updated_at=NOW() WHERE id=$4 RETURNING id',
      [sold_to.trim(), sold_for ? parseFloat(sold_for) : null, sold_date, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    res.json({ success: true });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record sale' });
  }
});

module.exports = router;
