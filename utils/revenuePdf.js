'use strict';
/*
 * Weekly revenue report - the document  (Nova)
 * --------------------------------------------
 * Draws the PDF from the model utils/revenueReport.js builds. Pure pdfkit, no
 * browser, no chart library: the charts are rectangles, which is all a bar
 * chart is, and it keeps the deploy free of a headless Chrome.
 *
 * LAYOUT, per page
 *   a title band, four cards (Roadside, Battery, Locksmith, Total Revenue),
 *   three charts in that same class order, and a weekly table.
 *
 * THE ONE DESIGN DECISION WORTH DEFENDING
 *   Each chart is scaled to ITS OWN class, not to a shared axis. Battery is
 *   about 3% of revenue; on a shared scale it is an invisible sliver and the
 *   chart tells a manager nothing about the market he is being asked to grow.
 *   The cost is that bar heights are not comparable BETWEEN the three charts,
 *   which is a real cost, so the methodology note on page 2 says so in print
 *   rather than leaving a reader to find out the hard way.
 *
 * ORDER AND COLOR
 *   Roadside, Battery, Locksmith - everywhere, on every page. Color is bound
 *   to the class, never to the position, so the same work is the same color
 *   throughout the document. The four hexes are checked for colour-vision
 *   separation on adjacent pairs; if they are ever swapped for a brand
 *   palette, re-check that.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var PDFDocument = require('pdfkit');
var CSV = require('./revenueCsv');

var COLOR = {
  roadside: '#1baf7a',
  battery: '#eb6834',
  locksmith: '#2a78d6',
  total: '#1a1a19'
};
var INK = '#1a1a19';
var MUTED = '#767676';
var RULE = '#e3e3e1';
var SOFT = '#f6f6f4';
var UP = '#16855d';
var DOWN = '#c4452a';

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------------------------------------ formatting */

function money(n, cents) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  var s = Math.abs(v).toFixed(cents ? 2 : 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-$' : '$') + s;
}

// A percent change, or an em-dash-free placeholder when there is nothing to
// compare against (see pct() in utils/revenueReport.js).
function delta(p) {
  if (p === null || p === undefined || !isFinite(p)) return 'n/a';
  var v = Math.round(p * 10) / 10;
  return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
}

function deltaColor(p) {
  if (p === null || p === undefined || !isFinite(p)) return MUTED;
  if (p > 0.05) return UP;
  if (p < -0.05) return DOWN;
  return MUTED;
}

function parts(ymd) {
  var p = String(ymd).split('-');
  return { y: parseInt(p[0], 10), m: parseInt(p[1], 10), d: parseInt(p[2], 10) };
}

// "Sep 8" - the axis label under a bar.
function shortDate(ymd) {
  var p = parts(ymd);
  return MONTHS[p.m - 1] + ' ' + p.d;
}

// "Sep 8 - Sep 14, 2026" - a whole week, spelled out.
function weekLabel(monday) {
  var a = parts(monday), b = parts(CSV.addDays(monday, 6));
  return MONTHS[a.m - 1] + ' ' + a.d + ' - ' + MONTHS[b.m - 1] + ' ' + b.d + ', ' + b.y;
}

/* ----------------------------------------------------------------- pieces */

var PAGE = { w: 612, h: 792, m: 38 };
var CW = PAGE.w - PAGE.m * 2;             // 536 content width

