'use strict';
/*
 * Pop-A-Lock Royalty Statements — API (Nova)
 * ------------------------------------------
 * Import Pulsar "Call Search" data and produce the Automated Royalty & Advertising
 * Fund Statement per city, stored as history you can re-export (.xlsx) or
 * re-download (the original CSV) any time.
 *
 * Two import styles:
 *   - Combined: ONE export containing every city -> split by the Location column,
 *     one statement per city, each using that city's own saved rates.
 *   - Single:   one city's CSV at a time.
 *
 * Per-city rates + a location->city alias map + the motor-club list live in
 * settings (royalty_rates / royalty_location_map / royalty_motor_clubs) so nobody
 * has to remember a rate at import time.
 *
 * Routes (mounted at /api/royalty):
 *   GET    /                     list history (view_royalty)   ?city_id= &period=
 *   GET    /config               rates + location map + motor clubs + cities (view_royalty)
 *   PUT    /config               save rates / location map / motor clubs (manage_royalty)
 *   POST   /preview              single-city compute, no save (manage_royalty)
 *   POST   /                     single-city import + save (manage_royalty)
 *   POST   /preview-combined     split a combined CSV, compute each city (manage_royalty)
 *   POST   /import-combined      split + save every matched city (manage_royalty)
 *   GET    /:id                  one statement (view_royalty)
 *   GET    /:id/export.xlsx      formatted workbook (view_royalty)
 *   GET    /:id/source.csv       the stored CSV for that city (view_royalty)
 *   DELETE /:id                  remove a statement (manage_royalty)
 *
 * No backtick/template-literal strings are used in this file (Windows-safe).
 */

var express = require('express');
var { pool } = require('../db');
var { requireAuth, requirePermission } = require('../middleware/auth');
var eng = require('../utils/royaltyEngine');
var xl = require('../utils/royaltyExcel');

var router = express.Router();

var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function periodLabel(p) {
  var m = /^(\d{4})-(\d{2})$/.exec(String(p || ''));
  if (!m) return String(p || '');
  return (MONTHS[parseInt(m[2], 10) - 1] || m[2]) + ' ' + m[1];
}
function validPeriod(p) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || '')); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function num(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }
function safe(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'city'; }

// A rate row is always {royaltyRate, adRate, partsCostPct} as decimals (0.05 = 5%).
function normRate(o) {
  o = o || {};
  return { royaltyRate: num(o.royaltyRate, 0.05), adRate: num(o.adRate, 0.01), partsCostPct: num(o.partsCostPct, 0.75) };
}

// Load the royalty config from settings (rates by city + default, the location->city
// alias map, and the motor-club payer list), each with a sane fallback.
async function getConfig() {
  var out = {
    rates: { default: { royaltyRate: 0.05, adRate: 0.01, partsCostPct: 0.75 }, byCity: {} },
    locationMap: {},
    motorClubs: eng.MOTOR_CLUB.slice(),
    owner: 'Benjamin Landers'
  };
  try {
    var r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)',
      [['royalty_rates', 'royalty_location_map', 'royalty_motor_clubs', 'royalty_owner']]);
    r.rows.forEach(function (row) {
      if (row.key === 'royalty_owner') {
        var ov = row.value; try { var pj = JSON.parse(row.value); if (typeof pj === 'string') ov = pj; } catch (e) {}
        if (String(ov == null ? '' : ov).trim()) out.owner = String(ov).trim();
        return;
      }
      var v; try { v = JSON.parse(row.value); } catch (e) { return; }
      if (row.key === 'royalty_rates' && v && typeof v === 'object') {
        if (v.default) out.rates.default = normRate(v.default);
        if (v.byCity && typeof v.byCity === 'object') {
          Object.keys(v.byCity).forEach(function (k) { out.rates.byCity[String(k)] = normRate(v.byCity[k]); });
        }
      } else if (row.key === 'royalty_location_map' && v && typeof v === 'object') {
        Object.keys(v).forEach(function (k) { out.locationMap[String(k).toLowerCase()] = parseInt(v[k], 10); });
      } else if (row.key === 'royalty_motor_clubs' && Array.isArray(v) && v.length) {
        out.motorClubs = v.map(function (x) { return String(x).trim(); }).filter(Boolean);
      }
    });
  } catch (e) { /* fall through to defaults */ }
  return out;
}

