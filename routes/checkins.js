// routes/checkins.js
//
// The app-facing half of check-in. The screens talk to this; Twilio talks to
// routes/twilioVoice.js. No backticks.
//
// Access follows the work order: whoever can open the job can check it in. A
// technician is routinely assigned the job while the coordinator holds the
// paperwork, so gating this on manage_work_orders would lock out exactly the
// person standing at the door.

var express = require('express');
var { pool } = require('../db');
var { requireAuth, requirePermission } = require('../middleware/auth');
var perms = require('../utils/permissions');
var engine = require('../utils/checkinEngine');
var twilio = require('../utils/twilioVoice');
var ivr = require('../utils/ivrScript');
var r2 = require('../utils/r2');
var { logAudit } = require('../utils/audit');

var router = express.Router();

async function canManage(req) { return perms.hasPermission(req.user.role, 'manage_work_orders'); }

// Same rule GET /api/work-orders/:id enforces, in one place.
async function guardWorkOrder(req, id) {
  var { rows } = await pool.query('SELECT id, assigned_to, wo_ref FROM work_orders WHERE id = $1', [id]);
  if (!rows.length) return { err: 404, message: 'Work order not found' };
  if (!(await canManage(req)) && rows[0].assigned_to !== req.user.id) {
    return { err: 403, message: 'Access denied' };
  }
  return { wo: rows[0] };
}

// Nobody knows a work order's internal database id, and asking for one is a
// good way to make a test call feel like homework. Accept whatever is to hand:
// the Nova id, the client's work order number, or Nova's own WO- reference.
async function resolveWorkOrder(raw) {
  var v = String(raw == null ? '' : raw).trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) {
    var byId = await pool.query('SELECT * FROM work_orders WHERE id = $1', [parseInt(v, 10)]);
    if (byId.rows.length) return byId.rows[0];
  }
  var byNum = await pool.query(
    'SELECT * FROM work_orders WHERE wo_number = $1 OR wo_ref = $1 ORDER BY id DESC LIMIT 1', [v]);
  return byNum.rows.length ? byNum.rows[0] : null;
}

function dirOf(raw) {
  var d = String(raw || '').toLowerCase();
  if (d === 'in' || d === 'checkin' || d === 'check-in') return 'in';
  if (d === 'out' || d === 'checkout' || d === 'check-out') return 'out';
  return null;
}

