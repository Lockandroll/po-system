'use strict';
/*
 * Completion Paperwork - the send path  (Nova)
 * --------------------------------------------
 * Builds the completion package for one finished national-account job and
 * emails it to the account: one sign-off PDF per trip (with its photos), the
 * invoice PDF, and the job photos as separate images - exactly the shape of the
 * email Tony shared. Shared by Send now (routes/paperwork.js) and the 5 PM
 * batch (jobs/paperwork.js) so the button is a real rehearsal of the schedule.
 *
 * Safety:
 *   - claims a job (ready -> sending) before sending so two callers never send
 *     it twice; on success -> sent, on failure -> failed (never lost).
 *   - size guard: if the package is over the limit, the SEPARATE photos are
 *     dropped (they stay embedded in the sign-off PDFs, so nothing is lost) and
 *     the drop is recorded; only a package still over without them is held.
 *   - a failed send pushes and emails the admins and the liaison who queued it.
 *   - on success it flips work_orders.status job_completed -> paperwork_sent.
 *
 * NOTE: no backtick/template-literal strings (Windows-safe per Nova rules).
 */

const { pool } = require('../db');
const SET = require('./paperworkSettings');
const QUEUE = require('./paperworkQueue');
const { sendEmail, sendEmailDetailed } = require('./email');
const { buildSignoffPdf } = require('./signoffPdf');
const { buildInvoicePdf } = require('./invoicePdf');
const notify = require('./notify');
const push = require('./push');
const r2 = require('./r2');
let logAudit = function () {};
try { logAudit = require('./audit').logAudit; } catch (e) {}

// Customer copy strips COGS, same fields routes/invoices.js hides on the emailed
// invoice.
const LINE_COST_FIELDS = ['unit_cost', 'cost_unknown', 'cost_unknown_reason', 'cost_source'];
const INVOICE_COST_FIELDS = ['parts_cost_total', 'cogs_incomplete', 'cogs'];
function customerSafeInvoice(inv) { const o = Object.assign({}, inv || {}); INVOICE_COST_FIELDS.forEach(function (k) { delete o[k]; }); return o; }
function customerSafeLines(items) { return (items || []).map(function (it) { const o = Object.assign({}, it || {}); LINE_COST_FIELDS.forEach(function (k) { delete o[k]; }); return o; }); }

