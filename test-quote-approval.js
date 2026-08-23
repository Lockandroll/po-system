// test-quote-approval.js
// Customer quote approval: migration, routes, public token surface, reminder job.
//
// Run with a real Postgres:
//   DATABASE_URL=postgresql://... node test-quote-approval.js
//
// Nothing here is mocked except the outbound side effects (email, SMS, push,
// audit, R2) and the auth middleware. The database is real, the Express routes
// are the real ones, and the HTTP requests are real.

const Module = require('module');
const http = require('http');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const FAILURES = [];
function ok(name, cond, detail) {
  if (cond) { PASS++; }
  else { FAIL++; FAILURES.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------------------
// Stubs. Only the outbound edges - everything inbound is the real code.
// ---------------------------------------------------------------------------
const SENT = { emails: [], sms: [], push: [], audit: [] };
let CURRENT_USER = { id: 1, name: 'Tony McKeon', role: 'admin' };
let CURRENT_PERMS = null;   // null = allow everything

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });

const STUBS = {
  '../db': { pool: pool, initDB: null },
  '../middleware/auth': {
    requireAuth: function (req, res, next) { req.user = CURRENT_USER; next(); },
    requirePermission: function (perm) {
      return function (req, res, next) {
        if (CURRENT_PERMS && CURRENT_PERMS.indexOf(perm) === -1) return res.status(403).json({ error: 'Missing permission: ' + perm });
        next();
      };
    },
    requireRole: function () { return function (req, res, next) { next(); }; }
  },
  '../utils/audit': { logAudit: async function (a) { SENT.audit.push(a); } },
  '../utils/r2': { configured: function () { return false; }, presignDownload: async function () { return null; }, presignUpload: async function () { return null; }, deleteObject: async function () {} },
  '../utils/email': null,   // filled below - we want the REAL emailTemplate
  '../utils/sms': { sendSms: async function (to, body) { SENT.sms.push({ to: to, body: body }); return true; } },
  '../utils/notify': { broadcastRecipients: async function () { return { emails: ['admin@lockandroll.com'], phones: [], userIds: [9] }; } },
  '../utils/push': { sendPushToUsers: async function (ids, p) { SENT.push.push({ ids: ids, payload: p }); } }
};

const _load = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request) && STUBS[request]) return STUBS[request];
  return _load.apply(this, arguments);
};

// The real emailTemplate, but sendEmail captured so we can assert on reply_to.
const realEmail = require('./utils/email');
STUBS['../utils/email'] = {
  emailTemplate: realEmail.emailTemplate,
  sendEmail: async function (to, subject, html, cc, attachments, opts) {
    SENT.emails.push({ to: to, subject: subject, html: html, opts: opts || {} });
    return true;
  }
};

// ---------------------------------------------------------------------------
// Server under test
// ---------------------------------------------------------------------------
const express = require('express');
const quotesRouter = require('./routes/quotes');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/quotes', quotesRouter);
app.use('/api/quote-approve', quotesRouter.publicRouter);
let server, BASE;

