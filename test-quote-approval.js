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
  const end = src.indexOf("ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_approval_notes TEXT;", start);
  if (end === -1) throw new Error('db.js quote approval migration is truncated');
  const chunk = src.slice(start - 1, end + 80);
  // Pull the SQL out of the JS string concatenation.
  const stmts = chunk.match(/ALTER TABLE quotes ADD COLUMN IF NOT EXISTS [^;]+;/g) || [];
  if (stmts.length < 21) throw new Error('expected >=19 ALTER statements, found ' + stmts.length);
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
  ['decline_reason', 'text', null],
  ['valid_until', 'date', null],
  ['approved_late_days', 'integer', null],
  ['customer_po_number', 'character varying', null],
  ['customer_approval_notes', 'text', null]
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
  ok('migration extracted from db.js (' + stmts.length + ' ALTERs)', stmts.length >= 21);

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

  // The valid_until backfill, run against the same genuine legacy table. A quote
  // written before this feature promised "30 days from whenever you looked", so
  // created_at + 30 is the honest fixed reading of it.
  await pool.query("UPDATE quotes SET created_at = NOW() - INTERVAL '90 days' WHERE quote_number = 'QT-2025-0001-TM'");
  await pool.query("INSERT INTO quotes (quote_number, requester_id, customer_name, created_at) VALUES ('QT-2025-0002-TM', 1, 'Second Legacy', NOW() - INTERVAL '10 days')");
  await pool.query("UPDATE quotes SET valid_until = NULL");
  const _bf = await pool.query("UPDATE quotes SET valid_until = (created_at + INTERVAL '30 days')::date WHERE valid_until IS NULL");
  eq('the backfill touches every legacy row', _bf.rowCount, 2);
  const _old = (await pool.query("SELECT to_char(valid_until,'YYYY-MM-DD') AS v, to_char((created_at + INTERVAL '30 days')::date,'YYYY-MM-DD') AS want FROM quotes WHERE quote_number = 'QT-2025-0001-TM'")).rows[0];
  eq('a 90-day-old quote gets created_at + 30, i.e. long past', _old.v, _old.want);
  ok('so it correctly reads as lapsed rather than eternally valid', _old.v < new Date().toISOString().slice(0, 10), _old.v);
  const _recent = (await pool.query("SELECT to_char(valid_until,'YYYY-MM-DD') AS v FROM quotes WHERE quote_number = 'QT-2025-0002-TM'")).rows[0];
  ok('a 10-day-old quote is still current', _recent.v >= new Date().toISOString().slice(0, 10), _recent.v);
  const _again = await pool.query("UPDATE quotes SET valid_until = (created_at + INTERVAL '30 days')::date WHERE valid_until IS NULL");
  eq('and re-running it touches nothing', _again.rowCount, 0);

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
  await pool.query("UPDATE quotes SET valid_until = (created_at + INTERVAL '30 days')::date WHERE valid_until IS NULL");
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

// Approving now carries a fingerprint of what the page displayed, so the server
// can refuse an approval whose numbers moved. Real clients read it off the GET;
// the tests do the same rather than faking a value.
async function approve(token, body) {
  const page = await req('GET', '/api/quote-approve/' + token);
  const v = page.body && page.body.version;
  return req('POST', '/api/quote-approve/' + token + '/approve', Object.assign({ seen_version: v }, body || {}));
}

// Walks a whole JSON payload looking for anything that smells like our cost.
function isAnsweredStatus(st) { return st === 'approved' || st === 'declined'; }

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

  let r = await approve(q.approval_token, { name: 'Danielle Harlow' });
  eq('approve without consent is refused', r.status, 400);
  r = await approve(q.approval_token, { consent: true, name: 'D' });
  eq('approve without a real name is refused', r.status, 400);
  r = await approve(q.approval_token, { consent: 'true', name: 'Danielle Harlow' });
  eq('a stringy consent value is not consent', r.status, 400);

  // A browser-supplied total must be ignored: the server approves its own math.
  r = await approve(q.approval_token, { consent: true, name: 'Danielle Harlow', title: 'Property Manager', total: 1, approved_total: 1, signature: 'data:image/png;base64,iVBOR', po_number: 'PO-4500123987', notes: 'Gate code is 4412, ask for Marcus at the dock.' });
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

  r = await approve(q.approval_token, { consent: true, name: 'Someone Else' });
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
  r = await approve(tok, { consent: true, name: 'Danielle Harlow' });
  eq('the customer can still approve after asking a question', r.status, 200);
  row = (await pool.query('SELECT status FROM quotes WHERE id = $1', [q2.id])).rows[0];
  eq('and the quote lands on approved', row.status, 'approved');

  const ev = (await pool.query("SELECT details FROM quote_events WHERE quote_id = $1 AND event_type = 'changes_requested'", [q2.id])).rows[0];
  ok('the message is on the trail', ev.details.message.indexOf('panic bar') !== -1);
  ok('the callback number is on the trail', ev.details.phone === '4045550182');
}

