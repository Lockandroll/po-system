const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');

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
async function userHasPerm(user, perm) {
  if (await permissions.hasPermission(user.role, perm)) return true;
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf(perm) !== -1;
  } catch (e) { return false; }
}
function hasAllChannels(user) { return userHasPerm(user, 'ptt_all_channels'); }

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
// Roles that get the per-city locksmith chats (Tony's spec: manager,
// locksmith, locksmith coordinator; admin/owner implicit).
const LOCKSMITH_CHAT_ROLES = ['admin', 'manager', 'locksmith', 'locksmith_coordinator'];

async function allowedChannels(user) {
  const cities = (await pool.query(
    'SELECT name, code, color FROM cities WHERE active = true ORDER BY name ASC'
  )).rows;
  const all = await hasAllChannels(user);
  let mine = null; // null = every city (all-channels perm, or no assignment)
  if (!all) {
    const rows = (await pool.query(
      'SELECT city_code FROM user_cities WHERE user_id = $1', [user.id]
    )).rows.map(function (r) { return (r.city_code || '').trim().toUpperCase(); });
    if (rows.length) mine = rows;
  }
  function cc(c) { return (c.code || '').trim().toUpperCase(); }
  function visible(codes) {
    if (!mine) return true;
    return codes.some(function (m) { return mine.indexOf(m) !== -1; });
  }
  const channels = [];
  cities.forEach(function (c) {
    if (visible([cc(c)])) channels.push({ code: cc(c), name: c.name, color: c.color || '#f97316' });
  });
  // Locksmith chats: one per city, restricted by role. Tampa + Clearwater are
  // combined into a single Tampa Bay chat. The Dispatch pseudo-city gets none.
  if (LOCKSMITH_CHAT_ROLES.includes(user.role)) {
    const groups = {};
    const order = [];
    cities.forEach(function (c) {
      const code = cc(c);
      if (code === 'DIS') return;
      const key = (code === 'TPA' || code === 'CSP') ? 'TPA' : code;
      if (!groups[key]) {
        groups[key] = {
          code: key + '-LS',
          name: (key === 'TPA' ? 'Tampa Bay' : c.name) + ' Locksmiths',
          color: c.color || '#f97316',
          members: []
        };
        order.push(key);
      }
      groups[key].members.push(code);
    });
    order.forEach(function (k) {
      const g = groups[k];
      if (visible(g.members)) channels.push({ code: g.code, name: g.name, color: g.color, locksmith: true });
    });
  }
  channels.push(ALL_HANDS);
  return channels;
}

// GET /api/ptt/channels - channels the current user may join.
router.get('/channels', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  const channels = await allowedChannels(req.user);
  res.json({ configured: isConfigured(), channels: channels, recording: r2.configured() });
});

