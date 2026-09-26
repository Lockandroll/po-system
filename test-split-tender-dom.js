'use strict';
/*
 * Split tender sheet harness (jsdom). The functions under test are sliced OUT of
 * public/js/app.js by brace-matching and run in a jsdom window, so these
 * assertions are about the shipped code, not a copy of it.
 *
 *   node test-split-tender-dom.js
 */
var fs = require('fs');
var path = require('path');
var { JSDOM } = require('jsdom');
var SRC = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');

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
    if (c === '/' && SRC[j + 1] === '/') { j = SRC.indexOf('\n', j); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return SRC.slice(m.index + 1, j);
}

var FNS = ['invTenderIsCard', 'invTenderCents', 'invTenderDraftKey', 'invTenderBaseCents', 'invTenderRate',
  'invTenderSurchargeCents', 'invTenderOpen', 'invTenderTypeOptions', 'invTenderRowHtml', 'invTenderSurHint',
  'invTenderSumHtml', 'invTenderTotals', 'invTenderRender', 'invTenderSet', 'invTenderRefreshBar',
  'invTenderSaveDraft', 'invTenderManual', 'invTenderAdd', 'invTenderRemove', 'invTenderFill', 'invTenderPayload',
  'invTenderCheck', 'invTenderComplete', 'invTenderRunSquare', 'invTenderBack', 'invTenderCardHtml',
  'invSheet', 'invCloseSheet', 'invSheetError', 'invIsBilledPayType', 'invPulsarTotal', 'invPulsarFields'];

var dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' });
var w = dom.window;
var calls = [];
w.eval(
  "var INV_PAY_TYPES = ['Cash','Check','Visa','Mastercard','Amex','Discover','Debit','Motor Club','Account / Invoice','Other'];" +
  "var _invoicePulsarPayMap = { 'Visa': 'Credit Card', 'Cash': 'Cash' }; var _invPulsarCanceledLabel = 'Canceled'; var _invoicePayTypes = null; var _invSurchargeOn = true; var _invSurchargeRate = 3;" +
  "var INV_TENDER_MIN = 2; var INV_TENDER_MAX = 4; var _invTender = null; var _invTenderDraftTimer = null;" +
  "var state = { user: { id: 7 } }; var _currentInvoice = null; var DRAFTS = {}; var TOASTS = []; var ALERTS = []; var CALLS = []; var NAV = [];" +
  "function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }" +
  "function invMoney(n){ return '$' + (parseFloat(n)||0).toFixed(2); }" +
  "function novaDraftPut(k,v){ DRAFTS[k]=v; return Promise.resolve(); } function novaDraftGet(k){ return Promise.resolve(DRAFTS[k]||null); } function novaDraftDel(k){ delete DRAFTS[k]; return Promise.resolve(); }" +
  "function showToast(m){ TOASTS.push(m); } function novaAlert(m){ ALERTS.push(m); } function navigate(v,p){ NAV.push([v,p]); } function apiBustCache(){}" +
  "var API_REPLY = null; async function api(m,p,b){ CALLS.push([m,p,b]); if (API_REPLY instanceof Error) throw API_REPLY; return API_REPLY; }" +
  "var COLLECT = []; async function invCollectPayment(id, seq){ COLLECT.push([id, seq]); }" +
  "async function invCompleteSheet(id){ CALLS.push(['sheet', id]); }" +
  FNS.map(grabFn).join('\n')
);

