/*
 * Who may edit a cash deposit.
 * ---------------------------------------------------------------------------
 * Viewing and deleting a deposit are company-wide for a manager. EDITING is
 * not: changing the numbers on a deposit is a correction to another location's
 * books, so a manager is held to the cities they are assigned (user_cities,
 * falling back to users.home_city so a manager with no explicit rows is not
 * locked out). Only admin/owner edit across locations.
 *
 * This lives in utils/ rather than inside routes/deposits.js because the Pulsar
 * reconciliation writes to deposits too (the "Correct Deposit Amount" button)
 * and MUST be held to exactly the same rule. One copy, one place to change it.
 *
 * NOTE: no backtick/template-literal strings anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var { pool } = require('../db');

// Roles allowed to edit at all, before the city question is even asked.
var EDIT_ROLES = ['admin', 'manager'];

// Returns null for "every city", or an array of upper-cased 3-letter codes.
async function editCityScope(req) {
  if (!req || !req.user) return [];
  if (req.user.role === 'admin' || req.user.isOwner) return null;
  var codes = [];
  try {
    const r = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [req.user.id]);
    codes = r.rows.map(function (x) { return (x.city_code || '').trim().toUpperCase(); }).filter(Boolean);
  } catch (e) { codes = []; }
  if (!codes.length) {
    try {
      const h = await pool.query('SELECT home_city FROM users WHERE id = $1', [req.user.id]);
      const hc = h.rows.length && h.rows[0].home_city ? String(h.rows[0].home_city).trim().toUpperCase() : '';
      if (hc) codes.push(hc);
    } catch (e) { /* leave empty */ }
  }
  return codes;
}

// True when this request may act on the given city. Fails CLOSED on a blank
// city: a scoped manager cannot edit a deposit that has no city on it.
function scopeAllows(scope, cityCode) {
  if (scope === null) return true;
  if (!cityCode) return false;
  return scope.indexOf(String(cityCode).trim().toUpperCase()) !== -1;
}

// Role gate + city gate, in that order.
async function mayEditCity(req, cityCode) {
  if (!req || !req.user) return false;
  if (EDIT_ROLES.indexOf(req.user.role) === -1) return false;
  const scope = await editCityScope(req);
  return scopeAllows(scope, cityCode);
}

module.exports = {
  EDIT_ROLES: EDIT_ROLES,
  editCityScope: editCityScope,
  scopeAllows: scopeAllows,
  mayEditCity: mayEditCity
};
