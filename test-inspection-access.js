'use strict';
/*
 * Two bugs Tony reported on 2026-08-26, pinned here.
 *
 * 1) The Inspections nav item was gated on view_vr AND view_inspections, so a
 *    manager who had the inspections permission but not vehicle repairs saw no
 *    Inspections link at all. The module has its own permission; nothing about
 *    reading a checklist needs the repair board.
 * 2) The reminder email's CTA was an inline-block <a> carrying its own padding.
 *    Outlook on Windows renders through Word, which drops display:inline-block
 *    and mishandles padding on an inline element - the button came out as a
 *    370x130 orange slab. The padding now lives on the TD.
 *
 * Plus the one-time db.js backfill that puts view_inspections on an already
 * saved manager role matrix, without which fix 1 changes nothing in production.
 *
 *   node test-inspection-access.js
 */
var fs = require('fs');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(h, n, l) { ok(String(h).indexOf(n) !== -1, l + '  (missing: ' + n + ')'); }
function lacks(h, n, l) { ok(String(h).indexOf(n) === -1, l + '  (unexpectedly present: ' + n + ')'); }

console.log('\n--- Fleet nav group, evaluated for real ---');

var SRC = fs.readFileSync('public/js/app.js', 'utf8');
var gStart = SRC.indexOf("navGroup('fleet', 'Fleet'");
ok(gStart > 0, 'found the Fleet nav group in app.js');
var gEnd = SRC.indexOf('\n    ]),', gStart);
ok(gEnd > gStart, 'found the end of the Fleet nav group');
var groupSrc = SRC.slice(gStart, gEnd) + '\n    ])';
ok(groupSrc.indexOf(String.fromCharCode(96)) === -1, 'the slice is backtick-free (Windows-safe)');

// The real navGroup / navItem, so the empty-group drop is exercised too.
function navItem(id, label, icon, views) { return { type: 'item', id: id, label: label, views: views || [id] }; }
function navGroup(id, label, icon, children) {
  var kids = children.filter(Boolean);
  return kids.length ? { type: 'group', id: id, label: label, children: kids } : null;
}
var NAVI = new Proxy({}, { get: function () { return 'icon'; } });
var icons = NAVI;

var buildFleet = new Function('navGroup', 'navItem', 'NAVI', 'icons', 'can',
  'return ' + groupSrc + ';');

function fleetFor(perms) {
  var set = {};
  perms.forEach(function (p) { set[p] = true; });
  return buildFleet(navGroup, navItem, NAVI, icons, function (p) { return !!set[p]; });
}
function ids(group) { return group ? group.children.map(function (c) { return c.id; }) : []; }

// The reported case: inspections permission, no vehicle repairs.
var mgr = fleetFor(['view_inspections']);
ok(mgr !== null, 'a user with only view_inspections still gets a Fleet group');
has(ids(mgr).join(','), 'inspections', 'Inspections draws without view_vr');
lacks(ids(mgr).join(','), 'vr-dashboard', 'Vehicle Repairs stays hidden without view_vr');

// The checklist editor follows the same rule.
var mgr2 = fleetFor(['manage_inspections']);
has(ids(mgr2).join(','), 'inspection-checklist', 'Insp. Checklist draws without view_vr');

// A full manager sees everything, in order.
var full = fleetFor(['view_vr', 'manage_vehicles', 'view_inspections', 'manage_inspections']);
eq(ids(full).join(','), 'vr-dashboard,fleet-registry,inspections,inspection-checklist',
  'a full manager sees all four Fleet items in order');

// Nothing leaked the other way: no inspections permission, no inspections item.
var tech = fleetFor(['view_vr']);
eq(ids(tech).join(','), 'vr-dashboard', 'view_vr alone does NOT unlock Inspections');
eq(fleetFor([]), null, 'no fleet permissions at all drops the group entirely');

// The view router must agree with the menu, or the link 403s on arrival.
var vp = SRC.slice(SRC.indexOf('var _viewPerm = {'), SRC.indexOf('var _viewPerm = {') + 4000);
has(vp, "inspections:'view_inspections'", 'the inspections view is routed on view_inspections');
has(vp, "'inspection-checklist':'manage_inspections'", 'the checklist view is routed on manage_inspections');

console.log('\n--- Email CTA button (bulletproof markup) ---');

var emailMod = require('./utils/email');
var html = emailMod.emailTemplate({
  badge: 'Reminder',
  title: '1 vehicle inspection due',
  body: 'These vehicles still need their 2026-08 inspection.',
  buttonText: 'Open inspections',
  buttonUrl: 'https://nova.example.com/?view=inspections'
});
var btn = html.slice(html.indexOf('<td align="center" bgcolor'), html.indexOf('</tr></table>', html.indexOf('<td align="center" bgcolor')));
ok(btn.length > 0, 'the button block is present');
has(btn, 'padding:13px 26px', 'the padding is on the TD, where Word honours it');
has(btn, 'bgcolor="#f97316"', 'the TD carries a bgcolor attribute for CSS-stripping clients');
has(btn, 'background-color:#f97316', 'the TD also carries the CSS background');
has(btn, 'mso-padding-alt', 'an mso padding fallback is present');
var anchor = btn.slice(btn.indexOf('<a '), btn.indexOf('</a>'));
lacks(anchor, 'display:inline-block', 'the anchor no longer relies on inline-block, which Word drops');
lacks(anchor, 'padding:', 'the anchor carries no padding of its own');
has(anchor, 'line-height:20px', 'the anchor pins its line-height so the box cannot grow');
has(anchor, 'white-space:nowrap', 'the label cannot wrap and stretch the button');
has(anchor, 'color:#ffffff', 'the label stays white on orange');

// The guard that stopped the "null" buttons stays in force.
var noBtn = emailMod.emailTemplate({ badge: 'Reminder', title: 'x', body: 'y' });
lacks(noBtn, 'bgcolor="#f97316"', 'no button is drawn when the caller supplies neither half');
lacks(noBtn, 'null', 'no stray null leaks into a buttonless email');

console.log('\n--- db.js one-time permission backfill ---');

var DB = fs.readFileSync('db.js', 'utf8');
has(DB, "perm_inspections_matrix_backfilled", 'the backfill has its own run-once settings key');
var bf = DB.slice(DB.indexOf("perm_inspections_matrix_backfilled"), DB.indexOf("perm_inspections_matrix_backfilled") + 1800);
has(bf, "'view_inspections', 'manage_inspections'", 'both inspection permissions are backfilled');
has(bf, 'Array.isArray(obj.manager)', 'it only touches a saved matrix that actually has a manager array');
has(bf, 'indexOf(k) === -1', 'it never duplicates a permission the matrix already has');
has(bf, 'ON CONFLICT (key) DO UPDATE SET value = $1', 'the updated matrix is written back');
lacks(bf, 'obj.admin', 'admin is left alone - admin is unrestricted by design');

// The defaults a fresh install uses must line up with what the backfill grants.
var perms = fs.readFileSync('utils/permissions.js', 'utf8');
var mgrDefaults = perms.slice(perms.indexOf('  manager: ['), perms.indexOf('\n', perms.indexOf('  manager: [')));
has(mgrDefaults, 'manage_inspections', 'manager DEFAULTS already carry manage_inspections');
has(perms, "EMPLOYEE_PERMS.push('view_inspections')", 'view_inspections reaches manager via EMPLOYEE_PERMS');

console.log('\n  ' + PASS + ' passed, ' + FAIL + ' failed\n');
process.exit(FAIL ? 1 : 0);
