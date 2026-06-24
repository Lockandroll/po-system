const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('../utils/email');
const notify = require('../utils/notify');
const { getReviewsPool } = require('../routes/reviews');

// The Google rating customers SEE is rounded to one decimal place (tenths).
// We alert only when that displayed number moves, so the threshold matches
// exactly what shows on a location's Google listing.
function displayed(avg) { return Math.round((parseFloat(avg) || 0) * 10) / 10; }

// Pull per-location ratings, preferring Google's official totals (location_totals,
// written by the review-bot) and falling back to logged-row aggregates.
async function fetchLocationRatings(rpool) {
  try {
    const { rows } = await rpool.query(
      'SELECT r.location_name, ' +
      'COALESCE(lt.total_review_count, r.row_count)::int AS count, ' +
      'COALESCE(lt.average_rating, r.row_avg)::numeric AS avg_rating ' +
      'FROM (SELECT location_name, COUNT(*)::int AS row_count, ' +
      'COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS row_avg ' +
      'FROM reviews GROUP BY location_name) r ' +
      'LEFT JOIN location_totals lt ON lt.location_name = r.location_name'
    );
    return rows;
  } catch (e) {
    const { rows } = await rpool.query(
      'SELECT location_name, COUNT(*)::int AS count, ' +
      'COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg_rating ' +
      'FROM reviews GROUP BY location_name'
    );
    return rows;
  }
}

function buildEmail(changes, appUrl) {
  const details = changes.map(function (c) {
    const arrow = c.to < c.from ? ' down' : ' up';
    return {
      label: c.loc,
      value: c.from.toFixed(1) + ' to ' + c.to.toFixed(1) + ' stars' + arrow
    };
  });
  const anyDrop = changes.some(function (c) { return c.to < c.from; });
  const body = changes.length === 1
    ? ('The Google star rating shown for <strong>' + changes[0].loc + '</strong> changed from ' +
       changes[0].from.toFixed(1) + ' to <strong>' + changes[0].to.toFixed(1) + '</strong> stars (across ' +
       (changes[0].count || 0).toLocaleString() + ' reviews).')
    : ('The Google star rating shown for <strong>' + changes.length + ' locations</strong> changed since the last check. Details below.');
  return emailTemplate({
    badge: 'Google Rating',
    badgeColor: anyDrop ? 'red' : 'green',
    title: 'A location rating changed on Google',
    body: body,
    details: details,
    buttonText: 'Open Reviews',
    buttonUrl: (appUrl || '') + '?view=reviews',
    footerNote: 'You are receiving this because you are set to receive Google rating alerts. Recipients can be changed under Notifications in settings.'
  });
}

async function checkReviewRatings() {
  const rpool = (typeof getReviewsPool === 'function') ? getReviewsPool() : null;
  if (!rpool) { console.log('[review-ratings] Reviews DB not configured — skipping.'); return; }

  let locs;
  try { locs = await fetchLocationRatings(rpool); }
  catch (e) { console.error('[review-ratings] Could not read reviews DB:', e.message); return; }

  const changes = [];
  for (var k = 0; k < locs.length; k++) {
    const r = locs[k];
    const loc = r.location_name;
    if (!loc) continue;
    const avg = parseFloat(r.avg_rating) || 0;
    const count = parseInt(r.count, 10) || 0;
    const disp = displayed(avg);
    try {
      const prev = await pool.query('SELECT displayed_rating FROM review_rating_snapshots WHERE location_name = $1', [loc]);
      if (prev.rows.length) {
        const prevDisp = parseFloat(prev.rows[0].displayed_rating);
        // Both values are rounded to tenths; treat a >= 0.05 gap as a real move.
        if (Math.abs(prevDisp - disp) >= 0.05) changes.push({ loc: loc, from: prevDisp, to: disp, count: count });
        await pool.query(
          'UPDATE review_rating_snapshots SET displayed_rating = $2, avg_rating = $3, review_count = $4, updated_at = NOW() WHERE location_name = $1',
          [loc, disp, avg, count]
        );
      } else {
        // First time seeing this location: record a baseline, do not alert.
        await pool.query(
          'INSERT INTO review_rating_snapshots (location_name, displayed_rating, avg_rating, review_count) VALUES ($1, $2, $3, $4)',
          [loc, disp, avg, count]
        );
      }
    } catch (e) { console.error('[review-ratings] Snapshot failed for ' + loc + ':', e.message); }
  }

  if (!changes.length) { console.log('[review-ratings] No displayed-rating changes.'); return; }

  // Recipients are configurable via Notifications (event review_rating_changed);
  // default audience is admins until customized.
  let recip;
  try { recip = await notify.broadcastRecipients('review_rating_changed', "role = 'admin'"); }
  catch (e) { recip = { emails: [] }; }
  const emails = (recip && recip.emails) || [];
  if (!emails.length) { console.log('[review-ratings] ' + changes.length + ' change(s) but no recipients configured.'); return; }

  const appUrl = process.env.APP_URL || '';
  const subject = changes.length === 1
    ? ('Google rating changed: ' + changes[0].loc + ' is now ' + changes[0].to.toFixed(1) + ' stars')
    : (changes.length + ' locations had a Google rating change');
  const html = buildEmail(changes, appUrl);
  for (var i = 0; i < emails.length; i++) {
    try { await sendEmail(emails[i], subject, html); }
    catch (e) { console.error('[review-ratings] Email failed to ' + emails[i] + ':', e.message); }
  }
  console.log('[review-ratings] Notified ' + emails.length + ' recipient(s) of ' + changes.length + ' change(s).');
}

function startReviewRatings() {
  // Daily at 09:00 ET — after the review-bot's overnight pull.
  cron.schedule('0 9 * * *', function () {
    console.log('[review-ratings] Running daily rating-change check…');
    checkReviewRatings();
  }, { timezone: 'America/New_York' });
  console.log('[review-ratings] Daily rating-change check scheduled (09:00 America/New_York)');
}

module.exports = { startReviewRatings, checkReviewRatings };