function ratesForCity(cfg, cityId) {
  if (cityId != null && cfg.rates.byCity[String(cityId)]) return cfg.rates.byCity[String(cityId)];
  return cfg.rates.default;
}

async function citiesList() {
  var r = await pool.query(
    'SELECT c.id, c.name, c.code, u.name AS manager_name FROM cities c ' +
    'LEFT JOIN users u ON u.id = c.manager_user_id WHERE c.active = true ORDER BY c.name ASC'
  );
  return r.rows;
}

// Resolve a Location string to a city: explicit assignment wins, then the saved
// alias map, then a case-insensitive city-name match. Returns the city row or null.
function resolveCity(cfg, cities, loc, assignments) {
  var key = String(loc == null ? '' : loc).trim().toLowerCase();
  var id = null;
  if (assignments && assignments[loc] != null && assignments[loc] !== '') id = parseInt(assignments[loc], 10);
  else if (cfg.locationMap[key] != null && !isNaN(cfg.locationMap[key])) id = cfg.locationMap[key];
  else { var m = cities.filter(function (c) { return String(c.name || '').trim().toLowerCase() === key; })[0]; if (m) id = m.id; }
  if (!id) return null;
  return cities.filter(function (c) { return c.id === id; })[0] || null;
}

// Group parsed rows by their Location value.
function groupByLocation(rows) {
  var groups = {}, order = [];
  rows.forEach(function (r) {
    var loc = String(r['Location'] == null ? '' : r['Location']).trim();
    if (!groups[loc]) { groups[loc] = []; order.push(loc); }
    groups[loc].push(r);
  });
  return { groups: groups, order: order };
}

// Rebuild a CSV (header + rows) for one city's slice, so source.csv returns just
// that city's calls even when the import was a combined file.
function rowsToCsv(keys, rows) {
  function cell(v) { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  var out = keys.map(cell).join(',') + '\n';
  rows.forEach(function (r) { out += keys.map(function (k) { return cell(r[k]); }).join(',') + '\n'; });
  return out;
}

// Upsert one statement (city + period). Returns { id, replaced }.
async function saveStatement(p) {
  var settings = {
    royaltyRate: p.rates.royaltyRate, adRate: p.rates.adRate, partsCostPct: p.rates.partsCostPct,
    fractionAdj: p.fractionAdj || 0, roadClubAdj: p.roadClubAdj || 0, motorClub: p.motorClubs
  };
  var q = await pool.query(
    'INSERT INTO royalty_statements' +
    ' (city_id, city_code, city_name, owner_name, period, csv_data, csv_filename, cells, settings,' +
    '  royalty_fee, ad_fee, gross_sales, row_count, completed_count, unmapped, created_by, created_by_name, updated_at)' +
    ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())' +
    ' ON CONFLICT (city_id, period) DO UPDATE SET' +
    '  owner_name=EXCLUDED.owner_name, csv_data=EXCLUDED.csv_data, csv_filename=EXCLUDED.csv_filename,' +
    '  cells=EXCLUDED.cells, settings=EXCLUDED.settings, royalty_fee=EXCLUDED.royalty_fee, ad_fee=EXCLUDED.ad_fee,' +
    '  gross_sales=EXCLUDED.gross_sales, row_count=EXCLUDED.row_count, completed_count=EXCLUDED.completed_count,' +
    '  unmapped=EXCLUDED.unmapped, updated_at=NOW()' +
    ' RETURNING id, (xmax <> 0) AS replaced',
    [
      p.city.id, p.city.code, p.city.name, p.owner, p.period, p.csvData, (p.filename || null),
      JSON.stringify(p.cells), JSON.stringify(settings),
      round2(p.cells.I45), round2(p.cells.I49), round2(p.cells.I47),
      p.rowCount, p.completed, JSON.stringify(p.unmapped || []),
      p.userId, p.userName
    ]
  );
  return q.rows[0];
}

