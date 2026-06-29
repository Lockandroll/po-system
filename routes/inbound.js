const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { sendEmail, emailTemplate } = require('../utils/email');
const { parseEmailToTask } = require('../utils/taskParse');
const { findUserByEmail, createTaskFromParsed, emailFromHeader } = require('../utils/taskFromEmail');
const querystring = require('querystring');
const { pool } = require('../db');
const { sendSms } = require('../utils/sms');
const { parsePulsarEmail } = require('../utils/pulsarParse');
const { intakeFeedback, logActivity } = require('../utils/feedbackIntake');

const router = express.Router();
const APP = (process.env.APP_URL || '').replace(/\/$/, '');

// This router is mounted BEFORE express.json() in server.js, so we capture the
// raw body here for Svix signature verification.
router.use(express.raw({ type: '*/*', limit: '80mb' }));

// Verify a Resend (Svix) webhook signature against the raw request body.
function verifySignature(rawBuf, headers, secret) {
  if (!secret) return true; // not configured (dev) -> accept
  try {
    const id = headers['svix-id'];
    const ts = headers['svix-timestamp'];
    const sigHeader = headers['svix-signature'];
    if (!id || !ts || !sigHeader) return false;
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signedContent = id + '.' + ts + '.' + rawBuf.toString('utf8');
    const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
    const parts = String(sigHeader).split(' ');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var sig = p.indexOf(',') !== -1 ? p.split(',')[1] : p;
      if (!sig) continue;
      try {
        if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return true;
      } catch (e) { /* length mismatch -> not a match */ }
    }
    return false;
  } catch (e) { return false; }
}

// Fetch the full received email (body + headers) from Resend by id.
function fetchReceivedEmail(emailId) {
  return new Promise(function (resolve, reject) {
    const options = {
      hostname: 'api.resend.com',
      path: '/emails/receiving/' + encodeURIComponent(emailId),
      method: 'GET',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY }
    };
    const r = https.request(options, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse Resend response')); }
      });
    });
    r.on('error', reject);
    r.setTimeout(30000, function () { r.destroy(new Error('Resend request timed out')); });
    r.end();
  });
}

