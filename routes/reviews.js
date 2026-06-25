const express = require('express');
const https = require('https');
const { Pool } = require('pg');
const { pool: novaPool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Load Nova-owned review assignments for a set of Google review_ids.
// Returns a map: review_id -> { assignee, source }. Never throws — if the
// table or the main pool is unavailable, callers just get an empty map.
async function loadAssignments(ids) {
  const map = {};
  const clean = (ids || []).filter(Boolean);
  if (!clean.length) return map;
  try {
    const { rows } = await novaPool.query(
      'SELECT review_id, assignee, source FROM review_assignments WHERE review_id = ANY($1)',
      [clean]
    );
    rows.forEach(function (r) { map[r.review_id] = { assignee: r.assignee, source: r.source }; });
  } catch (e) {
    console.error('loadAssignments failed:', e.message);
  }
  return map;
}

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
    // Attach Nova-owned "assigned to" info (kept in a separate database).
    const rows = result.rows;
    const amap = await loadAssignments(rows.map(function (r) { return r.review_id; }));
    rows.forEach(function (r) {
      const a = r.review_id ? amap[r.review_id] : null;
      r.assignee = a ? a.assignee : null;
      r.assignee_source = a ? a.source : null;
    });
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

// GET /api/reviews/assignees — name suggestions for the "Assigned To" picker.
// Combines active Nova users (real name + dispatch/pulsar name) with any name
// already credited on a review, so the common techs are one click and new
// (e.g. roadside) names appear once you have used them.
router.get('/assignees', requireAuth, async (req, res) => {
  const set = {};
  try {
    const u = await novaPool.query("SELECT name, pulsar_name FROM users WHERE active = true");
    u.rows.forEach(function (r) {
      if (r.name && r.name.trim()) set[r.name.trim()] = true;
      if (r.pulsar_name && r.pulsar_name.trim()) set[r.pulsar_name.trim()] = true;
    });
  } catch (e) { console.error('assignees users query failed:', e.message); }
  try {
    const a = await novaPool.query('SELECT DISTINCT assignee FROM review_assignments');
    a.rows.forEach(function (r) { if (r.assignee && r.assignee.trim()) set[r.assignee.trim()] = true; });
  } catch (e) { console.error('assignees assignment query failed:', e.message); }
  const names = Object.keys(set).sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
  res.json(names);
});

// PUT /api/reviews/assign — manually credit a review to a technician.
// Body: { review_id, assignee }. An empty assignee clears the assignment.
// Manual assignments are marked source='manual' and the AI tally never
// overwrites them.
router.put('/assign', requireAuth, requirePermission('assign_reviews'), async (req, res) => {
  const reviewId = (req.body && req.body.review_id != null) ? String(req.body.review_id).trim() : '';
  const assignee = (req.body && req.body.assignee != null) ? String(req.body.assignee).trim() : '';
  if (!reviewId) return res.status(400).json({ error: 'review_id is required' });
  try {
    if (!assignee) {
      await novaPool.query('DELETE FROM review_assignments WHERE review_id = $1', [reviewId]);
      return res.json({ review_id: reviewId, assignee: null, source: null });
    }
    await novaPool.query(
      "INSERT INTO review_assignments (review_id, assignee, source, assigned_by, updated_at) " +
      "VALUES ($1, $2, 'manual', $3, NOW()) " +
      "ON CONFLICT (review_id) DO UPDATE SET assignee = EXCLUDED.assignee, source = 'manual', " +
      "assigned_by = EXCLUDED.assigned_by, updated_at = NOW()",
      [reviewId, assignee, req.user.id]
    );
    res.json({ review_id: reviewId, assignee: assignee, source: 'manual' });
  } catch (err) {
    console.error('PUT /api/reviews/assign failed:', err.message);
    res.status(500).json({ error: 'Failed to save assignment.' });
  }
});

// POST /api/reviews/tech-tally — within the same filters as the list
// (location, rating, search, from, to), ask Claude to tally how many reviews
// name each technician/employee. Supports the per-review employee incentive.
router.post('/tech-tally', requireAuth, async (req, res) => {
  const rpool = getReviewsPool();
  if (!rpool) return notConfigured(res);
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI is not configured (missing ANTHROPIC_API_KEY).' });
  }
  try {
    const { whereSql, params } = buildReviewFilters(req.body || {});
    const FETCH = 1500; // how many filtered reviews we consider for the counts
    const AICAP = 800;  // how many we will spend AI tokens on in one run
    const sql =
      "SELECT review_id, location_name, review_text FROM reviews " + whereSql +
      " ORDER BY review_date DESC NULLS LAST, id DESC LIMIT " + FETCH;
    const { rows } = await rpool.query(sql, params);

    if (rows.length === 0) {
      return res.json({ technicians: [], unnamed: 0, total: 0, analyzed: 0, written: 0, capped: false });
    }

    // What is already credited (manual or a prior AI run)?
    const existing = await loadAssignments(rows.map(function (r) { return r.review_id; }));

    // AI candidates: have a stable review_id and are NOT manually assigned
    // (we may refresh our own prior AI guesses, but never touch a manual one).
    // Put the not-yet-assigned ones first so one run maximizes new coverage.
    const candidates = rows.filter(function (r) {
      if (!r.review_id) return false;
      const e = existing[r.review_id];
      return !e || e.source === 'ai';
    }).sort(function (a, b) {
      return (existing[a.review_id] ? 1 : 0) - (existing[b.review_id] ? 1 : 0);
    });
    const aiBatch = candidates.slice(0, AICAP);
    const capped = candidates.length > AICAP;

    let written = 0;
    if (aiBatch.length) {
      const list = aiBatch.map(function (r, i) {
        return (i + 1) + '. ' + ((r.review_text || '').replace(/\s+/g, ' ').trim() || '(no comment)');
      }).join('\n');
      const system =
        'You analyze Google reviews for Pop-A-Lock, a mobile locksmith and roadside ' +
        'company. Each review may name the technician/employee who provided service ' +
        '(for example: Austin, Dylan, Scooter, Paris). For EACH numbered review, give ' +
        'the single employee name credited, or null if none is named. Treat obvious ' +
        'nickname and spelling variants as the same canonical name. Respond with ONLY ' +
        'raw JSON, no markdown and no backticks, in exactly this shape: ' +
        '{"names":["Austin",null,"Dylan"]} with exactly one entry per review, in the ' +
        'same order as given.';
      const user = 'Here are ' + aiBatch.length + ' reviews:\n\n' + list;

      const ai = await callClaude(system, user, 4096);
      let text = '';
      try { text = ai.content[0].text; } catch (e) { text = ''; }
      const match = text.match(/\{[\s\S]*\}/);
      let names = [];
      if (match) { try { names = JSON.parse(match[0]).names || []; } catch (e) { names = []; } }
      if (!Array.isArray(names)) names = [];

      // Write each AI name, but never overwrite a manual assignment.
      for (let i = 0; i < aiBatch.length; i++) {
        let nm = names[i];
        nm = (typeof nm === 'string') ? nm.trim() : '';
        if (!nm) continue;
        try {
          await novaPool.query(
            "INSERT INTO review_assignments (review_id, assignee, source, updated_at) " +
            "VALUES ($1, $2, 'ai', NOW()) " +
            "ON CONFLICT (review_id) DO UPDATE SET assignee = EXCLUDED.assignee, source = 'ai', " +
            "updated_at = NOW() WHERE review_assignments.source <> 'manual'",
            [aiBatch[i].review_id, nm]
          );
          written++;
          existing[aiBatch[i].review_id] = { assignee: nm, source: 'ai' };
        } catch (e) { console.error('tally upsert failed:', e.message); }
      }
    }

    // Counts come from the STORED assignments (manual + ai) over the filtered
    // set, so manual fixes and blanks-filled are reflected in the totals.
    const techMap = {};
    let unnamed = 0;
    rows.forEach(function (r) {
      const e = r.review_id ? existing[r.review_id] : null;
      const nm = e && e.assignee ? e.assignee : '';
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
      total: rows.length,
      analyzed: aiBatch.length,
      written: written,
      capped: capped
    });
  } catch (err) {
    console.error('POST /api/reviews/tech-tally failed:', err.message);
    res.status(502).json({ error: 'Tally failed: ' + err.message });
  }
});

module.exports = router;
module.exports.getReviewsPool = getReviewsPool;