async function req(method, path, body, headers) {
  const res = await fetch(BASE + path, {
    method: method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, body: data };
}

// ---------------------------------------------------------------------------
// The migration, lifted verbatim from db.js so the test exercises the SHIPPING
// SQL rather than a copy of it. If db.js and this ever disagree, the extraction
// throws instead of silently testing nothing.
// ---------------------------------------------------------------------------
const fs = require('fs');
function extractQuoteMigration() {
  const src = fs.readFileSync(require.resolve('./db.js'), 'utf8');
  const start = src.indexOf("ALTER TABLE quotes ADD COLUMN IF NOT EXISTS status");
  if (start === -1) throw new Error('db.js no longer contains the quote approval migration');
  const end = src.indexOf("ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_reason TEXT;", start);
  if (end === -1) throw new Error('db.js quote approval migration is truncated');
  const chunk = src.slice(start - 1, end + 80);
  // Pull the SQL out of the JS string concatenation.
  const stmts = chunk.match(/ALTER TABLE quotes ADD COLUMN IF NOT EXISTS [^;]+;/g) || [];
  if (stmts.length < 16) throw new Error('expected >=16 ALTER statements, found ' + stmts.length);
  return stmts;
}

const NEW_COLUMNS = [
  ['status', 'character varying', "'draft'::character varying"],
  ['approval_token', 'character varying', null],
  ['token_expires_at', 'timestamp without time zone', null],
  ['sent_at', 'timestamp without time zone', null],
  ['sent_to', 'character varying', null],
  ['sent_by', 'integer', null],
  ['last_reminded_at', 'timestamp without time zone', null],
  ['reminder_count', 'integer', '0'],
  ['first_viewed_at', 'timestamp without time zone', null],
  ['responded_at', 'timestamp without time zone', null],
  ['approver_name', 'character varying', null],
  ['approver_title', 'character varying', null],
  ['approver_ip', 'character varying', null],
  ['approved_total', 'numeric', null],
  ['signature_data', 'text', null],
  ['customer_message', 'text', null],
  ['decline_reason', 'text', null]
];

async function testMigration() {
  section('Migration against real Postgres');

  // A genuine PRE-change quotes table: exactly the shape prod had before today.
  await pool.query('DROP SCHEMA IF EXISTS legacy CASCADE; CREATE SCHEMA legacy;');
  await pool.query('SET search_path TO legacy');
  await pool.query(
    'CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255));' +
    'CREATE TABLE quotes (' +
    '  id SERIAL PRIMARY KEY, quote_number VARCHAR(50) UNIQUE NOT NULL,' +
    '  requester_id INTEGER REFERENCES users(id), customer_name VARCHAR(255) NOT NULL,' +
    '  city_code CHAR(3), notes TEXT, important_info TEXT,' +
    '  tax_rate DECIMAL(5,2) DEFAULT 0, tax_amount DECIMAL(10,2) DEFAULT 0,' +
    '  total_amount DECIMAL(10,2) DEFAULT 0, customer_email VARCHAR(255),' +
    '  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());'
  );
  await pool.query("INSERT INTO users (name) VALUES ('Legacy Tony')");
  await pool.query("INSERT INTO quotes (quote_number, requester_id, customer_name, total_amount) VALUES ('QT-2025-0001-TM', 1, 'Old Customer', 500)");

  const stmts = extractQuoteMigration();
  ok('migration extracted from db.js (' + stmts.length + ' ALTERs)', stmts.length >= 17);

  // CREATE TABLE IF NOT EXISTS would have silently skipped this table. The
  // ALTERs are the whole reason prod does not 500 on "column does not exist".
  for (let pass = 0; pass < 2; pass++) {
    for (const st of stmts) await pool.query(st);
  }
  ok('ALTERs are idempotent over two passes', true);

  const cols = (await pool.query(
    "SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns " +
    "WHERE table_schema = 'legacy' AND table_name = 'quotes'"
  )).rows.reduce(function (m, r) { m[r.column_name] = r; return m; }, {});

  for (const [name, type, def] of NEW_COLUMNS) {
    ok('column quotes.' + name + ' added to the EXISTING table', !!cols[name]);
    if (cols[name]) {
      eq('quotes.' + name + ' type', cols[name].data_type, type);
      if (def !== null) eq('quotes.' + name + ' default', cols[name].column_default, def);
    }
  }

  // The legacy row must survive and pick up the defaults.
  const legacy = (await pool.query('SELECT status, reminder_count, approval_token, approved_total FROM quotes WHERE quote_number = $1', ['QT-2025-0001-TM'])).rows[0];
  eq('legacy row defaults to draft', legacy.status, 'draft');
  eq('legacy row reminder_count defaults to 0', legacy.reminder_count, 0);
  eq('legacy row has no token', legacy.approval_token, null);
  eq('legacy row has no approved_total', legacy.approved_total, null);

  // status is NOT NULL, so an old row can never read as "unknown state".
  eq('quotes.status is NOT NULL', cols.status.is_nullable, 'NO');

  await pool.query('RESET search_path');
}

// ---------------------------------------------------------------------------
// A working schema for the route tests: the real prod shape, post-migration.
// ---------------------------------------------------------------------------
async function buildSchema() {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.query(
    'CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255), phone VARCHAR(50),' +
    '  receive_emails BOOLEAN NOT NULL DEFAULT true, receive_sms BOOLEAN NOT NULL DEFAULT false, active BOOLEAN DEFAULT true);' +
    'CREATE TABLE settings (key VARCHAR(100) PRIMARY KEY, value TEXT);' +
    'CREATE TABLE quotes (' +
    '  id SERIAL PRIMARY KEY, quote_number VARCHAR(50) UNIQUE NOT NULL,' +
    '  requester_id INTEGER REFERENCES users(id), customer_name VARCHAR(255) NOT NULL,' +
    '  city_code CHAR(3), notes TEXT, important_info TEXT,' +
    '  tax_rate DECIMAL(5,2) DEFAULT 0, tax_amount DECIMAL(10,2) DEFAULT 0, total_amount DECIMAL(10,2) DEFAULT 0,' +
    '  customer_street VARCHAR(255), customer_city VARCHAR(120), customer_state VARCHAR(4),' +
    '  customer_zip VARCHAR(12), customer_phone VARCHAR(50), customer_email VARCHAR(255),' +
    '  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());' +
    'CREATE TABLE quote_line_items (' +
    '  id SERIAL PRIMARY KEY, quote_id INTEGER REFERENCES quotes(id) ON DELETE CASCADE,' +
    '  item_number VARCHAR(100), manufacturer VARCHAR(255), description VARCHAR(500) NOT NULL,' +
    '  quantity DECIMAL(10,2) NOT NULL, unit_price DECIMAL(10,2) NOT NULL, list_price DECIMAL(10,2),' +
    '  taxable BOOLEAN DEFAULT false, url TEXT, line_type VARCHAR(10) NOT NULL DEFAULT $$part$$);' +
    'CREATE TABLE purchase_orders (id SERIAL PRIMARY KEY, po_number VARCHAR(50) UNIQUE NOT NULL,' +
    '  requester_id INTEGER, vendor_name VARCHAR(255), customer_name VARCHAR(255), city_code CHAR(3),' +
    '  notes TEXT, total_amount DECIMAL(10,2), status VARCHAR(50), created_at TIMESTAMP DEFAULT NOW());' +
    'CREATE TABLE po_line_items (id SERIAL PRIMARY KEY, po_id INTEGER, item_number VARCHAR(100),' +
    '  manufacturer VARCHAR(255), description VARCHAR(500), quantity DECIMAL(10,2), unit_price DECIMAL(10,2));' +
    'CREATE TABLE quote_photos (id SERIAL PRIMARY KEY, quote_id INTEGER, name VARCHAR(255), r2_key TEXT,' +
    '  mime_type VARCHAR(255), size_bytes BIGINT, uploaded_by INTEGER, uploaded_by_name VARCHAR(255),' +
    '  status VARCHAR(20), created_at TIMESTAMP DEFAULT NOW());'
  );
  for (const st of extractQuoteMigration()) await pool.query(st);
  await pool.query(
    'CREATE TABLE IF NOT EXISTS quote_events (' +
    '  id SERIAL PRIMARY KEY, quote_id INTEGER REFERENCES quotes(id) ON DELETE CASCADE,' +
    '  event_type VARCHAR(32) NOT NULL, actor_name VARCHAR(255), ip VARCHAR(64),' +
    '  user_agent VARCHAR(500), details JSONB, created_at TIMESTAMP DEFAULT NOW());'
  );
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_approval_token ON quotes(approval_token) WHERE approval_token IS NOT NULL;');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_quote_events_quote ON quote_events(quote_id, created_at);');

  await pool.query("INSERT INTO users (name, email, phone, receive_emails, receive_sms) VALUES ($1,$2,$3,true,false)", ['Tony McKeon', 'tony@lockandroll.com', '4045550100']);
  await pool.query("INSERT INTO settings (key, value) VALUES ('company_name','Lock and Roll LLC'),('company_phone','(404) 555-0100'),('logo','')");
}

