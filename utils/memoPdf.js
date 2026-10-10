// PDFs for company memos.
//
//   buildSignedCopy(memo, recipient, opts)  ->  Buffer
//       The copy that goes in the employee's file. Page 1 is a signature page
//       (pdfkit): who it was from and to, the note and/or written memo, the
//       acknowledgment they agreed to, their drawn signature and typed name,
//       and the delivery record (delivered / viewed / read to the end /
//       signed, with IP and the file fingerprint). Then, if the memo carried a
//       PDF, every page of THAT PDF is appended exactly as it was sent
//       (pdf-lib copies the pages, it does not re-render them) and stamped
//       along the bottom with the memo number and who signed it, so a page
//       pulled out of the stack still says where it came from.
//
//       If they left questions or feedback, the whole thread follows on its
//       own pages at the very end, after the original document, so it never
//       sits between the signature and what was signed.
//
//   buildStatusReport(memo, recipients, opts)  ->  Buffer
//       One table: everyone it went to, when it was delivered, viewed and
//       signed, and the status. For a manager meeting or a file folder.
//
//   mergePdfs([Buffer])  ->  Buffer       "All signed copies" in one file.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
var PDFDocument = require('pdfkit');
var { PDFDocument: LibDoc, StandardFonts, rgb } = require('pdf-lib');

var INK = '#111111';
var MUTED = '#666666';
var ORANGE = '#f97316';
var SHADE = '#f3f3f3';
var RULE = '#cccccc';

function txt(s) { return (s == null || s === '') ? '' : String(s); }

