// Builds the CERTIFICATE REQUEST PACKET: the single document handed to the
// insurance agent at renewal. One block per account, each carrying the holder
// name and address exactly as that account requires it, the additional insured
// entities, the required wording verbatim, the required limits, the three boxes
// that get missed, and where the finished certificate has to go.
//
// Pure pdfkit, no browser. IMPORTANT: never use backticks / template literals in
// this file (Windows corrupts backticks in .js files); string concatenation only.
var PDFDocument = require('pdfkit');
var coi = require('./coi');

var ORANGE = '#f97316';
var INK = '#111111';
var MUTED = '#777777';
var RULE = '#dddddd';

var PAGE_MARGIN = 46;
var PAGE_BOTTOM = 756;   // LETTER is 792pt tall; leave room for the footer

function fmtDate(v) {
  if (!v) return '';
  var s = (v instanceof Date) ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4);
}

function label(doc, text, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED)
     .text(String(text).toUpperCase(), x, y, { width: width, characterSpacing: 0.7 });
  return doc.y;
}

function aiList(reqRow) {
  var ai = reqRow.additional_insured;
  if (typeof ai === 'string') { try { ai = JSON.parse(ai); } catch (e) { ai = null; } }
  if (!Array.isArray(ai) || !ai.length) return [];
  return ai.map(function (r) {
    return r.name + (r.relationship ? ('  (' + r.relationship + ')') : '');
  });
}

function requiredLimits(reqRow) {
  var out = [];
  coi.LIMIT_FIELDS.forEach(function (f) {
    var v = coi.num(reqRow[coi.reqCol(f.key)]);
    if (v !== null) out.push({ label: f.short, value: coi.fmtMoney(v) });
  });
  return out;
}

function boxLine(reqRow) {
  var parts = [];
  var w = [];
  if (reqRow.waiver_gl) w.push('GL');
  if (reqRow.waiver_auto) w.push('Auto');
  if (reqRow.waiver_wc) w.push('WC');
  if (w.length) parts.push('Waiver of subrogation (' + w.join(' / ') + ')');
  if (reqRow.primary_noncontrib) parts.push('Primary & non-contributory');
  if (reqRow.req_wc_statutory) parts.push('Workers comp - statutory');
  if (reqRow.cancel_notice_days) parts.push(reqRow.cancel_notice_days + ' days notice of cancellation');
  return parts;
}

function sendTo(reqRow) {
  var method = reqRow.submit_method || 'email';
  if (method === 'portal') {
    return 'Compliance portal: ' + (reqRow.submit_portal_url || 'see notes') +
      (reqRow.submit_notes ? ('  -  ' + reqRow.submit_notes) : '');
  }
  if (method === 'mail') {
    return 'By mail' + (reqRow.submit_notes ? ('  -  ' + reqRow.submit_notes) : '');
  }
  return (reqRow.submit_emails || 'no address on file') +
    (reqRow.submit_notes ? ('  -  ' + reqRow.submit_notes) : '');
}

// Measure a run of text in the font it will actually be drawn in. pdfkit's
// heightOfString uses the CURRENT font, so measuring without setting it first
// silently returns the wrong number - which is what made blocks overflow the
// page and pdfkit insert blank pages mid-block.
function mh(doc, text, width, font, size) {
  if (!text) return 0;
  doc.font(font || 'Helvetica').fontSize(size || 8.5);
  return doc.heightOfString(String(text), { width: width });
}

var LABEL_H = 11;   // one uppercase 6.5pt label line plus its gap

// How tall this account's block will be. Mirrors drawBlock piece for piece, so
// a block is never split across a page boundary halfway through the wording an
// underwriter has to read.
function blockHeight(doc, reqRow) {
  var leftW = 258;
  var rightW = 214;

  var left = 0;
  left += LABEL_H + mh(doc, reqRow.holder_name || '-', leftW) +
          (reqRow.holder_address ? mh(doc, reqRow.holder_address, leftW) : 0) + 8;
  var ai = aiList(reqRow);
  left += LABEL_H + mh(doc, ai.length ? ai.join('\n') : 'None required', leftW) + 8;
  if (reqRow.ai_wording) {
    left += LABEL_H + mh(doc, reqRow.ai_wording, leftW - 12, 'Helvetica-Oblique', 8) + 6;
  }

  var right = 0;
  var lims = requiredLimits(reqRow);
  right += LABEL_H + (lims.length ? (lims.length * 11.5 + 3) : (mh(doc, 'No minimums recorded', rightW) + 4));
  var boxes = boxLine(reqRow);
  if (boxes.length) {
    boxes.forEach(function (b) { right += mh(doc, '[ x ]  ' + b, rightW, 'Helvetica', 8) + 1; });
    right += 5;
  }
  right += LABEL_H + mh(doc, sendTo(reqRow), rightW, 'Helvetica', 8);

  // 26 = the account name row and the rule under it; 18 = padding inside the
  // rounded border.
  return 26 + Math.max(left, right) + 18;
}