function stripDataUrl(s) { if (!s) return ''; return String(s).replace(/^data:[^;]+;base64,/, ''); }
function fileSafe(x) { return String(x == null ? '' : x).replace(/[\/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function b64Bytes(s) { return Math.floor((String(s || '').length * 3) / 4); }

async function loadCompany() {
  const cs = await pool.query("SELECT key, value FROM settings WHERE key IN ('company_name','company_address','company_city_state_zip','company_phone','logo')");
  const m = {}; cs.rows.forEach(function (r) { try { m[r.key] = JSON.parse(r.value); } catch (e) { m[r.key] = r.value; } });
  return { name: m.company_name || 'Lock and Roll LLC', address: m.company_address || '', csz: m.company_city_state_zip || '', phone: m.company_phone || '', logo: m.logo || '' };
}

async function loadForSend(woId) {
  const wr = await pool.query(
    'SELECT wo.*, COALESCE(sf.trip_group_id, sf.id) AS trip_group FROM work_orders wo ' +
    'LEFT JOIN signoff_forms sf ON sf.id = wo.signoff_id WHERE wo.id = $1', [woId]);
  if (!wr.rows.length) return null;
  const wo = wr.rows[0];
  const grp = wo.trip_group;
  const v = (await pool.query('SELECT * FROM vendors WHERE id = $1', [wo.account_id])).rows[0] || {};
  const sheets = (await pool.query(
    'SELECT * FROM signoff_forms WHERE COALESCE(trip_group_id, id) = $1 ORDER BY trip_number ASC NULLS FIRST, id ASC', [grp])).rows;
  const invoice = (await pool.query(
    "SELECT i.*, u.name AS locksmith_name_join FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id " +
    "WHERE i.signoff_group_id = $1 AND i.status IN ('paid','partially_refunded','refunded') " +
    'ORDER BY i.completed_at DESC NULLS LAST, i.id DESC LIMIT 1', [grp])).rows[0] || null;
  return { wo: wo, grp: grp, v: v, sheets: sheets, invoice: invoice };
}

// Lives in paperworkQueue so the review screen and the send agree.
function resolveWithOverrides(v, settings, overrides) { return QUEUE.resolveWithOverrides(v, settings, overrides); }

// Assemble every attachment, then apply the size guard. Returns
// { attachments, manifest, sizeBytes, droppedPhotos, over }.
async function buildAttachments(data, settings, overrides) {
  const v = data.v, sheets = data.sheets, invoice = data.invoice;
  const company = await loadCompany();
  const att = { want_signoffs: v.completion_send_signoffs !== false, want_invoice: v.completion_send_invoice !== false, want_photos: v.completion_send_photos !== false };
  if (overrides && overrides.attach) {
    if (overrides.attach.signoffs === false) att.want_signoffs = false;
    if (overrides.attach.invoice === false) att.want_invoice = false;
    if (overrides.attach.photos === false) att.want_photos = false;
  }
  const tripCount = sheets.length;
  const attachments = [];
  const photoAttachments = [];
  const manifest = [];
  const po = data.wo.po_number || (sheets[0] && sheets[0].po_number) || '';

  for (let i = 0; i < sheets.length; i++) {
    const form = sheets[i];
    const tn = Number(form.trip_number || 1);
    const suffix = tn > 1 ? (' Trip ' + tn) : '';
    const label = (tripCount > 1) ? ('Trip ' + tn + ' of ' + tripCount) : '';
    const photos = (await pool.query('SELECT id, image_data, caption FROM signoff_photos WHERE form_id = $1 ORDER BY id', [form.id])).rows;
    if (att.want_signoffs) {
      try {
        const buf = await buildSignoffPdf(form, photos, { company: company, completedBy: '', logo: company.logo || null, tripLabel: label });
        if (buf && buf.length) {
          const content = buf.toString('base64');
          attachments.push({ filename: fileSafe('PO ' + po + ' Sign Off' + suffix) + '.pdf', content: content });
          manifest.push({ kind: 'signoff', name: fileSafe('PO ' + po + ' Sign Off' + suffix) + '.pdf', bytes: buf.length });
        }
      } catch (e) { console.error('[paperwork] signoff PDF failed:', e && e.message); }
    }
    if (att.want_photos) {
      for (let j = 0; j < photos.length; j++) {
        const img = photos[j].image_data;
        if (!img) continue;
        const cap = photos[j].caption ? String(photos[j].caption) : ('Picture ' + (j + 1));
        photoAttachments.push({ filename: fileSafe('PO ' + po + ' ' + cap + suffix) + '.jpg', content: stripDataUrl(img) });
      }
    }
  }

  if (att.want_invoice && invoice) {
    try {
      const items = (await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position, id', [invoice.id])).rows;
      const invPhotos = [];
      try {
        const ph = (await pool.query("SELECT r2_key, caption FROM invoice_photos WHERE invoice_id = $1 AND show_in_print = true AND status = 'ready' ORDER BY position, id", [invoice.id])).rows;
        if (ph.length && r2.configured && r2.configured()) {
          for (const p of ph) { try { invPhotos.push({ buffer: await r2.getObjectBuffer(p.r2_key), caption: p.caption }); } catch (e) {} }
        }
      } catch (e) {}
      let refunds = [];
      try { refunds = (await pool.query("SELECT refund_number, amount, refund_date, status FROM invoice_refunds WHERE invoice_id = $1 AND status IN ('approved','processed') ORDER BY id", [invoice.id])).rows; } catch (e) {}
      // accountCopy: never "Paid" on a billed account's copy (Tony 2026-09-24).
      // Due date runs from when the account is billed (today on a first send,
      // the original billed_at on a resend).
      const acctCopy = { netDays: (v.net_days == null ? 30 : Number(v.net_days)), billedDate: invoice.billed_at || new Date() };
      const buf = await buildInvoicePdf(customerSafeInvoice(invoice), customerSafeLines(items), invPhotos, { company: company, refunds: refunds, accountCopy: acctCopy });
      if (buf && buf.length) {
        const name = 'Invoice-' + (invoice.invoice_number || invoice.id) + '.pdf';
        attachments.push({ filename: name, content: buf.toString('base64') });
        manifest.push({ kind: 'invoice', name: name, bytes: buf.length });
      }
    } catch (e) { console.error('[paperwork] invoice PDF failed:', e && e.message); }
  }

  // size guard
  const maxBytes = (await SET.maxAttachMb()) * 1048576;
  let droppedPhotos = 0;
  function total() {
    let t = 0;
    attachments.forEach(function (a) { t += b64Bytes(a.content); });
    photoAttachments.forEach(function (a) { t += b64Bytes(a.content); });
    return t;
  }
  // Keep dropping the largest separate photo until the package is under the
  // limit. Photos stay embedded in the sign-off PDFs, so nothing is lost.
  while (total() > maxBytes && photoAttachments.length) {
    let big = 0;
    for (let k = 1; k < photoAttachments.length; k++) { if (b64Bytes(photoAttachments[k].content) > b64Bytes(photoAttachments[big].content)) big = k; }
    photoAttachments.splice(big, 1);
    droppedPhotos++;
  }
  const finalAttachments = attachments.concat(photoAttachments);
  let sizeBytes = 0; finalAttachments.forEach(function (a) { sizeBytes += b64Bytes(a.content); });
  if (photoAttachments.length) manifest.push({ kind: 'photos', count: photoAttachments.length, bytes: photoAttachments.reduce(function (s, a) { return s + b64Bytes(a.content); }, 0) });
  const over = sizeBytes > maxBytes;
  return { attachments: finalAttachments, manifest: manifest, sizeBytes: sizeBytes, droppedPhotos: droppedPhotos, over: over, po: po };
}

async function recordSend(data, recipients, subject, built, status, error, actor, providerId, extra) {
  extra = extra || {};
  try {
    await pool.query(
      'INSERT INTO paperwork_sends (work_order_id, trip_group_id, invoice_id, account_id, to_emails, cc_emails, reply_to, subject, attachment_manifest, status, error, sent_by, provider_message_id, kind, portal_ref) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [data.wo.id, data.grp, data.invoice ? data.invoice.id : null, data.wo.account_id,
       recipients.to || [], recipients.cc || [], recipients.replyTo || null, subject,
       JSON.stringify(built.manifest || []), status, error || null, (actor && actor.id) ? actor.id : null, providerId || null,
       extra.kind || 'send', extra.portalRef || null]);
  } catch (e) { console.error('[paperwork] recordSend failed:', e && e.message); }
}

// First time the account receives the bill: stamp it so A/R ages from here
// (see ar_invoice_balances.due_on in db.js). Never moved by a resend.
async function stampBilled(invoiceId, via) {
  if (!invoiceId) return;
  try { await pool.query('UPDATE invoices SET billed_at = NOW(), billed_via = $2 WHERE id = $1 AND billed_at IS NULL', [invoiceId, via]); }
  catch (e) { console.error('[paperwork] stampBilled failed:', e && e.message); }
}

// Everything the email body needs, shared by send and resend.
async function composeFor(data, settings, built) {
  const wo = data.wo, v = data.v, invoice = data.invoice;
  const jobLike = {
    account_name: v.name || wo.account_name || '', po_number: wo.po_number || built.po || '', wo_number: wo.wo_number || '',
    store_name: wo.store_name || '', store_number: wo.store_number || '', city_state_zip: wo.city_state_zip || '',
    invoice_number: invoice.invoice_number || '', grand_total: invoice.grand_total, manifest: built.manifest,
    service: QUEUE.serviceDetails(data.sheets)
  };
  const subject = QUEUE.subjectFor(settings.completion_subject_template, { po: jobLike.po_number, invoice: jobLike.invoice_number, account: jobLike.account_name, wo: jobLike.wo_number });
  const company = await loadCompany();
  company.signature = settings.completion_signature || '';
  return { subject: subject, bodyHtml: QUEUE.bodyHtmlFor(jobLike, company) };
}

async function alertFailure(data, errMsg) {
  try {
    const po = data.wo.po_number ? ('PO ' + data.wo.po_number) : ('WO ' + (data.wo.wo_number || data.wo.id));
    const acct = data.v && data.v.name ? data.v.name : (data.wo.account_name || 'the account');
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    const rec = await notify.broadcastRecipients('paperwork_failed', "role IN ('admin','owner')");
    const emails = (rec.emails || []).slice();
    const userIds = (rec.userIds || []).slice();
    // Add the liaison who queued it.
    if (data.wo.paperwork_ready_by) {
      try {
        const u = (await pool.query('SELECT email FROM users WHERE id = $1', [data.wo.paperwork_ready_by])).rows[0];
        if (u && u.email && emails.indexOf(u.email) === -1) emails.push(u.email);
        if (userIds.indexOf(data.wo.paperwork_ready_by) === -1) userIds.push(data.wo.paperwork_ready_by);
      } catch (e) {}
    }
    try { await push.sendPushToUsers(userIds, { title: 'Completion paperwork failed', body: po + ' to ' + acct + ' did not send: ' + errMsg, url: base + '/?view=completion-paperwork&id=' + data.wo.id }); } catch (e) {}
    if (emails.length) {
      const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6">' +
        '<p><strong>Completion paperwork failed to send.</strong></p>' +
        '<p>' + po + ' to ' + acct + ' could not be emailed:</p>' +
        '<p style="color:#b91c1c">' + String(errMsg || '') + '</p>' +
        '<p>The job is waiting in Completion Paperwork under Held / Issues with a Retry.</p></div>';
      try { await sendEmail(emails, 'Completion paperwork failed: ' + po, html); } catch (e) {}
    }
  } catch (e) { console.error('[paperwork] alertFailure failed:', e && e.message); }
}

// Send (or dry-run) one job. opts: { actor, dryRun }.
async function sendJob(woId, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const data = await loadForSend(woId);
  if (!data) return { ok: false, error: 'Job not found' };
  const wo = data.wo, v = data.v, invoice = data.invoice;

  if (v.send_completion !== true) return { ok: false, error: 'This account is not set to receive completion paperwork' };
  // Portal accounts are submitted by hand ("Submitted in portal"), never
  // emailed, so the batch and Send now both refuse them.
  if (v.completion_delivery === 'portal') return { ok: false, error: 'This account takes paperwork through its portal. Upload it there, then click Submitted in portal.' };
  if (!(wo.status === 'job_completed' || wo.status === 'paperwork_sent')) return { ok: false, error: 'The job is not complete yet' };
  if (!invoice) return { ok: false, error: 'No finished invoice on this job yet' };

  const settings = await SET.getAll();
  const overrides = wo.paperwork_overrides || null;
  const recipients = resolveWithOverrides(v, settings, overrides);
  const built = await buildAttachments(data, settings, overrides);
  const composed = await composeFor(data, settings, built);
  const subject = composed.subject, bodyHtml = composed.bodyHtml;

  if (dryRun) {
    return { ok: true, dryRun: true, recipients: recipients, subject: subject, manifest: built.manifest, size_bytes: built.sizeBytes, dropped_photos: built.droppedPhotos, over: built.over };
  }

  // Claim so two senders never overlap.
  const claim = await pool.query(
    "UPDATE work_orders SET paperwork_state = 'sending' WHERE id = $1 AND paperwork_state IN ('none','ready','held','failed') RETURNING id", [woId]);
  if (!claim.rows.length) return { ok: false, skipped: true, error: 'Already sending or already sent' };

  if (!recipients.to.length) return await fail(woId, data, recipients, subject, built, 'No To address on the account', opts.actor);
  if (built.over) return await fail(woId, data, recipients, subject, built, 'Package is over the ' + settings.completion_max_attach_mb + ' MB limit even without the separate photos', opts.actor);
  if (!built.attachments.length) return await fail(woId, data, recipients, subject, built, 'Nothing to attach', opts.actor);

  let ok = false, errMsg = '', providerId = null;
  try {
    const sr = await sendEmailDetailed(recipients.to, subject, bodyHtml, recipients.cc, built.attachments, { from: recipients.from || undefined, replyTo: recipients.replyTo || undefined });
    ok = sr.ok; providerId = sr.id || null;
    if (!ok) errMsg = sr.error || 'The email provider did not accept the message';
  } catch (e) { ok = false; errMsg = (e && e.message) ? e.message : 'send error'; }

  if (!ok) return await fail(woId, data, recipients, subject, built, errMsg, opts.actor);

  await pool.query(
    "UPDATE work_orders SET paperwork_state = 'sent', paperwork_sent_at = NOW(), paperwork_last_error = NULL, " +
    "status = CASE WHEN status = 'job_completed' THEN 'paperwork_sent' ELSE status END WHERE id = $1", [woId]);
  await stampBilled(invoice.id, 'email');
  await recordSend(data, recipients, subject, built, 'sent', null, opts.actor, providerId, { kind: 'send' });
  try { await logAudit({ entity_type: 'paperwork', entity_id: woId, entity_number: String(wo.po_number || woId), action: 'sent', user_id: (opts.actor && opts.actor.id) || null, user_name: (opts.actor && opts.actor.name) || 'Scheduled batch', details: { to: recipients.to, cc: recipients.cc, dropped_photos: built.droppedPhotos } }); } catch (e) {}
  return { ok: true, sent: true, recipients: recipients, subject: subject, manifest: built.manifest, dropped_photos: built.droppedPhotos };
}

async function fail(woId, data, recipients, subject, built, errMsg, actor) {
  try {
    await pool.query("UPDATE work_orders SET paperwork_state = 'failed', paperwork_last_error = $2 WHERE id = $1", [woId, errMsg]);
  } catch (e) {}
  await recordSend(data, recipients, subject, built, 'failed', errMsg, actor);
  await alertFailure(data, errMsg);
  try { await logAudit({ entity_type: 'paperwork', entity_id: woId, entity_number: String(data.wo.po_number || woId), action: 'send_failed', user_id: (actor && actor.id) || null, user_name: (actor && actor.name) || 'Scheduled batch', details: { error: errMsg } }); } catch (e) {}
  return { ok: false, sent: false, error: errMsg };
}

// The batch: every job marked Ready, oldest first.
async function runBatch(opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const rows = (await pool.query(
    "SELECT wo.id FROM work_orders wo LEFT JOIN vendors v ON v.id = wo.account_id " +
    "WHERE wo.paperwork_state = 'ready' AND COALESCE(v.completion_delivery, 'email') <> 'portal' " +
    'ORDER BY wo.paperwork_ready_at ASC NULLS LAST, wo.id ASC')).rows;
  const results = [];
  for (const r of rows) {
    try { results.push(await sendJob(r.id, { actor: { name: 'Scheduled batch' }, dryRun: dryRun })); }
    catch (e) { results.push({ ok: false, error: (e && e.message) || 'error', id: r.id }); }
  }
  const sent = results.filter(function (x) { return x && x.sent; }).length;
  const failed = results.filter(function (x) { return x && !x.sent && !x.skipped && !x.dryRun; }).length;
  return { total: rows.length, sent: sent, failed: failed, dry_run: dryRun, results: results };
}

// Resend delivery webhook -> update the send row and, on a bounce, reopen the
// job so it shows in Held / Issues with a Retry and re-fires the alert. Only
// acts on rows whose provider_message_id matches a completion send; any other
// Nova email that reaches the webhook is ignored. See routes/inbound.js.
function bounceReason(d) {
  if (!d) return 'The recipient mail server rejected it';
  if (d.bounce && (d.bounce.message || d.bounce.subType || d.bounce.type)) return String(d.bounce.message || (d.bounce.type + '/' + d.bounce.subType));
  return String(d.reason || d.message || 'The recipient mail server rejected it');
}
function failReason(d) {
  if (!d) return 'The email provider could not send it';
  if (d.failed && (d.failed.reason || d.failed.message)) return String(d.failed.reason || d.failed.message);
  return String(d.reason || d.message || 'The email provider could not send it');
}
async function handleDeliveryEvent(type, emailId, evtData) {
  if (!emailId) return { ignored: true };
  const found = await pool.query('SELECT * FROM paperwork_sends WHERE provider_message_id = $1 ORDER BY id DESC LIMIT 1', [emailId]);
  if (!found.rows.length) return { ignored: true };
  const ps = found.rows[0];
  if (type === 'email.delivered') {
    await pool.query("UPDATE paperwork_sends SET last_event = 'delivered', delivered_at = NOW() WHERE id = $1", [ps.id]);
    return { ok: true, event: 'delivered' };
  }
  if (type === 'email.bounced') {
    const reason = bounceReason(evtData);
    await pool.query("UPDATE paperwork_sends SET last_event = 'bounced', bounced_at = NOW(), error = $2 WHERE id = $1", [ps.id, reason]);
    // A RESEND that bounces does not un-send the job: the original package
    // already reached the account. Only the first send moves it back to Issues.
    if ((ps.kind || 'send') === 'send') await pool.query("UPDATE work_orders SET paperwork_state = 'failed', paperwork_last_error = $2 WHERE id = $1 AND paperwork_state = 'sent'", [ps.work_order_id, 'Delivery bounced: ' + reason]);
    try { const d = await loadForSend(ps.work_order_id); if (d) await alertFailure(d, 'Delivery bounced: ' + reason); } catch (e) {}
    try { await logAudit({ entity_type: 'paperwork', entity_id: ps.work_order_id, action: 'bounced', details: { reason: reason } }); } catch (e) {}
    return { ok: true, event: 'bounced' };
  }
  if (type === 'email.failed') {
    const reason = failReason(evtData);
    await pool.query("UPDATE paperwork_sends SET last_event = 'failed', error = $2 WHERE id = $1", [ps.id, reason]);
    if ((ps.kind || 'send') === 'send') await pool.query("UPDATE work_orders SET paperwork_state = 'failed', paperwork_last_error = $2 WHERE id = $1 AND paperwork_state = 'sent'", [ps.work_order_id, 'Send failed: ' + reason]);
    try { const d = await loadForSend(ps.work_order_id); if (d) await alertFailure(d, 'Send failed: ' + reason); } catch (e) {}
    try { await logAudit({ entity_type: 'paperwork', entity_id: ps.work_order_id, action: 'send_failed', details: { reason: reason } }); } catch (e) {}
    return { ok: true, event: 'failed' };
  }
  if (type === 'email.complained') {
    await pool.query("UPDATE paperwork_sends SET last_event = 'complained' WHERE id = $1", [ps.id]);
    try { const d = await loadForSend(ps.work_order_id); if (d) await alertFailure(d, 'The recipient marked the completion email as spam'); } catch (e) {}
    return { ok: true, event: 'complained' };
  }
  if (type === 'email.delivery_delayed') {
    await pool.query("UPDATE paperwork_sends SET last_event = 'delayed' WHERE id = $1", [ps.id]);
    return { ok: true, event: 'delayed' };
  }
  return { ignored: true, type: type };
}

// One attachment, byte-for-byte what the email would carry right now: same
// loader, same buildAttachments (customer-safe invoice, trip labels, company
// block). Used by the "PDF" buttons on the job review screen (Tony 2026-09-24:
// "one for the exact pdf"). kind = 'signoff' (id = signoff_forms.id) or
// 'invoice'. Returns { filename, buffer } or null.
async function buildOnePdf(woId, kind, id) {
  const data = await loadForSend(woId);
  if (!data) return null;
  const settings = await SET.getAll();
  const only = { attach: { signoffs: kind === 'signoff', invoice: kind === 'invoice', photos: false } };
  if (kind === 'signoff') {
    // Build every trip so the "Trip N of M" label matches the real email, then
    // pick this sheet's file by the same name buildAttachments gives it.
    const sheet = data.sheets.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!sheet) return null;
    const built = await buildAttachments(data, settings, only);
    const tn = Number(sheet.trip_number || 1);
    const want = fileSafe('PO ' + built.po + ' Sign Off' + (tn > 1 ? (' Trip ' + tn) : '')) + '.pdf';
    const hit = built.attachments.filter(function (a) { return a.filename === want; })[0];
    return hit ? { filename: hit.filename, buffer: Buffer.from(hit.content, 'base64') } : null;
  }
  if (kind === 'invoice') {
    if (!data.invoice) return null;
    const built = await buildAttachments(data, settings, only);
    const hit = built.attachments.filter(function (a) { return /^Invoice-/.test(a.filename); })[0];
    return hit ? { filename: hit.filename, buffer: Buffer.from(hit.content, 'base64') } : null;
  }
  return null;
}

// Resend (Tony 2026-09-24): the same package, rebuilt now, to whatever address
// the account says it never got it at. Only for a job already sent. It does not
// touch the job's state or billed date; it adds a 'resend' row to the history.
async function resendJob(woId, opts) {
  opts = opts || {};
  const data = await loadForSend(woId);
  if (!data) return { ok: false, error: 'Job not found' };
  const wo = data.wo, invoice = data.invoice;
  if (!(wo.paperwork_state === 'sent' || wo.status === 'paperwork_sent')) return { ok: false, error: 'Only a job that has already been sent can be resent' };
  if (!invoice) return { ok: false, error: 'No finished invoice on this job' };
  const to = SET.cleanEmails(opts.to);
  if (!to.length) return { ok: false, error: 'Enter at least one To address' };
  const cc = SET.cleanEmails(opts.cc).filter(function (e) { return to.indexOf(e) === -1; });
  const settings = await SET.getAll();
  const base = resolveWithOverrides(data.v, settings, null);
  const recipients = { to: to, cc: cc, replyTo: base.replyTo, from: base.from };
  const built = await buildAttachments(data, settings, wo.paperwork_overrides || null);
  if (built.over) return { ok: false, error: 'Package is over the size limit even without the separate photos' };
  if (!built.attachments.length) return { ok: false, error: 'Nothing to attach' };
  const composed = await composeFor(data, settings, built);
  let sr;
  try {
    sr = await sendEmailDetailed(recipients.to, composed.subject, composed.bodyHtml, recipients.cc, built.attachments, { from: recipients.from || undefined, replyTo: recipients.replyTo || undefined });
  } catch (e) { sr = { ok: false, error: (e && e.message) || 'send error' }; }
  if (!sr || !sr.ok) {
    const err = (sr && sr.error) || 'The email provider did not accept the message';
    await recordSend(data, recipients, composed.subject, built, 'failed', err, opts.actor, null, { kind: 'resend' });
    return { ok: false, error: err };
  }
  await recordSend(data, recipients, composed.subject, built, 'sent', null, opts.actor, sr.id || null, { kind: 'resend' });
  try { await logAudit({ entity_type: 'paperwork', entity_id: woId, entity_number: String(wo.po_number || woId), action: 'resent', user_id: (opts.actor && opts.actor.id) || null, user_name: (opts.actor && opts.actor.name) || '', details: { to: to, cc: cc } }); } catch (e) {}
  return { ok: true, sent: true, recipients: recipients };
}

// Portal accounts (ServiceChannel, Corrigo, ...): the liaison uploads the PDFs
// in the account's portal and then records it here. Same end state as an email
// send: job -> sent / paperwork_sent, invoice billed_at stamped, history row.
async function markPortalSubmitted(woId, opts) {
  opts = opts || {};
  const data = await loadForSend(woId);
  if (!data) return { ok: false, error: 'Job not found' };
  const wo = data.wo, invoice = data.invoice;
  if (!(wo.status === 'job_completed' || wo.status === 'paperwork_sent')) return { ok: false, error: 'The job is not complete yet' };
  if (!invoice) return { ok: false, error: 'No finished invoice on this job yet' };
  const claim = await pool.query(
    "UPDATE work_orders SET paperwork_state = 'sent', paperwork_sent_at = NOW(), paperwork_last_error = NULL, " +
    "status = CASE WHEN status = 'job_completed' THEN 'paperwork_sent' ELSE status END " +
    "WHERE id = $1 AND paperwork_state IN ('none','ready','held','failed') RETURNING id", [woId]);
  if (!claim.rows.length) return { ok: false, skipped: true, error: 'Already sent' };
  await stampBilled(invoice.id, 'portal');
  const ref = String(opts.ref || '').trim().slice(0, 120);
  const portal = String(data.v.completion_portal_url || data.v.website || '');
  await recordSend(data, { to: [], cc: [], replyTo: '' }, 'Submitted in portal' + (portal ? ' (' + portal + ')' : ''), { manifest: [] }, 'sent', null, opts.actor, null, { kind: 'portal', portalRef: ref || null });
  try { await logAudit({ entity_type: 'paperwork', entity_id: woId, entity_number: String(wo.po_number || woId), action: 'portal_submitted', user_id: (opts.actor && opts.actor.id) || null, user_name: (opts.actor && opts.actor.name) || '', details: { ref: ref } }); } catch (e) {}
  return { ok: true };
}

// Stale-job reminder: every Needs Review job older than completion_stale_days
// business days, listed in one email to completion_stale_notify. Only runs on
// business days (jobs/paperwork.js decides when).
async function staleDigest(opts) {
  opts = opts || {};
  const settings = await SET.getAll();
  const days = settings.completion_stale_days;
  const to = settings.completion_stale_notify || [];
  if (!days) return { ok: true, skipped: 'off', jobs: [] };
  const q = await QUEUE.listQueue();
  const stale = (q.needs_review || []).filter(function (j) { return j.stale; })
    .sort(function (a, b) { return b.age_bdays - a.age_bdays; });
  if (opts.dryRun) return { ok: true, dryRun: true, to: to, jobs: stale };
  if (!stale.length) return { ok: true, sent: false, jobs: [] };
  if (!to.length) return { ok: true, sent: false, skipped: 'no recipients', jobs: stale };
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  function e(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  const rowsHtml = stale.map(function (j) {
    const why = !j.readiness.invoice_finished ? 'No finished invoice' : ((j.readiness.checkin && j.readiness.checkin.applies && !j.readiness.checkin.ok) ? 'Check-in proof missing' : 'Waiting on review');
    return '<tr>' +
      '<td style="padding:6px 10px;border:1px solid #e5e7eb"><a href="' + base + '/?view=completion-paperwork&id=' + j.work_order_id + '">' + e(QUEUE.poWoText(j) || ('WO ' + j.work_order_id)) + '</a></td>' +
      '<td style="padding:6px 10px;border:1px solid #e5e7eb">' + e(j.account_name) + '</td>' +
      '<td style="padding:6px 10px;border:1px solid #e5e7eb">' + e(QUEUE.locationText(j)) + '</td>' +
      '<td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:center">' + j.age_bdays + '</td>' +
      '<td style="padding:6px 10px;border:1px solid #e5e7eb">' + e(why) + '</td></tr>';
  }).join('');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5">' +
    '<p><strong>' + stale.length + ' completed job' + (stale.length === 1 ? ' has' : 's have') + ' sat in Completion Paperwork for ' + days + '+ business days.</strong></p>' +
    '<p>Paperwork that sits is money that sits. Review and send these:</p>' +
    '<table style="border-collapse:collapse;font-size:13px"><tr style="background:#f3f4f6">' +
    '<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">PO / WO</th><th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Account</th>' +
    '<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Location</th><th style="padding:6px 10px;border:1px solid #e5e7eb">Business days</th>' +
    '<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Holding it up</th></tr>' + rowsHtml + '</table>' +
    '<p style="margin-top:14px"><a href="' + base + '/?view=completion-paperwork">Open Completion Paperwork</a></p></div>';
  let ok = false;
  try { await sendEmail(to, 'Completion paperwork waiting: ' + stale.length + ' job' + (stale.length === 1 ? '' : 's'), html); ok = true; } catch (err) { console.error('[paperwork] stale digest failed:', err && err.message); }
  return { ok: ok, sent: ok, to: to, jobs: stale };
}

module.exports = { sendJob: sendJob, runBatch: runBatch, loadForSend: loadForSend, handleDeliveryEvent: handleDeliveryEvent, buildOnePdf: buildOnePdf,
  resendJob: resendJob, markPortalSubmitted: markPortalSubmitted, staleDigest: staleDigest };
