// Shared COI logic. Everything that decides "is this account OK?" lives here so
// the route, the packet PDF, the reminder job and the browser cannot drift apart.
//
// House style: string concatenation only, no template literals (Windows corrupts
// backticks in .js files on Tony's clone).

// Every coverage line Nova tracks. Each entry pairs the REQUIRED column on
// account_coi_requirements with the ACTUAL column on account_coi_certificates.
// Adding a line here is the only change needed: the editor, the certificate
// dialog, the mismatch check and the packet PDF all read this list.
var LIMIT_FIELDS = [
  { key: 'gl_occurrence',    label: 'General Liability - each occurrence',   short: 'GL each occurrence' },
  { key: 'gl_aggregate',     label: 'General Liability - general aggregate', short: 'GL aggregate' },
  { key: 'gl_products_agg',  label: 'Products / comp-ops aggregate',         short: 'Products / comp-ops' },
  { key: 'auto_csl',         label: 'Automobile - combined single limit',    short: 'Auto CSL' },
  { key: 'umbrella_each',    label: 'Umbrella - each occurrence',            short: 'Umbrella each occ.' },
  { key: 'umbrella_agg',     label: 'Umbrella - aggregate',                  short: 'Umbrella aggregate' },
  { key: 'garagekeepers',    label: 'Garagekeepers',                         short: 'Garagekeepers' },
  { key: 'el_each_accident', label: 'Employers liability - each accident',   short: 'E.L. each accident' },
  { key: 'el_disease_each',  label: 'E.L. disease - each employee',          short: 'E.L. disease (employee)' },
  { key: 'el_disease_policy',label: 'E.L. disease - policy limit',           short: 'E.L. disease (policy)' }
];

// The three certificate boxes accounts most often demand and carriers most
// often leave off. Each pairs a requirement flag with a certificate flag.
var FLAG_FIELDS = [
  { req: 'primary_noncontrib', cert: 'has_pnc',    label: 'Primary & non-contributory' },
  { req: 'req_wc_statutory',   cert: 'has_wc',     label: 'Workers compensation (statutory)' }
];

var EXPIRING_DAYS = 60;

function reqCol(key) { return 'req_' + key; }
function limCol(key) { return 'lim_' + key; }

// Numbers arrive from pg as strings (NUMERIC) and from the browser as strings
// with commas in them. Anything that is not a real number becomes null, which
// means "not stated" everywhere downstream - never zero, because a zero limit
// and an absent limit are different answers.
function num(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).replace(/[,$\s]/g, '');
  if (s === '') return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

// True when the requirements row asks for at least one additional insured.
function wantsAdditionalInsured(reqRow) {
  if (!reqRow) return false;
  var ai = reqRow.additional_insured;
  if (typeof ai === 'string') { try { ai = JSON.parse(ai); } catch (e) { ai = null; } }
  if (Array.isArray(ai) && ai.length) return true;
  return !!String(reqRow.ai_wording || '').trim();
}

function wantsWaiver(reqRow) {
  if (!reqRow) return false;
  return !!(reqRow.waiver_gl || reqRow.waiver_auto || reqRow.waiver_wc);
}

// Compare one certificate against one account's requirements.
// Returns an array of { field, label, required, actual, kind }. Empty means the
// certificate satisfies everything the account asked for.
//
// A requirement that is NOT set is never a mismatch - blank means "this account
// does not require that line", not "zero".
function computeMismatch(reqRow, certRow) {
  var out = [];
  if (!reqRow || !certRow) return out;
  if (reqRow.coi_required === false) return out;

  LIMIT_FIELDS.forEach(function (f) {
    var required = num(reqRow[reqCol(f.key)]);
    if (required === null) return;
    var actual = num(certRow[limCol(f.key)]);
    if (actual === null || actual < required) {
      out.push({ field: f.key, label: f.label, required: required, actual: actual, kind: 'limit' });
    }
  });

  if (wantsAdditionalInsured(reqRow) && !certRow.has_ai) {
    out.push({ field: 'additional_insured', label: 'Additional insured', required: true, actual: false, kind: 'flag' });
  }
  if (wantsWaiver(reqRow) && !certRow.has_waiver) {
    out.push({ field: 'waiver', label: 'Waiver of subrogation', required: true, actual: false, kind: 'flag' });
  }
  FLAG_FIELDS.forEach(function (f) {
    if (reqRow[f.req] && !certRow[f.cert]) {
      out.push({ field: f.cert, label: f.label, required: true, actual: false, kind: 'flag' });
    }
  });
  return out;
}

