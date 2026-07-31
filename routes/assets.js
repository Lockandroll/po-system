// Asset / Equipment tracker.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files). Use string concatenation only.
//
// Per-LOCATION inventory of company property, assigned to individual techs,
// who initial each line and sign once for what they hold. Replacements are
// requested, reviewed against that tech's own history, and an approval opens a
// draft purchase order.
//
// Modelled on routes/vehicles.js (city-scoped reads, try/catch per handler,
// deactivate rather than delete) with ONE deliberate difference, documented on
// cityScope() below.
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { emailTemplate, sendEmail } = require('../utils/email');
const push = require('../utils/push');
const r2 = require('../utils/r2');
const poNum = require('../utils/poNumber');
const permissions = require('../utils/permissions');

const router = express.Router();

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

// Assets are scoped per LOCATION, on purpose. Unlike the rest of Nova, a
// manager is NOT privileged past their own cities here: each city runs its own
// inventory and must not be able to read or move another city's stock. Only
// admin/owner see across locations.
//
// DO NOT "fix" this to match cities.js / vehicles.js. It is the whole point of
// the module. Returns null for "every city", or an array of city codes.
async function cityScope(req) {
  if (!req.user) return [];
  if (req.user.role === 'admin' || req.user.isOwner) return null;
  var codes = [];
  try {
    const r = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [req.user.id]);
    codes = r.rows.map(function (x) { return (x.city_code || '').trim().toUpperCase(); }).filter(Boolean);
  } catch (e) { codes = []; }
  if (!codes.length) {
    // Fall back to their home city so a manager with no explicit city rows is
    // not locked out of everything.
    try {
      const h = await pool.query('SELECT home_city FROM users WHERE id = $1', [req.user.id]);
      const hc = h.rows.length && h.rows[0].home_city ? String(h.rows[0].home_city).trim().toUpperCase() : '';
      if (hc) codes.push(hc);
    } catch (e) { /* leave empty */ }
  }
  return codes;
}

// True when this request may act on the given city.
function scopeAllows(scope, cityCode) {
  if (scope === null) return true;
  if (!cityCode) return false;
  return scope.indexOf(String(cityCode).trim().toUpperCase()) !== -1;
}

// Appends "AND <col> = ANY($n)" when the caller is city-scoped. Mutates params.
function scopeClause(scope, params, col) {
  if (scope === null) return '';
  params.push(scope);
  return ' AND ' + col + ' = ANY($' + params.length + ')';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function posInt(v, dflt) {
  const n = parseInt(v, 10);
  return (isNaN(n) || n < 1) ? (dflt || 1) : n;
}
// Postgres raises 22001 on overflow and the global handler turns that into an
// opaque 500, so every string bound for a bounded column goes through here.
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

// Resolve and validate a city code against the cities table. Both PO creators
// in this codebase call city_code.toUpperCase() unguarded and insert whatever
// they are handed, so this module checks before it gets there.
async function assertCity(code) {
  const c = cityOf(code);
  if (!c) return null;
  const r = await pool.query('SELECT code FROM cities WHERE UPPER(code) = $1', [c]);
  return r.rows.length ? c : null;
}

// AA-2026-0071 / RR-2026-0118 / TR-2026-0031.
// Not race-safe on its own; every caller sits inside a retry loop that catches
// the unique violation, exactly like the PO numbering does.
async function nextNumber(client, table, col, prefix) {
  const year = new Date().getFullYear();
  const q = 'SELECT MAX(CAST(SPLIT_PART(' + col + ", '-', 3) AS INTEGER)) AS maxseq FROM " + table +
    ' WHERE EXTRACT(YEAR FROM created_at) = $1';
  const { rows } = await client.query(q, [year]);
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return prefix + '-' + year + '-' + seq;
}

// Retry wrapper for our own numbered records (23505 on the unique number).
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

// A tagged error so a handler can return a specific status from deep inside a
// transaction without unwinding through string matching.
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

// THE ONLY place asset_stock.qty_on_hand is allowed to change. Every caller
// gets a ledger row for free; nothing may update the count directly.
async function adjustStock(client, o) {
  const r = await client.query(
    'INSERT INTO asset_stock (asset_type_id, city_code, qty_on_hand, min_qty, updated_at) VALUES ($1,$2,$3,0,NOW()) ' +
    'ON CONFLICT (asset_type_id, city_code) DO UPDATE SET qty_on_hand = asset_stock.qty_on_hand + $3, updated_at = NOW() ' +
    'RETURNING qty_on_hand',
    [o.asset_type_id, o.city_code, o.delta]
  );
  const after = r.rows[0].qty_on_hand;
  await client.query(
    'INSERT INTO asset_stock_moves (asset_type_id, city_code, delta, reason, ref_type, ref_id, qty_after, user_id, user_name, note) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [o.asset_type_id, o.city_code, o.delta, o.reason, o.ref_type || null, o.ref_id || null, after,
      o.user ? o.user.id : null, o.user ? trunc(o.user.name, 255) : null, o.note || null]
  );
  return after;
}

async function stockOnHand(client, assetTypeId, cityCode) {
  const r = await client.query('SELECT qty_on_hand FROM asset_stock WHERE asset_type_id = $1 AND city_code = $2', [assetTypeId, cityCode]);
  return r.rows.length ? r.rows[0].qty_on_hand : 0;
}

// Claim one serialized unit at a city. SKIP LOCKED so two concurrent issues
// cannot hand the same physical tool to two people.
async function claimUnit(client, assetTypeId, cityCode, preferredAssetId) {
  var row = null;
  if (preferredAssetId) {
    const r = await client.query(
      "SELECT * FROM assets WHERE id = $1 AND asset_type_id = $2 AND status = 'in_stock' AND active = true FOR UPDATE",
      [preferredAssetId, assetTypeId]
    );
    row = r.rows.length ? r.rows[0] : null;
    if (!row) throw httpError(400, 'That unit is not available in stock any more. Pick another one.');
  } else {
    const r = await client.query(
      "SELECT * FROM assets WHERE asset_type_id = $1 AND city_code = $2 AND status = 'in_stock' AND active = true " +
      'ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED',
      [assetTypeId, cityCode]
    );
    row = r.rows.length ? r.rows[0] : null;
  }
  return row;
}

const DEFAULT_AGREEMENT =
  'I confirm I received the items I initialed above. I understand this equipment is the property of the company, ' +
  'that I am responsible for its safekeeping and reasonable care, and that I will return all of it on request or ' +
  'on my last day of employment. I will report loss, theft, or damage in Nova as soon as I know about it.';

// Reasons a unit does not come back to the shelf.
const LOST_REASONS = ['lost', 'stolen'];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

router.get('/config', requireAuth, async (req, res) => {
  const scope = await cityScope(req);
  res.json({
    photos: r2.configured(),
    all_cities: scope === null,
    cities: scope === null ? null : scope,
    agreement: DEFAULT_AGREEMENT
  });
});

// ---------------------------------------------------------------------------
// Equipment List (asset_types)
// ---------------------------------------------------------------------------

// Rollups are per-type and, for a scoped caller, only count their own cities.
async function typeRows(scope) {
  const params = [];
  const stockScope = scope === null ? '' : ' AND s.city_code = ANY($1)';
  const outScope = scope === null ? '' : ' AND h.city_code = ANY($1)';
  const asScope = scope === null ? '' : ' AND a.city_code = ANY($1)';
  if (scope !== null) params.push(scope);
  const sql =
    'SELECT t.*, ' +
    '  COALESCE((SELECT SUM(s.qty_on_hand) FROM asset_stock s WHERE s.asset_type_id = t.id' + stockScope + '), 0) AS counted_on_hand, ' +
    "  COALESCE((SELECT COUNT(*) FROM assets a WHERE a.asset_type_id = t.id AND a.status = 'in_stock' AND a.active = true" + asScope + '), 0) AS units_in_stock, ' +
    '  COALESCE((SELECT SUM(h.qty) FROM asset_holdings h WHERE h.asset_type_id = t.id AND h.returned_at IS NULL' + outScope + '), 0) AS out_with_techs, ' +
    "  COALESCE((SELECT COUNT(*) FROM asset_holdings h WHERE h.asset_type_id = t.id AND h.status = 'replaced' AND h.returned_at > NOW() - INTERVAL '12 months'" + outScope + '), 0) AS replaced_12mo, ' +
    '  COALESCE((SELECT SUM(s.min_qty) FROM asset_stock s WHERE s.asset_type_id = t.id' + stockScope + '), 0) AS min_total ' +
    'FROM asset_types t WHERE t.active = true ORDER BY t.position ASC, t.name ASC';
  const { rows } = await pool.query(sql, params);
  return rows;
}

router.get('/types', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    res.json(await typeRows(scope));
  } catch (err) { sendErr(res, err, 'Failed to load the equipment list'); }
});

router.get('/types/export', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const rows = await typeRows(await cityScope(req));
    const head = ['name', 'category', 'serialized', 'expected_life_months', 'vendor_name', 'item_number', 'manufacturer', 'unit_cost', 'product_url', 'notes'];
    function esc(v) {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var out = head.join(',') + '\n';
    rows.forEach(function (r) {
      out += head.map(function (k) { return esc(r[k]); }).join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="equipment-list.csv"');
    res.send(out);
  } catch (err) { sendErr(res, err, 'Failed to export the equipment list'); }
});

const CATEGORIES = ['tool', 'gear', 'uniform'];

function readTypeBody(b) {
  const cat = CATEGORIES.indexOf(b.category) !== -1 ? b.category : 'tool';
  return {
    name: trunc((b.name || '').trim(), 255),
    category: cat,
    serialized: b.serialized === true || b.serialized === 'true',
    expected_life_months: intOrNull(b.expected_life_months),
    vendor_name: trunc(b.vendor_name || null, 255),
    item_number: trunc(b.item_number || null, 255),
    manufacturer: trunc(b.manufacturer || null, 255),
    unit_cost: numOrNull(b.unit_cost),
    product_url: b.product_url || null,
    notes: b.notes || null
  };
}

router.post('/types', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const t = readTypeBody(req.body || {});
    if (!t.name) return res.status(400).json({ error: 'Name is required.' });
    const { rows } = await pool.query(
      'INSERT INTO asset_types (name, category, serialized, expected_life_months, vendor_name, item_number, manufacturer, unit_cost, product_url, notes) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [t.name, t.category, t.serialized, t.expected_life_months, t.vendor_name, t.item_number, t.manufacturer, t.unit_cost, t.product_url, t.notes]
    );
    try { await logAudit({ entity_type: 'asset_type', entity_id: rows[0].id, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { name: t.name } }); } catch (e) {}
    res.status(201).json(rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to add the equipment'); }
});

router.put('/types/:id', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const t = readTypeBody(req.body || {});
    if (!t.name) return res.status(400).json({ error: 'Name is required.' });
    // Flipping serialized on a type that already has history would orphan its
    // units or its counts, so it is locked once anything exists against it.
    const used = await pool.query(
      'SELECT (SELECT COUNT(*) FROM assets WHERE asset_type_id = $1)::int AS a, (SELECT COUNT(*) FROM asset_holdings WHERE asset_type_id = $1)::int AS h',
      [req.params.id]
    );
    const cur = await pool.query('SELECT serialized FROM asset_types WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Equipment not found' });
    const hasHistory = used.rows[0].a > 0 || used.rows[0].h > 0;
    const serialized = hasHistory ? cur.rows[0].serialized : t.serialized;
    const { rows } = await pool.query(
      'UPDATE asset_types SET name=$1, category=$2, serialized=$3, expected_life_months=$4, vendor_name=$5, item_number=$6, ' +
      'manufacturer=$7, unit_cost=$8, product_url=$9, notes=$10, updated_at=NOW() WHERE id=$11 RETURNING *',
      [t.name, t.category, serialized, t.expected_life_months, t.vendor_name, t.item_number, t.manufacturer, t.unit_cost, t.product_url, t.notes, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Equipment not found' });
    res.json(Object.assign({}, rows[0], { tracking_locked: hasHistory }));
  } catch (err) { sendErr(res, err, 'Failed to save the equipment'); }
});

router.post('/types/:id/deactivate', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const open = await pool.query('SELECT COUNT(*)::int AS n FROM asset_holdings WHERE asset_type_id = $1 AND returned_at IS NULL', [req.params.id]);
    if (open.rows[0].n > 0) {
      return res.status(400).json({ error: 'Collect the ' + open.rows[0].n + ' of these still out with techs before retiring the equipment type.' });
    }
    const { rows } = await pool.query('UPDATE asset_types SET active=false, updated_at=NOW() WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Equipment not found' });
    res.json({ success: true });
  } catch (err) { sendErr(res, err, 'Failed to retire the equipment'); }
});

// CSV import. Matches on name so a re-import updates rather than duplicates,
// which is how the equipment list gets its vendors and costs filled in bulk.
router.post('/types/bulk', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Nothing to import.' });
  if (items.length > 2000) return res.status(400).json({ error: 'Import at most 2000 rows at a time.' });
  const client = await pool.connect();
  var added = 0, updated = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    for (var i = 0; i < items.length; i++) {
      const t = readTypeBody(items[i] || {});
      if (!t.name) { skipped++; continue; }
      const ex = await client.query('SELECT id FROM asset_types WHERE LOWER(name) = LOWER($1)', [t.name]);
      if (ex.rows.length) {
        await client.query(
          'UPDATE asset_types SET category=$1, expected_life_months=COALESCE($2, expected_life_months), vendor_name=COALESCE($3, vendor_name), ' +
          'item_number=COALESCE($4, item_number), manufacturer=COALESCE($5, manufacturer), unit_cost=COALESCE($6, unit_cost), ' +
          'product_url=COALESCE($7, product_url), active=true, updated_at=NOW() WHERE id=$8',
          [t.category, t.expected_life_months, t.vendor_name, t.item_number, t.manufacturer, t.unit_cost, t.product_url, ex.rows[0].id]
        );
        updated++;
      } else {
        await client.query(
          'INSERT INTO asset_types (name, category, serialized, expected_life_months, vendor_name, item_number, manufacturer, unit_cost, product_url, notes) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [t.name, t.category, t.serialized, t.expected_life_months, t.vendor_name, t.item_number, t.manufacturer, t.unit_cost, t.product_url, t.notes]
        );
        added++;
      }
    }
    await client.query('COMMIT');
    res.json({ added: added, updated: updated, skipped: skipped });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Import failed');
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------

router.get('/kits', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM asset_kits WHERE active = true ORDER BY name ASC');
    const ids = rows.map(function (k) { return k.id; });
    var items = [];
    if (ids.length) {
      items = (await pool.query(
        'SELECT ki.*, t.name, t.category, t.serialized, t.unit_cost FROM asset_kit_items ki ' +
        'JOIN asset_types t ON t.id = ki.asset_type_id WHERE ki.kit_id = ANY($1) ORDER BY ki.position ASC, ki.id ASC',
        [ids]
      )).rows;
    }
    rows.forEach(function (k) { k.items = items.filter(function (i) { return i.kit_id === k.id; }); });
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load kits'); }
});

