// Receipt of Property checks. Run by hand: node test-property.js
//
// Exercises the pure rules in utils/property.js, the property half of
// utils/separation.js, and the PDF section that prints the list. No database and
// no network - the logo is passed in as an empty buffer so the builder never
// reaches for the CDN - so this is safe to run anywhere.
//
// The rules worth guarding are the ones that are invisible when they break: the
// outcome/disposition pairs that would put a lost tool back into stock, what the
// departing person's copy of the list does and does not show, and the mapping
// onto closeHolding() in routes/assets.js, which is what actually moves the
// inventory.
//
// House style: string concatenation only, no template literals/backticks.
var assert = require('assert');
var prop = require('./utils/property');
var sep = require('./utils/separation');
var pdf = require('./utils/separationPdf');
var n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.deepStrictEqual(a, b, msg); }

// ---- an item that never came back cannot go anywhere but a write-off
eq(prop.allowedDispositions('lost', true), ['writeoff'], 'lost has one home');
eq(prop.allowedDispositions('stolen', true), ['writeoff'], 'stolen has one home');
eq(prop.allowedDispositions('not_returned', true), ['writeoff'], 'not returned has one home');
eq(prop.allowedDispositions('kept', true), ['writeoff'], 'kept has one home');
ok(prop.allowedDispositions('returned', true).indexOf('stock') !== -1, 'returned can be shelved');
ok(prop.allowedDispositions('returned', true).indexOf('writeoff') === -1, 'returned is not a write-off');

// ---- untracked things have no shelf and no repair bench
var untracked = prop.allowedDispositions('returned', false);
ok(untracked.indexOf('stock') === -1, 'a shop key does not go into stock');
ok(untracked.indexOf('repair') === -1, 'a fuel card does not need repair');
ok(untracked.indexOf('person') !== -1, 'but it can be handed to somebody');

// ---- the pairs the server must refuse
ok(prop.checkLine({ label: 'Jump pack', outcome: 'lost', disposition: 'stock', qty: 1 }).length,
   'lost -> stock refused');
ok(prop.checkLine({ label: 'Drill', outcome: 'returned', disposition: 'writeoff', qty: 1 }).length,
   'returned -> writeoff refused');
eq(prop.checkLine({ label: 'Drill', outcome: 'returned', disposition: 'stock', dest_city_code: 'ORL', qty: 1 }), [],
   'a complete line passes');
ok(prop.checkLine({ label: 'Drill', outcome: 'returned', disposition: 'stock', qty: 1 }).length,
   'back to stock needs a city');
ok(prop.checkLine({ label: 'Drill', outcome: 'returned', disposition: 'person', qty: 1 }).length,
   'assigned on needs a person');
ok(prop.checkLine({ label: 'Drill', outcome: 'nonsense', disposition: 'stock', qty: 1 }).length,
   'junk outcome refused');
ok(prop.checkLine({ label: 'Drill', outcome: 'returned', disposition: 'stock', dest_city_code: 'ORL', qty: 0 }).length,
   'qty 0 refused');

// ---- every problem at once, not just the first
var bad = prop.missingForPost([
  { label: 'A', outcome: 'returned', disposition: 'stock', qty: 1 },
  { label: 'B', outcome: 'returned', disposition: 'person', qty: 1 }
]);
eq(bad.length, 2, 'both lines reported');
ok(prop.missingForPost([]).length === 1, 'an empty receipt is itself a blocker');

// ---- totals, which the screen and the signed PDF both read
var lines = [
  { label: 'Autel', qty: 1, unit_cost: 2199, outcome: 'returned', disposition: 'stock', tracked: true, holding_id: 1 },
  { label: 'Lishi', qty: 1, unit_cost: 640, outcome: 'returned', disposition: 'person', tracked: true, holding_id: 2 },
  { label: 'Reach tool', qty: 1, unit_cost: 89, outcome: 'returned', disposition: 'repair', tracked: true, holding_id: 3 },
  { label: 'Jump pack', qty: 1, unit_cost: 249, outcome: 'not_returned', disposition: 'writeoff', tracked: true, holding_id: 4 },
  { label: 'Key blanks', qty: 2, unit_cost: 163, outcome: 'lost', disposition: 'writeoff', tracked: true, holding_id: 5 },
  { label: 'Fuel card', qty: 1, outcome: 'returned', disposition: 'person', tracked: false }
];
var t = prop.totals(lines);
eq(t.returned, 4, 'four came back');
eq(t.gone, 2, 'two did not');
eq(t.to_stock, 1); eq(t.to_person, 2); eq(t.to_repair, 1);
eq(t.value_not_returned, 249 + 326, 'not-returned value counts quantity');
eq(t.items, 7, 'quantities, not rows');

// ---- the sentence above the Post button describes the real work
var s = prop.postSummary(lines, 'Julius Sherman');
ok(/closes 5 holdings/.test(s), s);
ok(/Julius Sherman/.test(s), s);
ok(/not recovered/.test(s), s);
ok(/Nothing moves/.test(prop.postSummary([{ label: 'Badge', qty: 1, outcome: 'returned', disposition: 'none', tracked: false }])),
   'an untracked-only receipt says nothing moves');

