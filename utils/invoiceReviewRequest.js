// Customer follow-up on invoice completion (Tony, 2026-10-11).
// Plan: claude/nova-customer-follow-up-plan.md in the Nova project.
//
// When an invoice is completed Nova can text or email the customer ONE message
// with a link to their invoice page (/i/<token>, routes/invoiceLink.js). The page
// carries the invoice buttons plus ONE follow-up: a "Leave a Google review"
// button, or a short feedback survey that lands in Customer Feedback.
//
// Who gets what, in this order (decide() below is the only place it lives):
//   1. The invoice has an ACCOUNT: vendors.customer_contact
//        'none'   Do not contact (the DEFAULT for every account) -> nothing.
//        'survey' Survey only: survey page, no invoice buttons, no Google.
//        'retail' Retail rules: carry on as a walk-in customer.
//   2. No account, but the pay type is billed (Motor Club, Account / Invoice)
//      -> nothing. Backstop for an invoice nobody picked an account on.
//   3. The locksmith chose Don't send                     -> nothing.
//   4. Automatic survey (logged as automatic, never held against the tech):
//        commercial job (invoice account_type = commercial), or the same
//        customer (phone or email) was sent a Google request in the last
//        followup_repeat_days (default 365).
//   5. The locksmith's pick: Google review (pre-selected), or the survey with a
//      reason from settings.followup_survey_reasons.
//
// Review gating. Google forbids asking only happy customers for reviews and the
// FTC's guidance says the same. That is WHY the survey needs a reason, the reason
// list never includes "how the job went", every choice and reason is logged, and
// the Customer Follow-Ups report shows the Google share per locksmith. The
// wording asks for HONEST feedback and never for stars. Keep all of that if you
// edit this file.
//
// Sent at most once automatically: review_sent_at is claimed in the same UPDATE
// that checks it. Reopen does NOT clear it, so fixing a typo never texts the
// customer twice. "Send again" on the invoice is the deliberate resend.
//
// Nothing here throws to a caller on the finish path.

const crypto = require('crypto');
const { pool } = require('../db');
const { sendEmailDetailed } = require('./email');
const { sendSmsDetailed } = require('./sms');
const r2 = require('./r2');
const { buildInvoicePdf } = require('./invoicePdf');

var emailLog = null;
try { emailLog = require('./emailLog'); } catch (e) { emailLog = null; }
var logAudit = null;
try { logAudit = require('./audit').logAudit; } catch (e) { logAudit = null; }

var VIA = ['none', 'sms', 'email'];
var KINDS = ['google', 'survey'];
var FINISHED = ['paid', 'partially_refunded', 'refunded'];
// Statuses in which the customer page shows the invoice. A reopened (draft)
// invoice is mid-correction and a canceled one was never a bill.
var LINK_OPEN = ['awaiting_payment', 'paid', 'partially_refunded', 'refunded'];
var CONTACT = ['retail', 'survey', 'none'];
// Same lists as routes/invoices.js and utils/paperworkDeliver.js: what the
// customer copy must never show.
var LINE_COST_FIELDS = ['unit_cost', 'cost_unknown', 'cost_unknown_reason', 'cost_source'];
var INVOICE_COST_FIELDS = ['parts_cost_total', 'cogs_incomplete', 'cogs'];
var LINKS_KEY = 'invoice_review_links';

// Survey reasons. A setting, so the list can change without a deploy; this is
// the default Tony approved 2026-10-11. NOTHING on it may be about how the job
// went (see the gating note above).
var DEFAULT_REASONS = [
  { key: 'commercial', label: 'Commercial job' },
  { key: 'repeat', label: 'Repeat customer' },
  { key: 'asked_not', label: 'Customer asked not to be asked for reviews' },
  { key: 'return_visit', label: 'Return visit needed to finish the job' },
  { key: 'no_google', label: 'Customer does not use Google' }
];
var AUTO_LABELS = {
  commercial: 'Commercial job',
  repeat: 'Customer was already asked for a Google review recently'
};

function appBase() { return (process.env.APP_URL || '').replace(/\/$/, ''); }
function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
function esc(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

async function getSetting(key, dflt) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (r.rows.length && r.rows[0].value != null && r.rows[0].value !== '') return r.rows[0].value;
  } catch (e) {}
  return dflt;
}

