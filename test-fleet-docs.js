// Fleet document linking: schema + resolver tests.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-fleet-docs.js
//
// It runs the real initDB() twice (so a migration that is not idempotent fails
// here rather than on the next Railway boot), then exercises the exact SQL the
// vehicle-document routes use and the shared logic in utils/fleetDocs.js.
//
// The invariant worth protecting is the last block: the status the REGISTRY
// shows for a vehicle and the status its DOCUMENTS CARD shows come from two
// different queries, and they must agree on every vehicle and both kinds. That
// is the thing that silently rots.
//
// House style: string concatenation only, no template literals.
const { initDB, pool } = require('./db');
const fleetDocs = require('./utils/fleetDocs');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
     'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

const REQUIRED_COLUMNS = {
  vehicle_documents: ['vehicle_id', 'document_id', 'kind', 'link_source', 'created_by', 'created_by_name', 'created_at'],
  documents: ['fleet_scope', 'fleet_kind', 'expires_on', 'reminder_lead_num', 'reminder_lead_unit']
};

function iso(d) {
  var y = d.getFullYear(), m = ('0' + (d.getMonth() + 1)).slice(-2), day = ('0' + d.getDate()).slice(-2);
  return y + '-' + m + '-' + day;
}
function shift(baseISO, days) {
  var d = new Date(baseISO + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return iso(d);
}

async function main() {
  console.log('Running initDB() (first pass)...');
  await initDB();
  console.log('Running initDB() (second pass - idempotency)...');
  await initDB();
  ok('initDB is idempotent', true);

  // ---------- schema ----------
  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    const { rows } = await pool.query(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]
    );
    const have = rows.map(function (r) { return r.column_name; });
    REQUIRED_COLUMNS[table].forEach(function (c) {
      ok('column ' + table + '.' + c + ' exists', have.indexOf(c) !== -1);
    });
  }
  const idx = (await pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'vehicle_documents'"
  )).rows.map(function (r) { return r.indexname; });
  ok('unique index vehicle_documents_uniq exists', idx.indexOf('vehicle_documents_uniq') !== -1, idx.join(','));
  ok('lookup index by vehicle exists', idx.indexOf('vehicle_documents_vehicle_idx') !== -1);
  ok('lookup index by document exists', idx.indexOf('vehicle_documents_document_idx') !== -1);

  // ---------- pure resolver logic ----------
  const TODAY = '2026-08-27';
  eq('no expiry -> current/undated',
     fleetDocs.statusFor({ expires_on: null }, TODAY).state, 'current');
  eq('no expiry -> dated false',
     fleetDocs.statusFor({ expires_on: null }, TODAY).dated, false);
  eq('far future -> current',
     fleetDocs.statusFor({ expires_on: '2027-03-04', reminder_lead_num: 2, reminder_lead_unit: 'weeks' }, TODAY).state, 'current');
  eq('inside 2-week lead -> expiring',
     fleetDocs.statusFor({ expires_on: '2026-09-05', reminder_lead_num: 2, reminder_lead_unit: 'weeks' }, TODAY).state, 'expiring');
  eq('one day outside 2-week lead -> current',
     fleetDocs.statusFor({ expires_on: '2026-09-11', reminder_lead_num: 2, reminder_lead_unit: 'weeks' }, TODAY).state, 'current');
  eq('past date -> expired',
     fleetDocs.statusFor({ expires_on: '2026-08-02', reminder_lead_num: 2, reminder_lead_unit: 'weeks' }, TODAY).state, 'expired');
  // The vault list and the reminder cron both treat the expiry day itself as
  // expired. If this flips, the registry disagrees with the email that morning.
  eq('expiring TODAY counts as expired',
     fleetDocs.statusFor({ expires_on: TODAY, reminder_lead_num: 2, reminder_lead_unit: 'weeks' }, TODAY).state, 'expired');
  eq('no lead configured -> jumps current straight to expired',
     fleetDocs.statusFor({ expires_on: '2026-08-28' }, TODAY).state, 'current');
  // months uses setMonth, NOT 30 days - jobs/docExpiry.js does the same.
  eq('3-month lead uses calendar months',
     fleetDocs.statusFor({ expires_on: '2026-11-20', reminder_lead_num: 3, reminder_lead_unit: 'months' }, TODAY).state, 'expiring');
  eq('3-month lead, one day short',
     fleetDocs.statusFor({ expires_on: '2026-11-28', reminder_lead_num: 3, reminder_lead_unit: 'months' }, TODAY).state, 'current');
  eq('days lead unit works',
     fleetDocs.statusFor({ expires_on: '2026-08-30', reminder_lead_num: 5, reminder_lead_unit: 'days' }, TODAY).state, 'expiring');
  eq('days counted to expiry', fleetDocs.statusFor({ expires_on: '2026-09-05' }, TODAY).days, 9);

  eq('rollup of nothing -> missing', fleetDocs.rollup([], TODAY).state, 'missing');
  eq('rollup of null -> missing', fleetDocs.rollup(null, TODAY).state, 'missing');
  // The renewal case: this year's registration sits beside last year's expired
  // one. The truck is legal, so the chip is green.
  eq('renewal beside an expired one -> current',
     fleetDocs.rollup([{ expires_on: '2026-08-02' }, { expires_on: '2027-03-04' }], TODAY).state, 'current');
  eq('renewal rollup reports the NEW date',
     fleetDocs.rollup([{ expires_on: '2026-08-02' }, { expires_on: '2027-03-04' }], TODAY).expires_on, '2027-03-04');
  eq('two expired -> expired', fleetDocs.rollup([{ expires_on: '2026-08-02' }, { expires_on: '2025-01-01' }], TODAY).state, 'expired');
  eq('expired rollup reports the LATEST expiry',
     fleetDocs.rollup([{ expires_on: '2026-08-02' }, { expires_on: '2025-01-01' }], TODAY).expires_on, '2026-08-02');
  eq('expiring beats expired',
     fleetDocs.rollup([{ expires_on: '2026-08-02' }, { expires_on: '2026-09-05', reminder_lead_num: 2, reminder_lead_unit: 'weeks' }], TODAY).state, 'expiring');
  eq('dated current beats undated current',
     fleetDocs.rollup([{ expires_on: null }, { expires_on: '2027-03-04' }], TODAY).expires_on, '2027-03-04');
  eq('rollup counts every document', fleetDocs.rollup([{ expires_on: null }, { expires_on: '2027-03-04' }], TODAY).count, 2);

  // ---------- fixtures ----------
  await pool.query('DELETE FROM vehicle_documents');
  await pool.query("DELETE FROM documents WHERE r2_key LIKE 'test-fleet/%'");
  await pool.query("DELETE FROM vehicles WHERE make_model LIKE 'TESTFLEET%'");
  await pool.query("DELETE FROM document_folders WHERE name LIKE 'TESTFLEET%'");

  const owner = (await pool.query(
    "INSERT INTO users (email, name, password_hash, role) VALUES ('fleetdocs-test@example.com','Fleet Test','x','admin') " +
    'ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id'
  )).rows[0].id;

  const rootFolder = (await pool.query(
    "INSERT INTO document_folders (name, parent_id, owner_id, owner_name) VALUES ('TESTFLEET Fleet', NULL, $1, 'Fleet Test') RETURNING id", [owner]
  )).rows[0].id;
  const regFolder = (await pool.query(
    "INSERT INTO document_folders (name, parent_id, owner_id, owner_name) VALUES ('TESTFLEET Registrations', $1, $2, 'Fleet Test') RETURNING id", [rootFolder, owner]
  )).rows[0].id;

  async function mkDoc(name, folderId, expiresOn, leadNum, leadUnit, fleetScope, fleetKind) {
    const r = await pool.query(
      "INSERT INTO documents (name, folder_id, r2_key, mime_type, owner_id, owner_name, status, size_bytes, expires_on, reminder_lead_num, reminder_lead_unit, fleet_scope, fleet_kind) " +
      "VALUES ($1,$2,$3,'application/pdf',$4,'Fleet Test','ready',1024,$5,$6,$7,$8,$9) RETURNING id",
      [name, folderId, 'test-fleet/' + name, owner, expiresOn, leadNum, leadUnit, !!fleetScope, fleetKind || null]
    );
    return r.rows[0].id;
  }
  async function mkVehicle(model, active, city) {
    const r = await pool.query(
      "INSERT INTO vehicles (year, make_model, vin, city_code, active) VALUES (2022,$1,$2,$3,$4) RETURNING id",
      [model, ('VIN' + model).slice(0, 17), city || 'DET', active]
    );
    return r.rows[0].id;
  }

  const TODAY2 = fleetDocs.etToday();
  const vGood = await mkVehicle('TESTFLEET Good', true);
  const vSoon = await mkVehicle('TESTFLEET Soon', true);
  const vBad = await mkVehicle('TESTFLEET Expired', true);
  const vNone = await mkVehicle('TESTFLEET NoReg', true);
  const vSold = await mkVehicle('TESTFLEET Sold', false);

  const dGood = await mkDoc('reg-good.pdf', regFolder, shift(TODAY2, 200), 2, 'weeks');
  const dSoon = await mkDoc('reg-soon.pdf', regFolder, shift(TODAY2, 9), 2, 'weeks');
  const dOld = await mkDoc('reg-old.pdf', regFolder, shift(TODAY2, -25), 2, 'weeks');
  const dRenewal = await mkDoc('reg-renewed.pdf', regFolder, shift(TODAY2, 300), 2, 'weeks');
  const dCard = await mkDoc('auto-id-cards.pdf', rootFolder, shift(TODAY2, 150), 3, 'weeks', true, 'insurance');

  async function link(vehicleId, docId, kind) {
    return pool.query(
      'INSERT INTO vehicle_documents (vehicle_id, document_id, kind, link_source, created_by, created_by_name) ' +
      "VALUES ($1,$2,$3,'manual',$4,'Fleet Test') ON CONFLICT (vehicle_id, document_id, kind) DO NOTHING RETURNING id",
      [vehicleId, docId, kind, owner]
    );
  }
  await link(vGood, dGood, 'registration');
  await link(vSoon, dSoon, 'registration');
  await link(vBad, dOld, 'registration');
  await link(vSold, dGood, 'registration');

  // ---------- link table behaviour ----------
  const dup = await link(vGood, dGood, 'registration');
  eq('re-attaching the same file is a no-op, not an error', dup.rows.length, 0);
  const cnt1 = (await pool.query('SELECT COUNT(*)::int AS n FROM vehicle_documents WHERE vehicle_id = $1', [vGood])).rows[0].n;
  eq('...and does not create a second row', cnt1, 1);
  await link(vGood, dGood, 'insurance');
  const cnt2 = (await pool.query('SELECT COUNT(*)::int AS n FROM vehicle_documents WHERE vehicle_id = $1', [vGood])).rows[0].n;
  eq('the same file CAN be attached under a different kind', cnt2, 2);
  await pool.query('DELETE FROM vehicle_documents WHERE vehicle_id = $1 AND document_id = $2 AND kind = $3', [vGood, dGood, 'insurance']);

  // ---------- cascades ----------
  const vTmp = await mkVehicle('TESTFLEET Cascade', true);
  const dTmp = await mkDoc('cascade.pdf', regFolder, null, null, null);
  await link(vTmp, dTmp, 'registration');
  await pool.query('DELETE FROM documents WHERE id = $1', [dTmp]);
  const afterDocDelete = (await pool.query('SELECT COUNT(*)::int AS n FROM vehicle_documents WHERE vehicle_id = $1', [vTmp])).rows[0].n;
  eq('deleting the vault file removes the link', afterDocDelete, 0);
  const dTmp2 = await mkDoc('cascade2.pdf', regFolder, null, null, null);
  await link(vTmp, dTmp2, 'registration');
  await pool.query('DELETE FROM vehicles WHERE id = $1', [vTmp]);
  const afterVehDelete = (await pool.query('SELECT COUNT(*)::int AS n FROM vehicle_documents WHERE document_id = $1', [dTmp2])).rows[0].n;
  eq('deleting the vehicle removes the link', afterVehDelete, 0);
  const fileSurvives = (await pool.query('SELECT COUNT(*)::int AS n FROM documents WHERE id = $1', [dTmp2])).rows[0].n;
  eq('...but the file itself survives', fileSurvives, 1);

  // ---------- docsForVehicle ----------
  const activeN = (await pool.query('SELECT COUNT(*)::int AS n FROM vehicles WHERE active = true')).rows[0].n;
  var docs = await fleetDocs.docsForVehicle(vGood, { vehicleActive: true, activeVehicleCount: activeN });
  eq('active vehicle sees its registration + the fleet insurance card', docs.length, 2);
  eq('registration is listed before insurance', docs.map(function (d) { return d.kind; }), ['registration', 'insurance']);
  eq('the fleet card is flagged as such', docs[1].link_source, 'fleet');
  eq('the linked registration is flagged manual', docs[0].link_source, 'manual');
  eq('folder breadcrumb is built', docs[0].folder_path, 'TESTFLEET Fleet / TESTFLEET Registrations');
  eq('fleet card reports the active fleet size', docs[1].covers, activeN);
  eq('a manual link reports how many vehicles share it', docs[0].covers, 2);
  eq('status rides along on each document', docs[0].status.state, 'current');
  eq('fleet card has no link id (nothing to detach)', docs[1].link_id, null);

  var docsSold = await fleetDocs.docsForVehicle(vSold, { vehicleActive: false, activeVehicleCount: activeN });
  eq('a SOLD vehicle does not get the fleet insurance card', docsSold.length, 1);
  eq('...it still shows what was explicitly linked to it', docsSold[0].kind, 'registration');

  var docsNone = await fleetDocs.docsForVehicle(vNone, { vehicleActive: true, activeVehicleCount: activeN });
  eq('a vehicle with no registration still gets the fleet card', docsNone.length, 1);
  eq('...and it is the insurance one', docsNone[0].kind, 'insurance');

  // Explicitly linking the fleet-wide card must not double it up.
  await link(vGood, dCard, 'insurance');
  var docsDedup = await fleetDocs.docsForVehicle(vGood, { vehicleActive: true, activeVehicleCount: activeN });
  eq('a fleet card explicitly linked too appears ONCE', docsDedup.length, 2);
  eq('...and the explicit link wins, so it can be detached', docsDedup[1].link_source, 'manual');
  await pool.query('DELETE FROM vehicle_documents WHERE vehicle_id = $1 AND document_id = $2', [vGood, dCard]);

  // Renewal beside the expired one, through the real query path.
  await link(vBad, dRenewal, 'registration');
  var docsRenewed = await fleetDocs.docsForVehicle(vBad, { vehicleActive: true, activeVehicleCount: activeN });
  eq('both registrations stay attached after a renewal', docsRenewed.filter(function (d) { return d.kind === 'registration'; }).length, 2);
  await pool.query('DELETE FROM vehicle_documents WHERE vehicle_id = $1 AND document_id = $2', [vBad, dRenewal]);

  // ---------- summaryForVehicles ----------
  const vehRows = (await pool.query("SELECT id, active FROM vehicles WHERE make_model LIKE 'TESTFLEET%'")).rows;
  const summary = await fleetDocs.summaryForVehicles(vehRows);
  eq('good vehicle registration is current', summary[vGood].registration.state, 'current');
  eq('soon vehicle registration is expiring', summary[vSoon].registration.state, 'expiring');
  eq('expired vehicle registration is expired', summary[vBad].registration.state, 'expired');
  eq('vehicle with no registration is missing', summary[vNone].registration.state, 'missing');
  eq('every active vehicle has insurance from the fleet card', summary[vGood].insurance.state, 'current');
  eq('the sold vehicle gets NO insurance from the fleet card', summary[vSold].insurance.state, 'missing');

  const counts = fleetDocs.countsNeedingAttention(summary, vehRows);
  eq('one expired vehicle counted', counts.expired, 1);
  eq('one expiring vehicle counted', counts.expiring, 1);
  eq('one vehicle missing a document counted', counts.missing, 1);
  eq('each vehicle is counted once, in its worst category', counts.total, 3);
  ok('the sold vehicle is not nagged about', counts.total === 3);

  // ---------- THE INVARIANT ----------
  // The registry chip and the vehicle page come from different queries. If they
  // ever disagree, one screen is lying and nobody can tell which.
  var divergences = [];
  for (var i = 0; i < vehRows.length; i++) {
    var v = vehRows[i];
    var perVehicle = await fleetDocs.docsForVehicle(v.id, { vehicleActive: v.active, activeVehicleCount: activeN });
    fleetDocs.KINDS.forEach(function (k) {
      var fromCard = fleetDocs.rollup(perVehicle.filter(function (d) { return d.kind === k; }));
      var fromList = summary[v.id][k];
      if (fromCard.state !== fromList.state) {
        divergences.push('vehicle ' + v.id + ' ' + k + ': card=' + fromCard.state + ' list=' + fromList.state);
      }
    });
  }
  eq('registry list and vehicle card agree on every vehicle and kind', divergences, []);

  // cleanup
  await pool.query('DELETE FROM vehicle_documents');
  await pool.query("DELETE FROM documents WHERE r2_key LIKE 'test-fleet/%'");
  await pool.query("DELETE FROM vehicles WHERE make_model LIKE 'TESTFLEET%'");
  await pool.query("DELETE FROM document_folders WHERE name LIKE 'TESTFLEET%'");
  await pool.query('DELETE FROM users WHERE id = $1', [owner]);

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
