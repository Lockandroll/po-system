// Swoop (Agero) review intake + low-score complaints. Built 2026-10-05 on the
// Geico pattern (jobs/geicoIngest.js + jobs/geicoComplaints.js), folded into one
// job because Swoop sends one email per job as it happens instead of a daily
// batch, so there is no reason to wait for a second poll to file.
//
// Every pass:
//   1. Pull "New Review for ID #..." emails from the mailbox over a rolling
//      window and upsert them into swoop_surveys (dedup on the Swoop job id).
//   2. File a Customer Feedback complaint (record + task for the city manager,
//      through the SAME utils/feedbackIntake path Geico and Google reviews use)
//      for every recent survey at or below swoop_complaint_max_score that has
//      not been filed yet.
//
// Who ran the job: Swoop's "Driver" is NOT always right (Tony, 2026-10-05). It
// is matched to a roster user only as a best guess (employee_source 'swoop'),
// used to pick the city, and shown as unverified. The complaint is NOT pinned on
// that person - its tech stays blank until somebody verifies the job on the
// Swoop Surveys page (CSV upload or the per-row picker), which then fills it in.
//
// Safety rails:
//   * customer_feedback has UNIQUE(source, external_ref) and external_ref is the
//     Swoop job id, so nothing can double-file.
//   * Only rows with complaint_filed_at IS NULL are considered, and the stamp is
//     written after filing, so a complaint somebody deleted is not re-opened.
//   * Only surveys received in the last LOOKBACK days auto-file, so raising the
//     threshold later does not dump months of history on the managers at once.
//     Older ones can still be filed by hand from the page.
//   * PER_RUN_CAP bounds how many complaints (and AI calls) one pass can make.

const cron = require('node-cron');
const { pool } = require('../db');
const { getMessagesBySubject } = require('../utils/graph');
const { buildEmployeeResolver } = require('../utils/rosterMatch');
const { intakeFeedback, logActivity } = require('../utils/feedbackIntake');
const SW = require('../utils/swoopSurvey');

const SOURCE = 'swoop_survey';
const POLL_CRON = process.env.SWOOP_SURVEYS_CRON || '*/20 * * * *';
// Swoop emails arrive one at a time, so a short rolling window re-reads very
// little. Three days covers a weekend outage of the mailbox or the app.
const WINDOW_DAYS = 3;
const DEFAULT_LOOKBACK_DAYS = 7;
const PER_RUN_CAP = 25;
const IDLE_LOG_MS = 60 * 60 * 1000;
let lastIdleLog = 0;
let running = false;

function defaultMailbox(opt) {
  // Swoop review emails are addressed to Tony, not to the Geico survey inbox, so
  // GEICO_MAILBOX is deliberately NOT a fallback here.
  return (opt && opt.mailbox) || process.env.SWOOP_MAILBOX || 'tony@popalockar.com';
}

// The city for a credited user = their home city (the same field the Schedule
// roster uses). null when the user has none.
async function homeCityOf(userId) {
  if (!userId) return null;
  try {
    var r = await pool.query('SELECT home_city FROM users WHERE id = $1', [userId]);
    return (r.rows.length && r.rows[0].home_city) ? String(r.rows[0].home_city).trim() || null : null;
  } catch (e) { return null; }
}

