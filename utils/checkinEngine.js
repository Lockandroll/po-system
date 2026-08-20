// utils/checkinEngine.js
//
// The brain behind check-in and check-out. Everything that decides WHAT to dial
// and whether it worked lives here; utils/twilioVoice.js only moves bytes and
// utils/ivrScript.js only formats them. No backticks.
//
// Two rules run through the whole file and are worth stating before the code:
//
//   1. A call that connected is not a check-in. A check-in is a recording in
//      which the tree said the phrase the profile expects. Anything else is a
//      FAILURE, loudly, with the technician told to call it in himself. A false
//      check-in is worse than a missing one, because nobody goes looking for it
//      until the invoice is denied.
//
//   2. Nova dials numbers that came out of an active ivr_profiles row and
//      nothing else. There is no path anywhere that takes an arbitrary number
//      and calls it. That, rather than answering-machine detection, is what
//      guarantees there is never a person on the other end.

var { pool } = require('../db');
var twilio = require('./twilioVoice');
var ivr = require('./ivrScript');
var speech = require('./speech');
var r2 = require('./r2');
var { sendSms } = require('./sms');
var push = require('./push');
var { logAudit } = require('./audit');

var LIVE = ['pending', 'dialing', 'in_progress'];
var MAX_ATTEMPTS = 2;   // one automatic retry, then it goes to the technician

// ---- small helpers ---------------------------------------------------------

function toE164(raw) {
  var d = String(raw == null ? '' : raw).replace(/[^0-9+]/g, '');
  if (d.indexOf('+') === 0) return d;
  d = d.replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  return d ? '+' + d : '';
}

function sameNumber(a, b) {
  var x = String(a == null ? '' : a).replace(/\D/g, '').replace(/^1/, '');
  var y = String(b == null ? '' : b).replace(/\D/g, '').replace(/^1/, '');
  return !!x && x === y;
}

function base() { return twilio.webhookBase(); }

// ---- loading ---------------------------------------------------------------

async function loadEvent(id) {
  var { rows } = await pool.query('SELECT * FROM checkin_events WHERE id = $1', [id]);
  return rows.length ? rows[0] : null;
}

async function loadProfile(id) {
  var { rows } = await pool.query('SELECT * FROM ivr_profiles WHERE id = $1', [id]);
  return rows.length ? rows[0] : null;
}

async function loadWorkOrder(id) {
  var { rows } = await pool.query('SELECT * FROM work_orders WHERE id = $1', [id]);
  return rows.length ? rows[0] : null;
}

// The account's profile. Matched on the work order's account, which is the only
// link that survives a client changing their phone number.
async function profileForWorkOrder(wo) {
  if (!wo) return null;
  if (wo.account_id) {
    var byId = await pool.query('SELECT * FROM ivr_profiles WHERE vendor_id = $1', [wo.account_id]);
    if (byId.rows.length) return byId.rows[0];
  }
  if (wo.account_name) {
    var byName = await pool.query(
      'SELECT p.* FROM ivr_profiles p JOIN vendors v ON p.vendor_id = v.id ' +
      'WHERE LOWER(TRIM(v.name)) = LOWER(TRIM($1)) LIMIT 1',
      [wo.account_name]
    );
    if (byName.rows.length) return byName.rows[0];
  }
  return null;
}

// The values a script's steps may pull from. The work order's own
// checkin_reference is tried before the technician's, because on these accounts
// the id is usually printed on the document rather than issued to the person.
function jobValues(wo, user) {
  return {
    wo_number: wo.wo_number,
    po_number: wo.po_number,
    claim_id: wo.claim_id,
    store_number: wo.store_number,
    account_number: wo.account_number,
    checkin_reference: wo.checkin_reference,
    tech_reference: wo.checkin_reference || (user && user.ivr_reference) || null,
    num_technicians: null
  };
}

