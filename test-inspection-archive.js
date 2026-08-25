// test-inspection-archive.js
// Inspection checklist retirement.
//
// The bug this locks down: removing items from the checklist used to set
// active = false and leave them in inspection_checklist, and the editor loaded
// with ?all=1 - so reopening the page showed every item ever created, and saving
// from that screen turned them all back on. Removed items now move to
// inspection_checklist_archive and leave the live table entirely.
//
// Run with a real, EMPTY Postgres:
//   DATABASE_URL=postgresql://... node test-inspection-archive.js
//
// Nothing inbound is mocked: db.js, the migration and the Express routes are the
// real ones and the HTTP requests are real. Only outbound edges (audit, R2, the
// SOP reindex) and the auth middleware are stubbed.

const Module = require('module');
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

const AUDIT = [];
let CURRENT_USER = { id: 1, name: 'Tony McKeon', role: 'admin' };
let CURRENT_PERMS = null;   // null = allow everything

const STUBS = {
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
  '../utils/audit': { logAudit: async function (a) { AUDIT.push(a); } },
  '../utils/r2': { configured: function () { return false; }, presignDownload: async function () { return null; }, presignUpload: async function () { return null; }, deleteObject: async function () {} },
  './utils/sopIndex': { reindexSop: async function () {} }
};
const _load = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request) && STUBS[request]) return STUBS[request];
  return _load.apply(this, arguments);
};

const { pool, initDB } = require('./db');
const express = require('express');
const inspectionsRouter = require('./routes/inspections');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/inspections', inspectionsRouter);
let server, BASE;

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, body: data };
}

async function liveKeys() {
  const { rows } = await pool.query('SELECT item_key FROM inspection_checklist ORDER BY sort_order, id');
  return rows.map(function (r) { return r.item_key; });
}
async function archiveKeys() {
  const { rows } = await pool.query('SELECT item_key FROM inspection_checklist_archive ORDER BY id');
  return rows.map(function (r) { return r.item_key; });
}
function opt(label, color, followup) { return { label: label, color: color, followup: !!followup }; }
const THREE = [
  { item_key: 'tires', label: 'Tires and tread depth', type: 'dropdown', requires_photo: true, options: [opt('Good', 'green'), opt('Low tread', 'yellow', true), opt('Needs replacement', 'red', true)] },
  { item_key: '', label: 'Emergency brake', type: 'dropdown', requires_photo: false, options: [opt('Holds', 'green'), opt('Does not hold', 'red', true)] },
  { item_key: '', label: 'Key machines secured', type: 'dropdown', requires_photo: false, options: [opt('Secured', 'green'), opt('Not secured', 'red', true)] }
];

