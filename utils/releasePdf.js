// Builds the Release of Liability PDF. Pure pdfkit, no browser.
//
// Unlike the e-signature module (which flattens signatures onto a PDF somebody
// uploaded), Nova DRAWS this document from the release_forms row. That is what
// lets the form arrive pre-filled from a complaint. The layout mirrors the
// Adobe Sign form this replaces: black title bar with an orange logo block, a
// grey meta strip, orange-bulleted sections, tinted value boxes, a two-party
// signature block, and an orange footer bar. A certificate of completion page
// (built from release_events) is appended once the document is finished.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
var PDFDocument = require('pdfkit');
var https = require('https');
var http = require('http');

var DEFAULT_LOGO = 'https://www.popalock.com/wp-content/uploads/2020/11/pal-logo-highres.png';

// The wording on the form. A release is a legal document, so this is seeded into
// the settings table under release_body_default on first use and edited there -
// Legal can revise it without a deploy, and any single release can override it.
var DEFAULT_RELEASE_BODY =
  'The undersigned Claimant hereby acknowledges receipt of payment in the sum stated above from ' +
  '{{COMPANY}} (hereinafter "the Company") in full and complete payment for any and all damages ' +
  'to the above-described Vehicle arising from the provision of car door unlocking, roadside ' +
  'assistance, or locksmith services. Claimant hereby accepts this sum as full and forever ' +
  'discharges the Company and its officers, directors, members, employees, insurers, successors, ' +
  'and assigns from any and all liability, claims, demands, causes of action, or suits of whatever ' +
  'nature for property damage to the Vehicle arising from said service.';

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
  var h = t.getHours(), ap = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12; if (h12 === 0) h12 = 12;
  var mi = t.getMinutes();
  return mdy(t) + '  ' + h12 + ':' + (mi < 10 ? '0' : '') + mi + ' ' + ap;
}

var EVENT_LABEL = {
  created: 'Document created',
  sent: 'Sent to the claimant',
  viewed: 'Opened by the claimant',
  consented: 'Electronic signature consent accepted',
  signed: 'Signed by the claimant',
  countersigned: 'Countersigned by the company representative',
  declined: 'Declined by the claimant',
  reminder_sent: 'Reminder sent',
  voided: 'Voided',
  expired: 'Expired',
  completed: 'Agreement completed'
};