// ---- the mapping onto closeHolding(), which is what moves inventory
var toStock = prop.closeOptionsFor({ outcome: 'returned', disposition: 'stock', condition_in: 'good' });
ok(toStock.restock === true, 'shelving restocks');
ok(toStock.physically_returned === true);
var toPerson = prop.closeOptionsFor({ outcome: 'returned', disposition: 'person' });
ok(toPerson.restock === false, 'handing it straight on must NOT restock');
var toRepair = prop.closeOptionsFor({ outcome: 'returned', disposition: 'repair', condition_in: 'good' });
eq(toRepair.condition_in, 'poor', 'repair forces the condition closeHolding reads for needs_repair');
ok(toRepair.restock === false, 'a broken tool does not go back on the shelf');
var lost = prop.closeOptionsFor({ outcome: 'lost', disposition: 'writeoff' });
eq(lost.reason, 'lost'); eq(lost.status, 'lost');
ok(lost.restock === false, 'lost never restocks');
ok(lost.physically_returned === false);
var notRet = prop.closeOptionsFor({ outcome: 'not_returned', disposition: 'writeoff' });
ok(notRet.physically_returned === false, 'not returned is not in hand');
ok(notRet.restock === false);

// ---- shelving somewhere other than where it was issued
eq(prop.restockCity({ disposition: 'stock', dest_city_code: 'jax' }, { city_code: 'ORL' }), 'JAX',
   'the chosen city wins, upper-cased');
eq(prop.restockCity({ disposition: 'person' }, { city_code: 'ORL' }), 'ORL', 'otherwise where it was issued');

// ---- the vocabularies in the two util files must not drift apart
eq(sep.GONE_OUTCOMES.slice().sort(), prop.GONE_OUTCOMES.slice().sort(),
   'utils/separation and utils/property must agree on what "gone" means');

// ---- what the departing person's copy shows, and what it must not
var view = sep.propertyView(lines);
eq(view.length, 6);
ok(view[0].value === null, 'no price on a returned tool');
ok(view[3].value === 249, 'price shown on what did not come back');
eq(view[4].value, 326, 'and it counts quantity');
view.forEach(function (v) {
  ok(!('disposition' in v), 'where it went is not their business');
  ok(!('dest_user_id' in v), 'nor who took it');
  ok(!('holding_id' in v), 'nor our internal ids');
  ok(!('unit_cost' in v), 'nor the raw cost of everything');
});
eq(sep.propertyTotals(lines), { not_returned: 2, value_not_returned: 575 });

// ---- the agreement cannot go out on an unposted list
ok(/Start the Receipt/.test(sep.receiptBlocker({})), 'no receipt blocks');
ok(/still a draft/.test(sep.receiptBlocker({ receipt_id: 3, receipt_status: 'draft' })), 'a draft blocks');
eq(sep.receiptBlocker({ receipt_id: 3, receipt_status: 'posted' }), null, 'a posted one does not');
eq(sep.receiptBlocker({ receipt_id: 3, receipt_status: 'posted', nothing_to_return: true }), null,
   'nothing-to-return is an answer, not an omission');

// ---- the whole list survives onto the PDF
var png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
var many = [];
for (var i = 0; i < 40; i++) {
  many.push({ label: 'Tool number ' + i, qty: 1, unit_cost: 50, outcome: i % 7 === 0 ? 'lost' : 'returned' });
}
pdf.buildSeparationPdf(
  { agreement_number: 'SEP-2026-0009', employee_name: 'Derek Alvarez', last_day: '2026-09-19',
    terms_body: pdf.DEFAULT_SEPARATION_BODY, rep_name: 'Julius Sherman', receipt_posted_at: new Date() },
  [{ event_type: 'created', actor: 'Tony McKeon', created_at: new Date() }],
  { company: { name: 'Lock and Roll LLC' }, logo: Buffer.alloc(0), employeeSig: png, repSig: png,
    property: sep.propertyView(lines), propertyTotals: sep.propertyTotals(lines) }
).then(function (buf) {
  var txt = buf.toString('latin1');
  n++; assert.ok(buf.slice(0, 5).toString() === '%PDF-', 'it is a pdf');
  n++; assert.ok(txt.indexOf('&#39;') === -1, 'entities decoded for print');

  // A 40-line receipt must paginate rather than run off the bottom.
  return pdf.buildSeparationPdf(
    { agreement_number: 'SEP-2026-0010', employee_name: 'Long List', last_day: '2026-09-19',
      terms_body: pdf.DEFAULT_SEPARATION_BODY, rep_name: 'Julius Sherman' },
    [], { company: { name: 'Lock and Roll LLC' }, logo: Buffer.alloc(0),
          property: sep.propertyView(many), propertyTotals: sep.propertyTotals(many) });
}).then(function (buf2) {
  var pages = (buf2.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  n++; assert.ok(pages >= 2, '40 lines paginate, got ' + pages);

  // And an empty one still renders.
  return pdf.buildSeparationPdf(
    { agreement_number: 'SEP-2026-0011', nothing_to_return: true },
    [], { company: { name: 'Lock and Roll LLC' }, logo: Buffer.alloc(0), property: [], propertyTotals: {} });
}).then(function (buf3) {
  n++; assert.ok(Buffer.isBuffer(buf3) && buf3.length > 1000, 'nothing-to-return renders');
  console.log('\nALL PASS - ' + n + ' assertions');
}).catch(function (e) { console.error('FAILED:', e && e.stack || e); process.exit(1); });