// What the screens need to draw the Job Clock, for one job.
async function jobState(workOrderId) {
  var wo = await loadWorkOrder(workOrderId);
  if (!wo) return null;
  var profile = await profileForWorkOrder(wo);
  var { rows: events } = await pool.query(
    'SELECT e.*, u.name AS requested_by_name FROM checkin_events e ' +
    'LEFT JOIN users u ON e.requested_by = u.id ' +
    'WHERE e.work_order_id = $1 AND e.is_test = false ORDER BY e.id ASC',
    [workOrderId]
  );
  function latest(dir) {
    var hit = null;
    events.forEach(function (e) { if (e.direction === dir) hit = e; });
    return hit;
  }
  var ready = !!(profile && profile.active && profile.method === 'phone' && profile.phone_number && !profile.needs_review);
  var reason = null;
  if (!profile) reason = 'No check-in profile has been set up for this account yet.';
  else if (profile.method !== 'phone') reason = 'Check-in is switched off for this account.';
  else if (profile.needs_review) reason = 'This account&#39;s phone script is flagged for review: ' + (profile.needs_review_reason || 'unknown');
  else if (!profile.active) reason = 'This account&#39;s phone script has not passed a test call yet.';
  else if (!twilio.configured()) reason = 'Twilio voice is not configured yet.';
  if (!twilio.configured()) ready = false;

  return {
    work_order_id: wo.id,
    account_name: wo.account_name,
    wo_number: wo.wo_number,
    checkin_phone: wo.checkin_phone,
    checkin_reference: wo.checkin_reference,
    checkin_instructions: wo.checkin_instructions,
    checked_in_at: wo.checked_in_at,
    checked_out_at: wo.checked_out_at,
    auth_number: wo.checkin_auth_number,
    profile: profile ? {
      id: profile.id, name: profile.name, method: profile.method,
      phone_number: profile.phone_number, active: profile.active,
      needs_review: profile.needs_review, capture_label: profile.capture_label
    } : null,
    can_call: ready,
    blocked_reason: ready ? null : reason,
    // The work order printed a different number than the profile dials. Not
    // fatal, but somebody should look, because it usually means the account
    // changed its line and every future call is about to start failing.
    number_mismatch: !!(profile && wo.checkin_phone && !sameNumber(profile.phone_number, wo.checkin_phone)),
    checkin: latest('in'),
    checkout: latest('out'),
    events: events
  };
}

// ---- placing a call --------------------------------------------------------

// Creates the event row FIRST, so the partial unique index refuses a second
// live call for the same job and direction. That index is the entire defence
// against a double tap: the Calls API has no idempotency key.
async function startCall(opts) {
  var wo = await loadWorkOrder(opts.workOrderId);
  if (!wo) throw new Error('Work order not found.');
  var isTest = !!opts.isTest;

  var profile = opts.profile || await profileForWorkOrder(wo);
  if (!profile) throw new Error('No check-in profile has been set up for this account yet.');
  if (profile.method !== 'phone') throw new Error('Check-in is switched off for this account.');
  if (profile.needs_review && !isTest) throw new Error('This account\'s phone script is flagged for review and will not be dialled until someone clears it.');
  if (!profile.active && !isTest) throw new Error('This account\'s phone script has not passed a test call yet.');

  // THE allow-list. The number dialled always comes from the profile, never
  // from the work order and never from the request, so no code path anywhere
  // can be talked into calling an arbitrary number.
  var to = toE164(profile.phone_number);
  if (!to) throw new Error('This account\'s profile has no phone number on it.');

  var steps = (opts.direction === 'out' ? profile.checkout_steps : profile.checkin_steps) || [];
  var values = jobValues(wo, opts.user);
  var problems = ivr.validate(steps, values);
  if (problems.length) throw new Error(problems.join(' '));

  var ins = await pool.query(
    'INSERT INTO checkin_events (work_order_id, signoff_id, profile_id, direction, method, status, ' +
    'requested_by, phone_number, script_preview, gps_lat, gps_lon, gps_accuracy, attempt, is_test) ' +
    "VALUES ($1,$2,$3,$4,'call','pending',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
    [wo.id, opts.signoffId || null, profile.id, opts.direction, opts.user ? opts.user.id : null,
      profile.phone_number, ivr.preview(steps, values, profile.phone_number),
      opts.gps ? opts.gps.lat : null, opts.gps ? opts.gps.lon : null, opts.gps ? opts.gps.accuracy : null,
      opts.attempt || 1, isTest]
  );
  var ev = ins.rows[0];

  try {
    var b = base();
    if (!b) throw new Error('No public URL configured for Twilio callbacks (set TWILIO_WEBHOOK_BASE or APP_URL).');
    var call = await twilio.placeCall({
      to: to,
      url: b + '/api/twilio/voice/script/' + ev.id,
      statusCallback: b + '/api/twilio/voice/status/' + ev.id,
      recordingCallback: b + '/api/twilio/voice/recording/' + ev.id,
      record: true
    });
    await pool.query(
      "UPDATE checkin_events SET call_sid = $1, status = 'dialing', updated_at = NOW() WHERE id = $2",
      [call.sid, ev.id]
    );
    ev.call_sid = call.sid;
    ev.status = 'dialing';
  } catch (err) {
    await fail(ev.id, 'Could not place the call: ' + err.message, { quiet: true });
    throw err;
  }

  try {
    await logAudit({
      entity_type: 'checkin', entity_id: ev.id, entity_number: wo.wo_ref || String(wo.id),
      action: 'call_placed', user_id: opts.user ? opts.user.id : null,
      user_name: opts.user ? opts.user.name : 'System',
      details: opts.direction === 'out' ? 'Check-out call placed' : 'Check-in call placed'
    });
  } catch (e) { /* audit must never fail a call */ }

  return ev;
}

