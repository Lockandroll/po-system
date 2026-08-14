// routes/judi.js
//
// Judi call history for the Call Lookup page. Judi is the AI receptionist on
// the inbound Pop-A-Lock line, run by MidTN Dispatch. See utils/judi.js for
// what this system is and why Nova stores none of it.
//
//   GET /api/judi/lookup?phone=      list a caller's Judi calls (summaries)
//   GET /api/judi/call/:shortCode    one call in full: transcript, grade, ETA
//   GET /api/judi/call/:shortCode/play   stream the audio through Nova
//   GET /api/judi/status             admin - what the API key actually sees
//
// Everything is gated on play_call_recordings, the same permission the GoTo
// lookup uses. No new permission, so no roles-matrix edit and no exposure to
// the saveRoles stripping trap (see the notes on adding a permission).
//
// WHY THE SAME PERMISSION IS THE RIGHT CALL HERE: on a complaint there are two
// things between a user and a customer's audio, the city scope on the complaint
// and the check that the call belongs to that complaint's number. A standalone
// lookup has neither, so the permission IS the whole gate - which is exactly
// the reasoning that put the GoTo lookup on the stronger permission, and Judi
// exposes strictly more (a transcript is the entire call as readable text).
//
// No backticks in this file (Windows clipboard safety - see CLAUDE.md 1.1).

'use strict';

const express = require('express');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const judi = require('../utils/judi');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// A failed Judi read must never look like a server fault, because the Call
// Lookup page fires this alongside the GoTo lookup and renders whatever comes
// back. 503 plus a reason lets the client show "Judi is unavailable" next to
// the GoTo rows it did get, instead of a red error over the whole page.
function sendErr(res, e, where) {
  const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 503;
  console.error(where + ':', e.message);
  res.status(status).json({
    error: e.message,
    reason: e.judiCode || (status === 404 ? 'not_found' : 'upstream'),
    source: 'judi'
  });
}

// GET /api/judi/lookup?phone=...
//
// Summaries only. No transcript, no audio URL, no full=true - a 9-call lookup
// is 6 KB this way and 253 KB with full=true, and running a search should not
// itself pull down the text of nine customer conversations.
router.get('/lookup', requireAuth, requirePermission('play_call_recordings'), async function (req, res) {
  try {
    if (!judi.configured()) {
      // Not an error. Judi being unconfigured is the normal state until the key
      // is in Railway, and the page should render GoTo rows regardless.
      return res.json({ calls: [], configured: false, reason: 'not_configured' });
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const out = await judi.callsForPhone(req.query.phone, { limit: limit });
    if (out.reason === 'bad_phone') {
      return res.json({ calls: [], configured: true, reason: 'bad_phone' });
    }
    res.json({ calls: out.calls, digits: out.digits, configured: true });
  } catch (e) {
    sendErr(res, e, 'GET /judi/lookup');
  }
});

// GET /api/judi/call/:shortCode
//
// AUDIT THE OPEN, NOT JUST THE PLAY. The GoTo route audits plays because audio
// was the only content it could hand over. A Judi detail includes the English
// transcript, which is the whole call in a form far easier to read, copy and
// forward than an MP3. Opening one IS the disclosure, so it is the thing that
// has to be on the record.
//
// short_code only in the audit details, never customer_name. The audit log is
// a permanent table; writing customer names into it would persist exactly what
// utils/judi.js goes out of its way not to store.
router.get('/call/:shortCode', requireAuth, requirePermission('play_call_recordings'), async function (req, res) {
  try {
    const out = await judi.callDetail(req.params.shortCode);

    if (!req.viewingAs && !(req.user.isOwner || req.user.role === 'owner')) {
      await logAudit({
        entity_type: 'judi_call',
        entity_number: String(req.params.shortCode).slice(0, 120),
        action: 'opened Judi call detail',
        user_id: req.user.id,
        user_name: req.user.name,
        details: { via: 'call lookup', has_transcript: !!out.shaped.transcript }
      });
    }

    res.json({ call: out.shaped });
  } catch (e) {
    sendErr(res, e, 'GET /judi/call/:shortCode');
  }
});

// GET /api/judi/call/:shortCode/play
//
// Streams the audio THROUGH Nova rather than handing the browser the upstream
// URL. Two reasons, and the first holds no matter what that URL turns out to
// be: whether recording_url is a signed expiring link or a permanent public
// one was never confirmed, and a permanent unsigned link handed to a browser is
// customer audio one copy-paste away from anybody. The second is that the
// upstream fetch may need the API key, which must not reach the client.
//
// Range requests are passed through so the player can seek.
router.get('/call/:shortCode/play', requireAuth, requirePermission('play_call_recordings'), async function (req, res) {
  try {
    const out = await judi.callDetail(req.params.shortCode);
    const url = out.recordingUrl;
    if (!url) return res.status(404).json({ error: 'This call has no recording', reason: 'no_recording' });

    if (!req.viewingAs && !(req.user.isOwner || req.user.role === 'owner')) {
      await logAudit({
        entity_type: 'judi_call',
        entity_number: String(req.params.shortCode).slice(0, 120),
        action: 'played Judi call recording',
        user_id: req.user.id,
        user_name: req.user.name,
        details: { via: 'call lookup' }
      });
    }

    const headers = { 'X-API-Key': String(process.env.JUDI_API_KEY || '').trim() };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(url, { method: 'GET', headers: headers });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: 'Judi audio fetch failed (' + upstream.status + ')', reason: 'upstream_audio' });
    }

    res.status(upstream.status === 206 ? 206 : 200);
    const passthrough = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
    passthrough.forEach(function (h) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    if (!upstream.headers.get('content-type')) res.setHeader('content-type', 'audio/mpeg');
    // Customer audio must not sit in a shared cache or a proxy.
    res.setHeader('Cache-Control', 'private, no-store');

    // Node 18's fetch returns a web ReadableStream. Buffering a whole recording
    // into memory would be fine for a two minute call and not fine for a long
    // one, so it is piped through a chunk at a time.
    const reader = upstream.body.getReader();
    let closed = false;
    req.on('close', function () { closed = true; try { reader.cancel(); } catch (e) {} });
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done || closed) break;
      if (!res.write(Buffer.from(chunk.value))) {
        await new Promise(function (resolve) { res.once('drain', resolve); });
      }
    }
    res.end();
  } catch (e) {
    // Headers may already be out the door mid-stream, in which case the only
    // honest thing left is to cut the connection.
    if (res.headersSent) { try { res.end(); } catch (e2) {} return; }
    sendErr(res, e, 'GET /judi/call/:shortCode/play');
  }
});

// GET /api/judi/status
//
// Admin diagnostics. This exists because the API could not be probed from the
// machine this integration was written on, so the questions that would normally
// be settled before building - what does the key see, is the calls path where
// we think it is, what are the real field names - are answered here from
// production instead. Key names only, never values, and never the API key.
router.get('/status', requireAuth, requireRole('admin'), async function (req, res) {
  try {
    const out = await judi.status(parseInt(req.query.sample, 10) || 1);
    res.json(out);
  } catch (e) {
    sendErr(res, e, 'GET /judi/status');
  }
});

module.exports = router;