// Upsert parsed emails. Exported separately from the Graph fetch so tests (and a
// future manual paste) can feed it messages directly.
async function upsertMessages(messages) {
  var resolver = await buildEmployeeResolver();
  var upserted = 0, inserted = 0, skipped = 0, matched = 0;
  for (var i = 0; i < messages.length; i++) {
    var r = SW.parseSwoopEmail(messages[i]);
    if (!r.jobId) { skipped++; continue; }
    var hit = SW.resolveDriver(resolver, r.driver);
    var city = hit.user_id ? await homeCityOf(hit.user_id) : null;
    if (hit.user_id) matched++;
    // On a re-read the email fields are refreshed, but who-gets-credit and the
    // city are only filled when still empty - a verification (import/manual)
    // must never be undone by the next poll.
    var q = await pool.query(
      'INSERT INTO swoop_surveys (job_id, score, feedback, account, driver_raw, pickup_contact, pickup_phone, ' +
      '  city_code, city_source, date_received, received_at, internet_message_id, ' +
      '  employee_name, employee_user_id, employee_source) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ' +
      'ON CONFLICT (job_id) DO UPDATE SET ' +
      '  score = EXCLUDED.score, feedback = EXCLUDED.feedback, account = EXCLUDED.account, ' +
      '  driver_raw = EXCLUDED.driver_raw, pickup_contact = EXCLUDED.pickup_contact, ' +
      '  pickup_phone = EXCLUDED.pickup_phone, date_received = EXCLUDED.date_received, ' +
      '  received_at = EXCLUDED.received_at, internet_message_id = EXCLUDED.internet_message_id, ' +
      '  city_code = COALESCE(swoop_surveys.city_code, EXCLUDED.city_code), ' +
      '  city_source = CASE WHEN swoop_surveys.city_code IS NULL THEN EXCLUDED.city_source ELSE swoop_surveys.city_source END, ' +
      '  employee_name = CASE WHEN swoop_surveys.employee_source IS NULL THEN EXCLUDED.employee_name ELSE swoop_surveys.employee_name END, ' +
      '  employee_user_id = CASE WHEN swoop_surveys.employee_source IS NULL THEN EXCLUDED.employee_user_id ELSE swoop_surveys.employee_user_id END, ' +
      '  employee_source = COALESCE(swoop_surveys.employee_source, EXCLUDED.employee_source), ' +
      '  updated_at = NOW() ' +
      'RETURNING (xmax = 0) AS inserted',
      [
        r.jobId, r.score, r.feedback || null, r.account || null, r.driver || null,
        r.pickupContact || null, r.pickupPhone || null,
        city, city ? 'driver' : null, r.dateReceived, r.receivedAt, r.internetMessageId || null,
        hit.user_id ? hit.name : null, hit.user_id || null, hit.user_id ? 'swoop' : null
      ]
    );
    upserted++;
    if (q.rows[0] && q.rows[0].inserted) inserted++;
  }
  return { upserted: upserted, inserted: inserted, skipped: skipped, matched: matched };
}

// Fetch + upsert a UTC window [startIso, endIso).
async function ingestRange(options) {
  options = options || {};
  var mailbox = defaultMailbox(options);
  var messages = await getMessagesBySubject(mailbox, SW.SUBJECT_PREFIX, options.startIso, options.endIso);
  var res = await upsertMessages(messages);
  res.mailbox = mailbox;
  res.fetched = messages.length;
  return res;
}

// The columns fileComplaintForSurvey reads.
const SURVEY_COLUMNS =
  "SELECT s.id, s.job_id, s.score, s.feedback, s.account, s.driver_raw, s.pickup_contact, s.pickup_phone, " +
  "       s.city_code, COALESCE(c.name,'') AS city_name, s.received_at, " +
  "       to_char(s.date_received,'YYYY-MM-DD') AS date_received, " +
  "       s.employee_name, s.employee_user_id, s.employee_source, s.complaint_filed_at, s.created_at " +
  "FROM swoop_surveys s LEFT JOIN cities c ON c.code = s.city_code ";

function verified(src) { return src === 'import' || src === 'manual'; }

