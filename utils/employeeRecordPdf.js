// Builds the printable Disciplinary Action Report PDF for one employee_records
// row (type = 'disciplinary'). Pure pdfkit, no browser - mirrors the layout
// language of utils/releasePdf.js (black bar + orange logo block, orange
// section bullets, tinted field boxes) so a printed disciplinary notice reads
// as the same family of company paperwork as a release or sign-off.
//
// Two pages, always:
//   Page 1 - the notice itself: employee, incident, corrective action,
//            consequence, progressive-discipline strip, signatures.
//   Page 2 - Certificate of Documentation: a machine-generated, unforgeable
//            audit trail (every employee_record_events row) plus an
//            attestation paragraph. This is the page that makes the export
//            useful OUTSIDE the company - an unemployment hearing, an
//            attorney, a regulatory request - because it shows due process
//            was followed, not just that a warning was typed up.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
var PDFDocument = require('pdfkit');
var https = require('https');
var http = require('http');

var DEFAULT_LOGO = 'https://www.popalock.com/wp-content/uploads/2020/11/pal-logo-highres.png';

var LEVELS = [
  { n: 1, short: 'Verbal' },
  { n: 2, short: 'Written 1' },
  { n: 3, short: 'Written 2' },
  { n: 4, short: 'Final' },
  { n: 5, short: 'Term.' }
];

// Human labels for employee_record_events.action. An action not in this map
// still prints - title-cased with underscores turned to spaces - so a future
// action never renders as a blank line.
var EVENT_LABEL = {
  created: 'Notice created',
  draft_saved: 'Draft saved',
  submitted: 'Submitted for approval',
  approved: 'Approved',
  sent: 'Sent to employee for signature',
  returned: 'Sent back for changes',
  extended: 'Signature window extended',
  reminded: 'Reminder sent',
  refused: 'Employee declined to sign',
  viewed: 'Opened by a reviewer',
  visibility_changed: 'Visibility changed',
  voided: 'Voided',
  attachment_added: 'Attachment added',
  attachment_removed: 'Attachment removed',
  acknowledged: 'Acknowledged by employee',
  employee_response: 'Employee response recorded',
  signed: 'Signed by employee',
  followup_extended: 'Follow-up rescheduled',
  followup_done: 'Follow-up completed',
  followup_missed: 'Follow-up marked missed'
};

var INK = '#111111';
var BAR = '#141414';
var ORANGE = '#f26522';
var GREY_BAR = '#2b2b2b';
var LABEL = '#767676';
var FIELD_BG = '#dfe3f7';
var RULE = '#333333';

function bufFromDataUrl(s) {
  if (!s) return null;
  var str = String(s);
  var idx = str.indexOf('base64,');
  var b64 = idx !== -1 ? str.slice(idx + 7) : str;
  try { return Buffer.from(b64, 'base64'); } catch (e) { return null; }
}

// Fetch a remote image (or decode a data URL) into a Buffer. Best-effort:
// resolves null on any error/timeout so PDF generation never blocks on the logo.
function fetchImageBuffer(url, depth) {
  return new Promise(function (resolve) {
    try {
      if (!url) return resolve(null);
      if (Buffer.isBuffer(url)) return resolve(url);
      if (/^data:/i.test(url)) return resolve(bufFromDataUrl(url));
      if (depth == null) depth = 0;
      if (depth > 3) return resolve(null);
      var mod = /^https:/i.test(url) ? https : http;
      var req = mod.get(url, function (res) {
        var sc = res.statusCode || 0;
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchImageBuffer(res.headers.location, depth + 1));
        }
        if (sc !== 200) { res.resume(); return resolve(null); }
        var data = [];
        res.on('data', function (c) { data.push(c); });
        res.on('end', function () { resolve(Buffer.concat(data)); });
      });
      req.on('error', function () { resolve(null); });
      req.setTimeout(6000, function () { try { req.destroy(); } catch (e) {} resolve(null); });
    } catch (e) { resolve(null); }
  });
}

function txt(s) { return (s == null || s === '') ? '' : String(s); }