// Access is OWNER-gated, not role-gated: only owners see Royalty by default, and
// only owners manage the people list. Specific people are granted via extra_perms
// (view_royalty / manage_royalty) from the in-module access panel. Admins get NO
// automatic access — an owner must add them like anyone else.
function ownerOnly(req, res, next) {
  if (req.user && req.user.isOwner) return next();
  return res.status(403).json({ error: 'Owners only.' });
}
function royaltyGate(level) {
  return function (req, res, next) {
    if (req.user && req.user.isOwner) return next();
    var ep = (req._userRow && Array.isArray(req._userRow.extra_perms)) ? req._userRow.extra_perms : [];
    if (level === 'manage') { if (ep.indexOf('manage_royalty') !== -1) return next(); }
    else { if (ep.indexOf('view_royalty') !== -1 || ep.indexOf('manage_royalty') !== -1) return next(); }
    return res.status(403).json({ error: 'You do not have access to Royalty.' });
  };
}

// ---- list history -----------------------------------------------------------
router.get('/', requireAuth, royaltyGate('view'), async function (req, res) {
  var where = [], args = [];
  if (req.query.city_id) { args.push(parseInt(req.query.city_id, 10)); where.push('city_id = $' + args.length); }
  if (req.query.period) { args.push(String(req.query.period)); where.push('period = $' + args.length); }
  var sql =
    'SELECT id, city_id, city_code, city_name, owner_name, period, royalty_fee, ad_fee, gross_sales,' +
    ' completed_count, row_count, unmapped, created_by_name, created_at, updated_at FROM royalty_statements' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY period DESC, city_name ASC';
  var { rows } = await pool.query(sql, args);
  res.json(rows.map(function (r) {
    var un = Array.isArray(r.unmapped) ? r.unmapped : [];
    return {
      id: r.id, city_id: r.city_id, city_code: r.city_code, city_name: r.city_name, owner_name: r.owner_name,
      period: r.period, period_label: periodLabel(r.period),
      royalty_fee: Number(r.royalty_fee), ad_fee: Number(r.ad_fee), gross_sales: Number(r.gross_sales),
      completed_count: r.completed_count, row_count: r.row_count,
      unmapped_count: un.reduce(function (a, b) { return a + (b.count || 0); }, 0),
      created_by_name: r.created_by_name, created_at: r.created_at, updated_at: r.updated_at
    };
  }));
});

// ---- config (rates + location map + motor clubs) ----------------------------
router.get('/config', requireAuth, royaltyGate('view'), async function (req, res) {
  var cfg = await getConfig();
  var cities = await citiesList();
  res.json({ rates: cfg.rates, locationMap: cfg.locationMap, motorClubs: cfg.motorClubs, cities: cities });
});

router.put('/config', requireAuth, royaltyGate('manage'), async function (req, res) {
  var b = req.body || {};
  async function put(key, val) {
    await pool.query(
      'INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
      [key, JSON.stringify(val)]);
  }
  if (b.rates && typeof b.rates === 'object') {
    var clean = { default: normRate(b.rates.default), byCity: {} };
    if (b.rates.byCity && typeof b.rates.byCity === 'object') {
      Object.keys(b.rates.byCity).forEach(function (k) { if (/^\d+$/.test(String(k))) clean.byCity[String(k)] = normRate(b.rates.byCity[k]); });
    }
    await put('royalty_rates', clean);
  }
  if (b.locationMap && typeof b.locationMap === 'object') {
    var lm = {};
    Object.keys(b.locationMap).forEach(function (k) { var id = parseInt(b.locationMap[k], 10); if (!isNaN(id)) lm[String(k).toLowerCase()] = id; });
    await put('royalty_location_map', lm);
  }
  if (Array.isArray(b.motorClubs)) {
    await put('royalty_motor_clubs', b.motorClubs.map(function (x) { return String(x).trim(); }).filter(Boolean));
  }
  res.json({ success: true });
});