async function saveKitItems(client, kitId, items) {
  await client.query('DELETE FROM asset_kit_items WHERE kit_id = $1', [kitId]);
  for (var i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const typeId = intOrNull(it.asset_type_id);
    if (!typeId) continue;
    await client.query(
      'INSERT INTO asset_kit_items (kit_id, asset_type_id, qty, required, position) VALUES ($1,$2,$3,$4,$5)',
      [kitId, typeId, posInt(it.qty, 1), it.required !== false, i]
    );
  }
}

router.post('/kits', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name is required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO asset_kits (name, description, roles) VALUES ($1,$2,$3) RETURNING *',
      [trunc(b.name, 255), b.description || null, Array.isArray(b.roles) ? b.roles : []]
    );
    await saveKitItems(client, rows[0].id, Array.isArray(b.items) ? b.items : []);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to create the kit');
  } finally { client.release(); }
});

router.put('/kits/:id', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name is required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE asset_kits SET name=$1, description=$2, roles=$3 WHERE id=$4 RETURNING *',
      [trunc(b.name, 255), b.description || null, Array.isArray(b.roles) ? b.roles : [], req.params.id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Kit not found' }); }
    await saveKitItems(client, rows[0].id, Array.isArray(b.items) ? b.items : []);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to save the kit');
  } finally { client.release(); }
});

router.post('/kits/:id/deactivate', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE asset_kits SET active=false WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Kit not found' });
    res.json({ success: true });
  } catch (err) { sendErr(res, err, 'Failed to remove the kit'); }
});

// ---------------------------------------------------------------------------
// Inventory
//
// One table over two different shapes: every serialized unit, plus every open
// holding of a counted item (which is how "Tyler has 3 polo shirts" shows up).
// Counted stock still sitting on a shelf is a location concern and lives under
// /locations instead.
// ---------------------------------------------------------------------------

const INVENTORY_INNER =
  "  SELECT 'unit' AS kind, a.id AS row_id, a.id AS asset_id, a.asset_type_id, t.name, t.category, t.serialized," +
  '         a.asset_tag, a.serial_number, a.city_code, a.assigned_user_id, u.name AS holder_name,' +
  '         h.issued_at AS held_since, a.status, a.condition,' +
  '         COALESCE(t.unit_cost, a.purchase_cost) AS unit_cost, 1 AS qty, h.id AS holding_id,' +
  '         t.expected_life_months' +
  '  FROM assets a' +
  '  JOIN asset_types t ON t.id = a.asset_type_id' +
  '  LEFT JOIN users u ON u.id = a.assigned_user_id' +
  '  LEFT JOIN asset_holdings h ON h.asset_id = a.id AND h.returned_at IS NULL' +
  '  WHERE a.active = true AND t.serialized = true' +
  '  UNION ALL' +
  "  SELECT 'counted', h.id, NULL, h.asset_type_id, t.name, t.category, t.serialized," +
  "         NULL, NULL, h.city_code, h.user_id, u.name, h.issued_at, 'assigned', h.condition_out," +
  '         COALESCE(h.unit_cost, t.unit_cost), h.qty, h.id, t.expected_life_months' +
  '  FROM asset_holdings h' +
  '  JOIN asset_types t ON t.id = h.asset_type_id' +
  '  LEFT JOIN users u ON u.id = h.user_id' +
  '  WHERE h.returned_at IS NULL AND t.serialized = false' +
  '  UNION ALL' +
  // Counted stock still sitting on a shelf. Without this the table and the
  // headline numbers disagree, because a box of shirts nobody holds yet is
  // real inventory too.
  "  SELECT 'shelf', st.id, NULL, st.asset_type_id, t.name, t.category, t.serialized," +
  "         NULL, NULL, st.city_code, NULL, NULL, NULL, 'in_stock', NULL," +
  '         t.unit_cost, st.qty_on_hand, NULL, t.expected_life_months' +
  '  FROM asset_stock st' +
  '  JOIN asset_types t ON t.id = st.asset_type_id' +
  '  WHERE st.qty_on_hand > 0 AND t.serialized = false AND t.active = true';

function inventoryFilters(q, scope, params) {
  var w = '';
  if (scope !== null) { params.push(scope); w += ' AND x.city_code = ANY($' + params.length + ')'; }
  if (q.city) { params.push(cityOf(q.city)); w += ' AND x.city_code = $' + params.length; }
  if (q.user_id) { params.push(intOrNull(q.user_id)); w += ' AND x.assigned_user_id = $' + params.length; }
  if (q.category) { params.push(q.category); w += ' AND x.category = $' + params.length; }
  if (q.status) { params.push(q.status); w += ' AND x.status = $' + params.length; }
  if (q.asset_type_id) { params.push(intOrNull(q.asset_type_id)); w += ' AND x.asset_type_id = $' + params.length; }
  if (q.from) { params.push(q.from); w += ' AND x.held_since >= $' + params.length; }
  if (q.to) { params.push(q.to); w += ' AND x.held_since < ($' + params.length + '::date + 1)'; }
  if (q.q) {
    // Escape the LIKE metacharacters so a serial containing % or _ still
    // matches literally.
    const term = '%' + String(q.q).replace(/([\\%_])/g, '\\$1') + '%';
    params.push(term);
    const n = '$' + params.length;
    w += ' AND (x.name ILIKE ' + n + " ESCAPE '\\' OR COALESCE(x.asset_tag,'') ILIKE " + n + " ESCAPE '\\'" +
      " OR COALESCE(x.serial_number,'') ILIKE " + n + " ESCAPE '\\' OR COALESCE(x.holder_name,'') ILIKE " + n + " ESCAPE '\\')";
  }
  return w;
}

router.get('/', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const q = req.query || {};
    const params = [];
    const where = inventoryFilters(q, scope, params);
    const page = posInt(q.page, 1);
    const size = Math.min(posInt(q.page_size, 25), 500);

    const totals = await pool.query(
      'SELECT COUNT(*)::int AS n, COALESCE(SUM(x.unit_cost * x.qty),0)::numeric AS value FROM (' +
      INVENTORY_INNER + ') x WHERE 1=1' + where,
      params
    );

    const listParams = params.slice();
    listParams.push(size); const lim = '$' + listParams.length;
    listParams.push((page - 1) * size); const off = '$' + listParams.length;
    const { rows } = await pool.query(
      'SELECT x.*, (SELECT COUNT(*) FROM asset_holdings hh WHERE hh.user_id = x.assigned_user_id ' +
      "  AND hh.asset_type_id = x.asset_type_id AND hh.status = 'replaced')::int AS times_replaced " +
      'FROM (' + INVENTORY_INNER + ') x WHERE 1=1' + where +
      ' ORDER BY x.name ASC, x.asset_tag ASC NULLS LAST, x.row_id ASC LIMIT ' + lim + ' OFFSET ' + off,
      listParams
    );

    res.json({
      items: rows,
      total: totals.rows[0].n,
      value: parseFloat(totals.rows[0].value) || 0,
      page: page,
      page_size: size
    });
  } catch (err) { sendErr(res, err, 'Failed to load inventory'); }
});

// Company-wide (or scope-wide) headline numbers for the Inventory screen.
router.get('/stats', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const p1 = []; const s1 = scopeClause(scope, p1, 'a.city_code');
    const units = await pool.query(
      'SELECT COUNT(*)::int AS total, ' +
      "  COUNT(*) FILTER (WHERE a.status = 'assigned')::int AS assigned, " +
      "  COUNT(*) FILTER (WHERE a.status = 'in_stock')::int AS in_stock, " +
      "  COUNT(*) FILTER (WHERE a.status IN ('needs_repair','awaiting_return'))::int AS attention, " +
      "  COUNT(*) FILTER (WHERE a.status = 'lost')::int AS lost, " +
      '  COALESCE(SUM(COALESCE(t.unit_cost, a.purchase_cost, 0)),0)::numeric AS value ' +
      'FROM assets a JOIN asset_types t ON t.id = a.asset_type_id WHERE a.active = true' + s1,
      p1
    );
    const p2 = []; const s2 = scopeClause(scope, p2, 'h.city_code');
    const counted = await pool.query(
      'SELECT COALESCE(SUM(h.qty),0)::int AS out_qty, COALESCE(SUM(h.qty * COALESCE(h.unit_cost, t.unit_cost, 0)),0)::numeric AS value ' +
      'FROM asset_holdings h JOIN asset_types t ON t.id = h.asset_type_id ' +
      'WHERE h.returned_at IS NULL AND t.serialized = false' + s2,
      p2
    );
    const p3 = []; const s3 = scopeClause(scope, p3, 's.city_code');
    const shelf = await pool.query(
      'SELECT COALESCE(SUM(s.qty_on_hand),0)::int AS qty, COALESCE(SUM(s.qty_on_hand * COALESCE(t.unit_cost,0)),0)::numeric AS value ' +
      'FROM asset_stock s JOIN asset_types t ON t.id = s.asset_type_id WHERE 1=1' + s3,
      p3
    );
    const u = units.rows[0], c = counted.rows[0], sh = shelf.rows[0];
    res.json({
      tracked: u.total + c.out_qty + sh.qty,
      assigned: u.assigned + c.out_qty,
      in_stock: u.in_stock + sh.qty,
      attention: u.attention,
      lost: u.lost,
      value: (parseFloat(u.value) || 0) + (parseFloat(c.value) || 0) + (parseFloat(sh.value) || 0)
    });
  } catch (err) { sendErr(res, err, 'Failed to load inventory stats'); }
});

// Must stay ABOVE /:id. Quotes learned this the hard way.
router.get('/search', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const term = String(req.query.q || '').trim();
    if (term.length < 2) return res.json([]);
    const scope = await cityScope(req);
    const params = ['%' + term.replace(/([\\%_])/g, '\\$1') + '%'];
    const s = scopeClause(scope, params, 'a.city_code');
    const { rows } = await pool.query(
      'SELECT a.id, a.asset_tag, a.serial_number, a.status, a.city_code, t.name, u.name AS holder_name ' +
      'FROM assets a JOIN asset_types t ON t.id = a.asset_type_id LEFT JOIN users u ON u.id = a.assigned_user_id ' +
      "WHERE a.active = true AND (t.name ILIKE $1 ESCAPE '\\' OR COALESCE(a.asset_tag,'') ILIKE $1 ESCAPE '\\' " +
      "  OR COALESCE(a.serial_number,'') ILIKE $1 ESCAPE '\\')" + s + ' ORDER BY t.name ASC LIMIT 20',
      params
    );
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Search failed'); }
});

router.get('/export', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const params = [];
    const where = inventoryFilters(req.query || {}, scope, params);
    const { rows } = await pool.query(
      'SELECT x.* FROM (' + INVENTORY_INNER + ') x WHERE 1=1' + where + ' ORDER BY x.name ASC',
      params
    );
    const head = ['name', 'category', 'asset_tag', 'serial_number', 'city_code', 'holder_name', 'held_since', 'status', 'condition', 'qty', 'unit_cost'];
    function esc(v) {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var out = head.join(',') + '\n';
    rows.forEach(function (r) { out += head.map(function (k) { return esc(r[k]); }).join(',') + '\n'; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
    res.send(out);
  } catch (err) { sendErr(res, err, 'Export failed'); }
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

router.get('/locations', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const all = (await pool.query('SELECT code, name FROM cities WHERE active = true ORDER BY name ASC')).rows;
    const cities = all.filter(function (c) { return scopeAllows(scope, c.code); });
    const out = [];
    for (var i = 0; i < cities.length; i++) {
      const code = String(cities[i].code).trim().toUpperCase();
      const u = (await pool.query(
        'SELECT COUNT(*)::int AS total, ' +
        "  COUNT(*) FILTER (WHERE status = 'assigned')::int AS assigned, " +
        "  COUNT(*) FILTER (WHERE status = 'in_stock')::int AS in_stock, " +
        "  COUNT(*) FILTER (WHERE status = 'awaiting_return')::int AS awaiting_return, " +
        '  COALESCE(SUM(COALESCE(t.unit_cost, a.purchase_cost, 0)),0)::numeric AS value ' +
        'FROM assets a JOIN asset_types t ON t.id = a.asset_type_id WHERE a.active = true AND a.city_code = $1',
        [code]
      )).rows[0];
      const s = (await pool.query(
        'SELECT COALESCE(SUM(s.qty_on_hand),0)::int AS qty, ' +
        '  COUNT(*) FILTER (WHERE s.min_qty > 0 AND s.qty_on_hand < s.min_qty)::int AS below_min, ' +
        '  COALESCE(SUM(s.qty_on_hand * COALESCE(t.unit_cost,0)),0)::numeric AS value ' +
        'FROM asset_stock s JOIN asset_types t ON t.id = s.asset_type_id WHERE s.city_code = $1',
        [code]
      )).rows[0];
      const h = (await pool.query(
        'SELECT COALESCE(SUM(h.qty),0)::int AS qty, COALESCE(SUM(h.qty * COALESCE(h.unit_cost, t.unit_cost, 0)),0)::numeric AS value ' +
        'FROM asset_holdings h JOIN asset_types t ON t.id = h.asset_type_id ' +
        'WHERE h.returned_at IS NULL AND t.serialized = false AND h.city_code = $1',
        [code]
      )).rows[0];
      out.push({
        code: code, name: cities[i].name,
        items: u.total + s.qty + h.qty,
        out_with_techs: u.assigned + h.qty,
        on_shelf: u.in_stock + s.qty,
        below_min: s.below_min,
        awaiting_return: u.awaiting_return,
        value: (parseFloat(u.value) || 0) + (parseFloat(s.value) || 0) + (parseFloat(h.value) || 0)
      });
    }
    res.json(out);
  } catch (err) { sendErr(res, err, 'Failed to load locations'); }
});

router.get('/locations/:cityCode', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const code = cityOf(req.params.cityCode);
    if (!code) return res.status(400).json({ error: 'Unknown city.' });
    if (!scopeAllows(scope, code)) return res.status(403).json({ error: 'That location is outside your cities.' });
    const { rows } = await pool.query(
      'SELECT t.id AS asset_type_id, t.name, t.category, t.serialized, t.unit_cost, t.vendor_name, t.item_number, ' +
      '  COALESCE(s.qty_on_hand, 0) AS counted_on_hand, COALESCE(s.min_qty, 0) AS min_qty, ' +
      "  (SELECT COUNT(*) FROM assets a WHERE a.asset_type_id = t.id AND a.city_code = $1 AND a.status = 'in_stock' AND a.active = true)::int AS units_in_stock, " +
      "  (SELECT COUNT(*) FROM assets a WHERE a.asset_type_id = t.id AND a.city_code = $1 AND a.status = 'awaiting_return' AND a.active = true)::int AS awaiting_return, " +
      '  COALESCE((SELECT SUM(h.qty) FROM asset_holdings h WHERE h.asset_type_id = t.id AND h.city_code = $1 AND h.returned_at IS NULL),0)::int AS out_with_techs, ' +
      "  COALESCE((SELECT COUNT(*) FROM asset_holdings h WHERE h.asset_type_id = t.id AND h.city_code = $1 AND h.status = 'replaced' AND h.returned_at > NOW() - INTERVAL '12 months'),0)::int AS replaced_12mo " +
      'FROM asset_types t LEFT JOIN asset_stock s ON s.asset_type_id = t.id AND s.city_code = $1 ' +
      'WHERE t.active = true ORDER BY t.category ASC, t.name ASC',
      [code]
    );
    rows.forEach(function (r) {
      r.on_shelf = r.serialized ? r.units_in_stock : r.counted_on_hand;
      r.below_min = r.min_qty > 0 && r.on_shelf < r.min_qty;
      r.shelf_value = (parseFloat(r.unit_cost) || 0) * r.on_shelf;
    });
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load the location'); }
});

