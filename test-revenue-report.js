'use strict';
/*
 * Weekly revenue report, end to end against a REAL Postgres.
 *
 * What it pins:
 *   - initDB() creates cs_calls / cs_imports / cs_report_runs on a database
 *     that has never seen them, is safe to run twice, and carries the UNIQUE
 *     index on call_uid that the whole design rests on;
 *   - the parser: currency with $ and commas, a parenthesized credit as a
 *     negative, inconsistent Task casing, dot-segment EQUALITY (so Bat and
 *     RP.Bat classify but Batch and Combat do not), Sunday belonging to the
 *     Monday before it;
 *   - the seven acceptance checks from the spec, every one of them measured
 *     against an INDEPENDENT tally: the fixture generator records what it
 *     wrote and the assertions compare against that, never against the
 *     module's own arithmetic;
 *   - GOA IS COUNTED. A run that silently filtered to Completed would pass
 *     every other check here, so this one is asserted on its own;
 *   - IDEMPOTENCY: re-importing the same file, and importing an overlapping
 *     range, leave the row count and the money untouched;
 *   - a corrected payment OVERWRITES rather than adds;
 *   - the window never includes the week in progress;
 *   - the location map is applied at READ time, so changing it re-reports the
 *     whole history with no re-import;
 *   - the weekly tables carry no combined column and the classes sum to the
 *     week total;
 *   - view_revenue cannot import; manage_revenue can;
 *   - the PDF renders, is a real PDF, and has 2 + one-page-per-location pages.
 *
 *   PGURL=postgres://postgres@127.0.0.1:5433/revenue_test node test-revenue-report.js
 *
 * House style: string concatenation only, no template literals.
 */
var http = require('http');
var Module = require('module');
var { Pool } = require('pg');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) PASS++; else { FAIL++; console.error('  FAIL: ' + label); } }
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
}
// Money is compared to the CENT, never with a tolerance. A report that is
// "close enough" to the books is a report nobody can use.
function eqMoney(a, b, label) {
  var x = Math.round(Number(a) * 100), y = Math.round(Number(b) * 100);
  ok(x === y, label + '  (got ' + (x / 100).toFixed(2) + ', want ' + (y / 100).toFixed(2) + ')');
}
function section(t) { console.log('\n== ' + t); }

process.env.DATABASE_URL = process.env.PGURL;
var pool = new Pool({ connectionString: process.env.PGURL });

var CURRENT_USER = { id: 1, name: 'Tony McKeon', role: 'admin' };
var PERMS = { admin: [], manager: ['view_revenue', 'manage_revenue'], locksmith: ['view_revenue'] };
var EMAILS = [];

var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return require('./db.js');
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = Object.assign({}, CURRENT_USER); next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    // The real gate, reproduced: admin and owner always pass, everybody else
    // is checked against the matrix. This is what makes the permission
    // assertions at the bottom mean something.
    requirePermission: function (perm) {
      return function (req, res, next) {
        var role = req.user.role;
        if (role === 'admin' || role === 'owner') return next();
        if ((PERMS[role] || []).indexOf(perm) !== -1) return next();
        res.status(403).json({ error: 'Access denied' });
      };
    }
  };
  if (request === '../utils/audit') return { logAudit: async function () {} };
  if (request === './email' || request === '../utils/email') return {
    sendEmail: async function (to, subject, html, cc, attachments) {
      EMAILS.push({ to: to, subject: subject, attachments: attachments || [] });
      return true;
    },
    emailTemplate: function (o) { return String((o && o.body) || ''); }
  };
  return origLoad.apply(this, arguments);
};

var express = require('express');
var db = require('./db.js');
var CSV = require('./utils/revenueCsv.js');
var RR = require('./utils/revenueReport.js');
var PDFB = require('./utils/revenuePdf.js');
var SET = require('./utils/revenueSettings.js');
var DELIVER = require('./utils/revenueDeliver.js');
var router = require('./routes/revenue.js');

var app = express();
app.use(express.json({ limit: '80mb' }));
app.use('/api/revenue', router);
var server;

