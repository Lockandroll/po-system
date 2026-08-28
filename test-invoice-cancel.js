'use strict';
/*
 * Invoice CANCEL harness -- runs against a REAL Postgres.
 *
 *   PGURL=postgres://postgres@127.0.0.1:5433/invoice_test node test-invoice-cancel.js
 *
 * Covers: cancelling from every reachable status, every refusal (paid, refunded,
 * a reconciled Square payment, a charge still in flight, a second cancel, another
 * tech's invoice), reopening back out of canceled, the grace window being keyed
 * to canceled_at rather than completed_at, and -- the one that silently costs
 * money -- the month-end parts report excluding a canceled invoice's part lines.
 *
 * The schema below is the subset of db.js this route touches, plus the cancel
 * migration VERBATIM, so a green run proves the ALTERs apply as well as the code.
 */
var http = require('http');
var Module = require('module');
var { Pool } = require('pg');

var pool = new Pool({ connectionString: process.env.PGURL });

/* ---- stub the module graph so routes/invoices.js loads standalone --------- */
var CURRENT_USER = null;
var NOOP = async function () {};
var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return { pool: pool, initDB: NOOP };
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = CURRENT_USER; next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
  };
  if (request === '../utils/email') return { sendEmail: NOOP, emailTemplate: function (a, b) { return String(b || ''); } };
  if (request === '../utils/sms') return { sendSms: NOOP };
  if (request === '../utils/notify') return { notify: NOOP, send: NOOP };
  if (request === '../utils/push') return { send: NOOP, sendToUser: NOOP };
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
CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255), role VARCHAR(50), supervisor_id INTEGER, home_city CHAR(3), phone VARCHAR(40));
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
  pay_type VARCHAR(50), card_last4 VARCHAR(4), approval_code VARCHAR(50), pay_method VARCHAR(10),
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

var express = require('express');
var app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/invoices', require('./routes/invoices'));

var pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL: ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

