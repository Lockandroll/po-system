// Licensing & compliance + the account/licence ledger: schema, permission and
// logic tests.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-licensing-ledger.js
//
// It runs the real initDB() twice (so a migration that is not idempotent fails
// here rather than on the next Railway boot), then mounts the REAL routers
// behind the REAL requireAuth and drives them over HTTP with real JWTs. The
// permission assertions are the point of this file: a register is only ever as
// private as the thing it hangs off, and the only way to know that holds is to
// ask the running route rather than to read the code and hope.
//
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-licensing';

const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');
const { initDB, pool } = require('./db');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
     'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

// Columns the routes read or write by name. If one of these is missing the
// route 500s in production, so the test asks the database directly.
const REQUIRED_COLUMNS = {
  licenses: ['name', 'kind', 'authority', 'license_number', 'city_code', 'jurisdiction',
    'website', 'username', 'password', 'security_questions', 'issued_on', 'expires_on',
    'renewal_interval', 'renewal_fee', 'responsible_user_id', 'restricted_to', 'notes',
    'active', 'created_by', 'created_by_name', 'created_at', 'updated_at'],
  account_ledger_entries: ['account_id', 'license_id', 'entry_date', 'kind', 'amount',
    'reason', 'method', 'reference', 'period_label', 'notes', 'created_by',
    'created_by_name', 'created_at', 'updated_at']
};

async function columnsOf(table) {
  const r = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
  return r.rows.map(function (x) { return x.column_name; });
}