// ---- access list: owners choose exactly who can see/use Royalty --------------
router.get('/access', requireAuth, ownerOnly, async function (req, res) {
  var { rows } = await pool.query('SELECT id, name, email, role, title, extra_perms FROM users WHERE active = true ORDER BY name ASC');
  res.json(rows.map(function (u) {
    var ep = Array.isArray(u.extra_perms) ? u.extra_perms : [];
    var level = u.role === 'owner' ? 'owner'
      : (ep.indexOf('manage_royalty') !== -1 ? 'manage' : (ep.indexOf('view_royalty') !== -1 ? 'view' : 'none'));
    return { id: u.id, name: u.name, email: u.email, role: u.role, title: u.title || null, isOwner: u.role === 'owner', level: level };
  }));
});

router.put('/access', requireAuth, ownerOnly, async function (req, res) {
  var b = req.body || {};
  var uid = parseInt(b.user_id, 10);
  var level = String(b.level || 'none');
  if (!uid) return res.status(400).json({ error: 'A user is required.' });
  if (['none', 'view', 'manage'].indexOf(level) === -1) return res.status(400).json({ error: 'Invalid access level.' });
  var u = await pool.query('SELECT id, name, role, extra_perms FROM users WHERE id = $1', [uid]);
  if (!u.rows.length) return res.status(404).json({ error: 'User not found.' });
  if (u.rows[0].role === 'owner') return res.json({ user_id: uid, level: 'owner' }); // owners are always full; nothing to store
  var ep = Array.isArray(u.rows[0].extra_perms) ? u.rows[0].extra_perms.slice() : [];
  ep = ep.filter(function (p) { return p !== 'view_royalty' && p !== 'manage_royalty'; });
  if (level === 'view') ep.push('view_royalty');
  else if (level === 'manage') ep.push('view_royalty', 'manage_royalty');
  await pool.query('UPDATE users SET extra_perms = $1 WHERE id = $2', [ep, uid]);
  try {
    require('../utils/audit').logAudit({ entity_type: 'royalty', entity_id: uid, entity_number: 'access',
      action: 'access_' + level, user_id: req.user.id, user_name: req.user.name,
      details: { target_user: u.rows[0].name, level: level } });
  } catch (e) {}
  res.json({ user_id: uid, level: level });
});

// ---- single-city preview (no save) ------------------------------------------
router.post('/preview', requireAuth, royaltyGate('manage'), async function (req, res) {
  var b = req.body || {};
  if (!b.csv || !String(b.csv).trim()) return res.status(400).json({ error: 'No CSV data provided.' });
  var cfg = await getConfig();
  var rates = b.city_id ? ratesForCity(cfg, parseInt(b.city_id, 10)) : normRate({ royaltyRate: b.royaltyRate, adRate: b.adRate, partsCostPct: b.partsCostPct });
  var rows = eng.parseCSV(b.csv);
  if (!rows.length) return res.status(400).json({ error: 'The CSV had a header but no data rows.' });
  var r = eng.computeStatement(rows, {
    royaltyRate: rates.royaltyRate, adRate: rates.adRate, partsCostPct: rates.partsCostPct,
    fractionAdj: num(b.fractionAdj, 0), roadClubAdj: num(b.roadClubAdj, 0), motorClub: cfg.motorClubs
  });
  res.json({ cells: r.cells, meta: r.meta, rates: rates, motorClub: cfg.motorClubs,
    totals: { royalty_fee: round2(r.cells.I45), ad_fee: round2(r.cells.I49), gross_sales: round2(r.cells.I47) } });
});