function req(method, path, body) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : JSON.stringify(body);
    var r = http.request({
      host: '127.0.0.1', port: server.address().port, method: method, path: path,
      headers: { 'content-type': 'application/json' }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        var j = null;
        try { j = JSON.parse(raw.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, body: j, buf: raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function as(u) { CURRENT_USER = u; }
var ADMIN = { id: 1, name: 'Tony McKeon', role: 'admin' };
var MGR = { id: 2, name: 'Dana Reed', role: 'manager' };
var READER = { id: 3, name: 'Jen Flynn', role: 'locksmith' };

/* =========================================================================
 * The fixture
 * =========================================================================
 * Built row by row so the test knows, independently of anything in
 * utils/, exactly how many calls it wrote, what each one earned and which
 * bucket it belongs in. Every assertion below compares the modules against
 * THIS tally, not against themselves.
 */

// 14 consecutive Mondays ending on a week that is safely in the past.
var WEEKS = (function () {
  var out = [], d = new Date(Date.UTC(2026, 5, 1));   // 2026-06-01 is a Monday
  for (var i = 0; i < 14; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
})();

var LOCATIONS = ['Orlando', 'Jacksonville', 'Clearwater', 'Tampa', 'Tallahassee', 'Savannah', 'Columbus', 'Birmingham'];

// Task codes as they really appear, casing and all. The expected class is
// stated here by hand so the test is not asking serviceClass() to mark its own
// homework.
var TASKS = [
  ['CDU', 'roadside'],
  ['ago.Jump', 'roadside'],
  ['CDU.Gas.Jump', 'roadside'],
  ['GEICO.Tow', 'roadside'],
  ['Geico.Tow', 'roadside'],
  ['Pick', 'roadside'],            // the known gap: no .LS suffix, so Roadside
  ['MSG.Lockout', 'roadside'],
  ['Bat', 'battery'],
  ['bat', 'battery'],
  ['RP.Bat', 'battery'],
  ['Auto.LS', 'locksmith'],
  ['AL.Bus.LS', 'locksmith'],
  ['Bus.ls', 'locksmith'],
  ['EDU.CDU', 'roadside']
];

// A small deterministic PRNG so a failure is reproducible.
var _seed = 20260914;
function rnd() {
  _seed = (_seed * 1103515245 + 12345) % 2147483648;
  return _seed / 2147483648;
}

function addDays(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function usd(v) {
  return '$' + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function mdy(ymd) {
  var p = ymd.split('-');
  return (+p[1]) + '/' + (+p[2]) + '/' + p[0];
}

/*
 * Build a set of calls and the tally that describes them.
 *
 * tally.byWeekLocClass[week][reportedLocation][class] = revenue
 * tally.total, tally.count, tally.goaRevenue, tally.goaCalls
 */
function makeCalls(weeks, startUid) {
  var calls = [], uid = startUid;
  var tally = { byWeekLocClass: {}, total: 0, count: 0, goaRevenue: 0, goaCalls: 0, zeroCalls: 0 };

  function record(week, loc, cls, revenue) {
    var reported = (loc === 'Clearwater' || loc === 'Tampa') ? 'Suncoast' : loc;
    if (!tally.byWeekLocClass[week]) tally.byWeekLocClass[week] = {};
    if (!tally.byWeekLocClass[week][reported]) tally.byWeekLocClass[week][reported] = { roadside: 0, battery: 0, locksmith: 0, calls: 0 };
    var b = tally.byWeekLocClass[week][reported];
    b[cls] = Math.round((b[cls] + revenue) * 100) / 100;
    b.calls++;
    tally.total = Math.round((tally.total + revenue) * 100) / 100;
    tally.count++;
  }

  weeks.forEach(function (week) {
    LOCATIONS.forEach(function (loc) {
      var n = 6 + Math.floor(rnd() * 6);
      for (var i = 0; i < n; i++) {
        var t = TASKS[Math.floor(rnd() * TASKS.length)];
        // Battery only exists in two markets in the real data; mirror that so
        // the "chart with nothing in it" path is exercised.
        if (t[1] === 'battery' && loc !== 'Orlando' && loc !== 'Clearwater') t = TASKS[0];

        var dayOffset = Math.floor(rnd() * 7);       // 0..6 -> Monday..Sunday
        var date = addDays(week, dayOffset);
        var goa = rnd() < 0.085;
        var zero = !goa && rnd() < 0.012;

        var cash = 0, check = 0, cc = 0, acct = 0;
        if (zero) {
          tally.zeroCalls++;
        } else if (goa) {
          cash = Math.round((25 + rnd() * 30) * 100) / 100;
        } else {
          var pick = rnd();
          var amt = Math.round((35 + rnd() * 240) * 100) / 100;
          if (pick < 0.12) cash = amt;
          else if (pick < 0.18) check = amt;
          else if (pick < 0.70) cc = amt;
          else acct = amt;
        }
        var revenue = Math.round((cash + check + cc + acct) * 100) / 100;
        if (goa) { tally.goaRevenue = Math.round((tally.goaRevenue + revenue) * 100) / 100; tally.goaCalls++; }

        calls.push({
          uid: 'UID-' + (uid++),
          date: date, week: week, location: loc, task: t[0], cls: t[1],
          status: goa ? 'GOA' : 'Completed',
          tech: 'Tech' + (1 + Math.floor(rnd() * 12)) + ', Sample',
          account: rnd() < 0.4 ? 'CM - Retail' : 'Allstate',
          cash: cash, check: check, cc: cc, acct: acct, revenue: revenue
        });
        record(week, loc, t[1], revenue);
      }
    });
  });
  return { calls: calls, tally: tally };
}

var HEADER = ['DT Complete', 'Location', 'Task', 'Tech ID', 'Status', 'Pay Period', 'Call UID',
  'Collected Cash', 'Collected Check', 'Collected CC', 'Collected Account', ''];

function toCsv(calls) {
  var lines = [HEADER.join(',')];
  calls.forEach(function (c) {
    lines.push([
      '"' + mdy(c.date) + ' 2:14:33 PM"',
      c.location,
      c.task,
      '"' + c.tech + '"',
      c.status,
      '"' + mdy(c.week) + ' 12:00:00 AM"',
      c.uid,
      '"' + usd(c.cash) + '"',
      '"' + usd(c.check) + '"',
      '"' + usd(c.cc) + '"',
      '"' + usd(c.acct) + '"',
      ''
    ].join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

/* ========================================================================= */

// cs_imports.uploaded_by is a real foreign key into users, so the people doing
// the importing have to exist before anything is imported.
async function seedUsers() {
  var people = [[1, 'Tony McKeon', 'admin'], [2, 'Dana Reed', 'manager'],
    [3, 'Jen Flynn', 'locksmith'], [9, 'Nobody', 'dispatcher']];
  for (var i = 0; i < people.length; i++) {
    await pool.query(
      'INSERT INTO users (id, name, email, password_hash, role, active) ' +
      "VALUES ($1,$2,$3,'x',$4,true) ON CONFLICT (id) DO NOTHING",
      [people[i][0], people[i][1], 'u' + people[i][0] + '@example.com', people[i][2]]);
  }
  await pool.query("SELECT setval('users_id_seq', 100, true)");
}

async function run() {
  section('initDB is idempotent and builds the store');
  await db.initDB();
  await db.initDB();                      // twice, on purpose
  await seedUsers();
  var t = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name IN ('cs_calls','cs_imports','cs_report_runs') ORDER BY 1");
  eq(t.rows.map(function (r) { return r.table_name; }), ['cs_calls', 'cs_imports', 'cs_report_runs'],
    'all three tables exist after two runs');

  var ix = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE tablename = 'cs_calls' AND indexname = 'cs_calls_uid_idx'");
  ok(ix.rows.length === 1 && /UNIQUE/i.test(ix.rows[0].indexdef),
    'call_uid carries a UNIQUE index - the whole idempotency guarantee');

  // A clean slate whichever database this is pointed at.
  await pool.query('DELETE FROM cs_calls');
  await pool.query('DELETE FROM cs_imports');
  await pool.query('DELETE FROM cs_report_runs');
  await pool.query("DELETE FROM settings WHERE key LIKE 'revenue_%'");

  /* ------------------------------------------------------------------ */
  section('the parser, on the things that actually broke');

  eqMoney(CSV.money('$1,234.56'), 1234.56, 'currency with a dollar sign and a comma');
  eqMoney(CSV.money('($25.00)'), -25, 'a parenthesized credit is negative');
  eqMoney(CSV.money('-$25.00'), -25, 'a leading minus is negative');
  eqMoney(CSV.money(''), 0, 'blank is zero, not NaN');
  eqMoney(CSV.money('0.00'), 0, 'a bare zero');

  eq(CSV.serviceClass('Auto.LS'), 'locksmith', 'LS segment -> Locksmith');
  eq(CSV.serviceClass('Bus.ls'), 'locksmith', 'lowercase ls -> Locksmith');
  eq(CSV.serviceClass('AL.Bus.LS'), 'locksmith', 'LS wins from any position');
  eq(CSV.serviceClass('Bat'), 'battery', 'a standalone Bat -> Battery');
  eq(CSV.serviceClass('RP.Bat'), 'battery', 'a Bat segment -> Battery');
  eq(CSV.serviceClass('bat'), 'battery', 'lowercase bat -> Battery');
  eq(CSV.serviceClass('Bat.LS'), 'locksmith', 'LS is tested before Bat');
  eq(CSV.serviceClass('Batch'), 'roadside', 'SUBSTRING must not match: Batch is not a battery');
  eq(CSV.serviceClass('Combat.Tow'), 'roadside', 'SUBSTRING must not match: Combat is not a battery');
  eq(CSV.serviceClass('Flats'), 'roadside', 'SUBSTRING must not match: Flats is not locksmith');
  eq(CSV.serviceClass('Pick'), 'roadside', 'Pick has no .LS suffix, so it is Roadside (known source gap)');
  eq(CSV.serviceClass('CDU'), 'roadside', 'anything else -> Roadside');
  eq(CSV.serviceClass(''), 'roadside', 'a blank task -> Roadside, never a crash');

  eq(CSV.mondayOf('2026-09-14'), '2026-09-14', 'a Monday is its own week');
  eq(CSV.mondayOf('2026-09-20'), '2026-09-14', 'Sunday belongs to the Monday before it');
  eq(CSV.mondayOf('2026-09-15'), '2026-09-14', 'Tuesday belongs to its Monday');
  eq(CSV.latestCompleteWeek('2026-09-14'), '2026-09-07',
    'on a Monday the latest COMPLETE week is the one that just ended');
  eq(CSV.latestCompleteWeek('2026-09-17'), '2026-09-07',
    'mid-week, the week in progress is still excluded');

  eq(CSV.parseDate('9/13/2026 4:07:11 PM'), '2026-09-13', 'M/D/YYYY with a time');
  eq(CSV.parseDate('09/03/2026'), '2026-09-03', 'zero-padded M/D/YYYY');
  eq(CSV.parseDate('2026-09-03'), '2026-09-03', 'an ISO date passes through');
  eq(CSV.parseDate('not a date'), '', 'garbage is empty, never a wrong date');

  eq(CSV.mapLocation('Tampa', CSV.DEFAULT_LOCATION_MAP), 'Suncoast', 'Tampa reports as Suncoast');
  eq(CSV.mapLocation('CLEARWATER', CSV.DEFAULT_LOCATION_MAP), 'Suncoast', 'the map is case-insensitive');
  eq(CSV.mapLocation('Orlando', CSV.DEFAULT_LOCATION_MAP), 'Orlando', 'everything else passes through');

  // A CSV with a quoted comma and an embedded newline, which the real export
  // produces in the Account column.
  var tricky = 'Call UID,Location,Task,DT Complete,Collected Cash,Account\r\n' +
    'A1,Orlando,CDU,9/7/2026,"$1,200.00","Smith, John"\r\n' +
    'A2,Orlando,Bat,9/7/2026,"$0.00","a\nb"\r\n';
  var tOut = CSV.extractRows(tricky, CSV.DEFAULT_LOCATION_MAP);
  eq(tOut.rows.length, 2, 'quoted commas and embedded newlines parse as two rows');
  eqMoney(tOut.rows[0].revenue, 1200, 'a quoted "$1,200.00" is twelve hundred dollars');
  eq(tOut.rows[0].account, 'Smith, John', 'a quoted comma stays inside its field');

  /* ------------------------------------------------------------------ */
  section('import: the seven acceptance checks');

  var fixture = makeCalls(WEEKS, 1000);
  var csvText = toCsv(fixture.calls);

  as(ADMIN);
  var pv = await req('POST', '/api/revenue/preview', { csv: csvText, filename: 'CallSearch_full.csv' });
  eq(pv.status, 200, 'preview accepts the export');
  eq(pv.body.diff.new, fixture.calls.length, 'preview says every row is new on an empty store');
  eq(pv.body.diff.changed, 0, 'preview says nothing is changed on an empty store');
  eqMoney(pv.body.diff.revenue_total, fixture.tally.total, 'preview totals the file to the cent');

  var imp = await req('POST', '/api/revenue/import', { csv: csvText, filename: 'CallSearch_full.csv' });
  eq(imp.status, 201, 'import commits');

  // 1. Row count ingested equals row count in the source file.
  var cnt = await pool.query('SELECT COUNT(*)::int AS n FROM cs_calls');
  eq(cnt.rows[0].n, fixture.calls.length, 'CHECK 1: row count ingested equals the source file');

  // 2. Sum of all revenue matches the source file to the cent.
  var sum = await pool.query('SELECT COALESCE(SUM(revenue),0)::float8 AS s FROM cs_calls');
  eqMoney(sum.rows[0].s, fixture.tally.total, 'CHECK 2: total revenue matches the source to the cent');

  // Build the report over the whole fixture so the structural checks have
  // every week in view.
  var lastWeek = WEEKS[WEEKS.length - 1];
  var report = await RR.buildReport(pool, {
    endWeek: lastWeek, weeks: WEEKS.length, locationMap: CSV.DEFAULT_LOCATION_MAP
  });

  // 3. Each location total equals the sum of its weeks.
  var badLoc = 0;
  report.locations.forEach(function (p) {
    var s = 0;
    report.window.weeks.forEach(function (w) { s += (p.weeks[w] || { total: 0 }).total; });
    if (Math.round(s * 100) !== Math.round(p.revenue * 100)) badLoc++;
  });
  eq(badLoc, 0, 'CHECK 3: every location total equals the sum of its weeks');

  // 4. Each week's three service classes sum to that week's total.
  var badWeek = 0;
  report.locations.concat([report.company]).forEach(function (p) {
    report.window.weeks.forEach(function (w) {
      var b = p.weeks[w];
      var s = b.roadside + b.battery + b.locksmith;
      if (Math.round(s * 100) !== Math.round(b.total * 100)) badWeek++;
    });
  });
  eq(badWeek, 0, 'CHECK 4: the three classes sum to the week total on every page');

  // 5. Company weekly totals equal the sum of location weekly totals.
  var badCompany = 0;
  report.window.weeks.forEach(function (w) {
    var s = 0;
    report.locations.forEach(function (p) { s += p.weeks[w].total; });
    if (Math.round(s * 100) !== Math.round(report.company.weeks[w].total * 100)) badCompany++;
  });
  eq(badCompany, 0, 'CHECK 5: company weekly totals equal the sum of the locations');

  // ... and against the INDEPENDENT tally, per week, per location, per class.
  var mismatches = 0, checked = 0;
  Object.keys(fixture.tally.byWeekLocClass).forEach(function (w) {
    var want = fixture.tally.byWeekLocClass[w];
    Object.keys(want).forEach(function (loc) {
      var page = null;
      report.locations.forEach(function (p) { if (p.name === loc) page = p; });
      if (!page) { mismatches++; return; }
      ['roadside', 'battery', 'locksmith'].forEach(function (c) {
        checked++;
        if (Math.round(page.weeks[w][c] * 100) !== Math.round(want[loc][c] * 100)) mismatches++;
      });
    });
  });
  eq(mismatches, 0, 'every week/location/class cell matches the independent tally (' + checked + ' cells)');

  // 6. Re-ingesting the same file produces zero net change.
  var before = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(revenue),0)::float8 AS s FROM cs_calls');
  var again = await req('POST', '/api/revenue/import', { csv: csvText, filename: 'CallSearch_full.csv' });
  eq(again.status, 201, 'the same file imports again without complaint');
  eq(again.body.inserted, 0, 'CHECK 6: a re-import inserts nothing');
  eq(again.body.payment_corrections, 0, 'CHECK 6: a re-import moves no money');
  var after = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(revenue),0)::float8 AS s FROM cs_calls');
  eq(after.rows[0].n, before.rows[0].n, 'CHECK 6: row count unchanged after a re-import');
  eqMoney(after.rows[0].s, before.rows[0].s, 'CHECK 6: revenue unchanged after a re-import');

  // 7. Ingesting an overlapping range produces no duplicate call_uid rows.
  var overlapCalls = fixture.calls.filter(function (c) {
    return c.week === WEEKS[WEEKS.length - 2] || c.week === lastWeek;
  });
  var ovl = await req('POST', '/api/revenue/import', { csv: toCsv(overlapCalls), filename: 'CallSearch_trailing.csv' });
  eq(ovl.status, 201, 'a trailing overlapping export imports');
  eq(ovl.body.inserted, 0, 'the overlapping weeks insert nothing new');
  var dupes = await pool.query(
    'SELECT COUNT(*)::int AS n FROM (SELECT call_uid FROM cs_calls GROUP BY call_uid HAVING COUNT(*) > 1) d');
  eq(dupes.rows[0].n, 0, 'CHECK 7: no duplicate call_uid rows after an overlapping import');
  var after2 = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(revenue),0)::float8 AS s FROM cs_calls');
  eqMoney(after2.rows[0].s, fixture.tally.total, 'CHECK 7: revenue still matches the source after the overlap');

  /* ------------------------------------------------------------------ */
  section('GOA is counted, and $0 calls are kept');

  var goa = await pool.query(
    "SELECT COUNT(*)::int AS n, COALESCE(SUM(revenue),0)::float8 AS s FROM cs_calls WHERE status = 'GOA'");
  eq(goa.rows[0].n, fixture.tally.goaCalls, 'every GOA row was stored');
  eqMoney(goa.rows[0].s, fixture.tally.goaRevenue, 'GOA revenue is in the store');
  ok(fixture.tally.goaRevenue > 0, 'the fixture actually has GOA money in it (or this test proves nothing)');
  // The report total already matched the source to the cent above, and the
  // source total includes GOA - so GOA is in the report. Assert it directly
  // anyway, because a future "filter to Completed" would be a one-line change.
  eqMoney(report.totals.revenue, fixture.tally.total, 'the report total includes GOA revenue');

  var zeros = await pool.query('SELECT COUNT(*)::int AS n FROM cs_calls WHERE revenue = 0');
  ok(zeros.rows[0].n >= fixture.tally.zeroCalls,
    'calls that collected nothing are kept, not dropped (' + zeros.rows[0].n + ' of them)');

  /* ------------------------------------------------------------------ */
  section('a corrected payment overwrites, it does not accumulate');

  var target = fixture.calls[7];
  var corrected = Object.assign({}, target, { cc: 0, cash: 0, check: 0, acct: 0 });
  corrected.cc = Math.round((target.revenue + 100) * 100) / 100;
  corrected.revenue = corrected.cc;
  var fix = await req('POST', '/api/revenue/import', {
    csv: toCsv([corrected]), filename: 'CallSearch_correction.csv'
  });
  eq(fix.status, 201, 'the correction imports');
  eq(fix.body.inserted, 0, 'a correction is an update, not an insert');
  eq(fix.body.payment_corrections, 1, 'the import reports exactly one figure that moved');
  var row = await pool.query('SELECT revenue::float8 AS r FROM cs_calls WHERE call_uid = $1', [target.uid]);
  eqMoney(row.rows[0].r, corrected.revenue, 'the row now holds the corrected figure, not the sum of both');
  var totalAfterFix = await pool.query('SELECT COALESCE(SUM(revenue),0)::float8 AS s FROM cs_calls');
  eqMoney(totalAfterFix.rows[0].s, fixture.tally.total - target.revenue + corrected.revenue,
    'the history moved by exactly the correction, not by the whole call again');

  // Put it back so the rest of the assertions read the original tally.
  await req('POST', '/api/revenue/import', { csv: toCsv([target]), filename: 'CallSearch_restore.csv' });
  var restored = await pool.query('SELECT COALESCE(SUM(revenue),0)::float8 AS s FROM cs_calls');
  eqMoney(restored.rows[0].s, fixture.tally.total, 'restoring the original row restores the total');

  /* ------------------------------------------------------------------ */
  section('the rolling window');

  var twelve = await RR.buildReport(pool, {
    endWeek: lastWeek, weeks: 12, locationMap: CSV.DEFAULT_LOCATION_MAP
  });
  eq(twelve.window.weeks.length, 12, 'the window is twelve weeks');
  eq(twelve.window.last, lastWeek, 'it ends on the requested week');
  eq(twelve.window.first, WEEKS[WEEKS.length - 12], 'and starts eleven weeks before that');
  ok(twelve.window.weeks.indexOf(WEEKS[0]) === -1,
    'weeks older than the window are excluded even though they are in the store');
  ok(twelve.totals.revenue < fixture.tally.total,
    'a 12-week report over 14 weeks of history is smaller than the whole history');

  var defaultEnd = await RR.buildReport(pool, {
    weeks: 12, locationMap: CSV.DEFAULT_LOCATION_MAP, today: '2026-09-17'
  });
  eq(defaultEnd.window.last, '2026-09-07',
    'with no end given, the window stops at the last COMPLETE week, never the one in progress');

  // Ordering: pages run by revenue descending.
  var ordered = true;
  for (var i = 1; i < report.locations.length; i++) {
    if (report.locations[i - 1].revenue < report.locations[i].revenue) ordered = false;
  }
  ok(ordered, 'location pages are ordered by revenue descending');

  // The consolidation actually happened.
  var names = report.locations.map(function (p) { return p.name; });
  ok(names.indexOf('Suncoast') !== -1, 'Suncoast appears as a location');
  ok(names.indexOf('Clearwater') === -1 && names.indexOf('Tampa') === -1,
    'Clearwater and Tampa do not appear separately');
  eq(names.length, LOCATIONS.length - 1, 'eight source locations report as seven');

  /* ------------------------------------------------------------------ */
  section('the location map is read-time, so changing it needs no re-import');

  await SET.put(SET.KEY_LOCATION_MAP, { clearwater: 'Gulf Coast', tampa: 'Gulf Coast', savannah: 'Gulf Coast' });
  var remapped = await RR.buildReport(pool, {
    endWeek: lastWeek, weeks: WEEKS.length, locationMap: await SET.locationMap()
  });
  var rnames = remapped.locations.map(function (p) { return p.name; });
  ok(rnames.indexOf('Gulf Coast') !== -1, 'a brand new consolidation appears immediately');
  ok(rnames.indexOf('Suncoast') === -1, 'the old name is gone');
  eqMoney(remapped.totals.revenue, report.totals.revenue,
    'and the company total is unchanged - a re-grouping moves no money');
  var rowsStill = await pool.query('SELECT COUNT(*)::int AS n FROM cs_calls');
  eq(rowsStill.rows[0].n, fixture.calls.length, 'not one row was rewritten to do it');
  await SET.put(SET.KEY_LOCATION_MAP, CSV.DEFAULT_LOCATION_MAP);

  /* ------------------------------------------------------------------ */
  section('the weekly table');

  var page = report.locations[0];
  eq(page.rows.length, report.window.weeks.length, 'one row per week in the window');
  eq(page.rows[0].week_start, report.window.weeks[0], 'oldest week first');
  eq(page.rows[page.rows.length - 1].week_start, lastWeek, 'newest week last');
  eq(page.rows[0].d_roadside, null, 'the first week has no prior week, so no percentage');
  ok(!('combined' in page.rows[0]) && !('total' in page.rows[0]),
    'the table rows carry NO combined column - that figure lives only on the Total card');

  // The per-row percentage is the change on the week before, per class.
  var r1 = page.rows[5], r0 = page.rows[4];
  if (r0.roadside > 0) {
    var want = (r1.roadside - r0.roadside) / Math.abs(r0.roadside) * 100;
    ok(Math.abs(r1.d_roadside - want) < 0.0001, 'the weekly percentage is the change on the week before');
  } else { PASS++; }

  // Cards: the latest week, and the rolling average excluding it.
  var card = page.cards.roadside;
  eqMoney(card.value, page.weeks[lastWeek].roadside, 'the card shows the latest week');
  eqMoney(card.prior, page.weeks[report.window.weeks[report.window.weeks.length - 2]].roadside,
    'and the prior week beside it');
  var avgWeeks = report.meta.activeWeeks.filter(function (w) { return w !== lastWeek; });
  var avgSum = 0;
  avgWeeks.forEach(function (w) { avgSum += page.weeks[w].roadside; });
  eqMoney(card.average, Math.round((avgSum / avgWeeks.length) * 100) / 100,
    'the rolling average is taken over the active weeks BEFORE the latest one');
  eq(card.avg_weeks, avgWeeks.length, 'and says how many weeks it averaged');

  eqMoney(page.cards.total.value,
    page.cards.roadside.value + page.cards.battery.value + page.cards.locksmith.value,
    'the Total card is the sum of the three class cards');

  ok(RR.pct(100, 0) === null, 'a percentage against zero is null, never Infinity');
  eqMoney(RR.pct(150, 100), 50, 'a straightforward percentage');

  /* ------------------------------------------------------------------ */
  section('the PDF');

  var pdf = await PDFB.buildPdf(report);
  ok(Buffer.isBuffer(pdf) && pdf.length > 5000, 'a PDF of real size came back (' + pdf.length + ' bytes)');
  eq(pdf.slice(0, 5).toString('latin1'), '%PDF-', 'it starts with the PDF magic number');
  ok(pdf.slice(-1024).toString('latin1').indexOf('%%EOF') !== -1, 'and ends with %%EOF');
  var pageCount = Number((pdf.toString('latin1').match(/\/Count (\d+)/) || [])[1]);
  eq(pageCount, 2 + report.locations.length,
    'one company page, one comparison page, then a page per location - and no blanks');
  ok(PDFB.fileName(report).indexOf(CSV.addDays(lastWeek, 6)) !== -1,
    'the filename is dated by the week covered, so two runs of a week agree');

  // The window is configurable up to 52 weeks. Everything on a page is placed
  // by hand, so a longer window must THIN the labels and TRIM the table rather
  // than spill - a text() call below the bottom margin makes pdfkit open a
  // fresh page, and the report grows blanks nobody asked for.
  var wide = await RR.buildReport(pool, {
    endWeek: lastWeek, weeks: 52, locationMap: CSV.DEFAULT_LOCATION_MAP
  });
  var widePdf = await PDFB.buildPdf(wide);
  var widePages = (widePdf.toString('latin1').match(/\/Count (\d+)/) || [])[1];
  eq(Number(widePages), 2 + wide.locations.length,
    'a 52-week window still produces exactly one page per location plus two');

  var httpPdf = await req('GET', '/api/revenue/report.pdf?end=' + lastWeek);
  eq(httpPdf.status, 200, 'the download endpoint answers');
  eq(httpPdf.buf.slice(0, 5).toString('latin1'), '%PDF-', 'and hands back a real PDF');

  /* ------------------------------------------------------------------ */
  section('the Monday send');

  EMAILS.length = 0;
  await SET.put(SET.KEY_RECIPIENTS, ['ops@example.com', 'ops@example.com', 'not an email', 'ben@example.com']);
  eq(await SET.recipients(), ['ops@example.com', 'ben@example.com'],
    'the recipient list de-duplicates and drops anything that is not an address');

  var sent = await DELIVER.generate({ endWeek: lastWeek, triggeredBy: 'schedule' });
  ok(sent.sent === true, 'the report sends');
  eq(EMAILS.length, 1, 'exactly one email went out');
  eq(EMAILS[0].to, ['ops@example.com', 'ben@example.com'], 'to the configured list');
  eq(EMAILS[0].attachments.length, 1, 'with one attachment');
  ok(/\.pdf$/.test(EMAILS[0].attachments[0].filename), 'and the attachment is the PDF');
  ok(EMAILS[0].attachments[0].content.length > 4000, 'the attachment has the document in it');

  var runRow = await pool.query('SELECT * FROM cs_report_runs ORDER BY id DESC LIMIT 1');
  eq(runRow.rows[0].ok, true, 'the run was recorded as successful');
  eq(runRow.rows[0].triggered_by, 'schedule', 'and attributed to the schedule');
  eqMoney(runRow.rows[0].revenue_total, report.company.cards.total.value,
    'the logged total is the week that was sent');

  EMAILS.length = 0;
  await SET.put(SET.KEY_RECIPIENTS, []);
  var nobody = await DELIVER.generate({ endWeek: lastWeek, triggeredBy: 'schedule' });
  eq(EMAILS.length, 0, 'an empty saved list means NOBODY - it does not fall back to the env var');
  ok(nobody.sent === false && !!nobody.error, 'and the failure is reported rather than swallowed');
  var failRow = await pool.query('SELECT ok, error FROM cs_report_runs ORDER BY id DESC LIMIT 1');
  eq(failRow.rows[0].ok, false, 'a send that did not happen is logged as a failure');
  ok(!!failRow.rows[0].error, 'with the reason on the row');

  eq(await SET.enabled(), false, 'the Monday schedule is OFF until somebody turns it on');

  /* ------------------------------------------------------------------ */
  section('staleness is stated, not left to be inferred from a flat chart');

  var stale = await DELIVER.generate({ endWeek: lastWeek, send: false, today: '2027-01-01' });
  ok(!!stale.stale && /days ago/.test(stale.stale), 'a long-neglected store says so out loud');
  var fresh = await DELIVER.generate({ endWeek: lastWeek, send: false, today: CSV.addDays(lastWeek, 8) });
  ok(!fresh.stale, 'a freshly fed store says nothing');

  /* ------------------------------------------------------------------ */
  section('permissions');

  as(READER);                                  // view_revenue only
  var readOk = await req('GET', '/api/revenue/report?end=' + lastWeek);
  eq(readOk.status, 200, 'view_revenue can read the report');
  var readPdf = await req('GET', '/api/revenue/report.pdf?end=' + lastWeek);
  eq(readPdf.status, 200, 'view_revenue can download the PDF');
  var noImport = await req('POST', '/api/revenue/import', { csv: csvText });
  eq(noImport.status, 403, 'view_revenue CANNOT import - that writes the history');
  var noPreview = await req('POST', '/api/revenue/preview', { csv: csvText });
  eq(noPreview.status, 403, 'view_revenue cannot even preview an import');
  var noSettings = await req('PUT', '/api/revenue/settings', { weeks: 4 });
  eq(noSettings.status, 403, 'view_revenue cannot change who gets the email');
  var noSend = await req('POST', '/api/revenue/send', {});
  eq(noSend.status, 403, 'view_revenue cannot fire a send');

  as(MGR);                                     // view_revenue + manage_revenue
  var mgrImport = await req('POST', '/api/revenue/preview', { csv: csvText });
  eq(mgrImport.status, 200, 'manage_revenue can preview');
  var mgrSettings = await req('PUT', '/api/revenue/settings', { weeks: 8 });
  eq(mgrSettings.status, 200, 'manage_revenue can change the window');
  eq(mgrSettings.body.settings.weeks, 8, 'and the change sticks');
  await req('PUT', '/api/revenue/settings', { weeks: 12 });

  var neither = { id: 9, name: 'Nobody', role: 'dispatcher' };
  as(neither);
  var denied = await req('GET', '/api/revenue/report');
  eq(denied.status, 403, 'a role with neither permission sees nothing at all');

  /* ------------------------------------------------------------------ */
  section('bad input is refused with a reason a manager can act on');

  as(ADMIN);
  var noCols = await req('POST', '/api/revenue/preview', { csv: 'a,b,c\n1,2,3\n' });
  eq(noCols.status, 400, 'a file without the required columns is refused');
  ok(/DT Complete|Call UID|Location|Task/.test(noCols.body.error || ''),
    'and the message names the columns it needed: ' + JSON.stringify(noCols.body.error));
  var empty = await req('POST', '/api/revenue/preview', { csv: '' });
  eq(empty.status, 400, 'an empty body is refused');

  var headerOnly = await req('POST', '/api/revenue/preview', { csv: HEADER.join(',') + '\r\n' });
  eq(headerOnly.status, 400, 'a header with no rows is refused');

  /* ------------------------------------------------------------------ */
  section('meta, the payload the page draws itself from');

  var meta = await req('GET', '/api/revenue/meta');
  eq(meta.status, 200, 'meta answers');
  eq(meta.body.history.calls, fixture.calls.length, 'it reports the whole history');
  eqMoney(meta.body.history.revenue, fixture.tally.total, 'with the right money in it');
  ok(meta.body.weeks.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(meta.body.weeks[0].week_start),
    'weeks come back as plain ISO dates, not as timezone-shifted timestamps');
  eq(meta.body.weeks[0].week_start, lastWeek, 'newest week first');
  ok(meta.body.imports.length > 0, 'and the import log is there');

  console.log('\n----------------------------------------');
  console.log(PASS + ' passed, ' + FAIL + ' failed');
  console.log('----------------------------------------');
}

server = app.listen(0, '127.0.0.1', function () {
  run().then(function () {
    server.close();
    return pool.end();
  }).then(function () {
    process.exit(FAIL ? 1 : 0);
  }).catch(function (e) {
    console.error(e);
    try { server.close(); } catch (x) {}
    process.exit(1);
  });
});
