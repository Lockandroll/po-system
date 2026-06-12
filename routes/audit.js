const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET audit logs (admin only)
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { entity_type, limit } = req.query;
    let query = 'SELECT * FROM audit_logs';
    const params = [];
    if (entity_type) {
      params.push(entity_type);
      query += ' WHERE entity_type = $' + params.length;
    }
    query += ' ORDER BY created_at DESC LIMIT ' + (parseInt(limit) || 500);
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

module.exports = router;
