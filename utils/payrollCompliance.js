// Payroll compliance engine.
//
// A faithful port of the payroll-compliance skill's check.py. Runs TWO tests
// in one pass from the same inputs:
//   1. MINIMUM WAGE - effective hourly rate (all W-2 taxable wages / hours)
//      must be >= the threshold for that technician's state.
//   2. OVERTIME    - any tech over 40 combined hours is owed an FLSA half-time
//      premium (29 CFR 778.118) on the hours past 40.
//
// The math here is DETERMINISTIC and never touches the AI, so Nova and the
// skill can never disagree. Wage figures come from utils/payrollJournal.js
// (the Paychex PDF read) and are reviewed by a human before compute.
//
// House style: string concatenation only, no template literals (Windows
// corrupts backticks in .js). Pure functions, exported for the route and tests.

var OT_THRESHOLD_HOURS = 40.0;

// Map a Pulsar territory code prefix to the state it sits in. The prefix is the
// leading letters of a code like "ORL-026-022" or "SAV- 19- 011". This is a
// best-effort default the reviewer can override per line on the review screen;
// the applied minimum wage is uniform across all three states today, so a wrong
// guess never changes the true-up, only which legal floor the record cites.
var STATE_BY_PREFIX = {
  ORL: 'FL', JAX: 'FL', TPA: 'FL', CLW: 'FL', TAL: 'FL', CSP: 'FL', LA: 'FL', NAV: 'FL',
  SAV: 'GA', CSG: 'GA',
  BHM: 'AL'
};

function deriveState(code) {
  if (!code) return 'FL';
  var m = String(code).toUpperCase().match(/[A-Z]+/);
  if (!m) return 'FL';
  var pre = m[0];
  return STATE_BY_PREFIX[pre] || 'FL';
}

function codeFromName(name) {
  // Pulsar names look like "Beardshear, Jesse (ORL-026-022)". Pull the code out
  // of the parentheses. Returns '' when there is none.
  var m = String(name || '').match(/\(([^)]+)\)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function normalizeName(name) {
  // Strip parentheticals and suffixes, collapse whitespace, lowercase.
  var n = String(name || '').replace(/\([^)]*\)/g, '');
  n = n.replace(/\s+/g, ' ').trim().toLowerCase();
  n = n.replace(/\b(iii|ii|iv|jr|sr|i)\b\.?/g, '');
  return n.replace(/\s+/g, ' ').trim();
}

function getLastName(name) {
  var norm = normalizeName(name);
  if (norm.indexOf(',') !== -1) return norm.split(',')[0].trim();
  var parts = norm.split(' ');
  return parts.length ? parts[0] : '';
}

// --- CSV parsing ----------------------------------------------------------

