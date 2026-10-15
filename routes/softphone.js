// Phone in Nova (pilot): answer GoTo calls in the browser. See utils/softphone.js.
//
//   GET  /api/softphone/status            this person's phone: connected, extension, last GoTo error
//   GET  /api/softphone/connect           -> { url } GoTo sign-in for this person (once)
//   POST /api/softphone/extension         { extension }
//   POST /api/softphone/register          turn the phone on (channel + device + extension)
//   GET  /api/softphone/events?after=&wait=   long poll: greetings / incoming / ended
//   POST /api/softphone/answer            { call_id, sdp } -> { sdp }
//   POST /api/softphone/reject            { call_id }   (send to voicemail)
//   POST /api/softphone/hangup            { call_id }
//   POST /api/softphone/disconnect
//   POST /api/softphone/hook/:userId/:secret   PUBLIC: GoTo notifications for that person
//
// Ships dark: everything except the hook needs the use_softphone permission.
// No backticks anywhere in this file (Windows corrupts them in .js).

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const sp = require('../utils/softphone');

const router = express.Router();

// GoTo posts here; the per-person secret in the path is the only check (GoTo
// does not sign webhooks). Always 200 fast, then process.
router.post('/hook/:userId/:secret', express.json({ limit: '1mb' }), function (req, res) {
  const uid = parseInt(req.params.userId, 10);
  if (!uid || req.params.secret !== sp.hookSecret(uid)) return res.status(404).json({ error: 'Not found' });
  res.status(200).json({ ok: true });
  setImmediate(function () { sp.ingest(uid, req.body || {}).catch(function (e) { console.error('[softphone] hook:', e.message); }); });
});
router.get('/hook/:userId/:secret', function (req, res) {
  const uid = parseInt(req.params.userId, 10);
  if (!uid || req.params.secret !== sp.hookSecret(uid)) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.use(requireAuth, requirePermission('use_softphone'));

// GoTo's own 5xx -> 502; anything else (GoTo 4xx or our checks) -> 400 with the words.
function fail(res, e) { res.status(e.status && e.status >= 500 ? 502 : 400).json({ error: e.message }); }

router.get('/status', async function (req, res) { res.json(await sp.status(req.user.id)); });

router.get('/connect', function (req, res) {
  if (!sp.configured()) return res.status(400).json({ error: 'GoTo is not set up in Nova (GOTO_CLIENT_ID / SECRET / REDIRECT_URI).' });
  res.json({ url: sp.authorizeUrl(req.user.id) });
});

router.post('/extension', async function (req, res) {
  const ext = String((req.body && req.body.extension) || '').replace(/[^0-9]/g, '').slice(0, 10);
  if (ext.length < 2) return res.status(400).json({ error: 'Enter your GoTo extension number.' });
  await sp.patch(req.user.id, { extension: ext });
  res.json({ ok: true, extension: ext });
});

router.post('/register', async function (req, res) {
  try {
    const out = await sp.register(req.user.id);
    await logAudit({ entity_type: 'softphone', entity_id: req.user.id, action: 'phone_on', user_id: req.user.id, user_name: req.user.name, details: { extension: out.extension } });
    res.json(out);
  } catch (e) { fail(res, e); }
});

router.get('/events', async function (req, res) {
  try { res.json({ events: await sp.events(req.user.id, req.query.after, parseInt(req.query.wait, 10) || 0) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/answer', async function (req, res) {
  const b = req.body || {};
  if (!b.call_id || !b.sdp) return res.status(400).json({ error: 'Missing call or audio offer.' });
  try {
    const out = await sp.answer(req.user.id, String(b.call_id), String(b.sdp));
    await logAudit({ entity_type: 'softphone', entity_id: req.user.id, action: 'answered', user_id: req.user.id, user_name: req.user.name, details: { call_id: b.call_id } });
    res.json(out);
  } catch (e) { fail(res, e); }
});
router.post('/reject', async function (req, res) {
  try { await sp.reject(req.user.id, String((req.body && req.body.call_id) || '')); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
});
router.post('/hangup', async function (req, res) {
  try { await sp.hangup(req.user.id, String((req.body && req.body.call_id) || '')); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
});
router.post('/disconnect', async function (req, res) {
  await sp.disconnect(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
