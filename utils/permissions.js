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
// Refunds: whoever can write an invoice can ASK for a refund on it; approving
// one is a manager-and-up decision (see routes/refunds.js).
EMPLOYEE_PERMS.push('request_refund');
ALL_PERMS.push('request_refund', 'approve_refund');
ALL_PERMS.push('assign_reviews');  // credit Google reviews to a technician
ALL_PERMS.push('view_vendors');  // accounts: read-only access (credentials hidden)
ALL_PERMS.push('view_feedback', 'manage_feedback');  // customer feedback module
// Playing a call recording is deliberately its own permission, not part of
// manage_feedback. Seeing that a call exists is administrative; listening to a
// customer's recorded conversation is not, and GoTo itself has no per-department
// scoping on recordings, so this gate is doing the real access control.
ALL_PERMS.push('play_call_recordings');
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
// Offboarding module: admins manage the whole lifecycle; managers get read-only
// visibility by default. send_exit_form / view_exit_interviews stay admin-only
// (admin is '*') and can be granted to individuals via users.extra_perms.
ALL_PERMS.push('view_offboarding', 'manage_offboarding', 'send_exit_form', 'view_exit_interviews');
// Asset / equipment tracker. Everyone can see their own equipment and ask for a
// replacement; managing the inventory and approving replacements are manager
// decisions. NOTE: this module scopes managers to their OWN cities inside
// routes/assets.js, unlike every other module here.
EMPLOYEE_PERMS.push('view_assets', 'request_asset_replacement');
ALL_PERMS.push('view_assets', 'manage_assets', 'request_asset_replacement', 'approve_asset_replacement');
// Live tech locations. Deliberately NOT an employee permission: a tech does not
// need to see where everyone else is, and handing the whole crew a map of each
// other is a different product than dispatch. Being TRACKED needs no permission,
// it is company policy gated on the time clock (see routes/locations.js).
ALL_PERMS.push('view_tech_locations', 'manage_tech_locations');
// Dispatch board. Deliberately NOT in EMPLOYEE_PERMS and NOT in any role's
// DEFAULTS: this module is piloting, so it is off for everybody until an admin
// ticks the box in Roles & Access, or grants one person via users.extra_perms
// on Edit User. Seeing the board ALSO requires being marked "ready to accept
// calls" (routes/dispatch.js requireBoardAccess) - the permission only decides
// whether the door exists, duty decides whether it is open.
ALL_PERMS.push('view_dispatch', 'manage_dispatch');
// Handing a call to someone else is its own permission on purpose. A lead tech
// often needs to pass a call along without also being able to create calls or
// cancel them, and manage_dispatch is too big a hammer for that.
ALL_PERMS.push('assign_dispatch');
// --- Dispatch Phase 2A/2B -------------------------------------------------
// All of these SHIP DARK for the same reason as the two above: not in
// EMPLOYEE_PERMS, not in any role's DEFAULTS, and db.js does NOT backfill them
// onto the saved matrix. On deploy only admin and owner can reach any of it.
ALL_PERMS.push('manage_service_types');   // the service catalog and its categories
ALL_PERMS.push('manage_dispatch_tags');   // the call-tag list
// Seeing WHO ELSE opened a call is a supervisory fact, not a working one, so it
// is its own permission rather than riding on view_dispatch. Managers get it
// implicitly in routes/dispatch.js; this exists so a lead can be given it
// without also being made a manager.
ALL_PERMS.push('view_call_views');
// Call Search is history, not the live board, so it is gated separately and in
// three widening steps: your own calls, your whole city, then everything.
// search_dispatch_all also carries CSV export, because a full call export is a
// customer list.
ALL_PERMS.push('search_dispatch', 'search_dispatch_city', 'search_dispatch_all');
// Roadside techs see customer names and addresses on the LIVE board - they have
// to knock on the right door. In search and history they do not, and this is
// the permission that says otherwise. Masking is applied in the query, not the
// template, and the CSV export reads the same masked projection.
ALL_PERMS.push('view_customer_pii');
// Time codes: the windows of the week that decide what a service costs and what
// ETA the customer is told, per service, per location. Same permission covers
// the account price exceptions layered on top, because they are one decision.
ALL_PERMS.push('manage_pricing');
// Coverage zones. Separate from pricing because drawing the map of where you
// work and setting what you charge are different jobs, often different people.
ALL_PERMS.push('manage_coverage');
// Tech pay. Three permissions because they are three different trust levels:
// writing the rate tables, reading everybody's pay, and reading your own.
// view_own_pay is the one a tech eventually gets; it never widens past the
// person asking, and it is enforced in the query rather than the template.
// Pay figures stay out of the board payload for anyone without view_pay_report,
// the same treatment the customer phone number already gets.
ALL_PERMS.push('manage_pay_grades', 'view_pay_report', 'view_own_pay');
// Accounts Receivable. view_ar reads the aging and the ledgers; manage_ar
// records payments, adjustments and import batches. ar_writeoff is separate on
// purpose - writing off a balance is not data entry, it is the line an auditor
// asks about, and it should take a second person's access to do.
ALL_PERMS.push('view_ar', 'manage_ar', 'ar_writeoff');
// Accounts Payable. Ships dark exactly like A/R above: view_ap reads the bills
// list and what is due; manage_ap adds and edits bills, marks them paid, and
// sets the reminder settings. NOT in EMPLOYEE_PERMS and NOT in any role's
// DEFAULTS, and db.js does not backfill it onto the saved matrix - on deploy
// only admin and owner reach Accounts Payable until someone ticks the box in
// Settings -> Roles & Access (or grants one person via users.extra_perms).
ALL_PERMS.push('view_ap', 'manage_ap');
// Editing a cash deposit after it was submitted. Deliberately NOT in
// EMPLOYEE_PERMS: a tech may create (and, per the matrix, delete) their own
// deposit, but correcting the numbers on one already on the books is a
// supervisory act. routes/deposits.js gates it a SECOND time on role AND on the
// editor's assigned cities, so a manager can only fix their own locations.
// Inbound sync (webhooks). Ships dark like A/P above: view_sync reads the
// source list and the event log; manage_sync creates sources, rotates tokens
// and replays events. NOT in EMPLOYEE_PERMS and NOT in any role's DEFAULTS.
// manage_sync in particular is close to admin - the token it hands out is a
// standing write path into Nova from outside - so it should stay with admin
// and owner unless there is a specific reason to widen it.
ALL_PERMS.push('view_sync', 'manage_sync');
ALL_PERMS.push('edit_deposit');

var DEFAULTS = {
  admin: '*',
  manager: ['view_users', 'manage_cities', 'manage_geico', 'manage_running', 'manage_vehicles', 'manage_vendors', 'view_vendors', 'manage_addresses', 'approve_vr', 'manage_tasks', 'manage_work_orders', 'manage_schedule', 'manage_parts', 'manage_invoice_setup', 'approve_refund', 'assign_reviews', 'view_feedback', 'manage_feedback', 'manage_signatures', 'manage_timeclock', 'manage_pto', 'view_quiz', 'manage_quiz', 'view_team_quiz', 'manage_onboarding', 'manage_inspections', 'ptt_all_channels', 'view_offboarding', 'play_call_recordings', 'manage_assets', 'approve_asset_replacement', 'edit_deposit'].concat(EMPLOYEE_PERMS),
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
