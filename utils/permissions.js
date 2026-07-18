const crypto = require('crypto');
const { pool } = require('../db');

// Central role-based access control.
// Permissions are stored in settings under key 'role_permissions' as JSON:
//   { "manager": ["view_users", ...], "approver": [...], "requester": [...] }
// The admin role ALWAYS has every permission and cannot be restricted.
// When a role has no configured entry, the DEFAULTS below apply — these mirror
// the app's original hard-coded requireRole behavior, so nothing changes until
// an admin edits the matrix.

var ALL_PERMS = [
  'approve_po',       // approve / reject purchase orders
  'cancel_po',        // cancel purchase orders
  'approve_vr',       // approve / reject vehicle repairs
  'manage_vehicles',  // fleet registry
  'manage_vendors',   // vendors / accounts
  'manage_addresses', // shipping addresses
  'manage_cities',    // cities
  'manage_running',   // monthly requisition (admin list / create-po)
  'manage_geico',     // geico surveys
  'view_users',       // view the user list
  'manage_users',     // add / edit / deactivate / delete users
  'manage_settings',  // company info, AI context, notifications, roles
  'view_audit',       // audit log
  'view_ai_admin',    // AI conversation history / usage
  'view_pos', 'create_po', 'edit_po', 'delete_po', 'submit_po',
  'view_quotes', 'create_quote', 'edit_quote', 'delete_quote', 'push_quote_po',
  'view_vr', 'create_vr', 'edit_vr', 'delete_vr', 'submit_vr',
  'view_deposits', 'create_deposit', 'delete_deposit', 'export_deposits',
  'view_signoffs', 'create_signoff', 'edit_signoff', 'complete_signoff', 'delete_signoff'
];

var EMPLOYEE_PERMS = [
  'view_pos', 'create_po', 'edit_po', 'delete_po', 'submit_po',
  'view_quotes', 'create_quote', 'edit_quote', 'delete_quote', 'push_quote_po',
  'view_vr', 'create_vr', 'edit_vr', 'delete_vr', 'submit_vr',
  'view_deposits', 'create_deposit', 'delete_deposit', 'export_deposits',
  'view_signoffs', 'create_signoff', 'edit_signoff', 'complete_signoff', 'delete_signoff'
];
EMPLOYEE_PERMS.push('view_tasks');
ALL_PERMS.push('view_tasks', 'manage_tasks');
EMPLOYEE_PERMS.push('view_work_orders');
ALL_PERMS.push('view_work_orders', 'manage_work_orders');
EMPLOYEE_PERMS.push('view_schedule');
ALL_PERMS.push('view_schedule', 'manage_schedule');
ALL_PERMS.push('manage_parts');
EMPLOYEE_PERMS.push('view_invoices', 'create_invoice', 'edit_invoice', 'delete_invoice');
ALL_PERMS.push('view_invoices', 'create_invoice', 'edit_invoice', 'delete_invoice', 'manage_invoice_setup');
ALL_PERMS.push('assign_reviews');  // credit Google reviews to a technician
ALL_PERMS.push('view_vendors');  // accounts: read-only access (credentials hidden)
ALL_PERMS.push('view_feedback', 'manage_feedback');  // customer feedback module
ALL_PERMS.push('view_signatures', 'manage_signatures');  // e-signature module
EMPLOYEE_PERMS.push('view_signatures');
EMPLOYEE_PERMS.push('view_timeclock');  // punch + own timesheet
ALL_PERMS.push('view_timeclock', 'manage_timeclock');  // time clock module
EMPLOYEE_PERMS.push('view_pto');                        // view + request own PTO
ALL_PERMS.push('view_pto', 'manage_pto');               // time off module
ALL_PERMS.push('view_quiz', 'manage_quiz');             // SOP quiz module
ALL_PERMS.push('view_team_quiz');                       // SOP quiz: scoped team visibility for managers
ALL_PERMS.push('manage_onboarding');                    // new-hire onboarding module
EMPLOYEE_PERMS.push('view_inspections');                // monthly vehicle inspections (own vehicle)
ALL_PERMS.push('view_inspections', 'manage_inspections'); // vehicle inspections module
EMPLOYEE_PERMS.push('view_ptt');                        // PTT radio: own city channels + All Hands
EMPLOYEE_PERMS.push('ptt_direct');                      // person-to-person direct talk
ALL_PERMS.push('view_ptt', 'ptt_all_channels', 'ptt_direct');
ALL_PERMS.push('view_royalty', 'manage_royalty');       // royalty statements module

