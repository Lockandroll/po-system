const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const permissions = require('../utils/permissions');

const router = express.Router();

// Company Information's "Important Contacts" box - a small shared directory
// (name, role/company, phone, email, notes) for numbers the office looks up
// often. Same restricted_to allowlist pattern as vendors.restricted_to
// (routes/vendors.js): empty/null = everyone who can see this page sees the
// row, a non-empty list hides the WHOLE row from anyone not on it. Admins and
// owners always see every row, same as vendors.
router.use(requireAuth);

// Read access matches the Company Information page itself (admin/manager
// role - see renderCompanyInfo in public/js/app.js). Add/edit/delete needs
// manage_settings, same gate as every other write on that page
// (PUT/DELETE /api/settings/:key) - a manager without manage_settings can see
// this card but their save will 403, exactly like Company Details/Payroll do
// today for that same manager.
function requirePageRole(req, res, next) {
  const role = req.user && req.user.role;
  if (role === 'admin' || role === 'owner' || role === 'manager') return next();
  return res.status(403).json({ error: 'Forbidden' });
}

async function canManageSettings(req) {
  try { if (await permissions.hasPermission(req.user.role, 'manage_settings')) return true; } catch (_) {}
  const cached = req._userRow;
  return !!(cached && Array.isArray(cached.extra_perms) && cached.extra_perms.indexOf('manage_settings') !== -1);
}

// GET all contacts the caller is allowed to see.
router.get('/', requirePageRole, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM important_contacts ORDER BY name ASC');
    const manage = await canManageSettings(req);
    const isAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'owner');
    const uid = req.user && req.user.id;
    const out = [];
    for (const c of rows) {
      const arr = Array.isArray(c.restricted_to) ? c.restricted_to : [];
      const restricted = arr.length > 0;
      const allowed = isAdmin || (uid != null && arr.indexOf(uid) !== -1);
      if (restricted && !allowed) continue; // whole contact hidden from non-permitted people
      const row = Object.assign({}, c);
      if (!manage) row.restricted_to = null; // only managers who can edit see/edit the allowlist
      row.restricted = restricted;
      out.push(row);
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// Active users for the "restrict to specific people" picker. Mirrors
// GET /api/vendors/pickable-users; kept as its own endpoint (rather than
// reusing /api/users) so it stays available to anyone who can manage this
// card even if their role doesn't also carry view_users.
router.get('/pickable-users', async (req, res) => {
  if (!(await canManageSettings(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = await pool.query('SELECT id, name, role FROM users WHERE active IS NOT false ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Sanitize a restricted_to allowlist into a de-duped array of positive int
// ids, same shape as vendors' cleanRestrictedTo.
function cleanRestrictedTo(v) {
  if (!Array.isArray(v)) return null;
  const ids = Array.from(new Set(v.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0)));
  return ids.length ? ids : null;
}

router.post('/', requirePermission('manage_settings'), async (req, res) => {
  const { name, role_company, phone, email, notes, restricted_to } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO important_contacts (name, role_company, phone, email, notes, restricted_to, created_by, created_by_name) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        String(name).trim(),
        (role_company || '').trim() || null,
        (phone || '').trim() || null,
        (email || '').trim() || null,
        (notes || '').trim() || null,
        cleanRestrictedTo(restricted_to),
        req.user.id,
        (req.user && req.user.name) || null
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

router.put('/:id', requirePermission('manage_settings'), async (req, res) => {
  const { name, role_company, phone, email, notes, restricted_to } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const { rows } = await pool.query(
      'UPDATE important_contacts SET name=$1, role_company=$2, phone=$3, email=$4, notes=$5, restricted_to=$6, updated_at=NOW() ' +
      'WHERE id=$7 RETURNING *',
      [
        String(name).trim(),
        (role_company || '').trim() || null,
        (phone || '').trim() || null,
        (email || '').trim() || null,
        (notes || '').trim() || null,
        cleanRestrictedTo(restricted_to),
        req.params.id
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

router.delete('/:id', requirePermission('manage_settings'), async (req, res) => {
  try {
    await pool.query('DELETE FROM important_contacts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = router;