async function testExpiry() {
  section('Past the valid-through date (a label, not a lock)');

  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  await pool.query("UPDATE quotes SET valid_until = ((NOW() AT TIME ZONE 'America/New_York')::date - 12) WHERE id = $1", [q.id]);

  let r = await req('GET', '/api/quote-approve/' + tok);
  eq('a lapsed link still loads the quote in full', r.status, 200);
  ok('and says how far past it is', r.body.days_past_valid === 12, String(r.body.days_past_valid));
  ok('the pricing is still shown', r.body.total > 0 && r.body.line_items.length > 0);
  ok('the date is on the payload', /^\d{4}-\d{2}-\d{2}$/.test(r.body.valid_until || ''), r.body.valid_until);
  ok('and it still leaks no cost', deepFindKeys(r.body, ['unit_price', 'item_number', 'manufacturer']).length === 0);

  eq('the quote is labelled as past its date', (await pool.query('SELECT status FROM quotes WHERE id = $1', [q.id])).rows[0].status, 'expired');

  // The whole point of Tony's call: a late customer can still say yes.
  SENT.emails.length = 0; SENT.push.length = 0;
  r = await approve(tok, { consent: true, name: 'Danielle Harlow' });
  eq('a lapsed quote can STILL be approved', r.status, 200);
  eq('and the response reports how late it was', r.body.late_days, 12);

  const row = (await pool.query('SELECT status, approved_late_days, approved_total FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('the status lands on approved', row.status, 'approved');
  eq('the lateness is recorded', row.approved_late_days, 12);
  ok('and the total is still the server figure', Math.abs(parseFloat(row.approved_total) - q.expected_total) < 0.005);

  await new Promise(function (res) { setTimeout(res, 200); });
  ok('the team email shouts LATE in the subject', SENT.emails.some(function (m) { return m.subject.indexOf('LATE:') === 0; }),
     SENT.emails.map(function (m) { return m.subject; }).join(' | '));
  ok('the email body says how many days past', SENT.emails.some(function (m) { return m.html.indexOf('12 days after') !== -1; }));
  ok('the email tells them to re-check pricing', SENT.emails.some(function (m) { return m.html.indexOf('Check the pricing still works') !== -1; }));
  ok('the push flags it too', SENT.push.some(function (pu) { return pu.payload.title.indexOf('LATE') !== -1; }));

  const ev = (await pool.query("SELECT details FROM quote_events WHERE quote_id = $1 AND event_type = 'approved'", [q.id])).rows[0];
  eq('the trail records the lateness', ev.details.late_days, 12);

  // An approval inside the window must NOT be flagged.
  const q2 = await makeQuote({});
  await req('POST', '/api/quotes/' + q2.id + '/send', {});
  const tok2 = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q2.id])).rows[0].approval_token;
  SENT.emails.length = 0;
  r = await approve(tok2, { consent: true, name: 'Danielle Harlow' });
  eq('an on-time approval reports zero lateness', r.body.late_days, 0);
  eq('and stores NULL, not 0', (await pool.query('SELECT approved_late_days FROM quotes WHERE id = $1', [q2.id])).rows[0].approved_late_days, null);
  await new Promise(function (res) { setTimeout(res, 200); });
  ok('and nothing shouts LATE', !SENT.emails.some(function (m) { return m.subject.indexOf('LATE') !== -1; }));

  // A quote whose date is today is NOT late.
  const q3 = await makeQuote({});
  await req('POST', '/api/quotes/' + q3.id + '/send', {});
  const tok3 = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q3.id])).rows[0].approval_token;
  await pool.query("UPDATE quotes SET valid_until = (NOW() AT TIME ZONE 'America/New_York')::date WHERE id = $1", [q3.id]);
  r = await req('GET', '/api/quote-approve/' + tok3);
  eq('the last day of validity is not past', r.body.days_past_valid, 0);
  r = await approve(tok3, { consent: true, name: 'D H' });
  eq('and approving on the last day is not late', r.body.late_days, 0);
}

