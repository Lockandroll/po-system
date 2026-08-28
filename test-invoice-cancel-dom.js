'use strict';
/*
 * Invoice CANCEL render harness. No database, no jsdom.
 *
 *   node test-invoice-cancel-dom.js
 *
 * Every function under test is a pure string builder, so they are sliced OUT of
 * public/js/app.js by brace-matching and executed here. That means these
 * assertions are about the shipped render, not a copy of it -- edit app.js and
 * this harness follows.
 */
var fs = require('fs');
var path = require('path');
var SRC = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');

// Brace-matcher that understands strings, so a '}' inside an HTML fragment does
// not end the function early.
function grabFn(name) {
  var re = new RegExp('\\n((?:async )?function ' + name + '\\s*\\()');
  var m = re.exec(SRC);
  if (!m) throw new Error('function not found in app.js: ' + name);
  var i = SRC.indexOf('{', m.index + m[0].length - 1);
  var depth = 0, inStr = null, esc = false, j = i;
  for (; j < SRC.length; j++) {
    var c = SRC[j];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return SRC.slice(m.index + 1, j);
}
function grabVar(name) {
  var re = new RegExp('\\nvar ' + name + '\\s*=');
  var m = re.exec(SRC);
  if (!m) throw new Error('var not found in app.js: ' + name);
  var depth = 0, inStr = null, esc = false, j = m.index + m[0].length;
  for (; j < SRC.length; j++) {
    var c = SRC[j];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) { j++; break; }
  }
  return SRC.slice(m.index + 1, j);
}

