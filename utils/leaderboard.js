/*
 * Weekly leaderboards: reading the spreadsheet, and deciding who each row is.
 *
 * Nova cannot compute either number on these boards. Revenue lives in Pulsar
 * and batteries are counted at the counter, so both arrive as a spreadsheet
 * somebody uploads on Monday. The shape of that spreadsheet is not fixed and
 * never will be - it is whatever the report tool exported that week - so this
 * file GUESSES the columns and then hands the guess back to a human to confirm.
 * Nothing here decides anything on its own that a wrong guess would hide.
 *
 * Two things are deliberate:
 *   1. A row whose name matches nobody on the roster is KEPT, as raw text. An
 *      importer that quietly drops what it cannot match is how a board ends up
 *      missing the person who actually won the week.
 *   2. raw_name is stored even when the match succeeded, so a wrong link can be
 *      seen afterwards. The DISPLAY name comes from users.name, so renaming
 *      somebody in Users moves them on the board instead of splitting them.
 *
 * House style: string concatenation only, no template literals.
 */
var PC = require('./pulsarCash');

// The two boards. 'hints' are header words that mean "this is the number";
// they are matched as substrings of a squashed header, most-specific first.
//
// 'preset' is a group of headers that belong TOGETHER, and it beats every hint
// when the whole group is present. Revenue on a Pulsar call export is not one
// column: money arrives as cash, a check, a card or on account, and the four
// have to be added. Guessing one of them - or worse, "Tech Paid Gross", which
// is what the TECH earned - is exactly the wrong answer, so the group wins.
var METRICS = {
  revenue: {
    key: 'revenue',
    label: 'Top Revenue',
    unit: 'money',
    // Money is ADDED UP out of columns.
    mode: 'sum',
    preset: ['collected cash', 'collected check', 'collected cc', 'collected account'],
    hints: ['total collected', 'collected', 'revenue', 'total sales', 'gross sales',
            'sales', 'total', 'amount', 'ticket', 'invoiced', 'billed', 'gross']
  },
  batteries: {
    key: 'batteries',
    label: 'Most Batteries Sold',
    unit: 'count',
    // Batteries are COUNTED, not added up. There is no quantity column on a
    // Pulsar export: a battery sale is a CALL whose Task says "batt", and the
    // board is how many of those calls each tech completed. Tony's rule, and
    // the only one the export can actually answer.
    mode: 'count',
    default_match: 'batt',
    hints: ['batteries sold', 'battery sold', 'batteries', 'battery', 'batt',
            'units sold', 'units', 'qty sold', 'qty', 'quantity', 'sold', 'count']
  }
};

// The column holding what the call WAS, for a counting board.
var MATCH_HINTS = ['task', 'service', 'service type', 'job type', 'call type',
                   'description', 'work performed', 'item'];

// The column holding how the call ENDED. Pulsar writes Completed / GOA /
// Canceled in "Status"; "Process Status" is a billing flag (Confirmed) and is
// deliberately further down the list.
var STATUS_HINTS = ['status', 'call status', 'job status', 'disposition',
                    'outcome', 'process status'];

// Which of those values mean the work actually happened. Used to pre-tick the
// status list; the human still confirms it.
var DONE_STATUS = /^(completed|complete|done|closed|finished|paid)$/i;

function isMetric(m) { return Object.prototype.hasOwnProperty.call(METRICS, String(m)); }

// Header words that mean "this column is the person".
var NAME_HINTS = ['tech id', 'tech name', 'technician', 'employee name', 'employee',
                  'locksmith', 'salesperson', 'sales rep', 'tech', 'name', 'agent',
                  'rep', 'user', 'staff', 'person'];

// Header words that mean "this column is the city / market".
var CITY_HINTS = ['city code', 'city', 'location', 'market', 'branch', 'store', 'shop', 'office'];

// Numeric columns that are never the board's number, whatever else their header
// says. 'Tech Paid Gross' is what the technician EARNED and it sits right next
// to the money on a Pulsar export; picking it would put the highest-paid person
// on a board labelled revenue. 'Charged' is what was billed, not what came in.
var NOT_VALUE_HINTS = ['tech paid', 'paid gross', 'cost of goods', 'cost', 'mileage',
                       'cycle time', 'charged', 'tax', 'discount', 'commission'];

// Rows whose name cell is one of these are the sheet's own summary lines, not
// people. They would otherwise win every board by a mile.
var TOTAL_ROW = /^(grand\s+)?(total|totals|sum|subtotal|all|average|avg)\b/i;