async function markDialing(id, callSid) {
  await pool.query(
    "UPDATE checkin_events SET status = CASE WHEN status IN ('pending','dialing') THEN 'in_progress' ELSE status END, " +
    'call_sid = COALESCE(call_sid, $2), updated_at = NOW() WHERE id = $1',
    [id, callSid]
  );
}

// The TwiML for a call already in flight.
async function renderScript(ev) {
  var wo = await loadWorkOrder(ev.work_order_id);
  var profile = await loadProfile(ev.profile_id);
  if (!wo || !profile) return ivr.renderTwiml([], {}, {});
  var user = null;
  if (ev.requested_by) {
    var u = await pool.query('SELECT id, name, ivr_reference FROM users WHERE id = $1', [ev.requested_by]);
    user = u.rows[0] || null;
  }
  var steps = (ev.direction === 'out' ? profile.checkout_steps : profile.checkin_steps) || [];
  return ivr.renderTwiml(steps, jobValues(wo, user), {});
}

// ---- callbacks -------------------------------------------------------------

async function onCallStatus(id, data) {
  var ev = await loadEvent(id);
  if (!ev) return;
  await pool.query(
    'UPDATE checkin_events SET call_status = $2, call_duration = COALESCE($3, call_duration), ' +
    'call_sid = COALESCE(call_sid, $4), updated_at = NOW() WHERE id = $1',
    [id, data.call_status, data.duration, data.call_sid]
  );
  var s = String(data.call_status || '').toLowerCase();
  if (s === 'busy' || s === 'no-answer' || s === 'failed' || s === 'canceled') {
    await fail(id, 'The line was ' + s + '.');
  }
  // A 'completed' status is NOT a confirmation. The verdict waits for the
  // recording, which is the only thing that can tell us what the tree said.
}

async function onRecording(id, data) {
  var ev = await loadEvent(id);
  if (!ev) return;
  if (ev.status === 'confirmed' || ev.status === 'manual') return;

  var profile = await loadProfile(ev.profile_id);
  var transcript = '';
  var key = null;

  try {
    var rec = await twilio.fetchRecording(data.recording_url, 'mp3');
    if (r2.configured()) {
      key = 'checkin/' + ev.id + '.' + rec.ext;
      await r2.putObject(key, rec.buffer, rec.mime);
      // Two copies of a recording is one more than anybody wants to reason
      // about. Best effort, and never allowed to fail the check-in.
      await twilio.deleteRecording(data.recording_sid);
    }
    transcript = await speech.transcribe(rec.buffer, rec.mime, { filename: 'checkin-' + ev.id });
  } catch (err) {
    await pool.query(
      'UPDATE checkin_events SET recording_sid = $2, recording_key = $3, updated_at = NOW() WHERE id = $1',
      [id, data.recording_sid, key]
    );
    return fail(id, 'Could not read the recording: ' + err.message);
  }

  var phrases = (ev.direction === 'out' && profile && profile.checkout_confirm_phrases)
    ? profile.checkout_confirm_phrases
    : (profile ? profile.confirm_phrases : '');
  var verdict = ivr.matchConfirmation(transcript, phrases);
  var auth = (ev.direction === 'out' && profile) ? ivr.captureValue(transcript, profile.capture_pattern) : null;

  await pool.query(
    'UPDATE checkin_events SET recording_sid = $2, recording_key = $3, transcript = $4, ' +
    'auth_number = COALESCE($5, auth_number), updated_at = NOW() WHERE id = $1',
    [id, data.recording_sid, key, transcript, auth]
  );

  if (verdict.matched) return confirm(id, verdict.phrase, auth);

  var why = verdict.reason === 'no_phrases_configured'
    ? 'This account has no confirmation phrase configured, so Nova cannot tell whether the call worked.'
    : 'The call ran to the end but Nova never heard the confirmation phrase.';
  await fail(id, why);

  // The tree said something, and it was not what this profile expects. That is
  // either a menu that changed or a number that was reassigned, and both mean
  // Nova should stop dialling it until a person has listened. This is what
  // replaces answering-machine detection: a list, checked after the fact,
  // rather than a detector guessing during the call.
  if (transcript && verdict.reason === 'phrase_not_heard' && profile && !ev.is_test) {
    await flagProfile(profile.id, 'A call on ' + new Date().toISOString().slice(0, 10) +
      ' did not match any expected phrase. Listen to the recording before dialling this number again.');
  }
}