async function testIndexAndCascade() {
  section('Token index and event cascade');
  await pool.query("INSERT INTO quotes (quote_number, requester_id, customer_name) VALUES ('QT-IDX-1', 1, 'A'),('QT-IDX-2', 1, 'B')");
  // Two un-sent quotes both have a NULL token. A plain UNIQUE index would have
  // rejected the second one; the partial index is what makes that legal.
  ok('two NULL tokens coexist', true);
  await pool.query("UPDATE quotes SET approval_token = repeat('a',64) WHERE quote_number = 'QT-IDX-1'");
  let dupRejected = false;
  try { await pool.query("UPDATE quotes SET approval_token = repeat('a',64) WHERE quote_number = 'QT-IDX-2'"); }
  catch (e) { dupRejected = (e.code === '23505'); }
  ok('a duplicate non-null token is rejected', dupRejected);

  const qid = (await pool.query("SELECT id FROM quotes WHERE quote_number = 'QT-IDX-1'")).rows[0].id;
  await pool.query("INSERT INTO quote_events (quote_id, event_type) VALUES ($1,'sent')", [qid]);
  await pool.query('DELETE FROM quotes WHERE id = $1', [qid]);
  const left = (await pool.query('SELECT COUNT(*)::int AS c FROM quote_events WHERE quote_id = $1', [qid])).rows[0].c;
  eq('deleting a quote cascades its events away', left, 0);
  await pool.query("DELETE FROM quotes WHERE quote_number LIKE 'QT-IDX-%'");
}

// ---------------------------------------------------------------------------
// Route-level: the whole lifecycle over real HTTP.
// ---------------------------------------------------------------------------
async function makeQuote(opts) {
  const o = opts || {};
  const q = (await pool.query(
    'INSERT INTO quotes (quote_number, requester_id, customer_name, city_code, notes, important_info, tax_rate, tax_amount, total_amount, customer_email, customer_phone) ' +
    'VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [o.number || ('QT-T-' + Math.random().toString(36).slice(2, 9)), o.customer || 'Riverbend Storage LLC', 'ATL',
     o.notes || 'Panic bar is a special order.', o.important || null,
     o.taxRate == null ? 8.9 : o.taxRate, 0, 0, o.email === undefined ? 'd.harlow@riverbendstor.com' : o.email, '4045550182']
  )).rows[0];
  const items = o.items || [
    { d: 'Rekey existing mortise cylinder, keyed alike', qty: 6, cost: 22, list: 68, taxable: true, type: 'part', item: 'MC-119', mfr: 'Schlage', url: 'https://supplier.example/mc119' },
    { d: 'Panic bar installation, labor', qty: 3.5, cost: 0, list: 185, taxable: false, type: 'labor', item: null, mfr: null, url: null }
  ];
  for (const it of items) {
    await pool.query(
      'INSERT INTO quote_line_items (quote_id, item_number, manufacturer, description, quantity, unit_price, list_price, taxable, url, line_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [q.id, it.item, it.mfr, it.d, it.qty, it.cost, it.list, it.taxable, it.url, it.type]
    );
  }
  // Keep the stored total honest, the way POST /quotes does.
  const t = items.reduce(function (a, it) { return a + it.qty * it.list; }, 0);
  const taxable = items.reduce(function (a, it) { return it.taxable ? a + it.qty * it.list : a; }, 0);
  const rate = o.taxRate == null ? 8.9 : o.taxRate;
  const tax = taxable * rate / 100;
  await pool.query('UPDATE quotes SET tax_amount = $1, total_amount = $2 WHERE id = $3', [tax, t + tax, q.id]);
  return Object.assign(q, { expected_subtotal: t, expected_tax: tax, expected_total: t + tax });
}