// POST /api/ptt/token - mint a short-lived LiveKit token for ONE channel.
// This is the security chokepoint: authorization happens here, never on the
// client. The allowed set is recomputed server-side on every request.
router.post('/token', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'PTT is not configured yet (missing LIVEKIT_* environment variables).' });
  }
  const listenOnly = !!(req.body && req.body.listen);

  // Direct person-to-person (Zello contacts): every user has a personal room
  // 'ptt_user_<id>'. Your client listens to YOUR OWN room whenever the radio
  // is on (the inbox); talking directly to someone means publishing into
  // THEIR room. Requires the ptt_direct permission to transmit.
  if (req.body && req.body.user) {
    const targetId = parseInt(req.body.user, 10) || 0;
    let targetName = req.user.name;
    if (listenOnly) {
      // You may only listen to your own inbox.
      if (targetId !== req.user.id) return res.status(403).json({ error: 'You can only listen to your own direct channel.' });
    } else {
      if (targetId === req.user.id) return res.status(400).json({ error: 'That would be talking to yourself.' });
      if (!(await userHasPerm(req.user, 'ptt_direct'))) return res.status(403).json({ error: 'You do not have permission to use direct talk.' });
      const t = await pool.query('SELECT id, name FROM users WHERE id = $1 AND active = true', [targetId]);
      if (!t.rows.length) return res.status(404).json({ error: 'User not found.' });
      targetName = t.rows[0].name;
    }
    const dmRoom = 'ptt_user_' + targetId;
    const dmGrant = {
      room: dmRoom, roomJoin: true,
      canPublish: !listenOnly, canSubscribe: true, canPublishData: !listenOnly
    };
    // Owners listen invisibly (LiveKit 'hidden' participants do not appear in
    // anyone's participant list). Talking is always visible.
    if (listenOnly && req.user.isOwner) dmGrant.hidden = true;
    const dmToken = jwt.sign(
      { video: dmGrant, name: req.user.name, metadata: JSON.stringify({ name: req.user.name, role: req.user.role }) },
      process.env.LIVEKIT_API_SECRET,
      { algorithm: 'HS256', issuer: process.env.LIVEKIT_API_KEY, subject: String(req.user.id), expiresIn: TOKEN_TTL_SECONDS }
    );
    logAudit({
      entity_type: 'ptt', entity_number: 'U' + targetId, action: listenOnly ? 'ptt_inbox' : 'ptt_direct',
      user_id: req.user.id, user_name: req.user.name,
      details: { target_user_id: targetId, room: dmRoom }
    });
    return res.json({
      url: process.env.LIVEKIT_URL, token: dmToken, room: dmRoom,
      direct: { id: targetId, name: targetName },
      identity: String(req.user.id), ttl: TOKEN_TTL_SECONDS
    });
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
  // Listen-only tokens (scan mode monitors) cannot publish - enforced by
  // LiveKit itself, not just the client.
  const grant = {
    room: roomName,
    roomJoin: true,
    canPublish: !listenOnly,
    canSubscribe: true,
    canPublishData: !listenOnly
  };
  // Owners listen invisibly: hidden participants receive all audio but never
  // appear in the channel's participant list or speaking indicators. An owner
  // who goes LIVE (publishes) joins visibly like anyone else.
  if (listenOnly && req.user.isOwner) grant.hidden = true;
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
    entity_type: 'ptt', entity_number: match.code, action: listenOnly ? 'ptt_monitor' : 'ptt_join',
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

// ---------------------------------------------------------------------------
// Radio Log - sender-side recordings. The transmitting client records its own
// mic while keyed up and uploads the clip straight to R2 via a presigned URL
// (same pattern as the Documents vault - bytes never touch this server).
// ---------------------------------------------------------------------------

// Lazy one-time table creation: avoids touching db.js and any race with
// initDB, since the CREATE runs on first use, not at require time.
let _tablePromise = null;
function ensureTable() {
  if (_tablePromise) return _tablePromise;
  _tablePromise = (async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS ptt_transmissions (' +
      'id SERIAL PRIMARY KEY, user_id INTEGER, user_name TEXT, ' +
      'channel_code TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ' +
      'duration_ms INTEGER, r2_key TEXT NOT NULL, mime TEXT, ' +
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
    );
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_ptt_tx_chan_time ON ptt_transmissions (channel_code, started_at DESC)'
    );
    // CREATE TABLE IF NOT EXISTS will not add columns to an existing table,
    // so direct-talk columns need explicit ALTERs (same rule as db.js).
    await pool.query('ALTER TABLE ptt_transmissions ADD COLUMN IF NOT EXISTS dm_from INTEGER');
    await pool.query('ALTER TABLE ptt_transmissions ADD COLUMN IF NOT EXISTS dm_to INTEGER');
    await pool.query(
      'CREATE TABLE IF NOT EXISTS ptt_presence (user_id INTEGER PRIMARY KEY, online_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
    );
  })().catch(err => { _tablePromise = null; throw err; });
  return _tablePromise;
}

