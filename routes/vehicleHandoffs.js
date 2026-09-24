// Vehicle assignment & turn-in sheets.
//
// A manager, admin or owner STARTS a sheet: which vehicle, which driver, a
// deadline, and who fills it out (the driver on their phone, or the manager in
// person). Whoever fills it out records the odometer and fuel, takes the photos
// with Nova's own camera, checks the damage diagram and answers the checklist.
// The DRIVER always initials the agreement(s) and signs on their own login. The
// manager reviews, can send a photo or the whole sheet back, and countersigns.
// Only the countersign changes Fleet (vehicles.assigned_user_id) - that is the
// whole point of the module. Decisions: Tony, 2026-09-23/24.
//
// Permissions (ship dark, CLAUDE.md 1.5):
//   view_vehicle_handoffs   - see the queue and any sheet
//   manage_vehicle_handoffs - start, review, send back, countersign, void, and
//                             edit the photo slots / checklist / agreement library
// The DRIVER needs neither: acting on your own sheet is gated by being the named
// driver, checked in every handler, never by a role.
//
// The rules about what a sheet still needs live in utils/vehicleHandoff.js (pure,
// testable). The drawing lives in utils/vehicleDiagram.js. The PDF in
// utils/handoffPdf.js.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission, userHasExtraPerm } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const push = require('../utils/push');
const r2 = require('../utils/r2');
const VH = require('../utils/vehicleHandoff');
const VD = require('../utils/vehicleDiagram');
const handoffPdf = require('../utils/handoffPdf');

const router = express.Router();

var MAX_SIGNATURE_CHARS = 600000;      // a drawn PNG signature is ~20-80 KB of base64
var MAX_PHOTO_BYTES = 15 * 1024 * 1024;
var CONFIRM_WINDOW_MIN = 15;           // a photo must be confirmed within this long of the shutter

// ---------------------------------------------------------------- helpers

function sendErr(res, err, msg) {
  console.error('[vehicle-handoffs] ' + msg + ':', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: msg });
}

function clientIp(req) {
  var xf = ((req.headers && req.headers['x-forwarded-for']) || '').toString().split(',')[0].trim();
  return (xf || req.ip || '').toString().slice(0, 64);
}

function intOrNull(v) { var n = parseInt(v, 10); return isFinite(n) ? n : null; }
function numOrNull(v) { var n = Number(v); return (v === null || v === undefined || v === '' || !isFinite(n)) ? null : n; }

function etToday() {
  return new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
}
function etMonth() { return etToday().slice(0, 7); }
function appUrl(path) { return (process.env.APP_URL || '').replace(/\/$/, '') + path; }

// Permission check inside a handler (for routes the driver can also reach).
async function hasPerm(req, perm) {
  if (!req.user) return false;
  if (req.user.role === 'admin' || req.user.role === 'owner') return true;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (e) { /* fall through */ }
  try { return !!(req.user.id && await userHasExtraPerm(req, req.user.id, perm)); } catch (e) { return false; }
}
function isAdminOwner(req) { return req.user && (req.user.role === 'admin' || req.user.role === 'owner'); }

async function settingJson(key, fallback) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (!r.rows.length || !r.rows[0].value) return fallback;
    var v = JSON.parse(r.rows[0].value);
    return (Array.isArray(v) && v.length) ? v : fallback;
  } catch (e) { return fallback; }
}
async function saveSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)]
  );
}
function photoSlotsSetting() { return settingJson('vehicle_sheet_photo_slots', VH.DEFAULT_PHOTO_SLOTS); }
function checklistSetting() { return settingJson('vehicle_sheet_checklist', VH.DEFAULT_CHECKLIST); }

// VA-2026-0001 / VT-2026-0001, year-sequenced per kind.
async function nextNumber(db, kind) {
  var prefix = VH.numberPrefix(kind) + '-' + new Date().getFullYear() + '-';
  const r = await db.query(
    "SELECT MAX(CAST(SPLIT_PART(handoff_number, '-', 3) AS INTEGER)) AS maxseq FROM vehicle_handoffs WHERE handoff_number LIKE $1",
    [prefix + '%']
  );
  return prefix + String((r.rows[0].maxseq || 0) + 1).padStart(4, '0');
}

var SHEET_SELECT =
  'SELECT h.*, v.year AS v_year, v.make_model AS v_make_model, v.vin AS v_vin, v.license_plate AS v_plate, ' +
  '       v.city_code AS v_city, v.assigned_user_id AS v_assigned_user_id, v.mileage AS v_mileage, ' +
  "       COALESCE(v.body_type, 'express') AS v_body_type, v.key_codes AS v_key_codes, " +
  '       du.name AS driver_name, du.email AS driver_email, du.phone AS driver_phone, du.role AS driver_role, ' +
  '       cu.name AS created_by_name, mu.name AS manager_name, ru.name AS reassign_to_name ' +
  'FROM vehicle_handoffs h JOIN vehicles v ON v.id = h.vehicle_id ' +
  'LEFT JOIN users du ON du.id = h.driver_user_id ' +
  'LEFT JOIN users cu ON cu.id = h.created_by ' +
  'LEFT JOIN users mu ON mu.id = h.manager_user_id ' +
  'LEFT JOIN users ru ON ru.id = h.reassign_to_user_id ';

async function loadSheet(id, db) {
  const r = await (db || pool).query(SHEET_SELECT + 'WHERE h.id = $1', [id]);
  return r.rows[0] || null;
}

function vehicleName(s) { return [s.v_year, s.v_make_model].filter(Boolean).join(' ') + (s.v_plate ? ' (' + s.v_plate + ')' : ''); }

async function photosFor(sheetId) {
  const r = await pool.query(
    "SELECT * FROM vehicle_handoff_photos WHERE handoff_id = $1 AND status IN ('ready','rejected') ORDER BY captured_at",
    [sheetId]
  );
  return r.rows;
}

// Marks relevant to a sheet: every open mark on the vehicle, plus anything this
// sheet created or changed (so a mark repaired on this sheet still shows here).
async function marksFor(sheet) {
  const r = await pool.query(
    'SELECT m.*, u.name AS created_by_name FROM vehicle_damage_marks m LEFT JOIN users u ON u.id = m.created_by ' +
    "WHERE m.vehicle_id = $1 AND (m.status = 'open' OR m.created_handoff_id = $2 OR m.changed_handoff_id = $2) ORDER BY m.mark_no",
    [sheet.vehicle_id, sheet.id]
  );
  return r.rows.map(function (m) { m.x = Number(m.x); m.y = Number(m.y); return m; });
}

async function agreementsFor(sheetId) {
  const r = await pool.query('SELECT * FROM vehicle_handoff_agreements WHERE handoff_id = $1 ORDER BY id', [sheetId]);
  return r.rows;
}

// Who is looking at this sheet, and what may they do.
async function accessFor(req, sheet) {
  var isDriver = !!(sheet.driver_user_id && req.user.id === sheet.driver_user_id);
  var canManage = await hasPerm(req, 'manage_vehicle_handoffs');
  var canView = canManage || isDriver || await hasPerm(req, 'view_vehicle_handoffs');
  var editable = VH.isEditable(sheet.status);
  // A manager-filled sheet is the manager's until they hand it to the driver.
  var managerStillFilling = sheet.filled_by === 'manager' && sheet.status === 'in_progress';
  var driverTurn = isDriver && editable && !managerStillFilling && !sheet.driver_not_present;
  return {
    is_driver: isDriver,
    can_view: canView,
    can_manage: canManage,
    can_fill: editable && ((sheet.filled_by === 'driver' && driverTurn) || canManage),
    can_add_marks: editable && (driverTurn || canManage),
    can_sign: driverTurn,
    can_review: canManage && VH.isOpen(sheet.status),
    // Nobody countersigns their own vehicle unless they are admin/owner.
    can_countersign: canManage && sheet.status === 'ready_for_review' && (!isDriver || isAdminOwner(req))
  };
}

async function photoUrls(photos) {
  var out = [];
  for (var i = 0; i < photos.length; i++) {
    var p = photos[i];
    var url = null;
    try { url = await r2.presignDownload(p.r2_key, null, true, 3600, 'image/jpeg'); } catch (e) { url = null; }
    out.push({
      id: p.id, slot_key: p.slot_key, slot_label: p.slot_label, mark_id: p.mark_id, status: p.status,
      captured_at: p.captured_at, reject_reason: p.reject_reason, replaces_photo_id: p.replaces_photo_id,
      uploaded_by: p.uploaded_by, url: url
    });
  }
  return out;
}

async function sheetPayload(req, sheet) {
  var access = await accessFor(req, sheet);
  var photos = await photosFor(sheet.id);
  var marks = await marksFor(sheet);
  var agreements = await agreementsFor(sheet.id);
  marks.forEach(function (m) { m.state = VH.markState(m, sheet); });
  var out = {};
  Object.keys(sheet).forEach(function (k) { out[k] = sheet[k]; });
  // Signatures are large; send only whether they exist.
  out.driver_signature = null;
  out.manager_signature = null;
  out.has_driver_signature = !!sheet.driver_signature;
  out.has_manager_signature = !!sheet.manager_signature;
  out.vehicle_name = vehicleName(sheet);
  out.status_label = VH.STATUS_LABEL[sheet.status] || sheet.status;
  out.photos = await photoUrls(photos);
  out.marks = marks;
  out.agreements = agreements;
  out.missing_for_sign = VH.missingForDriverSign(sheet, photos, agreements, marks);
  out.missing_for_countersign = VH.missingForCountersign(sheet, photos, agreements, marks);
  out.access = access;
  return out;
}

