const { pool } = require('../db');

// ---------------------------------------------------------------------------
//  Turning an address into coordinates
// ---------------------------------------------------------------------------
// One module, one function, so the provider is a config change rather than a
// project. Geocodio today; Google is written but deliberately gated (see the
// note on caching below, and on the map).
//
// Three rules this file exists to keep:
//
//   1. A geocode failure NEVER blocks a call. Dispatch works fine without
//      coordinates - it did for the whole of Phase 1. Anything in here that
//      could throw is caught and answered with null.
//
//   2. The same address is never paid for twice. Results are cached against a
//      normalised form of the address, so the same apartment complex, tow yard
//      or big-box lot bills once.
//
//   3. THE CACHE RESPECTS THE PROVIDER'S LICENCE. Geocodio permits keeping
//      coordinates indefinitely. Google does not - its terms allow a 30-day
//      cache and then require deletion, and separately forbid displaying the
//      result on a non-Google map. That TTL is encoded here rather than left to
//      somebody remembering it, because the difference between the two is a
//      contract, not a preference.
// ---------------------------------------------------------------------------

const PROVIDERS = {
  geocodio: {
    label: 'Geocodio',
    envKey: 'GEOCODIO_API_KEY',
    cacheDays: null,           // null = keep indefinitely; their terms allow it
    mapRestricted: false
  },
  google: {
    label: 'Google',
    envKey: 'GOOGLE_MAPS_API_KEY',
    cacheDays: 30,             // their terms: cache up to 30 days, then delete
    mapRestricted: true        // and only display on a Google map
  }
};

function providerName() {
  const want = String(process.env.GEOCODE_PROVIDER || '').toLowerCase();
  if (PROVIDERS[want]) return want;
  if (process.env.GEOCODIO_API_KEY) return 'geocodio';
  if (process.env.GOOGLE_MAPS_API_KEY) return 'google';
  return null;
}

function providerInfo() {
  const p = providerName();
  if (!p) return null;
  return Object.assign({ key: p }, PROVIDERS[p]);
}

function apiKey() {
  const p = providerInfo();
  return p ? (process.env[p.envKey] || null) : null;
}

function isConfigured() { return !!apiKey(); }

