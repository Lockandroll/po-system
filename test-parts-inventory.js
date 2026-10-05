// Parts Inventory (routes/inventory.js) + Equipment "Replace in place"
// (POST /api/assets/holdings/:id/replace). Real Postgres, real routers, real
// requireAuth, real JWTs.
//
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-parts-inventory.js
//
// The add-only rule is the point of half of this file: a technician must not be
// able to lower a count by ANY request shape. The other half proves a replace
// never leaves a tech holding nothing when the shelf is empty.
//
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-inventory';

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
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

var base = '';
function tokenFor(u) {
  return jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
async function call(u, method, path, body) {
  const res = await fetch(base + path, {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + tokenFor(u) }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function mkUser(name, role, home, extra, cities) {
  const email = name.toLowerCase().replace(/[^a-z]/g, '') + '@invtest.local';
  const r = await pool.query(
    "INSERT INTO users (email, name, password_hash, role, active, session_epoch, home_city, extra_perms) VALUES ($1,$2,'x',$3,true,0,$4,$5) RETURNING id",
    [email, name, role, home, extra || []]
  );
  const id = r.rows[0].id;
  for (var i = 0; i < (cities || []).length; i++) await pool.query('INSERT INTO user_cities (user_id, city_code) VALUES ($1,$2)', [id, cities[i]]);
  return { id: id, name: name, role: role, email: email };
}
async function q1(sql, p) { return (await pool.query(sql, p || [])).rows[0]; }

async function main() {
  console.log('Parts inventory + equipment replace tests');
  await initDB();
  await initDB();
  ok('initDB runs twice', true);

  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'parts'")).rows.map(function (r) { return r.column_name; });
  ok('parts.category exists', cols.indexOf('category') !== -1);
  ok('parts.track_inventory exists', cols.indexOf('track_inventory') !== -1);

  // ---- permissions registration -------------------------------------------
  const perms = require('./utils/permissions');
  ['view_inventory', 'add_inventory', 'manage_inventory'].forEach(function (p) {
    ok(p + ' in ALL_PERMS', perms.ALL_PERMS.indexOf(p) !== -1);
    ok(p + ' ships dark (not in EMPLOYEE_PERMS)', (perms.EMPLOYEE_PERMS || []).indexOf(p) === -1);
    Object.keys(perms.DEFAULTS || {}).forEach(function (role) {
      ok(p + ' not in DEFAULTS.' + role, (perms.DEFAULTS[role] || []).indexOf(p) === -1);
    });
  });

  // ---- app ---------------------------------------------------------------
  const app = express();
  app.use(express.json());
  app.use('/api/assets', require('./routes/assets'));
  app.use('/api/inventory', require('./routes/inventory'));
  app.use('/api/parts', require('./routes/parts'));
  app.use(function (err, req, res, next) { console.error('UNHANDLED', err); res.status(500).json({ error: 'Internal' }); });
  const server = await new Promise(function (r) { const s = app.listen(0, function () { r(s); }); });
  base = 'http://127.0.0.1:' + server.address().port;

  // ---- fixtures ----------------------------------------------------------
  await pool.query("INSERT INTO cities (name, code, active) VALUES ('Charleston','CHS',true),('Birmingham','BHM',true),('Closed','ZZZ',false) ON CONFLICT (code) DO NOTHING");
  const admin = await mkUser('Admin Person', 'admin', 'CHS');
  const mgr = await mkUser('Mona Manager', 'manager', 'CHS', ['view_inventory', 'manage_inventory'], ['CHS']);
  const mgrB = await mkUser('Barry Bham', 'manager', 'BHM', ['view_inventory', 'manage_inventory'], ['BHM']);
  const tech = await mkUser('Steven Ebert', 'roadside_technician', 'CHS', ['view_inventory', 'add_inventory']);
  const tech2 = await mkUser('Russ Other', 'locksmith', 'CHS', ['view_inventory', 'add_inventory']);
  const nobody = await mkUser('No Perms', 'locksmith', 'CHS');
  const disp = await mkUser('Desk Dispatcher', 'dispatcher', 'CHS', ['view_inventory']);
  const viewOnly = await mkUser('View Only', 'locksmith', 'CHS', ['view_inventory']);

  // =========================================================================
  // EQUIPMENT: replace in place
  // =========================================================================
  const jump = await q1("INSERT INTO asset_types (name, category, serialized, unit_cost, expected_life_months) VALUES ('Jumpbox','tool',false,100,24) RETURNING *");
  const prog = await q1("INSERT INTO asset_types (name, category, serialized, unit_cost) VALUES ('Programmer','tool',true,900) RETURNING *");
  await pool.query("INSERT INTO asset_stock (asset_type_id, city_code, qty_on_hand, min_qty) VALUES ($1,'CHS',2,0)", [jump.id]);
  const u1 = await q1("INSERT INTO assets (asset_type_id, asset_tag, serial_number, city_code, status) VALUES ($1,'P-1','SN1','CHS','in_stock') RETURNING id", [prog.id]);
  const u2 = await q1("INSERT INTO assets (asset_type_id, asset_tag, serial_number, city_code, status) VALUES ($1,'P-2','SN2','CHS','in_stock') RETURNING id", [prog.id]);
  const uB = await q1("INSERT INTO assets (asset_type_id, asset_tag, serial_number, city_code, status) VALUES ($1,'P-B','SNB','BHM','in_stock') RETURNING id", [prog.id]);

  var r = await call(mgr, 'POST', '/api/assets/acks', { user_id: tech.id, city_code: 'CHS', lines: [{ asset_type_id: jump.id, qty: 1 }, { asset_type_id: prog.id, qty: 1, asset_id: u1.id }] });
  eq('assign jumpbox + programmer', r.status, 201);
  var hJump = await q1('SELECT * FROM asset_holdings WHERE user_id = $1 AND asset_type_id = $2 AND returned_at IS NULL', [tech.id, jump.id]);
  var hProg = await q1('SELECT * FROM asset_holdings WHERE user_id = $1 AND asset_type_id = $2 AND returned_at IS NULL', [tech.id, prog.id]);
  ok('holdings exist', hJump && hProg);

  r = await call(mgr, 'GET', '/api/assets/holdings/' + hJump.id + '/replace-options');
  eq('options 200', r.status, 200);
  eq('options on_hand counted', r.body.on_hand, 1);
  eq('options needed', r.body.needed, 1);
  eq('options times_replaced 0', r.body.times_replaced, 0);
  eq('options carries asset_type_id', r.body.holding.asset_type_id, jump.id);
  r = await call(mgr, 'GET', '/api/assets/holdings/' + hProg.id + '/replace-options');
  eq('options serialized lists only CHS shelf units', r.body.units.map(function (u) { return u.id; }), [u2.id]);
  r = await call(mgrB, 'GET', '/api/assets/holdings/' + hJump.id + '/replace-options');
  eq('options other-city manager 403', r.status, 403);
  r = await call(tech, 'GET', '/api/assets/holdings/' + hJump.id + '/replace-options');
  eq('options tech 403', r.status, 403);

  r = await call(tech, 'POST', '/api/assets/holdings/' + hJump.id + '/replace', { reason: 'broken', handed_in: true });
  eq('replace as tech 403', r.status, 403);
  r = await call(mgrB, 'POST', '/api/assets/holdings/' + hJump.id + '/replace', { reason: 'broken', handed_in: true });
  eq('replace other-city manager 403', r.status, 403);
  r = await call(mgr, 'POST', '/api/assets/holdings/' + hJump.id + '/replace', { reason: 'nonsense' });
  eq('replace bad reason 400', r.status, 400);

  const acksBefore = (await q1('SELECT COUNT(*)::int AS n FROM asset_acknowledgments WHERE user_id = $1', [tech.id])).n;
  r = await call(mgr, 'POST', '/api/assets/holdings/' + hJump.id + '/replace', { reason: 'broken', handed_in: true, notes: 'cracked case' });
  eq('replace counted 200', r.status, 200);
  ok('replace returns an AA ack', r.body && r.body.ack && /^AA-/.test(r.body.ack.ack_number));
  var old = await q1('SELECT * FROM asset_holdings WHERE id = $1', [hJump.id]);
  eq('old holding status replaced', old.status, 'replaced');
  eq('old holding reason broken', old.returned_reason, 'broken');
  ok('old holding closed', !!old.returned_at);
  ok('old holding chained to new', old.replaced_by_holding_id === r.body.holding.id);
  ok('note recorded on old holding', /cracked case/.test(old.notes || ''));
  var fresh = await q1('SELECT * FROM asset_holdings WHERE id = $1', [r.body.holding.id]);
  ok('new holding open, same tech + city', !fresh.returned_at && fresh.user_id === tech.id && fresh.city_code === 'CHS');
  eq('new holding linked to the new ack', fresh.ack_id, r.body.ack.id);
  eq('shelf went 1 -> 0 (broken one NOT restocked)', (await q1('SELECT qty_on_hand FROM asset_stock WHERE asset_type_id = $1 AND city_code = $2', [jump.id, 'CHS'])).qty_on_hand, 0);
  eq('one new ack', (await q1('SELECT COUNT(*)::int AS n FROM asset_acknowledgments WHERE user_id = $1', [tech.id])).n, acksBefore + 1);
  eq('new ack pending', r.body.ack.status, 'pending');
  eq('new ack has one line', (await q1('SELECT COUNT(*)::int AS n FROM asset_ack_lines WHERE ack_id = $1', [r.body.ack.id])).n, 1);
  var det = await call(mgr, 'GET', '/api/assets/by-user/' + tech.id);
  eq('tech detail shows 1 replacement (12mo)', det.body.stats.replacements_12mo, 1);
  var jRow = det.body.current.filter(function (h) { return h.asset_type_id === jump.id; })[0];
  eq('current jumpbox times_replaced 1', jRow && jRow.times_replaced, 1);
  eq('history lists the old one', det.body.history.filter(function (h) { return h.id === hJump.id; }).length, 1);
  ok('audit row written', !!(await q1("SELECT 1 AS x FROM audit_logs WHERE action = 'replaced' AND entity_type = 'asset'")));

  r = await call(mgr, 'POST', '/api/assets/holdings/' + hJump.id + '/replace', { reason: 'broken' });
  eq('replacing the same holding twice 409', r.status, 409);

  // Empty shelf: refuse, and the tech must still be holding what they had.
  r = await call(mgr, 'POST', '/api/assets/holdings/' + fresh.id + '/replace', { reason: 'worn_out', handed_in: true });
  eq('empty shelf 409', r.status, 409);
  eq('empty shelf flagged out_of_stock', r.body && r.body.out_of_stock, true);
  eq('empty shelf reports on_hand 0', r.body && r.body.on_hand, 0);
  ok('empty shelf leaves the holding open', !(await q1('SELECT returned_at FROM asset_holdings WHERE id = $1', [fresh.id])).returned_at);
  eq('empty shelf wrote no ack', (await q1('SELECT COUNT(*)::int AS n FROM asset_acknowledgments WHERE user_id = $1', [tech.id])).n, acksBefore + 1);

  // The fallback the screen offers: a normal request, raised by the manager.
  r = await call(mgr, 'POST', '/api/assets/requests', { user_id: tech.id, city_code: 'CHS', kind: 'replacement', lines: [{ asset_type_id: jump.id, holding_id: fresh.id, qty: 1, reason: 'worn_out' }] });
  eq('fallback request 201', r.status, 201);
  r = await call(mgr, 'GET', '/api/assets/holdings/' + fresh.id + '/replace-options');
  ok('options now shows the open request', r.body.open_request && /^RR-/.test(r.body.open_request.request_number));

  // Serialized: a unit from another city's shelf is refused.
  r = await call(mgr, 'POST', '/api/assets/holdings/' + hProg.id + '/replace', { reason: 'broken', handed_in: true, asset_id: uB.id });
  eq('other-city unit refused 400', r.status, 400);
  ok('refused unit leaves holding open', !(await q1('SELECT returned_at FROM asset_holdings WHERE id = $1', [hProg.id])).returned_at);
  eq('refused BHM unit still in stock', (await q1('SELECT status FROM assets WHERE id = $1', [uB.id])).status, 'in_stock');

  // Lost: handed_in is ignored, the old unit is marked lost, u2 goes out.
  r = await call(mgr, 'POST', '/api/assets/holdings/' + hProg.id + '/replace', { reason: 'lost', handed_in: true });
  eq('serialized lost replace 200', r.status, 200);
  eq('old unit marked lost', (await q1('SELECT status FROM assets WHERE id = $1', [u1.id])).status, 'lost');
  var u2row = await q1('SELECT status, assigned_user_id FROM assets WHERE id = $1', [u2.id]);
  ok('u2 now assigned to tech', u2row.status === 'assigned' && u2row.assigned_user_id === tech.id);
  eq('lost holding not physically returned', (await q1('SELECT returned_reason FROM asset_holdings WHERE id = $1', [hProg.id])).returned_reason, 'lost');

  // Broken + handed in on a serialized unit parks it as needs_repair.
  const u3 = await q1("INSERT INTO assets (asset_type_id, asset_tag, city_code, status) VALUES ($1,'P-3','CHS','in_stock') RETURNING id", [prog.id]);
  var hProg2 = await q1('SELECT * FROM asset_holdings WHERE user_id = $1 AND asset_type_id = $2 AND returned_at IS NULL', [tech.id, prog.id]);
  r = await call(mgr, 'POST', '/api/assets/holdings/' + hProg2.id + '/replace', { reason: 'broken', handed_in: true, asset_id: u3.id });
  eq('serialized broken replace with picked unit 200', r.status, 200);
  eq('handed-in broken unit -> needs_repair', (await q1('SELECT status FROM assets WHERE id = $1', [u2.id])).status, 'needs_repair');
  eq('picked unit u3 assigned', (await q1('SELECT status FROM assets WHERE id = $1', [u3.id])).status, 'assigned');

  // =========================================================================
  // PARTS INVENTORY
  // =========================================================================
  const pKey = await q1("INSERT INTO parts (item_number, description, price, retail_price) VALUES ('HY18','Hyundai HY18 blade',10,23) RETURNING *");
  const pBat = await q1("INSERT INTO parts (item_number, description, price) VALUES ('H6','H6 battery',90) RETURNING *");
  const pRag = await q1("INSERT INTO parts (item_number, description, price) VALUES ('RAG','Shop rags',1) RETURNING *");
  eq('existing parts default to locksmith', pKey.category, 'locksmith');
  eq('existing parts default to tracked', pKey.track_inventory, true);

  r = await call(nobody, 'GET', '/api/inventory/config');
  eq('no perms -> 403 (ships dark)', r.status, 403);
  r = await call(tech, 'GET', '/api/inventory/config');
  eq('tech config 200', r.status, 200);
  ok('tech gets a van automatically', r.body.my_van && r.body.my_van.city_code === 'CHS');
  eq('tech cannot manage', r.body.can_manage, false);
  eq('tech can add', r.body.can_add, true);
  const vanId = r.body.my_van.id;
  r = await call(disp, 'GET', '/api/inventory/config');
  eq('dispatcher has no van', r.body.my_van, null);

  r = await call(mgr, 'GET', '/api/inventory/locations');
  eq('manager locations 200', r.status, 200);
  var names = r.body.map(function (l) { return l.name; });
  ok('manager sees CHS shelf', names.indexOf('CHS Shelf') !== -1);
  ok('manager sees tech van', names.indexOf("Steven Ebert's Van") !== -1);
  ok('manager does NOT see BHM shelf', names.indexOf('BHM Shelf') === -1);
  ok('no van for the dispatcher', names.indexOf("Desk Dispatcher's Van") === -1);
  ok('no van for admin', names.indexOf("Admin Person's Van") === -1);
  ok('inactive city has no shelf', names.indexOf('ZZZ Shelf') === -1);
  const shelfId = r.body.filter(function (l) { return l.name === 'CHS Shelf'; })[0].id;
  const van2Id = r.body.filter(function (l) { return l.name === "Russ Other's Van"; })[0].id;
  r = await call(mgr, 'GET', '/api/inventory/locations');
  eq('provisioning is idempotent', r.body.length, names.length);
  r = await call(tech, 'GET', '/api/inventory/locations');
  eq('tech sees only own van', r.body.map(function (l) { return l.id; }), [vanId]);
  r = await call(mgrB, 'GET', '/api/inventory/locations');
  ok('BHM manager sees no CHS location', r.body.every(function (l) { return l.city_code === 'BHM'; }) && r.body.length >= 1);

  // ---- THE RULE: a tech can only add -------------------------------------
  r = await call(tech, 'POST', '/api/inventory/add', { location_id: vanId, lines: [{ part_id: pKey.id, qty: 5, unit_cost: 999 }] });
  eq('tech add to own van 200', r.status, 200);
  var vs = await q1('SELECT * FROM part_stock WHERE part_id = $1 AND location_id = $2', [pKey.id, vanId]);
  eq('van qty 5', vs.qty_on_hand, 5);
  eq('tech-typed cost ignored, catalog cost used', parseFloat(vs.avg_cost), 10);
  eq('tech add logged as added', (await q1('SELECT reason FROM part_stock_moves WHERE location_id = $1 ORDER BY id DESC LIMIT 1', [vanId])).reason, 'added');
  var shapes = [-3, '-3', 0, '0', 1.5, '1.5', '2e2', 'abc', null, '', ' -1 ', 100001];
  for (var si = 0; si < shapes.length; si++) {
    r = await call(tech, 'POST', '/api/inventory/add', { location_id: vanId, lines: [{ part_id: pKey.id, qty: shapes[si] }] });
    eq('tech add qty ' + JSON.stringify(shapes[si]) + ' refused', r.status, 400);
  }
  r = await call(tech, 'POST', '/api/inventory/add', { location_id: vanId, lines: [{ part_id: pKey.id, qty: 2 }, { part_id: pKey.id, qty: -2 }] });
  eq('a negative line anywhere refuses the whole add', r.status, 400);
  eq('van still 5 after every refused shape', (await q1('SELECT qty_on_hand FROM part_stock WHERE part_id = $1 AND location_id = $2', [pKey.id, vanId])).qty_on_hand, 5);
  r = await call(tech, 'POST', '/api/inventory/adjust', { location_id: vanId, part_id: pKey.id, delta: -1, note: 'used one' });
  eq('tech adjust 403', r.status, 403);
  r = await call(tech, 'POST', '/api/inventory/adjust', { location_id: vanId, part_id: pKey.id, set_to: 0, note: 'zero it' });
  eq('tech set_to 403', r.status, 403);
  r = await call(tech, 'POST', '/api/inventory/transfers', { from_location_id: vanId, to_location_id: van2Id, lines: [{ part_id: pKey.id, qty: 5 }] });
  eq('tech transfer out of own van 403', r.status, 403);
  r = await call(tech, 'PUT', '/api/inventory/min', { location_id: vanId, part_id: pKey.id, min_qty: 3 });
  eq('tech set min 403', r.status, 403);
  r = await call(tech, 'POST', '/api/inventory/add', { location_id: shelfId, lines: [{ part_id: pKey.id, qty: 1 }] });
  eq('tech add to shelf 403', r.status, 403);
  r = await call(tech, 'POST', '/api/inventory/add', { location_id: van2Id, lines: [{ part_id: pKey.id, qty: 1 }] });
  eq('tech add to someone else van 403', r.status, 403);
  r = await call(viewOnly, 'POST', '/api/inventory/add', { location_id: vanId, lines: [{ part_id: pKey.id, qty: 1 }] });
  eq('view-only cannot add 403', r.status, 403);
  r = await call(tech, 'GET', '/api/inventory/stock');
  eq('tech company stock list 403', r.status, 403);
  r = await call(tech, 'GET', '/api/inventory/locations/' + shelfId);
  eq('tech read shelf 403', r.status, 403);
  r = await call(tech, 'GET', '/api/inventory/locations/' + van2Id);
  eq('tech read other van 403', r.status, 403);
  r = await call(tech, 'GET', '/api/inventory/locations/' + vanId);
  eq('tech read own van 200', r.status, 200);
  eq('own van shows 1 line', r.body.stock.length, 1);
  r = await call(tech, 'POST', '/api/inventory/part-settings', { ids: [pKey.id], track_inventory: false });
  eq('tech part settings 403', r.status, 403);

  // ---- manager: received cost re-averages ---------------------------------
  r = await call(mgr, 'POST', '/api/inventory/add', { location_id: shelfId, lines: [{ part_id: pKey.id, qty: 10, unit_cost: 12 }] });
  eq('manager receive 10 @ 12', r.status, 200);
  r = await call(mgr, 'POST', '/api/inventory/add', { location_id: shelfId, lines: [{ part_id: pKey.id, qty: 10, unit_cost: 14 }] });
  var ss = await q1('SELECT * FROM part_stock WHERE part_id = $1 AND location_id = $2', [pKey.id, shelfId]);
  eq('shelf qty 20', ss.qty_on_hand, 20);
  eq('weighted average 13', parseFloat(ss.avg_cost), 13);
  eq('manager receipt logged as received', (await q1('SELECT reason FROM part_stock_moves WHERE location_id = $1 ORDER BY id DESC LIMIT 1', [shelfId])).reason, 'received');
  r = await call(mgr, 'POST', '/api/inventory/add', { location_id: shelfId, lines: [{ part_id: pKey.id, qty: 1, unit_cost: -5 }] });
  eq('negative cost refused', r.status, 400);
  r = await call(mgrB, 'POST', '/api/inventory/add', { location_id: shelfId, lines: [{ part_id: pKey.id, qty: 1 }] });
  eq('other-city manager add 403', r.status, 403);

  // ---- transfer carries cost ----------------------------------------------
  r = await call(mgr, 'POST', '/api/inventory/transfers', { from_location_id: shelfId, to_location_id: vanId, lines: [{ part_id: pKey.id, qty: 4 }], note: 'restock' });
  eq('transfer 201', r.status, 201);
  ok('transfer numbered PT-', /^PT-\d{4}-0001$/.test(r.body.transfer_number || ''));
  eq('shelf 16 after transfer', (await q1('SELECT qty_on_hand FROM part_stock WHERE part_id = $1 AND location_id = $2', [pKey.id, shelfId])).qty_on_hand, 16);
  vs = await q1('SELECT * FROM part_stock WHERE part_id = $1 AND location_id = $2', [pKey.id, vanId]);
  eq('van 9 after transfer', vs.qty_on_hand, 9);
  eq('van re-averaged with the shelf cost (5@10 + 4@13)/9', parseFloat(vs.avg_cost), 11.3333);
  eq('shelf average unchanged by a transfer out', parseFloat((await q1('SELECT avg_cost FROM part_stock WHERE part_id = $1 AND location_id = $2', [pKey.id, shelfId])).avg_cost), 13);
  r = await call(mgr, 'POST', '/api/inventory/transfers', { from_location_id: shelfId, to_location_id: vanId, lines: [{ part_id: pKey.id, qty: 1 }, { part_id: pBat.id, qty: 1 }] });
  eq('transfer of a part the source lacks 400', r.status, 400);
  eq('failed transfer is atomic (shelf still 16)', (await q1('SELECT qty_on_hand FROM part_stock WHERE part_id = $1 AND location_id = $2', [pKey.id, shelfId])).qty_on_hand, 16);
  eq('failed transfer wrote no header', (await q1('SELECT COUNT(*)::int AS n FROM part_transfers')).n, 1);
  r = await call(mgr, 'POST', '/api/inventory/transfers', { from_location_id: shelfId, to_location_id: shelfId, lines: [{ part_id: pKey.id, qty: 1 }] });
  eq('transfer to itself 400', r.status, 400);
  const bhmShelf = (await call(mgrB, 'GET', '/api/inventory/locations')).body.filter(function (l) { return l.kind === 'shelf'; })[0].id;
  r = await call(mgr, 'POST', '/api/inventory/transfers', { from_location_id: shelfId, to_location_id: bhmShelf, lines: [{ part_id: pKey.id, qty: 1 }] });
  eq('transfer to a city outside scope 403', r.status, 403);
  r = await call(admin, 'POST', '/api/inventory/transfers', { from_location_id: shelfId, to_location_id: bhmShelf, lines: [{ part_id: pKey.id, qty: 1 }] });
  eq('admin cross-city transfer 201', r.status, 201);
  r = await call(mgr, 'GET', '/api/inventory/transfers');
  eq('CHS manager sees both transfers (one end in CHS)', r.body.length, 2);

  // ---- adjust ------------------------------------------------------------
  r = await call(mgr, 'POST', '/api/inventory/adjust', { location_id: vanId, part_id: pKey.id, set_to: 7 });
  eq('adjust without a reason 400', r.status, 400);
  r = await call(mgr, 'POST', '/api/inventory/adjust', { location_id: vanId, part_id: pKey.id, set_to: 7, expected_qty: 8, note: 'counted' });
  eq('adjust with stale expected_qty 409', r.status, 409);
  r = await call(mgr, 'POST', '/api/inventory/adjust', { location_id: vanId, part_id: pKey.id, set_to: 7, expected_qty: 9, note: 'counted with Steven, 2 short' });
  eq('adjust 200', r.status, 200);
  eq('adjust delta -2', r.body.delta, -2);
  r = await call(mgr, 'POST', '/api/inventory/adjust', { location_id: vanId, part_id: pKey.id, set_to: 7, note: 'again' });
  eq('adjust to same count 400', r.status, 400);
  r = await call(mgr, 'POST', '/api/inventory/adjust', { location_id: vanId, part_id: pKey.id, delta: '1.5', note: 'half' });
  eq('fractional adjust 400', r.status, 400);
  r = await call(mgrB, 'POST', '/api/inventory/adjust', { location_id: vanId, part_id: pKey.id, delta: -1, note: 'nope' });
  eq('other-city adjust 403', r.status, 403);
  eq('adjust kept the average', parseFloat((await q1('SELECT avg_cost FROM part_stock WHERE part_id = $1 AND location_id = $2', [pKey.id, vanId])).avg_cost), 11.3333);
  ok('adjust audited', !!(await q1("SELECT 1 AS x FROM audit_logs WHERE action = 'stock_adjusted'")));

  // ---- min + status -------------------------------------------------------
  r = await call(mgr, 'PUT', '/api/inventory/min', { location_id: vanId, part_id: pKey.id, min_qty: 10 });
  eq('set min 200', r.status, 200);
  r = await call(mgr, 'GET', '/api/inventory/stock?status=low');
  ok('van row now Low', r.body.rows.some(function (x) { return x.location_id === vanId && x.part_id === pKey.id && x.stock_status === 'low'; }));
  r = await call(mgr, 'PUT', '/api/inventory/min', { location_id: vanId, part_id: pBat.id, min_qty: 2 });
  r = await call(mgr, 'GET', '/api/inventory/stock?status=low');
  ok('a min on a part with zero shows Out', r.body.rows.some(function (x) { return x.location_id === vanId && x.part_id === pBat.id && x.stock_status === 'out'; }));
  r = await call(mgr, 'POST', '/api/inventory/adjust', { location_id: vanId, part_id: pBat.id, delta: -1, note: 'sold before it was received' });
  r = await call(mgr, 'GET', '/api/inventory/stock?status=negative');
  ok('negative status reported', r.body.rows.length === 1 && r.body.rows[0].qty_on_hand === -1);
  r = await call(mgr, 'GET', '/api/inventory/stock');
  ok('BHM shelf not in CHS manager stock list', r.body.rows.every(function (x) { return x.city_code === 'CHS'; }));
  var expectVal = 15 * 13 + 7 * 11.3333;   // shelf 16 - 1 sent to BHM by admin
  ok('stock value = sum(max(qty,0) * avg)', Math.abs(r.body.totals.value - expectVal) < 0.02, r.body.totals.value + ' vs ' + expectVal);

  // ---- ledger invariant: every count equals the sum of its moves ----------
  var bad = (await pool.query(
    'SELECT s.part_id, s.location_id, s.qty_on_hand, COALESCE(SUM(m.delta),0)::int AS moved FROM part_stock s ' +
    'LEFT JOIN part_stock_moves m ON m.part_id = s.part_id AND m.location_id = s.location_id ' +
    'GROUP BY s.part_id, s.location_id, s.qty_on_hand HAVING s.qty_on_hand <> COALESCE(SUM(m.delta),0)'
  )).rows;
  eq('every qty_on_hand equals the sum of its ledger moves', bad.length, 0);
  var badAfter = (await pool.query(
    'SELECT m.id FROM part_stock_moves m WHERE m.qty_after <> (SELECT SUM(m2.delta) FROM part_stock_moves m2 WHERE m2.part_id = m.part_id AND m2.location_id = m.location_id AND m2.id <= m.id)'
  )).rows;
  eq('every move qty_after is the running total', badAfter.length, 0);

  // ---- part settings + picker + delete guard -----------------------------
  r = await call(mgr, 'POST', '/api/inventory/part-settings', { ids: [pRag.id], track_inventory: false });
  eq('untrack rags 200', r.status, 200);
  r = await call(mgr, 'POST', '/api/inventory/part-settings', { ids: [pBat.id], category: 'battery' });
  eq('battery category 200', r.status, 200);
  r = await call(mgr, 'POST', '/api/inventory/part-settings', { ids: [pBat.id], category: 'snacks' });
  eq('unknown category 400', r.status, 400);
  r = await call(tech, 'GET', '/api/inventory/parts?q=rag');
  eq('picker hides untracked parts', r.body.length, 0);
  r = await call(tech, 'GET', '/api/inventory/parts?q=H6');
  eq('picker shows category', r.body[0] && r.body[0].category, 'battery');
  r = await call(tech, 'POST', '/api/inventory/add', { location_id: vanId, lines: [{ part_id: pRag.id, qty: 1 }] });
  eq('adding an untracked part 400', r.status, 400);
  r = await call(mgr, 'GET', '/api/inventory/stock?category=battery');
  ok('category filter', r.body.rows.length >= 1 && r.body.rows.every(function (x) { return x.category === 'battery'; }));
  r = await call(admin, 'DELETE', '/api/parts/' + pKey.id);
  eq('deleting a part with stock 409', r.status, 409);
  r = await call(admin, 'POST', '/api/parts/bulk-delete', { ids: [pKey.id, pRag.id] });
  eq('bulk delete with a stocked part 409', r.status, 409);
  r = await call(admin, 'DELETE', '/api/parts/' + pRag.id);
  eq('deleting a part with no stock still works', r.status, 200);

  // manage_inventory alone (no view_) still opens the module.
  const mOnly = await mkUser('Manage Only', 'manager', 'CHS', ['manage_inventory'], ['CHS']);
  r = await call(mOnly, 'GET', '/api/inventory/stock');
  eq('manage_inventory without view_ still 200', r.status, 200);

  server.close();
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
