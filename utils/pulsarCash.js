'use strict';
/*
 * Pulsar cash extractor  (Nova)
 * -----------------------------
 * Reads the Pulsar "Call Search" CSV export and pulls out every call where the
 * technician physically collected CASH, so Nova can reconcile that against the
 * weekly deposit the tech submitted on the Cash Deposits page.
 *
 * Verified against CallSearch_2026_08_03.csv (1,403 rows, Jul 27 - Aug 2 2026):
 *   65 cash calls / $5,317.73 across 25 technicians, and the three live deposits
 *   reconcile to the penny (Gomez 159.90, Yonkman 193.49, Haaf 249.99).
 *
 * COLUMN NOTES (learned from the real export, do not "simplify" these):
 *  - The technician column is "Tech ID" and holds a NAME in "Last, First" form
 *    ("Sawyer III, Darrell"), not an id. Suffixes and middle names are common.
 *  - The date column is "Pay Period" ("7/27/2026 12:00:00 AM"). It is Pulsar's
 *    own payroll-day attribution and agreed with "Date Closed" on 99.93% of rows
 *    versus 93.7% for "Date Disp", so Pay Period leads and Date Closed is the
 *    fallback. Never bucket cash by Date Disp.
 *  - "Collected Cash" is GROSS, tax included (Yonkman's $193.49 contains $13.50
 *    of Collected Tax). The deposit should equal it with NO tax adjustment.
 *  - "Call UID" is a true unique key: 1,403/1,403 distinct, zero blanks. It is
 *    the dedupe key so re-importing an overlapping export cannot double-count.
 *  - "Charged Parts  Non Tax" really does carry two spaces. Anything matching on
 *    header text must collapse whitespace first.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var royaltyEngine = require('./royaltyEngine');
var parseCSV = royaltyEngine.parseCSV;
var money = royaltyEngine.money;

// Statuses whose collected cash is real money in the tech's pocket.
// Canceled never carries cash (0 of 256 rows in the reference export). A paid
// GOA does -- the royalty engine counts it as sales -- so it is included here
// for the same reason, guarded by cash > 0.
var CASH_STATUSES = ['Completed', 'GOA'];

// Header aliases, most-trusted first. Matched case-insensitively after
// collapsing internal whitespace.
var COL = {
  tech: ['Tech ID', 'Tech', 'Technician', 'Tech Name', 'Dispatch Closed', 'Assigned To'],
  date: ['Pay Period', 'Date Closed', 'Date Disp'],
  cash: ['Collected Cash'],
  tax: ['Collected Tax'],
  uid: ['Call UID', 'Call ID New', 'Call ID'],
  invoice: ['Invoice'],
  location: ['Location'],
  status: ['Status'],
  task: ['Task'],
  account: ['Account']
};

function squash(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

// Resolve one logical field to the actual header present in this file.
// Returns the header string, or '' when the file has none of the aliases.
function resolveColumn(headers, aliases) {
  var map = {};
  for (var i = 0; i < headers.length; i++) map[squash(headers[i])] = headers[i];
  for (var a = 0; a < aliases.length; a++) {
    var hit = map[squash(aliases[a])];
    if (hit !== undefined) return hit;
  }
  return '';
}

function headersOf(rows) {
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]);
}

// Build the full logical-name -> header map for a parsed file.
function resolveColumns(rows) {
  var H = headersOf(rows), out = {};
  Object.keys(COL).forEach(function (k) { out[k] = resolveColumn(H, COL[k]); });
  return out;
}

// "7/27/2026 12:00:00 AM" / "7/27/2026" / "2026-07-27" -> "2026-07-27" (or '').
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
  return y + '-' + pad2(mdy[1]) + '-' + pad2(mdy[2]);
}

function pad2(n) { var s = String(n); return s.length < 2 ? '0' + s : s; }

// Name suffixes that are not part of the person's name for matching purposes.
var SUFFIXES = { 'jr': 1, 'sr': 1, 'ii': 1, 'iii': 1, 'iv': 1, 'v': 1 };

function stripPunct(tok) { return String(tok).replace(/[.,]/g, '').trim(); }

/*
 * Turn a Pulsar "Tech ID" into a display name plus a set of lookup keys.
 *
 *   "Sawyer III, Darrell"  -> display "Darrell Sawyer"
 *                             keys ["darrell sawyer", "sawyer iii, darrell", "sawyer darrell", ...]
 *   "Harris, Donald E"     -> display "Donald Harris"   (middle initial dropped)
 *   "Britt, Devon Jose"    -> display "Devon Jose Britt" (real middle name kept,
 *                             but "devon britt" is ALSO emitted as a key)
 *
 * Returning several keys rather than one canonical string is deliberate: Nova
 * stores three different spellings of a person (users.name, users.pulsar_name,
 * users.nickname) and any of them may be the one that matches.
 */