// Normalising is what makes the cache hit. Case, punctuation and doubled spaces
// are noise; "1699 Semoran N. Cir." and "1699 SEMORAN N CIR" are one address and
// should cost one lookup between them.
function normaliseAddress(parts) {
  const bits = [];
  if (typeof parts === 'string') bits.push(parts);
  else {
    if (parts.address) bits.push(parts.address);
    if (parts.city_state_zip) bits.push(parts.city_state_zip);
    else {
      if (parts.city) bits.push(parts.city);
      if (parts.state) bits.push(parts.state);
    }
    if (parts.zip && !(parts.city_state_zip || '').indexOf) bits.push(parts.zip);
    else if (parts.zip && String(parts.city_state_zip || '').indexOf(parts.zip) === -1) bits.push(parts.zip);
  }
  return bits.join(', ').toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

var _warned = false;
function warnOnce(msg) {
  if (_warned) return;
  _warned = true;
  console.log('Geocoding: ' + msg);
}

// ---------------------------------------------------------------------------
//  Cache
// ---------------------------------------------------------------------------
async function fromCache(key, provider) {
  try {
    const days = PROVIDERS[provider] && PROVIDERS[provider].cacheDays;
    var sql = 'SELECT lat, lon, accuracy, accuracy_type, formatted, provider FROM geocode_cache ' +
      'WHERE address_key = $1 AND provider = $2';
    const params = [key, provider];
    if (days) {
      // Expired rows are not returned AND are not silently kept: the sweep in
      // jobs/ deletes them. Both halves matter for a licence that says delete.
      sql += " AND created_at > NOW() - ($3 || ' days')::interval";
      params.push(String(days));
    }
    const r = await pool.query(sql, params);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

async function toCache(key, provider, hit) {
  try {
    await pool.query(
      'INSERT INTO geocode_cache (address_key, provider, formatted, lat, lon, accuracy, accuracy_type) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) ' +
      'ON CONFLICT (address_key, provider) DO UPDATE SET formatted = EXCLUDED.formatted, ' +
      ' lat = EXCLUDED.lat, lon = EXCLUDED.lon, accuracy = EXCLUDED.accuracy, ' +
      ' accuracy_type = EXCLUDED.accuracy_type, created_at = NOW(), hits = geocode_cache.hits + 1',
      [key, provider, hit.formatted, hit.lat, hit.lon, hit.accuracy, hit.accuracy_type]);
  } catch (e) { /* a cache write must never be the thing that fails a call */ }
}

async function bumpHit(key, provider) {
  try {
    await pool.query('UPDATE geocode_cache SET hits = hits + 1 WHERE address_key = $1 AND provider = $2',
      [key, provider]);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
//  Providers
// ---------------------------------------------------------------------------
// The key goes in the Authorization header, not on the query string: a key on a
// URL ends up in server logs, proxy logs and error traces.
async function callGeocodio(q, key) {
  const url = 'https://api.geocod.io/v2/geocode?q=' + encodeURIComponent(q) + '&limit=1';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + key } });
  if (!res.ok) throw new Error('Geocodio ' + res.status);
  const j = await res.json();
  const r = j && j.results && j.results[0];
  if (!r || !r.location) return null;
  return {
    lat: r.location.lat, lon: r.location.lng,
    accuracy: r.accuracy === undefined ? null : r.accuracy,
    accuracy_type: r.accuracy_type || null,
    formatted: r.formatted_address || q
  };
}

async function callGoogle(q, key) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
    encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Google ' + res.status);
  const j = await res.json();
  if (!j || j.status !== 'OK' || !j.results || !j.results.length) return null;
  const r = j.results[0];
  const loc = r.geometry && r.geometry.location;
  if (!loc) return null;
  const TYPE = { ROOFTOP: 'rooftop', RANGE_INTERPOLATED: 'range_interpolation',
    GEOMETRIC_CENTER: 'geometric_center', APPROXIMATE: 'approximate' };
  return {
    lat: loc.lat, lon: loc.lng,
    accuracy: null,
    accuracy_type: TYPE[(r.geometry && r.geometry.location_type) || ''] || null,
    formatted: r.formatted_address || q
  };
}

// The free US Census geocoder, used only as a backstop when the paid one cannot
// place an address. Public domain, no key, no storage restriction.
async function callCensus(q) {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress' +
    '?address=' + encodeURIComponent(q) + '&benchmark=Public_AR_Current&format=json';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Census ' + res.status);
  const j = await res.json();
  const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
  if (!m || !m.coordinates) return null;
  return {
    lat: m.coordinates.y, lon: m.coordinates.x,
    accuracy: null, accuracy_type: 'census',
    formatted: m.matchedAddress || q
  };
}

// ---------------------------------------------------------------------------
//  The one function everything else calls
// ---------------------------------------------------------------------------
/**
 * @param {string|object} parts an address string, or {address, city_state_zip, zip}
 * @returns {Promise<object|null>} {lat, lon, accuracy_type, provider, cached} or null
 */
async function geocode(parts, opts) {
  const o = opts || {};
  const q = normaliseAddress(parts);
  if (!q || q.length < 5) return null;

  const provider = providerName();
  if (!provider) {
    warnOnce('no provider key set, so addresses are not being converted to coordinates. ' +
      'Set GEOCODIO_API_KEY (or GOOGLE_MAPS_API_KEY) in Railway to switch it on.');
    return null;
  }
  const key = apiKey();
  if (!key) { warnOnce('provider ' + provider + ' selected but its key is missing.'); return null; }

  if (o.useCache !== false) {
    const hit = await fromCache(q, provider);
    if (hit) {
      bumpHit(q, provider);
      return { lat: Number(hit.lat), lon: Number(hit.lon), accuracy: hit.accuracy,
        accuracy_type: hit.accuracy_type, formatted: hit.formatted,
        provider: provider, cached: true };
    }
  }

  var hit = null;
  try {
    hit = provider === 'google' ? await callGoogle(q, key) : await callGeocodio(q, key);
  } catch (e) {
    console.log('Geocoding: ' + provider + ' failed for an address (' + e.message + ')');
  }

  // Backstop. Only reached when the paid provider gave nothing, so it costs
  // nothing on the happy path and rescues the rest.
  if (!hit && o.census !== false) {
    try { hit = await callCensus(q); }
    catch (e) { /* the backstop failing is not worth a log line every time */ }
  }
  if (!hit) return null;

  await toCache(q, hit.accuracy_type === 'census' ? provider : provider, hit);
  return Object.assign({}, hit, { provider: provider, cached: false });
}

// Straight-line miles. Deliberately computed here rather than bought: it is
// school arithmetic, it costs nothing, and it is what shortlists the two or
// three techs actually worth asking a paid routing provider about.
function milesBetween(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(function (v) { return v === null || v === undefined || !isFinite(Number(v)); })) return null;
  const R = 3958.7613;
  const toRad = function (d) { return Number(d) * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

// Is this point inside this ring? Ray casting, on a GeoJSON-style [[lon,lat],...]
// Used for drawn coverage zones; zip zones never reach it.
function pointInRing(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]), yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]), yj = Number(ring[j][1]);
    const hit = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

module.exports = {
  geocode: geocode,
  isConfigured: isConfigured,
  providerName: providerName,
  providerInfo: providerInfo,
  normaliseAddress: normaliseAddress,
  milesBetween: milesBetween,
  pointInRing: pointInRing,
  PROVIDERS: PROVIDERS
};
