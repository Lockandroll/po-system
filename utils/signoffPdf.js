// Builds a PDF of a completed sign-off sheet for emailing. Pure pdfkit, no
// browser. Mirrors the in-app "Print / Save as PDF" layout (printSignoff):
// black title bar, logo + Corporate Office block + PO/Invoice boxes, a bordered
// grid form, a description box, and photos on following pages.
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
var PDFDocument = require('pdfkit');
var https = require('https');
var http = require('http');

var DEFAULT_LOGO = 'https://www.popalock.com/wp-content/uploads/2020/11/pal-logo-highres.png';

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

// Normalize escaped newlines (data may arrive JSON-escaped as literal "\n").
function normText(s) {
  if (s == null) return '';
  return String(s).replace(/\\r\\n|\\r|\\n/g, '\n');
}

// form: signoff_forms row (plus completed_by_name). photos: [{image_data, caption}].
// opts: { company:{name,address,csz,phone}, completedBy, logo }
function buildSignoffPdf(form, photos, opts) {
  form = form || {};
  photos = photos || [];
  opts = opts || {};
  var company = opts.company || {};
  var logoUrl = opts.logo || company.logo || DEFAULT_LOGO;

  return fetchImageBuffer(logoUrl).then(function (logoBuf) {
    return new Promise(function (resolve, reject) {
      try {
        var doc = new PDFDocument({ size: 'LETTER', margin: 40 });
        var chunks = [];
        doc.on('data', function (c) { chunks.push(c); });
        doc.on('end', function () { resolve(Buffer.concat(chunks)); });
        doc.on('error', reject);

        var left = doc.page.margins.left;
        var pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        var BLACK = '#000000';

        function W(pctVal) { return pageW * pctVal / 100; }

        // ---------- Title bar ----------
        var y = doc.y;
        doc.save().rect(left, y, pageW, 26).fill(BLACK).restore();
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(14)
           .text('Work Order Sign Off Sheet', left, y + 7, { width: pageW, align: 'center' });
        doc.fillColor(BLACK);
        y += 26;

        // ---------- Header: logo | company | PO/Invoice ----------
        var hTop = y + 12;
        var col1W = pageW * 0.26;
        var col2W = pageW * 0.40;
        var col3W = pageW - col1W - col2W;
        var col1X = left;
        var col2X = left + col1W;
        var col3X = left + col1W + col2W;

        if (logoBuf) {
          try { doc.image(logoBuf, col1X + 4, hTop + 6, { fit: [col1W - 12, 66] }); } catch (e) {}
        }

        // Company block (centered)
        doc.fillColor(BLACK).font('Helvetica').fontSize(10);
        doc.text('Corporate Office:', col2X, hTop, { width: col2W, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(11).text(company.name || 'Lock And Roll, LLC', col2X, doc.y + 1, { width: col2W, align: 'center' });
        doc.font('Helvetica').fontSize(10);
        if (company.address) doc.text(company.address, col2X, doc.y + 1, { width: col2W, align: 'center' });
        if (company.csz) doc.text(company.csz, col2X, doc.y + 1, { width: col2W, align: 'center' });
        if (company.phone) doc.text(company.phone, col2X, doc.y + 1, { width: col2W, align: 'center' });
        var companyBottom = doc.y;

        // PO / Invoice number boxes (right)
        function labeledLine(labelText, valText, topY, labelW) {
          doc.font('Helvetica').fontSize(11).fillColor(BLACK);
          doc.text(labelText, col3X, topY, { width: labelW });
          var lx = col3X + labelW + 2;
          var lineY = topY + 14;
          doc.moveTo(lx, lineY).lineTo(col3X + col3W - 2, lineY).lineWidth(1).stroke(BLACK);
          doc.text(valText || '', lx + 2, topY, { width: (col3X + col3W - 2) - (lx + 2), align: 'center' });
        }
        labeledLine('PO Number:', String(form.po_number || ''), hTop + 8, 62);
        labeledLine('Invoice Number:', String(form.invoice_number || ''), hTop + 46, 82);

        // ---------- Grid ----------
        var gridTop = Math.max(companyBottom, hTop + 92) + 14;
        var cy = gridTop;
        var RH = 30;

        // Draw a single grid row. cells: [{ w, label?, text?, render? }]
        // Last cell auto-fills remaining width.
        function drawRow(h, cells) {
          var x = left;
          var used = 0;
          for (var i = 0; i < cells.length; i++) {
            var c = cells[i];
            var w = (i === cells.length - 1) ? (pageW - used) : c.w;
            used += w;
            if (i < cells.length - 1) {
              doc.moveTo(x + w, cy).lineTo(x + w, cy + h).lineWidth(0.8).stroke(BLACK);
            }
            if (c.label) {
              doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BLACK);
              var lh = doc.heightOfString(c.text, { width: w - 8, align: 'center' });
              doc.text(c.text, x + 4, cy + Math.max(3, (h - lh) / 2), { width: w - 8, align: 'center' });
            } else if (typeof c.render === 'function') {
              c.render(x, cy, w, h);
            } else {
              doc.font('Helvetica').fontSize(10).fillColor(BLACK);
              var tv = (c.text == null) ? '' : String(c.text);
              var vh = doc.heightOfString(tv || ' ', { width: w - 12 });
              doc.text(tv, x + 6, cy + Math.max(3, (h - vh) / 2), { width: w - 12 });
            }
            x += w;
          }
          doc.moveTo(left, cy + h).lineTo(left + pageW, cy + h).lineWidth(0.8).stroke(BLACK);
          cy += h;
        }

        function checkbox(cx, cyc, on, label) {
          var s = 12;
          doc.lineWidth(1).rect(cx, cyc - s / 2, s, s).stroke(BLACK);
          if (on) { doc.font('Helvetica-Bold').fontSize(11).fillColor(BLACK).text('X', cx + 2.5, cyc - 6.5); }
          doc.font('Helvetica').fontSize(10).fillColor(BLACK).text(label, cx + s + 5, cyc - 6);
        }

        var sigBuf = form.signature_data ? bufFromDataUrl(form.signature_data) : null;

        drawRow(RH, [ { label: true, w: W(15), text: 'Account:' }, { text: form.account } ]);
        drawRow(RH, [ { label: true, w: W(15), text: 'Store Name:' }, { w: W(45), text: form.store_name }, { label: true, w: W(15), text: 'Store Number:' }, { text: form.store_number } ]);
        drawRow(RH, [ { label: true, w: W(15), text: 'Address:' }, { text: form.address } ]);
        drawRow(RH, [ { label: true, w: W(15), text: 'City / State / Zip:' }, { text: form.city_state_zip } ]);
        drawRow(RH, [ { label: true, w: W(33), text: 'Date and Time Service Requested By:' }, { text: form.service_requested_by } ]);
        drawRow(RH, [ { label: true, w: W(19.5), text: 'Start Time and Date:' }, { w: W(26), text: form.start_time }, { label: true, w: W(18), text: 'End Time and Date:' }, { text: form.end_time } ]);
        drawRow(RH, [
          { label: true, w: W(25), text: 'Is This Work 100% Complete?' },
          { w: W(24), render: function (x, ry, w, h) {
              var cyc = ry + h / 2;
              checkbox(x + w * 0.14, cyc, form.work_complete === true, 'Yes');
              checkbox(x + w * 0.56, cyc, form.work_complete === false, 'No');
            } },
          { label: true, w: W(20), text: 'Number of Technicians' },
          { text: form.num_technicians != null ? String(form.num_technicians) : '' }
        ]);
        drawRow(RH, [ { label: true, w: W(25), text: 'Manager Name (Printed):' }, { text: form.manager_name } ]);
        drawRow(52, [
          { label: true, w: W(25), text: 'Manager Signature:' },
          { render: function (x, ry, w, h) {
              if (sigBuf) { try { doc.image(sigBuf, x + 8, ry + 5, { fit: [w - 16, h - 12] }); } catch (e) {} }
            } }
        ]);
        drawRow(RH, [ { label: true, w: W(25), text: 'Technician Name(s):' }, { text: form.technician_names } ]);

        // Description box (full width, height grows with content, min 130)
        var descText = normText(form.work_description);
        var descLabelH = 16;
        doc.font('Helvetica').fontSize(10);
        var descBodyH = doc.heightOfString(descText || ' ', { width: pageW - 16, lineGap: 2 });
        var descH = Math.max(130, descLabelH + descBodyH + 16);
        // Page-break guard.
        if (cy + descH > doc.page.height - doc.page.margins.bottom) {
          // Close the current outer border before breaking.
          doc.lineWidth(1.5).rect(left, gridTop, pageW, cy - gridTop).stroke(BLACK);
          doc.addPage();
          cy = doc.y;
          gridTop = cy;
        }
        doc.font('Helvetica-Bold').fontSize(10).fillColor(BLACK)
           .text('Description of Work Done / Cause of Damage:', left + 6, cy + 6, { width: pageW - 12 });
        doc.font('Helvetica').fontSize(10).fillColor(BLACK)
           .text(descText, left + 6, cy + 6 + descLabelH, { width: pageW - 12, lineGap: 2 });
        cy += descH;

        // Outer border around the whole grid.
        doc.lineWidth(1.5).rect(left, gridTop, pageW, cy - gridTop).stroke(BLACK);

        // ---------- Footer ----------
        var footParts = [];
        if (form.form_number) footParts.push(String(form.form_number));
        if (form.completed_at) footParts.push('Completed ' + new Date(form.completed_at).toLocaleString('en-US'));
        var by = opts.completedBy || form.completed_by_name;
        if (by) footParts.push('by ' + by);
        if (footParts.length) {
          doc.font('Helvetica').fontSize(8).fillColor('#999999')
             .text(footParts.join('  ·  '), left, cy + 8, { width: pageW, align: 'right' });
          doc.fillColor(BLACK);
        }

        // ---------- Photos ----------
        var validPhotos = photos.filter(function (p) { return p && (typeof p === 'string' ? p : p.image_data); });
        if (validPhotos.length) {
          doc.addPage();
          doc.font('Helvetica-Bold').fontSize(13).fillColor(BLACK).text('Photos');
          doc.moveDown(0.4);
          validPhotos.forEach(function (p, idx) {
            var img = bufFromDataUrl(typeof p === 'string' ? p : p.image_data);
            if (!img) return;
            var cap = (typeof p === 'object' && p.caption) ? String(p.caption) : ('Picture ' + (idx + 1));
            if (doc.y > doc.page.height - doc.page.margins.bottom - 240) doc.addPage();
            doc.font('Helvetica-Bold').fontSize(10).fillColor(BLACK).text(cap);
            doc.moveDown(0.2);
            try { doc.image(img, { fit: [pageW, 320] }); } catch (e) {}
            doc.moveDown(0.8);
          });
        }

        doc.end();
      } catch (e) { reject(e); }
    });
  });
}

module.exports = { buildSignoffPdf: buildSignoffPdf };