function gpsOf(body) {
  if (!body) return null;
  var lat = parseFloat(body.lat), lon = parseFloat(body.lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  var acc = parseFloat(body.accuracy);
  return { lat: lat, lon: lon, accuracy: isFinite(acc) ? acc : null };
}

// ---- status ---------------------------------------------------------------

// Is any of this switched on? Drives whether the screens draw the card at all.
router.get('/config', requireAuth, function (req, res) {
  var t = twilio.status();
  res.json({
    voice: t,
    can_call: t.configured && !!t.webhook_base,
    fields: ivr.fieldList()
  });
});

// The Job Clock payload for one job.
router.get('/state/:workOrderId', requireAuth, requirePermission('view_work_orders'), async (req, res) => {
  try {
    var g = await guardWorkOrder(req, req.params.workOrderId);
    if (g.err) return res.status(g.err).json({ error: g.message });
    var state = await engine.jobState(req.params.workOrderId);
    if (!state) return res.status(404).json({ error: 'Work order not found' });
    res.json(state);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load check-in status' }); }
});

// One event, with a short-lived link to its recording if there is one.
router.get('/event/:id', requireAuth, requirePermission('view_work_orders'), async (req, res) => {
  try {
    var { rows } = await pool.query(
      'SELECT e.*, u.name AS requested_by_name FROM checkin_events e ' +
      'LEFT JOIN users u ON e.requested_by = u.id WHERE e.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    var ev = rows[0];
    var g = await guardWorkOrder(req, ev.work_order_id);
    if (g.err) return res.status(g.err).json({ error: g.message });
    ev.recording_url = null;
    if (ev.recording_key && r2.configured()) {
      try {
        ev.recording_url = await r2.presignDownload(ev.recording_key, 'checkin-' + ev.id + '.mp3', true, 600, 'audio/mpeg');
      } catch (e) { /* the transcript is still useful without the audio */ }
    }
    res.json(ev);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load the check-in record' }); }
});

// ---- doing it -------------------------------------------------------------

// ---- the monitor ----------------------------------------------------------

router.get('/monitor', requireAuth, requirePermission('manage_work_orders'), async (req, res) => {
  try {
    var days = Math.min(parseInt(req.query.days, 10) || 1, 30);
    var { rows } = await pool.query(
      'SELECT e.*, u.name AS tech_name, w.wo_ref, w.wo_number, w.account_name, w.store_name ' +
      'FROM checkin_events e ' +
      'LEFT JOIN users u ON e.requested_by = u.id ' +
      'LEFT JOIN work_orders w ON e.work_order_id = w.id ' +
      'WHERE e.is_test = ANY($2) ' +
      "AND e.requested_at > NOW() - ($1 || ' days')::interval " +
      'ORDER BY e.id DESC LIMIT 500',
      [String(days), (req.query.tests === '1' ? [true, false] : [false])]
    );
    var counts = { confirmed: 0, manual: 0, failed: 0, open: 0 };
    rows.forEach(function (r) {
      if (r.status === 'confirmed') counts.confirmed++;
      else if (r.status === 'manual') counts.manual++;
      else if (r.status === 'failed') counts.failed++;
      else counts.open++;
    });
    res.json({ days: days, counts: counts, events: rows, includes_tests: req.query.tests === '1' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load the monitor' }); }
});

// ---- profiles -------------------------------------------------------------

function profileBody(b) {
  function steps(v) {
    if (v == null) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
    return Array.isArray(v) ? v : null;
  }
  return {
    vendor_id: b.vendor_id ? parseInt(b.vendor_id, 10) : null,
    name: b.name ? String(b.name).slice(0, 120) : null,
    method: b.method === 'off' ? 'off' : 'phone',
    phone_number: b.phone_number ? String(b.phone_number).slice(0, 50) : null,
    site_radius_ft: parseInt(b.site_radius_ft, 10) || 500,
    checkin_steps: steps(b.checkin_steps),
    checkout_steps: steps(b.checkout_steps),
    confirm_phrases: b.confirm_phrases != null ? String(b.confirm_phrases) : null,
    checkout_confirm_phrases: b.checkout_confirm_phrases != null ? String(b.checkout_confirm_phrases) : null,
    capture_pattern: b.capture_pattern != null ? String(b.capture_pattern) : null,
    capture_label: b.capture_label ? String(b.capture_label).slice(0, 80) : null
  };
}

router.get('/profiles', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var { rows } = await pool.query(
      'SELECT p.*, v.name AS vendor_name FROM ivr_profiles p ' +
      'LEFT JOIN vendors v ON p.vendor_id = v.id ORDER BY COALESCE(v.name, p.name) ASC'
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load profiles' }); }
});

router.get('/profiles/:id', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var { rows } = await pool.query(
      'SELECT p.*, v.name AS vendor_name FROM ivr_profiles p ' +
      'LEFT JOIN vendors v ON p.vendor_id = v.id WHERE p.id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load profile' }); }
});

router.post('/profiles', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var b = profileBody(req.body || {});
    if (!b.vendor_id) return res.status(400).json({ error: 'Pick the account this profile belongs to.' });
    var { rows } = await pool.query(
      'INSERT INTO ivr_profiles (vendor_id, name, method, phone_number, site_radius_ft, checkin_steps, ' +
      'checkout_steps, confirm_phrases, checkout_confirm_phrases, capture_pattern, capture_label, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [b.vendor_id, b.name, b.method, b.phone_number, b.site_radius_ft,
        JSON.stringify(b.checkin_steps), JSON.stringify(b.checkout_steps),
        b.confirm_phrases, b.checkout_confirm_phrases, b.capture_pattern, b.capture_label, req.user.id]
    );
    await logAudit({ entity_type: 'ivr_profile', entity_id: rows[0].id, action: 'created',
      user_id: req.user.id, user_name: req.user.name, details: 'Check-in profile created' });
    res.json(rows[0]);
  } catch (err) {
    if (err && String(err.code) === '23505') return res.status(409).json({ error: 'That account already has a profile.' });
    console.error(err); res.status(500).json({ error: 'Failed to save profile' });
  }
});

// A profile goes INACTIVE on every edit, on purpose. Changing the steps, the
// number, or the confirmation phrase means the last test call no longer proves
// anything, and an untested script is exactly how Nova ends up telling a client
// a technician arrived when he did not.
router.put('/profiles/:id', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var b = profileBody(req.body || {});
    var keepActive = req.body && req.body.keep_active === true;
    if (!b.vendor_id) return res.status(400).json({ error: 'Pick the account this script belongs to.' });
    // vendor_id is in the SET list on purpose. It was left out of the first
    // version, so changing the Account dropdown and saving appeared to work and
    // then silently reverted on reload. A field the form offers to edit has to
    // actually be written.
    var { rows } = await pool.query(
      'UPDATE ivr_profiles SET vendor_id = $13, name = $2, method = $3, phone_number = $4, site_radius_ft = $5, ' +
      'checkin_steps = $6, checkout_steps = $7, confirm_phrases = $8, checkout_confirm_phrases = $9, ' +
      'capture_pattern = $10, capture_label = $11, ' +
      'active = CASE WHEN $12 THEN active ELSE false END, ' +
      'needs_review = false, needs_review_reason = NULL, updated_at = NOW() ' +
      'WHERE id = $1 RETURNING *',
      [req.params.id, b.name, b.method, b.phone_number, b.site_radius_ft,
        JSON.stringify(b.checkin_steps), JSON.stringify(b.checkout_steps),
        b.confirm_phrases, b.checkout_confirm_phrases, b.capture_pattern, b.capture_label, keepActive,
        b.vendor_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await logAudit({ entity_type: 'ivr_profile', entity_id: rows[0].id, action: 'updated',
      user_id: req.user.id, user_name: req.user.name, details: 'Check-in profile updated' });
    res.json(rows[0]);
  } catch (err) {
    if (err && String(err.code) === '23505') {
      return res.status(409).json({ error: 'That account already has a script. Open that one instead, or delete it first.' });
    }
    console.error(err); res.status(500).json({ error: 'Failed to save profile' });
  }
});

router.delete('/profiles/:id', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    await pool.query('DELETE FROM ivr_profiles WHERE id = $1', [req.params.id]);
    await logAudit({ entity_type: 'ivr_profile', entity_id: parseInt(req.params.id, 10), action: 'deleted',
      user_id: req.user.id, user_name: req.user.name, details: 'Check-in profile deleted' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete profile' }); }
});

// What the script would dial, for a real work order, with the values filled in.
// Prints the NORMALIZED digits, because a work order number losing its dash on
// the way to the keypad is something to find out here rather than at 2am.
router.post('/profiles/:id/preview', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var profile = await engine.loadProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    var wanted = req.body && (req.body.work_order_id || req.body.work_order);
    var wo = wanted ? await resolveWorkOrder(wanted) : null;
    if (wanted && !wo) return res.status(404).json({ error: 'No work order matches "' + String(wanted).slice(0, 40) + '".' });
    var values = wo ? engine.jobValues(wo, req.user) : {};
    var dir = dirOf(req.body && req.body.direction) || 'in';
    var steps = (dir === 'out' ? profile.checkout_steps : profile.checkin_steps) || [];
    res.json({
      direction: dir,
      preview: ivr.preview(steps, values, profile.phone_number),
      twiml: ivr.renderTwiml(steps, values, {}),
      problems: ivr.validate(steps, values),
      resolved: ivr.resolve(steps, values),
      work_order: wo ? { id: wo.id, wo_ref: wo.wo_ref, wo_number: wo.wo_number, account_name: wo.account_name } : null
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to build the preview' }); }
});

// The test call. Runs against a real work order so the values are real, but the
// event is flagged is_test so it can never stamp a job or block a live call.
router.post('/profiles/:id/test', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var profile = await engine.loadProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    var wanted = req.body && (req.body.work_order_id || req.body.work_order);
    if (!wanted) return res.status(400).json({ error: 'Pick a work order to test against.' });
    var wo = await resolveWorkOrder(wanted);
    if (!wo) return res.status(404).json({ error: 'No work order matches "' + String(wanted).slice(0, 40) + '".' });
    var ev = await engine.startCall({
      workOrderId: wo.id,
      direction: dirOf(req.body && req.body.direction) || 'in',
      user: req.user, profile: profile, isTest: true
    });
    res.json(ev);
  } catch (err) { res.status(400).json({ error: err.message || 'Test call failed.' }); }
});

// A test call is excluded from the Monitor on purpose, so this is where its
// result comes back. Without it the Test Call button fires into silence, which
// is the worst possible behaviour for the one button whose entire job is to tell
// you whether the script works.
router.get('/profiles/:id/tests', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var { rows } = await pool.query(
      'SELECT e.*, w.wo_ref, w.wo_number FROM checkin_events e ' +
      'LEFT JOIN work_orders w ON e.work_order_id = w.id ' +
      'WHERE e.profile_id = $1 AND e.is_test = true ORDER BY e.id DESC LIMIT 10',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load test calls' }); }
});

// Marking a profile live is its own act, done after a human has listened to a
// test call. Nothing sets active = true automatically.
router.post('/profiles/:id/activate', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var on = !(req.body && req.body.active === false);
    var { rows } = await pool.query(
      'UPDATE ivr_profiles SET active = $2, needs_review = CASE WHEN $2 THEN false ELSE needs_review END, ' +
      'needs_review_reason = CASE WHEN $2 THEN NULL ELSE needs_review_reason END, ' +
      'last_test_at = CASE WHEN $2 THEN NOW() ELSE last_test_at END, ' +
      'last_test_ok = CASE WHEN $2 THEN true ELSE last_test_ok END, ' +
      'updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id, on]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await logAudit({ entity_type: 'ivr_profile', entity_id: rows[0].id, action: on ? 'activated' : 'deactivated',
      user_id: req.user.id, user_name: req.user.name,
      details: on ? 'Check-in profile marked live' : 'Check-in profile taken offline' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update profile' }); }
});

// ---- doing it -------------------------------------------------------------
//
// Registered LAST on purpose. These two are the only routes here with a
// wildcard first segment, so anything named (/config, /state, /event, /monitor,
// /profiles) has to be declared above them or it would be swallowed.

// Place the call. The number always comes from the account's profile, never
// from this request, so there is no way to talk this endpoint into dialling
// something arbitrary.
router.post('/:workOrderId/:direction', requireAuth, requirePermission('checkin_job'), async (req, res) => {
  try {
    var dir = dirOf(req.params.direction);
    if (!dir) return res.status(400).json({ error: 'Direction must be in or out.' });
    var g = await guardWorkOrder(req, req.params.workOrderId);
    if (g.err) return res.status(g.err).json({ error: g.message });

    var ev = await engine.startCall({
      workOrderId: parseInt(req.params.workOrderId, 10),
      direction: dir,
      user: req.user,
      signoffId: req.body && req.body.signoff_id ? parseInt(req.body.signoff_id, 10) : null,
      gps: gpsOf(req.body)
    });
    res.json(ev);
  } catch (err) {
    // A duplicate is the unique index doing its job, not a server fault.
    if (err && String(err.code) === '23505') {
      return res.status(409).json({ error: 'A check-in for this job is already in progress or already done.' });
    }
    res.status(400).json({ error: err.message || 'Could not place the call.' });
  }
});

// "I called it in myself." Recorded as its own method rather than pretending
// Nova did it, because they are not the same evidence.
router.post('/:workOrderId/:direction/manual', requireAuth, requirePermission('checkin_job'), async (req, res) => {
  try {
    var dir = dirOf(req.params.direction);
    if (!dir) return res.status(400).json({ error: 'Direction must be in or out.' });
    var g = await guardWorkOrder(req, req.params.workOrderId);
    if (g.err) return res.status(g.err).json({ error: g.message });

    var open = await pool.query(
      'SELECT id FROM checkin_events WHERE work_order_id = $1 AND direction = $2 AND is_test = false ' +
      "AND status IN ('pending','dialing','in_progress','failed') ORDER BY id DESC LIMIT 1",
      [req.params.workOrderId, dir]
    );
    var out;
    if (open.rows.length) out = await engine.markManual(open.rows[0].id, req.user, req.body && req.body.note);
    else out = await engine.recordManual({
      workOrderId: parseInt(req.params.workOrderId, 10), direction: dir, user: req.user,
      signoffId: req.body && req.body.signoff_id ? parseInt(req.body.signoff_id, 10) : null,
      gps: gpsOf(req.body), note: req.body && req.body.note
    });
    res.json(out);
  } catch (err) {
    if (err && String(err.code) === '23505') {
      return res.status(409).json({ error: 'This job is already checked in.' });
    }
    console.error(err); res.status(400).json({ error: err.message || 'Could not record that.' });
  }
});

module.exports = router;
