// Certificates of insurance: schema + logic tests.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-coi.js
//
// It runs the real initDB() twice (so a migration that is not idempotent fails
// here rather than on the next Railway boot), then exercises the exact SQL the
// COI routes use and the shared logic in utils/coi.js.
//
// House style: string concatenation only, no template literals.
const path = require('path');
const { initDB, pool } = require('./db');
const coi = require('./utils/coi');

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
  account_coi_requirements: ['account_id', 'coi_required', 'holder_name', 'holder_address',
    'additional_insured', 'ai_wording', 'waiver_gl', 'waiver_auto', 'waiver_wc',
    'primary_noncontrib', 'req_wc_statutory', 'cancel_notice_days', 'named_insured',
    'submit_method', 'submit_emails', 'submit_portal_url', 'submit_notes', 'off_cycle',
    'source_note', 'updated_by', 'updated_by_name', 'created_at', 'updated_at'],
  account_coi_certificates: ['account_id', 'cycle_id', 'r2_key', 'file_name', 'mime_type',
    'size_bytes', 'status', 'effective_on', 'expires_on', 'carrier', 'policy_numbers',
    'has_ai', 'has_waiver', 'has_pnc', 'has_wc', 'mismatch', 'notes', 'sent_at', 'sent_to',
    'sent_by', 'sent_by_name', 'superseded', 'reminder_sent_at', 'expiry_notice_sent_at',
    'uploaded_by', 'uploaded_by_name', 'created_at', 'updated_at'],
  coi_renewal_cycles: ['name', 'policy_effective', 'policy_expires', 'status',
    'packet_generated_at', 'created_by', 'created_by_name', 'created_at', 'closed_at'],
  coi_renewal_items: ['cycle_id', 'account_id', 'status', 'requested_at', 'certificate_id',
    'sent_at', 'confirmed_at', 'notes', 'updated_at'],
  account_documents: ['account_id', 'kind', 'title', 'r2_key', 'file_name', 'mime_type',
    'size_bytes', 'status', 'effective_on', 'expires_on', 'notes', 'uploaded_by',
    'uploaded_by_name', 'created_at', 'updated_at']
};

async function columnsOf(table) {
  const r = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
  return r.rows.map(function (x) { return x.column_name; });
}