var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } }
function eq(a, b, m) { ok(a === b, m + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(hay, needle, m) { ok(String(hay).indexOf(needle) !== -1, m + '  (missing: ' + needle + ')'); }
function lacks(hay, needle, m) { ok(String(hay).indexOf(needle) === -1, m + '  (should not contain: ' + needle + ')'); }

// --- stubs the sliced code closes over --------------------------------------
var PRELUDE = `
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatDate(d){ return 'Aug 28, 2026'; }
function formatDateTime(d){ return 'Aug 28, 2026 9:14 PM'; }
function invExt(it){ return (parseFloat(it.quantity)||0)*(parseFloat(it.unit_price)||0); }
var icons = { edit:'', print:'', mail:'', send:'', plus:'' };
var NAVI = { refund:'' };
var state = { user: { id: 7, name: 'Tim Tech', role: 'locksmith' } };
var _PERMS = {};
function can(p){ return _PERMS[p] !== false; }
`;

var NAMES_VAR = ['INV_STATUSES', 'INV_STATUS_LABELS', 'INV_STATUS_BADGE', 'INV_STATUS_HELP',
  '_invCancelReasons', 'INV_CANCEL_REASON_HINTS', '_invPulsarCanceledLabel', '_invoicePulsarPayMap'];
var NAMES_FN = ['invMoney', 'invStatusLabel', 'invPulsarTotal', 'invPulsarFields',
  'invCloseoutHtml', 'invProcessCardHtml', 'invActionBarHtml'];

var code = PRELUDE;
NAMES_VAR.forEach(n => { try { code += grabVar(n) + '\n'; } catch (e) { console.log('  (var ' + n + ': ' + e.message + ')'); } });
NAMES_FN.forEach(n => { code += grabFn(n) + '\n'; });
code += 'return { ' + NAMES_FN.concat(NAMES_VAR).map(n => n + ': ' + n).join(', ') + ', setPerm: function(k,v){ _PERMS[k]=v; }, setRole: function(r){ state.user.role = r; } };';
var M = new Function(code)();

// --- fixtures ----------------------------------------------------------------
function inv(over) {
  return Object.assign({
    id: 12, invoice_number: '310401370', status: 'draft',
    customer_name: 'Marcus Webb', city_code: 'ATL',
    labor_amount: 95, parts_amount: 65, subtotal: 160, tax_amount: 4.55,
    tip_amount: 0, surcharge_amount: 0, surcharge_rate: 0, grand_total: 164.55,
    pay_type: 'Visa', card_last4: '4242',
    can_complete: true, reopen_seconds_left: 0, can_reopen_now: false,
    cogs: { total: 18.4, part_lines: 1, costed_lines: 1, unknown_lines: 0, uncosted_lines: 0, incomplete: false, gross_profit: 141.6 },
    line_items: [
      { line_type: 'labor', description: 'Vehicle lockout', unit_price: 95, quantity: 1 },
      { line_type: 'part', item_number: 'HU100-T', description: 'Transponder key blank', unit_price: 65, quantity: 1, unit_cost: 18.4 }
    ]
  }, over || {});
}

console.log('\n1. The bar offers three ways out of an Active invoice');
var bar = M.invActionBarHtml(inv(), true);
has(bar, 'inv-actionbar', 'the bar renders');
has(bar, 'invWaitingSheet(12)', 'Waiting for Payment is wired');
has(bar, 'invCompleteSheet(12)', 'Complete is wired');
has(bar, 'invCancelSheet(12)', 'Cancel is wired');
eq((bar.match(/inv-ab-btn/g) || []).length, 3, 'exactly three buttons, no more');
// Order matters: the green sits in the middle, Cancel furthest from it.
ok(bar.indexOf('inv-ab-waiting') < bar.indexOf('inv-ab-complete'), 'Waiting comes before Complete');
ok(bar.indexOf('inv-ab-complete') < bar.indexOf('inv-ab-cancel'), 'Cancel comes last');

console.log('\n2. ⚠️ A failing checklist disables Complete and Waiting but NEVER Cancel');
bar = M.invActionBarHtml(inv({ can_complete: false }), true);
// This is the assertion the whole design turns on. A gone-on-arrival fails every
// gate, and Cancel is the only button that can help.
var waitingBtn = bar.slice(bar.indexOf('inv-ab-waiting'), bar.indexOf('inv-ab-complete'));
var completeBtn = bar.slice(bar.indexOf('inv-ab-complete'), bar.indexOf('inv-ab-cancel'));
var cancelBtn = bar.slice(bar.indexOf('inv-ab-cancel'));
has(waitingBtn, 'disabled', 'Waiting is disabled');
has(completeBtn, 'disabled', 'Complete is disabled');
lacks(cancelBtn, 'disabled', 'Cancel is NOT disabled');
has(bar, 'Cancel does not', 'and the hint says why');
bar = M.invActionBarHtml(inv({ can_complete: true }), true);
lacks(bar, 'disabled', 'with the checklist passing nothing is disabled');

console.log('\n3. The bar knows when it has no business being there');
eq(M.invActionBarHtml(inv(), false), '', 'a read-only viewer gets no bar');
eq(M.invActionBarHtml(inv({ status: 'paid' }), true), '', 'a completed invoice gets no bar');
eq(M.invActionBarHtml(inv({ status: 'refunded' }), true), '', 'a refunded invoice gets no bar');
eq(M.invActionBarHtml(inv({ status: 'canceled' }), true), '', 'a canceled invoice gets no bar');
ok(M.invActionBarHtml(inv({ status: 'awaiting_payment' }), true) !== '', 'a waiting invoice still gets one');

console.log('\n4. Status labels and the badge class');
eq(M.invStatusLabel('canceled'), 'Canceled', 'canceled has a label');
eq(M.INV_STATUS_BADGE.canceled, 'badge-canceled', 'and its own badge class');
// ⚠️ Grey, not red. Red is what a refund looks like, and the two must not be
// confusable in a list -- one means money went back, the other means none moved.
ok(M.INV_STATUS_BADGE.canceled !== M.INV_STATUS_BADGE.refunded, 'the canceled badge is not the refunded badge');
ok(M.INV_STATUSES.indexOf('canceled') !== -1, 'canceled is in the list filter statuses');

console.log('\n5. The canceled process card explains itself');
var card = M.invProcessCardHtml(inv({
  status: 'canceled', canceled_by_name: 'Tony McKeon', canceled_at: '2026-08-28T21:14:00Z',
  cancel_reason_label: 'Customer declined the price', cancel_note: 'Said $164 was too high.'
}), true, false);
has(card, 'Canceled by Tony McKeon', 'it names who');
has(card, 'Aug 28, 2026 9:14 PM', 'and when');
has(card, 'Customer declined the price', 'and the reason');
has(card, 'Said $164 was too high.', 'and the note');
has(card, 'Close the call in Pulsar as canceled', 'and tells the tech the next action');
has(card, 'badge-canceled', 'with the grey pill');
lacks(card, 'invCompleteSheet', 'no Complete button hiding on a canceled invoice');

console.log('\n6. Reopen on a canceled invoice');
card = M.invProcessCardHtml(inv({ status: 'canceled', can_reopen_now: true, reopen_seconds_left: 600 }), true, false);
has(card, 'invReopen(12)', 'inside the grace window the tech gets Reopen');
has(card, 'inv-grace-box', 'with the countdown box');
card = M.invProcessCardHtml(inv({ status: 'canceled', can_reopen_now: false, reopen_seconds_left: 0 }), true, false);
lacks(card, 'invReopen(12)', 'past the window a tech gets nothing');
M.setRole('admin');
card = M.invProcessCardHtml(inv({ status: 'canceled', can_reopen_now: false, reopen_seconds_left: 0 }), true, true);
has(card, 'invReopen(12)', 'but an admin always can');
M.setRole('locksmith');

console.log('\n7. ⚠️ Pulsar closes a canceled call at ZERO on every money field');
var f = M.invPulsarFields(inv({ status: 'canceled' }));
eq(f.length, 6, 'still the six fields Pulsar asks for, in Pulsar order');
eq(f[0].copyValue, '310401370', 'the invoice number is real -- the call still has to close');
eq(f[1].copyValue, '0.00', 'parts total is zero');
eq(f[2].copyValue, '0.00', 'labor total is zero');
eq(f[3].copyValue, '0.00', 'COGS total is zero');
eq(f[4].copyValue, 'Canceled', 'payment type says Canceled');
eq(f[5].copyValue, '0.00', 'payment total is zero');
// The royalty and the ad fee are computed off these figures. Anything non-zero
// pays a percentage on revenue that does not exist.
ok(f.slice(1).every(x => x.label === 'Payment type' || x.copyValue === '0.00'), 'every money field is 0.00, no exceptions');
// And the live path is untouched.
f = M.invPulsarFields(inv({ status: 'paid' }));
eq(f[1].copyValue, '65.00', 'a completed invoice still reports its real parts total');
eq(f[5].copyValue, '164.55', 'and its real payment total');

console.log('\n8. The close-out card unlocks for canceled and stays locked for draft');
var out = M.invCloseoutHtml(inv({ status: 'draft' }), false);
has(out, 'inv-closeout-stub', 'a draft still gets the locked stub');
has(out, 'Completed or Canceled', 'and the stub now names both ways to unlock it');
lacks(out, 'invCopyField', 'with no copy buttons');
out = M.invCloseoutHtml(inv({ status: 'canceled' }), true);
has(out, 'invCopyField', 'a canceled invoice gets the copy buttons');
has(out, 'every money field closes at 0.00', 'and says plainly what it is copying');
has(out, 'no sale, no royalty, no ad fee', 'and why');
lacks(out, 'inv-closeout-stub', 'the stub is gone');
lacks(out, 'Gross profit', 'no margin line on a job that earned nothing');
lacks(out, 'inv-cogs-ok', 'and no "all costed" tick either');
out = M.invCloseoutHtml(inv({ status: 'canceled', cogs: { total: 0, part_lines: 1, costed_lines: 0, unknown_lines: 1, uncosted_lines: 0, incomplete: true, gross_profit: 0 } }), true);
lacks(out, 'COGS is incomplete', 'an incomplete-COGS warning is suppressed -- there is nothing left to cost');

console.log('\n9. A completed invoice is unchanged by any of this');
out = M.invCloseoutHtml(inv({ status: 'paid' }), true);
has(out, 'Parts 65.00 + Labor 95.00', 'the reconciliation line still shows the real arithmetic');
has(out, 'Gross profit', 'and a manager still sees margin');
card = M.invProcessCardHtml(inv({ status: 'paid', completed_at: '2026-08-28T21:14:00Z' }), true, false);
has(card, 'Completed', 'the completed card still renders');
card = M.invProcessCardHtml(inv({ status: 'awaiting_payment', waiting_since: '2026-08-27T10:00:00Z' }), true, false);
has(card, 'owed', 'the waiting card still says what is owed');
has(card, 'invCompleteSheet(12)', 'and still offers Record payment');

console.log('\n10. The Active card keeps the checklist after losing its button');
card = M.invProcessCardHtml(inv({ gates: [
  { label: 'Customer name', ok: true, detail: 'Marcus Webb' },
  { label: 'City, for sales tax', ok: false, detail: 'Missing' }
] }), true, false);
has(card, 'Customer name', 'the gate rows are still there');
has(card, 'Missing', 'including the failing one');
has(card, 'var(--danger)', 'shown in red');
lacks(card, 'Complete Invoice</button>', 'but the green button has moved to the bar');
has(card, 'has to pass before this invoice can be Completed', 'and the card says what the checklist is for');

console.log('\n11. The reason list the sheet renders from');
eq(M._invCancelReasons.length, 4, 'four reasons ship as the client default');
var keys = M._invCancelReasons.map(r => r.key);
ok(keys.every(k => !!M.INV_CANCEL_REASON_HINTS[k]), 'every reason has a plain-language hint under it');
ok(keys.indexOf('no_show') !== -1, 'including gone-on-arrival, the ungated case');

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' assertions passed, ' + fail + ' failed.');
process.exit(fail === 0 ? 0 : 1);