async function userRow(id) {
  if (!id) return null;
  const r = await pool.query('SELECT id, name, email, phone, role, active, receive_sms, receive_emails FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// Push + text + email to one person. Every channel fails quietly on its own; a
// sheet must never fail to save because a text did not go out.
async function notifyUser(userId, title, body, link, opts) {
  opts = opts || {};
  var u = null;
  try { u = await userRow(userId); } catch (e) { u = null; }
  if (!u || u.active === false) return;
  try { await push.sendPushToUsers([u.id], { title: title, body: body, url: link }); } catch (e) { console.error('[vehicle-handoffs] push:', e.message); }
  if (opts.sms && u.phone && u.receive_sms !== false) {
    try { await sendSms(u.phone, 'Nova: ' + body + ' ' + appUrl(link)); } catch (e) { console.error('[vehicle-handoffs] sms:', e.message); }
  }
  if (u.email && u.receive_emails !== false) {
    try {
      var html = emailTemplate({
        badge: opts.badge || 'Fleet', badgeColor: opts.badgeColor || 'orange',
        title: VH.esc(title), body: VH.esc(body),
        details: opts.details || [],
        buttonText: opts.buttonText || 'Open in Nova', buttonUrl: appUrl(link)
      });
      await sendEmail(u.email, title, html);
    } catch (e) { console.error('[vehicle-handoffs] email:', e.message); }
  }
}

function sheetLink(sheet, forDriver) {
  return forDriver ? '/?view=vehicle-sheet&id=' + sheet.id : '/?view=vehicle-handoff&id=' + sheet.id;
}

async function audit(req, sheet, action, details) {
  try {
    await logAudit({
      entity_type: 'vehicle_handoff', entity_id: sheet.id, entity_number: sheet.handoff_number, action: action,
      user_id: req.user && req.user.id, user_name: req.user && req.user.name, details: details || {}
    });
  } catch (e) { /* audit must never break the flow */ }
}

function checkSignature(data) {
  if (typeof data !== 'string' || data.indexOf('data:image/png;base64,') !== 0) return 'Draw or type a signature first.';
  if (data.length > MAX_SIGNATURE_CHARS) return 'That signature is too large. Clear it and sign again.';
  return null;
}

// Load a sheet for a route and check access. Returns null after answering.
async function sheetForRoute(req, res, needs) {
  var id = intOrNull(req.params.id);
  if (!id) { res.status(400).json({ error: 'Bad sheet id' }); return null; }
  var sheet = await loadSheet(id);
  if (!sheet) { res.status(404).json({ error: 'Sheet not found' }); return null; }
  var access = await accessFor(req, sheet);
  if (!access.can_view) { res.status(403).json({ error: 'Forbidden' }); return null; }
  if (needs && !access[needs]) {
    var msg = {
      can_fill: 'This sheet cannot be changed right now.',
      can_add_marks: 'Damage marks cannot be changed on this sheet right now.',
      can_sign: 'Only the driver named on this sheet can do that, and only while it is open.',
      can_manage: 'Only a manager can do that.',
      can_review: 'Only a manager can do that, and only while the sheet is open.',
      can_countersign: 'This sheet is not ready to countersign.'
    }[needs] || 'Forbidden';
    res.status(403).json({ error: msg }); return null;
  }
  sheet._access = access;
  return sheet;
}

// When the driver edits a sheet that was waiting on them, it is now in progress.
async function touchInProgress(sheet, req) {
  // Driver-filled sheets only. A manager-filled sheet sitting at awaiting_driver
  // is waiting for initials and a signature; flipping it to in_progress would
  // hand it back to the manager mid-initials (in_progress + filled_by manager is
  // the manager's turn).
  if (sheet.status === 'awaiting_driver' && sheet.filled_by === 'driver' && req.user.id === sheet.driver_user_id) {
    await pool.query("UPDATE vehicle_handoffs SET status = 'in_progress', updated_at = NOW() WHERE id = $1 AND status = 'awaiting_driver'", [sheet.id]);
  }
}

// ---------------------------------------------------------------- config

// Everything the screens need to draw a sheet: slots, checklist, damage types,
// fuel levels, and the live agreements a manager can pick.
router.get('/config', requireAuth, async function (req, res) {
  try {
    var ag = await pool.query("SELECT id, name, use_on, is_default, version, status FROM vehicle_agreements WHERE status = 'live' ORDER BY is_default DESC, name");
    res.json({
      photo_slots: await photoSlotsSetting(),
      checklist: await checklistSetting(),
      damage_kinds: VD.DAMAGE_KINDS, severities: VD.SEVERITIES, fuel_levels: VH.FUEL_LEVELS,
      turn_in_reasons: VH.TURN_IN_REASONS, status_labels: VH.STATUS_LABEL,
      agreements: ag.rows, templates: VD.templateTypes(),
      can_manage: await hasPerm(req, 'manage_vehicle_handoffs'),
      can_view: await hasPerm(req, 'view_vehicle_handoffs')
    });
  } catch (err) { sendErr(res, err, 'Failed to load sheet settings'); }
});

// The drawing itself, as data. Any signed-in user: a driver needs it to check marks.
router.get('/diagram/:type', requireAuth, function (req, res) {
  var tpl = VD.getTemplate(req.params.type);
  res.json({ template: tpl, palettes: VD.PALETTES, mark_colors: VD.MARK_COLORS });
});

// ---------------------------------------------------------------- lists

router.get('/', requireAuth, requirePermission('view_vehicle_handoffs'), async function (req, res) {
  try {
    var tab = String(req.query.tab || 'open');
    var where = '1=1', params = [];
    if (tab === 'review') where = "h.status IN ('ready_for_review','flagged')";
    else if (tab === 'driver') where = "h.status IN ('awaiting_driver','in_progress','returned')";
    else if (tab === 'open') where = "h.status IN ('awaiting_driver','in_progress','returned','flagged','ready_for_review')";
    else if (tab === 'completed') where = "h.status = 'completed'";
    else if (tab === 'voided') where = "h.status = 'voided'";
    if (req.query.vehicle_id) { params.push(intOrNull(req.query.vehicle_id)); where += ' AND h.vehicle_id = $' + params.length; }
    const r = await pool.query(SHEET_SELECT + 'WHERE ' + where + ' ORDER BY h.updated_at DESC LIMIT 500', params);
    var counts = await pool.query(
      "SELECT COUNT(*) FILTER (WHERE status IN ('ready_for_review','flagged'))::int AS review, " +
      "COUNT(*) FILTER (WHERE status IN ('awaiting_driver','in_progress','returned'))::int AS driver " +
      'FROM vehicle_handoffs'
    );
    res.json({
      sheets: r.rows.map(function (s) {
        return {
          id: s.id, handoff_number: s.handoff_number, kind: s.kind, status: s.status, status_label: VH.STATUS_LABEL[s.status] || s.status,
          vehicle_id: s.vehicle_id, vehicle_name: vehicleName(s), city_code: s.city_code || s.v_city, driver_name: s.driver_name,
          filled_by: s.filled_by, due_at: s.due_at, created_at: s.created_at, updated_at: s.updated_at, completed_at: s.completed_at,
          created_by_name: s.created_by_name
        };
      }),
      counts: counts.rows[0]
    });
  } catch (err) { sendErr(res, err, 'Failed to load vehicle sheets'); }
});

// The driver's own open sheets (Home card + the sheet screen).
router.get('/mine', requireAuth, async function (req, res) {
  try {
    const r = await pool.query(
      SHEET_SELECT + "WHERE h.driver_user_id = $1 AND h.status IN ('awaiting_driver','in_progress','returned','flagged') " +
      "AND NOT (h.filled_by = 'manager' AND h.status = 'in_progress') AND h.driver_not_present = false ORDER BY h.created_at",
      [req.user.id]
    );
    res.json(r.rows.map(function (s) {
      return { id: s.id, handoff_number: s.handoff_number, kind: s.kind, status: s.status, status_label: VH.STATUS_LABEL[s.status],
        vehicle_name: vehicleName(s), due_at: s.due_at, created_by_name: s.created_by_name, note: s.note, returned_reason: s.returned_reason };
    }));
  } catch (err) { sendErr(res, err, 'Failed to load your vehicle sheets'); }
});

// Everything the vehicle page shows: sheets, who had it, current damage.
router.get('/vehicle/:vehicleId', requireAuth, requirePermission('view_vehicle_handoffs'), async function (req, res) {
  try {
    var vid = intOrNull(req.params.vehicleId);
    if (!vid) return res.status(400).json({ error: 'Bad vehicle id' });
    const v = await pool.query("SELECT id, year, make_model, license_plate, assigned_user_id, COALESCE(body_type,'express') AS body_type FROM vehicles WHERE id = $1", [vid]);
    if (!v.rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    const sheets = await pool.query(SHEET_SELECT + 'WHERE h.vehicle_id = $1 ORDER BY h.created_at DESC', [vid]);
    const hist = await pool.query(
      'SELECT h.*, u.name AS user_name FROM vehicle_assignment_history h LEFT JOIN users u ON u.id = h.user_id ' +
      'WHERE h.vehicle_id = $1 ORDER BY COALESCE(h.start_date, h.created_at::date) DESC, h.id DESC', [vid]);
    const marks = await pool.query("SELECT * FROM vehicle_damage_marks WHERE vehicle_id = $1 AND status = 'open' ORDER BY mark_no", [vid]);
    res.json({
      vehicle: v.rows[0],
      sheets: sheets.rows.map(function (s) {
        return { id: s.id, handoff_number: s.handoff_number, kind: s.kind, status: s.status, status_label: VH.STATUS_LABEL[s.status],
          driver_name: s.driver_name, odometer: s.odometer, effective_date: s.effective_date, completed_at: s.completed_at,
          created_at: s.created_at, has_pdf: !!s.pdf_r2_key };
      }),
      history: hist.rows,
      marks: marks.rows.map(function (m) { m.x = Number(m.x); m.y = Number(m.y); m.state = VH.markState(m, null); return m; })
    });
  } catch (err) { sendErr(res, err, 'Failed to load vehicle history'); }
});

// ---------------------------------------------------------------- start

router.post('/', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  var b = req.body || {};
  var kind = VH.KINDS.indexOf(b.kind) !== -1 ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'Pick assignment or turn-in.' });
  var vehicleId = intOrNull(b.vehicle_id);
  if (!vehicleId) return res.status(400).json({ error: 'Pick a vehicle.' });
  try {
    const vr = await pool.query('SELECT id, active, assigned_user_id, city_code, sold_to FROM vehicles WHERE id = $1', [vehicleId]);
    var veh = vr.rows[0];
    if (!veh) return res.status(404).json({ error: 'Vehicle not found.' });
    if (!veh.active) return res.status(400).json({ error: 'That vehicle is not active.' });
    var open = await pool.query("SELECT id, handoff_number FROM vehicle_handoffs WHERE vehicle_id = $1 AND status IN ('awaiting_driver','in_progress','returned','flagged','ready_for_review')", [vehicleId]);
    if (open.rows.length) return res.status(409).json({ error: 'This vehicle already has an open sheet (' + open.rows[0].handoff_number + '). Finish or void it first.', open_id: open.rows[0].id });

    var driverId;
    if (kind === 'assign') {
      if (veh.assigned_user_id) return res.status(409).json({ error: 'This vehicle already has a responsible employee. Turn it in first (you can reassign it straight from the turn-in).' });
      driverId = intOrNull(b.driver_user_id);
      if (!driverId) return res.status(400).json({ error: 'Pick the driver.' });
    } else {
      if (!veh.assigned_user_id) return res.status(409).json({ error: 'Nobody is assigned to this vehicle, so there is nothing to turn in.' });
      driverId = veh.assigned_user_id;
    }
    var drv = await userRow(driverId);
    if (!drv) return res.status(400).json({ error: 'That driver was not found.' });
    if (kind === 'assign' && drv.active === false) return res.status(400).json({ error: 'That employee is not active.' });

    var filledBy = b.filled_by === 'manager' ? 'manager' : 'driver';
    // A departed driver cannot fill out their own turn-in.
    if (kind === 'turn_in' && drv.active === false) filledBy = 'manager';
    var reason = kind === 'turn_in' ? (VH.TURN_IN_REASONS.indexOf(b.reason) !== -1 ? b.reason : 'reassignment') : null;
    var after = (kind === 'turn_in' && b.after_turn_in === 'reassign') ? 'reassign' : 'pool';
    var reassignTo = after === 'reassign' ? intOrNull(b.reassign_to_user_id) : null;
    if (after === 'reassign' && !reassignTo) return res.status(400).json({ error: 'Pick who gets the vehicle next, or return it to the pool.' });

    // Agreements: the ones picked, else the live defaults for this kind.
    var agIds = Array.isArray(b.agreement_ids) ? b.agreement_ids.map(intOrNull).filter(Boolean) : null;
    var agQ = agIds && agIds.length
      ? await pool.query("SELECT * FROM vehicle_agreements WHERE id = ANY($1::int[]) AND status = 'live'", [agIds])
      : await pool.query("SELECT * FROM vehicle_agreements WHERE status = 'live' AND is_default = true AND use_on IN ($1, 'both')", [kind]);
    var slots = await photoSlotsSetting();
    var checklist = VH.freezeChecklist(await checklistSetting());
    var due = b.due_at ? new Date(b.due_at) : null;
    if (due && isNaN(due.getTime())) due = null;
    var effective = /^\d{4}-\d{2}-\d{2}$/.test(String(b.effective_date || '')) ? b.effective_date : etToday();
    var status = filledBy === 'driver' ? 'awaiting_driver' : 'in_progress';

    var client = await pool.connect();
    var sheetId = null;
    try {
      await client.query('BEGIN');
      var ins = null;
      for (var attempt = 0; attempt < 5 && !ins; attempt++) {
        var num = await nextNumber(client, kind);
        try {
          await client.query('SAVEPOINT vh_num');
          ins = await client.query(
            'INSERT INTO vehicle_handoffs (handoff_number, kind, vehicle_id, driver_user_id, city_code, status, filled_by, effective_date, due_at, note, ' +
            ' reason, after_turn_in, reassign_to_user_id, photo_slots, checklist, created_by) ' +
            'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id',
            [num, kind, vehicleId, driverId, veh.city_code || null, status, filledBy, effective, due, (b.note || '').toString().slice(0, 1000) || null,
             reason, after, reassignTo, JSON.stringify(slots), JSON.stringify(checklist), req.user.id]
          );
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT vh_num');
          if (e.code === '23505' && String(e.constraint || e.detail || '').indexOf('handoff_number') !== -1) { ins = null; continue; }
          if (e.code === '23505') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This vehicle already has an open sheet.' }); }
          throw e;
        }
      }
      if (!ins) throw new Error('Could not allocate a sheet number');
      sheetId = ins.rows[0].id;
      for (var i = 0; i < agQ.rows.length; i++) {
        var a = agQ.rows[i];
        await client.query(
          'INSERT INTO vehicle_handoff_agreements (handoff_id, agreement_id, agreement_name, version, statements) VALUES ($1,$2,$3,$4,$5)',
          [sheetId, a.id, a.name, a.version, JSON.stringify(a.statements)]
        );
      }
      if (kind === 'turn_in') {
        var prior = await client.query("SELECT id FROM vehicle_handoffs WHERE vehicle_id = $1 AND kind = 'assign' AND status = 'completed' ORDER BY completed_at DESC LIMIT 1", [vehicleId]);
        if (prior.rows.length) await client.query('UPDATE vehicle_handoffs SET prior_handoff_id = $1 WHERE id = $2', [prior.rows[0].id, sheetId]);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { client.release(); }

    var sheet = await loadSheet(sheetId);
    await audit(req, sheet, 'created', { kind: kind, driver_user_id: driverId, filled_by: filledBy });
    if (filledBy === 'driver') {
      var what = kind === 'assign' ? (req.user.name + ' assigned you the ' + vehicleName(sheet) + '.') : (req.user.name + ' started the turn-in for the ' + vehicleName(sheet) + '.');
      var dueTxt = sheet.due_at ? ' Complete the vehicle sheet by ' + new Date(sheet.due_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.' : ' Complete the vehicle sheet in Nova.';
      notifyUser(driverId, kind === 'assign' ? 'Vehicle assignment' : 'Vehicle turn-in', what + dueTxt, sheetLink(sheet, true),
        { sms: true, details: [{ label: 'Sheet', value: sheet.handoff_number }, { label: 'Vehicle', value: vehicleName(sheet) }] }).catch(function () {});
    }
    res.json(await sheetPayload(req, sheet));
  } catch (err) { sendErr(res, err, 'Failed to start the sheet'); }
});

// ---------------------------------------------------------------- one sheet

router.get('/:id(\\d+)', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res);
    if (!sheet) return;
    res.json(await sheetPayload(req, sheet));
  } catch (err) { sendErr(res, err, 'Failed to load the sheet'); }
});