var TZ = 'America/New_York';
function stamp(d) {
  if (!d) return '';
  var t = (d instanceof Date) ? d : new Date(d);
  if (isNaN(t.getTime())) return String(d);
  try {
    return t.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
  } catch (e) { return t.toISOString(); }
}
// Table cells: no year, no zone, so it fits one line. The report header says ET.
function shortStamp(d) {
  if (!d) return '';
  var t = (d instanceof Date) ? d : new Date(d);
  if (isNaN(t.getTime())) return String(d);
  try { return t.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return t.toISOString(); }
}
function longDate(d) {
  if (!d) return '';
  var s = (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  var p = s.split('-');
  if (p.length !== 3) return s;
  var MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return MON[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
}
function dateOnly(d) {
  // A DATE column comes back from pg as a local-midnight Date. Read its local
  // parts so a server east or west of UTC cannot shift the day.
  if (!d) return '';
  if (d instanceof Date) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  return String(d).slice(0, 10);
}

function bufFromDataUrl(s) {
  if (!s) return null;
  var str = String(s);
  var idx = str.indexOf('base64,');
  var b64 = idx !== -1 ? str.slice(idx + 7) : str;
  try { return Buffer.from(b64, 'base64'); } catch (e) { return null; }
}

function render(build) {
  return new Promise(function (resolve, reject) {
    try {
      var doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
      var chunks = [];
      doc.on('data', function (c) { chunks.push(c); });
      doc.on('end', function () { resolve(Buffer.concat(chunks)); });
      doc.on('error', reject);
      build(doc);
      doc.end();
    } catch (e) { reject(e); }
  });
}

function header(doc, company, right1, right2) {
  var left = doc.page.margins.left;
  var w = doc.page.width - left - doc.page.margins.right;
  var y = doc.y;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(txt(company.name) || 'Lock and Roll LLC', left, y, { width: w * 0.6 });
  if (company.line) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(company.line, left, doc.y + 1, { width: w * 0.6 });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(right1, left + w * 0.55, y, { width: w * 0.45, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(right2, left + w * 0.55, y + 14, { width: w * 0.45, align: 'right' });
  var ry = Math.max(doc.y, y + 30) + 8;
  doc.save().moveTo(left, ry).lineTo(left + w, ry).lineWidth(2).strokeColor(ORANGE).stroke().restore();
  doc.x = left; doc.y = ry + 14;
}

function kvGrid(doc, pairs) {
  var left = doc.page.margins.left;
  var w = doc.page.width - left - doc.page.margins.right;
  var colW = w / 2;
  var rows = Math.ceil(pairs.length / 2);
  var rowH = 15;
  var top = doc.y;
  doc.save().rect(left, top, w, rows * rowH + 12).fill(SHADE).restore();
  for (var i = 0; i < pairs.length; i++) {
    var c = i % 2, r = Math.floor(i / 2);
    var x = left + 10 + c * colW, y = top + 6 + r * rowH;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(pairs[i][0], x, y, { width: 80, lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(txt(pairs[i][1]) || '-', x + 82, y, { width: colW - 100, lineBreak: false, ellipsis: true });
  }
  doc.x = left; doc.y = top + rows * rowH + 22;
}

// ---------------------------------------------------------------- signed copy

function signaturePage(memo, rcp, opts) {
  opts = opts || {};
  var company = opts.company || {};
  return render(function (doc) {
    var left = doc.page.margins.left;
    var w = doc.page.width - left - doc.page.margins.right;

    header(doc, company, 'COMPANY MEMO', txt(memo.memo_no) + ' · ' + (rcp.completion === 'acknowledged' ? 'Acknowledged copy' : 'Signed copy'));
    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(txt(memo.title), left, doc.y, { width: w });
    doc.moveDown(0.5);

    var to = txt(rcp.user_name) + (rcp.user_role_label ? ' (' + rcp.user_role_label + (rcp.user_city ? ', ' + rcp.user_city : '') + ')' : '');
    kvGrid(doc, [
      ['From', txt(memo.sent_by_name) + (opts.fromTitle ? ', ' + opts.fromTitle : '')],
      ['Memo type', memo.type],
      ['To', to],
      ['Effective', memo.effective_date ? longDate(dateOnly(memo.effective_date)) : ''],
      ['Date issued', memo.sent_at ? longDate(new Date(memo.sent_at).toISOString()) : ''],
      ['Attachment', memo.file_name ? (memo.file_name + (memo.file_pages ? ' (' + memo.file_pages + ' pp.)' : '')) : 'None']
    ]);

    if (memo.note) {
      doc.font('Helvetica-Oblique').fontSize(11).fillColor(INK).text('“' + txt(memo.note) + '”', left, doc.y, { width: w });
      doc.moveDown(0.6);
    }
    if (memo.body) {
      doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(txt(memo.body), left, doc.y, { width: w, lineGap: 2 });
      doc.moveDown(0.8);
    }
    if (memo.file_name) {
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(
        'This page records ' + txt(rcp.user_name) + '’s ' + (rcp.completion === 'acknowledged' ? 'acknowledgment of' : 'signature on') +
        ' the document that follows, ' + txt(memo.file_name) + ', which is attached exactly as it was sent.',
        left, doc.y, { width: w });
      doc.moveDown(0.8);
    }

    // Keep the acknowledgment box in one piece.
    if (doc.y > doc.page.height - 330) doc.addPage();

    var boxTop = doc.y;
    var pad = 14;
    var inner = w - pad * 2;
    var y = boxTop + pad;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#444444').text('EMPLOYEE ACKNOWLEDGMENT', left + pad, y, { width: inner, characterSpacing: 0.6 });
    y = doc.y + 6;
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(txt(opts.ackText), left + pad, y, { width: inner, lineGap: 1.5 });
    y = doc.y + 12;

    var half = (inner - 18) / 2;
    if (rcp.completion === 'signed') {
      var sigBuf = bufFromDataUrl(rcp.signature_data);
      if (sigBuf) {
        try { doc.image(sigBuf, left + pad, y, { fit: [half, 46], align: 'left', valign: 'bottom' }); } catch (e) { sigBuf = null; }
      }
      if (!sigBuf) doc.font('Helvetica-Oblique').fontSize(16).fillColor(INK).text(txt(rcp.signature_name), left + pad, y + 18, { width: half });
      doc.font('Helvetica').fontSize(13).fillColor(INK).text(txt(rcp.signature_name), left + pad + half + 18, y + 28, { width: half, lineBreak: false, ellipsis: true });
      var lineY = y + 50;
      doc.save().moveTo(left + pad, lineY).lineTo(left + pad + half, lineY).lineWidth(0.8).strokeColor('#333333').stroke().restore();
      doc.save().moveTo(left + pad + half + 18, lineY).lineTo(left + pad + inner, lineY).lineWidth(0.8).strokeColor('#333333').stroke().restore();
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Signature', left + pad, lineY + 4, { width: half });
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Typed name · signed ' + stamp(rcp.completed_at), left + pad + half + 18, lineY + 4, { width: half });
      y = lineY + 22;
    } else {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Acknowledged by ' + txt(rcp.user_name) + ' on ' + stamp(rcp.completed_at), left + pad, y, { width: inner });
      y = doc.y + 12;
    }

    doc.save().moveTo(left + pad, y).lineTo(left + pad + inner, y).lineWidth(0.5).strokeColor(RULE).stroke().restore();
    y += 8;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text('Delivery and signature record', left + pad, y, { width: inner });
    y = doc.y + 4;
    var trail = [
      ['Delivered', rcp.delivered_at ? stamp(rcp.delivered_at) + (rcp.delivered_via ? ' by ' + rcp.delivered_via : '') : 'In Nova'],
      ['First viewed', rcp.first_viewed_at ? stamp(rcp.first_viewed_at) + ' (' + (rcp.view_count || 1) + (Number(rcp.view_count) === 1 ? ' view)' : ' views)') : '-'],
      ['Read to the end', rcp.reached_end_at ? stamp(rcp.reached_end_at) : '-'],
      [rcp.completion === 'acknowledged' ? 'Acknowledged' : 'Signed', stamp(rcp.completed_at) + ', signed in to Nova' + (rcp.signature_ip ? ', IP ' + rcp.signature_ip : '') + (rcp.device ? ', ' + rcp.device : '')],
      ['Content fingerprint', 'SHA-256 ' + txt(rcp.signed_hash || memo.content_hash) + ((rcp.signed_hash && rcp.signed_hash === memo.content_hash) ? '  (matches the memo as sent)' : '')]
    ];
    for (var i = 0; i < trail.length; i++) {
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(trail[i][0], left + pad, y, { width: 100, lineBreak: false });
      doc.font(i === trail.length - 1 ? 'Courier' : 'Helvetica').fontSize(8).fillColor('#333333').text(trail[i][1], left + pad + 104, y, { width: inner - 104 });
      y = doc.y + 3;
    }
    var boxH = y + pad - 6 - boxTop;
    doc.save().roundedRect(left, boxTop, w, boxH, 4).lineWidth(0.8).strokeColor('#bbbbbb').stroke().restore();
    doc.y = boxTop + boxH + 12;
  });
}

// The questions-and-feedback thread, for the end of the signed copy.
function feedbackPages(memo, rcp, thread, opts) {
  var company = (opts && opts.company) || {};
  return render(function (doc) {
    var left = doc.page.margins.left;
    var w = doc.page.width - left - doc.page.margins.right;
    header(doc, company, 'QUESTIONS AND FEEDBACK', txt(memo.memo_no) + ' · ' + txt(rcp.user_name));
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
      'Written in Nova by ' + txt(rcp.user_name) + ' and the people who manage memos. This is a record of the conversation about the memo; ' +
      'it does not change what was ' + (rcp.completion === 'acknowledged' ? 'acknowledged' : 'signed') + '.', left, doc.y, { width: w });
    doc.moveDown(1);
    for (var i = 0; i < thread.length; i++) {
      var f = thread[i];
      if (doc.y > doc.page.height - 140) { doc.addPage(); }
      var top = doc.y;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(f.from_staff ? ORANGE : INK).text(txt(f.author_name) + (f.from_staff ? ' (reply)' : ''), left, top, { width: w * 0.6, lineBreak: false });
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(stamp(f.created_at), left + w * 0.5, top, { width: w * 0.5, align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(txt(f.body), left + 10, top + 15, { width: w - 10 });
      var bottom = doc.y + 4;
      doc.save().moveTo(left, top).lineTo(left, bottom).lineWidth(2).strokeColor(f.from_staff ? ORANGE : RULE).stroke().restore();
      doc.y = bottom + 12;
    }
  });
}

// Stamp "<footer>   Page i of N" along the bottom of every page.
async function stampPages(lib, footerFor) {
  var font = await lib.embedFont(StandardFonts.Helvetica);
  var pages = lib.getPages();
  var n = pages.length;
  for (var i = 0; i < n; i++) {
    var pg = pages[i];
    var size = pg.getSize();
    var left = footerFor(i, n) || '';
    var right = 'Page ' + (i + 1) + ' of ' + n;
    var fs = 7.5;
    // Text only, never a background strip: on the attached pages this is the
    // ORIGINAL document, and nothing the employee signed may be covered up.
    if (left) pg.drawText(left, { x: 36, y: 6, size: fs, font: font, color: rgb(0.45, 0.45, 0.45) });
    pg.drawText(right, { x: size.width - 36 - font.widthOfTextAtSize(right, fs), y: 6, size: fs, font: font, color: rgb(0.45, 0.45, 0.45) });
  }
}

function pdfSafe(s) {
  // pdf-lib's standard fonts are WinAnsi; anything outside it throws.
  return String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/·/g, '-').replace(/[^\x20-\x7E -ÿ]/g, '');
}

// memo: memos row. rcp: memo_recipients row (+ user_role_label, device).
// opts: { company:{name,line}, ackText, fromTitle, fileBuffer }
async function buildSignedCopy(memo, rcp, opts) {
  opts = opts || {};
  var first = await signaturePage(memo, rcp, opts);
  var out = await LibDoc.load(first);
  var sigPages = out.getPageCount();
  if (opts.fileBuffer) {
    var src = await LibDoc.load(opts.fileBuffer, { ignoreEncryption: true });
    var copied = await out.copyPages(src, src.getPageIndices());
    for (var i = 0; i < copied.length; i++) out.addPage(copied[i]);
  }
  var docEnd = out.getPageCount();
  if (opts.feedback && opts.feedback.length) {
    var fsrc = await LibDoc.load(await feedbackPages(memo, rcp, opts.feedback, opts));
    var fcopied = await out.copyPages(fsrc, fsrc.getPageIndices());
    for (var j = 0; j < fcopied.length; j++) out.addPage(fcopied[j]);
  }
  var signedWord = rcp.completion === 'acknowledged' ? 'acknowledged by ' : 'signed by ';
  var when = rcp.completed_at ? new Date(rcp.completed_at) : null;
  var whenTxt = when ? when.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' }) : '';
  await stampPages(out, function (i) {
    if (i < sigPages || i >= docEnd) return pdfSafe('Generated by Nova ' + stamp(new Date()));
    return pdfSafe(txt(memo.memo_no) + ' - ' + signedWord + txt(rcp.user_name) + (whenTxt ? ' ' + whenTxt : ''));
  });
  out.setTitle(pdfSafe(txt(memo.memo_no) + ' ' + txt(memo.title) + ' - ' + txt(rcp.user_name)));
  out.setProducer('Nova');
  return Buffer.from(await out.save());
}

// ---------------------------------------------------------------- status report

function statusOf(r) {
  if (r.excused_at) return 'Excused';
  if (r.completed_at) return r.completion === 'acknowledged' ? 'Acknowledged' : 'Signed';
  if (r.first_viewed_at) return 'Viewed, not ' + (r._needsSign ? 'signed' : 'acknowledged');
  return 'Not opened';
}

async function buildStatusReport(memo, recipients, opts) {
  opts = opts || {};
  var company = opts.company || {};
  var needsSign = memo.require_signature !== false;
  recipients = (recipients || []).map(function (r) { return Object.assign({}, r, { _needsSign: needsSign }); });
  var first = await render(function (doc) {
    var left = doc.page.margins.left;
    var w = doc.page.width - left - doc.page.margins.right;
    header(doc, company, 'MEMO STATUS REPORT', txt(memo.memo_no) + ' · as of ' + stamp(new Date()));
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(txt(memo.title), left, doc.y, { width: w });
    doc.moveDown(0.3);
    var total = recipients.length;
    var excused = recipients.filter(function (r) { return r.excused_at; }).length;
    var done = recipients.filter(function (r) { return r.completed_at; }).length;
    var viewed = recipients.filter(function (r) { return r.first_viewed_at; }).length;
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(
      'Sent ' + stamp(memo.sent_at) + ' by ' + txt(memo.sent_by_name) + '.  ' +
      'Sent to ' + total + ', viewed ' + viewed + ', ' + (needsSign ? 'signed ' : 'acknowledged ') + done +
      ', outstanding ' + (total - done - excused) + (excused ? ', excused ' + excused : '') + '.' +
      (memo.sign_by ? '  Due ' + longDate(dateOnly(memo.sign_by)) + '.' : ''),
      left, doc.y, { width: w });
    doc.moveDown(0.8);

    var cols = [
      { h: 'Employee', w: 0.25 }, { h: 'Location', w: 0.11 }, { h: 'Viewed', w: 0.19 },
      { h: needsSign ? 'Signed' : 'Acknowledged', w: 0.19 }, { h: 'Status', w: 0.26 }
    ];
    var xs = []; var acc = left;
    for (var c = 0; c < cols.length; c++) { xs.push(acc); acc += cols[c].w * w; }
    function head() {
      var y = doc.y;
      doc.save().rect(left, y - 3, w, 16).fill(SHADE).restore();
      for (var c2 = 0; c2 < cols.length; c2++) doc.font('Helvetica-Bold').fontSize(8).fillColor('#444444').text(cols[c2].h.toUpperCase(), xs[c2] + 3, y, { width: cols[c2].w * w - 6, lineBreak: false });
      doc.y = y + 17;
    }
    head();
    var order = { 'Not opened': 0 };
    recipients.sort(function (a, b) {
      var sa = statusOf(a), sb = statusOf(b);
      var ra = (order[sa] == null ? (sa.indexOf('Viewed') === 0 ? 1 : (sa === 'Excused' ? 3 : 2)) : 0);
      var rb = (order[sb] == null ? (sb.indexOf('Viewed') === 0 ? 1 : (sb === 'Excused' ? 3 : 2)) : 0);
      if (ra !== rb) return ra - rb;
      return String(a.user_name || '').localeCompare(String(b.user_name || ''));
    });
    for (var i = 0; i < recipients.length; i++) {
      var r = recipients[i];
      if (doc.y > doc.page.height - 70) { doc.addPage(); head(); }
      var y = doc.y;
      var cells = [txt(r.user_name), txt(r.user_city), r.first_viewed_at ? shortStamp(r.first_viewed_at) : '-', r.completed_at ? shortStamp(r.completed_at) : '-',
        statusOf(r) + (r.excused_reason ? ' (' + r.excused_reason + ')' : '')];
      for (var k = 0; k < cells.length; k++) doc.font(k === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(INK).text(cells[k], xs[k] + 3, y, { width: cols[k].w * w - 6, lineBreak: false, ellipsis: true });
      doc.save().moveTo(left, y + 13).lineTo(left + w, y + 13).lineWidth(0.4).strokeColor(RULE).stroke().restore();
      doc.y = y + 17;
    }
  });
  var lib = await LibDoc.load(first);
  await stampPages(lib, function () { return pdfSafe(txt(memo.memo_no) + ' status report - generated by Nova ' + stamp(new Date())); });
  return Buffer.from(await lib.save());
}

async function mergePdfs(buffers) {
  var out = await LibDoc.create();
  for (var i = 0; i < buffers.length; i++) {
    var src = await LibDoc.load(buffers[i], { ignoreEncryption: true });
    var pages = await out.copyPages(src, src.getPageIndices());
    for (var j = 0; j < pages.length; j++) out.addPage(pages[j]);
  }
  out.setProducer('Nova');
  return Buffer.from(await out.save());
}

// Page count of an uploaded PDF, or throws if it is not one pdf-lib can open.
async function pdfPageCount(buf) {
  var d = await LibDoc.load(buf, { ignoreEncryption: true });
  return d.getPageCount();
}

module.exports = {
  buildSignedCopy: buildSignedCopy,
  buildStatusReport: buildStatusReport,
  mergePdfs: mergePdfs,
  pdfPageCount: pdfPageCount,
  _stamp: stamp
};