// ---- a tiny HTTP harness around the real routers --------------------------
var base = '';
function tokenFor(user) {
  // The real login token carries the name, and middleware/auth.js reads
  // req.user.name straight off the payload, so the test token must too.
  return jwt.sign({ id: user.id, name: user.name, email: user.email || (user.name + '@licensetest.local'), role: user.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
async function call(user, method, path, body) {
  const res = await fetch(base + path, {
    method: method,
    headers: Object.assign(
      { Authorization: 'Bearer ' + tokenFor(user) },
      body === undefined ? {} : { 'Content-Type': 'application/json' }
    ),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

async function mkUser(name, email, role) {
  const r = await pool.query(
    "INSERT INTO users (email, name, password_hash, role, active, session_epoch) VALUES ($1,$2,'x',$3,true,0) RETURNING id, role",
    [email, name, role]
  );
  return { id: r.rows[0].id, role: r.rows[0].role, name: name };
}

function plus(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function main() {
  console.log('Licensing + ledger tests');
  console.log('------------------------');

  await initDB();
  await initDB();          // a migration that is not idempotent dies here
  ok('initDB runs twice', true);

  // ---- schema ------------------------------------------------------------
  for (var table in REQUIRED_COLUMNS) {
    var have = await columnsOf(table);
    REQUIRED_COLUMNS[table].forEach(function (c) {
      ok(table + '.' + c + ' exists', have.indexOf(c) !== -1);
    });
  }

  var ck = await pool.query("SELECT 1 FROM pg_constraint WHERE conname = 'account_ledger_one_subject'");
  ok('the one-subject CHECK constraint exists', ck.rows.length === 1);

  // A ledger row that belongs to nothing is invisible forever, so the database
  // refuses it outright rather than trusting every route to remember.
  var orphanRejected = false;
  try { await pool.query("INSERT INTO account_ledger_entries (entry_date) VALUES ('2026-01-01')"); }
  catch (e) { orphanRejected = true; }
  ok('a ledger row with no subject is rejected', orphanRejected);

  // ---- fixtures ----------------------------------------------------------
  await pool.query('DELETE FROM account_ledger_entries');
  await pool.query('DELETE FROM licenses');
  await pool.query("DELETE FROM vendors WHERE name LIKE 'TEST %'");
  await pool.query("DELETE FROM users WHERE email LIKE '%@licensetest.local'");
  await pool.query("DELETE FROM audit_logs WHERE entity_type IN ('license','ledger')");

  var admin = await mkUser('Admin', 'admin@licensetest.local', 'admin');
  var boss = await mkUser('Boss', 'boss@licensetest.local', 'locksmith_coordinator');   // manage both
  var reader = await mkUser('Reader', 'reader@licensetest.local', 'manager');           // view both
  var acctOnly = await mkUser('AcctOnly', 'acct@licensetest.local', 'roadside_technician'); // accounts read only
  var nobody = await mkUser('Nobody', 'nobody@licensetest.local', 'dispatcher');        // nothing

  // One explicit matrix, written once. utils/permissions.js caches it for 15s,
  // so a test that rewrote the matrix mid-run would be asserting against the
  // previous one; every role below therefore keeps one fixed profile.
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('role_permissions', $1) " +
    'ON CONFLICT (key) DO UPDATE SET value = $1',
    [JSON.stringify({
      locksmith_coordinator: ['manage_licenses', 'view_licenses', 'manage_vendors', 'view_vendors'],
      manager: ['view_licenses', 'view_vendors'],
      roadside_technician: ['view_vendors'],
      dispatcher: []
    })]
  );

  var vend = await pool.query("INSERT INTO vendors (name) VALUES ('TEST Amazon Business') RETURNING id");
  var accountId = vend.rows[0].id;
  var vendR = await pool.query(
    "INSERT INTO vendors (name, restricted_to) VALUES ('TEST Restricted Portal', $1) RETURNING id",
    [[boss.id]]
  );
  var restrictedAccountId = vendR.rows[0].id;

  // ---- boot the real routers --------------------------------------------
  const app = express();
  app.use(express.json());
  app.use('/api/licenses', require('./routes/licenses'));
  app.use('/api/ledger', require('./routes/ledger'));
  app.use(function (err, req, res, _next) { console.error(err); res.status(500).json({ error: 'Internal server error' }); });
  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  base = 'http://127.0.0.1:' + server.address().port;

  // ---- licences: create, gate, read --------------------------------------
  var noAuth = await fetch(base + '/api/licenses');
  eq('an unauthenticated caller is 401', noAuth.status, 401);

  var denied = await call(nobody, 'GET', '/api/licenses');
  eq('a role with neither permission is 403', denied.status, 403);

  var created = await call(boss, 'POST', '/api/licenses', {
    name: 'Birmingham Occupational Tax',
    kind: 'occupational_tax',
    authority: 'City of Birmingham Revenue Department',
    license_number: 'BHM-99123',
    jurisdiction: 'Birmingham, AL',
    website: 'https://birminghamal.gov',
    username: 'lockandroll',
    password: 'hunter2',
    security_questions: [{ q: 'First street', a: 'Elm' }],
    issued_on: '2026-01-02',
    expires_on: plus(30),
    renewal_interval: 'annual',
    renewal_fee: '$340.00'
  });
  eq('a manager can create a licence', created.status, 201);
  var licId = created.body && created.body.id;
  ok('the new licence has an id', !!licId);
  eq('the renewal fee parses out of a typed dollar string', parseFloat(created.body.renewal_fee), 340);

  var readerOnly = await call(reader, 'GET', '/api/licenses');
  eq('a view-only caller can list licences', readerOnly.status, 200);
  var rl = readerOnly.body.licenses[0];
  eq('a view-only caller gets no username', rl.username, null);
  eq('a view-only caller gets no password', rl.password, null);
  eq('a view-only caller gets no security answers', rl.security_questions, []);
  eq('a view-only caller is told they cannot manage', readerOnly.body.can_manage, false);
  eq('the licence number is not a credential and stays visible', rl.license_number, 'BHM-99123');

  var managerView = await call(boss, 'GET', '/api/licenses');
  eq('a manager gets the portal username', managerView.body.licenses[0].username, 'lockandroll');
  eq('a manager gets the portal password', managerView.body.licenses[0].password, 'hunter2');
  eq('a manager gets the security answers', managerView.body.licenses[0].security_questions.length, 1);

  // ---- status is computed server-side, once ------------------------------
  eq('a licence 30 days out reads as renew-soon', rl.status.key, 'expiring');
  eq('renew-soon is amber', rl.status.tone, 'amber');

  await call(boss, 'PUT', '/api/licenses/' + licId, {
    name: 'Birmingham Occupational Tax', kind: 'occupational_tax', expires_on: plus(-5)
  });
  var afterExpire = await call(boss, 'GET', '/api/licenses');
  eq('a past date reads as expired', afterExpire.body.licenses[0].status.key, 'expired');
  eq('expired is red', afterExpire.body.licenses[0].status.tone, 'red');

  await call(boss, 'PUT', '/api/licenses/' + licId, {
    name: 'Birmingham Occupational Tax', kind: 'occupational_tax', expires_on: plus(200)
  });
  var afterFuture = await call(boss, 'GET', '/api/licenses');
  eq('a far-off date reads as current', afterFuture.body.licenses[0].status.key, 'current');

  await call(boss, 'PUT', '/api/licenses/' + licId, {
    name: 'Birmingham Occupational Tax', kind: 'occupational_tax', expires_on: null
  });
  var afterNoDate = await call(boss, 'GET', '/api/licenses');
  eq('no renewal date reads as no-date, never as current', afterNoDate.body.licenses[0].status.key, 'unknown');

  // Put a real date back for the rest of the run.
  await call(boss, 'PUT', '/api/licenses/' + licId, {
    name: 'Birmingham Occupational Tax', kind: 'occupational_tax',
    authority: 'City of Birmingham Revenue Department', license_number: 'BHM-99123',
    expires_on: plus(200), renewal_interval: 'annual', renewal_fee: 340
  });

  // A PUT that never mentions security questions must not wipe them. Same
  // guard, and same reason, as routes/vendors.js.
  var stillThere = await call(boss, 'GET', '/api/licenses');
  eq('a save that omits security questions leaves them alone',
     stillThere.body.licenses[0].security_questions.length, 1);
  eq('a save that omits the password leaves it alone',
     stillThere.body.licenses[0].password, 'hunter2');

  var cleared = await call(boss, 'PUT', '/api/licenses/' + licId, {
    name: 'Birmingham Occupational Tax', expires_on: plus(200), security_questions: []
  });
  eq('an explicit empty list does clear the security questions', cleared.status, 200);
  var afterClear = await call(boss, 'GET', '/api/licenses');
  eq('the answers really are gone', afterClear.body.licenses[0].security_questions, []);

  // ---- licence visibility allowlist --------------------------------------
  await call(boss, 'PUT', '/api/licenses/' + licId, {
    name: 'Birmingham Occupational Tax', expires_on: plus(200), restricted_to: [boss.id]
  });
  var readerRestricted = await call(reader, 'GET', '/api/licenses');
  eq('a restricted licence is absent for a non-listed reader', readerRestricted.body.licenses.length, 0);
  var adminRestricted = await call(admin, 'GET', '/api/licenses');
  eq('an admin still sees a restricted licence', adminRestricted.body.licenses.length, 1);
  await call(boss, 'PUT', '/api/licenses/' + licId, {
    name: 'Birmingham Occupational Tax', expires_on: plus(200), restricted_to: null
  });

  // ---- the ledger: the whole point of the exercise -----------------------
  var entry = await call(boss, 'POST', '/api/ledger/license/' + licId, {
    entry_date: '2026-03-12', kind: 'payment', amount: '$1,234.56',
    reason: '2026 occupational tax', method: 'ach', reference: '88213', period_label: '2026'
  });
  eq('a payment can be written to a licence', entry.status, 201);
  eq('a typed dollar string is stored as a number', entry.body.amount, 1234.56);
  eq('the date comes back exactly as entered, with no timezone drift', entry.body.entry_date, '2026-03-12');
  eq('the writer is recorded', entry.body.created_by_name, 'Boss');

  await call(boss, 'POST', '/api/ledger/license/' + licId, {
    entry_date: '2026-04-01', kind: 'credit', amount: 100, reason: 'overpayment returned'
  });
  await call(boss, 'POST', '/api/ledger/license/' + licId, {
    entry_date: '2026-04-02', kind: 'filing', reason: 'annual return filed, nothing owed'
  });

  var led = await call(boss, 'GET', '/api/ledger/license/' + licId);
  eq('the ledger lists every entry', led.body.entries.length, 3);
  eq('newest first', led.body.entries[0].entry_date, '2026-04-02');
  eq('paid total ignores credits', led.body.totals.paid, 1234.56);
  eq('credited total is its own number', led.body.totals.credited, 100);
  eq('net is paid minus credited', led.body.totals.net, 1134.56);
  eq('a moneyless filing is not counted as an amount', led.body.totals.with_amount, 2);
  eq('the ledger names its subject', led.body.subject.name, 'Birmingham Occupational Tax');

  // ---- ledger validation -------------------------------------------------
  var noDate = await call(boss, 'POST', '/api/ledger/license/' + licId, { amount: 10 });
  eq('an entry with no date is refused', noDate.status, 400);
  var empty = await call(boss, 'POST', '/api/ledger/license/' + licId, { entry_date: '2026-05-01' });
  eq('an entry with no amount, reason or note is refused', empty.status, 400);
  var badDate = await call(boss, 'POST', '/api/ledger/license/' + licId, { entry_date: '3/12/26', amount: 5 });
  eq('a non-ISO date is refused rather than guessed at', badDate.status, 400);

  // ---- ledger permissions ride on the subject ----------------------------
  var readerLed = await call(reader, 'GET', '/api/ledger/license/' + licId);
  eq('a view-only caller can read a licence ledger', readerLed.status, 200);
  eq('and is told they cannot manage it', readerLed.body.can_manage, false);
  var readerWrite = await call(reader, 'POST', '/api/ledger/license/' + licId, {
    entry_date: '2026-06-01', amount: 5, reason: 'nope'
  });
  eq('a view-only caller cannot write to it', readerWrite.status, 403);

  var acctOnlyLed = await call(acctOnly, 'GET', '/api/ledger/license/' + licId);
  eq('account permissions do not open a licence ledger', acctOnlyLed.status, 404);

  var nobodyLed = await call(nobody, 'GET', '/api/ledger/license/' + licId);
  eq('a caller with no permission gets nothing', nobodyLed.status, 404);

  // The account side of the same table.
  var acctEntry = await call(boss, 'POST', '/api/ledger/account/' + accountId, {
    entry_date: '2026-02-01', kind: 'payment', amount: 75.5, reason: 'annual membership'
  });
  eq('a payment can be written to an account', acctEntry.status, 201);
  var acctRead = await call(acctOnly, 'GET', '/api/ledger/account/' + accountId);
  eq('view_vendors reads an account ledger', acctRead.status, 200);
  var acctWrite = await call(acctOnly, 'POST', '/api/ledger/account/' + accountId, {
    entry_date: '2026-02-02', amount: 1, reason: 'nope'
  });
  eq('view_vendors cannot write to an account ledger', acctWrite.status, 403);

  // The allowlist on an account has to cover its register too, or the payment
  // history leaks the thing the allowlist was protecting.
  var restrictedRead = await call(acctOnly, 'GET', '/api/ledger/account/' + restrictedAccountId);
  eq('a restricted account hides its ledger from a non-listed caller', restrictedRead.status, 404);
  var restrictedAllowed = await call(boss, 'GET', '/api/ledger/account/' + restrictedAccountId);
  eq('a listed caller reaches the same ledger', restrictedAllowed.status, 200);
  var restrictedAdmin = await call(admin, 'GET', '/api/ledger/account/' + restrictedAccountId);
  eq('an admin always reaches it', restrictedAdmin.status, 200);

  // ---- editing an entry re-checks the subject, not the entry id ----------
  var entryId = entry.body.id;
  var editByStranger = await call(acctOnly, 'PUT', '/api/ledger/entry/' + entryId, {
    entry_date: '2026-03-12', amount: 1, reason: 'tampered'
  });
  eq('an id guessed from elsewhere cannot be edited', editByStranger.status, 404);
  var delByStranger = await call(acctOnly, 'DELETE', '/api/ledger/entry/' + entryId);
  eq('nor deleted', delByStranger.status, 404);
  var editByReader = await call(reader, 'PUT', '/api/ledger/entry/' + entryId, {
    entry_date: '2026-03-12', amount: 1, reason: 'nope'
  });
  eq('a reader of the subject still cannot edit the entry', editByReader.status, 403);

  var edited = await call(boss, 'PUT', '/api/ledger/entry/' + entryId, {
    entry_date: '2026-03-13', kind: 'payment', amount: 1300, reason: '2026 occupational tax (corrected)'
  });
  eq('a manager can correct an entry', edited.status, 200);
  eq('the correction sticks', edited.body.amount, 1300);

  var delOk = await call(boss, 'DELETE', '/api/ledger/entry/' + entryId);
  eq('a manager can delete an entry', delOk.status, 200);
  var afterDel = await call(boss, 'GET', '/api/ledger/license/' + licId);
  eq('the entry is gone', afterDel.body.entries.length, 2);

  // ---- the licence list carries its own ledger summary -------------------
  var withTotals = await call(boss, 'GET', '/api/licenses');
  var lrow = withTotals.body.licenses[0];
  eq('the licence row counts its ledger', lrow.ledger_count, 2);
  eq('the licence row totals its ledger', lrow.ledger_total, 100);
  eq('the licence row knows the last entry date', lrow.last_entry_on, '2026-04-02');

  // ---- money that moves is audited ---------------------------------------
  var aud = await pool.query("SELECT action, details FROM audit_logs WHERE entity_type = 'ledger' ORDER BY id");
  ok('ledger writes are audited', aud.rows.length >= 3, 'got ' + aud.rows.length);
  var actions = aud.rows.map(function (r) { return r.action; });
  ok('create, update and delete are all audited',
     actions.indexOf('created') !== -1 && actions.indexOf('updated') !== -1 && actions.indexOf('deleted') !== -1,
     actions.join(','));
  var delRow = aud.rows.filter(function (r) { return r.action === 'deleted'; })[0];
  var delDetails = typeof delRow.details === 'string' ? JSON.parse(delRow.details) : delRow.details;
  eq('a deleted entry keeps its amount in the audit trail', delDetails.entry.amount, 1300);

  var licAud = await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'license' ORDER BY id");
  ok('licence writes are audited', licAud.rows.length >= 2);

  // ---- deleting the subject takes its register with it -------------------
  var before = await pool.query('SELECT COUNT(*)::int AS n FROM account_ledger_entries WHERE license_id = $1', [licId]);
  eq('two rows are hanging off the licence', before.rows[0].n, 2);
  var licDel = await call(boss, 'DELETE', '/api/licenses/' + licId);
  eq('the licence deletes', licDel.status, 200);
  eq('and says how much history went with it', licDel.body.ledger_rows_removed, 2);
  var after = await pool.query('SELECT COUNT(*)::int AS n FROM account_ledger_entries WHERE license_id = $1', [licId]);
  eq('the cascade really removed them', after.rows[0].n, 0);

  // ---- cleanup -----------------------------------------------------------
  await new Promise(function (r) { server.close(r); });
  await pool.query('DELETE FROM account_ledger_entries');
  await pool.query('DELETE FROM licenses');
  await pool.query("DELETE FROM vendors WHERE name LIKE 'TEST %'");
  await pool.query("DELETE FROM users WHERE email LIKE '%@licensetest.local'");
  await pool.query("DELETE FROM audit_logs WHERE entity_type IN ('license','ledger')");
  await pool.query("DELETE FROM settings WHERE key = 'role_permissions'");

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
