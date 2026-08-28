const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission, userHasExtraPerm } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const vault = require('../utils/vaultAccess');
const fleetDocs = require('../utils/fleetDocs');
const r2 = require('../utils/r2');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// The cities a user is actually bound to, from their assignments and then their
// home city. Returns null when they have no binding at all, which - matching
// routes/schedule.js and routes/running.js - means unrestricted rather than locked
// out, so a tech with no city on their profile does not lose the vehicle picker.
// Admins and managers are never restricted here.
async function userCityCodes(user) {
  if (['admin', 'manager'].includes(user.role)) return null;
  var out = [];
  try {
    const r = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [user.id]);
    r.rows.forEach(function (x) {
      var c = (x.city_code || '').trim().toUpperCase();
      if (c && out.indexOf(c) === -1) out.push(c);
    });
    const h = await pool.query('SELECT home_city FROM users WHERE id = $1', [user.id]);
    var hc = h.rows.length ? (h.rows[0].home_city || '').trim().toUpperCase() : '';
    if (hc && out.indexOf(hc) === -1) out.push(hc);
  } catch (e) { return null; }
  return out.length ? out : null;
}

// Can this person see this vehicle at all? Admins and managers see the whole
// fleet; everyone else only vehicles in a city they are bound to. Note it is
// STRICTER than the list route: a user with no city binding is denied here
// rather than treated as unrestricted, matching what GET /:id has always done.
//
// This is also the ONLY gate on reading a vehicle's registration and insurance
// card. The vault's own sharing rules are deliberately NOT consulted on that
// path: the person who needs the insurance card at the roadside is the tech
// driving the van, and he has no business in the Document Vault. The vault rules
// still decide who may browse, upload, rename, delete and ATTACH - see the
// attach route below, which refuses a file the caller cannot already see.
async function canSeeVehicle(user, vehicle) {
  if (['admin', 'manager'].includes(user.role)) return true;
  var scope = await userCityCodes(user);
  var vcity = (vehicle.city_code || '').trim().toUpperCase();
  return !!scope && scope.indexOf(vcity) !== -1;
}

async function canManageVehicleDocs(req) {
  try {
    if (await permissions.hasPermission(req.user.role, 'manage_vehicle_docs')) return true;
  } catch (e) { /* fall through to extra_perms */ }
  try {
    return !!(req.user.id && await userHasExtraPerm(req, req.user.id, 'manage_vehicle_docs'));
  } catch (e) { return false; }
}

// Load a vehicle for a document operation, applying the visibility rule above.
// Returns null after having already sent the response.
async function vehicleForDocs(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) { res.status(400).json({ error: 'Bad vehicle id' }); return null; }
  const { rows } = await pool.query('SELECT id, year, make_model, vin, license_plate, city_code, active FROM vehicles WHERE id = $1', [id]);
  if (!rows.length) { res.status(404).json({ error: 'Vehicle not found' }); return null; }
  if (!(await canSeeVehicle(req.user, rows[0]))) { res.status(403).json({ error: 'Forbidden' }); return null; }
  return rows[0];
}

async function activeVehicleCount() {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM vehicles WHERE active = true');
    return r.rows[0].n;
  } catch (e) { return null; }
}

