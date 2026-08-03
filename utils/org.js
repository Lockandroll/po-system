// Shared org-scope helpers.
//
// There are TWO different questions in here and they are deliberately not the
// same question. Keep them apart:
//
//   * chainIds / isUpline / downlineIds  -> the REPORTING LINE (users.supervisor_id).
//     Every ACTION gate must keep using these: approving PTO, logging retro PTO,
//     editing a balance, offboarding, onboarding sign-off. Widening an action to
//     city scope hands out authority, which is not what city scope is for.
//
//   * teamIds / inTeam                  -> VISIBILITY only. The reporting downline
//     PLUS everyone based in a city this viewer manages. Read-only rosters use
//     these, so a city manager can see the locksmiths even though those
//     locksmiths report to Russ rather than to the city manager.
//
// Why the split exists (2026-08-03): supervisor_id is one field doing three jobs
// at once (org chart, notification routing, team visibility). The locksmiths
// report to Russ, which is TRUE and which is what routes PTO, late clock-in
// texts and the invoice FYI to him correctly. Re-parenting them under their city
// manager to fix a roster would have silently moved all three of those. So the
// tree stays honest and visibility gets its own second axis.
//
// City rule, from the db.js column comments:
//   users.home_city  = "the employee's base city"        -> what an employee IS
//   user_cities      = "the cities they can view/manage" -> what a viewer OWNS
// We match viewer.user_cities against employee.home_city, and deliberately do
// NOT match employee.user_cities, because two managers who both watch a city
// would otherwise land in each other's team.

const pool = require('../db').pool;

// Cycle/runaway guard for the iterative walks. The recursive CTEs use UNION
// rather than UNION ALL, so a supervisor cycle terminates there on its own.
const MAX_DEPTH = 25;

function idOf(userOrId) {
  if (userOrId === null || userOrId === undefined) return 0;
  if (typeof userOrId === 'object') return parseInt(userOrId.id, 10) || 0;
  return parseInt(userOrId, 10) || 0;
}

function isAdminLike(user) {
  return !!(user && typeof user === 'object' && (user.role === 'admin' || user.isOwner === true));
}

// Ancestors of userId, closest first. Does not include userId.
async function chainIds(userOrId) {
  const start = idOf(userOrId);
  const ids = [];
  if (!start) return ids;
  let cur = start, guard = 0;
  while (cur && guard++ < MAX_DEPTH) {
    const r = await pool.query('SELECT supervisor_id FROM users WHERE id = $1', [cur]);
    if (!r.rows.length || !r.rows[0].supervisor_id) break;
    const sid = parseInt(r.rows[0].supervisor_id, 10) || 0;
    if (!sid || sid === start || ids.indexOf(sid) !== -1) break;
    ids.push(sid);
    cur = sid;
  }
  return ids;
}

// True when managerId sits anywhere ABOVE employeeId in the reporting line.
async function isUpline(managerOrId, employeeOrId) {
  const managerId = idOf(managerOrId), employeeId = idOf(employeeOrId);
  if (!managerId || !employeeId || managerId === employeeId) return false;
  const chain = await chainIds(employeeId);
  return chain.indexOf(managerId) !== -1;
}

// Everyone who rolls up to this person, direct and indirect. Excludes self.
async function downlineIds(managerOrId) {
  const managerId = idOf(managerOrId);
  if (!managerId) return [];
  const r = await pool.query(
    'WITH RECURSIVE dl AS (' +
    '  SELECT id FROM users WHERE supervisor_id = $1' +
    '  UNION' +
    '  SELECT u.id FROM users u JOIN dl ON u.supervisor_id = dl.id' +
    ') SELECT id FROM dl WHERE id <> $1',
    [managerId]
  );
  return r.rows.map(function (x) { return Number(x.id); });
}

// City codes this person views/manages (user_cities), upper-cased and trimmed.
async function cityCodesFor(userOrId) {
  const uid = idOf(userOrId);
  if (!uid) return [];
  const r = await pool.query(
    'SELECT DISTINCT UPPER(TRIM(city_code)) AS code FROM user_cities WHERE user_id = $1 AND city_code IS NOT NULL',
    [uid]
  );
  return r.rows.map(function (x) { return x.code; }).filter(Boolean);
}

// VISIBILITY roster: reporting downline UNION active employees based in a city
// this viewer manages. Excludes self, and never pulls admin/owner into a
// manager's roster (mirrors the existing dashboard/inspections exclusions).
//
// One query on purpose. The old per-row inDownline() loops ran a recursive walk
// for every user in the company; callers should resolve the set once and filter
// in memory.
async function teamIds(userOrId) {
  const uid = idOf(userOrId);
  if (!uid) return [];
  const r = await pool.query(
    'WITH RECURSIVE dl AS (' +
    '  SELECT id FROM users WHERE supervisor_id = $1' +
    '  UNION' +
    '  SELECT u.id FROM users u JOIN dl ON u.supervisor_id = dl.id' +
    '), mycities AS (' +
    '  SELECT DISTINCT UPPER(TRIM(city_code)) AS code FROM user_cities WHERE user_id = $1 AND city_code IS NOT NULL' +
    '), citypeers AS (' +
    '  SELECT u.id FROM users u' +
    '  WHERE u.active IS NOT FALSE' +
    '    AND u.home_city IS NOT NULL' +
    '    AND UPPER(TRIM(u.home_city)) IN (SELECT code FROM mycities)' +
    '    AND (u.role IS NULL OR u.role NOT IN (' + "'admin','owner'" + '))' +
    ') ' +
    'SELECT id FROM dl UNION SELECT id FROM citypeers',
    [uid]
  );
  const out = [];
  for (let i = 0; i < r.rows.length; i++) {
    const id = Number(r.rows[i].id);
    if (id && id !== uid && out.indexOf(id) === -1) out.push(id);
  }
  return out;
}

// Single-target form of teamIds. Admin/owner reach everyone but themselves.
// Do NOT use this to gate an action.
async function inTeam(user, targetOrId) {
  const targetId = idOf(targetOrId), uid = idOf(user);
  if (!targetId || !uid || targetId === uid) return false;
  if (isAdminLike(user)) return true;
  const ids = await teamIds(uid);
  return ids.indexOf(targetId) !== -1;
}

module.exports = {
  MAX_DEPTH: MAX_DEPTH,
  isAdminLike: isAdminLike,
  chainIds: chainIds,
  isUpline: isUpline,
  downlineIds: downlineIds,
  cityCodesFor: cityCodesFor,
  teamIds: teamIds,
  inTeam: inTeam
};
