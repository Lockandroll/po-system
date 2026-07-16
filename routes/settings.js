const express = require('express');
const { pool } = require('../db');
const clientVersion = require('../utils/clientVersion');
const permissions = require('../utils/permissions');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Keys any authenticated user may read: the logo + company display fields the print /
// invoice / signoff views render, plus the global matrices the client's can() depends on
// (role_permissions) and the min-version gate. Everything else (payroll emails, AI
// context, integration mailboxes, etc.) is admin-only and requires manage_settings.
const PUBLIC_SETTING_KEYS = [
  'logo',
  'company_name',
  'company_phone',
  'company_address',
  'company_city_state_zip',
  'role_permissions',
  'client_min_version'
];

// Get settings. Users with manage_settings get the full table (the admin config forms
// need it); everyone else gets only the public allowlist above so sensitive keys are not
// leaked to the whole authenticated user base.
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  let full = false;
  try {
    full = await permissions.hasPermission(req.user.role, 'manage_settings');
  } catch (e) { full = false; }
  if (!full) {
    const cached = req._userRow;
    if (cached && Array.isArray(cached.extra_perms) && cached.extra_perms.indexOf('manage_settings') !== -1) full = true;
  }
  const settings = {};
  rows.forEach(function(row) {
    if (full || PUBLIC_SETTING_KEYS.indexOf(row.key) !== -1) settings[row.key] = row.value;
  });
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