// Turn one swoop_surveys row into the shape utils/feedbackIntake expects and
// file it. Exported for the page's manual File button.
async function fileComplaintForSurvey(survey) {
  if (!survey) return { skipped: true, reason: 'no survey' };
  var job = String(survey.job_id == null ? '' : survey.job_id).trim();
  if (!job) return { skipped: true, reason: 'no job id' };

  var bands = await SW.npsBands();
  var nps = SW.npsFor(survey.score, bands);
  var scoreTxt = (survey.score == null) ? 'no score' : (survey.score + '/10');
  var isVerified = verified(survey.employee_source);

  var lines = [];
  lines.push('Swoop (Agero) review scored ' + scoreTxt + (nps == null ? '' : ' (NPS ' + nps + ')') +
    (survey.city_name ? ' for ' + survey.city_name : '') + '.');
  lines.push('Swoop job ID ' + job + (survey.date_received ? ', received ' + survey.date_received : '') + '.');
  if (survey.feedback && String(survey.feedback).trim()) {
    lines.push('Customer wrote: "' + String(survey.feedback).trim() + '"');
  } else {
    lines.push('The customer left no written comment.');
  }
  if (isVerified) {
    lines.push('Technician (verified): ' + (survey.employee_name || 'unknown') + '.');
  } else {
    lines.push('Swoop lists the driver as "' + (survey.driver_raw || 'nobody') + '". Swoop' + "'" + 's driver is not always ' +
      'the person who ran the job, so this is NOT verified. Identify the technician from the job ID, then credit them ' +
      'on the Swoop Surveys page (or upload the verification CSV) and it will be filled in here.');
  }

  var parsed = {
    customer_name: survey.pickup_contact || 'Swoop customer',
    customer_phone: survey.pickup_phone || null,
    customer_email: null,
    vehicle_make: null, vehicle_model: null, vehicle_year: null,
    service_task: null,
    job_location: survey.city_name || null,
    location_raw: survey.city_name || null,
    city_code: survey.city_code || null,
    // Only a VERIFIED person is put on the complaint. A Swoop guess is not.
    tech_name_raw: isVerified ? (survey.employee_name || null) : null,
    tech_user_id: isVerified ? (survey.employee_user_id || null) : null,
    incident_text: lines.join('\n'),
    invoice_ref: job,
    received_at: survey.received_at || survey.created_at || null,
    conduct_type: 'Swoop review ' + scoreTxt,
    category_hint: 'complaint'
  };

  var meta = {
    source: SOURCE,
    external_ref: job,
    raw_subject: 'Swoop review ' + scoreTxt + ' - job ' + job,
    raw_email: [
      'Swoop Job ID: ' + job,
      'NPS Score (survey answer 0-10): ' + (survey.score == null ? '-' : survey.score),
      'NPS value: ' + (nps == null ? '-' : nps),
      'Feedback: ' + (survey.feedback || '-'),
      'Account: ' + (survey.account || '-'),
      'Driver (as sent by Swoop): ' + (survey.driver_raw || '-'),
      'Pickup Contact: ' + (survey.pickup_contact || '-'),
      'Pickup Number: ' + (survey.pickup_phone || '-'),
      'City: ' + (survey.city_name || survey.city_code || '-'),
      'Date Received: ' + (survey.date_received || '-')
    ].join('\n')
  };

  var result = await intakeFeedback(parsed, meta);

  if (result && result.id) {
    try { await pool.query('UPDATE swoop_surveys SET complaint_filed_at = COALESCE(complaint_filed_at, NOW()) WHERE id = $1', [survey.id]); }
    catch (e) { console.error('[swoop] stamp complaint_filed_at:', e.message); }
    if (!result.duplicate && !survey.city_code) {
      await logActivity(result.id, null, 'event',
        'Swoop does not send a city, and the listed driver "' + (survey.driver_raw || 'unknown') + '" did not match anyone ' +
        'on the roster with a home city, so this went to the admins. Reassign it to the right city manager.', null);
    }
  }
  return result;
}

async function lookbackDays() {
  var raw = await SW.getSetting('swoop_complaint_lookback_days');
  var s = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(s)) return DEFAULT_LOOKBACK_DAYS;
  var n = parseInt(s, 10);
  return (n < 1 || n > 90) ? DEFAULT_LOOKBACK_DAYS : n;
}

