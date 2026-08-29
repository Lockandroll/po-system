'use strict';
/*
 * Every permission must have a row in Settings > Roles & Access - or be on the
 * short list of permissions that deliberately have none.
 *
 * WHY THIS FILE EXISTS. On 2026-08-29 Tony reported that the "+ Shout-out"
 * button never appeared for managers. utils/permissions.js says, in a comment,
 * to "tick the box in Roles & Access". There was no box. submit_shoutout had
 * been in ALL_PERMS since peer shout-outs shipped and had never been added to
 * the groups array in public/js/app.js, so the only way to grant it was to edit
 * users.extra_perms by hand. A feature was live and unreachable for the entire
 * company, and nothing anywhere said so.
 *
 * That is a silent failure, so it gets a loud test. A permission with no row is
 * a feature nobody can turn on.
 *
 * The allowlist below is the ONLY acceptable answer to "why has this one no
 * row", and every entry carries its reason. Adding a permission to this list is
 * a decision; adding one by forgetting is the bug.
 *
 *   node test-perm-rows.js
 *
 * House style: string concatenation only, no template literals.
 */
var fs = require('fs');
var permissions = require('./utils/permissions.js');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; console.error('  FAIL  ' + label); } }
function section(t) { console.log('\n== ' + t); }

// Permissions that are admin/owner-only BY DESIGN and must never get a role
// checkbox. The reason is the point of the entry.
var NO_ROW_ON_PURPOSE = {
  view_royalty:   'Royalty is owner-gated plus a per-person extra_perms allowlist, deliberately NOT role-based - see canRoyalty() in app.js.',
  manage_royalty: 'Same as view_royalty.',
  manage_sync:    'Carries the inbound webhook token, which is close to admin. CLAUDE.md 1.5 says this stays admin/owner-only by design.',
  pulsar_write:   'Writes back into Pulsar. Same reasoning as manage_sync.'
};

var src = fs.readFileSync('public/js/app.js', 'utf8');
var start = src.indexOf('  var groups = [');
var end = src.indexOf('  _rolePermsRendered = [];');
ok(start !== -1 && end !== -1 && end > start, 'the Roles & Access groups array is where this test expects it');
var seg = src.slice(start, end);

var rows = {};
var m = seg.match(/\{k:'([a-z0-9_]+)'/g) || [];
for (var i = 0; i < m.length; i++) { rows[m[i].slice(4, -1)] = true; }
ok(Object.keys(rows).length > 100, 'and it parsed a plausible number of rows  (got ' + Object.keys(rows).length + ')');

section('every permission is reachable from the settings screen');
var orphans = [];
for (i = 0; i < permissions.ALL_PERMS.length; i++) {
  var p = permissions.ALL_PERMS[i];
  if (rows[p] || NO_ROW_ON_PURPOSE[p]) continue;
  orphans.push(p);
}
ok(orphans.length === 0,
  'no permission is stranded without a checkbox  (stranded: ' + (orphans.join(', ') || 'none') + ')');

section('the one that started this');
ok(!!rows.submit_shoutout, 'submit_shoutout HAS a row - a manager can actually be granted the Shout-out button');

section('and it is not gated behind a permission its own audience lacks');
// A row inside a group with a gate renders DISABLED for any role that does not
// hold the gate. submit_shoutout is meant for everybody, so it must not sit in
// a gated group - most obviously not in Employee Records, gated on
// view_employee_records, which the people it is for will never have.
var groupChunks = seg.split(/\{ ?group:/);
var owner = null;
for (i = 0; i < groupChunks.length; i++) {
  if (groupChunks[i].indexOf("{k:'submit_shoutout'") !== -1) { owner = groupChunks[i]; break; }
}
ok(owner !== null, 'the row sits inside a group');
ok(owner !== null && owner.indexOf('gate:') === -1,
  'and that group has no gate, so the checkbox is tickable for every role');

section('the allowlist is honest');
for (var k in NO_ROW_ON_PURPOSE) {
  if (!Object.prototype.hasOwnProperty.call(NO_ROW_ON_PURPOSE, k)) continue;
  ok(permissions.ALL_PERMS.indexOf(k) !== -1,
    k + ' is still a real permission (a stale allowlist entry hides the next orphan)');
  ok(!rows[k], k + ' really has no row, so the reason recorded beside it still applies');
}

console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
