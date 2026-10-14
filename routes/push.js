const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const push = require('../utils/push');
const fcm = require('../utils/fcm');

const router = express.Router();

router.get('/key', requireAuth, function (req, res) {
  // native: true only when Firebase is configured on the server. The phone app
  // asks before it registers, so an app built without Firebase never tries.
  res.json({ key: push.publicKey(), native: push.nativeReady() });
});

// Phone-app (Firebase) tokens. One row per installed app; a token that moves to
// a different login (shared phone) follows the latest person to sign in.
router.post('/native-register', requireAuth, async (req, res) => {
  if (!push.nativeReady()) return res.json({ success: false, reason: 'not_configured' });
  try {
    const ok = await fcm.registerToken(req.user.id, req.body && req.body.token, req.body && req.body.platform);
    if (!ok) return res.status(400).json({ error: 'Invalid token' });
    res.json({ success: true });
  } catch (e) {
    console.error('native push register failed:', e.message);
    res.status(500).json({ error: 'Could not save the phone token' });
  }
});

router.post('/native-unregister', requireAuth, async (req, res) => {
  try { await fcm.unregisterToken(req.body && req.body.token); } catch (e) {}
  res.json({ success: true });
});

router.post('/subscribe', requireAuth, async (req, res) => {
  const s = (req.body && req.body.subscription) ? req.body.subscription : req.body;
  if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  try {
    await pool.query(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4) ' +
      'ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4',
      [req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('push subscribe failed:', e.message);
    res.status(500).json({ error: 'Could not save subscription' });
  }
});

router.post('/unsubscribe', requireAuth, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) { try { await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]); } catch (e) {} }
  res.json({ success: true });
});

module.exports = router;