router.get('/locations/:cityCode/ledger', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const code = cityOf(req.params.cityCode);
    if (!code) return res.status(400).json({ error: 'Unknown city.' });
    if (!scopeAllows(scope, code)) return res.status(403).json({ error: 'That location is outside your cities.' });
    const limit = Math.min(posInt(req.query.limit, 50), 500);
    const { rows } = await pool.query(
      'SELECT m.*, t.name FROM asset_stock_moves m JOIN asset_types t ON t.id = m.asset_type_id ' +
      'WHERE m.city_code = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2',
      [code, limit]
    );
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load the ledger'); }
});

router.put('/locations/:cityCode/stock', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    const code = cityOf(req.params.cityCode);
    const b = req.body || {};
    const typeId = intOrNull(b.asset_type_id);
    const to = intOrNull(b.qty_on_hand);
    if (!code) return res.status(400).json({ error: 'Unknown city.' });
    if (!scopeAllows(scope, code)) return res.status(403).json({ error: 'That location is outside your cities.' });
    if (!typeId || to === null) return res.status(400).json({ error: 'Pick the equipment and a new count.' });
    if (to < 0) return res.status(400).json({ error: 'A count cannot be negative.' });
    if (!b.note) return res.status(400).json({ error: 'Say why the count is changing.' });
    await client.query('BEGIN');
    const cur = await stockOnHand(client, typeId, code);
    const delta = to - cur;
    if (delta !== 0) {
      await adjustStock(client, {
        asset_type_id: typeId, city_code: code, delta: delta, reason: 'adjustment',
        user: req.user, note: b.note
      });
    }
    await client.query('COMMIT');
    res.json({ success: true, qty_on_hand: to, delta: delta });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to adjust the count');
  } finally { client.release(); }
});

router.put('/locations/:cityCode/min', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const code = cityOf(req.params.cityCode);
    const typeId = intOrNull((req.body || {}).asset_type_id);
    const min = intOrNull((req.body || {}).min_qty);
    if (!code) return res.status(400).json({ error: 'Unknown city.' });
    if (!scopeAllows(scope, code)) return res.status(403).json({ error: 'That location is outside your cities.' });
    if (!typeId || min === null || min < 0) return res.status(400).json({ error: 'Pick the equipment and a minimum of 0 or more.' });
    await pool.query(
      'INSERT INTO asset_stock (asset_type_id, city_code, qty_on_hand, min_qty, updated_at) VALUES ($1,$2,0,$3,NOW()) ' +
      'ON CONFLICT (asset_type_id, city_code) DO UPDATE SET min_qty = $3, updated_at = NOW()',
      [typeId, code, min]
    );
    res.json({ success: true });
  } catch (err) { sendErr(res, err, 'Failed to set the minimum'); }
});

// Receive stock into a location (against a PO or by hand).
router.post('/locations/:cityCode/receive', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    const code = cityOf(req.params.cityCode);
    const b = req.body || {};
    const typeId = intOrNull(b.asset_type_id);
    const qty = posInt(b.qty, 0);
    if (!code) return res.status(400).json({ error: 'Unknown city.' });
    if (!scopeAllows(scope, code)) return res.status(403).json({ error: 'That location is outside your cities.' });
    if (!typeId || qty < 1) return res.status(400).json({ error: 'Pick the equipment and how many arrived.' });
    const t = (await pool.query('SELECT * FROM asset_types WHERE id = $1', [typeId])).rows[0];
    if (!t) return res.status(404).json({ error: 'Equipment not found' });

    await client.query('BEGIN');
    const created = [];
    if (t.serialized) {
      // Serialized arrivals become individual units. Tags are optional; a unit
      // with no tag is still trackable by id and can be tagged later.
      const tags = Array.isArray(b.asset_tags) ? b.asset_tags : [];
      const serials = Array.isArray(b.serial_numbers) ? b.serial_numbers : [];
      for (var i = 0; i < qty; i++) {
        const r = await client.query(
          'INSERT INTO assets (asset_type_id, asset_tag, serial_number, city_code, status, condition, purchase_date, purchase_cost, po_id) ' +
          "VALUES ($1,$2,$3,$4,'in_stock',$5,$6,$7,$8) RETURNING *",
          [typeId, trunc(tags[i] || null, 40), trunc(serials[i] || null, 120), code, b.condition || 'new',
            b.purchase_date || null, numOrNull(b.unit_cost) !== null ? numOrNull(b.unit_cost) : t.unit_cost, intOrNull(b.po_id)]
        );
        created.push(r.rows[0]);
      }
    } else {
      await adjustStock(client, {
        asset_type_id: typeId, city_code: code, delta: qty,
        reason: b.po_id ? 'received_po' : 'received',
        ref_type: b.po_id ? 'po' : null, ref_id: intOrNull(b.po_id),
        user: req.user, note: b.note || null
      });
    }
    await client.query('COMMIT');
    try { await logAudit({ entity_type: 'asset', action: 'received', user_id: req.user.id, user_name: req.user.name, details: { city: code, type: t.name, qty: qty } }); } catch (e) {}
    res.status(201).json({ success: true, created: created.length, units: created });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to receive the stock');
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// Transfers between locations
// ---------------------------------------------------------------------------

router.get('/transfers', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const params = [];
    var where = '';
    if (scope !== null) { params.push(scope); where = ' AND (tr.from_city = ANY($1) OR tr.to_city = ANY($1))'; }
    const { rows } = await pool.query(
      'SELECT tr.*, s.name AS sent_by_name, rc.name AS received_by_name FROM asset_transfers tr ' +
      'LEFT JOIN users s ON s.id = tr.sent_by LEFT JOIN users rc ON rc.id = tr.received_by ' +
      'WHERE 1=1' + where + ' ORDER BY tr.sent_at DESC LIMIT 200',
      params
    );
    const ids = rows.map(function (r) { return r.id; });
    var lines = [];
    if (ids.length) {
      lines = (await pool.query(
        'SELECT l.*, a.asset_tag, a.serial_number FROM asset_transfer_lines l LEFT JOIN assets a ON a.id = l.asset_id WHERE l.transfer_id = ANY($1)',
        [ids]
      )).rows;
    }
    rows.forEach(function (r) { r.lines = lines.filter(function (l) { return l.transfer_id === r.id; }); });
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load transfers'); }
});

// Sending puts stock IN TRANSIT. It only lands when the receiving city
// confirms, which is what catches the box that left CHS and never arrived.
router.post('/transfers', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const b = req.body || {};
  const from = cityOf(b.from_city);
  const to = cityOf(b.to_city);
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!from || !to) return res.status(400).json({ error: 'Pick both cities.' });
  if (from === to) return res.status(400).json({ error: 'Those are the same city.' });
  if (!lines.length) return res.status(400).json({ error: 'Add at least one item to the transfer.' });
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    if (!scopeAllows(scope, from)) return res.status(403).json({ error: 'You can only send from your own cities.' });
    if (!(await assertCity(to))) return res.status(400).json({ error: 'Unknown destination city.' });

    const out = await withNumberRetry(async function () {
      await client.query('BEGIN');
      try {
        const number = await nextNumber(client, 'asset_transfers', 'transfer_number', 'TR');
        const tr = (await client.query(
          'INSERT INTO asset_transfers (transfer_number, from_city, to_city, reason, notes, sent_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [number, from, to, b.reason || 'manual', b.notes || null, req.user.id]
        )).rows[0];

        for (var i = 0; i < lines.length; i++) {
          const ln = lines[i] || {};
          const typeId = intOrNull(ln.asset_type_id);
          const assetId = intOrNull(ln.asset_id);
          const qty = posInt(ln.qty, 1);
          if (assetId) {
            const a = (await client.query(
              "SELECT a.*, t.name FROM assets a JOIN asset_types t ON t.id = a.asset_type_id WHERE a.id = $1 AND a.status = 'in_stock' AND a.city_code = $2 FOR UPDATE",
              [assetId, from]
            )).rows[0];
            if (!a) throw httpError(400, 'One of those units is no longer in stock at ' + from + '.');
            await client.query("UPDATE assets SET status = 'in_transit', updated_at = NOW() WHERE id = $1", [assetId]);
            await client.query(
              'INSERT INTO asset_transfer_lines (transfer_id, asset_type_id, asset_id, label, qty) VALUES ($1,$2,$3,$4,1)',
              [tr.id, a.asset_type_id, assetId, trunc(a.name, 255)]
            );
          } else if (typeId) {
            const t = (await client.query('SELECT * FROM asset_types WHERE id = $1', [typeId])).rows[0];
            if (!t) throw httpError(400, 'Unknown equipment on the transfer.');
            if (t.serialized) throw httpError(400, 'Pick specific units for ' + t.name + ', it is serialized.');
            const have = await stockOnHand(client, typeId, from);
            if (have < qty) throw httpError(400, from + ' only has ' + have + ' of ' + t.name + '.');
            await adjustStock(client, {
              asset_type_id: typeId, city_code: from, delta: -qty, reason: 'transfer_out',
              ref_type: 'transfer', ref_id: tr.id, user: req.user, note: 'To ' + to
            });
            await client.query(
              'INSERT INTO asset_transfer_lines (transfer_id, asset_type_id, asset_id, label, qty) VALUES ($1,$2,NULL,$3,$4)',
              [tr.id, typeId, trunc(t.name, 255), qty]
            );
          }
        }
        await client.query('COMMIT');
        return tr;
      } catch (e) {
        await client.query('ROLLBACK').catch(function () {});
        throw e;
      }
    });

    try { await logAudit({ entity_type: 'asset_transfer', entity_id: out.id, entity_number: out.transfer_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { from: from, to: to, lines: lines.length } }); } catch (e) {}
    res.status(201).json(out);
  } catch (err) { sendErr(res, err, 'Failed to start the transfer'); }
  finally { client.release(); }
});

router.post('/transfers/:id/receive', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    await client.query('BEGIN');
    const tr = (await client.query('SELECT * FROM asset_transfers WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!tr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Transfer not found' }); }
    if (tr.status !== 'in_transit') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This transfer was already ' + tr.status + '.' }); }
    if (!scopeAllows(scope, tr.to_city)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Only the receiving city can confirm this.' }); }

    const lines = (await client.query('SELECT * FROM asset_transfer_lines WHERE transfer_id = $1', [tr.id])).rows;
    for (var i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.asset_id) {
        await client.query("UPDATE assets SET city_code = $1, status = 'in_stock', updated_at = NOW() WHERE id = $2", [tr.to_city, l.asset_id]);
      } else if (l.asset_type_id) {
        await adjustStock(client, {
          asset_type_id: l.asset_type_id, city_code: tr.to_city, delta: l.qty, reason: 'transfer_in',
          ref_type: 'transfer', ref_id: tr.id, user: req.user, note: 'From ' + tr.from_city
        });
      }
    }
    await client.query("UPDATE asset_transfers SET status = 'received', received_by = $1, received_at = NOW() WHERE id = $2", [req.user.id, tr.id]);
    await client.query('COMMIT');
    try { await logAudit({ entity_type: 'asset_transfer', entity_id: tr.id, entity_number: tr.transfer_number, action: 'received', user_id: req.user.id, user_name: req.user.name, details: { to: tr.to_city } }); } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to receive the transfer');
  } finally { client.release(); }
});

