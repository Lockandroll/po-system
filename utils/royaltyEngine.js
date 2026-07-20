'use strict';
/*
 * Pop-A-Lock Royalty Engine  (Nova)
 * ---------------------------------
 * Pure JavaScript, no dependencies. Takes the Pulsar "Call Search" CSV for one
 * city + month and produces the Automated Royalty & Advertising Fund Statement.
 *
 * Verified against Birmingham May 2026 (685 rows / 449 completed): every
 * statement cell matches the approved sheet (max diff 5e-6, floating point only).
 *   computeStatement(parseCSV(csvText)).cells.I45  ->  1310.19   (Total Royalty Fee)
 *   ...I47 -> 26203.76 (Gross Sales)   ...I49 -> 262.04 (Total Advertising Fee)
 *
 * Classification rules, market split, locksmith consolidation, Paid-GOA handling
 * and the royalty/advertising math are defined in PopALock_Royalty_Module_Spec.md
 * (sections 4-8). This file is the reference implementation from Appendix A of that
 * spec, adapted to a CommonJS module. NOTE: no backtick/template-literal strings are
 * used anywhere in this file (Windows-safe per the Nova editing rules).
 */

var MOTOR_CLUB = ['Agero-Swoop', 'GEICO', 'ALLSTATE', 'Allied Dispatch', 'Roadside Protect'];

// RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes, CRLF, and a
// leading UTF-8 BOM. Returns an array of row objects keyed by the header row.
function parseCSV(text) {
  text = String(text == null ? '' : text).replace(/^﻿/, '');
  var rows = [], field = '', row = [], i = 0, inQ = false, ch;
  while (i < text.length) {
    ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  var H = rows[0].map(function (h) { return String(h).trim(); }), out = [];
  for (var r = 1; r < rows.length; r++) {
    if (rows[r].every(function (v) { return String(v).trim() === ''; })) continue;
    var o = {};
    for (var c = 0; c < H.length; c++) o[H[c]] = rows[r][c] !== undefined ? rows[r][c] : '';
    out.push(o);
  }
  return out;
}

// "$1,234.50" / "($5.00)" / "" -> number (blank and dash both parse to 0).
function money(x) {
  if (x == null) return 0;
  var s = String(x).replace(/\$/g, '').replace(/,/g, '').replace(/\(/g, '-').replace(/\)/g, '').trim();
  if (s === '' || s === '-') return 0;
  var v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

// Service classification from the Task label. Order matters — first match wins.
function classifyService(task) {
  if (task == null) return '';
  var t = String(task).trim().toUpperCase();
  if (t === '') return '';
  if (t.indexOf('EDU') >= 0 && t.indexOf('CDU') >= 0) return 'EmergencyCDU';
  if (/\.LS$/.test(t) || t === 'LS' || t.indexOf('PICK') >= 0) return 'Locksmith';
  if (t.indexOf('CDU') >= 0) return 'CarDoorUnlock';
  if (t.indexOf('TRUNK') >= 0) return 'TrunkOpening';
  if (t.indexOf('TIRE') >= 0 || /\.AIR$/.test(t) || t === 'AIR') return 'TireChange';
  if (t.indexOf('JUMP') >= 0 || /\.JS$/.test(t) || t === 'JS') return 'JumpStart';
  if (t.indexOf('GAS') >= 0) return 'FuelDelivery';
  if (/\.BAT$/.test(t) || t === 'BAT') return 'OtherBattery';
  return 'OTHER';
}

function sectionOf(s) {
  if (s === 'CarDoorUnlock' || s === 'TrunkOpening' || s === 'EmergencyCDU') return 'Opening';
  if (s === 'TireChange' || s === 'JumpStart' || s === 'FuelDelivery' || s === 'OtherBattery') return 'Roadside';
  if (s === 'Locksmith') return 'Locksmith';
  return 'Other';
}

function classifyMarket(acct, set) {
  var a = acct == null ? '' : String(acct).trim();
  if (a === '') return 'Core';
  return set[a] ? 'MotorClub' : 'Natl';
}

// Compute the full statement. Returns { cells, meta }.
//   cells:  map of statement cell -> value  (e.g. cells.I45 = total royalty)
//   meta:   { completed, goaPaid, rowCount, location, unmapped, sections }
// opts (all optional): royaltyRate (0.05), adRate (0.01), partsCostPct (0.75),
//   fractionAdj (0), roadClubAdj (0), motorClub ([...]).
function computeStatement(rows, opts) {
  opts = opts || {};
  var rRate = opts.royaltyRate != null ? opts.royaltyRate : 0.05;
  var aRate = opts.adRate != null ? opts.adRate : 0.01;
  var pPct = opts.partsCostPct != null ? opts.partsCostPct : 0.75;
  var frac = opts.fractionAdj || 0;
  var rclub = opts.roadClubAdj || 0;
  var set = {};
  (opts.motorClub || MOTOR_CLUB).forEach(function (m) { set[String(m).trim()] = true; });

  var MK = ['Core', 'MotorClub', 'Natl'];
  function z() { return { Core: 0, MotorClub: 0, Natl: 0 }; }
  var cnt = {}, sal = {};
  ['CarDoorUnlock', 'TrunkOpening', 'EmergencyCDU', 'TireChange', 'JumpStart', 'FuelDelivery', 'OtherBattery']
    .forEach(function (s) { cnt[s] = z(); sal[s] = z(); });
  var openTax = z(), roadTax = z(), goaN = z(), goaS = z();
  var lock = { n: 0, sales: 0, tax: 0, parts: 0 };
  var allParts = 0;   // parts cost is deducted across ALL completed services (Tony 2026-07-20), carried on the Locksmith line
  var unmapped = {};   // Task label -> count of completed calls that did not map to a service line
  var location = '';

  rows.forEach(function (row) {
    if (!location && row['Location'] != null && String(row['Location']).trim() !== '') location = String(row['Location']).trim();
    var st = String(row['Status'] || '').trim();
    var svc = classifyService(row['Task']);
    var mk = classifyMarket(row['Account'], set);
    var sales = money(row['Collected Cash']) + money(row['Collected Check']) + money(row['Collected CC']) + money(row['Collected Account']);
    var tax = money(row['Collected Tax']);
    var parts = money(row['Charged Parts']) + money(row['Charged Parts  Non Tax']);
    var sec = sectionOf(svc);
    if (st === 'GOA') { if (sales > 0) { goaN[mk] += 1; goaS[mk] += sales; } return; }
    if (st !== 'Completed') return;
    allParts += parts;
    if (svc === 'Locksmith') { lock.n += 1; lock.sales += sales; lock.tax += tax; lock.parts += parts; return; }
    if (cnt[svc]) { cnt[svc][mk] += 1; sal[svc][mk] += sales; }
    else if (svc === 'OTHER') {
      var lbl = String(row['Task'] == null ? '' : row['Task']).trim() || '(blank Task)';
      unmapped[lbl] = (unmapped[lbl] || 0) + 1;
    }
    if (sec === 'Opening') openTax[mk] += tax;
    else if (sec === 'Roadside') roadTax[mk] += tax;
  });

  var C = {}, col = { Core: ['B', 'C'], MotorClub: ['E', 'F'], Natl: ['H', 'I'] };
  function put(k, v) { C[k] = v; }
  function rc(r, s) { MK.forEach(function (m) { put(col[m][0] + r, cnt[s][m]); put(col[m][1] + r, sal[s][m]); }); }

  var openSub = z(), openRoy = z(), roadSub = z(), roadRoy = z();
  MK.forEach(function (m) {
    openSub[m] = sal.CarDoorUnlock[m] + sal.TrunkOpening[m] + 0 + goaS[m] - openTax[m];
    openRoy[m] = openSub[m] * rRate;
    roadSub[m] = sal.TireChange[m] + sal.JumpStart[m] + sal.FuelDelivery[m] + sal.OtherBattery[m] - roadTax[m];
    roadRoy[m] = roadSub[m] * rRate;
  });
  var lpc = allParts * pPct, lsub = lock.sales - lock.tax - lpc, lroy = lsub * rRate;
  var oT = openRoy.Core + openRoy.MotorClub + openRoy.Natl;
  var rT = roadRoy.Core + roadRoy.MotorClub + roadRoy.Natl;
  var gross = openSub.Core + openSub.MotorClub + openSub.Natl + roadSub.Core + roadSub.MotorClub + roadSub.Natl + lsub;

  rc(11, 'CarDoorUnlock'); rc(12, 'TrunkOpening');
  MK.forEach(function (m) {
    put(col[m][0] + '13', 0); put(col[m][1] + '13', 0);
    put(col[m][0] + '14', goaN[m]); put(col[m][1] + '14', goaS[m]);
    put(col[m][0] + '15', cnt.EmergencyCDU[m]); put(col[m][0] + '16', 0);
    put(col[m][1] + '17', openTax[m]); put(col[m][1] + '18', openSub[m]);
    put(col[m][1] + '19', rRate); put(col[m][1] + '20', openRoy[m]);
  });
  put('I21', oT);
  rc(24, 'TireChange'); rc(25, 'JumpStart'); rc(26, 'FuelDelivery'); rc(27, 'OtherBattery');
  MK.forEach(function (m) {
    put(col[m][1] + '28', roadTax[m]); put(col[m][1] + '29', roadSub[m]);
    put(col[m][1] + '30', rRate); put(col[m][1] + '31', roadRoy[m]);
  });
  put('I32', rT);
  put('B35', lock.n); put('C35', lock.sales); put('C36', lock.tax); put('C37', lpc);
  put('C38', lsub); put('F38', 0); put('I38', 0); put('C39', rRate); put('C40', lroy); put('I41', lroy);
  put('I43', frac); put('I44', rclub); put('I45', (oT + rT + lroy) + frac - rclub);
  put('I47', gross); put('I48', aRate); put('I49', gross * aRate);

  var completed = 0, goaPaid = goaN.Core + goaN.MotorClub + goaN.Natl;
  rows.forEach(function (r) { if (String(r['Status'] || '').trim() === 'Completed') completed++; });
  var unmappedArr = Object.keys(unmapped).map(function (k) { return { task: k, count: unmapped[k] }; })
    .sort(function (a, b) { return b.count - a.count; });

  return {
    cells: C,
    meta: {
      completed: completed,
      goaPaid: goaPaid,
      rowCount: rows.length,
      location: location,
      unmapped: unmappedArr,
      totals: { royaltyFee: C.I45, adFee: C.I49, grossSales: C.I47 }
    }
  };
}

module.exports = {
  MOTOR_CLUB: MOTOR_CLUB,
  parseCSV: parseCSV,
  money: money,
  classifyService: classifyService,
  sectionOf: sectionOf,
  classifyMarket: classifyMarket,
  computeStatement: computeStatement
};
