'use strict';
/*
 * Invoice FINISH notification harness -- runs against a REAL Postgres and the
 * real db.js schema (initDB), so the notified_complete_at migration is the one
 * the app runs.
 *
 *   PGURL=postgres://postgres@127.0.0.1:5433/invoice_test node test-invoice-finish-notify.js
 *
 * Why this exists: the "New invoice" email used to fire when the row was
 * inserted, and a row is nearly always a $0 draft at that moment (invoice
 * #500055 emailed the owners "Grand Total $0.00" for a $165 job). The email
 * now goes out when the invoice is FINISHED, from utils/invoiceNotify.js, via
 * every path that finishes one: Complete Invoice, PUT to paid, created as
 * paid, and the Square narrow writer. Covers: no email at creation or on a
 * draft save; the real total, labor, parts, tip, surcharge and pay type in the
 * email; exactly one send per finish even under concurrent callers; reopen
 * re-arming it; Settings notification rules and per-user email opt-out; and
 * the migration backfilling already-finished invoices so deploying does not
 * email the owners about history.
 */
var http = require('http');
var Module = require('module');
var { Pool } = require('pg');

process.env.DATABASE_URL = process.env.PGURL;
var realDb = require('./db');
var pool = realDb.pool;

/* ---- stub the module graph so routes/invoices.js loads standalone --------- */
var CURRENT_USER = null;
var SENT = [], PUSHED = [];
var NOOP = async function () {};
var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return realDb;
  if (request === './utils/sopIndex') return { reindexSop: NOOP };
  if (request === '../utils/invoiceNotify') return origLoad.apply(this, arguments);
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = CURRENT_USER; next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
  };
  if (request === '../utils/email' || request === './email') return { sendEmail: async function (to, subj, html) { SENT.push({ to: to, subject: subj, html: html }); }, emailTemplate: function (o) { return JSON.stringify(o); } };
  if (request === '../utils/sms') return { sendSms: NOOP };
  
  if (request === '../utils/push' || request === './push') return { sendPushToUsers: async function (ids, p) { PUSHED.push({ ids: ids, payload: p }); } };
  if (request === '../utils/r2') return { put: NOOP, get: NOOP, del: NOOP, presignPut: NOOP, presignGet: NOOP, head: NOOP };
  if (request === '../utils/disputePdf') return { buildDisputePdf: NOOP };
  if (request === '../utils/square') return {
    callbackUrl: function () { return 'https://example.test/cb'; },
    newNonce: function () { return 'n'; },
    signState: function () { return 's'; },
    configured: function () { return false; },
    enabled: function () { return false; },
    buildPosUrls: function () { return { android: '', ios: '' }; }
  };
  if (request === '../jobs/taskReminders') return { notifyTaskAssigned: NOOP, notifyTaskCc: NOOP };
  return origLoad.apply(this, arguments);
};

