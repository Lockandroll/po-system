const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { sendEmail, emailTemplate } = require('../utils/email');
const { parseEmailToTask } = require('../utils/taskParse');
const { findUserByEmail, createTaskFromParsed, emailFromHeader } = require('../utils/taskFromEmail');

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

module.exports = router;