function drawBlock(doc, reqRow, accountName, index, total, top) {
  var left = PAGE_MARGIN + 12;
  var leftW = 258;
  var right = PAGE_MARGIN + 300;
  var rightW = 214;
  var y = top;

  doc.save();
  doc.roundedRect(PAGE_MARGIN, top - 10, 520, blockHeight(doc, reqRow), 4).lineWidth(0.6).strokeColor(RULE).stroke();
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(accountName, left, y, { width: 340 });
  doc.font('Helvetica').fontSize(7).fillColor(MUTED)
     .text('CERTIFICATE ' + index + ' OF ' + total, right, y + 3, { width: rightW, align: 'right', characterSpacing: 0.6 });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(PAGE_MARGIN + 508, y).lineWidth(0.5).strokeColor('#e8e8e8').stroke();
  y += 8;

  // ---- left column: who the certificate is FOR ----
  var ly = y;
  label(doc, 'Certificate holder (verbatim)', left, ly, leftW);
  ly = doc.y + 2;
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)
     .text(String(reqRow.holder_name || '-'), left, ly, { width: leftW });
  if (reqRow.holder_address) {
    doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(String(reqRow.holder_address), left, doc.y, { width: leftW });
  }
  ly = doc.y + 8;

  label(doc, 'Additional insured', left, ly, leftW);
  ly = doc.y + 2;
  var ai = aiList(reqRow);
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)
     .text(ai.length ? ai.join('\n') : 'None required', left, ly, { width: leftW });
  ly = doc.y + 8;

  if (reqRow.ai_wording) {
    label(doc, 'Required wording', left, ly, leftW);
    ly = doc.y + 3;
    var wordH = doc.heightOfString(String(reqRow.ai_wording), { width: leftW - 12 });
    doc.save().rect(left, ly - 2, 2.5, wordH + 4).fillColor(ORANGE).fill().restore();
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(INK)
       .text(String(reqRow.ai_wording), left + 10, ly, { width: leftW - 12 });
    ly = doc.y + 6;
  }

  // ---- right column: what has to be on it ----
  var ry = y;
  label(doc, 'Required limits', right, ry, rightW);
  ry = doc.y + 3;
  var lims = requiredLimits(reqRow);
  if (!lims.length) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('No minimums recorded', right, ry, { width: rightW });
    ry = doc.y + 4;
  } else {
    lims.forEach(function (l) {
      doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(l.label, right, ry, { width: rightW - 74 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
         .text(l.value, right + rightW - 74, ry, { width: 74, align: 'right' });
      ry += 11.5;
      doc.moveTo(right, ry - 3).lineTo(right + rightW, ry - 3).lineWidth(0.4).strokeColor('#f0f0f0').stroke();
    });
    ry += 3;
  }

  var boxes = boxLine(reqRow);
  if (boxes.length) {
    boxes.forEach(function (b) {
      doc.font('Helvetica').fontSize(8).fillColor(INK).text('[ x ]  ' + b, right, ry, { width: rightW });
      ry = doc.y + 1;
    });
    ry += 5;
  }

  label(doc, 'Send the finished certificate to', right, ry, rightW);
  ry = doc.y + 2;
  doc.font('Helvetica').fontSize(8).fillColor(INK).text(sendTo(reqRow), right, ry, { width: rightW });

  return top + blockHeight(doc, reqRow) + 12;
}

function drawCover(doc, cycle, policy, count) {
  var x = PAGE_MARGIN;
  doc.font('Helvetica-Bold').fontSize(19).fillColor(INK).text('Certificate Request Packet', x, 52);
  doc.font('Helvetica').fontSize(10).fillColor('#555555')
     .text((policy.named_insured || 'Lock and Roll LLC') + '  -  policy year ' +
           fmtDate(cycle.policy_effective || policy.policy_effective) + ' to ' +
           fmtDate(cycle.policy_expires || policy.policy_expires), x, doc.y + 3);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
     .text('Generated ' + fmtDate(new Date().toISOString().slice(0, 10)) + '\n' +
           count + ' certificate' + (count === 1 ? '' : 's') + ' requested\n' +
           'Nova  -  ' + (policy.named_insured || 'Lock and Roll LLC'),
           PAGE_MARGIN + 320, 56, { width: 200, align: 'right' });
  var y = Math.max(doc.y, 104) + 6;
  doc.moveTo(x, y).lineTo(PAGE_MARGIN + 520, y).lineWidth(1.6).strokeColor(ORANGE).stroke();
  y += 14;

  label(doc, 'Named insured', x, y, 240);
  var ly = doc.y + 2;
  doc.font('Helvetica').fontSize(9).fillColor(INK)
     .text((policy.named_insured || 'Lock and Roll LLC') + (policy.address ? ('\n' + policy.address) : ''), x, ly, { width: 240 });
  var leftEnd = doc.y;

  label(doc, 'Agency', PAGE_MARGIN + 280, y, 240);
  var ry = doc.y + 2;
  var agency = [];
  if (policy.agency || policy.agent_name) agency.push([policy.agency, policy.agent_name].filter(Boolean).join('  -  '));
  if (policy.agent_email || policy.agent_phone) agency.push([policy.agent_email, policy.agent_phone].filter(Boolean).join('  -  '));
  var pols = [];
  if (policy.policy_gl) pols.push('GL ' + policy.policy_gl);
  if (policy.policy_auto) pols.push('Auto ' + policy.policy_auto);
  if (policy.policy_umbrella) pols.push('Umbrella ' + policy.policy_umbrella);
  if (policy.policy_wc) pols.push('WC ' + policy.policy_wc);
  if (pols.length) agency.push(pols.join('  -  '));
  if (policy.carrier) agency.push('Carrier: ' + policy.carrier);
  doc.font('Helvetica').fontSize(9).fillColor(INK)
     .text(agency.length ? agency.join('\n') : 'Not recorded - add it under the COI screen.', PAGE_MARGIN + 280, ry, { width: 240 });

  return Math.max(leftEnd, doc.y) + 20;
}

function drawSummary(doc, accounts) {
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text('Summary', PAGE_MARGIN, 52);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
     .text('Tick these off as each certificate is issued.', PAGE_MARGIN, doc.y + 2);
  var y = doc.y + 12;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED);
  doc.text('ACCOUNT', PAGE_MARGIN + 18, y, { width: 150 });
  doc.text('CERTIFICATE HOLDER', PAGE_MARGIN + 172, y, { width: 170 });
  doc.text('SEND TO', PAGE_MARGIN + 346, y, { width: 174 });
  y += 12;
  doc.moveTo(PAGE_MARGIN, y - 3).lineTo(PAGE_MARGIN + 520, y - 3).lineWidth(0.6).strokeColor(RULE).stroke();

  accounts.forEach(function (a) {
    if (y > PAGE_BOTTOM - 30) { doc.addPage(); y = 60; }
    doc.save().rect(PAGE_MARGIN, y + 1, 8, 8).lineWidth(0.6).strokeColor('#999999').stroke().restore();
    doc.font('Helvetica').fontSize(8).fillColor(INK).text(a.account_name || '', PAGE_MARGIN + 18, y, { width: 150 });
    var h1 = doc.y;
    doc.font('Helvetica').fontSize(8).fillColor(INK).text(a.holder_name || '-', PAGE_MARGIN + 172, y, { width: 170 });
    var h2 = doc.y;
    doc.font('Helvetica').fontSize(7.5).fillColor('#444444').text(sendTo(a), PAGE_MARGIN + 346, y, { width: 174 });
    y = Math.max(h1, h2, doc.y) + 7;
    doc.moveTo(PAGE_MARGIN, y - 4).lineTo(PAGE_MARGIN + 520, y - 4).lineWidth(0.35).strokeColor('#f0f0f0').stroke();
  });
}