var SCHEMA = `
CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255), role VARCHAR(50), supervisor_id INTEGER, home_city CHAR(3), phone VARCHAR(40), active BOOLEAN DEFAULT true, receive_emails BOOLEAN DEFAULT true, receive_sms BOOLEAN DEFAULT false);
CREATE TABLE cities (id SERIAL PRIMARY KEY, code CHAR(3), name VARCHAR(120), manager_user_id INTEGER);
CREATE TABLE settings (key VARCHAR(120) PRIMARY KEY, value TEXT);
CREATE TABLE vendors (id SERIAL PRIMARY KEY, name VARCHAR(255), account_number VARCHAR(120), city_code CHAR(3),
  show_in_invoice BOOLEAN DEFAULT false, invoice_notes TEXT, auto_line_items JSONB, agreement_text TEXT,
  require_signature BOOLEAN DEFAULT false, require_entitlement BOOLEAN DEFAULT false,
  require_vehicle BOOLEAN DEFAULT false, require_photos BOOLEAN DEFAULT false);
CREATE TABLE parts (id SERIAL PRIMARY KEY, item_number VARCHAR(120), description TEXT, preferred_vendor VARCHAR(255), cost DECIMAL(10,2));
CREATE TABLE tasks (id SERIAL PRIMARY KEY, title VARCHAR(255), description TEXT, status VARCHAR(30) DEFAULT 'todo',
  priority VARCHAR(20), assigned_to INTEGER, created_by INTEGER, due_date DATE, position INTEGER,
  completed_at TIMESTAMPTZ, completed_by INTEGER, updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE task_cc (task_id INTEGER, user_id INTEGER, UNIQUE (task_id, user_id));
CREATE TABLE audit_logs (id SERIAL PRIMARY KEY, entity_type VARCHAR(60), entity_id INTEGER, entity_number VARCHAR(60),
  action VARCHAR(60), user_id INTEGER, user_name VARCHAR(255), details JSONB, ip VARCHAR(60), created_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE invoices (
  id SERIAL PRIMARY KEY, invoice_number BIGINT UNIQUE NOT NULL, locksmith_id INTEGER REFERENCES users(id),
  locksmith_name VARCHAR(255), invoice_date DATE DEFAULT CURRENT_DATE, status VARCHAR(20) NOT NULL DEFAULT 'draft',
  account_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL, account_name VARCHAR(255), customer_po_wo VARCHAR(255),
  pay_type VARCHAR(50), card_last4 VARCHAR(4), approval_code VARCHAR(50), pay_method VARCHAR(10), cc_online BOOLEAN DEFAULT false, time_in VARCHAR(20), time_out VARCHAR(20),
  customer_name VARCHAR(255), dl_number VARCHAR(60), dl_state VARCHAR(4), street_address VARCHAR(255),
  city VARCHAR(120), state VARCHAR(4), zip VARCHAR(12), phone VARCHAR(40), email VARCHAR(255),
  vin VARCHAR(40), vehicle_year VARCHAR(8), vehicle_make VARCHAR(60), vehicle_model VARCHAR(60),
  license_tag VARCHAR(20), tag_state VARCHAR(4), mileage VARCHAR(20),
  ent_registration BOOLEAN DEFAULT false, ent_insurance BOOLEAN DEFAULT false,
  ent_title BOOLEAN DEFAULT false, ent_rental BOOLEAN DEFAULT false,
  tax_rate DECIMAL(6,3) DEFAULT 0, tax_exempt BOOLEAN DEFAULT false,
  labor_amount DECIMAL(10,2) DEFAULT 0, parts_amount DECIMAL(10,2) DEFAULT 0, subtotal DECIMAL(10,2) DEFAULT 0,
  tax_amount DECIMAL(10,2) DEFAULT 0, tip_amount DECIMAL(10,2) DEFAULT 0,
  surcharge_amount DECIMAL(10,2) DEFAULT 0, surcharge_rate DECIMAL(6,3) DEFAULT 0,
  grand_total DECIMAL(10,2) DEFAULT 0, authorized_total DECIMAL(10,2),
  notes TEXT, payments_note TEXT, agreement_text TEXT, signature_required BOOLEAN DEFAULT false,
  signature_image TEXT, signed_name VARCHAR(255), signed_at TIMESTAMPTZ, city_code CHAR(3),
  parts_cost_total DECIMAL(10,2) DEFAULT 0, cogs_incomplete BOOLEAN DEFAULT false,
  refunded_total DECIMAL(10,2) DEFAULT 0, status_before_refund VARCHAR(20),
  id_image_r2_key TEXT, id_image_mime TEXT, id_image_uploaded_at TIMESTAMPTZ, id_image_uploaded_by INTEGER,
  signoff_group_id INTEGER, split_group_id INTEGER, split_parent_id INTEGER,
  completed_at TIMESTAMPTZ, completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  waiting_since TIMESTAMPTZ, followup_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE invoice_line_items (id SERIAL PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  line_type VARCHAR(10), part_id INTEGER REFERENCES parts(id), description TEXT, item_number VARCHAR(120),
  unit_price DECIMAL(10,2), quantity DECIMAL(10,2), taxable BOOLEAN DEFAULT false, extension DECIMAL(10,2),
  unit_cost DECIMAL(10,2), cost_unknown BOOLEAN DEFAULT false, cost_unknown_reason TEXT, sort_order INTEGER, position INTEGER);
CREATE TABLE invoice_photos (id SERIAL PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  r2_key TEXT, caption TEXT, show_in_print BOOLEAN DEFAULT true, status VARCHAR(20) DEFAULT 'ready', position INTEGER, mime VARCHAR(80), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE invoice_payments (id SERIAL PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  state_nonce TEXT, status VARCHAR(30), amount_requested_cents INTEGER, square_location_id TEXT,
  square_payment_id TEXT, receipt_url TEXT, platform TEXT, initiated_by INTEGER,
  initiated_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE invoice_refunds (id SERIAL PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  refund_number VARCHAR(60), amount DECIMAL(10,2), refund_date DATE, status VARCHAR(30),
  requested_by INTEGER, approved_by INTEGER, processed_by INTEGER, square_receipt_url TEXT);
CREATE TABLE invoice_refund_lines (id SERIAL PRIMARY KEY, refund_id INTEGER REFERENCES invoice_refunds(id) ON DELETE CASCADE,
  invoice_line_item_id INTEGER, quantity DECIMAL(10,2), restock BOOLEAN DEFAULT false);

-- The cancel migration, copied VERBATIM from db.js. If these four lines and the
-- ones in db.js ever disagree, this harness is testing a table the app will
-- never see.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS canceled_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(40);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancel_note TEXT;
`;
// The finish-notify migration, VERBATIM from db.js (evaluated as JS so the two cannot drift).
var NOTIFY_MIG = 'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notified_complete_at TIMESTAMPTZ;' +
      "UPDATE invoices SET notified_complete_at = COALESCE(completed_at, NOW()) WHERE notified_complete_at IS NULL AND status IN ('paid', 'partially_refunded', 'refunded');";