router.post('/transfers/:id/cancel', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    await client.query('BEGIN');
    const tr = (await client.query('SELECT * FROM asset_transfers WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!tr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Transfer not found' }); }
    if (tr.status !== 'in_transit') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This transfer was already ' + tr.status + '.' }); }
    if (!scopeAllows(scope, tr.from_city)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Only the sending city can cancel this.' }); }
    const lines = (await client.query('SELECT * FROM asset_transfer_lines WHERE transfer_id = $1', [tr.id])).rows;
    for (var i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.asset_id) {
        await client.query("UPDATE assets SET status = 'in_stock', updated_at = NOW() WHERE id = $1", [l.asset_id]);
      } else if (l.asset_type_id) {
        await adjustStock(client, {
          asset_type_id: l.asset_type_id, city_code: tr.from_city, delta: l.qty, reason: 'transfer_in',
          ref_type: 'transfer', ref_id: tr.id, user: req.user, note: 'Transfer cancelled'
        });
      }
    }
    await client.query("UPDATE asset_transfers SET status = 'cancelled' WHERE id = $1", [tr.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to cancel the transfer');
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

router.get('/by-user', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const params = [];
    const s = scopeClause(scope, params, 'h.city_code');
    const { rows } = await pool.query(
      'SELECT u.id, u.name, u.role, u.home_city, ' +
      '  COALESCE(SUM(h.qty) FILTER (WHERE h.returned_at IS NULL),0)::int AS items, ' +
      '  COALESCE(SUM(h.qty * COALESCE(h.unit_cost,0)) FILTER (WHERE h.returned_at IS NULL),0)::numeric AS value, ' +
      "  COUNT(*) FILTER (WHERE h.status = 'replaced' AND h.returned_at > NOW() - INTERVAL '12 months')::int AS replacements_12mo, " +
      "  COALESCE(SUM(COALESCE(h.unit_cost,0)) FILTER (WHERE h.status = 'replaced' AND h.returned_at > NOW() - INTERVAL '12 months'),0)::numeric AS replacement_cost_12mo, " +
      '  (SELECT COUNT(*) FROM asset_acknowledgments ak WHERE ak.user_id = u.id AND ak.status = ' + "'pending'" + ')::int AS unsigned_acks ' +
      'FROM users u JOIN asset_holdings h ON h.user_id = u.id WHERE 1=1' + s +
      ' GROUP BY u.id, u.name, u.role, u.home_city HAVING COALESCE(SUM(h.qty) FILTER (WHERE h.returned_at IS NULL),0) > 0 ' +
      ' OR COUNT(*) FILTER (WHERE h.status = ' + "'replaced'" + ') > 0 ORDER BY u.name ASC',
      params
    );
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load technicians'); }
});

// One technician: what they hold, what they have had replaced, what they signed.
router.get('/by-user/:userId', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const userId = intOrNull(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Unknown technician.' });
    // A tech may always read their own record; anyone else needs manage_assets.
    if (userId !== req.user.id) {
      const okManage = (req.user.role === 'admin' || req.user.isOwner) ||
        await permissions.hasPermission(req.user.role, 'manage_assets');
      if (!okManage) return res.status(403).json({ error: 'Forbidden' });
    }
    const scope = await cityScope(req);
    const u = (await pool.query('SELECT id, name, role, home_city, hire_date, title FROM users WHERE id = $1', [userId])).rows[0];
    if (!u) return res.status(404).json({ error: 'Technician not found' });
    if (userId !== req.user.id && !scopeAllows(scope, u.home_city) && scope !== null) {
      // Still allow it when they hold something in one of the caller's cities.
      const any = await pool.query(
        'SELECT 1 FROM asset_holdings WHERE user_id = $1 AND city_code = ANY($2) LIMIT 1', [userId, scope]
      );
      if (!any.rows.length) return res.status(403).json({ error: 'That technician is outside your cities.' });
    }

    const current = (await pool.query(
      'SELECT h.*, t.name, t.category, t.serialized, t.expected_life_months, a.asset_tag, a.serial_number, ' +
      "  (SELECT COUNT(*) FROM asset_holdings p WHERE p.user_id = h.user_id AND p.asset_type_id = h.asset_type_id AND p.status = 'replaced')::int AS times_replaced, " +
      '  ak.status AS ack_status, ak.ack_number ' +
      'FROM asset_holdings h JOIN asset_types t ON t.id = h.asset_type_id ' +
      'LEFT JOIN assets a ON a.id = h.asset_id LEFT JOIN asset_acknowledgments ak ON ak.id = h.ack_id ' +
      'WHERE h.user_id = $1 AND h.returned_at IS NULL ORDER BY t.category ASC, t.name ASC',
      [userId]
    )).rows;

    const history = (await pool.query(
      'SELECT h.*, t.name, t.category, t.expected_life_months, a.asset_tag, a.serial_number, ' +
      '  EXTRACT(EPOCH FROM (h.returned_at - h.issued_at)) AS held_seconds ' +
      'FROM asset_holdings h JOIN asset_types t ON t.id = h.asset_type_id LEFT JOIN assets a ON a.id = h.asset_id ' +
      'WHERE h.user_id = $1 AND h.returned_at IS NOT NULL ORDER BY h.returned_at DESC LIMIT 200',
      [userId]
    )).rows;

    const acks = (await pool.query(
      'SELECT id, ack_number, status, created_at, signed_at, city_code FROM asset_acknowledgments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [userId]
    )).rows;

    const stats = (await pool.query(
      'SELECT COALESCE(SUM(qty) FILTER (WHERE returned_at IS NULL),0)::int AS items, ' +
      '  COALESCE(SUM(qty * COALESCE(unit_cost,0)) FILTER (WHERE returned_at IS NULL),0)::numeric AS value, ' +
      "  COUNT(*) FILTER (WHERE status = 'replaced' AND returned_at > NOW() - INTERVAL '12 months')::int AS replacements_12mo, " +
      "  COALESCE(SUM(COALESCE(unit_cost,0)) FILTER (WHERE status = 'replaced' AND returned_at > NOW() - INTERVAL '12 months'),0)::numeric AS replacement_cost_12mo, " +
      "  COUNT(*) FILTER (WHERE returned_reason = 'lost')::int AS lost_count, " +
      "  COUNT(*) FILTER (WHERE returned_reason = 'broken')::int AS broken_count " +
      'FROM asset_holdings WHERE user_id = $1',
      [userId]
    )).rows[0];

    const pendingAcks = acks.filter(function (a) { return a.status === 'pending'; }).length;
    res.json({ user: u, current: current, history: history, acks: acks, stats: stats, pending_acks: pendingAcks });
  } catch (err) { sendErr(res, err, 'Failed to load the technician'); }
});

// The tech's own list. No manage permission needed.
router.get('/mine', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const current = (await pool.query(
      'SELECT h.*, t.name, t.category, t.serialized, a.asset_tag, a.serial_number, ak.status AS ack_status, ak.ack_number ' +
      'FROM asset_holdings h JOIN asset_types t ON t.id = h.asset_type_id ' +
      'LEFT JOIN assets a ON a.id = h.asset_id LEFT JOIN asset_acknowledgments ak ON ak.id = h.ack_id ' +
      'WHERE h.user_id = $1 AND h.returned_at IS NULL ORDER BY t.category ASC, t.name ASC',
      [req.user.id]
    )).rows;
    const pending = (await pool.query(
      "SELECT id, ack_number, created_at FROM asset_acknowledgments WHERE user_id = $1 AND status = 'pending' ORDER BY created_at ASC",
      [req.user.id]
    )).rows;
    const requests = (await pool.query(
      'SELECT id, request_number, status, created_at, decided_at, decision_notes, po_number FROM asset_requests ' +
      "WHERE user_id = $1 AND status IN ('pending','approved') ORDER BY created_at DESC",
      [req.user.id]
    )).rows;
    res.json({ items: current, pending_acks: pending, open_requests: requests });
  } catch (err) { sendErr(res, err, 'Failed to load your equipment'); }
});

// Move every open holding for a tech to a new city. Called by routes/users.js
// when home_city changes, and available by hand to correct one.
async function relocateHoldings(client, opts) {
  const userId = opts.user_id;
  const to = opts.to_city;
  const actor = opts.actor || null;
  const open = (await client.query(
    'SELECT h.*, t.name, t.serialized FROM asset_holdings h JOIN asset_types t ON t.id = h.asset_type_id ' +
    'WHERE h.user_id = $1 AND h.returned_at IS NULL AND h.city_code IS DISTINCT FROM $2',
    [userId, to]
  )).rows;
  if (!open.length) return null;

  const fromCity = open[0].city_code || null;
  const number = await nextNumber(client, 'asset_transfers', 'transfer_number', 'TR');
  const tr = (await client.query(
    'INSERT INTO asset_transfers (transfer_number, from_city, to_city, status, reason, notes, sent_by, received_by, received_at) ' +
    "VALUES ($1,$2,$3,'received','tech_relocated',$4,$5,$5,NOW()) RETURNING *",
    [number, fromCity || to, to, 'Moved with the technician', actor ? actor.id : null]
  )).rows[0];

  var value = 0;
  for (var i = 0; i < open.length; i++) {
    const h = open[i];
    value += (parseFloat(h.unit_cost) || 0) * (h.qty || 1);
    await client.query('UPDATE asset_holdings SET city_code = $1 WHERE id = $2', [to, h.id]);
    if (h.asset_id) {
      await client.query('UPDATE assets SET city_code = $1, updated_at = NOW() WHERE id = $2', [to, h.asset_id]);
    } else if (h.city_code) {
      // A counted item that is out with a tech is not on either shelf, so the
      // ledger records the move for both books without touching a count.
      await client.query(
        'INSERT INTO asset_stock_moves (asset_type_id, city_code, delta, reason, ref_type, ref_id, qty_after, user_id, user_name, note) ' +
        'VALUES ($1,$2,0,$3,$4,$5,(SELECT COALESCE(qty_on_hand,0) FROM asset_stock WHERE asset_type_id=$1 AND city_code=$2),$6,$7,$8)',
        [h.asset_type_id, h.city_code, 'transfer_out', 'transfer', tr.id, actor ? actor.id : null,
          actor ? trunc(actor.name, 255) : null, 'Held by a technician who moved to ' + to]
      );
    }
    await client.query(
      'INSERT INTO asset_transfer_lines (transfer_id, asset_type_id, asset_id, label, qty) VALUES ($1,$2,$3,$4,$5)',
      [tr.id, h.asset_type_id, h.asset_id || null, trunc(h.name, 255), h.qty || 1]
    );
  }
  return { transfer: tr, count: open.length, value: value, from_city: fromCity };
}

router.post('/by-user/:userId/relocate', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = intOrNull(req.params.userId);
    const to = cityOf((req.body || {}).to_city);
    if (!userId || !to) return res.status(400).json({ error: 'Pick the technician and the new city.' });
    if (!(await assertCity(to))) return res.status(400).json({ error: 'Unknown city.' });
    const out = await withNumberRetry(async function () {
      await client.query('BEGIN');
      try {
        const r = await relocateHoldings(client, { user_id: userId, to_city: to, actor: req.user });
        await client.query('COMMIT');
        return r;
      } catch (e) { await client.query('ROLLBACK').catch(function () {}); throw e; }
    });
    if (!out) return res.json({ success: true, moved: 0 });
    notifyRelocation(userId, out, to).catch(function () {});
    res.json({ success: true, moved: out.count, value: out.value, transfer_number: out.transfer.transfer_number });
  } catch (err) { sendErr(res, err, 'Failed to move the equipment'); }
  finally { client.release(); }
});

// Automatic, but never silent: both city managers hear about it.
async function notifyRelocation(userId, out, toCity) {
  try {
    const u = (await pool.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0];
    const codes = [out.from_city, toCity].filter(Boolean);
    if (!codes.length) return;
    const mgrs = (await pool.query(
      'SELECT DISTINCT u.id, u.email, u.name, u.receive_emails FROM cities c JOIN users u ON u.id = c.manager_user_id ' +
      'WHERE UPPER(c.code) = ANY($1) AND u.active = true',
      [codes]
    )).rows;
    if (!mgrs.length) return;
    const money = '$' + (Math.round((out.value || 0) * 100) / 100).toFixed(2);
    const body = (u ? u.name : 'A technician') + ' moved from ' + (out.from_city || 'another city') + ' to ' + toCity +
      '. ' + out.count + ' item' + (out.count === 1 ? '' : 's') + ' (' + money + ') moved with them.';
    await push.sendPushToUsers(mgrs.map(function (m) { return m.id; }), { title: 'Equipment moved with a technician', body: body, url: '/?view=asset-locations' });
    const emails = mgrs.filter(function (m) { return m.receive_emails !== false; }).map(function (m) { return m.email; }).filter(Boolean);
    if (emails.length) {
      const html = emailTemplate({
        badge: 'Equipment moved', badgeColor: 'orange',
        title: 'Equipment moved between locations',
        body: body + ' This was recorded as transfer ' + out.transfer.transfer_number + ' and can be reversed from that record if the change was a mistake.',
        details: [
          { label: 'Technician', value: u ? u.name : '' },
          { label: 'From', value: out.from_city || '' },
          { label: 'To', value: toCity },
          { label: 'Items', value: String(out.count) },
          { label: 'Value', value: money }
        ]
      });
      await sendEmail(emails, 'Equipment moved with ' + (u ? u.name : 'a technician'), html);
    }
  } catch (e) { console.error('relocation notify failed:', e.message); }
}

// ---------------------------------------------------------------------------
// Units (serialized assets)
// ---------------------------------------------------------------------------

router.post('/', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const b = req.body || {};
    const scope = await cityScope(req);
    const typeId = intOrNull(b.asset_type_id);
    const city = await assertCity(b.city_code);
    if (!typeId) return res.status(400).json({ error: 'Pick the equipment.' });
    if (!city) return res.status(400).json({ error: 'Pick a valid city.' });
    if (!scopeAllows(scope, city)) return res.status(403).json({ error: 'That location is outside your cities.' });
    const t = (await pool.query('SELECT * FROM asset_types WHERE id = $1', [typeId])).rows[0];
    if (!t) return res.status(404).json({ error: 'Equipment not found' });
    if (!t.serialized) return res.status(400).json({ error: t.name + ' is tracked as a count. Use Receive Stock instead.' });
    const { rows } = await pool.query(
      'INSERT INTO assets (asset_type_id, asset_tag, serial_number, city_code, status, condition, purchase_date, purchase_cost, po_id, vehicle_id, notes) ' +
      "VALUES ($1,$2,$3,$4,'in_stock',$5,$6,$7,$8,$9,$10) RETURNING *",
      [typeId, trunc(b.asset_tag || null, 40), trunc(b.serial_number || null, 120), city, b.condition || 'new',
        b.purchase_date || null, numOrNull(b.purchase_cost), intOrNull(b.po_id), intOrNull(b.vehicle_id), b.notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err && err.code === '23505') return res.status(400).json({ error: 'That asset tag is already in use.' });
    sendErr(res, err, 'Failed to add the item');
  }
});

