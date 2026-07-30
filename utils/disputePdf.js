// Builds a Square / card-network DISPUTE EVIDENCE PACKET for a single invoice.
// Pure pdfkit, no browser. IMPORTANT: never use backticks/template literals in
// this file (Windows corrupts backticks in .js files); string concatenation only.
//
// Maps the evidence Square accepts onto the data Nova already captures:
//   - cardholder name, billing address, email, phone      (key evidence)
//   - signed authorization (agreement + signature + time)  (signed authorization form)
//   - timestamped, itemized proof of service delivery      (supporting evidence)
//   - government photo ID verified on site                 (identity evidence)
//   - payment reference: approval code + card last 4 only  (never full PAN / CVV)
// It deliberately contains NO full card number and NO CVV, per Square's upload rules,
// and no video/audio (which Square does not accept).
var PDFDocument = require('pdfkit');

function bufFromDataUrl(s) {
  if (!s) return null;
  var str = String(s);
  var idx = str.indexOf('base64,');
  if (idx === -1) return null;
  try { return Buffer.from(str.slice(idx + 7), 'base64'); } catch (e) { return null; }
}

function money(n) {
  var v = parseFloat(n);
  if (isNaN(v)) v = 0;
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtDate(d) {
  if (!d) return '';
  var s = (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  var dt = m ? new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '';
  var dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtTime(t) {
  if (!t) return '';
  var s = String(t);
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  var h = parseInt(m[1], 10); var min = m[2];
  var ap = h >= 12 ? 'PM' : 'AM'; var h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ':' + min + ' ' + ap;
}

function vehicleStr(inv) {
  return [inv.vehicle_year, inv.vehicle_make, inv.vehicle_model].filter(Boolean).join(' ');
}

// inv: invoice row. items: line_items rows. evidence: { idImage: Buffer|null, idMime,
// idUploadedAt, photos: [{ buffer, caption, created_at }] }. opts: { company }.
function buildDisputePdf(inv, items, evidence, opts) {
  return new Promise(function (resolve, reject) {
    try {
      inv = inv || {};
      items = items || [];
      evidence = evidence || {};
      opts = opts || {};
      var company = opts.company || {};
      var photos = (evidence.photos || []).filter(function (p) { return p && p.buffer; });

      var doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
      var chunks = [];
      doc.on('data', function (c) { chunks.push(c); });
      doc.on('end', function () { resolve(Buffer.concat(chunks)); });
      doc.on('error', reject);

      var left = doc.page.margins.left;
      var pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      var right = left + pageW;
      var bottom = function () { return doc.page.height - doc.page.margins.bottom; };

      function ensureRoom(h) {
        if (doc.y + h > bottom()) { doc.addPage(); doc.y = doc.page.margins.top; }
      }
      function hr(color) {
        doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(1).strokeColor(color || '#dddddd').stroke();
        doc.y += 8;
      }
      function sectionHeader(text) {
        ensureRoom(34);
        doc.y += 6;
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(String(text).toUpperCase(), left, doc.y);
        doc.y += 2;
        hr('#cccccc');
      }
      // Two-column label / value row.
      function labelVal(label, val) {
        var v = (val == null || val === '') ? '—' : String(val);
        var labW = 150;
        var valW = pageW - labW;
        var vh = doc.font('Helvetica').fontSize(10).heightOfString(v, { width: valW });
        var rowH = Math.max(vh, 12);
        ensureRoom(rowH + 4);
        var y0 = doc.y;
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555').text(String(label), left, y0 + 1, { width: labW - 8 });
        doc.font('Helvetica').fontSize(10).fillColor('#111111').text(v, left + labW, y0, { width: valW });
        doc.y = y0 + rowH + 4;
      }
      function para(text, color, size) {
        var t = String(text || '');
        if (!t) return;
        var h = doc.font('Helvetica').fontSize(size || 10).heightOfString(t, { width: pageW });
        ensureRoom(h + 4);
        doc.font('Helvetica').fontSize(size || 10).fillColor(color || '#222222').text(t, left, doc.y, { width: pageW });
        doc.y += 4;
      }
      function bullet(text) {
        var t = '•  ' + String(text || '');
        var h = doc.font('Helvetica').fontSize(10).heightOfString(t, { width: pageW - 10 });
        ensureRoom(h + 3);
        doc.font('Helvetica').fontSize(10).fillColor('#222222').text(t, left + 4, doc.y, { width: pageW - 10 });
        doc.y += 3;
      }
      function drawImage(buf, maxH) {
        if (!buf) return false;
        try {
          var img = doc.openImage(buf);
          var maxW = pageW;
          var mh = maxH || 300;
          var scale = Math.min(maxW / img.width, mh / img.height, 1);
          var w = img.width * scale;
          var h = img.height * scale;
          ensureRoom(h + 6);
          doc.image(buf, left, doc.y, { width: w, height: h });
          doc.y += h + 6;
          return true;
        } catch (e) {
          para('[An image could not be embedded (unsupported format). Original is on file in Nova.]', '#999999', 9);
          return false;
        }
      }

      var invNo = inv.invoice_number != null ? String(inv.invoice_number) : '';
      var custName = inv.customer_name || '';
      var billing = [inv.street_address, inv.city, inv.state, inv.zip].filter(Boolean).join(', ');
      var last4 = inv.card_last4 ? ('**** **** **** ' + String(inv.card_last4)) : '';
      var payLine = [inv.pay_type, last4].filter(Boolean).join('  •  ');
      var hasSig = !!bufFromDataUrl(inv.signature_image);
      var hasId = !!evidence.idImage;

      // ---------------------------- Header ----------------------------------
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111').text('Dispute Evidence Packet', left, doc.y);
      doc.font('Helvetica').fontSize(10).fillColor('#666666').text((company.name || 'Lock and Roll LLC') + (company.phone ? ('  •  ' + company.phone) : ''), left, doc.y + 2);
      doc.y += 6;
      hr('#111111');
      labelVal('Invoice #', invNo);
      labelVal('Invoice date', fmtDate(inv.invoice_date || inv.created_at));
      labelVal('Amount charged', money(inv.grand_total));
      if (payLine) labelVal('Payment', payLine);
      if (inv.approval_code) labelVal('Approval / auth code', inv.approval_code);
      labelVal('Packet prepared', fmtDateTime(new Date()));

      // ----------------------- Evidence checklist ---------------------------
      sectionHeader('Evidence included in this packet');
      para('The items below map to the evidence card networks accept for a chargeback response. This document contains no full card number and no CVV, and no video or audio.', '#555555', 9);
      doc.y += 2;
      function check(ok, text) { bullet((ok ? '[x] ' : '[ ] ') + text); }
      check(!!custName || !!billing, 'Cardholder name, billing address, email and phone');
      check(hasSig, 'Signed service authorization (customer signature + agreement + timestamp)');
      check(items.length > 0, 'Itemized description of the goods / services provided');
      check(true, 'Timestamped, dated proof of service delivery');
      check(hasId, 'Government photo ID verified on site (driver license image)');
      check(!!(inv.approval_code || inv.card_last4), 'Payment reference (approval code and card last 4)');
      check(photos.length > 0, photos.length + ' work photo(s) from the job as supporting evidence');

      // -------------------- Merchant account of what happened ---------------
      sectionHeader('Merchant account of what happened');
      var svcList = items.filter(function (it) { return it && it.description; }).map(function (it) { return it.description; });
      var whatFor = svcList.length
        ? ('This charge was for on-site locksmith services performed by ' + (company.name || 'Lock and Roll LLC') + ': ' + svcList.join('; ') + '.')
        : ('This charge was for on-site locksmith services performed by ' + (company.name || 'Lock and Roll LLC') + '.');
      var veh = vehicleStr(inv);
      if (veh) whatFor += ' Work was performed on the customer’s vehicle (' + veh + (inv.vin ? (', VIN ' + inv.vin) : '') + ').';
      para(whatFor);

      var when = 'The service was delivered in person on ' + fmtDate(inv.invoice_date || inv.created_at);
      if (inv.time_in || inv.time_out) {
        when += ' (' + [fmtTime(inv.time_in), fmtTime(inv.time_out)].filter(Boolean).join(' to ') + ')';
      }
      when += ', on the date agreed with the customer. This was a same-day field service, not a shipped good.';
      para(when);

      var idContext = '';
      if (custName) idContext += 'The charge was authorized in person by ' + custName + '. ';
      if (inv.dl_number || hasId) {
        idContext += 'The customer presented a valid ' + (inv.dl_state ? (inv.dl_state + ' ') : '') + 'government-issued photo ID';
        idContext += inv.dl_number ? (' (driver license #' + inv.dl_number + ')') : '';
        idContext += hasId ? ', which was scanned on site and is included below. ' : ', recorded on the invoice. ';
      }
      if (hasSig) {
        idContext += 'The customer signed the service authorization' + (inv.signed_at ? (' on ' + fmtDateTime(inv.signed_at)) : '') + ', agreeing to the work and the total shown. ';
      }
      if (idContext) para(idContext);
      para('For these reasons the charge is valid and was authorized by the cardholder. We respectfully request that the dispute be resolved in the merchant’s favor.');

      // ----------------------- Cardholder & payment -------------------------
      sectionHeader('Cardholder and payment');
      labelVal('Cardholder / customer', custName);
      labelVal('Billing address', billing);
      labelVal('Email', inv.email);
      labelVal('Phone', inv.phone);
      labelVal('Pay type', inv.pay_type);
      if (inv.card_last4) labelVal('Card (last 4 only)', '**** **** **** ' + String(inv.card_last4));
      if (inv.approval_code) labelVal('Approval / auth code', inv.approval_code);
      labelVal('Served by (technician)', inv.locksmith_name || inv.locksmith_name_join);

      // --------------------------- Government ID ----------------------------
      sectionHeader('Government photo ID verified on site');
      if (hasId) {
        labelVal('Driver license #', inv.dl_number);
        labelVal('Issuing state', inv.dl_state);
        if (evidence.idUploadedAt) labelVal('Captured', fmtDateTime(evidence.idUploadedAt));
        para('The government-issued photo ID the customer presented at the time of service:', '#555555', 9);
        drawImage(evidence.idImage, 330);
      } else {
        labelVal('Driver license #', inv.dl_number);
        labelVal('Issuing state', inv.dl_state);
        para('No ID photo was captured for this invoice. (Driver license details above were recorded on the invoice; scanning the ID on future jobs strengthens the identity evidence.)', '#999999', 9);
      }

      // ------------------------ Signed authorization ------------------------
      sectionHeader('Signed authorization');
      var agreement = String(inv.agreement_text || '').split('{customer}').join(custName || '__________');
      if (agreement) { para(agreement, '#333333', 9); }
      if (hasSig) {
        para('Customer signature:', '#555555', 9);
        drawImage(bufFromDataUrl(inv.signature_image), 120);
        labelVal('Signed by', inv.signed_name || custName);
        if (inv.signed_at) labelVal('Signed at', fmtDateTime(inv.signed_at));
      } else {
        para('No captured signature is on file for this invoice.', '#999999', 9);
      }

      // -------------------------- Proof of service --------------------------
      sectionHeader('Proof of service delivery');
      labelVal('Service date', fmtDate(inv.invoice_date || inv.created_at));
      if (inv.time_in || inv.time_out) labelVal('On site', [fmtTime(inv.time_in), fmtTime(inv.time_out)].filter(Boolean).join(' to '));
      labelVal('Status', inv.status ? (String(inv.status).charAt(0).toUpperCase() + String(inv.status).slice(1)) : '');
      if (veh) labelVal('Vehicle', veh + (inv.license_tag ? ('  •  Tag ' + inv.license_tag + (inv.tag_state ? (' (' + inv.tag_state + ')') : '')) : ''));

      // Line items table.
      doc.y += 6;
      ensureRoom(26);
      var cDesc = left, cQty = left + pageW - 200, cPrice = left + pageW - 130, cExt = left + pageW - 60;
      var hy = doc.y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555');
      doc.text('Description', cDesc, hy, { width: cQty - cDesc - 6 });
      doc.text('Qty', cQty, hy, { width: 40 });
      doc.text('Unit', cPrice, hy, { width: 60 });
      doc.text('Amount', cExt, hy, { width: 60, align: 'right' });
      doc.y = hy + 14;
      hr('#dddddd');
      items.forEach(function (it) {
        if (!it || !it.description) return;
        var qty = (parseFloat(it.quantity) || 0);
        var unit = (parseFloat(it.unit_price) || 0);
        var ext = qty * unit;
        var desc = (it.line_type === 'labor' ? 'Labor: ' : '') + String(it.description) + (it.item_number ? ('  (#' + it.item_number + ')') : '');
        var dh = doc.font('Helvetica').fontSize(9).heightOfString(desc, { width: cQty - cDesc - 6 });
        var rowH = Math.max(dh, 12);
        ensureRoom(rowH + 3);
        var y0 = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor('#111111');
        doc.text(desc, cDesc, y0, { width: cQty - cDesc - 6 });
        doc.text(String(qty), cQty, y0, { width: 40 });
        doc.text(money(unit), cPrice, y0, { width: 60 });
        doc.text(money(ext), cExt, y0, { width: 60, align: 'right' });
        doc.y = y0 + rowH + 3;
      });
      hr('#dddddd');
      var totY = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111');
      doc.text('Total charged', cPrice - 40, totY, { width: 100 });
      doc.text(money(inv.grand_total), cExt, totY, { width: 60, align: 'right' });
      doc.y = totY + 16;

      // Refunds already issued. Square weighs a documented partial refund heavily:
      // it shows the merchant tried to make the cardholder whole before the dispute.
      var refunds = (evidence.refunds || []).filter(function (r) { return r && ['approved', 'processed'].indexOf(r.status) !== -1; });
      if (refunds.length) {
        sectionHeader('Refunds already issued');
        para('These refunds were issued against this invoice before the dispute, and are recorded in Nova with who approved them and the payment processor reference.', '#555555', 9);
        var refTotal = 0;
        refunds.forEach(function (r) {
          refTotal += (parseFloat(r.amount) || 0);
          bullet(money(r.amount) + ' on ' + fmtDate(r.refund_date || r.processed_at || r.approved_at) +
            ' — ' + (r.reason_label || String(r.reason_code || 'refund').split('_').join(' ')) +
            (r.approved_by_name ? ('; approved by ' + r.approved_by_name) : '') +
            (r.external_ref ? ('; reference ' + r.external_ref) : '; not yet issued'));
          // A line-by-line refund names exactly what was given back, which reads
          // far better as evidence than a bare dollar figure.
          (r.lines || []).forEach(function (l) {
            para('        - ' + (parseFloat(l.quantity) || 0) + ' x ' + String(l.description || '') +
              (l.item_number ? (' (#' + l.item_number + ')') : '') +
              '  ' + money(l.amount) + (l.restock ? '  [returned to stock]' : ''), '#666666', 8);
          });
        });
        labelVal('Total refunded', money(refTotal));
        labelVal('Net retained', money((parseFloat(inv.grand_total) || 0) - refTotal));
      }

      // Work photos.
      if (photos.length) {
        sectionHeader('Work photos (' + photos.length + ')');
        para('Photographs taken at the job, kept in Nova with their upload timestamps.', '#555555', 9);
        photos.forEach(function (p, i) {
          var cap = 'Photo ' + (i + 1) + (p.caption ? (' — ' + p.caption) : '') + (p.created_at ? ('  (' + fmtDateTime(p.created_at) + ')') : '');
          para(cap, '#555555', 9);
          drawImage(p.buffer, 300);
        });
      }

      // Footer on every page. Zero the bottom margin while writing so pdfkit does not
      // paginate (a y below the normal bottom margin would otherwise spawn a blank page).
      var range = doc.bufferedPageRange();
      for (var pi = range.start; pi < range.start + range.count; pi++) {
        try {
          doc.switchToPage(pi);
          var oldBottom = doc.page.margins.bottom;
          doc.page.margins.bottom = 0;
          doc.font('Helvetica').fontSize(8).fillColor('#999999').text(
            'Confidential — ' + (company.name || 'Lock and Roll LLC') + ' dispute evidence for invoice #' + invNo + '. Contains no full card number or CVV.',
            left, doc.page.height - 34, { width: pageW, align: 'center', lineBreak: false }
          );
          doc.page.margins.bottom = oldBottom;
        } catch (e) { /* single page */ }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildDisputePdf: buildDisputePdf };