// Readings, checklist answers, notes. Whoever is filling it out.
router.put('/:id(\\d+)', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res);
    if (!sheet) return;
    var b = req.body || {};
    var acc = sheet._access;
    var sets = [], params = [];
    function set(col, val) { params.push(val); sets.push(col + ' = $' + params.length); }
    var wantsData = b.odometer !== undefined || b.fuel_level !== undefined || b.checklist !== undefined;
    if (wantsData && !acc.can_fill) return res.status(403).json({ error: 'This sheet cannot be changed right now.' });
    if (b.odometer !== undefined) {
      var od = b.odometer === '' || b.odometer === null ? null : intOrNull(b.odometer);
      if (od != null && (od < 0 || od > 2000000)) return res.status(400).json({ error: 'That odometer reading does not look right.' });
      set('odometer', od);
    }
    if (b.fuel_level !== undefined) {
      if (b.fuel_level && VH.FUEL_LEVELS.indexOf(b.fuel_level) === -1) return res.status(400).json({ error: 'Pick a fuel level.' });
      set('fuel_level', b.fuel_level || null);
    }
    if (b.checklist !== undefined) set('checklist', JSON.stringify(VH.applyChecklist(sheet.checklist, b.checklist)));
    if (b.driver_note !== undefined) {
      if (!acc.can_fill && !acc.can_sign) return res.status(403).json({ error: 'This sheet cannot be changed right now.' });
      set('driver_note', String(b.driver_note || '').slice(0, 1000) || null);
    }
    // Manager-only fields.
    if (b.reason !== undefined || b.after_turn_in !== undefined || b.reassign_to_user_id !== undefined || b.due_at !== undefined || b.note !== undefined) {
      if (!acc.can_review) return res.status(403).json({ error: 'Only a manager can change that.' });
      if (b.reason !== undefined) set('reason', VH.TURN_IN_REASONS.indexOf(b.reason) !== -1 ? b.reason : sheet.reason);
      if (b.after_turn_in !== undefined) set('after_turn_in', b.after_turn_in === 'reassign' ? 'reassign' : 'pool');
      if (b.reassign_to_user_id !== undefined) set('reassign_to_user_id', intOrNull(b.reassign_to_user_id));
      if (b.due_at !== undefined) { var d = b.due_at ? new Date(b.due_at) : null; set('due_at', d && !isNaN(d.getTime()) ? d : null); set('reminder_sent_at', null); }
      if (b.note !== undefined) set('note', String(b.note || '').slice(0, 1000) || null);
    }
    if (!sets.length) return res.json(await sheetPayload(req, sheet));
    params.push(sheet.id);
    await pool.query('UPDATE vehicle_handoffs SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $' + params.length, params);
    if (wantsData) await touchInProgress(sheet, req);
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to save the sheet'); }
});