// GET active vehicles — requires city_code for non-admin/manager; returns city-filtered list
router.get('/', requireAuth, async function(req, res) {
  try {
    var city_code = req.query.city_code || null;
    var isPrivileged = ['admin', 'manager'].includes(req.user.role);
    // Non-privileged users must supply a city_code — prevents full fleet enumeration
    if (!city_code && !isPrivileged) return res.json([]);
    // ...and the city they ask for has to be one of their own. Supplying a city code
    // used to be the ONLY check, so any logged-in user could enumerate the whole fleet
    // city by city (directly or through a Nova AI tool).
    var scope = await userCityCodes(req.user);
    if (scope && city_code && scope.indexOf(String(city_code).trim().toUpperCase()) === -1) {
      return res.status(403).json({ error: 'You can only see vehicles in your assigned cities.' });
    }
    var query = 'SELECT v.*, u.name as driver_name FROM vehicles v LEFT JOIN users u ON v.assigned_user_id = u.id WHERE v.active = true';
    var params = [];
    if (city_code) { params.push(city_code); query += ' AND v.city_code = $' + params.length; }
    query += ' ORDER BY v.year DESC, v.make_model ASC';
    const { rows } = await pool.query(query, params);
    // key_codes are the real cut codes for the fleet. The single-vehicle route below
    // already strips them for non-privileged callers; the list route did not.
    if (!isPrivileged) rows.forEach(function (v) { delete v.key_codes; });
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

// ===== Fleet documents =====
// Registration and insurance cards are vault files pointed at by
// vehicle_documents. Nothing here stores a second copy of a file, so replacing
// the file in the vault updates every vehicle linked to it at once.

// Per-vehicle registration/insurance rollup for the whole registry, so the list
// can colour its Documents column in one request instead of one per row.
// Registered ABOVE '/:id' on purpose - Express matches in order and would
// otherwise read 'doc-summary' as a vehicle id.
router.get('/doc-summary', requireAuth, requirePermission('manage_vehicles'), async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT id, active FROM vehicles');
    const summary = await fleetDocs.summaryForVehicles(rows);
    res.json({
      summary: summary,
      counts: fleetDocs.countsNeedingAttention(summary, rows),
      canManage: await canManageVehicleDocs(req)
    });
  } catch (err) {
    console.error('Vehicle doc-summary error:', err);
    res.status(500).json({ error: 'Failed to load document status' });
  }
});

// Everything that applies to one vehicle: files linked to it, plus any file
// marked as covering the whole fleet.
router.get('/:id/documents', requireAuth, async function (req, res) {
  try {
    const vehicle = await vehicleForDocs(req, res);
    if (!vehicle) return;
    const docs = await fleetDocs.docsForVehicle(vehicle.id, {
      vehicleActive: !!vehicle.active,
      activeVehicleCount: await activeVehicleCount()
    });
    res.json({
      vehicle: { id: vehicle.id, year: vehicle.year, make_model: vehicle.make_model, vin: vehicle.vin, license_plate: vehicle.license_plate, active: !!vehicle.active },
      documents: docs,
      canManage: await canManageVehicleDocs(req),
      storageReady: r2.configured()
    });
  } catch (err) {
    console.error('Vehicle documents error:', err);
    res.status(500).json({ error: 'Failed to load documents for this vehicle' });
  }
});

// A short-lived presigned URL for one of them. The document id is checked
// against what actually applies to THIS vehicle first - without that check this
// route would hand out a link to any file in the vault to anyone who can see any
// truck, which is exactly the hole the vehicle read path could open.
router.get('/:id/documents/:documentId/url', requireAuth, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Document storage is not configured yet.' });
    const vehicle = await vehicleForDocs(req, res);
    if (!vehicle) return;
    const documentId = parseInt(req.params.documentId, 10);
    const docs = await fleetDocs.docsForVehicle(vehicle.id, { vehicleActive: !!vehicle.active });
    const match = docs.filter(function (d) { return d.document_id === documentId; })[0];
    if (!match) return res.status(404).json({ error: 'That document is not attached to this vehicle' });
    const dr = await pool.query("SELECT r2_key, name FROM documents WHERE id = $1 AND status = 'ready'", [documentId]);
    if (!dr.rows.length) return res.status(404).json({ error: 'File not found' });
    const url = await r2.presignDownload(dr.rows[0].r2_key, dr.rows[0].name, req.query.inline === '1');
    res.json({ url: url });
  } catch (err) {
    console.error('Vehicle document url error:', err);
    res.status(500).json({ error: 'Failed to open that document' });
  }
});

