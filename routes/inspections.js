const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');

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
function colorSeverity(color) {
  var c = (color || '').toLowerCase();
  if (c === 'red') return 'fail';
  if (c === 'yellow' || c === 'orange') return 'attention';
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

function sanitizePhotoName(name) {
  return String(name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'photo';
}

function isPrivileged(user) { return ['admin', 'owner', 'manager'].includes(user.role); }
// Who may COMPLETE an inspection: admins/managers, or the assigned driver's direct manager (supervisor).
function canSubmit(user, driverSupervisorId) {
  if (['admin', 'owner', 'manager'].includes(user.role)) return true;
  return !!(driverSupervisorId && user.id === driverSupervisorId);
}

// ===== Checklist =====
// Active checklist (for the entry form). Admins/managers get all + inactive via ?all=1.
router.get('/checklist', requireAuth, requirePermission('view_inspections'), async function (req, res) {
  try {
    var all = req.query.all === '1' && isPrivileged(req.user);
    const { rows } = await pool.query(
      'SELECT id, item_key, label, type, sort_order, requires_photo, options, active FROM inspection_checklist' +
      (all ? '' : ' WHERE active = true') +
      ' ORDER BY sort_order, id'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load checklist' });
  }
});

// Replace the checklist definition (manage only).
router.put('/checklist', requireAuth, requirePermission('manage_inspections'), async function (req, res) {
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items array required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Deactivate everything, then upsert the provided rows as active.
    await client.query('UPDATE inspection_checklist SET active = false');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var key = (it.item_key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
      var label = (it.label || '').trim().slice(0, 255);
      if (!key || !label) continue;
      var type = (it.type === 'text') ? 'text' : 'dropdown';
      var opts = null;
      if (type === 'dropdown' && Array.isArray(it.options)) {
        var clean = it.options.map(function (o) { return { label: String((o && o.label) || '').slice(0, 60), color: String((o && o.color) || '').toLowerCase().slice(0, 20) }; }).filter(function (o) { return o.label; });
        opts = JSON.stringify(clean);
      }
      var reqPhoto = !!it.requires_photo;
      await client.query(
        'INSERT INTO inspection_checklist (item_key, label, type, sort_order, requires_photo, options, active) VALUES ($1,$2,$3,$4,$5,$6,true) ' +
        'ON CONFLICT (item_key) DO UPDATE SET label = EXCLUDED.label, type = EXCLUDED.type, sort_order = EXCLUDED.sort_order, requires_photo = EXCLUDED.requires_photo, options = EXCLUDED.options, active = true',
        [key, label, type, i, reqPhoto, opts]
      );
    }
    await client.query('COMMIT');
    await logAudit({ entity_type: 'inspection_checklist', entity_id: 0, action: 'edited', user_id: req.user.id, user_name: req.user.name });
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    console.error(err);
    res.status(500).json({ error: 'Failed to save checklist' });
  } finally {
    client.release();
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
      // Non-privileged users see the vehicles of the drivers who report to them.
      params.push(req.user.id);
      where += ' AND u.supervisor_id = $' + params.length;
    } else if (cityCode) {
      params.push(cityCode);
      where += ' AND v.city_code = $' + params.length;
    }
    const { rows } = await pool.query(
      'SELECT v.id as vehicle_id, v.year, v.make_model, v.license_plate, v.city_code, v.assigned_user_id, ' +
      '       v.inspection_exempt, v.inspection_exempt_reason, u.name as driver_name, ' +
      '       u.supervisor_id as driver_supervisor_id, mgr.name as manager_name, ' +
      '       i.id as inspection_id, i.inspection_number, i.status, i.overall_result, i.mileage, ' +
      '       i.submitted_by, su.name as submitted_by_name, i.created_at as inspected_at, ' +
      '       (SELECT COUNT(*) FROM inspection_photos p WHERE p.inspection_id = i.id AND p.status = $' + (params.length + 1) + ') as photo_count ' +
      'FROM vehicles v ' +
      'LEFT JOIN users u ON v.assigned_user_id = u.id ' +
      'LEFT JOIN users mgr ON u.supervisor_id = mgr.id ' +
      'LEFT JOIN vehicle_inspections i ON i.vehicle_id = v.id AND i.period_month = $1 ' +
      'LEFT JOIN users su ON i.submitted_by = su.id ' +
      'WHERE ' + where + ' ' +
      'ORDER BY v.inspection_exempt ASC, v.city_code ASC, v.year DESC, v.make_model ASC',
      params.concat(['ready'])
    );
    var cutoff = await getCutoffDay();
    res.json({ month: month, cutoff_day: cutoff, current_month: etMonth(), vehicles: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load compliance grid' });
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
    const vr = await pool.query('SELECT v.id, v.city_code, v.assigned_user_id, v.inspection_exempt, du.supervisor_id AS driver_supervisor_id FROM vehicles v LEFT JOIN users du ON v.assigned_user_id = du.id WHERE v.id = $1', [vehicle_id]);
    if (!vr.rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    const veh = vr.rows[0];
    if (!canSubmit(req.user, veh.driver_supervisor_id)) {
      return res.status(403).json({ error: 'Only the driver\'s manager (or an admin) can complete this inspection.' });
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
    if (!isPrivileged(req.user) && insp.submitted_by !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (insp.status === 'reviewed' && !isPrivileged(req.user)) return res.status(400).json({ error: 'Reviewed inspections cannot be edited' });
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
      res.json({ success: true, id: parseInt(req.params.id, 10) });
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

module.exports = router;