// ---------------------------------------------------------------- photos
// Same idea as inspection photos: Nova's own camera, the server's clock. The
// browser asks for a slot, the server stamps captured_at from ITS clock and hands
// back a presigned PUT; the photo must be confirmed within a few minutes of that
// stamp. A canvas JPEG has no EXIF, so there is nothing on the file to forge and
// nothing to trust - the timestamp is issued, not read.

router.post('/:id(\\d+)/photos/shoot', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res);
    if (!sheet) return;
    var b = req.body || {};
    var markId = intOrNull(b.mark_id);
    var slot = null;
    if (markId) {
      if (!sheet._access.can_add_marks) return res.status(403).json({ error: 'Damage photos cannot be added right now.' });
      var mk = await pool.query('SELECT id, mark_no FROM vehicle_damage_marks WHERE id = $1 AND vehicle_id = $2', [markId, sheet.vehicle_id]);
      if (!mk.rows.length) return res.status(404).json({ error: 'Damage mark not found.' });
      slot = { key: 'mark', label: 'Damage mark #' + mk.rows[0].mark_no };
    } else {
      if (!sheet._access.can_fill) return res.status(403).json({ error: 'Photos cannot be added to this sheet right now.' });
      (sheet.photo_slots || []).forEach(function (s) { if (s.key === b.slot_key) slot = s; });
      if (!slot) return res.status(400).json({ error: 'Unknown photo slot.' });
    }
    var replaces = intOrNull(b.replaces_photo_id);
    if (replaces) {
      var rp = await pool.query("SELECT id FROM vehicle_handoff_photos WHERE id = $1 AND handoff_id = $2 AND status = 'rejected'", [replaces, sheet.id]);
      if (!rp.rows.length) replaces = null;
    }
    var key = 'vehicle-handoffs/' + sheet.id + '/' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.jpg';
    const ins = await pool.query(
      'INSERT INTO vehicle_handoff_photos (handoff_id, slot_key, slot_label, mark_id, r2_key, status, captured_at, uploaded_by, replaces_photo_id) ' +
      "VALUES ($1,$2,$3,$4,$5,'pending',NOW(),$6,$7) RETURNING id, captured_at",
      [sheet.id, slot.key, slot.label, markId, key, req.user.id, replaces]
    );
    var url = await r2.presignUpload(key, 'image/jpeg');
    res.json({ photo_id: ins.rows[0].id, captured_at: ins.rows[0].captured_at, upload_url: url });
  } catch (err) { sendErr(res, err, 'Failed to start the photo'); }
});

router.post('/photos/:photoId(\\d+)/confirm', requireAuth, async function (req, res) {
  try {
    var pid = intOrNull(req.params.photoId);
    // The window is compared in SQL, never against Date.now(): app and database
    // are separate containers and clock drift would quietly widen it.
    const pr = await pool.query(
      "SELECT p.*, (p.captured_at > NOW() - INTERVAL '" + CONFIRM_WINDOW_MIN + " minutes') AS fresh FROM vehicle_handoff_photos p WHERE p.id = $1",
      [pid]
    );
    var p = pr.rows[0];
    if (!p) return res.status(404).json({ error: 'Photo not found.' });
    if (p.uploaded_by !== req.user.id) return res.status(403).json({ error: 'Only the person who took the photo can finish it.' });
    if (p.status !== 'pending') return res.status(409).json({ error: 'This photo is already saved.' });
    if (!p.fresh) return res.status(410).json({ error: 'That photo took too long to upload. Take it again.' });
    var head = null;
    try { head = await r2.headObject(p.r2_key); } catch (e) { return res.status(503).json({ error: 'Could not check the upload. Try again.' }); }
    if (!head || !head.size) return res.status(400).json({ error: 'The photo did not upload. Try again.' });
    if (head.size > MAX_PHOTO_BYTES) return res.status(400).json({ error: 'That photo is too large.' });
    var phash = /^[0-9a-f]{16}$/.test(String((req.body || {}).phash || '')) ? req.body.phash : null;
    var client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE vehicle_handoff_photos SET status = 'ready', confirmed_at = NOW(), size_bytes = $1, phash = $2 WHERE id = $3", [head.size, phash, pid]);
      if (p.mark_id) {
        await client.query('UPDATE vehicle_damage_marks SET photo_id = $1, updated_at = NOW() WHERE id = $2', [pid, p.mark_id]);
      } else if (!p.replaces_photo_id) {
        // A reshoot of the same slot supersedes the earlier photo (kept, not deleted).
        await client.query(
          "UPDATE vehicle_handoff_photos SET status = 'replaced' WHERE handoff_id = $1 AND slot_key = $2 AND id <> $3 AND status = 'ready' AND mark_id IS NULL",
          [p.handoff_id, p.slot_key, pid]
        );
      }
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; } finally { client.release(); }
    var sheet = await loadSheet(p.handoff_id);
    await touchInProgress(sheet, req);
    res.json(await sheetPayload(req, await loadSheet(p.handoff_id)));
  } catch (err) { sendErr(res, err, 'Failed to save the photo'); }
});

// Manager sends one photo back. The sheet goes back to the driver and any
// signature already on it is cleared: they signed for a set of photos that has
// now changed.
router.post('/photos/:photoId(\\d+)/reject', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var reason = String((req.body || {}).reason || '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: 'Say what is wrong with the photo.' });
    const pr = await pool.query('SELECT * FROM vehicle_handoff_photos WHERE id = $1', [intOrNull(req.params.photoId)]);
    var p = pr.rows[0];
    if (!p) return res.status(404).json({ error: 'Photo not found.' });
    var sheet = await loadSheet(p.handoff_id);
    if (!VH.isOpen(sheet.status)) return res.status(409).json({ error: 'This sheet is closed.' });
    if (p.status !== 'ready') return res.status(409).json({ error: 'That photo cannot be sent back.' });
    await pool.query("UPDATE vehicle_handoff_photos SET status = 'rejected', reject_reason = $1, rejected_by = $2, rejected_at = NOW() WHERE id = $3", [reason, req.user.id, p.id]);
    await sendBackToDriver(sheet, 'Retake the ' + (p.slot_label || 'photo') + ' photo: ' + reason, req);
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to send the photo back'); }
});

async function sendBackToDriver(sheet, reason, req) {
  // A driver-filled sheet goes back to the driver. A manager-filled one goes back
  // to the manager to fix, then "Send to driver" again.
  await pool.query(
    "UPDATE vehicle_handoffs SET status = $1, returned_reason = $2, returned_at = NOW(), driver_signature = NULL, driver_signed_at = NULL, driver_consent = false, updated_at = NOW() WHERE id = $3",
    [sheet.filled_by === 'manager' ? 'in_progress' : 'returned', reason, sheet.id]
  );
  await audit(req, sheet, 'sent_back', { reason: reason });
  if (sheet.filled_by === 'driver' && sheet.driver_user_id) {
    notifyUser(sheet.driver_user_id, 'Vehicle sheet sent back', req.user.name + ' sent your vehicle sheet back: ' + reason, sheetLink(sheet, true), { sms: true }).catch(function () {});
  }
}

// ---------------------------------------------------------------- damage marks

router.post('/:id(\\d+)/marks', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_add_marks');
    if (!sheet) return;
    var b = req.body || {};
    var tpl = VD.getTemplate(sheet.v_body_type);
    if (!VD.validPoint(tpl, b.view, b.x, b.y)) return res.status(400).json({ error: 'Tap on the vehicle to place the mark.' });
    var kinds = VD.DAMAGE_KINDS.map(function (k) { return k.key; });
    var kind = kinds.indexOf(b.kind) !== -1 ? b.kind : 'other';
    var sev = VD.SEVERITIES.indexOf(b.severity) !== -1 ? b.severity : 'minor';
    var byManager = sheet._access.can_manage && !sheet._access.is_driver;
    var client = await pool.connect();
    var mark;
    try {
      await client.query('BEGIN');
      // Serialise mark numbers per vehicle.
      await client.query('SELECT id FROM vehicles WHERE id = $1 FOR UPDATE', [sheet.vehicle_id]);
      const mx = await client.query('SELECT COALESCE(MAX(mark_no), 0) + 1 AS n FROM vehicle_damage_marks WHERE vehicle_id = $1', [sheet.vehicle_id]);
      const ins = await client.query(
        'INSERT INTO vehicle_damage_marks (vehicle_id, mark_no, view, x, y, kind, severity, location, note, origin, confirmed, created_handoff_id, created_by) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
        [sheet.vehicle_id, mx.rows[0].n, b.view, Number(b.x), Number(b.y), kind, sev,
         String(b.location || '').slice(0, 120) || null, String(b.note || '').slice(0, 500) || null,
         byManager ? 'manager' : 'driver', byManager, sheet.id, req.user.id]
      );
      mark = ins.rows[0];
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; } finally { client.release(); }
    await touchInProgress(sheet, req);
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to add the damage mark'); }
});

