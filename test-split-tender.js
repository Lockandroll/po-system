'use strict';
/*
 * Split tender harness -- runs against a REAL Postgres with the REAL db.js
 * initDB() schema, the real routes/invoices.js router, the real
 * utils/invoiceTenders.js and the real utils/square.js reconcile writer.
 * Only Square's HTTP API (global fetch) and outbound email/SMS/push are faked.
 *
 *   DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/nova_test node test-split-tender.js
 *
 * Covers: validation (count, sum to the cent, billed types refused), per-card
 * surcharge (cash share never surcharged), all-manual split finishing the
 * invoice, card + Square split where the invoice finishes only when the Square
 * line reconciles, Square tip on a line, re-running reconcile is a no-op, a
 * wrong Square amount flags mismatch and does not settle, the same Square
 * payment cannot settle two lines, whole-invoice Collect Payment refused while a
 * split exists, going back to one payment reprices, Pay-method / edit / reopen
 * behaviour with and without Square money on the plan.
 */
var http = require('http');
var Module = require('module');

process.env.SQUARE_ACCESS_TOKEN = 'tok';
process.env.SQUARE_APPLICATION_ID = 'app';
process.env.SQUARE_STATE_SECRET = 'sec';
process.env.SQUARE_POS_CALLBACK_URL = 'https://example.test/cb';
process.env.APP_URL = 'https://example.test';

var CURRENT_USER = null;
var NOOP = async function () {};
var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = CURRENT_USER; next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
  };
  if (request === '../utils/email' || request === './email') return { sendEmail: NOOP, sendEmailDetailed: NOOP, emailTemplate: function (a, b) { return String(b || ''); } };
  if (request === '../utils/sms') return { sendSms: NOOP };
  if (request === '../utils/notify' || request === './notify') return { notify: NOOP, send: NOOP, broadcastRecipients: async function () { return []; } };
  if (request === '../utils/push' || request === './push') return { send: NOOP, sendToUser: NOOP, sendToUsers: NOOP, sendPushToUsers: NOOP };
  if (request === '../utils/r2') return { put: NOOP, get: NOOP, del: NOOP, presignPut: NOOP, presignGet: NOOP, head: NOOP };
  if (request === '../utils/disputePdf') return { buildDisputePdf: NOOP };
  if (request === '../jobs/taskReminders') return { notifyTaskAssigned: NOOP, notifyTaskCc: NOOP };
  return origLoad.apply(this, arguments);
};

// ---- fake Square API ------------------------------------------------------
var SQ = { orders: {}, payments: {} };
var RUN = String(Date.now());
global.fetch = async function (url, opts) {
  var path = String(url).replace(/^https:\/\/[^/]+/, '');
  var m;
  var body = null, status = 200;
  if ((m = /^\/v2\/orders\/([^?]+)/.exec(path))) {
    var o = SQ.orders[decodeURIComponent(m[1])];
    if (o) body = { order: o }; else { status = 404; body = { errors: [{ code: 'NOT_FOUND' }] }; }
  } else if ((m = /^\/v2\/payments\/([^?]+)/.exec(path))) {
    var p = SQ.payments[decodeURIComponent(m[1])];
    if (p) body = { payment: p }; else { status = 404; body = { errors: [{ code: 'NOT_FOUND' }] }; }
  } else if (/^\/v2\/payments\?/.test(path)) {
    body = { payments: Object.keys(SQ.payments).map(function (k) { return SQ.payments[k]; }) };
  } else { status = 404; body = { errors: [{ code: 'NOT_FOUND' }] }; }
  return { ok: status < 400, status: status, text: async function () { return JSON.stringify(body); } };
};
function sqPayment(id, orderId, amountCents, tipCents, brand, last4, note) {
  SQ.orders[orderId] = { id: orderId, tenders: [{ payment_id: id }], line_items: [{ name: note || '', note: note || '' }] };
  SQ.payments[id] = {
    id: id, order_id: orderId, status: 'COMPLETED', note: note || '',
    amount_money: { amount: amountCents }, tip_money: { amount: tipCents || 0 },
    total_money: { amount: amountCents + (tipCents || 0) },
    card_details: { card: { card_brand: brand || 'VISA', last_4: last4 || '4242' }, auth_result_code: 'AUTH' + String(id).length, entry_method: 'EMV' },
    receipt_url: 'https://sq/r/' + id, created_at: new Date().toISOString()
  };
}

