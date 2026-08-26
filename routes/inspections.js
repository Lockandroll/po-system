const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');
const org = require('../utils/org');

const router = express.Router();

// Current calendar month (YYYY-MM) in America/New_York — matches the cron tz.
function etMonth() {
  var s = new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' });
  return s.slice(0, 7);
}
function validMonth(m) { return typeof m === 'string' && /^\d{4}-\d{2}$/.test(m); }

async function getCutoffDay() {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'inspection_cutoff_day'");
    if (rows.length && rows[0].value) {
      var n = parseInt(rows[0].value, 10);
      if (n >= 1 && n <= 31) return n;
    }
  } catch (e) {}
  return 25;
}

// Option colors drive the rolled-up result: red = fail, yellow/orange = attention,
// green = pass, gray/blue = neutral (no effect). Text items carry no color.
function hexHsl(hex) {
  var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  var n = parseInt(m[1], 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  var l = (mx + mn) / 2, s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h: h, s: s, l: l };
}
// Map a color (named or any #hex) to a result severity. Named legacy values map
// directly; arbitrary hex is classified by hue: red = fail, yellow/orange = attention,
// green = pass, everything muted/blue/purple = neutral. 'ok' covers pass + neutral.
function colorSeverity(color) {
  var c = (color || '').toLowerCase().trim();
  if (!c) return 'ok';
  var named = { green: 'ok', yellow: 'attention', orange: 'attention', red: 'fail', gray: 'ok', blue: 'ok' };
  if (named[c] != null) return named[c];
  var hsl = hexHsl(c);
  if (!hsl) return 'ok';
  if (hsl.s < 0.15 || hsl.l < 0.12 || hsl.l > 0.92) return 'ok';
  var h = hsl.h;
  if (h < 20 || h >= 345) return 'fail';
  if (h < 65) return 'attention';
  return 'ok';
}
function deriveResult(items) {
  var worst = 'pass';
  (items || []).forEach(function (it) {
    var s = colorSeverity(it.color);
    if (s === 'fail') worst = 'fail';
    else if (s === 'attention' && worst !== 'fail') worst = 'attention';
  });
  return worst;
}

async function generateInspectionNumber() {
  const year = new Date().getFullYear();
  const prefix = 'INS-' + year + '-%';
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(inspection_number, '-', 3) AS INTEGER)) as maxseq FROM vehicle_inspections WHERE inspection_number LIKE $1",
    [prefix]
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'INS-' + year + '-' + seq;
}

// Which submitted/stored items are flagged for follow-up, based on the active
// checklist option the driver selected (option.followup === true). Text items
// have no options and never trigger.
async function followupItemsFor(items) {
  if (!Array.isArray(items) || !items.length) return [];
  const { rows } = await pool.query('SELECT item_key, options FROM inspection_checklist WHERE active = true');
  const flag = {};
  rows.forEach(function (r) {
    var opts = r.options;
    if (typeof opts === 'string') { try { opts = JSON.parse(opts); } catch (e) { opts = null; } }
    if (!Array.isArray(opts)) return;
    var m = {};
    opts.forEach(function (o) { if (o && o.followup) m[String((o.label || '')).toLowerCase()] = true; });
    if (Object.keys(m).length) flag[r.item_key] = m;
  });
  return items.filter(function (it) {
    var m = (it && it.item_key) ? flag[it.item_key] : null;
    return !!(m && m[String((it.answer || '')).toLowerCase()]);
  }).map(function (it) {
    return { item_key: it.item_key, label: it.label || '', answer: it.answer || '', comment: it.comment || null };
  });
}

// The vehicle's assigned driver (default follow-up assignee), or null.
async function driverOf(vehicleId) {
  const { rows } = await pool.query('SELECT u.id, u.name FROM vehicles v LEFT JOIN users u ON v.assigned_user_id = u.id WHERE v.id = $1', [vehicleId]);
  if (!rows.length || !rows[0].id) return null;
  return { id: rows[0].id, name: rows[0].name };
}

