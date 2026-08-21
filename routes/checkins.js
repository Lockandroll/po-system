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
var ready = require('../utils/checkinReadiness');
var brain = require('../utils/ivrBrain');
var hrCrypto = require('../utils/hrCrypto');
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
    fields: ivr.fieldList(),
    readiness_fields: ready.fieldList(),
    default_needs: ready.DEFAULT_NEEDS,
    modes: [
      { value: 'script', label: 'Script only', hint: 'Send a fixed run of tones and judge the recording afterwards. Cheapest, and it breaks the day the tree changes.' },
      { value: 'ai_fallback', label: 'Script, then AI', hint: 'Run the script; if it fails, hand the same job straight to the navigator. Where most accounts belong.' },
      { value: 'ai', label: 'AI navigator', hint: 'Nova listens to every prompt and decides each keypress. Use it on a tree nobody has scripted yet.' }
    ]
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

// ---- readiness ------------------------------------------------------------
//
// Everything the tree is going to ask for, where each value came from, and what
// is still missing. The screen calls this before it shows a Call button, so a
// technician finds out he is short a head count while he is still standing
// there rather than halfway through a phone tree.
//
// Registered above the wildcard pair at the bottom of this file, like every
// other named route here.
router.get('/readiness/:workOrderId/:direction', requireAuth, requirePermission('view_work_orders'), async (req, res) => {
  try {
    var dir = dirOf(req.params.direction);
    if (!dir) return res.status(400).json({ error: 'Direction must be in or out.' });
    var g = await guardWorkOrder(req, req.params.workOrderId);
    if (g.err) return res.status(g.err).json({ error: g.message });
    var prep = await engine.prepare({
      workOrderId: parseInt(req.params.workOrderId, 10), direction: dir, user: req.user,
      signoffId: req.query.signoff_id ? parseInt(req.query.signoff_id, 10) : null
    });
    // The resolved values go out; the PIN itself does not. A screen needs to
    // know the PIN is in hand, never what it is.
    res.json({
      direction: dir,
      ready: prep.state.ready,
      ask: prep.state.ask,
      blocked: prep.state.blocked,
      values: prep.state.values.map(function (v) {
        return {
          key: v.key, label: v.label, source: v.source, status: v.status,
          value: v.key === 'checkin_reference' || v.key === 'tech_reference'
            ? (v.value ? '\u2022\u2022\u2022\u2022' + String(v.value).slice(-2) : null)
            : v.value,
          status_label: v.status_label || null
        };
      })
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to work out what this call needs' }); }
});

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

// The encrypted account PIN never leaves the server, not even to the screen that
// set it. A hint (the last two digits) is enough for a manager to tell two PINs
// apart, and that is the whole legitimate need.
function publicProfile(row) {
  if (!row) return row;
  var out = {};
  Object.keys(row).forEach(function (k) { if (k !== 'account_pin_enc') out[k] = row[k]; });
  out.has_account_pin = !!row.account_pin_enc;
  return out;
}

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
    capture_label: b.capture_label ? String(b.capture_label).slice(0, 80) : null,
    mode: MODES.indexOf(String(b.mode || '').toLowerCase()) === -1 ? 'script' : String(b.mode).toLowerCase(),
    goal_checkin: b.goal_checkin != null ? String(b.goal_checkin).slice(0, 600) : null,
    goal_checkout: b.goal_checkout != null ? String(b.goal_checkout).slice(0, 600) : null,
    playbook: b.playbook != null ? String(b.playbook).slice(0, 4000) : null,
    max_turns: clampTurns(b.max_turns),
    status_map: statusMap(b.status_map),
    needs: needsOf(b.needs)
  };
}

var MODES = ['script', 'ai', 'ai_fallback'];

function clampTurns(v) {
  var n = parseInt(v, 10);
  if (!isFinite(n) || n < 1) n = 12;
  return Math.min(n, brain.HARD_CAP_TURNS);
}

// Which digit means what on THIS account's tree. The one business fact in a
// check-out, kept out of the model's hands on purpose: a wrong status closes the
// job in the wrong state on the client's side, which is worse than not calling.
var STATUS_KEYS = ['complete', 'incomplete_parts', 'return_trip', 'cancelled'];
function statusMap(v) {
  var src = v;
  if (typeof src === 'string') { try { src = JSON.parse(src); } catch (e) { src = null; } }
  if (!src || typeof src !== 'object') return null;
  var out = {};
  STATUS_KEYS.forEach(function (k) {
    var d = String(src[k] == null ? '' : src[k]).replace(/[^0-9*#]/g, '').slice(0, 4);
    if (d) out[k] = d;
  });
  return Object.keys(out).length ? out : null;
}

// What the tree asks for, per direction. A script says this through its send
// steps; an AI profile has no steps to read, and guessing at dial time is how a
// call ends up halfway through a tree with nothing to type.
function needsOf(v) {
  var src = v;
  if (typeof src === 'string') { try { src = JSON.parse(src); } catch (e) { src = null; } }
  if (!src || typeof src !== 'object') return null;
  var known = {};
  ready.fieldList().forEach(function (f) { known[f.key] = true; });
  var pick = function (arr) {
    return (Array.isArray(arr) ? arr : []).filter(function (k) { return known[k]; }).slice(0, 12);
  };
  var out = { in: pick(src.in), out: pick(src.out) };
  return (out.in.length || out.out.length) ? out : null;
}

router.get('/profiles', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var { rows } = await pool.query(
      'SELECT p.*, v.name AS vendor_name FROM ivr_profiles p ' +
      'LEFT JOIN vendors v ON p.vendor_id = v.id ORDER BY COALESCE(v.name, p.name) ASC'
    );
    res.json(rows.map(publicProfile));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load profiles' }); }
});

router.get('/profiles/:id', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var { rows } = await pool.query(
      'SELECT p.*, v.name AS vendor_name FROM ivr_profiles p ' +
      'LEFT JOIN vendors v ON p.vendor_id = v.id WHERE p.id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(publicProfile(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load profile' }); }
});

