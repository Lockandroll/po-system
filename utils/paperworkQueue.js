'use strict';
/*
 * Completion Paperwork - the queue, readiness and preview  (Nova)
 * --------------------------------------------------------------
 * Read-only assembly for the Completion Paperwork page. Given a finished
 * national-account job (a work order whose sign-off trip group has a finished
 * invoice) it computes:
 *   - which jobs sit in each tab (needs review / ready / sent / held)
 *   - per-job readiness (final trip signed, finished invoice, sign-offs, photos)
 *   - the resolved recipients (account To/Cc + the standing internal Cc)
 *   - the attachment manifest and an estimated package size for the size guard
 *   - the subject and a professional body preview
 *
 * PHASE 2: nothing here sends. The actual send (Send now + the 5 PM cron) is
 * built on top of resolveRecipients/subjectFor/bodyHtmlFor in a later phase.
 *
 * The "job" is a work_orders row. Its trip group is COALESCE(sf.trip_group_id,
 * sf.id) of the sign-off sheet it points at; the finished invoice is the one
 * whose signoff_group_id equals that group.
 *
 * NOTE: no backtick/template-literal strings (Windows-safe per Nova rules).
 */

const { pool } = require('../db');
const SET = require('./paperworkSettings');

const FINISHED = "('paid','partially_refunded','refunded')";

function money(v) { return '$' + (parseFloat(v) || 0).toFixed(2); }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The one query behind the whole page. Returns every job that is either sitting
// in the queue (a finished job on a paperwork account) or already moved through
// it (ready / sent / held). Buckets are decided in JS from paperwork_state.
async function fetchRows(whereExtra, params) {
  const sql =
    'WITH base AS (' +
    '  SELECT wo.id AS work_order_id, wo.wo_number, wo.po_number, wo.account_id,' +
    "         COALESCE(NULLIF(wo.account_name, ''), v.name) AS account_name," +
    '         wo.store_name, wo.store_number, wo.city_state_zip, wo.status AS wo_status,' +
    '         wo.paperwork_state, wo.paperwork_ready_at, wo.paperwork_sent_at, wo.paperwork_last_error,' +
    '         wo.signoff_id, COALESCE(sf.trip_group_id, sf.id) AS trip_group, sf.completed_at AS sf_completed_at,' +
    '         wo.checkin_required, wo.checkout_required, wo.checked_in_at, wo.checked_out_at, wo.paperwork_overrides,' +
    "         v.name AS account_vname, v.send_completion, COALESCE(v.completion_delivery, 'email') AS delivery_method," +
    '         COALESCE(NULLIF(v.completion_portal_url, \'\'), v.website) AS portal_url' +
    '  FROM work_orders wo' +
    '  JOIN vendors v ON v.id = wo.account_id' +
    '  LEFT JOIN signoff_forms sf ON sf.id = wo.signoff_id' +
    '  WHERE v.send_completion = true' +
    ') ' +
    'SELECT b.*,' +
    '  (SELECT COUNT(*) FROM signoff_forms s2 WHERE COALESCE(s2.trip_group_id, s2.id) = b.trip_group) AS trips_total,' +
    "  (SELECT COUNT(*) FROM signoff_forms s2 WHERE COALESCE(s2.trip_group_id, s2.id) = b.trip_group AND s2.status = 'completed') AS trips_signed," +
    '  (SELECT COUNT(*) FROM signoff_photos p JOIN signoff_forms s3 ON s3.id = p.form_id WHERE COALESCE(s3.trip_group_id, s3.id) = b.trip_group) AS photo_count,' +
    '  (SELECT last_event FROM paperwork_sends pz WHERE pz.work_order_id = b.work_order_id ORDER BY pz.id DESC LIMIT 1) AS last_event,' +
    '  (SELECT delivered_at FROM paperwork_sends pz WHERE pz.work_order_id = b.work_order_id ORDER BY pz.id DESC LIMIT 1) AS delivered_at,' +
    '  (SELECT MAX(s4.completed_at) FROM signoff_forms s4 WHERE COALESCE(s4.trip_group_id, s4.id) = b.trip_group) AS last_trip_completed_at,' +
    '  inv.id AS invoice_id, inv.invoice_number, inv.grand_total, inv.status AS invoice_status, inv.completed_at AS invoice_completed_at, inv.billed_at ' +
    'FROM base b ' +
    'LEFT JOIN LATERAL (' +
    '  SELECT id, invoice_number, grand_total, status, completed_at, billed_at FROM invoices' +
    '  WHERE signoff_group_id = b.trip_group AND status IN ' + FINISHED +
    '  ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1' +
    ') inv ON true ' +
    'WHERE ' + whereExtra + ' ' +
    'ORDER BY b.sf_completed_at DESC NULLS LAST, b.work_order_id DESC';
  const { rows } = await pool.query(sql, params || []);
  return rows;
}