function sanitizePhotoName(name) {
  return String(name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'photo';
}

// Who inspects a vehicle, in order: the person explicitly picked on the vehicle,
// then the manager of the driver's home city (falling back to the city the van
// itself is based in when the driver has no home city on file), then the driver's
// own supervisor as a last resort. Mutates the row and returns it.
//
// The city manager is the DEFAULT, not a fallback for the supervisor: a van is
// inspected by whoever runs the city it sits in, and the picker only exists to
// override that for a one-off.
function resolveInspector(r, cityMgr) {
  var code = String(r.driver_home_city || r.city_code || '').trim().toUpperCase();
  var cm = code ? (cityMgr || {})[code] : null;
  r.inspector_city = code || null;
  r.city_manager_id = cm ? cm.id : null;
  r.city_manager_name = cm ? cm.name : null;
  if (r.inspector_id) {
    r.effective_inspector_id = r.inspector_id;
    r.effective_inspector_name = r.inspector_name || null;
    r.effective_inspector_source = 'assigned';
  } else if (cm) {
    r.effective_inspector_id = cm.id;
    r.effective_inspector_name = cm.name;
    r.effective_inspector_source = 'city';
  } else if (r.driver_supervisor_id) {
    r.effective_inspector_id = r.driver_supervisor_id;
    r.effective_inspector_name = r.manager_name || null;
    r.effective_inspector_source = 'supervisor';
  } else {
    r.effective_inspector_id = null;
    r.effective_inspector_name = null;
    r.effective_inspector_source = null;
  }
  return r;
}

function isPrivileged(user) { return ['admin', 'owner', 'manager'].includes(user.role); }
// Who may COMPLETE an inspection: admins/managers, the assigned driver's direct
// manager (supervisor), or the inspector explicitly assigned to the vehicle.
function canSubmit(user, driverSupervisorId, inspectorId) {
  if (['admin', 'owner', 'manager'].includes(user.role)) return true;
  if (inspectorId && user.id === inspectorId) return true;
  return !!(driverSupervisorId && user.id === driverSupervisorId);
}

// ===== Checklist =====
// The live checklist. Retired items are not in this table at all - they move to
// inspection_checklist_archive on save. The old ?all=1 flag is accepted and
// ignored, so a cached client cannot pull a retired item back into the editor.
router.get('/checklist', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, item_key, label, type, sort_order, requires_photo, options, active FROM inspection_checklist' +
      ' WHERE active = true' +
      ' ORDER BY sort_order, id'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load checklist' });
  }
});

// Replace the checklist definition (manage only). Anything missing from the payload
// is RETIRED: copied into inspection_checklist_archive and deleted from the live
// table, so reopening the editor shows exactly what was saved and nothing else.
// Safe for history - inspection_items snapshots each answer's label and color at
// submit time and never reads the checklist definition back.
router.put('/checklist', requireAuth, requirePermission('manage_inspections'), async function (req, res) {
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items array required' });
  // Clean the payload before touching the table, so a blank or empty list is
  // rejected up front rather than wiping the checklist.
  const keep = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var key = (it.item_key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
    var label = (it.label || '').trim().slice(0, 255);
    if (!label) continue;
    // A brand new item arrives without a key. Derive one from the label the same
    // way the editor does, rather than dropping the item on the floor.
    if (!key) key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'item';
    // Two items sharing a key would silently collapse into one on the upsert.
    var base = key, dupN = 2;
    while (keep.some(function (k) { return k.key === key; })) { key = base.slice(0, 55) + '_' + dupN; dupN++; }
    var type = (it.type === 'text') ? 'text' : 'dropdown';
    var opts = null;
    if (type === 'dropdown' && Array.isArray(it.options)) {
      var clean = it.options.map(function (o) { return { label: String((o && o.label) || '').slice(0, 60), color: String((o && o.color) || '').toLowerCase().slice(0, 20), followup: !!(o && o.followup) }; }).filter(function (o) { return o.label; });
      opts = JSON.stringify(clean);
    }
    keep.push({ key: key, label: label, type: type, opts: opts, reqPhoto: !!it.requires_photo });
  }
  if (!keep.length) return res.status(400).json({ error: 'The checklist needs at least one item. Remove items one at a time instead of clearing the list.' });
  const keys = keep.map(function (k) { return k.key; });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO inspection_checklist_archive (item_key, label, type, sort_order, requires_photo, options, retired_by, retired_by_name) ' +
      'SELECT item_key, label, type, sort_order, requires_photo, options, $1, $2 FROM inspection_checklist WHERE NOT (item_key = ANY($3::text[]))',
      [req.user.id, req.user.name || null, keys]
    );
    const { rows: retired } = await client.query(
      'DELETE FROM inspection_checklist WHERE NOT (item_key = ANY($1::text[])) RETURNING item_key',
      [keys]
    );
    // An item that is back on the list drops out of the retired pile, so the same
    // question is never both live and restorable.
    await client.query('DELETE FROM inspection_checklist_archive WHERE item_key = ANY($1::text[])', [keys]);
    for (var j = 0; j < keep.length; j++) {
      var k = keep[j];
      await client.query(
        'INSERT INTO inspection_checklist (item_key, label, type, sort_order, requires_photo, options, active) VALUES ($1,$2,$3,$4,$5,$6,true) ' +
        'ON CONFLICT (item_key) DO UPDATE SET label = EXCLUDED.label, type = EXCLUDED.type, sort_order = EXCLUDED.sort_order, requires_photo = EXCLUDED.requires_photo, options = EXCLUDED.options, active = true',
        [k.key, k.label, k.type, j, k.reqPhoto, k.opts]
      );
    }
    await client.query('COMMIT');
    await logAudit({ entity_type: 'inspection_checklist', entity_id: 0, action: 'edited', user_id: req.user.id, user_name: req.user.name, details: { items: keep.length, retired: retired.map(function (r) { return r.item_key; }) } });
    res.json({ success: true, items: keep.length, retired: retired.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    console.error(err);
    res.status(500).json({ error: 'Failed to save checklist' });
  } finally {
    client.release();
  }
});