// Attach an existing vault file. There is deliberately no upload here: a file
// that only exists on a vehicle is the per-vehicle filing this whole feature
// exists to avoid. The caller must be able to SEE the file in the vault, which
// is what stops someone with fleet rights from parking an HR document on a van
// and reading it back through the route above.
router.post('/:id/documents', requireAuth, requirePermission('manage_vehicle_docs'), async function (req, res) {
  try {
    const vehicle = await vehicleForDocs(req, res);
    if (!vehicle) return;
    const documentId = parseInt(req.body.document_id, 10);
    const kind = String(req.body.kind || '');
    if (!documentId) return res.status(400).json({ error: 'Pick a file' });
    if (fleetDocs.KINDS.indexOf(kind) === -1) return res.status(400).json({ error: 'Say whether this is a registration or an insurance document' });

    const dr = await pool.query("SELECT id, name, folder_id, owner_id FROM documents WHERE id = $1 AND status = 'ready'", [documentId]);
    if (!dr.rows.length) return res.status(404).json({ error: 'File not found' });
    const ctx = await vault.loadContext(req.user);
    if (!vault.canViewFile(ctx, dr.rows[0])) return res.status(403).json({ error: 'You do not have access to that file' });

    // Attaching the same file to the same vehicle twice is a no-op, not an error.
    await pool.query(
      'INSERT INTO vehicle_documents (vehicle_id, document_id, kind, link_source, created_by, created_by_name) ' +
      "VALUES ($1,$2,$3,'manual',$4,$5) ON CONFLICT (vehicle_id, document_id, kind) DO NOTHING",
      [vehicle.id, documentId, kind, req.user.id, req.user.name]
    );
    logAudit({
      entity_type: 'vehicle', entity_id: vehicle.id, action: 'attach_document',
      user_id: req.user.id, user_name: req.user.name,
      details: { document_id: documentId, name: dr.rows[0].name, kind: kind }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Attach vehicle document error:', err);
    res.status(500).json({ error: 'Failed to attach that document' });
  }
});

// Detach. This removes the LINK only - the file stays in the vault, which is the
// difference between unlinking a registration and destroying it.
router.delete('/:id/documents/:linkId', requireAuth, requirePermission('manage_vehicle_docs'), async function (req, res) {
  try {
    const vehicle = await vehicleForDocs(req, res);
    if (!vehicle) return;
    const linkId = parseInt(req.params.linkId, 10);
    const { rows } = await pool.query(
      'DELETE FROM vehicle_documents WHERE id = $1 AND vehicle_id = $2 RETURNING document_id, kind',
      [linkId, vehicle.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'That link is already gone' });
    logAudit({
      entity_type: 'vehicle', entity_id: vehicle.id, action: 'detach_document',
      user_id: req.user.id, user_name: req.user.name,
      details: { document_id: rows[0].document_id, kind: rows[0].kind }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Detach vehicle document error:', err);
    res.status(500).json({ error: 'Failed to remove that document' });
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
    // Mirror the list route's privilege model. Non-privileged users may only see a vehicle
    // in one of their OWN cities, and never the sensitive key_codes. This used to scope by
    // the requester-supplied city_code, which meant the caller graded their own homework.
    var isPrivileged = ['admin', 'manager'].includes(req.user.role);
    var vehicle = rows[0];
    if (!isPrivileged) {
      var scope = await userCityCodes(req.user);
      var vcity = (vehicle.city_code || '').trim().toUpperCase();
      if (!scope || scope.indexOf(vcity) === -1) return res.status(403).json({ error: 'Forbidden' });
      vehicle = Object.assign({}, vehicle);
      delete vehicle.key_codes;
    }
    res.json(vehicle);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicle' });
  }
});

// POST create vehicle — admin/manager only
router.post('/', requireAuth, requirePermission('manage_vehicles'), async function(req, res) {
  const { year, make_model, vin, key_codes, assigned_user_id, city_code, date_of_assignment, license_plate, mileage, notes, inspection_exempt, inspection_exempt_reason } = req.body;
  if (!year || !make_model) return res.status(400).json({ error: 'Year and Make/Model are required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO vehicles (year, make_model, vin, key_codes, assigned_user_id, city_code, date_of_assignment, license_plate, mileage, notes, inspection_exempt, inspection_exempt_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [parseInt(year), make_model, vin || null, key_codes || null, assigned_user_id || null, city_code || null, date_of_assignment || null, license_plate || null, mileage ? parseInt(mileage) : null, notes || null, inspection_exempt === true, inspection_exempt ? (inspection_exempt_reason || null) : null]
    );
    res.status(201).json(rows[0]);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create vehicle' });
  }
});

// PUT update vehicle — admin/manager only
router.put('/:id', requireAuth, requirePermission('manage_vehicles'), async function(req, res) {
  const { year, make_model, vin, key_codes, assigned_user_id, city_code, date_of_assignment, license_plate, mileage, notes, inspection_exempt, inspection_exempt_reason } = req.body;
  if (!year || !make_model) return res.status(400).json({ error: 'Year and Make/Model are required' });
  try {
    const { rows } = await pool.query(
      'UPDATE vehicles SET year=$1, make_model=$2, vin=$3, key_codes=$4, assigned_user_id=$5, city_code=$6, date_of_assignment=$7, license_plate=$8, mileage = COALESCE($9, mileage), notes=$10, inspection_exempt=$11, inspection_exempt_reason=$12, updated_at=NOW() WHERE id=$13 RETURNING *',
      [parseInt(year), make_model, vin || null, key_codes || null, assigned_user_id || null, city_code || null, date_of_assignment || null, license_plate || null, mileage ? parseInt(mileage) : null, notes || null, inspection_exempt === true, inspection_exempt ? (inspection_exempt_reason || null) : null, req.params.id]
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
