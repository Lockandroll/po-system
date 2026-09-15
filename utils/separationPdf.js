// Builds the Separation Agreement PDF. Pure pdfkit, no browser.
//
// Like the release of liability (utils/releasePdf.js, which this is modelled on),
// Nova DRAWS this document from the separation_agreements row rather than
// flattening signatures onto an uploaded file. That is what lets the form arrive
// already filled in from the offboarding record - name, last day, final check
// date, PTO payout - instead of somebody retyping all of it.
//
// Layout mirrors the release: black title bar with an orange logo block, a grey
// meta strip, orange-bulleted sections, tinted value boxes, a two-party signature
// block, an orange footer bar, and a certificate of completion built from
// separation_events.
//
// A NOTE ON THE DEFAULT WORDING, because it matters more here than anywhere else
// in Nova. DEFAULT_SEPARATION_BODY below is an ACKNOWLEDGMENT: it confirms the
// facts of the separation, the return of property, and that confidentiality
// obligations survive. It deliberately does NOT release any claims. General
// releases of claims carry requirements this codebase has no business guessing
// at - for anyone 40 or over the federal OWBPA rules impose consideration and
// revocation periods, and several states add their own - so release language, if
// Lock and Roll wants it, belongs in text an employment lawyer writes. The
// wording is seeded into settings under separation_body_default precisely so it
// can be replaced without a deploy, and any single agreement can override it.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
var PDFDocument = require('pdfkit');
var https = require('https');
var http = require('http');

var DEFAULT_LOGO = 'https://www.popalock.com/wp-content/uploads/2020/11/pal-logo-highres.png';

var DEFAULT_SEPARATION_BODY =
  'The undersigned Employee and {{COMPANY}} (the "Company") acknowledge that the Employee&#39;s ' +
  'employment with the Company ends on the Last Day stated above, and that the details recorded ' +
  'on this form are accurate as of the date of signing.\n\n' +
  'The Employee confirms that all Company property in their possession - including keys, key ' +
  'blanks and programming equipment, tools, uniforms, fuel and credit cards, access badges, ' +
  'phones, computers and vehicles - has been returned to the Company, except as noted above.\n\n' +
  'The Employee confirms that any final wages, and any accrued time off payable under Company ' +
  'policy and applicable law, will be paid on the Final Check Date stated above, and that the ' +
  'Company has the Employee&#39;s current mailing address for that purpose.\n\n' +
  'The Employee acknowledges that obligations regarding confidential business information, ' +
  'customer information, account credentials and trade secrets continue after employment ends, ' +
  'and that they have not retained copies of Company records.\n\n' +
  'Nothing in this acknowledgment waives any right or claim the Employee may have, and nothing ' +
  'here changes the at-will nature of the employment that has now ended. Signing confirms the ' +
  'facts recorded above; it is not a release of claims.';

var INK = '#111111';
var BAR = '#141414';
var ORANGE = '#f26522';
var GREY_BAR = '#2b2b2b';
var LABEL = '#767676';
var FIELD_BG = '#dfe3f7';
var RULE = '#333333';

var PROPERTY_STATUS = {
  returned: 'Returned', not_returned: 'Not returned', lost: 'Lost',
  stolen: 'Stolen', kept: 'Kept by agreement'
};

var EVENT_LABEL = {
  created: 'Agreement created',
  sent: 'Sent to employee',
  reminder_sent: 'Reminder sent',
  viewed: 'Opened by employee',
  consented: 'Consented to sign electronically',
  signed: 'Signed by employee',
  countersigned: 'Countersigned by the Company',
  completed: 'Completed',
  declined: 'Declined by employee',
  voided: 'Withdrawn'
};

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

function money(n) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// MM/DD/YYYY in the company's local reading, not UTC. A DATE column comes back
// from pg as a local-midnight Date, so read the local parts, not the ISO string.
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
  return t.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit'
  });
}

function hoursText(h) {
  var v = Number(h);
  if (!isFinite(v) || v <= 0) return '0 hours';
  var days = Math.round((v / 8) * 100) / 100;
  return (Math.round(v * 100) / 100) + ' hrs (' + days + ' d)';
}