router.put('/:id(\\d+)/marks/:markId(\\d+)', requireAuth, async function (req, res) {
  try {
    // No blanket gate here: confirming a driver's mark and recording worse /
    // repaired happen at REVIEW, after the driver has signed and the sheet is no
    // longer editable. Each kind of change is checked on its own below.
    var sheet = await sheetForRoute(req, res);
    if (!sheet) return;
    var b = req.body || {};
    const mr = await pool.query('SELECT * FROM vehicle_damage_marks WHERE id = $1 AND vehicle_id = $2', [intOrNull(req.params.markId), sheet.vehicle_id]);
    var m = mr.rows[0];
    if (!m) return res.status(404).json({ error: 'Damage mark not found.' });
    var mine = m.created_handoff_id === sheet.id;
    var mgr = sheet._access.can_review && !sheet._access.is_driver;
    var sets = [], params = [];
    function set(col, val) { params.push(val); sets.push(col + ' = $' + params.length); }
    // Position and description: only on the sheet that created the mark. An old
    // mark is part of a signed record and does not move.
    if (b.view !== undefined || b.x !== undefined || b.y !== undefined || b.kind !== undefined || b.severity !== undefined || b.location !== undefined || b.note !== undefined) {
      if (!sheet._access.can_add_marks) return res.status(403).json({ error: 'Damage marks cannot be changed on this sheet right now.' });
      if (!mine) return res.status(403).json({ error: 'That mark is from an earlier sheet. Record a change instead.' });
      if (b.view !== undefined || b.x !== undefined || b.y !== undefined) {
        var view = b.view !== undefined ? b.view : m.view, x = b.x !== undefined ? b.x : m.x, y = b.y !== undefined ? b.y : m.y;
        if (!VD.validPoint(VD.getTemplate(sheet.v_body_type), view, x, y)) return res.status(400).json({ error: 'Place the mark on the vehicle.' });
        set('view', view); set('x', Number(x)); set('y', Number(y));
      }
      if (b.kind !== undefined) set('kind', VD.DAMAGE_KINDS.map(function (k) { return k.key; }).indexOf(b.kind) !== -1 ? b.kind : m.kind);
      if (b.severity !== undefined) set('severity', VD.SEVERITIES.indexOf(b.severity) !== -1 ? b.severity : m.severity);
      if (b.location !== undefined) set('location', String(b.location || '').slice(0, 120) || null);
      if (b.note !== undefined) set('note', String(b.note || '').slice(0, 500) || null);
    }
    if (b.confirmed !== undefined) {
      if (!mgr) return res.status(403).json({ error: 'Only a manager confirms damage the driver added.' });
      set('confirmed', !!b.confirmed);
    }
    // Worse / repaired on an existing mark: the manager's call, recorded against
    // this sheet, applied for real at the countersign.
    if (b.change !== undefined) {
      if (!mgr) return res.status(403).json({ error: 'Only a manager records a change to existing damage.' });
      var ch = (b.change === 'worse' || b.change === 'repaired') ? b.change : null;
      set('change', ch); set('change_note', ch ? (String(b.change_note || '').slice(0, 300) || null) : null);
      set('changed_handoff_id', ch ? sheet.id : null);
      if (ch === 'worse' && VD.SEVERITIES.indexOf(b.severity) !== -1) set('severity', b.severity);
    }
    if (!sets.length) return res.json(await sheetPayload(req, sheet));
    params.push(m.id);
    await pool.query('UPDATE vehicle_damage_marks SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $' + params.length, params);
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to update the damage mark'); }
});

router.delete('/:id(\\d+)/marks/:markId(\\d+)', requireAuth, async function (req, res) {
  try {
    // A manager may remove a mark made on this sheet right up to the countersign
    // ("confirm or remove" at review); the driver only while it is their turn.
    var sheet = await sheetForRoute(req, res);
    if (!sheet) return;
    if (!sheet._access.can_add_marks && !(sheet._access.can_review && !sheet._access.is_driver)) return res.status(403).json({ error: 'Damage marks cannot be changed on this sheet right now.' });
    const mr = await pool.query('SELECT * FROM vehicle_damage_marks WHERE id = $1 AND vehicle_id = $2', [intOrNull(req.params.markId), sheet.vehicle_id]);
    var m = mr.rows[0];
    if (!m) return res.status(404).json({ error: 'Damage mark not found.' });
    if (m.created_handoff_id !== sheet.id) return res.status(403).json({ error: 'That mark is from an earlier sheet and stays on the record.' });
    // A driver removes only their own marks; a manager may remove any mark on the open sheet.
    if (sheet._access.is_driver && !sheet._access.can_manage && m.created_by !== req.user.id) return res.status(403).json({ error: 'Only your manager can remove that mark.' });
    await pool.query("UPDATE vehicle_handoff_photos SET status = 'replaced' WHERE mark_id = $1", [m.id]);
    await pool.query('DELETE FROM vehicle_damage_marks WHERE id = $1', [m.id]);
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to remove the damage mark'); }
});

// Driver (or the manager filling it in): "the marks are right" / "no damage found".
router.post('/:id(\\d+)/damage-reviewed', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_add_marks');
    if (!sheet) return;
    await pool.query('UPDATE vehicle_handoffs SET damage_reviewed_at = NOW(), updated_at = NOW() WHERE id = $1', [sheet.id]);
    await touchInProgress(sheet, req);
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to save'); }
});

// The manager's own damage check. Required on a turn-in before countersigning.
router.post('/:id(\\d+)/damage-checked', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_review');
    if (!sheet) return;
    await pool.query('UPDATE vehicle_handoffs SET manager_damage_checked_at = NOW(), damage_reviewed_at = COALESCE(damage_reviewed_at, NOW()), updated_at = NOW() WHERE id = $1', [sheet.id]);
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to save'); }
});

// ---------------------------------------------------------------- driver

router.post('/:id(\\d+)/agreements/:agId(\\d+)/initial', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_sign');
    if (!sheet) return;
    var b = req.body || {};
    const ar = await pool.query('SELECT * FROM vehicle_handoff_agreements WHERE id = $1 AND handoff_id = $2', [intOrNull(req.params.agId), sheet.id]);
    var a = ar.rows[0];
    if (!a) return res.status(404).json({ error: 'Agreement not found on this sheet.' });
    var st = (a.statements || []).filter(function (s) { return s.key === b.key; })[0];
    if (!st) return res.status(400).json({ error: 'Unknown statement.' });
    var initials = b.initials === null ? null : VH.cleanInitials(b.initials);
    if (b.initials !== null && !initials) return res.status(400).json({ error: 'Type your initials (1 to 4 letters).' });
    var next = Object.assign({}, a.initials || {});
    if (initials) next[b.key] = initials; else delete next[b.key];
    await pool.query('UPDATE vehicle_handoff_agreements SET initials = $1 WHERE id = $2', [JSON.stringify(next), a.id]);
    await touchInProgress(sheet, req);
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to save your initials'); }
});

router.post('/:id(\\d+)/driver-sign', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_sign');
    if (!sheet) return;
    var b = req.body || {};
    if (b.consent !== true) return res.status(400).json({ error: 'Tick the box to confirm the vehicle condition and the agreement.' });
    var sigErr = checkSignature(b.signature_data);
    if (sigErr) return res.status(400).json({ error: sigErr });
    var photos = await photosFor(sheet.id), agreements = await agreementsFor(sheet.id), marks = await marksFor(sheet);
    var missing = VH.missingForDriverSign(sheet, photos, agreements, marks);
    if (missing.length) return res.status(400).json({ error: missing[0], missing: missing });
    // Guarded so a double tap cannot sign twice or sign a sheet that moved on.
    const up = await pool.query(
      "UPDATE vehicle_handoffs SET status = 'ready_for_review', driver_consent = true, driver_signature = $1, driver_signed_at = NOW(), " +
      '  driver_gps_lat = $2, driver_gps_lon = $3, driver_gps_accuracy = $4, driver_ip = $5, driver_user_agent = $6, flag_reason = NULL, updated_at = NOW() ' +
      "WHERE id = $7 AND status IN ('awaiting_driver','in_progress','returned','flagged') RETURNING id",
      [b.signature_data, numOrNull(b.gps_lat), numOrNull(b.gps_lon), numOrNull(b.gps_accuracy), clientIp(req),
       String(req.headers['user-agent'] || '').slice(0, 500), sheet.id]
    );
    if (!up.rows.length) return res.status(409).json({ error: 'This sheet has already been signed.' });
    await audit(req, sheet, 'driver_signed', {});
    if (sheet.created_by) {
      notifyUser(sheet.created_by, 'Vehicle sheet ready for review', sheet.driver_name + ' finished and signed ' + sheet.handoff_number + ' for the ' + vehicleName(sheet) + '.',
        sheetLink(sheet, false), { details: [{ label: 'Sheet', value: sheet.handoff_number }] }).catch(function () {});
    }
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to record the signature'); }
});

