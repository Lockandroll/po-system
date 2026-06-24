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
    const cols =
      "id, review_id, location_name, reviewer_name, rating, review_text, reply_text, " +
      "to_char(review_date, 'YYYY-MM-DD') AS review_date, to_char(created_at, 'YYYY-MM-DD') AS created_at";
    const tail = " FROM reviews " + whereSql + " ORDER BY review_date DESC NULLS LAST, id DESC LIMIT " + limit;
    let result;
    try {
      result = await pool.query("SELECT " + cols + tail, params);
    } catch (colErr) {
      // reply_text column may not exist yet (review-bot not deployed) — retry without it
      result = await pool.query("SELECT " + cols.replace('reply_text, ', '') + tail, params);
    }
    res.json(result.rows);
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
  const { whereSql, params } = buildReviewFilters(req.query);
  const hasFilter = !!whereSql;
  try {
    // Per-location aggregates. With NO filter we prefer Google's OFFICIAL totals
    // (location_totals) so the dashboard matches the public Google counts exactly.
    // Once ANY filter is applied (rating/date/search/location), those lifetime
    // totals no longer describe the slice, so we count the matching logged rows.
    let byLoc;
    if (!hasFilter) {
      try {
        byLoc = await pool.query(
          'SELECT r.location_name, ' +
          'COALESCE(lt.total_review_count, r.row_count)::int AS count, ' +
          'COALESCE(lt.average_rating, r.row_avg)::numeric AS avg_rating ' +
          'FROM (SELECT location_name, COUNT(*)::int AS row_count, ' +
          'COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS row_avg ' +
          'FROM reviews GROUP BY location_name) r ' +
          'LEFT JOIN location_totals lt ON lt.location_name = r.location_name ' +
          'ORDER BY avg_rating DESC, count DESC'
        );
      } catch (joinErr) {
        byLoc = await pool.query(
          'SELECT location_name, COUNT(*)::int AS count, ' +
          'COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg_rating ' +
          'FROM reviews GROUP BY location_name ORDER BY avg_rating DESC, count DESC'
        );
      }
    } else {
      byLoc = await pool.query(
        'SELECT location_name, COUNT(*)::int AS count, ' +
        'COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg_rating ' +
        'FROM reviews ' + whereSql + ' GROUP BY location_name ORDER BY avg_rating DESC, count DESC',
        params
      );
    }

    const fiveStarRes = await pool.query(
      'SELECT COUNT(*) FILTER (WHERE rating = 5)::int AS five_star FROM reviews ' + whereSql,
      params
    );
    const dist = await pool.query(
      'SELECT rating, COUNT(*)::int AS count FROM reviews ' + whereSql + ' GROUP BY rating ORDER BY rating DESC',
      params
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
      distribution: dist.rows,
      filtered: hasFilter
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
      "SELECT location_name, review_text FROM reviews " + whereSql +
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

    // Ask the AI only to extract the technician named in EACH review (in order).
    // We then group by the city we already know from the database, so the city
    // attribution is exact rather than guessed by the model.
    const system =
      'You analyze Google reviews for Pop-A-Lock, a mobile locksmith and roadside ' +
      'company. Each review may name the technician/employee who provided service ' +
      '(for example: Austin, Dylan, Scooter, Paris). For EACH numbered review, give ' +
      'the single employee name credited, or null if none is named. Treat obvious ' +
      'nickname and spelling variants as the same canonical name. Respond with ONLY ' +
      'raw JSON, no markdown and no backticks, in exactly this shape: ' +
      '{"names":["Austin",null,"Dylan"]} with exactly one entry per review, in the ' +
      'same order as given.';
    const user = 'Here are ' + sample.length + ' reviews:\n\n' + list;

    const ai = await callClaude(system, user, 4096);
    let text = '';
    try { text = ai.content[0].text; } catch (e) { text = ''; }
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(502).json({ error: 'AI did not return a readable result. Try a smaller range.' });
    }
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch (e) {
      return res.status(502).json({ error: 'AI returned malformed data. Try a smaller range.' });
    }
    const names = Array.isArray(parsed.names) ? parsed.names : [];

    // Group by technician; track which city each tech appeared in.
    const techMap = {};
    let unnamed = 0;
    sample.forEach(function (r, i) {
      let nm = names[i];
      nm = (typeof nm === 'string') ? nm.trim() : '';
      if (!nm) { unnamed++; return; }
      if (!techMap[nm]) techMap[nm] = { count: 0, cities: {} };
      techMap[nm].count++;
      const city = r.location_name || '—';
      techMap[nm].cities[city] = (techMap[nm].cities[city] || 0) + 1;
    });

    const technicians = Object.keys(techMap).map(function (nm) {
      const t = techMap[nm];
      let topCity = '—', topN = -1;
      Object.keys(t.cities).forEach(function (c) {
        if (t.cities[c] > topN) { topN = t.cities[c]; topCity = c; }
      });
      return { name: nm, location: topCity, multiCity: Object.keys(t.cities).length > 1, count: t.count };
    }).sort(function (a, b) { return b.count - a.count; });

    res.json({
      technicians: technicians,
      unnamed: unnamed,
      total: sample.length,
      analyzed: sample.length,
      capped: capped
    });
  } catch (err) {
    console.error('POST /api/reviews/tech-tally failed:', err.message);
    res.status(502).json({ error: 'Tally failed: ' + err.message });
  }
});

module.exports = router;
module.exports.getReviewsPool = getReviewsPool;