var db = require('./db');
var pool = db.pool;
var express = require('express');
var square = require('./utils/square');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function c(n) { return Math.round((parseFloat(n) || 0) * 100); }

var server, base;
function call(method, path, body) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var req = http.request(base + path, { method: method, headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 } }, function (res) {
      var chunks = '';
      res.on('data', function (d) { chunks += d; });
      res.on('end', function () { var j = null; try { j = JSON.parse(chunks); } catch (e) { j = chunks; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

var TECH, ADMIN;
async function freshInvoice(opts) {
  opts = opts || {};
  // labor 100 + part 50 (taxable at 7%) -> subtotal 150, tax 3.50, sales 153.50
  var num = String(8100000 + Math.floor(Math.random() * 99999));
  var r = await pool.query(
    "INSERT INTO invoices (invoice_number, locksmith_id, locksmith_name, invoice_date, status, customer_name, city_code, " +
    "tax_rate, labor_amount, parts_amount, subtotal, tax_amount, tip_amount, grand_total, pay_method, surcharge_amount, surcharge_rate, signature_image) " +
    "VALUES ($1,$2,'Tech',CURRENT_DATE,'draft','Pat Customer','JAX',7,100,50,150,3.50,$3,$4,$5,$6,$7,'data:x') RETURNING *",
    [num, TECH.id, opts.tip || 0, opts.grand || (153.50 + (opts.tip || 0)), opts.pay_method || null, opts.sur || 0, opts.rate || 0]
  );
  var inv = r.rows[0];
  await pool.query("INSERT INTO invoice_line_items (invoice_id, line_type, description, quantity, unit_price, taxable, position, unit_cost) VALUES ($1,'labor','Lockout',1,100,false,0,null)", [inv.id]);
  await pool.query("INSERT INTO invoice_line_items (invoice_id, line_type, description, quantity, unit_price, taxable, position, unit_cost) VALUES ($1,'part','Key blank',1,50,true,1,10)", [inv.id]);
  return inv;
}
async function getInv(id) { return (await call('GET', '/api/invoices/' + id)).body; }

async function simulateSquareReturn(invoiceId, amountCents, tipCents, payId, opts) {
  opts = opts || {};
  payId = payId + '_' + RUN;
  var row = (await pool.query("SELECT * FROM invoice_payments WHERE invoice_id = $1 AND status = 'initiated' ORDER BY id DESC LIMIT 1", [invoiceId])).rows[0];
  var orderId = 'ord_' + payId;
  var invNum = (await pool.query('SELECT invoice_number FROM invoices WHERE id = $1', [invoiceId])).rows[0].invoice_number;
  sqPayment(payId, orderId, amountCents, tipCents, opts.brand || 'VISA', opts.last4 || '4242', 'Nova Invoice ' + invNum);
  if (opts.sqSur) {
    var P = SQ.payments[payId];
    P.amount_money.amount += opts.sqSur; P.total_money.amount += opts.sqSur;
    P.card_details.applied_card_surcharge_details = { card_surcharge_money: { amount: opts.sqSur } };
  }
  await pool.query("UPDATE invoice_payments SET status = 'returned', square_transaction_id = $1, returned_at = NOW() WHERE id = $2", [orderId, row.id]);
  return { row: row, result: await square.reconcilePayment(row.id) };
}

async function main() {
  await db.initDB();
  await pool.query("DELETE FROM settings WHERE key IN ('invoice_surcharge_enabled','invoice_surcharge_rate','square_location_map','invoice_billed_pay_types','tax_gate_enabled')");
  await pool.query("INSERT INTO settings (key, value) VALUES ('invoice_surcharge_enabled','true'),('invoice_surcharge_rate','3'),('square_location_map','{\"JAX\":\"LOC1\"}')");
  var u1 = await pool.query("INSERT INTO users (name, email, password_hash, role) VALUES ('Tech','t" + Date.now() + "@x.test','x','locksmith') RETURNING id, name, role");
  var u2 = await pool.query("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin','a" + Date.now() + "@x.test','x','admin') RETURNING id, name, role");
  TECH = u1.rows[0]; ADMIN = u2.rows[0];
  CURRENT_USER = TECH;

  var app = express();
  app.use(express.json());
  app.use('/api/invoices', require('./routes/invoices'));
  server = app.listen(0);
  base = 'http://127.0.0.1:' + server.address().port;

  console.log('\n# validation');
  var inv = await freshInvoice();
  var r = await call('POST', '/api/invoices/' + inv.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '153.50' }] });
  ok(r.status === 400 && /at least 2/.test(r.body.error), 'one line refused', r.body);
  r = await call('POST', '/api/invoices/' + inv.id + '/tenders', { tenders: [1, 2, 3, 4, 5].map(function () { return { pay_type: 'Cash', amount: '30.70' }; }) });
  ok(r.status === 400 && /at most 4/.test(r.body.error), 'five lines refused', r.body);
  r = await call('POST', '/api/invoices/' + inv.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '100' }, { pay_type: 'Visa', amount: '53.49' }] });
  ok(r.status === 400 && /0\.01 short/.test(r.body.error), 'one cent short refused', r.body);
  r = await call('POST', '/api/invoices/' + inv.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '100' }, { pay_type: 'Visa', amount: '53.51' }] });
  ok(r.status === 400 && /0\.01 over/.test(r.body.error), 'one cent over refused', r.body);
  r = await call('POST', '/api/invoices/' + inv.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '100' }, { pay_type: 'Motor Club', amount: '53.50' }] });
  ok(r.status === 400 && /billed/.test(r.body.error), 'billed type refused', r.body);
  r = await call('POST', '/api/invoices/' + inv.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '153.50' }, { pay_type: 'Visa', amount: '0' }] });
  ok(r.status === 400 && /greater than zero/.test(r.body.error), 'zero line refused', r.body);
  var still = (await pool.query('SELECT count(*)::int n FROM invoice_tenders WHERE invoice_id = $1', [inv.id])).rows[0].n;
  ok(still === 0, 'nothing written on a refused plan');

  console.log('\n# all-manual split: cash + typed card, surcharge on the card share only');
  r = await call('POST', '/api/invoices/' + inv.id + '/tenders', { tenders: [
    { pay_type: 'Cash', amount: '53.50' },
    { pay_type: 'Visa', amount: '100.00', card_last4: '1111', approval_code: 'APP1' }
  ] });
  ok(r.status === 200 && r.body.completed === true, 'saved and completed', r.body);
  var fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv.id])).rows[0];
  ok(fresh.status === 'paid' && fresh.pay_type === 'Split', 'invoice paid, pay_type Split', fresh.status + ' ' + fresh.pay_type);
  ok(c(fresh.surcharge_amount) === 300, 'surcharge 3.00 = 3% of the 100 card share only', fresh.surcharge_amount);
  ok(c(fresh.grand_total) === 15650, 'grand total 156.50', fresh.grand_total);
  ok(c(fresh.tip_amount) === 0, 'no tip', fresh.tip_amount);
  ok(c(fresh.authorized_total) === 15650, 'authorized total pre-tip 156.50', fresh.authorized_total);
  ok(c(fresh.subtotal) === 15000 && c(fresh.tax_amount) === 350, 'subtotal and tax untouched');
  var ts = (await pool.query('SELECT * FROM invoice_tenders WHERE invoice_id = $1 ORDER BY seq', [inv.id])).rows;
  ok(ts.length === 2 && c(ts[0].surcharge_amount) === 0 && c(ts[0].amount) === 5350, 'cash line 53.50, no surcharge', ts[0]);
  ok(c(ts[1].amount) === 10300 && ts[1].card_last4 === '1111' && ts[1].approval_code === 'APP1', 'card line 103.00 with last4/approval', ts[1]);
  var g = await getInv(inv.id);
  ok(Array.isArray(g.tenders) && g.tenders.length === 2 && g.tender_summary && g.tender_summary.pending === 0, 'GET returns tenders + summary', g.tender_summary);
  r = await call('POST', '/api/invoices/' + inv.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '53.50' }, { pay_type: 'Cash', amount: '100' }] });
  ok(r.status === 409, 'cannot re-split a completed invoice', r.body);
  var audit = (await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'invoice' AND entity_id = $1 ORDER BY id", [inv.id])).rows.map(function (x) { return x.action; });
  ok(audit.indexOf('split_tender_saved') !== -1 && audit.indexOf('completed') !== -1, 'audited save + completed', audit);

  console.log('\n# reopen a hand-recorded split returns it to a normal Active invoice');
  CURRENT_USER = ADMIN;
  r = await call('POST', '/api/invoices/' + inv.id + '/reopen', {});
  ok(r.status === 200, 'reopen ok', r.body);
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv.id])).rows[0];
  still = (await pool.query('SELECT count(*)::int n FROM invoice_tenders WHERE invoice_id = $1', [inv.id])).rows[0].n;
  ok(fresh.status === 'draft' && still === 0, 'draft, plan gone');
  ok(c(fresh.grand_total) === 15350 && c(fresh.surcharge_amount) === 0 && fresh.pay_type === null, 'repriced to 153.50 (no pay_method = no surcharge), pay_type cleared', [fresh.grand_total, fresh.surcharge_amount, fresh.pay_type]);
  CURRENT_USER = TECH;

  console.log('\n# card-priced invoice: split base excludes the whole-invoice surcharge');
  var inv2 = await freshInvoice({ pay_method: 'card', sur: 4.61, rate: 3, grand: 158.11 });
  r = await call('POST', '/api/invoices/' + inv2.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '53.50' }, { pay_type: 'Visa', amount: '100.00', collect_in_square: true }] });
  ok(r.status === 200 && r.body.completed === false && JSON.stringify(r.body.pending_seqs) === '[2]', 'saved, waits on Square line 2', r.body);
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv2.id])).rows[0];
  ok(fresh.status === 'draft' && c(fresh.grand_total) === 15650 && c(fresh.surcharge_amount) === 300, 'still Active; total repriced to 156.50', [fresh.status, fresh.grand_total, fresh.surcharge_amount]);

  console.log('\n# whole-invoice Collect Payment and attach are refused while split');
  r = await call('POST', '/api/invoices/' + inv2.id + '/collect-payment', { platform: 'android' });
  ok(r.status === 409 && /split/.test(r.body.error), 'whole collect refused', r.body);
  r = await call('POST', '/api/invoices/' + inv2.id + '/attach-square-payment', { square_payment_id: 'zzz' });
  ok(r.status === 409 && /split/.test(r.body.error), 'whole attach refused', r.body);
  r = await call('POST', '/api/invoices/' + inv2.id + '/collect-payment', { platform: 'android', tender_seq: 1 });
  ok((r.status === 400 || r.status === 409) && /Nothing was charged/.test(r.body.error), 'cash line cannot go to Square', r.body);
  r = await call('POST', '/api/invoices/' + inv2.id + '/collect-payment', { platform: 'android', tender_seq: 9 });
  ok(r.status === 404, 'missing line refused', r.body);

  console.log('\n# run line 2 in Square for its own amount');
  r = await call('POST', '/api/invoices/' + inv2.id + '/collect-payment', { platform: 'android', tender_seq: 2 });
  ok(r.status === 200 && r.body.amount_cents === 10300, 'charge 103.00 (100 + 3.00 surcharge)', r.body);
  var prow = (await pool.query("SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1", [inv2.id])).rows[0];
  ok(prow.tender_seq === 2 && prow.amount_requested_cents === 10300, 'attempt row carries tender_seq 2', prow.tender_seq);
  r = await call('POST', '/api/invoices/' + inv2.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '53.50' }, { pay_type: 'Visa', amount: '100.00', collect_in_square: true }] });
  ok(r.status === 409 && /still being confirmed/.test(r.body.error), 'plan frozen while Square attempt open', r.body);

  console.log('\n# wrong amount in Square is a mismatch and settles nothing');
  var bad = await simulateSquareReturn(inv2.id, 9999, 0, 'pay_bad');
  ok(bad.result.ok === false && bad.result.reason === 'amount_mismatch', 'mismatch', bad.result.reason);
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv2.id])).rows[0];
  ts = (await pool.query('SELECT * FROM invoice_tenders WHERE invoice_id = $1 ORDER BY seq', [inv2.id])).rows;
  ok(fresh.status === 'draft' && ts[1].status === 'pending', 'invoice not paid, line still pending');
  await pool.query("UPDATE invoice_payments SET status = 'canceled' WHERE id = $1", [bad.row.id]);

  console.log('\n# right amount + 5.00 tip settles line 2 and finishes the invoice');
  r = await call('POST', '/api/invoices/' + inv2.id + '/collect-payment', { platform: 'android', tender_seq: 2 });
  ok(r.status === 200, 'second attempt started', r.body);
  var good = await simulateSquareReturn(inv2.id, 10300, 500, 'pay_good', { brand: 'MASTERCARD', last4: '5555' });
  ok(good.result.ok === true && good.result.invoice_finished === true, 'reconciled + finished', good.result);
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv2.id])).rows[0];
  ts = (await pool.query('SELECT * FROM invoice_tenders WHERE invoice_id = $1 ORDER BY seq', [inv2.id])).rows;
  ok(fresh.status === 'paid' && fresh.pay_type === 'Split', 'invoice paid as Split');
  ok(c(fresh.grand_total) === 16150 && c(fresh.tip_amount) === 500 && c(fresh.surcharge_amount) === 300, 'total 161.50 = 153.50 + 3.00 surcharge + 5.00 tip', [fresh.grand_total, fresh.tip_amount, fresh.surcharge_amount]);
  ok(c(fresh.authorized_total) === 15650, 'authorized pre-tip 156.50', fresh.authorized_total);
  ok(ts[1].status === 'collected' && ts[1].collected_via === 'square' && ts[1].pay_type === 'Mastercard' && ts[1].card_last4 === '5555' && c(ts[1].tip_amount) === 500 && c(ts[1].amount) === 10800, 'line 2 collected from Square data', ts[1]);
  var prow2 = (await pool.query("SELECT * FROM invoice_payments WHERE id = $1", [good.row.id])).rows[0];
  ok(prow2.status === 'reconciled' && prow2.square_payment_id === 'pay_good_' + RUN, 'attempt row reconciled');

  console.log('\n# reconcile again is a no-op');
  var again = await square.reconcilePayment(good.row.id);
  var fresh2 = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv2.id])).rows[0];
  ok(again.ok === true && c(fresh2.grand_total) === 16150 && String(fresh2.completed_at) === String(fresh.completed_at), 'same totals, same completed_at');
  await pool.query("UPDATE invoice_payments SET status = 'returned' WHERE id = $1", [good.row.id]);
  again = await square.reconcilePayment(good.row.id);
  fresh2 = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv2.id])).rows[0];
  ok(again.ok === true && c(fresh2.grand_total) === 16150 && c(fresh2.tip_amount) === 500, 'forced re-entry still 161.50');

  console.log('\n# locked split: typo edit allowed, money edit refused, reopen refused');
  CURRENT_USER = ADMIN;
  var putBody = { customer_name: 'Pat Customer Jr', city_code: 'JAX', tax_rate: 7, tip_amount: 5, pay_method: 'card', signature_image: 'data:x',
    line_items: [{ line_type: 'labor', description: 'Lockout', quantity: 1, unit_price: 100, taxable: false }, { line_type: 'part', description: 'Key blank', quantity: 1, unit_price: 50, taxable: true, unit_cost: 10 }] };
  r = await call('PUT', '/api/invoices/' + inv2.id, putBody);
  fresh2 = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv2.id])).rows[0];
  ok(r.status === 200 && fresh2.customer_name === 'Pat Customer Jr', 'typo fix saved', r.body);
  ok(c(fresh2.grand_total) === 16150 && c(fresh2.surcharge_amount) === 300 && fresh2.pay_type === 'Split', 'split money survived the edit', [fresh2.grand_total, fresh2.surcharge_amount, fresh2.pay_type]);
  var moneyBody = JSON.parse(JSON.stringify(putBody)); moneyBody.line_items[0].unit_price = 120;
  r = await call('PUT', '/api/invoices/' + inv2.id, moneyBody);
  ok(r.status === 409 && /split/.test(r.body.error), 'money edit refused', r.body);
  r = await call('POST', '/api/invoices/' + inv2.id + '/reopen', {});
  ok(r.status === 409, 'reopen refused (Square money)', r.body);
  CURRENT_USER = TECH;

  console.log('\n# the same Square payment cannot settle two lines');
  var inv3 = await freshInvoice();
  r = await call('POST', '/api/invoices/' + inv3.id + '/tenders', { tenders: [{ pay_type: 'Visa', amount: '76.75', collect_in_square: true }, { pay_type: 'Visa', amount: '76.75', collect_in_square: true }] });
  ok(r.status === 200 && JSON.stringify(r.body.pending_seqs) === '[1,2]', 'two Square lines pending', r.body);
  var ts3 = (await pool.query('SELECT * FROM invoice_tenders WHERE invoice_id = $1 ORDER BY seq', [inv3.id])).rows;
  var each = c(ts3[0].base_amount) + c(ts3[0].surcharge_amount);
  ok(c(ts3[0].surcharge_amount) === 230 && c(ts3[1].surcharge_amount) === 230, 'each card 2.30 surcharge (3% of 76.75)', [ts3[0].surcharge_amount, ts3[1].surcharge_amount]);
  r = await call('POST', '/api/invoices/' + inv3.id + '/collect-payment', { platform: 'android', tender_seq: 1 });
  var one = await simulateSquareReturn(inv3.id, each, 0, 'pay_one');
  ok(one.result.ok && one.result.invoice_finished === false && one.result.split.pending === 1, 'line 1 in, one to go', one.result.split);
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv3.id])).rows[0];
  ok(fresh.status === 'draft', 'invoice not finished after first card');
  var st = await call('GET', '/api/invoices/' + inv3.id + '/payment-status?nonce=' + encodeURIComponent(one.row.state_nonce));
  ok(st.body.split && st.body.split.pending === 1, 'payment-status reports split progress', st.body.split);
  r = await call('POST', '/api/invoices/' + inv3.id + '/collect-payment', { platform: 'android', tender_seq: 1 });
  ok(r.status === 409, 'line 1 cannot be charged twice', r.body);
  r = await call('POST', '/api/invoices/' + inv3.id + '/collect-payment', { platform: 'android', tender_seq: 2 });
  var row2 = (await pool.query("SELECT * FROM invoice_payments WHERE invoice_id = $1 AND tender_seq = 2 ORDER BY id DESC LIMIT 1", [inv3.id])).rows[0];
  await pool.query("UPDATE invoice_payments SET status = 'returned', square_transaction_id = 'ord_pay_one_' || $2 WHERE id = $1", [row2.id, RUN]);
  var dupRes = await square.reconcilePayment(row2.id);
  ok(dupRes.ok === false && dupRes.reason === 'already_settled', 'reusing line 1 payment flagged', dupRes.reason);
  ts3 = (await pool.query('SELECT * FROM invoice_tenders WHERE invoice_id = $1 ORDER BY seq', [inv3.id])).rows;
  ok(ts3[1].status === 'pending', 'line 2 still pending');

  console.log('\n# Square money on the plan blocks going back to one payment / Cash-Card / money edits');
  await pool.query("UPDATE invoice_payments SET status = 'canceled' WHERE id = $1", [row2.id]);
  r = await call('DELETE', '/api/invoices/' + inv3.id + '/tenders');
  ok(r.status === 409 && /Square/.test(r.body.error), 'clear refused', r.body);
  r = await call('POST', '/api/invoices/' + inv3.id + '/pay-method', { pay_method: 'cash' });
  ok(r.status === 409, 'Cash/Card change refused', r.body);
  r = await call('POST', '/api/invoices/' + inv3.id + '/complete', { pay_type: 'Visa' });
  ok(r.status === 409, 'single complete refused', r.body);
  r = await call('POST', '/api/invoices/' + inv3.id + '/tenders', { tenders: [{ pay_type: 'Visa', amount: '70.00', collect_in_square: true }, { pay_type: 'Cash', amount: '83.50' }] });
  ok(r.status === 400 && /cannot be changed/.test(r.body.error), 'Square line amount locked', r.body);
  r = await call('POST', '/api/invoices/' + inv3.id + '/tenders', { tenders: [{ pay_type: 'Visa', amount: '76.75', collect_in_square: true }, { pay_type: 'Cash', amount: '76.75' }] });
  ok(r.status === 200 && r.body.completed === true, 'switch line 2 to cash finishes it', r.body);
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv3.id])).rows[0];
  ok(fresh.status === 'paid' && c(fresh.surcharge_amount) === 230 && c(fresh.grand_total) === 15580, 'paid 155.80 = 153.50 + 2.30 (only the card line surcharged)', [fresh.grand_total, fresh.surcharge_amount]);

  console.log('\n# going back to one payment reprices a hand-only plan');
  var inv4 = await freshInvoice({ pay_method: 'card', sur: 4.61, rate: 3, grand: 158.11 });
  r = await call('POST', '/api/invoices/' + inv4.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '50' }, { pay_type: 'Visa', amount: '103.50', collect_in_square: true }] });
  ok(r.status === 200 && r.body.completed === false, 'plan saved, pending');
  r = await call('DELETE', '/api/invoices/' + inv4.id + '/tenders');
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv4.id])).rows[0];
  still = (await pool.query('SELECT count(*)::int n FROM invoice_tenders WHERE invoice_id = $1', [inv4.id])).rows[0].n;
  ok(r.status === 200 && still === 0 && c(fresh.grand_total) === 15811 && c(fresh.surcharge_amount) === 461 && fresh.pay_type === null, 'back to 158.11 card pricing', [fresh.grand_total, fresh.surcharge_amount, fresh.pay_type]);
  r = await call('POST', '/api/invoices/' + inv4.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '50' }, { pay_type: 'Visa', amount: '103.50' }] });
  ok(r.status === 200 && r.body.completed, 'can split again after clearing');

  console.log('\n# single-payment complete is unchanged');
  var inv5 = await freshInvoice({ pay_method: 'cash' });
  r = await call('POST', '/api/invoices/' + inv5.id + '/complete', { pay_type: 'Cash' });
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv5.id])).rows[0];
  ok(r.status === 200 && fresh.status === 'paid' && fresh.pay_type === 'Cash' && c(fresh.grand_total) === 15350, 'plain cash complete');

  console.log('\n# split with a tip typed on the invoice: tip never surcharged');
  var inv6 = await freshInvoice({ tip: 10, pay_method: 'cash' });
  r = await call('POST', '/api/invoices/' + inv6.id + '/tenders', { tenders: [{ pay_type: 'Visa', amount: '163.50' }, { pay_type: 'Cash', amount: '0.00' }] });
  ok(r.status === 400, 'zero cash line refused');
  r = await call('POST', '/api/invoices/' + inv6.id + '/tenders', { tenders: [{ pay_type: 'Visa', amount: '113.50' }, { pay_type: 'Cash', amount: '50.00' }] });
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv6.id])).rows[0];
  // card share of sales = 113.50 * 153.50 / 163.50 = 106.558 -> 3% = 3.197 -> 3.20
  ok(r.status === 200 && c(fresh.surcharge_amount) === 320 && c(fresh.tip_amount) === 1000 && c(fresh.grand_total) === 16670, 'surcharge 3.20 on the card share of sales; total 166.70', [fresh.surcharge_amount, fresh.tip_amount, fresh.grand_total]);

  console.log('\n# Nova surcharge OFF, Square adds its own on the credit line (the 2026-09-26 setup)');
  await pool.query("UPDATE settings SET value = 'false' WHERE key = 'invoice_surcharge_enabled'");
  var inv7 = await freshInvoice({ pay_method: null });
  r = await call('POST', '/api/invoices/' + inv7.id + '/tenders', { tenders: [{ pay_type: 'Cash', amount: '53.50' }, { pay_type: 'Visa', amount: '100.00', collect_in_square: true }] });
  ts = (await pool.query('SELECT * FROM invoice_tenders WHERE invoice_id = $1 ORDER BY seq', [inv7.id])).rows;
  ok(r.status === 200 && c(ts[1].surcharge_amount) === 0, 'Nova adds nothing itself', ts[1].surcharge_amount);
  r = await call('POST', '/api/invoices/' + inv7.id + '/collect-payment', { platform: 'android', tender_seq: 2 });
  ok(r.status === 200 && r.body.amount_cents === 10000, 'Nova sends Square 100.00 flat', r.body.amount_cents);
  var sq7 = await simulateSquareReturn(inv7.id, 10000, 0, 'pay_sq7', { sqSur: 260 });
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv7.id])).rows[0];
  ts = (await pool.query('SELECT * FROM invoice_tenders WHERE invoice_id = $1 ORDER BY seq', [inv7.id])).rows;
  ok(sq7.result.ok && fresh.status === 'paid', 'Square surcharge accepted, invoice paid', sq7.result.reason);
  ok(c(ts[1].surcharge_amount) === 260 && c(ts[1].amount) === 10260, 'line records Square 2.60 surcharge', ts[1]);
  ok(c(fresh.surcharge_amount) === 260 && c(fresh.grand_total) === 15610 && c(fresh.subtotal) + c(fresh.tax_amount) === 15350, 'invoice 156.10 total, sales still 153.50 for Pulsar', [fresh.surcharge_amount, fresh.grand_total]);
  var inv8 = await freshInvoice({ pay_method: null });
  r = await call('POST', '/api/invoices/' + inv8.id + '/collect-payment', { platform: 'android' });
  ok(r.status === 200 && r.body.amount_cents === 15350, 'single card: no Cash/Card gate when Nova surcharge is off, sends 153.50');
  var sq8 = await simulateSquareReturn(inv8.id, 15350, 0, 'pay_sq8', { sqSur: 399 });
  fresh = (await pool.query('SELECT * FROM invoices WHERE id = $1', [inv8.id])).rows[0];
  ok(sq8.result.ok && c(fresh.surcharge_amount) === 399 && c(fresh.grand_total) === 15749, 'single card records Square 3.99 surcharge separately', [fresh.surcharge_amount, fresh.grand_total]);
  await pool.query("UPDATE settings SET value = 'true' WHERE key = 'invoice_surcharge_enabled'");

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
