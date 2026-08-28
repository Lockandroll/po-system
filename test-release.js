// Releases of liability: schema + logic tests.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-release.js
//
// It runs the real initDB() twice (so a migration that is not idempotent fails
// here rather than on the next Railway boot), then exercises the exact SQL the
// release routes use and the shared rules in utils/release.js.
//
// House style: string concatenation only, no template literals.
const { initDB, pool } = require('./db');
const R = require('./utils/release');
const releasePdf = require('./utils/releasePdf');

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
  release_forms: ['id', 'release_number', 'status', 'feedback_id', 'work_order_id',
    'claimant_name', 'claimant_phone', 'claimant_email', 'claimant_address', 'claimant_city',
    'claimant_state', 'claimant_zip', 'vehicle_year', 'vehicle_make', 'vehicle_model',
    'vehicle_color', 'license_plate', 'vin', 'service_date', 'job_ref', 'damage_description',
    'settlement_amount', 'release_body', 'rep_user_id', 'rep_name', 'rep_title',
    'customer_token', 'customer_token_expires_at', 'customer_consent', 'customer_printed_name',
    'customer_sig_r2_key', 'customer_signed_at', 'customer_signed_ip',
    'rep_sig_r2_key', 'rep_signed_at', 'rep_signed_ip', 'declined_reason', 'signed_r2_key',
    'sent_at', 'completed_at', 'expires_at', 'created_by', 'created_at', 'updated_at'],
  release_events: ['id', 'release_id', 'event_type', 'actor', 'ip', 'user_agent', 'detail', 'created_at']
};

async function columnsOf(table) {
  const r = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
  return r.rows.map(function (x) { return x.column_name; });
}

// The complete, sendable release used as the baseline everywhere below.
function goodRow() {
  return {
    claimant_name: 'TEST Marcus Whitfield',
    claimant_address: '1420 Larkspur Way',
    claimant_city: 'Jacksonville',
    claimant_state: 'FL',
    claimant_zip: '32210',
    damage_description: 'Body damage to front right passenger side door.',
    rep_name: 'TEST Alan Reyes',
    rep_user_id: 1,
    service_date: '2026-05-20',
    settlement_amount: '2845.00',
    status: 'sent'
  };
}