// File every recent, unfiled survey at or below the complaint threshold.
async function fileDueComplaints() {
  var max = await SW.complaintMaxScore();
  var days = await lookbackDays();
  var q = await pool.query(
    SURVEY_COLUMNS +
    'WHERE s.score IS NOT NULL AND s.score <= $1 AND s.complaint_filed_at IS NULL ' +
    "  AND COALESCE(s.received_at, s.created_at) >= NOW() - ($2 || ' days')::interval " +
    'ORDER BY s.id ASC LIMIT ' + PER_RUN_CAP,
    [max, String(days)]
  );
  var filed = 0, dupes = 0, failed = 0;
  for (var i = 0; i < q.rows.length; i++) {
    var r = q.rows[i];
    try {
      var res = await fileComplaintForSurvey(r);
      if (res && res.duplicate) dupes++;
      else if (res && res.id) {
        filed++;
        console.log('[swoop] Filed complaint #' + res.id + ' for a ' + r.score + '/10 review on job ' + r.job_id +
          ' (' + (r.city_name || 'no city') + ').');
      } else failed++;
    } catch (e) {
      failed++;
      // Not stamped, so the next pass retries it. intakeFeedback's own dedupe
      // keeps a half-finished earlier attempt from becoming a second record.
      console.error('[swoop] Failed to file job ' + r.job_id + ':', e.message);
    }
  }
  return { considered: q.rows.length, filed: filed, duplicates: dupes, failed: failed, maxScore: max };
}

// One-time-in-effect repair (2026-10-07). Before the parser knew Swoop's
// "Customer Contact" / "Customer Number" labels, those values were stored inside
// driver_raw and the complaint went out as "Swoop customer" with no phone. This
// splits them back out, re-tries the driver match on the clean name, and fills
// the customer name/phone on complaints still carrying the placeholder. It is
// idempotent: once a row is split its driver_raw no longer contains the label, so
// later passes find nothing. Safe to leave running every pass.
async function repairLegacyCustomerFields() {
  var q;
  try {
    q = await pool.query("SELECT id, job_id, driver_raw, pickup_contact, pickup_phone, city_code, employee_source " +
      "FROM swoop_surveys WHERE driver_raw ~* 'Customer[[:space:]]+(Contact|Number|Name|Phone)[[:space:]]*:' LIMIT 500");
  } catch (e) { console.error('[swoop] repair scan failed:', e.message); return 0; }
  if (!q.rows.length) return 0;
  var resolver = await buildEmployeeResolver();
  var fixed = 0;
  for (var i = 0; i < q.rows.length; i++) {
    var row = q.rows[i];
    var sp = SW.splitLegacyDriver(row.driver_raw);
    if (!sp) continue;
    try {
      var hit = (!row.employee_source && sp.driver) ? SW.resolveDriver(resolver, sp.driver) : { user_id: null };
      var city = (hit.user_id && !row.city_code) ? await homeCityOf(hit.user_id) : null;
      await pool.query(
        'UPDATE swoop_surveys SET driver_raw = $2, ' +
        '  pickup_contact = COALESCE(NULLIF(pickup_contact, \'\'), $3), ' +
        '  pickup_phone = COALESCE(NULLIF(pickup_phone, \'\'), $4), ' +
        '  employee_name = CASE WHEN employee_source IS NULL AND $5::int IS NOT NULL THEN $6 ELSE employee_name END, ' +
        '  employee_user_id = CASE WHEN employee_source IS NULL AND $5::int IS NOT NULL THEN $5::int ELSE employee_user_id END, ' +
        "  employee_source = CASE WHEN employee_source IS NULL AND $5::int IS NOT NULL THEN 'swoop' ELSE employee_source END, " +
        '  city_code = COALESCE(city_code, $7), ' +
        "  city_source = CASE WHEN city_code IS NULL AND $7::text IS NOT NULL THEN 'driver' ELSE city_source END, " +
        '  updated_at = NOW() WHERE id = $1',
        [row.id, sp.driver || null, sp.contact || null, sp.phone || null,
         hit.user_id || null, hit.user_id ? hit.name : null, city]
      );
      // The complaint: fill the placeholder name / empty phone, and tidy the
      // driver sentence in the write-up so it shows the driver alone.
      await pool.query(
        "UPDATE customer_feedback SET " +
        "  customer_name = CASE WHEN customer_name IS NULL OR customer_name = 'Swoop customer' THEN COALESCE($3, customer_name) ELSE customer_name END, " +
        "  customer_phone = COALESCE(NULLIF(customer_phone, ''), $4), " +
        "  incident_text = REPLACE(incident_text, $5, $6), " +
        "  updated_at = NOW() " +
        "WHERE source = $1 AND external_ref = $2",
        [SOURCE, String(row.job_id), sp.contact || null, sp.phone || null,
         '"' + row.driver_raw + '"', '"' + (sp.driver || 'nobody') + '"']
      );
      fixed++;
    } catch (e) {
      console.error('[swoop] repair job ' + row.job_id + ' failed:', e.message);
    }
  }
  if (fixed) console.log('[swoop] Repaired customer name/phone on ' + fixed + ' survey(s) stored before the label fix.');
  return fixed;
}

