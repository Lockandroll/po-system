// Builds a PDF of an invoice for emailing. Pure pdfkit, no browser.
// IMPORTANT: never use backticks/template literals in this file
// (Windows corrupts backticks in .js files); string concatenation only.
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

function statusLabel(s) {
  return { draft: 'Draft', completed: 'Completed', paid: 'Paid' }[s] || (s ? String(s) : '');
}

// inv: invoice row. items: line_items rows. photos: [{ buffer, caption }] (already
// filtered to those that should print). opts: { company: { name, address, csz, phone, logo } }.
function buildInvoicePdf(inv, items, photos, opts) {
  return new Promise(function (resolve, reject) {
    try {
      inv = inv || {};
      items = items || [];
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
      var right = left + pageW;

      function hr(y, color) {
        doc.save().moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(color || '#dddddd').stroke().restore();
      }

      // ---- Header ----
      var headTop = doc.y;
      var logoBuf = bufFromDataUrl(company.logo);
      if (logoBuf) { try { doc.image(logoBuf, left, headTop, { fit: [180, 46] }); } catch (e) {} }
      else { doc.font('Helvetica-Bold').fontSize(20).fillColor('#f97316').text(company.name || 'Pop-A-Lock', left, headTop); }

      // Right block: INVOICE + number, locksmith, date
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text('INVOICE', left, headTop, { width: pageW, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#f97316').text(String(inv.invoice_number || ''), { width: pageW, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#333333')
        .text('Locksmith: ' + (inv.locksmith_name || inv.locksmith_name_join || ''), { width: pageW, align: 'right' })
        .text('Date: ' + fmtDate(inv.invoice_date || inv.created_at), { width: pageW, align: 'right' });

      // Company address (left, under logo/name)
      var afterHead = Math.max(doc.y, headTop + 52);
      if (company.name && logoBuf) {
        // name already in logo; show address only
      }
      var compLine = [company.address, company.csz, company.phone].filter(Boolean).join('  |  ');
      if (compLine) {
        doc.font('Helvetica').fontSize(9).fillColor('#555555').text(compLine, left, headTop + 50, { width: pageW * 0.6 });
        afterHead = Math.max(afterHead, doc.y);
      }
      doc.y = afterHead + 6;
      doc.save().rect(left, doc.y, pageW, 3).fill('#f97316').restore();
      doc.y += 12;
      doc.fillColor('#111111');

      // ---- Two-column info ----
      function sectionHeader(text, x, w) {
        doc.save().rect(x, doc.y, w, 16).fill('#111111').restore();
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(text, x + 6, doc.y + 4, { width: w - 12 });
        doc.fillColor('#111111');
      }
      function labelVal(x, w, y, label, val) {
        doc.font('Helvetica').fontSize(7).fillColor('#888888').text(String(label).toUpperCase(), x, y, { width: w });
        doc.font('Helvetica').fontSize(10).fillColor('#111111').text((val == null || val === '') ? '—' : String(val), x, doc.y, { width: w });
        return doc.y;
      }

      var colGap = 18;
      var colW = (pageW - colGap) / 2;
      var col1X = left;
      var col2X = left + colW + colGap;
      var secY = doc.y;

      doc.y = secY; sectionHeader('JOB / CONTACT INFORMATION', col1X, colW);
      var y1 = doc.y + 4;
      var contact = [
        ['Customer Name', inv.customer_name],
        ['Driver License', (inv.dl_number || '') + (inv.dl_state ? (' (' + inv.dl_state + ')') : '')],
        ['Street Address', inv.street_address],
        ['City / State / Zip', [inv.city, inv.state, inv.zip].filter(Boolean).join(', ')],
        ['Phone', inv.phone],
        ['Email', inv.email]
      ];
      doc.y = y1;
      contact.forEach(function (r) { labelVal(col1X, colW, doc.y, r[0], r[1]); doc.y += 3; });
      var end1 = doc.y;

      var ent = [];
      if (inv.ent_registration) ent.push('Registration');
      if (inv.ent_insurance) ent.push('Insurance');
      if (inv.ent_title) ent.push('Title');
      if (inv.ent_rental) ent.push('Rental Agreement');
      doc.y = secY; sectionHeader('ACCOUNT / PAYMENT INFORMATION', col2X, colW);
      doc.y = y1;
      var account = [
        ['Account', inv.account_name],
        ['Customer PO / WO #', inv.customer_po_wo],
        ['Pay Type', (inv.pay_type || '') + (inv.card_last4 ? ('  ****' + inv.card_last4) : '')],
        ['Approval #', inv.approval_code],
        ['Entitlement', ent.join(', ')]
      ];
      account.forEach(function (r) { labelVal(col2X, colW, doc.y, r[0], r[1]); doc.y += 3; });
      var end2 = doc.y;

      doc.y = Math.max(end1, end2) + 8;

      // ---- Vehicle row (only fields with values) ----
      var vehCells = [];
      var veh = [inv.vehicle_year, inv.vehicle_make, inv.vehicle_model].filter(Boolean).join(' ');
      if (veh) vehCells.push(['Year/Make/Model', veh]);
      if (inv.license_tag) vehCells.push(['License #', inv.license_tag + (inv.tag_state ? (' (' + inv.tag_state + ')') : '')]);
      if (inv.vin) vehCells.push(['VIN', inv.vin]);
      if (inv.mileage) vehCells.push(['Mileage', inv.mileage]);
      vehCells.push(['Status', statusLabel(inv.status)]);
      hr(doc.y); doc.y += 6;
      var vcW = pageW / vehCells.length;
      var vy = doc.y;
      vehCells.forEach(function (c, i) {
        doc.font('Helvetica').fontSize(7).fillColor('#888888').text(String(c[0]).toUpperCase(), left + i * vcW, vy, { width: vcW - 6 });
        doc.font('Helvetica').fontSize(9).fillColor('#111111').text((c[1] == null || c[1] === '') ? '—' : String(c[1]), left + i * vcW, vy + 10, { width: vcW - 6 });
      });
      doc.y = vy + 26;

      // ---- Line items table ----
      var descX = left, descW = 236;
      var priceX = left + 240, priceW = 78;
      var qtyX = left + 322, qtyW = 38;
      var txX = left + 362, txW = 34;
      var extX = left + 400, extW = pageW - 400;

      function ensureRoom(h) {
        if (doc.y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); doc.y = doc.page.margins.top; return true; }
        return false;
      }

      var thY = doc.y;
      doc.save().rect(left, thY, pageW, 18).fill('#111111').restore();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
      doc.text('Labor / Parts Description', descX + 4, thY + 5, { width: descW - 6 });
      doc.text('Unit Price', priceX, thY + 5, { width: priceW, align: 'right' });
      doc.text('Qty', qtyX, thY + 5, { width: qtyW, align: 'center' });
      doc.text('TX', txX, thY + 5, { width: txW, align: 'center' });
      doc.text('Extension', extX, thY + 5, { width: extW - 4, align: 'right' });
      doc.fillColor('#111111');
      doc.y = thY + 18;

      items.forEach(function (it) {
        var qty = parseFloat(it.quantity) || 0;
        var unit = parseFloat(it.unit_price) || 0;
        var ext = qty * unit;
        var rowY = doc.y + 5;
        doc.font('Helvetica').fontSize(9).fillColor('#111111');
        var descH = doc.heightOfString(String(it.description || ''), { width: descW - 6 });
        var subH = 10;
        var rowH = Math.max(descH + subH, 20) + 8;
        ensureRoom(rowH);
        rowY = doc.y + 5;
        doc.font('Helvetica').fontSize(9).fillColor('#111111').text(String(it.description || ''), descX + 4, rowY, { width: descW - 6 });
        doc.font('Helvetica').fontSize(7).fillColor('#999999').text(it.line_type === 'labor' ? 'Labor' : 'Part', descX + 4, doc.y + 1, { width: descW - 6 });
        var lineBottom = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor('#111111');
        doc.text(money(unit), priceX, rowY, { width: priceW, align: 'right' });
        doc.text(String(qty), qtyX, rowY, { width: qtyW, align: 'center' });
        doc.text(it.taxable ? 'Y' : 'N', txX, rowY, { width: txW, align: 'center' });
        doc.text(money(ext), extX, rowY, { width: extW - 4, align: 'right' });
        doc.y = Math.max(lineBottom, rowY + 12) + 6;
        hr(doc.y - 3, '#eeeeee');
      });

      // ---- Totals ----
      doc.y += 6;
      ensureRoom(120);
      var totX = right - 220, totLblW = 130, totValW = 90;
      function totRow(label, val, bold) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(bold ? '#111111' : '#555555');
        var ty = doc.y;
        doc.text(label, totX, ty, { width: totLblW, align: 'right' });
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#111111').text(val, totX + totLblW, ty, { width: totValW, align: 'right' });
        doc.y = ty + (bold ? 16 : 13);
      }
      totRow('Labor Amount', money(inv.labor_amount));
      totRow('Parts Amount', money(inv.parts_amount));
      totRow('Sub-Total', money(inv.subtotal));
      totRow('Sales Tax', money(inv.tax_amount));
      if (parseFloat(inv.tip_amount)) totRow('Tip', money(inv.tip_amount));
      hr(doc.y + 1, '#111111'); doc.y += 4;
      totRow('Grand Total', money(inv.grand_total), true);

      // ---- Notes / payments ----
      if (inv.payments_note) { doc.moveDown(0.4); doc.font('Helvetica-Bold').fontSize(9).fillColor('#111111').text('Payments: ', { continued: true }); doc.font('Helvetica').text(String(inv.payments_note)); }
      if (inv.notes) { doc.font('Helvetica-Bold').fontSize(9).fillColor('#111111').text('Notes: ', { continued: true }); doc.font('Helvetica').text(String(inv.notes)); }

      // ---- Agreement ----
      var agreement = String(inv.agreement_text || '').split('{customer}').join(inv.customer_name || '__________');
      if (agreement.trim()) {
        ensureRoom(80);
        doc.moveDown(0.6); hr(doc.y); doc.y += 8;
        doc.font('Helvetica').fontSize(8).fillColor('#333333').text(agreement.trim(), left, doc.y, { width: pageW, lineGap: 2 });
      }

      // ---- Signature ----
      ensureRoom(110);
      doc.moveDown(0.8);
      doc.font('Helvetica').fontSize(8).fillColor('#888888').text('SIGNATURE', left, doc.y);
      doc.y += 2;
      var sigBuf = bufFromDataUrl(inv.signature_image);
      if (sigBuf) { try { doc.image(sigBuf, left, doc.y, { fit: [280, 70] }); doc.y += 74; } catch (e) { doc.y += 40; } }
      else { hr(doc.y + 34); doc.y += 40; }
      var sigStamp = (inv.signed_name || inv.customer_name || '');
      if (inv.signed_at) sigStamp += (sigStamp ? '  •  ' : '') + fmtDateTime(inv.signed_at);
      if (sigStamp) doc.font('Helvetica').fontSize(9).fillColor('#111111').text(sigStamp, left, doc.y, { width: pageW });

      // ---- Photos (already filtered to print-flagged) ----
      var validPhotos = photos.filter(function (p) { return p && p.buffer; });
      if (validPhotos.length) {
        doc.addPage(); doc.y = doc.page.margins.top;
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#111111').text('Photos');
        doc.moveDown(0.4);
        validPhotos.forEach(function (p, idx) {
          var cap = p.caption ? String(p.caption) : ('Photo ' + (idx + 1));
          if (doc.y > doc.page.height - doc.page.margins.bottom - 240) { doc.addPage(); doc.y = doc.page.margins.top; }
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text(cap, left, doc.y, { width: pageW });
          doc.moveDown(0.2);
          try { doc.image(p.buffer, { fit: [pageW, 330] }); } catch (e) {}
          doc.moveDown(0.8);
        });
      }

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildInvoicePdf: buildInvoicePdf };