router.put('/:id', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const b = req.body || {};
    const scope = await cityScope(req);
    const cur = (await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Item not found' });
    if (!scopeAllows(scope, cur.city_code)) return res.status(403).json({ error: 'That item is outside your cities.' });
    // City is changed through a transfer, never by editing the row, so the two
    // books always agree and there is always a record.
    const { rows } = await pool.query(
      'UPDATE assets SET asset_tag=$1, serial_number=$2, condition=$3, purchase_date=$4, purchase_cost=$5, ' +
      'vehicle_id=$6, notes=$7, updated_at=NOW() WHERE id=$8 RETURNING *',
      [trunc(b.asset_tag || null, 40), trunc(b.serial_number || null, 120), b.condition || cur.condition,
        b.purchase_date || null, numOrNull(b.purchase_cost), intOrNull(b.vehicle_id), b.notes || null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err && err.code === '23505') return res.status(400).json({ error: 'That asset tag is already in use.' });
    sendErr(res, err, 'Failed to save the item');
  }
});

router.post('/:id/retire', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const cur = (await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Item not found' });
    if (!scopeAllows(scope, cur.city_code)) return res.status(403).json({ error: 'That item is outside your cities.' });
    if (cur.status === 'assigned') return res.status(400).json({ error: 'Collect it from the technician before retiring it.' });
    await pool.query("UPDATE assets SET status='retired', active=false, updated_at=NOW() WHERE id=$1", [req.params.id]);
    try { await logAudit({ entity_type: 'asset', entity_id: cur.id, entity_number: cur.asset_tag, action: 'retired', user_id: req.user.id, user_name: req.user.name, details: {} }); } catch (e) {}
    res.json({ success: true });
  } catch (err) { sendErr(res, err, 'Failed to retire the item'); }
});

// Take a unit that was awaiting return back onto the books.
router.post('/:id/receive-return', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const outcome = (req.body || {}).outcome;
    if (['in_stock', 'needs_repair', 'retired'].indexOf(outcome) === -1) {
      return res.status(400).json({ error: 'Say whether it went back on the shelf, needs repair, or is dead.' });
    }
    const cur = (await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Item not found' });
    if (!scopeAllows(scope, cur.city_code)) return res.status(403).json({ error: 'That item is outside your cities.' });
    if (cur.status !== 'awaiting_return' && cur.status !== 'needs_repair') {
      return res.status(409).json({ error: 'That item is not waiting to come back.' });
    }
    await pool.query(
      'UPDATE assets SET status=$1, active=$2, condition=COALESCE($3, condition), updated_at=NOW() WHERE id=$4',
      [outcome, outcome !== 'retired', (req.body || {}).condition || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { sendErr(res, err, 'Failed to record the return'); }
});

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

// Issue one equipment type to a person and open the holding. Serialized types
// produce one holding per physical unit; counted types produce one holding for
// the quantity and move that city's count. Returns the new holdings.
async function issueItem(client, o) {
  const t = o.type;
  const qty = posInt(o.qty, 1);
  const out = [];
  const cost = t.unit_cost !== null && t.unit_cost !== undefined ? t.unit_cost : null;

  if (t.serialized) {
    for (var i = 0; i < qty; i++) {
      const unit = await claimUnit(client, t.id, o.city_code, i === 0 ? o.asset_id : null);
      if (!unit) {
        throw httpError(400, 'There is no ' + t.name + ' in stock at ' + o.city_code + '. Receive one first, or leave it off this assignment.');
      }
      await client.query(
        "UPDATE assets SET assigned_user_id = $1, status = 'assigned', condition = COALESCE($2, condition), updated_at = NOW() WHERE id = $3",
        [o.user_id, o.condition || null, unit.id]
      );
      const h = (await client.query(
        'INSERT INTO asset_holdings (user_id, asset_type_id, asset_id, qty, city_code, unit_cost, issued_by, condition_out, notes) ' +
        'VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8) RETURNING *',
        [o.user_id, t.id, unit.id, o.city_code, cost, o.actor ? o.actor.id : null, o.condition || unit.condition || null, o.notes || null]
      )).rows[0];
      h._unit = unit;
      out.push(h);
    }
  } else {
    const have = await stockOnHand(client, t.id, o.city_code);
    if (have < qty) {
      throw httpError(400, o.city_code + ' only has ' + have + ' of ' + t.name + ' on the shelf, and this needs ' + qty + '.');
    }
    await adjustStock(client, {
      asset_type_id: t.id, city_code: o.city_code, delta: -qty, reason: 'issued',
      ref_type: o.ref_type || null, ref_id: o.ref_id || null, user: o.actor,
      note: o.stock_note || null
    });
    const h = (await client.query(
      'INSERT INTO asset_holdings (user_id, asset_type_id, asset_id, qty, city_code, unit_cost, issued_by, condition_out, notes) ' +
      'VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8) RETURNING *',
      [o.user_id, t.id, qty, o.city_code, cost, o.actor ? o.actor.id : null, o.condition || 'new', o.notes || null]
    )).rows[0];
    out.push(h);
  }
  return out;
}

// Close a holding. Serialized units either wait to be handed in, or are gone
// for good when the reason says so.
async function closeHolding(client, holding, o) {
  const reason = o.reason || 'returned';
  const status = o.status || 'returned';
  await client.query(
    'UPDATE asset_holdings SET returned_at = NOW(), returned_reason = $1, status = $2, condition_in = $3 WHERE id = $4',
    [reason, status, o.condition_in || null, holding.id]
  );
  if (holding.asset_id) {
    var next = 'in_stock';
    if (LOST_REASONS.indexOf(reason) !== -1) next = 'lost';
    else if (o.physically_returned) next = (o.condition_in === 'poor' ? 'needs_repair' : 'in_stock');
    else next = 'awaiting_return';
    await client.query(
      'UPDATE assets SET assigned_user_id = NULL, status = $1, condition = COALESCE($2, condition), updated_at = NOW() WHERE id = $3',
      [next, o.condition_in || null, holding.asset_id]
    );
  } else if (o.restock && holding.city_code) {
    await adjustStock(client, {
      asset_type_id: holding.asset_type_id, city_code: holding.city_code, delta: holding.qty || 1,
      reason: 'returned', ref_type: o.ref_type || null, ref_id: o.ref_id || null, user: o.actor,
      note: o.note || null
    });
  }
}

// Hand something back without asking for a replacement.
router.post('/holdings/:id/return', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const scope = await cityScope(req);
    await client.query('BEGIN');
    const h = (await client.query('SELECT * FROM asset_holdings WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!h) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Holding not found' }); }
    if (h.returned_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'That was already returned.' }); }
    if (!scopeAllows(scope, h.city_code)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'That item is outside your cities.' }); }
    await closeHolding(client, h, {
      reason: b.reason || 'returned',
      status: LOST_REASONS.indexOf(b.reason) !== -1 ? 'lost' : 'returned',
      condition_in: b.condition || null,
      physically_returned: b.physically_returned !== false,
      restock: b.restock !== false && LOST_REASONS.indexOf(b.reason) === -1,
      actor: req.user, note: 'Returned by ' + req.user.name
    });
    await client.query('COMMIT');
    try { await logAudit({ entity_type: 'asset', entity_id: h.asset_id || h.id, action: 'returned', user_id: req.user.id, user_name: req.user.name, details: { holding: h.id, reason: b.reason || 'returned' } }); } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to record the return');
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// Acknowledgments (assignments the tech signs for)
// ---------------------------------------------------------------------------

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return trunc(String(fwd).split(',')[0].trim(), 64);
  return trunc(req.ip || '', 64);
}

// Freeze what the line said at the moment it was sent. Renaming equipment next
// year must not rewrite what somebody signed.
async function addAckLines(client, ackId, holdings, typeById, position) {
  var pos = position || 0;
  for (var i = 0; i < holdings.length; i++) {
    const h = holdings[i];
    const t = typeById[h.asset_type_id] || {};
    const unit = h._unit || null;
    await client.query(
      'INSERT INTO asset_ack_lines (ack_id, holding_id, asset_type_id, asset_id, label, serial_number, asset_tag, category, qty, condition, unit_cost, position) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [ackId, h.id, h.asset_type_id, h.asset_id || null, trunc(t.name || 'Equipment', 255),
        trunc(unit ? unit.serial_number : null, 120), trunc(unit ? unit.asset_tag : null, 40),
        t.category || null, h.qty || 1, h.condition_out || null, h.unit_cost, pos++]
    );
    await client.query('UPDATE asset_holdings SET ack_id = $1 WHERE id = $2', [ackId, h.id]);
  }
  return pos;
}

router.post('/acks', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const b = req.body || {};
  const lines = Array.isArray(b.lines) ? b.lines : [];
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    const userId = intOrNull(b.user_id);
    const city = await assertCity(b.city_code);
    if (!userId) return res.status(400).json({ error: 'Pick the technician.' });
    if (!city) return res.status(400).json({ error: 'Pick a valid city.' });
    if (!scopeAllows(scope, city)) return res.status(403).json({ error: 'That location is outside your cities.' });
    if (!lines.length) return res.status(400).json({ error: 'Tick at least one item to assign.' });

    const tech = (await pool.query('SELECT id, name, email, phone, receive_emails FROM users WHERE id = $1 AND active = true', [userId])).rows[0];
    if (!tech) return res.status(404).json({ error: 'Technician not found' });

    const typeIds = lines.map(function (l) { return intOrNull(l.asset_type_id); }).filter(Boolean);
    if (!typeIds.length) return res.status(400).json({ error: 'Tick at least one item to assign.' });
    const types = (await pool.query('SELECT * FROM asset_types WHERE id = ANY($1)', [typeIds])).rows;
    const typeById = {};
    types.forEach(function (t) { typeById[t.id] = t; });

    const ack = await withNumberRetry(async function () {
      await client.query('BEGIN');
      try {
        const number = await nextNumber(client, 'asset_acknowledgments', 'ack_number', 'AA');
        const row = (await client.query(
          'INSERT INTO asset_acknowledgments (ack_number, user_id, city_code, issued_by, note, agreement_text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [number, userId, city, req.user.id, b.note || null, b.agreement_text || DEFAULT_AGREEMENT]
        )).rows[0];

        var pos = 0;
        for (var i = 0; i < lines.length; i++) {
          const ln = lines[i] || {};
          const t = typeById[intOrNull(ln.asset_type_id)];
          if (!t) continue;
          const holdings = await issueItem(client, {
            type: t, user_id: userId, city_code: city, qty: posInt(ln.qty, 1),
            asset_id: intOrNull(ln.asset_id), condition: ln.condition || null,
            actor: req.user, ref_type: 'ack', ref_id: row.id,
            stock_note: 'Issued on ' + row.ack_number + ' to ' + tech.name
          });
          pos = await addAckLines(client, row.id, holdings, typeById, pos);
        }
        if (!pos) throw httpError(400, 'Nothing was assigned.');
        await client.query('COMMIT');
        return row;
      } catch (e) { await client.query('ROLLBACK').catch(function () {}); throw e; }
    });

    try { await logAudit({ entity_type: 'asset_ack', entity_id: ack.id, entity_number: ack.ack_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { tech: tech.name, city: city, lines: lines.length } }); } catch (e) {}
    notifyAckSent(ack, tech, req.user).catch(function () {});
    res.status(201).json(ack);
  } catch (err) { sendErr(res, err, 'Failed to create the assignment'); }
  finally { client.release(); }
});

async function notifyAckSent(ack, tech, actor) {
  try {
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    await push.sendPushToUsers([tech.id], {
      title: 'Sign for your equipment',
      body: (actor ? actor.name : 'Your manager') + ' assigned you equipment. Initial each item and sign.',
      url: '/?view=my-equipment'
    });
    if (tech.email && tech.receive_emails !== false) {
      const html = emailTemplate({
        badge: 'Signature needed', badgeColor: 'orange',
        title: 'Equipment assigned to you',
        body: (actor ? actor.name : 'Your manager') + ' has assigned you equipment on ' + ack.ack_number +
          '. Open Nova on your phone, initial each item you received, and sign once at the bottom.',
        details: [{ label: 'Reference', value: ack.ack_number }, { label: 'City', value: ack.city_code || '' }],
        buttonText: 'Open Nova',
        buttonUrl: base ? base + '/?view=my-equipment' : undefined
      });
      await sendEmail(tech.email, 'Sign for your equipment (' + ack.ack_number + ')', html);
    }
  } catch (e) { console.error('ack notify failed:', e.message); }
}

router.get('/acks', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const params = [];
    var where = '';
    if (scope !== null) { params.push(scope); where += ' AND ak.city_code = ANY($' + params.length + ')'; }
    if (req.query.status) { params.push(req.query.status); where += ' AND ak.status = $' + params.length; }
    if (req.query.user_id) { params.push(intOrNull(req.query.user_id)); where += ' AND ak.user_id = $' + params.length; }
    const { rows } = await pool.query(
      'SELECT ak.*, u.name AS user_name, ib.name AS issued_by_name, ' +
      '  (SELECT COUNT(*) FROM asset_ack_lines l WHERE l.ack_id = ak.id)::int AS line_count, ' +
      '  (SELECT COALESCE(SUM(l.qty * COALESCE(l.unit_cost,0)),0) FROM asset_ack_lines l WHERE l.ack_id = ak.id)::numeric AS total_value ' +
      'FROM asset_acknowledgments ak JOIN users u ON u.id = ak.user_id LEFT JOIN users ib ON ib.id = ak.issued_by ' +
      'WHERE 1=1' + where + ' ORDER BY ak.created_at DESC LIMIT 300',
      params
    );
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load assignments'); }
});

router.get('/acks/pending/mine', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM asset_acknowledgments WHERE user_id = $1 AND status = 'pending' ORDER BY created_at ASC",
      [req.user.id]
    );
    for (var i = 0; i < rows.length; i++) {
      rows[i].lines = (await pool.query('SELECT * FROM asset_ack_lines WHERE ack_id = $1 ORDER BY position ASC, id ASC', [rows[i].id])).rows;
    }
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load your pending signatures'); }
});