// Check-in / check-out proof (Tony 2026-09-24). Accounts that make the tech
// call in often reject a bill that has no check-in on file. Driven by what the
// work-order parser concluded (checkin_required / checkout_required = 'yes')
// and the stamps utils/checkinEngine.js writes when a check-in confirms.
// A WARNING, not a block: a tech who called the line from his own phone has a
// real check-in Nova never saw, and the liaison can still send once satisfied.
function checkinStatus(r) {
  const inReq = String(r.checkin_required || '').toLowerCase() === 'yes';
  const outReq = String(r.checkout_required || '').toLowerCase() === 'yes';
  const inDone = !!r.checked_in_at, outDone = !!r.checked_out_at;
  return {
    in_required: inReq, out_required: outReq, in_done: inDone, out_done: outDone,
    applies: inReq || outReq,
    ok: (!inReq || inDone) && (!outReq || outDone)
  };
}

function readiness(r) {
  const finalTripSigned = r.wo_status === 'job_completed' || r.wo_status === 'paperwork_sent';
  const invoiceFinished = !!r.invoice_id;
  return {
    final_trip_signed: finalTripSigned,
    invoice_finished: invoiceFinished,
    trips_total: Number(r.trips_total || 0),
    trips_signed: Number(r.trips_signed || 0),
    photo_count: Number(r.photo_count || 0),
    checkin: checkinStatus(r),
    blocked: !invoiceFinished,
    ready: finalTripSigned && invoiceFinished
  };
}

// "WINGSTOP#02637" + "02637" printed "WINGSTOP#02637, #02637". Drop the store
// number when the store name already carries it, and show one number when the
// PO and WO are the same (Bass Security uses the WO as the PO).
function locationText(job) {
  const name = String(job.store_name || '').trim();
  const num = String(job.store_number || '').trim();
  const numPart = (num && name.replace(/\s+/g, '').indexOf(num.replace(/\s+/g, '')) === -1) ? '#' + num : '';
  const storeBit = [name, numPart].filter(Boolean).join(' ');
  return [storeBit, String(job.city_state_zip || '').trim()].filter(Boolean).join(', ');
}
function poWoText(job) {
  const po = String(job.po_number || '').trim(), wo = String(job.wo_number || '').trim();
  if (po && wo && po !== wo) return po + ' / ' + wo;
  return po || wo;
}

// Service details for the email body: the date(s) on site, who did it, and a
// short line of what was done, taken from the sign-off sheets.
function fmtDay(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}
function serviceDetails(sheets) {
  const days = [], seenDay = {}, techs = [], seenTech = {};
  const works = [], seenWork = {};
  (sheets || []).forEach(function (s) {
    const d = fmtDay(s.signed_at || s.completed_at);
    if (d && !seenDay[d]) { seenDay[d] = 1; days.push(d); }
    String(s.technician_names || '').split(/[,;\n]+/).forEach(function (t) {
      const n = t.trim();
      if (n && !seenTech[n.toLowerCase()]) { seenTech[n.toLowerCase()] = 1; techs.push(n); }
    });
    const w = String(s.work_description || '').trim();
    if (w && !seenWork[w.toLowerCase()]) { seenWork[w.toLowerCase()] = 1; works.push(w); }
  });
  // One line per trip's description, in trip order.
  let work = works.join(' / ');
  if (work.length > 400) work = work.slice(0, 397).replace(/\s+\S*$/, '') + '...';
  return { dates: days.join('; '), date_count: days.length, technicians: techs.join(', '), tech_count: techs.length, work: work };
}

// Business days between a start and now (America/New_York), not counting the
// start day, weekends, or anything in the holidays table. Completed Friday,
// looked at Monday = 1.
function etDateKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function businessDaysSince(start, holidaySet, now) {
  if (!start) return 0;
  const s = new Date(start);
  if (isNaN(s.getTime())) return 0;
  const endKey = etDateKey(now || new Date());
  // walk calendar days in UTC-noon steps from the ET start date
  const k = etDateKey(s).split('-');
  let cur = new Date(Date.UTC(+k[0], +k[1] - 1, +k[2], 12));
  let n = 0, guard = 0;
  while (guard++ < 400) {
    cur = new Date(cur.getTime() + 86400000);
    const key = cur.toISOString().slice(0, 10);
    if (key > endKey) break;
    const dow = cur.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (holidaySet && holidaySet[key]) continue;
    n++;
  }
  return n;
}
async function holidaySet() {
  const out = {};
  try {
    const r = await pool.query("SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM holidays WHERE holiday_date >= CURRENT_DATE - 400");
    r.rows.forEach(function (x) { out[x.d] = 1; });
  } catch (e) {}
  return out;
}