function titleBand(doc, title, subtitle, y) {
  doc.rect(PAGE.m, y, CW, 34).fill(INK);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff')
    .text(title, PAGE.m + 12, y + 7, { width: CW - 200, lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor('#bdbdbd')
    .text(subtitle, PAGE.m + CW - 212, y + 12, { width: 200, align: 'right', lineBreak: false });
  return y + 34;
}

/*
 * One card. Latest week big, then the two comparisons.
 * The Total card is drawn distinctly - dark marker, deeper ground - so it
 * reads as the sum of the other three rather than as a fourth service class.
 */
function drawCard(doc, x, y, w, h, label, card, color, isTotal) {
  doc.rect(x, y, w, h).fill(isTotal ? '#eceae6' : SOFT);
  doc.rect(x, y, 3, h).fill(color);

  doc.font('Helvetica-Bold').fontSize(7).fillColor(isTotal ? INK : MUTED)
    .text(String(label).toUpperCase(), x + 10, y + 8, { width: w - 16, characterSpacing: 0.6, lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(isTotal ? 16 : 15).fillColor(INK)
    .text(money(card.value), x + 10, y + 20, { width: w - 16, lineBreak: false });

  var ly = y + 41;
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
    .text('vs prior week', x + 10, ly, { width: w - 16, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(8).fillColor(deltaColor(card.d_prior))
    .text(delta(card.d_prior), x + 10, ly + 7.5, { width: w - 16, lineBreak: false });

  var ay = ly + 19;
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
    .text('vs avg ' + (card.average === null ? 'n/a' : money(card.average)), x + 10, ay,
      { width: w - 16, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(8).fillColor(deltaColor(card.d_average))
    .text(delta(card.d_average), x + 10, ay + 7.5, { width: w - 16, lineBreak: false });
}

function drawCards(doc, page, y, meta) {
  var gap = 10;
  var w = (CW - gap * 3) / 4;
  var h = 78;
  var order = CSV.CLASSES.concat(['total']);
  order.forEach(function (key, i) {
    var label = key === 'total' ? 'Total Revenue' : meta.classLabels[key];
    drawCard(doc, PAGE.m + i * (w + gap), y, w, h, label, page.cards[key], COLOR[key], key === 'total');
  });
  return y + h;
}

/*
 * One chart: a bar per week, scaled to this class's own maximum, every bar
 * labelled with its figure. No y-axis - the labels ARE the axis, and a reader
 * comparing two weeks reads the two numbers rather than eyeballing heights.
 */
function drawChart(doc, page, cls, y, meta) {
  // plotH is tuned so the title band, cards, three charts and a twelve-row
  // table fill the page without reaching the bottom margin at 754. Raising it
  // pushes the table down; past about 92 the table starts dropping its oldest
  // row to fit (see drawTable), which is not what anybody wants on a
  // twelve-week report.
  var titleH = 12, plotH = 88, axisH = 13;
  var weeks = page.rows;
  var max = 0;
  weeks.forEach(function (r) { if (r[cls] > max) max = r[cls]; });

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
    .text(meta.classLabels[cls], PAGE.m, y, { width: 200, lineBreak: false });
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
    .text(max > 0 ? 'scaled to this chart, peak ' + money(max) : 'no revenue in this window',
      PAGE.m + CW - 200, y + 1.5, { width: 200, align: 'right', lineBreak: false });

  var top = y + titleH;
  var base = top + plotH;

  // Baseline.
  doc.rect(PAGE.m, base, CW, 0.6).fill(RULE);

  var gap = 5;
  var bw = (CW - gap * (weeks.length - 1)) / weeks.length;

  // At twelve weeks a bar is ~40pt wide and every figure fits above it. The
  // window is configurable up to 52, where a bar is 9pt and the labels would
  // collide into an unreadable smear, so they thin out rather than overlap.
  // The chart stops carrying the figures at that point and the table below is
  // where the numbers are read - which is the honest trade, not a bug.
  var labelValues = bw >= 22;
  var axisEvery = bw >= 14 ? 1 : (bw >= 8 ? 2 : 4);

  weeks.forEach(function (r, i) {
    var x = PAGE.m + i * (bw + gap);
    var v = r[cls];
    var hgt = max > 0 ? Math.max(v > 0 ? 1.5 : 0, (v / max) * (plotH - 12)) : 0;
    if (hgt > 0) doc.rect(x, base - hgt, bw, hgt).fill(COLOR[cls]);

    var isLast = i === weeks.length - 1;

    // The figure, directly above its bar.
    if (labelValues) {
      doc.font('Helvetica-Bold').fontSize(5.6).fillColor(INK)
        .text(money(v), x - 3, base - hgt - 8, { width: bw + 6, align: 'center', lineBreak: false });
    }

    // The week, directly below it. The last bar is the week being reported on,
    // so it is always labelled and always in bold.
    if (isLast || (weeks.length - 1 - i) % axisEvery === 0) {
      doc.font(isLast ? 'Helvetica-Bold' : 'Helvetica').fontSize(5.6)
        .fillColor(isLast ? INK : MUTED)
        .text(shortDate(r.week_start), x - 3, base + 4, { width: bw + 6, align: 'center', lineBreak: false });
    }
  });

  return base + axisH;
}

/*
 * The weekly table. One row per week, each class with its revenue and its
 * change on the week before, plus the call count.
 *
 * There is deliberately NO combined column and NO total row. The table is a
 * week-over-week comparison within each service class; the combined figure is
 * the Total Revenue card and appears nowhere else.
 */
function drawTable(doc, page, y, meta) {
  var rowH = 13.4;
  var wkW = 74, callW = 42;
  var clsW = (CW - wkW - callW) / 3;

  // Everything on this page is placed by hand, so nothing may be drawn below
  // the bottom margin: pdfkit answers a text() call down there by starting a
  // fresh page, and the report silently grows blank sheets. At the default
  // twelve weeks every row fits; a longer window keeps the most recent weeks
  // that do and says how many it left out, rather than spilling.
  var floorY = PAGE.h - PAGE.m - 22;
  var fits = Math.max(1, Math.floor((floorY - y - 16) / rowH));
  var rows = page.rows;
  var omitted = 0;
  if (rows.length > fits) {
    omitted = rows.length - fits;
    rows = rows.slice(rows.length - fits);
  }

  doc.rect(PAGE.m, y, CW, 16).fill(SOFT);
  doc.font('Helvetica-Bold').fontSize(6.8).fillColor(MUTED)
    .text('WEEK', PAGE.m + 6, y + 5.5, { width: wkW, lineBreak: false });
  CSV.CLASSES.forEach(function (c, i) {
    var x = PAGE.m + wkW + i * clsW;
    doc.fillColor(COLOR[c])
      .text(String(meta.classLabels[c]).toUpperCase(), x, y + 5.5, { width: clsW - 8, align: 'right', lineBreak: false });
  });
  doc.fillColor(MUTED)
    .text('CALLS', PAGE.m + wkW + 3 * clsW, y + 5.5, { width: callW - 6, align: 'right', lineBreak: false });

  var ry = y + 16;
  rows.forEach(function (r, i) {
    if (i % 2 === 1) doc.rect(PAGE.m, ry, CW, rowH).fill('#fbfbfa');
    var isLast = i === rows.length - 1;
    doc.font(isLast ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor(INK)
      .text(shortDate(r.week_start), PAGE.m + 6, ry + 3.6, { width: wkW, lineBreak: false });

    CSV.CLASSES.forEach(function (c, ci) {
      var x = PAGE.m + wkW + ci * clsW;
      // Figure on the left of its cell, change on the right, so a column of
      // dollars stays a column and the percentages line up beside it.
      doc.font(isLast ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor(INK)
        .text(money(r[c]), x, ry + 3.6, { width: clsW - 48, align: 'right', lineBreak: false });
      doc.font('Helvetica').fontSize(6.4).fillColor(deltaColor(r['d_' + c]))
        .text(delta(r['d_' + c]), x + clsW - 44, ry + 4.1, { width: 36, align: 'right', lineBreak: false });
    });

    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(String(r.calls), PAGE.m + wkW + 3 * clsW, ry + 3.6, { width: callW - 6, align: 'right', lineBreak: false });
    ry += rowH;
  });

  doc.rect(PAGE.m, ry, CW, 0.5).fill(RULE);
  if (omitted) {
    doc.font('Helvetica-Oblique').fontSize(6).fillColor(MUTED)
      .text(omitted + ' earlier week' + (omitted === 1 ? '' : 's') + ' are in the charts above',
        PAGE.m, ry + 3, { width: CW, lineBreak: false });
  }
  return ry + 1;
}

/*
 * Footers, stamped onto every page AFTER the document is laid out.
 *
 * Two reasons it happens at the end rather than per page. The page number has
 * to be the real one, and a page that needed extra room (a long location list
 * pushing the methodology onto its own sheet) would otherwise make a
 * hand-kept counter lie. And the footer sits close to the bottom margin:
 * anything drawn BELOW it (792 - 38 = 754) makes pdfkit break to a fresh
 * page, which silently turned a 9-page report into a 27-page one with two
 * blanks after every sheet. Stamping at the end keeps that geometry in one
 * place.
 */
function stampFooters(doc, report) {
  var y = PAGE.h - PAGE.m - 10;
  var range = doc.bufferedPageRange();
  for (var i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(6.5).fillColor('#9a9a98')
      .text('Lock and Roll LLC  -  weekly revenue, week of ' + weekLabel(report.window.last) +
        '  -  generated ' + String(report.meta.generatedAt).slice(0, 10),
        PAGE.m, y, { width: CW - 60, lineBreak: false });
    doc.font('Helvetica').fontSize(6.5).fillColor('#9a9a98')
      .text(String(i - range.start + 1) + ' of ' + range.count,
        PAGE.m + CW - 44, y, { width: 44, align: 'right', lineBreak: false });
  }
}

/* ------------------------------------------------------------ whole pages */

function drawPage(doc, report, page, title, subtitle) {
  var y = titleBand(doc, title, subtitle, PAGE.m);
  y += 12;
  y = drawCards(doc, page, y, report.meta);
  y += 14;
  CSV.CLASSES.forEach(function (c) {
    y = drawChart(doc, page, c, y, report.meta);
    y += 6;
  });
  y += 4;
  drawTable(doc, page, y, report.meta);
}

/*
 * Page 2: every location side by side for the latest week, then the
 * methodology note. The comparison is the page a manager reads first - it is
 * the only place the locations are put next to each other - and the note
 * directly under it is where the report admits what it is doing to the
 * numbers, on the same sheet of paper rather than in a spec nobody has.
 */
function drawComparison(doc, report) {
  var y = titleBand(doc, 'Location Comparison', weekLabel(report.window.last), PAGE.m);
  y += 12;

  var rowH = 15;
  var nameW = 116, totW = 76, dW = 52;
  var clsW = (CW - nameW - totW - dW) / 3;

  doc.rect(PAGE.m, y, CW, 17).fill(SOFT);
  doc.font('Helvetica-Bold').fontSize(6.8).fillColor(MUTED)
    .text('LOCATION', PAGE.m + 6, y + 5.8, { width: nameW, lineBreak: false });
  CSV.CLASSES.forEach(function (c, i) {
    doc.fillColor(COLOR[c])
      .text(String(report.meta.classLabels[c]).toUpperCase(), PAGE.m + nameW + i * clsW, y + 5.8,
        { width: clsW - 6, align: 'right', lineBreak: false });
  });
  doc.fillColor(INK)
    .text('TOTAL', PAGE.m + nameW + 3 * clsW, y + 5.8, { width: totW - 6, align: 'right', lineBreak: false });
  doc.fillColor(MUTED)
    .text('WoW', PAGE.m + nameW + 3 * clsW + totW, y + 5.8, { width: dW - 6, align: 'right', lineBreak: false });
  y += 17;

  function line(page, bold, tint) {
    if (tint) doc.rect(PAGE.m, y, CW, rowH).fill('#eceae6');
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.4).fillColor(INK)
      .text(page.name, PAGE.m + 6, y + 4.2, { width: nameW - 6, lineBreak: false });
    CSV.CLASSES.forEach(function (c, i) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.4).fillColor(INK)
        .text(money(page.cards[c].value), PAGE.m + nameW + i * clsW, y + 4.2,
          { width: clsW - 6, align: 'right', lineBreak: false });
    });
    doc.font('Helvetica-Bold').fontSize(7.4).fillColor(INK)
      .text(money(page.cards.total.value), PAGE.m + nameW + 3 * clsW, y + 4.2,
        { width: totW - 6, align: 'right', lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(6.8).fillColor(deltaColor(page.cards.total.d_prior))
      .text(delta(page.cards.total.d_prior), PAGE.m + nameW + 3 * clsW + totW, y + 4.6,
        { width: dW - 6, align: 'right', lineBreak: false });
    y += rowH;
  }

  report.locations.forEach(function (p, i) {
    if (i % 2 === 1) doc.rect(PAGE.m, y, CW, rowH).fill('#fbfbfa');
    line(p, false, false);
  });
  doc.rect(PAGE.m, y, CW, 0.6).fill(RULE);
  y += 0.6;
  line(report.company, true, true);
  y += 18;

  // ---- methodology -------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
    .text('How these numbers are built', PAGE.m, y, { width: CW });
  y += 14;

  var notes = [
    ['Revenue', 'Collected Cash + Collected Check + Collected CC + Collected Account, from the CallSearch ' +
      'export. A call is dated by DT Complete and weeks run Monday through Sunday.'],
    ['GOA is included', 'A GOA that collected a trip fee collected real money, so GOA calls count toward ' +
      'revenue. Filtering to Completed only would understate every location.'],
    ['Charts are scaled per class', 'Each of the three charts is scaled to its own maximum, not to a shared ' +
      'axis. Battery is a few percent of revenue and would be an invisible sliver otherwise. The tradeoff is ' +
      'real: bar heights are NOT comparable between the three charts. Compare the figures, not the heights.'],
    ['The rolling average', 'The average on each card is taken over the weeks in this window before the ' +
      'latest one, counting only weeks that have data. The latest week is excluded so it is not being ' +
      'compared against an average that contains it.'],
    ['Service class', 'A task code is split on its dots. Any segment of LS makes it Locksmith, else any ' +
      'segment of Bat makes it Battery, else Roadside. Pick tasks carry no .LS suffix in CallSearch and so ' +
      'land in Roadside; that is a coding gap at the source, not a rule of this report.'],
    ['Suncoast', 'Clearwater and Tampa are reported as one location, Suncoast, per the territory ' +
      'consolidation. Every other location passes through as CallSearch names it.'],
    ['No combined column', 'The weekly tables compare each service class against itself week over week. ' +
      'The combined figure appears only on the Total Revenue card.']
  ];

  // With a long location list the table can eat the page. The methodology is
  // not optional - it is where the report admits what it does to the numbers -
  // so it takes a page of its own rather than being dropped or spilled.
  var needed = 14 + notes.length * 22;
  if (y + needed > PAGE.h - PAGE.m - 24) {
    doc.addPage();
    y = PAGE.m;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
      .text('How these numbers are built', PAGE.m, y, { width: CW });
    y += 14;
  }

  notes.forEach(function (n) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(INK)
      .text(n[0], PAGE.m, y, { width: 104 });
    var h = doc.heightOfString(n[1], { width: CW - 114, align: 'left' });
    doc.font('Helvetica').fontSize(7).fillColor('#4a4a48')
      .text(n[1], PAGE.m + 114, y, { width: CW - 114, lineGap: 0.8 });
    y += Math.max(h, 10) + 5;
  });
}

/* ------------------------------------------------------------------ entry */

/*
 * Render the whole document. Resolves with a Buffer.
 *
 * Buffered rather than streamed on purpose: the caller either emails it as an
 * attachment or hands it back on an HTTP response, both of which want the
 * whole thing, and a 9-page vector PDF is well under a megabyte.
 */
function buildPdf(report) {
  return new Promise(function (resolve, reject) {
    try {
      var doc = new PDFDocument({
        size: 'LETTER', margin: PAGE.m, bufferPages: true,
        info: {
          Title: 'Lock and Roll weekly revenue - week ending ' + CSV.addDays(report.window.last, 6),
          Author: 'Nova', Subject: 'Revenue by service class, rolling ' + report.window.count + ' weeks'
        }
      });
      var chunks = [];
      doc.on('data', function (c) { chunks.push(c); });
      doc.on('end', function () { resolve(Buffer.concat(chunks)); });
      doc.on('error', reject);

      // "12 weeks ending Sep 6, 2026" - the END of the last week, which is what
      // a reader means by "the week ending". The full range is on the
      // comparison page's title band.
      var endParts = parts(CSV.addDays(report.window.last, 6));
      var sub = report.window.count + ' weeks ending ' +
        MONTHS[endParts.m - 1] + ' ' + endParts.d + ', ' + endParts.y;

      drawPage(doc, report, report.company, 'All Locations', sub);

      doc.addPage();
      drawComparison(doc, report);

      report.locations.forEach(function (p) {
        doc.addPage();
        drawPage(doc, report, p, p.name, sub);
      });

      stampFooters(doc, report);
      doc.end();
    } catch (e) { reject(e); }
  });
}

// "nova-revenue-2026-09-14.pdf" - dated by the week the report covers, not by
// the day it was generated, so two runs of the same week produce the same name.
function fileName(report) {
  return 'nova-revenue-week-ending-' + CSV.addDays(report.window.last, 6) + '.pdf';
}

module.exports = {
  COLOR: COLOR,
  money: money,
  delta: delta,
  weekLabel: weekLabel,
  shortDate: shortDate,
  buildPdf: buildPdf,
  fileName: fileName
};