router.post('/profiles', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var b = profileBody(req.body || {});
    if (!b.vendor_id) return res.status(400).json({ error: 'Pick the account this profile belongs to.' });
    var { rows } = await pool.query(
      'INSERT INTO ivr_profiles (vendor_id, name, method, phone_number, site_radius_ft, checkin_steps, ' +
      'checkout_steps, confirm_phrases, checkout_confirm_phrases, capture_pattern, capture_label, created_by, ' +
      'mode, goal_checkin, goal_checkout, playbook, max_turns, status_map, needs) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *',
      [b.vendor_id, b.name, b.method, b.phone_number, b.site_radius_ft,
        JSON.stringify(b.checkin_steps), JSON.stringify(b.checkout_steps),
        b.confirm_phrases, b.checkout_confirm_phrases, b.capture_pattern, b.capture_label, req.user.id,
        b.mode, b.goal_checkin, b.goal_checkout, b.playbook, b.max_turns,
        b.status_map ? JSON.stringify(b.status_map) : null, b.needs ? JSON.stringify(b.needs) : null]
    );
    await logAudit({ entity_type: 'ivr_profile', entity_id: rows[0].id, action: 'created',
      user_id: req.user.id, user_name: req.user.name, details: 'Check-in profile created' });
    res.json(publicProfile(rows[0]));
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
      'mode = $14, goal_checkin = $15, goal_checkout = $16, playbook = $17, max_turns = $18, ' +
      'status_map = $19, needs = $20, ' +
      'active = CASE WHEN $12 THEN active ELSE false END, ' +
      // Changing the script, the number, the mode or the goal means the last
      // test call no longer proves anything, so the streak that earns a
      // promotion offer resets with it.
      'ai_streak = 0, ai_streak_signature = NULL, ' +
      'needs_review = false, needs_review_reason = NULL, updated_at = NOW() ' +
      'WHERE id = $1 RETURNING *',
      [req.params.id, b.name, b.method, b.phone_number, b.site_radius_ft,
        JSON.stringify(b.checkin_steps), JSON.stringify(b.checkout_steps),
        b.confirm_phrases, b.checkout_confirm_phrases, b.capture_pattern, b.capture_label, keepActive,
        b.vendor_id, b.mode, b.goal_checkin, b.goal_checkout, b.playbook, b.max_turns,
        b.status_map ? JSON.stringify(b.status_map) : null, b.needs ? JSON.stringify(b.needs) : null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await logAudit({ entity_type: 'ivr_profile', entity_id: rows[0].id, action: 'updated',
      user_id: req.user.id, user_name: req.user.name, details: 'Check-in profile updated' });
    res.json(publicProfile(rows[0]));
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
    res.json(publicProfile(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update profile' }); }
});

// The account's own PIN, for the accounts that issue one to the company instead
// of printing it on every work order.
//
// A vendor credential, so it is encrypted here with the same key the onboarding
// documents use and is never read back out. Setting one is a write-only act: a
// manager who cannot remember it types a new one.
router.post('/profiles/:id/pin', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var raw = req.body && req.body.pin;
    var clearing = raw === null || String(raw == null ? '' : raw).trim() === '';
    if (!clearing && !hrCrypto.configured()) {
      return res.status(400).json({ error: 'HR_DOC_ENC_KEY is not set on this server, so Nova has nowhere safe to keep a vendor PIN. Set it in Railway first, or type the PIN onto each work order instead.' });
    }
    var enc = clearing ? { enc: null, hint: null } : engine.encryptPin(raw);
    var { rows } = await pool.query(
      'UPDATE ivr_profiles SET account_pin_enc = $2, account_pin_hint = $3, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id, enc.enc, enc.hint]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await logAudit({ entity_type: 'ivr_profile', entity_id: rows[0].id, action: clearing ? 'pin_cleared' : 'pin_set',
      user_id: req.user.id, user_name: req.user.name,
      details: clearing ? 'Account check-in PIN removed' : 'Account check-in PIN set (ending ' + enc.hint + ')' });
    res.json(publicProfile(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save the PIN' }); }
});

// Save what the navigator learned as a plain script.
//
// The whole economic argument for the AI tier: it costs roughly eight times a
// scripted call, and most trees do not vary - they were just never scripted.
// Three consecutive successes with an identical keypress sequence says the tree
// is stable, and this turns that sequence into steps the cheap path can run
// forever. Nothing here is automatic, and the new script still has to pass a
// test call before it goes live, like any other.
router.post('/profiles/:id/promote', requireAuth, requirePermission('manage_ivr_profiles'), async (req, res) => {
  try {
    var profile = await engine.loadProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    var dir = dirOf(req.body && req.body.direction) || 'in';
    var { rows } = await pool.query(
      "SELECT * FROM checkin_events WHERE profile_id = $1 AND direction = $2 AND status = 'confirmed' " +
      "AND mode = 'ai' AND turns IS NOT NULL ORDER BY id DESC LIMIT 1",
      [req.params.id, dir]
    );
    if (!rows.length) return res.status(400).json({ error: 'There is no successful AI call on this account to learn from yet.' });
    var ev = rows[0];
    var steps = engine.stepsFromTurns(ev.turns);
    if (!steps.length) return res.status(400).json({ error: 'That call did not send anything Nova can turn into a script.' });

    var col = dir === 'out' ? 'checkout_steps' : 'checkin_steps';
    var phraseCol = dir === 'out' ? 'checkout_confirm_phrases' : 'confirm_phrases';
    var heardPhrase = ev.confirmation_text || ev.ai_quote || null;
    var existing = dir === 'out' ? profile.checkout_confirm_phrases : profile.confirm_phrases;
    var phrases = existing && heardPhrase && existing.indexOf(heardPhrase) !== -1
      ? existing
      : [existing, heardPhrase].filter(Boolean).join('; ');

    var upd = await pool.query(
      'UPDATE ivr_profiles SET ' + col + ' = $2, ' + phraseCol + ' = $3, ' +
      // Inactive, always. A script nobody has tested does not dial, however it
      // came to exist.
      'active = false, ai_streak = 0, ai_streak_signature = NULL, updated_at = NOW() ' +
      'WHERE id = $1 RETURNING *',
      [req.params.id, JSON.stringify(steps), phrases || null]
    );
    await logAudit({ entity_type: 'ivr_profile', entity_id: parseInt(req.params.id, 10), action: 'promoted_from_ai',
      user_id: req.user.id, user_name: req.user.name,
      details: 'Saved the AI navigator run from call #' + ev.id + ' as the ' + (dir === 'out' ? 'check-out' : 'check-in') + ' script' });
    res.json({ profile: publicProfile(upd.rows[0]), steps: steps, from_event: ev.id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save that as a script' }); }
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
      gps: gpsOf(req.body),
      // Only ever used to fill a value readiness itself declared missing.
      // utils/checkinReadiness.js drops everything else and says which, which is
      // what stops a browser handing Nova a PIN.
      answers: (req.body && req.body.answers) || {}
    });
    res.json(ev);
  } catch (err) {
    // A duplicate is the unique index doing its job, not a server fault.
    if (err && String(err.code) === '23505') {
      return res.status(409).json({ error: 'A check-in for this job is already in progress or already done.' });
    }
    // Not an error so much as a question. The screen turns this into the little
    // sheet that asks the technician the two things the tree wants and the
    // sign-off sheet has not answered yet.
    // 422 means "answer these and try again". A readiness failure nothing the
    // technician can type will fix is an ordinary 400, so the screen shows it as
    // a problem rather than as a form.
    if (err && err.readiness && err.needs_answers) {
      return res.status(422).json({
        error: err.message,
        needs_answers: !!err.needs_answers,
        ask: err.readiness.ask,
        blocked: err.readiness.blocked
      });
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
