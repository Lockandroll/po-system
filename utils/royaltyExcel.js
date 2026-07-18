'use strict';
/*
 * Pop-A-Lock Royalty — Excel statement writer (Nova)
 * --------------------------------------------------
 * Renders the Automated Royalty & Advertising Fund Statement to an .xlsx that
 * matches the approved Birmingham sheet: same A-I three-market layout, the navy
 * section bands, accounting number formats (zero shows as a dash), and a period
 * header. A second "Call Data" sheet carries the raw Pulsar rows plus the six
 * engine helper columns so any figure on the statement can be audited.
 *
 * buildStatementBuffer(opts) -> Promise<Buffer>
 *   opts = { cells, city, owner, period, periodLabel, rates, rows }
 *   - cells:  the map returned by royaltyEngine.computeStatement(...).cells
 *   - rows:   (optional) the parsed Pulsar rows for the Call Data audit sheet
 *
 * No backtick/template-literal strings are used in this file (Windows-safe).
 */

var ExcelJS = require('exceljs');
var eng = require('./royaltyEngine');

var NAVY = 'FF1F3864', MIDBLUE = 'FF4472C4', LTBLUE = 'FFD9E1F2', TOTAL = 'FFFFF2CC';
var INPUT = 'FFFFFF00', GREY = 'FF595959', BLUE = 'FF0000FF', WHITE = 'FFFFFFFF';
var MONEY = '$#,##0.00;($#,##0.00);"-"';
var COUNT = '#,##0;(#,##0);"-"';
var PCT = '0.0%';

function money(x) { return eng.money(x); }

// pull a value out of the computed cell map, with a fallback when the engine
// did not populate that cell (empty market columns, etc.)
function make(cells) {
  return function (coord, fb) {
    var v = cells[coord];
    return (v === undefined || v === null) ? fb : v;
  };
}