async function flagProfile(profileId, reason) {
  try {
    await pool.query(
      'UPDATE ivr_profiles SET needs_review = true, needs_review_reason = $2, updated_at = NOW() WHERE id = $1',
      [profileId, String(reason).slice(0, 500)]
    );
  } catch (e) { console.error('[checkin] could not flag profile:', e.message); }
}

// ---- outcomes --------------------------------------------------------------

async function confirm(id, phrase, auth) {
  var ev = await loadEvent(id);
  if (!ev) return;
  var at = new Date();
  await pool.query(
    "UPDATE checkin_events SET status = 'confirmed', confirmed_at = $2, confirmation_text = $3, " +
    'auth_number = COALESCE($4, auth_number), failure_reason = NULL, updated_at = NOW() WHERE id = $1',
    [id, at, phrase || null, auth || null]
  );
  if (!ev.is_test) await stampJob(ev, at, auth);
  return true;
}

// The convenience copy on the work order. checkin_events stays the source of
// truth; these two columns exist so a list screen does not have to join.
async function stampJob(ev, at, auth) {
  var col = ev.direction === 'out' ? 'checked_out_at' : 'checked_in_at';
  await pool.query(
    'UPDATE work_orders SET ' + col + ' = $2, ' +
    'checkin_auth_number = COALESCE($3, checkin_auth_number), updated_at = NOW() WHERE id = $1',
    [ev.work_order_id, at, auth || null]
  );
}

async function fail(id, reason, opts) {
  opts = opts || {};
  var ev = await loadEvent(id);
  if (!ev) return;
  if (ev.status === 'confirmed' || ev.status === 'manual') return;
  await pool.query(
    "UPDATE checkin_events SET status = 'failed', failure_reason = $2, updated_at = NOW() WHERE id = $1",
    [id, String(reason || 'Unknown failure').slice(0, 500)]
  );
  if (!opts.quiet && !ev.is_test) await notifyFailure(ev, reason);
}

// A failed check-in that nobody hears about is the same as no check-in at all,
// except it also cost money. The technician gets told immediately, with the
// number in the message so he can act on it standing where he is.
async function notifyFailure(ev, reason) {
  try {
    var wo = await loadWorkOrder(ev.work_order_id);
    var who = ev.requested_by;
    if (!who) return;
    var u = await pool.query('SELECT id, name, phone FROM users WHERE id = $1', [who]);
    if (!u.rows.length) return;
    var word = ev.direction === 'out' ? 'Check-out' : 'Check-in';
    var msg = 'Nova: ' + word + ' FAILED for ' + (wo && wo.wo_number ? 'WO ' + wo.wo_number : 'this job') +
      '. ' + String(reason || '') + ' Call it in yourself: ' + (ev.phone_number || '') +
      (wo && wo.checkin_reference ? ' (ID ' + wo.checkin_reference + ')' : '');
    if (u.rows[0].phone) { try { await sendSms(u.rows[0].phone, msg); } catch (e) { /* SMS is best effort */ } }
    try {
      await push.sendPushToUsers([who], {
        title: word + ' failed', body: msg,
        url: '/#work-order/' + ev.work_order_id
      });
    } catch (e) { /* push is best effort */ }
  } catch (e) { console.error('[checkin] failure notify:', e.message); }
}

