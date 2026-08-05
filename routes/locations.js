const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const duty = require('../utils/duty');

const router = express.Router();

const TZ = 'America/New_York';
// A phone that has been in a dead zone dumps its buffer all at once. 200 is
// generous enough to cover a couple of hours of backlog in one request.
const MAX_BATCH = 200;

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------
// Every knob lives in the settings table so behaviour can change without an
// app rebuild. The phone re-reads them from the /ping response, which means a
// change here reaches every device on its next report, not its next install.
const SETTING_DEFAULTS = {
  location_enabled: '1',
  location_require_ready: '1',
  location_ping_seconds: '30',
  location_distance_meters: '40',
  location_idle_minutes: '2',
  location_max_accuracy_m: '250',
  location_retention_days: '90',
  location_stale_minutes: '10',
  location_tile_url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  location_tile_attribution: '&copy; OpenStreetMap contributors',
  // Traffic is a separate, keyed layer. OpenStreetMap has no traffic data at
  // all, so this is the only way to get congestion onto the map. Off until a
  // key is entered, so it costs nothing to leave alone.
  location_traffic_enabled: '0',
  location_traffic_key: '',
  location_traffic_url: 'https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key={key}'
};
const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

var _cache = null;
var _cacheAt = 0;
const CACHE_TTL_MS = 30000;

async function loadSettings(force) {
  if (!force && _cache && (Date.now() - _cacheAt) < CACHE_TTL_MS) return _cache;
  const out = {};
  SETTING_KEYS.forEach(function (k) { out[k] = SETTING_DEFAULTS[k]; });
  try {
    const r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTING_KEYS]);
    r.rows.forEach(function (row) {
      if (row.value !== null && row.value !== undefined && String(row.value) !== '') out[row.key] = String(row.value);
    });
  } catch (e) {
    console.error('location settings load failed:', e.message);
  }
  _cache = out;
  _cacheAt = Date.now();
  return out;
}
function invalidateSettings() { _cache = null; _cacheAt = 0; }

function numOf(settings, key, min, max) {
  var n = parseFloat(settings[key]);
  if (!isFinite(n)) n = parseFloat(SETTING_DEFAULTS[key]);
  if (!isFinite(n)) n = min;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}
