// Verification harness for the Square "install the app" false positive fix, the
// Android error-code normalizer, and the attach-a-Square-payment path.
//
// Real Postgres, real initDB(), the real routers, real HTTP. Square itself is
// faked at the fetch boundary, so everything Nova ships is exercised.

process.env.DATABASE_URL = 'postgres://tester@/squaretest?host=/tmp&port=55432';
process.env.SQUARE_ACCESS_TOKEN = 'sq-token';
process.env.SQUARE_APPLICATION_ID = 'sq-app';
process.env.SQUARE_STATE_SECRET = 'sq-secret';
process.env.SQUARE_POS_CALLBACK_URL = 'https://nova.test/api/square/pos-callback';
process.env.SQUARE_RETURN_BASE = 'https://nova.test';
process.env.APP_URL = 'https://nova.test';

var express = require('express');
var http = require('http');
var path = require('path');
var { pool, initDB } = require('./db');

// ---- auth stub, pushed into the module cache under the real resolved path ----
var authPath = require.resolve('./middleware/auth');
var CURRENT = null;
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, exports: {
    requireAuth: function (req, res, next) {
      if (!CURRENT) return res.status(401).json({ error: 'no user' });
      req.user = Object.assign({}, CURRENT);
      next();
    },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
  }
};

// ---- Square at the fetch boundary -------------------------------------------
var SQ = { payments: {}, list: [], orders: {}, calls: [] };
var realFetch = global.fetch;
global.fetch = async function (url, opts) {
  var u = String(url);
  if (u.indexOf('connect.squareup') === -1) return realFetch(url, opts);
  SQ.calls.push(u);
  var m = u.match(/\/v2\/payments\/([^?]+)$/);
  if (m) {
    var p = SQ.payments[decodeURIComponent(m[1])];
    if (!p) return new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }), { status: 404 });
    return new Response(JSON.stringify({ payment: p }), { status: 200 });
  }
  if (u.indexOf('/v2/payments?') !== -1) {
    var q = new URL(u).searchParams;
    var loc = q.get('location_id');
    var b = Date.parse(q.get('begin_time')), e = Date.parse(q.get('end_time'));
    var out = SQ.list.filter(function (x) {
      var t = Date.parse(x.created_at);
      return (!loc || x.location_id === loc) && t >= b && t <= e;
    });
    if (q.get('sort_order') === 'ASC') out.sort(function (a, b2) { return Date.parse(a.created_at) - Date.parse(b2.created_at); });
    else out.sort(function (a, b2) { return Date.parse(b2.created_at) - Date.parse(a.created_at); });
    return new Response(JSON.stringify({ payments: out }), { status: 200 });
  }
  var om = u.match(/\/v2\/orders\/([^?]+)$/);
  if (om) {
    var o = SQ.orders[decodeURIComponent(om[1])];
    if (!o) return new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }), { status: 404 });
    return new Response(JSON.stringify({ order: o }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 200 });
};

var invoices = require('./routes/invoices');
var squareRoutes = require('./routes/square');
var square = require('./utils/square');

var app = express();
app.use('/api/square', express.urlencoded({ extended: false }), squareRoutes);
app.use(express.json({ limit: '20mb' }));
app.use('/api/invoices', invoices);
var server = http.createServer(app);

var pass = 0, fail = 0, bad = [];
function ok(n, c, x) { if (c) pass++; else { fail++; bad.push(n + (x !== undefined ? ' :: ' + String(JSON.stringify(x)).slice(0, 400) : '')); } }
function eq(n, a, b) { ok(n, a === b, { got: a, want: b }); }
function has(n, h, x) { ok(n, String(h).indexOf(x) !== -1, { got: String(h).slice(0, 300), want: x }); }

var BASE;
async function req(method, p, body, form) {
  var opts = { method: method, headers: {} };
  if (form) { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body).toString(); }
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  var r = await realFetch(BASE + p, Object.assign(opts, { redirect: 'manual' }));
  var t = await r.text();
  var j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: j, text: t, location: r.headers.get('location') };
}