router.get('/acks/:id', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const ack = (await pool.query(
      'SELECT ak.*, u.name AS user_name, u.title AS user_title, ib.name AS issued_by_name FROM asset_acknowledgments ak ' +
      'JOIN users u ON u.id = ak.user_id LEFT JOIN users ib ON ib.id = ak.issued_by WHERE ak.id = $1',
      [req.params.id]
    )).rows[0];
    if (!ack) return res.status(404).json({ error: 'Assignment not found' });
    if (ack.user_id !== req.user.id) {
      const okManage = (req.user.role === 'admin' || req.user.isOwner) ||
        await permissions.hasPermission(req.user.role, 'manage_assets');
      if (!okManage) return res.status(403).json({ error: 'Forbidden' });
      const scope = await cityScope(req);
      if (!scopeAllows(scope, ack.city_code)) return res.status(403).json({ error: 'That assignment is outside your cities.' });
    }
    ack.lines = (await pool.query('SELECT * FROM asset_ack_lines WHERE ack_id = $1 ORDER BY position ASC, id ASC', [req.params.id])).rows;
    res.json(ack);
  } catch (err) { sendErr(res, err, 'Failed to load the assignment'); }
});

// Only the person the equipment belongs to may initial or sign. That is the
// whole point of the record, so there is no manager override here.
router.post('/acks/:id/lines/:lineId/initial', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const initials = trunc(((req.body || {}).initials || '').trim(), 10);
    if (!initials) return res.status(400).json({ error: 'Initials are required.' });
    const ack = (await pool.query('SELECT * FROM asset_acknowledgments WHERE id = $1', [req.params.id])).rows[0];
    if (!ack) return res.status(404).json({ error: 'Assignment not found' });
    if (ack.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person this equipment belongs to can initial it.' });
    if (ack.status !== 'pending') return res.status(409).json({ error: 'This assignment is already ' + ack.status + '.' });
    const { rowCount } = await pool.query(
      'UPDATE asset_ack_lines SET initials = $1, initialed_at = NOW() WHERE id = $2 AND ack_id = $3',
      [initials, req.params.lineId, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Line not found' });
    res.json({ success: true });
  } catch (err) { sendErr(res, err, 'Failed to save the initials'); }
});

router.post('/acks/:id/sign', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.signature_data) return res.status(400).json({ error: 'Draw your signature first.' });
    const ack = (await pool.query('SELECT * FROM asset_acknowledgments WHERE id = $1', [req.params.id])).rows[0];
    if (!ack) return res.status(404).json({ error: 'Assignment not found' });
    if (ack.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person this equipment belongs to can sign for it.' });

    const missing = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM asset_ack_lines WHERE ack_id = $1 AND (initials IS NULL OR initials = ' + "''" + ')',
      [req.params.id]
    )).rows[0].n;
    if (missing > 0) return res.status(400).json({ error: 'Initial all ' + missing + ' remaining item' + (missing === 1 ? '' : 's') + ' before signing.' });

    // Guarded so a double tap cannot overwrite an already-signed record, the
    // same way a completed sign-off sheet is locked.
    const { rows } = await pool.query(
      "UPDATE asset_acknowledgments SET status='signed', signature_data=$1, signed_at=NOW(), gps_lat=$2, gps_lon=$3, " +
      "gps_accuracy=$4, ip=$5, user_agent=$6, updated_at=NOW() WHERE id=$7 AND status='pending' RETURNING *",
      [b.signature_data, numOrNull(b.gps_lat), numOrNull(b.gps_lon), numOrNull(b.gps_accuracy),
        clientIp(req), trunc(req.headers['user-agent'] || '', 500), req.params.id]
    );
    if (!rows.length) return res.status(409).json({ error: 'This assignment has already been signed.' });
    try { await logAudit({ entity_type: 'asset_ack', entity_id: ack.id, entity_number: ack.ack_number, action: 'signed', user_id: req.user.id, user_name: req.user.name, details: {} }); } catch (e) {}
    notifyAckSigned(rows[0], req.user).catch(function () {});
    res.json(rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to record the signature'); }
});

async function notifyAckSigned(ack, tech) {
  try {
    if (!ack.issued_by) return;
    const m = (await pool.query('SELECT id, email, name, receive_emails FROM users WHERE id = $1', [ack.issued_by])).rows[0];
    if (!m) return;
    await push.sendPushToUsers([m.id], { title: 'Equipment signed for', body: tech.name + ' signed ' + ack.ack_number + '.', url: '/?view=asset-acks' });
    if (m.email && m.receive_emails !== false) {
      const html = emailTemplate({
        badge: 'Signed', badgeColor: 'green',
        title: 'Equipment acknowledgment signed',
        body: tech.name + ' initialed every item and signed ' + ack.ack_number + '.',
        details: [{ label: 'Reference', value: ack.ack_number }, { label: 'City', value: ack.city_code || '' }]
      });
      await sendEmail(m.email, tech.name + ' signed ' + ack.ack_number, html);
    }
  } catch (e) { console.error('ack signed notify failed:', e.message); }
}

// Declining flags it for the manager. It deliberately does NOT reverse the
// issue: a mis-tap should not silently destroy stock records. Voiding does.
router.post('/acks/:id/decline', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const reason = ((req.body || {}).reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Tell your manager what is wrong.' });
    const ack = (await pool.query('SELECT * FROM asset_acknowledgments WHERE id = $1', [req.params.id])).rows[0];
    if (!ack) return res.status(404).json({ error: 'Assignment not found' });
    if (ack.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person this equipment belongs to can do that.' });
    const { rows } = await pool.query(
      "UPDATE asset_acknowledgments SET status='declined', declined_reason=$1, updated_at=NOW() WHERE id=$2 AND status='pending' RETURNING *",
      [reason, req.params.id]
    );
    if (!rows.length) return res.status(409).json({ error: 'This assignment is no longer pending.' });
    if (ack.issued_by) {
      push.sendPushToUsers([ack.issued_by], { title: 'Assignment flagged', body: req.user.name + ' flagged ' + ack.ack_number + ': ' + reason, url: '/?view=asset-acks' }).catch(function () {});
    }
    res.json(rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to flag the assignment'); }
});

// Void reverses everything the assignment did: open holdings close, serialized
// units go back on the shelf, counted stock is added back.
router.post('/acks/:id/void', requireAuth, requirePermission('manage_assets'), async (req, res) => {
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    await client.query('BEGIN');
    const ack = (await client.query('SELECT * FROM asset_acknowledgments WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!ack) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Assignment not found' }); }
    if (ack.status === 'void') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Already voided.' }); }
    if (!scopeAllows(scope, ack.city_code)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'That assignment is outside your cities.' }); }

    const holdings = (await client.query('SELECT * FROM asset_holdings WHERE ack_id = $1 AND returned_at IS NULL', [ack.id])).rows;
    for (var i = 0; i < holdings.length; i++) {
      await closeHolding(client, holdings[i], {
        reason: 'returned', status: 'void', physically_returned: true, restock: true,
        actor: req.user, ref_type: 'ack', ref_id: ack.id, note: 'Assignment ' + ack.ack_number + ' voided'
      });
    }
    await client.query("UPDATE asset_acknowledgments SET status='void', updated_at=NOW() WHERE id=$1", [ack.id]);
    await client.query('COMMIT');
    try { await logAudit({ entity_type: 'asset_ack', entity_id: ack.id, entity_number: ack.ack_number, action: 'voided', user_id: req.user.id, user_name: req.user.name, details: { reversed: holdings.length } }); } catch (e) {}
    res.json({ success: true, reversed: holdings.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to void the assignment');
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// Replacement requests
// ---------------------------------------------------------------------------

const REASONS = ['broken', 'worn_out', 'lost', 'stolen', 'not_working', 'recall'];

router.get('/requests', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const canManage = (req.user.role === 'admin' || req.user.isOwner) ||
      await permissions.hasPermission(req.user.role, 'approve_asset_replacement') ||
      await permissions.hasPermission(req.user.role, 'manage_assets');
    const params = [];
    var where = '';
    if (!canManage) { params.push(req.user.id); where += ' AND r.user_id = $' + params.length; }
    else if (scope !== null) { params.push(scope); where += ' AND r.city_code = ANY($' + params.length + ')'; }
    if (req.query.status) { params.push(req.query.status); where += ' AND r.status = $' + params.length; }
    const { rows } = await pool.query(
      'SELECT r.*, u.name AS user_name, d.name AS decided_by_name, ' +
      '  (SELECT COUNT(*) FROM asset_request_lines l WHERE l.request_id = r.id)::int AS line_count ' +
      'FROM asset_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by ' +
      'WHERE 1=1' + where + ' ORDER BY (r.status = ' + "'pending'" + ') DESC, r.created_at DESC LIMIT 300',
      params
    );
    const ids = rows.map(function (r) { return r.id; });
    var lines = [];
    if (ids.length) {
      lines = (await pool.query(
        'SELECT l.*, t.name, t.category, t.expected_life_months, t.unit_cost, t.vendor_name, ' +
        '  h.issued_at, EXTRACT(EPOCH FROM (NOW() - h.issued_at)) AS held_seconds, ' +
        "  (SELECT COUNT(*) FROM asset_holdings p WHERE p.user_id = r2.user_id AND p.asset_type_id = l.asset_type_id AND p.status = 'replaced')::int AS prior_replacements " +
        'FROM asset_request_lines l JOIN asset_types t ON t.id = l.asset_type_id ' +
        'JOIN asset_requests r2 ON r2.id = l.request_id ' +
        'LEFT JOIN asset_holdings h ON h.id = l.holding_id WHERE l.request_id = ANY($1) ORDER BY l.position ASC, l.id ASC',
        [ids]
      )).rows;
    }
    rows.forEach(function (r) { r.lines = lines.filter(function (l) { return l.request_id === r.id; }); });
    res.json(rows);
  } catch (err) { sendErr(res, err, 'Failed to load replacement requests'); }
});

// The history block the review screen leads with: how long they held it, how
// many times before, what it has cost, and how that compares to the crew.
async function historyFor(userId, typeId) {
  const own = (await pool.query(
    "SELECT COUNT(*) FILTER (WHERE status = 'replaced')::int AS times_replaced, " +
    "  COALESCE(SUM(COALESCE(unit_cost,0)) FILTER (WHERE status = 'replaced'),0)::numeric AS spent, " +
    "  COALESCE(AVG(EXTRACT(EPOCH FROM (returned_at - issued_at))) FILTER (WHERE returned_at IS NOT NULL),0)::numeric AS avg_held_seconds " +
    'FROM asset_holdings WHERE user_id = $1 AND asset_type_id = $2',
    [userId, typeId]
  )).rows[0];
  const crew = (await pool.query(
    "SELECT COUNT(*) FILTER (WHERE status = 'replaced' AND returned_at > NOW() - INTERVAL '12 months')::int AS replaced_12mo, " +
    '  COUNT(DISTINCT user_id)::int AS people FROM asset_holdings WHERE asset_type_id = $1',
    [typeId]
  )).rows[0];
  const timeline = (await pool.query(
    'SELECT h.id, h.issued_at, h.returned_at, h.returned_reason, h.status, h.unit_cost, a.serial_number, a.asset_tag, ' +
    '  EXTRACT(EPOCH FROM (COALESCE(h.returned_at, NOW()) - h.issued_at)) AS held_seconds ' +
    'FROM asset_holdings h LEFT JOIN assets a ON a.id = h.asset_id ' +
    'WHERE h.user_id = $1 AND h.asset_type_id = $2 ORDER BY h.issued_at DESC LIMIT 20',
    [userId, typeId]
  )).rows;
  const t = (await pool.query('SELECT expected_life_months, name, unit_cost FROM asset_types WHERE id = $1', [typeId])).rows[0] || {};
  return {
    times_replaced: own.times_replaced,
    spent: parseFloat(own.spent) || 0,
    avg_held_months: own.avg_held_seconds ? (parseFloat(own.avg_held_seconds) / 2629800) : 0,
    expected_life_months: t.expected_life_months || null,
    crew_per_year: crew.people ? (crew.replaced_12mo / crew.people) : 0,
    timeline: timeline
  };
}

router.get('/history/:userId/:typeId', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const userId = intOrNull(req.params.userId);
    const typeId = intOrNull(req.params.typeId);
    if (!userId || !typeId) return res.status(400).json({ error: 'Bad request' });
    if (userId !== req.user.id) {
      const okManage = (req.user.role === 'admin' || req.user.isOwner) ||
        await permissions.hasPermission(req.user.role, 'manage_assets') ||
        await permissions.hasPermission(req.user.role, 'approve_asset_replacement');
      if (!okManage) return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(await historyFor(userId, typeId));
  } catch (err) { sendErr(res, err, 'Failed to load the history'); }
});

router.get('/requests/:id', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const r = (await pool.query(
      'SELECT r.*, u.name AS user_name, u.home_city, d.name AS decided_by_name, p.status AS po_status ' +
      'FROM asset_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by ' +
      'LEFT JOIN purchase_orders p ON p.id = r.po_id WHERE r.id = $1',
      [req.params.id]
    )).rows[0];
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.user_id !== req.user.id) {
      const okManage = (req.user.role === 'admin' || req.user.isOwner) ||
        await permissions.hasPermission(req.user.role, 'manage_assets') ||
        await permissions.hasPermission(req.user.role, 'approve_asset_replacement');
      if (!okManage) return res.status(403).json({ error: 'Forbidden' });
      const scope = await cityScope(req);
      if (!scopeAllows(scope, r.city_code)) return res.status(403).json({ error: 'That request is outside your cities.' });
    }
    r.lines = (await pool.query(
      'SELECT l.*, t.name, t.category, t.serialized, t.expected_life_months, t.unit_cost, t.vendor_name, t.item_number, t.manufacturer, ' +
      '  h.issued_at, a.serial_number, a.asset_tag, ' +
      '  EXTRACT(EPOCH FROM (NOW() - h.issued_at)) AS held_seconds ' +
      'FROM asset_request_lines l JOIN asset_types t ON t.id = l.asset_type_id ' +
      'LEFT JOIN asset_holdings h ON h.id = l.holding_id LEFT JOIN assets a ON a.id = h.asset_id ' +
      'WHERE l.request_id = $1 ORDER BY l.position ASC, l.id ASC',
      [req.params.id]
    )).rows;
    // How many are on that city's shelf right now, so the reviewer can decide
    // whether to hand one over today.
    for (var i = 0; i < r.lines.length; i++) {
      const ln = r.lines[i];
      if (ln.serialized) {
        ln.available = (await pool.query(
          "SELECT COUNT(*)::int AS n FROM assets WHERE asset_type_id = $1 AND city_code = $2 AND status = 'in_stock' AND active = true",
          [ln.asset_type_id, r.city_code]
        )).rows[0].n;
      } else {
        ln.available = (await pool.query(
          'SELECT COALESCE(qty_on_hand,0)::int AS n FROM asset_stock WHERE asset_type_id = $1 AND city_code = $2',
          [ln.asset_type_id, r.city_code]
        )).rows.reduce(function (a, x) { return a + x.n; }, 0);
      }
      const st = (await pool.query('SELECT min_qty FROM asset_stock WHERE asset_type_id = $1 AND city_code = $2', [ln.asset_type_id, r.city_code])).rows[0];
      ln.min_qty = st ? st.min_qty : 0;
      ln.history = await historyFor(r.user_id, ln.asset_type_id);
    }
    r.photos = (await pool.query('SELECT id, request_line_id, created_at FROM asset_request_photos WHERE request_id = $1 ORDER BY id ASC', [req.params.id])).rows;
    res.json(r);
  } catch (err) { sendErr(res, err, 'Failed to load the request'); }
});