function normalizeTechName(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return { raw: '', display: '', keys: [] };

  var first = '', last = '', middles = [];
  var comma = s.indexOf(',');
  if (comma !== -1) {
    // "Last, First Middle" -- the export's normal shape.
    var lastPart = s.slice(0, comma).trim();
    var firstPart = s.slice(comma + 1).trim();
    var lastToks = lastPart.split(/\s+/).map(stripPunct).filter(Boolean)
      .filter(function (t) { return !SUFFIXES[t.toLowerCase()]; });
    var firstToks = firstPart.split(/\s+/).map(stripPunct).filter(Boolean)
      .filter(function (t) { return !SUFFIXES[t.toLowerCase()]; });
    last = lastToks.join(' ');
    first = firstToks.shift() || '';
    middles = firstToks;
  } else {
    // Already "First Middle Last".
    var toks = s.split(/\s+/).map(stripPunct).filter(Boolean)
      .filter(function (t) { return !SUFFIXES[t.toLowerCase()]; });
    first = toks.shift() || '';
    last = toks.pop() || '';
    middles = toks;
  }

  // A lone initial ("E") is noise; a real middle name ("Jose") is kept in the
  // display name because that may be how the person is actually known.
  var realMiddles = middles.filter(function (t) { return stripPunct(t).length > 1; });
  var display = [first].concat(realMiddles).concat([last])
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  var keys = {};
  function add(v) {
    var k = squash(v);
    if (k) keys[k] = 1;
  }
  add(display);
  add(first + ' ' + last);
  add(s);                       // raw "Sawyer III, Darrell" -- someone may have
  add(last + ', ' + first);     // pasted it straight into users.pulsar_name
  add(last + ' ' + first);

  return { raw: s, display: display, first: first, last: last, keys: Object.keys(keys) };
}

/*
 * Extract the cash calls from a Call Search CSV.
 *
 * Returns { rows, meta }.
 *   rows[]: { call_uid, invoice, call_date, location_raw, tech_raw, tech_display,
 *             tech_keys[], task, status, account, cash, tax }
 *   meta:   { columns, missing[], totalRows, consideredRows, cashRows, cashTotal,
 *             periodStart, periodEnd, statuses{}, skippedNoTech, skippedNoDate,
 *             skippedNoUid, locations[] }
 *
 * Rows with cash <= 0 are dropped -- this file exists to reconcile deposits, and
 * a card-only or account-only call has nothing to deposit.
 */
