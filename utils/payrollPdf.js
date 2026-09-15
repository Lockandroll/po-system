// Filed payroll-compliance PDF.
//
// Renders the one-page (roster may flow to a second page) record that is
// archived every pay period for wage-and-hour defense, per the payroll-
// compliance skill. pdfkit, same library as the invoice / dispute / revenue
// PDFs. Returns a Promise<Buffer>; the route uploads it to R2.
//
// The methodology paragraph is load-bearing legal evidence (good-faith "we had
// a system", caps liquidated damages under 29 USC 260) and must match the method
// actually used. It is passed in from settings so policy and practice cannot
// drift.
//
// House style: string concatenation only, no template literals.

var PDFDocument = require('pdfkit');

var C = {
  ink: '#1a1a1a', dim: '#555555', line: '#cccccc',
  green: '#15803d', greenBg: '#ecfdf3', greenLine: '#abe6c1',
  amber: '#b45309', amberBg: '#fffbeb', amberLine: '#f5d98b',
  red: '#b91c1c', redBg: '#fef2f2', redLine: '#f3b4b4',
  panelKey: '#777777', grey: '#f0f0f0'
};

function money(n) {
  var v = Number(n) || 0;
  var neg = v < 0;
  v = Math.abs(v).toFixed(2);
  var parts = v.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + parts[0] + '.' + parts[1];
}
function rate(n) { return '$' + (Number(n) || 0).toFixed(2); }

function fmtDate(d) {
  if (!d) return '';
  var s = String(d);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[2] + '/' + m[3] + '/' + m[1];
  return s;
}

