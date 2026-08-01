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
const PER_RUN_CAP = 25;

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

// Read the cursor, seeding it on the very first run. Returns the row id to read
// past, or null when the caller should stop (first run baseline, or a read error).
async function readWatermark(rpool) {
  var raw = await getSetting(WATERMARK_KEY);
  // Must be a PURE integer. parseInt would happily read '2026-07-01T00:00:00Z' as
  // 2026 - an earlier build of this job stored ISO timestamps, and silently
  // treating one as a row id would freeze the cursor until the bot's ids passed it.
  if (raw != null && /^\d+$/.test(String(raw).trim())) return parseInt(raw, 10);
  if (raw != null && String(raw).trim() !== '') {
    console.warn('[review-complaints] Watermark ' + JSON.stringify(raw) + ' is not a row id - re-baselining.');
  }

  // No usable cursor yet. Anything already in the reviews table predates this
  // feature, so the baseline is the current highest row id and we file nothing
  // this pass - unless an explicit start date was supplied.
  var seed = process.env.REVIEW_COMPLAINTS_SINCE || null;
  try {
    if (seed) {
      var s = await rpool.query(
        'SELECT COALESCE(MAX(id), 0)::int AS id FROM reviews WHERE created_at < $1::timestamptz',
        [seed]
      );
      var seedId = s.rows[0].id;
      await setSetting(WATERMARK_KEY, seedId);
      console.log('[review-complaints] Seeded cursor at row ' + seedId + ' from REVIEW_COMPLAINTS_SINCE=' + seed + '.');
      return seedId;
    }
    var m = await rpool.query('SELECT COALESCE(MAX(id), 0)::int AS id FROM reviews');
    var baseId = m.rows[0].id;
    await setSetting(WATERMARK_KEY, baseId);
    console.log('[review-complaints] First run - baseline set at row ' + baseId +
      '. Reviews ingested from now on will file complaints; nothing was back-filed.');
    return null;
  } catch (e) {
    console.error('[review-complaints] Could not seed the cursor:', e.message);
    return null;
  }
}

async function checkReviewComplaints() {
  const rpool = (typeof getReviewsPool === 'function') ? getReviewsPool() : null;
  if (!rpool) { console.log('[review-complaints] Reviews DB not configured - skipping.'); return; }

  var watermark = await readWatermark(rpool);
  if (watermark === null) return;  // first run: baseline recorded, nothing to file

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

  if (!rows.length) { console.log('[review-complaints] No new reviews at or below ' + maxRating + ' stars.'); return; }

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
  // Every 30 minutes. The review-bot pulls from Google on a 10-minute cron, so a
  // bad review turns into an assigned complaint within about half an hour.
  cron.schedule('*/30 * * * *', function () {
    if (running) { console.log('[review-complaints] Previous pass still running - skipping this tick.'); return; }
    running = true;
    checkReviewComplaints()
      .catch(function (e) { console.error('[review-complaints] Pass failed:', e.message); })
      .then(function () { running = false; }, function () { running = false; });
  }, { timezone: 'America/New_York' });
  console.log('[review-complaints] Low-star review intake scheduled (every 30 minutes)');
}

module.exports = {
  startReviewComplaints: startReviewComplaints,
  checkReviewComplaints: checkReviewComplaints,
  fileComplaintForReview: fileComplaintForReview,
  complaintThreshold: complaintThreshold,
  resolveCityForLocation: resolveCityForLocation
};
