// PTO schedule markers - which shift_positions rows mean "time off from PTO".
//
// Each marker row is tagged in shift_positions.pto_kind:
//   'paid'   -> Approved Vacation Day
//   'unpaid' -> Unpaid Vacation Day
//   'off'    -> Scheduled Off (a neutral, no-charge day)
//
// Why a tag and not an id or a name (Tony, 2026-09-28): routes/pto.js used to
// hardcode ids 5 and 7. db.js never created those rows, so whether 5 really was
// "Approved Vacation Day" depended on the order rows happened to be inserted in
// production. A name lookup would break the day someone renames the position in
// the Positions manager. The tag is set once by initDB (matched by name, or the
// row is created) and then follows the row whatever it is called.
//
// No backticks in this file (Windows paste hazard, CLAUDE.md 1.1).
const { pool } = require('../db');

const TTL_MS = 60 * 1000;
let _cache = null;
let _at = 0;

async function load() {
  if (_cache && (Date.now() - _at) < TTL_MS) return _cache;
  const r = await pool.query('SELECT id, pto_kind FROM shift_positions WHERE pto_kind IS NOT NULL ORDER BY id ASC');
  const map = { paid: null, unpaid: null, off: null };
  r.rows.forEach(function (row) {
    if (Object.prototype.hasOwnProperty.call(map, row.pto_kind) && map[row.pto_kind] === null) map[row.pto_kind] = Number(row.id);
  });
  _cache = map; _at = Date.now();
  return map;
}

// Position id for a PTO day kind ('paid' | 'unpaid' | 'off'), or null if the
// marker row is missing. Unknown kinds are treated as paid, matching pto.js.
async function posIdFor(kind) {
  const m = await load();
  if (kind === 'unpaid') return m.unpaid;
  if (kind === 'off') return m.off;
  return m.paid;
}

// Every position PTO marks the schedule with (for clearing / flip-guarding).
async function markerIds() {
  const m = await load();
  return [m.paid, m.unpaid, m.off].filter(function (x) { return x !== null; });
}

// Only the two VACATION markers. These are the ones a scheduler may no longer
// paint by hand: a vacation day has to come from PTO so the hours are charged.
// Scheduled Off stays free to use - it is a normal day off, not PTO.
async function vacationIds() {
  const m = await load();
  return [m.paid, m.unpaid].filter(function (x) { return x !== null; });
}

// 'paid' | 'unpaid' if the position is a vacation marker, else null.
async function vacationKindOf(positionId) {
  const id = parseInt(positionId, 10);
  if (!id) return null;
  const m = await load();
  if (m.paid === id) return 'paid';
  if (m.unpaid === id) return 'unpaid';
  return null;
}

function clearCache() { _cache = null; _at = 0; }

module.exports = { posIdFor: posIdFor, markerIds: markerIds, vacationIds: vacationIds, vacationKindOf: vacationKindOf, clearCache: clearCache };
