const { pool } = require('../db');
const geo = require('./geocode');

// ---------------------------------------------------------------------------
//  Coverage zones
// ---------------------------------------------------------------------------
// Resolution order, and it is deliberately not the other way round:
//
//   1. the ZIP, matched exactly against an active zip zone
//   2. point-in-polygon on the geocoded coordinates, for drawn zones
//   3. no match -> OUT OF AREA. The call is still creatable; it gets tagged.
//
// Zip first because zip is exact and free, and a polygon needs a geocode that
// can fail. If polygon won, one bad geocode would silently move a call into the
// wrong market - and the wrong market is the wrong price, the wrong pay rule and
// the wrong royalty bucket.
// ---------------------------------------------------------------------------

async function zoneByZip(zip, cityCode) {
  const z = String(zip || '').trim().slice(0, 10);
  if (!z) return null;
  const params = [z];
  var sql =
    'SELECT cz.* FROM coverage_zone_zips zz JOIN coverage_zones cz ON cz.id = zz.zone_id ' +
    'WHERE zz.zip = $1 AND cz.active = true';
  // A city is a hint, not a filter: a zip that belongs to the neighbouring
  // market is exactly the case worth catching, so we look everywhere and let the
  // caller notice the zone came back with a different city on it.
  if (cityCode) { params.push(cityCode); sql += ' ORDER BY (TRIM(cz.city_code) = TRIM($2)) DESC, cz.sort'; }
  else sql += ' ORDER BY cz.sort';
  const r = await pool.query(sql + ' LIMIT 1', params);
  return r.rows[0] || null;
}

async function zoneByPoint(lat, lon, cityCode) {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
  const params = [];
  var sql = "SELECT * FROM coverage_zones WHERE active = true AND kind = 'polygon' AND polygon IS NOT NULL";
  if (cityCode) { params.push(cityCode); sql += ' ORDER BY (TRIM(city_code) = TRIM($1)) DESC, sort'; }
  else sql += ' ORDER BY sort';
  const r = await pool.query(sql, params);
  for (var i = 0; i < r.rows.length; i++) {
    const ring = r.rows[i].polygon;
    const coords = Array.isArray(ring) ? ring : (ring && ring.coordinates ? ring.coordinates[0] : null);
    if (geo.pointInRing(Number(lat), Number(lon), coords)) return r.rows[i];
  }
  return null;
}

/**
 * @param {object} o zip, city_code, lat, lon
 * @returns {zone|null, matched_by: 'zip'|'polygon'|null, out_of_area: bool,
 *           wrong_city: bool}
 */
async function hasZones(cityCode) {
  try {
    const r = await pool.query(
      'SELECT 1 FROM coverage_zones WHERE active = true' +
      (cityCode ? ' AND TRIM(city_code) = TRIM($1)' : '') + ' LIMIT 1',
      cityCode ? [cityCode] : []);
    return !!r.rows.length;
  } catch (e) { return false; }
}

async function resolve(o) {
  const opts = o || {};
  var zone = await zoneByZip(opts.zip, opts.city_code);
  var by = zone ? 'zip' : null;
  if (!zone) {
    zone = await zoneByPoint(opts.lat, opts.lon, opts.city_code);
    by = zone ? 'polygon' : null;
  }
  // ⚠️ "No zones drawn yet" is NOT "out of area". Before this distinction every
  // call on a fresh install got tagged Out of area, which is both noise and a
  // lie - you are not outside your coverage, the map simply has not been drawn.
  // No opinion beats a wrong opinion.
  const configured = await hasZones(opts.city_code);
  return {
    zone: zone,
    configured: configured,
    matched_by: by,
    out_of_area: configured && !zone,
    // The address resolved, but to somebody else's market. Worth surfacing
    // rather than swallowing: it is usually a typo in the zip, occasionally a
    // genuine border job, and it changes who gets paid for it.
    wrong_city: !!(zone && opts.city_code &&
      String(zone.city_code || '').trim() !== String(opts.city_code).trim())
  };
}

// Applied on top of whichever price won - the time code, or the account's
// contract rate. Blank means inherit, so a zone only has to say what differs.
function applyPriceAdjust(price, zone) {
  if (price === null || price === undefined || !zone) return { price: price, adjust: null };
  const type = zone.price_adjust_type;
  const val = zone.price_adjust_value === null || zone.price_adjust_value === undefined
    ? null : Number(zone.price_adjust_value);
  if (!type || val === null || !isFinite(val)) return { price: price, adjust: null };
  const base = Number(price);
  var out = base;
  if (type === 'flat') out = base + val;
  else if (type === 'percent') out = base * (1 + val / 100);
  out = Math.round(out * 100) / 100;
  return { price: out, adjust: Math.round((out - base) * 100) / 100 };
}

function applyEtaAdjust(minutes, zone) {
  if (minutes === null || minutes === undefined || !zone) return minutes;
  const adj = parseInt(zone.eta_adjust_minutes, 10);
  if (!isFinite(adj) || !adj) return minutes;
  return Math.max(1, Number(minutes) + adj);
}

// Which zips are already claimed by another ACTIVE zone. This is the guard that
// keeps "no overlap" true, and it names the zone it clashes with so the message
// is actionable rather than just a refusal.
async function conflictingZips(zips, exceptZoneId) {
  if (!Array.isArray(zips) || !zips.length) return [];
  const params = [zips];
  var sql =
    'SELECT zz.zip, cz.id, cz.name, cz.city_code FROM coverage_zone_zips zz ' +
    'JOIN coverage_zones cz ON cz.id = zz.zone_id ' +
    'WHERE zz.zip = ANY($1) AND cz.active = true';
  if (exceptZoneId) { params.push(exceptZoneId); sql += ' AND cz.id <> $' + params.length; }
  const r = await pool.query(sql, params);
  return r.rows;
}

module.exports = {
  resolve: resolve,
  hasZones: hasZones,
  zoneByZip: zoneByZip,
  zoneByPoint: zoneByPoint,
  applyPriceAdjust: applyPriceAdjust,
  applyEtaAdjust: applyEtaAdjust,
  conflictingZips: conflictingZips
};
