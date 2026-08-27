// Guard test for the work-order revision matcher.
//
// Regression under test: on 2026-08-27 six Bass Pro work orders, sent individually so
// each would open its own job, were folded into one. Every form printed the same site
// code (S108121C) where the parser looks for wo_number, and wo_number equality was the
// entire merge test. This asserts the identifying fields now overrule it.
//
// Run: node test-wo-revision-guard.js   (no DB, no network)

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x/x';
const wo = require('./jobs/workOrders');
const conflict = wo.identityConflict;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function blocks(name, parsed, row) { ok(name, !!conflict(parsed, row)); }
function allows(name, parsed, row) {
  const why = conflict(parsed, row);
  ok(name + (why ? ' [blocked: ' + why + ']' : ''), !why);
}

console.log('\nThe Bass Pro case: same wo_number, genuinely different jobs');
const bass = { wo_number: 'S108121C', po_number: 'PO-4471', address: '1815 E Bass Pro Dr', city_state_zip: 'Bossier City, LA 71111', store_number: '213' };
blocks('different PO blocks the fold',
  Object.assign({}, bass, { po_number: 'PO-4482' }), bass);
blocks('different street number blocks the fold',
  Object.assign({}, bass, { address: '2200 E Bass Pro Dr' }), bass);
blocks('different ZIP blocks the fold',
  Object.assign({}, bass, { city_state_zip: 'Katy, TX 77494' }), bass);
blocks('different store number blocks the fold',
  Object.assign({}, bass, { store_number: '218' }), bass);
blocks('one disagreement is enough even when everything else matches',
  Object.assign({}, bass, { po_number: 'PO-9999' }), bass);

console.log('\nA real NTE revision still folds');
allows('identical form, higher NTE', bass, bass);
allows('same job, address written differently',
  Object.assign({}, bass, { address: '1815 East Bass Pro Drive' }), bass);
allows('same PO punctuated differently',
  Object.assign({}, bass, { po_number: 'po 4471' }), bass);
allows('ZIP+4 vs ZIP', Object.assign({}, bass, { city_state_zip: 'Bossier City, LA 71111-2043' }), bass);

console.log('\nAbsent is silence, not agreement');
allows('field missing on the incoming form', { wo_number: 'S108121C' }, bass);
allows('field missing on the stored job', bass, { wo_number: 'S108121C' });
allows('"unknown" is treated as absent',
  Object.assign({}, bass, { po_number: 'unknown', address: 'unknown' }), bass);
allows('both sides empty', {}, {});

console.log('\nVehicle jobs');
const van = { wo_number: 'W4274808', vin: '5LMPJ8KA3TJ062337' };
blocks('different VIN blocks the fold', { wo_number: 'W4274808', vin: '1FTFW1ET5DFA12345' }, van);
allows('same VIN spaced one character per box',
  { wo_number: 'W4274808', vin: '5 L M P J 8 K A 3 T J 0 6 2 3 3 7' }, van);
allows('unreadable short VIN does not invent a conflict', { wo_number: 'W4274808', vin: '5LMP' }, van);

console.log('\nThe Spirit Halloween case (group 101) must still merge');
const spirit = { wo_number: '678127', po_number: 'RT-8891', address: '4000 Meadows Ln', city_state_zip: 'Las Vegas, NV 89107' };
allows('legitimate revision of the same job', spirit, spirit);
allows('revision that only adds a PO the original lacked',
  spirit, { wo_number: '678127', address: '4000 Meadows Ln', city_state_zip: 'Las Vegas, NV 89107' });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
