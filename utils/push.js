let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }
const { pool } = require('../db');

const PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@popalockar.com';

let ready = false;
if (webpush && PUBLIC && PRIVATE) {
  try { webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE); ready = true; }
  catch (e) { console.error('web-push VAPID setup failed:', e.message); }
}

function publicKey() { return ready ? PUBLIC : ''; }
function isReady() { return ready; }

// Send a push to every device subscribed by any of the given user ids.
// No-ops cleanly when web-push/VAPID isn't configured. Prunes dead subscriptions.
async function sendPushToUsers(userIds, payload) {
  if (!ready) return;
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!ids.length) return;
  let subs;
  try {
    subs = (await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::int[])', [ids])).rows;
  } catch (e) { console.error('push: load subscriptions failed:', e.message); return; }
  if (!subs.length) return;
  const body = JSON.stringify({
    title: (payload && payload.title) || 'Nova',
    body: (payload && payload.body) || '',
    url: (payload && payload.url) || '/'
  });
  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(sub, body);
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        try { await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); } catch (e) {}
      } else {
        console.error('push send failed:', err && err.message);
      }
    }
  }
}

module.exports = { publicKey: publicKey, isReady: isReady, sendPushToUsers: sendPushToUsers };
