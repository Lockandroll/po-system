// Poor Geico ERS survey ratings -> Customer Feedback complaints.
//
// The surveys themselves are ingested from the Geico mailbox by
// jobs/geicoIngest.js into Nova's own geico_surveys table. This job polls that
// table for newly ingested surveys whose "Rating of Technician" is at the bad
// end of the scale and files each one through the SAME intake path the Pulsar
// emails and the low-star Google reviews use, so a bad survey lands in the
// existing complaint process tree: the city primary manager gets the record +
// a task, AI classifies category/severity, high/critical escalates, and the
// close-out gate applies unchanged.
//
// Deliberately NOT copied from the Google review flow:
//   * No tech resolution. A Geico survey only carries an employee name when
//     somebody hand-imports the Employee CSV afterwards, and Tony's call was to
//     file straight to the city rather than wait for that. The city is already
//     resolved at ingest (vendors.account_number -> vendors.city_code), so the
//     record goes to the right manager on day one; whoever works it names the
//     tech. An imported employee_name is still passed through if it happens to
//     be there, but nothing waits for it.
//
// Safety rails:
//   * A watermark in settings (geico_complaints_watermark) means we only ever
//     act on surveys ingested AFTER this job first ran. The first run baselines
//     over a lookback window instead of replaying years of history.
//   * customer_feedback has a UNIQUE(source, external_ref) index and
//     external_ref is Geico's PO number, so a re-run can never double-file.
//   * PER_RUN_CAP bounds how many complaints one pass can open.
const cron = require('node-cron');
const { pool } = require('../db');
const { intakeFeedback, logActivity } = require('../utils/feedbackIntake');

const SOURCE = 'geico_survey';
const WATERMARK_KEY = 'geico_complaints_watermark';
const RATINGS_KEY = 'geico_complaint_ratings';
const SEEDED_FROM_KEY = 'geico_complaints_seeded_from';
// Row id this job first baselined at. Everything at or below it predates the
// feature and must stay untouched forever - see the re-ingest sweep below.
const BASELINE_KEY = 'geico_complaints_baseline_id';
// When the last pass ran, used only by the re-ingest sweep.
const SWEPT_KEY = 'geico_complaints_swept_at';

// Which rating buckets open a complaint. Tony's setting: Poor and Fair.
const DEFAULT_RATINGS = ['poor', 'fair'];
// 'excellent' is deliberately NOT selectable - an excellent survey is never a
// complaint, and allowing it would quietly file every happy customer.
const ALLOWED_RATINGS = ['poor', 'fair', 'good', 'unknown'];

// How far back the FIRST run reaches. The mailbox ingest runs once a day, so 48
// hours covers the two most recent ingests without replaying history.
const DEFAULT_LOOKBACK_HOURS = 48;
// Surveys arrive in one daily batch (jobs/geicoIngest.js, 19:30 UTC), so there
// is nothing to gain from a tight poll - a quarter hour of added delay on a
// survey that is already a day old is noise.
const POLL_CRON = process.env.GEICO_COMPLAINTS_CRON || '*/15 * * * *';
// Idle passes say WHY there was nothing to do, but only once an hour, so the
// line that matters (something actually filed) is not buried.
const IDLE_LOG_MS = 60 * 60 * 1000;
let lastIdleLog = 0;
const PER_RUN_CAP = 25;

// A pass that files 25 complaints makes 25 AI calls and can outlive the tick.
let running = false;

async function getSetting(key) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].value : null;
  } catch (e) { return null; }
}

async function setSetting(key, value) {
  try {
    await pool.query(
      'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ' +
      'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
      [key, String(value)]
    );
  } catch (e) { console.error('[geico-complaints] setSetting ' + key + ':', e.message); }
}

// Geico's rating is free text on the survey email, so it is normalized to a
// bucket rather than compared literally. Order matters: check the words that
// can only mean one thing first.
//   ''            -> null      (no rating on the survey at all)
//   'Poor'        -> 'poor'
//   'Fair'        -> 'fair'
//   'Excellent'   -> 'excellent'
//   'Very Good'   -> 'good'
//   anything else -> 'unknown' (a wording Geico has not used before)
function ratingBucket(raw) {
  var s = (raw == null ? '' : String(raw)).trim();
  if (!s) return null;
  if (/poor|bad/i.test(s)) return 'poor';
  if (/fair/i.test(s)) return 'fair';
  if (/excellent/i.test(s)) return 'excellent';
  if (/good/i.test(s)) return 'good';
  return 'unknown';
}

