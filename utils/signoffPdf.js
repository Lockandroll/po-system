// Builds a PDF of a completed sign-off sheet for emailing. Pure pdfkit, no
// browser. IMPORTANT: never use backticks/template literals in this file
// (Windows corrupts backticks in .js files); string concatenation only.
var PDFDocument = require('pdfkit');

function bufFromDataUrl(s) {
  if (!s) return null;
  var str = String(s);
  var idx = str.indexOf('base64,');
  var b64 = idx !== -1 ? str.slice(idx + 7) : str;
  try { return Buffer.from(b64, 'base64'); } catch (e) { return null; }
}

function fmtTime(t) {
  if (!t) return '';
  var m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(t);
  var h = parseInt(m[1], 10), mn = m[2];
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + mn + ' ' + ap;
}

// form: signoff_forms row (plus completed_by_name). photos: [{image_data, caption}].
// opts: { company:{name,address,csz,phone}, completedBy }
function buildSignoffPdf(form, photos, opts) {
  return new Promise(function (resolve, reject) {
    try {
      form = form || {};
      photos = photos || [];
      opts = opts || {};
      var company = opts.company || {};
      var doc = new PDFDocument({ size: 'LETTER', margin: 50 });
      var chunks = [];
      doc.on('data', function (c) { chunks.push(c); });
      doc.on('end', function () { resolve(Buffer.concat(chunks)); });
      doc.on('error', reject);

      var left = doc.page.margins.left;
      var pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // Title bar
      var top = doc.y;
      doc.save().rect(left, top, pageW, 30).fill('#000').restore();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13)
         .text('WORK ORDER SIGN-OFF SHEET', left, top + 9, { width: pageW, align: 'center' });
      doc.fillColor('#000000');
      doc.y = top + 42;

      // Company line
      doc.font('Helvetica-Bold').fontSize(12).text(company.name || 'Lock And Roll, LLC', left, doc.y, { width: pageW, align: 'center' });
      var compLine = [company.address, company.csz, company.phone].filter(Boolean).join('   |   ');
      if (compLine) { doc.font('Helvetica').fontSize(9).fillColor('#555555').text(compLine, { width: pageW, align: 'center' }); }
      doc.fillColor('#000000').moveDown(1);

      // Details (single column, label + value)
      var rows = [
        ['Form #', form.form_number],
        ['PO #', form.po_number],
        ['Invoice #', form.invoice_number],
        ['Account', form.account],
        ['Store', (form.store_name || '') + (form.store_number ? ' (#' + form.store_number + ')' : '')],
        ['Address', form.address],
        ['City / State / Zip', form.city_state_zip],
        ['Service Requested By', form.service_requested_by],
        ['Start', fmtTime(form.start_time)],
        ['End', fmtTime(form.end_time)],
        ['# Technicians', form.num_technicians != null ? String(form.num_technicians) : ''],
        ['Work 100% Complete', form.work_complete === true ? 'Yes' : (form.work_complete === false ? 'No' : '')],
        ['Technician(s)', form.technician_names],
        ['Completed By', opts.completedBy || form.completed_by_name || '']
      ];
      doc.fontSize(10);
      rows.forEach(function (r) {
        doc.font('Helvetica-Bold').fillColor('#444444').text(r[0] + ': ', { continued: true });
        doc.font('Helvetica').fillColor('#000000').text((r[1] == null || r[1] === '') ? '—' : String(r[1]));
      });

      // Work description
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fillColor('#444444').fontSize(10).text('Description of Work Done / Cause of Damage');
      doc.font('Helvetica').fillColor('#000000').fontSize(10).text(form.work_description ? String(form.work_description) : '—', { width: pageW });

      // Signature
      if (form.signature_data) {
        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').fillColor('#444444').fontSize(10)
           .text('Manager Signature' + (form.manager_name ? ' — ' + form.manager_name : ''));
        var sigBuf = bufFromDataUrl(form.signature_data);
        if (sigBuf) { try { doc.image(sigBuf, { fit: [260, 90] }); } catch (e) {} }
        var stamp = [];
        if (form.signed_at || form.completed_at) stamp.push('Signed ' + new Date(form.signed_at || form.completed_at).toLocaleString('en-US'));
        if (form.gps_lat != null && form.gps_lon != null) {
          stamp.push('GPS ' + Number(form.gps_lat).toFixed(5) + ', ' + Number(form.gps_lon).toFixed(5) + (form.gps_accuracy ? (' (±' + Math.round(form.gps_accuracy) + 'm)') : ''));
        }
        if (stamp.length) { doc.font('Helvetica').fontSize(8).fillColor('#666666').text(stamp.join('   ·   ')); doc.fillColor('#000000'); }
      }

      // Photos on a fresh page
      var validPhotos = photos.filter(function (p) { return p && (typeof p === 'string' ? p : p.image_data); });
      if (validPhotos.length) {
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#000000').text('Photos');
        doc.moveDown(0.4);
        validPhotos.forEach(function (p, idx) {
          var img = bufFromDataUrl(typeof p === 'string' ? p : p.image_data);
          if (!img) return;
          var cap = (typeof p === 'object' && p.caption) ? String(p.caption) : ('Picture ' + (idx + 1));
          if (doc.y > doc.page.height - doc.page.margins.bottom - 230) doc.addPage();
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text(cap);
          doc.moveDown(0.2);
          try { doc.image(img, { fit: [pageW, 320] }); } catch (e) {}
          doc.moveDown(0.8);
        });
      }

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildSignoffPdf: buildSignoffPdf };
