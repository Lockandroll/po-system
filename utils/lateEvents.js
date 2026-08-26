/*
 * Late deposits, counted once, from the two shapes they come in.
 * ---------------------------------------------------------------------------
 * A late deposit used to be one thing: a deposits row with is_late = true. That
 * covers every case except the worst one - the technician who never submitted a
 * deposit at all. There is no row to write the flag onto, so the pay week is
 * recorded in deposit_missed instead (see db.js), keyed by person and period.
 *
 * Both are the same fact to everybody who reads them: the money did not arrive
 * when it was supposed to. "How many times has he been late?" is the question a
 * write-up is answering, and an answer split across two numbers is how a
 * write-up ends up wrong. So every count, ranking, drill-down and employee file
 * reads THIS union and nothing else.
 *
 * The dedup rule matters. A week marked missed can later receive its deposit,
 * and a manager can mark that deposit late too. Tony's call: the mark stays -
 * it was late - but the week must only ever count ONCE, so a missed mark stops
 * counting the moment a late deposit exists for the same person and week. The
 * deposit is the better record when there is one.
 *
 * NOTE: no backtick/template-literal strings anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var { pool } = require('../db');

// Every late deposit, before deposit_missed exists. Also the fallback on a
// deployment where the migration has not landed: a missing table must not take
// the employee file or the deposits page down with it.
var DEPOSITS_ONLY =
  '(SELECT d.user_id AS user_id, d.user_name AS user_name, d.city_code AS city_code, ' +
  '        d.deposit_date AS late_date, d.id AS deposit_id, d.deposit_number AS deposit_number, ' +
  '        d.amount AS amount, d.period_start AS period_start, NULL::date AS period_end, ' +
  '        d.late_marked_at AS marked_at, d.late_marked_by_name AS marked_by_name, ' +
  '        d.late_reason AS reason, false AS missed ' +
  '   FROM deposits d WHERE d.is_late = true)';

// The same, plus a row for every pay week where nothing was submitted at all.
// A missed week is dated by the END of its pay period - the day the deposit was
// due is the only date it has, and it is the one that belongs in a 12-month
// window.
var WITH_MISSED =
  '(SELECT d.user_id AS user_id, d.user_name AS user_name, d.city_code AS city_code, ' +
  '        d.deposit_date AS late_date, d.id AS deposit_id, d.deposit_number AS deposit_number, ' +
  '        d.amount AS amount, d.period_start AS period_start, NULL::date AS period_end, ' +
  '        d.late_marked_at AS marked_at, d.late_marked_by_name AS marked_by_name, ' +
  '        d.late_reason AS reason, false AS missed ' +
  '   FROM deposits d WHERE d.is_late = true ' +
  '  UNION ALL ' +
  ' SELECT m.user_id, m.user_name, m.city_code, ' +
  '        COALESCE(m.period_end, m.period_start + 6) AS late_date, NULL::integer, NULL::varchar, ' +
  '        m.pulsar_cash, m.period_start, m.period_end, ' +
  '        m.marked_at, m.marked_by_name, m.reason, true ' +
  '   FROM deposit_missed m ' +
  '  WHERE NOT EXISTS (SELECT 1 FROM deposits d2 ' +
  '                     WHERE d2.user_id = m.user_id AND d2.period_start = m.period_start ' +
  '                       AND d2.is_late = true))';

// Whether deposit_missed is there yet. A positive answer never changes, so it
// is cached for good; a negative one is re-asked now and then, because the
// migration lands at boot and this module may have been asked first.
var _has = false;
var _askedAt = 0;
var RECHECK_MS = 60 * 1000;

async function hasMissedTable() {
  if (_has) return true;
  var now = Date.now();
  if (_askedAt && (now - _askedAt) < RECHECK_MS) return false;
  _askedAt = now;
  try {
    const r = await pool.query("SELECT to_regclass('public.deposit_missed') AS t");
    _has = !!(r.rows.length && r.rows[0].t);
  } catch (e) {
    _has = false;
  }
  return _has;
}

// The derived table to select FROM. Alias it yourself:
//   'SELECT ... FROM ' + (await lateEvents()) + ' d WHERE d.user_id = $1'
async function lateEvents() {
  return (await hasMissedTable()) ? WITH_MISSED : DEPOSITS_ONLY;
}

// How many times this person has been late in the last N months, missed weeks
// included. Handed straight back by the two marking endpoints so a button can
// say the number without a second round trip.
async function lateCount(userId, months) {
  months = months || 12;
  try {
    const c = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ' + (await lateEvents()) + ' d ' +
      "WHERE d.user_id = $1 AND d.late_date > CURRENT_DATE - ($2 || ' months')::interval",
      [userId, String(months)]
    );
    return c.rows.length ? c.rows[0].n : 0;
  } catch (e) {
    return 0;
  }
}

module.exports = { lateEvents: lateEvents, lateCount: lateCount, hasMissedTable: hasMissedTable };