function extFromMime(mime) {
  if (/webm/.test(mime || '')) return 'webm';
  if (/mp4|m4a|aac/.test(mime || '')) return 'm4a';
  if (/ogg/.test(mime || '')) return 'ogg';
  return 'bin';
}

// POST /api/ptt/recordings/presign - presigned PUT for one transmission clip.
router.post('/recordings/presign', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  if (!r2.configured()) return res.status(503).json({ error: 'Recording storage (R2) is not configured.' });
  const mime = String((req.body && req.body.mime) || 'audio/webm').slice(0, 100);
  const day = new Date().toISOString().slice(0, 10);
  if (req.body && req.body.user) {
    const targetId = parseInt(req.body.user, 10) || 0;
    if (!(await userHasPerm(req.user, 'ptt_direct'))) return res.status(403).json({ error: 'You do not have permission to use direct talk.' });
    const pair = Math.min(req.user.id, targetId) + '-' + Math.max(req.user.id, targetId);
    const key = 'ptt/dm/' + pair + '/' + day + '/' + Date.now() + '-' + req.user.id + '.' + extFromMime(mime);
    return res.json({ key: key, url: await r2.presignUpload(key, mime) });
  }
  const code = String((req.body && req.body.channel) || '').trim().toUpperCase();
  const channels = await allowedChannels(req.user);
  if (!channels.find(function (c) { return c.code === code; })) {
    return res.status(403).json({ error: 'You do not have access to this channel.' });
  }
  const key = 'ptt/' + code + '/' + day + '/' + Date.now() + '-' + req.user.id + '.' + extFromMime(mime);
  const url = await r2.presignUpload(key, mime);
  res.json({ key: key, url: url });
});

// POST /api/ptt/recordings - register an uploaded clip in the log.
router.post('/recordings', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  const b = req.body || {};
  const key = String(b.key || '');
  const durationMs = parseInt(b.duration_ms, 10) || 0;
  const mime = String(b.mime || 'audio/webm').slice(0, 100);
  if (b.user) {
    const targetId = parseInt(b.user, 10) || 0;
    const pair = Math.min(req.user.id, targetId) + '-' + Math.max(req.user.id, targetId);
    if (key.indexOf('ptt/dm/' + pair + '/') !== 0 || key.indexOf('..') !== -1) {
      return res.status(400).json({ error: 'Invalid key' });
    }
    await ensureTable();
    const startedAtDm = b.started_at ? new Date(b.started_at) : new Date();
    const ins = await pool.query(
      'INSERT INTO ptt_transmissions (user_id, user_name, channel_code, started_at, duration_ms, r2_key, mime, dm_from, dm_to) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [req.user.id, req.user.name, 'DIRECT', isNaN(startedAtDm.getTime()) ? new Date() : startedAtDm, durationMs, key, mime, req.user.id, targetId]
    );
    return res.status(201).json({ id: ins.rows[0].id });
  }
  const code = String(b.channel || '').trim().toUpperCase();
  if (!code || !key) return res.status(400).json({ error: 'channel and key are required' });
  // The key must be one this user could have been presigned for on this channel.
  if (key.indexOf('ptt/' + code + '/') !== 0 || key.indexOf('..') !== -1) {
    return res.status(400).json({ error: 'Invalid key' });
  }
  const channels = await allowedChannels(req.user);
  if (!channels.find(function (c) { return c.code === code; })) {
    return res.status(403).json({ error: 'You do not have access to this channel.' });
  }
  await ensureTable();
  const startedAt = b.started_at ? new Date(b.started_at) : new Date();
  const { rows } = await pool.query(
    'INSERT INTO ptt_transmissions (user_id, user_name, channel_code, started_at, duration_ms, r2_key, mime) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [req.user.id, req.user.name, code, isNaN(startedAt.getTime()) ? new Date() : startedAt, durationMs, key, mime]
  );
  res.status(201).json({ id: rows[0].id });
});

