// Parts Inventory, phase 1 (2026-10-05).
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files). Use string concatenation only.
//
// This is the COGS inventory: the parts and batteries that go onto invoices,
// held on a CITY SHELF or in a TECH'S VAN. It is NOT the equipment tracker in
// routes/assets.js (company tools issued to a tech and signed for). Tony asked
// for the two to be separate pages, and they are separate tables too.
//
// The one rule (PARTS_INVENTORY_PLAN.md, Tony 2026-07-31):
//
//     A tech can ADD stock. A tech can NEVER subtract stock.
//
// Theft makes the physical count fall while the system count stays high, so a
// shortage surfaces at the next count. If a tech could lower a number they
// would simply erase the shortage. Inflating a number only makes their own
// shortage look worse, so a manual add has no exploit. That is why POST /add
// refuses anything that is not a positive whole number, and why the only signed
// change (POST /adjust) needs manage_inventory and a written reason.
//
// The rule lives in the ENDPOINTS, not in the permission matrix: there is no
// "reduce stock" permission to tick by mistake.
//
// Phase 1 here: locations, the ledger, add stock, manager adjust, minimums,
// shelf <-> van transfers, per-part category / tracked settings.
// Phase 2 (not built): invoice consumption reconcile, PO receiving, blind
// counts, the waste queue, battery cores, the shrink reports.
//
// Scoping copies routes/assets.js on purpose: a manager sees the shelves and
// vans in THEIR OWN cities only. Admin/owner see everything. Do not "fix" this
// to the ['admin','manager'] see-all pattern used by deposits/invoices.
const express = require('express');
const { pool } = require('../db');
const { requireAuth, userHasExtraPerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const permissions = require('../utils/permissions');

const router = express.Router();

const CATEGORIES = ['locksmith', 'battery', 'other'];
// Roles that never carry a van. Admin/owner run the business, dispatchers sit
// at a desk. Everyone else with a home city gets one automatically.
const NO_VAN_ROLES = ['admin', 'owner', 'dispatcher'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}
// A strictly positive whole number, or null. Used for every add: "1.5" and
// "-3" and "0" are all refusals, never silently coerced into something else.
function positiveWhole(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n > 0 && n <= 100000 ? n : null;
}
function trunc(s, n) {
  if (s === null || s === undefined) return null;
  const t = String(s);
  return t.length > n ? t.slice(0, n) : t;
}
function cityOf(v) {
  if (!v) return null;
  const c = String(v).trim().toUpperCase();
  return c.length === 3 ? c : null;
}
function round4(n) { return Math.round(n * 10000) / 10000; }

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}
function sendErr(res, err, fallback) {
  if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  console.error(fallback + ':', err && err.message);
  return res.status(500).json({ error: fallback });
}

async function hasPerm(req, perm) {
  if (!req.user) return false;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (_) {}
  try { return await userHasExtraPerm(req, req.user.id, perm); } catch (_) { return false; }
}
async function canManage(req) { return hasPerm(req, 'manage_inventory'); }
async function canAdd(req) { return (await hasPerm(req, 'add_inventory')) || (await canManage(req)); }

