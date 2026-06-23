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

// GET /api/reviews/stats — global totals + per-location breakdown
router.get('/stats', requireAuth, async (req, res) => {
  const pool = getReviewsPool();
  if (!pool) return notConfigured(res);
  try {
    const overall = await pool.query(
      'SELECT COUNT(*)::int AS total, COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg_rating, ' +
      'COUNT(*) FILTER (WHERE rating = 5)::int AS five_star FROM reviews'
    );
    const byLoc = await pool.query(
      'SELECT location_name, COUNT(*)::int AS count, COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg_rating ' +
      'FROM reviews GROUP BY location_name ORDER BY count DESC'
    );
    const dist = await pool.query('SELECT rating, COUNT(*)::int AS count FROM reviews GROUP BY rating ORDER BY rating DESC');
    const o = overall.rows[0] || {};
    res.json({
      total: o.total || 0,
      avg_rating: parseFloat(o.avg_rating) || 0,
      five_star: o.five_star || 0,
      by_location: byLoc.rows,
      locations: byLoc.rows.map(function (r) { return r.location_name; }),
      distribution: dist.rows
    });
  } catch (err) {
    console.error('GET /api/reviews/stats failed:', err.message);
    res.status(502).json({ error: 'Could not reach the reviews database. Check REVIEWS_DATABASE_URL.' });
  }
});

module.exports = router;
