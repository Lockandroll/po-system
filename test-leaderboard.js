// Weekly leaderboards: schema, sheet reading, name matching and the exact SQL
// the routes run.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-leaderboard.js
//
// It runs the real initDB() twice (so a migration that is not idempotent fails
// here rather than on the next Railway boot), builds a real .xlsx with exceljs
// and reads it back through utils/leaderboard.js, then drives the week /
// entries tables the way routes/leaderboard.js does.
//
// House style: string concatenation only, no template literals.
const path = require('path');
const { initDB, pool } = require('./db');
const LB = require('./utils/leaderboard');

// The router is mounted for real below, so the handlers themselves are on
// trial - the parse, the roster match and the write, end to end. Only the auth
// middleware is stubbed, and only because a JWT and a 2FA code prove nothing
// about a spreadsheet. Everything past requireAuth is the shipping code.
const TEST_USER = { id: 9000, name: 'Ada Admin', role: 'admin' };
const authPath = require.resolve('./middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, children: [], paths: [],
  exports: {
    requireAuth: function (req, res, next) { req.user = TEST_USER; next(); },
    requirePermission: function () { return function (req, res, next) { next(); }; },
    requireRole: function () { return function (req, res, next) { next(); }; },
    userHasExtraPerm: async function () { return false; }
  }
};
const ROUTE = require('./routes/leaderboard');

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
  leaderboard_weeks: ['id', 'metric', 'week_start', 'file_name', 'file_hash', 'sheet_name',
    'name_column', 'value_column', 'city_column', 'row_count', 'matched_count', 'total_value',
    'uploaded_by', 'uploaded_by_name', 'created_at', 'updated_at'],
  leaderboard_entries: ['id', 'week_id', 'rank', 'user_id', 'raw_name', 'match_tier', 'value',
    'city_code', 'created_at']
};

async function columnsOf(table) {
  const r = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
  return r.rows.map(function (x) { return x.column_name; });
}

// The sheet Monday actually looks like: a title, a date line, a blank, then the
// grid - with one person appearing twice and a Total row at the bottom.
function sampleGrid() {
  return [
    ['Weekly Performance', '', '', '', ''],
    ['08/17/2026 - 08/23/2026', '', '', '', ''],
    ['', '', '', '', ''],
    ['Tech ID', 'Location', 'Calls', 'Revenue', 'Batteries Sold'],
    ['Benson, Chris', 'VAB', '31', '$4,210.55', '9'],
    ['Sawyer III, Darrell', 'VAB', '22', '3,980.00', '14'],
    ['Harris, Donald E', 'CHE', '18', '2,100.10', '4'],
    ['Benson, Chris', 'VAB', '4', '900.00', '2'],
    ['Ghost, Nobody', 'CHE', '5', '640.00', '1'],
    ['Bad Row', 'CHE', '2', 'n/a', ''],
    ['Total', '', '82', '11,830.65', '30']
  ];
}

async function xlsxOf(grid, sheetName) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName || 'Week');
  grid.forEach(function (row) { ws.addRow(row); });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------------------------------------------------
 *  The routes themselves, over real HTTP.
 * --------------------------------------------------------------------- */

