// Vehicle assignment & turn-in sheets: schema, permission and flow tests.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-vehicle-handoffs.js
//
// Same shape as test-licensing-ledger.js: the real initDB() runs twice (so a
// migration that is not idempotent fails here, not on the next Railway boot),
// then the REAL routers are mounted behind the REAL requireAuth and driven over
// HTTP with real JWTs. R2, push, SMS and email are stubbed in place (the route
// grabs them at require time, so the stubs go in first); everything else,
// including the PDF renderer, is the real code.
//
// What this proves, end to end:
//   - a locksmith cannot start a sheet; a manager can; one open sheet per van
//   - the driver fills and signs on their own login; nobody else can sign
//   - photos: server clock, 15-minute confirm window, only the shooter confirms
//   - a driver-added damage mark blocks the countersign until a manager confirms it
//   - countersign is the only thing that changes Fleet, and it writes history,
//     credits the month's inspection, files a PDF and emails it
//   - turn-in: manager damage check required, repaired marks applied, reassign chains
//   - complete-without-driver, void, and the Edit Vehicle override guard
//   - agreement library: version bump only after a signature, delete vs archive
//
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-vehicle-handoffs';
process.env.APP_URL = process.env.APP_URL || 'https://nova.test';

const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');

// ---- stubs, installed before any route is required ------------------------
var sent = { push: [], sms: [], email: [], put: {} };
var r2 = require('./utils/r2');
r2.configured = function () { return true; };
r2.presignUpload = async function (key) { return 'https://r2.test/put/' + key; };
r2.presignDownload = async function (key) { return 'https://r2.test/get/' + key; };
r2.headObject = async function (key) { return r2._missing && r2._missing[key] ? null : { size: 1234 }; };
r2.putObject = async function (key, buf) { sent.put[key] = buf; };
r2.getObjectBuffer = async function () { return null; };   // PDF draws a placeholder tile
var push = require('./utils/push');
push.sendPushToUsers = async function (ids, p) { sent.push.push({ ids: ids, p: p }); };
var sms = require('./utils/sms');
sms.sendSms = async function (to, msg) { sent.sms.push({ to: to, msg: msg }); };
var email = require('./utils/email');
email.sendEmail = async function (to, subject, html, cc, att) { sent.email.push({ to: to, subject: subject, att: att || null }); };

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

const REQUIRED_COLUMNS = {
  vehicle_handoffs: ['handoff_number', 'kind', 'vehicle_id', 'driver_user_id', 'status', 'filled_by', 'due_at',
    'reminder_sent_at', 'photo_slots', 'checklist', 'damage_reviewed_at', 'manager_damage_checked_at', 'marks_snapshot',
    'driver_not_present', 'driver_signature', 'driver_gps_lat', 'manager_signature', 'pdf_r2_key', 'document_id',
    'inspection_id', 'next_handoff_id', 'prior_handoff_id', 'after_turn_in', 'reassign_to_user_id'],
  vehicle_handoff_photos: ['handoff_id', 'slot_key', 'mark_id', 'r2_key', 'status', 'captured_at', 'confirmed_at', 'replaces_photo_id', 'uploaded_by'],
  vehicle_damage_marks: ['vehicle_id', 'mark_no', 'view', 'x', 'y', 'kind', 'severity', 'origin', 'confirmed', 'created_handoff_id', 'status', 'change', 'changed_handoff_id', 'photo_id'],
  vehicle_assignment_history: ['vehicle_id', 'user_id', 'start_date', 'end_date', 'start_odometer', 'end_odometer', 'assign_handoff_id', 'turnin_handoff_id', 'source', 'override_reason'],
  vehicle_agreements: ['name', 'use_on', 'is_default', 'status', 'version', 'statements'],
  vehicle_handoff_agreements: ['handoff_id', 'agreement_id', 'agreement_name', 'version', 'statements', 'initials'],
  vehicle_inspections: ['handoff_id'],
  vehicles: ['body_type']
};
async function columnsOf(table) {
  const r = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
  return r.rows.map(function (x) { return x.column_name; });
}