// Which buckets file, from settings (comma separated), env, then the default.
// Anything outside ALLOWED_RATINGS is dropped, and an empty result falls back to
// the default rather than silently switching the feature off.
async function complaintRatings() {
  var raw = await getSetting(RATINGS_KEY);
  if (raw == null || String(raw).trim() === '') raw = process.env.GEICO_COMPLAINT_RATINGS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_RATINGS.slice();
  var picked = String(raw).split(/[,;|]+/).map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return ALLOWED_RATINGS.indexOf(s) !== -1; });
  if (!picked.length) {
    console.warn('[geico-complaints] Setting ' + RATINGS_KEY + '=' + JSON.stringify(raw) +
      ' names no usable rating (allowed: ' + ALLOWED_RATINGS.join(', ') + ') - using the default ' +
      DEFAULT_RATINGS.join(' + ') + '.');
    return DEFAULT_RATINGS.slice();
  }
  // De-duplicate without changing the caller's ordering expectations.
  var out = [];
  picked.forEach(function (p) { if (out.indexOf(p) === -1) out.push(p); });
  return out;
}

// SQL side of the same rule, so a pass reads only rows that could possibly file
// instead of paging through every survey. JS re-checks the bucket before filing,
// so this only ever needs to be a superset.
function ratingSql(buckets, alias) {
  var a = alias ? (alias + '.') : '';
  var parts = [];
  if (buckets.indexOf('poor') !== -1) parts.push('(' + a + "rating ILIKE '%poor%' OR " + a + "rating ILIKE '%bad%')");
  if (buckets.indexOf('fair') !== -1) parts.push(a + "rating ILIKE '%fair%'");
  if (buckets.indexOf('good') !== -1) parts.push(a + "rating ILIKE '%good%'");
  if (buckets.indexOf('unknown') !== -1) {
    parts.push('(' + a + "btrim(rating) <> '' AND " + a + "rating !~* '(excellent|good|fair|poor|bad)')");
  }
  if (!parts.length) return 'false';
  return '(' + a + 'rating IS NOT NULL AND (' + parts.join(' OR ') + '))';
}

function ratingWord(raw) {
  var b = ratingBucket(raw);
  if (!b) return 'Unrated';
  if (b === 'unknown') return String(raw).trim();
  return b.charAt(0).toUpperCase() + b.slice(1);
}

// Turn one geico_surveys row into the shape utils/feedbackIntake expects and
// file it. Exported so the Geico Surveys page can file an older survey on demand.
async function fileComplaintForSurvey(survey) {
  if (!survey) return { skipped: true, reason: 'no survey' };
  var po = (survey.po_number == null ? '' : String(survey.po_number)).trim();
  // po_number is the dedupe key. Without one there is nothing for
  // UNIQUE(source, external_ref) to hold onto, so we would re-file it forever.
  if (!po) return { skipped: true, reason: 'no po_number' };

  var cityCode = survey.city_code || null;
  var rating = ratingWord(survey.rating);

  var lines = [];
  lines.push(rating + ' rating on a Geico ERS survey' +
    (survey.city_name ? ' for ' + survey.city_name : '') + '.');
  var detail = [];
  detail.push('PO ' + po);
  if (survey.service) detail.push('service: ' + survey.service);
  if (survey.date_of_dispatch) detail.push('dispatched ' + survey.date_of_dispatch);
  if (survey.loss_state) detail.push('loss state ' + survey.loss_state);
  lines.push(detail.join(', ') + '.');
  if (survey.arrived_on_time || survey.time_to_arrive) {
    lines.push('Customer answered "arrived on time": ' + (survey.arrived_on_time || 'not answered') +
      '. Time until the provider arrived: ' + (survey.time_to_arrive || 'not answered') + '.');
  }
  lines.push('Geico surveys carry no written comment and no technician name, so the ' +
    'rating above is everything the customer sent. Identify the technician from the PO number ' +
    'before working this.');

  var parsed = {
    customer_name: 'Geico ERS customer',
    customer_phone: null,
    customer_email: null,
    vehicle_make: null,
    vehicle_model: null,
    vehicle_year: null,
    service_task: survey.service || null,
    job_location: survey.city_name || null,
    location_raw: survey.city_name || null,
    city_code: cityCode,
    // Only present when somebody imported the Employee CSV. Never waited on.
    tech_name_raw: survey.employee_name || null,
    tech_user_id: null,
    incident_text: lines.join('\n'),
    invoice_ref: po,
    received_at: survey.date_received || survey.created_at || null,
    conduct_type: rating + ' Geico ERS survey rating',
    category_hint: 'complaint'
  };

  var meta = {
    source: SOURCE,
    external_ref: po,
    raw_subject: rating + ' Geico ERS survey - PO ' + po,
    raw_email: [
      'PO Number: ' + po,
      'Account Number: ' + (survey.account_number || '-'),
      'City: ' + (survey.city_name || survey.city_code || '-'),
      'Service: ' + (survey.service || '-'),
      'Loss State: ' + (survey.loss_state || '-'),
      'Date of Dispatch: ' + (survey.date_of_dispatch || '-'),
      'Provider Arrived On Time: ' + (survey.arrived_on_time || '-'),
      'How Long Till Provider Arrived: ' + (survey.time_to_arrive || '-'),
      'Rating of Technician: ' + (survey.rating || '-'),
      'Date Received: ' + (survey.date_received || '-'),
      'Employee (imported): ' + (survey.employee_name || '-')
    ].join('\n')
  };

  var result = await intakeFeedback(parsed, meta);

  // Leave a breadcrumb when the account could not be matched to a city, so the
  // admin who picks this up knows WHY it landed with them and how to fix it.
  if (result && result.id && !result.duplicate && !cityCode) {
    try {
      await logActivity(result.id, null, 'event',
        'Geico account "' + (survey.account_number || 'unknown') + '" is not mapped to a Nova city, so this went to the admins. ' +
        'Set the City on that account under Accounts and future surveys will route themselves.', null);
    } catch (e) {}
  }
  return result;
}

