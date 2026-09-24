// Vehicle assignment & turn-in sheets: the real screens against the real server.
//
// public/js/vehicleHandoffs.js is a classic script, so it is evaluated inside a
// jsdom window with the globals app.js normally provides (api, state, can,
// escHtml, navigate, showToast, novaConfirm/novaPrompt/novaAlert) and releases.js's
// novaSigPad replaced by small stand-ins. Unlike test-licensing-dom.js, api()
// is NOT answered from fixtures: it goes over HTTP to the real routers behind
// the real requireAuth on a real Postgres, as whichever user the step is acting
// as. So every click below is the screen and the server agreeing, not the screen
// agreeing with a fixture somebody typed.
//
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-vehicle-handoffs-dom.js
//
// Note: jsdom serialises innerHTML, so &#39; written by the screen reads back
// as a plain apostrophe in the assertions below.
//
// The one thing it cannot drive is the camera (jsdom has no getUserMedia), so
// photos are shot through the same two API calls the camera makes, then the
// screen is redrawn from the server.
//
// Needs jsdom (npm i --no-save jsdom), like the other *-dom.js tests.
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-vehicle-handoffs-dom';

const fs = require('fs');
const path = require('path');
const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');

// Stubs for the outside world, installed before any route is required.
var r2 = require('./utils/r2');
r2.configured = function () { return true; };
r2.presignUpload = async function (key) { return 'https://r2.test/put/' + key; };
r2.presignDownload = async function (key) { return 'https://r2.test/get/' + key; };
r2.headObject = async function () { return { size: 2048 }; };
r2.putObject = async function () {};
r2.getObjectBuffer = async function () { return null; };
require('./utils/push').sendPushToUsers = async function () {};
require('./utils/sms').sendSms = async function () {};
require('./utils/email').sendEmail = async function () {};

const { initDB, pool } = require('./db');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function has(name, hay, needle) { ok(name, String(hay).indexOf(needle) !== -1, 'missing: ' + needle); }
function hasnt(name, hay, needle) { ok(name, String(hay).indexOf(needle) === -1, 'unexpectedly present: ' + needle); }

var SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
var base = '';
var PERMS = {};