async function testStaleSend() {
  section('Sending a quote that has already lapsed');
  const q = await makeQuote({});
  await pool.query("UPDATE quotes SET valid_until = ((NOW() AT TIME ZONE 'America/New_York')::date - 5) WHERE id = $1", [q.id]);

  let r = await req('POST', '/api/quotes/' + q.id + '/send', {});
  eq('sending a lapsed quote is stopped', r.status, 409);
  eq('with the structured reason the UI needs', r.body.error, 'past_valid_until');
  eq('and says how far past', r.body.days_past, 5);
  ok('the message names the date', (r.body.message || '').indexOf(r.body.valid_until) !== -1, r.body.message);
  eq('nothing was sent', (await pool.query('SELECT status FROM quotes WHERE id = $1', [q.id])).rows[0].status, 'draft');

  r = await req('POST', '/api/quotes/' + q.id + '/send', { confirm_stale: true });
  eq('confirming sends it anyway', r.status, 200);
  const row = (await pool.query('SELECT status, approval_token FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('the quote is out', row.status, 'sent');
  const ev = (await pool.query("SELECT details FROM quote_events WHERE quote_id = $1 AND event_type = 'sent'", [q.id])).rows[0];
  eq('and the trail records that it went out stale', ev.details.sent_stale_days, 5);

  // The customer can act on it immediately - the link was never dead.
  r = await req('GET', '/api/quote-approve/' + row.approval_token);
  eq('the customer can open it right away', r.status, 200);
  ok('and is told it has lapsed', r.body.days_past_valid > 0);

  // Sending with a NEW date fixes the quote itself, no confirm needed.
  const q2 = await makeQuote({});
  await pool.query("UPDATE quotes SET valid_until = ((NOW() AT TIME ZONE 'America/New_York')::date - 5) WHERE id = $1", [q2.id]);
  const future = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  r = await req('POST', '/api/quotes/' + q2.id + '/send', { valid_until: future });
  eq('sending with a fresh date needs no confirm', r.status, 200);
  eq('and the response echoes it', r.body.valid_until, future);
  eq('the QUOTE itself now carries that date', (await pool.query("SELECT to_char(valid_until,'YYYY-MM-DD') AS v FROM quotes WHERE id = $1", [q2.id])).rows[0].v, future);
}

async function testValidUntil() {
  section('The valid-through date is one value everywhere');

  // A new quote gets a date without anyone asking for one.
  let r = await req('POST', '/api/quotes', {
    customer_name: 'Default Date Co', city_code: 'ATL', tax_rate: 0,
    line_items: [{ description: 'Rekey', quantity: 1, unit_price: 10, list_price: 40, taxable: false, line_type: 'part' }]
  });
  ok('a quote can be created without a date', r.status === 200 || r.status === 201, 'status ' + r.status);
  let vu = (await pool.query("SELECT to_char(valid_until,'YYYY-MM-DD') AS v FROM quotes WHERE id = $1", [r.body.id])).rows[0].v;
  const _d30 = new Date(Date.now() + 30 * 86400000);
  const expect30 = _d30.getFullYear() + '-' + String(_d30.getMonth() + 1).padStart(2, '0') + '-' + String(_d30.getDate()).padStart(2, '0');
  eq('and defaults to 30 days out', vu, expect30);

  // An explicit date is honoured.
  const chosen = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  r = await req('POST', '/api/quotes', {
    customer_name: 'Chosen Date Co', city_code: 'ATL', tax_rate: 0, valid_until: chosen,
    line_items: [{ description: 'Rekey', quantity: 1, unit_price: 10, list_price: 40, taxable: false, line_type: 'part' }]
  });
  const id2 = r.body.id;
  eq('an explicit date is stored', (await pool.query("SELECT to_char(valid_until,'YYYY-MM-DD') AS v FROM quotes WHERE id = $1", [id2])).rows[0].v, chosen);

  // Garbage is refused rather than guessed at - it becomes a promise to a customer.
  r = await req('POST', '/api/quotes', {
    customer_name: 'Junk Date Co', city_code: 'ATL', tax_rate: 0, valid_until: 'next tuesday',
    line_items: [{ description: 'Rekey', quantity: 1, unit_price: 10, list_price: 40, taxable: false, line_type: 'part' }]
  });
  eq('an unparseable date falls back to the default rather than being guessed',
     (await pool.query("SELECT to_char(valid_until,'YYYY-MM-DD') AS v FROM quotes WHERE id = $1", [r.body.id])).rows[0].v, expect30);

  // An edit that omits the field must not blank the promise.
  await req('PUT', '/api/quotes/' + id2, {
    customer_name: 'Chosen Date Co', city_code: 'ATL', tax_rate: 0,
    line_items: [{ description: 'Rekey', quantity: 2, unit_price: 10, list_price: 40, taxable: false, line_type: 'part' }]
  });
  eq('an edit that omits the date leaves it alone', (await pool.query("SELECT to_char(valid_until,'YYYY-MM-DD') AS v FROM quotes WHERE id = $1", [id2])).rows[0].v, chosen);

  // --- the same date reaches the customer everywhere ---
  const q = await makeQuote({});
  const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await pool.query('UPDATE quotes SET valid_until = $1::date WHERE id = $2', [soon, q.id]);
  SENT.emails.length = 0; SENT.sms.length = 0;
  await pool.query("INSERT INTO settings (key, value) VALUES ('quote_sms_template', $1) ON CONFLICT (key) DO UPDATE SET value = $1", ['Good through {expires}. {link}']);
  await req('POST', '/api/quotes/' + q.id + '/send', { sms_to: '4045550182' });

  const pretty = new Date(soon + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  ok('the email shows the quote date as Valid through', SENT.emails[0].html.indexOf(pretty) !== -1, pretty + ' not in email');
  ok('the SMS {expires} token shows the same date', SENT.sms[0].body.indexOf(pretty) !== -1, SENT.sms[0].body);
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  const page = (await req('GET', '/api/quote-approve/' + tok)).body;
  eq('and the approval page carries the same date', page.valid_until, soon);
  eq('with nothing past yet', page.days_past_valid, 0);
  await pool.query("DELETE FROM settings WHERE key = 'quote_sms_template'");

  // --- changing the date must NOT void the link ---
  const later = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  r = await req('POST', '/api/quotes/' + q.id + '/valid-until', { valid_until: later });
  eq('the date can be changed on a sent quote', r.status, 200);
  eq('and it reports no void', r.body.voided, false);
  const after = (await pool.query("SELECT status, approval_token, to_char(valid_until,'YYYY-MM-DD') AS v FROM quotes WHERE id = $1", [q.id])).rows[0];
  eq('the date moved', after.v, later);
  eq('the customer link is untouched', after.approval_token, tok);
  ok('and the quote is still out', after.status === 'sent' || after.status === 'viewed');
  eq('the old link still works', (await req('GET', '/api/quote-approve/' + tok)).status, 200);

  const cev = (await pool.query("SELECT details FROM quote_events WHERE quote_id = $1 AND event_type = 'valid_until_changed'", [q.id])).rows[0];
  eq('the change is on the trail', cev.details.to, later);
  eq('and it knows the date was extended', cev.details.extended, true);

  r = await req('POST', '/api/quotes/' + q.id + '/valid-until', { valid_until: 'soon' });
  eq('a junk date is refused outright', r.status, 400);

  // Re-dating a lapsed quote puts it back in play.
  const q3 = await makeQuote({});
  await req('POST', '/api/quotes/' + q3.id + '/send', {});
  await pool.query("UPDATE quotes SET valid_until = ((NOW() AT TIME ZONE 'America/New_York')::date - 3), status = 'expired' WHERE id = $1", [q3.id]);
  await req('POST', '/api/quotes/' + q3.id + '/valid-until', { valid_until: later });
  eq('extending a lapsed quote makes it waiting again',
     (await pool.query('SELECT status FROM quotes WHERE id = $1', [q3.id])).rows[0].status, 'sent');
}

async function testEditWhileOut() {
  section('Editing a sent quote (no longer voids the link)');
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const before = (await pool.query('SELECT * FROM quotes WHERE id = $1', [q.id])).rows[0];

  // What the customer's open page is showing right now.
  const seen = (await req('GET', '/api/quote-approve/' + before.approval_token)).body;
  ok('the page hands out a version fingerprint', /^[a-f0-9]{16}$/.test(seen.version || ''), seen.version);

  const edit = {
    customer_name: 'Riverbend Storage LLC', city_code: 'ATL', notes: 'Edited', important_info: null, tax_rate: 8.9,
    customer_email: 'd.harlow@riverbendstor.com', customer_phone: '4045550182',
    line_items: [{ description: 'Rekey', quantity: 6, unit_price: 22, list_price: 95, taxable: true, line_type: 'part' }]
  };
  let r = await req('PUT', '/api/quotes/' + q.id, edit);
  eq('editing a sent quote just works', r.status, 200);
  ok('and reports no void', r.body.voided === false);

  const after = (await pool.query('SELECT * FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('the edit landed', after.notes, 'Edited');
  ok('the quote is STILL out to the customer', after.status === 'sent' || after.status === 'viewed', after.status);
  eq('the customer link is untouched', after.approval_token, before.approval_token);
  ok('sent_at survives', !!after.sent_at);
  eq('the old link still opens', (await req('GET', '/api/quote-approve/' + before.approval_token)).status, 200);

  const ev = (await pool.query("SELECT * FROM quote_events WHERE quote_id = $1 AND event_type = 'edited_while_out'", [q.id])).rows;
  eq('the trail records that it changed under them', ev.length, 1);

  // THE safety property. The customer is still holding the old page.
  const fresh = (await req('GET', '/api/quote-approve/' + before.approval_token)).body;
  ok('the fingerprint moved with the edit', fresh.version !== seen.version, seen.version + ' -> ' + fresh.version);
  r = await req('POST', '/api/quote-approve/' + before.approval_token + '/approve',
    { seen_version: seen.version, consent: true, name: 'Danielle Harlow' });
  eq('approving the version they saw is refused', r.status, 409);
  eq('with the reason the page needs', r.body.error, 'quote_changed');
  eq('and the current fingerprint to reload with', r.body.version, fresh.version);
  ok('nothing was recorded', !isAnsweredStatus((await pool.query('SELECT status FROM quotes WHERE id = $1', [q.id])).rows[0].status));

  // An approval with no fingerprint at all is refused too - that is a client that
  // cannot have shown them a total.
  r = await req('POST', '/api/quote-approve/' + before.approval_token + '/approve', { consent: true, name: 'Danielle Harlow' });
  eq('an approval with no fingerprint is refused', r.status, 400);

  // Reload, then approve: they get the NEW total, having seen it.
  r = await approve(before.approval_token, { consent: true, name: 'Danielle Harlow' });
  eq('approving the reloaded version works', r.status, 200);
  const newTotal = 6 * 95 * 1.089;
  ok('and binds them to the edited total, not the old one',
     Math.abs(r.body.approved_total - newTotal) < 0.02, r.body.approved_total + ' vs ' + newTotal);

  // Revoke is still the manual kill switch.
  const q2 = await makeQuote({});
  await req('POST', '/api/quotes/' + q2.id + '/send', {});
  const tok2 = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q2.id])).rows[0].approval_token;
  eq('revoke succeeds', (await req('POST', '/api/quotes/' + q2.id + '/revoke', {})).status, 200);
  eq('and the link really is dead', (await req('GET', '/api/quote-approve/' + tok2)).status, 404);
  eq('with the quote back in draft', (await pool.query('SELECT status FROM quotes WHERE id = $1', [q2.id])).rows[0].status, 'draft');
}

async function testCustomerPoAndNotes() {
  section('The PO number and note a customer adds when approving');
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;

  SENT.emails.length = 0;
  const r = await approve(tok, {
    consent: true, name: 'Danielle Harlow', title: 'Property Manager',
    po_number: 'PO-4500123987', notes: 'Gate code is 4412, ask for Marcus at the dock.'
  });
  eq('the approval takes them', r.status, 200);
  eq('and echoes the PO back', r.body.po_number, 'PO-4500123987');

  const row = (await pool.query('SELECT customer_po_number, customer_approval_notes FROM quotes WHERE id = $1', [q.id])).rows[0];
  eq('the PO number is stored', row.customer_po_number, 'PO-4500123987');
  eq('the note is stored', row.customer_approval_notes, 'Gate code is 4412, ask for Marcus at the dock.');

  const ev = (await pool.query("SELECT details FROM quote_events WHERE quote_id = $1 AND event_type = 'approved'", [q.id])).rows[0];
  eq('the PO is on the trail', ev.details.po_number, 'PO-4500123987');
  ok('and so is the note', (ev.details.notes || '').indexOf('Gate code') !== -1);

  await new Promise(function (res) { setTimeout(res, 200); });
  ok('the team email shows the PO number', SENT.emails.some(function (m) { return m.html.indexOf('PO-4500123987') !== -1; }));
  ok('and quotes their note back', SENT.emails.some(function (m) { return m.html.indexOf('Gate code is 4412') !== -1; }));

  // The receipt the customer sees on reload.
  const page = (await req('GET', '/api/quote-approve/' + tok)).body;
  eq('the receipt carries the PO', page.customer_po_number, 'PO-4500123987');
  ok('and still leaks no cost', deepFindKeys(page, ['unit_price', 'approver_ip']).length === 0);

  // Both are optional.
  const q2 = await makeQuote({});
  await req('POST', '/api/quotes/' + q2.id + '/send', {});
  const tok2 = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q2.id])).rows[0].approval_token;
  eq('approving with neither still works', (await approve(tok2, { consent: true, name: 'D H' })).status, 200);
  const row2 = (await pool.query('SELECT customer_po_number, customer_approval_notes FROM quotes WHERE id = $1', [q2.id])).rows[0];
  eq('and stores NULL rather than an empty string', row2.customer_po_number, null);
  eq('same for the note', row2.customer_approval_notes, null);

  // A hostile PO number must not survive as markup in the notification.
  const q3 = await makeQuote({});
  await req('POST', '/api/quotes/' + q3.id + '/send', {});
  const tok3 = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q3.id])).rows[0].approval_token;
  SENT.emails.length = 0;
  await approve(tok3, { consent: true, name: 'D H', po_number: '<script>x</script>', notes: '<img src=x onerror=y>' });
  await new Promise(function (res) { setTimeout(res, 200); });
  ok('a hostile PO is escaped in the email', !SENT.emails.some(function (m) { return m.html.indexOf('<script>x</script>') !== -1; }));
  ok('and a hostile note is stripped', !SENT.emails.some(function (m) { return m.html.indexOf('<img src=x') !== -1; }));
}