// A one-line human summary of a mismatch array, for digests and table cells.
function mismatchSummary(list) {
  if (!list || !list.length) return '';
  var first = list[0];
  var rest = list.length - 1;
  var head;
  if (first.kind === 'limit') {
    head = first.label + ' ' + (first.actual === null ? 'not shown' : fmtMoney(first.actual)) +
           ' vs ' + fmtMoney(first.required) + ' required';
  } else {
    head = first.label + ' missing';
  }
  return rest > 0 ? (head + ' (+' + rest + ' more)') : head;
}

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  var v = num(n);
  if (v === null) return '';
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Calendar date in America/New_York as YYYY-MM-DD. Every date comparison in
// this module runs on plain date strings so a timezone never shifts an expiry
// across midnight. Matches jobs/docExpiry.js.
function etToday() {
  return new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
}

function daysBetween(fromISO, toISO) {
  var a = Date.UTC(+fromISO.slice(0, 4), +fromISO.slice(5, 7) - 1, +fromISO.slice(8, 10));
  var b = Date.UTC(+toISO.slice(0, 4), +toISO.slice(5, 7) - 1, +toISO.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

// THE status function. The Accounts chip, the COI screen, the badge count and
// the reminder digest all call this and nothing else, so they cannot disagree.
//
// row: { coi_required, expires_on (YYYY-MM-DD or null), mismatch (array/JSON/null) }
// Precedence, most urgent first:
//   not_required -> missing -> expired -> mismatch -> expiring -> current
// mismatch outranks expiring on purpose: a short certificate has to be
// re-issued regardless of how long it has left to run.
function coiStatus(row, todayISO) {
  var today = todayISO || etToday();
  if (!row || row.coi_required === false) {
    return { key: 'not_required', label: 'Not required', tone: 'grey', note: '', days: null };
  }
  var exp = row.expires_on ? String(row.expires_on).slice(0, 10) : null;
  if (!exp) {
    return { key: 'missing', label: 'Missing', tone: 'red', note: 'Never issued', days: null };
  }
  var days = daysBetween(today, exp);
  if (days < 0) {
    return { key: 'expired', label: 'Expired', tone: 'red', note: 'Expired ' + Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's') + ' ago', days: days };
  }
  var mm = row.mismatch;
  if (typeof mm === 'string') { try { mm = JSON.parse(mm); } catch (e) { mm = null; } }
  if (Array.isArray(mm) && mm.length) {
    return { key: 'mismatch', label: 'Below requirement', tone: 'amber', note: mismatchSummary(mm), days: days };
  }
  if (days <= EXPIRING_DAYS) {
    return { key: 'expiring', label: 'Expiring', tone: 'amber', note: 'in ' + days + ' day' + (days === 1 ? '' : 's'), days: days };
  }
  return { key: 'current', label: 'Current', tone: 'green', note: '', days: days };
}

// Anything that is not 'current' and not 'not_required' needs a human. That is
// what the sidebar badge counts - including mismatches, which are a real defect
// even though the certificate has not expired.
function needsAttention(statusKey) {
  return statusKey === 'missing' || statusKey === 'expired' ||
         statusKey === 'expiring' || statusKey === 'mismatch';
}

function tally(rows, todayISO) {
  var counts = { current: 0, expiring: 0, mismatch: 0, expired: 0, missing: 0, not_required: 0, attention: 0 };
  (rows || []).forEach(function (r) {
    var st = coiStatus(r, todayISO);
    counts[st.key] = (counts[st.key] || 0) + 1;
    if (needsAttention(st.key)) counts.attention++;
  });
  return counts;
}

module.exports = {
  LIMIT_FIELDS: LIMIT_FIELDS,
  FLAG_FIELDS: FLAG_FIELDS,
  EXPIRING_DAYS: EXPIRING_DAYS,
  reqCol: reqCol,
  limCol: limCol,
  num: num,
  fmtMoney: fmtMoney,
  etToday: etToday,
  daysBetween: daysBetween,
  wantsAdditionalInsured: wantsAdditionalInsured,
  wantsWaiver: wantsWaiver,
  computeMismatch: computeMismatch,
  mismatchSummary: mismatchSummary,
  coiStatus: coiStatus,
  needsAttention: needsAttention,
  tally: tally
};