// Retired checklist items. Nothing here is asked on an inspection; the table exists
// so a removal can be undone without retyping the item's options and colors.
router.get('/checklist/archive', requireAuth, requirePermission('manage_inspections'), async function (req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, item_key, label, type, sort_order, requires_photo, options, retired_at, retired_by_name ' +
      'FROM inspection_checklist_archive ORDER BY retired_at DESC, id DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load retired items' });
  }
});

// Put a retired item back on the checklist, at the bottom of the list.
router.post('/checklist/archive/:id/restore', requireAuth, requirePermission('manage_inspections'), async function (req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM inspection_checklist_archive WHERE id = $1', [id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Retired item not found' }); }
    var a = rows[0];
    const { rows: live } = await client.query('SELECT 1 FROM inspection_checklist WHERE item_key = $1', [a.item_key]);
    if (live.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'A checklist item with that name is already active. Rename that one first, then restore this.' }); }
    const { rows: mx } = await client.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM inspection_checklist');
    // options comes back from JSONB as a JS array; hand it back as JSON text, or
    // node-postgres writes it as a Postgres array literal instead.
    await client.query(
      'INSERT INTO inspection_checklist (item_key, label, type, sort_order, requires_photo, options, active) VALUES ($1,$2,$3,$4,$5,$6,true)',
      [a.item_key, a.label, a.type, (parseInt(mx[0].m, 10) || 0) + 1, a.requires_photo, a.options == null ? null : JSON.stringify(a.options)]
    );
    await client.query('DELETE FROM inspection_checklist_archive WHERE id = $1', [id]);
    await client.query('COMMIT');
    await logAudit({ entity_type: 'inspection_checklist', entity_id: 0, action: 'restored', user_id: req.user.id, user_name: req.user.name, details: { item_key: a.item_key } });
    res.json({ success: true, item_key: a.item_key });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    console.error(err);
    res.status(500).json({ error: 'Failed to restore item' });
  } finally {
    client.release();
  }
});