// ---- single-city import + save ----------------------------------------------
router.post('/', requireAuth, royaltyGate('manage'), async function (req, res) {
  var b = req.body || {};
  var cityId = parseInt(b.city_id, 10);
  if (!cityId) return res.status(400).json({ error: 'A city is required.' });
  if (!validPeriod(b.period)) return res.status(400).json({ error: 'Statement period must look like 2026-05 (YYYY-MM).' });
  if (!b.csv || !String(b.csv).trim()) return res.status(400).json({ error: 'No CSV data provided.' });
  var cities = await citiesList();
  var city = cities.filter(function (c) { return c.id === cityId; })[0];
  if (!city) return res.status(404).json({ error: 'City not found.' });
  var cfg = await getConfig();
  var rates = (b.royaltyRate != null || b.adRate != null || b.partsCostPct != null)
    ? normRate({ royaltyRate: b.royaltyRate, adRate: b.adRate, partsCostPct: b.partsCostPct }) : ratesForCity(cfg, cityId);
  var rows = eng.parseCSV(b.csv);
  if (!rows.length) return res.status(400).json({ error: 'The CSV had a header but no data rows.' });
  var r = eng.computeStatement(rows, {
    royaltyRate: rates.royaltyRate, adRate: rates.adRate, partsCostPct: rates.partsCostPct,
    fractionAdj: num(b.fractionAdj, 0), roadClubAdj: num(b.roadClubAdj, 0), motorClub: cfg.motorClubs
  });
  var owner = (b.owner != null && String(b.owner).trim()) ? String(b.owner).trim() : (cfg.owner || '');
  var saved = await saveStatement({
    city: city, owner: owner, period: b.period, csvData: String(b.csv), filename: b.filename,
    cells: r.cells, rates: rates, fractionAdj: num(b.fractionAdj, 0), roadClubAdj: num(b.roadClubAdj, 0),
    motorClubs: cfg.motorClubs, rowCount: rows.length, completed: r.meta.completed, unmapped: r.meta.unmapped,
    userId: req.user.id, userName: req.user.name
  });
  try {
    require('../utils/audit').logAudit({ entity_type: 'royalty', entity_id: saved.id, entity_number: city.code + ' ' + b.period,
      action: saved.replaced ? 'updated' : 'created', user_id: req.user.id, user_name: req.user.name,
      details: { city: city.name, period: b.period, royalty_fee: round2(r.cells.I45) } });
  } catch (e) {}
  res.status(saved.replaced ? 200 : 201).json({ id: saved.id, replaced: !!saved.replaced, city_id: city.id, city_code: city.code,
    city_name: city.name, owner_name: owner, period: b.period, period_label: periodLabel(b.period),
    totals: { royalty_fee: round2(r.cells.I45), ad_fee: round2(r.cells.I49), gross_sales: round2(r.cells.I47) }, meta: r.meta });
});