function rowOut(r) {
  return {
    work_order_id: r.work_order_id,
    wo_number: r.wo_number, po_number: r.po_number,
    account_id: r.account_id, account_name: r.account_name,
    store_name: r.store_name, store_number: r.store_number, city_state_zip: r.city_state_zip,
    wo_status: r.wo_status, paperwork_state: r.paperwork_state,
    paperwork_ready_at: r.paperwork_ready_at, paperwork_sent_at: r.paperwork_sent_at,
    paperwork_last_error: r.paperwork_last_error,
    delivery: r.last_event || null, delivered_at: r.delivered_at || null,
    trip_group: r.trip_group, completed_at: r.sf_completed_at,
    invoice_id: r.invoice_id, invoice_number: r.invoice_number,
    grand_total: r.grand_total, invoice_status: r.invoice_status,
    billed_at: r.billed_at || null,
    delivery_method: r.delivery_method === 'portal' ? 'portal' : 'email',
    portal_url: r.portal_url || '',
    last_trip_completed_at: r.last_trip_completed_at || r.sf_completed_at || null,
    has_recipient_override: !!(r.paperwork_overrides && (Array.isArray(r.paperwork_overrides.to) || Array.isArray(r.paperwork_overrides.cc))),
    readiness: readiness(r)
  };
}

// The queue, bucketed for the four tabs.
async function listQueue() {
  const rows = await fetchRows(
    "( (b.wo_status IN ('job_completed','paperwork_sent')) OR b.paperwork_state <> 'none' )", []);
  const out = { needs_review: [], ready: [], sent: [], held: [] };
  const hol = await holidaySet();
  const staleDays = await SET.staleDays();
  const now = new Date();
  rows.forEach(function (r) {
    const o = rowOut(r);
    o.age_bdays = businessDaysSince(o.last_trip_completed_at, hol, now);
    o.stale = staleDays > 0 && o.age_bdays >= staleDays;
    const st = o.paperwork_state;
    if (st === 'ready') out.ready.push(o);
    else if (st === 'sent') out.sent.push(o);
    else if (st === 'held' || st === 'failed') out.held.push(o);
    else if (o.wo_status === 'job_completed') out.needs_review.push(o);
    else if (o.wo_status === 'paperwork_sent') out.sent.push(o);
  });
  // Stale only means something while the job is still waiting on a person.
  out.ready.concat(out.sent, out.held).forEach(function (o) { o.stale = false; });
  out.stale_days = staleDays;
  return out;
}

// Resolve who a job is emailed to. account row + settings object in, addresses
// out. The From needs a verified domain (handled at send); reply-to can be any
// real inbox.
function resolveRecipients(v, settings) {
  let to = SET.cleanEmails(v.completion_to);
  if (!to.length) to = SET.cleanEmails(v.ar_contact_email);
  const inTo = {};
  to.forEach(function (e) { inTo[e] = 1; });
  const ccRaw = SET.cleanEmails(v.completion_cc).concat(settings.completion_internal_cc || []);
  const cc = SET.cleanEmails(ccRaw).filter(function (e) { return !inTo[e]; });
  const replyTo = String(v.completion_reply_to || settings.completion_reply_to || '').trim();
  const from = String(settings.completion_from || '').trim();
  return { to: to, cc: cc, replyTo: replyTo, from: from };
}

// The account/settings recipients with a per-job override on top. Used by the
// review screen AND the send, so what the screen shows is what goes out.
function resolveWithOverrides(v, settings, overrides) {
  const base = resolveRecipients(v, settings);
  if (overrides && Array.isArray(overrides.to) && overrides.to.length) base.to = SET.cleanEmails(overrides.to);
  if (overrides && Array.isArray(overrides.cc)) base.cc = SET.cleanEmails(overrides.cc).filter(function (e) { return base.to.indexOf(e) === -1; });
  base.overridden = !!(overrides && ((Array.isArray(overrides.to) && overrides.to.length) || Array.isArray(overrides.cc)));
  return base;
}