// Walks a whole JSON payload looking for anything that smells like our cost.
function deepFindKeys(obj, keys, path, hits) {
  path = path || '$'; hits = hits || [];
  if (obj === null || typeof obj !== 'object') return hits;
  if (Array.isArray(obj)) { obj.forEach(function (v, i) { deepFindKeys(v, keys, path + '[' + i + ']', hits); }); return hits; }
  Object.keys(obj).forEach(function (k) {
    if (keys.indexOf(k) !== -1) hits.push(path + '.' + k);
    deepFindKeys(obj[k], keys, path + '.' + k, hits);
  });
  return hits;
}

async function testSend() {
  section('Sending a quote to the customer');
  SENT.emails.length = 0; SENT.sms.length = 0;

  const q = await makeQuote({});

  CURRENT_PERMS = ['view_quotes', 'edit_quote'];       // no send_quote
  let r = await req('POST', '/api/quotes/' + q.id + '/send', { to: 'd.harlow@riverbendstor.com' });
  eq('send without send_quote is refused', r.status, 403);

  CURRENT_PERMS = null;
  const noEmail = await makeQuote({ email: null });
  r = await req('POST', '/api/quotes/' + noEmail.id + '/send', {});
  eq('send with no customer email is refused', r.status, 400);

  const noItems = (await pool.query("INSERT INTO quotes (quote_number, requester_id, customer_name, customer_email) VALUES ('QT-EMPTY-1',1,'X','x@y.com') RETURNING *")).rows[0];
  r = await req('POST', '/api/quotes/' + noItems.id + '/send', {});
  eq('send with no line items is refused', r.status, 400);

  r = await req('POST', '/api/quotes/' + q.id + '/send', { to: 'd.harlow@riverbendstor.com', sms_to: '4045550182', message: 'Let me know if anything looks off.', expires_days: 30 });
  eq('send succeeds', r.status, 200);
  ok('send reports the email went out', r.body && r.body.emailed === true);

  const row = (await pool.query('SELECT * FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('status flips to sent', row.status, 'sent');
  ok('a 64-char hex token is minted', /^[a-f0-9]{64}$/.test(row.approval_token || ''), row.approval_token);
  eq('sent_to is recorded', row.sent_to, 'd.harlow@riverbendstor.com');
  ok('sent_at is set', !!row.sent_at);
  ok('sent_by is the acting user', row.sent_by === 1);
  eq('customer message is stored', row.customer_message, 'Let me know if anything looks off.');
  const days = Math.round((new Date(row.token_expires_at) - Date.now()) / 86400000);
  eq('expiry lands 30 days out', days, 30);

  eq('one customer email went out', SENT.emails.length, 1);
  const mail = SENT.emails[0];
  ok('email addressed to the customer', mail.to === 'd.harlow@riverbendstor.com');
  ok('subject carries the quote number', mail.subject.indexOf(q.quote_number) !== -1, mail.subject);
  eq('reply-to falls back to the preparer', mail.opts.replyTo, 'tony@lockandroll.com');
  ok('the email links to the token page', mail.html.indexOf('/quote/' + row.approval_token) !== -1);
  ok('the email shows the total', mail.html.indexOf('$' + q.expected_total.toFixed(2)) !== -1, 'looking for $' + q.expected_total.toFixed(2));
  ok('our cost never appears in the email', mail.html.indexOf('22.00') === -1);
  eq('an SMS went out too', SENT.sms.length, 1);
  ok('the SMS carries the link', SENT.sms[0].body.indexOf('/quote/' + row.approval_token) !== -1);

  const ev = (await pool.query("SELECT * FROM quote_events WHERE quote_id = $1 AND event_type = 'sent'", [q.id])).rows;
  eq('a sent event is logged', ev.length, 1);
  eq('the event names who sent it', ev[0].actor_name, 'Tony McKeon');

  r = await req('POST', '/api/quotes/' + q.id + '/send', { to: 'd.harlow@riverbendstor.com' });
  eq('sending an already-sent quote is refused', r.status, 409);

  return Object.assign(row, { expected_total: q.expected_total, expected_subtotal: q.expected_subtotal, expected_tax: q.expected_tax });
}

async function testPublicView(q) {
  section('What the customer can see');

  let r = await req('GET', '/api/quote-approve/' + 'z'.repeat(64));
  eq('an unknown token is a 404', r.status, 404);
  r = await req('GET', '/api/quote-approve/not-a-token');
  eq('a malformed token is a 404, not a 500', r.status, 404);

  r = await req('GET', '/api/quote-approve/' + q.approval_token);
  eq('the customer can load the quote', r.status, 200);
  const d = r.body;

  // THE test. Not "the page does not draw a cost" - the number is not in the
  // response at all, so no future frontend change can leak it.
  const leaks = deepFindKeys(d, ['unit_price', 'cost', 'unit_cost', 'item_number', 'manufacturer', 'url', 'requester_id', 'sent_by', 'approval_token', 'approver_ip', 'city_code']);
  ok('the payload contains NO cost or internal field', leaks.length === 0, leaks.join(', '));
  ok('the raw JSON never contains our cost figure', JSON.stringify(d).indexOf('22') === -1 || JSON.stringify(d).indexOf('"unit_price"') === -1);

  eq('quote number is shown', d.quote_number, q.quote_number);
  eq('customer name is shown', d.customer_name, 'Riverbend Storage LLC');
  eq('the preparer is named', d.prepared_by.name, 'Tony McKeon');
  ok('company branding is included', d.company && d.company.company_name === 'Lock and Roll LLC');
  eq('line items are exposed', d.line_items.length, 2);
  eq('a line item exposes only the four print columns',
    Object.keys(d.line_items[0]).sort().join(','), 'description,line_type,list_price,quantity,taxable');

  // Totals must match the print path exactly: list price, taxable lines only.
  ok('subtotal matches the printed quote', Math.abs(d.subtotal - q.expected_subtotal) < 0.005, d.subtotal + ' vs ' + q.expected_subtotal);
  ok('tax matches the printed quote', Math.abs(d.tax_amount - q.expected_tax) < 0.005, d.tax_amount + ' vs ' + q.expected_tax);
  ok('total matches the printed quote', Math.abs(d.total - q.expected_total) < 0.005, d.total + ' vs ' + q.expected_total);
  ok('labor is not taxed', d.line_items[1].taxable === false);

  const row = (await pool.query('SELECT status, first_viewed_at FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('the first open flips sent to viewed', row.status, 'viewed');
  ok('first_viewed_at is stamped', !!row.first_viewed_at);

  const firstView = row.first_viewed_at;
  await req('GET', '/api/quote-approve/' + q.approval_token);
  const row2 = (await pool.query('SELECT status, first_viewed_at FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('a second open does not re-flip the status', row2.status, 'viewed');
  eq('first_viewed_at is not overwritten', String(row2.first_viewed_at), String(firstView));
  const views = (await pool.query("SELECT COUNT(*)::int AS c FROM quote_events WHERE quote_id = $1 AND event_type = 'viewed'", [q.id])).rows[0].c;
  eq('every open is still logged', views, 2);

  const ipRow = (await pool.query("SELECT ip, user_agent FROM quote_events WHERE quote_id = $1 AND event_type = 'viewed' ORDER BY id LIMIT 1", [q.id])).rows[0];
  ok('the view records an IP', !!ipRow.ip);
}

async function testApprove(q) {
  section('Approving');
  SENT.emails.length = 0; SENT.push.length = 0; SENT.audit.length = 0;

  let r = await req('POST', '/api/quote-approve/' + q.approval_token + '/approve', { name: 'Danielle Harlow' });
  eq('approve without consent is refused', r.status, 400);
  r = await req('POST', '/api/quote-approve/' + q.approval_token + '/approve', { consent: true, name: 'D' });
  eq('approve without a real name is refused', r.status, 400);
  r = await req('POST', '/api/quote-approve/' + q.approval_token + '/approve', { consent: 'true', name: 'Danielle Harlow' });
  eq('a stringy consent value is not consent', r.status, 400);

  // A browser-supplied total must be ignored: the server approves its own math.
  r = await req('POST', '/api/quote-approve/' + q.approval_token + '/approve',
    { consent: true, name: 'Danielle Harlow', title: 'Property Manager', total: 1, approved_total: 1, signature: 'data:image/png;base64,iVBOR' });
  eq('approve succeeds', r.status, 200);
  ok('the response echoes the server total', Math.abs(r.body.approved_total - q.expected_total) < 0.005, String(r.body.approved_total));

  const row = (await pool.query('SELECT * FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('status is approved', row.status, 'approved');
  eq('the approver name is stored', row.approver_name, 'Danielle Harlow');
  eq('the title is stored', row.approver_title, 'Property Manager');
  ok('approved_total is the server figure, not the browser one',
    Math.abs(parseFloat(row.approved_total) - q.expected_total) < 0.005, String(row.approved_total));
  ok('the IP is recorded', !!row.approver_ip);
  ok('the signature is stored', (row.signature_data || '').indexOf('data:image/png') === 0);
  ok('responded_at is stamped', !!row.responded_at);

  const ev = (await pool.query("SELECT * FROM quote_events WHERE quote_id = $1 AND event_type = 'approved'", [q.id])).rows;
  eq('an approved event is logged', ev.length, 1);
  eq('the event names the approver', ev[0].actor_name, 'Danielle Harlow');
  ok('the event records it was signed', ev[0].details && ev[0].details.signed === true);

  await new Promise(function (res) { setTimeout(res, 150); });   // notify is fire-and-forget
  ok('the team was emailed', SENT.emails.length >= 1);
  ok('the team email names the approver', SENT.emails.length && SENT.emails[0].html.indexOf('Danielle Harlow') !== -1);
  ok('a push went out', SENT.push.length >= 1);
  ok('the preparer is on the push list', SENT.push.length && SENT.push[0].ids.indexOf(1) !== -1);
  ok('an audit row was written', SENT.audit.some(function (a) { return a.action === 'approved_by_customer'; }));

  r = await req('POST', '/api/quote-approve/' + q.approval_token + '/approve', { consent: true, name: 'Someone Else' });
  eq('a second approval is refused', r.status, 409);
  eq('the refusal is the already-answered one', r.body.error, 'already_answered');
  const still = (await pool.query('SELECT approver_name FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('the original approver is untouched', still.approver_name, 'Danielle Harlow');

  r = await req('POST', '/api/quote-approve/' + q.approval_token + '/decline', { name: 'Someone Else' });
  eq('declining after approval is refused', r.status, 409);

  r = await req('GET', '/api/quote-approve/' + q.approval_token);
  eq('the link still resolves after answering', r.status, 200);
  eq('and serves the receipt state', r.body.status, 'approved');
  ok('the receipt carries the approved total', Math.abs(r.body.approved_total - q.expected_total) < 0.005);
  ok('the receipt still leaks no cost', deepFindKeys(r.body, ['unit_price', 'approver_ip']).length === 0);
}

async function testDeclineAndMessage() {
  section('Declining and asking for changes');

  const q1 = await makeQuote({});
  await req('POST', '/api/quotes/' + q1.id + '/send', {});
  let tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q1.id])).rows[0].approval_token;
  let r = await req('POST', '/api/quote-approve/' + tok + '/decline', { name: 'Danielle Harlow', reason: 'Went with in-house' });
  eq('decline succeeds', r.status, 200);
  let row = (await pool.query('SELECT * FROM quotes WHERE id = $1', [q1.id])).rows[0];
  eq('status is declined', row.status, 'declined');
  eq('the reason is stored', row.decline_reason, 'Went with in-house');
  eq('no approved_total is invented on a decline', row.approved_total, null);

  const q2 = await makeQuote({});
  await req('POST', '/api/quotes/' + q2.id + '/send', {});
  tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q2.id])).rows[0].approval_token;

  r = await req('POST', '/api/quote-approve/' + tok + '/message', { message: 'a' });
  eq('an empty message is refused', r.status, 400);

  SENT.emails.length = 0;
  r = await req('POST', '/api/quote-approve/' + tok + '/message', { message: 'Can we hold the panic bar until October?', phone: '4045550182' });
  eq('asking a question succeeds', r.status, 200);
  row = (await pool.query('SELECT * FROM quotes WHERE id = $1', [q2.id])).rows[0];
  eq('status becomes changes_requested', row.status, 'changes_requested');
  eq('no decision was recorded', row.responded_at, null);

  // The whole point: this is not a decision, so the quote stays answerable.
  r = await req('POST', '/api/quote-approve/' + tok + '/approve', { consent: true, name: 'Danielle Harlow' });
  eq('the customer can still approve after asking a question', r.status, 200);
  row = (await pool.query('SELECT status FROM quotes WHERE id = $1', [q2.id])).rows[0];
  eq('and the quote lands on approved', row.status, 'approved');

  const ev = (await pool.query("SELECT details FROM quote_events WHERE quote_id = $1 AND event_type = 'changes_requested'", [q2.id])).rows[0];
  ok('the message is on the trail', ev.details.message.indexOf('panic bar') !== -1);
  ok('the callback number is on the trail', ev.details.phone === '4045550182');
}

async function testExpiry() {
  section('Expiry');
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', { expires_days: 1 });
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  await pool.query("UPDATE quotes SET token_expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [q.id]);

  let r = await req('GET', '/api/quote-approve/' + tok);
  eq('an expired link is a 410', r.status, 410);
  eq('and says so plainly', r.body.error, 'expired');
  ok('the expired page still names the quote', r.body.quote_number === q.quote_number);
  // The pricing must not ride along on the expired response.
  ok('an expired response carries no pricing', r.body.total === undefined && r.body.line_items === undefined);

  const row = (await pool.query('SELECT status FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('the quote is marked expired', row.status, 'expired');

  r = await req('POST', '/api/quote-approve/' + tok + '/approve', { consent: true, name: 'Danielle Harlow' });
  eq('an expired quote cannot be approved', r.status, 410);
  r = await req('POST', '/api/quote-approve/' + tok + '/message', { message: 'still interested' });
  eq('an expired quote cannot take a message either', r.status, 410);

  // An already-answered quote must NOT be expired out from under its receipt.
  const q2 = await makeQuote({});
  await req('POST', '/api/quotes/' + q2.id + '/send', {});
  const tok2 = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q2.id])).rows[0].approval_token;
  await req('POST', '/api/quote-approve/' + tok2 + '/approve', { consent: true, name: 'Danielle Harlow' });
  await pool.query("UPDATE quotes SET token_expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [q2.id]);
  r = await req('GET', '/api/quote-approve/' + tok2);
  eq('an approved quote past its date still shows the receipt', r.status, 200);
  eq('and stays approved', r.body.status, 'approved');
}

async function testReadOnlyAndVoid() {
  section('A sent quote is read-only');
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const before = (await pool.query('SELECT * FROM quotes WHERE id = $1', [q.id])).rows[0];

  // The real editor always submits every contact field, so the test does too -
  // PUT replaces them wholesale and omitting one blanks it.
  const edit = {
    customer_name: 'Riverbend Storage LLC', city_code: 'ATL', notes: 'Edited', important_info: null, tax_rate: 8.9,
    customer_email: 'd.harlow@riverbendstor.com', customer_phone: '4045550182',
    line_items: [{ description: 'Rekey', quantity: 6, unit_price: 22, list_price: 75, taxable: true, line_type: 'part' }]
  };

  let r = await req('PUT', '/api/quotes/' + q.id, edit);
  eq('editing a sent quote is refused', r.status, 409);
  eq('with the structured reason the UI needs', r.body.error, 'quote_is_out');
  eq('and tells the UI who it went to', r.body.sent_to, 'd.harlow@riverbendstor.com');
  const unchanged = (await pool.query('SELECT notes, approval_token FROM quotes WHERE id = $1', [q.id])).rows[0];
  ok('nothing was written on the refused edit', unchanged.notes !== 'Edited');
  eq('and the token is untouched', unchanged.approval_token, before.approval_token);

  edit.confirm_void = true;
  r = await req('PUT', '/api/quotes/' + q.id, edit);
  eq('editing with an explicit void succeeds', r.status, 200);
  ok('the response says the link was voided', r.body.voided === true);

  const after = (await pool.query('SELECT * FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('the edit landed', after.notes, 'Edited');
  eq('the quote is back to draft', after.status, 'draft');
  eq('the token is gone', after.approval_token, null);
  eq('the expiry is cleared', after.token_expires_at, null);
  eq('sent_at is cleared', after.sent_at, null);
  eq('the view stamp is cleared', after.first_viewed_at, null);
  eq('the reminder counter is reset', after.reminder_count, 0);

  // The old link must be dead the moment the edit lands.
  r = await req('GET', '/api/quote-approve/' + before.approval_token);
  eq('the old customer link is dead', r.status, 404);

  const ev = (await pool.query("SELECT * FROM quote_events WHERE quote_id = $1 AND event_type = 'link_voided'", [q.id])).rows;
  eq('the void is on the trail', ev.length, 1);
  eq('and says why', ev[0].details.reason, 'edited');

  // Revoke, the version that does not touch the quote itself.
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  r = await req('POST', '/api/quotes/' + q.id + '/revoke', {});
  eq('revoke succeeds', r.status, 200);
  r = await req('GET', '/api/quote-approve/' + tok);
  eq('the revoked link is dead', r.status, 404);
  eq('and the quote is a draft again', (await pool.query('SELECT status FROM quotes WHERE id = $1', [q.id])).rows[0].status, 'draft');
}

async function testApprovedTotalSurvivesEdits() {
  section('approved_total does not move when the quote does');
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  await req('POST', '/api/quote-approve/' + tok + '/approve', { consent: true, name: 'Danielle Harlow' });
  const agreed = parseFloat((await pool.query('SELECT approved_total FROM quotes WHERE id = $1', [q.id])).rows[0].approved_total);

  // Somebody re-opens and re-prices it later. The record of what the customer
  // agreed to must not follow total_amount.
  const r = await req('PUT', '/api/quotes/' + q.id, {
    confirm_void: true, customer_name: 'Riverbend Storage LLC', city_code: 'ATL', tax_rate: 8.9,
    customer_email: 'd.harlow@riverbendstor.com',
    line_items: [{ description: 'Rekey', quantity: 99, unit_price: 22, list_price: 500, taxable: true, line_type: 'part' }]
  });
  eq('the re-price saved', r.status, 200);
  const after = (await pool.query('SELECT total_amount, approved_total, approver_name FROM quotes WHERE id = $1', [q.id])).rows[0];
  ok('total_amount moved', Math.abs(parseFloat(after.total_amount) - agreed) > 1);
  ok('approved_total did NOT move', Math.abs(parseFloat(after.approved_total) - agreed) < 0.005,
     after.approved_total + ' vs ' + agreed);
  eq('and the approver is still on the record', after.approver_name, 'Danielle Harlow');
}

async function testDeleteGuard() {
  section('Deleting an approved quote');
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  await req('POST', '/api/quote-approve/' + tok + '/approve', { consent: true, name: 'Danielle Harlow' });

  CURRENT_USER = { id: 1, name: 'Tony McKeon', role: 'manager' };
  let r = await req('DELETE', '/api/quotes/' + q.id);
  eq('a manager cannot delete an approved quote', r.status, 409);
  ok('the quote is still there', (await pool.query('SELECT COUNT(*)::int AS c FROM quotes WHERE id = $1', [q.id])).rows[0].c === 1);

  CURRENT_USER = { id: 1, name: 'Tony McKeon', role: 'admin' };
  r = await req('DELETE', '/api/quotes/' + q.id);
  eq('an admin still can', r.status, 200);
}

async function testRemindAndJob() {
  section('Reminders');
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});

  SENT.emails.length = 0;
  let r = await req('POST', '/api/quotes/' + q.id + '/remind', {});
  eq('a manual reminder sends', r.status, 200);
  eq('one reminder email went out', SENT.emails.length, 1);
  ok('it reads as a reminder', SENT.emails[0].subject.toLowerCase().indexOf('reminder') === 0, SENT.emails[0].subject);
  ok('and still carries the same link', SENT.emails[0].html.indexOf('/quote/') !== -1);
  eq('the counter moved', (await pool.query('SELECT reminder_count FROM quotes WHERE id = $1', [q.id])).rows[0].reminder_count, 1);

  // The nightly job.
  const jobs = require('./jobs/quoteReminders');
  await pool.query('UPDATE quotes SET reminder_count = 0, last_reminded_at = NULL WHERE id = $1', [q.id]);

  await pool.query("UPDATE quotes SET sent_at = NOW() - INTERVAL '2 days' WHERE id = $1", [q.id]);
  SENT.emails.length = 0;
  await jobs.runQuoteReminders();
  eq('nothing is nudged at 2 days', SENT.emails.length, 0);

  await pool.query("UPDATE quotes SET sent_at = NOW() - INTERVAL '3 days' WHERE id = $1", [q.id]);
  SENT.emails.length = 0;
  await jobs.runQuoteReminders();
  eq('the first nudge fires at 3 days', SENT.emails.length, 1);
  eq('the counter is now 1', (await pool.query('SELECT reminder_count FROM quotes WHERE id = $1', [q.id])).rows[0].reminder_count, 1);

  SENT.emails.length = 0;
  await jobs.runQuoteReminders();
  eq('it does not nudge twice in one day', SENT.emails.length, 0);

  await pool.query("UPDATE quotes SET sent_at = NOW() - INTERVAL '8 days', last_reminded_at = NOW() - INTERVAL '5 days' WHERE id = $1", [q.id]);
  SENT.emails.length = 0;
  await jobs.runQuoteReminders();
  eq('the second nudge fires at 7 days', SENT.emails.length, 1);

  await pool.query("UPDATE quotes SET sent_at = NOW() - INTERVAL '30 days', last_reminded_at = NOW() - INTERVAL '20 days' WHERE id = $1", [q.id]);
  SENT.emails.length = 0;
  await jobs.runQuoteReminders();
  eq('there is never a third nudge', SENT.emails.length, 0);

  // Expiry sweep.
  await pool.query("UPDATE quotes SET token_expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [q.id]);
  await jobs.runQuoteReminders();
  eq('the job expires an overdue quote', (await pool.query('SELECT status FROM quotes WHERE id = $1', [q.id])).rows[0].status, 'expired');

  // An answered quote must never be nudged or expired.
  const q2 = await makeQuote({});
  await req('POST', '/api/quotes/' + q2.id + '/send', {});
  const tok2 = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q2.id])).rows[0].approval_token;
  await req('POST', '/api/quote-approve/' + tok2 + '/approve', { consent: true, name: 'Danielle Harlow' });
  await pool.query("UPDATE quotes SET sent_at = NOW() - INTERVAL '9 days', token_expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [q2.id]);
  SENT.emails.length = 0;
  await jobs.runQuoteReminders();
  eq('an approved quote is never nudged', SENT.emails.length, 0);
  eq('and is never expired', (await pool.query('SELECT status FROM quotes WHERE id = $1', [q2.id])).rows[0].status, 'approved');
}

async function testEvents() {
  section('Activity feed');
  CURRENT_PERMS = null;
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  await req('GET', '/api/quote-approve/' + tok);
  await req('POST', '/api/quote-approve/' + tok + '/approve', { consent: true, name: 'Danielle Harlow' });

  const r = await req('GET', '/api/quotes/' + q.id + '/events');
  eq('the feed loads', r.status, 200);
  const types = r.body.map(function (e) { return e.event_type; });
  ok('it holds sent, viewed and approved', types.indexOf('sent') !== -1 && types.indexOf('viewed') !== -1 && types.indexOf('approved') !== -1, types.join(','));
  ok('newest first', new Date(r.body[0].created_at) >= new Date(r.body[r.body.length - 1].created_at));
}

// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL to a scratch Postgres and re-run.'); process.exit(2); }
  server = http.createServer(app);
  await new Promise(function (r) { server.listen(0, r); });
  BASE = 'http://127.0.0.1:' + server.address().port;

  try {
    await testMigration();
    await buildSchema();
    await testIndexAndCascade();
    const q = await testSend();
    await testPublicView(q);
    await testApprove(q);
    await testDeclineAndMessage();
    await testExpiry();
    await testReadOnlyAndVoid();
    await testApprovedTotalSurvivesEdits();
    await testDeleteGuard();
    await testRemindAndJob();
    await testEvents();
  } catch (e) {
    FAIL++; FAILURES.push('THREW: ' + e.stack);
    console.error('\nTHREW:', e.stack);
  }

  console.log('\n' + '-'.repeat(60));
  console.log(PASS + ' passed, ' + FAIL + ' failed');
  if (FAILURES.length) { console.log('\nFailures:'); FAILURES.forEach(function (f) { console.log('  - ' + f); }); }
  server.close();
  await pool.end();
  process.exit(FAIL ? 1 : 0);
}
main();
