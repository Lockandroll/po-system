// routes/goto.js
// GoTo Connect integration: the admin connect flow and health status.
//
// GoTo has no client_credentials grant, so an admin has to consent once in a
// browser. This router owns that handshake:
//
//   GET  /api/goto/status     admin  - is it connected, token health, last error
//   GET  /api/goto/connect    admin  - redirect the browser to GoTo consent
//   GET  /api/goto/callback   PUBLIC - GoTo redirects here with ?code=&state=
//   POST /api/goto/disconnect admin  - forget the tokens
//
// The callback CANNOT require a JWT: GoTo redirects the user's browser to it,
// and a browser redirect carries no Authorization header. It is protected by the
// signed, 15-minute state parameter minted in /connect instead, which also
// carries the id of the admin who started the flow.
//
// No backticks in this file (Windows clipboard safety).

'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const goto = require('../utils/goto');
const { logAudit } = require('../utils/audit');

const router = express.Router();

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A small self-contained result page for the OAuth round trip. The browser lands
// here from GoTo, not from the SPA, so it cannot rely on any app CSS.
function resultPage(ok, heading, detail) {
  const accent = ok ? '#22c55e' : '#e24b4a';
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(heading) + '</title></head>' +
    '<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#14161a;color:#e6e8eb;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh">' +
    '<div style="max-width:460px;padding:32px;text-align:center">' +
    '<div style="width:44px;height:44px;border-radius:50%;background:' + accent + ';margin:0 auto 18px"></div>' +
    '<h1 style="font-size:20px;margin:0 0 10px">' + esc(heading) + '</h1>' +
    '<p style="font-size:14px;line-height:1.6;color:#9aa2ad;margin:0 0 22px">' + esc(detail) + '</p>' +
    '<a href="/" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#f97316;' +
    'color:#fff;text-decoration:none;font-size:14px;font-weight:600">Back to Nova</a>' +
    '</div></body></html>';
}

// ---- Status ----------------------------------------------------------------

router.get('/status', requireAuth, requireRole('admin'), async function (req, res) {
  try {
    const s = await goto.status();
    res.json(s);
  } catch (e) {
    console.error('GET /goto/status:', e.message);
    res.status(500).json({ error: 'Failed to read GoTo status' });
  }
});

// ---- Connect ---------------------------------------------------------------
// Returns the consent URL as JSON so the SPA can open it itself. Also supports
// ?redirect=1 for a direct browser navigation, which is handy for testing.

router.get('/connect', requireAuth, requireRole('admin'), async function (req, res) {
  try {
    if (!goto.configured()) {
      return res.status(503).json({
        error: 'GoTo is not configured. Add GOTO_CLIENT_ID, GOTO_CLIENT_SECRET and GOTO_REDIRECT_URI in Railway.'
      });
    }
    const url = goto.authorizeUrl(req.user.id);
    if (req.query.redirect === '1') return res.redirect(url);
    res.json({ url: url });
  } catch (e) {
    console.error('GET /goto/connect:', e.message);
    res.status(500).json({ error: 'Failed to build the GoTo consent URL' });
  }
});

// ---- Callback (public, protected by the signed state) ----------------------

router.get('/callback', async function (req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8');

  // GoTo reports consent failures as ?error=access_denied rather than an HTTP error.
  if (req.query.error) {
    const desc = req.query.error_description || req.query.error;
    return res.status(400).send(resultPage(false, 'GoTo did not connect', String(desc)));
  }

  const code = String(req.query.code || '');
  const st = goto.readState(req.query.state);
  if (!code || !st.ok) {
    return res.status(400).send(resultPage(
      false,
      'That link expired',
      'The connect link is only valid for 15 minutes. Start the connection again from Settings.'
    ));
  }

  try {
    await goto.exchangeCode(code, st.userId);
    try {
      await logAudit({ entity_type: 'integration', action: 'goto_connected', user_id: st.userId || null, details: { provider: 'goto_connect' } });
    } catch (e) {}
    res.send(resultPage(
      true,
      'GoTo is connected',
      'Nova can now read call reports and recordings. You can close this tab.'
    ));
  } catch (e) {
    console.error('GET /goto/callback:', e.message);
    try { await goto.noteError(e.message); } catch (e2) {}
    res.status(500).send(resultPage(false, 'Could not finish connecting', e.message));
  }
});

// ---- Disconnect ------------------------------------------------------------

router.post('/disconnect', requireAuth, requireRole('admin'), async function (req, res) {
  try {
    await goto.disconnect();
    try {
      await logAudit({ entity_type: 'integration', action: 'goto_disconnected', user_id: req.user.id, user_name: req.user.name, details: { provider: 'goto_connect' } });
    } catch (e) {}
    res.json({ success: true });
  } catch (e) {
    console.error('POST /goto/disconnect:', e.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ---- Account key -----------------------------------------------------------
// The account key is needed on every call lookup. It is discovered automatically
// at connect time; this exposes it so an admin can see what was found, re-run
// discovery, or choose when the login belongs to more than one account.

router.get('/account', requireAuth, requireRole('admin'), async function (req, res) {
  try {
    const current = await goto.resolveAccountKey();
    let found = [];
    try { found = await goto.discoverAccounts(); } catch (e) { found = []; }
    res.json({ current: current, accounts: found });
  } catch (e) {
    console.error('GET /goto/account:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/account', requireAuth, requireRole('admin'), async function (req, res) {
  try {
    const key = await goto.setAccountKey(req.body && req.body.account_key);
    res.json({ success: true, account_key: key });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Diagnostic: what does GoTo actually say when we ask who we are? Admin only.
router.get('/account/diagnose', requireAuth, requireRole('admin'), async function (req, res) {
  try {
    const probes = await goto.probeMe();
    res.json({ probes: probes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnostic: probe the call-search API against the live account and report its
// SHAPE. Answers the four things GoTo does not document. Returns types and field
// names, never customer data - see utils/goto.js probeCallSearch.
//   ?days=30           how far back to look (1-90, default 7)
//   ?phone=7045550134  optional, tests which phone-filter parameter works
router.get('/calls/probe', requireAuth, requireRole('admin'), async function (req, res) {
  try {
    const out = await goto.probeCallSearch({ days: req.query.days, digits: req.query.phone });
    res.json(out);
  } catch (e) {
    console.error('GET /goto/calls/probe:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- Manual refresh (admin, for diagnosing a stuck connection) -------------

router.post('/refresh', requireAuth, requireRole('admin'), async function (req, res) {
  try {
    await goto.refresh();
    const s = await goto.status();
    res.json({ success: true, status: s });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