function squash(s) { return PC.squash(s); }

/* ---------------------------------------------------------------- cells --- */

// exceljs hands back numbers, strings, Dates, rich text, formula results and
// hyperlink objects depending on how the cell was authored. Everything below
// works on the plain text, so flatten once here.
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) {
      return v.richText.map(function (t) { return t.text || ''; }).join('').trim();
    }
    if (v.text !== undefined && v.text !== null) return cellText(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v.formula !== undefined) return '';
    if (v.error !== undefined) return '';
  }
  return String(v).trim();
}

// "$1,234.56" -> 1234.56 ; "(45)" -> -45 ; "12 batteries" -> null.
// A cell that is not cleanly a number returns null rather than 0, because 0 is
// a real result on these boards and "could not read it" is not.
function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var s = cellText(v);
  if (s === '') return null;
  var neg = /^\(.*\)$/.test(s);
  s = s.replace(/^\(|\)$/g, '').replace(/[$,\s]/g, '').replace(/%$/, '');
  if (s === '' || !/^-?\d*\.?\d+$/.test(s)) return null;
  var n = Number(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

function isNumericCell(v) { return toNumber(v) !== null; }

/* ----------------------------------------------------------- the files --- */

// CSV -> grid of strings. Handles quoted fields, embedded commas/newlines and
// doubled quotes. (PC.parseCSV returns objects keyed by header; header
// detection here needs the raw grid, headers included.)
function csvGrid(text) {
  var s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  var rows = [], row = [], cur = '', q = false, i = 0;
  for (; i < s.length; i++) {
    var c = s.charAt(i);
    if (q) {
      if (c === '"') {
        if (s.charAt(i + 1) === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += c;
      continue;
    }
    if (c === '"') { q = true; continue; }
    if (c === ',') { row.push(cur); cur = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; continue; }
    cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map(function (r) { return r.map(function (x) { return String(x).trim(); }); });
}

// Read a spreadsheet into { sheets: [{ name, grid }] }.
// buffer: a Buffer. filename decides the reader; anything that is not .xlsx /
// .xlsm is read as text.
async function readWorkbook(buffer, filename) {
  var name = String(filename || '').toLowerCase();
  if (/\.(csv|txt|tsv)$/.test(name)) {
    var text = buffer.toString('utf8');
    if (/\.tsv$/.test(name)) {
      return { sheets: [{ name: 'Sheet1', grid: text.split(/\r?\n/).map(function (l) { return l.split('\t').map(function (x) { return x.trim(); }); }) }] };
    }
    return { sheets: [{ name: 'Sheet1', grid: csvGrid(text) }] };
  }
  // .xls (the old binary format) is NOT readable by exceljs. Say so plainly
  // rather than failing with a parser error nobody can act on.
  if (/\.xls$/.test(name)) {
    var e = new Error('That is an old-format .xls file. Open it in Excel and Save As .xlsx (or .csv), then upload again.');
    e.userFacing = true;
    throw e;
  }
  var ExcelJS = require('exceljs');
  var wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    var e2 = new Error('Nova could not read that file as a spreadsheet. Save it as .xlsx or .csv and try again.');
    e2.userFacing = true;
    throw e2;
  }
  var sheets = [];
  wb.eachSheet(function (ws) {
    var grid = [];
    var width = ws.columnCount || 0;
    ws.eachRow({ includeEmpty: true }, function (row) {
      var out = [];
      for (var c = 1; c <= Math.max(width, row.cellCount || 0); c++) {
        out.push(cellText(row.getCell(c).value));
      }
      grid.push(out);
    });
    sheets.push({ name: ws.name || ('Sheet' + (sheets.length + 1)), grid: trimGrid(grid) });
  });
  if (!sheets.length) {
    var e3 = new Error('That workbook has no sheets in it.');
    e3.userFacing = true;
    throw e3;
  }
  return { sheets: sheets };
}

// Drop fully-empty trailing rows and columns so the preview is not 900 blanks.
function trimGrid(grid) {
  var rows = grid.slice();
  while (rows.length && rows[rows.length - 1].every(function (c) { return c === ''; })) rows.pop();
  var width = 0;
  rows.forEach(function (r) {
    for (var i = r.length - 1; i >= 0; i--) { if (r[i] !== '') { if (i + 1 > width) width = i + 1; break; } }
  });
  return rows.map(function (r) { return r.slice(0, width); });
}

/* --------------------------------------------------------- the guessing --- */

// Which row holds the headers. Reports routinely open with a title line, a date
// line and a blank, so this looks for the first row that is mostly words and is
// followed by a row with a number in it.
function findHeaderRow(grid) {
  var limit = Math.min(grid.length - 1, 15);
  for (var r = 0; r < limit; r++) {
    var row = grid[r] || [];
    var texty = 0, filled = 0;
    for (var c = 0; c < row.length; c++) {
      if (row[c] === '') continue;
      filled++;
      if (!isNumericCell(row[c])) texty++;
    }
    if (filled < 2 || texty < 2) continue;
    for (var d = r + 1; d < Math.min(grid.length, r + 6); d++) {
      var below = grid[d] || [];
      for (var k = 0; k < below.length; k++) if (isNumericCell(below[k])) return r;
    }
  }
  return 0;
}

// hints are matched against the squashed header as substrings; earlier hints
// score higher, so 'batteries sold' beats a bare 'sold' on the same sheet.
function hintScore(header, hints) {
  var h = squash(header);
  if (h === '') return 0;
  for (var i = 0; i < hints.length; i++) {
    if (h === hints[i]) return 1000 - i;          // exact header wins outright
    if (h.indexOf(hints[i]) !== -1) return 500 - i;
  }
  return 0;
}

// Describe every column: its header, what the values under it look like, and a
// couple of samples for the confirm screen.
function profileColumns(grid, headerRow) {
  var header = grid[headerRow] || [];
  var width = header.length;
  grid.forEach(function (r) { if (r.length > width) width = r.length; });
  var cols = [];
  for (var c = 0; c < width; c++) {
    var filled = 0, numeric = 0, total = 0, samples = [];
    for (var r = headerRow + 1; r < grid.length; r++) {
      var v = (grid[r] || [])[c];
      if (v === undefined || v === '') continue;
      filled++;
      var n = toNumber(v);
      if (n !== null) { numeric++; total += n; }
      if (samples.length < 3) samples.push(String(v));
    }
    cols.push({
      index: c,
      header: (header[c] === undefined || header[c] === '') ? ('Column ' + colLetter(c)) : String(header[c]),
      raw_header: header[c] === undefined ? '' : String(header[c]),
      filled: filled,
      numeric_ratio: filled ? (numeric / filled) : 0,
      total: total,
      samples: samples
    });
  }
  return cols;
}

// Every distinct value under one column, most common first. The status filter
// on a counting board is a tick list of what is ACTUALLY in the file, not a
// guess at what Pulsar might have written this week.
function distinctValues(grid, headerRow, col, limit) {
  if (!(col >= 0)) return [];
  var tally = {}, order = [];
  for (var r = headerRow + 1; r < grid.length; r++) {
    var v = String(((grid[r] || [])[col]) === undefined ? '' : grid[r][col]).trim();
    if (v === '') continue;
    var k = squash(v);
    if (!tally[k]) { tally[k] = { value: v, count: 0 }; order.push(k); }
    tally[k].count++;
  }
  var out = order.map(function (k) { return tally[k]; });
  out.sort(function (a, b) { return b.count - a.count || a.value.localeCompare(b.value); });
  out.forEach(function (x) { x.done = DONE_STATUS.test(x.value); });
  return out.slice(0, limit || 40);
}

function colLetter(i) {
  var s = '';
  i = i + 1;
  while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/*
 * Look at one sheet and propose header row + name / value / city columns.
 * Returns everything the confirm screen needs, including the columns it did
 * NOT pick, because the whole point is that a human overrules this.
 */
function analyzeSheet(grid, metric, mode) {
  var m = METRICS[metric] || METRICS.revenue;
  mode = (mode === 'count' || mode === 'sum') ? mode : (m.mode || 'sum');
  var headerRow = findHeaderRow(grid);
  var cols = profileColumns(grid, headerRow);

  // Name: header hint first; failing that, the leftmost column that is mostly
  // words. A column with no values under it can never be the name column.
  var nameCol = -1, nameScore = 0;
  cols.forEach(function (c) {
    if (!c.filled) return;
    var s = hintScore(c.raw_header, NAME_HINTS);
    if (s > nameScore) { nameScore = s; nameCol = c.index; }
  });
  if (nameCol === -1) {
    cols.forEach(function (c) {
      if (!c.filled || c.numeric_ratio > 0.4) return;
      if (nameCol === -1) nameCol = c.index;
    });
  }

  // Value: a SET of columns, summed. Usually one, but a Pulsar export splits
  // the money four ways and all four are the same number.
  //
  //   1. the metric's preset, if every column in it is on this sheet
  //   2. the best header hint
  //   3. the mostly-numeric column with the largest total
  //
  // A column on NOT_VALUE_HINTS is never picked automatically at steps 2 or 3.
  // It can still be ticked by hand - this decides the default, not the rules.
  var valueCols = [], valueScore = 0, presetHit = false;
  if (m.preset && m.preset.length) {
    var found = [];
    m.preset.forEach(function (want) {
      cols.forEach(function (c) { if (squash(c.raw_header) === want) found.push(c.index); });
    });
    if (found.length === m.preset.length) { valueCols = found; presetHit = true; }
  }
  if (!valueCols.length) {
    var pick = -1;
    cols.forEach(function (c) {
      if (!c.filled || c.index === nameCol) return;
      if (c.numeric_ratio < 0.5) return;
      if (hintScore(c.raw_header, NOT_VALUE_HINTS) > 0) return;
      var sc = hintScore(c.raw_header, m.hints);
      if (sc > valueScore) { valueScore = sc; pick = c.index; }
    });
    if (pick !== -1) valueCols = [pick];
  }
  if (!valueCols.length) {
    var best = null;
    cols.forEach(function (c) {
      if (!c.filled || c.index === nameCol || c.numeric_ratio < 0.5) return;
      if (hintScore(c.raw_header, NOT_VALUE_HINTS) > 0) return;
      if (!best || Math.abs(c.total) > Math.abs(best.total)) best = c;
    });
    if (best) valueCols = [best.index];
  }

  // A COUNTING board does not add a column up. It counts the rows that say the
  // right thing: Task contains "batt", Status is Completed. So instead of value
  // columns it proposes a rule, and offers the status values the file really
  // holds rather than a guess at Pulsar's vocabulary.
  var matchCol = -1, matchScore = 0, statusCol = -1, statusScore = 0;
  if (mode === 'count') {
    valueCols = [];
    cols.forEach(function (c) {
      if (!c.filled || c.index === nameCol) return;
      var sm = hintScore(c.raw_header, MATCH_HINTS);
      if (sm > matchScore) { matchScore = sm; matchCol = c.index; }
      var ss = hintScore(c.raw_header, STATUS_HINTS);
      if (ss > statusScore) { statusScore = ss; statusCol = c.index; }
    });
    if (matchCol !== -1 && matchCol === statusCol) statusCol = -1;
  }
  var statusOptions = mode === 'count' ? distinctValues(grid, headerRow, statusCol) : [];

  var cityCol = -1, cityScore = 0;
  cols.forEach(function (c) {
    if (!c.filled || c.index === nameCol || valueCols.indexOf(c.index) !== -1) return;
    if (c.index === matchCol || c.index === statusCol) return;
    var s = hintScore(c.raw_header, CITY_HINTS);
    if (s > cityScore) { cityScore = s; cityCol = c.index; }
  });

  return {
    header_row: headerRow,
    mode: mode,
    columns: cols,
    status_options: statusOptions,
    suggestion: {
      name: nameCol,
      values: valueCols,
      city: cityCol,
      match_col: matchCol,
      match_text: mode === 'count' ? (m.default_match || '') : '',
      status_col: statusCol,
      status_values: statusOptions.filter(function (o) { return o.done; }).map(function (o) { return o.value; })
    },
    preset_used: presetHit,
    confident: mode === 'count'
      ? (nameCol !== -1 && matchCol !== -1 && matchScore > 0 && nameScore > 0)
      : (nameCol !== -1 && valueCols.length > 0 && nameScore > 0 && (presetHit || valueScore > 0)),
    preview: grid.slice(headerRow, headerRow + 9)
  };
}

// Normalise whatever the caller sent for the value columns into a clean array
// of indices: an array, a single number, or "3,4,5".
function valueColList(v) {
  if (v === null || v === undefined || v === '') return [];
  var raw = Array.isArray(v) ? v : String(v).split(',');
  var out = [];
  raw.forEach(function (x) {
    var n = parseInt(x, 10);
    if (n >= 0 && out.indexOf(n) === -1) out.push(n);
  });
  return out;
}

/*
 * Pull the rows out of a sheet with the columns a human confirmed, and add up
 * anything that names the same person twice (a per-day export does).
 *
 * Returns { rows: [{ raw_name, value, city_code, lines }], skipped: {...} }
 * sorted highest first. Ties break on name so two identical numbers always
 * come back in the same order.
 */
function extractRows(grid, opts) {
  var headerRow = parseInt(opts.header_row, 10);
  if (!(headerRow >= 0)) headerRow = 0;
  var nameCol = parseInt(opts.name_col, 10);
  var valueCols = valueColList(opts.value_cols !== undefined ? opts.value_cols : opts.value_col);
  var cityCol = opts.city_col === null || opts.city_col === undefined || opts.city_col === '' ? -1 : parseInt(opts.city_col, 10);
  var mode = opts.mode === 'count' ? 'count' : 'sum';
  var matchCol = opts.match_col === null || opts.match_col === undefined || opts.match_col === '' ? -1 : parseInt(opts.match_col, 10);
  var matchText = squash(opts.match_text);
  var statusCol = opts.status_col === null || opts.status_col === undefined || opts.status_col === '' ? -1 : parseInt(opts.status_col, 10);
  var statusOk = {};
  var statusList = Array.isArray(opts.status_values) ? opts.status_values
    : (opts.status_values ? String(opts.status_values).split('|') : []);
  statusList.forEach(function (v) { var k = squash(v); if (k) statusOk[k] = 1; });
  var filterStatus = statusCol >= 0 && Object.keys(statusOk).length > 0;
  var skipped = { no_name: 0, no_value: 0, total_row: 0, no_match: 0, wrong_status: 0 };
  var byKey = {};
  var order = [];

  for (var r = headerRow + 1; r < grid.length; r++) {
    var row = grid[r] || [];
    var name = String(row[nameCol] === undefined ? '' : row[nameCol]).trim();
    if (name === '') { skipped.no_name++; continue; }
    if (TOTAL_ROW.test(name)) { skipped.total_row++; continue; }
    var value = 0, readable = false;
    if (mode === 'count') {
      // Counting board: this row is worth 1 if it says the right thing.
      // The task test comes first so "how many rows even mention batteries"
      // stays separable from "how many of those were completed".
      if (matchCol >= 0 && matchText) {
        var cell = squash(row[matchCol]);
        if (cell.indexOf(matchText) === -1) { skipped.no_match++; continue; }
      }
      if (filterStatus && !statusOk[squash(row[statusCol])]) { skipped.wrong_status++; continue; }
      value = 1;
      readable = true;
    } else {
      // A call paid entirely by card has three of the four money columns blank.
      // Blank is not "unreadable" when a sibling column has a number in it -
      // the row only fails when NONE of the chosen columns can be read.
      for (var vc = 0; vc < valueCols.length; vc++) {
        var one = toNumber(row[valueCols[vc]]);
        if (one !== null) { value += one; readable = true; }
      }
    }
    if (!readable) { skipped.no_value++; continue; }
    var key = squash(name);
    if (!byKey[key]) {
      byKey[key] = { raw_name: name, value: 0, city_code: '', lines: 0 };
      order.push(key);
    }
    byKey[key].value += value;
    byKey[key].lines++;
    // Kept as the sheet wrote it. On a Pulsar export this is "Columbus, GA",
    // not a Nova city code, and shouting it in a table helps nobody.
    if (cityCol >= 0 && !byKey[key].city_code) {
      byKey[key].city_code = String(row[cityCol] === undefined ? '' : row[cityCol]).trim().slice(0, 40);
    }
  }

  var rows = order.map(function (k) { return byKey[k]; });
  rows.sort(function (a, b) {
    if (b.value !== a.value) return b.value - a.value;
    return a.raw_name.localeCompare(b.raw_name);
  });
  rows.forEach(function (x) { x.value = Math.round(x.value * 100) / 100; });
  return { rows: rows, skipped: skipped };
}

/* ------------------------------------------------------- who is this? ----- */

/*
 * Roster matcher. Same three tiers as the Geico import (routes/geico.js), and
 * for the same reason: a WRONG link is worse than no link, because the board
 * would then credit the wrong person and nobody would know to look.
 *
 *   1. users.pulsar_name  - the field that exists precisely for this
 *   2. users.name / nickname
 *   3. last name + first initial, ONLY when exactly one ACTIVE user answers to
 *      it (Nova has people who share a last name)
 *
 * users: rows of { id, name, pulsar_name, nickname, active, home_city }.
 */
function buildResolver(users) {
  var exact = {};      // squashed key -> { id, tier }
  var initial = {};    // "lastname f" -> [ids]
  var byId = {};

  // Two DIFFERENT people answering to the same spelling at the same tier is not
  // a match, it is a coin flip - so the key is poisoned and the row is left
  // unmatched for a human to link. Nova has had two active people with the same
  // full name before; crediting one of them silently is the exact failure this
  // whole file is built to avoid.
  function claim(key, id, tier) {
    if (!key) return;
    var prior = exact[key];
    if (!prior) { exact[key] = { id: id, tier: tier }; return; }
    if (tier < prior.tier) { exact[key] = { id: id, tier: tier }; return; }
    if (tier === prior.tier && prior.id !== id) prior.ambiguous = true;
  }

  (users || []).forEach(function (row) {
    byId[row.id] = { id: row.id, name: row.name, active: row.active !== false, home_city: row.home_city || null };
    claim(squash(row.pulsar_name), row.id, 1);
    claim(squash(row.name), row.id, 2);
    String(row.nickname == null ? '' : row.nickname).split(',').forEach(function (nick) {
      claim(squash(nick), row.id, 2);
    });
    var forms = [row.name].concat(String(row.nickname == null ? '' : row.nickname).split(','));
    forms.forEach(function (form) {
      var toks = squash(form).split(' ').filter(Boolean);
      if (toks.length < 2) return;
      var key = toks[toks.length - 1] + ' ' + toks[0].charAt(0);
      if (!initial[key]) initial[key] = [];
      if (initial[key].indexOf(row.id) === -1) initial[key].push(row.id);
    });
  });

  return {
    byId: byId,
    // { user_id, name, tier } - user_id null when nobody matched.
    resolve: function (raw) {
      var nm = PC.normalizeTechName(raw);
      var best = null;
      for (var i = 0; i < nm.keys.length; i++) {
        var hit = exact[nm.keys[i]];
        if (hit && hit.ambiguous) continue;
        if (hit && (!best || hit.tier < best.tier)) best = hit;
      }
      if (best) return { user_id: best.id, name: byId[best.id].name, tier: best.tier };
      if (nm.last && nm.first) {
        var key = squash(nm.last) + ' ' + squash(nm.first).charAt(0);
        var ids = (initial[key] || []).filter(function (id) { return byId[id] && byId[id].active; });
        if (ids.length === 1) return { user_id: ids[0], name: byId[ids[0]].name, tier: 3 };
      }
      return { user_id: null, name: null, tier: null };
    }
  };
}

/* ------------------------------------------------------------- weeks ------ */

// Sheets are uploaded on Monday FOR the week that just ended, so this is the
// default the upload screen offers. Weeks run Monday-Sunday, same as deposits
// and the schedule.
function lastMonday(today) {
  var d = today ? new Date(today) : new Date();
  var ymd = d.toISOString().slice(0, 10);
  return PC.addDaysYmd(PC.mondayOf(ymd), -7);
}

function weekLabel(ymd) {
  var start = String(ymd).slice(0, 10);
  var end = PC.addDaysYmd(start, 6);
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function part(s, withYear) {
    var p = s.split('-');
    return MON[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + (withYear ? (', ' + p[0]) : '');
  }
  return part(start, false) + ' - ' + part(end, true);
}

module.exports = {
  METRICS: METRICS,
  MATCH_HINTS: MATCH_HINTS,
  STATUS_HINTS: STATUS_HINTS,
  DONE_STATUS: DONE_STATUS,
  distinctValues: distinctValues,
  isMetric: isMetric,
  NAME_HINTS: NAME_HINTS,
  CITY_HINTS: CITY_HINTS,
  NOT_VALUE_HINTS: NOT_VALUE_HINTS,
  cellText: cellText,
  toNumber: toNumber,
  csvGrid: csvGrid,
  readWorkbook: readWorkbook,
  trimGrid: trimGrid,
  findHeaderRow: findHeaderRow,
  profileColumns: profileColumns,
  analyzeSheet: analyzeSheet,
  extractRows: extractRows,
  valueColList: valueColList,
  buildResolver: buildResolver,
  lastMonday: lastMonday,
  weekLabel: weekLabel,
  colLetter: colLetter
};
