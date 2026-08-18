// Low-star Google reviews -> Customer Feedback complaints.
//
// The reviews themselves live in the review-bot's SEPARATE Postgres (read-only,
// reached through routes/reviews.js getReviewsPool). This job polls that database
// for newly ingested reviews at or below the complaint threshold (default 3 stars)
// and files each one through the SAME intake path the Pulsar emails use, so a bad
// review lands in the existing complaint process tree: city primary manager gets
// the record + a task, AI classifies category/severity, high/critical escalates,
// and the close-out gate (tech, tech-at-fault, damages, refund) applies unchanged.
//
// Safety rails:
//   * A watermark in settings (review_complaints_watermark) means we only ever act
//     on reviews ingested AFTER this job first ran. The very first run records a
//     baseline and files nothing, so turning this on does not back-file years of
//     history. Set REVIEW_COMPLAINTS_SINCE (an ISO date) before the first run to
//     deliberately seed an earlier starting point.
//     The watermark is the review-bot's own row id, NOT a timestamp. An id is
//     monotonic and has no timezone semantics, so we can never silently skip a
//     review because created_at is a bare timestamp being compared against a
//     timestamptz under a different session TimeZone. It also guarantees the
//     cursor always moves, which a timestamp with an overlap window would not.
//   * customer_feedback has a UNIQUE(source, external_ref) index and external_ref
//     is Google's stable review_id, so a re-run can never double-file a review.
//   * PER_RUN_CAP bounds how many complaints one pass can open.
const cron = require('node-cron');
const { pool } = require('../db');
const { intakeFeedback, logActivity } = require('../utils/feedbackIntake');
const { getReviewsPool } = require('../routes/reviews');

const SOURCE = 'google_review';
const WATERMARK_KEY = 'review_complaints_watermark';
const THRESHOLD_KEY = 'review_complaint_max_rating';
const CITYMAP_KEY = 'review_city_map';
const SEEDED_FROM_KEY = 'review_complaints_seeded_from';
// How far back the FIRST run reaches. Turning this feature on should not replay
// years of history, but it also must not strand a review that came in an hour
// before the deploy - which is exactly what a hard MAX(id) baseline did.
const DEFAULT_LOOKBACK_HOURS = 48;
// How often we look for new reviews. The review-bot pulls from Google every 10
// minutes, so that is the real floor on how fresh anything can be - polling faster
// than the bot writes does not make a complaint appear sooner. Two minutes keeps
// our own added delay small without pretending to beat the bot.
const POLL_CRON = process.env.REVIEW_COMPLAINTS_CRON || '*/2 * * * *';
// At a 2-minute cadence an idle day is ~720 passes. Logging "nothing new" on each
// one would bury the lines that matter, and re-counting the backlog each time would
// mean 720 full scans of the bot's table over a public connection. So the idle
// report is throttled; anything actually FILED is always logged immediately.
const IDLE_LOG_MS = 60 * 60 * 1000;
let lastIdleLog = 0;
const PER_RUN_CAP = 25;

// --- Safety net -------------------------------------------------------------
// The cursor pass advances past rows it FAILED on, deliberately, so one bad review
// can never wedge the queue. The price of that is silence: a review that failed
// once is never looked at again. It just sits on the Reviews page with a File
// button, and nothing anywhere says it was dropped. The same end state comes from
// the app being down mid-pass, or from intakeFeedback throwing on the insert.
//
// So a second pass sweeps a rolling window and files anything at or below the
// threshold that has NO complaint on file. Tony, 2026-08-18, on a 1-star that sat
// unfiled for two days: "this should already being pushed to a complaint flow as
// it is three stars or less." The cursor is the fast path; this is the guarantee.
const SWEEP_DAYS_KEY = 'review_complaints_sweep_days';
const SWEEP_FLOOR_KEY = 'review_complaints_sweep_floor_id';
const SWEPT_AT_KEY = 'review_complaints_swept_at';
const DEFAULT_SWEEP_DAYS = 14;
// The sweep reads BOTH databases, so it does not belong on every 2-minute tick.
// Twenty minutes still recovers a dropped review within the same hour, which is
// the point - it is a backstop, not the primary path.
const SWEEP_INTERVAL_MS = 20 * 60 * 1000;
// A sweep that suddenly finds hundreds of unfiled reviews means something is badly
// wrong upstream. Opening hundreds of complaints in one pass would not help.
const SWEEP_CAP = 10;

