// test-inspection-inspector.js
// Who inspects a vehicle.
//
// The rule: the manager of the driver's home city by default, overridable per
// vehicle from the picker on the compliance grid, with the driver's own
// supervisor as a last resort when no city manager exists. The compliance grid
// and the reminder job must always name the SAME person.
//
// The bug this locks down: commit 75b2c15 put the picker in the Responsible cell
// and stopped rendering the resolved name beside it, so every van read
// "Unassigned" to an admin. The picker also only ever listed admins and owners,
// so the actual city manager could not be chosen.
//
// Run with a real, EMPTY Postgres:
//   DATABASE_URL=postgresql://... node test-inspection-inspector.js

const Module = require('module');

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

const SENT = { emails: [], sms: [], push: [] };
let CURRENT_USER = { id: 1, name: 'Tony McKeon', role: 'admin' };

const STUBS = {
  'node-cron': { schedule: function () {} },
  '../middleware/auth': {
    requireAuth: function (req, res, next) { req.user = CURRENT_USER; next(); },
    requirePermission: function () { return function (req, res, next) { next(); }; },
    requireRole: function () { return function (req, res, next) { next(); }; }
  },
  '../utils/audit': { logAudit: async function () {} },
  '../utils/r2': { configured: function () { return false; }, presignDownload: async function () { return null; }, presignUpload: async function () { return null; }, deleteObject: async function () {} },
  '../utils/email': { emailTemplate: function (o) { return '<html>' + o.title + '</html>'; }, sendEmail: async function (to, subject, html) { SENT.emails.push({ to: to, subject: subject, html: html }); return true; } },
  '../utils/sms': { sendSms: async function (to, body) { SENT.sms.push({ to: to, body: body }); return true; } },
  '../utils/notify': { broadcastRecipients: async function () { return { emails: [], phones: [], userIds: [] }; } },
  '../utils/push': { sendPushToUsers: async function (ids, p) { SENT.push.push({ ids: ids, payload: p }); } },
  './utils/sopIndex': { reindexSop: async function () {} }
};
const _load = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request) && STUBS[request]) return STUBS[request];
  return _load.apply(this, arguments);
};

const { pool, initDB } = require('./db');
const org = require('./utils/org');
const express = require('express');
const inspectionsRouter = require('./routes/inspections');
const reminders = require('./jobs/inspectionReminders');
const app = express();
app.use(express.json());
app.use('/api/inspections', inspectionsRouter);
let server, BASE;

async function get(path) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' } });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, body: data };
}
async function put(path, body) {
  const res = await fetch(BASE + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, body: data };
}

