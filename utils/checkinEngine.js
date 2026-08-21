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
var brain = require('./ivrBrain');
var ready = require('./checkinReadiness');
var hrCrypto = require('./hrCrypto');
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
function jobValues(wo, user, extra) {
  var base = {
    wo_number: wo.wo_number,
    po_number: wo.po_number,
    claim_id: wo.claim_id,
    store_number: wo.store_number,
    account_number: wo.account_number,
    checkin_reference: wo.checkin_reference,
    checkin_tracking: wo.checkin_tracking,
    tech_reference: wo.checkin_reference || (user && user.ivr_reference) || null,
    num_technicians: null
  };
  // Anything readiness resolved wins: the account-level PIN, a head count off
  // the sign-off sheet, a job status turned into this account's own digit, and
  // whatever the technician typed on the way past. Every one of those carries a
  // provenance that was recorded before the call, which is the only reason it is
  // allowed near a keypad.
  Object.keys(extra || {}).forEach(function (k) {
    if (extra[k] != null && String(extra[k]) !== '') base[k] = extra[k];
  });
  return base;
}

// ---- the account's own PIN ------------------------------------------------
//
// Some accounts issue one PIN to the company rather than printing it on each
// work order. It is a vendor credential, so it is stored encrypted with the same
// key the onboarding documents use and decrypted only here, on the way to a
// keypad. It is never returned to a browser and never written to a log.
function accountPin(profile) {
  if (!profile || !profile.account_pin_enc) return null;
  try {
    return hrCrypto.decrypt(Buffer.from(String(profile.account_pin_enc), 'base64')).toString('utf8') || null;
  } catch (e) {
    console.error('[checkin] could not read the account PIN: ' + e.message);
    return null;
  }
}

function encryptPin(pin) {
  var v = String(pin == null ? '' : pin).trim();
  if (!v) return { enc: null, hint: null };
  return {
    enc: hrCrypto.encrypt(Buffer.from(v, 'utf8')).toString('base64'),
    hint: v.length > 2 ? ('..' + v.slice(-2)) : '..'
  };
}

// The sheet this call belongs to. The latest trip, because a job with three
// visits checks out of the one being worked, not the first one.
async function loadSignoff(wo, signoffId) {
  var id = signoffId || (wo && wo.signoff_id) || null;
  if (!id) return null;
  var { rows } = await pool.query('SELECT * FROM signoff_forms WHERE id = $1', [id]);
  return rows.length ? rows[0] : null;
}

// Everything a call needs, decided before a number is dialled.
//
// Deliberately re-run on the server even when the browser already ran it: the
// client's verdict is a convenience so the technician sees the right form, and
// this one is what actually gates the dial.
async function prepare(opts) {
  var wo = opts.workOrder || await loadWorkOrder(opts.workOrderId);
  if (!wo) throw new Error('Work order not found.');
  var profile = opts.profile || await profileForWorkOrder(wo);
  var user = opts.user || null;
  var signoff = await loadSignoff(wo, opts.signoffId);
  var direction = opts.direction === 'out' ? 'out' : 'in';

  var first = ready.readiness({
    direction: direction, profile: profile || {}, workOrder: wo, user: user,
    signoff: signoff, accountPin: accountPin(profile)
  });
  var merged = ready.applyAnswers(first, opts.answers || {});
  var state = Object.keys(merged.answers).length
    ? ready.readiness({
        direction: direction, profile: profile || {}, workOrder: wo, user: user,
        signoff: signoff, accountPin: accountPin(profile), answers: merged.answers
      })
    : first;

  return {
    wo: wo, profile: profile, user: user, signoff: signoff, direction: direction,
    state: state, answers: merged.answers, rejected: merged.rejected,
    values: ready.dialValues(state)
  };
}

