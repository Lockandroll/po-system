// Dispatch Quote Script (Phase 1, residential + commercial): schema, permission,
// pricing-engine and log tests.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-quote-script.js
//
// Runs the real initDB() twice (a migration that is not idempotent dies here),
// then mounts the REAL router behind the REAL requireAuth and drives it over
// HTTP with real JWTs, the same way test-licensing-ledger.js does. The money
// assertions are the point: every number a dispatcher reads to a customer is
// checked here against the rule Tony gave for it.
//
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-quote-script';

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

var base = '';
function tokenFor(user) {
  return jwt.sign({ id: user.id, name: user.name, email: user.name + '@quotetest.local', role: user.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
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
async function mkUser(name, role, extra) {
  const r = await pool.query(
    "INSERT INTO users (email, name, password_hash, role, active, session_epoch, extra_perms) VALUES ($1,$2,'x',$3,true,0,$4) RETURNING id, role",
    [name.toLowerCase().replace(/\s+/g, '.') + '@quotetest.local', name, role, extra || []]);
  return { id: r.rows[0].id, role: r.rows[0].role, name: name };
}
function sectionText(result, section) {
  var s = (result.script || []).filter(function (x) { return x.section === section; })[0];
  return s ? s.text : '';
}

async function main() {
  console.log('Quote script tests');
  console.log('------------------');
  await initDB();
  await initDB();
  ok('initDB runs twice', true);

  // ---- seed ----------------------------------------------------------------
  // Leftovers from an earlier run of this file, so it can be re-run on the
  // same database. Only the test cities and the test-only rows are touched.
  await pool.query("DELETE FROM quote_rate_cards WHERE TRIM(city_code) IN ('TSA','TSB','TSD')");
  await pool.query("DELETE FROM quote_flat_prices WHERE TRIM(city_code) IN ('TSA','TSB','TSD')");
  await pool.query("DELETE FROM quote_unit_prices WHERE TRIM(city_code) IN ('TSA','TSB','TSD')");
  await pool.query("DELETE FROM quote_tasks WHERE name = 'Gun safe lock'");
  await pool.query("DELETE FROM quote_script_blocks WHERE block_key = 'greeting' AND category = 'commercial'");
  await pool.query("UPDATE settings SET value = 'Parts are extra; most common locks start at $40.' WHERE key = 'quote_parts_line'");
  await pool.query("UPDATE quote_decline_reasons SET active = true");
  await pool.query("DELETE FROM location_services WHERE TRIM(city_code) IN ('TSA','TSB','TSD')");
  var tc = await pool.query('SELECT category, pricing, COUNT(*)::int AS n FROM quote_tasks GROUP BY 1,2 ORDER BY 1,2');
  ok('tasks seeded', tc.rows.length === 4, JSON.stringify(tc.rows));
  var codes = {};
  (await pool.query('SELECT id, code FROM quote_tasks')).rows.forEach(function (r) { codes[r.code] = r.id; });
  ok('residential rekey seeded', !!codes.RES_REKEY);
  eq('rekey units are 2 keyways + 2 keys',
    (await pool.query('SELECT code, included_qty FROM quote_task_units WHERE task_id = $1 ORDER BY sort', [codes.RES_REKEY])).rows,
    [{ code: 'keyway', included_qty: 2 }, { code: 'key', included_qty: 2 }]);
  eq('NO prices are seeded (rate cards)', (await pool.query('SELECT COUNT(*)::int AS n FROM quote_rate_cards')).rows[0].n, 0);
  eq('NO prices are seeded (flat)', (await pool.query('SELECT COUNT(*)::int AS n FROM quote_flat_prices')).rows[0].n, 0);
  var lockout = (await pool.query('SELECT upsell_task_id FROM quote_tasks WHERE code = $1', ['RES_LOCKOUT'])).rows[0];
  eq('house lockout upsells the residential rekey', lockout.upsell_task_id, codes.RES_REKEY);
  eq('exit device repair is a tech-quotes job', (await pool.query("SELECT tech_confirms FROM quote_tasks WHERE code='COM_EXIT_REPAIR'")).rows[0].tech_confirms, true);
  eq('vendors.quote_fallback defaults to no_quote', (await pool.query(
    "SELECT column_default FROM information_schema.columns WHERE table_name='vendors' AND column_name='quote_fallback'")).rows[0].column_default.indexOf('no_quote') !== -1, true);
  // Seeding is once-only: a renamed task must survive the next boot.
  await pool.query("UPDATE quote_tasks SET name = 'House lockout (renamed)' WHERE code = 'RES_LOCKOUT'");
  await initDB();
  eq('a rename survives a reboot', (await pool.query("SELECT name FROM quote_tasks WHERE code='RES_LOCKOUT'")).rows[0].name, 'House lockout (renamed)');
  await pool.query("UPDATE quote_tasks SET name = 'House lockout' WHERE code = 'RES_LOCKOUT'");

  // ---- fixtures --------------------------------------------------------------
  await pool.query("DELETE FROM dispatch_quotes");
  await pool.query("DELETE FROM coverage_zones WHERE name LIKE 'TEST %'");
  await pool.query("DELETE FROM vendors WHERE name LIKE 'TEST %'");
  await pool.query("DELETE FROM users WHERE email LIKE '%@quotetest.local'");
  await pool.query("DELETE FROM cities WHERE code IN ('TSA','TSB','TSD')");
  await pool.query("INSERT INTO cities (name, code, active) VALUES ('Testville','TSA',true), ('Otherton','TSB',true)");
  var admin = await mkUser('Ada Admin', 'admin');
  var disp = await mkUser('Dana Dispatch', 'dispatcher', ['use_quote_script']);
  var disp2 = await mkUser('Dee Dispatch', 'dispatcher', ['use_quote_script']);
  var nobody = await mkUser('Ned Nobody', 'dispatcher');
  var mgr = await mkUser('Max Manager', 'manager');

  const app = express();
  app.use(express.json());
  app.use('/api/quote-script', require('./routes/quoteScript'));
  app.use(function (err, req, res, next) { console.error(err); res.status(500).json({ error: err.message }); });
  const server = await new Promise(function (resolve) { const s = app.listen(0, function () { resolve(s); }); });
  base = 'http://127.0.0.1:' + server.address().port + '/api/quote-script';

  // ---- permission gates ------------------------------------------------------
  eq('no permission -> bootstrap 403', (await call(nobody, 'GET', '/bootstrap')).status, 403);
  eq('manager without the box -> bootstrap 403', (await call(mgr, 'GET', '/bootstrap')).status, 403);
  var boot = await call(disp, 'GET', '/bootstrap');
  eq('dispatcher with use_quote_script -> bootstrap 200', boot.status, 200);
  eq('dispatcher cannot manage', boot.body.can_manage, false);
  eq('dispatcher greeting name is first name only', boot.body.dispatcher, 'Dana');
  eq('dispatcher -> admin 403', (await call(disp, 'GET', '/admin')).status, 403);
  eq('dispatcher cannot write a rate card', (await call(disp, 'PUT', '/admin/rate-cards', { rows: [] })).status, 403);
  eq('dispatcher cannot open the report', (await call(disp, 'GET', '/report')).status, 403);
  eq('admin -> admin 200', (await call(admin, 'GET', '/admin')).status, 200);
  eq('admin can manage', (await call(admin, 'GET', '/bootstrap')).body.can_manage, true);

  // ---- nothing live until the rate card is set -------------------------------
  var tsa = boot.body.cities.filter(function (c) { return c.code === 'TSA'; })[0];
  eq('TSA has no live category yet', tsa.live, {});
  var cat0 = await call(disp, 'GET', '/catalog?city=TSA&category=residential');
  eq('catalog not live before rates', cat0.body.live, false);
  var p0 = await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT });
  eq('unpriced hourly task -> total null', p0.body.total, null);
  ok('unpriced hourly task warns price_not_set', p0.body.warnings.some(function (w) { return w.key === 'price_not_set'; }));

  // ---- rate cards --------------------------------------------------------------
  eq('negative rate rejected', (await call(admin, 'PUT', '/admin/rate-cards', { rows: [{ city_code: 'TSA', category: 'residential', first_hour: -1, addl_hour: 5 }] })).status, 400);
  var rc = await call(admin, 'PUT', '/admin/rate-cards', { rows: [
    { city_code: 'TSA', category: 'residential', first_hour: '119.99', addl_hour: '89.99' },
    { city_code: 'TSA', category: 'commercial', first_hour: 149.99, addl_hour: 109.99 }] });
  eq('rate cards saved', rc.body.changed, 2);
  eq('re-saving the same numbers changes nothing', (await call(admin, 'PUT', '/admin/rate-cards', { rows: [{ city_code: 'TSA', category: 'residential', first_hour: 119.99, addl_hour: 89.99 }] })).body.changed, 0);
  boot = await call(disp, 'GET', '/bootstrap');
  eq('TSA now live for both', boot.body.cities.filter(function (c) { return c.code === 'TSA'; })[0].live, { residential: true, commercial: true });
  var cat1 = await call(disp, 'GET', '/catalog?city=TSA&category=residential');
  eq('catalog live after rates', cat1.body.live, true);
  var lockRow = cat1.body.tasks.filter(function (t) { return t.id === codes.RES_LOCKOUT; })[0];
  eq('lockout lead price = first hour', Number(lockRow.lead_price), 119.99);

  // ---- hourly ------------------------------------------------------------------
  var p1 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT })).body;
  eq('hourly: total is the first hour', p1.total, 119.99);
  eq('hourly: first_hour', p1.first_hour, 119.99);
  eq('hourly: addl_hour', p1.addl_hour, 89.99);
  eq('hourly: source retail', p1.source, 'retail');
  ok('hourly price wording has both numbers', sectionText(p1, 'price').indexOf('$119.99') !== -1 && sectionText(p1, 'price').indexOf('$89.99') !== -1, sectionText(p1, 'price'));
  ok('lockout does not read the parts line', !p1.parts_line && sectionText(p1, 'price').indexOf('$40') === -1);
  ok('lockout policy asks for ID with the address', sectionText(p1, 'policies').indexOf('ID with the address') !== -1);
  ok('surcharge disclosure read on every quote', sectionText(p1, 'policies').indexOf('Credit cards carry a small processing surcharge') !== -1);
  ok('greeting uses the dispatcher first name', sectionText(p1, 'greeting').indexOf('this is Dana') !== -1);
  ok('multi-task line present', sectionText(p1, 'price').indexOf('price it for you on site') !== -1);
  eq('no upsell until the rekey has a price', p1.upsell && p1.upsell.price, null);
  ok('no upsell section without an upsell price', !sectionText(p1, 'upsell'));
  var p2 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_DEADBOLT })).body;
  ok('deadbolt reads the parts line ($40)', sectionText(p2, 'price').indexOf('most common locks start at $40') !== -1, sectionText(p2, 'price'));
  var p3 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.COM_EXIT_REPAIR })).body;
  eq('commercial uses the commercial card', p3.total, 149.99);
  ok('exit device: tech gives a full quote line', sectionText(p3, 'price').indexOf('full quote') !== -1);
  ok('commercial policy line', sectionText(p3, 'policies').indexOf('authorized for the business') !== -1);
  // No time codes yet -> the service type's catalog default (COMLS = 45 min).
  eq('ETA falls back to the service type default', p3.eta, { low: 45, high: 45 });

  // ---- flat: rekey -----------------------------------------------------------
  eq('negative flat price rejected', (await call(admin, 'PUT', '/admin/flat-prices', { task_id: codes.RES_REKEY, city_code: 'TSA', package_price: -5 })).status, 400);
  eq('rekey price saved', (await call(admin, 'PUT', '/admin/flat-prices', { task_id: codes.RES_REKEY, city_code: 'TSA', package_price: 138.99, units: { keyway: 29.99, key: 4.99 } })).status, 200);
  var r1 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_REKEY })).body;
  eq('rekey 2 + 2 = package', r1.total, 138.99);
  ok('rekey wording: 2 keyways and 2 keys', sectionText(r1, 'price').indexOf('2 keyways and 2 keys') !== -1, sectionText(r1, 'price'));
  var r2 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_REKEY, quantities: { keyway: 4, key: 3 } })).body;
  eq('rekey 4 keyways + 3 keys = 138.99 + 2x29.99 + 1x4.99', r2.total, 203.96);
  eq('rekey lines', r2.lines.map(function (l) { return l.amount; }), [138.99, 59.98, 4.99]);
  ok('rekey wording: 4 keyways and 3 keys', sectionText(r2, 'price').indexOf('4 keyways and 3 keys') !== -1);
  ok('rekey wording names each extra price', sectionText(r2, 'price').indexOf('$29.99') !== -1 && sectionText(r2, 'price').indexOf('$4.99') !== -1);
  var r3 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_REKEY, quantities: { keyway: 1, key: 0 } })).body;
  eq('fewer than included never discounts', r3.total, 138.99);
  // Upsell now priced.
  var p4 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT })).body;
  eq('lockout upsell = rekey package', p4.upsell.price, 138.99);
  ok('upsell wording carries price and units', sectionText(p4, 'upsell').indexOf('$138.99') !== -1 && sectionText(p4, 'upsell').indexOf('2 keyways and 2 keys') !== -1, sectionText(p4, 'upsell'));

  // ---- flat: key dup + missing ---------------------------------------------------
  await call(admin, 'PUT', '/admin/flat-prices', { task_id: codes.RES_KEYDUP, city_code: 'TSA', package_price: 79.99, units: { key: 4.99 } });
  var k1 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_KEYDUP, quantities: { key: 3 } })).body;
  eq('key dup = visit + 3 x key', k1.total, 94.96);
  var m1 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_MAILBOX })).body;
  eq('unpriced flat task -> total null', m1.total, null);
  eq('unpriced flat task flags price_missing', m1.price_missing, true);
  await call(admin, 'PUT', '/admin/flat-prices', { task_id: codes.RES_MAILBOX, city_code: 'TSA', package_price: 99.99 });
  var m2 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_MAILBOX })).body;
  ok('unit-less flat wording reads naturally', sectionText(m2, 'price') === 'That is $99.99 plus tax for the mailbox lock. If there is anything else you would like done while the tech is there, they will price it for you on site.', sectionText(m2, 'price'));
  var u1 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_REKEY, quantities: { keyway: 2, key: 2 } })).body;
  eq('rekey still 138.99 (sanity)', u1.total, 138.99);
  await call(admin, 'PUT', '/admin/flat-prices', { task_id: codes.COM_REKEY, city_code: 'TSA', package_price: 159.99, units: { cylinder: null, key: 5.99 } });
  var u2 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.COM_REKEY, quantities: { cylinder: 3, key: 2 } })).body;
  ok('missing extra-unit price warns instead of charging 0', u2.warnings.some(function (w) { return w.key === 'unit_price_not_set'; }) && u2.total === 159.99, JSON.stringify(u2.warnings));

  // ---- coverage zone ------------------------------------------------------------
  var z = await pool.query("INSERT INTO coverage_zones (city_code, name, kind, price_adjust_type, price_adjust_value, eta_adjust_minutes) VALUES ('TSA','TEST Outer','zip','flat',15,10) RETURNING id");
  await pool.query("INSERT INTO coverage_zone_zips (zone_id, zip) VALUES ($1,'99901')", [z.rows[0].id]);
  var zipr = (await call(disp, 'GET', '/zip?zip=99901')).body;
  eq('zip resolves to its city', zipr.city_code, 'TSA');
  eq('zip resolves to its zone', zipr.zone && zipr.zone.name, 'TEST Outer');
  var zp = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT, zip: '99901' })).body;
  eq('zone adds once to the first hour', zp.total, 134.99);
  ok('zone line shown', zp.lines.some(function (l) { return l.label.indexOf('TEST Outer') !== -1 && l.amount === 15; }));
  ok('hourly wording uses the zoned first hour', sectionText(zp, 'price').indexOf('$134.99') !== -1);
  var zr = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_REKEY, quantities: { keyway: 4, key: 3 }, zip: '99901' })).body;
  eq('zone adds once to the flat total', zr.total, 218.96);
  var zw = (await call(disp, 'POST', '/price', { city_code: 'TSB', task_id: codes.RES_LOCKOUT, zip: '99901' })).body;
  ok('a zip from another market warns and does not adjust', zw.warnings.some(function (w) { return w.key === 'wrong_city'; }) && zw.zone === null);
  var zo = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT, zip: '11111' })).body;
  ok('a zip outside a drawn map is out of area', zo.out_of_area === true && zo.total === 119.99);

  // ---- ETA from the RESLS time codes --------------------------------------------
  var st = (await pool.query("SELECT id FROM service_types WHERE code = 'RESLS'")).rows[0].id;
  var ls = await pool.query("INSERT INTO location_services (city_code, service_type_id) VALUES ('TSA',$1) ON CONFLICT (city_code, service_type_id) DO UPDATE SET active = true RETURNING id", [st]);
  await pool.query("INSERT INTO service_time_codes (location_service_id, code_id, title, start_minute, end_minute, days, eta_core_low, eta_core_high) VALUES ($1, 1, 'All day', 0, 1439, 127, 35, 55) ON CONFLICT DO NOTHING", [ls.rows[0].id]);
  var e1 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT })).body;
  eq('ETA from the RESLS time code', e1.eta, { low: 35, high: 55 });
  ok('ETA merged into the ASAP close', sectionText(e1, 'close_asap').indexOf('35 to 55 minutes') !== -1, sectionText(e1, 'close_asap'));
  var e2 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT, zip: '99901' })).body;
  eq('zone ETA adjustment applies', e2.eta, { low: 45, high: 65 });

  // ---- accounts --------------------------------------------------------------------
  var acct = (await pool.query("INSERT INTO vendors (name) VALUES ('TEST Bayside PM') RETURNING id")).rows[0].id;
  var secret = (await pool.query("INSERT INTO vendors (name, restricted_to) VALUES ('TEST Bayside Secret', ARRAY[1]) RETURNING id")).rows[0].id;
  var found = (await call(disp, 'GET', '/accounts?q=bayside')).body;
  ok('account search finds the account', found.some(function (a) { return a.id === acct; }));
  ok('account search hides owner-restricted accounts', !found.some(function (a) { return a.id === secret; }));
  eq('no permission -> account search 403', (await call(nobody, 'GET', '/accounts?q=bay')).status, 403);
  var a0 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT, account_id: acct })).body;
  eq('account with nothing set defaults to do-not-quote', a0.source, 'no_quote');
  eq('do-not-quote has no total', a0.total, null);
  ok('do-not-quote reads the account line', sectionText(a0, 'price').indexOf('TEST Bayside PM') !== -1);
  eq('dispatcher cannot write account rates', (await call(disp, 'PUT', '/admin/accounts/' + acct, { fallback: 'retail' })).status, 403);
  await call(admin, 'PUT', '/admin/accounts/' + acct, { fallback: 'retail', rates: [], task_prices: [] });
  eq('fallback retail quotes retail', (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT, account_id: acct })).body.total, 119.99);
  await call(admin, 'PUT', '/admin/accounts/' + acct, { fallback: 'no_quote',
    rates: [{ category: 'commercial', city_code: '', first_hour: 129.99, addl_hour: 99.99 },
            { category: 'residential', city_code: 'TSA', first_hour: 109.99, addl_hour: 79.99 },
            { category: 'residential', city_code: '', first_hour: 114.99, addl_hour: 84.99 }],
    task_prices: [{ task_id: codes.RES_REKEY, city_code: '', package_price: 120, unit_prices: { key: 3.99 } }] });
  var a1 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT, account_id: acct })).body;
  eq('account city rate beats account all-city rate', a1.total, 109.99);
  eq('account source', a1.source, 'account');
  eq('account addl hour', a1.addl_hour, 79.99);
  eq('account all-city rate applies elsewhere', (await call(admin, 'PUT', '/admin/rate-cards', { rows: [{ city_code: 'TSB', category: 'residential', first_hour: 99, addl_hour: 70 }] })).status, 200);
  eq('account all-city residential in TSB', (await call(disp, 'POST', '/price', { city_code: 'TSB', task_id: codes.RES_LOCKOUT, account_id: acct })).body.total, 114.99);
  eq('account commercial all cities', (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.COM_LOCKOUT, account_id: acct })).body.total, 129.99);
  var a2 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_REKEY, account_id: acct, quantities: { keyway: 3, key: 3 } })).body;
  eq('account rekey: own package + own key price + retail keyway price', a2.total, 153.98);
  eq('account flat with no task price -> do not quote (fallback no_quote)', (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_KEYDUP, account_id: acct })).body.source, 'no_quote');
  var ag = (await call(admin, 'GET', '/admin/accounts/' + acct)).body;
  eq('account rates read back', ag.rates.length, 3);

  // ---- logging a quote ---------------------------------------------------------------
  eq('outcome required', (await call(disp, 'POST', '/quotes', { city_code: 'TSA', task_id: codes.RES_REKEY })).status, 400);
  var q1 = await call(disp, 'POST', '/quotes', { city_code: 'TSA', task_id: codes.RES_REKEY, quantities: { keyway: 4, key: 3 }, outcome: 'booked_asap',
    total: 1, customer_name: 'Pat Customer', pulsar_call_number: 'P-1001' });
  eq('quote logged', q1.status, 200);
  eq('server recomputes the total (ignores the browser)', Number(q1.body.total), 203.96);
  var row = (await pool.query('SELECT * FROM dispatch_quotes WHERE id = $1', [q1.body.id])).rows[0];
  eq('row total', Number(row.total), 203.96);
  eq('row snapshot carries the lines', row.snapshot.lines.length, 3);
  eq('row customer', row.customer_name, 'Pat Customer');
  eq('row Pulsar call #', row.pulsar_call_number, 'P-1001');
  var q2 = await call(disp, 'POST', '/quotes', { city_code: 'TSA', task_id: codes.RES_LOCKOUT, outcome: 'declined', decline_reason: 'Too expensive', upsell_accepted: false });
  eq('declined logged', q2.status, 200);
  eq('lockout logs upsell offered', (await pool.query('SELECT upsell_offered FROM dispatch_quotes WHERE id = $1', [q2.body.id])).rows[0].upsell_offered, true);
  var q3 = await call(disp, 'POST', '/quotes', { city_code: 'TSA', task_id: codes.RES_MAILBOX, outcome: 'callback' });
  eq('another dispatcher cannot change my outcome', (await call(disp2, 'PATCH', '/quotes/' + q3.body.id + '/outcome', { outcome: 'booked_asap' })).status, 403);
  eq('I can change my own outcome', (await call(disp, 'PATCH', '/quotes/' + q3.body.id + '/outcome', { outcome: 'booked_scheduled' })).status, 200);
  eq('admin can change anyone\'s outcome', (await call(admin, 'PATCH', '/quotes/' + q3.body.id + '/outcome', { outcome: 'declined', decline_reason: 'ETA too long' })).status, 200);
  eq('decline reason stored', (await pool.query('SELECT decline_reason FROM dispatch_quotes WHERE id = $1', [q3.body.id])).rows[0].decline_reason, 'ETA too long');
  await call(disp2, 'POST', '/quotes', { city_code: 'TSA', task_id: codes.COM_EXIT_REPAIR, outcome: 'callback' });
  eq('a dispatcher sees only their own quotes', (await call(disp, 'GET', '/quotes')).body.length, 3);
  eq('admin sees everyone\'s quotes', (await call(admin, 'GET', '/quotes')).body.length, 4);

  // A later price change must not rewrite what was quoted.
  await call(admin, 'PUT', '/admin/flat-prices', { task_id: codes.RES_REKEY, city_code: 'TSA', package_price: 149.99, units: { keyway: 29.99, key: 4.99 } });
  eq('logged total unchanged after a price edit', Number((await pool.query('SELECT total FROM dispatch_quotes WHERE id = $1', [q1.body.id])).rows[0].total), 203.96);

  // ---- report -------------------------------------------------------------------------
  var rep = (await call(admin, 'GET', '/report')).body;
  eq('report quotes', rep.totals.quotes, 4);
  eq('report booked', rep.totals.booked, 1);
  eq('report declined', rep.totals.declined, 2);
  ok('report decline reasons', rep.decline_reasons.some(function (r) { return r.k === 'Too expensive' && r.n === 1; }));
  ok('report by task', rep.by_task.length >= 3);
  eq('report rejects a bad date', (await call(admin, 'GET', '/report?from=yesterday')).status, 400);

  // ---- copy to all cities ----------------------------------------------------------------
  var cp = (await call(admin, 'POST', '/admin/copy', { scope: 'rate_cards', from_city: 'TSA' })).body;
  ok('rate cards copied to the other city', cp.to.indexOf('TSB') !== -1);
  eq('TSB commercial now live', (await call(disp, 'GET', '/catalog?city=TSB&category=commercial')).body.live, true);
  eq('TSB residential overwritten by the copy', Number((await call(disp, 'GET', '/catalog?city=TSB&category=residential')).body.first_hour), 119.99);
  await call(admin, 'POST', '/admin/copy', { scope: 'task', from_city: 'TSA', task_id: codes.RES_REKEY });
  eq('rekey copied to TSB', (await call(disp, 'POST', '/price', { city_code: 'TSB', task_id: codes.RES_REKEY, quantities: { keyway: 3 } })).body.total, 179.98);
  eq('copy with an unknown scope is refused', (await call(admin, 'POST', '/admin/copy', { scope: 'nope', from_city: 'TSA' })).status, 400);

  // ---- tasks ---------------------------------------------------------------------------------
  var nt = await call(admin, 'POST', '/admin/tasks', { category: 'residential', group_name: 'Small locks', name: 'Gun safe lock', pricing: 'flat',
    units: [{ label: 'Extra Lock', included_qty: 1 }] });
  eq('task created', nt.status, 200);
  eq('unit code slugged from the label', (await pool.query('SELECT code FROM quote_task_units WHERE task_id = $1', [nt.body.id])).rows[0].code, 'extra_lock');
  var ut = await call(admin, 'PUT', '/admin/tasks/' + nt.body.id, { category: 'residential', group_name: 'Small locks', name: 'Gun safe lock', pricing: 'flat', upsell_task_id: nt.body.id, units: [] });
  eq('task updated', ut.status, 200);
  var ntRow = (await pool.query('SELECT upsell_task_id FROM quote_tasks WHERE id = $1', [nt.body.id])).rows[0];
  eq('a task cannot upsell itself', ntRow.upsell_task_id, null);
  eq('units replaced (removed)', (await pool.query('SELECT COUNT(*)::int AS n FROM quote_task_units WHERE task_id = $1', [nt.body.id])).rows[0].n, 0);
  eq('task without a name refused', (await call(admin, 'POST', '/admin/tasks', { category: 'residential' })).status, 400);
  await call(admin, 'PUT', '/admin/tasks/' + nt.body.id, { category: 'residential', name: 'Gun safe lock', pricing: 'flat', active: false });
  ok('inactive task leaves the catalog', !(await call(disp, 'GET', '/catalog?city=TSA&category=residential')).body.tasks.some(function (t) { return t.id === nt.body.id; }));
  eq('inactive task cannot be priced', (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: nt.body.id })).status, 400);

  // ---- scripts + settings ------------------------------------------------------------------
  await call(admin, 'PUT', '/admin/blocks', { blocks: [{ block_key: 'greeting', category: 'commercial', body: 'Pop-A-Lock commercial desk, {dispatcher} speaking.' }, { block_key: 'bogus', category: '', body: 'x' }] });
  eq('unknown block key ignored', (await pool.query("SELECT COUNT(*)::int AS n FROM quote_script_blocks WHERE block_key = 'bogus'")).rows[0].n, 0);
  var g1 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.COM_LOCKOUT })).body;
  eq('commercial greeting override used', sectionText(g1, 'greeting'), 'Pop-A-Lock commercial desk, Dana speaking.');
  var g2 = (await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_LOCKOUT })).body;
  ok('residential falls back to the global greeting', sectionText(g2, 'greeting').indexOf('Thanks for calling') === 0);
  await call(admin, 'PUT', '/admin/settings', { parts_line: 'Parts are extra; most locks start at $45.', decline_reasons: ['Too expensive', 'Other'] });
  ok('parts line change is read', sectionText((await call(disp, 'POST', '/price', { city_code: 'TSA', task_id: codes.RES_DEADBOLT })).body, 'price').indexOf('$45') !== -1);
  eq('decline reasons replaced', (await call(disp, 'GET', '/bootstrap')).body.decline_reasons, ['Too expensive', 'Other']);
  ok('price changes are audited', (await pool.query("SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_type = 'quote_script'")).rows[0].n >= 8);

  server.close();
  await pool.end();
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