// The body is authored as plain text with blank lines between paragraphs, and
// carries &#39; because the same string is rendered into HTML on the signing
// page. pdfkit is not HTML, so those entities are turned back into characters
// here - otherwise the printed document reads "Employee&#39;s".
function plain(s) {
  return String(s == null ? '' : s)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function buildSeparationPdf(agr, events, opts) {
  agr = agr || {};
  events = events || [];
  opts = opts || {};
  var company = opts.company || {};
  var companyName = company.name || 'Lock and Roll LLC';
  var logoUrl = opts.logo || company.logo || DEFAULT_LOGO;
  var body = plain(String(agr.terms_body || DEFAULT_SEPARATION_BODY).replace(/\{\{COMPANY\}\}/g, companyName));

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

        // ---------- helpers ----------
        function label(x, y, w, s) {
          doc.font('Helvetica').fontSize(6.5).fillColor(LABEL)
             .text(String(s || '').toUpperCase(), x, y, { width: w, characterSpacing: 0.6 });
        }
        // A filled value box with its small uppercase caption above. Returns the
        // y just below the box so callers can stack rows without measuring.
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
        function subHead(y, s) {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(s, left, y, { width: pageW });
          return y + 11;
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

        // ---------- header ----------
        var y = 34;
        var logoW = 118;
        var barW = pageW - logoW;
        doc.save().rect(left, y, barW, 62).fill(BAR).restore();
        doc.save().rect(left + barW, y, logoW, 62).fill(ORANGE).restore();
        doc.font('Helvetica').fontSize(6.5).fillColor('#9a9a9a')
           .text('COMPANY FORM', left + 14, y + 12, { width: barW - 28, characterSpacing: 1.4 });
        doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff')
           .text('Separation Agreement', left + 14, y + 25, { width: barW - 28 });
        var placed = false;
        if (logoBuf) {
          try { doc.image(logoBuf, left + barW + 9, y + 14, { fit: [logoW - 18, 34] }); placed = true; } catch (e) {}
        }
        // The logo is fetched over the network and is allowed to fail. Draw a
        // wordmark rather than leaving an empty orange block, so a document built
        // while the CDN is unreachable still looks like a company form.
        if (!placed) {
          doc.font('Helvetica-BoldOblique').fontSize(13).fillColor('#ffffff')
             .text('Pop-A-Lock', left + barW, y + 22, { width: logoW, align: 'center', lineBreak: false });
          doc.font('Helvetica').fontSize(5.5).fillColor('#ffffff')
             .text('LOCKSMITH', left + barW, y + 38, { width: logoW, align: 'center', characterSpacing: 2.2, lineBreak: false });
        }
        y += 62;

        // ---------- meta strip ----------
        // One line tall by design: every cell is drawn at a fixed x with
        // lineBreak off, because a wrap here spills text out from under the bar.
        doc.save().rect(left, y, pageW, 17).fill(GREY_BAR).restore();
        function metaCell(x, cap, value, w) {
          doc.font('Helvetica').fontSize(7).fillColor('#a8a8a8')
             .text(cap, x, y + 5.5, { width: 52, lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff')
             .text(value, x + 44, y + 5, { width: w, lineBreak: false, ellipsis: true });
        }
        metaCell(left + 12, 'Document:', 'Separation Acknowledgment', pageW * 0.34);
        metaCell(left + pageW * 0.52, 'Company:', companyName, pageW * 0.28);
        if (agr.agreement_number) {
          doc.font('Helvetica').fontSize(7).fillColor('#8a8a8a')
             .text(agr.agreement_number, left, y + 5.5, { width: pageW - 12, align: 'right', lineBreak: false });
        }
        y += 17 + 16;

        // ---------- separation details ----------
        y = sectionHead(y, 'Separation details');
        y = subHead(y, 'Employee');
        var c2 = cols(2);
        var rowBottom = field(c2[0].x, y, c2[0].w, 'Printed name', agr.employee_name);
        field(c2[1].x, y, c2[1].w, 'Position', agr.job_title);
        y = rowBottom + 11;

        y = subHead(y, 'Dates and final pay');
        var c3 = cols(3);
        rowBottom = field(c3[0].x, y, c3[0].w, 'Last day', mdy(agr.last_day));
        field(c3[1].x, y, c3[1].w, 'Final check date', agr.final_check_date ? mdy(agr.final_check_date) : 'Per payroll schedule');
        field(c3[2].x, y, c3[2].w, 'Accrued time off paid', hoursText(agr.pto_payout_hours));
        y = rowBottom + 7;
        // Severance is optional and usually zero. Printing "$0.00" on a form
        // where nothing was offered invites an argument about it, so the row is
        // drawn only when there is an amount.
        if (Number(agr.severance_amount) > 0) {
          y = field(left, y, pageW * 0.42, 'Separation pay', money(agr.severance_amount)) + 7;
        }
        y = field(left, y, pageW, 'Company property - notes / outstanding items', agr.property_notes || 'All returned') + 11;

        // ---------- property received ----------
        // Drawn from the POSTED receipt (routes/property.js), so this is the same
        // list the manager recorded item by item, not a retyped summary. Value is
        // printed only against what did not come back, because that is the part
        // the employee is being asked to agree to - putting a price on a returned
        // tool just invites an argument about the price.
        var props = opts.property || [];
        if (props.length) {
          y = sectionHead(y, 'Property received');
          doc.font('Helvetica').fontSize(7).fillColor(LABEL)
             .text('Recorded ' + (mdy(opts.recordedAt) || mdy(agr.receipt_posted_at) || 'on the last day') +
                   '. Signing confirms this list is accurate.', left, y, { width: pageW });
          y = doc.y + 6;

          var colQty = 34, colState = 74, colVal = 62;
          var colName = pageW - colQty - colState - colVal - 12;
          doc.font('Helvetica').fontSize(6.5).fillColor(LABEL);
          doc.text('ITEM', left, y, { width: colName, characterSpacing: 0.6 });
          doc.text('QTY', left + colName + 4, y, { width: colQty, characterSpacing: 0.6 });
          doc.text('STATUS', left + colName + colQty + 8, y, { width: colState, characterSpacing: 0.6 });
          doc.text('VALUE', left + colName + colQty + colState + 12, y, { width: colVal, align: 'right', characterSpacing: 0.6 });
          y += 9;
          doc.save().moveTo(left, y).lineTo(left + pageW, y).lineWidth(0.6).stroke('#cccccc').restore();
          y += 4;

          for (var pi = 0; pi < props.length; pi++) {
            var pr = props[pi];
            // A long receipt must not run off the bottom of the page, and a line
            // must not be split across two.
            if (y > doc.page.height - doc.page.margins.bottom - 60) { doc.addPage(); y = 44; }
            var gone = pr.value != null || (pr.outcome && pr.outcome !== 'returned');
            // plain() here too: a label or note that was HTML-escaped on its way
            // in must not print as "brother&#39;s" on a document somebody signs.
            var sub = pr.serial_number ? plain(pr.serial_number) : '';
            if (pr.note) sub += (sub ? '  \u00b7  ' : '') + plain(pr.note);

            doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
               .text(plain(txt(pr.label)), left, y, { width: colName, lineBreak: false, ellipsis: true });
            doc.font('Helvetica').fontSize(8.5).fillColor(INK)
               .text(String(pr.qty || 1), left + colName + 4, y, { width: colQty, lineBreak: false });
            doc.font('Helvetica-Bold').fontSize(8).fillColor(gone ? '#b3261e' : '#1e7a3c')
               .text(PROPERTY_STATUS[pr.outcome] || txt(pr.outcome), left + colName + colQty + 8, y,
                     { width: colState, lineBreak: false, ellipsis: true });
            doc.font('Helvetica').fontSize(8.5).fillColor(INK)
               .text(pr.value != null ? money(pr.value) : '', left + colName + colQty + colState + 12, y,
                     { width: colVal, align: 'right', lineBreak: false });
            y += 10;
            if (sub) {
              doc.font('Helvetica').fontSize(7).fillColor(LABEL)
                 .text(sub, left, y, { width: colName + colQty, lineBreak: false, ellipsis: true });
              y += 8;
            }
            y += 2;
          }

          var pt = opts.propertyTotals || {};
          doc.save().moveTo(left, y).lineTo(left + pageW, y).lineWidth(0.6).stroke('#cccccc').restore();
          y += 5;
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(pt.not_returned ? '#b3261e' : INK)
             .text(pt.not_returned
                     ? ('Not returned: ' + pt.not_returned + ' item' + (pt.not_returned === 1 ? '' : 's') +
                        '  \u00b7  ' + money(pt.value_not_returned))
                     : 'Everything listed was returned.',
                   left, y, { width: pageW });
          y = doc.y + 12;
        } else if (agr.nothing_to_return) {
          y = sectionHead(y, 'Property received');
          doc.font('Helvetica').fontSize(8.5).fillColor(INK)
             .text('The Employee held no Company property to return.', left, y, { width: pageW });
          y = doc.y + 12;
        }

        // ---------- the wording ----------
        y = sectionHead(y, 'Acknowledgment');
        doc.font('Helvetica').fontSize(8.5).fillColor(INK)
           .text(body, left, y, { width: pageW, align: 'left', lineGap: 1.6, paragraphGap: 5 });
        y = doc.y + 12;

        // The signature block must not be orphaned onto a page by itself, and
        // must never collide with the footer bar. 150pt is the measured height
        // of the block below plus its captions.
        if (y > doc.page.height - doc.page.margins.bottom - 150) { doc.addPage(); y = 44; }

        // ---------- signatures ----------
        y = sectionHead(y, 'Signatures');
        y = subHead(y, 'Employee');
        var sigCols = [{ x: left, w: pageW * 0.62 }, { x: left + pageW * 0.66, w: pageW * 0.34 }];
        var sigBottom = sigSlot(sigCols[0].x, y, sigCols[0].w, 'Signature', opts.employeeSig, agr.employee_printed_name);
        field(sigCols[1].x, y, sigCols[1].w, 'Date', mdy(agr.employee_signed_at));
        y = sigBottom + 4;
        doc.font('Helvetica').fontSize(7).fillColor(LABEL)
           .text('Printed name: ' + txt(agr.employee_printed_name), left, y, { width: pageW });
        y = doc.y + 11;

        y = subHead(y, companyName + ' Representative');
        rowBottom = field(c2[0].x, y, c2[0].w, 'Printed name', agr.rep_name);
        field(c2[1].x, y, c2[1].w, 'Title', agr.rep_title);
        y = rowBottom + 7;
        sigBottom = sigSlot(sigCols[0].x, y, sigCols[0].w, 'Signature', opts.repSig, null);
        field(sigCols[1].x, y, sigCols[1].w, 'Date', mdy(agr.rep_signed_at));
        y = sigBottom;

        // ---------- footer bar ----------
        var footY = doc.page.height - doc.page.margins.bottom - 18;
        doc.save().rect(left, footY, pageW, 18).fill(ORANGE).restore();
        doc.font('Helvetica').fontSize(7.5).fillColor('#ffffff')
           .text(companyName + '  ·  Separation Agreement and Acknowledgment',
                 left + 12, footY + 6, { width: pageW - 24 });

        // ---------- certificate of completion ----------
        if (opts.certificate !== false && events.length) {
          doc.addPage();
          var cy = 44;
          doc.font('Helvetica-Bold').fontSize(19).fillColor(INK)
             .text('Certificate of Completion', left, cy, { width: pageW });
          cy = doc.y + 3;
          doc.font('Helvetica').fontSize(9).fillColor(LABEL)
             .text('Audit trail for ' + txt(agr.agreement_number), left, cy, { width: pageW });
          cy = doc.y + 14;

          var metaH = 74;
          doc.save().rect(left, cy, pageW, metaH).lineWidth(0.8).stroke('#cccccc').restore();
          var rows = [
            ['Document', 'Separation Agreement - ' + txt(agr.agreement_number)],
            ['Employee', txt(agr.employee_name)],
            ['Last day', mdy(agr.last_day)],
            ['Status', txt(agr.status).replace(/_/g, ' ')],
            ['Completed', stamp(agr.completed_at) || 'Not yet complete']
          ];
          var ry = cy + 8;
          for (var i = 0; i < rows.length; i++) {
            doc.font('Helvetica').fontSize(8).fillColor(LABEL).text(rows[i][0], left + 10, ry, { width: 130 });
            doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(rows[i][1], left + 145, ry, { width: pageW - 155 });
            ry += 12;
          }
          cy += metaH + 18;

          doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('History', left, cy, { width: pageW });
          cy = doc.y + 8;

          for (var e = 0; e < events.length; e++) {
            var ev = events[e] || {};
            if (cy > doc.page.height - 90) { doc.addPage(); cy = 44; }
            doc.save().circle(left + 3, cy + 4, 2.5).fill(ORANGE).restore();
            var head = EVENT_LABEL[ev.event_type] || txt(ev.event_type);
            if (ev.actor) head += ' - ' + txt(ev.actor);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
               .text(head, left + 12, cy, { width: pageW - 12 });
            cy = doc.y + 1;
            var meta = stamp(ev.created_at);
            if (ev.ip) meta += '  ·  IP ' + txt(ev.ip);
            if (ev.user_agent) meta += '  ·  ' + txt(ev.user_agent).slice(0, 78);
            doc.font('Helvetica').fontSize(7).fillColor(LABEL)
               .text(meta, left + 12, cy, { width: pageW - 12 });
            cy = doc.y + 7;
          }

          doc.font('Helvetica').fontSize(7).fillColor(LABEL)
             .text('Generated by Nova for ' + companyName + '. Times are ' +
                   Intl.DateTimeFormat().resolvedOptions().timeZone + '.',
                   left, doc.page.height - doc.page.margins.bottom - 14, { width: pageW });
        }

        doc.end();
      } catch (err) { reject(err); }
    });
  });
}

module.exports = {
  buildSeparationPdf: buildSeparationPdf,
  DEFAULT_SEPARATION_BODY: DEFAULT_SEPARATION_BODY,
  EVENT_LABEL: EVENT_LABEL
};
