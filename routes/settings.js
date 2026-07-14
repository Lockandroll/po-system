const express = require('express');
const { pool } = require('../db');
const clientVersion = require('../utils/clientVersion');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Get all settings (authenticated users — needed to show logo on print)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const settings = {};
  rows.forEach(function(row) { settings[row.key] = row.value; });
  res.json(settings);
});

// Upsert a setting (admin only)
router.put('/:key', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value === null) {
    return res.status(400).json({ error: 'Value is required' });
  }
  await pool.query(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
    [req.params.key, value]
  );
  // The min-version gate is cached in memory; drop the cache so raising it takes
  // effect on the very next request instead of up to 30s later.
  if (req.params.key === 'client_min_version') clientVersion.bust();
  res.json({ success: true });
});

// Delete a setting (admin only)
router.delete('/:key', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  await pool.query('DELETE FROM settings WHERE key=$1', [req.params.key]);
  if (req.params.key === 'client_min_version') clientVersion.bust();
  res.json({ success: true });
});

module.exports = router;