// ---- combined: preview every city in one file -------------------------------
router.post('/preview-combined', requireAuth, royaltyGate('manage'), async function (req, res) {
  var b = req.body || {};
  if (!b.csv || !String(b.csv).trim()) return res.status(400).json({ error: 'No CSV data provided.' });
  var cfg = await getConfig();
  var cities = await citiesList();
  var assignments = b.assignments || {};
  var rows = eng.parseCSV(b.csv);
  if (!rows.length) return res.status(400).json({ error: 'The CSV had a header but no data rows.' });
  var g = groupByLocation(rows);
  var groups = g.order.map(function (loc) {
    var grp = g.groups[loc];
    var city = resolveCity(cfg, cities, loc, assignments);
    var rates = city ? ratesForCity(cfg, city.id) : cfg.rates.default;
    var r = eng.computeStatement(grp, { royaltyRate: rates.royaltyRate, adRate: rates.adRate, partsCostPct: rates.partsCostPct, motorClub: cfg.motorClubs });
    return {
      location: loc || '(no location)', rawLocation: loc, rowCount: grp.length, completed: r.meta.completed,
      city_id: city ? city.id : null, city_name: city ? city.name : null, city_code: city ? city.code : null,
      owner: city ? (cfg.owner || '') : null, matched: !!city, rates: rates,
      totals: { royalty_fee: round2(r.cells.I45), ad_fee: round2(r.cells.I49), gross_sales: round2(r.cells.I47) },
      unmapped: r.meta.unmapped
    };
  });
  groups.sort(function (a, b2) { return (a.city_name || a.location).localeCompare(b2.city_name || b2.location); });
  res.json({
    period: b.period || '', period_label: periodLabel(b.period), groups: groups,
    cities: cities.map(function (c) { return { id: c.id, name: c.name, code: c.code }; }),
    matched: groups.filter(function (x) { return x.matched; }).length,
    unmatched: groups.filter(function (x) { return !x.matched; }).length
  });
});

// ---- combined: split + save every matched city ------------------------------
router.post('/import-combined', requireAuth, royaltyGate('manage'), async function (req, res) {
  var b = req.body || {};
  if (!validPeriod(b.period)) return res.status(400).json({ error: 'Statement period must look like 2026-05 (YYYY-MM).' });
  if (!b.csv || !String(b.csv).trim()) return res.status(400).json({ error: 'No CSV data provided.' });
  var cfg = await getConfig();
  var cities = await citiesList();
  var assignments = b.assignments || {};
  var rows = eng.parseCSV(b.csv);
  if (!rows.length) return res.status(400).json({ error: 'The CSV had a header but no data rows.' });
  var keys = Object.keys(rows[0]);
  var g = groupByLocation(rows);
  var saved = [], skipped = [], learned = {};
  for (var i = 0; i < g.order.length; i++) {
    var loc = g.order[i], grp = g.groups[loc];
    var city = resolveCity(cfg, cities, loc, assignments);
    if (!city) { skipped.push({ location: loc || '(no location)', rows: grp.length }); continue; }
    var rates = ratesForCity(cfg, city.id);
    var r = eng.computeStatement(grp, { royaltyRate: rates.royaltyRate, adRate: rates.adRate, partsCostPct: rates.partsCostPct, motorClub: cfg.motorClubs });
    var row = await saveStatement({
      city: city, owner: cfg.owner || '', period: b.period, csvData: rowsToCsv(keys, grp),
      filename: (b.filename || null), cells: r.cells, rates: rates, motorClubs: cfg.motorClubs,
      rowCount: grp.length, completed: r.meta.completed, unmapped: r.meta.unmapped, userId: req.user.id, userName: req.user.name
    });
    if (loc) learned[String(loc).toLowerCase()] = city.id;
    saved.push({ id: row.id, replaced: !!row.replaced, city_id: city.id, city_name: city.name, city_code: city.code,
      period: b.period, totals: { royalty_fee: round2(r.cells.I45), ad_fee: round2(r.cells.I49), gross_sales: round2(r.cells.I47) },
      completed: r.meta.completed, unmapped_count: (r.meta.unmapped || []).reduce(function (a, x) { return a + (x.count || 0); }, 0) });
  }
  // Remember the location -> city mapping so next month auto-matches (unless opted out).
  if (b.rememberMap !== false && Object.keys(learned).length) {
    var merged = {}; Object.keys(cfg.locationMap).forEach(function (k) { merged[k] = cfg.locationMap[k]; });
    Object.keys(learned).forEach(function (k) { merged[k] = learned[k]; });
    await pool.query('INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
      ['royalty_location_map', JSON.stringify(merged)]);
  }
  try {
    require('../utils/audit').logAudit({ entity_type: 'royalty', entity_id: 0, entity_number: 'combined ' + b.period,
      action: 'imported', user_id: req.user.id, user_name: req.user.name,
      details: { period: b.period, saved: saved.length, skipped: skipped.length } });
  } catch (e) {}
  res.json({ period: b.period, period_label: periodLabel(b.period), saved: saved, skipped: skipped });
});