async function main() {
  console.log('Release of liability tests');
  console.log('--------------------------');

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

  var idx = (await pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename IN ('release_forms','release_events')"
  )).rows.map(function (r) { return r.indexname; });
  ok('feedback index exists', idx.indexOf('release_forms_feedback_idx') !== -1);
  ok('status index exists', idx.indexOf('release_forms_status_idx') !== -1);
  ok('events index exists', idx.indexOf('release_events_release_idx') !== -1);

  // ---- the send gate -----------------------------------------------------
  eq('a complete release needs nothing', R.missingForSend(goodRow()), []);
  eq('an empty release names every requirement', R.missingForSend({}).length, 9);

  var noAddr = goodRow(); delete noAddr.claimant_address;
  eq('a missing address is named', R.missingForSend(noAddr), ['Mailing address']);

  var blankZip = goodRow(); blankZip.claimant_zip = '   ';
  eq('whitespace is not a ZIP code', R.missingForSend(blankZip), ['ZIP code']);

  var zeroAmt = goodRow(); zeroAmt.settlement_amount = '0.00';
  eq('a zero settlement blocks sending', R.missingForSend(zeroAmt), ['Settlement amount']);

  var negAmt = goodRow(); negAmt.settlement_amount = '-50';
  eq('a negative settlement blocks sending', R.missingForSend(negAmt), ['Settlement amount']);

  var noRep = goodRow(); noRep.rep_name = null;
  eq('a release with nobody to countersign cannot go out', R.missingForSend(noRep), ['Countersigning representative']);

  var noDate = goodRow(); noDate.service_date = null;
  eq('a missing service date is named', R.missingForSend(noDate), ['Date of service']);

  // ---- the token gate ----------------------------------------------------
  var live = goodRow();
  live.customer_token_expires_at = new Date(Date.now() + 86400000);
  ok('a live link opens', R.tokenError(live) === null);

  var stale = goodRow();
  stale.customer_token_expires_at = new Date(Date.now() - 1000);
  eq('an expired link is 410', R.tokenError(stale).code, 410);
  ok('an expired link says so', /expired/i.test(R.tokenError(stale).msg));

  ['voided', 'declined', 'expired', 'customer_signed', 'completed'].forEach(function (st) {
    var row = goodRow(); row.status = st;
    ok(st + ' refuses the link', R.tokenError(row) !== null);
    eq(st + ' refuses with 410', R.tokenError(row).code, 410);
  });

  var signed = goodRow(); signed.status = 'customer_signed';
  ok('an already-signed link thanks them rather than erroring', /already been signed/i.test(R.tokenError(signed).msg));

  // Status beats the clock: something voided AND overdue reports the reason a
  // human would give, not the one the calendar would.
  var both = goodRow();
  both.status = 'voided';
  both.customer_token_expires_at = new Date(Date.now() - 86400000);
  ok('voided outranks expired in the message', /canceled/i.test(R.tokenError(both).msg));

  // ---- who may countersign ----------------------------------------------
  var relRow = { rep_user_id: 7 };
  ok('the named rep may countersign', R.canCountersign(relRow, { id: 7, role: 'manager' }));
  ok('a different manager may not', !R.canCountersign(relRow, { id: 8, role: 'manager' }));
  ok('admin may', R.canCountersign(relRow, { id: 99, role: 'admin' }));
  ok('owner may', R.canCountersign(relRow, { id: 99, role: 'owner' }));
  ok('nobody may when no rep is named', !R.canCountersign({ rep_user_id: null }, { id: 7, role: 'manager' }));
  ok('a string id still matches its number', R.canCountersign({ rep_user_id: '7' }, { id: 7, role: 'manager' }));
  ok('an anonymous caller may not', !R.canCountersign(relRow, null));

  // ---- what the customer can see ----------------------------------------
  var full = goodRow();
  full.id = 42;
  full.customer_token = 'a'.repeat(64);
  full.customer_signed_ip = '198.51.100.24';
  full.created_by = 3;
  full.signed_r2_key = 'releases/42/x-signed.pdf';
  full.release_body = 'Paid by {{COMPANY}} in full.';
  var view = R.publicView(full, 'Lock and Roll LLC', 'fallback');
  ok('the token never reaches the browser', Object.keys(view).indexOf('customer_token') === -1);
  ok('internal ids never reach the browser', Object.keys(view).indexOf('id') === -1);
  ok('the R2 key never reaches the browser', Object.keys(view).indexOf('signed_r2_key') === -1);
  ok('the signer IP never reaches the browser', Object.keys(view).indexOf('customer_signed_ip') === -1);
  eq('the company name is substituted into the wording', view.release_body, 'Paid by Lock and Roll LLC in full.');
  var noBody = goodRow();
  eq('the default wording is used when the release has none',
     R.publicView(noBody, 'Acme', 'Default from {{COMPANY}}.').release_body, 'Default from Acme.');

  // ---- signature validation ---------------------------------------------
  var tinyPng = 'data:image/png;base64,' + 'A'.repeat(400);
  ok('a PNG data URL is accepted', R.checkSignatureDataUrl(tinyPng) === null);
  ok('a JPEG is refused', R.checkSignatureDataUrl('data:image/jpeg;base64,AAAA') !== null);
  ok('a bare string is refused', R.checkSignatureDataUrl('not a signature') !== null);
  ok('an empty signature is refused', R.checkSignatureDataUrl('') !== null);
  ok('an empty PNG body is refused', R.checkSignatureDataUrl('data:image/png;base64,') !== null);
  ok('an oversized signature is refused', R.checkSignatureDataUrl('data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024)) !== null);
  ok('a script data URL is refused', R.checkSignatureDataUrl('data:text/html;base64,PHNjcmlwdD4=') !== null);

  // ---- token shape -------------------------------------------------------
  ok('a 64-hex token is well formed', R.isValidToken('a1b2c3d4'.repeat(8)));
  ok('a short token is refused', !R.isValidToken('abc123'));
  ok('a non-hex token is refused', !R.isValidToken('z'.repeat(64)));
  ok('an empty token is refused', !R.isValidToken(''));
  ok('a null token is refused', !R.isValidToken(null));
  eq('money formats with separators', R.usd('2845'), '$2,845.00');
  eq('money copes with nothing at all', R.usd(null), '$0.00');

  // ---- the SQL the routes actually run -----------------------------------
  const u = await pool.query(
    "INSERT INTO users (email, name, password_hash, role, title) VALUES ('test-release@example.com','TEST Alan Reyes','x','manager','Southeast Director') " +
    'ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id'
  );
  const userId = u.rows[0].id;

  const fb = await pool.query(
    'INSERT INTO customer_feedback (source, customer_name, customer_phone, customer_email, vehicle_year, vehicle_make, ' +
    ' vehicle_model, job_location, invoice_ref, incident_text, ai_summary, city_code, received_at) ' +
    "VALUES ('pulsar','TEST Marcus Whitfield','9045550182','mwhitfield@example.com','2024','Toyota','Highlander'," +
    "'Jacksonville','271884','TEST long incident text','TEST damage to the front right door','JAX', NOW()) RETURNING id"
  );
  const fbId = fb.rows[0].id;

  // The pre-fill, exactly as POST /api/releases builds it.
  const seedRow = (await pool.query('SELECT * FROM customer_feedback WHERE id = $1', [fbId])).rows[0];
  ok('the complaint carries a customer name over', seedRow.customer_name === 'TEST Marcus Whitfield');
  ok('the complaint carries the vehicle over', seedRow.vehicle_make === 'Toyota');
  ok('the AI summary is available as the damage description', !!seedRow.ai_summary);

  async function nextNumber() {
    const year = new Date().getFullYear();
    const { rows } = await pool.query(
      "SELECT MAX(CAST(SPLIT_PART(release_number, '-', 3) AS INTEGER)) AS maxseq FROM release_forms WHERE release_number LIKE $1",
      ['ROL-' + year + '-%']
    );
    return 'ROL-' + year + '-' + String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  }

  async function makeRelease(extra) {
    const num = await nextNumber();
    const r = await pool.query(
      'INSERT INTO release_forms (release_number, status, feedback_id, claimant_name, claimant_phone, claimant_email, ' +
      ' claimant_address, claimant_city, claimant_state, claimant_zip, vehicle_year, vehicle_make, vehicle_model, ' +
      ' job_ref, damage_description, service_date, settlement_amount, rep_user_id, rep_name, rep_title, created_by) ' +
      "VALUES ($1,'draft',$2,$3,$4,$5,'1420 Larkspur Way','Jacksonville','FL','32210','2024','Toyota','Highlander'," +
      "$6,'TEST damage','2026-05-20',2845.00,$7,'TEST Alan Reyes','Southeast Director',$8) RETURNING *",
      [num, (extra && extra.noFeedback) ? null : fbId, seedRow.customer_name, seedRow.customer_phone,
       seedRow.customer_email, seedRow.invoice_ref, userId, userId]
    );
    return r.rows[0];
  }

  const relA = await makeRelease();
  ok('a release number is year-sequenced', /^ROL-\d{4}-\d{4}$/.test(relA.release_number));
  eq('a new release starts as a draft', relA.status, 'draft');
  eq('a new release has no token', relA.customer_token, null);
  eq('consent starts false', relA.customer_consent, false);

  const relB = await makeRelease();
  const seqA = parseInt(relA.release_number.split('-')[2], 10);
  const seqB = parseInt(relB.release_number.split('-')[2], 10);
  eq('release numbers increment', seqB, seqA + 1);

  let dupe = null;
  try { await pool.query("INSERT INTO release_forms (release_number, claimant_name) VALUES ($1,'x')", [relA.release_number]); }
  catch (e) { dupe = e.message; }
  ok('release numbers are unique', dupe !== null);

  // A draft is complete enough to send.
  eq('the seeded draft is sendable', R.missingForSend(relA), []);

  // ---- send: the token appears, the status moves -------------------------
  const token = 'b3'.repeat(32);
  const expires = new Date(Date.now() + 14 * 86400000);
  await pool.query(
    "UPDATE release_forms SET customer_token = $1, customer_token_expires_at = $2, expires_at = $2, status = 'sent', sent_at = NOW() WHERE id = $3",
    [token, expires, relA.id]
  );
  let sent = (await pool.query('SELECT * FROM release_forms WHERE customer_token = $1', [token])).rows[0];
  ok('a sent release is found by its token', !!sent);
  eq('sending moves the status', sent.status, 'sent');
  ok('the token gate lets a freshly sent link through', R.tokenError(sent) === null);

  let dupeTok = null;
  try { await pool.query("INSERT INTO release_forms (release_number, claimant_name, customer_token) VALUES ('ROL-9999-9999','x',$1)", [token]); }
  catch (e) { dupeTok = e.message; }
  ok('two releases cannot share a token', dupeTok !== null);

  // ---- sign: the token dies in the same statement ------------------------
  await pool.query(
    'UPDATE release_forms SET customer_sig_r2_key = $1, customer_printed_name = $2, customer_signed_at = NOW(), ' +
    "customer_signed_ip = $3, customer_consent = true, customer_token = NULL, status = 'customer_signed' WHERE id = $4",
    ['releases/' + relA.id + '/customer-sig-1.png', 'TEST Marcus Whitfield', '198.51.100.24', relA.id]
  );
  const replay = (await pool.query('SELECT * FROM release_forms WHERE customer_token = $1', [token])).rows;
  eq('the link is dead the moment it is used', replay.length, 0);
  sent = (await pool.query('SELECT * FROM release_forms WHERE id = $1', [relA.id])).rows[0];
  eq('signing moves the status', sent.status, 'customer_signed');
  ok('the signature is recorded against the release', !!sent.customer_sig_r2_key);
  ok('the signer IP is kept for the certificate', sent.customer_signed_ip === '198.51.100.24');
  ok('a signed release refuses a second signature', R.tokenError(sent) !== null);

  // ---- countersign and complete ------------------------------------------
  await pool.query(
    "UPDATE release_forms SET rep_sig_r2_key = $1, rep_signed_at = NOW(), rep_signed_ip = $2, signed_r2_key = $3, status = 'completed', completed_at = NOW() WHERE id = $4",
    ['releases/' + relA.id + '/rep-sig-1.png', '203.0.113.57', 'releases/' + relA.id + '/' + relA.release_number + '-signed.pdf', relA.id]
  );
  const done = (await pool.query('SELECT * FROM release_forms WHERE id = $1', [relA.id])).rows[0];
  eq('countersigning completes the release', done.status, 'completed');
  ok('the finished PDF is recorded', !!done.signed_r2_key);

  // ---- the audit trail ---------------------------------------------------
  const EVENTS = ['created', 'sent', 'viewed', 'consented', 'signed', 'countersigned', 'completed'];
  for (var i = 0; i < EVENTS.length; i++) {
    await pool.query(
      'INSERT INTO release_events (release_id, event_type, actor, ip, user_agent, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [relA.id, EVENTS[i], 'TEST actor', '198.51.100.24', 'Mozilla/5.0', JSON.stringify({ n: i })]
    );
  }
  const evs = (await pool.query('SELECT * FROM release_events WHERE release_id = $1 ORDER BY created_at ASC, id ASC', [relA.id])).rows;
  eq('every event is stored', evs.length, EVENTS.length);
  eq('events come back oldest first', evs[0].event_type, 'created');
  eq('the detail column round-trips as JSON', evs[2].detail.n, 2);
  ok('the user agent is kept', evs[0].user_agent === 'Mozilla/5.0');

  // ---- the complaint attachment is idempotent ----------------------------
  const key = done.signed_r2_key;
  for (var t = 0; t < 2; t++) {
    await pool.query(
      'INSERT INTO customer_feedback_attachments (feedback_id, r2_key, file_name, mime_type, size_bytes, status, uploaded_by, uploaded_by_name) ' +
      "VALUES ($1,$2,$3,'application/pdf',$4,'ready',$5,$6) ON CONFLICT (r2_key) DO NOTHING",
      [fbId, key, relA.release_number + '-signed.pdf', 1234, userId, 'TEST Alan Reyes']
    );
  }
  const atts = (await pool.query('SELECT * FROM customer_feedback_attachments WHERE r2_key = $1', [key])).rows;
  eq('filing the PDF twice leaves one attachment', atts.length, 1);
  eq('the attachment hangs off the complaint', atts[0].feedback_id, fbId);

  // ---- referential behaviour ---------------------------------------------
  await pool.query('DELETE FROM release_forms WHERE id = $1', [relB.id]);
  const orphanEvents = (await pool.query('SELECT COUNT(*)::int AS n FROM release_events WHERE release_id = $1', [relB.id])).rows[0].n;
  eq('deleting a release takes its events with it', orphanEvents, 0);

  // A release outlives the complaint it came from: the signed document is the
  // record of a payment, and must not vanish because a complaint was tidied up.
  const relC = await makeRelease();
  await pool.query('DELETE FROM customer_feedback_attachments WHERE feedback_id = $1', [fbId]);
  await pool.query('DELETE FROM customer_feedback WHERE id = $1', [fbId]);
  const survivors = (await pool.query('SELECT id, feedback_id FROM release_forms WHERE id = ANY($1)', [[relA.id, relC.id]])).rows;
  eq('releases survive the complaint being deleted', survivors.length, 2);
  ok('the complaint link is cleared, not left dangling',
     survivors.every(function (r) { return r.feedback_id === null; }));

  // ---- the PDF builds from a real row ------------------------------------
  const pdf = await releasePdf.buildReleasePdf(done, evs, { company: { name: 'Lock and Roll LLC' }, logo: null });
  ok('the PDF builds from a database row', Buffer.isBuffer(pdf) && pdf.length > 3000);
  eq('the output really is a PDF', pdf.slice(0, 5).toString(), '%PDF-');
  const pdfNoEvents = await releasePdf.buildReleasePdf(done, [], { company: { name: 'Lock and Roll LLC' }, logo: null });
  ok('a preview with no audit trail still builds', Buffer.isBuffer(pdfNoEvents) && pdfNoEvents.length > 2000);
  ok('the certificate page makes the finished PDF longer', pdf.length > pdfNoEvents.length);
  const pdfEmpty = await releasePdf.buildReleasePdf({ release_number: 'ROL-2026-0000' }, [], { logo: null });
  ok('an almost empty release still renders rather than throwing', Buffer.isBuffer(pdfEmpty));

  // ---- cleanup -----------------------------------------------------------
  await pool.query("DELETE FROM release_forms WHERE claimant_name LIKE 'TEST %' OR release_number LIKE 'ROL-9999-%'");
  await pool.query("DELETE FROM customer_feedback WHERE customer_name LIKE 'TEST %'");
  await pool.query("DELETE FROM users WHERE email = 'test-release@example.com'");

  console.log('--------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error('CRASH', e); process.exit(1); });
