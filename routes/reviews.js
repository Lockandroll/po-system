const express = require('express');
const https = require('https');
const { Pool } = require('pg');
const { pool: novaPool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Load Nova-owned review assignments for a set of Google review_ids.
// Returns a map: review_id -> { assignee, source, user_id, confidence }.
// Never throws — if the table or the main pool is unavailable, callers just
// get an empty map.
async function loadAssignments(ids) {
  const map = {};
  const clean = (ids || []).filter(Boolean);
  if (!clean.length) return map;
  try {
    const { rows } = await novaPool.query(
      'SELECT review_id, assignee, source, user_id, confidence FROM review_assignments WHERE review_id = ANY($1)',
      [clean]
    );
    rows.forEach(function (r) { map[r.review_id] = { assignee: r.assignee, source: r.source, user_id: r.user_id, confidence: r.confidence }; });
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
      r.assignee_user_id = a ? a.user_id : null;
      r.assignee_confidence = a ? a.confidence : null;
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

// GET /api/reviews/assignees — the people picker for "Assigned To".
// REAL Nova users only (active first; former employees included because older
// reviews still credit them). Every manual assignment must link to a user id —
// unmatched AI guesses are displayed as estimates but are never offered here.
router.get('/assignees', requireAuth, async (req, res) => {
  try {
    const { rows } = await novaPool.query(
      'SELECT id, name, nickname, active FROM users ORDER BY active DESC, name ASC'
    );
    res.json(rows);
  } catch (e) {
    console.error('assignees query failed:', e.message);
    res.json([]);
  }
});

// PUT /api/reviews/assign — manually credit a review to a real Nova user.
// Body: { review_id, user_id }. A null/empty user_id clears the assignment.
// Manual assignments are marked source='manual' and the AI tally never
// overwrites them.
router.put('/assign', requireAuth, requirePermission('assign_reviews'), async (req, res) => {
  const reviewId = (req.body && req.body.review_id != null) ? String(req.body.review_id).trim() : '';
  const userId = parseInt(req.body && req.body.user_id, 10);
  if (!reviewId) return res.status(400).json({ error: 'review_id is required' });
  try {
    if (!userId || isNaN(userId)) {
      await novaPool.query('DELETE FROM review_assignments WHERE review_id = $1', [reviewId]);
      return res.json({ review_id: reviewId, assignee: null, user_id: null, source: null });
    }
    const u = await novaPool.query('SELECT id, name FROM users WHERE id = $1', [userId]);
    if (!u.rows[0]) return res.status(400).json({ error: 'That user does not exist.' });
    await novaPool.query(
      "INSERT INTO review_assignments (review_id, assignee, user_id, confidence, source, assigned_by, updated_at) " +
      "VALUES ($1, $2, $3, NULL, 'manual', $4, NOW()) " +
      "ON CONFLICT (review_id) DO UPDATE SET assignee = EXCLUDED.assignee, user_id = EXCLUDED.user_id, " +
      "confidence = NULL, source = 'manual', assigned_by = EXCLUDED.assigned_by, updated_at = NOW()",
      [reviewId, u.rows[0].name, userId, req.user.id]
    );
    res.json({ review_id: reviewId, assignee: u.rows[0].name, user_id: userId, source: 'manual' });
  } catch (err) {
    console.error('PUT /api/reviews/assign failed:', err.message);
    res.status(500).json({ error: 'Failed to save assignment.' });
  }
});

// POST /api/reviews/tech-tally — within the same filters as the list
// (location, rating, search, from, to), ask Claude to credit each review to an
// employee. The AI extracts the name from the review text and matches it
// against the REAL user roster (full name, nickname(s), dispatch/pulsar name).
// A match at MATCH_MIN%+ confidence is hard-linked (user_id + canonical name);
// anything weaker is stored as an unmatched guess (user_id NULL) that the UI
// shows as an estimate but never offers as a selectable choice.
router.post('/tech-tally', requireAuth, async (req, res) => {
  const rpool = getReviewsPool();
  if (!rpool) return notConfigured(res);
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI is not configured (missing ANTHROPIC_API_KEY).' });
  }
  try {
    const { whereSql, params } = buildReviewFilters(req.body || {});
    const FETCH = 1500;     // how many filtered reviews we consider for the counts
    const AICAP = 800;      // how many we will spend AI tokens on in one run
    const CHUNK = 200;      // reviews per AI call (keeps each JSON reply small and parseable)
    const MATCH_MIN = 85;   // % confidence required to hard-link a roster user
    const sql =
      "SELECT review_id, location_name, review_text FROM reviews " + whereSql +
      " ORDER BY review_date DESC NULLS LAST, id DESC LIMIT " + FETCH;
    const { rows } = await rpool.query(sql, params);

    if (rows.length === 0) {
      return res.json({ technicians: [], unnamed: 0, total: 0, analyzed: 0, written: 0, linked: 0, capped: false });
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
    let linked = 0;
    if (aiBatch.length) {
      // The roster the AI matches against — real Nova users, including former
      // employees (their names still appear on older reviews).
      const rosterRes = await novaPool.query(
        'SELECT id, name, nickname, pulsar_name FROM users ORDER BY active DESC, name ASC'
      );
      const rosterById = {};
      rosterRes.rows.forEach(function (u) { rosterById[u.id] = u; });
      const rosterLines = rosterRes.rows.map(function (u) {
        return u.id + ' | ' + (u.name || '-') + ' | ' + (u.nickname || '-') + ' | ' + (u.pulsar_name || '-');
      }).join('\n');
      const system =
        'You analyze Google reviews for Pop-A-Lock, a mobile locksmith and roadside ' +
        'company. Below is the employee roster, one person per line, formatted as: ' +
        'id | full name | nickname(s) | dispatch name\n\n' + rosterLines + '\n\n' +
        'For EACH numbered review: extract the single employee name the customer ' +
        'credits for the service (null if no employee is named). Then decide which ' +
        'roster person that name most likely refers to — consider first names, ' +
        'nicknames, dispatch names, and obvious spelling variants — and rate your ' +
        'confidence 0-100 that it is the right person (use null and 0 when nothing ' +
        'plausibly matches). Respond with ONLY raw JSON, no markdown and no ' +
        'backticks, in exactly this shape: {"results":[["Kevin",12,95],[null,null,0]]} ' +
        '— one [extracted_name, roster_id_or_null, confidence] triple per review, in ' +
        'the same order as given.';

      for (let off = 0; off < aiBatch.length; off += CHUNK) {
        const chunk = aiBatch.slice(off, off + CHUNK);
        const list = chunk.map(function (r, i) {
          return (i + 1) + '. ' + ((r.review_text || '').replace(/\s+/g, ' ').trim() || '(no comment)');
        }).join('\n');
        const ai = await callClaude(system, 'Here are ' + chunk.length + ' reviews:\n\n' + list, 8192);
        let text = '';
        try { text = ai.content[0].text; } catch (e) { text = ''; }
        const match = text.match(/\{[\s\S]*\}/);
        let results = [];
        if (match) { try { results = JSON.parse(match[0]).results || []; } catch (e) { results = []; } }
        if (!Array.isArray(results)) results = [];

        // Write each result, but never overwrite a manual assignment.
        for (let i = 0; i < chunk.length; i++) {
          const trip = Array.isArray(results[i]) ? results[i] : [null, null, 0];
          let nm = (typeof trip[0] === 'string') ? trip[0].trim() : '';
          const uid = parseInt(trip[1], 10);
          let conf = parseInt(trip[2], 10);
          if (isNaN(conf)) conf = null; else conf = Math.max(0, Math.min(100, conf));
          const user = (!isNaN(uid) && rosterById[uid]) ? rosterById[uid] : null;
          const isLinked = !!(user && conf != null && conf >= MATCH_MIN);
          if (isLinked) nm = user.name; // store the canonical user name
          if (!nm) continue;            // nobody named — leave unassigned
          try {
            await novaPool.query(
              "INSERT INTO review_assignments (review_id, assignee, user_id, confidence, source, updated_at) " +
              "VALUES ($1, $2, $3, $4, 'ai', NOW()) " +
              "ON CONFLICT (review_id) DO UPDATE SET assignee = EXCLUDED.assignee, user_id = EXCLUDED.user_id, " +
              "confidence = EXCLUDED.confidence, source = 'ai', updated_at = NOW() " +
              "WHERE review_assignments.source <> 'manual'",
              [chunk[i].review_id, nm, isLinked ? user.id : null, conf]
            );
            written++;
            if (isLinked) linked++;
            existing[chunk[i].review_id] = { assignee: nm, source: 'ai', user_id: isLinked ? user.id : null, confidence: conf };
          } catch (e) { console.error('tally upsert failed:', e.message); }
        }
      }
    }

    // Counts come from the STORED assignments (manual + ai) over the filtered
    // set, so manual fixes and blanks-filled are reflected in the totals.
    // Linked assignments group by user id (canonical name); unmatched guesses
    // group by the raw guessed name and are flagged matched:false.
    const techMap = {};
    let unnamed = 0;
    rows.forEach(function (r) {
      const e = r.review_id ? existing[r.review_id] : null;
      const nm = e && e.assignee ? e.assignee : '';
      if (!nm) { unnamed++; return; }
      const key = (e.user_id ? ('u' + e.user_id) : ('n' + nm.toLowerCase()));
      if (!techMap[key]) techMap[key] = { name: nm, matched: !!e.user_id, count: 0, cities: {} };
      techMap[key].count++;
      const city = r.location_name || '—';
      techMap[key].cities[city] = (techMap[key].cities[city] || 0) + 1;
    });

    const technicians = Object.keys(techMap).map(function (k) {
      const t = techMap[k];
      let topCity = '—', topN = -1;
      Object.keys(t.cities).forEach(function (c) {
        if (t.cities[c] > topN) { topN = t.cities[c]; topCity = c; }
      });
      return { name: t.name, matched: t.matched, location: topCity, multiCity: Object.keys(t.cities).length > 1, count: t.count };
    }).sort(function (a, b) { return b.count - a.count; });

    res.json({
      technicians: technicians,
      unnamed: unnamed,
      total: rows.length,
      analyzed: aiBatch.length,
      written: written,
      linked: linked,
      capped: capped
    });
  } catch (err) {
    console.error('POST /api/reviews/tech-tally failed:', err.message);
    res.status(502).json({ error: 'Tally failed: ' + err.message });
  }
});

module.exports = router;
module.exports.getReviewsPool = getReviewsPool;