var express = require('express');
var app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/invoices', require('./routes/invoices'));
var { notifyInvoiceFinished } = require('./utils/invoiceNotify');

var pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL: ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
var server, base;
function call(method, path, body) {
  return new Promise(function (resolve, reject) {
    var data = body == null ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(base + path, { method: method, headers: Object.assign({ 'content-type': 'application/json' }, data ? { 'content-length': data.length } : {}) }, function (res) {
      var buf = ''; res.on('data', function (c) { buf += c; });
      res.on('end', function () { var json = null; try { json = JSON.parse(buf); } catch (e) { json = { _raw: buf }; } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
let TECH, ADMIN, OWNER, PART;
let nextNum = 900000001;
async function seed() {
  await realDb.initDB();
  await pool.query('TRUNCATE invoices, invoice_line_items, users, settings, cities, parts, vendors, audit_logs RESTART IDENTITY CASCADE');
  await pool.query("ALTER TABLE invoices DROP COLUMN IF EXISTS notified_complete_at");
  // Pre-existing finished invoice BEFORE the migration: must be backfilled, never emailed.
  await pool.query("INSERT INTO users (name, email, role, password_hash) VALUES ('Old Tech','old@x.test', 'locksmith', 'x')");
  await pool.query("INSERT INTO invoices (invoice_number, locksmith_name, status, grand_total, completed_at) VALUES (100, 'Old Tech', 'paid', 50, NOW() - interval '30 days')");
  await pool.query("INSERT INTO invoices (invoice_number, locksmith_name, status, grand_total) VALUES (101, 'Old Tech', 'draft', 0)");
  await pool.query(NOTIFY_MIG);
  await pool.query(NOTIFY_MIG); // re-runnable
  await pool.query("INSERT INTO cities (code, name) VALUES ('ATL','Atlanta')");
  ADMIN = (await pool.query("INSERT INTO users (name, email, role, password_hash) VALUES ('Ada Admin','a@x.test', 'admin', 'x') RETURNING id")).rows[0].id;
  OWNER = (await pool.query("INSERT INTO users (name, email, role, password_hash) VALUES ('Ben Owner','b@x.test', 'owner', 'x') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO users (name, email, role, password_hash, receive_emails) VALUES ('Quiet Admin','q@x.test', 'admin', 'x', false)");
  TECH = (await pool.query("INSERT INTO users (name, email, role, password_hash, home_city) VALUES ('Anthony Weston','t@x.test', 'locksmith', 'x','ATL') RETURNING id")).rows[0].id;
  PART = (await pool.query("INSERT INTO parts (item_number, description) VALUES ('HU100-T','Transponder blank') RETURNING id")).rows[0].id;
}
const rowOf = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
function lastMail() { return SENT[SENT.length - 1]; }
function detail(mail, label) { var o = JSON.parse(mail.html); var d = (o.details || []).filter(function (x) { return x.label === label; })[0]; return d ? d.value : undefined; }

async function run() {
  await seed();

  console.log('\n0. Migration backfill');
  let old = (await pool.query('SELECT notified_complete_at, completed_at FROM invoices WHERE invoice_number = 100')).rows[0];
  ok(old.notified_complete_at && String(old.notified_complete_at) === String(old.completed_at), 'a paid invoice that predates the column is marked already-notified at its completed_at');
  let olddraft = (await pool.query('SELECT notified_complete_at FROM invoices WHERE invoice_number = 101')).rows[0];
  ok(olddraft.notified_complete_at === null, 'a pre-existing draft is left unstamped');
  eq(await notifyInvoiceFinished((await pool.query('SELECT id FROM invoices WHERE invoice_number = 100')).rows[0].id, null), false, 'helper refuses to notify a backfilled invoice');
  eq(SENT.length, 0, 'no email for the backfill');

  console.log('\n1. The #500055 sequence: created as a $0 draft, priced later, then completed');
  CURRENT_USER = { id: TECH, name: 'Anthony Weston', role: 'locksmith' };
  let r = await call('POST', '/api/invoices', { status: 'draft', customer_name: 'Ross Dress For Less #0272 - Ross', account_name: 'Academy Locksmith', customer_po_wo: 'R 681361', city_code: 'ATL', pay_type: 'Account', line_items: [] });
  eq(r.status, 201, 'draft created (' + JSON.stringify(r.body).slice(0, 120) + ')');
  let id = r.body.id;
  eq(SENT.length, 0, 'NO email at creation (this is the $0.00 email that used to go out)');
  eq(PUSHED.length, 0, 'no push at creation either');
  ok((await rowOf(id)).notified_complete_at === null, 'draft is unstamped');

  r = await call('PUT', '/api/invoices/' + id, { status: 'draft', customer_name: 'Ross Dress For Less #0272 - Ross', account_name: 'Academy Locksmith', customer_po_wo: 'R 681361', city_code: 'ATL', pay_type: 'Account',
    line_items: [{ line_type: 'labor', description: 'Rekey front door', quantity: 1, unit_price: 165 }] });
  eq(r.status, 200, 'labor line added on a later save');
  eq(SENT.length, 0, 'still no email: saving a draft is not a finish');
  eq(Number((await rowOf(id)).grand_total), 165, 'total is now 165 in the database');

  r = await call('POST', '/api/invoices/' + id + '/complete', { pay_type: 'Account' });
  eq(r.status, 200, 'Complete Invoice succeeds (' + JSON.stringify(r.body.error || '') + ')');
  eq(SENT.length, 1, 'exactly one email, sent at completion');
  let m = lastMail();
  eq(detail(m, 'Grand Total'), '$165.00', 'email Grand Total is the real total, not $0.00');
  eq(detail(m, 'Labor'), '$165.00', 'email shows labor');
  eq(detail(m, 'Parts'), '$0.00', 'email shows parts');
  eq(detail(m, 'Customer'), 'Ross Dress For Less #0272 - Ross', 'customer');
  eq(detail(m, 'Account'), 'Academy Locksmith', 'account');
  eq(detail(m, 'Customer PO / WO'), 'R 681361', 'PO/WO');
  eq(detail(m, 'Pay type'), 'Account', 'pay type');
  eq(detail(m, 'Finished by'), 'Anthony Weston', 'finished by');
  ok(detail(m, 'Card surcharge') === undefined && detail(m, 'Tip') === undefined, 'surcharge and tip rows hidden when zero');
  ok(m.subject.indexOf('#' + r.body.invoice.invoice_number) !== -1 && m.subject.indexOf('$165.00') !== -1, 'subject carries number and total: ' + m.subject);
  ok(m.to.indexOf('a@x.test') !== -1 && m.to.indexOf('b@x.test') !== -1, 'admin and owner get it');
  ok(m.to.indexOf('q@x.test') === -1, 'admin with emails off does not');
  ok(m.to.indexOf('t@x.test') === -1, 'the tech does not');
  eq(PUSHED.length, 1, 'one push');
  ok(PUSHED[0].payload.body.indexOf('$165.00') !== -1, 'push body carries the total: ' + PUSHED[0].payload.body);
  ok(PUSHED[0].payload.url.indexOf('id=' + id) !== -1, 'push deep-links to the invoice');
  ok((await rowOf(id)).notified_complete_at !== null, 'stamped');

  r = await call('POST', '/api/invoices/' + id + '/complete', { pay_type: 'Account' });
  eq(r.status, 409, 'second Complete refused');
  eq(SENT.length, 1, 'no second email');
  eq(await notifyInvoiceFinished(id, CURRENT_USER), false, 'helper called directly again: refuses');
  eq(SENT.length, 1, 'still one email');

  console.log('\n2. Reopen, correct the total, complete again');
  CURRENT_USER = { id: ADMIN, name: 'Ada Admin', role: 'admin' };
  r = await call('POST', '/api/invoices/' + id + '/reopen', {});
  eq(r.status, 200, 'reopened');
  ok((await rowOf(id)).notified_complete_at === null, 'reopen clears the stamp');
  r = await call('PUT', '/api/invoices/' + id, { status: 'draft', customer_name: 'Ross Dress For Less #0272 - Ross', account_name: 'Academy Locksmith', city_code: 'ATL', pay_type: 'Account',
    line_items: [{ line_type: 'labor', description: 'Rekey front door', quantity: 1, unit_price: 165 }, { line_type: 'part', description: 'Cylinder', quantity: 1, unit_price: 40, unit_cost: 12 }] });
  eq(r.status, 200, 'corrected');
  eq(SENT.length, 1, 'no email for the correction while still a draft');
  r = await call('POST', '/api/invoices/' + id + '/complete', { pay_type: 'Account' });
  eq(r.status, 200, 'completed again');
  eq(SENT.length, 2, 'second finish sends again');
  eq(detail(lastMail(), 'Grand Total'), '$205.00', 'with the corrected total');
  eq(detail(lastMail(), 'Finished by'), 'Ada Admin', 'names who finished it this time');

  console.log('\n3. Saving with the Status dropdown set to Paid is a finish');
  CURRENT_USER = { id: TECH, name: 'Anthony Weston', role: 'locksmith' };
  r = await call('POST', '/api/invoices', { status: 'draft', customer_name: 'Marcus Webb', city_code: 'ATL', pay_type: 'Cash', line_items: [{ line_type: 'labor', description: 'Lockout', quantity: 1, unit_price: 95 }] });
  eq(r.status, 201, 'draft with a priced line created'); let id2 = r.body.id;
  eq(SENT.length, 2, 'no email at creation even with a price on it');
  r = await call('PUT', '/api/invoices/' + id2, { status: 'paid', customer_name: 'Marcus Webb', city_code: 'ATL', pay_type: 'Cash', line_items: [{ line_type: 'labor', description: 'Lockout', quantity: 1, unit_price: 95 }] });
  eq(r.status, 200, 'PUT to paid (' + JSON.stringify(r.body.error || '') + ')');
  eq(SENT.length, 3, 'email sent on PUT draft -> paid');
  eq(detail(lastMail(), 'Grand Total'), '$95.00', 'with its total');
  CURRENT_USER = { id: ADMIN, name: 'Ada Admin', role: 'admin' };
  r = await call('PUT', '/api/invoices/' + id2, { status: 'paid', customer_name: 'Marcus Webb Jr', city_code: 'ATL', pay_type: 'Cash', line_items: [{ line_type: 'labor', description: 'Lockout', quantity: 1, unit_price: 95 }] });
  eq(r.status, 200, 'admin edits the paid invoice');
  eq(SENT.length, 3, 'paid -> paid edit does not re-send');

  console.log('\n4. Created straight as Paid');
  CURRENT_USER = { id: TECH, name: 'Anthony Weston', role: 'locksmith' };
  r = await call('POST', '/api/invoices', { status: 'paid', customer_name: 'Walk-in', city_code: 'ATL', pay_type: 'Cash', line_items: [{ line_type: 'labor', description: 'Key cut', quantity: 2, unit_price: 12.5 }] });
  eq(r.status, 201, 'created as paid (' + JSON.stringify(r.body.error || '') + ')');
  eq(SENT.length, 4, 'email at creation ONLY because it was created finished');
  eq(detail(lastMail(), 'Grand Total'), '$25.00', 'with its total');

  console.log('\n5. Two callers racing over the same finish send once');
  let raw = await pool.query("INSERT INTO invoices (invoice_number, locksmith_name, status, grand_total, tip_amount, surcharge_amount, pay_type, card_last4) VALUES (777, 'Tim Tech', 'paid', 110.50, 5, 3.15, 'Card', '4242') RETURNING id");
  let id3 = raw.rows[0].id;
  let both = await Promise.all([notifyInvoiceFinished(id3, null), notifyInvoiceFinished(id3, null), notifyInvoiceFinished(id3, null)]);
  eq(both.filter(Boolean).length, 1, 'exactly one of three concurrent calls sends');
  eq(SENT.length, 5, 'one email');
  eq(detail(lastMail(), 'Tip'), '$5.00', 'tip row shown when present');
  eq(detail(lastMail(), 'Card surcharge'), '$3.15', 'surcharge row shown when present');
  eq(detail(lastMail(), 'Pay type'), 'Card •••• 4242', 'card last4 on pay type');
  eq(detail(lastMail(), 'Finished by'), 'Tim Tech', 'falls back to the locksmith when no actor (Square path)');
  let d = await pool.query("INSERT INTO invoices (invoice_number, locksmith_name, status, grand_total) VALUES (778, 'Tim Tech', 'draft', 40) RETURNING id");
  eq(await notifyInvoiceFinished(d.rows[0].id, null), false, 'a draft is never notified even if asked');
  eq(SENT.length, 5, 'still five');

  console.log('\n6. Notification rules in Settings are honoured (invoice_created key)');
  await pool.query("INSERT INTO settings (key, value) VALUES ('notification_rules', $1)", [JSON.stringify({ invoice_created: { users: [OWNER], email: true, sms: false, extra_emails: ['books@x.test'] } })]);
  let e = await pool.query("INSERT INTO invoices (invoice_number, locksmith_name, status, grand_total) VALUES (779, 'Tim Tech', 'paid', 60) RETURNING id");
  eq(await notifyInvoiceFinished(e.rows[0].id, null), true, 'sent');
  eq(JSON.stringify(lastMail().to), JSON.stringify(['b@x.test', 'books@x.test']), 'goes to the configured list only');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close(); await pool.end();
  process.exit(fail ? 1 : 0);
}
server = http.createServer(app).listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; run().catch(function (e) { console.error(e); process.exit(1); }); });