// The technician called it in himself. Recorded as its own method rather than
// pretending Nova did it, because the two are not the same evidence.
async function markManual(id, user, note) {
  var ev = await loadEvent(id);
  if (!ev) throw new Error('Check-in not found.');
  var at = new Date();
  await pool.query(
    "UPDATE checkin_events SET status = 'manual', method = 'manual', confirmed_at = $2, " +
    'confirmation_text = $3, failure_reason = NULL, updated_at = NOW() WHERE id = $1',
    [id, at, note || 'Marked as called in by hand.']
  );
  if (!ev.is_test) await stampJob(ev, at, null);
  try {
    await logAudit({
      entity_type: 'checkin', entity_id: ev.id, entity_number: String(ev.work_order_id),
      action: 'marked_manual', user_id: user ? user.id : null, user_name: user ? user.name : 'System',
      details: (ev.direction === 'out' ? 'Check-out' : 'Check-in') + ' marked as called in by hand'
    });
  } catch (e) { /* audit must never block */ }
  return loadEvent(id);
}

// A job with no automation at all: the account has no profile, or Twilio is not
// configured, and the technician just wants it recorded that he called.
async function recordManual(opts) {
  var wo = await loadWorkOrder(opts.workOrderId);
  if (!wo) throw new Error('Work order not found.');
  var at = new Date();
  var ins = await pool.query(
    'INSERT INTO checkin_events (work_order_id, signoff_id, direction, method, status, requested_by, ' +
    "phone_number, confirmed_at, confirmation_text, gps_lat, gps_lon, gps_accuracy) " +
    "VALUES ($1,$2,$3,'manual','manual',$4,$5,$6,$7,$8,$9,$10) RETURNING *",
    [wo.id, opts.signoffId || null, opts.direction, opts.user ? opts.user.id : null,
      wo.checkin_phone || null, at, opts.note || 'Called in by hand.',
      opts.gps ? opts.gps.lat : null, opts.gps ? opts.gps.lon : null, opts.gps ? opts.gps.accuracy : null]
  );
  await stampJob(ins.rows[0], at, null);
  return ins.rows[0];
}

// ---- the sweeper -----------------------------------------------------------
//
// Railway redeploys mid-call and the status callback lands nowhere. These are
// the rows that started and never reported back; ask Twilio what happened
// rather than leaving a technician staring at a spinner.
async function sweepStuck(olderThanMinutes) {
  var mins = olderThanMinutes || 10;
  var { rows } = await pool.query(
    'SELECT * FROM checkin_events WHERE status = ANY($1) ' +
    "AND requested_at < NOW() - ($2 || ' minutes')::interval ORDER BY id ASC LIMIT 50",
    [LIVE, String(mins)]
  );
  var handled = 0;
  for (var i = 0; i < rows.length; i++) {
    var ev = rows[i];
    try {
      if (!ev.call_sid) { await fail(ev.id, 'The call was never placed.'); handled++; continue; }
      var call = await twilio.getCall(ev.call_sid);
      if (!call) { await fail(ev.id, 'Twilio has no record of this call.'); handled++; continue; }
      var s = String(call.status || '').toLowerCase();
      if (s === 'completed') {
        await fail(ev.id, 'The call finished but no recording ever arrived, so Nova cannot confirm it.');
      } else if (s === 'in-progress' || s === 'ringing' || s === 'queued') {
        continue; // genuinely still going
      } else {
        await fail(ev.id, 'The call ended as ' + s + '.');
      }
      handled++;
    } catch (e) { console.error('[checkin] sweep ' + ev.id + ':', e.message); }
  }
  return { checked: rows.length, handled: handled };
}

module.exports = {
  toE164: toE164,
  sameNumber: sameNumber,
  loadEvent: loadEvent,
  loadProfile: loadProfile,
  loadWorkOrder: loadWorkOrder,
  profileForWorkOrder: profileForWorkOrder,
  jobValues: jobValues,
  jobState: jobState,
  startCall: startCall,
  markDialing: markDialing,
  renderScript: renderScript,
  onCallStatus: onCallStatus,
  onRecording: onRecording,
  confirm: confirm,
  fail: fail,
  flagProfile: flagProfile,
  markManual: markManual,
  recordManual: recordManual,
  sweepStuck: sweepStuck,
  MAX_ATTEMPTS: MAX_ATTEMPTS
};