var DEFAULTS = {
  admin: '*',
  manager: ['view_users', 'manage_cities', 'manage_geico', 'manage_running', 'manage_vehicles', 'manage_vendors', 'view_vendors', 'manage_addresses', 'approve_vr', 'manage_tasks', 'manage_work_orders', 'manage_schedule', 'manage_parts', 'manage_invoice_setup', 'assign_reviews', 'view_feedback', 'manage_feedback', 'manage_signatures', 'manage_timeclock', 'manage_pto', 'view_quiz', 'manage_quiz', 'view_team_quiz', 'manage_onboarding', 'manage_inspections', 'ptt_all_channels'].concat(EMPLOYEE_PERMS),
  locksmith: EMPLOYEE_PERMS.slice(),
  locksmith_coordinator: EMPLOYEE_PERMS.concat(['manage_work_orders', 'ptt_all_channels']),
  dispatcher: EMPLOYEE_PERMS.concat(['manage_work_orders', 'ptt_all_channels']),
  roadside_technician: EMPLOYEE_PERMS.slice()
};

var cache = null;
var cacheValid = false;
var cacheAt = 0;
var TTL_MS = 15000;
// Fingerprint of the currently cached role_permissions matrix. Recomputed only when
// the cache is refreshed (at most once per TTL), not on every permission check.
var cfgRev = '0';

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
}

async function getRolePerms() {
  if (cacheValid && (Date.now() - cacheAt) < TTL_MS) return cache;
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'role_permissions'");
    if (rows.length && rows[0].value) {
      const parsed = JSON.parse(rows[0].value);
      if (parsed && typeof parsed === 'object') {
        cache = parsed;
        cacheAt = Date.now();
        cacheValid = true;
        cfgRev = shortHash(rows[0].value);
        return parsed;
      }
    }
    // No valid config — cache the empty result so we don't re-query on every check.
    cache = null;
    cacheAt = Date.now();
    cacheValid = true;
    cfgRev = '0';
    return null;
  } catch (e) {
    console.error('Failed to load role_permissions:', e.message);
    return null;
  }
}

// A short fingerprint of everything the CLIENT's can() depends on for this user:
// their role, their per-user extra_perms, whether they are still active, and the
// global role_permissions matrix. Sent to the browser as X-Perms-Rev on every
// authenticated response. When it changes, the client knows its cached permissions
// are stale and refetches them — no logout or page reload required.
async function permsRev(user) {
  await getRolePerms(); // ensures cfgRev reflects the current matrix
  const role = (user && user.role) || '';
  const ep = (user && Array.isArray(user.extra_perms)) ? user.extra_perms.slice().sort().join('|') : '';
  const active = (user && user.active === false) ? '0' : '1';
  return shortHash(role + '~' + ep + '~' + active + '~' + cfgRev);
}

// Synchronous default check (used as a safe fallback).
function defaultHas(role, perm) {
  if (role === 'admin' || role === 'owner') return true;
  const d = DEFAULTS[role];
  return Array.isArray(d) && d.indexOf(perm) !== -1;
}

// Authoritative async check: admin always allowed; otherwise use the configured
// matrix for that role if present, else fall back to defaults.
async function hasPermission(role, perm) {
  if (role === 'admin' || role === 'owner') return true;
  const cfg = await getRolePerms();
  if (cfg && Array.isArray(cfg[role])) return cfg[role].indexOf(perm) !== -1;
  return defaultHas(role, perm);
}

module.exports = {
  ALL_PERMS: ALL_PERMS,
  DEFAULTS: DEFAULTS,
  getRolePerms: getRolePerms,
  defaultHas: defaultHas,
  hasPermission: hasPermission,
  permsRev: permsRev
};