router.post('/requests', requireAuth, requirePermission('request_asset_replacement'), async (req, res) => {
  const b = req.body || {};
  const lines = Array.isArray(b.lines) ? b.lines : [];
  const client = await pool.connect();
  try {
    var userId = intOrNull(b.user_id) || req.user.id;
    if (userId !== req.user.id) {
      const okManage = (req.user.role === 'admin' || req.user.isOwner) ||
        await permissions.hasPermission(req.user.role, 'manage_assets');
      if (!okManage) return res.status(403).json({ error: 'You can only raise a request for yourself.' });
    }
    if (!lines.length) return res.status(400).json({ error: 'Pick at least one item.' });

    // The city follows the equipment, not the person filing the request.
    var city = cityOf(b.city_code);
    const firstHolding = intOrNull(lines[0] && lines[0].holding_id);
    if (!city && firstHolding) {
      const h = (await pool.query('SELECT city_code FROM asset_holdings WHERE id = $1', [firstHolding])).rows[0];
      if (h) city = cityOf(h.city_code);
    }
    if (!city) {
      const u = (await pool.query('SELECT home_city FROM users WHERE id = $1', [userId])).rows[0];
      if (u) city = cityOf(u.home_city);
    }

    const out = await withNumberRetry(async function () {
      await client.query('BEGIN');
      try {
        const number = await nextNumber(client, 'asset_requests', 'request_number', 'RR');
        const r = (await client.query(
          'INSERT INTO asset_requests (request_number, user_id, city_code, kind, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
          [number, userId, city, ['replacement', 'new', 'return'].indexOf(b.kind) !== -1 ? b.kind : 'replacement', b.notes || null]
        )).rows[0];
        for (var i = 0; i < lines.length; i++) {
          const ln = lines[i] || {};
          const typeId = intOrNull(ln.asset_type_id);
          if (!typeId) continue;
          const holdingId = intOrNull(ln.holding_id);
          if (holdingId) {
            const h = (await client.query('SELECT * FROM asset_holdings WHERE id = $1 AND user_id = $2 AND returned_at IS NULL', [holdingId, userId])).rows[0];
            if (!h) throw httpError(400, 'One of those items is no longer assigned to you.');
          }
          await client.query(
            'INSERT INTO asset_request_lines (request_id, asset_type_id, holding_id, qty, reason, notes, position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [r.id, typeId, holdingId, posInt(ln.qty, 1), REASONS.indexOf(ln.reason) !== -1 ? ln.reason : null, ln.notes || null, i]
          );
        }
        await client.query('COMMIT');
        return r;
      } catch (e) { await client.query('ROLLBACK').catch(function () {}); throw e; }
    });

    try { await logAudit({ entity_type: 'asset_request', entity_id: out.id, entity_number: out.request_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { lines: lines.length, city: city } }); } catch (e) {}
    notifyRequestRaised(out, req.user).catch(function () {});
    res.status(201).json(out);
  } catch (err) { sendErr(res, err, 'Failed to send the request'); }
  finally { client.release(); }
});

// Goes to the manager of THAT ITEM'S city.
async function notifyRequestRaised(request, actor) {
  try {
    if (!request.city_code) return;
    const mgr = (await pool.query(
      'SELECT u.id, u.email, u.name, u.receive_emails FROM cities c JOIN users u ON u.id = c.manager_user_id ' +
      'WHERE UPPER(c.code) = $1 AND u.active = true',
      [request.city_code]
    )).rows[0];
    if (!mgr) return;
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    await push.sendPushToUsers([mgr.id], {
      title: 'Replacement requested',
      body: actor.name + ' asked for a replacement (' + request.request_number + ').',
      url: '/?view=asset-requests'
    });
    if (mgr.email && mgr.receive_emails !== false) {
      const html = emailTemplate({
        badge: 'Needs review', badgeColor: 'orange',
        title: 'Replacement requested',
        body: actor.name + ' has asked for a replacement. The review screen shows how long they held it, how many times it has been replaced before, and what it has cost.',
        details: [{ label: 'Reference', value: request.request_number }, { label: 'City', value: request.city_code }],
        buttonText: 'Review it',
        buttonUrl: base ? base + '/?view=asset-requests' : undefined
      });
      await sendEmail(mgr.email, 'Replacement requested by ' + actor.name, html);
    }
  } catch (e) { console.error('request notify failed:', e.message); }
}

// Build the draft PO for an approved request, inside the caller's transaction.
//
// Written straight against the database rather than through POST /api/pos on
// purpose: that route hardcodes requester_id to whoever is logged in (which
// would put the manager's name on the tech's order), sits behind session-based
// middleware a server-side call has no session for, and an internal HTTP call
// would burn the API rate limit. routes/running.js hit the same wall and made
// the same choice.
async function createRequestPo(client, o) {
  const request = o.request;
  const lines = o.lines;
  const typeById = o.typeById;
  const poNumber = o.po_number;

  const poLines = [];
  const vendors = [];
  for (var i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const t = typeById[ln.asset_type_id] || {};
    const override = (o.overrides && o.overrides[ln.asset_type_id]) || {};
    const vendor = (override.vendor_name || t.vendor_name || '').trim();
    const cost = override.unit_cost !== undefined && override.unit_cost !== null ? numOrNull(override.unit_cost) : numOrNull(t.unit_cost);
    if (vendor && vendors.indexOf(vendor) === -1) vendors.push(vendor);
    // po_line_items.description is NOT NULL but POST /api/pos never checks it,
    // so a missing one becomes an opaque 500. Build it here and cap it at the
    // column width rather than letting Postgres raise 22001.
    const desc = trunc((t.name || 'Equipment') + ' - ' + (ln.holding_id ? 'replacement for ' : 'for ') +
      o.tech_name + ' (' + request.request_number + ')', 500);
    poLines.push({
      item_number: trunc(override.item_number || t.item_number || null, 255),
      manufacturer: trunc(t.manufacturer || null, 255),
      description: desc,
      quantity: posInt(ln.qty, 1),
      unit_price: cost === null ? 0 : cost
    });
  }
  if (!poLines.length) return null;

  var vendorName = (o.vendor_override || '').trim();
  if (!vendorName) vendorName = vendors.length ? vendors.join(', ') : 'Various Vendors';
  vendorName = trunc(vendorName, 255);

  const total = poNum.computeTotal(poLines);
  const notes = trunc('Replacement for ' + o.tech_name + ' (' + request.request_number + ').' +
    (o.old_units.length ? ' Old unit' + (o.old_units.length === 1 ? '' : 's') + ' ' + o.old_units.join(', ') +
      ' awaiting return at ' + request.city_code + '.' : ''), 2000);

  const po = (await client.query(
    'INSERT INTO purchase_orders (po_number, requester_id, vendor_name, customer_name, city_code, notes, total_amount) ' +
    'VALUES ($1,$2,$3,NULL,$4,$5,$6) RETURNING *',
    [poNumber, request.user_id, vendorName, request.city_code, notes, total]
  )).rows[0];

  for (var j = 0; j < poLines.length; j++) {
    const pl = poLines[j];
    await client.query(
      'INSERT INTO po_line_items (po_id, item_number, manufacturer, description, quantity, unit_price, requested_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [po.id, pl.item_number, pl.manufacturer, pl.description, pl.quantity, pl.unit_price, request.user_id]
    );
  }
  return po;
}

