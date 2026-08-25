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

// The manager of a city: ONE responsible name per city code, for the places that
// need a single owner rather than a roster (vehicle inspections today).
//
// Candidates are active managers/admins/owners who watch the city in user_cities.
// A plain manager deliberately outranks an admin or owner here - admins watch
// every city, so picking by rank would hand every city to the same person. Ties
// break toward whoever watches the FEWEST cities (the most dedicated to this one),
// then the lowest id, so the answer is stable instead of whatever Postgres happens
// to return first. Returns { CITYCODE: userRow } keyed by upper-cased code.
async function cityManagerMap() {
  const { rows } = await pool.query(
    'SELECT DISTINCT ON (uc.code) uc.code, u.id, u.name, u.email, u.phone, u.role, ' +
    '       u.receive_emails, u.receive_sms ' +
    'FROM (SELECT user_id, UPPER(TRIM(city_code)) AS code FROM user_cities WHERE city_code IS NOT NULL) uc ' +
    'JOIN users u ON u.id = uc.user_id ' +
    "WHERE u.active = true AND u.role IN ('manager','admin','owner') " +
    'ORDER BY uc.code, ' +
    "         CASE u.role WHEN 'manager' THEN 0 ELSE 1 END, " +
    '         (SELECT COUNT(*) FROM user_cities c2 WHERE c2.user_id = u.id), ' +
    '         u.id'
  );
  const map = {};
  rows.forEach(function (r) { map[r.code] = r; });
  return map;
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

// ---------------------------------------------------------------------------
// PERSONNEL FILE ACCESS
//
// A third question, separate again from the two above, and the strictest of the
// three: who may OPEN somebody's personnel file.
//
// Scope answers "is this person in my part of the company". It is not enough on
// its own, because it says nothing about rank. Without the rule below, two
// admins can read each other's disciplinary history and two managers in the
// same city can read each other's, which is not what a personnel file is for.
// Tony's requirement, 2026-08-21: "I just want to make sure that no one can open
// up another peer's employee file. Even admin to admin."
//
// So a file may only be opened by somebody STRICTLY ABOVE the person it belongs
// to. Equal rank is refused, which blocks peers and, because your supervisor is
// never below you, blocks your upline at the same time. Nobody opens their own
// file here either - that is My File, which shows what was shared with them
// rather than the manager's view of it.
//
// Owner sits at the top because somebody has to. Two owners cannot read each
// other, by the same rule.
var RANK = { owner: 4, admin: 3, manager: 2 };

// Works for a req.user (where an owner has been coerced to role 'admin' with
// isOwner set - see middleware/auth.js) and for a raw users row alike.
function rankOf(u) {
  if (!u) return 0;
  if (u.isOwner === true) return RANK.owner;
  return RANK[u.role] || 1;
}

// viewer: req.user. target: a users row, or at minimum { id, role }.
// Returns false rather than throwing on anything unexpected.
async function canOpenFile(viewer, target) {
  if (!viewer || !target) return false;
  var vid = idOf(viewer), tid = idOf(target);
  if (!vid || !tid) return false;
  if (vid === tid) return false;                       // your own file is My File
  if (rankOf(viewer) <= rankOf(target)) return false;  // peers and upline
  if (isAdminLike(viewer)) return true;                // admin and owner reach the company
  return await inTeam(viewer, tid);                    // everyone else: city + downline
}

// The same rule expressed as a filter, for building a roster in one pass rather
// than a query per person.
function filterOpenable(viewer, rows) {
  var vid = idOf(viewer), vr = rankOf(viewer);
  return (rows || []).filter(function (r) {
    return r && Number(r.id) !== vid && vr > rankOf(r);
  });
}

module.exports = {
  MAX_DEPTH: MAX_DEPTH,
  RANK: RANK,
  rankOf: rankOf,
  canOpenFile: canOpenFile,
  filterOpenable: filterOpenable,
  isAdminLike: isAdminLike,
  chainIds: chainIds,
  isUpline: isUpline,
  downlineIds: downlineIds,
  cityCodesFor: cityCodesFor,
  cityManagerMap: cityManagerMap,
  teamIds: teamIds,
  inTeam: inTeam
};