function boolOf(settings, key) {
  var v = String(settings[key] === undefined ? SETTING_DEFAULTS[key] : settings[key]).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// What the phone needs to know to configure its watcher.
function clientConfig(settings) {
  return {
    enabled: boolOf(settings, 'location_enabled'),
    requireReady: boolOf(settings, 'location_require_ready'),
    intervalSeconds: numOf(settings, 'location_ping_seconds', 10, 3600),
    distanceMeters: numOf(settings, 'location_distance_meters', 0, 5000),
    idleMinutes: numOf(settings, 'location_idle_minutes', 0.5, 60),
    maxAccuracyMeters: numOf(settings, 'location_max_accuracy_m', 10, 100000)
  };
}


// The traffic tile URL, with the key substituted in. Raster tiles are fetched
// by the browser, so the key has to travel; this endpoint already requires
// view_tech_locations, so it only ever reaches someone allowed to see the map.
// Restrict the key to your own domain in the provider's portal as well.
function trafficLayer(settings) {
  const on = boolOf(settings, 'location_traffic_enabled');
  const key = (settings.location_traffic_key || '').trim();
  const tpl = (settings.location_traffic_url || '').trim();
  if (!on || !key || !tpl) return { enabled: false };
  return { enabled: true, url: tpl.replace('{key}', encodeURIComponent(key)) };
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function numOrNull(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  if (!isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

// Turns one raw fix from a phone into a row, or null if it is not usable.
// Everything the client sends is treated as hostile: a bad clock, a cell-tower
// fix with 3km of error, or 0/0 from a GPS chip that has not locked yet.
function cleanPing(p, maxAccuracy) {
  if (!p || typeof p !== 'object') return null;
  const lat = numOrNull(p.lat !== undefined ? p.lat : p.latitude, -90, 90);
  const lon = numOrNull(p.lon !== undefined ? p.lon : (p.lng !== undefined ? p.lng : p.longitude), -180, 180);
  if (lat === null || lon === null) return null;
  // 0,0 is in the Atlantic. No tech has ever been there; it means "no fix yet".
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return null;

  const acc = numOrNull(p.accuracy_m !== undefined ? p.accuracy_m : p.accuracy, 0, 1000000);
  if (acc !== null && maxAccuracy && acc > maxAccuracy) return null;

  var rec = p.recorded_at || p.timestamp || p.time || null;
  var d = rec ? new Date(typeof rec === 'number' ? rec : String(rec)) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  const now = Date.now();
  // A clock more than 5 minutes ahead is wrong, not prophetic. Clamp it to now
  // so one bad device cannot park itself permanently at the top of the trail.
  if (d.getTime() > now + 5 * 60000) d = new Date(now);
  // Older than 14 days is a stale buffer nobody needs; drop it.
  if (d.getTime() < now - 14 * 24 * 3600 * 1000) return null;

  var battery = numOrNull(p.battery_pct !== undefined ? p.battery_pct : p.battery, 0, 100);
  if (battery !== null && battery <= 1 && String(p.battery_pct !== undefined ? p.battery_pct : p.battery).indexOf('.') !== -1) {
    // Some plugins report 0..1 instead of 0..100.
    battery = Math.round(battery * 100);
  }

  return {
    lat: lat,
    lon: lon,
    accuracy_m: acc,
    speed_mps: numOrNull(p.speed_mps !== undefined ? p.speed_mps : p.speed, 0, 400),
    heading_deg: numOrNull(p.heading_deg !== undefined ? p.heading_deg : p.heading, 0, 360),
    altitude_m: numOrNull(p.altitude_m !== undefined ? p.altitude_m : p.altitude, -500, 100000),
    battery_pct: battery === null ? null : Math.round(battery),
    is_moving: (p.is_moving === undefined && p.moving === undefined) ? null : !!(p.is_moving || p.moving),
    recorded_at: d.toISOString()
  };
}

function cleanSource(v) {
  const s = String(v || '').toLowerCase().trim();
  if (s === 'ios' || s === 'android' || s === 'pwa' || s === 'web') return s;
  return 'pwa';
}

// The open time clock entry for a user, or null.
async function openEntry(userId) {
  const r = await pool.query(
    "SELECT id, city_code FROM time_entries WHERE user_id = $1 AND status = 'open' ORDER BY clock_in_at DESC LIMIT 1",
    [userId]
  );
  return r.rows.length ? r.rows[0] : null;
}

// Same city scoping as Scheduling: null means every city.
async function allowedCities(user) {
  if (user.role === 'admin') return null;
  const { rows } = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [user.id]);
  if (!rows.length) return null;
  return rows.map(function (r) { return (r.city_code || '').trim(); });
}

// ---------------------------------------------------------------------------
//  INGEST - the phone reports here
// ---------------------------------------------------------------------------
// Accepts a single fix or a batch. Always answers 200 with a body the client
// can act on, because a 4xx to a background uploader just produces a retry
// loop that drains the battery it is trying to preserve.
router.post('/ping', requireAuth, async function (req, res) {
  const settings = await loadSettings();
  const cfg = clientConfig(settings);
  const uid = req.user.id;

  if (!cfg.enabled) {
    return res.json({ accepted: 0, received: 0, tracking: false, reason: 'disabled', config: cfg });
  }

  // THE DUTY GATE. Techs do not punch a time clock, so the switch is
  // "ready to accept calls". The SERVER decides this, not the phone: a modified
  // or misbehaving client cannot record a tech's position while they are off
  // duty, which is what makes the promise we make to the crew actually true.
  if (cfg.requireReady && !(await duty.isReady(uid))) {
    return res.json({ accepted: 0, received: 0, tracking: false, reason: 'not_ready', config: cfg });
  }
  // Still stamped to an open punch when there IS one - office staff do clock in,
  // and it costs nothing to keep the link for them.
  var entry = await openEntry(uid);

  var raw = req.body && Array.isArray(req.body.pings) ? req.body.pings : [req.body];
  if (raw.length > MAX_BATCH) raw = raw.slice(raw.length - MAX_BATCH);
  const source = cleanSource((req.body && req.body.source) || (req.body && req.body.platform));

  // Dedupe inside the batch as well as against the table. Two fixes with the
  // same instant would collide on uniq_locping_user_recorded, and a phone that
  // reports twice in the same millisecond is a plugin quirk, not two positions.
  const rows = [];
  const seen = {};
  for (var i = 0; i < raw.length; i++) {
    const c = cleanPing(raw[i], cfg.maxAccuracyMeters);
    if (!c) continue;
    if (seen[c.recorded_at]) continue;
    seen[c.recorded_at] = 1;
    rows.push(c);
  }
  if (!rows.length) {
    return res.json({ accepted: 0, received: 0, tracking: true, reason: 'no_valid_fixes', config: cfg });
  }

  const entryId = entry ? entry.id : null;
  const cityCode = entry && entry.city_code ? entry.city_code : null;

  // Bulk insert. ON CONFLICT DO NOTHING makes a resent batch a no-op instead of
  // a doubled trail (see uniq_locping_user_recorded in db.js).
  const vals = [];
  const params = [];
  var n = 1;
  rows.forEach(function (r) {
    vals.push('($' + (n++) + ',$' + (n++) + ',$' + (n++) + ',$' + (n++) + ',$' + (n++) + ',$' + (n++) +
      ',$' + (n++) + ',$' + (n++) + ',$' + (n++) + ',$' + (n++) + ',$' + (n++) + ',$' + (n++) + ',NOW())');
    params.push(uid, entryId, r.lat, r.lon, r.accuracy_m, r.speed_mps, r.heading_deg,
      r.altitude_m, r.battery_pct, r.is_moving, source, r.recorded_at);
  });
  var accepted = 0;
  try {
    const ins = await pool.query(
      'INSERT INTO location_pings (user_id, time_entry_id, lat, lon, accuracy_m, speed_mps, heading_deg, ' +
      'altitude_m, battery_pct, is_moving, source, recorded_at, received_at) VALUES ' + vals.join(',') +
      ' ON CONFLICT (user_id, recorded_at) DO NOTHING RETURNING id',
      params
    );
    accepted = ins.rowCount || 0;
  } catch (e) {
    console.error('location ping insert failed:', e.message);
    return res.status(500).json({ error: 'Could not store location', config: cfg });
  }

  // Newest fix in this batch wins, and only if it is newer than what is already
  // stored. A late-arriving buffer from a dead zone must never overwrite a
  // fresher position with an older one.
  var newest = rows[0];
  rows.forEach(function (r) { if (r.recorded_at > newest.recorded_at) newest = r; });
  try {
    await pool.query(
      'INSERT INTO tech_locations (user_id, lat, lon, accuracy_m, speed_mps, heading_deg, altitude_m, ' +
      'battery_pct, is_moving, time_entry_id, city_code, source, recorded_at, received_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) ' +
      'ON CONFLICT (user_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, ' +
      'accuracy_m = EXCLUDED.accuracy_m, speed_mps = EXCLUDED.speed_mps, heading_deg = EXCLUDED.heading_deg, ' +
      'altitude_m = EXCLUDED.altitude_m, battery_pct = EXCLUDED.battery_pct, is_moving = EXCLUDED.is_moving, ' +
      'time_entry_id = EXCLUDED.time_entry_id, city_code = EXCLUDED.city_code, source = EXCLUDED.source, ' +
      'recorded_at = EXCLUDED.recorded_at, received_at = NOW() ' +
      'WHERE tech_locations.recorded_at IS NULL OR EXCLUDED.recorded_at > tech_locations.recorded_at',
      [uid, newest.lat, newest.lon, newest.accuracy_m, newest.speed_mps, newest.heading_deg,
        newest.altitude_m, newest.battery_pct, newest.is_moving, entryId, cityCode, source, newest.recorded_at]
    );
  } catch (e) {
    console.error('tech_locations upsert failed:', e.message);
  }

  res.json({ accepted: accepted, received: rows.length, tracking: true, config: cfg });
});

// ---------------------------------------------------------------------------
//  MY OWN STATE - so a tech can always see what is being shared
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, async function (req, res) {
  const settings = await loadSettings();
  const cfg = clientConfig(settings);
  const d = await duty.getDuty(req.user.id);
  const r = await pool.query('SELECT * FROM tech_locations WHERE user_id = $1', [req.user.id]);
  res.json({
    config: cfg,
    ready: !!d.ready,
    readySince: d.ready_since,
    tracking: cfg.enabled && (!cfg.requireReady || !!d.ready),
    last: r.rows.length ? r.rows[0] : null,
    retentionDays: numOf(settings, 'location_retention_days', 1, 3650)
  });
});

// ---------------------------------------------------------------------------
//  LIVE MAP
// ---------------------------------------------------------------------------
router.get('/live', requireAuth, requirePermission('view_tech_locations'), async function (req, res) {
  const settings = await loadSettings();
  const scope = await allowedCities(req.user);

  const params = [];
  var where = 'WHERE u.active = true';
  if (scope !== null) {
    params.push(scope);
    where += ' AND (COALESCE(tl.city_code, u.home_city) IS NULL OR TRIM(COALESCE(tl.city_code, u.home_city)) = ANY($1))';
  }

  const sql =
    'SELECT u.id, u.name, u.role, u.phone, u.nickname, TRIM(COALESCE(tl.city_code, u.home_city)) AS city_code, ' +
    '       tl.lat, tl.lon, tl.accuracy_m, tl.speed_mps, tl.heading_deg, tl.battery_pct, tl.is_moving, ' +
    '       tl.source, tl.recorded_at, tl.received_at, ' +
    '       COALESCE(td.ready,false) AS on_duty, td.ready_since, ' +
    '       c.name AS city_name, c.color AS city_color, ' +
    '       wo.id AS wo_id, wo.wo_ref, wo.store_name, wo.address AS wo_address, wo.status AS wo_status, ' +
    // Counted here rather than in a second round trip: the map redraws every
    // 20 seconds and a per-tech query per refresh would be silly.
    "       (SELECT COUNT(*) FROM dispatch_jobs dj WHERE dj.assigned_to = u.id " +
    "          AND (dj.assigned_at AT TIME ZONE 'America/New_York')::date " +
    "            = (NOW() AT TIME ZONE 'America/New_York')::date) AS calls_today, " +
    "       (SELECT COUNT(*) FROM dispatch_jobs dj WHERE dj.assigned_to = u.id " +
    "          AND dj.status IN ('assigned','accepted','enroute','onscene')) AS open_calls " +
    'FROM users u ' +
    'LEFT JOIN tech_locations tl ON tl.user_id = u.id ' +
    'LEFT JOIN tech_duty td ON td.user_id = u.id ' +
    'LEFT JOIN cities c ON TRIM(c.code) = TRIM(COALESCE(tl.city_code, u.home_city)) ' +
    'LEFT JOIN LATERAL (' +
    '  SELECT w.id, w.wo_ref, w.store_name, w.address, w.status FROM work_orders w ' +
    "  WHERE w.assigned_to = u.id AND w.status NOT IN ('completed','cancelled','closed','invoiced') " +
    '  ORDER BY w.updated_at DESC LIMIT 1' +
    ') wo ON true ' +
    where + ' ' +
    'ORDER BY COALESCE(td.ready,false) DESC, (tl.recorded_at IS NULL), tl.recorded_at DESC, u.name';

  const r = await pool.query(sql, params);
  const staleMin = numOf(settings, 'location_stale_minutes', 1, 1440);
  const now = Date.now();

  const techs = r.rows.map(function (row) {
    const rec = row.recorded_at ? new Date(row.recorded_at).getTime() : null;
    const ageMin = rec === null ? null : Math.max(0, Math.round((now - rec) / 60000));
    var status = 'no_fix';
    if (rec !== null) {
      if (!row.on_duty) status = 'off_duty';
      else if (ageMin > staleMin) status = 'stale';
      else if (row.is_moving) status = 'moving';
      else status = 'stopped';
    }
    // No automatic overnight clear (nights are a real shift here), so surface how
    // long someone has been marked ready. A 20-hour "ready" is a forgotten toggle,
    // and the board should say so rather than quietly showing them as available.
    const dutyHrs = row.on_duty && row.ready_since
      ? Math.round(((now - new Date(row.ready_since).getTime()) / 3600000) * 10) / 10
      : null;
    return {
      user_id: row.id,
      name: row.name,
      nickname: row.nickname,
      role: row.role,
      phone: row.phone,
      city_code: row.city_code,
      city_name: row.city_name,
      city_color: row.city_color || '#f97316',
      lat: row.lat === null ? null : Number(row.lat),
      lon: row.lon === null ? null : Number(row.lon),
      accuracy_m: row.accuracy_m,
      speed_mps: row.speed_mps,
      heading_deg: row.heading_deg,
      battery_pct: row.battery_pct,
      is_moving: row.is_moving,
      source: row.source,
      recorded_at: row.recorded_at,
      age_minutes: ageMin,
      on_duty: !!row.on_duty,
      ready_since: row.ready_since,
      hours_on_duty: dutyHrs,
      status: status,
      calls_today: parseInt(row.calls_today, 10) || 0,
      open_calls: parseInt(row.open_calls, 10) || 0,
      job: row.wo_id ? { id: row.wo_id, ref: row.wo_ref, store: row.store_name, address: row.wo_address, status: row.wo_status } : null
    };
  });

  res.json({
    techs: techs,
    staleMinutes: staleMin,
    tile: { url: settings.location_tile_url, attribution: settings.location_tile_attribution },
    traffic: trafficLayer(settings),
    serverTime: new Date().toISOString()
  });
});

// ---------------------------------------------------------------------------
//  TRAIL - one tech, one span of time
// ---------------------------------------------------------------------------
router.get('/trail/:userId', requireAuth, requirePermission('view_tech_locations'), async function (req, res) {
  const uid = parseInt(req.params.userId, 10);
  if (!uid) return res.status(400).json({ error: 'Bad user' });

  const scope = await allowedCities(req.user);
  if (scope !== null) {
    const u = await pool.query(
      'SELECT TRIM(COALESCE(tl.city_code, u.home_city)) AS city_code FROM users u ' +
      'LEFT JOIN tech_locations tl ON tl.user_id = u.id WHERE u.id = $1', [uid]);
    if (u.rows.length && u.rows[0].city_code && scope.indexOf(u.rows[0].city_code) === -1) {
      return res.status(403).json({ error: 'Not in your cities' });
    }
  }

  // Default span is "today" in the shop's timezone.
  var from = req.query.from, to = req.query.to;
  const params = [uid];
  var sql = 'SELECT lat, lon, accuracy_m, speed_mps, heading_deg, battery_pct, is_moving, recorded_at, time_entry_id ' +
            'FROM location_pings WHERE user_id = $1';
  if (from && /^\d{4}-\d{2}-\d{2}/.test(from)) {
    params.push(from.length === 10 ? from + 'T00:00:00' : from);
    sql += ' AND recorded_at >= ($' + params.length + ')::timestamp AT TIME ZONE $' + (params.length + 1);
    params.push(TZ);
  } else {
    sql += " AND recorded_at >= (NOW() AT TIME ZONE $2)::date AT TIME ZONE $2";
    params.push(TZ);
  }
  if (to && /^\d{4}-\d{2}-\d{2}/.test(to)) {
    params.push(to.length === 10 ? to + 'T23:59:59' : to);
    sql += ' AND recorded_at <= ($' + params.length + ')::timestamp AT TIME ZONE $' + (params.length + 1);
    params.push(TZ);
  }
  sql += ' ORDER BY recorded_at ASC LIMIT 5000';

  const r = await pool.query(sql, params);
  const points = r.rows.map(function (p) {
    return {
      lat: Number(p.lat), lon: Number(p.lon), accuracy_m: p.accuracy_m,
      speed_mps: p.speed_mps, heading_deg: p.heading_deg, battery_pct: p.battery_pct,
      is_moving: p.is_moving, recorded_at: p.recorded_at, time_entry_id: p.time_entry_id
    };
  });

  const who = await pool.query('SELECT id, name FROM users WHERE id = $1', [uid]);
  res.json({
    user: who.rows.length ? who.rows[0] : { id: uid, name: 'Unknown' },
    points: points,
    stops: findStops(points),
    truncated: points.length >= 5000
  });
});

// A stop is a run of consecutive fixes that stay inside ~60m for 5 minutes or
// more. This is what turns a squiggle into "he was at the Walmart for 40
// minutes", which is the only part of a trail anyone actually reads.
const STOP_RADIUS_M = 60;
const STOP_MIN_MINUTES = 5;

function metersBetween(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function findStops(points) {
  const stops = [];
  var i = 0;
  while (i < points.length) {
    var j = i + 1;
    while (j < points.length && metersBetween(points[i], points[j]) <= STOP_RADIUS_M) j++;
    const mins = (new Date(points[j - 1].recorded_at) - new Date(points[i].recorded_at)) / 60000;
    if (j - 1 > i && mins >= STOP_MIN_MINUTES) {
      stops.push({
        lat: points[i].lat, lon: points[i].lon,
        from: points[i].recorded_at, to: points[j - 1].recorded_at,
        minutes: Math.round(mins), fixes: j - i
      });
      i = j;
    } else {
      i++;
    }
  }
  return stops;
}

// ---------------------------------------------------------------------------
//  SETTINGS
// ---------------------------------------------------------------------------
router.get('/settings', requireAuth, requirePermission('manage_settings'), async function (req, res) {
  const s = await loadSettings(true);
  res.json({ settings: s, defaults: SETTING_DEFAULTS });
});

router.post('/settings', requireAuth, requirePermission('manage_settings'), async function (req, res) {
  const body = req.body || {};
  const saved = {};
  for (var i = 0; i < SETTING_KEYS.length; i++) {
    const k = SETTING_KEYS[i];
    if (body[k] === undefined) continue;
    const v = String(body[k]).slice(0, 500);
    await pool.query(
      'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ' +
      'ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()', [k, v]);
    saved[k] = v;
  }
  invalidateSettings();
  await logAudit({ entity_type: 'location_settings', action: 'update', user_id: req.user.id, user_name: req.user.name, details: saved, ip: req.ip });
  const s = await loadSettings(true);
  res.json({ ok: true, saved: saved, settings: s });
});

// ---------------------------------------------------------------------------
//  PURGE - delete one tech's stored history
// ---------------------------------------------------------------------------
router.post('/purge/:userId', requireAuth, requirePermission('manage_tech_locations'), async function (req, res) {
  const uid = parseInt(req.params.userId, 10);
  if (!uid) return res.status(400).json({ error: 'Bad user' });
  const r = await pool.query('DELETE FROM location_pings WHERE user_id = $1', [uid]);
  await pool.query('DELETE FROM tech_locations WHERE user_id = $1', [uid]);
  await logAudit({ entity_type: 'location_history', entity_id: uid, action: 'purge', user_id: req.user.id, user_name: req.user.name, details: { deleted: r.rowCount || 0 }, ip: req.ip });
  res.json({ ok: true, deleted: r.rowCount || 0 });
});

// ---------------------------------------------------------------------------
//  Retention sweep, called by jobs/locationCleanup.js
// ---------------------------------------------------------------------------
async function sweepOldPings() {
  const s = await loadSettings(true);
  const days = numOf(s, 'location_retention_days', 1, 3650);
  const r = await pool.query(
    "DELETE FROM location_pings WHERE recorded_at < NOW() - ($1 || ' days')::interval", [String(days)]);
  return { deleted: r.rowCount || 0, days: days };
}

module.exports = router;
module.exports.sweepOldPings = sweepOldPings;
module.exports.loadSettings = loadSettings;
module.exports.cleanPing = cleanPing;
module.exports.findStops = findStops;
module.exports.metersBetween = metersBetween;
