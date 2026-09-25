// Reliability tracker (2026-09-24). Reads the attendance markings already on the
// Schedule (a "position" is a labelled marker on a shift) and turns them into a
// per-person reliability percentage over a rolling window, plus a dated incident
// log for annual reviews. NOTHING new is captured: the numbers are computed live
// from shifts joined to shift_positions.
//
// Model:
//   expected shifts = shifts in range whose position is NOT excluded_from_reliability
//   penalty (points) = SUM(reliability_weight) over those shifts
//   reliability %    = max(0, (expected - penalty) / expected) * 100   (0 if none)
// Off / vacation markers are excluded, so approved time off never moves the number.
// Future-dated shifts never count. Manager / admin / owner only.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Scoring + the role gate live in utils/reliability.js, shared with the
// Reliability card on the personnel file so the two never disagree.
const rel = require('../utils/reliability');
const THRESHOLDS = rel.THRESHOLDS;
const resolveRange = rel.resolveRange;
const pct = rel.pct;
function gate(req, res, next) {
  if (!rel.canSeeReliability(req.user)) return res.status(403).json({ error: 'Managers and up only.' });
  next();
}

// null = every city (admin / owner, or a manager with no explicit assignment);
// otherwise the manager's assigned city codes.
async function allowedCities(user) {
  if (user.role === 'admin') return null;
  const { rows } = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [user.id]);
  if (!rows.length) return null;
  return rows.map(function (r) { return (r.city_code || '').trim(); });
}
function cityOk(scope, code) {
  if (scope === null) return true;
  return scope.indexOf((code || '').trim()) !== -1;
}
// ---- roster summary --------------------------------------------------------
router.get('/summary', requireAuth, gate, async (req, res) => {
  try {
    var range = resolveRange(req.query);
    var scope = await allowedCities(req.user);
    // ?include_former=1 adds deactivated employees, so a fired tech's history
    // stays reachable (separation paperwork, unemployment claims). Tony 2026-09-24.
    var includeFormer = req.query.include_former === '1' || req.query.include_former === 'true';

    // per-employee expected count + weighted penalty (excluded positions dropped)
    var stats = await pool.query(
      'SELECT s.user_id, ' +
      '  COUNT(*)::int AS expected, ' +
      '  COALESCE(SUM(p.reliability_weight), 0)::float AS penalty ' +
      'FROM shifts s JOIN shift_positions p ON p.id = s.position_id ' +
      'WHERE s.shift_date BETWEEN $1 AND $2 AND s.shift_date <= $3 ' +
      '  AND p.excluded_from_reliability = false ' +
      'GROUP BY s.user_id',
      [range.from, range.to, range.today]
    );
    // per-employee per-position incident counts (weighted positions only)
    var counts = await pool.query(
      'SELECT s.user_id, s.position_id, COUNT(*)::int AS cnt ' +
      'FROM shifts s JOIN shift_positions p ON p.id = s.position_id ' +
      'WHERE s.shift_date BETWEEN $1 AND $2 AND s.shift_date <= $3 ' +
      '  AND p.excluded_from_reliability = false AND p.reliability_weight > 0 ' +
      'GROUP BY s.user_id, s.position_id',
      [range.from, range.to, range.today]
    );
    // the weighted positions themselves, so the client can build one column each
    var posRows = await pool.query(
      "SELECT id, name, color, reliability_weight::float AS weight FROM shift_positions " +
      "WHERE excluded_from_reliability = false AND reliability_weight > 0 " +
      "ORDER BY reliability_weight DESC, name ASC"
    );
    var users = await pool.query(
      'SELECT u.id, u.name, u.role, u.title, u.home_city, u.active, c.name AS city_name ' +
      'FROM users u LEFT JOIN cities c ON c.code = u.home_city' +
      (includeFormer ? '' : ' WHERE u.active = true')
    );

    var statById = {};
    stats.rows.forEach(function (r) { statById[r.user_id] = r; });
    var countsById = {};
    counts.rows.forEach(function (r) {
      (countsById[r.user_id] = countsById[r.user_id] || {})[r.position_id] = r.cnt;
    });

    var rows = [];
    users.rows.forEach(function (u) {
      var st = statById[u.id];
      if (!st || !st.expected) return;               // nobody with no expected shifts
      if (!cityOk(scope, u.home_city)) return;       // manager city scope
      var points = Math.round(st.penalty * 100) / 100;
      rows.push({
        user_id: u.id,
        name: u.name,
        role: u.role,
        title: u.title || null,
        home_city: u.home_city || null,
        city_name: u.city_name || (u.home_city || ''),
        former: u.active === false,
        expected: st.expected,
        points: points,
        reliability: pct(st.expected, st.penalty),
        counts: countsById[u.id] || {}
      });
    });
    rows.sort(function (a, b) {
      if (a.reliability == null) return 1;
      if (b.reliability == null) return -1;
      return a.reliability - b.reliability;      // worst first
    });

    // Tiles are CURRENT staff only, even with former employees listed, so a
    // fired tech never drags the team average or the review count.
    var scored = rows.filter(function (r) { return r.reliability != null && !r.former; });
    var teamAvg = scored.length
      ? Math.round((scored.reduce(function (s, r) { return s + r.reliability; }, 0) / scored.length) * 10) / 10
      : null;
    var belowAmber = scored.filter(function (r) { return r.reliability < THRESHOLDS.amber; }).length;

    res.json({
      range: range,
      thresholds: THRESHOLDS,
      positions: posRows.rows.map(function (p) { return { id: p.id, name: p.name, color: p.color, weight: p.weight }; }),
      team_avg: teamAvg,
      below_count: belowAmber,
      people: rows.filter(function (r) { return !r.former; }).length,
      former_count: rows.filter(function (r) { return r.former; }).length,
      include_former: includeFormer,
      rows: rows
    });
  } catch (e) {
    console.error('[reliability] summary failed:', e && e.message);
    res.status(500).json({ error: 'Could not load reliability.' });
  }
});

// ---- one employee: score + dated incident log -----------------------------
router.get('/user/:id', requireAuth, gate, async (req, res) => {
  try {
    var id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Bad employee id.' });
    var range = resolveRange(req.query);
    var scope = await allowedCities(req.user);

    var uq = await pool.query(
      'SELECT u.id, u.name, u.role, u.title, u.home_city, u.active, c.name AS city_name ' +
      'FROM users u LEFT JOIN cities c ON c.code = u.home_city WHERE u.id = $1',
      [id]
    );
    if (!uq.rows.length) return res.status(404).json({ error: 'Employee not found.' });
    var u = uq.rows[0];
    if (!cityOk(scope, u.home_city)) return res.status(403).json({ error: 'Outside your cities.' });

    var r = await rel.userReliability(id, range);
    r.user = { id: u.id, name: u.name, role: u.role, title: u.title || null, city_name: u.city_name || (u.home_city || ''), former: u.active === false };
    res.json(r);
  } catch (e) {
    console.error('[reliability] user detail failed:', e && e.message);
    res.status(500).json({ error: 'Could not load employee reliability.' });
  }
});

module.exports = router;