// Drop a retired item for good.
router.delete('/checklist/archive/:id', requireAuth, requirePermission('manage_inspections'), async function (req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await pool.query('DELETE FROM inspection_checklist_archive WHERE id = $1 RETURNING item_key', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Retired item not found' });
    await logAudit({ entity_type: 'inspection_checklist', entity_id: 0, action: 'deleted', user_id: req.user.id, user_name: req.user.name, details: { item_key: rows[0].item_key } });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// ===== Compliance grid =====
// Active vehicles (incl. exempt, flagged) joined to the inspection for the month.
router.get('/compliance', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    var month = validMonth(req.query.month) ? req.query.month : etMonth();
    var cityCode = req.query.city_code || null;
    var params = [month];
    var where = 'v.active = true';
    if (!isPrivileged(req.user)) {
      // Non-privileged users see their team's vehicles: reporting downline plus
      // anyone based in a city they run (see utils/org.js). Direct reports only
      // meant a second level of the tree was invisible here.
      params.push(await org.teamIds(req.user.id));
      where += ' AND u.id = ANY($' + params.length + '::int[])';
    } else if (cityCode) {
      params.push(cityCode);
      where += ' AND v.city_code = $' + params.length;
    }
    const { rows } = await pool.query(
      'SELECT v.id as vehicle_id, v.year, v.make_model, v.license_plate, v.city_code, v.assigned_user_id, ' +
      '       v.inspection_exempt, v.inspection_exempt_reason, u.name as driver_name, ' +
      '       u.supervisor_id as driver_supervisor_id, u.role as driver_role, u.home_city as driver_home_city, ' +
      '       mgr.name as manager_name, ' +
      '       v.inspector_id, iu.name as inspector_name, ' +
      '       i.id as inspection_id, i.inspection_number, i.status, i.overall_result, i.mileage, ' +
      '       i.submitted_by, su.name as submitted_by_name, i.created_at as inspected_at, ' +
      '       (SELECT COUNT(*) FROM inspection_photos p WHERE p.inspection_id = i.id AND p.status = $' + (params.length + 1) + ') as photo_count ' +
      'FROM vehicles v ' +
      'LEFT JOIN users u ON v.assigned_user_id = u.id ' +
      'LEFT JOIN users mgr ON u.supervisor_id = mgr.id ' +
      'LEFT JOIN users iu ON v.inspector_id = iu.id ' +
      'LEFT JOIN vehicle_inspections i ON i.vehicle_id = v.id AND i.period_month = $1 ' +
      'LEFT JOIN users su ON i.submitted_by = su.id ' +
      'WHERE ' + where + ' ' +
      'ORDER BY v.inspection_exempt ASC, v.city_code ASC, v.year DESC, v.make_model ASC',
      params.concat(['ready'])
    );
    var cutoff = await getCutoffDay();
    var cityMgr = await org.cityManagerMap();
    rows.forEach(function (r) { resolveInspector(r, cityMgr); });
    // Everyone who can be handed an inspection. Managers belong on this list: the
    // city manager usually IS one, and leaving them off is why the picker only ever
    // offered admins.
    var canAssign = ['admin', 'owner', 'manager'].includes(req.user.role);
    var inspectors = [];
    if (canAssign) {
      const ir = await pool.query("SELECT id, name, role FROM users WHERE active = true AND role IN ('manager', 'admin', 'owner') ORDER BY name");
      inspectors = ir.rows;
    }
    res.json({ month: month, cutoff_day: cutoff, current_month: etMonth(), vehicles: rows, inspectors: inspectors, can_assign_inspector: canAssign });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load compliance grid' });
  }
});

// ===== Assign the inspector responsible for a vehicle (admin / owner / manager) =====
// Managers were added 2026-08-26: handing a van to whoever is actually going to
// walk out to it is the manager's job, and routing every reassignment through an
// admin was the reason vehicles sat on the default. It stays a role check rather
// than manage_inspections, which is now admin-only (checklist, review, delete).
router.put('/vehicle/:id/inspector', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  if (!['admin', 'owner', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only an admin, owner or manager can assign inspectors.' });
  }
  try {
    var vehicleId = parseInt(req.params.id, 10);
    if (!vehicleId) return res.status(400).json({ error: 'Vehicle is required' });
    var inspectorId = req.body.inspector_id ? parseInt(req.body.inspector_id, 10) : null;
    var inspectorName = null;
    if (inspectorId) {
      // Managers belong here as much as admins do - the default inspector IS a city
      // manager, so refusing to save one made the widened picker unusable.
      const ur = await pool.query("SELECT id, name FROM users WHERE id = $1 AND active = true AND role IN ('manager', 'admin', 'owner')", [inspectorId]);
      if (!ur.rows.length) return res.status(400).json({ error: 'Selected user is not a valid inspector.' });
      inspectorName = ur.rows[0].name;
    }
    const vr = await pool.query('UPDATE vehicles SET inspector_id = $1 WHERE id = $2 RETURNING id', [inspectorId, vehicleId]);
    if (!vr.rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    try { await logAudit({ entity_type: 'vehicle', entity_id: vehicleId, action: 'edited', user_id: req.user.id, user_name: req.user.name, details: { inspector_id: inspectorId, inspector_name: inspectorName } }); } catch (e) {}
    res.json({ ok: true, inspector_id: inspectorId, inspector_name: inspectorName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign inspector' });
  }
});

// ===== List (history) =====
router.get('/', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    var vehicleId = req.query.vehicle_id ? parseInt(req.query.vehicle_id, 10) : null;
    var month = validMonth(req.query.month) ? req.query.month : null;
    var params = [];
    var where = [];
    if (vehicleId) { params.push(vehicleId); where.push('i.vehicle_id = $' + params.length); }
    if (month) { params.push(month); where.push('i.period_month = $' + params.length); }
    if (!isPrivileged(req.user)) { params.push(req.user.id); where.push('i.submitted_by = $' + params.length); }
    const { rows } = await pool.query(
      'SELECT i.*, v.year, v.make_model, v.license_plate, su.name as submitted_by_name, ' +
      '(SELECT COUNT(*) FROM inspection_photos p WHERE p.inspection_id = i.id AND p.status = \'ready\') as photo_count ' +
      'FROM vehicle_inspections i ' +
      'JOIN vehicles v ON i.vehicle_id = v.id ' +
      'LEFT JOIN users su ON i.submitted_by = su.id ' +
      (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
      'ORDER BY i.period_month DESC, i.created_at DESC',
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load inspections' });
  }
});

// ===== Single =====
router.get('/:id', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT i.*, v.year, v.make_model, v.vin, v.license_plate, v.city_code as vehicle_city, ' +
      'su.name as submitted_by_name, rv.name as reviewer_name ' +
      'FROM vehicle_inspections i JOIN vehicles v ON i.vehicle_id = v.id ' +
      'LEFT JOIN users su ON i.submitted_by = su.id LEFT JOIN users rv ON i.reviewer_id = rv.id ' +
      'WHERE i.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Inspection not found' });
    const insp = rows[0];
    if (!isPrivileged(req.user) && insp.submitted_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows: items } = await pool.query('SELECT * FROM inspection_items WHERE inspection_id = $1 ORDER BY id', [req.params.id]);
    const { rows: photos } = await pool.query("SELECT id, item_key, name, mime_type, caption, r2_key FROM inspection_photos WHERE inspection_id = $1 AND status = 'ready' ORDER BY id", [req.params.id]);
    for (var p = 0; p < photos.length; p++) {
      try { photos[p].url = await r2.presignDownload(photos[p].r2_key, photos[p].name, true); } catch (e) { photos[p].url = null; }
      delete photos[p].r2_key;
    }
    insp.items = items;
    insp.photos = photos;
    try { insp.followup_items = await followupItemsFor(items); } catch (e) { insp.followup_items = []; }
    insp.driver = await driverOf(insp.vehicle_id);
    res.json(insp);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load inspection' });
  }
});