router.post('/requests/:id/approve', requireAuth, requirePermission('approve_asset_replacement'), async (req, res) => {
  const b = req.body || {};
  const wantPo = b.create_po !== false;
  const lineFlags = {};
  (Array.isArray(b.lines) ? b.lines : []).forEach(function (l) {
    if (l && l.id) lineFlags[String(l.id)] = l.issue_from_stock === true;
  });
  const overrides = {};
  (Array.isArray(b.type_overrides) ? b.type_overrides : []).forEach(function (o) {
    if (o && o.asset_type_id) overrides[String(o.asset_type_id)] = o;
  });

  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    const pre = (await pool.query('SELECT r.*, u.name AS user_name FROM asset_requests r JOIN users u ON u.id = r.user_id WHERE r.id = $1', [req.params.id])).rows[0];
    if (!pre) return res.status(404).json({ error: 'Request not found' });
    if (pre.status !== 'pending') return res.status(409).json({ error: 'This request was already ' + pre.status + '.' });
    if (!scopeAllows(scope, pre.city_code)) return res.status(403).json({ error: 'That request is outside your cities.' });
    const city = await assertCity(pre.city_code);
    if (!city) return res.status(400).json({ error: 'This request has no valid city on it, so a PO cannot be raised. Set the city first.' });

    const rawLines = (await pool.query('SELECT * FROM asset_request_lines WHERE request_id = $1 ORDER BY position ASC, id ASC', [req.params.id])).rows;
    if (!rawLines.length) return res.status(400).json({ error: 'This request has no items on it.' });
    const types = (await pool.query('SELECT * FROM asset_types WHERE id = ANY($1)', [rawLines.map(function (l) { return l.asset_type_id; })])).rows;
    const typeById = {};
    types.forEach(function (t) { typeById[t.id] = t; });

    // A PO needs a vendor and a price. Anything missing comes back as a
    // structured list so the approve dialog can ask for it inline instead of
    // failing with a bare message.
    if (wantPo) {
      const missing = [];
      rawLines.forEach(function (l) {
        const t = typeById[l.asset_type_id] || {};
        const ov = overrides[String(l.asset_type_id)] || {};
        const vendor = ov.vendor_name || t.vendor_name;
        const cost = ov.unit_cost !== undefined && ov.unit_cost !== null && ov.unit_cost !== '' ? ov.unit_cost : t.unit_cost;
        if (!vendor || cost === null || cost === undefined) {
          missing.push({ asset_type_id: l.asset_type_id, name: t.name, vendor_name: t.vendor_name || null, unit_cost: t.unit_cost });
        }
      });
      if (missing.length && !b.vendor_name) {
        return res.status(422).json({
          error: 'Add a vendor and a cost before this can open a purchase order.',
          needs_ordering_details: missing
        });
      }
    }

    // Optionally write the ordering details back onto the equipment record so
    // nobody has to type them again.
    const saveBacks = Object.keys(overrides).filter(function (k) { return overrides[k].save === true; });
    for (var s = 0; s < saveBacks.length; s++) {
      const ov = overrides[saveBacks[s]];
      await pool.query(
        'UPDATE asset_types SET vendor_name = COALESCE($1, vendor_name), item_number = COALESCE($2, item_number), unit_cost = COALESCE($3, unit_cost), updated_at = NOW() WHERE id = $4',
        [trunc(ov.vendor_name || null, 255), trunc(ov.item_number || null, 255), numOrNull(ov.unit_cost), intOrNull(ov.asset_type_id)]
      );
    }

    const result = await poNum.withPoNumberRetry(city, poNum.getInitials(req.user.name), async function (poNumber) {
      await client.query('BEGIN');
      try {
        // Lock and re-check inside the transaction. This guard is the whole
        // idempotency story: a double tap cannot cut two POs.
        const r = (await client.query('SELECT * FROM asset_requests WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
        if (!r || r.status !== 'pending') throw httpError(409, 'This request was already handled.');

        const lines = (await client.query('SELECT * FROM asset_request_lines WHERE request_id = $1 ORDER BY position ASC, id ASC', [r.id])).rows;
        const issuedHoldings = [];
        const oldUnits = [];
        var issuedCount = 0;

        for (var i = 0; i < lines.length; i++) {
          const ln = lines[i];
          const t = typeById[ln.asset_type_id];
          if (!t) continue;
          if (!lineFlags[String(ln.id)]) continue;

          // Close the old holding first so the chain reads correctly and the
          // physical item is parked before a new one goes out.
          var oldHolding = null;
          if (ln.holding_id) {
            oldHolding = (await client.query('SELECT * FROM asset_holdings WHERE id = $1 FOR UPDATE', [ln.holding_id])).rows[0];
            if (oldHolding && !oldHolding.returned_at) {
              await closeHolding(client, oldHolding, {
                reason: ln.reason || 'broken', status: 'replaced',
                physically_returned: false, restock: false,
                actor: req.user, ref_type: 'request', ref_id: r.id
              });
              if (oldHolding.asset_id) {
                const oa = (await client.query('SELECT asset_tag, serial_number FROM assets WHERE id = $1', [oldHolding.asset_id])).rows[0];
                if (oa) oldUnits.push(oa.serial_number || oa.asset_tag || ('#' + oldHolding.asset_id));
              }
            } else { oldHolding = null; }
          }

          const fresh = await issueItem(client, {
            type: t, user_id: r.user_id, city_code: city, qty: posInt(ln.qty, 1),
            condition: 'new', actor: req.user, ref_type: 'request', ref_id: r.id,
            stock_note: 'Replacement issued on ' + r.request_number
          });
          issuedCount++;
          fresh.forEach(function (h) { issuedHoldings.push(h); });

          if (oldHolding && fresh.length) {
            await client.query('UPDATE asset_holdings SET replaced_by_holding_id = $1 WHERE id = $2', [fresh[0].id, oldHolding.id]);
          }
          await client.query('UPDATE asset_request_lines SET issued_from_stock = true, fulfilled_holding_id = $1 WHERE id = $2',
            [fresh.length ? fresh[0].id : null, ln.id]);
        }

        // Anything issued has to be signed for, so the signature record never
        // goes stale.
        var ack = null;
        if (issuedHoldings.length) {
          const number = await nextNumber(client, 'asset_acknowledgments', 'ack_number', 'AA');
          ack = (await client.query(
            'INSERT INTO asset_acknowledgments (ack_number, user_id, city_code, issued_by, note, agreement_text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
            [number, r.user_id, city, req.user.id, 'Replacement issued on ' + r.request_number, DEFAULT_AGREEMENT]
          )).rows[0];
          await addAckLines(client, ack.id, issuedHoldings, typeById, 0);
        }

        var po = null;
        if (wantPo) {
          po = await createRequestPo(client, {
            request: r, lines: lines, typeById: typeById, po_number: poNumber,
            overrides: overrides, vendor_override: b.vendor_name || null,
            tech_name: pre.user_name, old_units: oldUnits
          });
        }

        const allIssued = issuedCount === lines.length;
        const upd = await client.query(
          'UPDATE asset_requests SET status = $1, decided_by = $2, decided_at = NOW(), decision_notes = $3, ' +
          "po_id = $4, po_number = $5, updated_at = NOW() WHERE id = $6 AND status = 'pending' RETURNING *",
          [allIssued ? 'fulfilled' : 'approved', req.user.id, b.decision_notes || null,
            po ? po.id : null, po ? po.po_number : null, r.id]
        );
        if (!upd.rowCount) throw httpError(409, 'This request was already handled.');

        await client.query('COMMIT');
        return { request: upd.rows[0], po: po, ack: ack, issued: issuedCount };
      } catch (e) {
        await client.query('ROLLBACK').catch(function () {});
        throw e;
      }
    });

    try {
      await logAudit({
        entity_type: 'asset_request', entity_id: pre.id, entity_number: pre.request_number, action: 'approved',
        user_id: req.user.id, user_name: req.user.name,
        details: { issued: result.issued, po: result.po ? result.po.po_number : null, ack: result.ack ? result.ack.ack_number : null }
      });
    } catch (e) {}
    if (result.po) {
      try { await logAudit({ entity_type: 'po', entity_id: result.po.id, entity_number: result.po.po_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { source: 'asset_replacement', request: pre.request_number, city: city } }); } catch (e) {}
    }
    notifyRequestDecided(result.request, pre.user_name, req.user, result).catch(function () {});
    res.json(result);
  } catch (err) { sendErr(res, err, 'Failed to approve the request'); }
  finally { client.release(); }
});

router.post('/requests/:id/deny', requireAuth, requirePermission('approve_asset_replacement'), async (req, res) => {
  try {
    const scope = await cityScope(req);
    const pre = (await pool.query('SELECT r.*, u.name AS user_name FROM asset_requests r JOIN users u ON u.id = r.user_id WHERE r.id = $1', [req.params.id])).rows[0];
    if (!pre) return res.status(404).json({ error: 'Request not found' });
    if (!scopeAllows(scope, pre.city_code)) return res.status(403).json({ error: 'That request is outside your cities.' });
    const { rows } = await pool.query(
      "UPDATE asset_requests SET status='denied', decided_by=$1, decided_at=NOW(), decision_notes=$2, updated_at=NOW() " +
      "WHERE id=$3 AND status='pending' RETURNING *",
      [req.user.id, (req.body || {}).decision_notes || null, req.params.id]
    );
    if (!rows.length) return res.status(409).json({ error: 'This request was already handled.' });
    try { await logAudit({ entity_type: 'asset_request', entity_id: pre.id, entity_number: pre.request_number, action: 'denied', user_id: req.user.id, user_name: req.user.name, details: {} }); } catch (e) {}
    notifyRequestDecided(rows[0], pre.user_name, req.user, { issued: 0 }).catch(function () {});
    res.json(rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to deny the request'); }
});

router.post('/requests/:id/cancel', requireAuth, requirePermission('request_asset_replacement'), async (req, res) => {
  try {
    const pre = (await pool.query('SELECT * FROM asset_requests WHERE id = $1', [req.params.id])).rows[0];
    if (!pre) return res.status(404).json({ error: 'Request not found' });
    if (pre.user_id !== req.user.id) {
      const okManage = (req.user.role === 'admin' || req.user.isOwner) ||
        await permissions.hasPermission(req.user.role, 'manage_assets');
      if (!okManage) return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query(
      "UPDATE asset_requests SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *",
      [req.params.id]
    );
    if (!rows.length) return res.status(409).json({ error: 'This request was already handled.' });
    res.json(rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to cancel the request'); }
});

// Issue against a PO that has since been received.
router.post('/requests/:id/fulfill', requireAuth, requirePermission('approve_asset_replacement'), async (req, res) => {
  const client = await pool.connect();
  try {
    const scope = await cityScope(req);
    await client.query('BEGIN');
    const r = (await client.query('SELECT * FROM asset_requests WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Request not found' }); }
    if (r.status !== 'approved') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Only an approved request can be issued.' }); }
    if (!scopeAllows(scope, r.city_code)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'That request is outside your cities.' }); }
    const lines = (await client.query('SELECT * FROM asset_request_lines WHERE request_id = $1 AND issued_from_stock = false ORDER BY position ASC', [r.id])).rows;
    if (!lines.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Everything on this request has already been issued.' }); }
    const types = (await client.query('SELECT * FROM asset_types WHERE id = ANY($1)', [lines.map(function (l) { return l.asset_type_id; })])).rows;
    const typeById = {};
    types.forEach(function (t) { typeById[t.id] = t; });

    const issuedHoldings = [];
    for (var i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const t = typeById[ln.asset_type_id];
      if (!t) continue;
      if (ln.holding_id) {
        const old = (await client.query('SELECT * FROM asset_holdings WHERE id = $1 FOR UPDATE', [ln.holding_id])).rows[0];
        if (old && !old.returned_at) {
          await closeHolding(client, old, {
            reason: ln.reason || 'broken', status: 'replaced', physically_returned: false,
            restock: false, actor: req.user, ref_type: 'request', ref_id: r.id
          });
        }
      }
      const fresh = await issueItem(client, {
        type: t, user_id: r.user_id, city_code: r.city_code, qty: posInt(ln.qty, 1),
        condition: 'new', actor: req.user, ref_type: 'request', ref_id: r.id,
        stock_note: 'Issued against ' + r.request_number
      });
      fresh.forEach(function (h) { issuedHoldings.push(h); });
      if (ln.holding_id && fresh.length) {
        await client.query('UPDATE asset_holdings SET replaced_by_holding_id = $1 WHERE id = $2', [fresh[0].id, ln.holding_id]);
      }
      await client.query('UPDATE asset_request_lines SET issued_from_stock = true, fulfilled_holding_id = $1 WHERE id = $2',
        [fresh.length ? fresh[0].id : null, ln.id]);
    }

    var ack = null;
    if (issuedHoldings.length) {
      ack = await withNumberRetry(async function () {
        const number = await nextNumber(client, 'asset_acknowledgments', 'ack_number', 'AA');
        return (await client.query(
          'INSERT INTO asset_acknowledgments (ack_number, user_id, city_code, issued_by, note, agreement_text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [number, r.user_id, r.city_code, req.user.id, 'Issued against ' + r.request_number, DEFAULT_AGREEMENT]
        )).rows[0];
      });
      await addAckLines(client, ack.id, issuedHoldings, typeById, 0);
    }
    await client.query("UPDATE asset_requests SET status='fulfilled', updated_at=NOW() WHERE id=$1", [r.id]);
    await client.query('COMMIT');
    res.json({ success: true, ack: ack });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    sendErr(res, err, 'Failed to issue the replacement');
  } finally { client.release(); }
});

async function notifyRequestDecided(request, techName, actor, result) {
  try {
    const tech = (await pool.query('SELECT id, email, name, receive_emails FROM users WHERE id = $1', [request.user_id])).rows[0];
    if (!tech) return;
    const approved = request.status !== 'denied';
    const body = approved
      ? (result && result.issued ? 'Approved. Collect it at ' + (request.city_code || 'your location') + ' and sign for it.'
        : 'Approved and on order' + (request.po_number ? ' (' + request.po_number + ')' : '') + '.')
      : 'Not approved.' + (request.decision_notes ? ' ' + request.decision_notes : '');
    await push.sendPushToUsers([tech.id], { title: 'Replacement ' + (approved ? 'approved' : 'declined'), body: body, url: '/?view=my-equipment' });
    if (tech.email && tech.receive_emails !== false) {
      const html = emailTemplate({
        badge: approved ? 'Approved' : 'Not approved', badgeColor: approved ? 'green' : 'orange',
        title: 'Replacement request ' + request.request_number,
        body: body + (request.decision_notes && approved ? '<br /><br />' + request.decision_notes : ''),
        details: [
          { label: 'Reference', value: request.request_number },
          { label: 'Decided by', value: actor ? actor.name : '' },
          request.po_number ? { label: 'Purchase order', value: request.po_number } : null
        ].filter(Boolean)
      });
      await sendEmail(tech.email, 'Your replacement request ' + request.request_number, html);
    }
  } catch (e) { console.error('request decision notify failed:', e.message); }
}

// ---------------------------------------------------------------------------
// Photos on a request (R2). Degrades cleanly when R2 is not configured.
// ---------------------------------------------------------------------------

router.post('/requests/:id/photo-url', requireAuth, requirePermission('request_asset_replacement'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not set up yet.' });
    const r = (await pool.query('SELECT * FROM asset_requests WHERE id = $1', [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.user_id !== req.user.id) {
      const okManage = (req.user.role === 'admin' || req.user.isOwner) ||
        await permissions.hasPermission(req.user.role, 'manage_assets');
      if (!okManage) return res.status(403).json({ error: 'Forbidden' });
    }
    const ct = (req.body || {}).content_type || 'image/jpeg';
    const key = 'assets/requests/' + r.id + '/' + Date.now() + '-' + Math.round(Math.random() * 1e6) + '.jpg';
    const url = await r2.presignUpload(key, ct);
    res.json({ url: url, key: key });
  } catch (err) { sendErr(res, err, 'Failed to prepare the upload'); }
});

router.post('/requests/:id/photos', requireAuth, requirePermission('request_asset_replacement'), async (req, res) => {
  try {
    const key = (req.body || {}).key;
    if (!key) return res.status(400).json({ error: 'Missing the uploaded file.' });
    if (String(key).indexOf('assets/requests/' + req.params.id + '/') !== 0) {
      return res.status(400).json({ error: 'That file does not belong to this request.' });
    }
    const r = (await pool.query('SELECT * FROM asset_requests WHERE id = $1', [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.user_id !== req.user.id) {
      const okManage = (req.user.role === 'admin' || req.user.isOwner) ||
        await permissions.hasPermission(req.user.role, 'manage_assets');
      if (!okManage) return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query(
      'INSERT INTO asset_request_photos (request_id, request_line_id, r2_key) VALUES ($1,$2,$3) RETURNING id, created_at',
      [r.id, intOrNull((req.body || {}).request_line_id), trunc(key, 512)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { sendErr(res, err, 'Failed to attach the photo'); }
});

router.get('/requests/:id/photos/:photoId', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not set up yet.' });
    const p = (await pool.query(
      'SELECT p.*, r.user_id, r.city_code FROM asset_request_photos p JOIN asset_requests r ON r.id = p.request_id WHERE p.id = $1 AND p.request_id = $2',
      [req.params.photoId, req.params.id]
    )).rows[0];
    if (!p) return res.status(404).json({ error: 'Photo not found' });
    if (p.user_id !== req.user.id) {
      const okManage = (req.user.role === 'admin' || req.user.isOwner) ||
        await permissions.hasPermission(req.user.role, 'manage_assets') ||
        await permissions.hasPermission(req.user.role, 'approve_asset_replacement');
      if (!okManage) return res.status(403).json({ error: 'Forbidden' });
      const scope = await cityScope(req);
      if (!scopeAllows(scope, p.city_code)) return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ url: await r2.presignDownload(p.r2_key, 'photo.jpg', true, 300, 'image/jpeg') });
  } catch (err) { sendErr(res, err, 'Failed to open the photo'); }
});

// ---------------------------------------------------------------------------
// One serialized unit and its whole life. Declared LAST so it can never
// shadow /types, /kits, /search, /locations, /acks, /requests and friends.
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, requirePermission('view_assets'), async (req, res) => {
  try {
    const id = intOrNull(req.params.id);
    if (!id) return res.status(404).json({ error: 'Item not found' });
    const scope = await cityScope(req);
    const a = (await pool.query(
      'SELECT a.*, t.name, t.category, t.expected_life_months, t.unit_cost, t.vendor_name, t.item_number, t.manufacturer, ' +
      '  u.name AS holder_name, v.vehicle_number ' +
      'FROM assets a JOIN asset_types t ON t.id = a.asset_type_id ' +
      'LEFT JOIN users u ON u.id = a.assigned_user_id LEFT JOIN vehicles v ON v.id = a.vehicle_id WHERE a.id = $1',
      [id]
    )).rows[0];
    if (!a) return res.status(404).json({ error: 'Item not found' });
    if (!scopeAllows(scope, a.city_code)) return res.status(403).json({ error: 'That item is outside your cities.' });
    a.holdings = (await pool.query(
      'SELECT h.*, u.name AS user_name, ak.ack_number, ak.status AS ack_status, ' +
      '  EXTRACT(EPOCH FROM (COALESCE(h.returned_at, NOW()) - h.issued_at)) AS held_seconds ' +
      'FROM asset_holdings h LEFT JOIN users u ON u.id = h.user_id LEFT JOIN asset_acknowledgments ak ON ak.id = h.ack_id ' +
      'WHERE h.asset_id = $1 ORDER BY h.issued_at DESC',
      [id]
    )).rows;
    res.json(a);
  } catch (err) { sendErr(res, err, 'Failed to load the item'); }
});

module.exports = router;
module.exports.relocateHoldings = relocateHoldings;
module.exports.notifyRelocation = notifyRelocation;