function extractCashRows(csvText) {
  var all = parseCSV(csvText);
  var cols = resolveColumns(all);
  var missing = [];
  ['tech', 'date', 'cash', 'status'].forEach(function (k) { if (!cols[k]) missing.push(k); });

  var rows = [], statuses = {}, locations = {};
  var cashTotal = 0, considered = 0;
  var skippedNoTech = 0, skippedNoDate = 0, skippedNoUid = 0;
  var minDate = '', maxDate = '';

  if (missing.length) {
    return {
      rows: [],
      meta: {
        columns: cols, missing: missing, totalRows: all.length, consideredRows: 0,
        cashRows: 0, cashTotal: 0, periodStart: '', periodEnd: '', statuses: {},
        skippedNoTech: 0, skippedNoDate: 0, skippedNoUid: 0, locations: []
      }
    };
  }

  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    var status = String(r[cols.status] == null ? '' : r[cols.status]).trim();
    statuses[status || '(blank)'] = (statuses[status || '(blank)'] || 0) + 1;

    var cash = money(r[cols.cash]);
    if (!(cash > 0)) continue;
    considered++;
    if (CASH_STATUSES.indexOf(status) === -1) continue;

    var techRaw = String(r[cols.tech] == null ? '' : r[cols.tech]).trim();
    if (techRaw === '') { skippedNoTech++; continue; }

    // Pay Period leads; fall back to Date Closed then Date Disp so a trimmed
    // export without the payroll column still reconciles.
    var callDate = parseDate(r[cols.date]);
    if (!callDate && cols.date !== 'Date Closed') callDate = parseDate(r['Date Closed']);
    if (!callDate) callDate = parseDate(r['Date Disp']);
    if (!callDate) { skippedNoDate++; continue; }

    var uid = cols.uid ? String(r[cols.uid] == null ? '' : r[cols.uid]).trim() : '';
    if (!uid) { skippedNoUid++; continue; }

    var nm = normalizeTechName(techRaw);
    var loc = cols.location ? String(r[cols.location] == null ? '' : r[cols.location]).trim() : '';
    if (loc) locations[loc] = (locations[loc] || 0) + 1;

    rows.push({
      call_uid: uid,
      invoice: cols.invoice ? String(r[cols.invoice] == null ? '' : r[cols.invoice]).trim() : '',
      call_date: callDate,
      location_raw: loc,
      tech_raw: techRaw,
      tech_display: nm.display,
      tech_keys: nm.keys,
      task: cols.task ? String(r[cols.task] == null ? '' : r[cols.task]).trim() : '',
      status: status,
      account: cols.account ? String(r[cols.account] == null ? '' : r[cols.account]).trim() : '',
      cash: Math.round(cash * 100) / 100,
      tax: cols.tax ? Math.round(money(r[cols.tax]) * 100) / 100 : 0
    });
    cashTotal += cash;
    if (!minDate || callDate < minDate) minDate = callDate;
    if (!maxDate || callDate > maxDate) maxDate = callDate;
  }

  var locArr = Object.keys(locations).map(function (k) { return { location: k, count: locations[k] }; })
    .sort(function (a, b) { return b.count - a.count; });

  return {
    rows: rows,
    meta: {
      columns: cols,
      missing: [],
      totalRows: all.length,
      consideredRows: considered,
      cashRows: rows.length,
      cashTotal: Math.round(cashTotal * 100) / 100,
      periodStart: minDate,
      periodEnd: maxDate,
      statuses: statuses,
      skippedNoTech: skippedNoTech,
      skippedNoDate: skippedNoDate,
      skippedNoUid: skippedNoUid,
      locations: locArr
    }
  };
}

// Monday of the week containing an ISO date string. Nova pay periods run
// Monday -> Sunday (see depMonday in public/js/app.js -- keep these in step).
function mondayOf(ymd) {
  var p = String(ymd).split('-');
  var d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)));
  var day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

function addDaysYmd(ymd, n) {
  var p = String(ymd).split('-');
  var d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/*
 * Work out which Nova pay week an export covers.
 * Returns { start, end, weeks[], spansMultiple }.
 * The dominant week (most cash rows) wins when a file straddles a boundary,
 * so a stray late-closing call cannot drag the whole import into the wrong week.
 */
function detectPeriod(rows) {
  if (!rows || !rows.length) return { start: '', end: '', weeks: [], spansMultiple: false };
  var tally = {};
  rows.forEach(function (r) {
    var m = mondayOf(r.call_date);
    if (!tally[m]) tally[m] = { start: m, end: addDaysYmd(m, 6), rows: 0, cash: 0 };
    tally[m].rows++;
    tally[m].cash += r.cash;
  });
  var weeks = Object.keys(tally).map(function (k) {
    tally[k].cash = Math.round(tally[k].cash * 100) / 100;
    return tally[k];
  }).sort(function (a, b) { return b.rows - a.rows || (a.start < b.start ? -1 : 1); });
  return {
    start: weeks[0].start,
    end: weeks[0].end,
    weeks: weeks.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; }),
    spansMultiple: weeks.length > 1
  };
}

module.exports = {
  CASH_STATUSES: CASH_STATUSES,
  COL: COL,
  squash: squash,
  parseCSV: parseCSV,
  money: money,
  resolveColumn: resolveColumn,
  resolveColumns: resolveColumns,
  parseDate: parseDate,
  normalizeTechName: normalizeTechName,
  extractCashRows: extractCashRows,
  mondayOf: mondayOf,
  addDaysYmd: addDaysYmd,
  detectPeriod: detectPeriod
};
