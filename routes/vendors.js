const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const permissions = require('../utils/permissions');

const router = express.Router();

// Every account route requires auth. Read access needs view_vendors OR
// manage_vendors; mutations require manage_vendors. View-only callers get
// credentials (username/password) stripped in the GET handler below.
router.use(requireAuth);

// True if this request can fully manage accounts (role perm or per-user grant).
async function canManageVendors(req) {
  if (!req.user) return false;
  try { if (await permissions.hasPermission(req.user.role, 'manage_vendors')) return true; } catch (_) {}
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf('manage_vendors') !== -1;
  } catch (_) { return false; }
}

// Gate for read access: allow view_vendors or manage_vendors (role or per-user).
async function requireViewVendors(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    for (const perm of ['manage_vendors', 'view_vendors']) {
      try { if (await permissions.hasPermission(req.user.role, perm)) return next(); } catch (_) {}
    }
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    if (Array.isArray(ep) && (ep.indexOf('manage_vendors') !== -1 || ep.indexOf('view_vendors') !== -1)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) {
    return res.status(403).json({ error: 'Forbidden' });
  }
}

// Sanitize a restricted_to allowlist into a de-duped array of positive int IDs.
function cleanRestrictedTo(v) {
  if (!Array.isArray(v)) return null;
  const ids = Array.from(new Set(v.map(function (x) { return parseInt(x, 10); }).filter(function (n) { return Number.isInteger(n) && n > 0; })));
  return ids.length ? ids : null;
}

// Sanitize a per-account required-photo override into an array of slot keys.
// undefined  -> leave the column alone (the caller did not mean to change it)
// null / ''  -> clear it, i.e. fall back to the global Invoice Setup list
// []         -> a real answer: this account requires NO photos
function cleanRequiredPhotos(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!Array.isArray(v)) return null;
  const keys = Array.from(new Set(v
    .map(function (x) { return String(x == null ? '' : x).trim().toLowerCase().slice(0, 40); })
    .filter(Boolean)));
  return keys;
}

// Active users for the per-account restriction picker (managers only).
router.get('/pickable-users', requirePermission('manage_vendors'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, role FROM users WHERE active IS NOT false ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET all vendors (view or manage). Credentials hidden for view-only callers.
router.get('/', requireViewVendors, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM vendors ORDER BY name ASC');
    const manage = await canManageVendors(req);
    const isAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'owner');
    const uid = req.user && req.user.id;
    const out = [];
    for (const v of rows) {
      const arr = Array.isArray(v.restricted_to) ? v.restricted_to : [];
      const restricted = arr.length > 0;
      const allowed = isAdmin || (uid != null && arr.indexOf(uid) !== -1);
      if (restricted && !allowed) continue; // whole account hidden from non-permitted people
      const showCreds = manage || (restricted && allowed);
      const c = Object.assign({}, v);
      if (!manage) c.restricted_to = null; // only managers see/edit the allowlist
      if (!showCreds) { c.username = null; c.password = null; }
      out.push(c);
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vendors' });
  }
});

// POST create vendor
router.post('/', requirePermission('manage_vendors'), async (req, res) => {
  const { name, website, account_number, username, password, notes, rep_name, rep_email, rep_phone, city_code, show_in_invoice, invoice_notes, auto_line_items, agreement_text, restricted_to, required_photos } = req.body;
  if (!name) return res.status(400).json({ error: 'Vendor name is required' });
  const _reqPhotos = cleanRequiredPhotos(required_photos);
  try {
    const { rows } = await pool.query(
      'INSERT INTO vendors (name, website, account_number, username, password, notes, rep_name, rep_email, rep_phone, city_code, show_in_invoice, invoice_notes, auto_line_items, agreement_text, restricted_to, required_photos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
      [name, website || null, account_number || null, username || null, password || null, notes || null, rep_name || null, rep_email || null, rep_phone || null, city_code || null, show_in_invoice === true, invoice_notes || null, (auto_line_items != null ? JSON.stringify(auto_line_items) : null), agreement_text || null, cleanRestrictedTo(restricted_to), (_reqPhotos === undefined || _reqPhotos === null) ? null : JSON.stringify(_reqPhotos)]
    );
    if (account_number) {
      await pool.query('UPDATE geico_surveys SET city_code = $1, updated_at = NOW() WHERE UPPER(TRIM(account_number)) = UPPER(TRIM($2))', [city_code || null, account_number]);
    }
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create vendor' });
  }
});

// PUT update vendor
router.put('/:id', requirePermission('manage_vendors'), async (req, res) => {
  const { name, website, account_number, username, password, notes, rep_name, rep_email, rep_phone, city_code, show_in_invoice, invoice_notes, auto_line_items, agreement_text, restricted_to, required_photos } = req.body;
  if (!name) return res.status(400).json({ error: 'Vendor name is required' });
  // restricted_to and required_photos are only touched when the caller actually
  // sent them. The Invoice Setup screen saves an account with the invoice fields
  // only; before this guard that save silently wiped the account's user
  // allowlist, which reads as "someone opened the account to everybody".
  const _params = [name, website || null, account_number || null, username || null, password || null, notes || null, rep_name || null, rep_email || null, rep_phone || null, city_code || null, show_in_invoice === true, invoice_notes || null, (auto_line_items != null ? JSON.stringify(auto_line_items) : null), agreement_text || null];
  const _sets = ['name=$1', 'website=$2', 'account_number=$3', 'username=$4', 'password=$5', 'notes=$6', 'rep_name=$7', 'rep_email=$8', 'rep_phone=$9', 'city_code=$10', 'show_in_invoice=$11', 'invoice_notes=$12', 'auto_line_items=$13', 'agreement_text=$14'];
  if (restricted_to !== undefined) { _params.push(cleanRestrictedTo(restricted_to)); _sets.push('restricted_to=$' + _params.length); }
  const _reqPhotos = cleanRequiredPhotos(required_photos);
  if (_reqPhotos !== undefined) { _params.push(_reqPhotos === null ? null : JSON.stringify(_reqPhotos)); _sets.push('required_photos=$' + _params.length); }
  _params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      'UPDATE vendors SET ' + _sets.join(', ') + ', updated_at=NOW() WHERE id=$' + _params.length + ' RETURNING *',
      _params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Vendor not found' });
    if (account_number) {
      await pool.query('UPDATE geico_surveys SET city_code = $1, updated_at = NOW() WHERE UPPER(TRIM(account_number)) = UPPER(TRIM($2))', [city_code || null, account_number]);
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update vendor' });
  }
});

// DELETE vendor
router.delete('/:id', requirePermission('manage_vendors'), async (req, res) => {
  try {
    await pool.query('DELETE FROM vendors WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete vendor' });
  }
});

module.exports = router;