function tokenFor(u) {
  return jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
async function http(u, method, p, body) {
  const res = await fetch(base + '/api' + p, {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + tokenFor(u) }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var json = null;
  try { json = await res.json(); } catch (_) {}
  if (!res.ok) { var e = new Error((json && json.error) || ('HTTP ' + res.status)); e.status = res.status; throw e; }
  return json;
}
async function mkUser(name, role) {
  var em = name.toLowerCase().replace(/[^a-z]/g, '') + '@vhdom.local';
  const r = await pool.query("INSERT INTO users (email, name, password_hash, role, active, session_epoch) VALUES ($1,$2,'x',$3,true,0) RETURNING id", [em, name, role]);
  return { id: r.rows[0].id, name: name, email: em, role: role };
}
async function shoot(u, sheetId, body) {
  var s = await http(u, 'POST', '/vehicle-handoffs/' + sheetId + '/photos/shoot', body);
  return http(u, 'POST', '/vehicle-handoffs/photos/' + s.photo_id + '/confirm', {});
}

// ---- the browser --------------------------------------------------------------
var w, el, navs = [], toasts = [], errors = [];
function bootWindow() {
  var dom = new JSDOM('<!doctype html><html><head></head><body><div id="content"></div></body></html>', { runScripts: 'outside-only', url: 'https://nova.test/' });
  w = dom.window;
  el = w.document.getElementById('content');
  w.addEventListener('error', function (e) { errors.push(String(e.message || e)); });
  w.__user = null;
  w.state = { user: null };
  w.api = function (method, p, body) { return http(w.__user, method, p, body); };
  w.can = function (perm) {
    var u = w.__user;
    if (!u) return false;
    if (u.role === 'admin' || u.role === 'owner') return true;
    return (PERMS[u.role] || []).indexOf(perm) !== -1;
  };
  w.escHtml = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
  w.navigate = function (view, param) { navs.push([view, param]); };
  w.showToast = function (m, t) { toasts.push([t || 'success', m]); };
  w.__prompt = '';
  w.novaPrompt = function () { return Promise.resolve(w.__prompt); };
  w.novaConfirm = function () { return Promise.resolve(true); };
  w.novaAlert = function () { return Promise.resolve(); };
  w.__sig = null;
  w.novaSigPad = function (o) { w.__sig = Promise.resolve(o.onApply(SIG)); };
  w.inspPerceptualHash = function () { return '0123456789abcdef'; };
  w.scrollTo = function () {};
  // The screens this module wraps, as minimal stand-ins, defined BEFORE the
  // script loads (it captures them at load time, as it does after app.js).
  w.renderVehicleHistory = async function (host) { host.innerHTML = '<div class="page-header">History</div><div id="old-history">old</div>'; };
  w.renderHomeScreen = async function (host) { host.innerHTML = '<div class="page-header">Home</div>'; };
  // Minimal stand-in for app.js renderViewInspection: header, info card, Checklist card.
  w.renderViewInspection = async function (host) {
    w._inspLabelOf = { front: 'Front', tires: 'Tires' };
    host.innerHTML = '<div class="page-header">Inspection</div><div class="card"><div class="card-body">info</div></div>' +
      '<div class="card" id="insp-checklist"><div class="card-header"><span class="card-title">Checklist</span></div><div class="card-body">items</div></div>';
  };
  w.renderEditVehicle = async function (host) { host.innerHTML = '<div class="form-group"><select id="ve-driver"><option value="">-</option><option value="7" selected>X</option><option value="8">Y</option></select></div>'; };
  w.eval(fs.readFileSync(path.join(__dirname, 'public/js/vehicleHandoffs.js'), 'utf8'));
}
function as(u) { w.__user = u; w.state.user = { id: u.id, name: u.name, role: u.role }; }
function html() { return el.innerHTML; }
function errToasts() { return toasts.filter(function (t) { return t[0] === 'error'; }).map(function (t) { return t[1]; }); }

async function main() {
  await initDB();
  await pool.query("DELETE FROM users WHERE email LIKE '%@vhdom.local'");
  var admin = await mkUser('Ada Admin', 'admin');
  var mgr = await mkUser('Mona Manager', 'manager');
  var lock = await mkUser('Lee O\'Neil <b>', 'locksmith');
  var lock2 = await mkUser('Sam Second', 'locksmith');
  var tpaTech = await mkUser('Tia Tampa', 'locksmith');
  await pool.query("INSERT INTO user_cities (user_id, city_code) VALUES ($1,'JAX')", [mgr.id]);
  await pool.query("UPDATE users SET home_city = 'TPA' WHERE id = $1", [tpaTech.id]);
  PERMS = {
    manager: ['view_vehicle_handoffs', 'manage_vehicle_handoffs', 'manage_vehicles', 'view_users', 'view_inspections'],
    locksmith: []
  };
  await pool.query("INSERT INTO settings (key, value) VALUES ('role_permissions', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(PERMS)]);
  await pool.query("DELETE FROM settings WHERE key IN ('vehicle_sheet_photo_slots','vehicle_sheet_checklist')");
  var vq = await pool.query("INSERT INTO vehicles (year, make_model, license_plate, city_code, mileage) VALUES (2022, 'Chevy Express <img src=x onerror=alert(1)>', 'DOM-1', 'JAX', 12000) RETURNING id");
  var vid = vq.rows[0].id;
  var tpaVid = (await pool.query("INSERT INTO vehicles (year, make_model, license_plate, city_code, mileage) VALUES (2020, 'Chevy Express 3500', 'TPA-1', 'TPA', 30000) RETURNING id")).rows[0].id;

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/vehicle-handoffs', require('./routes/vehicleHandoffs'));
  app.use('/api/vehicles', require('./routes/vehicles'));
  app.use('/api/inspections', require('./routes/inspections'));
  app.use('/api/users', require('./routes/users'));
  app.use(function (err, req, res, _next) { console.error(err); res.status(500).json({ error: 'Internal server error' }); });
  const server = await new Promise(function (resolve) { const s = app.listen(0, '127.0.0.1', function () { resolve(s); }); });
  base = 'http://127.0.0.1:' + server.address().port;

  bootWindow();

  // ---- manager: queue and start ----------------------------------------------
  as(mgr);
  await w.renderVehicleHandoffs(el);
  has('queue renders', html(), 'Vehicle Assignments');
  has('a manager sees Start sheet', html(), '+ Start sheet');
  has('empty queue says how to start', html(), 'Nothing here');

  await w.vhStart('assign', vid);
  var modal = w.document.getElementById('vh-modal');
  ok('the start dialog opens', !!modal);
  has('the dialog names the vehicle, escaped', modal.innerHTML, '&lt;img src=x');
  hasnt('and never renders the raw tag', modal.innerHTML, '<img src=x');
  var drvSel = w.document.getElementById('vh-start-driver');
  ok('the driver list has the locksmith', !!drvSel && Array.prototype.some.call(drvSel.options, function (o) { return o.value === String(lock.id); }));
  var agBoxes = w.document.querySelectorAll('.vh-ag');
  eq('the default assign agreement is pre-ticked, turn-in one is not', Array.prototype.map.call(agBoxes, function (b) { return b.checked; }), [true, false]);
  ok('drivers based in another city are left out', !Array.prototype.some.call(drvSel.options, function (o) { return o.value === String(tpaTech.id); }));
  drvSel.value = String(lock.id);
  w.document.getElementById('vh-start-note').value = 'Keys in the lockbox';
  await w.vhStartGo('assign');
  var last = navs[navs.length - 1];
  eq('Start sheet opens the new sheet', last && last[0], 'vehicle-handoff');
  ok('and closes the dialog', !w.document.getElementById('vh-modal'));
  var sheetId = last[1];

  await w.renderVehicleHandoff(el, sheetId);
  has('manager sheet renders', html(), 'Vehicle Assignment');
  has('it is waiting on the driver', html(), 'Waiting on Lee O\'Neil &lt;b&gt;');
  hasnt('the driver name is escaped everywhere', html(), 'O\'Neil <b>');
  has('the back button goes to the queue', html(), 'navigate(\'vehicle-handoffs\')');
  has('the note shows', html(), 'Keys in the lockbox');
  has('five tabs', html(), 'Review &amp; sign');

  // ---- driver: the phone flow ----------------------------------------------------
  as(lock);
  navs = [];
  await w.renderVehicleHandoff(el, sheetId);
  eq('a driver sent to the manager view is bounced to their own', navs[0], ['vehicle-sheet', sheetId]);
  await w.renderVehicleSheet(el, sheetId);
  has('driver sheet renders', html(), 'Your vehicle sheet');
  var stepCount = (html().match(/vhDrvStep\('/g) || []).length;
  eq('six steps', stepCount, 6);
  has('there is a way to flag a problem', html(), 'Something is wrong');

  w.vhDrvStep('readings');
  var odo = w.document.getElementById('vh-odo');
  ok('odometer box on the readings step', !!odo);
  odo.value = '12345';
  w.document.getElementById('vh-fuel').value = '1/2';
  await w.vhSaveReadings();
  var srv = await http(mgr, 'GET', '/vehicle-handoffs/' + sheetId);
  eq('readings reached the server', [srv.odometer, srv.fuel_level, srv.status], [12345, '1/2', 'in_progress']);

  for (var i = 0; i < srv.photo_slots.length; i++) await shoot(lock, sheetId, { slot_key: srv.photo_slots[i].key });
  await w.renderVehicleSheet(el, sheetId);
  w.vhDrvStep('photos');
  eq('all eight tiles now say Reshoot', (html().match(/>Reshoot</g) || []).length, 8);

  w.vhDrvStep('damage');
  ok('the diagram is drawn', !!w.document.getElementById('vh-diagram'));
  has('damage tools are offered', html(), 'Scratch / scuff');
  w.eval("_vh.tool = 'scratch'");
  await w.vhAddMark({ view: 'ps', x: 60, y: 30 });
  has('the new mark opens its editor', html(), 'Mark #1');
  has('with a close-up button', html(), 'Take close-up');
  hasnt('a driver never sees Confirm', html(), 'Confirm this damage');
  var markId = w.eval('_vh.selMark');
  ok('the new mark is selected', !!markId);
  var d1 = await shoot(lock, sheetId, { mark_id: markId });
  w.eval('_vh.sheet = ' + JSON.stringify(d1) + '; vhRedraw();');
  await w.vhDamageReviewed();
  has('damage step records the check', html(), 'Damage checked');

  var nItems = w.eval('_vh.sheet.checklist.length');
  for (var c = 0; c < nItems; c++) await w.vhCheck(c, 'present');
  w.vhDrvStep('checklist');
  eq('every item shows Present', (html().match(/background:#0d2d17;color:#86efac;font-weight:600">Present/g) || []).length, nItems);

  w.vhDrvStep('agreement');
  eq('five statements to initial', (html().match(/Tap to initial/g) || []).length, 5);
  has('the camera statement says it records audio', html(), 'records video, audio');
  w.eval("_vh.initials = 'LO'");
  var ags = w.eval('JSON.stringify(_vh.sheet.agreements)');
  ags = JSON.parse(ags);
  for (var j = 0; j < ags[0].statements.length; j++) await w.vhInitial(ags[0].id, ags[0].statements[j].key, false);
  eq('all five show the initials', (html().match(/>LO<\/span>/g) || []).length, 5);

  w.vhDrvStep('sign');
  has('nothing left before signing', html(), 'Everything is done');
  w.vhDriverSign();
  eq('signing without the box is stopped', errToasts().slice(-1)[0], 'Tick the box first.');
  w.document.getElementById('vh-consent').checked = true;
  w.vhDriverSign();
  await w.__sig;
  has('after signing the driver sees the wait', html(), 'Waiting for Mona Manager to countersign');

  // ---- manager: review and countersign ----------------------------------------
  as(mgr);
  await w.renderVehicleHandoff(el, sheetId);
  w.vhMgrTab('damage');
  has('the damage tab counts the mark to confirm', html(), '1 to confirm');
  w.vhSelMark(markId);
  has('the manager can confirm a driver mark at review', html(), 'Confirm this damage');
  has('or remove it', html(), 'Remove mark');
  await w.vhMarkPatch(markId, { confirmed: true });
  hasnt('confirmed marks leave the to-confirm count', html(), 'to confirm');
  w.vhMgrTab('review');
  has('countersign is offered', html(), 'Countersign &amp; assign');
  has('it says what countersigning does', html(), 'counts as this month\'s inspection');
  w.vhCountersign();
  await w.__sig;
  has('completed banner', html(), 'is now the responsible employee');
  has('PDF button', html(), 'Open signed PDF');
  var veh = (await pool.query('SELECT assigned_user_id FROM vehicles WHERE id = $1', [vid])).rows[0];
  eq('Fleet changed', veh.assigned_user_id, lock.id);

  // ---- inspection review aid ------------------------------------------------
  var iid = (await pool.query('SELECT id FROM vehicle_inspections WHERE vehicle_id = $1', [vid])).rows[0].id;
  await pool.query("INSERT INTO inspection_photos (inspection_id, item_key, name, r2_key, status) VALUES ($1,'front','f.jpg','inspections/dom/f.jpg','ready')", [iid]);
  await w.renderViewInspection(el, iid);
  var recCard = w.document.getElementById('vh-insp-record');
  ok('the inspection gets a Vehicle record card', !!recCard);
  ok('placed above the Checklist', recCard && recCard.nextElementSibling && recCard.nextElementSibling.id === 'insp-checklist');
  has('damage on file is listed with the diagram', recCard.innerHTML, 'DAMAGE ON FILE (1)');
  ok('diagram drawn', !!w.document.getElementById('vh-insp-diagram'));
  has('the last signed sheet is linked', recCard.innerHTML, srv.handoff_number);
  eq('its eight photos are shown', (recCard.innerHTML.match(/cursor:zoom-in" onclick="vhViewPhoto/g) || []).length >= 8, true);
  has('Side by side is offered', recCard.innerHTML, 'Side by side');
  w.vhInspCompare();
  var right = w.document.getElementById('vh-cmp-right'), left = w.document.getElementById('vh-cmp-left');
  ok('the viewer opens with both sides', !!right && !!left);
  eq('right side offers only this inspection', right.options.length, 1);
  var leftPic = w.eval('_vh.insPics[' + left.value + ']');
  eq('left jumps to the same angle (Front with Front)', [leftPic.label, leftPic.mine], ['Front', undefined]);
  has('both images render', w.document.getElementById('vh-cmp-left-img').innerHTML + w.document.getElementById('vh-cmp-right-img').innerHTML, 'r2.test/get/');
  w.vhModalClose();
  eq('no error toasts on the happy path', errToasts().filter(function (m) { return m !== 'Tick the box first.'; }), []);

  // ---- vehicle history, Fleet row, Edit Vehicle ------------------------------------
  await w.renderVehicleHistory(el, vid);
  has('history keeps the original page', html(), 'old-history');
  has('adds Assignment sheets', html(), 'Assignment sheets');
  has('lists the sheet', html(), srv.handoff_number);
  has('adds Who had it', html(), 'signed sheet');
  has('draws current damage', html(), 'vh-hist-diagram');
  has('offers Turn in (van is assigned)', html(), 'vhStart(\'turn_in\'');

  var fleet = await http(mgr, 'GET', '/vehicles/all');
  var row = fleet.filter(function (v) { return v.id === vid; })[0];
  has('Fleet row offers Turn in', w.vhRowActions(row), 'Turn in');
  eq('no pill without an open sheet', w.vhDriverPill(row), '');

  await w.renderEditVehicle(el, vid);
  ok('a manager gets a locked driver select', w.document.getElementById('ve-driver').disabled === true);
  as(admin);
  await w.renderEditVehicle(el, vid);
  var sel = w.document.getElementById('ve-driver');
  var reason = w.document.getElementById('ve-driver-reason');
  ok('an admin keeps the select and gets a hidden reason box', sel.disabled === false && !!reason && reason.style.display === 'none');
  sel.value = '8';
  sel.dispatchEvent(new w.Event('change'));
  eq('changing the driver shows the reason box', reason.style.display, 'block');

  // ---- turn-in started: Fleet pill, Home card ------------------------------------
  as(mgr);
  await http(mgr, 'POST', '/vehicle-handoffs', { kind: 'turn_in', vehicle_id: vid, reason: 'reassignment' });
  fleet = await http(mgr, 'GET', '/vehicles/all');
  row = fleet.filter(function (v) { return v.id === vid; })[0];
  has('Fleet row says Open sheet', w.vhRowActions(row), 'Open sheet');
  has('with a Turn-in started pill', w.vhDriverPill(row), 'Turn-in started');
  var tpaRow = fleet.filter(function (v) { return v.id === tpaVid; })[0];
  eq('no Assign button on another city\'s van', w.vhRowActions(tpaRow), '');
  as(admin);
  w.eval('_vh.cfg = null');
  await w.vhConfig();
  has('admin gets Assign on any city', w.vhRowActions(tpaRow), 'Assign');
  as(mgr);
  w.eval('_vh.cfg = null');
  await w.vhConfig();

  // Turn-in: same angle side by side with the assignment it closes.
  var tiId = row.open_handoff_id;
  for (var k = 0; k < srv.photo_slots.length - 1; k++) await shoot(mgr, tiId, { slot_key: srv.photo_slots[k].key });
  await http(mgr, 'PUT', '/vehicle-handoffs/' + tiId, { odometer: 13000 });
  await w.renderVehicleHandoff(el, tiId);
  has('turn-in photos are paired', html(), 'At assignment vs. turn-in');
  has('against the assignment sheet', html(), 'Compared with ' + srv.handoff_number);
  eq('one pair per slot', (html().match(/class="vh-pair"/g) || []).length, srv.photo_slots.length);
  eq('each pair shows the assignment photo', (html().match(/at assignment" style/g) || []).length, srv.photo_slots.length);
  has('readings show the assignment odometer and miles driven', html(), '+655 mi');
  as(lock);
  await w.renderHomeScreen(el);
  has('the driver gets a Home card', html(), 'Turn in your vehicle');
  as(lock2);
  await w.renderHomeScreen(el);
  hasnt('nobody else does', html(), 'Turn in your vehicle');

  // ---- settings (admin/owner only) --------------------------------------------
  as(mgr);
  await w.renderVehicleHandoffs(el);
  hasnt('a manager gets no Settings button', html(), 'vehicle-sheet-settings');
  has('but can still start a sheet', html(), '+ Start sheet');
  await w.renderVehicleSheetSettings(el);
  has('a manager who opens the link is told who manages it', html(), 'managed by an admin or owner');
  as(admin);
  await w.renderVehicleHandoffs(el);
  has('admin gets the Settings button', html(), 'vehicle-sheet-settings');
  await w.renderVehicleSheetSettings(el);
  has('settings open on photo slots', html(), 'Photo slots');
  has('the slots are listed', html(), 'Odometer / dash');
  w.vhSetTab('checklist');
  has('checklist tab', html(), 'Fire extinguisher');
  w.vhSetTab('agreements');
  has('agreement library lists the standard agreement', html(), 'Standard Vehicle Use Agreement');
  has('and the turn-in one', html(), 'Turn-In Acknowledgment');
  w.vhSetTab('diagrams');
  has('diagrams tab shows the Express', html(), 'Chevy Express');

  eq('no script errors in the window', errors, []);

  await new Promise(function (r) { server.close(r); });
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
