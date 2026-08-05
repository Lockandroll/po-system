const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const zones = require('../utils/zones');
const geo = require('../utils/geocode');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Coverage zones
// ---------------------------------------------------------------------------
// Zip lists today; drawn shapes once a geocoding provider is switched on. Zones
// may not overlap - Tony's call - and that is enforced here rather than in the
// database, because "unique across ACTIVE zones only" needs a subquery Postgres
// will not accept in an index predicate.
//
// No overlap is worth more than tidiness: it makes a zone match UNIQUE, which is
// the only reason the ETA and price overrides can be applied without a
// precedence rule nobody would remember.
// ---------------------------------------------------------------------------

function s(v, n) { return v === undefined || v === null ? null : String(v).trim().slice(0, n) || null; }
function money(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// "32801, 32803 32804\n32806" - people paste zips out of anything.
function parseZips(raw) {
  if (Array.isArray(raw)) raw = raw.join(' ');
  return String(raw || '')
    .split(/[^0-9-]+/)
    .map(function (z) { return z.trim(); })
    .filter(function (z) { return /^\d{5}(-\d{4})?$/.test(z); })
    .filter(function (z, i, a) { return a.indexOf(z) === i; });
}

router.get('/', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  const params = [];
  var where = '';
  if (req.query.city) { params.push(String(req.query.city).trim().slice(0, 3)); where = ' WHERE TRIM(z.city_code) = TRIM($1)'; }
  const r = await pool.query(
    'SELECT z.*, c.name AS city_name, ' +
    "       COALESCE((SELECT json_agg(zz.zip ORDER BY zz.zip) FROM coverage_zone_zips zz WHERE zz.zone_id = z.id), '[]'::json) AS zips " +
    'FROM coverage_zones z LEFT JOIN cities c ON TRIM(c.code) = TRIM(z.city_code)' +
    where + ' ORDER BY z.city_code, z.sort, z.name', params);
  res.json({
    zones: r.rows,
    geocoding: {
      configured: geo.isConfigured(),
      provider: geo.providerName(),
      // Drawn shapes need coordinates, so the editor stays hidden until a
      // provider is live rather than offering a tool that cannot work.
      polygons_available: geo.isConfigured()
    }
  });
});

router.post('/', requireAuth, requirePermission('manage_coverage'), async function (req, res) {
  const b = req.body || {};
  const id = parseInt(b.id, 10) || null;
  const city = s(b.city_code, 3);
  const name = s(b.name, 120);
  if (!city || !name) return res.status(400).json({ error: 'A zone needs a city and a name.' });

  const kind = b.kind === 'polygon' ? 'polygon' : 'zip';
  if (kind === 'polygon' && !geo.isConfigured()) {
    return res.status(400).json({
      error: 'Drawn zones need a geocoding provider switched on. Zip zones work without one.',
      reason: 'no_geocoder'
    });
  }
  const zips = kind === 'zip' ? parseZips(b.zips) : [];
  if (kind === 'zip' && !zips.length) {
    return res.status(400).json({ error: 'A zip zone needs at least one zip code.' });
  }

  // The overlap guard, and it names the zone it clashes with so the message is
  // actionable rather than just a refusal.
  if (zips.length) {
    const clash = await zones.conflictingZips(zips, id);
    if (clash.length) {
      const first = clash[0];
      return res.status(400).json({
        error: 'Zip ' + first.zip + ' already belongs to "' + first.name + '"' +
          (String(first.city_code || '').trim() !== city ? ' in ' + String(first.city_code).trim() : '') +
          '. Zones cannot overlap - remove it there first.' +
          (clash.length > 1 ? ' (' + (clash.length - 1) + ' more zips clash too.)' : ''),
        reason: 'overlap',
        conflicts: clash
      });
    }
  }

  const fields = [city, name, kind, kind === 'polygon' ? JSON.stringify(b.polygon || null) : null,
    parseInt(b.eta_adjust_minutes, 10) || 0,
    ['flat', 'percent'].indexOf(b.price_adjust_type) !== -1 ? b.price_adjust_type : null,
    money(b.price_adjust_value),
    b.is_primary === false ? false : true,
    parseInt(b.sort, 10) || 0];

  const client = await pool.connect();
  var zoneId = id;
  try {
    await client.query('BEGIN');
    if (id) {
      await client.query(
        'UPDATE coverage_zones SET city_code=$1, name=$2, kind=$3, polygon=$4, eta_adjust_minutes=$5, ' +
        'price_adjust_type=$6, price_adjust_value=$7, is_primary=$8, sort=$9 WHERE id=$10',
        fields.concat([id]));
      await client.query('DELETE FROM coverage_zone_zips WHERE zone_id = $1', [id]);
    } else {
      const r = await client.query(
        'INSERT INTO coverage_zones (city_code, name, kind, polygon, eta_adjust_minutes, ' +
        'price_adjust_type, price_adjust_value, is_primary, sort) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', fields);
      zoneId = r.rows[0].id;
    }
    for (var i = 0; i < zips.length; i++) {
      await client.query('INSERT INTO coverage_zone_zips (zone_id, zip) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [zoneId, zips[i]]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }

  await logAudit({ entity_type: 'coverage_zone', entity_id: zoneId, action: id ? 'update' : 'create',
    user_id: req.user.id, user_name: req.user.name, details: { name: name, city: city, zips: zips.length }, ip: req.ip });
  res.json({ ok: true, id: zoneId, zips: zips.length });
});

router.post('/:id/deactivate', requireAuth, requirePermission('manage_coverage'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  // Deactivated rather than deleted: calls priced under this zone last month
  // still have to be explainable. Switching it off also frees its zips for
  // another zone, which is the normal way a market gets re-cut.
  const r = await pool.query('UPDATE coverage_zones SET active = false WHERE id = $1 RETURNING name', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  await logAudit({ entity_type: 'coverage_zone', entity_id: id, action: 'deactivate',
    user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip });
  res.json({ ok: true });
});

// Where would this address land? Used by the new-call form and by anyone asking
// why a call priced the way it did.
router.get('/lookup', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  const zip = s(req.query.zip, 10);
  const city = s(req.query.city_code, 3);
  var point = null;
  if (!zip && req.query.address) {
    try { point = await geo.geocode({ address: req.query.address, city_state_zip: req.query.city_state_zip }); }
    catch (e) { point = null; }
  }
  const hit = await zones.resolve({ zip: zip, city_code: city, lat: point && point.lat, lon: point && point.lon });
  res.json({
    zone: hit.zone, matched_by: hit.matched_by, out_of_area: hit.out_of_area,
    wrong_city: hit.wrong_city, point: point
  });
});

// How much of the geocoding bill the cache has already saved. Worth showing,
// because the answer to "is this getting expensive" is usually "no, look".
router.get('/geocode-status', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  var stats = { rows: 0, hits: 0, saved: 0 };
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS rows, COALESCE(SUM(hits),0)::int AS hits FROM geocode_cache');
    stats.rows = r.rows[0].rows;
    stats.hits = r.rows[0].hits;
    stats.saved = Math.max(0, stats.hits - stats.rows);
  } catch (e) {}
  const info = geo.providerInfo();
  res.json({
    configured: geo.isConfigured(),
    provider: info ? info.key : null,
    provider_label: info ? info.label : null,
    cache_days: info ? info.cacheDays : null,
    map_restricted: info ? info.mapRestricted : false,
    cache: stats
  });
});

module.exports = router;
module.exports.parseZips = parseZips;
