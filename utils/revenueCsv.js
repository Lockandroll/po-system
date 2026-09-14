'use strict';
/*
 * CallSearch revenue export - parsing and classification  (Nova)
 * -------------------------------------------------------------
 * Reads the CallSearch "Call Search" CSV and turns every row into a call
 * record with a week, a location, a service class and a revenue figure. That
 * is all this file does: no database, no HTTP, no formatting.
 *
 * WHY THIS IS NOT utils/pulsarCash.js
 * -----------------------------------
 * Nova already reads this same export in utils/pulsarCash.js, and it would
 * look like an easy win to share the code. It is not, and this duplication is
 * deliberate (Tony's call, Sep 2026):
 *
 *   - pulsarCash keeps ONLY the rows where the tech collected cash. This
 *     module needs every row, including the $0 ones, because a call that
 *     collected nothing is still a call that happened.
 *   - pulsarCash buckets by "Pay Period" because a deposit is owed for a
 *     payroll week. Revenue is bucketed by "DT Complete", because that is
 *     when the work was actually finished.
 *   - pulsarCash REPLACES a period on import (DELETE, then insert). This
 *     module only ever upserts, so an overlapping export is harmless.
 *
 * Those three differences are the whole design of each module, and they point
 * opposite ways. Merging them would mean one file with a mode flag in every
 * function, and a change to a revenue chart could then silently move money on
 * the Cash Deposits reconciliation. They stay apart.
 *
 * COLUMN NOTES (learned from the real export, do not "simplify" these):
 *  - "DT Complete" is "M/D/YYYY h:mm:ss AM/PM". It drives the week.
 *  - Currency arrives as "$1,234.56" strings, not numbers. A credit may appear
 *    parenthesized, "($25.00)", which is negative.
 *  - "Task" casing is inconsistent in the source: GEICO/Geico, MSG/Msg,
 *    Bat/bat all appear. Everything matches case-insensitively.
 *  - "Task" is dot-delimited with a variable number of segments (CDU,
 *    ago.Jump, AL.Bus.LS, CDU.Gas.Jump). Segments are compared for EQUALITY,
 *    never substring - "Bat" and "RP.Bat" must both classify as Battery while
 *    a task merely containing the letters does not.
 *  - "Call UID" is the dedupe key. Verified unique with zero blanks across a
 *    13,670-row export; a row without one is dropped rather than guessed at.
 *  - Status is Completed or GOA. GOA IS COUNTED. A GOA that collected a trip
 *    fee is real money (8.2% of calls, $19,499 of the validation period), so
 *    filtering to Completed would understate every location.
 *  - There is a trailing unnamed empty column. Ignored.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

/* ------------------------------------------------------------------ CSV */

/*
 * RFC4180-ish tokenizer. Handles quoted fields, doubled quotes inside them,
 * embedded newlines, and both CRLF and LF. Returns an array of plain objects
 * keyed by the header row.
 *
 * Written here rather than imported so this module has no dependency that a
 * change elsewhere could move underneath it.
 */
