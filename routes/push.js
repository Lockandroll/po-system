const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const push = require('../utils/push');

const router = express.Router();

router.get('/key', requireAuth, function (req, res) {
  res.json({ key: push.publicKey() });
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