function subjectFor(tmpl, ctx) {
  let s = String(tmpl || '');
  s = s.split('{po}').join(ctx.po || '');
  s = s.split('{invoice}').join(ctx.invoice || '');
  s = s.split('{account}').join(ctx.account || '');
  s = s.split('{wo}').join(ctx.wo || '');
  return s.trim();
}

// The professional body preview (also the body the send will use). company is
// {name,address,csz,phone,signature}.
function bodyHtmlFor(job, company) {
  const rows = [];
  function row(k, val) { rows.push('<tr><td style="padding:6px 12px;color:#6b7280;background:#f7f7f8;border:1px solid #e5e7eb">' + esc(k) + '</td><td style="padding:6px 12px;border:1px solid #e5e7eb">' + esc(val) + '</td></tr>'); }
  const po = String(job.po_number || '').trim(), wo = String(job.wo_number || '').trim();
  row('Account', job.account_name || '');
  row((po && wo && po !== wo) ? 'PO / WO #' : (po ? 'PO #' : 'WO #'), poWoText(job));
  row('Location', locationText(job));
  const svc = job.service || {};
  if (svc.dates) row('Service date' + (svc.date_count > 1 ? 's' : ''), svc.dates);
  if (svc.technicians) row('Technician' + (svc.tech_count > 1 ? 's' : ''), svc.technicians);
  if (svc.work) row('Work performed', svc.work);
  if (job.invoice_number) row('Invoice #', job.invoice_number);
  if (job.grand_total != null) row('Amount due', money(job.grand_total));
  const att = [];
  (job.manifest || []).forEach(function (m) {
    if (m.kind === 'photos') att.push('<li>' + m.count + ' job photo' + (m.count === 1 ? '' : 's') + '</li>');
    else att.push('<li>' + esc(m.name) + '</li>');
  });
  const sig = (company && company.signature) ? esc(company.signature).split('\n').join('<br>') :
    ('<strong>' + esc(company && company.name || 'Lock and Roll LLC') + '</strong><br>' +
     esc(company && company.address || '') + (company && company.csz ? '<br>' + esc(company.csz) : '') +
     (company && company.phone ? '<br>' + esc(company.phone) : ''));
  return '' +
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#1c1d21;font-size:14px;line-height:1.6">' +
    '<p>Good day,</p>' +
    '<p>Please find attached the completed service paperwork for the work order below. All trips for this job are complete and were signed off on site.</p>' +
    '<table style="border-collapse:collapse;margin:10px 0">' + rows.join('') + '</table>' +
    (att.length ? '<p style="margin-bottom:4px">Attached to this email:</p><ul style="margin-top:0">' + att.join('') + '</ul>' : '') +
    '<p>Please reply all to this message with any questions on this job.</p>' +
    '<p>Thank you,</p>' +
    '<p style="color:#374151">' + sig + '</p>' +
    '</div>';
}