// GET /api/ptt/recordings?channel=CODE&date=YYYY-MM-DD - the Radio Log,
// scoped to channels this user may join.
router.get('/recordings', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  const channels = await allowedChannels(req.user);
  const myCodes = channels.map(function (c) { return c.code; });
  const chan = String(req.query.channel || '').trim().toUpperCase();
  if (chan && myCodes.indexOf(chan) === -1) {
    return res.status(403).json({ error: 'You do not have access to this channel.' });
  }
  await ensureTable();
  const params = [chan ? [chan] : myCodes];
  let where = 'channel_code = ANY($1)';
  const date = String(req.query.date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    params.push(date);
    where += " AND started_at >= $2::date AND started_at < ($2::date + INTERVAL '1 day')";
  }
  params.push(req.user.id);
  const meIdx = '$' + params.length;
  const { rows } = await pool.query(
    'SELECT t.id, t.user_id, t.user_name, t.channel_code, t.started_at, t.duration_ms, t.mime, ' +
    't.dm_from, t.dm_to, u.name AS dm_to_name ' +
    'FROM ptt_transmissions t LEFT JOIN users u ON u.id = t.dm_to ' +
    'WHERE ((' + where + ") OR (t.channel_code = 'DIRECT' AND (t.dm_from = " + meIdx + ' OR t.dm_to = ' + meIdx + '))) ' +
    'ORDER BY t.started_at DESC LIMIT 300',
    params
  );
  res.json({ recordings: rows, recording: r2.configured() });
});

// GET /api/ptt/recordings/:id/url - short-lived playback URL.
router.get('/recordings/:id/url', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  await ensureTable();
  const { rows } = await pool.query('SELECT * FROM ptt_transmissions WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const rec = rows[0];
  if (rec.channel_code === 'DIRECT') {
    if (rec.dm_from !== req.user.id && rec.dm_to !== req.user.id) {
      return res.status(403).json({ error: 'This is a direct transmission between other people.' });
    }
  } else {
    const channels = await allowedChannels(req.user);
    if (!channels.find(function (c) { return c.code === rec.channel_code; })) {
      return res.status(403).json({ error: 'You do not have access to this channel.' });
    }
  }
  const url = await r2.presignDownload(rec.r2_key, 'radio-' + rec.id + '.' + extFromMime(rec.mime), true);
  res.json({ url: url, mime: rec.mime });
});

// ---------------------------------------------------------------------------
// Direct talk support: roster + presence.
// ---------------------------------------------------------------------------

// POST /api/ptt/heartbeat - "my radio is on". Sent on connect and every
// minute while connected; {off:true} clears it on radio-off.
router.post('/heartbeat', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  await ensureTable();
  if (req.body && req.body.off) {
    await pool.query('DELETE FROM ptt_presence WHERE user_id = $1', [req.user.id]);
    return res.json({ ok: true });
  }
  await pool.query(
    'INSERT INTO ptt_presence (user_id, online_at) VALUES ($1, NOW()) ' +
    'ON CONFLICT (user_id) DO UPDATE SET online_at = NOW()',
    [req.user.id]
  );
  res.json({ ok: true });
});

// GET /api/ptt/people - active users with radio presence (online = heartbeat
// within the last 2.5 minutes). Drives the People section.
router.get('/people', requireAuth, requirePermission('view_ptt'), async (req, res) => {
  await ensureTable();
  const canDirect = await userHasPerm(req.user, 'ptt_direct');
  const { rows } = await pool.query(
    'SELECT us.id, us.name, us.title, us.role, ' +
    "(pp.online_at IS NOT NULL AND pp.online_at > NOW() - INTERVAL '150 seconds') AS online " +
    'FROM users us LEFT JOIN ptt_presence pp ON pp.user_id = us.id ' +
    'WHERE us.active = true ORDER BY us.name ASC'
  );
  res.json({ people: rows, canDirect: canDirect });
});

module.exports = router;