async function testApprovedTotalSurvivesEdits() {
  section('approved_total does not move when the quote does');
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  await approve(tok, { consent: true, name: 'Danielle Harlow' });
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
  await approve(tok, { consent: true, name: 'Danielle Harlow' });

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

  // Past-date sweep. This is a LABEL now, not a lock - the link stays live.
  await pool.query("UPDATE quotes SET status = 'sent', valid_until = ((NOW() AT TIME ZONE 'America/New_York')::date - 1) WHERE id = $1", [q.id]);
  await jobs.runQuoteReminders();
  eq('the job labels a quote past its date', (await pool.query('SELECT status FROM quotes WHERE id = $1', [q.id])).rows[0].status, 'expired');
  const _stillTok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  eq('and the customer link is NOT killed', (await req('GET', '/api/quote-approve/' + _stillTok)).status, 200);

  // An answered quote must never be nudged or expired.
  const q2 = await makeQuote({});
  await req('POST', '/api/quotes/' + q2.id + '/send', {});
  const tok2 = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q2.id])).rows[0].approval_token;
  await approve(tok2, { consent: true, name: 'Danielle Harlow' });
  await pool.query("UPDATE quotes SET sent_at = NOW() - INTERVAL '9 days', valid_until = ((NOW() AT TIME ZONE 'America/New_York')::date - 1) WHERE id = $1", [q2.id]);
  SENT.emails.length = 0;
  await jobs.runQuoteReminders();
  eq('an approved quote is never nudged', SENT.emails.length, 0);
  eq('and is never relabelled', (await pool.query('SELECT status FROM quotes WHERE id = $1', [q2.id])).rows[0].status, 'approved');
}