// run: totals + statuses + period. lines: sorted roster (lowest rate first).
// opts: { entity, fein, methodology, thresholds: {FL:{legal,applied},...} }
function generate(run, lines, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    try {
      var doc = new PDFDocument({ size: 'LETTER', margin: 40 });
      var chunks = [];
      doc.on('data', function (c) { chunks.push(c); });
      doc.on('end', function () { resolve(Buffer.concat(chunks)); });
      doc.on('error', reject);

      var left = 40;
      var right = doc.page.width - 40;
      var width = right - left;

      // Header
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(16).text('PAYROLL COMPLIANCE RECORD', left, 40);
      doc.fillColor(C.red).font('Helvetica-Bold').fontSize(8)
        .text('CONFIDENTIAL  -  ATTORNEY WORK PRODUCT  -  RETAIN 3 YEARS', left, 62);

      var entity = opts.entity || 'Lock and Roll LLC';
      var fein = opts.fein || 'on file';
      var idLine = entity + '   -   FEIN ' + fein + '   -   Pay period ' + fmtDate(run.period_start) + ' to ' +
        fmtDate(run.period_end) + '   -   Check date ' + fmtDate(run.check_date) +
        (run.review_date ? '   -   Reviewed ' + fmtDate(run.review_date) : '');
      doc.fillColor(C.dim).font('Helvetica').fontSize(8.5).text(idLine, left, 78, { width: width });
      var y = 96;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(1.2).strokeColor(C.ink).stroke();
      y += 12;

      // Status panels
      var pin = run.status_minwage === 'action';
      var pot = run.status_ot === 'action';
      var pw = (width - 12) / 2;
      var ph = 46;
      panel(doc, left, y, pw, ph, 'MINIMUM WAGE',
        pin ? 'ACTION REQUIRED' : 'PASS',
        pin ? (run.minwage_violations + ' below threshold - true-up ' + money(run.total_trueup)) : 'All technicians at or above the floor',
        pin ? 'red' : 'green');
      panel(doc, left + pw + 12, y, pw, ph, 'OVERTIME',
        pot ? 'ACTION REQUIRED' : 'PASS',
        pot ? (run.ot_count + ' over 40 hrs - premium ' + money(run.total_ot)) : 'No technician over 40 hours',
        pot ? 'amber' : 'green');
      y += ph + 12;

      // Applied minimum wage by state
      var th = opts.thresholds || {};
      var stLine = 'Applied minimum wage:  ' + ['FL', 'GA', 'AL'].map(function (s) {
        var t = th[s] || {};
        var applied = t.applied != null ? rate(t.applied) : '';
        var legal = t.legal != null ? rate(t.legal) : '';
        return s + ' ' + applied + (legal ? ' (legal ' + legal + ')' : '');
      }).join('   -   ');
      doc.fillColor(C.dim).font('Helvetica').fontSize(8).text(stLine, left, y, { width: width });
      y += 16;

      // Methodology
      var method = opts.methodology ||
        ('Methodology. Effective hourly rate is total W-2 taxable wages (salary, commission, tips, ' +
         'bonuses, stipends) divided by hours worked per Pulsar with 30-minute gap time, aggregated ' +
         'across all regions. Overtime premium is the FLSA half-time method (29 CFR 778.118): regular ' +
         'rate x 0.5 x hours over 40. Method is consistent with the employee handbook and applied ' +
         'uniformly to every technician below.');
      var mh = doc.font('Helvetica').fontSize(8.5).heightOfString(method, { width: width - 20 }) + 12;
      doc.rect(left, y, width, mh).fill(C.grey);
      doc.rect(left, y, 3, mh).fill(C.dim);
      doc.fillColor(C.ink).font('Helvetica').fontSize(8.5).text(method, left + 12, y + 6, { width: width - 20 });
      y += mh + 12;

      // Action blocks
      var trueupLines = (lines || []).filter(function (l) { return l.flagged_minwage; });
      var otLines = (lines || []).filter(function (l) { return l.flagged_ot; });

      if (trueupLines.length) {
        y = actionBlock(doc, left, y, width, 'red',
          'True-up owed - enter in Paychex as Minimum Compensation',
          trueupLines.map(function (l) {
            return { label: l.name + '  -  ' + Number(l.hours).toFixed(1) + ' hrs @ ' + rate(l.effective_rate) + ' (' + l.state + ' floor ' + rate(l.threshold) + ')', amt: money(l.trueup) };
          }), 'Period true-up total', money(run.total_trueup));
      }
      if (otLines.length) {
        y = actionBlock(doc, left, y, width, 'amber',
          'Overtime premium owed - enter in Paychex',
          otLines.map(function (l) {
            return { label: l.name + '  -  ' + Number(l.ot_hours).toFixed(1) + ' OT hrs @ reg ' + rate(l.reg_rate), amt: money(l.ot_premium) };
          }), 'Period overtime total', money(run.total_ot));
      }
      if (!trueupLines.length && !otLines.length) {
        doc.rect(left, y, width, 24).fill(C.greenBg);
        doc.fillColor(C.green).font('Helvetica-Bold').fontSize(9.5)
          .text('No action required. Every technician cleared minimum wage and none exceeded 40 hours.', left + 10, y + 7, { width: width - 20 });
        y += 34;
      }

      // Roster table
      y = ensureSpace(doc, y, 40);
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text('ROSTER TESTED (sorted by effective rate, lowest first)', left, y);
      y += 14;
      var cols = [
        { k: 'name', w: 0.42, a: 'left', h: 'Technician' },
        { k: 'hours', w: 0.11, a: 'right', h: 'Hours' },
        { k: 'wages', w: 0.16, a: 'right', h: 'W-2 wages' },
        { k: 'rate', w: 0.12, a: 'right', h: 'Eff. rate' },
        { k: 'state', w: 0.09, a: 'center', h: 'State' },
        { k: 'ot', w: 0.10, a: 'right', h: 'OT hrs' }
      ];
      y = tableHeader(doc, left, y, width, cols);
      (lines || []).forEach(function (l) {
        if (y + 16 > doc.page.height - 40) { doc.addPage(); y = tableHeader(doc, left, 40, width, cols); }
        var tint = l.flagged_minwage ? C.redBg : (l.flagged_ot ? C.amberBg : null);
        if (tint) { doc.rect(left, y - 2, width, 15).fill(tint); }
        var cellVals = {
          name: (l.flagged_minwage || l.flagged_ot ? '* ' : '') + l.name,
          hours: Number(l.hours).toFixed(1),
          wages: money(l.wages).replace('$', ''),
          rate: rate(l.effective_rate),
          state: l.state || '',
          ot: l.ot_hours > 0 ? Number(l.ot_hours).toFixed(1) : '-'
        };
        var x = left;
        cols.forEach(function (c) {
          var cw = width * c.w;
          doc.fillColor(l.flagged_minwage ? C.red : C.ink).font('Helvetica').fontSize(8.5)
            .text(String(cellVals[c.k]), x + 3, y, { width: cw - 6, align: c.a, lineBreak: false });
          x += cw;
        });
        y += 15;
      });

      // Footnote
      y += 8;
      y = ensureSpace(doc, y, 30);
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(C.line).stroke();
      y += 6;
      var margin = (run.lowest_rate != null) ? rate(run.lowest_rate) : '';
      var foot = 'Result: ' + run.minwage_violations + ' minimum-wage true-up' + (run.minwage_violations === 1 ? '' : 's') +
        ' and ' + run.ot_count + ' overtime premium' + (run.ot_count === 1 ? '' : 's') + ' identified. ' +
        'Lowest effective rate ' + margin + '. ' + run.roster_count + ' technicians tested; full population reviewed.';
      doc.fillColor(C.dim).font('Helvetica').fontSize(8).text(foot, left, y, { width: width });

      doc.end();
    } catch (e) { reject(e); }
  });
}