// ===== Create / submit =====
router.post('/', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  const { vehicle_id, period_month, mileage, notes, items } = req.body;
  if (!vehicle_id) return res.status(400).json({ error: 'Vehicle is required' });
  var month = validMonth(period_month) ? period_month : etMonth();
  try {
    const vr = await pool.query('SELECT v.id, v.city_code, v.assigned_user_id, v.inspection_exempt, v.inspector_id, du.supervisor_id AS driver_supervisor_id FROM vehicles v LEFT JOIN users du ON v.assigned_user_id = du.id WHERE v.id = $1', [vehicle_id]);
    if (!vr.rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    const veh = vr.rows[0];
    if (!canSubmit(req.user, veh.driver_supervisor_id, veh.inspector_id)) {
      return res.status(403).json({ error: 'Only the assigned inspector, the driver\'s manager, or an admin can complete this inspection.' });
    }
    const result = deriveResult(items);
    for (var attempt = 0; attempt < 10; attempt++) {
      const number = await generateInspectionNumber();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ins = await client.query(
          'INSERT INTO vehicle_inspections (inspection_number, vehicle_id, period_month, submitted_by, city_code, mileage, status, overall_result, notes) ' +
          "VALUES ($1,$2,$3,$4,$5,$6,'submitted',$7,$8) RETURNING *",
          [number, vehicle_id, month, req.user.id, veh.city_code || null, mileage ? parseInt(mileage, 10) : null, result, notes || null]
        );
        const insp = ins.rows[0];
        for (const it of (items || [])) {
          if (!it || !it.item_key) continue;
          await client.query(
            'INSERT INTO inspection_items (inspection_id, item_key, label, answer, color, comment) VALUES ($1,$2,$3,$4,$5,$6)',
            [insp.id, String(it.item_key).slice(0, 60), (it.label || '').slice(0, 255), (it.answer || '').slice(0, 60), (it.color || '').toLowerCase().slice(0, 20) || null, it.comment || null]
          );
        }
        if (mileage && parseInt(mileage, 10) > 0) {
          await client.query('UPDATE vehicles SET mileage = $1, updated_at = NOW() WHERE id = $2', [parseInt(mileage, 10), vehicle_id]);
        }
        await client.query('COMMIT');
        client.release();
        await logAudit({ entity_type: 'inspection', entity_id: insp.id, entity_number: number, action: 'submitted', user_id: req.user.id, user_name: req.user.name, details: { vehicle_id: vehicle_id, month: month, result: result } });
        try { insp.followup_items = await followupItemsFor(items); } catch (e) { insp.followup_items = []; }
        insp.driver = await driverOf(vehicle_id);
        return res.status(201).json(insp);
      } catch (err) {
        await client.query('ROLLBACK').catch(function () {});
        client.release();
        if (err.code === '23505') {
          // Unique (vehicle_id, period_month) — already inspected this month.
          if (String(err.constraint || '').indexOf('vehicle_month') !== -1 || String(err.detail || '').indexOf('period_month') !== -1) {
            return res.status(409).json({ error: 'This vehicle has already been inspected for ' + month + '.' });
          }
          if (attempt < 9) continue; // number collision — retry
        }
        console.error(err);
        return res.status(500).json({ error: 'Failed to save inspection' });
      }
    }
    return res.status(500).json({ error: 'Failed to save inspection' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save inspection' });
  }
});

// ===== Update (before review) =====
router.put('/:id', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM vehicle_inspections WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Inspection not found' });
    const insp = rows[0];
    // isPrivileged() includes manager, and it is right to for READ scoping - a
    // manager sees the whole grid. Editing is different: a manager may complete an
    // inspection and fix their own, not rewrite somebody else's, and not reopen a
    // reviewed one. Those stay admin/owner (Tony, 2026-08-26). The UI hid the
    // button already; this closes the API behind it.
    var isAdminOwner = ['admin', 'owner'].includes(req.user.role);
    if (!isAdminOwner && insp.submitted_by !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (insp.status === 'reviewed' && !isAdminOwner) return res.status(400).json({ error: 'Reviewed inspections cannot be edited' });
    const { mileage, notes, items } = req.body;
    const result = deriveResult(items);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE vehicle_inspections SET mileage=$1, notes=$2, overall_result=$3, updated_at=NOW() WHERE id=$4',
        [mileage ? parseInt(mileage, 10) : null, notes || null, result, req.params.id]
      );
      await client.query('DELETE FROM inspection_items WHERE inspection_id = $1', [req.params.id]);
      for (const it of (items || [])) {
        if (!it || !it.item_key) continue;
        await client.query(
          'INSERT INTO inspection_items (inspection_id, item_key, label, answer, color, comment) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.params.id, String(it.item_key).slice(0, 60), (it.label || '').slice(0, 255), (it.answer || '').slice(0, 60), (it.color || '').toLowerCase().slice(0, 20) || null, it.comment || null]
        );
      }
      await client.query('COMMIT');
      await logAudit({ entity_type: 'inspection', entity_id: parseInt(req.params.id, 10), entity_number: insp.inspection_number, action: 'edited', user_id: req.user.id, user_name: req.user.name });
      var _fu = [];
      try { _fu = await followupItemsFor(items); } catch (e) {}
      res.json({ success: true, id: parseInt(req.params.id, 10), followup_items: _fu, driver: await driverOf(insp.vehicle_id), followup_task_id: insp.followup_task_id });
    } catch (err) {
      await client.query('ROLLBACK').catch(function () {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update inspection' });
  }
});

// ===== Manager review sign-off =====
router.post('/:id/review', requireAuth, requirePermission('manage_inspections'), async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM vehicle_inspections WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const insp = rows[0];
    var note = (req.body.note || '').trim();
    await pool.query(
      "UPDATE vehicle_inspections SET status='reviewed', reviewer_id=$1, reviewed_at=NOW(), notes=COALESCE(NULLIF($2,''), notes), updated_at=NOW() WHERE id=$3",
      [req.user.id, note ? ((insp.notes ? insp.notes + '\n\n' : '') + 'Reviewer: ' + note) : '', req.params.id]
    );
    await logAudit({ entity_type: 'inspection', entity_id: insp.id, entity_number: insp.inspection_number, action: 'reviewed', user_id: req.user.id, user_name: req.user.name });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to review' });
  }
});

