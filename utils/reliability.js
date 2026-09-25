// Reliability scoring, shared by routes/reliability.js (the dashboard) and
// routes/employeeRecords.js (the Reliability card on a personnel file), so the
// two can never disagree about a number. Computed live from shifts joined to
// shift_positions; nothing is stored.
//
//   expected shifts = shifts in range whose position is NOT excluded_from_reliability
//   penalty (points) = SUM(reliability_weight) over those shifts
//   reliability %    = max(0, (expected - penalty) / expected) * 100
//
// No backticks in this file (Windows corrupts them in .js).

const { pool } = require('../db');

// Bands are read the same way everywhere; returned to clients so they can't drift.
const THRESHOLDS = { green: 97, amber: 90 };

// Gated by ROLE, not a handable permission, so the view never travels if some
// schedule permission is handed to another role.
const MGR_ROLES = ['manager', 'admin'];
function canSeeReliability(u) {
  return !!u && (u.isOwner === true || MGR_ROLES.indexOf(u.role) !== -1);
}

function todayLocal() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Resolve the window. Defaults to the last 6 months ending today. `to` is never
// allowed past today, so future scheduled shifts can't inflate the denominator.
function resolveRange(q) {
  var today = todayLocal();
  var to = (q && RE_DATE.test(q.to)) ? q.to : today;
  if (to > today) to = today;
  var from;
  if (q && RE_DATE.test(q.from)) {
    from = q.from;
  } else {
    var parts = to.split('-').map(Number);
    var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    dt.setUTCMonth(dt.getUTCMonth() - 6);
    from = dt.toISOString().slice(0, 10);
  }
  if (from > to) from = to;
  return { from: from, to: to, today: today };
}

function pct(expected, penalty) {
  if (!expected) return null;
  var v = ((expected - penalty) / expected) * 100;
  if (v < 0) v = 0;
  return Math.round(v * 10) / 10;
}

// One person's score + dated incident log over a resolved range.
async function userReliability(userId, range) {
  var st = await pool.query(
    'SELECT COUNT(*)::int AS expected, COALESCE(SUM(p.reliability_weight),0)::float AS penalty ' +
    'FROM shifts s JOIN shift_positions p ON p.id = s.position_id ' +
    'WHERE s.user_id = $1 AND s.shift_date BETWEEN $2 AND $3 AND s.shift_date <= $4 ' +
    '  AND p.excluded_from_reliability = false',
    [userId, range.from, range.to, range.today]
  );
  var expected = st.rows[0].expected;
  var penalty = st.rows[0].penalty;
  var inc = await pool.query(
    "SELECT to_char(s.shift_date,'YYYY-MM-DD') AS date, to_char(s.shift_date,'Dy') AS dow, " +
    "  p.name AS position_name, p.color AS color, p.reliability_weight::float AS weight, s.manager_notes " +
    'FROM shifts s JOIN shift_positions p ON p.id = s.position_id ' +
    'WHERE s.user_id = $1 AND s.shift_date BETWEEN $2 AND $3 AND s.shift_date <= $4 ' +
    '  AND p.excluded_from_reliability = false AND p.reliability_weight > 0 ' +
    'ORDER BY s.shift_date DESC, p.name ASC',
    [userId, range.from, range.to, range.today]
  );
  return {
    range: range,
    thresholds: THRESHOLDS,
    expected: expected,
    points: Math.round(penalty * 100) / 100,
    reliability: pct(expected, penalty),
    incidents: inc.rows
  };
}

module.exports = {
  THRESHOLDS: THRESHOLDS,
  canSeeReliability: canSeeReliability,
  resolveRange: resolveRange,
  pct: pct,
  userReliability: userReliability
};