// The columns fileComplaintForSurvey reads, normalized the same way everywhere.
const SURVEY_COLUMNS =
  "SELECT g.id, g.po_number, g.account_number, g.city_code, COALESCE(c.name,'') AS city_name, " +
  "       g.service, g.loss_state, to_char(g.date_of_dispatch,'MM/DD/YYYY') AS date_of_dispatch, " +
  "       g.arrived_on_time, g.time_to_arrive, g.rating, " +
  "       to_char(g.date_received,'YYYY-MM-DD') AS date_received, g.employee_name, g.created_at " +
  "FROM geico_surveys g LEFT JOIN cities c ON c.code = g.city_code ";

// Highest row id OLDER than the lookback window. Everything after it is "recent"
// and worth filing even on a first run.
async function baselineId() {
  var hours = parseInt(process.env.GEICO_COMPLAINTS_LOOKBACK_HOURS, 10);
  if (isNaN(hours) || hours < 0) hours = DEFAULT_LOOKBACK_HOURS;
  var q = await pool.query(
    "SELECT COALESCE(MAX(id), 0)::int AS id FROM geico_surveys WHERE created_at < NOW() - ($1 || ' hours')::interval",
    [String(hours)]
  );
  return { id: q.rows[0].id, hours: hours };
}

// Read the cursor, seeding it when there isn't a usable one. Returns the row id
// to read past, or null when the caller should stop.
//
// GEICO_COMPLAINTS_SINCE is honoured whenever its value CHANGES, not only on a
// virgin install - that is the supported way to rewind and pick up surveys that
// were missed, without editing the database by hand.
async function readWatermark() {
  var raw = await getSetting(WATERMARK_KEY);
  // Must be a PURE integer. parseInt would read '2026-07-01T00:00:00Z' as 2026
  // and freeze the cursor at row 2026 until the table's ids passed it.
  var haveCursor = (raw != null && /^\d+$/.test(String(raw).trim()));
  var cursor = haveCursor ? parseInt(raw, 10) : null;
  if (raw != null && !haveCursor && String(raw).trim() !== '') {
    console.warn('[geico-complaints] Watermark ' + JSON.stringify(raw) + ' is not a row id - re-baselining.');
  }

  var seed = process.env.GEICO_COMPLAINTS_SINCE || null;
  try {
    if (seed) {
      var appliedSeed = await getSetting(SEEDED_FROM_KEY);
      if (appliedSeed !== seed) {
        var s = await pool.query(
          'SELECT COALESCE(MAX(id), 0)::int AS id FROM geico_surveys WHERE created_at < $1::timestamptz',
          [seed]
        );
        var seedId = s.rows[0].id;
        await setSetting(WATERMARK_KEY, seedId);
        await setSetting(SEEDED_FROM_KEY, seed);
        await rememberBaseline(seedId);
        console.log('[geico-complaints] GEICO_COMPLAINTS_SINCE=' + seed + ' applied - cursor moved to row ' +
          seedId + '. Surveys ingested after that date will file on this pass.');
        return seedId;
      }
    }

    if (haveCursor) {
      // If the table's highest id is BELOW our cursor the table was rebuilt and
      // the cursor points at nothing. Re-baseline rather than going silent.
      var top = await pool.query('SELECT COALESCE(MAX(id), 0)::int AS id FROM geico_surveys');
      if (top.rows[0].id < cursor) {
        var reset = await baselineId();
        await setSetting(WATERMARK_KEY, reset.id);
        await rememberBaseline(reset.id, true);
        console.warn('[geico-complaints] Cursor ' + cursor + ' is past the geico_surveys high-water mark ' +
          top.rows[0].id + ' - the table was rebuilt. Re-baselined to row ' + reset.id + '.');
        return reset.id;
      }
      await rememberBaseline(cursor);
      return cursor;
    }

    var base = await baselineId();
    await setSetting(WATERMARK_KEY, base.id);
    await rememberBaseline(base.id);
    console.log('[geico-complaints] First run - cursor set at row ' + base.id + ' (everything ingested in the ' +
      'last ' + base.hours + 'h will file on this pass; older history was skipped).');
    return base.id;
  } catch (e) {
    console.error('[geico-complaints] Could not seed the cursor:', e.message);
    return null;
  }
}