// ---- tiny HTTP harness ----------------------------------------------------
var base = '';
function tokenFor(user) {
  return jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
async function call(user, method, path, body) {
  const res = await fetch(base + path, {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + tokenFor(user) }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function mkUser(name, role) {
  var em = name.toLowerCase() + '@vhtest.local';
  const r = await pool.query(
    "INSERT INTO users (email, name, password_hash, role, active, session_epoch, phone, receive_sms) VALUES ($1,$2,'x',$3,true,0,'5555550100',true) RETURNING id, role",
    [em, name, role]
  );
  return { id: r.rows[0].id, role: r.rows[0].role, name: name, email: em };
}

var SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
var API = '/api/vehicle-handoffs';

// Shoot + confirm one photo as the given user. Returns the confirm response.
async function shoot(user, sheetId, body) {
  var s = await call(user, 'POST', API + '/' + sheetId + '/photos/shoot', body);
  if (s.status !== 200) return s;
  return call(user, 'POST', API + '/photos/' + s.body.photo_id + '/confirm', { phash: '0123456789abcdef' });
}
async function shootAllSlots(user, sheet) {
  var last = null;
  for (var i = 0; i < sheet.photo_slots.length; i++) last = await shoot(user, sheet.id, { slot_key: sheet.photo_slots[i].key });
  return last;
}
function allPresent(sheet) {
  return sheet.checklist.map(function (c) { return { key: c.key, state: 'present', value: c.extra === 'count' ? '2' : (c.extra === 'last4' ? '4242' : '') }; });
}
async function initialAll(user, sheet, initials) {
  var last = null;
  for (var i = 0; i < sheet.agreements.length; i++) {
    var a = sheet.agreements[i];
    for (var j = 0; j < a.statements.length; j++) {
      last = await call(user, 'POST', API + '/' + sheet.id + '/agreements/' + a.id + '/initial', { key: a.statements[j].key, initials: initials });
    }
  }
  return last;
}

async function main() {
  // ---- schema ------------------------------------------------------------
  await initDB();
  await initDB();
  for (var t in REQUIRED_COLUMNS) {
    var have = await columnsOf(t);
    REQUIRED_COLUMNS[t].forEach(function (c) { ok(t + '.' + c + ' exists', have.indexOf(c) !== -1); });
  }
  var ag0 = await pool.query('SELECT name, use_on, is_default, status FROM vehicle_agreements ORDER BY id');
  eq('initDB twice seeds the two starter agreements once', ag0.rows.length, 2);
  eq('both starters are live defaults', ag0.rows.map(function (r) { return r.status + '/' + r.is_default; }), ['live/true', 'live/true']);

  // ---- fixtures ----------------------------------------------------------
  await pool.query("DELETE FROM users WHERE email LIKE '%@vhtest.local'");
  var admin = await mkUser('Admin', 'admin');
  var mgr = await mkUser('Mgr', 'manager');
  var viewer = await mkUser('Viewer', 'dispatcher');
  var lock = await mkUser('Lock', 'locksmith');
  var lock2 = await mkUser('Locktwo', 'locksmith');
  var nobody = await mkUser('Nobody', 'roadside_technician');
  // City scope: Mgr manages JAX; Mgrtpa manages TPA only; Mgrhome has no
  // user_cities rows and falls back to home_city JAX; Tpadriver is based in TPA.
  var mgrTpa = await mkUser('Mgrtpa', 'manager');
  var mgrHome = await mkUser('Mgrhome', 'manager');
  var tpaDriver = await mkUser('Tpadriver', 'locksmith');
  await pool.query("INSERT INTO user_cities (user_id, city_code) VALUES ($1,'JAX'),($2,'TPA'),($3,'JAX')", [mgr.id, mgrTpa.id, viewer.id]);
  await pool.query("UPDATE users SET home_city = 'JAX' WHERE id = $1", [mgrHome.id]);
  await pool.query("UPDATE users SET home_city = 'TPA' WHERE id = $1", [tpaDriver.id]);
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('role_permissions', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify({
      manager: ['view_vehicle_handoffs', 'manage_vehicle_handoffs', 'manage_vehicles', 'view_vehicles', 'view_inspections'],
      dispatcher: ['view_vehicle_handoffs'],
      locksmith: ['view_inspections'],
      roadside_technician: []
    })]
  );
  var vq = await pool.query("INSERT INTO vehicles (year, make_model, license_plate, city_code, mileage) VALUES (2021, 'Chevy Express 2500', 'VH-TEST', 'JAX', 44000) RETURNING id");
  var vid = vq.rows[0].id;

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(API, require('./routes/vehicleHandoffs'));
  app.use('/api/vehicles', require('./routes/vehicles'));
  app.use('/api/inspections', require('./routes/inspections'));
  app.use(function (err, req, res, _next) { console.error(err); res.status(500).json({ error: 'Internal server error' }); });
  const server = await new Promise(function (resolve) { const s = app.listen(0, '127.0.0.1', function () { resolve(s); }); });
  base = 'http://127.0.0.1:' + server.address().port;

  // ---- starting a sheet --------------------------------------------------
  eq('unauthenticated is 401', (await fetch(base + API + '/config')).status, 401);
  var cfg = await call(lock, 'GET', API + '/config');
  eq('any signed-in user can load config', cfg.status, 200);
  eq('a locksmith is not a manager in config', cfg.body.can_manage, false);
  eq('config tells a manager their cities', (await call(mgr, 'GET', API + '/config')).body.cities, ['JAX']);
  eq('home city is the fallback scope', (await call(mgrHome, 'GET', API + '/config')).body.cities, ['JAX']);
  eq('admin is unscoped', (await call(admin, 'GET', API + '/config')).body.cities, null);
  var nocity = (await pool.query("INSERT INTO vehicles (year, make_model, license_plate) VALUES (2019, 'Chevy Express 2500', 'NO-CITY') RETURNING id")).rows[0].id;
  var ncs = await call(mgr, 'POST', API, { kind: 'assign', vehicle_id: nocity, driver_user_id: lock.id });
  eq('a manager cannot start a sheet on a van with no city', ncs.status, 403);
  ok('and is told to get the city set', /no city set/.test(ncs.body.error), ncs.body.error);
  var nca = await call(admin, 'POST', API, { kind: 'assign', vehicle_id: nocity, driver_user_id: lock.id });
  eq('admin can', nca.status, 200);
  await call(admin, 'POST', API + '/' + nca.body.id + '/void', { reason: 'scope test' });
  eq('diagram loads for a driver', (await call(lock, 'GET', API + '/diagram/express')).status, 200);

  eq('a locksmith cannot start a sheet', (await call(lock, 'POST', API, { kind: 'assign', vehicle_id: vid, driver_user_id: lock.id })).status, 403);
  eq('a viewer cannot start a sheet', (await call(viewer, 'POST', API, { kind: 'assign', vehicle_id: vid, driver_user_id: lock.id })).status, 403);
  eq('turn-in of an unassigned van is refused', (await call(mgr, 'POST', API, { kind: 'turn_in', vehicle_id: vid })).status, 409);
  eq('assign needs a driver', (await call(mgr, 'POST', API, { kind: 'assign', vehicle_id: vid })).status, 400);

  var tpaStart = await call(mgrTpa, 'POST', API, { kind: 'assign', vehicle_id: vid, driver_user_id: lock.id });
  eq('a TPA manager cannot start a sheet on a JAX van', tpaStart.status, 403);
  ok('and is told why', /JAX/.test(tpaStart.body.error), tpaStart.body.error);
  var outDrv = await call(mgr, 'POST', API, { kind: 'assign', vehicle_id: vid, driver_user_id: tpaDriver.id });
  eq('a JAX manager cannot hand a van to a TPA-based driver', outDrv.status, 400);
  var due = new Date(Date.now() + 86400000).toISOString();
  var st = await call(mgr, 'POST', API, { kind: 'assign', vehicle_id: vid, driver_user_id: lock.id, due_at: due, note: 'Bring both keys' });
  eq('manager starts an assignment', st.status, 200);
  var S1 = st.body;
  ok('numbered VA-YYYY-NNNN', /^VA-\d{4}-\d{4}$/.test(S1.handoff_number), S1.handoff_number);
  eq('driver-filled sheet waits on the driver', S1.status, 'awaiting_driver');
  eq('the default assign agreement is frozen onto it', S1.agreements.map(function (a) { return a.agreement_name; }), ['Standard Vehicle Use Agreement']);
  eq('eight photo slots frozen', S1.photo_slots.length, 8);
  ok('the driver was texted', sent.sms.some(function (m) { return m.msg.indexOf('assigned you') !== -1 && m.msg.indexOf('vehicle-sheet') !== -1; }));
  eq('a second sheet on the same van is refused', (await call(mgr, 'POST', API, { kind: 'assign', vehicle_id: vid, driver_user_id: lock2.id })).status, 409);

  // ---- access ------------------------------------------------------------
  eq('an unrelated employee cannot open the sheet', (await call(nobody, 'GET', API + '/' + S1.id)).status, 403);
  eq('another locksmith cannot open it either', (await call(lock2, 'GET', API + '/' + S1.id)).status, 403);
  var dv = await call(lock, 'GET', API + '/' + S1.id);
  eq('the driver opens it', dv.status, 200);
  eq('driver access', [dv.body.access.can_fill, dv.body.access.can_sign, dv.body.access.can_countersign], [true, true, false]);
  var vv = await call(viewer, 'GET', API + '/' + S1.id);
  eq('a viewer can read but not fill', [vv.status, vv.body.access.can_fill, vv.body.access.can_review], [200, false, false]);
  eq('signatures are not in the payload', dv.body.driver_signature, null);
  eq('a TPA manager cannot open a JAX sheet', (await call(mgrTpa, 'GET', API + '/' + S1.id)).status, 403);
  eq('a home-city JAX manager can', (await call(mgrHome, 'GET', API + '/' + S1.id)).status, 200);
  var tq = await call(mgrTpa, 'GET', API + '?tab=open');
  eq('the TPA queue does not list it, and counts only TPA', [tq.body.sheets.length, tq.body.counts.driver], [0, 0]);
  eq('the JAX queue does', (await call(mgr, 'GET', API + '?tab=open')).body.sheets.map(function (x) { return x.id; }), [S1.id]);
  var mine = await call(lock, 'GET', API + '/mine');
  eq('the sheet is on the driver home card', mine.body.map(function (s) { return s.id; }), [S1.id]);
  eq('a viewer cannot list /mine of others (gets their own, empty)', (await call(viewer, 'GET', API + '/mine')).body.length, 0);

  // ---- the driver fills it -----------------------------------------------
  eq('a silly odometer is refused', (await call(lock, 'PUT', API + '/' + S1.id, { odometer: 9999999 })).status, 400);
  eq('an unknown fuel level is refused', (await call(lock, 'PUT', API + '/' + S1.id, { fuel_level: 'half' })).status, 400);
  var u1 = await call(lock, 'PUT', API + '/' + S1.id, { odometer: 45012, fuel_level: '3/4' });
  eq('driver saves readings', u1.status, 200);
  eq('touching it moves it to in progress', u1.body.status, 'in_progress');
  eq('the driver cannot change the manager note', (await call(lock, 'PUT', API + '/' + S1.id, { note: 'hi' })).status, 403);
  eq('a viewer cannot fill', (await call(viewer, 'PUT', API + '/' + S1.id, { odometer: 1 })).status, 403);

  eq('unknown photo slot is refused', (await call(lock, 'POST', API + '/' + S1.id + '/photos/shoot', { slot_key: 'selfie' })).status, 400);
  var sh = await call(lock, 'POST', API + '/' + S1.id + '/photos/shoot', { slot_key: 'front' });
  eq('shoot returns a presigned PUT', [sh.status, /^https:\/\/r2\.test\/put\/vehicle-handoffs\//.test(sh.body.upload_url)], [200, true]);
  eq('only the shooter can confirm', (await call(mgr, 'POST', API + '/photos/' + sh.body.photo_id + '/confirm', {})).status, 403);
  await pool.query("UPDATE vehicle_handoff_photos SET captured_at = NOW() - INTERVAL '20 minutes' WHERE id = $1", [sh.body.photo_id]);
  eq('a photo confirmed after 15 minutes is refused', (await call(lock, 'POST', API + '/photos/' + sh.body.photo_id + '/confirm', {})).status, 410);
  var sh2 = await call(lock, 'POST', API + '/' + S1.id + '/photos/shoot', { slot_key: 'front' });
  r2._missing = {}; r2._missing[(await pool.query('SELECT r2_key FROM vehicle_handoff_photos WHERE id = $1', [sh2.body.photo_id])).rows[0].r2_key] = true;
  eq('a photo that never reached R2 is refused', (await call(lock, 'POST', API + '/photos/' + sh2.body.photo_id + '/confirm', {})).status, 400);
  r2._missing = null;
  var last = await shootAllSlots(lock, S1);
  eq('all eight slots shot and confirmed', last.status, 200);
  ok('no photo is still owed', !last.body.missing_for_sign.some(function (m) { return m.indexOf('photo') !== -1 && m.indexOf('Take the') === 0; }), JSON.stringify(last.body.missing_for_sign));
  var reshoot = await shoot(lock, S1.id, { slot_key: 'front' });
  eq('a reshoot supersedes the earlier photo, one ready per slot', reshoot.body.photos.filter(function (p) { return p.slot_key === 'front'; }).length, 1);

  // Damage: off the van, then a real one.
  eq('a mark off the vehicle is refused', (await call(lock, 'POST', API + '/' + S1.id + '/marks', { view: 'ds', x: 500, y: 40, kind: 'dent' })).status, 400);
  eq('a mark on an unknown view is refused', (await call(lock, 'POST', API + '/' + S1.id + '/marks', { view: 'roof', x: 10, y: 10 })).status, 400);
  var mk = await call(lock, 'POST', API + '/' + S1.id + '/marks', { view: 'ds', x: 150, y: 40, kind: 'dent', severity: 'moderate', location: 'Slider door' });
  eq('the driver adds a mark', mk.status, 200);
  var M1 = mk.body.marks[0];
  eq('driver mark: #1, origin driver, unconfirmed, blue', [M1.mark_no, M1.origin, M1.confirmed, M1.state], [1, 'driver', false, 'driver']);
  ok('a driver mark needs a close-up', mk.body.missing_for_sign.indexOf('Take a close-up of damage mark #1.') !== -1);
  eq('the driver cannot confirm their own mark', (await call(lock, 'PUT', API + '/' + S1.id + '/marks/' + M1.id, { confirmed: true })).status, 403);
  var mkPhoto = await shoot(lock, S1.id, { mark_id: M1.id });
  eq('mark close-up saved', mkPhoto.status, 200);
  ok('the close-up is linked to the mark', mkPhoto.body.marks[0].photo_id != null);
  await call(lock, 'POST', API + '/' + S1.id + '/damage-reviewed');

  var cl = await call(lock, 'PUT', API + '/' + S1.id, { checklist: allPresent(S1).concat([{ key: 'made_up', state: 'present' }]) });
  eq('checklist saved, unknown keys ignored', cl.body.checklist.length, 8);
  eq('the keys count came through', cl.body.checklist[0].value, '2');

  var early = await call(lock, 'POST', API + '/' + S1.id + '/driver-sign', { consent: true, signature_data: SIG });
  eq('signing before initials is refused', early.status, 400);
  ok('and says what is left', /^Initial 5 statements/.test(early.body.error), early.body.error);
  var ag = S1.agreements[0];
  eq('bad initials are refused', (await call(lock, 'POST', API + '/' + S1.id + '/agreements/' + ag.id + '/initial', { key: ag.statements[0].key, initials: '12' })).status, 400);
  eq('an unknown statement is refused', (await call(lock, 'POST', API + '/' + S1.id + '/agreements/' + ag.id + '/initial', { key: 'nope', initials: 'LK' })).status, 400);
  eq('a manager cannot initial for the driver', (await call(mgr, 'POST', API + '/' + S1.id + '/agreements/' + ag.id + '/initial', { key: ag.statements[0].key, initials: 'MG' })).status, 403);
  var ini = await initialAll(lock, S1, 'lk');
  eq('initials stored upper-case', ini.body.agreements[0].initials.camera, 'LK');
  eq('nothing left before signing', ini.body.missing_for_sign, []);

  eq('signing needs the consent box', (await call(lock, 'POST', API + '/' + S1.id + '/driver-sign', { signature_data: SIG })).status, 400);
  eq('signing needs a PNG signature', (await call(lock, 'POST', API + '/' + S1.id + '/driver-sign', { consent: true, signature_data: 'hello' })).status, 400);
  eq('a manager cannot sign as the driver', (await call(mgr, 'POST', API + '/' + S1.id + '/driver-sign', { consent: true, signature_data: SIG })).status, 403);
  var sg = await call(lock, 'POST', API + '/' + S1.id + '/driver-sign', { consent: true, signature_data: SIG, gps_lat: 30.33, gps_lon: -81.65, gps_accuracy: 12 });
  eq('the driver signs', [sg.status, sg.body.status, sg.body.has_driver_signature], [200, 'ready_for_review', true]);
  eq('the driver cannot change it after signing', (await call(lock, 'PUT', API + '/' + S1.id, { odometer: 1 })).status, 403);
  eq('and cannot sign twice', (await call(lock, 'POST', API + '/' + S1.id + '/driver-sign', { consent: true, signature_data: SIG })).status, 403);
  var sigs = await call(mgr, 'GET', API + '/' + S1.id + '/signatures');
  eq('the signature image is served separately', sigs.body.driver, SIG);
  var gps = await pool.query('SELECT driver_gps_lat::float AS lat, driver_ip FROM vehicle_handoffs WHERE id = $1', [S1.id]);
  eq('GPS stored with the signature', gps.rows[0].lat, 30.33);

  // ---- countersign -------------------------------------------------------
  var q = await call(mgr, 'GET', API + '?tab=review');
  eq('the sheet is in the review queue', [q.body.sheets.map(function (s) { return s.id; }), q.body.counts.review], [[S1.id], 1]);
  eq('the driver cannot countersign', (await call(lock, 'POST', API + '/' + S1.id + '/countersign', { signature_data: SIG })).status, 403);
  var cs0 = await call(mgr, 'POST', API + '/' + S1.id + '/countersign', { signature_data: SIG });
  eq('an unconfirmed driver mark blocks the countersign', cs0.status, 400);
  ok('and says which', cs0.body.error.indexOf('#1') !== -1, cs0.body.error);
  var before = await pool.query('SELECT assigned_user_id FROM vehicles WHERE id = $1', [vid]);
  eq('Fleet has not changed yet', before.rows[0].assigned_user_id, null);
  await call(mgr, 'PUT', API + '/' + S1.id + '/marks/' + M1.id, { confirmed: true });
  sent.email = [];
  var cs = await call(mgr, 'POST', API + '/' + S1.id + '/countersign', { signature_data: SIG });
  eq('the manager countersigns', [cs.status, cs.body.status], [200, 'completed']);

  var veh = (await pool.query('SELECT assigned_user_id, mileage, date_of_assignment FROM vehicles WHERE id = $1', [vid])).rows[0];
  eq('Fleet now shows the driver', veh.assigned_user_id, lock.id);
  eq('mileage moved up to the sheet reading', veh.mileage, 45012);
  ok('assignment date set', !!veh.date_of_assignment);
  var hist = (await pool.query('SELECT * FROM vehicle_assignment_history WHERE vehicle_id = $1 ORDER BY id', [vid])).rows;
  eq('one open history row from the sheet', hist.map(function (h) { return [h.user_id, h.end_date, h.assign_handoff_id, h.source, h.start_odometer]; }), [[lock.id, null, S1.id, 'sheet', 45012]]);
  var insp = (await pool.query('SELECT id, status, handoff_id, period_month FROM vehicle_inspections WHERE vehicle_id = $1', [vid])).rows;
  eq('the sheet counts as this month\'s inspection', [insp.length, insp[0] && insp[0].status, insp[0] && insp[0].handoff_id], [1, 'reviewed', S1.id]);
  var done1 = (await pool.query('SELECT pdf_r2_key, document_id, inspection_id, marks_snapshot FROM vehicle_handoffs WHERE id = $1', [S1.id])).rows[0];
  eq('inspection linked back to the sheet', done1.inspection_id, insp[0] && insp[0].id);
  ok('PDF stored in R2', !!done1.pdf_r2_key && !!sent.put[done1.pdf_r2_key]);
  ok('it is a real PDF', sent.put[done1.pdf_r2_key] && sent.put[done1.pdf_r2_key].slice(0, 5).toString() === '%PDF-');
  ok('filed in the Document Vault', !!done1.document_id);
  var folder = await pool.query('SELECT f.name FROM documents d JOIN document_folders f ON f.id = d.folder_id WHERE d.id = $1', [done1.document_id]);
  eq('in the Vehicle Sheets folder', folder.rows[0] && folder.rows[0].name, 'Vehicle Sheets');
  var pdfMails = sent.email.filter(function (e) { return e.att && e.att.length; });
  eq('the signed PDF went to the driver and the manager', pdfMails.map(function (e) { return e.to; }).sort(), [lock.email, mgr.email].sort());
  eq('marks snapshot frozen on the sheet', done1.marks_snapshot.map(function (m) { return [m.mark_no, m.state]; }), [[1, 'existing']]);
  var mc = (await pool.query('SELECT confirmed FROM vehicle_damage_marks WHERE id = $1', [M1.id])).rows[0];
  eq('the driver mark is confirmed on the record', mc.confirmed, true);
  var pdfUrl = await call(lock, 'GET', API + '/' + S1.id + '/pdf');
  eq('the driver can open the PDF', [pdfUrl.status, /r2\.test\/get\//.test(pdfUrl.body.url)], [200, true]);

  // ---- inspection review aid: GET /inspections/:id/vehicle-record ----------
  // An earlier inspection with a red item and a photo, one month back.
  var prevMonth = (function () { var d = new Date(insp[0].period_month + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  var ei = (await pool.query("INSERT INTO vehicle_inspections (inspection_number, vehicle_id, period_month, submitted_by, status, overall_result, mileage) VALUES ('INS-TEST-0001',$1,$2,$3,'reviewed','fail',43000) RETURNING id", [vid, prevMonth, lock.id])).rows[0].id;
  await pool.query("INSERT INTO inspection_items (inspection_id, item_key, label, answer, color, comment) VALUES ($1,'tires','Tires','Bald','red','Front left worn'),($1,'lights','Lights','OK','green',null)", [ei]);
  await pool.query("INSERT INTO inspection_photos (inspection_id, item_key, name, r2_key, status) VALUES ($1,'tires','tire.jpg','inspections/test/tire.jpg','ready'),($1,'lights','l.jpg','inspections/test/l.jpg','ready')", [ei]);
  var rec = await call(mgr, 'GET', '/api/inspections/' + insp[0].id + '/vehicle-record');
  eq('vehicle record loads for a manager', rec.status, 200);
  eq('damage on file: mark #1, confirmed, with its close-up', rec.body.marks.map(function (m) { return [m.mark_no, m.state, !!m.photo_url]; }), [[1, 'existing', true]]);
  eq('last signed sheet is the assignment, with its 8 slot photos', [rec.body.sheet.handoff_number, rec.body.sheet.kind, rec.body.sheet.photos.length], [S1.handoff_number, 'assign', 8]);
  eq('miles since the sheet', rec.body.sheet.miles_since, 0);
  eq('earlier inspections: only the flagged item, with its photo', rec.body.earlier.map(function (e) { return [e.inspection_number, e.items.map(function (i) { return i.label + ':' + i.severity + ':' + i.photos.length; })]; }), [['INS-TEST-0001', ['Tires:fail:1']]]);
  eq('the driver who submitted it can see it too', (await call(lock, 'GET', '/api/inspections/' + insp[0].id + '/vehicle-record')).status, 200);
  eq('another locksmith cannot', (await call(lock2, 'GET', '/api/inspections/' + insp[0].id + '/vehicle-record')).status, 403);
  var recEarly = await call(mgr, 'GET', '/api/inspections/' + ei + '/vehicle-record');
  eq('an older inspection does not list later ones as earlier', recEarly.body.earlier.length, 0);
  eq('unknown inspection is 404', (await call(mgr, 'GET', '/api/inspections/999999/vehicle-record')).status, 404);
  eq('a closed sheet cannot be voided', (await call(mgr, 'POST', API + '/' + S1.id + '/void', { reason: 'x' })).status, 403);
  eq('a closed sheet takes no marks', (await call(mgr, 'POST', API + '/' + S1.id + '/marks', { view: 'ds', x: 10, y: 10 })).status, 403);

  var vh = await call(viewer, 'GET', API + '/vehicle/' + vid);
  eq('vehicle page: one sheet, one history row, one open mark', [vh.body.sheets.length, vh.body.history.length, vh.body.marks.length], [1, 1, 1]);
  eq('vehicle page is gated', (await call(lock, 'GET', API + '/vehicle/' + vid)).status, 403);
  eq('vehicle page is city scoped', (await call(mgrTpa, 'GET', API + '/vehicle/' + vid)).status, 403);
  var all = await call(mgr, 'GET', '/api/vehicles/all');
  var row = (all.body || []).filter ? all.body.filter(function (v) { return v.id === vid; })[0] : null;
  eq('Fleet list shows no open sheet', row && row.open_handoff_id, null);

  // ---- Edit Vehicle guard ------------------------------------------------
  var vbody = { year: 2021, make_model: 'Chevy Express 2500', license_plate: 'VH-TEST', city_code: 'JAX', mileage: 45012 };
  var pm = await call(mgr, 'PUT', '/api/vehicles/' + vid, Object.assign({}, vbody, { assigned_user_id: lock2.id }));
  eq('a manager cannot swap the driver on Edit Vehicle', pm.status, 409);
  var pa = await call(admin, 'PUT', '/api/vehicles/' + vid, Object.assign({}, vbody, { assigned_user_id: lock2.id }));
  eq('an admin needs a reason', pa.status, 400);
  var same = await call(mgr, 'PUT', '/api/vehicles/' + vid, Object.assign({}, vbody, { assigned_user_id: lock.id, date_of_assignment: '2020-01-01', notes: 'Edited' }));
  eq('a manager can still edit other fields', same.status, 200);
  ok('but the manager cannot move the assignment date', String(same.body.date_of_assignment).slice(0, 10) !== '2020-01-01', same.body.date_of_assignment);
  var sameA = await call(admin, 'PUT', '/api/vehicles/' + vid, Object.assign({}, vbody, { assigned_user_id: lock.id, date_of_assignment: '2026-01-15' }));
  eq('an admin can correct the assignment date', String(sameA.body.date_of_assignment).slice(0, 10), '2026-01-15');
  var newVeh = await call(mgr, 'POST', '/api/vehicles', Object.assign({}, vbody, { license_plate: 'VH-NEW', assigned_user_id: lock2.id }));
  eq('a new vehicle from a manager never gets a driver', [newVeh.status, newVeh.body.assigned_user_id], [201, null]);

  // ---- turn-in, filled by the manager, reassign ----------------------------
  var t = await call(mgr, 'POST', API, { kind: 'turn_in', vehicle_id: vid, filled_by: 'manager', reason: 'reassignment', after_turn_in: 'reassign', reassign_to_user_id: lock2.id });
  eq('manager starts a turn-in they will fill', [t.status, t.body.status, t.body.kind], [200, 'in_progress', 'turn_in']);
  var S2 = t.body;
  ok('numbered VT-YYYY-0001', /^VT-\d{4}-0001$/.test(S2.handoff_number), S2.handoff_number);
  eq('driver is taken from Fleet', S2.driver_user_id, lock.id);
  eq('turn-in agreement frozen on', S2.agreements.map(function (a) { return a.agreement_name; }), ['Turn-In Acknowledgment']);
  eq('prior assignment linked', S2.prior_handoff_id, S1.id);
  ok('the turn-in carries the assignment it closes', !!S2.prior && S2.prior.handoff_number === S1.handoff_number, JSON.stringify(S2.prior && S2.prior.handoff_number));
  eq('with its readings', [S2.prior.odometer, S2.prior.fuel_level], [45012, '3/4']);
  eq('and one photo per slot (reshoots and close-ups left out)', S2.prior.photos.map(function (p) { return p.slot_key; }).sort(), S1.photo_slots.map(function (x) { return x.key; }).sort());
  ok('prior photos have URLs', S2.prior.photos.every(function (p) { return /r2\.test\/get\//.test(p.url); }));
  eq('an assignment sheet has no prior', (await call(mgr, 'GET', API + '/' + S1.id)).body.prior, null);
  var all2 = await call(mgr, 'GET', '/api/vehicles/all');
  eq('Fleet list shows the open turn-in', all2.body.filter(function (v) { return v.id === vid; })[0].open_handoff_kind, 'turn_in');
  eq('a driver swap is refused while a sheet is open, even for admin', (await call(admin, 'PUT', '/api/vehicles/' + vid, Object.assign({}, vbody, { assigned_user_id: null, override_reason: 'x' }))).status, 409);
  eq('the driver cannot fill a manager-filled sheet', (await call(lock, 'PUT', API + '/' + S2.id, { odometer: 1 })).status, 403);
  eq('it is not on the driver home card yet', (await call(lock, 'GET', API + '/mine')).body.length, 0);
  eq('the driver cannot sign it yet', (await call(lock, 'POST', API + '/' + S2.id + '/driver-sign', { consent: true, signature_data: SIG })).status, 403);

  await call(mgr, 'PUT', API + '/' + S2.id, { odometer: 46100, fuel_level: '1/2', checklist: allPresent(S2) });
  await shootAllSlots(mgr, S2);
  var ex = await call(mgr, 'PUT', API + '/' + S2.id + '/marks/' + M1.id, { change: 'repaired', change_note: 'Fixed at Maaco' });
  eq('manager records mark #1 as repaired', ex.status, 200);
  eq('a manager cannot move a mark from an earlier sheet', (await call(mgr, 'PUT', API + '/' + S2.id + '/marks/' + M1.id, { x: 20 })).status, 403);
  eq('nor delete it', (await call(mgr, 'DELETE', API + '/' + S2.id + '/marks/' + M1.id)).status, 403);
  var nm = await call(mgr, 'POST', API + '/' + S2.id + '/marks', { view: 'rear', x: 40, y: 50, kind: 'scratch' });
  var M2 = nm.body.marks.filter(function (m) { return m.mark_no === 2; })[0];
  eq('manager mark: #2, confirmed, red on a turn-in', [M2.origin, M2.confirmed, M2.state], ['manager', true, 'new']);
  var tmp = await call(mgr, 'POST', API + '/' + S2.id + '/marks', { view: 'top', x: 50, y: 30, kind: 'other' });
  var M3 = tmp.body.marks.filter(function (m) { return m.mark_no === 3; })[0];
  eq('a mark made on this sheet can be removed', (await call(mgr, 'DELETE', API + '/' + S2.id + '/marks/' + M3.id)).status, 200);
  await call(mgr, 'POST', API + '/' + S2.id + '/damage-reviewed');
  var sd = await call(mgr, 'POST', API + '/' + S2.id + '/send-to-driver');
  eq('manager hands it to the driver', [sd.status, sd.body.status], [200, 'awaiting_driver']);
  eq('now it is on the driver home card', (await call(lock, 'GET', API + '/mine')).body.map(function (s) { return s.id; }), [S2.id]);

  // Photo sent back: signature cleared, sheet returns to the driver.
  var S2d = (await call(lock, 'GET', API + '/' + S2.id)).body;
  await initialAll(lock, S2d, 'LK');
  await call(lock, 'POST', API + '/' + S2.id + '/driver-sign', { consent: true, signature_data: SIG });
  var cabin = S2d.photos.filter(function (p) { return p.slot_key === 'interior'; })[0];
  eq('a TPA manager cannot send a JAX photo back', (await call(mgrTpa, 'POST', API + '/photos/' + cabin.id + '/reject', { reason: 'x' })).status, 403);
  var rj = await call(mgr, 'POST', API + '/photos/' + cabin.id + '/reject', { reason: 'Blurry' });
  eq('a sent-back photo on a manager-filled sheet goes to the manager', [rj.status, rj.body.status, rj.body.has_driver_signature], [200, 'in_progress', false]);
  ok('the retake is owed', rj.body.missing_for_sign.indexOf('Retake the photo your manager sent back.') !== -1 || rj.body.missing_for_sign.some(function (m) { return m.indexOf('Interior') !== -1; }), JSON.stringify(rj.body.missing_for_sign));
  var rt = await shoot(mgr, S2.id, { slot_key: 'interior', replaces_photo_id: cabin.id });
  ok('after the retake nothing is owed', rt.body.missing_for_sign.length === 0, JSON.stringify(rt.body.missing_for_sign));
  await call(mgr, 'POST', API + '/' + S2.id + '/send-to-driver');
  var sg2 = await call(lock, 'POST', API + '/' + S2.id + '/driver-sign', { consent: true, signature_data: SIG });
  eq('the driver signs the turn-in', sg2.body.status, 'ready_for_review');
  var cs2a = await call(mgr, 'POST', API + '/' + S2.id + '/countersign', { signature_data: SIG });
  eq('a turn-in needs the manager damage check', cs2a.status, 400);
  ok('and says so', cs2a.body.error.indexOf('Damage checked') !== -1, cs2a.body.error);
  await call(mgr, 'POST', API + '/' + S2.id + '/damage-checked');
  var cs2 = await call(mgr, 'POST', API + '/' + S2.id + '/countersign', { signature_data: SIG });
  eq('turn-in countersigned', [cs2.status, cs2.body.status], [200, 'completed']);
  veh = (await pool.query('SELECT assigned_user_id, mileage FROM vehicles WHERE id = $1', [vid])).rows[0];
  eq('Fleet driver cleared, mileage updated', [veh.assigned_user_id, veh.mileage], [null, 46100]);
  hist = (await pool.query('SELECT user_id, end_date IS NOT NULL AS closed, end_odometer, turnin_handoff_id FROM vehicle_assignment_history WHERE vehicle_id = $1 ORDER BY id', [vid])).rows;
  eq('the history row is closed by the turn-in', hist.map(function (h) { return [h.user_id, h.closed, h.end_odometer, h.turnin_handoff_id]; }), [[lock.id, true, 46100, S2.id]]);
  var mk1 = (await pool.query('SELECT status FROM vehicle_damage_marks WHERE id = $1', [M1.id])).rows[0];
  eq('mark #1 is now repaired', mk1.status, 'repaired');
  var snap2 = (await pool.query('SELECT marks_snapshot, inspection_id, next_handoff_id FROM vehicle_handoffs WHERE id = $1', [S2.id])).rows[0];
  eq('snapshot shows repaired #1 and new #2', snap2.marks_snapshot.map(function (m) { return m.mark_no + ':' + m.state; }), ['1:repaired', '2:new']);
  eq('no second inspection this month', [(await pool.query('SELECT COUNT(*)::int AS n FROM vehicle_inspections WHERE vehicle_id = $1 AND period_month = $2', [vid, insp[0].period_month])).rows[0].n, snap2.inspection_id], [1, null]);
  ok('reassign chained a new assignment sheet', !!snap2.next_handoff_id);
  var S3 = (await call(lock2, 'GET', API + '/' + snap2.next_handoff_id)).body;
  eq('the next driver has it waiting', [S3.kind, S3.status, S3.driver_user_id, S3.prior_handoff_id], ['assign', 'awaiting_driver', lock2.id, S2.id]);

  // ---- void --------------------------------------------------------------
  var dm = await call(lock2, 'POST', API + '/' + S3.id + '/marks', { view: 'ps', x: 100, y: 40, kind: 'dent' });
  eq('the new driver adds a mark on the chained sheet', dm.status, 200);
  var fl = await call(lock2, 'POST', API + '/' + S3.id + '/flag', { reason: 'Van is not here' });
  eq('the driver flags it', fl.body.status, 'flagged');
  eq('void needs a reason', (await call(mgr, 'POST', API + '/' + S3.id + '/void', {})).status, 400);
  eq('a driver cannot void', (await call(lock2, 'POST', API + '/' + S3.id + '/void', { reason: 'x' })).status, 403);
  var vd = await call(mgr, 'POST', API + '/' + S3.id + '/void', { reason: 'Wrong van' });
  eq('the manager voids it', vd.body.status, 'voided');
  eq('marks from a voided sheet come off the record', (await pool.query('SELECT COUNT(*)::int AS n FROM vehicle_damage_marks WHERE created_handoff_id = $1', [S3.id])).rows[0].n, 0);
  var vt = (await call(mgr, 'GET', API + '?tab=voided')).body.sheets.map(function (s) { return s.id; });
  eq('the voided tab lists it (and the no-city van, admin only, is not in JAX)', vt, [S3.id]);

  // ---- admin override, then complete without the driver --------------------
  var ov = await call(admin, 'PUT', '/api/vehicles/' + vid, Object.assign({}, vbody, { assigned_user_id: lock2.id, override_reason: 'Handed keys over the phone' }));
  eq('admin override sets the driver', [ov.status, ov.body.assigned_user_id], [200, lock2.id]);
  var oh = (await pool.query("SELECT user_id, source, override_reason FROM vehicle_assignment_history WHERE vehicle_id = $1 AND source = 'override'", [vid])).rows;
  eq('override writes a history row with the reason', oh.map(function (h) { return [h.user_id, h.override_reason]; }), [[lock2.id, 'Handed keys over the phone']]);
  var oa = await pool.query("SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_type = 'vehicle' AND entity_id = $1", [vid]);
  ok('and is audited', oa.rows[0].n >= 1);

  var t4 = await call(mgr, 'POST', API, { kind: 'turn_in', vehicle_id: vid, reason: 'separation' });
  var S4 = t4.body;
  eq('turn-in waits on the driver by default', S4.status, 'awaiting_driver');
  eq('a van handed over by override has no assignment to compare against', [S4.prior_handoff_id, S4.prior], [null, null]);
  eq('assign sheets cannot be closed without the driver', (await call(mgr, 'POST', API + '/' + S3.id + '/complete-without-driver', { reason: 'x', signature_data: SIG })).status, 403);
  await call(mgr, 'PUT', API + '/' + S4.id, { odometer: 46200, fuel_level: 'F', checklist: allPresent(S4) });
  await shootAllSlots(mgr, S4);
  var cw0 = await call(mgr, 'POST', API + '/' + S4.id + '/complete-without-driver', { signature_data: SIG });
  eq('without the driver needs a reason', cw0.status, 400);
  var cw1 = await call(mgr, 'POST', API + '/' + S4.id + '/complete-without-driver', { reason: 'No-show', signature_data: SIG });
  eq('and the manager damage check', cw1.status, 400);
  await call(mgr, 'POST', API + '/' + S4.id + '/damage-checked');
  var cw = await call(mgr, 'POST', API + '/' + S4.id + '/complete-without-driver', { reason: 'No-show', signature_data: SIG });
  eq('turn-in completed without the driver', [cw.status, cw.body.status, cw.body.driver_not_present], [200, 'completed', true]);
  eq('Fleet cleared', (await pool.query('SELECT assigned_user_id FROM vehicles WHERE id = $1', [vid])).rows[0].assigned_user_id, null);
  eq('the sheet is gone from the driver home card', (await call(lock2, 'GET', API + '/mine')).body.length, 0);

  // ---- agreement library -------------------------------------------------
  eq('settings are closed to a viewer', (await call(viewer, 'GET', API + '/settings')).status, 403);
  eq('and to a manager (admin/owner only)', (await call(mgr, 'GET', API + '/settings')).status, 403);
  eq('a manager cannot save settings', (await call(mgr, 'PUT', API + '/settings', { photo_slots: [{ label: 'Front' }] })).status, 403);
  eq('a manager cannot add an agreement', (await call(mgr, 'POST', API + '/agreements', { name: 'X', statements: [{ title: 'A', body: 'B' }] })).status, 403);
  eq('a manager still sees live agreements to pick from', (await call(mgr, 'GET', API + '/config')).body.agreements.length >= 2, true);
  var set = await call(admin, 'GET', API + '/settings');
  var std = set.body.agreements.filter(function (a) { return a.name === 'Standard Vehicle Use Agreement'; })[0];
  eq('the standard agreement shows one signature', std.signed_count, 1);
  var newWords = std.statements.map(function (s) { return Object.assign({}, s); });
  newWords[1].body = newWords[1].body + ' This includes school zones.';
  var v2 = await call(admin, 'PUT', API + '/agreements/' + std.id, { statements: newWords });
  eq('new wording on a signed agreement is version 2', v2.body.version, 2);
  newWords[1].body = newWords[1].body + ' And work zones.';
  eq('editing v2 before anyone signs it stays v2', (await call(admin, 'PUT', API + '/agreements/' + std.id, { statements: newWords })).body.version, 2);
  eq('renaming alone does not bump the version', (await call(admin, 'PUT', API + '/agreements/' + std.id, { name: 'Vehicle Use Agreement' })).body.version, 2);
  var frozen = (await pool.query('SELECT version, statements FROM vehicle_handoff_agreements WHERE handoff_id = $1', [S1.id])).rows[0];
  eq('the signed sheet keeps version 1 wording', [frozen.version, frozen.statements[1].body.indexOf('school zones')], [1, -1]);
  eq('a signed agreement cannot be deleted', (await call(admin, 'DELETE', API + '/agreements/' + std.id)).status, 409);
  var arc = await call(admin, 'POST', API + '/agreements/' + std.id + '/archive');
  eq('it can be archived, which drops the default', [arc.body.status, arc.body.is_default], ['archived', false]);
  eq('an archived agreement cannot be edited', (await call(admin, 'PUT', API + '/agreements/' + std.id, { name: 'X' })).status, 409);
  eq('it can be restored', (await call(admin, 'POST', API + '/agreements/' + std.id + '/restore')).body.status, 'live');
  eq('a new agreement needs statements', (await call(admin, 'POST', API + '/agreements', { name: 'Empty' })).status, 400);
  var na = await call(admin, 'POST', API + '/agreements', { name: 'Tow hitch rules', use_on: 'both', statements: [{ title: 'Hitch', body: 'No towing without approval.' }] });
  eq('a new agreement starts as a draft', [na.status, na.body.status, na.body.statements[0].key], [200, 'draft', 'hitch']);
  var cp = await call(admin, 'POST', API + '/agreements/' + std.id + '/copy');
  eq('copy makes a non-default draft', [cp.body.status, cp.body.is_default, cp.body.version], ['draft', false, 1]);
  eq('an unsigned agreement can be deleted', (await call(admin, 'DELETE', API + '/agreements/' + na.body.id)).status, 200);
  var live = await call(admin, 'PUT', API + '/agreements/' + cp.body.id, { status: 'live' });
  eq('a draft can go live', live.body.status, 'live');
  var picked = await call(mgr, 'POST', API, { kind: 'assign', vehicle_id: vid, driver_user_id: lock.id, agreement_ids: [cp.body.id] });
  eq('a sheet can carry a picked agreement', picked.body.agreements.map(function (a) { return a.agreement_id; }), [cp.body.id]);
  eq('an agreement on an open sheet cannot be deleted', (await call(admin, 'DELETE', API + '/agreements/' + cp.body.id)).status, 409);
  await call(mgr, 'POST', API + '/' + picked.body.id + '/void', { reason: 'test' });

  // ---- settings: photo slots and checklist -----------------------------------
  eq('an empty slot list is refused', (await call(admin, 'PUT', API + '/settings', { photo_slots: [] })).status, 400);
  eq('a nameless checklist item is refused', (await call(admin, 'PUT', API + '/settings', { checklist: [{ label: '' }] })).status, 400);
  var ns = await call(admin, 'PUT', API + '/settings', { photo_slots: [{ label: 'Front' }, { label: 'Ladder rack', required: false }] });
  eq('slots saved and keyed', ns.body.photo_slots.map(function (s) { return s.key + ':' + s.required; }), ['front:true', 'ladder_rack:false']);
  var S5 = (await call(mgr, 'POST', API, { kind: 'assign', vehicle_id: vid, driver_user_id: lock.id })).body;
  eq('new sheets use the new slots', S5.photo_slots.length, 2);
  eq('old sheets keep theirs', (await call(mgr, 'GET', API + '/' + S1.id)).body.photo_slots.length, 8);
  await call(mgr, 'POST', API + '/' + S5.id + '/void', { reason: 'test' });

  // ---- the reminder job's claim ---------------------------------------------
  var jobInternal = require('./routes/vehicleHandoffs')._internal;
  ok('the job hooks are exported', typeof jobInternal.finalize === 'function' && typeof jobInternal.notifyUser === 'function');
  var jobs = require('./jobs/vehicleHandoffs');
  ok('the reminder job exports its starter', typeof jobs.startVehicleSheetReminders === 'function');

  // ---- cleanup -----------------------------------------------------------
  await new Promise(function (r) { server.close(r); });
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
