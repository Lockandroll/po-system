// Sidebar badges (routes/navCounts.js): who gets which number.
//
// Runs against a REAL Postgres:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-nav-counts.js
//
// Mounts the real router behind the real requireAuth and asks it as each
// person, over HTTP, with real JWTs. The point is Tony's rule: "a locksmith
// should not see the badge for a write up to another employee" - every count
// must be somebody's MOVE, scoped the way the module itself scopes it.
//
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-navcounts';

const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');
const { initDB, pool } = require('./db');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

var base = '';
function tokenFor(u) {
  return jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
async function counts(u) {
  const res = await fetch(base + '/api/nav/counts?fresh=1', { headers: { Authorization: 'Bearer ' + tokenFor(u) } });
  var j = null; try { j = await res.json(); } catch (_) {}
  return { status: res.status, body: j };
}
function n(c, view) { return (c.body && c.body.items && c.body.items[view]) ? c.body.items[view].n : 0; }
function part(c, view, key) {
  var it = c.body && c.body.items && c.body.items[view];
  if (!it) return 0;
  var p = it.parts.filter(function (x) { return x.key === key; })[0];
  return p ? p.n : 0;
}

async function mkUser(name, role, extra) {
  extra = extra || {};
  const email = name.toLowerCase().replace(/ /g, '.') + '@navtest.local';
  const r = await pool.query(
    "INSERT INTO users (email, name, password_hash, role, active, session_epoch, supervisor_id, home_city) VALUES ($1,$2,'x',$3,true,0,$4,$5) RETURNING id",
    [email, name, role, extra.supervisor_id || null, extra.home_city || null]
  );
  return { id: r.rows[0].id, name: name, email: email, role: role };
}

async function main() {
  console.log('Nav badge count tests');
  await initDB();
  await initDB();
  ok('initDB runs twice', true);

  // ---- clean slate for the tables we count ----
  var wipe = ['employee_records', 'purchase_orders', 'pto_requests', 'vehicle_repairs', 'suggestions', 'invoice_refunds', 'customer_feedback'];
  for (var i = 0; i < wipe.length; i++) { try { await pool.query('DELETE FROM ' + wipe[i]); } catch (e) {} }
  await pool.query("DELETE FROM tasks WHERE title LIKE 'NAVTEST%'");
  await pool.query("DELETE FROM user_cities WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@navtest.local')");
  try { await pool.query("DELETE FROM vehicle_assignment_history WHERE vehicle_id IN (SELECT id FROM vehicles WHERE make_model = 'NAVTEST')"); } catch (e) {}
  await pool.query("DELETE FROM vehicles WHERE make_model = 'NAVTEST'");
  await pool.query("DELETE FROM memo_recipients WHERE memo_id IN (SELECT id FROM memos WHERE title = 'NAVTEST memo')");
  await pool.query("DELETE FROM memos WHERE title = 'NAVTEST memo'");
  await pool.query("DELETE FROM tasks WHERE assigned_to IN (SELECT id FROM users WHERE email LIKE '%@navtest.local')");
  await pool.query("DELETE FROM users WHERE email LIKE '%@navtest.local'");

  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('role_permissions', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify({
      manager: ['view_pos', 'view_pto', 'manage_pto', 'manage_onboarding', 'view_employee_records', 'create_disciplinary',
        'approve_discipline', 'create_employee_note', 'approve_vr', 'view_vr', 'approve_refund', 'view_invoices',
        'view_tasks', 'view_inspections', 'manage_inspections', 'view_feedback', 'view_assets'],
      locksmith: ['view_pos', 'create_po', 'view_pto', 'view_tasks', 'view_inspections', 'view_assets', 'view_vr'],
      dispatcher: []
    })]
  );

  var tony = await mkUser('Tony Navtest', 'admin');
  var julius = await mkUser('Julius Navtest', 'manager', { supervisor_id: tony.id, home_city: 'ORL' });
  var mia = await mkUser('Mia Navtest', 'manager', { supervisor_id: tony.id, home_city: 'JAX' });
  var jesse = await mkUser('Jesse Navtest', 'locksmith', { supervisor_id: julius.id, home_city: 'ORL' });
  var lou = await mkUser('Lou Navtest', 'locksmith', { supervisor_id: julius.id, home_city: 'ORL' });
  var dee = await mkUser('Dee Navtest', 'dispatcher', { supervisor_id: julius.id, home_city: 'ORL' });
  await pool.query("INSERT INTO user_cities (user_id, city_code) VALUES ($1,'ORL'),($2,'JAX')", [julius.id, mia.id]);

  // Write-ups
  await pool.query(
    "INSERT INTO employee_records (user_id, type, status, level, created_by, created_by_name, approver_id, approver_name, visible_to_employee) " +
    "VALUES ($1,'disciplinary','pending_approval',1,$2,'Julius',$3,'Tony',true)", [jesse.id, julius.id, tony.id]);
  await pool.query(
    "INSERT INTO employee_records (user_id, type, status, level, created_by, created_by_name, visible_to_employee) " +
    "VALUES ($1,'disciplinary','approved',1,$2,'Julius',true)", [lou.id, julius.id]);
  await pool.query(
    "INSERT INTO employee_records (user_id, type, status, level, created_by, created_by_name, visible_to_employee) " +
    "VALUES ($1,'disciplinary','sent',1,$2,'Julius',true)", [jesse.id, julius.id]);

  // Purchase orders
  await pool.query("INSERT INTO purchase_orders (po_number, vendor_name, status, requester_id) VALUES ('NAV-1','V','submitted',$1)", [jesse.id]);
  await pool.query("INSERT INTO purchase_orders (po_number, vendor_name, status, requester_id, orderer_id) VALUES ('NAV-2','V','approved',$1,$2)", [jesse.id, julius.id]);

  // PTO: Jesse asks; Julius (his manager) and Tony (admin) can approve, Mia and Lou cannot.
  await pool.query("INSERT INTO pto_requests (user_id, start_date, end_date, status) VALUES ($1, CURRENT_DATE + 10, CURRENT_DATE + 11, 'pending')", [jesse.id]);

  // Overdue task for Lou, a future one for Jesse
  await pool.query("INSERT INTO tasks (title, assigned_to, status, due_date) VALUES ('NAVTEST overdue', $1, 'todo', CURRENT_DATE - 2)", [lou.id]);
  await pool.query("INSERT INTO tasks (title, assigned_to, status, due_date) VALUES ('NAVTEST later', $1, 'todo', CURRENT_DATE + 5)", [jesse.id]);

  // Vehicle repair waiting, and a phantom one that never counts
  await pool.query("INSERT INTO vehicle_repairs (vr_number, vehicle, status, requester_id) VALUES ('VR-NAV-1','Van','submitted',$1)", [jesse.id]);
  try { await pool.query("INSERT INTO vehicle_repairs (vr_number, vehicle, status, requester_id) VALUES (NULL,'Van','submitted',$1)", [jesse.id]); } catch (e) {}

  await pool.query("INSERT INTO suggestions (category, suggestion, status) VALUES ('x','y','open'), ('x','z','implemented')");

  // Feedback: one new in ORL, one new in JAX
  await pool.query("INSERT INTO customer_feedback (status, city_code) VALUES ('new','ORL'), ('new','JAX'), ('resolved','ORL')");

  // Inspection due: a vehicle on Jesse with nothing this month
  try { await pool.query("DELETE FROM vehicle_assignment_history WHERE vehicle_id IN (SELECT id FROM vehicles WHERE make_model = 'NAVTEST')"); } catch (e) {}
  await pool.query("DELETE FROM vehicles WHERE make_model = 'NAVTEST'");
  await pool.query("INSERT INTO vehicles (year, make_model, assigned_user_id, active, inspection_exempt) VALUES (2020,'NAVTEST',$1,true,false)", [jesse.id]);

  // Refund requested on an invoice
  await pool.query("DELETE FROM invoices WHERE invoice_number = 99990001");
  var inv = await pool.query("INSERT INTO invoices (invoice_number) VALUES (99990001) RETURNING id");
  await pool.query("INSERT INTO invoice_refunds (invoice_id, status, amount, requested_by) VALUES ($1,'requested',10,$2)", [inv.rows[0].id, jesse.id]);

  // Memo sent to Lou, not yet signed
  var memo = await pool.query("INSERT INTO memos (status, title) VALUES ('sent','NAVTEST memo') RETURNING id");
  await pool.query("INSERT INTO memo_recipients (memo_id, user_id) VALUES ($1,$2)", [memo.rows[0].id, lou.id]);

  // ---- server ----
  const app = express();
  app.use(express.json());
  app.use('/api/nav', require('./routes/navCounts'));
  const srv = await new Promise(function (r) { var s = app.listen(0, function () { r(s); }); });
  base = 'http://127.0.0.1:' + srv.address().port;

  var cT = await counts(tony), cJ = await counts(julius), cM = await counts(mia);
  var cJe = await counts(jesse), cL = await counts(lou), cD = await counts(dee);
  [cT, cJ, cM, cJe, cL, cD].forEach(function (c, i) { eq('200 for user ' + i, c.status, 200); });

  // Write-ups: Tony's rule
  eq('Tony: wording approval on Jesse', part(cT, 'employee-files', 'wording'), 1);
  eq('Tony: not asked to administer Julius\'s notice', part(cT, 'employee-files', 'administer'), 0);
  eq('Julius: no wording approval (not the approver)', part(cJ, 'employee-files', 'wording'), 0);
  eq('Julius: administer his approved notice on Lou', part(cJ, 'employee-files', 'administer'), 1);
  eq('Mia: nothing on another city\'s write-ups', n(cM, 'employee-files'), 0);
  eq('Jesse: no employee-files badge (locksmith)', n(cJe, 'employee-files'), 0);
  eq('Lou: no sign badge for his own approved-but-not-administered notice', part(cL, 'my-documents', 'sign'), 0);
  eq('Lou: no employee-files badge', n(cL, 'employee-files'), 0);
  eq('Jesse: his sent notice to sign', part(cJe, 'my-documents', 'sign'), 1);
  eq('Jesse: his pending-approval notice is invisible to him', n(cJe, 'my-documents'), 1);

  // POs
  eq('Tony: PO to approve', part(cT, 'dashboard', 'approve'), 1);
  eq('Julius: PO to order (he is the orderer)', part(cJ, 'dashboard', 'order'), 1);
  eq('Julius: no approve count without approve_po', part(cJ, 'dashboard', 'approve'), 0);
  eq('Jesse: nothing on POs', n(cJe, 'dashboard'), 0);

  // PTO
  eq('Tony (admin): PTO to approve', n(cT, 'pto'), 1);
  eq('Julius (manager in chain): PTO to approve', n(cJ, 'pto'), 1);
  eq('Mia (other branch): no PTO', n(cM, 'pto'), 0);
  eq('Jesse: never his own PTO', n(cJe, 'pto'), 0);
  eq('Lou: no PTO', n(cL, 'pto'), 0);

  // Tasks
  eq('Lou: one overdue task', n(cL, 'tasks'), 1);
  eq('Jesse: future task does not count', n(cJe, 'tasks'), 0);

  // VR
  eq('Julius: VR to approve (phantom excluded)', n(cJ, 'vr-dashboard'), 1);
  eq('Jesse: no VR approval', n(cJe, 'vr-dashboard'), 0);

  // Suggestions
  eq('Tony: 1 open suggestion', n(cT, 'suggestions'), 1);
  eq('Julius: 1 open suggestion', n(cJ, 'suggestions'), 1);
  eq('Jesse: no suggestions badge', n(cJe, 'suggestions'), 0);

  // Feedback
  eq('Julius: only ORL new complaint', n(cJ, 'feedback'), 1);
  eq('Mia: only JAX new complaint', n(cM, 'feedback'), 1);
  eq('Tony: both new complaints', n(cT, 'feedback'), 2);
  eq('Jesse: no feedback badge without view_feedback', n(cJe, 'feedback'), 0);

  eq('Jesse: inspection due on his own vehicle', part(cJe, 'inspections', 'due'), 1);
  eq('Lou: no inspection due (no vehicle)', n(cL, 'inspections'), 0);
  eq('Julius: refund to approve', part(cJ, 'refunds', 'approve'), 1);
  eq('Jesse: no refund badge', n(cJe, 'refunds'), 0);
  eq('Lou: memo to sign', part(cL, 'my-documents', 'memos'), 1);
  eq('Jesse: not Lou\'s memo', part(cJe, 'my-documents', 'memos'), 0);

  // Dispatcher with no permissions: nothing at all
  eq('Dee: zero total', cD.body.total, 0);

  // Totals add up
  var sum = 0; Object.keys(cJ.body.items).forEach(function (k) { sum += cJ.body.items[k].n; });
  eq('Julius total equals the sum of rows', cJ.body.total, sum);

  // Clearing: administer path flips status, fresh read drops the count
  await pool.query("UPDATE employee_records SET status='sent' WHERE status='approved'");
  eq('Julius: administer clears after send', part(await counts(julius), 'employee-files', 'administer'), 0);

  // Unauthenticated
  const r401 = await fetch(base + '/api/nav/counts');
  eq('no token -> 401', r401.status, 401);

  srv.close();
  console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
