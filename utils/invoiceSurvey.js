// The customer feedback survey on the invoice page (Tony, 2026-10-11).
// Plan: claude/nova-customer-follow-up-plan.md. Called by routes/invoiceLink.js.
//
// Four questions plus a comment and "Can a manager contact you?". Every answer
// lands in Customer Feedback, tied to the invoice, the locksmith and the city:
//   - FLAGGED (overall Poor or Okay, or any "No"), or the customer asked for a
//     call: filed through utils/feedbackIntake.js exactly like a low-star Google
//     review, which gives the city manager a task and the admins their FYI. A
//     call request also dates that task for the next business day.
//   - Otherwise: a quiet 'praise' row, already resolved, no task, no alerts. It
//     is a record of a happy customer, not work for anybody.
// One survey per invoice (invoice_surveys.invoice_id is UNIQUE).

const { pool } = require('../db');
const { intakeFeedback, logActivity } = require('./feedbackIntake');

var OVERALL = { 1: 'Poor', 2: 'Okay', 3: 'Good', 4: 'Great', 5: 'Excellent' };
var YN = ['yes', 'no', 'unsure'];
var YN_LABEL = { yes: 'Yes', no: 'No', unsure: 'Not sure' };
var QUESTIONS = [
  { key: 'arrived', col: 'arrived', label: 'Did the locksmith arrive when we said?' },
  { key: 'price_explained', col: 'price_explained', label: 'Was the price explained before work started?' },
  { key: 'professional', col: 'professional', label: 'Was the locksmith professional and courteous?' }
];

function yn(v) { v = String(v == null ? '' : v).toLowerCase(); return YN.indexOf(v) === -1 ? null : v; }

function validate(body) {
  body = body || {};
  var overall = parseInt(body.overall, 10);
  if (!(overall >= 1 && overall <= 5)) return { error: 'Please pick how your overall experience was.' };
  var out = {
    overall: overall,
    arrived: yn(body.arrived),
    price_explained: yn(body.price_explained),
    professional: yn(body.professional),
    comment: String(body.comment || '').trim().slice(0, 2000),
    call_me: body.call_me === true || body.call_me === 'true' || body.call_me === 'yes'
  };
  out.flagged = overall <= 2 || out.arrived === 'no' || out.price_explained === 'no' || out.professional === 'no';
  return out;
}

function nextBusinessDay(from) {
  var d = new Date(from || Date.now());
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function summaryText(inv, a) {
  var lines = [];
  lines.push('Invoice survey for invoice #' + (inv.invoice_number || inv.id) + (inv.locksmith_name ? ' (locksmith ' + inv.locksmith_name + ')' : '') + '.');
  lines.push('');
  lines.push('Overall: ' + OVERALL[a.overall]);
  QUESTIONS.forEach(function (q) { lines.push(q.label + ' ' + (a[q.key] ? YN_LABEL[a[q.key]] : 'No answer')); });
  lines.push('Wants a manager to call: ' + (a.call_me ? 'Yes' : 'No'));
  if (a.comment) { lines.push(''); lines.push('"' + a.comment + '"'); }
  return lines.join('\n');
}

// Returns { ok, already, flagged, feedback_id } or { error }.
async function submitSurvey(inv, body, ip) {
  var a = validate(body);
  if (a.error) return { error: a.error };
  var ins = await pool.query(
    'INSERT INTO invoice_surveys (invoice_id, overall, arrived, price_explained, professional, comment, call_me, flagged, ip) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (invoice_id) DO NOTHING RETURNING id',
    [inv.id, a.overall, a.arrived, a.price_explained, a.professional, a.comment || null, a.call_me, a.flagged, ip || null]
  );
  if (!ins.rows.length) return { ok: true, already: true };
  var surveyId = ins.rows[0].id;
  var text = summaryText(inv, a);
  var feedbackId = null;

  try {
    if (a.flagged || a.call_me) {
      var parsed = {
        customer_name: inv.customer_name || 'Customer',
        customer_phone: inv.phone || null,
        customer_email: inv.email || null,
        vehicle_make: inv.vehicle_make || null,
        vehicle_model: inv.vehicle_model || null,
        vehicle_year: inv.vehicle_year || null,
        service_task: null,
        job_location: [inv.street_address, inv.city, inv.state].filter(Boolean).join(', ') || null,
        location_raw: null,
        city_code: inv.city_code || null,
        tech_name_raw: inv.locksmith_name || null,
        tech_user_id: inv.locksmith_id || null,
        incident_text: text,
        invoice_ref: String(inv.invoice_number || inv.id),
        category_hint: a.flagged ? 'complaint' : 'other'
      };
      var meta = {
        source: 'invoice_survey',
        external_ref: 'invoice-' + inv.id,
        raw_subject: (a.flagged ? 'Invoice survey needs follow-up' : 'Invoice survey: call requested') + ' - #' + (inv.invoice_number || inv.id),
        raw_email: text
      };
      var r = await intakeFeedback(parsed, meta);
      feedbackId = r && r.id ? r.id : null;
      if (feedbackId && a.call_me && r.task && r.task.id) {
        try {
          await pool.query("UPDATE tasks SET due_date = $1, title = 'Call back: ' || title WHERE id = $2", [nextBusinessDay(), r.task.id]);
          await logActivity(feedbackId, null, 'event', 'Customer asked a manager to call. Call-back task due ' + nextBusinessDay() + '.', 'invoice_survey');
        } catch (e) { console.error('[survey] call-back date:', e.message); }
      }
    } else {
      var q = await pool.query(
        'INSERT INTO customer_feedback (source, external_ref, customer_name, customer_phone, customer_email, vehicle_make, vehicle_model, vehicle_year, ' +
        'city_code, tech_name_raw, tech_user_id, incident_text, invoice_ref, category, sentiment, ai_summary, status, is_resolved, resolved_at, resolved_notes, raw_subject) ' +
        "VALUES ('invoice_survey',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'praise','positive',$13,'resolved',true,NOW(),$14,$15) RETURNING id",
        ['invoice-' + inv.id, inv.customer_name || 'Customer', inv.phone || null, inv.email || null, inv.vehicle_make || null, inv.vehicle_model || null,
         inv.vehicle_year || null, inv.city_code || null, inv.locksmith_name || null, inv.locksmith_id || null, text,
         String(inv.invoice_number || inv.id), 'Positive invoice survey: ' + OVERALL[a.overall] + '.',
         'Positive survey, no follow-up needed.', 'Invoice survey - #' + (inv.invoice_number || inv.id)]
      );
      feedbackId = q.rows[0].id;
      await logActivity(feedbackId, null, 'event', 'Created from an invoice survey (positive, filed as resolved).', 'invoice_survey');
    }
  } catch (e) {
    console.error('[survey] feedback filing failed:', e);
  }
  if (feedbackId) {
    try { await pool.query('UPDATE invoice_surveys SET feedback_id = $1 WHERE id = $2', [feedbackId, surveyId]); } catch (e) {}
  }
  return { ok: true, flagged: a.flagged, feedback_id: feedbackId };
}

module.exports = { submitSurvey: submitSurvey, validate: validate, OVERALL: OVERALL, QUESTIONS: QUESTIONS, nextBusinessDay: nextBusinessDay };