// A pass that files 25 complaints makes 25 AI calls and can outlive the 30-minute
// tick. Two overlapping passes would read the same watermark and re-do the same
// work - the dedupe index keeps the database correct, but the AI spend is wasted.
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
  } catch (e) { console.error('[review-complaints] setSetting ' + key + ':', e.message); }
}

// Highest star rating that still files a complaint. Tony's setting: 3, so 1, 2 and
// 3-star reviews all open a record. Clamped to 1-4 - a 5-star review is never a
// complaint, and 0 would switch the feature off by accident.
async function complaintThreshold() {
  var raw = await getSetting(THRESHOLD_KEY);
  if (raw == null || raw === '') raw = process.env.REVIEW_COMPLAINT_MAX_RATING;
  var n = parseInt(raw, 10);
  if (isNaN(n)) n = 3;
  if (n < 1) n = 1;
  if (n > 4) n = 4;
  return n;
}

// Optional manual override, stored in settings as JSON: {"Google location name":"ORL"}.
// Only needed when a Google listing title does not contain the Nova city name.
async function cityOverrides() {
  var raw = await getSetting(CITYMAP_KEY);
  if (!raw) return {};
  try {
    var obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
}

// Google listing title -> Nova city code. Tiers, in order:
//   1. explicit override map
//   2. exact cities.name match
//   3. exact match after dropping a leading state prefix ('FL - Orlando')
//   4. the longest city name that appears inside the listing title
//      ('Pop-A-Lock of Orlando' -> Orlando). Longest-first so 'Palm Beach'
//      wins over a shorter city that is a substring of it.
// Returns null when nothing matches; intake then falls back to admins and flags
// the record needs_review rather than assigning it to the wrong manager.
async function resolveCityForLocation(locationName, overrides) {
  var raw = (locationName || '').trim();
  if (!raw) return null;
  if (overrides && overrides[raw]) return String(overrides[raw]).toUpperCase().slice(0, 3);

  var candidates = [raw];
  var dash = raw.indexOf('-');
  if (dash !== -1) {
    var tail = raw.slice(dash + 1).trim();
    if (tail) candidates.push(tail);
  }
  for (var i = 0; i < candidates.length; i++) {
    try {
      var e = await pool.query('SELECT code FROM cities WHERE lower(name) = lower($1) LIMIT 1', [candidates[i]]);
      if (e.rows.length) return e.rows[0].code;
    } catch (err) { console.error('[review-complaints] city exact:', err.message); }
  }
  try {
    var c = await pool.query(
      "SELECT code FROM cities WHERE active = true AND length(trim(name)) > 2 " +
      "AND $1 ILIKE '%' || trim(name) || '%' ORDER BY length(trim(name)) DESC LIMIT 1",
      [raw]
    );
    if (c.rows.length) return c.rows[0].code;
  } catch (err) { console.error('[review-complaints] city contains:', err.message); }
  return null;
}

// Whoever the Reviews page already credits for this review (manual pick, or an AI
// tally match). user_id is only set on a confident match, so an unmatched AI guess
// comes through as a name for the manager to confirm, never as a hard assignment.
async function creditedTech(reviewId) {
  if (!reviewId) return { name: null, userId: null };
  try {
    var r = await pool.query('SELECT assignee, user_id FROM review_assignments WHERE review_id = $1', [reviewId]);
    if (!r.rows.length) return { name: null, userId: null };
    return { name: r.rows[0].assignee || null, userId: r.rows[0].user_id || null };
  } catch (e) { return { name: null, userId: null }; }
}

function starWord(n) {
  var r = parseInt(n, 10);
  return (isNaN(r) ? '?' : r) + '-star';
}

// Turn one review row into the shape utils/feedbackIntake expects and file it.
// Exported so the Reviews page can file an older review on demand.
async function fileComplaintForReview(review, opts) {
  opts = opts || {};
  if (!review || !review.review_id) return { skipped: true, reason: 'no review_id' };

  var overrides = opts.overrides || (await cityOverrides());
  var cityCode = await resolveCityForLocation(review.location_name, overrides);
  var tech = await creditedTech(review.review_id);

  var text = (review.review_text || '').trim();
  var header = starWord(review.rating) + ' Google review' +
    (review.location_name ? ' for ' + review.location_name : '') +
    (review.reviewer_name ? ', left by ' + review.reviewer_name : '') + '.';
  var incident = text ? (header + '\n\n"' + text + '"') : (header + ' No comment was left with the rating.');

  var parsed = {
    customer_name: review.reviewer_name || 'Google reviewer',
    customer_phone: null,
    customer_email: null,
    vehicle_make: null,
    vehicle_model: null,
    vehicle_year: null,
    service_task: null,
    job_location: review.location_name || null,
    location_raw: review.location_name || null,
    city_code: cityCode,
    tech_name_raw: tech.name,
    tech_user_id: tech.userId,
    incident_text: incident,
    invoice_ref: null,
    received_at: review.review_date || review.created_at || null,
    conduct_type: starWord(review.rating) + ' public Google review',
    category_hint: 'complaint'
  };

  var meta = {
    source: SOURCE,
    external_ref: String(review.review_id),
    raw_subject: starWord(review.rating) + ' Google review - ' + (review.location_name || 'unknown location'),
    raw_email: [
      'Google review ID: ' + review.review_id,
      'Location: ' + (review.location_name || '-'),
      'Reviewer: ' + (review.reviewer_name || '-'),
      'Rating: ' + (review.rating == null ? '-' : review.rating),
      'Review date: ' + (review.review_date || '-'),
      '',
      text || '(no comment)'
    ].join('\n')
  };

  var result = await intakeFeedback(parsed, meta);

  // Leave a breadcrumb when the listing could not be matched to a city, so the
  // manager who picks this up knows WHY it landed with the admins.
  if (result && result.id && !result.duplicate && !cityCode) {
    try {
      await logActivity(result.id, null, 'event',
        'Google location "' + (review.location_name || 'unknown') + '" does not match a Nova city, so this went to the admins. ' +
        'Add the city, or map the listing name under the ' + CITYMAP_KEY + ' setting.', null);
    } catch (e) {}
  }
  return result;
}

// Highest row id that is OLDER than the lookback window. Everything after it is
// "recent" and worth filing even on a first run.
async function baselineId(rpool) {
  var hours = parseInt(process.env.REVIEW_COMPLAINTS_LOOKBACK_HOURS, 10);
  if (isNaN(hours) || hours < 0) hours = DEFAULT_LOOKBACK_HOURS;
  var q = await rpool.query(
    "SELECT COALESCE(MAX(id), 0)::int AS id FROM reviews WHERE created_at < NOW() - ($1 || ' hours')::interval",
    [String(hours)]
  );
  return { id: q.rows[0].id, hours: hours };
}

// Read the cursor, seeding it when there isn't a usable one. Returns the row id to
// read past, or null when the caller should stop (unreadable reviews DB).
//
// REVIEW_COMPLAINTS_SINCE is honoured whenever its value CHANGES, not only on a
// virgin install - that is the supported way to rewind and pick up reviews that
// were missed, without touching the database by hand.
async function readWatermark(rpool) {
  var raw = await getSetting(WATERMARK_KEY);
  // Must be a PURE integer. parseInt would happily read '2026-07-01T00:00:00Z' as
  // 2026 - an earlier build of this job stored ISO timestamps, and silently
  // treating one as a row id would freeze the cursor until the bot's ids passed it.
  var haveCursor = (raw != null && /^\d+$/.test(String(raw).trim()));
  var cursor = haveCursor ? parseInt(raw, 10) : null;
  if (raw != null && !haveCursor && String(raw).trim() !== '') {
    console.warn('[review-complaints] Watermark ' + JSON.stringify(raw) + ' is not a row id - re-baselining.');
  }

  var seed = process.env.REVIEW_COMPLAINTS_SINCE || null;
  try {
    // An explicit start date that we have not already applied wins over whatever
    // the cursor currently says, forwards OR backwards.
    if (seed) {
      var appliedSeed = await getSetting(SEEDED_FROM_KEY);
      if (appliedSeed !== seed) {
        var s = await rpool.query(
          'SELECT COALESCE(MAX(id), 0)::int AS id FROM reviews WHERE created_at < $1::timestamptz',
          [seed]
        );
        var seedId = s.rows[0].id;
        await setSetting(WATERMARK_KEY, seedId);
        await setSetting(SEEDED_FROM_KEY, seed);
        console.log('[review-complaints] REVIEW_COMPLAINTS_SINCE=' + seed + ' applied - cursor moved to row ' +
          seedId + '. Reviews ingested after that date will file on this pass.');
        return seedId;
      }
    }

    if (haveCursor) {
      // Sanity check: if the reviews table's highest id is BELOW our cursor, the
      // bot's table was rebuilt or re-keyed and our cursor points at nothing.
      // Re-baseline rather than sitting silent forever.
      var top = await rpool.query('SELECT COALESCE(MAX(id), 0)::int AS id FROM reviews');
      if (top.rows[0].id < cursor) {
        var reset = await baselineId(rpool);
        await setSetting(WATERMARK_KEY, reset.id);
        console.warn('[review-complaints] Cursor ' + cursor + ' is past the reviews table high-water mark ' +
          top.rows[0].id + ' - the table was rebuilt. Re-baselined to row ' + reset.id + '.');
        return reset.id;
      }
      return cursor;
    }

    // Virgin install. Reach back over the lookback window so a review that landed
    // shortly before the deploy still files, but do not replay all of history.
    var base = await baselineId(rpool);
    await setSetting(WATERMARK_KEY, base.id);
    console.log('[review-complaints] First run - cursor set at row ' + base.id + ' (everything ingested in the ' +
      'last ' + base.hours + 'h will file on this pass; older history was skipped).');
    return base.id;
  } catch (e) {
    console.error('[review-complaints] Could not seed the cursor:', e.message);
    return null;
  }
}

// How far back the safety net looks. Settings first, then env, then 14 days.
// 0 switches the net off entirely; the ceiling stops a fat-fingered value from
// turning a backstop into a full back-file of history.
async function sweepDays() {
  var raw = await getSetting(SWEEP_DAYS_KEY);
  if (raw == null || raw === '') raw = process.env.REVIEW_COMPLAINTS_SWEEP_DAYS;
  var n = parseInt(raw, 10);
  if (isNaN(n)) n = DEFAULT_SWEEP_DAYS;
  if (n < 0) n = 0;
  if (n > 90) n = 90;
  return n;
}

// Hard floor for the sweep, written ONCE and never refreshed.
//
// Without it, the first sweep would treat every low-star review in the window as
// "missed" - including the history the original cursor baseline deliberately
// skipped - and file all of it. The floor is the highest row id that was ALREADY
// older than the window on the day the net was armed, so the sweep can only ever
// move forwards from that point. This is the same trap, and the same fix, as
// geico_complaints_baseline_id in jobs/geicoComplaints.js.
async function sweepFloor(rpool, days) {
  var raw = await getSetting(SWEEP_FLOOR_KEY);
  if (raw != null && /^\d+$/.test(String(raw).trim())) return parseInt(raw, 10);
  var q;
  try {
    q = await rpool.query(
      "SELECT COALESCE(MAX(id), 0)::int AS id FROM reviews WHERE created_at < NOW() - ($1 || ' days')::interval",
      [String(days)]
    );
  } catch (e) {
    // Never arm the floor from a failed read - a 0 here would mean "no floor" and
    // the next sweep would treat all of history as missed.
    console.error('[review-complaints] Could not arm the sweep floor:', e.message);
    return null;
  }
  var floor = q.rows[0].id;
  await setSetting(SWEEP_FLOOR_KEY, floor);
  console.log('[review-complaints] Safety-net sweep armed at row ' + floor +
    ' - it will never look at anything ingested before that point.');
  return floor;
}

// Find low-star reviews inside the window that have no complaint against them and
// file them. Deliberately says nothing when it finds nothing: a quiet sweep is the
// normal case, and anything it DOES file is a defect in the cursor pass worth
// shouting about.
async function sweepMissedReviews(rpool, maxRating, overrides) {
  var days = await sweepDays();
  if (!days) return { window: 0, missed: 0, filed: 0 };

  var floor = await sweepFloor(rpool, days);
  if (floor === null) return { window: 0, missed: 0, filed: 0 };

  var rows;
  try {
    var q = await rpool.query(
      'SELECT id, review_id, location_name, reviewer_name, rating, review_text, ' +
      "to_char(review_date, 'YYYY-MM-DD') AS review_date, created_at " +
      'FROM reviews WHERE rating IS NOT NULL AND rating <= $1 AND id > $2 ' +
      "AND review_id IS NOT NULL AND created_at > NOW() - ($3 || ' days')::interval " +
      'ORDER BY id ASC LIMIT 500',
      [maxRating, floor, String(days)]
    );
    rows = q.rows;
  } catch (e) {
    console.error('[review-complaints] Sweep could not read the reviews DB:', e.message);
    return { window: 0, missed: 0, filed: 0 };
  }
  if (!rows.length) return { window: 0, missed: 0, filed: 0 };

  // One lookup for the whole window, not one per review.
  var refs = [];
  for (var k = 0; k < rows.length; k++) refs.push(String(rows[k].review_id));
  var onFile = {};
  try {
    var f = await pool.query(
      'SELECT external_ref FROM customer_feedback WHERE source = $1 AND external_ref = ANY($2::text[])',
      [SOURCE, refs]
    );
    for (var m = 0; m < f.rows.length; m++) onFile[String(f.rows[m].external_ref)] = true;
  } catch (e) {
    // Fail CLOSED. If we cannot tell what is already on file we do nothing -
    // intakeFeedback would dedupe anyway, but guessing here is not worth it.
    console.error('[review-complaints] Sweep could not read customer_feedback - standing down this pass:', e.message);
    return { window: rows.length, missed: 0, filed: 0 };
  }

  var missed = [];
  for (var n2 = 0; n2 < rows.length; n2++) {
    if (!onFile[String(rows[n2].review_id)]) missed.push(rows[n2]);
  }
  if (!missed.length) return { window: rows.length, missed: 0, filed: 0 };

  // rows already come back oldest-first, so a capped sweep drains in order.
  var batch = missed.slice(0, SWEEP_CAP);
  console.warn('[review-complaints] SAFETY NET: ' + missed.length + ' review(s) at or below ' + maxRating +
    ' stars in the last ' + days + ' day(s) have no complaint on file - the normal pass missed them. ' +
    'Filing ' + batch.length + ' now. Look for an earlier "failed" or "Nothing new" line to see why.');

  var filed = 0;
  for (var i = 0; i < batch.length; i++) {
    var r = batch[i];
    try {
      var res = await fileComplaintForReview(r, { overrides: overrides });
      if (res && res.id && !res.duplicate) {
        filed++;
        console.warn('[review-complaints] SAFETY NET filed complaint #' + res.id + ' for ' + starWord(r.rating) +
          ' review ' + r.review_id + ' (' + (r.location_name || 'unknown') + ', row ' + r.id + ').');
      }
    } catch (e) {
      console.error('[review-complaints] SAFETY NET failed on review ' + r.review_id + ':', e.message);
    }
  }
  return { window: rows.length, missed: missed.length, filed: filed };
}

// Throttled entry point for the sweep. Kept OUT of checkReviewComplaints on
// purpose: that function returns early on an idle pass, which is exactly when the
// backstop most needs to run. force=true skips the throttle (manual runs).
async function sweepPass(force) {
  const rpool = (typeof getReviewsPool === 'function') ? getReviewsPool() : null;
  if (!rpool) return null;
  if (!force) {
    var last = await getSetting(SWEPT_AT_KEY);
    var lastMs = last ? Date.parse(last) : NaN;
    if (!isNaN(lastMs) && (Date.now() - lastMs) < SWEEP_INTERVAL_MS) return null;
  }
  // Stamp BEFORE the work, so a sweep that throws every time cannot run hot on
  // every 2-minute tick.
  await setSetting(SWEPT_AT_KEY, new Date().toISOString());
  var maxRating = await complaintThreshold();
  var overrides = await cityOverrides();
  return await sweepMissedReviews(rpool, maxRating, overrides);
}

async function checkReviewComplaints() {
  const rpool = (typeof getReviewsPool === 'function') ? getReviewsPool() : null;
  if (!rpool) { console.log('[review-complaints] Reviews DB not configured - skipping.'); return; }

  var watermark = await readWatermark(rpool);
  if (watermark === null) return;  // reviews DB unreadable; readWatermark logged why

  var maxRating = await complaintThreshold();
  var rows;
  try {
    var q = await rpool.query(
      'SELECT id, review_id, location_name, reviewer_name, rating, review_text, ' +
      "to_char(review_date, 'YYYY-MM-DD') AS review_date, created_at " +
      'FROM reviews WHERE rating IS NOT NULL AND rating <= $1 AND id > $2 ' +
      'ORDER BY id ASC LIMIT ' + PER_RUN_CAP,
      [maxRating, watermark]
    );
    rows = q.rows;
  } catch (e) {
    console.error('[review-complaints] Could not read reviews DB:', e.message);
    return;
  }

  if (!rows.length) {
    // Say WHY there was nothing to do, so "the review did not file" is answerable
    // from the Railway log alone instead of guessing at the cursor. Throttled: the
    // backlog count is a full scan, and at this cadence it would otherwise run every
    // couple of minutes forever for a line nobody is reading.
    var now = Date.now();
    if (now - lastIdleLog < IDLE_LOG_MS) return;
    lastIdleLog = now;
    var diag = '';
    try {
      var dq = await rpool.query(
        'SELECT COALESCE(MAX(id), 0)::int AS top, ' +
        'COUNT(*) FILTER (WHERE rating IS NOT NULL AND rating <= $1 AND id <= $2)::int AS behind FROM reviews',
        [maxRating, watermark]
      );
      diag = ' Cursor is row ' + watermark + ', highest review row is ' + dq.rows[0].top + ', and ' +
        dq.rows[0].behind + ' review(s) at or below ' + maxRating +
        ' stars sit behind the cursor (those predate the cursor and will not auto-file - use the File button).';
    } catch (e) {}
    console.log('[review-complaints] Nothing new at or below ' + maxRating + ' stars.' + diag);
    return;
  }
  // Something happened, so the next idle pass is worth hearing about again.
  lastIdleLog = 0;

  var overrides = await cityOverrides();
  var filed = 0, dupes = 0, failed = 0, skipped = 0, highestId = watermark;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var rid = parseInt(r.id, 10);
    if (!isNaN(rid) && rid > highestId) highestId = rid;
    try {
      var res = await fileComplaintForReview(r, { overrides: overrides });
      if (res && res.skipped) skipped++;
      else if (res && res.duplicate) dupes++;
      else if (res && res.id) {
        filed++;
        console.log('[review-complaints] Filed complaint #' + res.id + ' for ' + starWord(r.rating) + ' review ' + r.review_id + ' (' + (r.location_name || 'unknown') + ').');
      } else failed++;
    } catch (e) {
      failed++;
      console.error('[review-complaints] Failed on review ' + r.review_id + ':', e.message);
    }
  }

  // Advance past everything we looked at, including any that failed - a single bad
  // row must not wedge the queue. Failures are logged above and the review stays
  // visible on the Reviews page, where it can be filed by hand.
  if (highestId > watermark) await setSetting(WATERMARK_KEY, highestId);
  console.log('[review-complaints] ' + rows.length + ' review(s) checked: ' + filed + ' filed, ' + dupes +
    ' already on file, ' + skipped + ' skipped (no Google review id), ' + failed + ' failed.');
}