function mdy(d) {
  if (!d) return '';
  var t = (d instanceof Date) ? d : new Date(d);
  if (isNaN(t.getTime())) return String(d);
  var m = t.getMonth() + 1, day = t.getDate();
  return (m < 10 ? '0' : '') + m + '/' + (day < 10 ? '0' : '') + day + '/' + t.getFullYear();
}

function stamp(d) {
  if (!d) return '';
  var t = (d instanceof Date) ? d : new Date(d);
  if (isNaN(t.getTime())) return String(d);
  var h = t.getHours(), ap = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12; if (h12 === 0) h12 = 12;
  var mi = t.getMinutes();
  return mdy(t) + '  ' + h12 + ':' + (mi < 10 ? '0' : '') + mi + ' ' + ap;
}

function eventLabel(action) {
  if (EVENT_LABEL[action]) return EVENT_LABEL[action];
  return txt(action).replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || 'Event';
}

// rec: an enriched employee_records row (see routes/employeeRecords.js GET
//      /:id/pdf for the exact shape) with employee{name,title,city} and
//      ladder[] attached. events: employee_record_events rows, oldest first.
// opts: { company:{name,logo}, exportedBy:{name}, exportedAt:Date, signatureImage:Buffer|null }
function buildDisciplinaryPdf(rec, events, opts) {
  rec = rec || {};
  events = events || [];
  opts = opts || {};
  var company = opts.company || {};
  var companyName = company.name || 'Lock and Roll LLC';
  var logoUrl = opts.logo || company.logo || DEFAULT_LOGO;
  var employee = rec.employee || {};
  var recordNumber = 'ER-' + txt(rec.id);

  return fetchImageBuffer(logoUrl).then(function (logoBuf) {
    return new Promise(function (resolve, reject) {
      try {
        var doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });
        var chunks = [];
        doc.on('data', function (c) { chunks.push(c); });
        doc.on('end', function () { resolve(Buffer.concat(chunks)); });
        doc.on('error', reject);

        var left = doc.page.margins.left;
        var pageW = doc.page.width - left - doc.page.margins.right;

        // ---------- shared helpers (see utils/releasePdf.js for the originals) ----------
        function label(x, y, w, s) {
          doc.font('Helvetica').fontSize(6.5).fillColor(LABEL)
             .text(String(s || '').toUpperCase(), x, y, { width: w, characterSpacing: 0.6 });
        }
        function field(x, y, w, cap, value) {
          label(x, y, w, cap);
          var by = y + 9;
          doc.save().rect(x, by, w, 15).fill(FIELD_BG).restore();
          doc.font('Helvetica').fontSize(9).fillColor(INK)
             .text(txt(value), x + 4, by + 4, { width: w - 8, height: 11, ellipsis: true, lineBreak: false });
          return by + 15;
        }
        function cols(n, gap) {
          gap = gap == null ? 8 : gap;
          var w = (pageW - gap * (n - 1)) / n;
          var xs = [];
          for (var i = 0; i < n; i++) xs.push({ x: left + i * (w + gap), w: w });
          return xs;
        }
        function sectionHead(y, s) {
          doc.save().circle(left + 3, y + 5, 3).fill(ORANGE).restore();
          doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
             .text(String(s).toUpperCase(), left + 12, y, { width: pageW - 12, characterSpacing: 0.4 });
          return y + 15;
        }
        // A tinted, height-growing narrative box - never truncates text.
        function narrativeBox(y, text) {
          var body = txt(text) || '-';
          doc.font('Helvetica').fontSize(9.5);
          var h = Math.max(15, doc.heightOfString(body, { width: pageW - 16 }) + 10);
          doc.save().rect(left, y, pageW, h).fill(FIELD_BG).restore();
          doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(body, left + 8, y + 5, { width: pageW - 16, lineGap: 1 });
          return y + h;
        }
        function sigSlot(x, y, w, cap, imgBuf, typedFallback) {
          label(x, y, w, cap);
          var lineY = y + 9 + 26;
          if (imgBuf) {
            try { doc.image(imgBuf, x + 4, y + 10, { fit: [w - 12, 24], align: 'left', valign: 'bottom' }); }
            catch (e) { imgBuf = null; }
          }
          if (!imgBuf && typedFallback) {
            doc.font('Helvetica-Oblique').fontSize(14).fillColor(INK)
               .text(txt(typedFallback), x + 4, y + 18, { width: w - 12, lineBreak: false, ellipsis: true });
          }
          doc.save().moveTo(x, lineY).lineTo(x + w, lineY).lineWidth(0.8).stroke(RULE).restore();
          return lineY + 3;
        }

        // ================================================================
        // PAGE 1 - the notice
        // ================================================================
        var y = 34;
        var logoW = 118;
        var barW = pageW - logoW;
        doc.save().rect(left, y, barW, 62).fill(BAR).restore();
        doc.save().rect(left + barW, y, logoW, 62).fill(ORANGE).restore();
        doc.font('Helvetica').fontSize(6.5).fillColor('#9a9a9a')
           .text('COMPANY FORM', left + 14, y + 12, { width: barW - 28, characterSpacing: 1.4 });
        doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff')
           .text('Disciplinary Action Report', left + 14, y + 25, { width: barW - 28 });
        var placed = false;
        if (logoBuf) {
          try { doc.image(logoBuf, left + barW + 9, y + 14, { fit: [logoW - 18, 34] }); placed = true; } catch (e) {}
        }
        if (!placed) {
          doc.font('Helvetica-BoldOblique').fontSize(13).fillColor('#ffffff')
             .text('Pop-A-Lock', left + barW, y + 22, { width: logoW, align: 'center', lineBreak: false });
          doc.font('Helvetica').fontSize(5.5).fillColor('#ffffff')
             .text('LOCKSMITH', left + barW, y + 38, { width: logoW, align: 'center', characterSpacing: 2.2, lineBreak: false });
        }
        y += 62;

        // ---------- meta strip ----------
        doc.save().rect(left, y, pageW, 17).fill(GREY_BAR).restore();
        function metaCell(x, cap, value, w) {
          doc.font('Helvetica').fontSize(7).fillColor('#a8a8a8')
             .text(cap, x, y + 5.5, { width: 52, lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff')
             .text(value, x + 44, y + 5, { width: w, lineBreak: false, ellipsis: true });
        }
        metaCell(left + 12, 'Document:', txt(rec.level_label) || 'Disciplinary Action', pageW * 0.34);
        metaCell(left + pageW * 0.52, 'Company:', companyName, pageW * 0.28);
        doc.font('Helvetica').fontSize(7).fillColor('#8a8a8a')
           .text('Record #' + recordNumber, left, y + 5.5, { width: pageW - 12, align: 'right', lineBreak: false });
        y += 17 + 14;

        // ---------- employee / incident ----------
        y = sectionHead(y, 'Employee');
        var c3 = cols(3);
        var rowBottom = field(c3[0].x, y, c3[0].w, 'Printed name', employee.name);
        field(c3[1].x, y, c3[1].w, 'Position', employee.title);
        field(c3[2].x, y, c3[2].w, 'Territory', employee.city);
        y = rowBottom + 9;

        rowBottom = field(c3[0].x, y, c3[0].w, 'Date of incident', mdy(rec.occurred_on));
        field(c3[1].x, y, c3[1].w, 'Category', rec.category);
        field(c3[2].x, y, c3[2].w, 'Level', (rec.level ? rec.level + ' of 5 · ' : '') + txt(rec.level_label));
        y = rowBottom + 13;

        // ---------- description ----------
        y = sectionHead(y, 'Description of incident');
        y = narrativeBox(y, rec.body) + 12;
        if (rec.sop_label) {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor(LABEL)
             .text('Policy cited: ' + txt(rec.sop_label), left, y, { width: pageW });
          y = doc.y + 10;
        }

        // ---------- corrective action / consequence ----------
        y = sectionHead(y, 'Corrective action required');
        y = narrativeBox(y, rec.corrective_action) + 12;

        y = sectionHead(y, 'Consequence of further occurrence');
        y = narrativeBox(y, rec.consequence) + 14;

        // ---------- progressive discipline strip ----------
        if ((rec.ladder || []).length) {
          y = sectionHead(y, 'Progressive discipline on file');
          var stepW = (pageW - 4 * 4) / 5;
          var byLevel = {};
          (rec.ladder || []).forEach(function (p) { byLevel[p.level] = p; });
          for (var i = 0; i < LEVELS.length; i++) {
            var lv = LEVELS[i];
            var x = left + i * (stepW + 4);
            var p = byLevel[lv.n];
            var isCurrent = rec.level === lv.n;
            var bg = isCurrent ? ORANGE : (p ? '#fdece3' : '#f2f2f2');
            var fg = isCurrent ? '#ffffff' : (p ? '#c1440e' : '#aaaaaa');
            doc.save().rect(x, y, stepW, 26).fill(bg).restore();
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor(fg)
               .text(lv.short.toUpperCase(), x, y + 6, { width: stepW, align: 'center' });
            doc.font('Helvetica').fontSize(6.5).fillColor(fg)
               .text(p ? mdy(p.occurred_on) : '-', x, y + 16, { width: stepW, align: 'center' });
          }
          y += 26 + 14;
        }

        // ---------- issued / approved ----------
        y = sectionHead(y, 'Issued by');
        var c2 = cols(2);
        rowBottom = field(c2[0].x, y, c2[0].w, 'Printed name', rec.created_by_name);
        field(c2[1].x, y, c2[1].w, 'Date issued', mdy(rec.submitted_at || rec.created_at));
        y = rowBottom + 9;
        if (rec.approver_name) {
          y = field(left, y, pageW, 'Approved by (HR)', rec.approver_name + (rec.approved_at ? '  ·  approved ' + mdy(rec.approved_at) : '')) + 13;
        } else {
          y += 4;
        }

        // ---------- acknowledgment ----------
        y = sectionHead(y, 'Employee acknowledgment');
        if (rec.status === 'refused') {
          doc.font('Helvetica').fontSize(9).fillColor(INK)
             .text('The employee declined to sign this notice.', left, y, { width: pageW });
          y = doc.y + 6;
          rowBottom = field(c2[0].x, y, c2[0].w, 'Recorded by', rec.refusal_by_name);
          field(c2[1].x, y, c2[1].w, 'Date', mdy(rec.refused_at));
          y = rowBottom + 8;
          if (rec.refusal_note) y = narrativeBox(y, rec.refusal_note) + 6;
        } else {
          doc.font('Helvetica').fontSize(8.5).fillColor('#333333')
             .text('My signature confirms receipt of this notice. It does not necessarily indicate agreement with its contents.',
                   left, y, { width: pageW });
          y = doc.y + 8;
          var sigCols = [{ x: left, w: pageW * 0.58 }, { x: left + pageW * 0.58 + 10, w: pageW * 0.42 - 10 }];
          var sigBottom = sigSlot(sigCols[0].x, y, sigCols[0].w, 'Signature', opts.signatureImage, rec.signature_name);
          field(sigCols[1].x, y, sigCols[1].w, 'Date signed', stamp(rec.signed_at));
          y = sigBottom + 6;
        }

        if (rec.employee_response) {
          doc.save().rect(left, y, 3, doc.heightOfString(rec.employee_response, { width: pageW - 24 }) + 14).fill(ORANGE).restore();
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#7a3a1a')
             .text('Employee response on file: "' + txt(rec.employee_response) + '"' +
                   (rec.employee_response_at ? '  -  recorded ' + mdy(rec.employee_response_at) : ''),
                   left + 12, y + 6, { width: pageW - 24 });
          y = doc.y + 12;
        }

        // ---------- footer ----------
        var footY = doc.page.height - doc.page.margins.bottom - 18;
        doc.save().rect(left, footY, pageW, 18).fill(ORANGE).restore();
        doc.font('Helvetica').fontSize(7.5).fillColor('#ffffff')
           .text(companyName + '  ·  Disciplinary Action Report  ·  CONFIDENTIAL PERSONNEL RECORD',
                 left + 12, footY + 6, { width: pageW - 24 });

        // ================================================================
        // PAGE 2 - Certificate of Documentation (audit trail)
        // ================================================================
        doc.addPage();
        var cy = 44;
        doc.font('Helvetica-Bold').fontSize(19).fillColor(INK)
           .text('Certificate of Documentation', left, cy, { width: pageW });
        cy = doc.y + 3;
        doc.font('Helvetica').fontSize(9).fillColor(LABEL)
           .text('Audit trail for Record #' + recordNumber + ' - generated automatically by Nova at export time.',
                 left, cy, { width: pageW });
        cy = doc.y + 16;

        var metaRows = [
          ['Document', txt(rec.level_label) + ' - ' + recordNumber],
          ['Employee', txt(employee.name)],
          ['Issued by', txt(rec.created_by_name)],
          ['Approved by', rec.approver_name ? txt(rec.approver_name) : 'Not required'],
          ['Status', txt(rec.status).replace(/_/g, ' ')],
          ['Exported for external use', stamp(opts.exportedAt) + (opts.exportedBy && opts.exportedBy.name ? ' by ' + opts.exportedBy.name : '')]
        ];
        var metaH = metaRows.length * 12 + 14;
        doc.save().rect(left, cy, pageW, metaH).lineWidth(0.8).stroke('#cccccc').restore();
        var ry = cy + 8;
        for (var m = 0; m < metaRows.length; m++) {
          doc.font('Helvetica').fontSize(8).fillColor(LABEL).text(metaRows[m][0], left + 10, ry, { width: 160 });
          doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(metaRows[m][1], left + 175, ry, { width: pageW - 185 });
          ry += 12;
        }
        cy += metaH + 18;

        doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('History', left, cy, { width: pageW });
        cy = doc.y + 8;

        if (!events.length) {
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(LABEL)
             .text('No recorded events for this notice.', left + 12, cy, { width: pageW - 12 });
          cy = doc.y + 10;
        }
        for (var e = 0; e < events.length; e++) {
          var ev = events[e] || {};
          if (cy > doc.page.height - 90) { doc.addPage(); cy = 44; }
          doc.save().circle(left + 3, cy + 4, 2.5).fill(ORANGE).restore();
          var head = eventLabel(ev.action);
          if (ev.user_name) head += ' - ' + txt(ev.user_name);
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
             .text(head, left + 12, cy, { width: pageW - 12 });
          cy = doc.y + 1;
          var meta = stamp(ev.created_at);
          if (ev.note) meta += '  ·  ' + txt(ev.note).slice(0, 140);
          doc.font('Helvetica').fontSize(7).fillColor(LABEL)
             .text(meta, left + 12, cy, { width: pageW - 12 });
          cy = doc.y + 7;
        }

        cy += 6;
        if (cy > doc.page.height - 110) { doc.addPage(); cy = 44; }
        doc.save().moveTo(left, cy).lineTo(left + pageW, cy).dash(2, { space: 2 }).lineWidth(0.6).stroke('#cccccc').undash().restore();
        cy += 12;
        doc.font('Helvetica').fontSize(8).fillColor('#666666').text(
          'This certificate is generated automatically from every action Nova recorded for this document, ' +
          'and cannot be edited. It is intended to accompany the signed notice when this record is shared outside ' +
          'the company - for an unemployment hearing, an attorney, or a regulatory request - as evidence that the ' +
          'employee was notified and given the opportunity to respond before signing.',
          left, cy, { width: pageW, lineGap: 1.5 }
        );

        doc.font('Helvetica').fontSize(7).fillColor(LABEL)
           .text(companyName + ' - Confidential Personnel Record  ·  Certificate ID: CERT-' + recordNumber,
                 left, doc.page.height - doc.page.margins.bottom - 14, { width: pageW });

        doc.end();
      } catch (err) { reject(err); }
    });
  });
}

module.exports = { buildDisciplinaryPdf: buildDisciplinaryPdf };