// The floor the re-ingest sweep is allowed to reach back to. Written once, on
// the first pass that establishes a cursor, and then left alone - lowering it
// later would let the sweep file history this job was never meant to see.
async function rememberBaseline(id, force) {
  var have = await getSetting(BASELINE_KEY);
  if (!force && have != null && /^\d+$/.test(String(have).trim())) return parseInt(have, 10);
  await setSetting(BASELINE_KEY, id);
  return id;
}

async function readBaseline() {
  var raw = await getSetting(BASELINE_KEY);
  if (raw != null && /^\d+$/.test(String(raw).trim())) return parseInt(raw, 10);
  return null;
}

// Surveys that were ALREADY past the cursor but have since been re-ingested with
// a different rating. jobs/geicoIngest.js re-upserts a rolling 10-day window
// every day, so a survey Geico re-sends (or that was first stored unrated) can
// turn bad after this job has walked past it, and the id cursor would never look
// at it again.
//
// Bounded on both sides on purpose:
//   * id > baseline   - never reaches into the history the first run skipped.
//                       Without this, the daily upsert touching a 10-day window
//                       would drag every old Poor survey in on the next pass.
//   * updated_at > swept_at - only rows the ingest has actually written since
//                       the last pass.
async function sweepRows(buckets, sweptAt, baseline, cursor) {
  if (!sweptAt || baseline == null) return [];
  try {
    var q = await pool.query(
      SURVEY_COLUMNS +
      'WHERE ' + ratingSql(buckets, 'g') + ' AND g.id > $1 AND g.id <= $2 AND g.updated_at > $3::timestamptz ' +
      'ORDER BY g.id ASC LIMIT ' + PER_RUN_CAP,
      [baseline, cursor, sweptAt]
    );
    return q.rows;
  } catch (e) {
    console.error('[geico-complaints] Re-ingest sweep failed:', e.message);
    return [];
  }
}