function startReviewComplaints() {
  // Every 2 minutes by default (override with REVIEW_COMPLAINTS_CRON). Combined
  // with the review-bot's own 10-minute pull from Google, a bad review becomes an
  // assigned complaint within roughly 12 minutes worst case. The bot's cadence is
  // the dominant term - polling here faster buys almost nothing, because there is
  // nothing new in the table to find until the bot writes it.
  cron.schedule(POLL_CRON, function () {
    if (running) { console.log('[review-complaints] Previous pass still running - skipping this tick.'); return; }
    running = true;
    // Cursor pass first (fast, every tick), then the safety-net sweep, which
    // throttles itself to SWEEP_INTERVAL_MS - on most ticks it is one settings
    // read and a return. The sweep runs even when the cursor pass found nothing,
    // because "found nothing" is the state a stranded review hides in.
    Promise.resolve()
      .then(function () { return checkReviewComplaints(); })
      .catch(function (e) { console.error('[review-complaints] Pass failed:', e.message); })
      .then(function () { return sweepPass(false); })
      .catch(function (e) { console.error('[review-complaints] Safety-net sweep failed:', e.message); })
      .then(function () { running = false; }, function () { running = false; });
  }, { timezone: 'America/New_York' });
  console.log('[review-complaints] Low-star review intake scheduled (' + POLL_CRON + ')');
}

module.exports = {
  startReviewComplaints: startReviewComplaints,
  checkReviewComplaints: checkReviewComplaints,
  sweepPass: sweepPass,
  sweepMissedReviews: sweepMissedReviews,
  fileComplaintForReview: fileComplaintForReview,
  complaintThreshold: complaintThreshold,
  resolveCityForLocation: resolveCityForLocation
};
