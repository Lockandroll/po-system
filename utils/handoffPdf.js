// Signed PDF for a vehicle assignment or turn-in sheet. Pure pdfkit.
//
// Drawn from the sheet row, never uploaded: header, the vehicle and readings, the
// damage diagram with its numbered marks (drawn from the same template data the
// page uses - utils/vehicleDiagram.js), the checklist, the photos, every
// agreement exactly as the driver saw it with their initials, and both
// signatures with time, location and device.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
var PDFDocument = require('pdfkit');
var VD = require('./vehicleDiagram');

var INK = '#111111';
var MUTED = '#6b6b6b';
var RULE = '#d9d9d9';
var ORANGE = '#f26522';
var BAR = '#141414';

function bufFromDataUrl(s) {
  if (!s) return null;
  var str = String(s);
  var idx = str.indexOf('base64,');
  try { return Buffer.from(idx !== -1 ? str.slice(idx + 7) : str, 'base64'); } catch (e) { return null; }
}

function fmtDate(d, withTime) {
  if (!d) return '-';
  try {
    var o = { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' };
    if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; }
    return new Date(d).toLocaleString('en-US', o) + (withTime ? ' ET' : '');
  } catch (e) { return String(d); }
}
function dateOnly(d) {
  if (!d) return '-';
  var s = (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  var p = s.split('-');
  if (p.length !== 3) return s;
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + ', ' + p[0];
}

var KIND_LABEL = {};
VD.DAMAGE_KINDS.forEach(function (k) { KIND_LABEL[k.key] = k.label; });
var REASON_LABEL = { reassignment: 'Reassignment', separation: 'Separation', shop: 'Vehicle to shop', sold_retired: 'Sold / retired', other: 'Other' };

function col(pal, name) { return (name && name !== 'none') ? (pal[name] || name) : null; }

// Draw one template shape with pdfkit, already inside the view transform.
function drawShape(doc, s, pal) {
  var fill = col(pal, s.fill), stroke = col(pal, s.stroke);
  var op = s.op == null ? 1 : s.op;
  if (s.t === 'text') {
    doc.fillColor(fill || MUTED).fontSize(s.size || 4).text(s.text, s.x - 20, s.y - (s.size || 4) * 0.8, { width: 40, align: 'center', lineBreak: false });
    return;
  }
  if (s.t === 'line') {
    doc.moveTo(s.x1, s.y1).lineTo(s.x2, s.y2).lineWidth(s.w || 0.4).strokeColor(stroke || MUTED).lineCap('round').stroke();
    return;
  }
  if (s.t === 'path') doc.path(s.d);
  else if (s.t === 'rect') doc.roundedRect(s.x, s.y, s.w, s.h, s.rx || 0);
  else if (s.t === 'circle') doc.circle(s.cx, s.cy, s.r);
  else return;
  var lw = s.t === 'rect' ? s.sw : (s.t === 'circle' ? s.sw : s.w);
  doc.fillOpacity(op).strokeOpacity(op);
  if (fill && stroke && lw) doc.lineWidth(lw).fillColor(fill).strokeColor(stroke).lineJoin('round').fillAndStroke();
  else if (fill) doc.fillColor(fill).fill();
  else if (stroke && lw) doc.lineWidth(lw).strokeColor(stroke).lineJoin('round').stroke();
  doc.fillOpacity(1).strokeOpacity(1);
}

function drawDiagram(doc, tpl, marks, left, top, width) {
  var pal = VD.PALETTES.paper;
  var vb = tpl.viewBox;
  var scale = width / vb[2];
  doc.save();
  doc.translate(left, top).scale(scale);
  Object.keys(tpl.views).forEach(function (key) {
    var v = tpl.views[key];
    doc.save();
    doc.translate(v.x, v.y);
    if (v.flip === -1) { doc.translate(tpl.mirrorWidth, 0); doc.scale(-1, 1); }
    (tpl.shapes[key] || []).forEach(function (s) { drawShape(doc, s, pal); });
    doc.restore();
  });
  (tpl.labels || []).forEach(function (l) {
    doc.fillColor(pal.label).fontSize(5).text(l[0], l[1] - 40, l[2] - 4.5, { width: 80, align: 'center', lineBreak: false, characterSpacing: 0.6 });
  });
  (marks || []).forEach(function (m) {
    var p = VD.toCanvas(tpl, m.view, Number(m.x), Number(m.y));
    if (!p) return;
    var c = VD.MARK_COLORS[m.state] || VD.MARK_COLORS.existing;
    if (m.state === 'new' || m.change === 'worse') doc.circle(p.x, p.y, 8).lineWidth(1).strokeColor(VD.MARK_COLORS.new).stroke();
    doc.circle(p.x, p.y, 5.2).lineWidth(0.8).fillColor(c).strokeColor('#222222').fillAndStroke();
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(5.6).text(String(m.mark_no), p.x - 6, p.y - 2.9, { width: 12, align: 'center', lineBreak: false });
    doc.font('Helvetica');
  });
  doc.restore();
  return vb[3] * scale;
}

function sectionTitle(doc, text) {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.moveDown(0.6);
  var y = doc.y;
  doc.rect(40, y + 2, 4, 12).fill(ORANGE);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(text, 50, y, { lineBreak: false });
  doc.font('Helvetica');
  doc.y = y + 20;
}

function kv(doc, pairs, cols) {
  cols = cols || 3;
  var w = (doc.page.width - 80) / cols;
  var y = doc.y;
  pairs.forEach(function (p, i) {
    var c = i % cols;
    if (i && c === 0) y += 34;
    var x = 40 + c * w;
    doc.fillColor(MUTED).fontSize(8).text(String(p[0]).toUpperCase(), x, y, { width: w - 10, characterSpacing: 0.4 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(p[1] == null || p[1] === '' ? '-' : String(p[1]), x, y + 11, { width: w - 10, ellipsis: true, height: 14 });
    doc.font('Helvetica');
  });
  doc.y = y + 38;
}

function ensure(doc, h) { if (doc.y + h > doc.page.height - 50) doc.addPage(); }

async function fetchPhotos(photos) {
  var r2 = null;
  try { r2 = require('./r2'); } catch (e) { r2 = null; }
  var out = [];
  for (var i = 0; i < photos.length; i++) {
    var p = photos[i];
    if (p.status !== 'ready') continue;
    var buf = null;
    try { if (r2 && r2.configured && r2.configured()) buf = await r2.getObjectBuffer(p.r2_key); } catch (e) { buf = null; }
    out.push({ photo: p, buf: buf });
  }
  return out;
}

function build(sheet, opts) {
  opts = opts || {};
  var tpl = opts.template || VD.getTemplate(sheet.v_body_type);
  var marks = opts.marks || [];
  var agreements = opts.agreements || [];
  var prior = (sheet.kind === 'turn_in' && opts.prior) ? opts.prior : null;
  return Promise.all([fetchPhotos(opts.photos || []), fetchPhotos(prior ? (prior.photos || []) : [])]).then(function (both) {
    var photoBufs = both[0], priorBufs = both[1];
    return new Promise(function (resolve, reject) {
      try {
        var doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true, info: { Title: sheet.handoff_number + ' ' + (sheet.kind === 'assign' ? 'Vehicle Assignment' : 'Vehicle Turn-In') } });
        var chunks = [];
        doc.on('data', function (c) { chunks.push(c); });
        doc.on('end', function () { resolve(Buffer.concat(chunks)); });
        doc.on('error', reject);
        var W = doc.page.width;

        // Header bar
        doc.rect(0, 0, W, 64).fill(BAR);
        doc.rect(40, 18, 28, 28).fill(ORANGE);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(sheet.kind === 'assign' ? 'VEHICLE ASSIGNMENT' : 'VEHICLE TURN-IN', 80, 20, { lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor('#bbbbbb').text('Lock and Roll LLC', 80, 40, { lineBreak: false });
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13).text(sheet.handoff_number, W - 240, 20, { width: 200, align: 'right' });
        doc.font('Helvetica').fontSize(9).fillColor('#bbbbbb').text('Completed ' + fmtDate(sheet.completed_at, true), W - 240, 40, { width: 200, align: 'right' });
        doc.y = 80;

        var vName = [sheet.v_year, sheet.v_make_model].filter(Boolean).join(' ');
        var pairs = [
          ['Vehicle', vName], ['VIN', sheet.v_vin], ['Plate', sheet.v_plate],
          ['Driver', sheet.driver_name], ['Effective date', dateOnly(sheet.effective_date)], ['City', sheet.city_code || sheet.v_city],
          ['Odometer', sheet.odometer != null ? Number(sheet.odometer).toLocaleString('en-US') + ' mi' : '-'], ['Fuel', sheet.fuel_level], ['Filled out by', sheet.filled_by === 'manager' ? 'Manager, in person' : 'Driver'],
          ['Started by', sheet.created_by_name], ['Countersigned by', sheet.manager_name], ['Key codes', sheet.v_key_codes]
        ];
        if (sheet.kind === 'turn_in') {
          pairs.push(['Reason', REASON_LABEL[sheet.reason] || sheet.reason]);
          pairs.push(['After turn-in', sheet.after_turn_in === 'reassign' ? ('Reassigned to ' + (sheet.reassign_to_name || '-')) : 'Returned to pool']);
          if (prior) {
            pairs.push(['At assignment', prior.handoff_number + (prior.odometer != null ? ', ' + Number(prior.odometer).toLocaleString('en-US') + ' mi' : '') + (prior.fuel_level ? ', fuel ' + prior.fuel_level : '')]);
            if (prior.odometer != null && sheet.odometer != null) pairs.push(['Miles driven', (Number(sheet.odometer) - Number(prior.odometer)).toLocaleString('en-US') + ' mi']);
          }
        }
        kv(doc, pairs, 3);
        if (sheet.driver_not_present) {
          ensure(doc, 40);
          var dy = doc.y;
          doc.rect(40, dy, W - 80, 30).fill('#fdecea');
          doc.fillColor('#a02622').font('Helvetica-Bold').fontSize(10).text('Driver not present. ', 50, dy + 9, { continued: true }).font('Helvetica').text(sheet.driver_not_present_reason || '');
          doc.y = dy + 40;
        }

        // Keep the heading with the drawing, and measure from a saved top: the
        // labels and mark numbers are drawn with text() inside the scaled
        // transform, which moves doc.y to a meaningless spot.
        ensure(doc, 440);
        sectionTitle(doc, 'Damage');
        var dTop = doc.y;
        var h = drawDiagram(doc, tpl, marks, 40, dTop, W - 80);
        doc.y = dTop + h + 6;
        var legend = [['Existing', VD.MARK_COLORS.existing], ['New at turn-in', VD.MARK_COLORS.new], ['Added by driver', VD.MARK_COLORS.driver], ['Repaired', VD.MARK_COLORS.repaired]];
        var lx = 40, ly = doc.y;
        legend.forEach(function (l) {
          doc.circle(lx + 4, ly + 4, 4).fill(l[1]);
          doc.fillColor(MUTED).fontSize(8).text(l[0], lx + 11, ly, { lineBreak: false });
          lx += 100;
        });
        doc.y = ly + 16;
        if (!marks.length) {
          doc.fillColor(INK).fontSize(10).text('No damage recorded.', 40, doc.y);
        } else {
          marks.forEach(function (m) {
            ensure(doc, 18);
            var y = doc.y;
            var stateTxt = m.status === 'repaired' ? 'Repaired' : (m.change === 'worse' ? 'Got worse' : (m.state === 'new' ? 'New' : 'Existing'));
            doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text('#' + m.mark_no, 40, y, { width: 28, lineBreak: false });
            doc.font('Helvetica').text((KIND_LABEL[m.kind] || m.kind) + ' - ' + (m.severity || '') + (m.location ? ' - ' + m.location : ''), 70, y, { width: 330 });
            var endY = doc.y;
            doc.fillColor(MUTED).fontSize(9).text(stateTxt + ((m.note || m.change_note) ? ': ' + (m.change_note || m.note) : ''), 405, y, { width: W - 445 });
            doc.y = Math.max(endY, doc.y) + 3;
          });
        }

        sectionTitle(doc, sheet.kind === 'assign' ? 'Equipment checklist' : 'Returned items');
        (sheet.checklist || []).forEach(function (c) {
          ensure(doc, 16);
          var y = doc.y;
          var st = c.state === 'present' ? (sheet.kind === 'assign' ? 'Present' : 'Returned') : (c.state === 'missing' ? 'Missing' : 'Not answered');
          doc.fillColor(INK).fontSize(10).text(c.label + (c.value ? ' (' + c.value + ')' : ''), 40, y, { width: 330 });
          doc.fillColor(c.state === 'missing' ? '#c0392b' : (c.state === 'present' ? '#1e7b43' : MUTED)).font('Helvetica-Bold').text(st, 380, y, { width: 90, lineBreak: false });
          doc.font('Helvetica');
          if (c.note) doc.fillColor(MUTED).fontSize(9).text(c.note, 470, y, { width: W - 510 });
          doc.y = Math.max(doc.y, y + 15);
        });
        if (sheet.driver_note) { doc.moveDown(0.3); doc.fillColor(MUTED).fontSize(9).text('Driver note: ' + sheet.driver_note, 40, doc.y, { width: W - 80 }); }

        if (photoBufs.length && prior) {
          // Turn-in: each angle beside the same angle from the assignment it closes.
          ensure(doc, 230);
          sectionTitle(doc, 'Photos: at assignment (' + prior.handoff_number + ') vs. now');
          var bw = (W - 80 - 14) / 2, bh = bw * 0.6;
          var byKey = {};
          priorBufs.forEach(function (pb) { if (pb.photo.slot_key && !byKey[pb.photo.slot_key]) byKey[pb.photo.slot_key] = pb; });
          photoBufs.forEach(function (pb) {
            ensure(doc, bh + 34);
            var y = doc.y;
            doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(pb.photo.slot_label || pb.photo.slot_key || 'Photo', 40, y, { width: W - 80, lineBreak: false });
            doc.font('Helvetica');
            var iy = y + 13;
            var before = byKey[pb.photo.slot_key];
            [[before, 40, 'At assignment'], [pb, 40 + bw + 14, 'Turn-in']].forEach(function (cell) {
              var c = cell[0], x = cell[1];
              doc.rect(x, iy, bw, bh).fill('#f1f1f1');
              if (c && c.buf) { try { doc.image(c.buf, x, iy, { fit: [bw, bh], align: 'center', valign: 'center' }); } catch (e) { /* unreadable image */ } }
              if (!c) doc.fillColor(MUTED).fontSize(8.5).text('No photo on the assignment sheet', x, iy + bh / 2 - 5, { width: bw, align: 'center', lineBreak: false });
              doc.fillColor(MUTED).fontSize(7.5).text(cell[2] + (c ? ' - ' + fmtDate(c.photo.captured_at, true) : ''), x, iy + bh + 3, { width: bw, lineBreak: false });
            });
            doc.y = iy + bh + 16;
          });
        } else if (photoBufs.length) {
          sectionTitle(doc, 'Photos');
          var pw = (W - 80 - 20) / 3, ph = pw * 0.66;
          var i = 0;
          photoBufs.forEach(function (pb) {
            if (i % 3 === 0) ensure(doc, ph + 30);
            var x = 40 + (i % 3) * (pw + 10);
            var y = doc.y;
            doc.rect(x, y, pw, ph).fill('#f1f1f1');
            if (pb.buf) { try { doc.image(pb.buf, x, y, { fit: [pw, ph], align: 'center', valign: 'center' }); } catch (e) { /* unreadable image */ } }
            doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5).text(pb.photo.slot_label || pb.photo.slot_key || 'Photo', x, y + ph + 3, { width: pw, lineBreak: false });
            doc.font('Helvetica').fillColor(MUTED).fontSize(7.5).text('Taken ' + fmtDate(pb.photo.captured_at, true), x, y + ph + 13, { width: pw, lineBreak: false });
            i++;
            if (i % 3 === 0) doc.y = y + ph + 28; else doc.y = y;
          });
          if (i % 3 !== 0) doc.y = doc.y + ph + 28;
        }

        agreements.forEach(function (a) {
          sectionTitle(doc, a.agreement_name + ' (v' + a.version + ')');
          (a.statements || []).forEach(function (st) {
            var initials = (a.initials || {})[st.key] || '';
            var textH = doc.heightOfString(st.body, { width: W - 150, fontSize: 9.5 }) + 18;
            ensure(doc, textH + 6);
            var y = doc.y;
            doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(st.title, 40, y, { width: W - 150 });
            doc.font('Helvetica').fillColor('#333333').fontSize(9.5).text(st.body, 40, doc.y + 1, { width: W - 150 });
            var endY = doc.y;
            doc.rect(W - 100, y, 60, 26).lineWidth(0.8).strokeColor(RULE).stroke();
            doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(initials || (sheet.driver_not_present ? 'n/a' : ''), W - 100, y + 7, { width: 60, align: 'center', lineBreak: false });
            doc.font('Helvetica');
            doc.y = Math.max(endY, y + 28) + 6;
          });
        });

        ensure(doc, 170);   // heading and both signature boxes stay together
        sectionTitle(doc, 'Signatures');
        var sy = doc.y, half = (W - 100) / 2;
        function sigBlock(x, label, name, dataUrl, when, extra) {
          doc.fillColor(MUTED).fontSize(8).text(label.toUpperCase(), x, sy, { width: half, characterSpacing: 0.4 });
          doc.rect(x, sy + 12, half, 60).lineWidth(0.8).strokeColor(RULE).stroke();
          var img = bufFromDataUrl(dataUrl);
          if (img) { try { doc.image(img, x + 6, sy + 16, { fit: [half - 12, 52], align: 'left', valign: 'center' }); } catch (e) { /* bad image */ } }
          doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(name || '-', x, sy + 78, { width: half });
          doc.font('Helvetica').fillColor(MUTED).fontSize(8.5).text(when, x, sy + 92, { width: half });
          if (extra) doc.text(extra, x, sy + 104, { width: half });
        }
        if (sheet.driver_not_present) {
          doc.fillColor(MUTED).fontSize(8).text('DRIVER', 40, sy);
          doc.fillColor(INK).fontSize(10).text('Driver not present: ' + (sheet.driver_not_present_reason || ''), 40, sy + 14, { width: half });
        } else {
          var gps = (sheet.driver_gps_lat != null && sheet.driver_gps_lon != null) ? ('Location ' + Number(sheet.driver_gps_lat).toFixed(5) + ', ' + Number(sheet.driver_gps_lon).toFixed(5)) : 'Location not shared';
          sigBlock(40, 'Driver', sheet.driver_name, sheet.driver_signature, 'Signed ' + fmtDate(sheet.driver_signed_at, true) + ' on their own Nova login', gps + (sheet.driver_ip ? ' - IP ' + sheet.driver_ip : ''));
        }
        sigBlock(60 + half, 'Manager', sheet.manager_name, sheet.manager_signature, 'Countersigned ' + fmtDate(sheet.manager_signed_at, true), null);
        doc.y = sy + 124;

        // Footer on every page
        var range = doc.bufferedPageRange();
        for (var pi = range.start; pi < range.start + range.count; pi++) {
          doc.switchToPage(pi);
          // Writing below the bottom margin makes pdfkit start a new page; lift
          // the margin for the footer line only.
          var oldBottom = doc.page.margins.bottom;
          doc.page.margins.bottom = 0;
          doc.fillColor(MUTED).fontSize(7.5).text(sheet.handoff_number + ' - ' + vName + ' - page ' + (pi + 1) + ' of ' + range.count, 40, doc.page.height - 30, { width: W - 80, align: 'center', lineBreak: false });
          doc.page.margins.bottom = oldBottom;
        }
        doc.end();
      } catch (e) { reject(e); }
    });
  });
}

module.exports = { build: build, drawDiagram: drawDiagram };