// What the technician typed belongs on the sheet, not only on the call. The
// sheet is the record; the call is one thing that happened to the job.
async function writeAnswersThrough(signoff, answers) {
  if (!signoff || !answers) return;
  var sets = [], args = [signoff.id], n = 1;
  if (answers.num_technicians != null) {
    n++; sets.push('num_technicians = $' + n); args.push(parseInt(answers.num_technicians, 10));
  }
  if (answers.job_status != null && signoff.work_complete === null) {
    n++; sets.push('work_complete = $' + n); args.push(answers.job_status === 'complete');
  }
  if (!sets.length) return;
  try {
    await pool.query('UPDATE signoff_forms SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $1', args);
  } catch (e) { console.error('[checkin] answer write-through: ' + e.message); }
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
  var canDial = !!(profile && profile.active && profile.method === 'phone' && profile.phone_number && !profile.needs_review);
  var reason = null;
  // The account does the check-in through an app or a web portal. That is still
  // REQUIRED, Nova just cannot place it, and saying so plainly beats a Call
  // button that fails or a silent screen that looks like nothing is needed.
  var byHand = (wo.checkin_method === 'app' || wo.checkin_method === 'portal');
  if (byHand) reason = 'This account checks in through their ' + (wo.checkin_method === 'app' ? 'app' : 'portal') + ', so it has to be done by hand.';
  else if (!profile) reason = 'No check-in profile has been set up for this account yet.';
  else if (profile.method !== 'phone') reason = 'Check-in is switched off for this account.';
  else if (profile.needs_review) reason = 'This account&#39;s phone script is flagged for review: ' + (profile.needs_review_reason || 'unknown');
  else if (!profile.active) reason = 'This account&#39;s phone script has not passed a test call yet.';
  else if (!twilio.configured()) reason = 'Twilio voice is not configured yet.';
  if (!twilio.configured() || byHand) canDial = false;

  return {
    work_order_id: wo.id,
    account_name: wo.account_name,
    wo_number: wo.wo_number,
    checkin_phone: wo.checkin_phone,
    checkin_reference: wo.checkin_reference,
    checkin_tracking: wo.checkin_tracking,
    checkin_instructions: wo.checkin_instructions,
    checked_in_at: wo.checked_in_at,
    checked_out_at: wo.checked_out_at,
    auth_number: wo.checkin_auth_number,
    // What the document said about whether any of this is needed. The card only
    // draws when the answer is yes or unknown; a job the account explicitly
    // exempted should not be showing a technician a Check In button.
    checkin_required: wo.checkin_required || null,
    checkout_required: wo.checkout_required || null,
    checkin_method: wo.checkin_method || null,
    checkin_pay_gated: wo.checkin_pay_gated === true,
    checkin_evidence: wo.checkin_evidence || null,
    checkin_ai_note: wo.checkin_ai_note || null,
    checkin_ask_order: wo.checkin_ask_order || null,
    by_hand: byHand,
    profile: profile ? {
      id: profile.id, name: profile.name, method: profile.method,
      phone_number: profile.phone_number, active: profile.active,
      needs_review: profile.needs_review, capture_label: profile.capture_label,
      mode: profile.mode || 'script'
    } : null,
    can_call: canDial,
    blocked_reason: canDial ? null : reason,
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
function modeOf(profile, opts) {
  // ai_fallback runs the cheap deterministic script FIRST and only reaches for
  // the model when that script has already failed, which is where most accounts
  // should end up: the script handles the routine, the model handles the day the
  // tree changes.
  var m = String((profile && profile.mode) || 'script').toLowerCase();
  if (opts && opts.forceMode) return opts.forceMode;
  if (m === 'ai') return 'ai';
  return 'script';
}

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

  var prep = await prepare({
    workOrder: wo, profile: profile, user: opts.user, direction: opts.direction,
    signoffId: opts.signoffId, answers: opts.answers
  });
  var mode = modeOf(profile, opts);
  var steps = (opts.direction === 'out' ? profile.checkout_steps : profile.checkin_steps) || [];
  var values = jobValues(wo, opts.user, prep.values);
  var preview;
  if (mode === 'script') {
    // The step-level complaint first, because it names the step as well as the
    // field and that is what a person editing a script needs to hear. Readiness
    // below catches what a script cannot see: a value the tree wants that no
    // step happens to reference, and the questions only a technician can answer.
    var problems = ivr.validate(steps, values);
    if (problems.length) throw new Error(problems.join(' '));
    preview = ivr.preview(steps, values, profile.phone_number);
  } else {
    preview = 'dial ' + profile.phone_number + ' -> Nova listens and decides each keypress (up to ' +
      (profile.max_turns || 12) + ' turns) with ' +
      Object.keys(prep.values).join(', ') + ' in hand';
  }

  // Nothing dials until every value the tree will ask for has been named and
  // sourced. A call that dies halfway has already told the tree something, and
  // a half-finished entry is what makes the NEXT attempt fail too.
  if (!prep.state.ready) {
    var err = new Error(prep.state.blocked.length
      ? prep.state.blocked.join(' ')
      : 'Nova still needs ' + prep.state.ask.map(function (a) { return a.label; }).join(', ') + ' before it can make this call.');
    err.readiness = prep.state;
    err.needs_answers = prep.state.ask.length > 0 && prep.state.blocked.length === 0;
    throw err;
  }
  await writeAnswersThrough(prep.signoff, prep.answers);

  var ins = await pool.query(
    'INSERT INTO checkin_events (work_order_id, signoff_id, profile_id, direction, method, status, ' +
    'requested_by, phone_number, script_preview, gps_lat, gps_lon, gps_accuracy, attempt, is_test, ' +
    'mode, answers, turns) ' +
    "VALUES ($1,$2,$3,$4,'call','pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'[]'::jsonb) RETURNING *",
    [wo.id, opts.signoffId || (prep.signoff ? prep.signoff.id : null), profile.id, opts.direction,
      opts.user ? opts.user.id : null,
      profile.phone_number, preview,
      opts.gps ? opts.gps.lat : null, opts.gps ? opts.gps.lon : null, opts.gps ? opts.gps.accuracy : null,
      opts.attempt || 1, isTest, mode, JSON.stringify(prep.answers || {})]
  );
  var ev = ins.rows[0];

  try {
    var b = base();
    if (!b) throw new Error('No public URL configured for Twilio callbacks (set TWILIO_WEBHOOK_BASE or APP_URL).');
    var call = await twilio.placeCall({
      to: to,
      url: b + (mode === 'ai' ? '/api/twilio/voice/ai/' : '/api/twilio/voice/script/') + ev.id,
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

// Everything a call in flight needs, rebuilt from the row. Twilio calls back on
// a different request than the one that dialled, so nothing can be held in
// memory between the two.
async function callContext(ev) {
  var wo = await loadWorkOrder(ev.work_order_id);
  var profile = await loadProfile(ev.profile_id);
  var user = null;
  if (ev.requested_by) {
    var u = await pool.query('SELECT id, name, ivr_reference FROM users WHERE id = $1', [ev.requested_by]);
    user = u.rows[0] || null;
  }
  if (!wo) return null;
  var prep = await prepare({
    workOrder: wo, profile: profile, user: user, direction: ev.direction,
    signoffId: ev.signoff_id, answers: ev.answers || {}
  });
  return { wo: wo, profile: profile, user: user, prep: prep, values: jobValues(wo, user, prep.values) };
}

// The TwiML for a scripted call already in flight.
async function renderScript(ev) {
  var ctx = await callContext(ev);
  if (!ctx || !ctx.profile) return ivr.renderTwiml([], {}, {});
  var steps = (ev.direction === 'out' ? ctx.profile.checkout_steps : ctx.profile.checkin_steps) || [];
  return ivr.renderTwiml(steps, ctx.values, {});
}

// ---- the AI navigator ------------------------------------------------------
//
// One webhook per turn. Twilio posts what the tree just said, Nova decides the
// next keypress, and answers with TwiML that plays it and opens the next listen.
// Digits go OUTSIDE the Gather, which sidesteps the rule against a digits play
// inside one entirely.
//
// Everything that could go badly wrong here is handled in utils/ivrBrain.js and
// checked in code: the interlock that hangs up on a person before the model is
// asked, the validator that will not send a value Nova did not resolve, and the
// quote rule below. This function is the plumbing between those and the row.

// Words worth telling the recogniser to expect. Speech recognition on spoken
// alphanumerics is the weakest link in the whole system, and a hint list is the
// cheapest thing that moves it.
var SPEECH_HINTS = 'checked in, checked out, check in, check out, confirmation number, ' +
  'authorization number, tracking number, PIN number, pound key, work order, ' +
  'not recognized, invalid, try again, press one, for English, representative';

function aiUrls(ev) {
  var b = base();
  return {
    turn: b + '/api/twilio/voice/ai/' + ev.id + '/turn',
    hints: SPEECH_HINTS
  };
}

function maxTurnsFor(profile) {
  var n = parseInt(profile && profile.max_turns, 10);
  if (!isFinite(n) || n < 1) n = 12;
  return Math.min(n, brain.HARD_CAP_TURNS);
}

// The first thing the call does: nothing. Listen, and let the tree open.
async function aiOpen(ev) {
  await markDialing(ev.id, null);
  var u = aiUrls(ev);
  return brain.turnTwiml({ action: 'listen' }, { actionUrl: u.turn, hints: u.hints, timeout: 12 });
}

async function appendTurn(id, turn, heard) {
  var { rows } = await pool.query(
    'UPDATE checkin_events SET turns = COALESCE(turns, \'[]\'::jsonb) || $2::jsonb, ' +
    'turn_count = COALESCE(turn_count, 0) + 1, ' +
    "live_transcript = COALESCE(live_transcript, '') || $3, updated_at = NOW() " +
    'WHERE id = $1 RETURNING turns, live_transcript, turn_count',
    [id, JSON.stringify([turn]), (heard ? ' ' + heard : '')]
  );
  return rows[0] || { turns: [], live_transcript: '', turn_count: 0 };
}

// One turn.
async function aiTurn(id, heard, opts) {
  opts = opts || {};
  var ev = await loadEvent(id);
  if (!ev) return brain.hangupTwiml();
  if (ev.status === 'confirmed' || ev.status === 'manual' || ev.status === 'failed') return brain.hangupTwiml();

  var ctx = await callContext(ev);
  if (!ctx) { await fail(id, 'The job behind this call disappeared mid-call.'); return brain.hangupTwiml(); }

  var profile = ctx.profile || {};
  var max = maxTurnsFor(profile);
  var prior = Array.isArray(ev.turns) ? ev.turns : [];
  var soFar = String(ev.live_transcript || '') + ' ' + String(heard || '');

  var act = await brain.decide({
    direction: ev.direction,
    goal: ev.direction === 'out' ? profile.goal_checkout : profile.goal_checkin,
    playbook: profile.playbook || null,
    askOrder: ctx.wo.checkin_ask_order || null,
    values: ctx.prep.values,
    labels: (function () {
      var m = {};
      Object.keys(ctx.prep.values).forEach(function (k) { m[k] = ready.fieldLabel(k); });
      return m;
    })(),
    heard: heard,
    turns: prior,
    turnsLeft: max - prior.length
  }, { model: opts.model || null, callModel: opts.callModel || null });

  var record = {
    n: prior.length + 1,
    heard: String(heard || '').slice(0, 1000),
    action: act.action,
    digits: act.digits || null,
    field: act.field || null,
    suffix: act.suffix || null,
    seconds: act.seconds || null,
    reason: act.reason || null,
    confidence: act.confidence || null,
    source: act.source || null,
    at: new Date().toISOString()
  };
  var state = await appendTurn(id, record, heard);
  var live = String(state.live_transcript || soFar);

  // ---- confirm -----------------------------------------------------------
  //
  // THE rule. A model saying "checked in" is not a check-in; the tree saying it
  // is. So the words the model quotes have to be found in the transcript Twilio
  // produced, and a quote that is not there is a FAILED call with its own name
  // and its own alarm. A model that invents a confirmation is the worst thing
  // this system can do, and it must never look like a success.
  if (act.action === 'confirm') {
    var v = brain.verifyQuote(act.quote, live);
    if (v.ok) {
      var auth = (ev.direction === 'out' && act.auth_number && brain.verifyAuth(act.auth_number, live))
        ? act.auth_number : null;
      // The account's own configured phrase is a stronger and cheaper answer, so
      // if it also matched, record THAT as how Nova knows.
      var phrases = (ev.direction === 'out' && profile.checkout_confirm_phrases)
        ? profile.checkout_confirm_phrases : profile.confirm_phrases;
      var byPhrase = ivr.matchConfirmation(live, phrases);
      await confirm(id, byPhrase.matched ? byPhrase.phrase : act.quote, auth, {
        verdict_source: byPhrase.matched ? 'phrase' : 'ai_quoted',
        ai_quote: act.quote
      });
      return brain.hangupTwiml();
    }
    await fail(id, v.reason === 'quote_too_short'
      ? 'The AI confirmed the check-in but quoted too little to prove it. Treated as a failure on purpose.'
      : 'The AI said this job was checked in, but the words it quoted are not in the recording. Nova refused it. Listen to the call before trusting this account again.');
    await pool.query('UPDATE checkin_events SET ai_quote = $2 WHERE id = $1', [id, String(act.quote || '').slice(0, 400)]);
    if (!ev.is_test && profile.id) {
      await flagProfile(profile.id, 'A call on ' + new Date().toISOString().slice(0, 10) +
        ' produced a confirmation the recording does not support. Listen to it before this number is dialled again.');
    }
    return brain.hangupTwiml();
  }

  // ---- abort -------------------------------------------------------------
  if (act.action === 'abort') {
    await fail(id, act.reason || 'The AI could not get through this tree.');
    // A number that reaches a person or a voicemail box is not a bad call, it is
    // a bad NUMBER, and every future call on it will do the same thing. Stop
    // dialling it until somebody has listened. This is what replaces answering
    // machine detection: a list, checked after the fact.
    if (!ev.is_test && profile.id && (act.hard_stop === 'human_on_the_line' || act.hard_stop === 'voicemail' || act.hard_stop === 'number_dead')) {
      await flagProfile(profile.id, 'A call on ' + new Date().toISOString().slice(0, 10) + ' ' +
        (act.hard_stop === 'number_dead' ? 'reached a dead number.' : 'reached ' + (act.hard_stop === 'voicemail' ? 'a voicemail box.' : 'a person.')) +
        ' Nova hung up. Check the number on a recent work order.');
    }
    return brain.hangupTwiml();
  }

  // ---- budget ------------------------------------------------------------
  if (state.turn_count >= max) {
    await fail(id, 'Nova used all ' + max + ' turns on this call without hearing a confirmation. The whole conversation is on the record below.');
    return brain.hangupTwiml();
  }

  var u = aiUrls(ev);
  return brain.turnTwiml(act, { actionUrl: u.turn, hints: u.hints, timeout: 12 });
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
  // A call the technician marked as made by hand has no recording of ours to
  // reason about.
  if (ev.status === 'manual') return;

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

  // An AI call was already judged live, off the transcript Twilio produced
  // during the call, and the technician has long since driven away. This pass is
  // the durable evidence and a CHECK, not a second verdict: a confirmed row is
  // never flipped from under somebody, because un-confirming a job hours later
  // helps nobody. What a disagreement does is flag the account, which gets a
  // person listening today rather than after the invoice is denied.
  if (ev.status === 'confirmed') {
    if (ev.verdict_source === 'ai_quoted' && ev.ai_quote) {
      var check = brain.verifyQuote(ev.ai_quote, transcript);
      if (!check.ok && transcript && profile && !ev.is_test) {
        await flagProfile(profile.id, 'A confirmed call on ' + new Date().toISOString().slice(0, 10) +
          ' quoted wording the full recording does not contain. The check-in stands, but listen to it.');
      }
    }
    return true;
  }

  if (verdict.matched) return confirm(id, verdict.phrase, auth, { verdict_source: 'phrase' });

  var why = verdict.reason === 'no_phrases_configured'
    ? 'This account has no confirmation phrase configured, so Nova cannot tell whether the call worked.'
    : 'The call ran to the end but Nova never heard the confirmation phrase.';
  // Say what the tree said instead, in terms of the next thing to change. A
  // failure reason that is identical on every failure teaches nobody anything.
  var hint = ivr.diagnose(transcript);
  if (hint) why += ' ' + hint;
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

async function confirm(id, phrase, auth, opts) {
  opts = opts || {};
  var ev = await loadEvent(id);
  if (!ev) return;
  var at = new Date();
  await pool.query(
    "UPDATE checkin_events SET status = 'confirmed', confirmed_at = $2, confirmation_text = $3, " +
    'auth_number = COALESCE($4, auth_number), failure_reason = NULL, ' +
    'verdict_source = COALESCE($5, verdict_source), ai_quote = COALESCE($6, ai_quote), ' +
    'updated_at = NOW() WHERE id = $1',
    [id, at, phrase || null, auth || null, opts.verdict_source || 'phrase', opts.ai_quote || null]
  );
  if (!ev.is_test) await stampJob(ev, at, auth);
  if (ev.mode === 'ai') { try { await noteAiSuccess(ev); } catch (e) { console.error('[checkin] promotion streak: ' + e.message); } }
  return true;
}

// ---- learn once, then stop paying -----------------------------------------
//
// An AI-navigated call costs roughly eight times a scripted one, and most trees
// do not vary. The problem is only that nobody knows the shape of a tree until
// they have been through it - so the model learns it, and then hands it over.
//
// Three consecutive successes whose keypress sequences are IDENTICAL is the
// signal that the tree is stable. Nothing happens automatically: it puts a
// "Save this as the script" offer on the profile screen, and a person decides.
// Waits and listens are deliberately excluded from the signature, because their
// lengths vary with how fast the tree talks and none of that is the tree.
async function noteAiSuccess(ev) {
  var sig = brain.actionSignature(Array.isArray(ev.turns) ? ev.turns : []);
  if (!sig || !ev.profile_id || ev.is_test) return;
  var { rows } = await pool.query('SELECT ai_streak, ai_streak_signature FROM ivr_profiles WHERE id = $1', [ev.profile_id]);
  if (!rows.length) return;
  var same = rows[0].ai_streak_signature === sig;
  await pool.query(
    'UPDATE ivr_profiles SET ai_streak = $2, ai_streak_signature = $3, updated_at = NOW() WHERE id = $1',
    [ev.profile_id, same ? (rows[0].ai_streak || 0) + 1 : 1, sig]
  );
}

// The turns of the most recent clean AI call, turned into the step list the
// scripted path already understands. The confirmed wording becomes the phrase
// to expect, so the cheap lane can judge the call without a model at all.
function stepsFromTurns(turns) {
  var steps = [];
  (turns || []).forEach(function (t) {
    if (!t || !t.action) return;
    if (t.action === 'wait') steps.push({ type: 'wait', seconds: t.seconds || 3 });
    else if (t.action === 'press') steps.push({ type: 'press', digits: t.digits, label: t.reason || '' });
    else if (t.action === 'send') steps.push({ type: 'send', field: t.field, suffix: t.suffix || '' });
  });
  if (steps.length) steps.push({ type: 'listen', seconds: 25 });
  return steps;
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

  // ai_fallback: the cheap script just failed, so hand the same job to the model
  // before bothering the technician. This is the mode most accounts should end
  // up on - the script runs the tree it knows, and the model is what happens on
  // the day the tree changes.
  //
  // Only ONE handover, only after a call that actually ran, and never on a
  // hard-stop failure: a number that reaches a person will reach a person again,
  // and a model is not going to talk its way past that.
  if (!opts.quiet && !opts.noFallback && !ev.is_test && ev.mode === 'script' && ev.call_sid &&
      (ev.attempt || 1) < MAX_ATTEMPTS) {
    var prof = await loadProfile(ev.profile_id);
    if (prof && String(prof.mode || '').toLowerCase() === 'ai_fallback' && !prof.needs_review) {
      try {
        await pool.query("UPDATE checkin_events SET failure_reason = failure_reason || ' Handing this one to the AI navigator.' WHERE id = $1", [id]);
        await startCall({
          workOrderId: ev.work_order_id, direction: ev.direction, signoffId: ev.signoff_id,
          user: ev.requested_by ? { id: ev.requested_by } : null,
          profile: prof, forceMode: 'ai', attempt: (ev.attempt || 1) + 1,
          answers: ev.answers || {}
        });
        return;   // the technician hears about it only if the retry fails too
      } catch (e) {
        console.error('[checkin] ai_fallback retry: ' + e.message);
      }
    }
  }

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
  callContext: callContext,
  prepare: prepare,
  accountPin: accountPin,
  encryptPin: encryptPin,
  loadSignoff: loadSignoff,
  writeAnswersThrough: writeAnswersThrough,
  modeOf: modeOf,
  maxTurnsFor: maxTurnsFor,
  aiOpen: aiOpen,
  aiTurn: aiTurn,
  noteAiSuccess: noteAiSuccess,
  stepsFromTurns: stepsFromTurns,
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
