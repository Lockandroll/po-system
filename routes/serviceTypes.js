const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// ---------------------------------------------------------------------------
//  The service catalog, the tag list, and who is set up for which kind of work
// ---------------------------------------------------------------------------
// The category on a service type is load-bearing in three places: who can SEE
// the call, which pay row will apply, and which price sheet row matches. That
// is why deleting one is not offered - only deactivating.
// ---------------------------------------------------------------------------

function s(v, n) {
  return v === undefined || v === null ? null : String(v).trim().slice(0, n) || null;
}

// ---- categories -----------------------------------------------------------
router.get('/categories', requireAuth, async function (req, res) {
  const r = await pool.query('SELECT code, name, sort, active FROM service_categories ORDER BY sort, name');
  res.json({ categories: r.rows });
});

router.post('/categories', requireAuth, requirePermission('manage_service_types'), async function (req, res) {
  const code = (s(req.body && req.body.code, 20) || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  const name = s(req.body && req.body.name, 80);
  if (!code || !name) return res.status(400).json({ error: 'A category needs a code and a name.' });
  await pool.query(
    'INSERT INTO service_categories (code, name, sort) VALUES ($1,$2,$3) ' +
    'ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, sort = EXCLUDED.sort',
    [code, name, parseInt((req.body && req.body.sort) || 0, 10) || 0]);
  // A brand new category starts switched OFF for everyone. Every other row in
  // user_service_categories was written by the backfill; if we defaulted this
  // one to visible, adding a category would silently widen what people see.
  await pool.query(
    'INSERT INTO user_service_categories (user_id, category_code, can_view, can_be_assigned) ' +
    'SELECT id, $1, false, false FROM users WHERE COALESCE(active,true) = true ' +
    'ON CONFLICT (user_id, category_code) DO NOTHING', [code]);
  await logAudit({ entity_type: 'service_category', entity_number: code, action: 'save',
    user_id: req.user.id, user_name: req.user.name, details: { name: name }, ip: req.ip });
  res.json({ ok: true, code: code });
});

// ---- service types --------------------------------------------------------
router.get('/', requireAuth, async function (req, res) {
  const showAll = String(req.query.all || '') === '1';
  const r = await pool.query(
    'SELECT st.id, st.code, st.name, st.category_code, st.default_eta_minutes, st.active, st.sort, ' +
    '       c.name AS category_name, ' +
    '       (SELECT COUNT(*)::int FROM dispatch_jobs j WHERE j.service_type_id = st.id) AS call_count ' +
    'FROM service_types st LEFT JOIN service_categories c ON c.code = st.category_code ' +
    (showAll ? '' : 'WHERE st.active = true ') +
    'ORDER BY st.sort, st.name');
  res.json({ service_types: r.rows });
});

router.post('/', requireAuth, requirePermission('manage_service_types'), async function (req, res) {
  const b = req.body || {};
  const code = (s(b.code, 30) || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const name = s(b.name, 120);
  const cat = s(b.category_code, 20);
  if (!code || !name || !cat) return res.status(400).json({ error: 'A service needs a code, a name and a category.' });
  const c = await pool.query('SELECT 1 FROM service_categories WHERE code = $1 AND active = true', [cat]);
  if (!c.rows.length) return res.status(400).json({ error: 'That category does not exist.' });
  const eta = parseInt(b.default_eta_minutes, 10);
  const r = await pool.query(
    'INSERT INTO service_types (code, name, category_code, default_eta_minutes, sort) VALUES ($1,$2,$3,$4,$5) ' +
    'ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category_code = EXCLUDED.category_code, ' +
    'default_eta_minutes = EXCLUDED.default_eta_minutes, sort = EXCLUDED.sort RETURNING id',
    [code, name, cat, isFinite(eta) && eta > 0 ? eta : null, parseInt(b.sort, 10) || 0]);
  await logAudit({ entity_type: 'service_type', entity_id: r.rows[0].id, entity_number: code, action: 'save',
    user_id: req.user.id, user_name: req.user.name, details: { name: name, category: cat }, ip: req.ip });
  res.json({ ok: true, id: r.rows[0].id });
});

router.put('/:id', requireAuth, requirePermission('manage_service_types'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const prev = await pool.query('SELECT * FROM service_types WHERE id = $1', [id]);
  if (!prev.rows.length) return res.status(404).json({ error: 'Not found' });
  const name = s(b.name, 120) || prev.rows[0].name;
  const cat = s(b.category_code, 20) || prev.rows[0].category_code;
  const eta = parseInt(b.default_eta_minutes, 10);
  const active = b.active === undefined ? prev.rows[0].active : !!(b.active === true || b.active === 'true' || b.active === 1 || b.active === '1');
  await pool.query(
    'UPDATE service_types SET name=$1, category_code=$2, default_eta_minutes=$3, active=$4, sort=$5 WHERE id=$6',
    [name, cat, isFinite(eta) && eta > 0 ? eta : prev.rows[0].default_eta_minutes, active,
      b.sort === undefined ? prev.rows[0].sort : (parseInt(b.sort, 10) || 0), id]);
  // Moving a service between categories changes who can see every historical
  // call of that type, so it is worth saying out loud in the audit log rather
  // than filing it as a generic edit.
  if (cat !== prev.rows[0].category_code) {
    await logAudit({ entity_type: 'service_type', entity_id: id, entity_number: prev.rows[0].code,
      action: 'recategorised', user_id: req.user.id, user_name: req.user.name,
      details: { from: prev.rows[0].category_code, to: cat }, ip: req.ip });
  }
  res.json({ ok: true });
});

// No DELETE on purpose. A service type is referenced by every call that used
// it; removing the row would orphan the FK and lose the category that decides
// who may see those calls. Deactivating hides it from the picker and leaves
// history intact.
router.post('/:id/deactivate', requireAuth, requirePermission('manage_service_types'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('UPDATE service_types SET active = false WHERE id = $1 RETURNING code', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  await logAudit({ entity_type: 'service_type', entity_id: id, entity_number: r.rows[0].code,
    action: 'deactivate', user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip });
  res.json({ ok: true });
});

// ---- tags -----------------------------------------------------------------
router.get('/tags/all', requireAuth, async function (req, res) {
  const r = await pool.query('SELECT id, name, color, active, sort FROM dispatch_tags ORDER BY sort, name');
  res.json({ tags: r.rows });
});

router.post('/tags', requireAuth, requirePermission('manage_dispatch_tags'), async function (req, res) {
  const name = s(req.body && req.body.name, 60);
  if (!name) return res.status(400).json({ error: 'A tag needs a name.' });
  var color = s(req.body && req.body.color, 7) || '#f97316';
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = '#f97316';
  const r = await pool.query(
    'INSERT INTO dispatch_tags (name, color, sort) VALUES ($1,$2,$3) ' +
    'ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color, sort = EXCLUDED.sort, active = true RETURNING id',
    [name, color, parseInt((req.body && req.body.sort) || 0, 10) || 0]);
  res.json({ ok: true, id: r.rows[0].id });
});

router.post('/tags/:id/deactivate', requireAuth, requirePermission('manage_dispatch_tags'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('UPDATE dispatch_tags SET active = false WHERE id = $1 RETURNING name', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---- who is set up for which work ----------------------------------------
// Read is open to anyone who can manage users, because it belongs on the Edit
// User screen next to home city rather than buried in a dispatch setting.
router.get('/user/:userId', requireAuth, requirePermission('view_users'), async function (req, res) {
  const uid = parseInt(req.params.userId, 10);
  const r = await pool.query(
    'SELECT c.code, c.name, ' +
    '       COALESCE(usc.can_view, false) AS can_view, ' +
    '       COALESCE(usc.can_be_assigned, false) AS can_be_assigned ' +
    'FROM service_categories c ' +
    'LEFT JOIN user_service_categories usc ON usc.category_code = c.code AND usc.user_id = $1 ' +
    'WHERE c.active = true ORDER BY c.sort, c.name', [uid]);
  res.json({ categories: r.rows });
});

router.post('/user/:userId', requireAuth, requirePermission('manage_users'), async function (req, res) {
  const uid = parseInt(req.params.userId, 10);
  const rows = (req.body && req.body.categories) || [];
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'Bad payload' });
  const u = await pool.query('SELECT name FROM users WHERE id = $1', [uid]);
  if (!u.rows.length) return res.status(404).json({ error: 'No such user' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (var i = 0; i < rows.length; i++) {
      const code = s(rows[i].code, 20);
      if (!code) continue;
      const view = !!rows[i].can_view;
      // Cannot be handed work you are not allowed to see. Enforced here rather
      // than trusted from the form, because the two flags arriving out of step
      // would produce a tech who gets assigned calls that then vanish.
      const assign = view && !!rows[i].can_be_assigned;
      await client.query(
        'INSERT INTO user_service_categories (user_id, category_code, can_view, can_be_assigned) ' +
        'VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, category_code) ' +
        'DO UPDATE SET can_view = EXCLUDED.can_view, can_be_assigned = EXCLUDED.can_be_assigned',
        [uid, code, view, assign]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await logAudit({ entity_type: 'user', entity_id: uid, action: 'service_categories',
    user_id: req.user.id, user_name: req.user.name,
    details: { user: u.rows[0].name, categories: rows }, ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