// ---- one statement ----------------------------------------------------------
router.get('/:id', requireAuth, royaltyGate('view'), async function (req, res) {
  var { rows } = await pool.query(
    'SELECT id, city_id, city_code, city_name, owner_name, period, cells, settings, royalty_fee, ad_fee, gross_sales,' +
    ' row_count, completed_count, unmapped, csv_filename, created_by_name, created_at, updated_at,' +
    ' (csv_data IS NOT NULL AND length(csv_data) > 0) AS has_csv FROM royalty_statements WHERE id = $1', [parseInt(req.params.id, 10)]);
  if (!rows.length) return res.status(404).json({ error: 'Statement not found.' });
  var r = rows[0];
  r.period_label = periodLabel(r.period);
  r.royalty_fee = Number(r.royalty_fee); r.ad_fee = Number(r.ad_fee); r.gross_sales = Number(r.gross_sales);
  res.json(r);
});

// ---- formatted .xlsx --------------------------------------------------------
router.get('/:id/export.xlsx', requireAuth, royaltyGate('view'), async function (req, res) {
  var { rows } = await pool.query('SELECT * FROM royalty_statements WHERE id = $1', [parseInt(req.params.id, 10)]);
  if (!rows.length) return res.status(404).json({ error: 'Statement not found.' });
  var r = rows[0], settings = r.settings || {}, callRows = [];
  try { if (r.csv_data) callRows = eng.parseCSV(r.csv_data); } catch (e) { callRows = []; }
  var buf = await xl.buildStatementBuffer({
    cells: r.cells || {}, city: r.city_name, owner: r.owner_name, period: r.period, periodLabel: periodLabel(r.period),
    rates: { royaltyRate: settings.royaltyRate, adRate: settings.adRate, partsCostPct: settings.partsCostPct },
    motorClub: settings.motorClub, rows: callRows
  });
  var fname = safe(r.city_code || r.city_name) + '_' + r.period + '_Royalty_Statement.xlsx';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
  res.send(Buffer.from(buf));
});

// ---- original CSV (re-download the source data) -----------------------------
router.get('/:id/source.csv', requireAuth, royaltyGate('view'), async function (req, res) {
  var { rows } = await pool.query('SELECT city_code, city_name, period, csv_data, csv_filename FROM royalty_statements WHERE id = $1', [parseInt(req.params.id, 10)]);
  if (!rows.length) return res.status(404).json({ error: 'Statement not found.' });
  var r = rows[0];
  if (!r.csv_data) return res.status(404).json({ error: 'No source CSV stored for this statement.' });
  var fname = safe(r.city_code || r.city_name) + '_' + r.period + '_CallSearch.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
  res.send(r.csv_data);
});

// ---- delete -----------------------------------------------------------------
router.delete('/:id', requireAuth, royaltyGate('manage'), async function (req, res) {
  var { rows } = await pool.query('DELETE FROM royalty_statements WHERE id = $1 RETURNING city_code, city_name, period', [parseInt(req.params.id, 10)]);
  if (!rows.length) return res.status(404).json({ error: 'Statement not found.' });
  try {
    require('../utils/audit').logAudit({ entity_type: 'royalty', entity_id: parseInt(req.params.id, 10), entity_number: rows[0].city_code + ' ' + rows[0].period,
      action: 'deleted', user_id: req.user.id, user_name: req.user.name, details: { city: rows[0].city_name, period: rows[0].period } });
  } catch (e) {}
  res.json({ success: true });
});

module.exports = router;