async function httpTests(grid) {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/leaderboard', ROUTE);
  const server = await new Promise(function (resolve) {
    const srv = app.listen(0, '127.0.0.1', function () { resolve(srv); });
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/leaderboard';

  async function call(method, p, body) {
    const r = await fetch(base + p, {
      method: method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var j = null;
    try { j = await r.json(); } catch (e) {}
    return { status: r.status, body: j };
  }

  try {
    await pool.query('DELETE FROM leaderboard_entries');
    await pool.query('DELETE FROM leaderboard_weeks');
    await pool.query('DELETE FROM users WHERE email LIKE $1', ['lbhttp-%']);
    // The roster fixtures from the section above share names with the ones
    // below. Two people with one name is a real case and it is tested on its
    // own further up - it must not quietly colour the whole HTTP run.
    await pool.query('DELETE FROM users WHERE email LIKE $1', ['lbtest-%']);
    await pool.query(
      "INSERT INTO users (id,name,email,password_hash,role,active,home_city,pulsar_name) VALUES " +
      "(9000,'Ada Admin','lbhttp-0@example.com','x','admin',true,'VAB',NULL)," +
      "(9101,'Chris Benson','lbhttp-1@example.com','x','locksmith',true,'VAB',NULL)," +
      "(9102,'Darrell Sawyer','lbhttp-2@example.com','x','locksmith',true,'VAB','Sawyer III, Darrell')," +
      "(9103,'Donald Harris','lbhttp-3@example.com','x','locksmith',true,'CHE',NULL)"
    );
    await pool.query("SELECT setval('users_id_seq',(SELECT MAX(id) FROM users));");

    const b64 = (await xlsxOf(grid, 'Week 34')).toString('base64');

    // ---- preview ---------------------------------------------------------
    var pv = await call('POST', '/preview', { metric: 'revenue', filename: 'week34.xlsx', file_base64: b64 });
    eq('POST /preview succeeds', pv.status, 200);
    eq('preview: header row found', pv.body.header_row, 3);
    eq('preview: name column guessed', pv.body.suggestion.name, 0);
    eq('preview: revenue column guessed', pv.body.suggestion.value, 3);
    eq('preview: people found', pv.body.rows_found, 4);
    eq('preview: the top name is resolved to the roster', pv.body.resolved[0].matched_name, 'Chris Benson');
    eq('preview: the duplicate lines were folded', pv.body.resolved[0].lines, 2);
    eq('preview: one name matched nobody', pv.body.unmatched, 1);
    eq('preview: the Total row was ignored', pv.body.skipped.total_row, 1);
    ok('preview: stores nothing',
       (await pool.query('SELECT COUNT(*)::int AS n FROM leaderboard_weeks')).rows[0].n === 0);

    // Same file, told it is the battery board: a different column, and the
    // pulsar_name match is used for Darrell.
    var pvb = await call('POST', '/preview', { metric: 'batteries', filename: 'week34.xlsx', file_base64: b64 });
    eq('preview: the battery board picks Batteries Sold', pvb.body.suggestion.value, 4);
    eq('preview: and ranks by batteries', pvb.body.resolved[0].raw_name, 'Sawyer III, Darrell');
    eq('preview: pulsar_name is the tier that matched him', pvb.body.resolved[0].match_tier, 1);

    // A column the human overrides is respected.
    var pvo = await call('POST', '/preview', {
      metric: 'revenue', filename: 'week34.xlsx', file_base64: b64,
      sheet: 'Week 34', header_row: 3, name_col: 0, value_col: 4, city_col: -1
    });
    eq('preview: an overridden column is used', pvo.body.resolved[0].value, 14);
    eq('preview: and city can be turned off', pvo.body.resolved[0].city_code, null);

    var pvBad = await call('POST', '/preview', { metric: 'revenue', filename: 'x.xlsx', file_base64: Buffer.from('not a workbook').toString('base64') });
    eq('preview: junk is refused', pvBad.status, 400);
    ok('preview: with a sentence a human can act on', /save it as|could not read/i.test(pvBad.body.error), pvBad.body.error);

    // ---- import ----------------------------------------------------------
    var im = await call('POST', '/import', {
      metric: 'batteries', week_start: '2026-08-17', filename: 'week34.xlsx', file_base64: b64,
      sheet: 'Week 34', header_row: 3, name_col: 0, value_col: 4, city_col: 1
    });
    eq('POST /import succeeds', im.status, 200);
    eq('import: four people', im.body.rows, 4);
    eq('import: three of them matched', im.body.matched, 3);
    ok('import: it is a new week, not a replacement', im.body.replaced === false);

    var home = await call('GET', '/home');
    eq('GET /home succeeds', home.status, 200);
    eq('home: the battery board is live', home.body.batteries.week_start, '2026-08-17');
    eq('home: ranked by batteries', home.body.batteries.top[0].name, 'Darrell Sawyer');
    eq('home: value carried through', home.body.batteries.top[0].value, 14);
    eq('home: the unmatched name still appears', home.body.batteries.top[3].name, 'Ghost, Nobody');
    ok('home: and is marked as unlinked', home.body.batteries.top[3].user_id === null);
    ok('home: the revenue board is absent until it is uploaded', home.body.revenue === null);
    eq('home: no more than five rows', home.body.batteries.top.length, 4);

    // Re-uploading the SAME metric and week replaces it rather than doubling it.
    var im2 = await call('POST', '/import', {
      metric: 'batteries', week_start: '2026-08-17', filename: 'week34-fixed.xlsx', file_base64: b64,
      sheet: 'Week 34', header_row: 3, name_col: 0, value_col: 3, city_col: 1
    });
    ok('import: the second upload replaces the first', im2.body.replaced === true);
    eq('one week row, not two',
       (await pool.query("SELECT COUNT(*)::int AS n FROM leaderboard_weeks WHERE metric='batteries'")).rows[0].n, 1);
    eq('and its rows were replaced, not added to',
       (await pool.query('SELECT COUNT(*)::int AS n FROM leaderboard_entries')).rows[0].n, 4);
    var home2 = await call('GET', '/home');
    eq('home reflects the corrected column immediately', home2.body.batteries.top[0].name, 'Chris Benson');
    eq('and the corrected number', home2.body.batteries.top[0].value, 5110.55);

    // ---- what import refuses --------------------------------------------
    eq('import without a week is refused',
       (await call('POST', '/import', { metric: 'revenue', file_base64: b64, filename: 'x.xlsx' })).status, 400);
    eq('import onto an unknown board is refused',
       (await call('POST', '/import', { metric: 'morale', week_start: '2026-08-17', file_base64: b64, filename: 'x.xlsx' })).status, 400);
    eq('import with the name and number in one column is refused',
       (await call('POST', '/import', { metric: 'revenue', week_start: '2026-08-17', file_base64: b64,
                                        filename: 'x.xlsx', name_col: 0, value_col: 0 })).status, 400);
    eq('import with no file is refused',
       (await call('POST', '/import', { metric: 'revenue', week_start: '2026-08-17', filename: 'x.xlsx' })).status, 400);
    var emptySheet = (await xlsxOf([['Name', 'Revenue']], 'Empty')).toString('base64');
    var imEmpty = await call('POST', '/import', {
      metric: 'revenue', week_start: '2026-08-17', filename: 'empty.xlsx', file_base64: emptySheet,
      header_row: 0, name_col: 0, value_col: 1, city_col: -1
    });
    eq('a sheet with a header and nothing under it is refused', imEmpty.status, 400);
    eq('and nothing was written', (await pool.query("SELECT COUNT(*)::int AS n FROM leaderboard_weeks WHERE metric='revenue'")).rows[0].n, 0);

    // ---- linking through the route --------------------------------------
    var wkId = (await pool.query("SELECT id FROM leaderboard_weeks WHERE metric='batteries'")).rows[0].id;
    var ghost = (await pool.query("SELECT id FROM leaderboard_entries WHERE week_id=$1 AND raw_name='Ghost, Nobody'", [wkId])).rows[0];
    var lk = await call('POST', '/entry/' + ghost.id, { user_id: 9103 });
    eq('POST /entry links a row', lk.status, 200);
    var afterLink = await call('GET', '/home');
    // Donald Harris was already on this board, so the two rows must have merged.
    eq('linking onto somebody already there merges them', afterLink.body.batteries.top.length, 3);
    var donald = afterLink.body.batteries.top.filter(function (r) { return r.name === 'Donald Harris'; });
    eq('the merged row appears once', donald.length, 1);
    eq('with both numbers added up', donald[0].value, 2740.1);
    eq('and the board is still ranked 1..n',
       afterLink.body.batteries.top.map(function (r) { return r.rank; }), [1, 2, 3]);

    eq('unlinking is allowed too', (await call('POST', '/entry/' + ghost.id, { user_id: null })).status, 200);
    eq('linking a row that is not there 404s', (await call('POST', '/entry/999999', { user_id: 9101 })).status, 404);
    eq('linking to somebody who is not a user is refused', (await call('POST', '/entry/' + ghost.id, { user_id: 424242 })).status, 400);

    // ---- the list, and removing a week ----------------------------------
    var lst = await call('GET', '/');
    eq('GET / lists the week', lst.body.weeks.length, 1);
    eq('and names its leader', lst.body.weeks[0].leader, 'Chris Benson');
    eq('and offers the week that just ended as the default', lst.body.default_week, LB.lastMonday());

    var det = await call('GET', '/week/' + wkId);
    eq('GET /week/:id returns every row, not just five', det.body.entries.length, 3);
    ok('and the roster to link them against', (det.body.roster || []).length >= 4);

    eq('DELETE removes the week', (await call('DELETE', '/week/' + wkId)).status, 200);
    eq('deleting it twice 404s', (await call('DELETE', '/week/' + wkId)).status, 404);
    var homeGone = await call('GET', '/home');
    ok('and the home card goes quiet rather than erroring', homeGone.body.batteries === null);

    // ---- the audit trail -------------------------------------------------
    var audit = await pool.query(
      "SELECT action FROM audit_logs WHERE entity_type = 'leaderboard' ORDER BY id");
    ok('every publish, edit and removal is audited', audit.rows.length >= 4, JSON.stringify(audit.rows));
    ok('including the delete', audit.rows.some(function (r) { return r.action === 'deleted'; }));
    ok('and the replacement', audit.rows.some(function (r) { return r.action === 'edited'; }));

    await pool.query('DELETE FROM users WHERE email LIKE $1', ['lbhttp-%']);
    await pool.query("DELETE FROM audit_logs WHERE entity_type = 'leaderboard'");
  } finally {
    server.close();
  }
}

async function main() {
  console.log('Leaderboard tests');
  console.log('-----------------');

  await initDB();
  await initDB();          // a migration that is not idempotent dies here
  ok('initDB runs twice', true);

  // ---- schema -----------------------------------------------------------
  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    const have = await columnsOf(table);
    REQUIRED_COLUMNS[table].forEach(function (c) {
      ok('column ' + table + '.' + c, have.indexOf(c) !== -1);
    });
  }
  const idx = (await pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename IN ('leaderboard_weeks','leaderboard_entries')"
  )).rows.map(function (r) { return r.indexname; });
  ok('unique (metric, week_start) index exists', idx.indexOf('leaderboard_weeks_metric_week_idx') !== -1, idx.join(','));
  ok('entries are indexed by week + rank', idx.indexOf('leaderboard_entries_week_idx') !== -1);

  // ---- reading numbers ---------------------------------------------------
  eq('toNumber money', LB.toNumber('$4,210.55'), 4210.55);
  eq('toNumber parens are negative', LB.toNumber('(45)'), -45);
  eq('toNumber plain', LB.toNumber(12), 12);
  eq('toNumber refuses words', LB.toNumber('n/a'), null);
  eq('toNumber refuses a number with units', LB.toNumber('12 batteries'), null);
  eq('toNumber keeps zero as zero, not null', LB.toNumber('0'), 0);
  eq('toNumber blank is null', LB.toNumber(''), null);

  // ---- csv ---------------------------------------------------------------
  var csv = LB.csvGrid('Name,Revenue\n"Benson, Chris",\"$1,200.00\"\nSawyer,900\n');
  eq('csv keeps a comma inside quotes', csv[1][0], 'Benson, Chris');
  eq('csv row count', csv.length, 3);

  // ---- finding the grid inside the report --------------------------------
  var grid = sampleGrid();
  eq('header row found under the title block', LB.findHeaderRow(grid), 3);

  var aRev = LB.analyzeSheet(grid, 'revenue');
  eq('revenue: name column', aRev.suggestion.name, 0);
  eq('revenue: value column', aRev.suggestion.value, 3);
  eq('revenue: city column', aRev.suggestion.city, 1);
  ok('revenue: confident', aRev.confident === true);

  var aBat = LB.analyzeSheet(grid, 'batteries');
  eq('batteries: same name column', aBat.suggestion.name, 0);
  eq('batteries: picks Batteries Sold, not Revenue', aBat.suggestion.value, 4);

  // A header word must not be able to win when it is the name column.
  var same = LB.analyzeSheet([['Total', 'Amount'], ['Chris', '10']], 'revenue');
  ok('name and value are never the same column', same.suggestion.name !== same.suggestion.value,
     JSON.stringify(same.suggestion));

  // ---- turning the grid into rows ----------------------------------------
  var x = LB.extractRows(grid, { header_row: 3, name_col: 0, value_col: 3, city_col: 1 });
  eq('rows: one per person, not one per line', x.rows.length, 4);
  eq('rows: the duplicate is summed', x.rows[0].raw_name, 'Benson, Chris');
  eq('rows: summed value', x.rows[0].value, 5110.55);
  eq('rows: two lines were folded in', x.rows[0].lines, 2);
  eq('rows: sorted highest first', x.rows.map(function (r) { return r.value; }), [5110.55, 3980, 2100.1, 640]);
  eq('rows: city carried', x.rows[0].city_code, 'VAB');
  eq('rows: the Total line is ignored', x.skipped.total_row, 1);
  eq('rows: the unreadable number is skipped, not zeroed', x.skipped.no_value, 1);

  // Ties break on name so the same file always produces the same order.
  var tie = LB.extractRows([['n', 'v'], ['Zeb', '10'], ['Abe', '10']],
    { header_row: 0, name_col: 0, value_col: 1, city_col: -1 });
  eq('ties break on name', tie.rows.map(function (r) { return r.raw_name; }), ['Abe', 'Zeb']);

  // ---- reading a real workbook -------------------------------------------
  var buf = await xlsxOf(grid, 'Week 34');
  var book = await LB.readWorkbook(buf, 'week34.xlsx');
  eq('xlsx: sheet name survives', book.sheets[0].name, 'Week 34');
  var xr = LB.extractRows(book.sheets[0].grid, { header_row: LB.findHeaderRow(book.sheets[0].grid), name_col: 0, value_col: 3, city_col: 1 });
  eq('xlsx: same rows as the grid it was written from', xr.rows.length, 4);
  eq('xlsx: same top value', xr.rows[0].value, 5110.55);

  var csvBook = await LB.readWorkbook(Buffer.from('Name,Revenue\nChris,100\nDarrell,50\n', 'utf8'), 'w.csv');
  eq('csv: read as one sheet', csvBook.sheets.length, 1);
  eq('csv: rows', LB.extractRows(csvBook.sheets[0].grid, { header_row: 0, name_col: 0, value_col: 1, city_col: -1 }).rows.length, 2);

  var xlsErr = null;
  try { await LB.readWorkbook(Buffer.from('nope'), 'old.xls'); } catch (e) { xlsErr = e; }
  ok('an old .xls is refused with something a human can act on', !!xlsErr && xlsErr.userFacing === true,
     xlsErr && xlsErr.message);
  var junkErr = null;
  try { await LB.readWorkbook(Buffer.from('not a workbook at all'), 'x.xlsx'); } catch (e) { junkErr = e; }
  ok('a non-workbook is refused, not half-imported', !!junkErr && junkErr.userFacing === true);

  // ---- who is this? ------------------------------------------------------
  await pool.query('DELETE FROM leaderboard_entries');
  await pool.query('DELETE FROM leaderboard_weeks');
  // Both roster fixtures, in case a previous run died before its own cleanup.
  // They deliberately share names, so a leftover row from one poisons the other.
  await pool.query('DELETE FROM users WHERE email LIKE $1 OR email LIKE $2', ['lbtest-%', 'lbhttp-%']);
  await pool.query(
    "INSERT INTO users (id,name,email,password_hash,role,active,home_city,pulsar_name,nickname) VALUES " +
    "(9001,'Chris Benson','lbtest-1@example.com','x','locksmith',true,'VAB',NULL,NULL)," +
    "(9002,'Darrell Sawyer','lbtest-2@example.com','x','locksmith',true,'VAB','Sawyer III, Darrell',NULL)," +
    "(9003,'Donald Harris','lbtest-3@example.com','x','locksmith',true,'CHE',NULL,'Don')," +
    "(9004,'Dana Harris','lbtest-4@example.com','x','locksmith',true,'CHE',NULL,NULL)," +
    "(9005,'Retired Harris','lbtest-5@example.com','x','locksmith',false,'CHE',NULL,NULL)"
  );
  await pool.query("SELECT setval('users_id_seq',(SELECT MAX(id) FROM users));");

  const users = (await pool.query('SELECT id, name, pulsar_name, nickname, active, home_city FROM users')).rows;
  const R = LB.buildResolver(users);
  eq('pulsar_name is the most trusted match', R.resolve('Sawyer III, Darrell').tier, 1);
  eq('pulsar_name resolves to the right person', R.resolve('Sawyer III, Darrell').user_id, 9002);
  eq('users.name matches "Last, First"', R.resolve('Benson, Chris').user_id, 9001);
  eq('users.name tier', R.resolve('Benson, Chris').tier, 2);
  eq('a nickname matches', R.resolve('Don').user_id, 9003);
  // Two active Harrises share a last name, so "Harris, D" must NOT guess.
  eq('an ambiguous last name + initial refuses to guess', R.resolve('Harris, D').user_id, null);
  eq('a name nobody answers to stays unmatched', R.resolve('Ghost, Nobody').user_id, null);
  // Donald Harris still matches on his full name even though the initial is
  // ambiguous - the exact tiers run first.
  eq('the exact name still wins over the ambiguity', R.resolve('Harris, Donald E').user_id, 9003);

  // Two ACTIVE people with the same full name: neither is credited, because
  // picking one would be a coin flip nobody would ever notice.
  const R2 = LB.buildResolver(users.concat([{ id: 9999, name: 'Donald Harris', active: true }]));
  eq('two people with one name is left for a human', R2.resolve('Harris, Donald E').user_id, null);
  eq('and everybody else still matches', R2.resolve('Benson, Chris').user_id, 9001);
  // The same person claiming a key twice (name == nickname) is not ambiguity.
  const R3 = LB.buildResolver([{ id: 1, name: 'Kay Young', nickname: 'Kay Young', active: true }]);
  eq('one person claiming a key twice still matches', R3.resolve('Young, Kay').user_id, 1);

  // ---- the week, as routes/leaderboard.js writes it -----------------------
  var rows = LB.extractRows(grid, { header_row: 3, name_col: 0, value_col: 3, city_col: 1 }).rows
    .map(function (r, i) {
      var hit = R.resolve(r.raw_name);
      return { rank: i + 1, raw_name: r.raw_name, value: r.value, city_code: r.city_code,
               user_id: hit.user_id, match_tier: hit.tier };
    });
  eq('three of the four rows matched somebody', rows.filter(function (r) { return r.user_id; }).length, 3);

  async function writeWeek(metric, week, list) {
    const w = await pool.query(
      'INSERT INTO leaderboard_weeks (metric, week_start, file_name, row_count, matched_count, total_value, uploaded_by_name) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [metric, week, 'week.xlsx', list.length, list.filter(function (r) { return r.user_id; }).length,
       list.reduce(function (s, r) { return s + r.value; }, 0), 'Tester']
    );
    const id = w.rows[0].id;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      await pool.query(
        'INSERT INTO leaderboard_entries (week_id, rank, user_id, raw_name, match_tier, value, city_code) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, r.rank, r.user_id, r.raw_name, r.match_tier, r.value, r.city_code || null]
      );
    }
    return id;
  }

  const wkOld = await writeWeek('revenue', '2026-08-10', rows);
  const wkNew = await writeWeek('revenue', '2026-08-17', rows);
  await writeWeek('batteries', '2026-08-17', rows);

  var dupe = null;
  try { await writeWeek('revenue', '2026-08-17', rows); } catch (e) { dupe = e; }
  ok('the same metric + week cannot be published twice', !!dupe, 'a second row was allowed in');

  // The Home card's query, verbatim in shape: latest week, top five, in order.
  const latest = await pool.query(
    'SELECT id, week_start::text AS week_start FROM leaderboard_weeks WHERE metric = $1 ORDER BY week_start DESC LIMIT 1',
    ['revenue']
  );
  eq('home reads the newest week', latest.rows[0].week_start, '2026-08-17');
  const top = await pool.query(
    'SELECT e.rank, e.user_id, e.raw_name, e.value, u.name AS user_name ' +
    'FROM leaderboard_entries e LEFT JOIN users u ON u.id = e.user_id ' +
    'WHERE e.week_id = $1 ORDER BY e.rank ASC LIMIT 5', [latest.rows[0].id]
  );
  eq('home top order', top.rows.map(function (r) { return r.user_name || r.raw_name; }),
     ['Chris Benson', 'Darrell Sawyer', 'Donald Harris', 'Ghost, Nobody']);
  eq('a matched row shows the roster name, not the sheet spelling', top.rows[0].user_name, 'Chris Benson');
  eq('an unmatched row still appears, under the sheet spelling', top.rows[3].raw_name, 'Ghost, Nobody');

  // Renaming somebody in Users moves them on the board.
  await pool.query("UPDATE users SET name = 'Christopher Benson' WHERE id = 9001");
  const renamed = await pool.query(
    'SELECT COALESCE(u.name, e.raw_name) AS label FROM leaderboard_entries e LEFT JOIN users u ON u.id = e.user_id ' +
    'WHERE e.week_id = $1 ORDER BY e.rank ASC LIMIT 1', [latest.rows[0].id]
  );
  eq('a rename in Users follows onto the board', renamed.rows[0].label, 'Christopher Benson');
  await pool.query("UPDATE users SET name = 'Chris Benson' WHERE id = 9001");

  // ---- the list screen's leader sub-select --------------------------------
  const list = await pool.query(
    'SELECT w.id, w.metric, w.week_start::text AS week_start, ' +
    '       (SELECT COALESCE(u.name, e.raw_name) FROM leaderboard_entries e ' +
    '          LEFT JOIN users u ON u.id = e.user_id ' +
    '         WHERE e.week_id = w.id ORDER BY e.rank ASC LIMIT 1) AS leader ' +
    'FROM leaderboard_weeks w ORDER BY w.week_start DESC, w.metric ASC'
  );
  eq('the list names the leader of each week', list.rows[0].leader, 'Chris Benson');
  eq('the list is newest first', list.rows[0].week_start, '2026-08-17');

  // ---- linking an unmatched name -----------------------------------------
  // "Ghost, Nobody" is really Dana Harris. Linking must re-rank, not just
  // relabel, and must never leave the stored rank out of step with the values.
  const ghost = await pool.query(
    "SELECT id FROM leaderboard_entries WHERE week_id = $1 AND raw_name = 'Ghost, Nobody'", [wkNew]);
  const client = await pool.connect();
  try {
    await client.query('UPDATE leaderboard_entries SET user_id = 9004, match_tier = 0 WHERE id = $1', [ghost.rows[0].id]);
    await ROUTE.rerank(client, wkNew);
  } finally { client.release(); }
  var after = await pool.query(
    'SELECT e.rank, COALESCE(u.name, e.raw_name) AS label, e.value FROM leaderboard_entries e ' +
    'LEFT JOIN users u ON u.id = e.user_id WHERE e.week_id = $1 ORDER BY e.rank', [wkNew]);
  eq('linking relabels the row', after.rows[3].label, 'Dana Harris');
  eq('rank stays 1..n after a link', after.rows.map(function (r) { return r.rank; }), [1, 2, 3, 4]);
  var wkRow = (await pool.query('SELECT row_count, matched_count, total_value FROM leaderboard_weeks WHERE id = $1', [wkNew])).rows[0];
  eq('the week counts the new match', wkRow.matched_count, 4);
  eq('the week keeps its row count', wkRow.row_count, 4);

  // ---- linking somebody who is ALREADY on the board must merge ------------
  // Two spellings of Chris on one sheet: without the merge he lands on the
  // board twice with half his revenue each, which is the worst possible
  // outcome for a board people are meant to trust.
  await pool.query(
    'INSERT INTO leaderboard_entries (week_id, rank, user_id, raw_name, value, city_code) VALUES ($1,$2,NULL,$3,$4,$5)',
    [wkNew, 5, 'C. Benson', 1000, 'VAB']);
  const stray = await pool.query("SELECT id FROM leaderboard_entries WHERE week_id = $1 AND raw_name = 'C. Benson'", [wkNew]);
  const c2 = await pool.connect();
  try {
    // Exactly what routes/leaderboard.js POST /entry/:id does when a twin exists.
    const twin = await c2.query(
      'SELECT id, value FROM leaderboard_entries WHERE week_id = $1 AND user_id = $2 AND id <> $3',
      [wkNew, 9001, stray.rows[0].id]);
    var merged = 1000;
    twin.rows.forEach(function (t) { merged += Number(t.value); });
    await c2.query('DELETE FROM leaderboard_entries WHERE id = ANY($1::int[])', [twin.rows.map(function (t) { return t.id; })]);
    await c2.query('UPDATE leaderboard_entries SET user_id=$2, match_tier=0, value=$3 WHERE id=$1',
      [stray.rows[0].id, 9001, merged]);
    await ROUTE.rerank(c2, wkNew);
  } finally { c2.release(); }
  const mergedRows = await pool.query(
    'SELECT e.rank, COALESCE(u.name, e.raw_name) AS label, e.value FROM leaderboard_entries e ' +
    'LEFT JOIN users u ON u.id = e.user_id WHERE e.week_id = $1 ORDER BY e.rank', [wkNew]);
  eq('the two spellings became one row', mergedRows.rows.filter(function (r) { return r.label === 'Chris Benson'; }).length, 1);
  eq('and the numbers were added, not replaced', Number(mergedRows.rows[0].value), 6110.55);
  eq('still four people on the board', mergedRows.rows.length, 4);
  eq('and still ranked 1..n', mergedRows.rows.map(function (r) { return r.rank; }), [1, 2, 3, 4]);

  // ---- re-uploading a week replaces it ------------------------------------
  const c3 = await pool.connect();
  try {
    await c3.query('DELETE FROM leaderboard_entries WHERE week_id = $1', [wkNew]);
    await c3.query('INSERT INTO leaderboard_entries (week_id, rank, user_id, raw_name, value) VALUES ($1,1,9001,$2,$3)',
      [wkNew, 'Benson, Chris', 25]);
    await ROUTE.rerank(c3, wkNew);
  } finally { c3.release(); }
  const replaced = await pool.query('SELECT COUNT(*)::int AS n FROM leaderboard_entries WHERE week_id = $1', [wkNew]);
  eq('a replaced week keeps none of the old rows', replaced.rows[0].n, 1);
  const weeksNow = await pool.query("SELECT COUNT(*)::int AS n FROM leaderboard_weeks WHERE metric='revenue'");
  eq('and does not leave a second week behind', weeksNow.rows[0].n, 2);

  // ---- deleting a week ----------------------------------------------------
  await pool.query('DELETE FROM leaderboard_weeks WHERE id = $1', [wkOld]);
  const orphans = await pool.query('SELECT COUNT(*)::int AS n FROM leaderboard_entries WHERE week_id = $1', [wkOld]);
  eq('deleting a week takes its rows with it', orphans.rows[0].n, 0);

  // ---- deactivating somebody must not blank the board ---------------------
  await pool.query('DELETE FROM users WHERE id = 9004');
  const survivor = await pool.query('SELECT COUNT(*)::int AS n FROM leaderboard_entries WHERE week_id = $1', [wkNew]);
  ok('deleting a user does not delete their board rows', survivor.rows[0].n === 1);

  // ---- weeks --------------------------------------------------------------
  eq('lastMonday of a Friday is the Monday before last', LB.lastMonday('2026-08-28T12:00:00Z'), '2026-08-17');
  eq('lastMonday of a Monday is the week before', LB.lastMonday('2026-08-24T12:00:00Z'), '2026-08-17');
  eq('week label', LB.weekLabel('2026-08-17'), 'Aug 17 - Aug 23, 2026');

  await httpTests(grid);

  // ---- cleanup ------------------------------------------------------------
  await pool.query('DELETE FROM leaderboard_entries');
  await pool.query('DELETE FROM leaderboard_weeks');
  await pool.query('DELETE FROM users WHERE email LIKE $1 OR email LIKE $2', ['lbtest-%', 'lbhttp-%']);

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
