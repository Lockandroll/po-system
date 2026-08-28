// DOM assertions for the Square payment card and the attach flow. Evaluates the
// ACTUAL shipped source of the block inside jsdom, so a broken string concat or a
// raw apostrophe in an attribute shows up here rather than on a truck phone.
var fs = require('fs');
var { JSDOM } = require('jsdom');

var lines = fs.readFileSync('public/js/app.js', 'utf8').split(/\r?\n/);
var start = lines.findIndex(function (l) { return l.indexOf('// ---- Square payment collection') === 0; });
var end   = lines.findIndex(function (l) { return l.indexOf('function invStatusBadge(') === 0; });
if (start < 0 || end < 0) { console.error('could not locate the block', start, end); process.exit(2); }
var block = lines.slice(start, end).join('\n');
['invSquareCardHtml','invSqEntryLabel','invSqMoney','invSqAttachChoose','invSqAttachBtnHtml','invSqReportMiss','invSqAttemptStillOpen','invSqMissAlert','invCollectPayment','invSqAttach','invSqAttachTyped']
  .forEach(function (f) { if (block.indexOf('function ' + f) === -1) { console.error('block missed ' + f); process.exit(2); } });

// The boot deep-link parser lives far above; grab it too.
var bs = lines.findIndex(function (l) { return l.indexOf('// Deep link support: ?view=view-vr&id=123 from email buttons') !== -1; });
var be = bs; while (be < lines.length && lines[be].indexOf('})();') !== 0) be++;
var boot = lines.slice(bs, be + 1).join('\n');
if (boot.indexOf('_sqBootMissNonce') === -1) { console.error('boot slice missed the nonce capture'); process.exit(2); }

var pass = 0, fail = 0, bad = [];
function ok(n, c, x) { if (c) pass++; else { fail++; bad.push(n + (x !== undefined ? ' :: ' + String(JSON.stringify(x)).slice(0, 300) : '')); } }
function eq(n, a, b) { ok(n, a === b, { got: a, want: b }); }
function has(n, h, x) { ok(n, String(h).indexOf(x) !== -1, { got: String(h).slice(0, 400), want: x }); }
function hasnt(n, h, x) { ok(n, String(h).indexOf(x) === -1, { got: String(h).slice(0, 400), notWant: x }); }

var dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://nova.test/?view=view-invoice&id=42&sq_missing=1&sq_n=NONCE9', pretendToBeVisual: true, runScripts: 'outside-only' });
var w = dom.window;
global.window = w; global.document = w.document; global.URLSearchParams = w.URLSearchParams;

var shim = [
  "function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'); }",
  "function invMoney(n){ return '$' + (Number(n)||0).toFixed(2); }",
  "var state = { user: { id: 1, role: 'locksmith' }, currentView: 'view-invoice', currentParam: 42 };",
  "var __calls = [], __responses = {}, __alerts = [], __toasts = [], __confirms = [], __renders = 0;",
  "var __confirmAnswer = true;",
  "async function api(m,p,b){ __calls.push({m:m,p:p,b:b}); var k=m+' '+p; if(__responses[k] && __responses[k].__throw) throw __responses[k]; if(!(k in __responses)) throw new Error('no stub for '+k); return __responses[k]; }",
  "function apiBustCache(){}",
  "function novaAlert(m,o){ __alerts.push({m:m,o:o}); return Promise.resolve(); }",
  "function novaConfirm(m,o){ __confirms.push(m); return Promise.resolve(__confirmAnswer); }",
  "function novaSelect(){ return Promise.resolve('card'); }",
  "function showToast(m,k){ __toasts.push({m:m,k:k}); }",
  "function render(){ __renders++; }",
  "function navigate(){}",
  "function invSheet(t,b,f){ __sheet = { title:t, body:b, foot:f }; document.body.innerHTML = '<div id=\"inv-proc-modal\"><div id=\"inv-proc-err\"></div>'+b+'<div>'+f+'</div></div>'; return document.getElementById('inv-proc-modal'); }",
  "var __sheet = null;",
  "function invCloseSheet(){ __sheet = null; document.body.innerHTML=''; }",
  "function invSheetError(m){ __sheetErrors.push(m); } var __sheetErrors = [];",
  "function invStartGraceCountdown(){}",
  "var _currentInvoice = null, _invSurchargeOn = false, _invSurchargeRate = 0;",
  "var icons = { edit: '' };",
  "function tick(n){ return new Promise(function(r){ setTimeout(r, n||0); }); }"
].join('\n');