function parseCSV(text) {
  var s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);      // strip BOM
  var rows = [], row = [], field = '', inQuotes = false;
  var i = 0, n = s.length;

  while (i < n) {
    var ch = s.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  row.push(field);
  rows.push(row);

  // Drop trailing blank lines.
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  if (!rows.length) return [];

  var headers = rows[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  var out = [];
  for (var r = 1; r < rows.length; r++) {
    var obj = {}, cells = rows[r];
    // A row of nothing but empty cells is a formatting artefact, not a call.
    var any = false;
    for (var c = 0; c < headers.length; c++) {
      var v = cells[c] == null ? '' : cells[c];
      obj[headers[c]] = v;
      if (String(v).trim() !== '') any = true;
    }
    if (any) out.push(obj);
  }
  return out;
}

function squash(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/*
 * Currency string -> Number.
 *   "$1,234.56"  ->  1234.56
 *   "($25.00)"   ->  -25          (accounting negative; see spec section 4)
 *   ""           ->  0
 */
function money(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return 0;
  var neg = false;
  if (s.charAt(0) === '(' && s.charAt(s.length - 1) === ')') { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  var v = parseFloat(s);
  if (!isFinite(v)) return 0;
  return neg ? -v : v;
}

function n2(v) {
  var x = Number(v);
  if (!isFinite(x)) x = 0;
  return Math.round(x * 100) / 100;
}

function pad2(v) { var s = String(v); return s.length < 2 ? '0' + s : s; }

/*
 * "9/13/2026 4:07:11 PM" / "9/13/2026" / "2026-09-13 16:07" -> "2026-09-13".
 * Only the DATE is kept: the report never asks what hour a call closed, and
 * carrying a timestamp would drag the week boundary into whatever timezone the
 * server happens to be in.
 */
function parseDate(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return '';
  s = s.split(' ')[0];
  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return iso[1] + '-' + pad2(iso[2]) + '-' + pad2(iso[3]);
  var mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!mdy) return '';
  var y = mdy[3];
  if (y.length === 2) y = '20' + y;
  var mo = parseInt(mdy[1], 10), da = parseInt(mdy[2], 10);
  if (!(mo >= 1 && mo <= 12) || !(da >= 1 && da <= 31)) return '';
  return y + '-' + pad2(mo) + '-' + pad2(da);
}

/* --------------------------------------------------------------- columns */

// Aliases per logical field, most-trusted first. The first entry is also the
// name shown to a manager when a column is missing, so keep it the real one.
var COL = {
  date:     ['DT Complete', 'Date Closed', 'Pay Period', 'Date Disp'],
  location: ['Location'],
  task:     ['Task'],
  tech:     ['Tech ID', 'Tech', 'Technician', 'Tech Name'],
  status:   ['Status'],
  uid:      ['Call UID', 'Call ID New', 'Call ID'],
  account:  ['Account'],
  invoice:  ['Invoice'],
  cash:     ['Collected Cash'],
  check:    ['Collected Check'],
  cc:       ['Collected CC'],
  acct:     ['Collected Account']
};

// The four columns that add up to revenue. Named once so nothing can sum three
// of them by accident.
var PAY_KEYS = ['cash', 'check', 'cc', 'acct'];

function resolveColumn(headers, aliases) {
  var map = {};
  for (var i = 0; i < headers.length; i++) map[squash(headers[i])] = headers[i];
  for (var a = 0; a < aliases.length; a++) {
    var hit = map[squash(aliases[a])];
    if (hit !== undefined) return hit;
  }
  return '';
}

function resolveColumns(rows) {
  var headers = (rows && rows.length) ? Object.keys(rows[0]) : [];
  var out = {};
  Object.keys(COL).forEach(function (k) { out[k] = resolveColumn(headers, COL[k]); });
  return out;
}

// What the file must have before a revenue figure means anything. Location and
// Task are required too: without them every call lands in one nameless bucket
// with no service class, which is not a report.
var REQUIRED = ['date', 'uid', 'location', 'task'];

/* --------------------------------------------------------- classification */

var CLASS_ROADSIDE = 'roadside';
var CLASS_BATTERY = 'battery';
var CLASS_LOCKSMITH = 'locksmith';

// Display order, everywhere, always: Roadside, Battery, Locksmith. Colors are
// bound to the class rather than to a position, so the same work is the same
// color on every page of the PDF.
var CLASSES = [CLASS_ROADSIDE, CLASS_BATTERY, CLASS_LOCKSMITH];
var CLASS_LABEL = { roadside: 'Roadside', battery: 'Battery', locksmith: 'Locksmith' };

/*
 * Task code -> service class.
 *
 * Split on '.', lowercase each segment, then test in this order:
 *   any segment === 'ls'   -> Locksmith
 *   any segment === 'bat'  -> Battery
 *   otherwise              -> Roadside
 *
 * Order matters: "AL.Bus.LS" is locksmith work whatever else is in the code.
 * Equality, not substring, is what makes standalone "Bat" and "RP.Bat" both
 * land in Battery without "Batch" or "Combat" joining them.
 *
 * KNOWN GAP, carried on purpose: "Pick" tasks carry no .LS suffix and so
 * classify as Roadside (531 calls / $38,316 over the validation period, about
 * 5% of revenue). That is a source-data problem - the task should be recoded
 * in CallSearch - and special-casing it here would hide it. See the
 * methodology note on page 2 of the PDF, which says so in print.
 */
function serviceClass(task) {
  var segs = String(task == null ? '' : task).split('.');
  var i;
  for (i = 0; i < segs.length; i++) if (segs[i].trim().toLowerCase() === 'ls') return CLASS_LOCKSMITH;
  for (i = 0; i < segs.length; i++) if (segs[i].trim().toLowerCase() === 'bat') return CLASS_BATTERY;
  return CLASS_ROADSIDE;
}

/* -------------------------------------------------------------- location */

/*
 * Location consolidation. Clearwater and Tampa are one territory now
 * (Suncoast), and more consolidations are likely, so the map is CONFIGURATION:
 * it lives in settings under 'revenue_location_map' and is passed in here.
 * DEFAULT_LOCATION_MAP is only the seed for a Nova that has never been told.
 *
 * Keys are squashed source names; values are the display name to report under.
 */
var DEFAULT_LOCATION_MAP = { clearwater: 'Suncoast', tampa: 'Suncoast' };

function mapLocation(raw, map) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return '';
  var k = squash(s);
  if (map && Object.prototype.hasOwnProperty.call(map, k)) return String(map[k]);
  return s;
}

/* ------------------------------------------------------------------ weeks */

// Monday of the week containing an ISO date. Weeks run Monday..Sunday, the
// same boundary the pay week and the schedule use.
function mondayOf(ymd) {
  var p = String(ymd).split('-');
  var d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)));
  var day = d.getUTCDay();                       // 0 = Sunday
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

