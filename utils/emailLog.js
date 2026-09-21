'use strict';
/*
 * Generic outbound-email delivery log  (Nova)
 * -------------------------------------------
 * Records the customer-facing emails we want to confirm actually landed
 * (invoices, quotes, ...) and lets the Resend delivery webhook move each one
 * sent -> delivered / bounced / failed / complained / delayed.
 *
 * Completion paperwork keeps its own richer log (paperwork_sends) with its own
 * job-reopen logic; this is the lightweight log for everything else. The webhook
 * (routes/inbound.js POST /email-status) tries the paperwork handler first and
 * falls through to this one, so one Resend webhook feeds both.
 *
 * NOTE: no backtick/template-literal strings (Windows-safe per Nova rules).
 */

const { pool } = require('../db');
const { sendEmail } = require('./email');
const notify = require('./notify');
const push = require('./push');

function esc(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function toText(to) {
  if (to == null) return null;
  if (Array.isArray(to)) return to.filter(Boolean).join(', ');
  return String(to);
}

// Pull a human reason out of whatever shape Resend sends for a bounce/failure.
function reasonFrom(d, fallback) {
  if (!d) return fallback;
  if (d.bounce && (d.bounce.message || d.bounce.subType || d.bounce.type)) return String(d.bounce.message || (d.bounce.type + '/' + d.bounce.subType));
  if (d.failed && (d.failed.reason || d.failed.message)) return String(d.failed.reason || d.failed.message);
  return String(d.reason || d.message || fallback);
}

// Record one outbound send. Never throws.
async function recordOutbound(o) {
  o = o || {};
  try {
    await pool.query(
      'INSERT INTO email_log (provider_message_id, entity_type, entity_id, entity_number, to_emails, subject, status, sent_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [o.messageId || null, o.entityType || null, (o.entityId != null ? o.entityId : null),
       (o.entityNumber != null ? String(o.entityNumber) : null),
       toText(o.to), o.subject || null, o.status || 'sent',
       (o.sentBy != null ? o.sentBy : null)]
    );
  } catch (e) { console.error('[emailLog] recordOutbound failed:', e && e.message); }
}

// The latest logged send for one entity (what the detail page chip reads). Never throws.
async function latestForEntity(entityType, entityId) {
  try {
    const r = await pool.query(
      'SELECT provider_message_id, status, last_event, delivered_at, bounced_at, error, to_emails, created_at ' +
      'FROM email_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1',
      [entityType, entityId]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

// Tell the person who sent it (admins as a fallback) that it did not land. Never throws.
async function alertSender(row, headline, detail) {
  try {
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    const label = (row.entity_type === 'quote' ? 'Quote ' : 'Invoice #') + (row.entity_number || row.entity_id || '');
    const view = row.entity_type === 'quote' ? 'view-quote' : 'view-invoice';
    var emails = [];
    var userIds = [];
    if (row.sent_by) {
      try {
        const u = (await pool.query('SELECT id, email FROM users WHERE id = $1 AND active = true', [row.sent_by])).rows[0];
        if (u) { if (u.email) emails.push(u.email); userIds.push(u.id); }
      } catch (e) {}
    }
    if (!emails.length) {
      try { const rec = await notify.broadcastRecipients('email_bounce', "role IN ('admin','owner')"); emails = (rec.emails || []).slice(); userIds = (rec.userIds || []).slice(); } catch (e) {}
    }
    try { await push.sendPushToUsers(userIds, { title: headline, body: label + ' to ' + toText(row.to_emails) + ': ' + detail, url: base + '/?view=' + view + '&id=' + row.entity_id }); } catch (e) {}
    if (emails.length) {
      const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6">' +
        '<p><strong>' + esc(headline) + '</strong></p>' +
        '<p>' + esc(label) + ' to ' + esc(toText(row.to_emails)) + ' ' + esc(detail) + '.</p>' +
        '<p>Open it in Nova to resend to a corrected address.</p></div>';
      try { await sendEmail(emails, headline + ': ' + label, html); } catch (e) {}
    }
  } catch (e) { console.error('[emailLog] alertSender failed:', e && e.message); }
}

// Apply one Resend delivery event to the matching logged send. Never throws.
async function handleDeliveryEvent(type, emailId, evtData) {
  if (!emailId) return { ignored: true };
  var found;
  try { found = await pool.query('SELECT * FROM email_log WHERE provider_message_id = $1 ORDER BY id DESC LIMIT 1', [emailId]); }
  catch (e) { return { ignored: true }; }
  if (!found.rows.length) return { ignored: true };
  const row = found.rows[0];
  if (type === 'email.delivered') {
    await pool.query("UPDATE email_log SET last_event = 'delivered', status = 'delivered', delivered_at = NOW() WHERE id = $1", [row.id]);
    return { ok: true, event: 'delivered' };
  }
  if (type === 'email.bounced') {
    const reason = reasonFrom(evtData, 'The recipient mail server rejected it');
    await pool.query("UPDATE email_log SET last_event = 'bounced', status = 'bounced', bounced_at = NOW(), error = $2 WHERE id = $1", [row.id, reason]);
    try { await alertSender(row, (row.entity_type === 'quote' ? 'Quote email bounced' : 'Invoice email bounced'), 'bounced: ' + reason); } catch (e) {}
    return { ok: true, event: 'bounced' };
  }
  if (type === 'email.failed') {
    const reason = reasonFrom(evtData, 'The email provider could not send it');
    await pool.query("UPDATE email_log SET last_event = 'failed', status = 'failed', error = $2 WHERE id = $1", [row.id, reason]);
    try { await alertSender(row, (row.entity_type === 'quote' ? 'Quote email failed' : 'Invoice email failed'), 'failed to send: ' + reason); } catch (e) {}
    return { ok: true, event: 'failed' };
  }
  if (type === 'email.complained') {
    await pool.query("UPDATE email_log SET last_event = 'complained' WHERE id = $1", [row.id]);
    return { ok: true, event: 'complained' };
  }
  if (type === 'email.delivery_delayed') {
    await pool.query("UPDATE email_log SET last_event = 'delayed' WHERE id = $1", [row.id]);
    return { ok: true, event: 'delayed' };
  }
  return { ignored: true, type: type };
}

module.exports = {
  recordOutbound: recordOutbound,
  latestForEntity: latestForEntity,
  handleDeliveryEvent: handleDeliveryEvent
};