async function getReasons() {
  try {
    const list = JSON.parse(await getSetting('followup_survey_reasons', ''));
    if (Array.isArray(list) && list.length) {
      return list.filter(function (r) { return r && r.key && r.label; }).map(function (r) {
        return { key: String(r.key).slice(0, 40), label: String(r.label).slice(0, 120) };
      });
    }
  } catch (e) {}
  return DEFAULT_REASONS.slice();
}

function reasonLabel(key, reasons) {
  var hit = (reasons || DEFAULT_REASONS).filter(function (r) { return r.key === key; })[0];
  return hit ? hit.label : (key ? String(key) : 'No reason given');
}

async function repeatDays() {
  var n = parseInt(await getSetting('followup_repeat_days', '365'), 10);
  return (isNaN(n) || n < 0) ? 365 : n;
}

// ---- Google review links (Invoice Setup) ----------------------------------
// { CITY_CODE: 'https://g.page/r/.../review', __default: '...' }
async function reviewLinks() {
  try {
    const o = JSON.parse(await getSetting(LINKS_KEY, '{}'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}

function linkFor(links, cityCode) {
  var c = String(cityCode || '').trim().toUpperCase();
  return (c && links[c]) || links.__default || '';
}

async function reviewLinkFor(cityCode) { return linkFor(await reviewLinks(), cityCode); }

// Only https, so a typo cannot put a javascript: or http: URL in front of a customer.
function cleanLink(u) {
  var s = String(u || '').trim();
  if (!s) return '';
  if (!/^https:\/\/[^\s<>"]+$/i.test(s) || s.length > 500) return null;
  return s;
}

async function saveReviewLinks(map) {
  var out = {};
  var bad = [];
  Object.keys(map || {}).forEach(function (k) {
    var key = k === '__default' ? '__default' : String(k).trim().toUpperCase().slice(0, 8);
    if (!key) return;
    var v = cleanLink(map[k]);
    if (v === null) { bad.push(key); return; }
    if (v) out[key] = v;
  });
  if (bad.length) return { ok: false, error: 'These links are not valid https:// addresses: ' + bad.join(', ') + '.' };
  await pool.query(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
    [LINKS_KEY, JSON.stringify(out)]
  );
  return { ok: true, links: out };
}

async function billedPayTypes() {
  try {
    const list = JSON.parse(await getSetting('invoice_billed_pay_types', '["Account / Invoice","Motor Club"]'));
    return Array.isArray(list) ? list : [];
  } catch (e) { return ['Account / Invoice', 'Motor Club']; }
}

function isBilled(payType, list) {
  var p = String(payType || '').trim().toLowerCase();
  if (!p) return false;
  return (list || []).some(function (x) { return String(x).trim().toLowerCase() === p; });
}

// US numbers, which is every customer Lock and Roll serves. Anything that is
// not ten digits (or eleven starting with 1) is refused rather than guessed at.
function toE164(raw) {
  var d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  return '';
}
function last10(raw) { var d = String(raw == null ? '' : raw).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim()); }

// ---- the locksmith's choice -------------------------------------------------
// strict: refuse a bad number/address or a survey with no reason (the invoice
// page endpoints). Loose: keep what was typed (the editor Save, so a half-typed
// draft never blocks a save; the send reports the problem instead).
function normalizeChoice(body, strict, reasons) {
  body = body || {};
  var via = String(body.review_send_via || 'none').trim().toLowerCase();
  if (VIA.indexOf(via) === -1) via = 'none';
  var kind = String(body.followup_kind || 'google').trim().toLowerCase();
  if (KINDS.indexOf(kind) === -1) kind = 'google';
  var reason = kind === 'survey' ? String(body.followup_reason || '').trim().slice(0, 40) : '';
  if (kind === 'survey' && reason && reasons && !reasons.some(function (r) { return r.key === reason; })) reason = '';
  var to = String(body.review_send_to || '').trim().slice(0, 255);
  var out = { via: via, to: to || null, kind: kind, reason: reason || null };
  if (via === 'none') return out;
  if (strict && kind === 'survey' && !reason) return { error: 'Pick why the survey instead of a Google review.' };
  if (via === 'sms') {
    var e = toE164(to);
    if (!e) { if (strict) return { error: 'Enter the customer\'s 10-digit mobile number for the text.' }; return out; }
    out.to = e;
    return out;
  }
  if (!validEmail(to)) { if (strict) return { error: 'Enter a valid email address for the customer.' }; return out; }
  out.to = to.toLowerCase();
  return out;
}

async function writeChoice(invoiceId, c) {
  await pool.query(
    'UPDATE invoices SET review_send_via = $1, review_send_to = $2, followup_kind = $3, followup_reason = $4 WHERE id = $5',
    [c.via, c.to, c.kind, c.reason, invoiceId]
  );
}

// Called by POST / and PUT /:id BEFORE notifyInvoiceFinished, so a Save that
// also finishes the invoice sends to the choice it just saved. A body without
// the key (an older client, another screen) leaves the stored choice alone.
async function applyChoice(invoiceId, body) {
  if (!has(body, 'review_send_via')) return;
  try { await writeChoice(invoiceId, normalizeChoice(body, false, await getReasons())); }
  catch (e) { console.error('[followup] save choice failed:', e.message); }
}

// The invoice page Save (before completion). Strict.
async function saveChoiceStrict(invoiceId, body) {
  var c = normalizeChoice(body || {}, true, await getReasons());
  if (c.error) return { status: 400, error: c.error };
  await writeChoice(invoiceId, c);
  return { status: 200, ok: true, via: c.via, to: c.to, kind: c.kind, reason: c.reason };
}

// ---- the decision -----------------------------------------------------------
async function accountContact(accountId) {
  var id = parseInt(accountId, 10);
  if (!id) return null;
  try {
    const r = await pool.query('SELECT customer_contact FROM vendors WHERE id = $1', [id]);
    if (!r.rows.length) return 'none';
    var v = String(r.rows[0].customer_contact || 'none');
    return CONTACT.indexOf(v) === -1 ? 'none' : v;
  } catch (e) { return 'none'; }
}

async function sentGoogleRecently(inv, via, to) {
  var days = await repeatDays();
  if (!days) return false;
  var phone = via === 'sms' ? last10(to) : '';
  if (!phone) phone = last10(inv.phone);
  var email = via === 'email' && validEmail(to) ? String(to).trim().toLowerCase() : '';
  if (!email && validEmail(inv.email)) email = String(inv.email).trim().toLowerCase();
  if (!phone && !email) return false;
  try {
    const r = await pool.query(
      "SELECT 1 FROM invoices WHERE id <> $1 AND followup_mode = 'google' AND review_send_status = 'sent' " +
      "AND review_sent_at > NOW() - ($2 || ' days')::interval AND (" +
      "($3 <> '' AND (RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = $3 OR RIGHT(REGEXP_REPLACE(COALESCE(review_sent_to, ''), '[^0-9]', '', 'g'), 10) = $3)) " +
      "OR ($4 <> '' AND (LOWER(COALESCE(email, '')) = $4 OR LOWER(COALESCE(review_sent_to, '')) = $4))) LIMIT 1",
      [inv.id || 0, String(days), phone, email]
    );
    return r.rows.length > 0;
  } catch (e) { console.error('[followup] repeat check:', e.message); return false; }
}

// What would go out for this invoice. opts.ignoreVia: answer as if the
// locksmith had picked Text, so the invoice card can explain the account rule
// before anyone chooses. Returns
//   { send, mode: 'google'|'survey'|'survey_only'|null, auto, reason, rule, why }
async function decide(inv, opts) {
  opts = opts || {};
  var via = opts.via || inv.review_send_via || 'none';
  var to = has(opts, 'to') ? opts.to : inv.review_send_to;
  var kind = opts.kind || inv.followup_kind || 'google';
  var reason = has(opts, 'reason') ? opts.reason : inv.followup_reason;
  var rule = null;
  if (inv.account_id) {
    rule = await accountContact(inv.account_id);
    if (rule === 'none') return { send: false, mode: null, rule: rule, why: 'Account is set to Do not contact.' };
  } else if (isBilled(inv.pay_type, await billedPayTypes())) {
    return { send: false, mode: null, rule: 'none', why: 'Account-billed pay type (' + inv.pay_type + '). Only retail customers are contacted.' };
  } else {
    rule = 'retail';
  }
  if (!opts.ignoreVia && via === 'none') return { send: false, mode: null, rule: rule, why: 'Locksmith chose Don\'t send.' };
  if (rule === 'survey') return { send: true, mode: 'survey_only', rule: rule, auto: null, reason: null, why: 'Account is set to Survey only.' };
  if (String(inv.account_type || '').toLowerCase() === 'commercial') {
    return { send: true, mode: 'survey', rule: rule, auto: 'commercial', reason: 'commercial', why: 'Automatic survey: ' + AUTO_LABELS.commercial + '.' };
  }
  if (await sentGoogleRecently(inv, via, to)) {
    return { send: true, mode: 'survey', rule: rule, auto: 'repeat', reason: 'repeat', why: 'Automatic survey: ' + AUTO_LABELS.repeat + '.' };
  }
  if (kind === 'survey') {
    return { send: true, mode: 'survey', rule: rule, auto: null, reason: reason || null, why: 'Survey: ' + reasonLabel(reason, await getReasons()) + '.' };
  }
  return { send: true, mode: 'google', rule: rule, auto: null, reason: null, why: 'Google review request.' };
}

// ---- the invoice link -------------------------------------------------------
function newToken() { return crypto.randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function ensureLinkToken(invoiceId) {
  const r = await pool.query(
    'UPDATE invoices SET customer_link_token = COALESCE(customer_link_token, $2) WHERE id = $1 RETURNING customer_link_token',
    [invoiceId, newToken()]
  );
  return r.rows.length ? r.rows[0].customer_link_token : null;
}

function invoiceLink(token) { return appBase() + '/i/' + token; }

async function companyInfo() {
  return {
    name: await getSetting('company_name', 'Pop-A-Lock'),
    address: await getSetting('company_address', ''),
    csz: await getSetting('company_city_state_zip', ''),
    phone: await getSetting('company_phone', ''),
    logo: await getSetting('logo', '')
  };
}

// The same customer copy POST /invoices/:id/email attaches: costs stripped,
// print-flagged photos, refunds shown under the original total.
async function buildCustomerPdf(inv) {
  const items = (await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position, id', [inv.id])).rows;
  const photos = [];
  try {
    const ph = (await pool.query("SELECT r2_key, caption FROM invoice_photos WHERE invoice_id = $1 AND show_in_print = true AND status = 'ready' ORDER BY position, id", [inv.id])).rows;
    if (ph.length && r2.configured()) {
      for (const p of ph) {
        try { photos.push({ buffer: await r2.getObjectBuffer(p.r2_key), caption: p.caption }); } catch (e) { console.error('R2 photo fetch failed:', e.message); }
      }
    }
  } catch (e) {}
  let refunds = [];
  try {
    refunds = (await pool.query(
      "SELECT refund_number, amount, refund_date, status FROM invoice_refunds WHERE invoice_id = $1 AND status IN ('approved', 'processed') ORDER BY id",
      [inv.id]
    )).rows;
  } catch (e) { refunds = []; }
  const safeInv = Object.assign({}, inv);
  INVOICE_COST_FIELDS.forEach(function (k) { delete safeInv[k]; });
  const safeLines = items.map(function (it) {
    const o = Object.assign({}, it);
    LINE_COST_FIELDS.forEach(function (k) { delete o[k]; });
    return o;
  });
  return buildInvoicePdf(safeInv, safeLines, photos, { company: await companyInfo(), refunds: refunds });
}

function firstName(n) {
  var s = String(n || '').trim().split(/\s+/)[0] || '';
  return s.length > 1 && s.length <= 30 ? s : '';
}

function money(v) { return '$' + (parseFloat(v) || 0).toFixed(2); }

// ---- message wording (honest feedback, never stars) -------------------------
function smsBody(inv, brand, pageUrl, mode) {
  var first = firstName(inv.customer_name);
  var lead = first ? ('Hi ' + first + ', thank you') : 'Thank you';
  var num = String(inv.invoice_number || inv.id);
  var body;
  if (mode === 'survey_only') {
    body = lead + ' for having ' + brand + ' out today. How did we do? It takes 30 seconds:\n' + pageUrl;
  } else if (mode === 'survey') {
    body = lead + ' for choosing ' + brand + '. Your invoice #' + num + ' is ready, and we would love to hear how we did (30-second survey):\n' + pageUrl;
  } else {
    body = lead + ' for choosing ' + brand + '. Your invoice #' + num + ' is ready, and we would appreciate your honest feedback on Google:\n' + pageUrl;
  }
  return body + '\n\nReply STOP to opt out.';
}

function btn(href, label, bg) {
  return '<a href="' + esc(href) + '" style="display:inline-block;background:' + bg + ';color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:6px;margin:4px 8px 4px 0">' + esc(label) + '</a>';
}

function emailHtml(inv, brand, pageUrl, mode, phone) {
  var first = firstName(inv.customer_name);
  var parts = ['<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.6;max-width:560px">'];
  parts.push('<p>' + (first ? ('Hi ' + esc(first) + ',') : 'Hello,') + '</p>');
  if (mode === 'survey_only') {
    parts.push('<p>Thank you for having ' + esc(brand) + ' out today.</p>');
  } else {
    parts.push('<p>Thank you for choosing ' + esc(brand) + '. Your invoice <strong>#' + esc(String(inv.invoice_number || inv.id)) + '</strong>' +
      (inv.grand_total != null ? (' for <strong>' + money(inv.grand_total) + '</strong>') : '') + ' is attached.</p>');
    parts.push(btn(pageUrl, 'View invoice online', '#f97316'));
  }
  parts.push('<div style="margin:22px 0;padding:18px 20px;border:1px solid #e5e5e5;border-radius:10px;background:#fafafa">');
  if (mode === 'google') {
    parts.push('<p style="margin:0 0 12px">We would appreciate your honest feedback about your visit. It takes a minute and helps other people find a locksmith they can trust.</p>');
    parts.push(btn(pageUrl + '/google', 'Leave a Google review', '#1a73e8'));
  } else {
    parts.push('<p style="margin:0 0 12px"><strong>How did we do?</strong> Four quick questions, about 30 seconds. Your answers go straight to the local manager.</p>');
    parts.push(btn(pageUrl + '#survey', 'Take the survey', '#111111'));
  }
  parts.push('</div>');
  if (mode === 'survey_only') parts.push('<p style="font-size:13px;color:#666">Your invoice goes to the account that requested this service, not to you.</p>');
  if (phone) parts.push('<p>Questions? Call us at ' + esc(phone) + '.</p>');
  parts.push('<p style="color:#888;font-size:12px;border-top:1px solid #eee;padding-top:10px;margin-top:18px">This message was sent from an unmonitored address. Please contact ' + esc(brand) + ' directly with any questions.</p>');
  parts.push('</div>');
  return parts.join('');
}

function fromAddress(brand) {
  if (process.env.QUOTE_FROM_EMAIL) return process.env.QUOTE_FROM_EMAIL;
  var base = process.env.FROM_EMAIL || '';
  var m = base.match(/<([^>]+)>/);
  var addr = (m ? m[1] : base.trim()) || 'onboarding@resend.dev';
  return brand + ' <' + addr + '>';
}

// ---- the send ---------------------------------------------------------------
// Returns { ok, skipped, error, to, decision }.
async function deliver(inv, via, to, actor, choice) {
  var d = await decide(inv, { via: via, to: to, kind: choice ? choice.kind : undefined, reason: choice ? choice.reason : inv.followup_reason });
  if (!d.send) return { ok: false, skipped: true, error: d.why, decision: d };
  if (d.mode === 'google' && !(await reviewLinkFor(inv.city_code))) {
    return { ok: false, error: 'No Google review link is set for ' + (inv.city_code || 'this city') + '. An admin can add it in Invoice Setup.', decision: d };
  }
  if (!appBase()) return { ok: false, error: 'APP_URL is not set, so there is no link to send.', decision: d };
  var brand = await getSetting('company_name', 'Pop-A-Lock');
  var token = await ensureLinkToken(inv.id);
  var pageUrl = invoiceLink(token);

  if (via === 'sms') {
    var e = toE164(to);
    if (!e) return { ok: false, error: 'The mobile number on this invoice is not a valid 10-digit number.', decision: d };
    var s = await sendSmsDetailed(e, smsBody(inv, brand, pageUrl, d.mode));
    return { ok: s.ok, error: s.ok ? null : s.error, to: e, decision: d };
  }
  if (via === 'email') {
    if (!validEmail(to)) return { ok: false, error: 'The email address on this invoice is not valid.', decision: d };
    var attachments = [];
    if (d.mode !== 'survey_only') {
      var pdf;
      try { pdf = await buildCustomerPdf(inv); }
      catch (err) { console.error('[followup] PDF build failed:', err); return { ok: false, error: 'Could not build the invoice PDF.', decision: d }; }
      if (pdf.length <= 20 * 1024 * 1024) attachments.push({ filename: 'Invoice-' + (inv.invoice_number || inv.id) + '.pdf', content: pdf.toString('base64'), content_type: 'application/pdf' });
    }
    var subject = d.mode === 'survey_only'
      ? ('How did we do today? | ' + brand)
      : ('Your invoice #' + (inv.invoice_number || inv.id) + ' from ' + brand);
    var r = await sendEmailDetailed(to, subject, emailHtml(inv, brand, pageUrl, d.mode, await getSetting('company_phone', '')), null, attachments,
      { from: fromAddress(brand), replyTo: process.env.QUOTE_REPLY_TO || undefined });
    if (emailLog) {
      try {
        await emailLog.recordOutbound({ messageId: r.id, entityType: 'invoice', entityId: inv.id, entityNumber: String(inv.invoice_number || inv.id), to: to, subject: subject, sentBy: actor && actor.id ? actor.id : null, status: r.ok ? 'sent' : 'failed' });
      } catch (e2) {}
    }
    return { ok: r.ok, error: r.ok ? null : 'The email did not send.', to: to, decision: d };
  }
  return { ok: false, skipped: true, error: 'Locksmith chose Don\'t send.', decision: d };
}

async function record(invId, result, via, to) {
  var status = result.ok ? 'sent' : (result.skipped ? 'skipped' : 'failed');
  var d = result.decision || {};
  try {
    await pool.query(
      'UPDATE invoices SET review_sent_at = NOW(), review_send_status = $2, review_sent_via = $3, review_sent_to = $4, review_send_detail = $5, ' +
      'followup_mode = $6, followup_auto = $7 WHERE id = $1',
      [invId, status, via, result.to || to || null, result.error ? String(result.error).slice(0, 500) : null,
       result.ok ? (d.mode || null) : null, d.auto || null]
    );
  } catch (e) { console.error('[followup] record failed:', e.message); }
  return status;
}

async function audit(inv, actor, status, via, to, result, manual) {
  if (!logAudit) return;
  var d = result.decision || {};
  try {
    await logAudit({
      entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number || ''),
      action: 'review_request_' + status, user_id: actor && actor.id ? actor.id : null, user_name: actor && actor.name ? actor.name : 'System',
      details: { via: via, to: to, mode: d.mode || null, auto: d.auto || null, reason: d.reason || null, detail: result.error || null, manual: !!manual }
    });
  } catch (e) {}
}

// Automatic send, called from notifyInvoiceFinished (every finish path goes
// through it). Never throws, and resolves to the recorded status (or null when
// nothing was claimed: Don't send, or already sent).
async function sendOnFinish(invoiceId, actor) {
  try {
    const claim = await pool.query(
      "UPDATE invoices SET review_sent_at = NOW(), review_send_status = 'sending' " +
      "WHERE id = $1 AND status IN ('paid', 'partially_refunded', 'refunded') AND review_send_via IN ('sms', 'email') AND review_sent_at IS NULL RETURNING *",
      [invoiceId]
    );
    if (!claim.rows.length) return null;
    const inv = claim.rows[0];
    var res = await deliver(inv, inv.review_send_via, inv.review_send_to, actor, null);
    var status = await record(inv.id, res, inv.review_send_via, inv.review_send_to);
    await audit(inv, actor, status, inv.review_send_via, res.to || inv.review_send_to, res, false);
    return status;
  } catch (e) {
    console.error('[followup] send on finish failed:', e);
    return null;
  }
}

// "Send now" / "Send again" from the invoice page. Saves the choice it was
// given first, then sends right away. Only on a finished invoice.
async function sendNow(invoiceId, user, body) {
  var c = normalizeChoice(body || {}, true, await getReasons());
  if (c.error) return { status: 400, error: c.error };
  if (c.via === 'none') return { status: 400, error: 'Pick text or email first.' };
  const r = await pool.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  const inv = r.rows[0];
  if (!inv) return { status: 404, error: 'Invoice not found' };
  if (FINISHED.indexOf(inv.status) === -1) return { status: 409, error: 'Complete the invoice first. Your choice is saved and sends automatically when it is completed.' };
  // A double tap must not text the customer twice. A 'sending' row older than
  // two minutes is a send that died with the process, so it does not block.
  var _age = inv.review_sent_at ? (Date.now() - new Date(inv.review_sent_at).getTime()) : Infinity;
  if ((inv.review_send_status === 'sending' && _age < 120000) || (inv.review_send_status === 'sent' && _age < 60000)) {
    return { status: 429, error: 'That was just sent. Give it a minute before sending again.' };
  }
  await writeChoice(inv.id, c);
  inv.review_send_via = c.via; inv.review_send_to = c.to; inv.followup_kind = c.kind; inv.followup_reason = c.reason;
  var res = await deliver(inv, c.via, c.to, user, c);
  var status = await record(inv.id, res, c.via, c.to);
  await audit(inv, user, status, c.via, res.to || c.to, res, true);
  if (status === 'sent') return { status: 200, ok: true, send_status: status };
  return { status: res.skipped ? 409 : 502, error: res.error || 'It did not send.', send_status: status };
}

// One line for the "Invoice finished" email (and anywhere else that wants it).
async function followupSummary(inv) {
  if (!inv) return '';
  var how = inv.review_sent_via === 'email' ? 'email' : 'text';
  var to = inv.review_sent_to || inv.review_send_to || '';
  var m = String(to).match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m) to = '(' + m[1] + ') ' + m[2] + '-' + m[3];
  var st = inv.review_send_status;
  if (st === 'sent') {
    if (inv.followup_mode === 'google') return 'Google review request, sent by ' + how + ' to ' + to;
    if (inv.followup_mode === 'survey_only') return 'Feedback survey (account is Survey only), sent by ' + how + ' to ' + to;
    if (inv.followup_auto) return 'Feedback survey (automatic: ' + (AUTO_LABELS[inv.followup_auto] || inv.followup_auto) + '), sent by ' + how + ' to ' + to;
    return 'Feedback survey, sent by ' + how + ' to ' + to + '. Reason: ' + reasonLabel(inv.followup_reason, await getReasons()) + (inv.locksmith_name ? ' (picked by ' + inv.locksmith_name + ')' : '');
  }
  if (st === 'skipped') return 'Not sent: ' + (inv.review_send_detail || 'not allowed for this job');
  if (st === 'failed') return 'Did not send: ' + (inv.review_send_detail || 'unknown error');
  if (st === 'sending') return 'Sending';
  var d = await decide(inv, {});
  return 'Not sent: ' + (d.why || 'nothing chosen');
}

module.exports = {
  reviewLinks: reviewLinks,
  reviewLinkFor: reviewLinkFor,
  linkFor: linkFor,
  saveReviewLinks: saveReviewLinks,
  applyChoice: applyChoice,
  saveChoiceStrict: saveChoiceStrict,
  sendOnFinish: sendOnFinish,
  sendNow: sendNow,
  decide: decide,
  followupSummary: followupSummary,
  buildCustomerPdf: buildCustomerPdf,
  billedPayTypes: billedPayTypes,
  isBilled: isBilled,
  toE164: toE164,
  normalizeChoice: normalizeChoice,
  smsBody: smsBody,
  emailHtml: emailHtml,
  getReasons: getReasons,
  reasonLabel: reasonLabel,
  getSetting: getSetting,
  companyInfo: companyInfo,
  firstName: firstName,
  money: money,
  esc: esc,
  AUTO_LABELS: AUTO_LABELS,
  CONTACT: CONTACT,
  FINISHED: FINISHED,
  LINK_OPEN: LINK_OPEN
};