// data: { cycle, accounts: [ {account_name, ...requirements columns} ], policy }
// stream: an HTTP response, or anything with write/end (the email path collects
// the chunks into a Buffer that way).
function buildPacketPdf(data, stream) {
  var doc = new PDFDocument({ size: 'LETTER', margin: PAGE_MARGIN, bufferPages: true });
  // This file paginates itself: every block is measured and placed at an
  // explicit y. Leaving pdfkit's own auto-break armed meant one overflowing
  // line could insert a page in the MIDDLE of a block, stranding a single line
  // of an address on a page of its own. A zero bottom margin disarms it.
  doc.page.margins.bottom = 0;
  doc.on('pageAdded', function () { doc.page.margins.bottom = 0; });
  doc.pipe(stream);

  // An account on the cycle with no requirements row would render as an empty
  // block, which is worse than useless to the agent - skip it and say so.
  var accounts = (data.accounts || []).filter(function (a) { return a && a.account_id; });
  var skipped = (data.accounts || []).length - accounts.length;

  var y = drawCover(doc, data.cycle || {}, data.policy || {}, accounts.length);

  accounts.forEach(function (a, i) {
    var h = blockHeight(doc, a);
    if (y + h > PAGE_BOTTOM) { doc.addPage(); y = 56; }
    y = drawBlock(doc, a, a.account_name || 'Account', i + 1, accounts.length, y);
  });

  if (skipped > 0) {
    if (y + 40 > PAGE_BOTTOM) { doc.addPage(); y = 56; }
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#a15c00')
       .text(skipped + ' account' + (skipped === 1 ? ' on this cycle has' : 's on this cycle have') +
             ' no requirements recorded, and ' + (skipped === 1 ? 'was' : 'were') +
             ' left out of this packet.', PAGE_MARGIN, y, { width: 520 });
  }

  if (accounts.length) drawSummary(doc, accounts);

  var range = doc.bufferedPageRange();
  for (var i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
       .text('Lock and Roll LLC  -  certificate request packet  -  page ' + (i + 1) + ' of ' + range.count,
             PAGE_MARGIN, 768, { width: 520, align: 'center' });
  }

  doc.end();
  return doc;
}

module.exports = { buildPacketPdf: buildPacketPdf };