// Minimal RFC-4180-ish CSV parser. Handles quoted fields containing commas
// (the tech name "Last, First (CODE)") and quoted numbers ("1,084.16"). The
// Pulsar export has no newlines inside fields, so we split on lines first.
function parseCsvLine(line) {
  var out = [];
  var cur = '';
  var inq = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (inq) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inq = false; }
      } else { cur += c; }
    } else {
      if (c === '"') { inq = true; }
      else if (c === ',') { out.push(cur); cur = ''; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

function toNumber(s) {
  if (s === null || s === undefined) return null;
  var t = String(s).replace(/\$/g, '').replace(/,/g, '').trim();
  if (t === '' || t.toLowerCase() === 'nan') return null;
  var v = parseFloat(t);
  return isNaN(v) ? null : v;
}

// Parse ONE Pulsar Event-to-Event CSV. The file has a one-line title, then the
// real header on line 2. Returns an array of { name, code, state, hours } for
// each real technician row (totals and footer rows dropped).
function parsePulsarCsv(text) {
  var raw = String(text || '').replace(/^﻿/, '');
  var lines = raw.split(/\r\n|\n|\r/);
  // Drop the title line. Find the header line (the one that starts with "Tech").
  var headerIdx = -1;
  for (var i = 0; i < lines.length && i < 5; i++) {
    var first = parseCsvLine(lines[i])[0];
    if (first && first.trim().toLowerCase() === 'tech') { headerIdx = i; break; }
  }
  if (headerIdx === -1) headerIdx = 1;
  var header = parseCsvLine(lines[headerIdx]).map(function (h) { return h.trim(); });
  var techCol = header.indexOf('Tech');
  var hoursCol = header.indexOf('Hours Worked');
  if (techCol === -1) techCol = 0;

  var rows = [];
  for (var r = headerIdx + 1; r < lines.length; r++) {
    if (!lines[r]) continue;
    var cells = parseCsvLine(lines[r]);
    var tech = (cells[techCol] || '').trim();
    if (!tech) continue;
    // Skip totals and footer rows.
    if (/Totals|Weighted|Limit|Penalty|Avg/i.test(tech)) continue;
    var hours = hoursCol !== -1 ? toNumber(cells[hoursCol]) : null;
    if (hours === null || hours <= 0) continue;
    var code = codeFromName(tech);
    rows.push({ name: tech, code: code, state: deriveState(code), hours: hours });
  }
  return rows;
}

// Merge several CSVs. If a tech appears in more than one (rare), sum the hours
// and keep the first code/state seen.
function parseAllCsvs(texts) {
  var byName = {};
  var order = [];
  (texts || []).forEach(function (t) {
    parsePulsarCsv(t).forEach(function (row) {
      if (byName[row.name]) {
        byName[row.name].hours += row.hours;
      } else {
        byName[row.name] = { name: row.name, code: row.code, state: row.state, hours: row.hours };
        order.push(row.name);
      }
    });
  });
  return order.map(function (n) { return byName[n]; });
}

// --- Name matching --------------------------------------------------------

// Match Pulsar tech rows to the wages map (name -> { wages, components }) read
// from the Paychex journal. Returns { matched, unmatchedPulsar, unmatchedWages }.
// matched items: { name, code, state, hours, wages, components, wagesName, matchMethod }.
function matchTechs(pulsarRows, wagesByName) {
  var matched = [];
  var usedWageNames = {};
  var wageNames = Object.keys(wagesByName || {});

  pulsarRows.forEach(function (row) {
    var pLast = getLastName(row.name);
    var pNorm = normalizeName(row.name);
    var best = null;
    var method = null;

    for (var i = 0; i < wageNames.length; i++) {
      var wn = wageNames[i];
      if (usedWageNames[wn]) continue;
      var wLast = getLastName(wn);
      var wNorm = normalizeName(wn);
      if (wNorm === pNorm) { best = wn; method = 'exact'; break; }
      if (wLast && wLast === pLast) {
        var wParts = wNorm.replace(/,/g, '').split(' ').filter(Boolean);
        var pParts = pNorm.replace(/,/g, '').split(' ').filter(Boolean);
        if (wParts.length > 1 && pParts.length > 1) {
          if (wParts[1][0] === pParts[1][0]) { best = wn; method = 'last_name'; }
        } else {
          best = wn; method = 'last_name';
        }
      }
    }

    if (best) {
      usedWageNames[best] = true;
      var entry = wagesByName[best] || {};
      matched.push({
        name: row.name,
        code: row.code,
        state: row.state,
        hours: row.hours,
        wages: Number(entry.wages) || 0,
        components: entry.components || '',
        wagesName: best,
        matchMethod: method
      });
    }
  });

  var matchedNames = {};
  matched.forEach(function (m) { matchedNames[m.name] = true; });
  var unmatchedPulsar = pulsarRows.filter(function (r) { return !matchedNames[r.name]; })
    .map(function (r) { return { name: r.name, code: r.code, state: r.state, hours: r.hours }; });
  var unmatchedWages = wageNames.filter(function (n) { return !usedWageNames[n]; });

  return { matched: matched, unmatchedPulsar: unmatchedPulsar, unmatchedWages: unmatchedWages };
}

// --- The two tests --------------------------------------------------------

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Minimum wage on ONE line. threshold is the applied minimum for that tech's
// state. rate = wages / hours; trueup = max(0, threshold*hours - wages).
function checkMinWage(hours, wages, threshold) {
  var h = Number(hours) || 0;
  var w = Number(wages) || 0;
  var t = Number(threshold) || 0;
  var rate = h > 0 ? w / h : 0;
  var trueup = Math.max(0, t * h - w);
  return { rate: round2(rate), trueup: round2(trueup), compliant: rate >= t };
}

// Overtime on ONE line. Half-time premium (0.5x the regular rate) on hours over
// 40 - correct for commission-paid techs whose pay already covers straight time
// on every hour. The 1.5x (additional 1.0x) figure is computed as a reference.
function checkOvertime(hours, wages, otMethod) {
  var h = Number(hours) || 0;
  var w = Number(wages) || 0;
  if (h <= OT_THRESHOLD_HOURS) {
    return { ot_hours: 0, reg_rate: h > 0 ? round2(w / h) : 0, half: 0, full: 0, premium: 0 };
  }
  var otHours = round2(h - OT_THRESHOLD_HOURS);
  var regRate = w / h;
  var half = round2(regRate * 0.5 * otHours);
  var full = round2(regRate * 1.0 * otHours);
  var premium = otMethod === 'full' ? full : half;
  return { ot_hours: otHours, reg_rate: round2(regRate), half: half, full: full, premium: premium };
}

// Run both tests over a list of reviewed lines. Each input line needs at least
// { hours, wages, threshold }. Returns per-line results plus period totals,
// sorted lowest effective rate first (the evidence that the whole population was
// checked). thresholdFor(line) may be supplied to look the threshold up per
// state; otherwise line.threshold is used.
//
// Lines with $0 (or no) W-2 wages are SKIPPED, not tested (Ben's kick-back,
// 2026-09-24). A $0 line means the person has Pulsar hours but was not paid on
// this Paychex journal at all - the owner/admin logins, someone paid on another
// payroll, or a Pulsar name the journal read could not match. Testing them
// produced a phantom true-up of the full floor x hours (e.g. 21.2 hrs @ $0.00
// = $296.80). They are returned in `skipped` so the screen and the filed PDF
// still name them - nothing is silently dropped - and typing a real wage on the
// review screen puts the person straight back into the test.
function isZeroWage(ln) { return !(Number(ln.wages) > 0); }

function computeRun(lines, otMethod, thresholdFor) {
  var out = [];
  var skipped = [];
  (lines || []).forEach(function (ln) {
    if (ln.excluded) return;
    if (isZeroWage(ln)) { skipped.push(ln); return; }
    var threshold = thresholdFor ? thresholdFor(ln) : (Number(ln.threshold) || 0);
    var mw = checkMinWage(ln.hours, ln.wages, threshold);
    var ot = checkOvertime(ln.hours, ln.wages, otMethod);
    out.push(Object.assign({}, ln, {
      threshold: round2(threshold),
      effective_rate: mw.rate,
      trueup: mw.trueup,
      flagged_minwage: !mw.compliant,
      ot_hours: ot.ot_hours,
      reg_rate: ot.reg_rate,
      ot_premium_half: ot.half,
      ot_premium_full: ot.full,
      ot_premium: ot.premium,
      flagged_ot: ot.ot_hours > 0
    }));
  });

  out.sort(function (a, b) { return a.effective_rate - b.effective_rate; });

  var totalTrueup = 0, totalOt = 0, mwViolations = 0, otCount = 0, lowest = null;
  out.forEach(function (r) {
    totalTrueup += r.trueup;
    totalOt += r.ot_premium;
    if (r.flagged_minwage) mwViolations++;
    if (r.flagged_ot) otCount++;
    if (lowest === null || r.effective_rate < lowest) lowest = r.effective_rate;
  });

  return {
    lines: out,
    skipped: skipped,
    roster_count: out.length,
    total_trueup: round2(totalTrueup),
    total_ot: round2(totalOt),
    minwage_violations: mwViolations,
    ot_count: otCount,
    lowest_rate: lowest === null ? 0 : round2(lowest),
    status_minwage: mwViolations > 0 ? 'action' : 'pass',
    status_ot: otCount > 0 ? 'action' : 'pass'
  };
}

module.exports = {
  OT_THRESHOLD_HOURS: OT_THRESHOLD_HOURS,
  deriveState: deriveState,
  codeFromName: codeFromName,
  normalizeName: normalizeName,
  getLastName: getLastName,
  parseCsvLine: parseCsvLine,
  toNumber: toNumber,
  parsePulsarCsv: parsePulsarCsv,
  parseAllCsvs: parseAllCsvs,
  matchTechs: matchTechs,
  checkMinWage: checkMinWage,
  checkOvertime: checkOvertime,
  computeRun: computeRun,
  isZeroWage: isZeroWage
};