async function main() {
  console.log('COI tests');
  console.log('---------');

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

  // Every limit in utils/coi.js must have BOTH its required and its actual
  // column. This is the drift guard: adding a coverage line to LIMIT_FIELDS
  // without adding the columns fails right here.
  var reqCols = await columnsOf('account_coi_requirements');
  var certCols = await columnsOf('account_coi_certificates');
  coi.LIMIT_FIELDS.forEach(function (f) {
    ok('req_' + f.key + ' column exists', reqCols.indexOf(coi.reqCol(f.key)) !== -1);
    ok('lim_' + f.key + ' column exists', certCols.indexOf(coi.limCol(f.key)) !== -1);
  });

  // ---- pure logic: computeMismatch ---------------------------------------
  var reqRow = {
    coi_required: true,
    req_gl_occurrence: '1000000', req_gl_aggregate: '2000000', req_auto_csl: '1000000',
    req_garagekeepers: '100000',
    additional_insured: [{ name: 'GEICO Insurance Agency, Inc.', relationship: 'Client' }],
    waiver_gl: true, primary_noncontrib: true, req_wc_statutory: false
  };
  var goodCert = {
    lim_gl_occurrence: '1000000', lim_gl_aggregate: '2000000', lim_auto_csl: '1000000',
    lim_garagekeepers: '100000', has_ai: true, has_waiver: true, has_pnc: true, has_wc: false
  };
  eq('a compliant certificate has no mismatch', coi.computeMismatch(reqRow, goodCert), []);

  var shortCert = Object.assign({}, goodCert, { lim_auto_csl: '500000', lim_garagekeepers: null });
  var mm = coi.computeMismatch(reqRow, shortCert);
  eq('two shortfalls found', mm.length, 2);
  eq('the low limit is named', mm[0].field, 'auto_csl');
  eq('the low limit reports both numbers', [mm[0].required, mm[0].actual], [1000000, 500000]);
  eq('an absent limit reads as not shown, not zero', mm[1].actual, null);

  var noFlags = Object.assign({}, goodCert, { has_ai: false, has_waiver: false, has_pnc: false });
  var mm2 = coi.computeMismatch(reqRow, noFlags);
  eq('the three missing boxes are all reported', mm2.length, 3);
  ok('missing boxes are flag-kind', mm2.every(function (m) { return m.kind === 'flag'; }));

  // A limit the account does NOT require is never a mismatch, even at zero.
  var partial = { coi_required: true, req_gl_occurrence: '1000000' };
  eq('unset requirements are not mismatches',
     coi.computeMismatch(partial, { lim_gl_occurrence: '1000000', lim_auto_csl: null }), []);

  // An account marked not-required is never non-compliant.
  eq('coi_required=false suppresses the check',
     coi.computeMismatch(Object.assign({}, reqRow, { coi_required: false }), shortCert), []);

  // Limits typed with commas from the browser still compare numerically.
  eq('a limit typed with commas compares as a number',
     coi.computeMismatch({ coi_required: true, req_gl_occurrence: '1000000' }, { lim_gl_occurrence: '1,000,000' }), []);

  // ---- pure logic: coiStatus --------------------------------------------
  var today = '2026-08-24';
  eq('not required', coi.coiStatus({ coi_required: false }, today).key, 'not_required');
  eq('missing', coi.coiStatus({ coi_required: true, expires_on: null }, today).key, 'missing');
  eq('expired', coi.coiStatus({ coi_required: true, expires_on: '2026-06-30' }, today).key, 'expired');
  eq('expiring inside 60 days', coi.coiStatus({ coi_required: true, expires_on: '2026-09-24' }, today).key, 'expiring');
  eq('current beyond 60 days', coi.coiStatus({ coi_required: true, expires_on: '2027-03-01' }, today).key, 'current');
  eq('the 60th day still counts as expiring', coi.coiStatus({ coi_required: true, expires_on: '2026-10-23' }, today).key, 'expiring');
  eq('the 61st day is current', coi.coiStatus({ coi_required: true, expires_on: '2026-10-24' }, today).key, 'current');
  eq('today is not yet expired', coi.coiStatus({ coi_required: true, expires_on: today }, today).key, 'expiring');

  // Precedence: a certificate that is BOTH short and expiring reads as short,
  // because a short certificate has to be reissued either way.
  eq('mismatch outranks expiring',
     coi.coiStatus({ coi_required: true, expires_on: '2026-09-24', mismatch: mm }, today).key, 'mismatch');
  // ... but an EXPIRED certificate outranks a mismatch: it covers nothing at all.
  eq('expired outranks mismatch',
     coi.coiStatus({ coi_required: true, expires_on: '2026-06-30', mismatch: mm }, today).key, 'expired');
  eq('mismatch stored as JSON text still counts',
     coi.coiStatus({ coi_required: true, expires_on: '2027-03-01', mismatch: JSON.stringify(mm) }, today).key, 'mismatch');

  eq('needsAttention covers the four bad states',
     ['missing', 'expired', 'expiring', 'mismatch', 'current', 'not_required'].map(coi.needsAttention),
     [true, true, true, true, false, false]);

  var counts = coi.tally([
    { coi_required: false },
    { coi_required: true, expires_on: null },
    { coi_required: true, expires_on: '2026-06-30' },
    { coi_required: true, expires_on: '2026-09-24' },
    { coi_required: true, expires_on: '2027-03-01' },
    { coi_required: true, expires_on: '2027-03-01', mismatch: mm }
  ], today);
  eq('tally counts each state once', [counts.not_required, counts.missing, counts.expired, counts.expiring, counts.current, counts.mismatch],
     [1, 1, 1, 1, 1, 1]);
  eq('the badge counts everything that needs a human', counts.attention, 4);

  eq('money formatting', coi.fmtMoney('1000000'), '1,000,000');
  eq('blank money stays blank', coi.fmtMoney(null), '');

  // ---- the SQL the routes actually run ------------------------------------
  await pool.query("DELETE FROM account_documents WHERE r2_key LIKE 'test/%'");
  await pool.query("DELETE FROM account_coi_certificates WHERE r2_key LIKE 'test/%'");
  await pool.query("DELETE FROM coi_renewal_cycles WHERE name LIKE 'TEST %'");
  await pool.query("DELETE FROM vendors WHERE name LIKE 'TEST COI %'");

  var v1 = (await pool.query("INSERT INTO vendors (name) VALUES ('TEST COI Alpha') RETURNING id")).rows[0].id;
  var v2 = (await pool.query("INSERT INTO vendors (name) VALUES ('TEST COI Beta') RETURNING id")).rows[0].id;
  var v3 = (await pool.query("INSERT INTO vendors (name) VALUES ('TEST COI OffCycle') RETURNING id")).rows[0].id;

  // The upsert the requirements editor uses, with the full column list.
  var cols = ['account_id', 'coi_required', 'holder_name', 'holder_address', 'additional_insured',
    'ai_wording', 'waiver_gl', 'waiver_auto', 'waiver_wc', 'primary_noncontrib', 'req_wc_statutory',
    'cancel_notice_days', 'named_insured', 'submit_method', 'submit_emails', 'submit_portal_url',
    'submit_notes', 'off_cycle', 'source_note', 'updated_by', 'updated_by_name']
    .concat(coi.LIMIT_FIELDS.map(function (f) { return coi.reqCol(f.key); }));
  var vals = [v1, true, 'GEICO Insurance Agency, Inc.', 'One GEICO Plaza', JSON.stringify(reqRow.additional_insured),
    'named as additional insured', true, false, false, true, false, 30, 'Lock and Roll LLC',
    'email', 'certs@example.com', null, null, false, 'contract p.12', 1, 'Tester']
    .concat(coi.LIMIT_FIELDS.map(function (f) { return coi.num(reqRow[coi.reqCol(f.key)]); }));
  var ph = cols.map(function (_, i) { return '$' + (i + 1); }).join(',');
  var upd = cols.slice(1).map(function (c, i) { return c + ' = $' + (i + 2); }).join(', ');
  var upsert = 'INSERT INTO account_coi_requirements (' + cols.join(',') + ') VALUES (' + ph + ') ' +
    'ON CONFLICT (account_id) DO UPDATE SET ' + upd + ', updated_at = NOW()';
  await pool.query(upsert, vals);
  await pool.query(upsert, vals);      // saving twice must not create a second row
  var rq = await pool.query('SELECT * FROM account_coi_requirements WHERE account_id = $1', [v1]);
  eq('one requirements row per account', rq.rowCount, 1);
  eq('additional insured round-trips as JSON', rq.rows[0].additional_insured[0].name, 'GEICO Insurance Agency, Inc.');
  eq('required limits round-trip', Number(rq.rows[0].req_auto_csl), 1000000);

  await pool.query("INSERT INTO account_coi_requirements (account_id, coi_required, submit_method) VALUES ($1, true, 'portal')", [v2]);
  await pool.query("INSERT INTO account_coi_requirements (account_id, coi_required, off_cycle) VALUES ($1, true, true)", [v3]);

  // Certificates, newest-wins.
  async function addCert(accountId, key, eff, exp) {
    var r = await pool.query(
      'INSERT INTO account_coi_certificates (account_id, r2_key, file_name, status, effective_on, expires_on, ' +
      'lim_gl_occurrence, lim_gl_aggregate, lim_auto_csl, lim_garagekeepers, has_ai, has_waiver, has_pnc) ' +
      "VALUES ($1,$2,$3,'ready',$4,$5,1000000,2000000,1000000,100000,true,true,true) RETURNING *", 
      [accountId, key, key.split('/').pop(), eff, exp]);
    return r.rows[0];
  }
  var old = await addCert(v1, 'test/a/2025.pdf', '2025-03-01', '2026-03-01');
  var cur = await addCert(v1, 'test/a/2026.pdf', '2026-03-01', '2027-03-01');

  // resyncAccount's rule: highest expiry wins, everything else is superseded.
  var all = (await pool.query("SELECT * FROM account_coi_certificates WHERE account_id = $1 AND status = 'ready' ORDER BY expires_on DESC NULLS LAST, id DESC", [v1])).rows;
  eq('newest certificate sorts first', all[0].id, cur.id);
  for (var i = 0; i < all.length; i++) {
    await pool.query('UPDATE account_coi_certificates SET superseded = $1 WHERE id = $2', [all[i].id !== all[0].id, all[i].id]);
  }

  // The DISTINCT ON the list and the digest both use.
  var currentSql = 'SELECT DISTINCT ON (account_id) * FROM account_coi_certificates ' +
    "WHERE status = 'ready' AND superseded = false ORDER BY account_id, expires_on DESC NULLS LAST, id DESC";
  var currents = (await pool.query(currentSql)).rows.filter(function (r) { return r.account_id === v1; });
  eq('exactly one current certificate per account', currents.length, 1);
  eq('and it is the newest one', currents[0].id, cur.id);
  eq('the older one is marked superseded',
     (await pool.query('SELECT superseded FROM account_coi_certificates WHERE id = $1', [old.id])).rows[0].superseded, true);

  // The stored mismatch, computed the way the route computes it.
  var storedMismatch = coi.computeMismatch(rq.rows[0], currents[0]);
  await pool.query('UPDATE account_coi_certificates SET mismatch = $1 WHERE id = $2',
    [storedMismatch.length ? JSON.stringify(storedMismatch) : null, cur.id]);
  eq('the compliant current certificate stores no mismatch',
     (await pool.query('SELECT mismatch FROM account_coi_certificates WHERE id = $1', [cur.id])).rows[0].mismatch, null);

  // Now make the requirements stricter and re-check, which is what saving the
  // editor does: the certificate did not change, the answer did.
  await pool.query('UPDATE account_coi_requirements SET req_umbrella_each = 5000000 WHERE account_id = $1', [v1]);
  var rq2 = (await pool.query('SELECT * FROM account_coi_requirements WHERE account_id = $1', [v1])).rows[0];
  var mm3 = coi.computeMismatch(rq2, currents[0]);
  eq('raising a requirement flags the stored certificate', mm3.length, 1);
  eq('and names the line', mm3[0].field, 'umbrella_each');

  // ---- renewal cycle ------------------------------------------------------
  var cy = (await pool.query(
    "INSERT INTO coi_renewal_cycles (name, policy_effective, policy_expires, created_by_name) " +
    "VALUES ('TEST 2026-2027', '2026-03-01', '2027-03-01', 'Tester') RETURNING *")).rows[0];
  var snap = await pool.query(
    'INSERT INTO coi_renewal_items (cycle_id, account_id) ' +
    'SELECT $1, r.account_id FROM account_coi_requirements r WHERE r.coi_required = true AND r.off_cycle = false ' +
    'ON CONFLICT (cycle_id, account_id) DO NOTHING', [cy.id]);
  ok('the snapshot skipped the off-cycle account', snap.rowCount >= 2);
  var items = (await pool.query('SELECT i.*, v.name FROM coi_renewal_items i JOIN vendors v ON v.id = i.account_id WHERE i.cycle_id = $1', [cy.id])).rows;
  ok('off-cycle account is not on the checklist', items.every(function (i) { return i.account_id !== v3; }));
  eq('every snapshot row starts as needed', items.every(function (i) { return i.status === 'needed'; }), true);

  // Re-snapshotting must not duplicate a row.
  await pool.query(
    'INSERT INTO coi_renewal_items (cycle_id, account_id) ' +
    'SELECT $1, r.account_id FROM account_coi_requirements r WHERE r.coi_required = true AND r.off_cycle = false ' +
    'ON CONFLICT (cycle_id, account_id) DO NOTHING', [cy.id]);
  eq('re-snapshotting is a no-op',
     (await pool.query('SELECT COUNT(*)::int AS n FROM coi_renewal_items WHERE cycle_id = $1', [cy.id])).rows[0].n, items.length);

  // The upload path advances a waiting checklist row by itself.
  await pool.query("UPDATE coi_renewal_items SET status = 'requested' WHERE cycle_id = $1", [cy.id]);
  await pool.query(
    "UPDATE coi_renewal_items i SET status = 'received', certificate_id = $1, updated_at = NOW() " +
    "FROM coi_renewal_cycles c WHERE i.cycle_id = c.id AND c.status = 'open' " +
    "AND i.account_id = $2 AND i.status IN ('needed','requested')", [cur.id, v1]);
  var advanced = (await pool.query('SELECT * FROM coi_renewal_items WHERE cycle_id = $1 AND account_id = $2', [cy.id, v1])).rows[0];
  eq('uploading a certificate marks the row received', advanced.status, 'received');
  eq('and links the certificate', advanced.certificate_id, cur.id);

  // A CLOSED cycle must not be advanced by a later upload.
  await pool.query("UPDATE coi_renewal_cycles SET status = 'closed' WHERE id = $1", [cy.id]);
  await pool.query("UPDATE coi_renewal_items SET status = 'requested' WHERE cycle_id = $1 AND account_id = $2", [cy.id, v1]);
  await pool.query(
    "UPDATE coi_renewal_items i SET status = 'received', certificate_id = $1, updated_at = NOW() " +
    "FROM coi_renewal_cycles c WHERE i.cycle_id = c.id AND c.status = 'open' " +
    "AND i.account_id = $2 AND i.status IN ('needed','requested')", [cur.id, v1]);
  eq('a closed cycle is left alone',
     (await pool.query('SELECT status FROM coi_renewal_items WHERE cycle_id = $1 AND account_id = $2', [cy.id, v1])).rows[0].status, 'requested');

  // ---- the digest query ---------------------------------------------------
  var digest = (await pool.query(
    'SELECT v.name AS account_name, r.account_id, r.coi_required, c.id AS cert_id, c.mismatch, ' +
    "       to_char(c.expires_on, 'YYYY-MM-DD') AS expires_on " +
    'FROM account_coi_requirements r JOIN vendors v ON v.id = r.account_id ' +
    'LEFT JOIN (SELECT DISTINCT ON (account_id) * FROM account_coi_certificates ' +
    "          WHERE status = 'ready' AND superseded = false " +
    '          ORDER BY account_id, expires_on DESC NULLS LAST, id DESC) c ON c.account_id = r.account_id ' +
    'WHERE r.coi_required = true AND v.name LIKE $1 ORDER BY v.name ASC', ['TEST COI %'])).rows;
  eq('the digest sees all three test accounts', digest.length, 3);
  var byName = {};
  digest.forEach(function (d) { byName[d.account_name] = coi.coiStatus(d, today).key; });
  eq('Alpha is current', byName['TEST COI Alpha'], 'current');
  eq('Beta has no certificate', byName['TEST COI Beta'], 'missing');
  eq('the expiry comes back as a plain date string', typeof digest[0].expires_on, 'string');

  // ---- account documents ---------------------------------------------------
  var doc = (await pool.query(
    "INSERT INTO account_documents (account_id, kind, title, r2_key, file_name, status, effective_on, notes) " +
    "VALUES ($1,'agreement','Master services agreement','test/doc/msa.pdf','msa.pdf','ready','2026-01-01','No 1099 work') RETURNING *", [v1])).rows[0];
  eq('an agreement stores against the account', doc.account_id, v1);
  eq('the kind defaults sensibly', doc.kind, 'agreement');
  var docs = (await pool.query("SELECT * FROM account_documents WHERE account_id = $1 AND status <> 'pending'", [v1])).rows;
  eq('the account page query finds it', docs.length, 1);
  eq('notes are searchable text', docs[0].notes, 'No 1099 work');

  // Deleting the account takes its paperwork with it, so nothing is orphaned.
  await pool.query('DELETE FROM vendors WHERE id = $1', [v2]);
  eq('deleting an account removes its COI record',
     (await pool.query('SELECT COUNT(*)::int AS n FROM account_coi_requirements WHERE account_id = $1', [v2])).rows[0].n, 0);

  // ---- the packet PDF -----------------------------------------------------
  var built = await new Promise(function (resolve, reject) {
    var chunks = [];
    var sink = { write: function (c) { chunks.push(Buffer.from(c)); return true; },
      end: function (c) { if (c) chunks.push(Buffer.from(c)); resolve(Buffer.concat(chunks)); },
      on: function () { return sink; }, once: function () { return sink; },
      emit: function () {}, removeListener: function () { return sink; } };
    try {
      require('./utils/coiPacketPdf').buildPacketPdf({
        cycle: cy,
        policy: { named_insured: 'Lock and Roll LLC', agent_name: 'Dana Whitfield', agent_email: 'dana@example.com', policy_gl: 'TWM-1' },
        accounts: [Object.assign({ account_name: 'TEST COI Alpha' }, rq2),
                   { account_name: 'TEST COI NoRequirements' }]
      }, sink);
    } catch (e) { reject(e); }
  });
  ok('the packet builds a real PDF', built.length > 2000, built.length + ' bytes');
  eq('and it is a PDF', built.slice(0, 5).toString(), '%PDF-');

  // Cleanup.
  await pool.query("DELETE FROM coi_renewal_cycles WHERE name LIKE 'TEST %'");
  await pool.query("DELETE FROM vendors WHERE name LIKE 'TEST COI %'");

  console.log('---------');
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error('CRASH', e); process.exit(1); });
