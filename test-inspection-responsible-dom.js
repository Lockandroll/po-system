'use strict';
/*
 * Render harness for the Responsible column on the inspection compliance grid.
 *
 * Commit 75b2c15 put the inspector picker in this cell and stopped drawing the
 * resolved name beside it, so to an admin every van read "Unassigned" even
 * though a manager was on the hook for it. These assertions pin the fix: the
 * resolved inspector is always named, the picker sits underneath it, and the
 * blank option says who the default is rather than "Unassigned".
 *
 *   node test-inspection-responsible-dom.js
 */
var fs = require('fs');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(h, n, l) { ok(String(h).indexOf(n) !== -1, l + '  (missing: ' + n + ')'); }
function lacks(h, n, l) { ok(String(h).indexOf(n) === -1, l + '  (unexpectedly present: ' + n + ')'); }

var SRC = fs.readFileSync('public/js/app.js', 'utf8');
var start = SRC.indexOf('function inspIsExempt(v) {');
var end = SRC.indexOf('function inspComplianceReload() {');
ok(start > 0 && end > start, 'found the compliance slice in app.js');
var slice = SRC.slice(start, end);
ok(slice.indexOf('`') === -1, 'the slice is backtick-free (Windows-safe)');

var STATE = { user: { id: 1, role: 'admin' }, currentView: 'inspections' };
var mod = new Function(
  'window', 'document', 'state', 'escHtml', 'icons', 'can', 'formatDate', 'inspResultBadge', 'api', 'navigate',
  'var _inspCompliance = null, _inspCities = [];\n' + slice +
  '\nreturn { render: function (d, el) { _inspCompliance = d; inspRenderCompliance(el); return el.innerHTML; } };'
)(
  {}, { getElementById: function () { return null; } }, STATE,
  function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  { settings: '<svg/>', plus: '<svg/>' },
  function () { return true; },
  function () { return 'Aug 20, 2026'; },
  function () { return '<span>result</span>'; },
  function () { return Promise.resolve({}); },
  function () {}
);

function grid(vehicles, over) {
  return Object.assign({
    month: '2026-08', current_month: '2026-08', cutoff_day: 25,
    can_assign_inspector: true,
    inspectors: [{ id: 5, name: 'Bree Hall', role: 'manager' }, { id: 6, name: 'Ada Admin', role: 'admin' }],
    vehicles: vehicles
  }, over || {});
}
function van(over) {
  return Object.assign({
    vehicle_id: 11, year: 2021, make_model: 'Chevrolet Express', license_plate: 'BHM001',
    city_code: 'BHM', driver_name: 'Dave Driver', driver_role: 'locksmith', driver_supervisor_id: 9,
    manager_name: 'Sue Supervisor', inspection_exempt: false, inspector_id: null, inspector_name: null,
    inspector_city: 'BHM', city_manager_id: 5, city_manager_name: 'Bree Hall',
    effective_inspector_id: 5, effective_inspector_name: 'Bree Hall', effective_inspector_source: 'city',
    inspection_id: null, photo_count: 0
  }, over || {});
}
function render(v, over) { return mod.render(grid([v], over), { innerHTML: '' }); }

// ---- the regression itself ---------------------------------------------------
var html = render(van());
has(html, 'Inspector: Bree Hall', 'an admin sees the resolved inspector, not just the picker');
has(html, '(BHM manager)', 'and why that person is on the hook');
has(html, '<select', 'the picker is still there');
has(html, '— Default: Bree Hall —', 'the blank option names the default instead of saying Unassigned');
lacks(html, '— Unassigned —', 'the old Unassigned placeholder is gone');
has(html, 'Dave Driver', 'the driver is still the headline name in the cell');
has(html, 'inspSetInspector(this,11)', 'changing the picker still calls through');
has(html, '>Bree Hall</option>', 'a manager is selectable');
has(html, '>Ada Admin</option>', 'so is an admin');

// ---- an explicit override ------------------------------------------------------
html = render(van({ inspector_id: 6, inspector_name: 'Ada Admin', effective_inspector_id: 6, effective_inspector_name: 'Ada Admin', effective_inspector_source: 'assigned' }));
has(html, 'Inspector: Ada Admin', 'an assigned inspector is named');
lacks(html, 'Ada Admin</span> <span style="opacity:0.7">(', 'an explicit pick needs no explanation');
has(html, 'value="6" selected', 'and is selected in the picker');
has(html, '— Default: Bree Hall —', 'while the blank option still offers the way back to the default');

// ---- the supervisor fallback ----------------------------------------------------
html = render(van({ city_manager_id: null, city_manager_name: null, inspector_city: 'SAV',
  effective_inspector_id: 9, effective_inspector_name: 'Sue Supervisor', effective_inspector_source: 'supervisor' }));
has(html, 'Inspector: Sue Supervisor', 'the supervisor fallback is named');
has(html, '(supervisor)', 'and labelled as the fallback it is');
has(html, '— Default: Sue Supervisor —', 'the picker offers the fallback as the default');

// ---- nobody at all ---------------------------------------------------------------
html = render(van({ city_manager_id: null, city_manager_name: null, manager_name: null, driver_supervisor_id: null,
  inspector_city: 'CSG', effective_inspector_id: null, effective_inspector_name: null, effective_inspector_source: null }));
has(html, 'nobody manages CSG', 'an unowned city is called out by name');
has(html, '— No default —', 'and the picker admits it has no default');

// ---- exempt vans -----------------------------------------------------------------
html = render(van({ driver_role: 'admin', driver_name: 'Tony McKeon' }));
lacks(html, 'Inspector:', 'an exempt van names no inspector');
lacks(html, 'inspSetInspector', 'and offers no picker');
has(html, 'Assigned to admin', 'it explains why it is exempt');

// ---- who may start ----------------------------------------------------------------
STATE.user = { id: 5, role: 'manager' };
html = render(van());
has(html, 'Start', 'the city manager can start the inspection');
STATE.user = { id: 77, role: 'locksmith' };
html = render(van({ driver_supervisor_id: 9 }));
lacks(html, '>Start<', 'an unrelated locksmith cannot');
STATE.user = { id: 5, role: 'locksmith' };
html = render(van({ can_assign_inspector: false }));
has(html, 'Start', 'but the resolved inspector can, whatever their role');
STATE.user = { id: 1, role: 'admin' };

// ---- non-assigners still see the name ----------------------------------------------
html = render(van(), { can_assign_inspector: false });
has(html, 'Inspector: Bree Hall', 'a viewer who cannot assign still sees who is responsible');
lacks(html, '<select data-prev', 'and gets no picker');

console.log('\n  ' + PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