async function checkGeicoComplaints() {
  var passStartedAt;
  try {
    var nowQ = await pool.query('SELECT NOW() AS now');
    passStartedAt = nowQ.rows[0].now;
  } catch (e) {
    console.error('[geico-complaints] Database unreachable:', e.message);
    return;
  }

  var watermark = await readWatermark();
  if (watermark === null) return;  // readWatermark logged why

  var buckets = await complaintRatings();
  var where = ratingSql(buckets, 'g');
  var sweptAt = await getSetting(SWEPT_KEY);
  var baseline = await readBaseline();

  var rows, topId;
  try {
    // Read the high-water mark FIRST. Taken after the batch it would include a
    // row inserted between the two queries, and the short-batch jump below would
    // then skip that row forever.
    var t = await pool.query('SELECT COALESCE(MAX(id), 0)::int AS id FROM geico_surveys');
    topId = t.rows[0].id;
    var q = await pool.query(
      SURVEY_COLUMNS + 'WHERE ' + where + ' AND g.id > $1 ORDER BY g.id ASC LIMIT ' + PER_RUN_CAP,
      [watermark]
    );
    rows = q.rows;
  } catch (e) {
    console.error('[geico-complaints] Could not read geico_surveys:', e.message);
    return;
  }

  // Surveys that only turned bad on a re-ingest. Filed alongside the new ones;
  // the dedupe index makes an already-filed row a cheap no-op.
  var resweep = await sweepRows(buckets, sweptAt, baseline, watermark);

  // Where the cursor lands. A short batch means we consumed every qualifying row
  // up to topId, so the cursor can jump the whole way and skip the good surveys
  // in between instead of crawling 25 rows at a time.
  var nextCursor = watermark;
  if (rows.length) {
    var lastId = parseInt(rows[rows.length - 1].id, 10);
    if (!isNaN(lastId) && lastId > nextCursor) nextCursor = lastId;
  }
  if (rows.length < PER_RUN_CAP && topId > nextCursor) nextCursor = topId;

  var work = rows.concat(resweep);
  if (!work.length) {
    if (nextCursor > watermark) await setSetting(WATERMARK_KEY, nextCursor);
    await setSetting(SWEPT_KEY, passStartedAt.toISOString ? passStartedAt.toISOString() : String(passStartedAt));
    var now = Date.now();
    if (now - lastIdleLog < IDLE_LOG_MS) return;
    lastIdleLog = now;
    var diag = '';
    try {
      var dq = await pool.query(
        'SELECT COUNT(*) FILTER (WHERE ' + where + ' AND g.id <= $1)::int AS behind FROM geico_surveys g',
        [watermark]
      );
      diag = ' Cursor is row ' + nextCursor + ', highest survey row is ' + topId + ', and ' +
        dq.rows[0].behind + ' survey(s) rated ' + buckets.join('/') + ' sit behind the cursor ' +
        '(those predate the cursor and will not auto-file - use the File button).';
    } catch (e) {}
    console.log('[geico-complaints] Nothing new rated ' + buckets.join('/') + '.' + diag);
    return;
  }
  lastIdleLog = 0;

  var filed = 0, dupes = 0, failed = 0, skipped = 0;
  var unknownSeen = {};
  for (var i = 0; i < work.length; i++) {
    var r = work[i];
    var bucket = ratingBucket(r.rating);
    // The SQL filter is a superset; the bucket is the real rule.
    if (!bucket || buckets.indexOf(bucket) === -1) { skipped++; continue; }
    if (bucket === 'unknown') unknownSeen[String(r.rating).trim()] = true;
    try {
      var res = await fileComplaintForSurvey(r);
      if (res && res.skipped) skipped++;
      else if (res && res.duplicate) dupes++;
      else if (res && res.id) {
        filed++;
        console.log('[geico-complaints] Filed complaint #' + res.id + ' for a ' + ratingWord(r.rating) +
          ' survey on PO ' + r.po_number + ' (' + (r.city_name || 'no city') + ').');
      } else failed++;
    } catch (e) {
      failed++;
      console.error('[geico-complaints] Failed on PO ' + r.po_number + ':', e.message);
    }
  }

  // Advance past everything we looked at, including any that failed - one bad
  // row must not wedge the queue. Failures are logged above and the survey stays
  // on the Geico Surveys page, where it can be filed by hand.
  if (nextCursor > watermark) await setSetting(WATERMARK_KEY, nextCursor);
  await setSetting(SWEPT_KEY, passStartedAt.toISOString ? passStartedAt.toISOString() : String(passStartedAt));

  var unknownWords = Object.keys(unknownSeen);
  if (unknownWords.length) {
    console.warn('[geico-complaints] Rating wording Geico has not used before: ' +
      unknownWords.map(function (w) { return JSON.stringify(w); }).join(', ') +
      '. Check whether it belongs in the ' + RATINGS_KEY + ' setting.');
  }
  console.log('[geico-complaints] ' + work.length + ' survey(s) checked (' + resweep.length +
    ' from a re-ingest): ' + filed + ' filed, ' + dupes + ' already on file, ' + skipped +
    ' skipped, ' + failed + ' failed.');
}

function startGeicoComplaints() {
  cron.schedule(POLL_CRON, function () {
    if (running) { console.log('[geico-complaints] Previous pass still running - skipping this tick.'); return; }
    running = true;
    checkGeicoComplaints()
      .catch(function (e) { console.error('[geico-complaints] Pass failed:', e.message); })
      .then(function () { running = false; }, function () { running = false; });
  }, { timezone: 'America/New_York' });
  console.log('[geico-complaints] Poor Geico survey intake scheduled (' + POLL_CRON + ')');
}

module.exports = {
  startGeicoComplaints: startGeicoComplaints,
  checkGeicoComplaints: checkGeicoComplaints,
  fileComplaintForSurvey: fileComplaintForSurvey,
  complaintRatings: complaintRatings,
  ratingBucket: ratingBucket,
  ratingSql: ratingSql,
  SURVEY_COLUMNS: SURVEY_COLUMNS,
  SOURCE: SOURCE
};