// POST /api/inbound/email — Resend "email.received" webhook
router.post('/email', async function (req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  if (!verifySignature(raw, req.headers, process.env.RESEND_INBOUND_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  var event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch (e) { return res.status(400).json({ error: 'Bad JSON' }); }
  if (!event || event.type !== 'email.received') {
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Acknowledge immediately, then process in the background so Resend never times out.
  res.status(200).json({ ok: true });

  try {
    const data = event.data || {};
    const senderEmail = emailFromHeader(data.from);
    const sender = await findUserByEmail(senderEmail);
    if (!sender) {
      console.log('[inbound] ignoring email from unknown sender:', senderEmail);
      return;
    }
    if (!data.email_id) { console.log('[inbound] webhook missing email_id'); return; }

    const full = await fetchReceivedEmail(data.email_id);
    const parsed = await parseEmailToTask({
      subject: (full && full.subject) || data.subject || '',
      text: (full && full.text) || '',
      html: (full && full.html) || '',
      fromName: sender.name
    });
    const result = await createTaskFromParsed(parsed, { id: sender.id, name: sender.name }, 'email');

    if (sender.email) {
      try {
        const details = [
          { label: 'Task', value: parsed.title },
          { label: 'Assigned to', value: result.assignee.name },
          { label: 'Priority', value: parsed.priority },
          { label: 'Due', value: parsed.due_date || 'None' }
        ];
        const html = emailTemplate({
          badge: 'Task Created', badgeColor: 'green',
          title: 'Nova created a task from your email',
          body: parsed.description || 'Created from your forwarded email.',
          details: details,
          buttonText: 'View Tasks', buttonUrl: APP + '/?view=tasks',
          footerNote: 'Forward an email to this address any time to create a task.'
        });
        await sendEmail(sender.email, 'Task created: ' + parsed.title, html);
      } catch (e) { console.error('[inbound] confirm email failed:', e.message); }
    }
    console.log('[inbound] created task #' + result.task.id + ' for ' + sender.email);
  } catch (e) {
    console.error('[inbound] processing failed:', e.message);
  }
});


// POST /api/inbound/feedback - Resend 'email.received' webhook for the customer
// feedback address (e.g. feedback@in.popalockar.com). Unlike /email this does NOT
// require a known sender - Pulsar is an external system.
router.post('/feedback', async function (req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const secret = process.env.RESEND_FEEDBACK_SECRET || process.env.RESEND_INBOUND_SECRET;
  if (!verifySignature(raw, req.headers, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  var event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch (e) { return res.status(400).json({ error: 'Bad JSON' }); }
  if (!event || event.type !== 'email.received') {
    return res.status(200).json({ ok: true, ignored: true });
  }
  res.status(200).json({ ok: true });

  try {
    const data = event.data || {};
    if (!data.email_id) { console.log('[feedback] webhook missing email_id'); return; }
    const full = await fetchReceivedEmail(data.email_id);
    const parsed = parsePulsarEmail({
      subject: (full && full.subject) || data.subject || '',
      text: (full && full.text) || '',
      html: (full && full.html) || ''
    });
    const result = await intakeFeedback(parsed, {
      source: 'pulsar',
      external_ref: data.email_id,
      raw_email: (full && (full.text || full.html)) || '',
      raw_subject: (full && full.subject) || data.subject || ''
    });
    if (result && result.duplicate) { console.log('[feedback] duplicate email ignored'); return; }
    console.log('[feedback] created record #' + (result && result.id));
  } catch (e) {
    console.error('[feedback] processing failed:', e.message);
  }
});

// Normalize a phone to its last 10 digits for matching.
function phoneKey(p) {
  var digits = String(p || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// POST /api/inbound/sms - Twilio inbound webhook. A manager texting back a reply
// (to a followup/escalation that carried an [FB-1234] tag) lands as a note on that
// feedback record. Body is application/x-www-form-urlencoded captured as raw above.
router.post('/sms', async function (req, res) {
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const params = querystring.parse(raw.toString('utf8'));
    const from = params.From || '';
    const body = (params.Body || '').trim();
    if (!from || !body) return;

    const key = phoneKey(from);
    var user = null;
    if (key) {
      const u = await pool.query("SELECT id, name, phone FROM users WHERE right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1 AND active = true LIMIT 1", [key]);
      if (u.rows.length) user = u.rows[0];
    }

    // Find the referenced feedback record: [FB-1234] tag, else the sender's most
    // recent open record.
    var feedbackId = null;
    const tag = body.match(/\bFB[-\s]?(\d+)\b/i);
    if (tag) feedbackId = parseInt(tag[1], 10);
    if (!feedbackId && user) {
      const recent = await pool.query(
        'SELECT id FROM customer_feedback WHERE assigned_to = $1 AND is_resolved = false ORDER BY last_interaction_at DESC LIMIT 1',
        [user.id]
      );
      if (recent.rows.length) feedbackId = recent.rows[0].id;
    }

    if (!feedbackId || !user) {
      console.log('[feedback-sms] unmatched reply from ' + from + ' - logging needs_review');
      try {
        await pool.query(
          "INSERT INTO customer_feedback (source, raw_email, incident_text, status, needs_review) VALUES ('sms_unmatched', $1, $2, 'new', true)",
          [from + ': ' + body, body]
        );
      } catch (e) { console.error('[feedback-sms] log unmatched:', e.message); }
      return;
    }

    const exists = await pool.query('SELECT id, customer_name FROM customer_feedback WHERE id = $1', [feedbackId]);
    if (!exists.rows.length) { console.log('[feedback-sms] FB id not found: ' + feedbackId); return; }

    await logActivity(feedbackId, { id: user.id, name: user.name }, 'note', body, 'sms');
    // Clear a due followup, if any.
    await pool.query('UPDATE customer_feedback SET followup_sent_at = COALESCE(followup_sent_at, NOW()) WHERE id = $1 AND followup_needed = true', [feedbackId]);

    try { await sendSms(from, 'Got it - added your note to FB-' + feedbackId + '.'); }
    catch (e) { console.error('[feedback-sms] ack failed:', e.message); }
    console.log('[feedback-sms] note added to FB-' + feedbackId + ' by ' + user.name);
  } catch (e) {
    console.error('[feedback-sms] processing failed:', e.message);
  }
});

module.exports = router;