// "Something is wrong" - the driver flags it instead of signing.
router.post('/:id(\\d+)/flag', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_sign');
    if (!sheet) return;
    var reason = String((req.body || {}).reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Say what is wrong.' });
    await pool.query("UPDATE vehicle_handoffs SET status = 'flagged', flag_reason = $1, updated_at = NOW() WHERE id = $2", [reason, sheet.id]);
    await audit(req, sheet, 'flagged', { reason: reason });
    if (sheet.created_by) notifyUser(sheet.created_by, 'Vehicle sheet flagged', sheet.driver_name + ' flagged ' + sheet.handoff_number + ': ' + reason, sheetLink(sheet, false)).catch(function () {});
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to flag the sheet'); }
});

// ---------------------------------------------------------------- manager

// Manager filled it in person; now the driver initials and signs on their login.
router.post('/:id(\\d+)/send-to-driver', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_review');
    if (!sheet) return;
    if (sheet.filled_by !== 'manager' || sheet.status !== 'in_progress') return res.status(409).json({ error: 'This sheet is not waiting on you.' });
    var photos = await photosFor(sheet.id), marks = await marksFor(sheet);
    var missing = VH.missingForDriverSign(sheet, photos, [], marks);
    if (missing.length) return res.status(400).json({ error: missing[0], missing: missing });
    await pool.query("UPDATE vehicle_handoffs SET status = 'awaiting_driver', updated_at = NOW() WHERE id = $1", [sheet.id]);
    notifyUser(sheet.driver_user_id, 'Sign for your vehicle', req.user.name + ' filled out ' + sheet.handoff_number + ' for the ' + vehicleName(sheet) + '. Check it, initial and sign in Nova.',
      sheetLink(sheet, true), { sms: true }).catch(function () {});
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to send the sheet'); }
});

router.post('/:id(\\d+)/send-back', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_review');
    if (!sheet) return;
    var reason = String((req.body || {}).reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Say what needs fixing.' });
    await sendBackToDriver(sheet, reason, req);
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to send the sheet back'); }
});

router.post('/:id(\\d+)/void', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_review');
    if (!sheet) return;
    var reason = String((req.body || {}).reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Say why the sheet is being voided.' });
    var client = await pool.connect();
    try {
      await client.query('BEGIN');
      const up = await client.query(
        "UPDATE vehicle_handoffs SET status = 'voided', voided_reason = $1, voided_at = NOW(), voided_by = $2, updated_at = NOW() " +
        "WHERE id = $3 AND status IN ('awaiting_driver','in_progress','returned','flagged','ready_for_review') RETURNING id",
        [reason, req.user.id, sheet.id]
      );
      if (!up.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This sheet is already closed.' }); }
      // Nothing on a voided sheet was ever signed, so its marks and pending
      // changes come off the vehicle's record.
      await client.query("DELETE FROM vehicle_damage_marks WHERE created_handoff_id = $1 AND status = 'open'", [sheet.id]);
      await client.query('UPDATE vehicle_damage_marks SET change = NULL, change_note = NULL, changed_handoff_id = NULL WHERE changed_handoff_id = $1', [sheet.id]);
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; } finally { client.release(); }
    await audit(req, sheet, 'voided', { reason: reason });
    if (sheet.driver_user_id && sheet.filled_by === 'driver') notifyUser(sheet.driver_user_id, 'Vehicle sheet canceled', sheet.handoff_number + ' was canceled: ' + reason, '/?view=home').catch(function () {});
    res.json(await sheetPayload(req, await loadSheet(sheet.id)));
  } catch (err) { sendErr(res, err, 'Failed to void the sheet'); }
});

// The countersign. The one place Fleet changes.
async function finalize(req, sheetId, managerSignature) {
  var client = await pool.connect();
  var sheet;
  try {
    await client.query('BEGIN');
    sheet = await loadSheet(sheetId, client);
    await client.query('SELECT id FROM vehicle_handoffs WHERE id = $1 FOR UPDATE', [sheetId]);
    await client.query('SELECT id FROM vehicles WHERE id = $1 FOR UPDATE', [sheet.vehicle_id]);
    const vr = await client.query('SELECT assigned_user_id, mileage FROM vehicles WHERE id = $1', [sheet.vehicle_id]);
    var veh = vr.rows[0];
    var today = etToday();
    var eff = sheet.effective_date ? new Date(sheet.effective_date).toISOString().slice(0, 10) : today;
    if (sheet.kind === 'assign') {
      if (veh.assigned_user_id && veh.assigned_user_id !== sheet.driver_user_id) {
        await client.query('ROLLBACK');
        client.release();
        return { error: 'Someone else became responsible for this vehicle while the sheet was open. Turn it in first.', status: 409 };
      }
      await client.query(
        'UPDATE vehicles SET assigned_user_id = $1, date_of_assignment = $2, mileage = GREATEST(COALESCE(mileage, 0), COALESCE($3, 0)), updated_at = NOW() WHERE id = $4',
        [sheet.driver_user_id, eff, sheet.odometer, sheet.vehicle_id]
      );
      await client.query('UPDATE vehicle_assignment_history SET end_date = $1 WHERE vehicle_id = $2 AND end_date IS NULL', [eff, sheet.vehicle_id]);
      await client.query(
        "INSERT INTO vehicle_assignment_history (vehicle_id, user_id, start_date, start_odometer, assign_handoff_id, source, created_by) VALUES ($1,$2,$3,$4,$5,'sheet',$6)",
        [sheet.vehicle_id, sheet.driver_user_id, eff, sheet.odometer, sheet.id, req.user.id]
      );
    } else {
      await client.query(
        'UPDATE vehicles SET assigned_user_id = NULL, mileage = GREATEST(COALESCE(mileage, 0), COALESCE($1, 0)), updated_at = NOW() WHERE id = $2',
        [sheet.odometer, sheet.vehicle_id]
      );
      const oh = await client.query('SELECT id FROM vehicle_assignment_history WHERE vehicle_id = $1 AND end_date IS NULL ORDER BY id DESC LIMIT 1', [sheet.vehicle_id]);
      if (oh.rows.length) {
        await client.query('UPDATE vehicle_assignment_history SET end_date = $1, end_odometer = $2, turnin_handoff_id = $3 WHERE id = $4', [today, sheet.odometer, sheet.id, oh.rows[0].id]);
      } else {
        await client.query(
          "INSERT INTO vehicle_assignment_history (vehicle_id, user_id, end_date, end_odometer, turnin_handoff_id, source, created_by) VALUES ($1,$2,$3,$4,$5,'sheet',$6)",
          [sheet.vehicle_id, sheet.driver_user_id, today, sheet.odometer, sheet.id, req.user.id]
        );
      }
    }
    // Apply the damage changes recorded on this sheet.
    await client.query("UPDATE vehicle_damage_marks SET status = 'repaired', repaired_at = NOW(), updated_at = NOW() WHERE changed_handoff_id = $1 AND change = 'repaired'", [sheet.id]);
    await client.query('UPDATE vehicle_damage_marks SET confirmed = true WHERE created_handoff_id = $1', [sheet.id]);
    const snap = await client.query(
      "SELECT id, mark_no, view, x, y, kind, severity, location, note, origin, confirmed, status, change, change_note, created_handoff_id, changed_handoff_id, photo_id " +
      "FROM vehicle_damage_marks WHERE vehicle_id = $1 AND (status = 'open' OR changed_handoff_id = $2) ORDER BY mark_no",
      [sheet.vehicle_id, sheet.id]
    );
    await client.query(
      "UPDATE vehicle_handoffs SET status = 'completed', manager_user_id = $1, manager_signature = $2, manager_signed_at = NOW(), manager_ip = $3, " +
      '  marks_snapshot = $4, completed_at = NOW(), updated_at = NOW() WHERE id = $5',
      [req.user.id, managerSignature, clientIp(req), JSON.stringify(snap.rows.map(function (m) {
        m.x = Number(m.x); m.y = Number(m.y); m.state = VH.markState(m, sheet); return m;
      })), sheet.id]
    );
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); throw e; }
  client.release();

  var done = await loadSheet(sheetId);
  await audit(req, done, 'completed', { kind: done.kind, driver_user_id: done.driver_user_id, driver_not_present: done.driver_not_present });
  try {
    await logAudit({ entity_type: 'vehicle', entity_id: done.vehicle_id, entity_number: vehicleName(done),
      action: done.kind === 'assign' ? 'driver_assigned' : 'driver_turned_in', user_id: req.user.id, user_name: req.user.name,
      details: { handoff: done.handoff_number, driver_user_id: done.driver_user_id } });
  } catch (e) { /* ignore */ }

  // Everything below is best-effort and happens after the commit: none of it may
  // undo the assignment.
  await creditInspection(done, req).catch(function (e) { console.error('[vehicle-handoffs] inspection credit:', e.message); });
  await buildAndFilePdf(done).catch(function (e) { console.error('[vehicle-handoffs] pdf:', e.message); });
  if (done.kind === 'turn_in' && done.after_turn_in === 'reassign' && done.reassign_to_user_id) {
    await chainReassign(done, req).catch(function (e) { console.error('[vehicle-handoffs] reassign chain:', e.message); });
  }
  var finalSheet = await loadSheet(sheetId);
  var msg = done.kind === 'assign'
    ? 'You are now the responsible employee for the ' + vehicleName(done) + '. The signed sheet is attached in Nova.'
    : 'Your turn-in of the ' + vehicleName(done) + ' is complete.';
  if (done.driver_user_id && !done.driver_not_present) {
    notifyUser(done.driver_user_id, done.kind === 'assign' ? 'Vehicle assigned to you' : 'Vehicle turn-in complete', msg, sheetLink(done, true),
      { badge: 'Signed', badgeColor: 'green', details: [{ label: 'Sheet', value: done.handoff_number }] }).catch(function () {});
  }
  return { sheet: finalSheet };
}