// One job in full, for the review screen.
async function getJob(woId) {
  const rows = await fetchRows('b.work_order_id = $1', [woId]);
  if (!rows.length) return null;
  const r = rows[0];
  const o = rowOut(r);
  const grp = r.trip_group;

  const sheetsRes = await pool.query(
    'SELECT s.id, s.form_number, s.po_number, s.trip_number, s.status, s.work_complete, s.completed_at, s.signed_at, s.technician_names, s.work_description,' +
    '  (SELECT COUNT(*) FROM signoff_photos p WHERE p.form_id = s.id) AS photos,' +
    '  (SELECT COALESCE(SUM(LENGTH(image_data)),0) FROM signoff_photos p WHERE p.form_id = s.id) AS photo_chars ' +
    'FROM signoff_forms s WHERE COALESCE(s.trip_group_id, s.id) = $1 ORDER BY s.trip_number ASC NULLS FIRST, s.id ASC',
    [grp]);
  const sheets = sheetsRes.rows;

  const vRes = await pool.query('SELECT * FROM vendors WHERE id = $1', [r.account_id]);
  const v = vRes.rows[0] || {};
  const settings = await SET.getAll();
  const recipients = resolveWithOverrides(v, settings, r.paperwork_overrides || null);
  const accountRecipients = resolveRecipients(v, settings);

  // Company block for the signature.
  const csRes = await pool.query("SELECT key, value FROM settings WHERE key IN ('company_name','company_address','company_city_state_zip','company_phone')");
  const cmap = {}; csRes.rows.forEach(function (x) { try { cmap[x.key] = JSON.parse(x.value); } catch (e) { cmap[x.key] = x.value; } });
  const company = {
    name: cmap.company_name || 'Lock and Roll LLC',
    address: cmap.company_address || '',
    csz: cmap.company_city_state_zip || '',
    phone: cmap.company_phone || '',
    signature: settings.completion_signature || ''
  };

  // Attachment manifest + estimated size (photos are real bytes; PDFs are a
  // nominal estimate here and computed exactly at send time).
  const wantSo = v.completion_send_signoffs !== false;
  const wantInv = v.completion_send_invoice !== false;
  const wantPho = v.completion_send_photos !== false;
  const po = r.po_number || (sheets[0] && sheets[0].po_number) || '';
  const manifest = [];
  let estBytes = 0;
  if (wantSo) {
    sheets.forEach(function (s) {
      const tn = Number(s.trip_number || 1);
      manifest.push({ kind: 'signoff', id: s.id, name: 'PO ' + po + ' Sign Off' + (tn > 1 ? ' Trip ' + tn : '') + '.pdf', trip: tn, signed: s.status === 'completed' });
      estBytes += 120 * 1024;
    });
  }
  if (wantInv && r.invoice_id) { manifest.push({ kind: 'invoice', id: r.invoice_id, name: 'Invoice-' + (r.invoice_number || r.invoice_id) + '.pdf' }); estBytes += 60 * 1024; }
  let photoChars = 0; sheets.forEach(function (s) { photoChars += Number(s.photo_chars || 0); });
  const photoBytes = Math.round(photoChars * 0.72);
  const photoCount = Number(r.photo_count || 0);
  if (wantPho && photoCount > 0) { manifest.push({ kind: 'photos', count: photoCount, bytes: photoBytes }); estBytes += photoBytes; }

  const maxMb = await SET.maxAttachMb();
  const subject = subjectFor(settings.completion_subject_template, {
    po: po, invoice: r.invoice_number || '', account: o.account_name, wo: r.wo_number || ''
  });
  o.manifest = manifest;
  o.service = serviceDetails(sheets);
  o.age_bdays = businessDaysSince(o.last_trip_completed_at, await holidaySet(), new Date());
  const bodyHtml = bodyHtmlFor(o, company);

  // Send history for the Sent tab / Resend defaults.
  let sends = [];
  try {
    sends = (await pool.query(
      'SELECT ps.id, ps.kind, ps.status, ps.to_emails, ps.cc_emails, ps.subject, ps.portal_ref, ps.error, ps.last_event, ps.delivered_at, ps.created_at, u.name AS sent_by_name ' +
      'FROM paperwork_sends ps LEFT JOIN users u ON u.id = ps.sent_by WHERE ps.work_order_id = $1 ORDER BY ps.id DESC LIMIT 20', [woId])).rows;
  } catch (e) {}

  return {
    job: o,
    sheets: sheets.map(function (s) {
      return { id: s.id, form_number: s.form_number, trip_number: Number(s.trip_number || 1), status: s.status, work_complete: s.work_complete, completed_at: s.completed_at, photos: Number(s.photos || 0) };
    }),
    account: {
      id: v.id, name: v.name, ar_contact_email: v.ar_contact_email || '',
      completion_to: v.completion_to || '', completion_cc: v.completion_cc || '', completion_reply_to: v.completion_reply_to || '',
      send_signoffs: v.completion_send_signoffs !== false, send_invoice: v.completion_send_invoice !== false, send_photos: v.completion_send_photos !== false,
      delivery: v.completion_delivery === 'portal' ? 'portal' : 'email',
      portal_url: String(v.completion_portal_url || v.website || ''),
      net_days: v.net_days == null ? 30 : Number(v.net_days)
    },
    recipients: recipients,
    account_recipients: accountRecipients,
    sends: sends,
    internal_cc: settings.completion_internal_cc || [],
    manifest: manifest,
    photo_count: photoCount,
    size_bytes: estBytes,
    photo_bytes: photoBytes,
    max_mb: maxMb,
    subject: subject,
    body_html: bodyHtml
  };
}

module.exports = {
  listQueue: listQueue,
  getJob: getJob,
  resolveRecipients: resolveRecipients,
  resolveWithOverrides: resolveWithOverrides,
  serviceDetails: serviceDetails,
  locationText: locationText,
  poWoText: poWoText,
  checkinStatus: checkinStatus,
  businessDaysSince: businessDaysSince,
  holidaySet: holidaySet,
  fetchRows: fetchRows,
  rowOut: rowOut,
  subjectFor: subjectFor,
  bodyHtmlFor: bodyHtmlFor,
  readiness: readiness
};
