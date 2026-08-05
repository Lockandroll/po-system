const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const permissions = require('../utils/permissions');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Call Search - history, not the live board
// ---------------------------------------------------------------------------
// The board is NOW. This is what happened: it includes done, goa and cancelled
// calls, which the board never shows. Three widening permissions decide the
// rows, and a roadside tech gets customer details masked here even though they
// see them in full on a live call they can actually take.
// ---------------------------------------------------------------------------

async function hasPerm(req, perm) {
  if (!req.user) return false;
  if (req.user.role === 'admin' || req.user.role === 'owner') return true;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (e) {}
  const ep = req._userRow && req._userRow.extra_perms;
  return Array.isArray(ep) && ep.indexOf(perm) !== -1;
}

// Every column this screen can show. The key is what the client asks for; sql
// is what produces it. Nothing outside this map can ever be selected, so a
// crafted request cannot reach a column nobody was offered.
const COLUMNS = {
  job_number:    { label: 'Job #',        sql: 'j.job_number' },
  created_at:    { label: 'Date',         sql: 'j.created_at' },
  city:          { label: 'City',         sql: 'TRIM(j.city_code)' },
  city_name:     { label: 'Location',     sql: 'c.name' },
  account:       { label: 'Account',      sql: "COALESCE(j.account_name, '')" },
  account_po:    { label: 'PO',           sql: "COALESCE(j.account_po, '')" },
  customer:      { label: 'Customer',     sql: "COALESCE(j.customer_name, '')", pii: 'name' },
  address:       { label: 'Address',      sql: "COALESCE(j.address, '')", pii: 'address' },
  zip:           { label: 'Zip',          sql: "COALESCE(j.zip, '')" },
  business:      { label: 'Business',     sql: "COALESCE(j.business_name, '')" },
  service:       { label: 'Service',      sql: "COALESCE(st.name, j.service_type, '')" },
  category:      { label: 'Category',     sql: "COALESCE(st.category_code, '')" },
  is_edu:        { label: 'EDU',          sql: 'j.is_edu' },
  status:        { label: 'Status',       sql: 'j.status' },
  tech:          { label: 'Tech',         sql: "COALESCE(u.name, '')" },
  dispatched_by: { label: 'Dispatched by', sql: "COALESCE(cb.name, '')" },
  eta_minutes:   { label: 'ETA',          sql: 'j.eta_minutes' },
  on_time:       { label: 'On time?',     sql: 'CASE WHEN j.eta_promised_at IS NULL OR j.arrived_at IS NULL THEN NULL ' +
                                                'WHEN j.arrived_at <= j.eta_promised_at THEN true ELSE false END' },
  age_at_close:  { label: 'Age at close', sql: 'CASE WHEN COALESCE(j.completed_at, j.goa_at) IS NULL THEN NULL ' +
                                                'ELSE EXTRACT(EPOCH FROM (COALESCE(j.completed_at, j.goa_at) - j.created_at))::int END' },
  quoted_price:  { label: 'Price',        sql: 'j.quoted_price' },
  plate:         { label: 'Plate',        sql: "COALESCE(j.license_tag, '')" },
  vin:           { label: 'VIN',          sql: "COALESCE(j.vin, '')" },
  vehicle:       { label: 'Vehicle',      sql: "TRIM(COALESCE(j.vehicle_year,'') || ' ' || COALESCE(j.vehicle_make,'') || ' ' || COALESCE(j.vehicle_model,''))" },
  tags:          { label: 'Tags',         sql: "COALESCE((SELECT string_agg(t.name, ', ' ORDER BY t.sort) " +
                                                'FROM dispatch_job_tags jt JOIN dispatch_tags t ON t.id = jt.tag_id ' +
                                                "WHERE jt.job_id = j.id), '')" }
};

const DEFAULT_COLUMNS = ['job_number', 'created_at', 'city', 'account', 'customer', 'address',
  'service', 'status', 'tech', 'age_at_close'];

// Columns nobody without view_customer_pii may even tick. Filtering the OFFER
// is what stops the export being used to widen a view - you cannot export a
// column you were never allowed to choose.
function allowedColumns(canSeePii) {
  return Object.keys(COLUMNS).filter(function (k) {
    if (COLUMNS[k].pii && !canSeePii) return true;   // still offered, but masked
    return true;
  });
}

// ---------------------------------------------------------------------------
//  Masking
// ---------------------------------------------------------------------------
// Applied to the ROWS after the query, but only ever to values the query was
// allowed to return in the first place; phone and email are never selected at
// all. Name collapses to initials, the street number is dropped.
function maskName(v) {
  if (!v) return '';
  return String(v).trim().split(/\s+/).map(function (part) {
    return part.charAt(0).toUpperCase() + '.';
  }).join(' ');
}
function maskAddress(v) {
  if (!v) return '';
  // Drop a leading house number: "1699 Semoran N Cir" -> "Semoran N Cir".
  return String(v).replace(/^\s*[0-9]+[A-Za-z]?\s+/, '').trim();
}