// release: a release_forms row. events: release_events rows, oldest first.
// opts: { company:{name}, logo, customerSig:Buffer, repSig:Buffer, certificate:bool }
function buildReleasePdf(release, events, opts) {
  release = release || {};
  events = events || [];
  opts = opts || {};
  var company = opts.company || {};
  var companyName = company.name || 'Lock and Roll LLC';
  var logoUrl = opts.logo || company.logo || DEFAULT_LOGO;

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
        // Even columns across the full width, with a gutter between them.
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
        // Signature slot: a rule with the drawn signature sitting on it.
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
        doc.font('Helvetica-Bold').fontSize(24).fillColor('#ffffff')
           .text('Release of Liability', left + 14, y + 25, { width: barW - 28 });
        var placed = false;
        if (logoBuf) {
          try { doc.image(logoBuf, left + barW + 9, y + 14, { fit: [logoW - 18, 34] }); placed = true; } catch (e) {}
        }
        // The logo is fetched over the network and is allowed to fail (see
        // fetchImageBuffer). Draw a wordmark instead of leaving an empty orange
        // block, so a release built while the CDN is unreachable still looks
        // like a company form rather than a bug.
        if (!placed) {
          doc.font('Helvetica-BoldOblique').fontSize(13).fillColor('#ffffff')
             .text('Pop-A-Lock', left + barW, y + 22, { width: logoW, align: 'center', lineBreak: false });
          doc.font('Helvetica').fontSize(5.5).fillColor('#ffffff')
             .text('LOCKSMITH', left + barW, y + 38, { width: logoW, align: 'center', characterSpacing: 2.2, lineBreak: false });
        }
        y += 62;

        // ---------- meta strip ----------
        // Every cell is drawn at a fixed x with lineBreak off: this strip is one
        // line tall by design, and a wrap here spills text out under the bar.
        doc.save().rect(left, y, pageW, 17).fill(GREY_BAR).restore();
        function metaCell(x, cap, value, w) {
          doc.font('Helvetica').fontSize(7).fillColor('#a8a8a8')
             .text(cap, x, y + 5.5, { width: 52, lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff')
             .text(value, x + 44, y + 5, { width: w, lineBreak: false, ellipsis: true });
        }
        metaCell(left + 12, 'Document:', 'Receipt of Payment & Release', pageW * 0.34);
        metaCell(left + pageW * 0.52, 'Company:', companyName, pageW * 0.28);
        if (release.release_number) {
          doc.font('Helvetica').fontSize(7).fillColor('#8a8a8a')
             .text(release.release_number, left, y + 5.5, { width: pageW - 12, align: 'right', lineBreak: false });
        }
        y += 17 + 16;

        // ---------- claim details ----------
        y = sectionHead(y, 'Claim details');
        y = subHead(y, 'Claimant');
        var c2 = cols(2);
        var rowBottom = field(c2[0].x, y, c2[0].w, 'Printed name', release.claimant_name);
        field(c2[1].x, y, c2[1].w, 'Phone number', release.claimant_phone);
        y = rowBottom + 7;
        y = field(left, y, pageW, 'Mailing address', release.claimant_address) + 7;
        var c3 = cols(3);
        rowBottom = field(c3[0].x, y, c3[0].w, 'City', release.claimant_city);
        field(c3[1].x, y, c3[1].w, 'State', release.claimant_state);
        field(c3[2].x, y, c3[2].w, 'Zip code', release.claimant_zip);
        y = rowBottom + 11;

        y = subHead(y, 'Vehicle');
        var c4 = cols(4);
        rowBottom = field(c4[0].x, y, c4[0].w, 'Year', release.vehicle_year);
        field(c4[1].x, y, c4[1].w, 'Make', release.vehicle_make);
        field(c4[2].x, y, c4[2].w, 'Model', release.vehicle_model);
        field(c4[3].x, y, c4[3].w, 'Color', release.vehicle_color);
        y = rowBottom + 7;
        rowBottom = field(c2[0].x, y, c2[0].w, 'License plate', release.license_plate);
        field(c2[1].x, y, c2[1].w, 'VIN (if available)', release.vin);
        y = rowBottom + 11;

        y = subHead(y, 'Service');
        rowBottom = field(c2[0].x, y, c2[0].w, 'Date of service', mdy(release.service_date));
        field(c2[1].x, y, c2[1].w, 'Job / invoice #', release.job_ref);
        y = rowBottom + 7;
        // Damage description grows with the text rather than clipping: a body
        // shop line can run long and truncating it would change what was agreed.
        var dmg = txt(release.damage_description);
        doc.font('Helvetica').fontSize(9);
        var dmgH = Math.max(15, doc.heightOfString(dmg, { width: pageW - 8 }) + 8);
        label(left, y, pageW, 'Description of damage');
        doc.save().rect(left, y + 9, pageW, dmgH).fill(FIELD_BG).restore();
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(dmg, left + 4, y + 13, { width: pageW - 8 });
        y = y + 9 + dmgH + 16;

        // ---------- release ----------
        y = sectionHead(y, 'Release of liability');
        field(left, y, pageW * 0.36, 'Settlement amount paid (USD)', money(release.settlement_amount));
        y += 9 + 15 + 8;
        var bodyText = txt(release.release_body) || DEFAULT_RELEASE_BODY;
        bodyText = bodyText.replace(/\{\{COMPANY\}\}/g, companyName);
        doc.font('Helvetica').fontSize(8.5).fillColor('#333333')
           .text(bodyText, left, y, { width: pageW, align: 'left', lineGap: 1.5 });
        y = doc.y + 18;

        // ---------- signatures ----------
        y = sectionHead(y, 'Acknowledgment and signatures');
        y = subHead(y, 'Claimant');
        y = field(left, y, pageW, 'Printed name',
                  release.customer_printed_name || release.claimant_name) + 7;
        var sigCols = [{ x: left, w: pageW * 0.58 }, { x: left + pageW * 0.58 + 10, w: pageW * 0.42 - 10 }];
        var sigBottom = sigSlot(sigCols[0].x, y, sigCols[0].w, 'Signature', opts.customerSig, null);
        field(sigCols[1].x, y, sigCols[1].w, 'Date', mdy(release.customer_signed_at));
        y = sigBottom + 11;

        y = subHead(y, companyName + ' Representative');
        rowBottom = field(c2[0].x, y, c2[0].w, 'Printed name', release.rep_name);
        field(c2[1].x, y, c2[1].w, 'Title', release.rep_title);
        y = rowBottom + 7;
        sigBottom = sigSlot(sigCols[0].x, y, sigCols[0].w, 'Signature', opts.repSig, null);
        field(sigCols[1].x, y, sigCols[1].w, 'Date', mdy(release.rep_signed_at));
        y = sigBottom;

        // ---------- footer bar ----------
        var footY = doc.page.height - doc.page.margins.bottom - 18;
        doc.save().rect(left, footY, pageW, 18).fill(ORANGE).restore();
        doc.font('Helvetica').fontSize(7.5).fillColor('#ffffff')
           .text(companyName + '  ·  Receipt of Payment and Release of Liability',
                 left + 12, footY + 6, { width: pageW - 24 });

        // ---------- certificate of completion ----------
        if (opts.certificate !== false && events.length) {
          doc.addPage();
          var cy = 44;
          doc.font('Helvetica-Bold').fontSize(19).fillColor(INK)
             .text('Certificate of Completion', left, cy, { width: pageW });
          cy = doc.y + 3;
          doc.font('Helvetica').fontSize(9).fillColor(LABEL)
             .text('Audit trail for ' + txt(release.release_number), left, cy, { width: pageW });
          cy = doc.y + 14;

          var metaH = 74;
          doc.save().rect(left, cy, pageW, metaH).lineWidth(0.8).stroke('#cccccc').restore();
          var rows = [
            ['Document', 'Release of Liability - ' + txt(release.release_number)],
            ['Claimant', txt(release.claimant_name)],
            ['Settlement amount', money(release.settlement_amount)],
            ['Status', txt(release.status).replace(/_/g, ' ')],
            ['Completed', stamp(release.completed_at) || 'Not yet complete']
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

module.exports = { buildReleasePdf: buildReleasePdf, DEFAULT_RELEASE_BODY: DEFAULT_RELEASE_BODY };