function buildWorkbook(opts) {
  opts = opts || {};
  var cells = opts.cells || {};
  var g = make(cells);
  var rates = opts.rates || {};
  var rRate = rates.royaltyRate != null ? rates.royaltyRate : 0.05;
  var aRate = rates.adRate != null ? rates.adRate : 0.01;
  var pPct = rates.partsCostPct != null ? rates.partsCostPct : 0.75;

  var wb = new ExcelJS.Workbook();
  wb.creator = 'Nova';
  wb.created = new Date(2020, 0, 1); // fixed (Date.now unavailable in some contexts; value is cosmetic)
  var ws = wb.addWorksheet('Statement', { views: [{ showGridLines: false }] });

  var widths = { A: 40, B: 11, C: 13, D: 3, E: 11, F: 13, G: 3, H: 11, I: 13 };
  Object.keys(widths).forEach(function (k) { ws.getColumn(k).width = widths[k]; });

  function set(coord, val, o) {
    o = o || {};
    var c = ws.getCell(coord);
    if (val !== undefined && val !== null) c.value = val;
    var font = { name: 'Arial', size: o.size || 10, bold: !!o.bold };
    if (o.color) font.color = { argb: o.color };
    c.font = font;
    if (o.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
    if (o.fmt) c.numFmt = o.fmt;
    c.alignment = { vertical: 'middle', horizontal: o.align || (o.fmt ? 'right' : 'left') };
    if (o.border) {
      var t = { style: 'thin', color: { argb: 'FFBFBFBF' } };
      c.border = { top: t, left: t, bottom: t, right: t };
    }
  }

  // fill a whole A..I row with one background (for the section bands)
  function band(row, fill) {
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].forEach(function (col) {
      var c = ws.getCell(col + row);
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    });
  }

  // ---- header ----
  set('A1', 'Automated Royalty & Advertising Fund Statement', { size: 15, bold: true, color: NAVY });
  set('A2', 'Pop-A-Lock Franchise System', { size: 11, bold: true, color: NAVY });
  set('A4', 'Franchise Location', { bold: true }); set('B4', opts.city || '', { bold: true });
  set('A6', 'Franchise Owner', { bold: true }); set('B6', opts.owner || '', { bold: true });
  set('A7', 'Statement Period', { bold: true }); set('B7', opts.periodLabel || opts.period || '', { bold: true });
  set('B9', 'Core Market', { bold: true, align: 'center' });
  set('E9', 'Motor Club', { bold: true, align: 'center' });
  set('H9', "Nat'l Accounts", { bold: true, align: 'center' });

  // a service row: label + [Core n/$, Club n/$, Natl n/$]
  function svcRow(row, label, countsToo) {
    set('A' + row, label, {});
    var pairs = [['B', 'C'], ['E', 'F'], ['H', 'I']];
    pairs.forEach(function (p) {
      set(p[0] + row, g(p[0] + row, 0), { fmt: COUNT });
      if (countsToo !== 'countOnly') set(p[1] + row, g(p[1] + row, 0), { fmt: MONEY });
    });
  }

  function sectionHead(row, title) {
    band(row, NAVY);
    set('A' + row, title, { size: 11, bold: true, color: WHITE, fill: NAVY });
    [['B', 'Number'], ['C', 'Sales'], ['E', 'Number'], ['F', 'Sales'], ['H', 'Number'], ['I', 'Sales']].forEach(function (p) {
      set(p[0] + row, p[1], { bold: true, color: WHITE, fill: MIDBLUE, align: 'center' });
    });
  }

  // ===== OPENING / UNLOCKING =====
  sectionHead(10, 'OPENING / UNLOCKING');
  svcRow(11, 'Car Door Unlocking');
  svcRow(12, 'Trunk Opening');
  svcRow(13, 'Service Call (All Service Types)');
  svcRow(14, 'Paid GOA (All Service Types)');
  // Emergency CDU — count only
  set('A15', 'Emergency Car Door Unlocking', {});
  set('B15', g('B15', 0), { fmt: COUNT }); set('E15', g('E15', 0), { fmt: COUNT }); set('H15', g('H15', 0), { fmt: COUNT });
  set('A16', 'Dead Call (All Service Types)', {});
  set('B16', g('B16', 0), { fmt: COUNT }); set('E16', g('E16', 0), { fmt: COUNT }); set('H16', g('H16', 0), { fmt: COUNT });
  set('A17', 'LESS Sales Tax', { size: 9, color: GREY });
  set('C17', g('C17', 0), { size: 9, color: GREY, fmt: MONEY }); set('F17', g('F17', 0), { size: 9, color: GREY, fmt: MONEY }); set('I17', g('I17', 0), { size: 9, color: GREY, fmt: MONEY });
  set('A18', 'Sales Subtotals (Opening/Unlocking)', { bold: true });
  set('B18', '1A', { size: 9, bold: true, color: 'FF7F7F7F', fill: LTBLUE, align: 'center' }); set('C18', g('C18', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });
  set('E18', '1B', { size: 9, bold: true, color: 'FF7F7F7F', fill: LTBLUE, align: 'center' }); set('F18', g('F18', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });
  set('H18', '1C', { size: 9, bold: true, color: 'FF7F7F7F', fill: LTBLUE, align: 'center' }); set('I18', g('I18', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });
  set('A19', 'Royalty Rate (Opening/Unlocking)', {});
  set('C19', g('C19', rRate), { color: BLUE, fill: INPUT, fmt: PCT }); set('F19', g('F19', rRate), { color: BLUE, fill: INPUT, fmt: PCT }); set('I19', g('I19', rRate), { color: BLUE, fill: INPUT, fmt: PCT });
  set('A20', 'Royalty Payment (Opening/Unlocking)', {});
  set('B20', '1D', { size: 9, bold: true, color: 'FF7F7F7F' }); set('C20', g('C20', 0), { fmt: MONEY });
  set('E20', '1E', { size: 9, bold: true, color: 'FF7F7F7F' }); set('F20', g('F20', 0), { fmt: MONEY });
  set('H20', '1F', { size: 9, bold: true, color: 'FF7F7F7F' }); set('I20', g('I20', 0), { fmt: MONEY });
  set('A21', 'Total Opening/Unlocking Royalty', { bold: true });
  set('B21', '1G', { size: 9, bold: true, color: 'FF7F7F7F' }); set('I21', g('I21', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });

  // ===== ROADSIDE ASSISTANCE =====
  sectionHead(23, 'ROADSIDE ASSISTANCE');
  svcRow(24, 'Tire Change');
  svcRow(25, 'Jump Start');
  svcRow(26, 'Fuel Delivery');
  svcRow(27, 'Other Services (Description - Battery Service)');
  set('A28', 'LESS Sales Tax', { size: 9, color: GREY });
  set('C28', g('C28', 0), { size: 9, color: GREY, fmt: MONEY }); set('F28', g('F28', 0), { size: 9, color: GREY, fmt: MONEY }); set('I28', g('I28', 0), { size: 9, color: GREY, fmt: MONEY });
  set('A29', 'Sales Subtotals (Roadside Assistance)', { bold: true });
  set('B29', '2A', { size: 9, bold: true, color: 'FF7F7F7F', fill: LTBLUE, align: 'center' }); set('C29', g('C29', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });
  set('E29', '2B', { size: 9, bold: true, color: 'FF7F7F7F', fill: LTBLUE, align: 'center' }); set('F29', g('F29', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });
  set('H29', '2C', { size: 9, bold: true, color: 'FF7F7F7F', fill: LTBLUE, align: 'center' }); set('I29', g('I29', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });
  set('A30', 'Royalty Rate (Roadside Assistance)', {});
  set('C30', g('C30', rRate), { color: BLUE, fill: INPUT, fmt: PCT }); set('F30', g('F30', rRate), { color: BLUE, fill: INPUT, fmt: PCT }); set('I30', g('I30', rRate), { color: BLUE, fill: INPUT, fmt: PCT });
  set('A31', 'Royalty Payment (Roadside Assistance)', {});
  set('B31', '2D', { size: 9, bold: true, color: 'FF7F7F7F' }); set('C31', g('C31', 0), { fmt: MONEY });
  set('E31', '2E', { size: 9, bold: true, color: 'FF7F7F7F' }); set('F31', g('F31', 0), { fmt: MONEY });
  set('H31', '2F', { size: 9, bold: true, color: 'FF7F7F7F' }); set('I31', g('I31', 0), { fmt: MONEY });
  set('A32', 'Total Roadside Assistance Royalty', { bold: true });
  set('B32', '2G', { size: 9, bold: true, color: 'FF7F7F7F' }); set('I32', g('I32', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });

  // ===== LOCKSMITH SERVICES =====
  sectionHead(34, 'LOCKSMITH SERVICES');
  set('A35', 'Locksmith Services', {});
  set('B35', g('B35', 0), { fmt: COUNT }); set('C35', g('C35', 0), { fmt: MONEY });
  set('A36', 'LESS Sales Tax', { size: 9, color: GREY }); set('C36', g('C36', 0), { size: 9, color: GREY, fmt: MONEY });
  set('A37', 'LESS Parts Cost', { size: 9, color: GREY }); set('C37', g('C37', 0), { size: 9, color: GREY, fmt: MONEY });
  set('A38', 'Sales Subtotals (Locksmith Services)', { bold: true });
  set('B38', '3A', { size: 9, bold: true, color: 'FF7F7F7F', fill: LTBLUE, align: 'center' }); set('C38', g('C38', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });
  set('E38', '3B', { size: 9, bold: true, color: 'FF7F7F7F', fill: LTBLUE, align: 'center' }); set('F38', g('F38', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });
  set('H38', '3C', { size: 9, bold: true, color: 'FF7F7F7F', fill: LTBLUE, align: 'center' }); set('I38', g('I38', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });
  set('A39', 'Royalty Rate (Locksmith Services)', {});
  set('C39', g('C39', rRate), { color: BLUE, fill: INPUT, fmt: PCT }); set('F39', g('F39', rRate), { color: BLUE, fill: INPUT, fmt: PCT }); set('I39', g('I39', rRate), { color: BLUE, fill: INPUT, fmt: PCT });
  set('A40', 'Royalty Payment (Locksmith Services)', {});
  set('B40', '3D', { size: 9, bold: true, color: 'FF7F7F7F' }); set('C40', g('C40', 0), { fmt: MONEY });
  set('E40', '3E', { size: 9, bold: true, color: 'FF7F7F7F' }); set('F40', g('F40', 0), { fmt: MONEY });
  set('H40', '3F', { size: 9, bold: true, color: 'FF7F7F7F' }); set('I40', g('I40', 0), { fmt: MONEY });
  set('A41', 'Total Locksmith Services Royalty', { bold: true });
  set('B41', '3G', { size: 9, bold: true, color: 'FF7F7F7F' }); set('I41', g('I41', 0), { bold: true, fill: LTBLUE, fmt: MONEY, border: true });

  // ===== adjustments + totals =====
  set('A43', 'Fraction of Cents Adjustment', {}); set('I43', g('I43', 0), { color: BLUE, fill: INPUT, fmt: MONEY });
  set('A44', 'Road Club Sales under $19.00 (manual deduction)', {}); set('I44', g('I44', 0), { color: BLUE, fill: INPUT, fmt: MONEY });
  set('A45', 'Total Royalty Fee — make check payable to SystemForward America, Inc.', { bold: true });
  set('I45', g('I45', 0), { bold: true, fill: TOTAL, fmt: MONEY, border: true });

  band(46, NAVY);
  set('A46', 'ADVERTISING FEE', { size: 11, bold: true, color: WHITE, fill: NAVY });
  set('A47', 'Gross Sales', {}); set('I47', g('I47', 0), { fmt: MONEY });
  set('A48', 'Advertising Fee', {}); set('I48', g('I48', aRate), { color: BLUE, fill: INPUT, fmt: PCT });
  set('A49', 'Total Advertising Fee — make check payable to Pop-A-Lock Advertising Fund, Inc.', { bold: true });
  set('I49', g('I49', 0), { bold: true, fill: TOTAL, fmt: MONEY, border: true });

  set('A50', 'I certify that the above data is true and correct to the best of my knowledge.', { size: 9, color: GREY });
  set('A52', 'Owner/Manager Signature ______________________________', { bold: true });
  set('F52', 'Date __________________', { bold: true });

  // rates footnote
  set('A54', 'Rates applied: Royalty ' + (rRate * 100).toFixed(1) + '% per section  ·  Advertising ' +
    (aRate * 100).toFixed(1) + '%  ·  Parts cost ' + (pPct * 100).toFixed(0) + '% of parts billed', { size: 9, color: GREY });
  if (opts.footnote) set('A55', opts.footnote, { size: 9, color: GREY });

  // ---- Call Data audit sheet ----
  if (Array.isArray(opts.rows) && opts.rows.length) {
    var cd = wb.addWorksheet('Call Data');
    var headers = Object.keys(opts.rows[0]);
    var motorSet = {};
    (opts.motorClub || eng.MOTOR_CLUB).forEach(function (m) { motorSet[String(m).trim()] = true; });
    var extra = ['_Service', '_Market', '_Sales', '_Tax', '_PartsBilled', '_Section'];
    var headerRow = headers.concat(extra);
    cd.addRow(headerRow);
    cd.getRow(1).font = { name: 'Arial', size: 9, bold: true };
    cd.views = [{ state: 'frozen', ySplit: 1 }];
    opts.rows.forEach(function (r) {
      var svc = eng.classifyService(r['Task']);
      var mk = eng.classifyMarket(r['Account'], motorSet);
      var sales = money(r['Collected Cash']) + money(r['Collected Check']) + money(r['Collected CC']) + money(r['Collected Account']);
      var tax = money(r['Collected Tax']);
      var partsB = money(r['Charged Parts']) + money(r['Charged Parts  Non Tax']);
      var line = headers.map(function (h) { return r[h]; });
      line.push(svc, mk, sales, tax, partsB, eng.sectionOf(svc));
      cd.addRow(line);
    });
    // right-size a few of the appended numeric columns
    var base = headers.length;
    [base + 3, base + 4, base + 5].forEach(function (i) { cd.getColumn(i + 1).numFmt = '$#,##0.00'; });
  }

  return wb;
}

async function buildStatementBuffer(opts) {
  var wb = buildWorkbook(opts);
  return wb.xlsx.writeBuffer();
}

module.exports = { buildWorkbook: buildWorkbook, buildStatementBuffer: buildStatementBuffer };