async function runPass(options) {
  options = options || {};
  try { await repairLegacyCustomerFields(); } catch (e) { console.error('[swoop] repair failed:', e.message); }
  var end = new Date();
  var start = new Date(end.getTime() - WINDOW_DAYS * 86400000);
  var ingest = null;
  try {
    ingest = await ingestRange({ startIso: start.toISOString(), endIso: end.toISOString(), mailbox: options.mailbox });
  } catch (e) {
    // Still file from what is already stored - a Graph outage should not also
    // stall complaints for surveys we already have.
    console.error('[swoop] Mailbox read failed:', e.message);
  }
  var filing = await fileDueComplaints();
  var quiet = (!ingest || !ingest.inserted) && !filing.filed && !filing.failed;
  if (!quiet || Date.now() - lastIdleLog > IDLE_LOG_MS) {
    lastIdleLog = Date.now();
    console.log('[swoop] Pass: ' + (ingest ? (ingest.fetched + ' email(s), ' + ingest.inserted + ' new') : 'mailbox unavailable') +
      '; complaints ' + filing.filed + ' filed, ' + filing.duplicates + ' already on file, ' + filing.failed + ' failed.');
  }
  return { ingest: ingest, filing: filing };
}

// One pass at a time, whether it came from the schedule or the page's "Check
// mail now" button. Returns null when a pass is already running.
async function runPassOnce(options) {
  if (running) return null;
  running = true;
  try { return await runPass(options); }
  finally { running = false; }
}

function startSwoopSurveys() {
  cron.schedule(POLL_CRON, function () {
    if (running) { console.log('[swoop] Previous pass still running - skipping this tick.'); return; }
    runPassOnce().catch(function (e) { console.error('[swoop] Pass failed:', e.message); });
  }, { timezone: 'America/New_York' });
  console.log('[swoop] Swoop review intake scheduled (' + POLL_CRON + ')');
}

module.exports = {
  startSwoopSurveys: startSwoopSurveys,
  runPass: runPass,
  runPassOnce: runPassOnce,
  ingestRange: ingestRange,
  upsertMessages: upsertMessages,
  fileComplaintForSurvey: fileComplaintForSurvey,
  fileDueComplaints: fileDueComplaints,
  repairLegacyCustomerFields: repairLegacyCustomerFields,
  homeCityOf: homeCityOf,
  SURVEY_COLUMNS: SURVEY_COLUMNS,
  SOURCE: SOURCE
};