function addDays(ymd, n) {
  var p = String(ymd).split('-');
  var d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/*
 * The most recent COMPLETE week as of an ISO date. "Complete" means it has
 * ended: on a Monday the week that just finished yesterday is the latest, and
 * the week in progress never appears in the report. A partial week would show
 * up as a collapse in revenue and get read as one.
 */
function latestCompleteWeek(todayYmd) {
  return addDays(mondayOf(todayYmd), -7);
}

// The N complete weeks ending at endMonday, oldest first.
function weekWindow(endMonday, count) {
  var out = [];
  for (var i = count - 1; i >= 0; i--) out.push(addDays(endMonday, -7 * i));
  return out;
}

/* ---------------------------------------------------------------- extract */

/*
 * Read a CallSearch CSV into call records.
 *
 * Returns { rows, meta }.
 *   rows[]: { call_uid, invoice, call_date, week_start, location_raw, location,
 *             task, service_class, tech_raw, status, cash, check_amt, cc,
 *             account_amt, revenue, account }
 *   meta:   { columns, missing[], totalRows, keptRows, skipped{...},
 *             firstDate, lastDate, weeks[], locations[], statuses{},
 *             revenueTotal }
 *
 * NOTHING is filtered on money or status. A $0 completed call and a GOA that
 * collected a trip fee are both calls that happened, and both belong in the
 * store; what the REPORT does with them is the report's business.
 */
function extractRows(csvText, locationMap) {
  var all = parseCSV(csvText);
  var cols = resolveColumns(all);
  var missing = REQUIRED.filter(function (k) { return !cols[k]; });

  var meta = {
    columns: cols,
    missing: missing,
    totalRows: all.length,
    keptRows: 0,
    skipped: { noUid: 0, noDate: 0, noLocation: 0, duplicateUid: 0 },
    firstDate: '', lastDate: '',
    weeks: [], locations: [], statuses: {},
    revenueTotal: 0
  };
  if (missing.length) return { rows: [], meta: meta };

  var map = locationMap || DEFAULT_LOCATION_MAP;
  var rows = [], seen = {}, weeks = {}, locs = {}, total = 0;

  for (var i = 0; i < all.length; i++) {
    var r = all[i];

    var uid = String(r[cols.uid] == null ? '' : r[cols.uid]).trim();
    if (!uid) { meta.skipped.noUid++; continue; }

    var date = parseDate(r[cols.date]);
    if (!date) { meta.skipped.noDate++; continue; }

    var locRaw = String(r[cols.location] == null ? '' : r[cols.location]).trim();
    if (!locRaw) { meta.skipped.noLocation++; continue; }

    // A file can legitimately contain the same call twice when two exports
    // were concatenated. Last one wins, the same rule the database upsert
    // applies, so a preview and the import it precedes agree.
    if (seen[uid] !== undefined) { meta.skipped.duplicateUid++; rows[seen[uid]] = null; }

    var status = String(cols.status ? (r[cols.status] == null ? '' : r[cols.status]) : '').trim();
    meta.statuses[status || '(blank)'] = (meta.statuses[status || '(blank)'] || 0) + 1;

    var cash = money(cols.cash ? r[cols.cash] : 0);
    var chk = money(cols.check ? r[cols.check] : 0);
    var cc = money(cols.cc ? r[cols.cc] : 0);
    var acct = money(cols.acct ? r[cols.acct] : 0);
    var revenue = n2(cash + chk + cc + acct);

    var task = String(cols.task == null ? '' : (r[cols.task] == null ? '' : r[cols.task])).trim();
    var loc = mapLocation(locRaw, map);
    var week = mondayOf(date);

    seen[uid] = rows.length;
    rows.push({
      call_uid: uid,
      invoice: cols.invoice ? String(r[cols.invoice] == null ? '' : r[cols.invoice]).trim() : '',
      call_date: date,
      week_start: week,
      location_raw: locRaw,
      location: loc,
      task: task,
      service_class: serviceClass(task),
      tech_raw: cols.tech ? String(r[cols.tech] == null ? '' : r[cols.tech]).trim() : '',
      status: status,
      account: cols.account ? String(r[cols.account] == null ? '' : r[cols.account]).trim() : '',
      cash: n2(cash),
      check_amt: n2(chk),
      cc: n2(cc),
      account_amt: n2(acct),
      revenue: revenue
    });
  }

  rows = rows.filter(Boolean);
  for (var j = 0; j < rows.length; j++) {
    var row = rows[j];
    total += row.revenue;
    weeks[row.week_start] = (weeks[row.week_start] || 0) + 1;
    locs[row.location] = (locs[row.location] || 0) + 1;
    if (!meta.firstDate || row.call_date < meta.firstDate) meta.firstDate = row.call_date;
    if (!meta.lastDate || row.call_date > meta.lastDate) meta.lastDate = row.call_date;
  }

  meta.keptRows = rows.length;
  meta.revenueTotal = n2(total);
  meta.weeks = Object.keys(weeks).sort().map(function (w) { return { week_start: w, calls: weeks[w] }; });
  meta.locations = Object.keys(locs).sort().map(function (l) { return { location: l, calls: locs[l] }; });
  return { rows: rows, meta: meta };
}

// The canonical header name for a logical field, for error messages.
function columnName(key) {
  var a = COL[key];
  return (a && a[0]) ? a[0] : key;
}

/*
 * Why did a file that parsed produce nothing? Answering this in words is the
 * difference between a manager fixing their export and a manager filing a bug.
 */
function emptyReason(meta) {
  if (meta.missing && meta.missing.length) {
    return 'That file is missing ' +
      meta.missing.map(columnName).join(', ') +
      '. Export it from CallSearch with those columns included.';
  }
  if (!meta.totalRows) return 'That file has no rows under its header.';
  var s = meta.skipped || {};
  if (s.noUid >= meta.totalRows) return 'No row in that file has a Call UID, so nothing can be de-duplicated safely.';
  if (s.noDate >= meta.totalRows) return 'No row in that file has a readable ' + columnName('date') + '.';
  if (s.noLocation >= meta.totalRows) return 'No row in that file has a Location.';
  return 'Nothing in that file could be read as a call.';
}

module.exports = {
  parseCSV: parseCSV,
  squash: squash,
  money: money,
  n2: n2,
  parseDate: parseDate,
  COL: COL,
  PAY_KEYS: PAY_KEYS,
  REQUIRED: REQUIRED,
  resolveColumn: resolveColumn,
  resolveColumns: resolveColumns,
  columnName: columnName,
  emptyReason: emptyReason,
  CLASS_ROADSIDE: CLASS_ROADSIDE,
  CLASS_BATTERY: CLASS_BATTERY,
  CLASS_LOCKSMITH: CLASS_LOCKSMITH,
  CLASSES: CLASSES,
  CLASS_LABEL: CLASS_LABEL,
  serviceClass: serviceClass,
  DEFAULT_LOCATION_MAP: DEFAULT_LOCATION_MAP,
  mapLocation: mapLocation,
  mondayOf: mondayOf,
  addDays: addDays,
  latestCompleteWeek: latestCompleteWeek,
  weekWindow: weekWindow,
  extractRows: extractRows
};