var TECH = { id: 0, name: 'Mike', role: 'locksmith' };
var MGR  = { id: 0, name: 'Tony', role: 'admin' };
var LOC = 'LOCJAX1';

async function seed() {
  await pool.query("DELETE FROM invoice_payments");
  await pool.query("DELETE FROM square_orphan_payments");
  await pool.query("DELETE FROM invoice_line_items");
  await pool.query("DELETE FROM invoices");
  await pool.query("DELETE FROM users WHERE email LIKE 'sqtest%'");
  await pool.query("DELETE FROM cities WHERE code = 'JAX'");
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('square_location_map', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify({ JAX: LOC })]
  );
  var c = await pool.query("INSERT INTO cities (code, name, active) VALUES ('JAX','Jacksonville',true) RETURNING id");
  var t = await pool.query("INSERT INTO users (email,name,password_hash,role,active) VALUES ('sqtest-mike@x.co','Mike','x','locksmith',true) RETURNING id");
  var m = await pool.query("INSERT INTO users (email,name,password_hash,role,active) VALUES ('sqtest-tony@x.co','Tony','x','admin',true) RETURNING id");
  TECH.id = t.rows[0].id; MGR.id = m.rows[0].id;
  return c.rows[0].id;
}

// subtotal 200, tax 20, surcharge 0 -> pre-tip base 22000 cents, grand 220
async function newInvoice(num, over) {
  var o = over || {};
  var r = await pool.query(
    "INSERT INTO invoices (invoice_number, city_code, locksmith_id, status, customer_name, subtotal, tax_amount, surcharge_amount, grand_total, invoice_date, created_at) " +
    "VALUES ($1,'JAX',$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE,NOW()) RETURNING *",
    [num, TECH.id, o.status || 'draft', o.customer === null ? null : (o.customer || 'A Customer'),
     o.subtotal != null ? o.subtotal : 200, o.tax != null ? o.tax : 20,
     o.surcharge != null ? o.surcharge : 0, o.grand != null ? o.grand : 220]
  );
  await pool.query("INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price) VALUES ($1,'work',1,200)", [r.rows[0].id]);
  return r.rows[0];
}

function mkPayment(id, cents, over) {
  var o = over || {};
  return {
    id: id, order_id: o.order_id || ('ORD-' + id), status: o.status || 'COMPLETED',
    location_id: o.location_id || LOC,
    total_money: { amount: cents, currency: 'USD' },
    amount_money: { amount: cents - (o.tip || 0), currency: 'USD' },
    tip_money: { amount: o.tip || 0, currency: 'USD' },
    card_details: { entry_method: o.entry || 'KEYED', auth_result_code: o.auth || 'AUTH1',
      avs_status: 'AVS_ACCEPTED', cvv_status: 'CVV_ACCEPTED',
      card: { card_brand: o.brand || 'VISA', last_4: o.last4 || '4242' } },
    receipt_number: o.receipt || 'RC01', receipt_url: 'https://sq/r/' + id,
    note: o.note || '', created_at: o.at || new Date().toISOString(),
    processing_fee: [{ amount_money: { amount: 300 } }]
  };
}