// A completed sheet counts as that month's vehicle inspection (Tony, 2026-09-24).
// The compliance grid, the reminder job and the dashboard all treat "a
// vehicle_inspections row exists for this vehicle and month" as done, so writing
// that row is the whole integration - none of their queries change. An inspection
// that already exists for the month is left alone.
async function creditInspection(sheet, req) {
  var month = etMonth();
  var year = new Date().getFullYear();
  for (var attempt = 0; attempt < 4; attempt++) {
    const r = await pool.query(
      "SELECT MAX(CAST(SPLIT_PART(inspection_number, '-', 3) AS INTEGER)) AS maxseq FROM vehicle_inspections WHERE inspection_number LIKE $1",
      ['INS-' + year + '-%']
    );
    var num = 'INS-' + year + '-' + String((r.rows[0].maxseq || 0) + 1).padStart(4, '0');
    try {
      const ins = await pool.query(
        'INSERT INTO vehicle_inspections (inspection_number, vehicle_id, period_month, submitted_by, city_code, mileage, status, overall_result, reviewer_id, reviewed_at, notes, handoff_id) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,'reviewed','pass',$7,NOW(),$8,$9) ON CONFLICT (vehicle_id, period_month) DO NOTHING RETURNING id",
        [num, sheet.vehicle_id, month, sheet.driver_user_id || req.user.id, sheet.city_code || sheet.v_city || null, sheet.odometer,
         req.user.id, 'Satisfied by ' + sheet.handoff_number + ' (vehicle ' + (sheet.kind === 'assign' ? 'assignment' : 'turn-in') + ' sheet). Photos and checklist are on that sheet.', sheet.id]
      );
      if (ins.rows.length) await pool.query('UPDATE vehicle_handoffs SET inspection_id = $1 WHERE id = $2', [ins.rows[0].id, sheet.id]);
      return;
    } catch (e) {
      if (e.code === '23505' && String(e.constraint || '').indexOf('inspection_number') !== -1) continue;
      throw e;
    }
  }
}

async function chainReassign(sheet, req) {
  var drv = await userRow(sheet.reassign_to_user_id);
  if (!drv || drv.active === false) return;
  var fakeReq = { user: req.user, headers: req.headers, ip: req.ip };
  var slots = await photoSlotsSetting();
  var checklist = VH.freezeChecklist(await checklistSetting());
  var ag = await pool.query("SELECT * FROM vehicle_agreements WHERE status = 'live' AND is_default = true AND use_on IN ('assign','both')");
  var num = await nextNumber(pool, 'assign');
  const ins = await pool.query(
    'INSERT INTO vehicle_handoffs (handoff_number, kind, vehicle_id, driver_user_id, city_code, status, filled_by, effective_date, note, prior_handoff_id, photo_slots, checklist, created_by) ' +
    "VALUES ($1,'assign',$2,$3,$4,'awaiting_driver','driver',$5,$6,$7,$8,$9,$10) RETURNING id",
    [num, sheet.vehicle_id, drv.id, sheet.city_code || null, etToday(), 'Reassigned from ' + sheet.handoff_number + '.', sheet.id,
     JSON.stringify(slots), JSON.stringify(checklist), req.user.id]
  );
  var newId = ins.rows[0].id;
  for (var i = 0; i < ag.rows.length; i++) {
    await pool.query('INSERT INTO vehicle_handoff_agreements (handoff_id, agreement_id, agreement_name, version, statements) VALUES ($1,$2,$3,$4,$5)',
      [newId, ag.rows[i].id, ag.rows[i].name, ag.rows[i].version, JSON.stringify(ag.rows[i].statements)]);
  }
  await pool.query('UPDATE vehicle_handoffs SET next_handoff_id = $1 WHERE id = $2', [newId, sheet.id]);
  var ns = await loadSheet(newId);
  await audit(fakeReq, ns, 'created', { kind: 'assign', chained_from: sheet.handoff_number });
  notifyUser(drv.id, 'Vehicle assignment', req.user.name + ' assigned you the ' + vehicleName(ns) + '. Complete the vehicle sheet in Nova.', sheetLink(ns, true), { sms: true }).catch(function () {});
}

// Render the signed PDF, store it, drop it in the Document Vault, email both people.
async function buildAndFilePdf(sheet) {
  if (!r2.configured || !r2.configured()) return;
  var full = await loadSheet(sheet.id);
  var photos = await photosFor(sheet.id);
  var agreements = await agreementsFor(sheet.id);
  var buf = await handoffPdf.build(full, { photos: photos, agreements: agreements, marks: full.marks_snapshot || [], template: VD.getTemplate(full.v_body_type) });
  var key = 'vehicle-handoffs/' + sheet.id + '/' + sheet.handoff_number + '.pdf';
  await r2.putObject(key, buf, 'application/pdf');
  await pool.query('UPDATE vehicle_handoffs SET pdf_r2_key = $1 WHERE id = $2', [key, sheet.id]);
  // Vault: Fleet / Vehicle Sheets, owned by whoever started the sheet.
  try {
    var owner = await userRow(full.created_by);
    if (owner) {
      var f = await pool.query("SELECT id FROM document_folders WHERE name = 'Vehicle Sheets' AND owner_id = $1 AND parent_id IS NULL", [owner.id]);
      var folderId = f.rows.length ? f.rows[0].id : (await pool.query("INSERT INTO document_folders (name, parent_id, owner_id, owner_name) VALUES ('Vehicle Sheets', NULL, $1, $2) RETURNING id", [owner.id, owner.name])).rows[0].id;
      var d = await pool.query(
        "INSERT INTO documents (name, folder_id, r2_key, mime_type, size_bytes, status, owner_id, owner_name) VALUES ($1,$2,$3,'application/pdf',$4,'ready',$5,$6) RETURNING id",
        [full.handoff_number + ' ' + vehicleName(full) + '.pdf', folderId, key, buf.length, owner.id, owner.name]
      );
      await pool.query('UPDATE vehicle_handoffs SET document_id = $1 WHERE id = $2', [d.rows[0].id, sheet.id]);
    }
  } catch (e) { console.error('[vehicle-handoffs] vault drop:', e.message); }
  // Email the signed copy to the driver and the manager who countersigned.
  var att = [{ filename: full.handoff_number + '.pdf', content: buf.toString('base64') }];
  var ids = [full.driver_not_present ? null : full.driver_user_id, full.manager_user_id].filter(Boolean);
  for (var i = 0; i < ids.length; i++) {
    try {
      var u = await userRow(ids[i]);
      if (!u || !u.email || u.receive_emails === false) continue;
      var html = emailTemplate({ badge: 'Signed', badgeColor: 'green', title: VH.esc(full.handoff_number + ' signed'),
        body: 'The signed ' + (full.kind === 'assign' ? 'vehicle assignment' : 'vehicle turn-in') + ' sheet for the ' + VH.esc(vehicleName(full)) + ' is attached.',
        details: [{ label: 'Driver', value: full.driver_name || '' }, { label: 'Countersigned by', value: full.manager_name || '' }] });
      await sendEmail(u.email, full.handoff_number + ' signed: ' + vehicleName(full), html, null, att);
    } catch (e) { console.error('[vehicle-handoffs] email pdf:', e.message); }
  }
}

router.post('/:id(\\d+)/countersign', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_countersign');
    if (!sheet) return;
    var sigErr = checkSignature((req.body || {}).signature_data);
    if (sigErr) return res.status(400).json({ error: sigErr });
    var photos = await photosFor(sheet.id), agreements = await agreementsFor(sheet.id), marks = await marksFor(sheet);
    var missing = VH.missingForCountersign(sheet, photos, agreements, marks);
    if (missing.length) return res.status(400).json({ error: missing[0], missing: missing });
    var out = await finalize(req, sheet.id, req.body.signature_data);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(await sheetPayload(req, out.sheet));
  } catch (err) { sendErr(res, err, 'Failed to countersign'); }
});

// Turn-in only: the driver is gone (separation, no-show). The manager completes
// it alone, with a reason; the PDF says "Driver not present".
router.post('/:id(\\d+)/complete-without-driver', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res, 'can_review');
    if (!sheet) return;
    if (sheet.kind !== 'turn_in') return res.status(400).json({ error: 'Only a turn-in can be completed without the driver.' });
    var b = req.body || {};
    var reason = String(b.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Say why the driver is not signing.' });
    var sigErr = checkSignature(b.signature_data);
    if (sigErr) return res.status(400).json({ error: sigErr });
    var probe = Object.assign({}, sheet, { driver_not_present: true, driver_not_present_reason: reason });
    var photos = await photosFor(sheet.id), marks = await marksFor(sheet);
    var missing = VH.missingForCountersign(probe, photos, [], marks);
    if (missing.length) return res.status(400).json({ error: missing[0], missing: missing });
    await pool.query('UPDATE vehicle_handoffs SET driver_not_present = true, driver_not_present_reason = $1, updated_at = NOW() WHERE id = $2', [reason, sheet.id]);
    var out = await finalize(req, sheet.id, b.signature_data);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(await sheetPayload(req, out.sheet));
  } catch (err) { sendErr(res, err, 'Failed to complete the turn-in'); }
});