async function testEvents() {
  section('Activity feed');
  CURRENT_PERMS = null;
  const q = await makeQuote({});
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  const tok = (await pool.query('SELECT approval_token FROM quotes WHERE id = $1', [q.id])).rows[0].approval_token;
  await req('GET', '/api/quote-approve/' + tok);
  await approve(tok, { consent: true, name: 'Danielle Harlow' });

  const r = await req('GET', '/api/quotes/' + q.id + '/events');
  eq('the feed loads', r.status, 200);
  const types = r.body.map(function (e) { return e.event_type; });
  ok('it holds sent, viewed and approved', types.indexOf('sent') !== -1 && types.indexOf('viewed') !== -1 && types.indexOf('approved') !== -1, types.join(','));
  ok('newest first', new Date(r.body[0].created_at) >= new Date(r.body[r.body.length - 1].created_at));
}

async function testBrandAndSms() {
  section('Branding and the customer text message');
  CURRENT_PERMS = null;

  // --- the brand -----------------------------------------------------------
  await pool.query("DELETE FROM settings WHERE key = 'company_name'");
  let q = await makeQuote({});
  SENT.emails.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  ok('with no company_name it falls back to Lock and Roll LLC', SENT.emails[0].html.indexOf('Lock and Roll LLC') !== -1);

  await pool.query("INSERT INTO settings (key, value) VALUES ('company_name', $1) ON CONFLICT (key) DO UPDATE SET value = $1", ['Pop-A-Lock of Atlanta']);
  q = await makeQuote({});
  SENT.emails.length = 0; SENT.sms.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', { sms_to: '4045550182' });
  const mail = SENT.emails[0];
  ok('the email header uses the Settings brand', mail.html.indexOf('>Pop-A-Lock of Atlanta</td>') !== -1);
  ok('the subject uses the brand', mail.subject.indexOf('Your quote from Pop-A-Lock of Atlanta') === 0, mail.subject);
  ok('the email body never says the old name', mail.html.indexOf('Lock and Roll') === -1);
  ok('the SMS uses the brand', SENT.sms[0].body.indexOf('Pop-A-Lock of Atlanta') === 0, SENT.sms[0].body);

  // --- the sender ----------------------------------------------------------
  delete process.env.QUOTE_FROM_EMAIL;
  process.env.FROM_EMAIL = 'Nova <noreply@novaops.dev>';
  q = await makeQuote({});
  SENT.emails.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  eq('the sender keeps the verified address but takes the new display name',
     SENT.emails[0].opts.from, 'Pop-A-Lock of Atlanta <noreply@novaops.dev>');

  // An unset FROM_EMAIL used to hand control back to sendEmail's own hardcoded
  // default and silently throw the brand away.
  const _savedFrom = process.env.FROM_EMAIL;
  delete process.env.FROM_EMAIL;
  q = await makeQuote({});
  SENT.emails.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  eq('with no FROM_EMAIL at all the brand still wins the display name',
     SENT.emails[0].opts.from, 'Pop-A-Lock of Atlanta <onboarding@resend.dev>');
  process.env.FROM_EMAIL = _savedFrom;

  // A bare address with no display name is just as valid a FROM_EMAIL.
  process.env.FROM_EMAIL = 'noreply@novaops.dev';
  q = await makeQuote({});
  SENT.emails.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  eq('a bare FROM_EMAIL address still gets the brand in front of it',
     SENT.emails[0].opts.from, 'Pop-A-Lock of Atlanta <noreply@novaops.dev>');

  // Whatever display name FROM_EMAIL carries is DISCARDED for customer mail.
  process.env.FROM_EMAIL = 'Nova <noreply@novaops.dev>';
  q = await makeQuote({});
  SENT.emails.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  ok('the FROM_EMAIL display name never reaches a customer', SENT.emails[0].opts.from.indexOf('Nova') === -1, SENT.emails[0].opts.from);

  process.env.QUOTE_FROM_EMAIL = 'Pop-A-Lock <quotes@popalockar.com>';
  q = await makeQuote({});
  SENT.emails.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', {});
  eq('an explicit QUOTE_FROM_EMAIL wins outright', SENT.emails[0].opts.from, 'Pop-A-Lock <quotes@popalockar.com>');
  delete process.env.QUOTE_FROM_EMAIL;

  // --- the SMS template ----------------------------------------------------
  await pool.query("DELETE FROM settings WHERE key = 'quote_sms_template'");
  q = await makeQuote({});
  SENT.sms.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', { sms_to: '4045550182' });
  let body = SENT.sms[0].body;
  ok('the default template names the quote', body.indexOf(q.quote_number) !== -1, body);
  ok('the default template shows the total', body.indexOf('$' + q.expected_total.toFixed(2)) !== -1, body);
  ok('the default template carries the link', /\/quote\/[a-f0-9]{64}/.test(body), body);
  ok('and never leaks a cost', body.indexOf('22.00') === -1);

  await pool.query("INSERT INTO settings (key, value) VALUES ('quote_sms_template', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    ["Hi {customer}, it's {prepared_by} at {company}. Your estimate {quote_number} ({total}) is ready - approve it here: {link} Good through {expires}."]);
  q = await makeQuote({});
  SENT.sms.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', { sms_to: '4045550182' });
  body = SENT.sms[0].body;
  ok('a custom template is used', body.indexOf('Hi Riverbend Storage LLC') === 0, body);
  ok('{prepared_by} resolves', body.indexOf("it's Tony McKeon at") !== -1, body);
  ok('{company} resolves', body.indexOf('Pop-A-Lock of Atlanta') !== -1);
  ok('{quote_number} resolves', body.indexOf(q.quote_number) !== -1);
  ok('{expires} resolves to a date', /Good through [A-Z][a-z]{2} \d/.test(body), body);
  ok('no token braces survive', body.indexOf('{') === -1, body);

  // A template that forgets the link would send a dead end.
  await pool.query("UPDATE settings SET value = $1 WHERE key = 'quote_sms_template'", ['Your quote {quote_number} is ready.']);
  q = await makeQuote({});
  SENT.sms.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', { sms_to: '4045550182' });
  body = SENT.sms[0].body;
  ok('a template with no {link} still gets the link appended', /\/quote\/[a-f0-9]{64}$/.test(body), body);

  // An unknown token is left visible rather than silently blanked, so a typo
  // is obvious in the preview instead of shipping an odd-looking text.
  await pool.query("UPDATE settings SET value = $1 WHERE key = 'quote_sms_template'", ['Quote {quote_nunber} ready {link}']);
  q = await makeQuote({});
  SENT.sms.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', { sms_to: '4045550182' });
  ok('a misspelled token is left visible', SENT.sms[0].body.indexOf('{quote_nunber}') !== -1, SENT.sms[0].body);

  // Over-long prose is trimmed; the link never is.
  await pool.query("UPDATE settings SET value = $1 WHERE key = 'quote_sms_template'", ['x'.repeat(400) + ' {link}']);
  q = await makeQuote({});
  SENT.sms.length = 0;
  await req('POST', '/api/quotes/' + q.id + '/send', { sms_to: '4045550182' });
  body = SENT.sms[0].body;
  ok('an over-long template is trimmed', body.length <= 320, 'length ' + body.length);
  ok('but the link survives the trim', /\/quote\/[a-f0-9]{64}$/.test(body), body);

  // --- the preview endpoint ------------------------------------------------
  await pool.query("DELETE FROM settings WHERE key = 'quote_sms_template'");
  let r = await req('POST', '/api/quotes/sms-preview', { template: 'Hi {customer}, {quote_number} for {total}: {link}' });
  eq('the preview renders', r.status, 200);
  ok('it resolves the sample customer', r.body.body.indexOf('Hi Riverbend Storage LLC') === 0, r.body.body);
  ok('it reports a character count', r.body.length === r.body.body.length);
  ok('it reports segments', r.body.segments >= 1);
  ok('it hands back the token list', (r.body.tokens || []).indexOf('prepared_by') !== -1);
  ok('and the default wording', (r.body.default_template || '').indexOf('{link}') !== -1);

  r = await req('POST', '/api/quotes/sms-preview', { template: '' });
  ok('an empty template previews the default', r.body.body.indexOf('Pop-A-Lock of Atlanta') === 0, r.body.body);

  r = await req('POST', '/api/quotes/sms-preview', { template: 'Long ' + 'y'.repeat(400) + ' {link}' });
  ok('the preview trims exactly like the sender does', r.body.length <= 320, 'length ' + r.body.length);

  CURRENT_PERMS = ['view_quotes'];
  r = await req('POST', '/api/quotes/sms-preview', { template: 'x {link}' });
  eq('the preview needs manage_settings', r.status, 403);
  CURRENT_PERMS = null;
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
    await testStaleSend();
    await testValidUntil();
    await testEditWhileOut();
    await testCustomerPoAndNotes();
    await testApprovedTotalSurvivesEdits();
    await testDeleteGuard();
    await testRemindAndJob();
    await testEvents();
    await testBrandAndSms();
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