// The module opens on view_inventory OR manage_inventory, so a role given
// manage without view is not locked out of the screen it manages.
async function requireView(req, res, next) {
  try {
    if (await hasPerm(req, 'view_inventory')) return next();
    if (await canManage(req)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
}
async function requireManage(req, res, next) {
  try {
    if (await canManage(req)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
}

// Same rule as routes/assets.js cityScope(): null = every city (admin/owner),
// otherwise the caller's user_cities, falling back to their home city.
async function cityScope(req) {
  if (!req.user) return [];
  if (req.user.role === 'admin' || req.user.isOwner) return null;
  var codes = [];
  try {
    const r = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [req.user.id]);
    codes = r.rows.map(function (x) { return (x.city_code || '').trim().toUpperCase(); }).filter(Boolean);
  } catch (e) { codes = []; }
  if (!codes.length) {
    try {
      const h = await pool.query('SELECT home_city FROM users WHERE id = $1', [req.user.id]);
      const hc = h.rows.length && h.rows[0].home_city ? String(h.rows[0].home_city).trim().toUpperCase() : '';
      if (hc) codes.push(hc);
    } catch (e) { /* leave empty */ }
  }
  return codes;
}
function scopeAllows(scope, cityCode) {
  if (scope === null) return true;
  if (!cityCode) return false;
  return scope.indexOf(String(cityCode).trim().toUpperCase()) !== -1;
}
function scopeClause(scope, params, col) {
  if (scope === null) return '';
  params.push(scope);
  return ' AND ' + col + ' = ANY($' + params.length + ')';
}

// PT-2026-0001. Not race-safe alone; callers retry on the unique violation.
async function nextNumber(client, prefix) {
  const year = new Date().getFullYear();
  const { rows } = await client.query(
    "SELECT MAX(CAST(SPLIT_PART(transfer_number, '-', 3) AS INTEGER)) AS maxseq FROM part_transfers WHERE EXTRACT(YEAR FROM created_at) = $1",
    [year]
  );
  return prefix + '-' + year + '-' + String((rows[0].maxseq || 0) + 1).padStart(4, '0');
}
async function withNumberRetry(fn) {
  var lastErr = null;
  for (var attempt = 0; attempt < 10; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (err && err.code === '23505' && attempt < 9) continue;
      throw err;
    }
  }
  throw lastErr || new Error('Could not allocate a number');
}

// ---------------------------------------------------------------------------
// Locations: created on demand, never set up by hand
// ---------------------------------------------------------------------------

// A van belongs to a PERSON, not a vehicle. Techs swap trucks; the parts follow
// the person, and invoices carry locksmith_id, which is how phase 2 knows which
// van a sold part came out of. If the tech's home city changes, the van moves
// with them (stock and all).
async function ensureVan(db, user) {
  if (!user || NO_VAN_ROLES.indexOf(user.role) !== -1) return null;
  const city = cityOf(user.home_city);
  if (!city) return null;
  const r = await db.query(
    "INSERT INTO stock_locations (kind, city_code, user_id, name) VALUES ('van', $1, $2, $3) " +
    "ON CONFLICT (user_id) WHERE kind = 'van' DO UPDATE SET city_code = EXCLUDED.city_code, name = EXCLUDED.name " +
    'RETURNING *',
    [city, user.id, trunc((user.name || 'Tech') + "'s Van", 120)]
  );
  return r.rows[0];
}

// One shelf per active city and one van per active tech, inside the caller's
// scope. Two INSERT ... SELECTs, both no-ops once everything exists.
async function provision(scope) {
  const p1 = [];
  const c1 = scope === null ? '' : ' AND UPPER(code) = ANY($1)';
  if (scope !== null) p1.push(scope);
  await pool.query(
    "INSERT INTO stock_locations (kind, city_code, name) " +
    "SELECT 'shelf', UPPER(code), UPPER(code) || ' Shelf' FROM cities WHERE active = true" + c1 + ' ' +
    "ON CONFLICT (city_code) WHERE kind = 'shelf' DO NOTHING",
    p1
  );
  const p2 = [NO_VAN_ROLES];
  const c2 = scope === null ? '' : ' AND UPPER(TRIM(u.home_city)) = ANY($2)';
  if (scope !== null) p2.push(scope);
  await pool.query(
    "INSERT INTO stock_locations (kind, city_code, user_id, name) " +
    "SELECT 'van', UPPER(TRIM(u.home_city)), u.id, LEFT(u.name || '''s Van', 120) FROM users u " +
    'WHERE u.active = true AND u.home_city IS NOT NULL AND LENGTH(TRIM(u.home_city)) = 3 AND NOT (u.role = ANY($1))' + c2 + ' ' +
    "ON CONFLICT (user_id) WHERE kind = 'van' DO NOTHING",
    p2
  );
}

async function loadLocation(db, id) {
  const r = await db.query(
    'SELECT l.*, u.name AS user_name, u.active AS user_active FROM stock_locations l LEFT JOIN users u ON u.id = l.user_id WHERE l.id = $1',
    [id]
  );
  return r.rows[0] || null;
}

// May this caller SEE this location? Their own van always; anything else only
// with manage_inventory and inside their cities.
async function canSeeLocation(req, loc, scope) {
  if (!loc) return false;
  if (loc.kind === 'van' && loc.user_id === req.user.id) return true;
  if (!(await canManage(req))) return false;
  return scopeAllows(scope, loc.city_code);
}

// ---------------------------------------------------------------------------
// THE ONLY place part_stock.qty_on_hand is allowed to change.
// ---------------------------------------------------------------------------
// Every caller gets a ledger row with the running total for free, exactly like
// adjustStock() in routes/assets.js, which is why both modules' counts can be
// trusted. Weighted average cost per location:
//   - an add re-averages what is on hand with what came in
//   - a reduction leaves the average alone and books the move AT the average
// Every move stores the actual unit cost, so FIFO stays derivable later.
// Negative stock is allowed at this layer (phase 2 invoice consumption must
// never block an invoice; the negative IS the alarm). Callers that should not
// go negative, like a transfer, check before calling.
async function adjustPartStock(client, o) {
  const delta = parseInt(o.delta, 10);
  if (!delta) throw httpError(400, 'Nothing to change.');
  await client.query(
    'INSERT INTO part_stock (part_id, location_id) VALUES ($1,$2) ON CONFLICT (part_id, location_id) DO NOTHING',
    [o.part_id, o.location_id]
  );
  const cur = (await client.query(
    'SELECT qty_on_hand, avg_cost FROM part_stock WHERE part_id = $1 AND location_id = $2 FOR UPDATE',
    [o.part_id, o.location_id]
  )).rows[0];
  const qty = cur.qty_on_hand || 0;
  const avg = cur.avg_cost === null || cur.avg_cost === undefined ? null : parseFloat(cur.avg_cost);
  var newAvg = avg;
  var moveCost = avg;
  if (delta > 0) {
    const cost = o.unit_cost !== null && o.unit_cost !== undefined && isFinite(o.unit_cost) ? Number(o.unit_cost) : avg;
    moveCost = cost;
    if (cost !== null) {
      const base = Math.max(qty, 0);
      newAvg = (avg === null || base === 0) ? cost : (base * avg + delta * cost) / (base + delta);
      newAvg = round4(newAvg);
    }
  }
  const upd = (await client.query(
    'UPDATE part_stock SET qty_on_hand = qty_on_hand + $1, avg_cost = $2, updated_at = NOW() WHERE part_id = $3 AND location_id = $4 RETURNING qty_on_hand',
    [delta, newAvg, o.part_id, o.location_id]
  )).rows[0];
  await client.query(
    'INSERT INTO part_stock_moves (part_id, part_label, location_id, delta, qty_after, unit_cost, avg_cost_after, reason, ref_type, ref_id, note, user_id, user_name) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [o.part_id, trunc(o.part_label || null, 255), o.location_id, delta, upd.qty_on_hand,
      moveCost === null ? null : round4(moveCost), newAvg, o.reason, o.ref_type || null, o.ref_id || null,
      trunc(o.note || null, 500), o.user ? o.user.id : null, o.user ? trunc(o.user.name, 255) : null]
  );
  return { qty_after: upd.qty_on_hand, avg_cost: newAvg };
}

function partLabel(p) {
  return (p.item_number ? p.item_number + ' - ' : '') + (p.description || 'Part');
}

async function loadParts(db, ids) {
  const r = await db.query('SELECT id, item_number, alias, description, price, category, track_inventory FROM parts WHERE id = ANY($1::int[])', [ids]);
  const byId = {};
  r.rows.forEach(function (p) { byId[p.id] = p; });
  return byId;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const STOCK_COLS =
  's.part_id, s.location_id, s.qty_on_hand, s.min_qty, s.avg_cost, s.updated_at, ' +
  'p.item_number, p.alias, p.description, p.category, p.price AS catalog_cost, p.retail_price, ' +
  'l.kind AS location_kind, l.name AS location_name, l.city_code, l.user_id AS location_user_id, ' +
  "CASE WHEN s.qty_on_hand < 0 THEN 'negative' WHEN s.qty_on_hand = 0 AND s.min_qty > 0 THEN 'out' " +
  "  WHEN s.min_qty > 0 AND s.qty_on_hand < s.min_qty THEN 'low' ELSE 'ok' END AS stock_status, " +
  '(GREATEST(s.qty_on_hand,0) * COALESCE(s.avg_cost, p.price, 0))::numeric(14,2) AS value';

router.get('/config', requireAuth, requireView, async (req, res) => {
  try {
    const manage = await canManage(req);
    const add = await canAdd(req);
    const me = (await pool.query('SELECT id, name, role, home_city FROM users WHERE id = $1', [req.user.id])).rows[0];
    var van = null;
    try { van = await ensureVan(pool, me); } catch (e) { van = null; }
    const scope = await cityScope(req);
    res.json({
      can_manage: manage, can_add: add, categories: CATEGORIES,
      my_van: van ? { id: van.id, name: van.name, city_code: van.city_code } : null,
      cities: scope === null ? null : scope
    });
  } catch (err) { sendErr(res, err, 'Failed to load inventory settings'); }
});

router.get('/locations', requireAuth, requireView, async (req, res) => {
  try {
    const manage = await canManage(req);
    const scope = await cityScope(req);
    const params = [];
    var where;
    if (manage) {
      await provision(scope);
      where = 'WHERE l.active = true' + scopeClause(scope, params, 'l.city_code');
    } else {
      params.push(req.user.id);
      where = "WHERE l.kind = 'van' AND l.user_id = $1";
    }
    const { rows } = await pool.query(
      'SELECT l.id, l.kind, l.city_code, l.user_id, l.name, l.last_counted_at, u.name AS user_name, u.active AS user_active, ' +
      '  COALESCE(a.lines,0)::int AS lines, COALESCE(a.units,0)::int AS units, COALESCE(a.value,0)::numeric(14,2) AS value, ' +
      '  COALESCE(a.low,0)::int AS low, COALESCE(a.negative,0)::int AS negative, m.last_move_at ' +
      'FROM stock_locations l LEFT JOIN users u ON u.id = l.user_id ' +
      'LEFT JOIN (SELECT s.location_id, COUNT(*) FILTER (WHERE s.qty_on_hand <> 0) AS lines, ' +
      '    SUM(GREATEST(s.qty_on_hand,0)) AS units, ' +
      '    SUM(GREATEST(s.qty_on_hand,0) * COALESCE(s.avg_cost, p.price, 0)) AS value, ' +
      '    COUNT(*) FILTER (WHERE s.min_qty > 0 AND s.qty_on_hand >= 0 AND s.qty_on_hand < s.min_qty) AS low, ' +
      '    COUNT(*) FILTER (WHERE s.qty_on_hand < 0) AS negative ' +
      '  FROM part_stock s JOIN parts p ON p.id = s.part_id GROUP BY s.location_id) a ON a.location_id = l.id ' +
      'LEFT JOIN (SELECT location_id, MAX(created_at) AS last_move_at FROM part_stock_moves GROUP BY location_id) m ON m.location_id = l.id ' +
      where + " ORDER BY l.city_code ASC, CASE WHEN l.kind = 'shelf' THEN 0 ELSE 1 END, l.name ASC",
      params
    );
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load locations'); }
});

router.get('/locations/:id', requireAuth, requireView, async (req, res) => {
  try {
    const scope = await cityScope(req);
    const loc = await loadLocation(pool, intOrNull(req.params.id));
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    if (!(await canSeeLocation(req, loc, scope))) return res.status(403).json({ error: 'That location is outside your cities.' });
    const stock = (await pool.query(
      'SELECT ' + STOCK_COLS + ' FROM part_stock s JOIN parts p ON p.id = s.part_id JOIN stock_locations l ON l.id = s.location_id ' +
      'WHERE s.location_id = $1 AND (s.qty_on_hand <> 0 OR s.min_qty > 0) ORDER BY p.category ASC, p.description ASC',
      [loc.id]
    )).rows;
    const moves = (await pool.query(
      'SELECT m.*, p.item_number, p.description FROM part_stock_moves m LEFT JOIN parts p ON p.id = m.part_id ' +
      'WHERE m.location_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT 100',
      [loc.id]
    )).rows;
    const totals = stock.reduce(function (a, r) {
      a.value += parseFloat(r.value) || 0;
      a.units += Math.max(r.qty_on_hand, 0);
      if (r.stock_status === 'low' || r.stock_status === 'out') a.low++;
      if (r.stock_status === 'negative') a.negative++;
      return a;
    }, { value: 0, units: 0, low: 0, negative: 0 });
    res.json({ location: loc, stock: stock, moves: moves, totals: totals, can_manage: await canManage(req), can_add: await canAdd(req) });
  } catch (err) { sendErr(res, err, 'Failed to load the location'); }
});

router.get('/locations/:id/moves', requireAuth, requireView, async (req, res) => {
  try {
    const scope = await cityScope(req);
    const loc = await loadLocation(pool, intOrNull(req.params.id));
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    if (!(await canSeeLocation(req, loc, scope))) return res.status(403).json({ error: 'That location is outside your cities.' });
    const params = [loc.id];
    var extra = '';
    const pid = intOrNull(req.query.part_id);
    if (pid) { params.push(pid); extra = ' AND m.part_id = $2'; }
    const { rows } = await pool.query(
      'SELECT m.*, p.item_number, p.description FROM part_stock_moves m LEFT JOIN parts p ON p.id = m.part_id ' +
      'WHERE m.location_id = $1' + extra + ' ORDER BY m.created_at DESC, m.id DESC LIMIT 500',
      params
    );
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load the ledger'); }
});

// Every part x location in the caller's cities.
router.get('/stock', requireAuth, requireManage, async (req, res) => {
  try {
    const scope = await cityScope(req);
    await provision(scope);
    const q = req.query || {};
    const params = [];
    var where = 'WHERE l.active = true AND (s.qty_on_hand <> 0 OR s.min_qty > 0)' + scopeClause(scope, params, 'l.city_code');
    if (cityOf(q.city)) { params.push(cityOf(q.city)); where += ' AND l.city_code = $' + params.length; }
    if (intOrNull(q.location_id)) { params.push(intOrNull(q.location_id)); where += ' AND l.id = $' + params.length; }
    if (CATEGORIES.indexOf(q.category) !== -1) { params.push(q.category); where += ' AND p.category = $' + params.length; }
    if (q.kind === 'shelf' || q.kind === 'van') { params.push(q.kind); where += ' AND l.kind = $' + params.length; }
    if (q.q) {
      params.push('%' + String(q.q).replace(/([\\%_])/g, '\\$1') + '%');
      const n = '$' + params.length;
      where += ' AND (p.item_number ILIKE ' + n + ' OR p.alias ILIKE ' + n + ' OR p.description ILIKE ' + n + ' OR l.name ILIKE ' + n + ')';
    }
    var sql = 'SELECT * FROM (SELECT ' + STOCK_COLS + ' FROM part_stock s JOIN parts p ON p.id = s.part_id JOIN stock_locations l ON l.id = s.location_id ' + where + ') x';
    if (['low', 'out', 'negative'].indexOf(q.status) !== -1) {
      params.push(q.status === 'low' ? ['low', 'out'] : [q.status]);
      sql += ' WHERE x.stock_status = ANY($' + params.length + ')';
    }
    const { rows } = await pool.query(sql + " ORDER BY x.description ASC, x.city_code ASC, CASE WHEN x.location_kind = 'shelf' THEN 0 ELSE 1 END, x.location_name ASC LIMIT 2000", params);
    const totals = rows.reduce(function (a, r) {
      a.value += parseFloat(r.value) || 0;
      a.units += Math.max(r.qty_on_hand, 0);
      if (r.stock_status === 'low' || r.stock_status === 'out') a.low++;
      if (r.stock_status === 'negative') a.negative++;
      return a;
    }, { value: 0, units: 0, low: 0, negative: 0 });
    totals.value = Math.round(totals.value * 100) / 100;
    res.json({ rows: rows, totals: totals, capped: rows.length >= 2000 });
  } catch (err) { sendErr(res, err, 'Failed to load inventory'); }
});

// The picker. Tracked parts only.
router.get('/parts', requireAuth, requireView, async (req, res) => {
  try {
    const q = String((req.query || {}).q || '').trim();
    const params = [];
    var where = 'WHERE p.track_inventory = true';
    if (q) {
      params.push('%' + q.replace(/([\\%_])/g, '\\$1') + '%');
      where += ' AND (p.item_number ILIKE $1 OR p.alias ILIKE $1 OR p.description ILIKE $1)';
    }
    const { rows } = await pool.query(
      'SELECT p.id, p.item_number, p.alias, p.description, p.category, p.price FROM parts p ' + where +
      ' ORDER BY p.description ASC LIMIT 50',
      params
    );
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to search parts'); }
});

// Part settings: which category and whether it is counted at all. Lives here
// rather than on the Parts List editor so routes/parts.js and its CSV import
// stay byte-for-byte as they were.
router.get('/part-settings', requireAuth, requireManage, async (req, res) => {
  try {
    const q = String((req.query || {}).q || '').trim();
    const params = [];
    var where = 'WHERE 1=1';
    if (q) {
      params.push('%' + q.replace(/([\\%_])/g, '\\$1') + '%');
      where += ' AND (p.item_number ILIKE $' + params.length + ' OR p.alias ILIKE $' + params.length + ' OR p.description ILIKE $' + params.length + ')';
    }
    if (CATEGORIES.indexOf(req.query.category) !== -1) { params.push(req.query.category); where += ' AND p.category = $' + params.length; }
    const { rows } = await pool.query(
      'SELECT p.id, p.item_number, p.alias, p.description, p.category, p.track_inventory, p.price, ' +
      '  COALESCE((SELECT SUM(s.qty_on_hand) FROM part_stock s WHERE s.part_id = p.id),0)::int AS on_hand ' +
      'FROM parts p ' + where + ' ORDER BY p.description ASC LIMIT 2000',
      params
    );
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load part settings'); }
});

router.post('/part-settings', requireAuth, requireManage, async (req, res) => {
  try {
    const b = req.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(intOrNull).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one part.' });
    const sets = [];
    const params = [];
    if (b.category !== undefined) {
      if (CATEGORIES.indexOf(b.category) === -1) return res.status(400).json({ error: 'Unknown category.' });
      params.push(b.category); sets.push('category = $' + params.length);
    }
    if (b.track_inventory !== undefined) { params.push(b.track_inventory === true); sets.push('track_inventory = $' + params.length); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    params.push(ids);
    const r = await pool.query('UPDATE parts SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = ANY($' + params.length + '::int[])', params);
    try { await logAudit({ entity_type: 'part', entity_id: ids[0], action: 'inventory_settings', user_id: req.user.id, user_name: req.user.name, details: { ids: ids.length, category: b.category, track_inventory: b.track_inventory } }); } catch (e) {}
    res.json({ success: true, updated: r.rowCount });
  } catch (err) { sendErr(res, err, 'Failed to save part settings'); }
});

router.get('/transfers', requireAuth, requireManage, async (req, res) => {
  try {
    const scope = await cityScope(req);
    const params = [];
    const sc = scope === null ? '' : (function () { params.push(scope); return ' WHERE (fl.city_code = ANY($1) OR tl.city_code = ANY($1))'; })();
    const { rows } = await pool.query(
      'SELECT t.*, fl.name AS from_name, fl.city_code AS from_city, tl.name AS to_name, tl.city_code AS to_city, ' +
      '  (SELECT COUNT(*) FROM part_transfer_lines x WHERE x.transfer_id = t.id)::int AS lines, ' +
      '  (SELECT COALESCE(SUM(x.qty),0) FROM part_transfer_lines x WHERE x.transfer_id = t.id)::int AS units ' +
      'FROM part_transfers t JOIN stock_locations fl ON fl.id = t.from_location_id JOIN stock_locations tl ON tl.id = t.to_location_id' +
      sc + ' ORDER BY t.created_at DESC LIMIT 100',
      params
    );
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load transfers'); }
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Add stock. The ONLY write a technician has. Positive whole numbers only.
//
// A tech adds at the catalog cost (or the van's running average); only a
// manager may type the price actually paid, because a typed cost moves the
// average and the average is what phase 2 books as COGS.
router.post('/add', requireAuth, requireView, async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    if (!(await canAdd(req))) return res.status(403).json({ error: 'You do not have permission to add stock.' });
    const manage = await canManage(req);
    const scope = await cityScope(req);
    const loc = await loadLocation(pool, intOrNull(b.location_id));
    if (!loc || !loc.active) return res.status(404).json({ error: 'Location not found' });
    const own = loc.kind === 'van' && loc.user_id === req.user.id;
    if (!own && !(manage && scopeAllows(scope, loc.city_code))) {
      return res.status(403).json({ error: 'You can only add stock to your own van.' });
    }
    const raw = Array.isArray(b.lines) ? b.lines : [];
    if (!raw.length) return res.status(400).json({ error: 'Add at least one part.' });
    const lines = [];
    for (var i = 0; i < raw.length; i++) {
      const ln = raw[i] || {};
      const pid = intOrNull(ln.part_id);
      const qty = positiveWhole(ln.qty);
      if (!pid) return res.status(400).json({ error: 'Line ' + (i + 1) + ' has no part.' });
      // The whole rule, in one line: an add is a positive whole number or it
      // is refused. There is no other path for a tech to touch a count.
      if (!qty) return res.status(400).json({ error: 'Line ' + (i + 1) + ': quantity must be a whole number of 1 or more. Stock can only be added here.' });
      var cost = null;
      if (manage && ln.unit_cost !== undefined && ln.unit_cost !== null && ln.unit_cost !== '') {
        cost = numOrNull(ln.unit_cost);
        if (cost === null || cost < 0) return res.status(400).json({ error: 'Line ' + (i + 1) + ': cost must be 0 or more.' });
      }
      lines.push({ part_id: pid, qty: qty, unit_cost: cost });
    }
    const parts = await loadParts(pool, lines.map(function (l) { return l.part_id; }));
    for (var k = 0; k < lines.length; k++) {
      const p = parts[lines[k].part_id];
      if (!p) return res.status(400).json({ error: 'One of those parts is not in the Parts List.' });
      if (p.track_inventory === false) return res.status(400).json({ error: partLabel(p) + ' is not tracked in inventory.' });
    }
    const note = trunc((b.note || '').trim() || null, 500);

    await client.query('BEGIN');
    const out = [];
    for (var j = 0; j < lines.length; j++) {
      const ln = lines[j];
      const p = parts[ln.part_id];
      // Cost precedence: typed by a manager > what this location already
      // averages > catalog cost. adjustPartStock() treats a null as "keep the
      // average", so only the catalog fallback has to be passed explicitly.
      var useCost = ln.unit_cost;
      if (useCost === null) {
        const cur = (await client.query('SELECT avg_cost FROM part_stock WHERE part_id = $1 AND location_id = $2', [ln.part_id, loc.id])).rows[0];
        if (!cur || cur.avg_cost === null) useCost = numOrNull(p.price);
      }
      const r = await adjustPartStock(client, {
        part_id: ln.part_id, part_label: partLabel(p), location_id: loc.id, delta: ln.qty, unit_cost: useCost,
        reason: ln.unit_cost !== null ? 'received' : 'added', ref_type: 'manual', note: note, user: req.user
      });
      out.push({ part_id: ln.part_id, qty_after: r.qty_after });
    }
    await client.query('COMMIT');
    try { await logAudit({ entity_type: 'inventory', entity_id: loc.id, entity_number: loc.name, action: 'stock_added', user_id: req.user.id, user_name: req.user.name, details: { lines: lines.length, units: lines.reduce(function (a, l) { return a + l.qty; }, 0), own_van: own } }); } catch (e) {}
    res.json({ success: true, lines: out });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to add stock');
  } finally { client.release(); }
});

// The only signed change. Manager, own cities, written reason, and an optional
// expected_qty so two managers editing the same line cannot clobber each other.
router.post('/adjust', requireAuth, requireManage, async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    const loc = await loadLocation(pool, intOrNull(b.location_id));
    if (!loc || !loc.active) return res.status(404).json({ error: 'Location not found' });
    if (!scopeAllows(scope, loc.city_code)) return res.status(403).json({ error: 'That location is outside your cities.' });
    const pid = intOrNull(b.part_id);
    const parts = await loadParts(pool, pid ? [pid] : []);
    const p = parts[pid];
    if (!p) return res.status(400).json({ error: 'Pick a part.' });
    const note = String(b.note || '').trim();
    if (note.length < 3) return res.status(400).json({ error: 'Write down why. Every adjustment is permanent and carries your name.' });

    await client.query('BEGIN');
    await client.query('INSERT INTO part_stock (part_id, location_id) VALUES ($1,$2) ON CONFLICT (part_id, location_id) DO NOTHING', [pid, loc.id]);
    const cur = (await client.query('SELECT qty_on_hand FROM part_stock WHERE part_id = $1 AND location_id = $2 FOR UPDATE', [pid, loc.id])).rows[0];
    const expected = intOrNull(b.expected_qty);
    if (expected !== null && expected !== cur.qty_on_hand) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The count changed to ' + cur.qty_on_hand + ' while you were editing. Check it and try again.', qty_on_hand: cur.qty_on_hand });
    }
    var delta;
    if (b.set_to !== undefined && b.set_to !== null && b.set_to !== '') {
      if (!/^-?\d+$/.test(String(b.set_to).trim())) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The new count must be a whole number.' }); }
      delta = parseInt(b.set_to, 10) - cur.qty_on_hand;
    } else {
      if (!/^-?\d+$/.test(String(b.delta === undefined ? '' : b.delta).trim())) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The change must be a whole number.' }); }
      delta = parseInt(b.delta, 10);
    }
    if (!delta) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'That is already the count. Nothing changed.' }); }
    const r = await adjustPartStock(client, {
      part_id: pid, part_label: partLabel(p), location_id: loc.id, delta: delta, unit_cost: null,
      reason: 'adjusted', ref_type: 'adjust', note: note, user: req.user
    });
    await client.query('COMMIT');
    try { await logAudit({ entity_type: 'inventory', entity_id: loc.id, entity_number: loc.name, action: 'stock_adjusted', user_id: req.user.id, user_name: req.user.name, details: { part: partLabel(p), delta: delta, qty_after: r.qty_after, note: note } }); } catch (e) {}
    res.json({ success: true, delta: delta, qty_after: r.qty_after });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to adjust stock');
  } finally { client.release(); }
});

router.put('/min', requireAuth, requireManage, async (req, res) => {
  try {
    const b = req.body || {};
    const scope = await cityScope(req);
    const loc = await loadLocation(pool, intOrNull(b.location_id));
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    if (!scopeAllows(scope, loc.city_code)) return res.status(403).json({ error: 'That location is outside your cities.' });
    const pid = intOrNull(b.part_id);
    if (!pid) return res.status(400).json({ error: 'Pick a part.' });
    const min = String(b.min_qty === undefined || b.min_qty === null ? '0' : b.min_qty).trim() || '0';
    if (!/^\d+$/.test(min)) return res.status(400).json({ error: 'Minimum must be a whole number of 0 or more.' });
    await pool.query(
      'INSERT INTO part_stock (part_id, location_id, min_qty) VALUES ($1,$2,$3) ' +
      'ON CONFLICT (part_id, location_id) DO UPDATE SET min_qty = EXCLUDED.min_qty, updated_at = NOW()',
      [pid, loc.id, parseInt(min, 10)]
    );
    res.json({ success: true });
  } catch (err) { sendErr(res, err, 'Failed to save the minimum'); }
});

// Shelf -> van (or any location -> any location) inside the caller's cities.
// Instant: both ends are in scope, so there is nobody else to confirm arrival.
// The cost travels with the part: out at the source average, in at that same
// cost, then re-averaged at the destination.
router.post('/transfers', requireAuth, requireManage, async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    const from = await loadLocation(pool, intOrNull(b.from_location_id));
    const to = await loadLocation(pool, intOrNull(b.to_location_id));
    if (!from || !to || !from.active || !to.active) return res.status(404).json({ error: 'Pick where it is coming from and where it is going.' });
    if (from.id === to.id) return res.status(400).json({ error: 'From and to are the same place.' });
    if (!scopeAllows(scope, from.city_code) || !scopeAllows(scope, to.city_code)) return res.status(403).json({ error: 'Both ends of a transfer must be in your cities.' });
    const raw = Array.isArray(b.lines) ? b.lines : [];
    const lines = [];
    for (var i = 0; i < raw.length; i++) {
      const pid = intOrNull(raw[i] && raw[i].part_id);
      const qty = positiveWhole(raw[i] && raw[i].qty);
      if (!pid || !qty) return res.status(400).json({ error: 'Line ' + (i + 1) + ' needs a part and a whole-number quantity.' });
      lines.push({ part_id: pid, qty: qty });
    }
    if (!lines.length) return res.status(400).json({ error: 'Add at least one part.' });
    const parts = await loadParts(pool, lines.map(function (l) { return l.part_id; }));
    const note = trunc((b.note || '').trim() || null, 500);

    const t = await withNumberRetry(async function () {
      await client.query('BEGIN');
      try {
        const number = await nextNumber(client, 'PT');
        const row = (await client.query(
          'INSERT INTO part_transfers (transfer_number, from_location_id, to_location_id, note, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [number, from.id, to.id, note, req.user.id, trunc(req.user.name, 255)]
        )).rows[0];
        for (var j = 0; j < lines.length; j++) {
          const ln = lines[j];
          const p = parts[ln.part_id];
          if (!p) throw httpError(400, 'One of those parts is not in the Parts List.');
          const src = (await client.query('SELECT qty_on_hand, avg_cost FROM part_stock WHERE part_id = $1 AND location_id = $2 FOR UPDATE', [ln.part_id, from.id])).rows[0];
          const have = src ? src.qty_on_hand : 0;
          if (have < ln.qty) throw httpError(400, from.name + ' only has ' + have + ' of ' + partLabel(p) + '.');
          const cost = src && src.avg_cost !== null ? parseFloat(src.avg_cost) : numOrNull(p.price);
          await adjustPartStock(client, {
            part_id: ln.part_id, part_label: partLabel(p), location_id: from.id, delta: -ln.qty,
            reason: 'transfer_out', ref_type: 'transfer', ref_id: row.id, note: 'To ' + to.name + ' (' + number + ')', user: req.user
          });
          await adjustPartStock(client, {
            part_id: ln.part_id, part_label: partLabel(p), location_id: to.id, delta: ln.qty, unit_cost: cost,
            reason: 'transfer_in', ref_type: 'transfer', ref_id: row.id, note: 'From ' + from.name + ' (' + number + ')', user: req.user
          });
          await client.query('INSERT INTO part_transfer_lines (transfer_id, part_id, part_label, qty, unit_cost) VALUES ($1,$2,$3,$4,$5)',
            [row.id, ln.part_id, trunc(partLabel(p), 255), ln.qty, cost === null ? null : round4(cost)]);
        }
        await client.query('COMMIT');
        return row;
      } catch (e) { await client.query('ROLLBACK').catch(function () {}); throw e; }
    });
    try { await logAudit({ entity_type: 'inventory_transfer', entity_id: t.id, entity_number: t.transfer_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { from: from.name, to: to.name, lines: lines.length } }); } catch (e) {}
    res.status(201).json(t);
  } catch (err) { sendErr(res, err, 'Failed to transfer stock'); }
  finally { client.release(); }
});

module.exports = router;
module.exports.adjustPartStock = adjustPartStock;
module.exports.CATEGORIES = CATEGORIES;