router.get('/:id(\\d+)/pdf', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res);
    if (!sheet) return;
    if (sheet.status !== 'completed') return res.status(400).json({ error: 'The PDF is made when the sheet is countersigned.' });
    if (!sheet.pdf_r2_key) {
      await buildAndFilePdf(sheet);
      sheet = await loadSheet(sheet.id);
      if (!sheet.pdf_r2_key) return res.status(503).json({ error: 'File storage is not configured.' });
    }
    var url = await r2.presignDownload(sheet.pdf_r2_key, sheet.handoff_number + '.pdf', true, 300, 'application/pdf');
    res.json({ url: url });
  } catch (err) { sendErr(res, err, 'Failed to open the PDF'); }
});

// Signature images for the review screen (kept out of the main payload - large).
router.get('/:id(\\d+)/signatures', requireAuth, async function (req, res) {
  try {
    var sheet = await sheetForRoute(req, res);
    if (!sheet) return;
    res.json({ driver: sheet.driver_signature || null, manager: sheet.manager_signature || null });
  } catch (err) { sendErr(res, err, 'Failed to load signatures'); }
});

// ---------------------------------------------------------------- settings

router.get('/settings', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var ag = await pool.query(
      'SELECT a.*, (SELECT COUNT(*)::int FROM vehicle_handoff_agreements ha JOIN vehicle_handoffs h ON h.id = ha.handoff_id ' +
      "  WHERE ha.agreement_id = a.id AND h.driver_signed_at IS NOT NULL) AS signed_count FROM vehicle_agreements a " +
      "ORDER BY CASE a.status WHEN 'live' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, a.is_default DESC, a.name"
    );
    res.json({ photo_slots: await photoSlotsSetting(), checklist: await checklistSetting(), agreements: ag.rows, templates: VD.templateTypes() });
  } catch (err) { sendErr(res, err, 'Failed to load settings'); }
});

router.put('/settings', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var b = req.body || {};
    var slots = b.photo_slots !== undefined ? VH.cleanPhotoSlots(b.photo_slots) : null;
    var checklist = b.checklist !== undefined ? VH.cleanChecklist(b.checklist) : null;
    // Validate everything before saving anything.
    if (slots) await saveSetting('vehicle_sheet_photo_slots', slots);
    if (checklist) await saveSetting('vehicle_sheet_checklist', checklist);
    await logAudit({ entity_type: 'settings', entity_id: null, entity_number: 'vehicle_sheets', action: 'updated', user_id: req.user.id, user_name: req.user.name, details: { photo_slots: !!slots, checklist: !!checklist } });
    res.json({ photo_slots: await photoSlotsSetting(), checklist: await checklistSetting() });
  } catch (err) {
    if (err && /^(Keep|Photo|Checklist|20|40)/.test(err.message)) return res.status(400).json({ error: err.message });
    sendErr(res, err, 'Failed to save settings');
  }
});

async function agreementSigned(id) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM vehicle_handoff_agreements ha JOIN vehicle_handoffs h ON h.id = ha.handoff_id WHERE ha.agreement_id = $1 AND h.driver_signed_at IS NOT NULL',
    [id]
  );
  return r.rows[0].n;
}
async function agreementSignedAtVersion(id, version) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM vehicle_handoff_agreements ha JOIN vehicle_handoffs h ON h.id = ha.handoff_id WHERE ha.agreement_id = $1 AND ha.version = $2 AND h.driver_signed_at IS NOT NULL',
    [id, version]
  );
  return r.rows[0].n;
}

function agreementInput(b) {
  var name = String(b.name || '').trim().slice(0, 120);
  if (!name) throw new Error('Give the agreement a name.');
  var useOn = ['assign', 'turn_in', 'both'].indexOf(b.use_on) !== -1 ? b.use_on : 'assign';
  return { name: name, use_on: useOn, is_default: !!b.is_default, statements: VH.cleanStatements(b.statements) };
}

router.post('/agreements', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var a;
    try { a = agreementInput(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
    var status = (req.body || {}).status === 'live' ? 'live' : 'draft';
    const r = await pool.query(
      'INSERT INTO vehicle_agreements (name, use_on, is_default, status, version, statements, created_by) VALUES ($1,$2,$3,$4,1,$5,$6) RETURNING *',
      [a.name, a.use_on, a.is_default, status, JSON.stringify(a.statements), req.user.id]
    );
    res.json(r.rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to create the agreement'); }
});

// Saving new wording on an agreement somebody has signed publishes a new version.
// Signed sheets keep their own frozen copy, so nothing already signed changes.
router.put('/agreements/:agId(\\d+)', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    const cur = await pool.query('SELECT * FROM vehicle_agreements WHERE id = $1', [intOrNull(req.params.agId)]);
    var ag = cur.rows[0];
    if (!ag) return res.status(404).json({ error: 'Agreement not found.' });
    if (ag.status === 'archived') return res.status(409).json({ error: 'Restore the agreement before editing it.' });
    var a;
    try { a = agreementInput(Object.assign({ name: ag.name, use_on: ag.use_on, is_default: ag.is_default, statements: ag.statements }, req.body || {})); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    var wordingChanged = !VH.sameStatements(a.statements, ag.statements);
    var version = ag.version;
    if (wordingChanged && (await agreementSignedAtVersion(ag.id, ag.version)) > 0) version = ag.version + 1;
    var status = (req.body || {}).status === 'live' ? 'live' : ((req.body || {}).status === 'draft' && ag.status === 'draft' ? 'draft' : ag.status);
    const r = await pool.query(
      'UPDATE vehicle_agreements SET name = $1, use_on = $2, is_default = $3, statements = $4, version = $5, status = $6, updated_at = NOW() WHERE id = $7 RETURNING *',
      [a.name, a.use_on, a.is_default, JSON.stringify(a.statements), version, status, ag.id]
    );
    await logAudit({ entity_type: 'vehicle_agreement', entity_id: ag.id, entity_number: a.name, action: version !== ag.version ? 'new_version' : 'updated', user_id: req.user.id, user_name: req.user.name, details: { version: version } });
    res.json(r.rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to save the agreement'); }
});

router.post('/agreements/:agId(\\d+)/copy', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    const cur = await pool.query('SELECT * FROM vehicle_agreements WHERE id = $1', [intOrNull(req.params.agId)]);
    var ag = cur.rows[0];
    if (!ag) return res.status(404).json({ error: 'Agreement not found.' });
    const r = await pool.query(
      "INSERT INTO vehicle_agreements (name, use_on, is_default, status, version, statements, created_by) VALUES ($1,$2,false,'draft',1,$3,$4) RETURNING *",
      [(ag.name + ' (copy)').slice(0, 120), ag.use_on, JSON.stringify(ag.statements), req.user.id]
    );
    res.json(r.rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to copy the agreement'); }
});

router.post('/agreements/:agId(\\d+)/archive', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    const r = await pool.query("UPDATE vehicle_agreements SET status = 'archived', is_default = false, updated_at = NOW() WHERE id = $1 RETURNING *", [intOrNull(req.params.agId)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Agreement not found.' });
    res.json(r.rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to archive the agreement'); }
});

router.post('/agreements/:agId(\\d+)/restore', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    const r = await pool.query("UPDATE vehicle_agreements SET status = 'live', updated_at = NOW() WHERE id = $1 AND status = 'archived' RETURNING *", [intOrNull(req.params.agId)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Agreement not found.' });
    res.json(r.rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to restore the agreement'); }
});

// Delete only what nobody has signed. Anything signed is archived instead, so the
// record of what a driver agreed to can never disappear.
router.delete('/agreements/:agId(\\d+)', requireAuth, requirePermission('manage_vehicle_handoffs'), async function (req, res) {
  try {
    var id = intOrNull(req.params.agId);
    if ((await agreementSigned(id)) > 0) return res.status(409).json({ error: 'Someone has signed this agreement, so it can only be archived.' });
    const open = await pool.query(
      "SELECT COUNT(*)::int AS n FROM vehicle_handoff_agreements ha JOIN vehicle_handoffs h ON h.id = ha.handoff_id WHERE ha.agreement_id = $1 AND h.status IN ('awaiting_driver','in_progress','returned','flagged','ready_for_review')",
      [id]
    );
    if (open.rows[0].n > 0) return res.status(409).json({ error: 'An open sheet uses this agreement. Archive it, or finish those sheets first.' });
    const r = await pool.query('DELETE FROM vehicle_agreements WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Agreement not found.' });
    res.json({ ok: true });
  } catch (err) { sendErr(res, err, 'Failed to delete the agreement'); }
});

// Exposed for the reminder job and the tests.
router._internal = { finalize: finalize, creditInspection: creditInspection, notifyUser: notifyUser, loadSheet: loadSheet, sheetLink: sheetLink, vehicleName: vehicleName };

module.exports = router;