async function run() {
  await initDB();
  var cityId = await seed();

  // =========================================================================
  // 1. The fallback URL now carries the nonce (Task 1's whole mechanism)
  // =========================================================================
  CURRENT = TECH;
  var inv1 = await newInvoice(500001);
  var start = await req('POST', '/api/invoices/' + inv1.id + '/collect-payment', { platform: 'android' });
  eq('collect-payment 200', start.status, 200);
  ok('android url built', !!(start.body && start.body.android_url));
  var nonce = start.body && start.body.nonce;
  ok('nonce returned', !!nonce);
  var fb = decodeURIComponent((start.body.android_url.match(/S\.browser_fallback_url=([^;]+)/) || [])[1] || '');
  has('fallback has sq_missing', fb, 'sq_missing=1');
  has('fallback has sq_n', fb, 'sq_n=' + nonce);
  has('fallback returns to the invoice', fb, 'view=view-invoice&id=' + inv1.id);

  // The SPA asks about THIS attempt. Freshly started => still initiated, so a
  // real miss is reported.
  var ps = await req('GET', '/api/invoices/' + inv1.id + '/payment-status?nonce=' + nonce);
  eq('status is initiated', ps.body.payment.status, 'initiated');
  ok('initiated_at present', !!ps.body.payment.initiated_at);
  ok('state_nonce never leaves the server', ps.body.payment.state_nonce === undefined);
  ok('raw_payment never leaves the server', ps.body.payment.raw_payment === undefined);

  // ...and once the attempt is consumed, the SAME sq_n replayed by a restored
  // tab no longer reads as initiated. That is the false positive, gone.
  await req('POST', '/api/invoices/' + inv1.id + '/payments/' + ps.body.payment.id + '/cancel', {});
  var ps2 = await req('GET', '/api/invoices/' + inv1.id + '/payment-status?nonce=' + nonce);
  eq('replayed nonce reads canceled', ps2.body.payment.status, 'canceled');
  ok('replay is NOT initiated', ps2.body.payment.status !== 'initiated');

  // =========================================================================
  // 2. Android error codes: the callback now recognises a cancel
  // =========================================================================
  var inv2 = await newInvoice(500002);
  var s2 = await req('POST', '/api/invoices/' + inv2.id + '/collect-payment', { platform: 'android' });
  var state2 = decodeURIComponent((s2.body.android_url.match(/REQUEST_METADATA=([^;]+)/) || [])[1] || '');
  var cb = await req('POST', '/api/square/pos-callback', {
    'com.squareup.pos.REQUEST_METADATA': state2,
    'com.squareup.pos.ERROR_CODE': 'com.squareup.pos.ERROR_TRANSACTION_CANCELED'
  }, true);
  eq('callback redirects', cb.status, 302);
  var row2 = (await pool.query('SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1', [inv2.id])).rows[0];
  eq('android cancel is CANCELED, not unconfirmed', row2.status, 'canceled');
  eq('stored code is normalized', row2.error_code, 'TRANSACTION_CANCELED');
  eq('plain-English cancel text', row2.error_description, 'Payment canceled.');
  var inv2b = (await pool.query('SELECT status FROM invoices WHERE id = $1', [inv2.id])).rows[0];
  eq('a cancel never pays the invoice', inv2b.status, 'draft');

  // A not-signed-in error now reaches the tech with the actionable sentence.
  var s2c = await req('POST', '/api/invoices/' + inv2.id + '/collect-payment', { platform: 'android' });
  var st2c = decodeURIComponent((s2c.body.android_url.match(/REQUEST_METADATA=([^;]+)/) || [])[1] || '');
  await req('POST', '/api/square/pos-callback', {
    'com.squareup.pos.REQUEST_METADATA': st2c,
    'com.squareup.pos.ERROR_CODE': 'com.squareup.pos.ERROR_USER_NOT_LOGGED_IN'
  }, true);
  var row2c = (await pool.query('SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1', [inv2.id])).rows[0];
  eq('android not-signed-in is failed', row2c.status, 'failed');
  eq('android not-signed-in text', row2c.error_description, 'Sign in to the Square app first, then tap Collect Payment again.');

  // The safety net SURVIVES: an unrecognised Android code still goes to
  // 'unconfirmed', never to 'failed'. That is what stops a captured card from
  // being declared a failure and re-run.
  var inv2d = await newInvoice(500003);
  await pool.query("INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price) VALUES ($1,'work',1,200)", [inv2d.id]);
  var s2d = await req('POST', '/api/invoices/' + inv2d.id + '/collect-payment', { platform: 'android' });
  var st2d = decodeURIComponent((s2d.body.android_url.match(/REQUEST_METADATA=([^;]+)/) || [])[1] || '');
  await req('POST', '/api/square/pos-callback', {
    'com.squareup.pos.REQUEST_METADATA': st2d,
    'com.squareup.pos.ERROR_CODE': 'com.squareup.pos.ERROR_SOMETHING_BRAND_NEW'
  }, true);
  var row2d = (await pool.query('SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1', [inv2d.id])).rows[0];
  eq('unknown android code stays unconfirmed', row2d.status, 'unconfirmed');

  // =========================================================================
  // 3. Attach a Square payment run in the Square app by hand
  // =========================================================================
  var inv3 = await newInvoice(500010);
  var good = mkPayment('PAY-GOOD', 22000, { receipt: 'AB12', entry: 'KEYED' });
  var wrong = mkPayment('PAY-WRONG', 9900, { receipt: 'ZZ99' });
  var elsewhere = mkPayment('PAY-OTHERCITY', 22000, { location_id: 'LOCTPA1' });
  var pending = mkPayment('PAY-PENDING', 22000, { status: 'APPROVED', receipt: 'PP01' });
  [good, wrong, elsewhere, pending].forEach(function (p) { SQ.payments[p.id] = p; SQ.list.push(p); });

  CURRENT = TECH;
  var cand = await req('GET', '/api/invoices/' + inv3.id + '/square-candidates');
  eq('candidates 200', cand.status, 200);
  ok('candidates ok', cand.body.ok === true);
  var ids = cand.body.payments.map(function (x) { return x.id; });
  ok('good payment listed', ids.indexOf('PAY-GOOD') !== -1, ids);
  ok('wrong-amount payment still listed', ids.indexOf('PAY-WRONG') !== -1, ids);
  ok('other city NOT listed', ids.indexOf('PAY-OTHERCITY') === -1, ids);
  ok('not-completed NOT listed', ids.indexOf('PAY-PENDING') === -1, ids);
  eq('matching one is flagged', cand.body.payments[0].id, 'PAY-GOOD');
  ok('match flag set', cand.body.payments[0].likely === true);
  ok('non-match flag clear', cand.body.payments.filter(function (x) { return x.id === 'PAY-WRONG'; })[0].likely === false);
  eq('expected base cents', cand.body.expected_cents, 22000);
  ok('no customer data in candidates', cand.body.payments.every(function (x) { return x.customer_id === undefined; }));

  // Attach by payment id.
  var at = await req('POST', '/api/invoices/' + inv3.id + '/attach-square-payment', { square_payment_id: 'PAY-GOOD' });
  eq('attach 200', at.status, 200);
  ok('attach settled it', at.body.ok === true, at.body);
  eq('row reconciled', at.body.payment.status, 'reconciled');
  eq('row is platform manual', at.body.payment.platform, 'manual');
  eq('square payment id stored', at.body.payment.square_payment_id, 'PAY-GOOD');
  eq('order id adopted from Square', at.body.payment.square_order_id, 'ORD-PAY-GOOD');
  eq('last4 from Square not typed', at.body.payment.card_last4, '4242');
  eq('approval code from Square', at.body.payment.auth_result_code, 'AUTH1');
  eq('entry method recorded', at.body.payment.entry_method, 'KEYED');
  var inv3b = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv3.id])).rows[0];
  eq('invoice is paid', inv3b.status, 'paid');
  eq('grand total unchanged', Number(inv3b.grand_total), 220);
  eq('card last4 on the invoice', inv3b.card_last4, '4242');
  eq('approval code on the invoice', inv3b.approval_code, 'AUTH1');
  eq('pay type from the brand', inv3b.pay_type, 'Visa');
  ok('completed_at stamped', !!inv3b.completed_at);
  var aud = await pool.query("SELECT * FROM audit_logs WHERE entity_id = $1 AND action = 'square_payment_attached'", [inv3.id]);
  eq('the pointing is audited', aud.rows.length, 1);
  eq('audit names the user', aud.rows[0].user_name, 'Mike');
  var aud2 = await pool.query("SELECT * FROM audit_logs WHERE entity_id = $1 AND action = 'paid_via_square'", [inv3.id]);
  eq('the money write is audited too', aud2.rows.length, 1);

  // Same payment cannot be attached to a second invoice.
  var inv4 = await newInvoice(500011);
  var dup = await req('POST', '/api/invoices/' + inv4.id + '/attach-square-payment', { square_payment_id: 'PAY-GOOD' });
  eq('duplicate attach refused', dup.status, 409);
  has('and it names the invoice', dup.body.error, '500010');
  var n4 = await pool.query('SELECT COUNT(*)::int c FROM invoice_payments WHERE invoice_id = $1', [inv4.id]);
  eq('no row left behind on refusal', n4.rows[0].c, 0);

  // An already-settled invoice refuses a second attach.
  var again = await req('POST', '/api/invoices/' + inv3.id + '/attach-square-payment', { square_payment_id: 'PAY-WRONG' });
  eq('second attach on a settled invoice refused', again.status, 409);

  // A wrong-amount pick is a MISMATCH, never a silent payment.
  var inv5 = await newInvoice(500012);
  var mm = await req('POST', '/api/invoices/' + inv5.id + '/attach-square-payment', { square_payment_id: 'PAY-WRONG' });
  eq('mismatch attach 200', mm.status, 200);
  ok('mismatch does NOT settle', mm.body.ok === false, mm.body);
  eq('reason is amount_mismatch', mm.body.reason, 'amount_mismatch');
  eq('row is mismatch', mm.body.payment.status, 'mismatch');
  var inv5b = (await pool.query('SELECT status, card_last4 FROM invoices WHERE id = $1', [inv5.id])).rows[0];
  eq('the invoice is NOT paid', inv5b.status, 'draft');
  ok('and nothing was written to the card fields', !inv5b.card_last4);
  ok('mismatch_reason quotes both bases', String(mm.body.payment.mismatch_reason).indexOf('220.00') !== -1, mm.body.payment.mismatch_reason);

  // Receipt number works when the tech only has the paper.
  var inv6 = await newInvoice(500013);
  var byRc = mkPayment('PAY-RC', 22000, { receipt: 'QQ77' });
  SQ.payments[byRc.id] = byRc; SQ.list.push(byRc);
  var rc = await req('POST', '/api/invoices/' + inv6.id + '/attach-square-payment', { square_payment_id: 'QQ77' });
  ok('receipt number attaches', rc.body && rc.body.ok === true, rc.body);
  eq('right payment found by receipt', rc.body.payment.square_payment_id, 'PAY-RC');
  var rcLower = 'qq77';

  // Junk is a clean 404, not a 500, and leaves nothing behind.
  var inv7 = await newInvoice(500014);
  var junk = await req('POST', '/api/invoices/' + inv7.id + '/attach-square-payment', { square_payment_id: 'NOPE-NOT-A-THING' });
  eq('junk reference 404', junk.status, 404);
  has('junk message names the city', junk.body.error, 'JAX');
  var n7 = await pool.query('SELECT COUNT(*)::int c FROM invoice_payments WHERE invoice_id = $1', [inv7.id]);
  eq('junk leaves no row', n7.rows[0].c, 0);
  var empty = await req('POST', '/api/invoices/' + inv7.id + '/attach-square-payment', {});
  eq('empty reference 400', empty.status, 400);

  // An APPROVED-but-not-captured payment must not settle an invoice.
  var appr = await req('POST', '/api/invoices/' + inv7.id + '/attach-square-payment', { square_payment_id: 'PAY-PENDING' });
  eq('not-completed refused', appr.status, 400);
  has('and says what Square reports', appr.body.error, 'approved');

  // A payment taken at ANOTHER city's Square location. The picker never offers
  // one, but typing the id reaches Square directly, and the amount check has
  // nothing to say about geography. It must not settle silently.
  var inv8 = await newInvoice(500015);
  CURRENT = TECH;
  var other = await req('POST', '/api/invoices/' + inv8.id + '/attach-square-payment', { square_payment_id: 'PAY-OTHERCITY' });
  eq('other-city attach refused', other.status, 409);
  has('and names the invoice city', other.body.error, 'JAX');
  has('and says why it matters', other.body.error, 'wrong city');
  ok('a tech gets NO override', other.body.needs_override === false, other.body);
  has('a tech is told to get a manager', other.body.error, 'manager');
  var n8 = await pool.query('SELECT COUNT(*)::int c FROM invoice_payments WHERE invoice_id = $1', [inv8.id]);
  eq('refusal leaves no row', n8.rows[0].c, 0);
  var inv8b = (await pool.query('SELECT status FROM invoices WHERE id = $1', [inv8.id])).rows[0];
  eq('and the invoice is untouched', inv8b.status, 'draft');

  CURRENT = MGR;
  var mgrTry = await req('POST', '/api/invoices/' + inv8.id + '/attach-square-payment', { square_payment_id: 'PAY-OTHERCITY' });
  eq('a manager is stopped too, first time', mgrTry.status, 409);
  ok('but IS offered the override', mgrTry.body.needs_override === true, mgrTry.body);
  eq('and told both locations', mgrTry.body.payment_location_id, 'LOCTPA1');
  eq('invoice location named too', mgrTry.body.invoice_location_id, LOC);
  var mgrForce = await req('POST', '/api/invoices/' + inv8.id + '/attach-square-payment', { square_payment_id: 'PAY-OTHERCITY', allow_other_location: true });
  ok('the deliberate override goes through', mgrForce.body && mgrForce.body.ok === true, mgrForce.body);
  eq('and the row records where the money really was', mgrForce.body.payment.square_location_id, 'LOCTPA1');
  var ovAud = await pool.query("SELECT details FROM audit_logs WHERE entity_id = $1 AND action = 'square_payment_attached'", [inv8.id]);
  eq("the override is audited", JSON.parse(ovAud.rows[0].details).other_location_override, true);
  eq("and both locations are on the audit row", JSON.parse(ovAud.rows[0].details).invoice_location_id, LOC);

  CURRENT = TECH;

  // The orphan row for a payment the tech claims stops being an orphan.
  await pool.query(
    "INSERT INTO square_orphan_payments (square_payment_id, location_id, amount_cents, resolved) VALUES ('PAY-ORPH',$1,22000,false)",
    [LOC]
  );
  var orph = mkPayment('PAY-ORPH', 22000, { receipt: 'OR01' });
  SQ.payments[orph.id] = orph; SQ.list.push(orph);
  var inv9 = await newInvoice(500016);
  var oa = await req('POST', '/api/invoices/' + inv9.id + '/attach-square-payment', { square_payment_id: 'PAY-ORPH' });
  ok('orphan attaches', oa.body && oa.body.ok === true, oa.body);
  var orphRow = (await pool.query("SELECT resolved FROM square_orphan_payments WHERE square_payment_id = 'PAY-ORPH'")).rows[0];
  eq('orphan marked resolved', orphRow.resolved, true);

  // Scoping: another tech cannot attach to someone else's invoice; a manager can.
  var inv10 = await newInvoice(500017);
  var p10 = mkPayment('PAY-SCOPE', 22000, { receipt: 'SC01' });
  SQ.payments[p10.id] = p10; SQ.list.push(p10);
  CURRENT = { id: TECH.id + 9999, name: 'Someone Else', role: 'locksmith' };
  var denied = await req('POST', '/api/invoices/' + inv10.id + '/attach-square-payment', { square_payment_id: 'PAY-SCOPE' });
  eq('another tech is denied', denied.status, 403);
  var deniedList = await req('GET', '/api/invoices/' + inv10.id + '/square-candidates');
  eq('and cannot list either', deniedList.status, 403);
  CURRENT = MGR;
  var mgrOk = await req('POST', '/api/invoices/' + inv10.id + '/attach-square-payment', { square_payment_id: 'PAY-SCOPE' });
  ok('a manager can attach', mgrOk.body && mgrOk.body.ok === true, mgrOk.body);

  // A city with no Square location says so instead of searching the wrong one.
  CURRENT = MGR;
  var invNC = (await pool.query(
    "INSERT INTO invoices (invoice_number, city_code, locksmith_id, status, customer_name, subtotal, tax_amount, surcharge_amount, grand_total, invoice_date) " +
    "VALUES (500018,'TPA',$1,'draft','A Customer',200,20,0,220,CURRENT_DATE) RETURNING *", [TECH.id])).rows[0];
  await pool.query("INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price) VALUES ($1,'work',1,200)", [invNC.id]);
  var nc = await req('GET', '/api/invoices/' + invNC.id + '/square-candidates');
  eq('unmapped city 400', nc.status, 400);
  has('and names the city', nc.body.error, 'TPA');

  // A tip added inside Square rides through, same as the deep-link path.
  var inv11 = await newInvoice(500019);
  var tipped = mkPayment('PAY-TIP', 24000, { tip: 2000, receipt: 'TP01' });
  SQ.payments[tipped.id] = tipped; SQ.list.push(tipped);
  var tp = await req('POST', '/api/invoices/' + inv11.id + '/attach-square-payment', { square_payment_id: 'PAY-TIP' });
  ok('tipped payment settles', tp.body && tp.body.ok === true, tp.body);
  var inv11b = (await pool.query('SELECT grand_total, tip_amount, authorized_total FROM invoices WHERE id = $1', [inv11.id])).rows[0];
  eq('tip recorded', Number(inv11b.tip_amount), 20);
  eq('grand total includes the tip', Number(inv11b.grand_total), 240);
  eq('authorized total keeps the signed figure', Number(inv11b.authorized_total), 220);

  // An unfinished invoice cannot be settled by attaching either. Same gate as
  // Collect Payment, because the outcome is the same: paid and completed.
  var invG = await newInvoice(500020, { customer: null });
  var pg = mkPayment('PAY-GATE', 22000, { receipt: 'GT01' });
  SQ.payments[pg.id] = pg; SQ.list.push(pg);
  CURRENT = MGR;
  var gated = await req('POST', '/api/invoices/' + invG.id + '/attach-square-payment', { square_payment_id: 'PAY-GATE' });
  eq('unfinished invoice refuses the attach', gated.status, 400);
  has('and names what is missing', gated.body.error, 'customer name');
  has('and says the money is safe', gated.body.error, 'stays in Square');
  var nG = await pool.query('SELECT COUNT(*)::int c FROM invoice_payments WHERE invoice_id = $1', [invG.id]);
  eq('gated attach leaves no row', nG.rows[0].c, 0);
  await pool.query("UPDATE invoices SET customer_name = 'Fixed Now' WHERE id = $1", [invG.id]);
  var ungated = await req('POST', '/api/invoices/' + invG.id + '/attach-square-payment', { square_payment_id: 'PAY-GATE' });
  ok('and it works once the field is filled in', ungated.body && ungated.body.ok === true, ungated.body);

  console.log('');
  console.log('pass ' + pass + '  fail ' + fail);
  if (fail) { bad.forEach(function (b) { console.log('  FAIL ' + b); }); }
  return fail;
}

server.listen(0, async function () {
  BASE = 'http://127.0.0.1:' + server.address().port;
  var code = 1;
  try { code = await run(); }
  catch (e) { console.error('HARNESS ERROR:', e); code = 2; }
  finally { server.close(); await pool.end(); process.exit(code ? 1 : 0); }
});