// ===== Create the follow-up task from flagged inspection items =====
router.post('/:id/followup-task', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    const ir = await pool.query('SELECT * FROM vehicle_inspections WHERE id = $1', [req.params.id]);
    if (!ir.rows.length) return res.status(404).json({ error: 'Inspection not found' });
    const insp = ir.rows[0];
    const vr = await pool.query('SELECT v.id, v.assigned_user_id, v.year, v.make_model, v.license_plate, v.inspector_id, du.supervisor_id AS driver_supervisor_id FROM vehicles v LEFT JOIN users du ON v.assigned_user_id = du.id WHERE v.id = $1', [insp.vehicle_id]);
    const veh = vr.rows[0] || {};
    if (!canSubmit(req.user, veh.driver_supervisor_id, veh.inspector_id)) return res.status(403).json({ error: 'Only the assigned inspector, the driver\'s manager, or an admin can create this task.' });
    if (insp.followup_task_id) return res.status(409).json({ error: 'A follow-up task already exists for this inspection.', task_id: insp.followup_task_id });

    const { rows: items } = await pool.query('SELECT * FROM inspection_items WHERE inspection_id = $1 ORDER BY id', [req.params.id]);
    const issues = await followupItemsFor(items);
    if (!issues.length) return res.status(400).json({ error: 'No items on this inspection are flagged for follow-up.' });

    var assigned_to = req.body.assigned_to ? parseInt(req.body.assigned_to, 10) : (veh.assigned_user_id || req.user.id);
    if (!assigned_to) assigned_to = req.user.id;
    const priorities = ['low', 'medium', 'high', 'urgent'];
    var priority = priorities.indexOf(req.body.priority) !== -1 ? req.body.priority : 'high';
    var due_date = req.body.due_date || null;
    var vehLabel = ((veh.year ? veh.year + ' ' : '') + (veh.make_model || 'Vehicle') + (veh.license_plate ? ' (' + veh.license_plate + ')' : '')).trim();
    var title = (req.body.title && String(req.body.title).trim()) || ('Inspection follow-up \u2014 ' + vehLabel + ' (' + insp.period_month + ')');
    title = title.slice(0, 255);
    var description = req.body.description ? String(req.body.description) : ('Auto-created from inspection ' + insp.inspection_number + '. Items needing attention:\n' + issues.map(function (it) { return '- ' + it.label + (it.answer ? ': ' + it.answer : '') + (it.comment ? ' \u2014 ' + it.comment : ''); }).join('\n'));

    const tr = await pool.query(
      'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, assigned_by, require_due_to_close, source, source_id) ' +
      "VALUES ($1,$2,'todo',$3,$4,$5,$6,$7,true,'inspection',$8) RETURNING *",
      [title, description, priority, assigned_to, req.user.id, due_date, req.user.id, insp.id]
    );
    const task = tr.rows[0];
    for (var i = 0; i < issues.length; i++) {
      var it = issues[i];
      var stitle = (it.label + (it.answer ? ' \u2014 ' + it.answer : '') + (it.comment ? ' (' + it.comment + ')' : '')).slice(0, 500);
      await pool.query('INSERT INTO task_subtasks (task_id, title, position) VALUES ($1,$2,$3)', [task.id, stitle, i]);
    }
    await pool.query('INSERT INTO task_activity (task_id, user_id, user_name, type, body) VALUES ($1,$2,$3,$4,$5)', [task.id, req.user.id, req.user.name, 'event', 'created this task from inspection ' + insp.inspection_number]);
    await pool.query('UPDATE vehicle_inspections SET followup_task_id = $1, updated_at = NOW() WHERE id = $2', [task.id, insp.id]);
    try { await logAudit({ entity_type: 'task', entity_id: task.id, entity_number: '#' + task.id, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { source: 'inspection', inspection: insp.inspection_number } }); } catch (e) {}
    try { const { notifyTaskAssigned } = require('../jobs/taskReminders'); await notifyTaskAssigned(task.id); } catch (e) {}
    res.status(201).json({ success: true, task_id: task.id, inspection_id: insp.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create follow-up task' });
  }
});