w.eval(shim + '\n' + boot + '\n' + block);

function inv(over) {
  return Object.assign({ id: 42, invoice_number: 500001, status: 'draft', square_enabled: true, grand_total: 220, square_payment: null }, over || {});
}

function run() {
  // ---- boot parser keeps the nonce -----------------------------------------
  eq('boot captured sq_missing', w._sqBootMissing, true);
  eq('boot captured sq_n', w._sqBootMissNonce, 'NONCE9');
  eq('boot did not mistake sq_n for sq', w._sqBootNonce, null);

  // ---- the attach button appears where a tech will need it -----------------
  var h = w.invSquareCardHtml(inv(), true, false);
  has('idle card offers Collect Payment', h, 'Collect Payment in Square');
  has('idle card offers the attach path', h, 'I ran this in the Square app');
  has('attach button calls with the id', h, 'invSqAttach(42)');

  var hFail = w.invSquareCardHtml(inv({ square_payment: { id: 7, status: 'failed', error_description: 'Declined.' } }), true, false);
  has('failed card offers attach', hFail, 'invSqAttach(42)');
  has('failed card still offers a retry', hFail, 'Try again');

  var hUnc = w.invSquareCardHtml(inv({ square_payment: { id: 7, status: 'unconfirmed' } }), true, false);
  has('unconfirmed card offers attach', hUnc, 'invSqAttach(42)');
  has('unconfirmed card still says do not re-run', hUnc, 'Do not run the card again');
  has('and explains the alternative', hUnc, 'Attach that payment instead of running it again');

  // Locked / settled invoices must NOT offer it.
  var hDone = w.invSquareCardHtml(inv({ status: 'paid', square_payment: { id: 7, status: 'reconciled', card_last4: '4242', total_cents: 22000, tip_cents: 0 } }), false, true);
  hasnt('settled card has no attach button', hDone, 'invSqAttach(');
  var hNoPerm = w.invSquareCardHtml(inv({ square_payment: { id: 7, status: 'failed' } }), false, false);
  hasnt('a read-only viewer gets no attach button', hNoPerm, 'invSqAttach(');
  var hNoSq = w.invSquareCardHtml(inv({ square_enabled: false, square_payment: { id: 7, status: 'failed' } }), true, false);
  hasnt('Square-off invoice gets no attach button', hNoSq, 'invSqAttach(');

  // ---- the picker ----------------------------------------------------------
  w.__responses['GET /invoices/42/square-candidates'] = {
    ok: true, expected_cents: 22000, capped: false, payments: [
      { id: 'PAY-GOOD', amount_cents: 22000, tip_cents: 0, card_brand: 'VISA', card_last4: '4242', entry_method: 'CONTACTLESS', taken_at: '2026-08-27T18:04:00Z', likely: true },
      { id: 'PAY-TIP', amount_cents: 24000, tip_cents: 2000, card_brand: 'MASTERCARD', card_last4: '1111', entry_method: 'KEYED', taken_at: '2026-08-27T17:40:00Z', likely: false }
    ]
  };
  return w.invSqAttach(42).then(function () {
    var b = w.__sheet.body;
    has('picker lists the matching card', b, 'PAY-GOOD');
    has('picker shows the amount', b, '$220.00');
    has('picker flags the match', b, 'Matches this invoice');
    has('picker names the entry method', b, 'Tap / contactless');
    has('picker shows a keyed one too', b, 'Keyed in');
    has('picker calls out the tip', b, 'includes $20.00 tip');
    has('picker offers a typed reference', b, 'inv-sq-ref');
    has('picker wires Use this', b, "invSqAttachChoose(42,'PAY-GOOD')");

    // The markup has to actually parse. A raw apostrophe in an attribute is the
    // house hazard (CLAUDE.md 1.2), and this is where it would show.
    var probe = w.document.createElement('div');
    probe.innerHTML = b;
    var btns = probe.querySelectorAll('button');
    eq('two Use this buttons parsed', btns.length, 2);
    eq('onclick survived intact', btns[0].getAttribute('onclick'), "invSqAttachChoose(42,'PAY-GOOD')");
    ok('an input for the typed reference exists', !!probe.querySelector('#inv-sq-ref'));

    // Nothing in the picker leaks a customer.
    hasnt('no email in the picker', b, '@');

    // ---- empty list still lets a tech paste a reference --------------------
    w.__responses['GET /invoices/42/square-candidates'] = { ok: true, expected_cents: 22000, payments: [] };
    return w.invSqAttach(42);
  }).then(function () {
    has('empty picker explains itself', w.__sheet.body, 'no unattached completed payments');
    has('empty picker still takes a reference', w.__sheet.body, 'inv-sq-ref');

    // ---- Square unreachable -----------------------------------------------
    w.__responses['GET /invoices/42/square-candidates'] = { ok: false, reason: 'lookup_failed', payments: [] };
    return w.invSqAttach(42);
  }).then(function () {
    has('lookup failure is explained', w.__sheet.body, 'could not reach Square');
    has('and the manual path survives it', w.__sheet.body, 'inv-sq-ref');

    // ---- a successful attach ----------------------------------------------
    w.__responses['POST /invoices/42/attach-square-payment'] = { ok: true, payment: { status: 'reconciled' } };
    w.__toasts.length = 0; w.__alerts.length = 0;
    return w.invSqAttachChoose(42, 'PAY-GOOD');
  }).then(function () {
    eq('success toasts', w.__toasts.length, 1);
    has('success wording', w.__toasts[0].m, 'Paid in Square');
    eq('success raises no alert', w.__alerts.length, 0);
    ok('sheet closed on success', w.__sheet === null);
    var last = w.__calls[w.__calls.length - 1];
    eq('posted to the right route', last.p, '/invoices/42/attach-square-payment');
    ok('no override sent by default', last.b.allow_other_location === undefined, last.b);

    // ---- a mismatch is surfaced, not swallowed ----------------------------
    w.__responses['POST /invoices/42/attach-square-payment'] = { ok: false, reason: 'amount_mismatch', payment: { status: 'mismatch' } };
    w.__toasts.length = 0; w.__alerts.length = 0;
    return w.invSqAttachChoose(42, 'PAY-WRONG');
  }).then(function () {
    eq('mismatch does NOT toast success', w.__toasts.length, 0);
    eq('mismatch alerts', w.__alerts.length, 1);
    has('with the shipped mismatch sentence', w.__alerts[0].m, 'Square charged a different amount');
    eq('under a Not settled title', w.__alerts[0].o.title, 'Not settled');

    // ---- the other-location override ---------------------------------------
    var e = new Error('That card was taken at a different Square location than JAX.');
    e.status = 409; e.data = { needs_override: true }; e.__throw = true;
    w.__responses['POST /invoices/42/attach-square-payment'] = e;
    w.__confirms.length = 0; w.__confirmAnswer = false;
    return w.invSqAttachChoose(42, 'PAY-OTHERCITY');
  }).then(function () {
    eq('manager is asked once', w.__confirms.length, 1);
    has('and the question names the problem', w.__confirms[0], 'different Square location');
    var declinedCalls = w.__calls.filter(function (c) { return c.b && c.b.allow_other_location; });
    eq('declining sends no override', declinedCalls.length, 0);

    // Saying yes retries once, with the flag, and does not loop.
    w.__confirmAnswer = true; w.__confirms.length = 0;
    var calls0 = w.__calls.length;
    return w.invSqAttachChoose(42, 'PAY-OTHERCITY');
  }).then(function () {
    eq('accepting asks only once', w.__confirms.length, 1);
    var forced = w.__calls.filter(function (c) { return c.b && c.b.allow_other_location === true; });
    eq('exactly one override attempt', forced.length, 1);

    // A tech (needs_override false) is simply told, never asked.
    var e2 = new Error('A manager has to attach this one.');
    e2.status = 409; e2.data = { needs_override: false }; e2.__throw = true;
    w.__responses['POST /invoices/42/attach-square-payment'] = e2;
    w.__confirms.length = 0; w.__sheetErrors.length = 0;
    return w.invSqAttachChoose(42, 'PAY-OTHERCITY');
  }).then(function () {
    eq('a tech is not asked', w.__confirms.length, 0);
    eq('a tech is told in the sheet', w.__sheetErrors.length, 1);
    has('with the manager instruction', w.__sheetErrors[0], 'manager');

    // ---- an empty typed reference is refused locally -----------------------
    w.__sheetErrors.length = 0;
    w.invSheet('x', '<input id="inv-sq-ref" />', '');
    w.invSqAttachTyped(42);
    eq('empty typed reference is refused', w.__sheetErrors.length, 1);

    // ---- the "did it really fail" check ------------------------------------
    var iso = new Date().toISOString();
    w.__responses['GET /invoices/42/payment-status?nonce=NONCE9'] = { payment: { id: 5, status: 'initiated', initiated_at: iso } };
    return w.invSqAttemptStillOpen(42, 'NONCE9');
  }).then(function (r) {
    ok('a fresh initiated attempt IS a real miss', r && r.id === 5, r);
    // A replayed navigation: the row is long since consumed.
    w.__responses['GET /invoices/42/payment-status?nonce=NONCE9'] = { payment: { id: 5, status: 'canceled', initiated_at: new Date().toISOString() } };
    return w.invSqAttemptStillOpen(42, 'NONCE9');
  }).then(function (r) {
    eq('a consumed attempt is NOT a miss', r, null);
    w.__responses['GET /invoices/42/payment-status?nonce=NONCE9'] = { payment: { id: 5, status: 'reconciled', initiated_at: new Date().toISOString() } };
    return w.invSqAttemptStillOpen(42, 'NONCE9');
  }).then(function (r) {
    eq('a settled attempt is NOT a miss', r, null);
    // An old abandoned row is not this tap either.
    w.__responses['GET /invoices/42/payment-status?nonce=NONCE9'] = { payment: { id: 5, status: 'initiated', initiated_at: new Date(Date.now() - 10 * 60000).toISOString() } };
    return w.invSqAttemptStillOpen(42, 'NONCE9');
  }).then(function (r) {
    eq('a ten-minute-old attempt is NOT this tap', r, null);
    return w.invSqAttemptStillOpen(42, null);
  }).then(function (r) {
    eq('no nonce means no accusation', r, null);
    var eOff = new Error('offline'); eOff.__throw = true;
    w.__responses['GET /invoices/42/payment-status?nonce=NONCE9'] = eOff;
    return w.invSqAttemptStillOpen(42, 'NONCE9');
  }).then(function (r) {
    eq('a failed check never accuses either', r, null);

    // ---- the replay case end to end: silence -------------------------------
    w.__alerts.length = 0;
    w.__responses['GET /invoices/42/payment-status?nonce=NONCE9'] = { payment: { id: 5, status: 'canceled', initiated_at: new Date().toISOString() } };
    return w.invSqReportMiss(42, 'NONCE9');
  }).then(function () {
    eq('a replayed fallback says NOTHING', w.__alerts.length, 0);
    var cancels = w.__calls.filter(function (c) { return c.p.indexOf('/cancel') !== -1; });
    eq('and cancels nothing', cancels.length, 0);

    // ---- a genuine miss: one clear message, and the row is closed ----------
    w.__alerts.length = 0; w.__calls.length = 0;
    w.__responses['GET /invoices/42/payment-status?nonce=NONCE9'] = { payment: { id: 5, status: 'initiated', initiated_at: new Date().toISOString() } };
    w.__responses['POST /invoices/42/payments/5/cancel'] = { ok: true };
    return w.invSqReportMiss(42, 'NONCE9');
  }).then(function () {
    eq('a real miss alerts once', w.__alerts.length, 1);
    var m = w.__alerts[0].m;
    hasnt('and NEVER tells anyone to reinstall', m, 'reinstall');
    hasnt('and does not open with install-from-the-app-store', m, 'Install it from the app store');
    hasnt('and does not claim Square is not installed', m, 'is not installed on this phone');
    has('it says nothing was charged', m, 'nothing was charged');
    has('it gives the actual fix', m, 'Open Square from your home screen');
    has('and only then mentions a missing app', m, 'If Square is not on this phone at all');
    eq('the title is about opening, not installing', w.__alerts[0].o.title, 'Square did not open');
    var cancels = w.__calls.filter(function (c) { return c.p.indexOf('/payments/5/cancel') !== -1; });
    eq('the dead attempt is closed so the button returns', cancels.length, 1);
  });
}

run().then(function () {
  console.log('');
  console.log('pass ' + pass + '  fail ' + fail);
  if (fail) { bad.forEach(function (b) { console.log('  FAIL ' + b); }); process.exit(1); }
}, function (e) { console.error('HARNESS ERROR:', e); process.exit(2); });