var server, base;
function call(method, path, body) {
  return new Promise(function (resolve, reject) {
    var data = body == null ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(base + path, {
      method: method,
      headers: Object.assign({ 'content-type': 'application/json' }, data ? { 'content-length': data.length } : {})
    }, function (res) {
      var buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        var json = null;
        try { json = JSON.parse(buf); } catch (e) { json = { _raw: buf }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// --- fixtures ---------------------------------------------------------------
let TECH, TECH2, ADMIN, MGR, ACCT, PART;
let nextNum = 900000001;

async function seed() {
  await pool.query(SCHEMA);
  await pool.query('TRUNCATE invoice_refund_lines, invoice_refunds, invoice_payments, invoice_photos, invoice_line_items, invoices, tasks, task_cc, audit_logs, vendors, parts, users, settings, cities RESTART IDENTITY CASCADE');
  MGR = (await pool.query("INSERT INTO users (name, email, role) VALUES ('Manda Manager','m@x.test','manager') RETURNING id")).rows[0].id;
  TECH = (await pool.query("INSERT INTO users (name, email, role, supervisor_id, home_city) VALUES ('Tim Tech','t@x.test','locksmith',$1,'ATL') RETURNING id", [MGR])).rows[0].id;
  TECH2 = (await pool.query("INSERT INTO users (name, email, role) VALUES ('Other Tech','o@x.test','locksmith') RETURNING id")).rows[0].id;
  ADMIN = (await pool.query("INSERT INTO users (name, email, role) VALUES ('Ada Admin','a@x.test','admin') RETURNING id")).rows[0].id;
  ACCT = (await pool.query("INSERT INTO vendors (name, show_in_invoice) VALUES ('Geico', true) RETURNING id")).rows[0].id;
  PART = (await pool.query("INSERT INTO parts (item_number, description, cost) VALUES ('HU100-T','Transponder blank', 18.40) RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO cities (code, name) VALUES ('ATL','Atlanta')");
}

// A complete, gate-passing invoice unless told otherwise.
async function mkInvoice(over) {
  over = over || {};
  const num = nextNum++;
  const r = await pool.query(
    "INSERT INTO invoices (invoice_number, locksmith_id, locksmith_name, status, customer_name, city_code, " +
    " labor_amount, parts_amount, subtotal, tax_amount, grand_total, tax_rate, pay_method, account_id) " +
    "VALUES ($1,$2,'Tim Tech',$3,$4,$5,95,65,160,4.55,164.55,7,'cash',$6) RETURNING *",
    [num, over.locksmith_id || TECH, over.status || 'draft',
     'customer_name' in over ? over.customer_name : 'Marcus Webb',
     'city_code' in over ? over.city_code : 'ATL',
     'account_id' in over ? over.account_id : null]
  );
  const inv = r.rows[0];
  if (over.noLines !== true) {
    await pool.query(
      "INSERT INTO invoice_line_items (invoice_id, line_type, description, unit_price, quantity, extension) " +
      "VALUES ($1,'labor','Vehicle lockout',95,1,95)", [inv.id]);
    await pool.query(
      "INSERT INTO invoice_line_items (invoice_id, line_type, part_id, item_number, description, unit_price, quantity, extension, unit_cost, taxable) " +
      "VALUES ($1,'part',$2,'HU100-T','Transponder key blank',65,1,65,18.40,true)", [inv.id, PART]);
  }
  return inv;
}
const statusOf = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];

async function run() {
  await seed();

  // === 1. The happy path ====================================================
  console.log('\n1. Cancelling an Active invoice');
  CURRENT_USER = { id: TECH, name: 'Tim Tech', role: 'locksmith' };
  let inv = await mkInvoice();
  let r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined', note: 'Said it was too high.' });
  eq(r.status, 200, 'a tech can cancel their own active invoice');
  let row = await statusOf(inv.id);
  eq(row.status, 'canceled', 'status is canceled');
  eq(row.cancel_reason, 'declined', 'the reason key is stored, not the label');
  eq(row.cancel_note, 'Said it was too high.', 'the note is stored');
  eq(row.canceled_by, TECH, 'canceled_by is the person who did it');
  ok(row.canceled_at != null, 'canceled_at is stamped');
  // ⚠️ The money must survive. Reports exclude canceled rows; the ROW keeps what
  // was quoted, because that is the only record of what the customer turned down.
  eq(parseFloat(row.grand_total), 164.55, 'grand_total is NOT zeroed on the row');
  eq(parseFloat(row.parts_amount), 65, 'parts_amount is NOT zeroed on the row');
  const aud = (await pool.query("SELECT * FROM audit_logs WHERE entity_id = $1 AND action = 'canceled'", [inv.id])).rows[0];
  ok(!!aud, 'an audit row is written');
  eq(aud && aud.details.reason_label, 'Customer declined the price', 'the audit row carries the human label');
  eq(aud && String(aud.details.would_have_been), '164.55', 'the audit row records what it would have been');

  // === 2. A reason is mandatory ============================================
  console.log('\n2. The reason is required and validated');
  inv = await mkInvoice();
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', {});
  eq(r.status, 400, 'no reason is refused');
  ok(Array.isArray(r.body.reasons) && r.body.reasons.length === 4, 'the refusal hands back the four valid reasons');
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'because_i_said_so' });
  eq(r.status, 400, 'an unknown reason key is refused');
  eq((await statusOf(inv.id)).status, 'draft', 'a refused cancel changed nothing');

  // === 3. Cancelling out of Waiting for Payment ============================
  console.log('\n3. Cancelling out of Waiting for Payment');
  inv = await mkInvoice();
  r = await call('POST', '/api/invoices/' + inv.id + '/waiting', { followup_date: '2026-09-30', note: 'chase' });
  eq(r.status, 200, 'the invoice parks as waiting');
  let parked = await statusOf(inv.id);
  ok(parked.followup_task_id != null, 'a chase task exists');
  ok(parked.waiting_since != null, 'waiting_since is set');
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'no_show' });
  eq(r.status, 200, 'a waiting invoice can be canceled');
  row = await statusOf(inv.id);
  eq(row.status, 'canceled', 'it is canceled');
  // ⚠️ Both of these matter: an invoice ageing on a debt nobody is owed, and a
  // task telling a tech to chase money for a job that did not happen.
  eq(row.waiting_since, null, 'the waiting clock is cleared');
  const task = (await pool.query('SELECT status FROM tasks WHERE id = $1', [parked.followup_task_id])).rows[0];
  eq(task.status, 'done', 'the chase task is closed');

  // === 4. Cancel is NOT gated ==============================================
  console.log('\n4. Cancel is not gated on the finish-line checklist');
  inv = await mkInvoice({ customer_name: null, city_code: null, noLines: true });
  r = await call('POST', '/api/invoices/' + inv.id + '/complete', { pay_type: 'Cash' });
  eq(r.status, 400, 'Complete is refused on an empty invoice');
  r = await call('POST', '/api/invoices/' + inv.id + '/waiting', { followup_date: '2026-09-30' });
  eq(r.status, 400, 'Waiting is refused on an empty invoice');
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'no_show' });
  eq(r.status, 200, 'Cancel goes through on the SAME empty invoice (the gone-on-arrival case)');

  // === 5. Refusals =========================================================
  console.log('\n5. What cannot be canceled');
  inv = await mkInvoice({ status: 'paid' });
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined' });
  eq(r.status, 409, 'a paid invoice cannot be canceled');
  ok(/refund/i.test(r.body.error), 'and the refusal points at the refund flow');

  inv = await mkInvoice({ status: 'refunded' });
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined' });
  eq(r.status, 409, 'a refunded invoice cannot be canceled');

  inv = await mkInvoice();
  await pool.query("INSERT INTO invoice_payments (invoice_id, status, amount_requested_cents) VALUES ($1,'reconciled',16455)", [inv.id]);
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined' });
  eq(r.status, 409, 'a DRAFT carrying a reconciled Square payment cannot be canceled');
  ok(/Square/.test(r.body.error), 'and the refusal names Square');

  inv = await mkInvoice();
  await pool.query("INSERT INTO invoice_payments (invoice_id, status, amount_requested_cents) VALUES ($1,'offline_pending',16455)", [inv.id]);
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined' });
  eq(r.status, 409, 'a charge still in flight blocks a cancel');

  inv = await mkInvoice({ status: 'canceled' });
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined' });
  eq(r.status, 409, 'cancelling twice is refused');

  inv = await mkInvoice({ locksmith_id: TECH2 });
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined' });
  eq(r.status, 403, "a tech cannot cancel somebody else's invoice");
  CURRENT_USER = { id: MGR, name: 'Manda Manager', role: 'manager' };
  r = await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined' });
  eq(r.status, 200, 'a manager can');
  CURRENT_USER = { id: TECH, name: 'Tim Tech', role: 'locksmith' };

  // === 6. A canceled invoice is frozen =====================================
  console.log('\n6. A canceled invoice refuses everything else');
  inv = await mkInvoice();
  await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'duplicate' });
  r = await call('POST', '/api/invoices/' + inv.id + '/complete', { pay_type: 'Cash' });
  eq(r.status, 409, 'it cannot be completed');
  ok(/reopen it first/i.test(r.body.error), 'and the error names the one way out');
  r = await call('POST', '/api/invoices/' + inv.id + '/waiting', { followup_date: '2026-09-30' });
  eq(r.status, 409, 'it cannot be parked as waiting');
  r = await call('POST', '/api/invoices/' + inv.id + '/pay-method', { pay_method: 'card' });
  eq(r.status, 409, 'its pay method cannot be switched (which would re-price it)');
  r = await call('PUT', '/api/invoices/' + inv.id, { customer_name: 'Someone Else', line_items: [] });
  eq(r.status, 409, 'it cannot be edited');
  CURRENT_USER = { id: ADMIN, name: 'Ada Admin', role: 'admin' };
  r = await call('PUT', '/api/invoices/' + inv.id, { customer_name: 'Someone Else', line_items: [] });
  eq(r.status, 409, 'not even by an admin -- the way back is Reopen, which clears the reason');
  eq((await statusOf(inv.id)).customer_name, 'Marcus Webb', 'and nothing was written');
  CURRENT_USER = { id: TECH, name: 'Tim Tech', role: 'locksmith' };

  // === 7. Reopen ===========================================================
  console.log('\n7. Reopening a canceled invoice');
  inv = await mkInvoice();
  await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined', note: 'too high' });
  r = await call('POST', '/api/invoices/' + inv.id + '/reopen', {});
  eq(r.status, 200, 'the person who canceled it can reopen inside the grace window');
  row = await statusOf(inv.id);
  eq(row.status, 'draft', 'it is Active again');
  // ⚠️ Every trace must go, or an Active invoice still prints "canceled by Tim".
  eq(row.cancel_reason, null, 'the reason is cleared');
  eq(row.cancel_note, null, 'the note is cleared');
  eq(row.canceled_at, null, 'canceled_at is cleared');
  eq(row.canceled_by, null, 'canceled_by is cleared');
  r = await call('POST', '/api/invoices/' + inv.id + '/complete', { pay_type: 'Cash' });
  eq(r.status, 200, 'and it can be completed normally afterwards');

  console.log('\n7b. The grace window is keyed to the CANCEL stamp, not completed_at');
  inv = await mkInvoice();
  await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined' });
  await pool.query("UPDATE invoices SET canceled_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [inv.id]);
  r = await call('POST', '/api/invoices/' + inv.id + '/reopen', {});
  eq(r.status, 403, 'past the window a tech is refused');
  ok(/canceled this invoice|minutes to undo/i.test(r.body.error), 'and the message says canceled, not completed');
  CURRENT_USER = { id: ADMIN, name: 'Ada Admin', role: 'admin' };
  r = await call('POST', '/api/invoices/' + inv.id + '/reopen', {});
  eq(r.status, 200, 'an admin can reopen it any time');
  CURRENT_USER = { id: TECH, name: 'Tim Tech', role: 'locksmith' };

  inv = await mkInvoice();
  await call('POST', '/api/invoices/' + inv.id + '/cancel', { reason: 'declined' });
  CURRENT_USER = { id: TECH2, name: 'Other Tech', role: 'locksmith' };
  r = await call('POST', '/api/invoices/' + inv.id + '/reopen', {});
  ok(r.status === 403, 'a different tech cannot reopen somebody else\'s cancel');
  CURRENT_USER = { id: TECH, name: 'Tim Tech', role: 'locksmith' };

  // === 8. THE MONEY ONE: the month-end parts report =========================
  console.log('\n8. The month-end parts report excludes canceled invoices');
  await pool.query('TRUNCATE invoice_line_items, invoices RESTART IDENTITY CASCADE');
  const keep = await mkInvoice();                       // draft, counts
  const gone = await mkInvoice();                       // will be canceled
  await pool.query("UPDATE invoices SET invoice_date = CURRENT_DATE");
  await call('POST', '/api/invoices/' + gone.id + '/cancel', { reason: 'no_show' });
  const month = new Date().toISOString().slice(0, 7);
  r = await call('GET', '/api/invoices/parts-report?month=' + month);
  eq(r.status, 200, 'the report builds');
  const blank = (r.body.items || []).filter(i => i.item_number === 'HU100-T')[0];
  ok(!!blank, 'the surviving invoice still puts the blank on the order');
  // Two invoices each used 1. Only one of them happened.
  eq(parseFloat(blank.total_qty), 1, 'the canceled invoice\'s blank is NOT reordered');
  eq(parseInt(blank.invoice_count, 10), 1, 'and it is not counted as an invoice either');

  // === 9. COGS and margin read zero on a canceled invoice ==================
  console.log('\n9. COGS is zero on a canceled invoice');
  CURRENT_USER = { id: MGR, name: 'Manda Manager', role: 'manager' };
  r = await call('GET', '/api/invoices/' + gone.id);
  eq(r.status, 200, 'the canceled invoice loads');
  eq(r.body.cogs.total, 0, 'COGS is zero');
  eq(r.body.cogs.gross_profit, 0, 'gross profit is zero, not a loss the size of the parts');
  eq(r.body.cogs.incomplete, false, 'and it is not flagged as incomplete COGS');
  eq(r.body.cancel_reason_label, 'Gone on arrival / no-show', 'the human label is served to the client');
  eq(r.body.canceled_by_name, 'Tim Tech', 'and the name of whoever did it');
  r = await call('GET', '/api/invoices/' + keep.id);
  eq(r.body.cogs.total, 18.4, 'a live invoice still reports its real COGS');

  // === 10. cancel_reasons ship with the config =============================
  console.log('\n10. The reason list is served, not duplicated in the client');
  r = await call('GET', '/api/invoices/config');
  eq(r.status, 200, 'config loads');
  eq((r.body.cancel_reasons || []).length, 4, 'four reasons are shipped');
  eq(r.body.cancel_reasons[0].key, 'declined', 'keyed the way the server validates');
  eq(r.body.pulsar_canceled_label, 'Canceled', 'and the Pulsar label the close-out card copies');

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' assertions passed, ' + fail + ' failed.');
  return fail;
}

server = http.createServer(app).listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  let code = 1;
  try { code = await run(); }
  catch (e) { console.error(e); code = 1; }
  server.close();
  await pool.end();
  process.exit(code === 0 ? 0 : 1);
});