(async function main() {
  server = app.listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  BASE = 'http://127.0.0.1:' + server.address().port + '/api';

  try {
    section('Migration: the archive table and the one-time move');
    await initDB();
    var live = await liveKeys();
    ok('initDB seeds the default checklist', live.length === 12, live.length + ' items');
    eq('archive starts empty', (await archiveKeys()).length, 0);

    // Recreate the old world: two items "removed" the way the previous code did it.
    await pool.query("UPDATE inspection_checklist SET active = false WHERE item_key IN ('brakes','lights')");
    await initDB();   // idempotent, and carries the one-time move
    live = await liveKeys();
    var arch = await archiveKeys();
    eq('deactivated items leave the live table', live.length, 10);
    ok('brakes is gone from the checklist', live.indexOf('brakes') === -1);
    ok('lights is gone from the checklist', live.indexOf('lights') === -1);
    eq('both landed in the archive', arch.length, 2);
    ok('archive holds brakes and lights', arch.indexOf('brakes') !== -1 && arch.indexOf('lights') !== -1, arch.join(','));

    await initDB();   // a third run must not duplicate anything
    eq('migration is idempotent', (await archiveKeys()).length, 2);

    section('The resurrection bug');
    var r = await req('GET', '/inspections/checklist');
    eq('GET /checklist returns the live items', r.body.length, 10);
    r = await req('GET', '/inspections/checklist?all=1');
    eq('the old ?all=1 flag cannot pull retired items back', r.body.length, 10);

    section('Saving retires what was removed');
    r = await req('PUT', '/inspections/checklist', { items: THREE });
    eq('save succeeds', r.status, 200);
    eq('save reports 3 items kept', r.body.items, 3);
    eq('save reports 9 retired', r.body.retired, 9);

    r = await req('GET', '/inspections/checklist');
    eq('reopening the editor shows exactly what was saved', r.body.length, 3);
    eq('order follows the saved order', r.body.map(function (i) { return i.label; }).join(' | '),
       'Tires and tread depth | Emergency brake | Key machines secured');
    eq('a blank item_key is derived from the label', r.body[1].item_key, 'emergency_brake');
    eq('photo flag survives the round trip', r.body[0].requires_photo, true);
    eq('follow-up flag survives the round trip', r.body[0].options[1].followup, true);
    eq('colors survive the round trip', r.body[0].options[2].color, 'red');

    arch = await archiveKeys();
    eq('everything removed is in the archive', arch.length, 11);
    ok('nothing is in both places', arch.filter(function (k) { return r.body.some(function (i) { return i.item_key === k; }); }).length === 0);
    const { rows: who } = await pool.query("SELECT retired_by, retired_by_name FROM inspection_checklist_archive WHERE item_key = 'seatbelts'");
    eq('the archive records who retired it', who[0].retired_by_name, 'Tony McKeon');
    eq('and their id', who[0].retired_by, 1);

    section('Saving again is not destructive');
    r = await req('PUT', '/inspections/checklist', { items: THREE });
    eq('a no-change save retires nothing', r.body.retired, 0);
    eq('archive is unchanged', (await archiveKeys()).length, 11);
    eq('checklist is unchanged', (await liveKeys()).length, 3);

    section('Re-adding a retired item clears it from the archive');
    var withBrakes = THREE.concat([{ item_key: 'brakes', label: 'Brakes', type: 'dropdown', requires_photo: false, options: [opt('OK', 'green'), opt('Fail', 'red', true)] }]);
    r = await req('PUT', '/inspections/checklist', { items: withBrakes });
    eq('brakes is live again', (await liveKeys()).indexOf('brakes') >= 0, true);
    eq('brakes is no longer restorable', (await archiveKeys()).indexOf('brakes'), -1);
    eq('archive shrank by one', (await archiveKeys()).length, 10);

    section('A save can never empty the checklist');
    r = await req('PUT', '/inspections/checklist', { items: [] });
    eq('empty list is refused', r.status, 400);
    eq('checklist untouched', (await liveKeys()).length, 4);
    r = await req('PUT', '/inspections/checklist', { items: [{ label: '   ' }, { label: '' }] });
    eq('all-blank list is refused', r.status, 400);
    eq('checklist still untouched', (await liveKeys()).length, 4);
    r = await req('PUT', '/inspections/checklist', {});
    eq('missing items array is refused', r.status, 400);

    section('Restore');
    const { rows: pick } = await pool.query("SELECT id, item_key, options FROM inspection_checklist_archive WHERE item_key = 'exterior'");
    var archId = pick[0].id;
    r = await req('POST', '/inspections/checklist/archive/' + archId + '/restore', {});
    eq('restore succeeds', r.status, 200);
    var restored = (await req('GET', '/inspections/checklist')).body;
    eq('the item is back on the checklist', restored.length, 5);
    eq('it comes back at the bottom', restored[restored.length - 1].item_key, 'exterior');
    ok('its options came back as JSON, not a Postgres array literal',
      Array.isArray(restored[restored.length - 1].options), JSON.stringify(restored[restored.length - 1].options));
    eq('option labels survived', restored[restored.length - 1].options[0].label, 'OK');
    eq('option colors survived', restored[restored.length - 1].options[2].color, 'red');
    eq('it left the archive', (await archiveKeys()).indexOf('exterior'), -1);
    r = await req('POST', '/inspections/checklist/archive/' + archId + '/restore', {});
    eq('restoring it twice is a 404', r.status, 404);

    // A retired key that has since been recreated by hand must not collide.
    const { rows: dup } = await pool.query("SELECT id FROM inspection_checklist_archive WHERE item_key = 'wipers'");
    await pool.query("INSERT INTO inspection_checklist (item_key, label, type, sort_order, requires_photo, active) VALUES ('wipers','Wipers','dropdown',99,false,true)");
    r = await req('POST', '/inspections/checklist/archive/' + dup[0].id + '/restore', {});
    eq('restoring onto a live key is refused', r.status, 409);
    ok('and says why', /already active/.test((r.body || {}).error || ''), (r.body || {}).error);
    await pool.query("DELETE FROM inspection_checklist WHERE item_key = 'wipers'");

    r = await req('POST', '/inspections/checklist/archive/999999/restore', {});
    eq('restoring a missing id is a 404', r.status, 404);
    r = await req('POST', '/inspections/checklist/archive/abc/restore', {});
    eq('a junk id is a 400, not a 500', r.status, 400);

    section('Delete forever');
    var before = (await archiveKeys()).length;
    r = await req('DELETE', '/inspections/checklist/archive/' + dup[0].id);
    eq('delete succeeds', r.status, 200);
    eq('archive shrank', (await archiveKeys()).length, before - 1);
    r = await req('DELETE', '/inspections/checklist/archive/' + dup[0].id);
    eq('deleting it twice is a 404', r.status, 404);

    section('Permissions');
    CURRENT_PERMS = ['view_inspections'];
    eq('reading the checklist needs only view', (await req('GET', '/inspections/checklist')).status, 200);
    eq('the retired list needs manage', (await req('GET', '/inspections/checklist/archive')).status, 403);
    eq('saving needs manage', (await req('PUT', '/inspections/checklist', { items: THREE })).status, 403);
    eq('restoring needs manage', (await req('POST', '/inspections/checklist/archive/1/restore', {})).status, 403);
    eq('deleting needs manage', (await req('DELETE', '/inspections/checklist/archive/1')).status, 403);
    CURRENT_PERMS = null;

    section('Submitted inspections are untouched by any of this');
    await pool.query("INSERT INTO users (id, name, email, password_hash, role) VALUES (1,'Tony McKeon','tony@example.com','x','admin') ON CONFLICT (id) DO NOTHING");
    const { rows: veh } = await pool.query(
      "INSERT INTO vehicles (year, make_model, license_plate, city_code, active) VALUES (2021,'Ford Transit','ABC1234','TPA',true) RETURNING id"
    );
    const { rows: ins } = await pool.query(
      "INSERT INTO vehicle_inspections (inspection_number, vehicle_id, period_month, submitted_by, city_code, mileage, status, overall_result) " +
      "VALUES ('INS-2026-9001', $1, '2026-07', 1, 'TPA', 84000, 'submitted', 'fail') RETURNING id", [veh[0].id]
    );
    // 'seatbelts' was retired several saves ago and no longer exists anywhere live.
    await pool.query(
      "INSERT INTO inspection_items (inspection_id, item_key, label, answer, color, comment) VALUES " +
      "($1,'seatbelts','Seatbelts','Fail','red','Driver belt frays at the latch'), " +
      "($1,'tires','Tires and tread depth','Low tread','yellow','Front left at 3/32')", [ins[0].id]
    );
    ok('the retired key really is gone from both tables',
      (await liveKeys()).indexOf('seatbelts') === -1 && (await archiveKeys()).indexOf('seatbelts') !== -1);

    r = await req('GET', '/inspections/' + ins[0].id);
    eq('the inspection still loads', r.status, 200);
    eq('both answers are still there', r.body.items.length, 2);
    eq('the retired item keeps its label', r.body.items[0].label, 'Seatbelts');
    eq('and its answer', r.body.items[0].answer, 'Fail');
    eq('and its color', r.body.items[0].color, 'red');
    eq('and its comment', r.body.items[0].comment, 'Driver belt frays at the latch');
    eq('overall result is untouched', r.body.overall_result, 'fail');
    var fk = (r.body.followup_items || []).map(function (i) { return i.item_key; });
    ok('a live flagged answer still raises follow-up', fk.indexOf('tires') !== -1, fk.join(','));
    ok('a retired item cannot raise follow-up', fk.indexOf('seatbelts') === -1, fk.join(','));

    section('New items and duplicate labels');
    r = await req('PUT', '/inspections/checklist', { items: [
      { item_key: '', label: 'Fire extinguisher', type: 'dropdown', options: [opt('Present', 'green'), opt('Missing', 'red', true)] },
      { item_key: '', label: 'Fire extinguisher', type: 'dropdown', options: [opt('Present', 'green')] },
      { item_key: '', label: '!!!', type: 'text' }
    ] });
    eq('all three are kept', r.body.items, 3);
    var keys = await liveKeys();
    eq('a new item gets a key derived from its label', keys[0], 'fire_extinguisher');
    eq('a colliding label does not silently vanish', keys[1], 'fire_extinguisher_2');
    eq('an unusable label still gets a key', keys[2], 'item');
    section('Audit');
    var acts = AUDIT.filter(function (a) { return a.entity_type === 'inspection_checklist'; }).map(function (a) { return a.action; });
    ok('saves, restores and deletes are all logged',
      acts.indexOf('edited') !== -1 && acts.indexOf('restored') !== -1 && acts.indexOf('deleted') !== -1, acts.join(','));
    var edited = AUDIT.filter(function (a) { return a.action === 'edited'; }).shift();
    ok('the save log names what was retired', edited && edited.details && Array.isArray(edited.details.retired) && edited.details.retired.length === 9,
      JSON.stringify(edited && edited.details));

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