async function mkUser(o) {
  const { rows } = await pool.query(
    'INSERT INTO users (name, email, password_hash, role, active, supervisor_id, home_city, phone, receive_emails, receive_sms) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
    [o.name, o.email, 'x', o.role, o.active !== false, o.supervisor_id || null, o.home_city || null, o.phone || null,
     o.receive_emails !== false, !!o.receive_sms]
  );
  var id = rows[0].id;
  for (var i = 0; i < (o.cities || []).length; i++) {
    await pool.query('INSERT INTO user_cities (user_id, city_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, o.cities[i]]);
  }
  return id;
}
async function mkVehicle(o) {
  const { rows } = await pool.query(
    'INSERT INTO vehicles (year, make_model, license_plate, city_code, assigned_user_id, active, inspection_exempt, inspector_id) ' +
    'VALUES ($1,$2,$3,$4,$5,true,false,$6) RETURNING id',
    [o.year || 2021, 'Chevrolet Express', o.plate, o.city || null, o.driver || null, o.inspector || null]
  );
  return rows[0].id;
}
function vehicleRow(grid, id) { return grid.vehicles.filter(function (v) { return v.vehicle_id === id; })[0]; }

(async function main() {
  server = app.listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  BASE = 'http://127.0.0.1:' + server.address().port + '/api';

  try {
    await initDB();
    await pool.query('DELETE FROM vehicles');
    await pool.query('DELETE FROM user_cities');
    await pool.query('DELETE FROM users');

    section('cityManagerMap: one owner per city');
    // BHM: a dedicated local manager, plus an admin who watches everything.
    var bhmMgr = await mkUser({ name: 'Bree Hall', email: 'bree@x.com', role: 'manager', cities: ['BHM'], phone: '+15551110001', receive_sms: true });
    var everywhereAdmin = await mkUser({ name: 'Ada Admin', email: 'ada@x.com', role: 'admin', cities: ['BHM', 'JAX', 'ORL', 'TPA'] });
    // JAX: two managers, one of whom also covers ORL.
    var jaxOnly = await mkUser({ name: 'Jo Jax', email: 'jo@x.com', role: 'manager', cities: ['JAX'] });
    var jaxAndOrl = await mkUser({ name: 'Owen Wide', email: 'owen@x.com', role: 'manager', cities: ['JAX', 'ORL'] });
    // SAV: only an inactive manager watches it.
    await mkUser({ name: 'Gone Guy', email: 'gone@x.com', role: 'manager', active: false, cities: ['SAV'] });
    // TAL: only a locksmith watches it, which is not a manager.
    await mkUser({ name: 'Larry Locksmith', email: 'larry@x.com', role: 'locksmith', cities: ['TAL'] });

    var map = await org.cityManagerMap();
    eq('a local manager beats an admin who watches every city', map.BHM && map.BHM.id, bhmMgr);
    eq('the more dedicated manager wins a tie', map.JAX && map.JAX.id, jaxOnly);
    eq('a manager who covers two cities still owns the one nobody else does', map.ORL && map.ORL.id, jaxAndOrl);
    eq('an inactive manager does not own a city', map.SAV, undefined);
    eq('a non-manager does not own a city', map.TAL, undefined);
    eq('a city nobody watches has no manager', map.CSG, undefined);
    var again = await org.cityManagerMap();
    eq('the answer is stable across calls', JSON.stringify(again.JAX.id), JSON.stringify(map.JAX.id));

    section('The compliance grid resolves an inspector');
    var driverBhm = await mkUser({ name: 'Dave Driver', email: 'dave@x.com', role: 'locksmith', home_city: 'BHM', supervisor_id: everywhereAdmin });
    var driverJax = await mkUser({ name: 'Jane Jax', email: 'jane@x.com', role: 'locksmith', home_city: 'JAX' });
    var driverSav = await mkUser({ name: 'Sam Sav', email: 'sam@x.com', role: 'locksmith', home_city: 'SAV', supervisor_id: bhmMgr });
    var driverCsg = await mkUser({ name: 'Cal Csg', email: 'cal@x.com', role: 'locksmith', home_city: 'CSG' });
    var driverNoCity = await mkUser({ name: 'Nora NoCity', email: 'nora@x.com', role: 'locksmith' });

    var vBhm = await mkVehicle({ plate: 'BHM001', city: 'BHM', driver: driverBhm });
    var vJax = await mkVehicle({ plate: 'JAX001', city: 'JAX', driver: driverJax });
    var vSav = await mkVehicle({ plate: 'SAV001', city: 'SAV', driver: driverSav });
    var vCsg = await mkVehicle({ plate: 'CSG001', city: 'CSG', driver: driverCsg });
    var vFallback = await mkVehicle({ plate: 'ORL001', city: 'ORL', driver: driverNoCity });
    var vNoDriver = await mkVehicle({ plate: 'TPA001', city: 'TPA', driver: null });
    var vOverride = await mkVehicle({ plate: 'BHM002', city: 'BHM', driver: driverBhm, inspector: jaxOnly });

    var grid = (await get('/inspections/compliance')).body;

    var r = vehicleRow(grid, vBhm);
    eq('the city manager is the default inspector', r.effective_inspector_id, bhmMgr);
    eq('and is labelled as such', r.effective_inspector_source, 'city');
    eq('with a name to show', r.effective_inspector_name, 'Bree Hall');
    eq('the city manager beats the supervisor', r.driver_supervisor_id === everywhereAdmin && r.effective_inspector_id === bhmMgr, true);

    r = vehicleRow(grid, vJax);
    eq('a driver with no supervisor still gets an inspector', r.effective_inspector_id, jaxOnly);

    r = vehicleRow(grid, vSav);
    eq('with no city manager it falls back to the supervisor', r.effective_inspector_id, bhmMgr);
    eq('and says the fallback was used', r.effective_inspector_source, 'supervisor');

    r = vehicleRow(grid, vCsg);
    eq('no city manager and no supervisor resolves to nobody', r.effective_inspector_id, null);
    eq('with no source', r.effective_inspector_source, null);
    eq('but the grid still names the city that needs one', r.inspector_city, 'CSG');

    r = vehicleRow(grid, vFallback);
    eq('a driver with no home city falls back to the vehicle city', r.inspector_city, 'ORL');
    eq('and gets that city manager', r.effective_inspector_id, jaxAndOrl);

    r = vehicleRow(grid, vNoDriver);
    eq('a vehicle with no driver still resolves by its own city', r.effective_inspector_id, everywhereAdmin);

    r = vehicleRow(grid, vOverride);
    eq('an explicit pick wins over the city manager', r.effective_inspector_id, jaxOnly);
    eq('and is labelled as assigned', r.effective_inspector_source, 'assigned');
    eq('the default is still reported so the picker can name it', r.city_manager_id, bhmMgr);
    eq('by name', r.city_manager_name, 'Bree Hall');

    section('The picker offers managers');
    eq('an admin may assign', grid.can_assign_inspector, true);
    var names = (grid.inspectors || []).map(function (i) { return i.name; });
    ok('managers are on the list', names.indexOf('Bree Hall') !== -1, names.join(','));
    ok('admins are still on the list', names.indexOf('Ada Admin') !== -1, names.join(','));
    ok('locksmiths are not', names.indexOf('Larry Locksmith') === -1, names.join(','));
    ok('inactive people are not', names.indexOf('Gone Guy') === -1, names.join(','));

    section('Clearing the override goes back to the city manager');
    var res = await put('/inspections/vehicle/' + vOverride + '/inspector', { inspector_id: null });
    eq('clearing succeeds', res.status, 200);
    grid = (await get('/inspections/compliance')).body;
    r = vehicleRow(grid, vOverride);
    eq('the vehicle is back on its city manager', r.effective_inspector_id, bhmMgr);
    eq('by default, not by assignment', r.effective_inspector_source, 'city');

    section('The reminder nudges whoever the grid names');
    SENT.emails.length = 0; SENT.sms.length = 0; SENT.push.length = 0;
    await reminders.nudgeManagers();
    var to = SENT.emails.map(function (e) { return e.to; });
    ok('the BHM city manager is emailed', to.indexOf('bree@x.com') !== -1, to.join(','));
    ok('the JAX city manager is emailed', to.indexOf('jo@x.com') !== -1, to.join(','));
    ok('the driver of the BHM van is not', to.indexOf('dave@x.com') === -1, to.join(','));
    eq('one grouped email per inspector, not one per vehicle', to.length, new Set(to).size);
    var bree = SENT.emails.filter(function (e) { return e.to === 'bree@x.com'; })[0];
    ok('the BHM manager is told about all three of her vans', /3 vehicle inspections due/.test(bree.subject), bree.subject);
    ok('she is texted too, having opted in', SENT.sms.some(function (s) { return s.to === '+15551110001'; }), JSON.stringify(SENT.sms));
    ok('and pushed', SENT.push.some(function (p) { return p.ids.indexOf(bhmMgr) !== -1; }), JSON.stringify(SENT.push));
    ok('the vehicle nobody owns raises no email', to.indexOf('cal@x.com') === -1, to.join(','));

    // An explicit pick redirects the nudge.
    var assigned = await put('/inspections/vehicle/' + vBhm + '/inspector', { inspector_id: jaxAndOrl });
    eq('a manager can be saved as the inspector', assigned.status, 200);
    SENT.emails.length = 0;
    await reminders.nudgeManagers();
    to = SENT.emails.map(function (e) { return e.to; });
    ok('an assigned inspector is emailed instead', to.indexOf('owen@x.com') !== -1, to.join(','));
    var breeNow = SENT.emails.filter(function (e) { return e.to === 'bree@x.com'; })[0];
    ok('and the city manager drops to her remaining vans', /2 vehicle inspections due/.test(breeNow.subject), breeNow.subject);

  } catch (err) {
    FAIL++;
    FAILURES.push('THREW: ' + (err && err.stack ? err.stack : err));
    console.log('\n  THREW  ' + (err && err.stack ? err.stack : err));
  }

  console.log('\n---------------------------------------------');
  console.log('  ' + PASS + ' passed, ' + FAIL + ' failed');
  if (FAILURES.length) { console.log('\nFailures:'); FAILURES.forEach(function (f) { console.log('  - ' + f); }); }
  console.log('---------------------------------------------');
  server.close();
  await pool.end();
  process.exit(FAIL ? 1 : 0);
})();
