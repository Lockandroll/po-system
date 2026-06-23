const express = require('express');
const { Pool } = require('pg');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Read-only connection to the Google-review-bot's Postgres, which lives in a
// SEPARATE Railway project. Cross-project means we reach it over its PUBLIC URL
// (set REVIEWS_DATABASE_URL in Nova's Railway variables). Lazy pool so the app
// still boots fine if the variable is not set yet.
let reviewsPool = null;
let reviewsPoolUrl = null;
function getReviewsPool() {
  const url = process.env.REVIEWS_DATABASE_URL;
  if (!url) return null;
  if (reviewsPool && reviewsPoolUrl === url) return reviewsPool;
  if (reviewsPool) { try { reviewsPool.end(); } catch (e) {} }
  reviewsPoolUrl = url;
  reviewsPool = new Pool({
    connectionString: url,
    ssl: url.includes('railway.internal') ? false : { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  reviewsPool.on('error', function (e) { console.error('reviews pool error:', e.message); });
  return reviewsPool;
}

function notConfigured(res) {
  return res.status(503).json({ error: 'Reviews database is not connected yet. Add a REVIEWS_DATABASE_URL variable in Nova’s Railway settings (the review-bot Postgres public URL).' });
}

// GET /api/reviews — filtered list (location, rating, search)
router.get('/', requireAuth, async (req, res) => {
  const pool = getReviewsPool();
  if (!pool) return notConfigured(res);
  try {
    const where = [];
    const params = [];
    if (req.query.location) { params.push(req.query.location); where.push('location_name = $' + params.length); }
    if (req.query.rating)   { params.push(parseInt(req.query.rating, 10)); where.push('rating = $' + params.length); }
    if (req.query.search)   { params.push('%' + req.query.search + '%'); where.push('(reviewer_name ILIKE $' + params.length + ' OR review_text ILIKE $' + params.length + ')'); }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const sql =
      "SELECT id, review_id, location_name, reviewer_name, rating, review_text, " +
      "to_char(review_date, 'YYYY-MM-DD') AS review_date, to_char(created_at, 'YYYY-MM-DD') AS created_at " +
      "FROM reviews " + whereSql + " ORDER BY review_date DESC NULLS LAST, id DESC LIMIT " + limit;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/reviews failed:', err.message);
    res.status(502).json({ error: 'Could not reach the reviews database. Check REVIEWS_DATABASE_URL.' });
  }
});

// GET /api/reviews/stats — global totals + per-location breakdown.
// Prefers Google's OFFICIAL totals (location_totals, written by the review-bot
// from the v4 reviews endpoint's totalReviewCount/averageRating) so the
// dashboard matches the public Google counts exactly. Falls back to a raw row
// count of the logged reviews if those totals are not available yet (e.g. the
// bot has not deployed/run since this feature was added).
router.get('/stats', requireAuth, async (req, res) => {
  const pool = getReviewsPool();
  if (!pool) return notConfigured(res);
  try {
    // Per-location: official Google totals when present, else logged-row counts.
    let byLoc;
    try {
      byLoc = await pool.query(
        'SELECT r.location_name, ' +
        'COALESCE(lt.total_review_count, r.row_count)::int AS count, ' +
        'COALESCE(lt.average_rating, r.row_avg)::numeric AS avg_rating ' +
        'FROM (SELECT location_name, COUNT(*)::int AS row_count, ' +
        'COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS row_avg ' +
        'FROM reviews GROUP BY location_name) r ' +
        'LEFT JOIN location_totals lt ON lt.location_name = r.location_name ' +
        'ORDER BY count DESC'
      );
    } catch (joinErr) {
      // location_totals does not exist yet — fall back to raw row counts.
      byLoc = await pool.query(
        'SELECT location_name, COUNT(*)::int AS count, ' +
        'COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg_rating ' +
        'FROM reviews GROUP BY location_name ORDER BY count DESC'
      );
    }

    const fiveStarRes = await pool.query(
      'SELECT COUNT(*) FILTER (WHERE rating = 5)::int AS five_star FROM reviews'
    );
    const dist = await pool.query(
      'SELECT rating, COUNT(*)::int AS count FROM reviews GROUP BY rating ORDER BY rating DESC'
    );

    const rows = byLoc.rows;
    let total = 0;
    let weighted = 0;
    rows.forEach(function (r) {
      const c = parseInt(r.count, 10) || 0;
      total += c;
      weighted += c * (parseFloat(r.avg_rating) || 0);
    });
    const avg_rating = total ? Math.round((weighted / total) * 100) / 100 : 0;

    res.json({
      total: total,
      avg_rating: avg_rating,
      five_star: (fiveStarRes.rows[0] || {}).five_star || 0,
      by_location: rows,
      locations: rows.map(function (r) { return r.location_name; }),
      distribution: dist.rows
    });
  } catch (err) {
    console.error('GET /api/reviews/stats failed:', err.message);
    res.status(502).json({ error: 'Could not reach the reviews database. Check REVIEWS_DATABASE_URL.' });
  }
});

module.exports = router;
