const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// ---------------------------------------------------------------------------
// Nova PTT (push-to-talk) - Phase 1.
// Nova owns identity + authorization; LiveKit owns audio. This file is the
// entire server-side surface: it decides which channels a user may join and
// mints short-lived LiveKit access tokens scoped to exactly one room.
// A LiveKit "room" == a PTT channel. Rooms are named 'ptt_' + channel code.
// No new npm dependency: LiveKit access tokens are standard HS256 JWTs, so we
// sign them with jsonwebtoken (already a dependency) using the LiveKit API
// secret. Env vars required: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
// ---------------------------------------------------------------------------

// Who may join every channel (the dispatch function): anyone whose role has
// the 'ptt_all_channels' permission (defaults: admin, manager, coordinator,
// dispatcher - editable on the Roles page) or with a per-user extra_perms grant.
async function hasAllChannels(user) {
  if (await permissions.hasPermission(user.role, 'ptt_all_channels')) return true;
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf('ptt_all_channels') !== -1;
  } catch (e) { return false; }
}

// Virtual all-hands channel. Always present, joinable by every active user,
// independent of the cities table.
const ALL_HANDS = { code: 'ALL', name: 'All Hands', color: '#f97316' };

// Token lifetime. Tokens are only needed at (re)connect time; the client
// fetches a fresh one for every connection attempt, so keep this short.
const TOKEN_TTL_SECONDS = 600; // 10 minutes

function isConfigured() {
  return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

// The channels this user may join. Mirrors the /api/cities/mine convention:
// dispatch-tier roles get every city channel; a user with assigned cities gets
// those; a user with no assignment gets every city. Everyone gets All Hands.
async function allowedChannels(user) {
  const cities = (await pool.query(
    'SELECT name, code, color FROM cities WHERE active = true ORDER BY name ASC'
  )).rows;
  let list;
  if (await hasAllChannels(user)) {
    list = cities;
  } else {
    const mine = (await pool.query(
      'SELECT city_code FROM user_cities WHERE user_id = $1', [user.id]
    )).rows.map(function (r) { return (r.city_code || '').trim().toUpperCase(); });
    list = mine.length
      ? cities.filter(function (c) { return mine.indexOf((c.code || '').trim().toUpperCase()) !== -1; })
      : cities;
  }
  const channels = list.map(function (c) {
    return { code: (c.code || '').trim().toUpperCase(), name: c.name, color: c.color || '#f97316' };
  });
  channels.push(ALL_HANDS);
  return channels;
}

// GET /api/ptt/channels - channels the current user may join.
router.get('/channels', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  const channels = await allowedChannels(req.user);
  res.json({ configured: isConfigured(), channels: channels });
});

// POST /api/ptt/token - mint a short-lived LiveKit token for ONE channel.
// This is the security chokepoint: authorization happens here, never on the
// client. The allowed set is recomputed server-side on every request.
router.post('/token', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'PTT is not configured yet (missing LIVEKIT_* environment variables).' });
  }
  const requested = String((req.body && req.body.channel) || '').trim().toUpperCase();
  if (!requested) return res.status(400).json({ error: 'channel is required' });

  const channels = await allowedChannels(req.user);
  const match = channels.find(function (c) { return c.code === requested; });
  if (!match) {
    return res.status(403).json({ error: 'You do not have access to this channel.' });
  }

  const roomName = 'ptt_' + match.code;
  // LiveKit access tokens are plain JWTs: iss = API key, sub = participant
  // identity, plus a 'video' grant object scoping the token to one room.
  // Identity is the Nova user id so presence maps back to real people.
  // NOTE: LiveKit allows one connection per identity per room - joining the
  // same channel from a second tab/device disconnects the first.
  const grant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  };
  const token = jwt.sign(
    {
      video: grant,
      name: req.user.name,
      metadata: JSON.stringify({ name: req.user.name, role: req.user.role })
    },
    process.env.LIVEKIT_API_SECRET,
    {
      algorithm: 'HS256',
      issuer: process.env.LIVEKIT_API_KEY,
      subject: String(req.user.id),
      expiresIn: TOKEN_TTL_SECONDS
    }
  );

  logAudit({
    entity_type: 'ptt', entity_number: match.code, action: 'ptt_join',
    user_id: req.user.id, user_name: req.user.name,
    details: { channel: match.code, room: roomName }
  });

  res.json({
    url: process.env.LIVEKIT_URL,
    token: token,
    room: roomName,
    channel: { code: match.code, name: match.name, color: match.color },
    identity: String(req.user.id),
    ttl: TOKEN_TTL_SECONDS
  });
});

module.exports = router;