// ===== Delete =====
router.delete('/:id', requireAuth, requirePermission('manage_inspections'), async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM vehicle_inspections WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const insp = rows[0];
    const photos = await pool.query('SELECT r2_key FROM inspection_photos WHERE inspection_id = $1', [req.params.id]);
    for (const p of photos.rows) { try { await r2.deleteObject(p.r2_key); } catch (e) { console.error('R2 delete failed:', e.message); } }
    await pool.query('DELETE FROM vehicle_inspections WHERE id = $1', [req.params.id]);
    await logAudit({ entity_type: 'inspection', entity_id: insp.id, entity_number: insp.inspection_number, action: 'deleted', user_id: req.user.id, user_name: req.user.name });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// ===== Photos =====
async function loadInspForPhoto(id) {
  const { rows } = await pool.query('SELECT * FROM vehicle_inspections WHERE id = $1', [id]);
  return rows[0] || null;
}

// Step 1: reserve a record + presigned PUT URL.
router.post('/:id/photos/upload-url', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not configured yet. Add the R2_* environment variables in Railway.' });
    const insp = await loadInspForPhoto(req.params.id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    if (!isPrivileged(req.user) && insp.submitted_by !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const name = (req.body.name || 'photo.jpg').slice(0, 255);
    const mime = (req.body.mime_type || 'image/jpeg').slice(0, 255);
    const itemKey = (req.body.item_key || '').slice(0, 60) || null;
    const caption = (req.body.caption || '').slice(0, 255) || null;
    const key = 'inspection-photos/' + req.params.id + '/' + crypto.randomUUID() + '/' + sanitizePhotoName(name);
    const { rows } = await pool.query(
      "INSERT INTO inspection_photos (inspection_id, item_key, name, r2_key, mime_type, caption, uploaded_by, uploaded_by_name, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id",
      [req.params.id, itemKey, name, key, mime, caption, req.user.id, req.user.name]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, uploadUrl: uploadUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start upload' });
  }
});

// Step 2: confirm upload completed.
router.post('/photos/:photoId/confirm', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT p.*, i.submitted_by FROM inspection_photos p JOIN vehicle_inspections i ON p.inspection_id = i.id WHERE p.id = $1', [req.params.photoId]);
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (!isPrivileged(req.user) && rows[0].submitted_by !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const size = Math.max(0, parseInt(req.body.size_bytes, 10) || 0);
    await pool.query("UPDATE inspection_photos SET size_bytes = $1, status = 'ready' WHERE id = $2", [size, req.params.photoId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

// Presigned inline URL for a single photo.
router.get('/photos/:photoId/download', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not configured yet.' });
    const { rows } = await pool.query("SELECT p.*, i.submitted_by FROM inspection_photos p JOIN vehicle_inspections i ON p.inspection_id = i.id WHERE p.id = $1 AND p.status = 'ready'", [req.params.photoId]);
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (!isPrivileged(req.user) && rows[0].submitted_by !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const url = await r2.presignDownload(rows[0].r2_key, rows[0].name, req.query.inline !== '0');
    res.json({ url: url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate link' });
  }
});

router.delete('/photos/:photoId', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT p.*, i.submitted_by FROM inspection_photos p JOIN vehicle_inspections i ON p.inspection_id = i.id WHERE p.id = $1', [req.params.photoId]);
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (!isPrivileged(req.user) && rows[0].submitted_by !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    try { await r2.deleteObject(rows[0].r2_key); } catch (e) { console.error('R2 delete failed:', e.message); }
    await pool.query('DELETE FROM inspection_photos WHERE id = $1', [req.params.photoId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

router.resolveInspector = resolveInspector;
module.exports = router;
