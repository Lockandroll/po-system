const express = require('express');
const https = require('https');
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

// Build the shared WHERE clause used by both the list and the AI tally, from a
// plain object of filters (location, rating, search, from, to). Returns
// { whereSql, params } with $1.. placeholders.
function buildReviewFilters(f) {
  const where = [];
  const params = [];
  if (f.location) { params.push(f.location); where.push('location_name = $' + params.length); }
  if (f.rating)   { params.push(parseInt(f.rating, 10)); where.push('rating = $' + params.length); }
  if (f.search)   { params.push('%' + f.search + '%'); where.push('(reviewer_name ILIKE $' + params.length + ' OR review_text ILIKE $' + params.length + ')'); }
  if (f.from)     { params.push(f.from); where.push('review_date >= $' + params.length + '::date'); }
  if (f.to)       { params.push(f.to); where.push("review_date < ($" + params.length + "::date + INTERVAL '1 day')"); }
  return { whereSql: where.length ? ('WHERE ' + where.join(' AND ')) : '', params: params };
}

// GET /api/reviews — filtered list (location, rating, search, from, to)
router.get('/', requireAuth, async (req, res) => {
  const pool = getReviewsPool();
  if (!pool) return notConfigured(res);
  try {
    const { whereSql, params } = buildReviewFilters(req.query);
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

// Minimal direct-HTTPS call to Claude (no SDK), mirroring routes/ai.js.
function callClaude(system, userContent, maxTokens) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: maxTokens || 2048,
      system: system,
      messages: [{ role: 'user', content: userContent }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const r = https.request(options, function (resp) {
      let data = '';
      resp.on('data', function (chunk) { data += chunk; });
      resp.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse Anthropic response')); }
      });
    });
    r.on('error', reject);
    r.setTimeout(60000, function () { r.destroy(new Error('AI request timed out. Try a smaller date range.')); });
    r.write(body);
    r.end();
  });
}

// POST /api/reviews/tech-tally — within the same filters as the list
// (location, rating, search, from, to), ask Claude to tally how many reviews
// name each technician/employee. Supports the per-review employee incentive.
router.post('/tech-tally', requireAuth, async (req, res) => {
  const pool = getReviewsPool();
  if (!pool) return notConfigured(res);
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI is not configured (missing ANTHROPIC_API_KEY).' });
  }
  try {
    const { whereSql, params } = buildReviewFilters(req.body || {});
    const CAP = 800; // keep the prompt within sane token limits
    const sql =
      "SELECT review_text FROM reviews " + whereSql +
      " ORDER BY review_date DESC NULLS LAST, id DESC LIMIT " + (CAP + 1);
    const { rows } = await pool.query(sql, params);

    if (rows.length === 0) {
      return res.json({ technicians: [], unnamed: 0, total: 0, analyzed: 0, capped: false });
    }
    const capped = rows.length > CAP;
    const sample = rows.slice(0, CAP);
    const list = sample.map(function (r, i) {
      return (i + 1) + '. ' + ((r.review_text || '').replace(/\s+/g, ' ').trim() || '(no comment)');
    }).join('\n');

    const system =
      'You analyze Google reviews for Pop-A-Lock, a mobile locksmith and roadside ' +
      'assistance company. Reviews frequently name the technician/employee who ' +
      'provided the service (for example: Austin, Dylan, Scooter, Paris). Your job ' +
      'is to read each review and tally how many reviews name each employee. Treat ' +
      'obvious nickname and spelling variants as the same person. Count a review as ' +
      '"unnamed" if it names no employee. A single review names at most one employee ' +
      'for tallying purposes (use the main technician credited). Respond with ONLY ' +
      'raw JSON, no markdown and no backticks, in exactly this shape: ' +
      '{"technicians":[{"name":"Austin","count":12}],"unnamed":5,"total":40}. ' +
      'Sort technicians by count descending. total must equal the number of reviews provided.';
    const user = 'Here are ' + sample.length + ' reviews. Tally the employees named:\n\n' + list;

    const ai = await callClaude(system, user, 2048);
    let text = '';
    try { text = ai.content[0].text; } catch (e) { text = ''; }
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(502).json({ error: 'AI did not return a readable tally. Try a smaller range.' });
    }
    const parsed = JSON.parse(match[0]);
    parsed.analyzed = sample.length;
    parsed.capped = capped;
    if (!Array.isArray(parsed.technicians)) parsed.technicians = [];
    res.json(parsed);
  } catch (err) {
    console.error('POST /api/reviews/tech-tally failed:', err.message);
    res.status(502).json({ error: 'Tally failed: ' + err.message });
  }
});

module.exports = router;