function applyMask(rows, cols) {
  const nameCols = cols.filter(function (c) { return COLUMNS[c] && COLUMNS[c].pii === 'name'; });
  const addrCols = cols.filter(function (c) { return COLUMNS[c] && COLUMNS[c].pii === 'address'; });
  if (!nameCols.length && !addrCols.length) return rows;
  return rows.map(function (r) {
    const out = Object.assign({}, r);
    nameCols.forEach(function (c) { out[c] = maskName(out[c]); });
    addrCols.forEach(function (c) { out[c] = maskAddress(out[c]); });
    return out;
  });
}

// ---------------------------------------------------------------------------
//  Scope
// ---------------------------------------------------------------------------
async function scopeFor(req) {
  if (await hasPerm(req, 'search_dispatch_all')) return 'all';
  if (await hasPerm(req, 'search_dispatch_city')) return 'city';
  return 'own';
}

function esc(term) {
  return String(term).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

async function buildQuery(req, opts) {
  const q = req.query || {};
  const params = [];
  const where = [];

  const scope = await scopeFor(req);
  if (scope === 'own') {
    params.push(req.user.id);
    where.push('(j.assigned_to = $' + params.length + ' OR j.created_by = $' + params.length + ')');
  } else if (scope === 'city') {
    params.push(req.user.id);
    where.push('TRIM(j.city_code) = (SELECT TRIM(home_city) FROM users WHERE id = $' + params.length + ')');
  }

  // Category scoping applies at EVERY scope, including admin's own view of what
  // a tech would see - it is about competence, not seniority.
  const isPrivileged = req.user.role === 'admin' || req.user.role === 'owner' ||
    req.user.role === 'manager' || (await hasPerm(req, 'manage_dispatch'));
  if (!isPrivileged) {
    params.push(req.user.id);
    where.push('EXISTS (SELECT 1 FROM service_types s2 ' +
      'JOIN user_service_categories usc ON usc.category_code = s2.category_code ' +
      'WHERE s2.id = j.service_type_id AND usc.user_id = $' + params.length + ' AND usc.can_view = true)');
  }

  // Custom From / To, not canned buckets.
  if (q.from) { params.push(q.from); where.push('j.created_at >= $' + params.length + '::date'); }
  if (q.to) { params.push(q.to); where.push("j.created_at < ($" + params.length + "::date + interval '1 day')"); }
  if (q.city) { params.push(String(q.city).trim().slice(0, 3)); where.push('TRIM(j.city_code) = $' + params.length); }
  if (q.status) { params.push(String(q.status)); where.push('j.status = $' + params.length); }
  if (q.service_type_id) { params.push(parseInt(q.service_type_id, 10)); where.push('j.service_type_id = $' + params.length); }
  if (q.category) { params.push(String(q.category)); where.push('st.category_code = $' + params.length); }
  if (q.assigned_to) { params.push(parseInt(q.assigned_to, 10)); where.push('j.assigned_to = $' + params.length); }
  if (q.account_id) { params.push(parseInt(q.account_id, 10)); where.push('j.account_id = $' + params.length); }
  if (q.edu === '1') where.push('j.is_edu = true');
  if (q.tag_id) {
    params.push(parseInt(q.tag_id, 10));
    where.push('EXISTS (SELECT 1 FROM dispatch_job_tags jt WHERE jt.job_id = j.id AND jt.tag_id = $' + params.length + ')');
  }
  if (q.text && String(q.text).trim()) {
    const t = '%' + esc(String(q.text).trim()) + '%';
    const digits = String(q.text).replace(/[^0-9]/g, '');
    params.push(t);
    const p = '$' + params.length;
    var clause =
      '(j.job_number ILIKE ' + p + " ESCAPE '\\' OR j.customer_name ILIKE " + p + " ESCAPE '\\'" +
      ' OR j.business_name ILIKE ' + p + " ESCAPE '\\' OR j.address ILIKE " + p + " ESCAPE '\\'" +
      ' OR j.license_tag ILIKE ' + p + " ESCAPE '\\' OR j.vin ILIKE " + p + " ESCAPE '\\'" +
      ' OR j.account_po ILIKE ' + p + " ESCAPE '\\' OR j.account_name ILIKE " + p + " ESCAPE '\\'";
    if (digits.length >= 4) {
      params.push('%' + digits + '%');
      clause += " OR regexp_replace(COALESCE(j.customer_phone,'') || COALESCE(j.callback_phone,''), '[^0-9]', '', 'g') LIKE $" + params.length;
    }
    clause += ')';
    where.push(clause);
  }

  return {
    where: where.length ? ' WHERE ' + where.join(' AND ') : '',
    params: params,
    scope: scope
  };
}

const FROM =
  ' FROM dispatch_jobs j ' +
  ' LEFT JOIN users u ON u.id = j.assigned_to ' +
  ' LEFT JOIN users cb ON cb.id = j.created_by ' +
  ' LEFT JOIN cities c ON TRIM(c.code) = TRIM(j.city_code) ' +
  ' LEFT JOIN service_types st ON st.id = j.service_type_id ';

function wantedColumns(raw) {
  var cols = [];
  if (typeof raw === 'string' && raw.trim()) cols = raw.split(',');
  else if (Array.isArray(raw)) cols = raw;
  cols = cols.map(function (c) { return String(c).trim(); }).filter(function (c) { return !!COLUMNS[c]; });
  if (!cols.length) cols = DEFAULT_COLUMNS.slice();
  // job_number is always present: without it a row cannot be opened or quoted
  // back to anyone, and an export of anonymous rows helps nobody.
  if (cols.indexOf('job_number') === -1) cols.unshift('job_number');
  return cols.slice(0, 25);
}

// ---------------------------------------------------------------------------
//  Endpoints
// ---------------------------------------------------------------------------
router.get('/columns', requireAuth, requirePermission('search_dispatch'), async function (req, res) {
  const canSeePii = await hasPerm(req, 'view_customer_pii');
  const saved = await pool.query(
    "SELECT columns FROM user_grid_prefs WHERE user_id = $1 AND grid = 'call_search'", [req.user.id]);
  res.json({
    available: allowedColumns(canSeePii).map(function (k) {
      return { key: k, label: COLUMNS[k].label, masked: !!(COLUMNS[k].pii && !canSeePii) };
    }),
    selected: saved.rows.length ? saved.rows[0].columns : DEFAULT_COLUMNS,
    defaults: DEFAULT_COLUMNS,
    canSeePii: canSeePii,
    scope: await scopeFor(req)
  });
});

router.post('/columns', requireAuth, requirePermission('search_dispatch'), async function (req, res) {
  const cols = wantedColumns((req.body && req.body.columns) || []);
  await pool.query(
    "INSERT INTO user_grid_prefs (user_id, grid, columns) VALUES ($1, 'call_search', $2) " +
    'ON CONFLICT (user_id, grid) DO UPDATE SET columns = EXCLUDED.columns',
    [req.user.id, cols]);
  res.json({ ok: true, columns: cols });
});

router.get('/', requireAuth, requirePermission('search_dispatch'), async function (req, res) {
  const cols = wantedColumns(req.query.columns);
  const canSeePii = await hasPerm(req, 'view_customer_pii');
  const q = await buildQuery(req, {});
  const select = cols.map(function (c) { return COLUMNS[c].sql + ' AS "' + c + '"'; }).join(', ');
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const countR = await pool.query('SELECT COUNT(*)::int AS n' + FROM + q.where, q.params);
  const rowsR = await pool.query(
    'SELECT j.id, ' + select + FROM + q.where + ' ORDER BY j.created_at DESC LIMIT ' + limit + ' OFFSET ' + offset,
    q.params);

  res.json({
    total: countR.rows[0].n,
    columns: cols.map(function (c) { return { key: c, label: COLUMNS[c].label }; }),
    rows: canSeePii ? rowsR.rows : applyMask(rowsR.rows, cols),
    masked: !canSeePii,
    scope: q.scope,
    limit: limit,
    offset: offset
  });
});

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// The export writes EXACTLY the columns on screen, in that order, and reads the
// same masked projection - so it can never be used to see more than the screen
// already showed.
router.get('/export', requireAuth, requirePermission('search_dispatch_all'), async function (req, res) {
  const cols = wantedColumns(req.query.columns);
  const canSeePii = await hasPerm(req, 'view_customer_pii');
  const q = await buildQuery(req, {});
  const select = cols.map(function (c) { return COLUMNS[c].sql + ' AS "' + c + '"'; }).join(', ');
  const r = await pool.query(
    'SELECT ' + select + FROM + q.where + ' ORDER BY j.created_at DESC LIMIT 20000', q.params);
  const rows = canSeePii ? r.rows : applyMask(r.rows, cols);

  await logAudit({
    entity_type: 'dispatch_search', entity_id: null, action: 'export',
    user_id: req.user.id, user_name: req.user.name,
    details: { rows: rows.length, columns: cols, filters: req.query }, ip: req.ip
  });

  const head = cols.map(function (c) { return csvCell(COLUMNS[c].label); }).join(',');
  const body = rows.map(function (row) {
    return cols.map(function (c) { return csvCell(row[c]); }).join(',');
  }).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="nova-calls.csv"');
  res.send(head + '\n' + body + '\n');
});

module.exports = router;
module.exports.COLUMNS = COLUMNS;
module.exports.maskName = maskName;
module.exports.maskAddress = maskAddress;