var pass = 0, fail = 0;
function ok(c, m, extra) { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + m + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } }
function $(id) { return w.document.getElementById(id); }
function type(id, val) { var el = $(id); el.value = val; el.dispatchEvent(new w.Event('input', { bubbles: true })); }
function pick(id, val) { var el = $(id); el.value = val; el.dispatchEvent(new w.Event('change', { bubbles: true })); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function baseInv(extra) {
  return Object.assign({ id: 42, invoice_number: '8000042', subtotal: '150.00', tax_amount: '3.50', tip_amount: '0',
    surcharge_rate: '0', grand_total: '153.50', square_enabled: true, tenders: [], billed_pay_types: ['Account / Invoice', 'Motor Club'] }, extra || {});
}

(async function () {
  // ---- fresh split
  w._currentInvoice = baseInv();
  await w.invTenderOpen(42);
  ok(!!$('inv-proc-modal'), 'sheet opens');
  ok($('inv-tender-amt-0').value === '153.50' && $('inv-tender-amt-1').value === '', 'whole amount on line 1, line 2 empty');
  ok($('inv-tender-go').disabled, 'Mark Completed disabled before types picked');
  var opts = Array.prototype.map.call($('inv-tender-type-0').options, function (o) { return o.value; });
  ok(opts.indexOf('Motor Club') === -1 && opts.indexOf('Account / Invoice') === -1 && opts.indexOf('Cash') !== -1, 'billed types not offered', opts);

  pick('inv-tender-type-0', 'Cash');
  type('inv-tender-amt-0', '53.50');
  ok(/Remaining to collect \$100\.00/.test($('inv-tender-remaining').textContent), 'remaining 100.00', $('inv-tender-remaining').textContent);
  ok($('inv-tender-remaining').querySelector('button').style.display !== 'none', 'fill button shown while short');
  pick('inv-tender-type-1', 'Visa');
  ok(!!$('inv-tender-l4-1') && !$('inv-tender-l4-0'), 'card fields only on the card line');
  w.invTenderFill();
  ok($('inv-tender-amt-1').value === '100.00', 'fill puts the rest on the last line', $('inv-tender-amt-1').value);
  ok(/Fully covered/.test($('inv-tender-remaining').textContent), 'fully covered');
  ok(/\$3\.00 credit card surcharge/.test($('inv-tender-sur-1').innerHTML) && /\$103\.00/.test($('inv-tender-sur-1').innerHTML), 'card line shows 3.00 credit card surcharge, charge 103.00', $('inv-tender-sur-1').innerHTML);
  ok(/\$156\.50 in total/.test($('inv-tender-sum').innerHTML), 'customer total 156.50', $('inv-tender-sum').innerHTML);
  ok(!$('inv-tender-go').disabled, 'Mark Completed enabled at $0.00 remaining');

  type('inv-tender-amt-1', '99.99');
  ok($('inv-tender-go').disabled && /Remaining to collect \$0\.01/.test($('inv-tender-remaining').textContent), 'one cent short disables it');
  type('inv-tender-amt-1', '100.01');
  ok($('inv-tender-go').disabled && /Over by \$0\.01/.test($('inv-tender-remaining').textContent), 'one cent over disables it');
  type('inv-tender-amt-1', '100');
  type('inv-tender-l4-1', '1111');
  type('inv-tender-ap-1', 'AP9');
  await sleep(450);
  ok(w.DRAFTS['inv-tender:42:7'] && w.DRAFTS['inv-tender:42:7'].rows[1].last4 === '1111', 'autosaved draft');

  // add / remove / max
  w.invTenderAdd(); w.invTenderAdd();
  ok(w._invTender.rows.length === 4 && !/Add another payment/.test($('inv-proc-modal').innerHTML), 'max 4, add button gone');
  w.invTenderRemove(3); w.invTenderRemove(2);
  ok(w._invTender.rows.length === 2 && !/Remove this payment/.test($('inv-proc-modal').innerHTML), 'back to 2, remove hidden at minimum');

  // complete
  w.API_REPLY = { ok: true, completed: true };
  await w.invTenderComplete(42);
  var post = w.CALLS.filter(function (c) { return c[0] === 'POST'; }).pop();
  ok(post && post[1] === '/invoices/42/tenders', 'posts to /tenders');
  ok(post && JSON.stringify(post[2].tenders) === JSON.stringify([
    { pay_type: 'Cash', amount: '53.50', card_last4: '', approval_code: '', collect_in_square: false },
    { pay_type: 'Visa', amount: '100.00', card_last4: '1111', approval_code: 'AP9', collect_in_square: false }]), 'payload exact', post && post[2]);
  ok(!$('inv-proc-modal') && !w.DRAFTS['inv-tender:42:7'] && /Paid as a split/.test(w.TOASTS.pop()), 'closed, draft cleared, toast');

  // ---- draft restore
  w.DRAFTS['inv-tender:42:7'] = { base: 15350, rows: [{ pay_type: 'Cash', amount: '10.00' }, { pay_type: 'Visa', amount: '143.50' }] };
  await w.invTenderOpen(42);
  ok($('inv-tender-amt-0').value === '10.00' && /Restored/.test(w.TOASTS.pop()), 'draft restored');
  w.invCloseSheet();
  w.DRAFTS['inv-tender:42:7'] = { base: 99999, rows: [{ pay_type: 'Cash', amount: '10.00' }, { pay_type: 'Visa', amount: '143.50' }] };
  await w.invTenderOpen(42);
  ok($('inv-tender-amt-0').value === '153.50', 'stale draft (total changed) ignored');

  // ---- run in Square
  pick('inv-tender-type-0', 'Cash'); type('inv-tender-amt-0', '53.50');
  pick('inv-tender-type-1', 'Visa'); type('inv-tender-amt-1', '100');
  w.API_REPLY = { ok: true, completed: false, pending_seqs: [2], invoice: { id: 42 }, tenders: [], tender_summary: {} };
  w.CALLS.length = 0;
  await w.invTenderRunSquare(1);
  var p2 = w.CALLS.filter(function (c) { return c[0] === 'POST'; }).pop();
  ok(p2 && p2[2].tenders[1].collect_in_square === true && p2[2].tenders[0].collect_in_square === false, 'line 2 marked for Square');
  ok(JSON.stringify(w.COLLECT.pop()) === '[42,2]', 'hands tender 2 to Square');

  // ---- resume with a Square-collected line
  w._currentInvoice = baseInv({
    tenders: [
      { seq: 1, pay_type: 'Mastercard', base_amount: '100.00', surcharge_amount: '3.00', tip_amount: '5.00', amount: '108.00', card_last4: '5555', collected_via: 'square', status: 'collected' },
      { seq: 2, pay_type: 'Visa', base_amount: '53.50', surcharge_amount: '1.61', tip_amount: '0', amount: '55.11', collected_via: 'square', status: 'pending' }
    ],
    tender_summary: { split_base: 153.50, pending: 1, remaining_to_collect: 55.11 }, tip_amount: '5.00'
  });
  await w.invTenderOpen(42);
  var html = $('inv-proc-modal').innerHTML;
  ok(/Paid in Square/.test(html) && /\$108\.00/.test(html) && !$('inv-tender-amt-0'), 'collected line locked read-only');
  ok(/Run this card in Square/.test(html), 'pending Square line offers Run');
  ok($('inv-tender-go').disabled, 'cannot complete while a Square line is pending');
  ok(!/>One payment</.test(html), 'no back-to-one-payment with Square money on it');
  w.invTenderManual(1);
  pick('inv-tender-type-1', 'Cash');
  ok(!$('inv-tender-go').disabled, 'switching the pending line to cash allows completing');
  var pl = w.invTenderPayload(-1);
  ok(pl[0].collect_in_square === true && pl[0].amount === '100.00' && pl[1].collect_in_square === false, 'locked line echoed back as Square', pl);

  // ---- server error lands in the sheet
  w.API_REPLY = w.eval("new Error('The payments are 0.01 short of the 153.50 to collect.')");
  await w.invTenderComplete(42);
  ok(/0\.01 short/.test($('inv-proc-err').textContent) && !$('inv-tender-go').disabled, 'server error shown, button re-enabled');
  w.invCloseSheet();

  // ---- invoice-page card
  var card = w.invTenderCardHtml(w._currentInvoice, true);
  ok(/Split payment/.test(card) && /Remaining to collect/.test(card) && /Continue split payment/.test(card) && /Not run yet/.test(card), 'in-progress card');
  var paid = w.invTenderCardHtml(Object.assign({}, w._currentInvoice, { status: 'paid', tender_summary: { remaining_to_collect: 0 } }), true);
  ok(!/Continue split payment/.test(paid) && !/Remaining to collect/.test(paid), 'settled card has no continue');
  ok(w.invTenderCardHtml(baseInv(), true) === '', 'no card without tenders');

  // ---- surcharge preview math matches the server (tip on invoice)
  w._currentInvoice = baseInv({ tip_amount: '10.00' });
  ok(w.invTenderSurchargeCents(11350, w._currentInvoice) === 320, 'tip excluded from the card share (3.20)');
  w._invSurchargeOn = false;
  ok(w.invTenderSurchargeCents(11350, w._currentInvoice) === 0, 'no surcharge when surcharging is off');

  // ---- Pulsar close-out: never the convenience fee, never a tip
  var pinv = baseInv({ tip_amount: '10.00', surcharge_amount: '3.20', grand_total: '166.70', parts_amount: '50.00', labor_amount: '100.00', pay_type: 'Split',
    tenders: [{ seq: 1, pay_type: 'Visa', base_amount: '113.50' }, { seq: 2, pay_type: 'Cash', base_amount: '50.00' }] });
  var pf = w.invPulsarFields(pinv);
  var payRow = pf.filter(function (r) { return r.label === 'Payment type'; })[0];
  var totRow = pf.filter(function (r) { return r.label === 'Payment total'; })[0];
  ok(totRow.copyValue === '153.50', 'Pulsar payment total is sales only (no fee, no tip)', totRow.copyValue);
  ok(payRow.copyValue === 'Credit Card 106.56, Cash 46.94', 'split shares are sales only and add up to 153.50', payRow.copyValue);
  ok(/Credit Card 106\.56 \+ Cash 46\.94/.test(payRow.display), 'display matches', payRow.display);
  var single = w.invPulsarFields(baseInv({ surcharge_amount: '4.61', grand_total: '158.11', pay_type: 'Visa', parts_amount: '50', labor_amount: '100' }));
  ok(single.filter(function (r) { return r.label === 'Payment total'; })[0].copyValue === '153.50', 'single card: fee excluded from Pulsar total');
  ok(!/Convenience|Surcharge|4\.61/i.test(JSON.stringify(single)), 'fee appears nowhere in the Pulsar numbers');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