function panel(doc, x, y, w, h, key, val, desc, tone) {
  var bg = tone === 'red' ? C.redBg : (tone === 'amber' ? C.amberBg : C.greenBg);
  var ln = tone === 'red' ? C.redLine : (tone === 'amber' ? C.amberLine : C.greenLine);
  var fg = tone === 'red' ? C.red : (tone === 'amber' ? C.amber : C.green);
  doc.save();
  doc.rect(x, y, w, h).fillAndStroke(bg, ln);
  doc.fillColor(C.panelKey).font('Helvetica-Bold').fontSize(7.5).text(key, x + 10, y + 8, { width: w - 20 });
  doc.fillColor(fg).font('Helvetica-Bold').fontSize(12).text(val, x + 10, y + 18, { width: w - 20 });
  doc.fillColor(C.dim).font('Helvetica').fontSize(7.5).text(desc, x + 10, y + 33, { width: w - 20, lineBreak: false });
  doc.restore();
}

function actionBlock(doc, x, y, w, tone, title, rows, totalLabel, totalAmt) {
  var bg = tone === 'red' ? C.redBg : C.amberBg;
  var ln = tone === 'red' ? C.redLine : C.amberLine;
  var fg = tone === 'red' ? C.red : C.amber;
  var h = 22 + rows.length * 13 + 15;
  doc.rect(x, y, w, h).fillAndStroke(bg, ln);
  doc.fillColor(fg).font('Helvetica-Bold').fontSize(8.5).text(title.toUpperCase(), x + 10, y + 7, { width: w - 20 });
  var ry = y + 21;
  rows.forEach(function (r) {
    doc.fillColor(C.ink).font('Helvetica').fontSize(8.5).text(r.label, x + 10, ry, { width: w - 110, lineBreak: false });
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8.5).text(r.amt, x + w - 100, ry, { width: 90, align: 'right' });
    ry += 13;
  });
  doc.moveTo(x + 10, ry + 1).lineTo(x + w - 10, ry + 1).lineWidth(0.6).strokeColor(ln).stroke();
  doc.fillColor(fg).font('Helvetica-Bold').fontSize(8.5).text(totalLabel, x + 10, ry + 4, { width: w - 110 });
  doc.fillColor(fg).font('Helvetica-Bold').fontSize(8.5).text(totalAmt, x + w - 100, ry + 4, { width: 90, align: 'right' });
  return y + h + 12;
}

function tableHeader(doc, left, y, width, cols) {
  doc.rect(left, y - 2, width, 15).fill(C.grey);
  var x = left;
  cols.forEach(function (c) {
    var cw = width * c.w;
    doc.fillColor(C.dim).font('Helvetica-Bold').fontSize(7.5).text(c.h.toUpperCase(), x + 3, y + 1, { width: cw - 6, align: c.a, lineBreak: false });
    x += cw;
  });
  return y + 16;
}

// Ensure at least `need` px remain on the page; otherwise add a page and (if a
// redraw callback is given) let the caller re-emit its table header.
function ensureSpace(doc, y, need) {
  if (y + need > doc.page.height - 40) { doc.addPage(); return 40; }
  return y;
}

module.exports = { generate: generate };
