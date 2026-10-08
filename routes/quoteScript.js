// Dispatch Quote Script API, Phase 1: residential + commercial (2026-10-08).
// Mounted at /api/quote-script. Engine: utils/quoteScript.js.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files). Use string concatenation only.
//
// Two permissions, both deliberate:
//   use_quote_script - the dispatcher panel (Dispatch > Quote), the account
//                      search it needs, and logging an outcome. NEW, ships dark
//                      (CLAUDE.md 1.5): tick it for the Dispatcher role in
//                      Settings > Roles & Access to go live. It does NOT need
//                      view_dispatch, so the panel can go live before Nova's
//                      own dispatch board does.
//   manage_pricing   - EXISTING (roadside time codes already use it). Every
//                      price, task, script and account rate. Not in any role's
//                      DEFAULTS, so only admin/owner hold it: Tony's call that
//                      prices and scripts are owner/admin only.
//
// The server recomputes the price on every save. A quote row is never built
// from numbers the browser sent, so the log always shows what the engine
// would have said at that moment.
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const permissions = require('../utils/permissions');
const engine = require('../utils/quoteScript');
const zones = require('../utils/zones');

const router = express.Router();
const requireUse = requirePermission('use_quote_script');
const requireManage = requirePermission('manage_pricing');
// The account search serves both the panel and the account-rates editor.
async function requireUseOrManage(req, res, next) {
  try {
    if (await permissions.hasPermission(req.user.role, 'use_quote_script')) return next();
    if (await canManage(req)) return next();
    const { userHasExtraPerm } = require('../middleware/auth');
    if (await userHasExtraPerm(req, req.user.id, 'use_quote_script')) return next();
  } catch (e) { /* fall through, fail closed */ }
  return res.status(403).json({ error: 'Forbidden' });
}

const OUTCOMES = ['booked_asap', 'booked_scheduled', 'callback', 'declined'];

function s(v, max) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!t) return null;
  return max ? t.slice(0, max) : t;
}
function intOrNull(v) {
  const n = parseInt(v, 10);
  return isFinite(n) ? n : null;
}
function cat(v) { return engine.CATEGORIES.indexOf(v) !== -1 ? v : null; }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
async function canManage(req) {
  if (await permissions.hasPermission(req.user.role, 'manage_pricing')) return true;
  const { userHasExtraPerm } = require('../middleware/auth');
  return userHasExtraPerm(req, req.user.id, 'manage_pricing');
}
function audit(req, action, details) {
  return logAudit({ entity_type: 'quote_script', action: action, user_id: req.user.id, user_name: req.user.name, details: details, ip: req.ip });
}
// Cities a customer can be quoted in. Not every row in cities is a market:
// Dispatch (DIS) is the call-centre division, not somewhere a tech drives to,
// so it never gets a rate card or shows in the panel (Tony, 2026-10-08). The
// list lives in settings.quote_excluded_cities (codes, comma separated) so a
// future non-market row can be added without a deploy.
async function excludedCities() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'quote_excluded_cities'");
    const v = r.rows.length ? String(r.rows[0].value || '') : 'DIS';
    return v.split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean);
  } catch (e) { return ['DIS']; }
}
async function cityList() {
  const skip = await excludedCities();
  const r = await pool.query('SELECT TRIM(code) AS code, name FROM cities WHERE active = true ORDER BY name ASC');
  return r.rows.filter(function (c) { return skip.indexOf(String(c.code).toUpperCase()) === -1; });
}

// ===========================================================================
// Dispatcher side (use_quote_script)
// ===========================================================================

// Everything the panel needs once: cities with which categories are live,
// decline reasons, and whether this person can open the pricing screens.
router.get('/bootstrap', requireAuth, requireUse, async (req, res) => {
  const cities = await cityList();
  const live = await engine.liveMap();
  cities.forEach(function (c) { c.live = live[c.code] || {}; });
  const reasons = await pool.query('SELECT label FROM quote_decline_reasons WHERE active = true ORDER BY sort, id');
  res.json({
    cities: cities,
    decline_reasons: reasons.rows.map(function (r) { return r.label; }),
    can_manage: await canManage(req),
    dispatcher: firstName(req.user.name)
  });
});

// Zip -> city + zone. A zip in no zone is fine (most cities have no map yet).
router.get('/zip', requireAuth, requireUse, async (req, res) => {
  const zip = s(req.query.zip, 10);
  if (!zip) return res.json({ city_code: null, zone: null });
  var hit = null;
  try { hit = await zones.resolve({ zip: zip, city_code: s(req.query.city, 10) }); } catch (e) { hit = null; }
  const z = hit && hit.zone;
  res.json({
    city_code: z ? String(z.city_code || '').trim() : null,
    zone: z ? { id: z.id, name: z.name } : null,
    out_of_area: !!(hit && hit.out_of_area)
  });
});

// The task list for one category in one city, each with its lead price.
router.get('/catalog', requireAuth, requireUse, async (req, res) => {
  const city = engine.cleanCity(req.query.city);
  const category = cat(req.query.category);
  if (!city || !category) return res.status(400).json({ error: 'city and category are required' });
  const rc = await pool.query('SELECT first_hour, addl_hour FROM quote_rate_cards WHERE TRIM(city_code) = $1 AND category = $2', [city, category]);
  const card = rc.rows[0] || {};
  const tasks = await pool.query(
    'SELECT t.id, t.name, t.group_name, t.pricing, t.tech_confirms, t.show_parts_line, t.upsell_task_id, ' +
    '  fp.package_price ' +
    'FROM quote_tasks t LEFT JOIN quote_flat_prices fp ON fp.task_id = t.id AND TRIM(fp.city_code) = $2 ' +
    'WHERE t.active = true AND t.category = $1 ORDER BY t.sort, t.id', [category, city]);
  const ids = tasks.rows.map(function (t) { return t.id; });
  const units = ids.length ? (await pool.query(
    'SELECT u.task_id, u.code, u.label, u.included_qty, up.addl_price FROM quote_task_units u ' +
    'LEFT JOIN quote_unit_prices up ON up.task_id = u.task_id AND up.unit_code = u.code AND TRIM(up.city_code) = $2 ' +
    'WHERE u.task_id = ANY($1) ORDER BY u.sort, u.id', [ids, city])).rows : [];
  const byTask = {};
  units.forEach(function (u) { (byTask[u.task_id] = byTask[u.task_id] || []).push(u); });
  res.json({
    city_code: city, category: category,
    live: card.first_hour !== null && card.first_hour !== undefined,
    first_hour: card.first_hour === undefined ? null : card.first_hour,
    addl_hour: card.addl_hour === undefined ? null : card.addl_hour,
    tasks: tasks.rows.map(function (t) {
      t.units = byTask[t.id] || [];
      t.lead_price = t.pricing === 'hourly' ? (card.first_hour === undefined ? null : card.first_hour) : t.package_price;
      return t;
    })
  });
});

// Account search for the panel. Name only, and never an owner-restricted
// account: a dispatcher without view_vendors must not learn those exist.
router.get('/accounts', requireAuth, requireUseOrManage, async (req, res) => {
  const q = s(req.query.q, 80);
  if (!q || q.length < 2) return res.json([]);
  const r = await pool.query(
    "SELECT id, name, quote_fallback, " +
    "  EXISTS (SELECT 1 FROM quote_account_rates a WHERE a.account_id = v.id) OR " +
    "  EXISTS (SELECT 1 FROM quote_account_task_prices p WHERE p.account_id = v.id) AS has_rates " +
    "FROM vendors v WHERE name ILIKE $1 AND (restricted_to IS NULL OR cardinality(restricted_to) = 0) " +
    "ORDER BY name LIMIT 20", ['%' + q + '%']);
  res.json(r.rows);
});

function priceInput(req) {
  const b = req.body || {};
  return {
    city_code: b.city_code, task_id: b.task_id, quantities: b.quantities || {},
    account_id: b.account_id || null, zip: s(b.zip, 10), dispatcher: firstName(req.user.name)
  };
}

router.post('/price', requireAuth, requireUse, async (req, res) => {
  const out = await engine.price(priceInput(req));
  if (out.error) return res.status(400).json(out);
  res.json(out);
});

// Log a quote with its outcome. The price is recomputed here, never trusted
// from the browser.
router.post('/quotes', requireAuth, requireUse, async (req, res) => {
  const b = req.body || {};
  const outcome = OUTCOMES.indexOf(b.outcome) !== -1 ? b.outcome : null;
  if (!outcome) return res.status(400).json({ error: 'Pick an outcome.' });
  const p = await engine.price(priceInput(req));
  if (p.error) return res.status(400).json(p);
  const r = await pool.query(
    'INSERT INTO dispatch_quotes (created_by, created_by_name, city_code, zip, zone_id, zone_name, out_of_area, category, task_id, task_name, ' +
    '  pricing, account_id, account_name, price_source, price_missing, total, first_hour, addl_hour, eta_low, eta_high, tech_confirms, customer_name, ' +
    '  snapshot, outcome, decline_reason, pulsar_call_number, note, upsell_offered, upsell_accepted, outcome_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$1) RETURNING id',
    [req.user.id, req.user.name || null, p.city_code, s(b.zip, 10), p.zone ? p.zone.id : null, p.zone ? p.zone.name : null, !!p.out_of_area,
      p.task.category, p.task.id, p.task.name, p.task.pricing, p.account ? p.account.id : null, p.account ? p.account.name : null,
      p.source, !!p.price_missing, p.total, p.first_hour, p.addl_hour, p.eta ? p.eta.low : null, p.eta ? p.eta.high : null,
      !!p.task.tech_confirms, s(b.customer_name, 120), JSON.stringify(p), outcome,
      outcome === 'declined' ? s(b.decline_reason, 80) : null, s(b.pulsar_call_number, 40), s(b.note, 2000),
      !!p.upsell && p.upsell.price !== null, !!b.upsell_accepted]);
  res.json({ id: r.rows[0].id, total: p.total });
});

// Change an outcome later (a Callback that booked). The person who logged it
// can, and so can anyone with manage_pricing.
router.patch('/quotes/:id/outcome', requireAuth, requireUse, async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body || {};
  const outcome = OUTCOMES.indexOf(b.outcome) !== -1 ? b.outcome : null;
  if (!id || !outcome) return res.status(400).json({ error: 'Pick an outcome.' });
  const q = await pool.query('SELECT id, created_by FROM dispatch_quotes WHERE id = $1', [id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quote not found' });
  if (q.rows[0].created_by !== req.user.id && !(await canManage(req))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query(
    'UPDATE dispatch_quotes SET outcome = $2, decline_reason = $3, pulsar_call_number = COALESCE($4, pulsar_call_number), ' +
    '  note = COALESCE($5, note), upsell_accepted = COALESCE($6, upsell_accepted), outcome_at = NOW(), outcome_by = $7 WHERE id = $1',
    [id, outcome, outcome === 'declined' ? s(b.decline_reason, 80) : null, s(b.pulsar_call_number, 40), s(b.note, 2000),
      typeof b.upsell_accepted === 'boolean' ? b.upsell_accepted : null, req.user.id]);
  res.json({ ok: true });
});

// Recent quotes. A dispatcher sees their own; manage_pricing sees everyone's.
router.get('/quotes', requireAuth, requireUse, async (req, res) => {
  const manage = await canManage(req);
  const params = [];
  const where = [];
  if (!manage || req.query.mine === '1') { params.push(req.user.id); where.push('created_by = $' + params.length); }
  if (req.query.outcome && OUTCOMES.indexOf(req.query.outcome) !== -1) { params.push(req.query.outcome); where.push('outcome = $' + params.length); }
  const limit = Math.min(200, Math.max(1, intOrNull(req.query.limit) || 25));
  const r = await pool.query(
    'SELECT id, created_at, created_by_name, city_code, category, task_name, pricing, account_name, price_source, total, first_hour, ' +
    '  outcome, decline_reason, pulsar_call_number, customer_name, outcome_at FROM dispatch_quotes ' +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY created_at DESC LIMIT ' + limit, params);
  res.json(r.rows);
});

// ===========================================================================
// Admin side (manage_pricing)
// ===========================================================================

router.get('/admin', requireAuth, requireManage, async (req, res) => {
  const cities = await cityList();
  const cards = (await pool.query('SELECT TRIM(city_code) AS city_code, category, first_hour, addl_hour FROM quote_rate_cards')).rows;
  const tasks = (await pool.query('SELECT * FROM quote_tasks ORDER BY category, sort, id')).rows;
  const units = (await pool.query('SELECT task_id, code, label, included_qty, sort FROM quote_task_units ORDER BY sort, id')).rows;
  const flat = (await pool.query('SELECT task_id, TRIM(city_code) AS city_code, package_price FROM quote_flat_prices')).rows;
  const unitPrices = (await pool.query('SELECT task_id, unit_code, TRIM(city_code) AS city_code, addl_price FROM quote_unit_prices')).rows;
  const blocks = (await pool.query('SELECT block_key, category, body FROM quote_script_blocks')).rows;
  const reasons = (await pool.query('SELECT label FROM quote_decline_reasons WHERE active = true ORDER BY sort, id')).rows;
  const set = (await pool.query("SELECT key, value FROM settings WHERE key IN ('quote_parts_line','quote_surcharge_disclosure')")).rows;
  const excluded = await excludedCities();
  const settings = { parts_line: engine.DEFAULT_PARTS_LINE, surcharge_disclosure: engine.DEFAULT_SURCHARGE };
  set.forEach(function (x) { if (x.key === 'quote_parts_line') settings.parts_line = x.value; else settings.surcharge_disclosure = x.value; });
  const byTask = {};
  units.forEach(function (u) { (byTask[u.task_id] = byTask[u.task_id] || []).push(u); });
  tasks.forEach(function (t) { t.units = byTask[t.id] || []; });
  res.json({
    cities: cities, rate_cards: cards, tasks: tasks, flat_prices: flat, unit_prices: unitPrices,
    blocks: blocks, block_keys: engine.BLOCK_KEYS, decline_reasons: reasons.map(function (r) { return r.label; }),
    settings: Object.assign(settings, { excluded_cities: excluded.join(', ') })
  });
});

// Batch upsert. A blank number clears that rate (and hides the category in
// that city if it was the first hour).
router.put('/admin/rate-cards', requireAuth, requireManage, async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  const changed = [];
  for (const r of rows) {
    const city = engine.cleanCity(r.city_code);
    const category = cat(r.category);
    if (!city || !category) continue;
    const first = engine.numOrNull(r.first_hour);
    const addl = engine.numOrNull(r.addl_hour);
    if ((first !== null && first < 0) || (addl !== null && addl < 0)) return res.status(400).json({ error: 'Rates cannot be negative.' });
    const prev = await pool.query('SELECT first_hour, addl_hour FROM quote_rate_cards WHERE TRIM(city_code) = $1 AND category = $2', [city, category]);
    const p = prev.rows[0] || { first_hour: null, addl_hour: null };
    if (engine.numOrNull(p.first_hour) === first && engine.numOrNull(p.addl_hour) === addl) continue;
    await pool.query(
      'INSERT INTO quote_rate_cards (city_code, category, first_hour, addl_hour, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,NOW()) ' +
      'ON CONFLICT (city_code, category) DO UPDATE SET first_hour = EXCLUDED.first_hour, addl_hour = EXCLUDED.addl_hour, updated_by = EXCLUDED.updated_by, updated_at = NOW()',
      [city, category, first, addl, req.user.id]);
    changed.push({ city: city, category: category, from: p, to: { first_hour: first, addl_hour: addl } });
  }
  if (changed.length) await audit(req, 'rate_cards_updated', { changes: changed });
  res.json({ ok: true, changed: changed.length });
});

async function upsertTask(req, id) {
  const b = req.body || {};
  const name = s(b.name, 120);
  const category = cat(b.category);
  if (!name || !category) return { error: 'Name and category are required.' };
  const pricing = b.pricing === 'flat' ? 'flat' : 'hourly';
  const vals = [category, s(b.group_name, 60) || 'Other', name, pricing, !!b.tech_confirms, !!b.show_parts_line,
    intOrNull(b.upsell_task_id), s(b.qualify_text, 2000), s(b.price_text, 2000), s(b.policy_text, 2000), s(b.upsell_text, 2000),
    intOrNull(b.sort) || 0, b.active === false ? false : true];
  if (vals[6] && vals[6] === id) vals[6] = null; // a task cannot upsell itself
  var taskId = id;
  if (id) {
    const r = await pool.query(
      'UPDATE quote_tasks SET category=$1, group_name=$2, name=$3, pricing=$4, tech_confirms=$5, show_parts_line=$6, upsell_task_id=$7, ' +
      '  qualify_text=$8, price_text=$9, policy_text=$10, upsell_text=$11, sort=$12, active=$13, updated_at=NOW() WHERE id=$14 RETURNING id',
      vals.concat([id]));
    if (!r.rows.length) return { error: 'Task not found', status: 404 };
  } else {
    const r = await pool.query(
      'INSERT INTO quote_tasks (category, group_name, name, pricing, tech_confirms, show_parts_line, upsell_task_id, qualify_text, price_text, ' +
      '  policy_text, upsell_text, sort, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id', vals);
    taskId = r.rows[0].id;
  }
  // Units: replace the set. Codes are slugged from the label when new.
  if (Array.isArray(b.units)) {
    const keep = [];
    for (var i = 0; i < b.units.length; i++) {
      const u = b.units[i] || {};
      const label = s(u.label, 60);
      if (!label) continue;
      const code = (s(u.code, 30) || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || ('unit' + i);
      keep.push(code);
      await pool.query(
        'INSERT INTO quote_task_units (task_id, code, label, included_qty, sort) VALUES ($1,$2,$3,$4,$5) ' +
        'ON CONFLICT (task_id, code) DO UPDATE SET label = EXCLUDED.label, included_qty = EXCLUDED.included_qty, sort = EXCLUDED.sort',
        [taskId, code, label, Math.max(0, intOrNull(u.included_qty) || 0), i]);
    }
    await pool.query('DELETE FROM quote_task_units WHERE task_id = $1 AND NOT (code = ANY($2))', [taskId, keep]);
  }
  return { id: taskId };
}

router.post('/admin/tasks', requireAuth, requireManage, async (req, res) => {
  const out = await upsertTask(req, null);
  if (out.error) return res.status(out.status || 400).json(out);
  await audit(req, 'task_created', { task_id: out.id, name: req.body.name });
  res.json(out);
});
router.put('/admin/tasks/:id', requireAuth, requireManage, async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  const prev = await engine.taskWithUnits(id);
  const out = await upsertTask(req, id);
  if (out.error) return res.status(out.status || 400).json(out);
  await audit(req, 'task_updated', { task_id: id, from: prev, to: req.body });
  res.json(out);
});

// One task's price for one city: the package and each unit's extra price.
router.put('/admin/flat-prices', requireAuth, requireManage, async (req, res) => {
  const b = req.body || {};
  const taskId = intOrNull(b.task_id);
  const city = engine.cleanCity(b.city_code);
  if (!taskId || !city) return res.status(400).json({ error: 'task_id and city_code are required' });
  const pkg = engine.numOrNull(b.package_price);
  if (pkg !== null && pkg < 0) return res.status(400).json({ error: 'Prices cannot be negative.' });
  const before = await pool.query('SELECT package_price FROM quote_flat_prices WHERE task_id = $1 AND TRIM(city_code) = $2', [taskId, city]);
  await pool.query(
    'INSERT INTO quote_flat_prices (task_id, city_code, package_price, updated_at) VALUES ($1,$2,$3,NOW()) ' +
    'ON CONFLICT (task_id, city_code) DO UPDATE SET package_price = EXCLUDED.package_price, updated_at = NOW()', [taskId, city, pkg]);
  const units = b.units || {};
  for (const code of Object.keys(units)) {
    const v = engine.numOrNull(units[code]);
    if (v !== null && v < 0) continue;
    await pool.query(
      'INSERT INTO quote_unit_prices (task_id, unit_code, city_code, addl_price) VALUES ($1,$2,$3,$4) ' +
      'ON CONFLICT (task_id, unit_code, city_code) DO UPDATE SET addl_price = EXCLUDED.addl_price', [taskId, String(code).slice(0, 30), city, v]);
  }
  await audit(req, 'flat_price_updated', { task_id: taskId, city: city, from: before.rows[0] || null, to: { package_price: pkg, units: units } });
  res.json({ ok: true });
});

// Copy a city's prices to other cities. scope 'rate_cards' copies both rate
// cards; scope 'task' copies one flat task; scope 'all_flat' every flat task.
router.post('/admin/copy', requireAuth, requireManage, async (req, res) => {
  const b = req.body || {};
  const from = engine.cleanCity(b.from_city);
  const all = (await cityList()).map(function (c) { return c.code; });
  const to = (Array.isArray(b.to) ? b.to.map(engine.cleanCity) : all).filter(function (c) { return c && c !== from && all.indexOf(c) !== -1; });
  if (!from || !to.length) return res.status(400).json({ error: 'Pick a city to copy from and at least one to copy to.' });
  const scope = b.scope;
  var n = 0;
  if (scope === 'rate_cards') {
    const src = (await pool.query('SELECT category, first_hour, addl_hour FROM quote_rate_cards WHERE TRIM(city_code) = $1', [from])).rows;
    for (const c of to) for (const r of src) {
      await pool.query(
        'INSERT INTO quote_rate_cards (city_code, category, first_hour, addl_hour, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,NOW()) ' +
        'ON CONFLICT (city_code, category) DO UPDATE SET first_hour = EXCLUDED.first_hour, addl_hour = EXCLUDED.addl_hour, updated_by = EXCLUDED.updated_by, updated_at = NOW()',
        [c, r.category, r.first_hour, r.addl_hour, req.user.id]); n++;
    }
  } else if (scope === 'task' || scope === 'all_flat') {
    var taskIds;
    if (scope === 'task') { const t = intOrNull(b.task_id); if (!t) return res.status(400).json({ error: 'task_id required' }); taskIds = [t]; }
    else taskIds = (await pool.query("SELECT id FROM quote_tasks WHERE pricing = 'flat'")).rows.map(function (r) { return r.id; });
    for (const t of taskIds) {
      const p = (await pool.query('SELECT package_price FROM quote_flat_prices WHERE task_id = $1 AND TRIM(city_code) = $2', [t, from])).rows[0];
      const u = (await pool.query('SELECT unit_code, addl_price FROM quote_unit_prices WHERE task_id = $1 AND TRIM(city_code) = $2', [t, from])).rows;
      for (const c of to) {
        if (p) {
          await pool.query(
            'INSERT INTO quote_flat_prices (task_id, city_code, package_price, updated_at) VALUES ($1,$2,$3,NOW()) ' +
            'ON CONFLICT (task_id, city_code) DO UPDATE SET package_price = EXCLUDED.package_price, updated_at = NOW()', [t, c, p.package_price]); n++;
        }
        for (const x of u) {
          await pool.query(
            'INSERT INTO quote_unit_prices (task_id, unit_code, city_code, addl_price) VALUES ($1,$2,$3,$4) ' +
            'ON CONFLICT (task_id, unit_code, city_code) DO UPDATE SET addl_price = EXCLUDED.addl_price', [t, x.unit_code, c, x.addl_price]);
        }
      }
    }
  } else return res.status(400).json({ error: 'Unknown copy scope' });
  await audit(req, 'prices_copied', { scope: scope, from: from, to: to, task_id: b.task_id || null });
  res.json({ ok: true, copied: n, to: to });
});

router.put('/admin/blocks', requireAuth, requireManage, async (req, res) => {
  const rows = Array.isArray(req.body && req.body.blocks) ? req.body.blocks : [];
  const keys = engine.BLOCK_KEYS.map(function (k) { return k.key; });
  var n = 0;
  for (const r of rows) {
    if (keys.indexOf(r.block_key) === -1) continue;
    const category = r.category ? cat(r.category) : '';
    if (category === null) continue;
    await pool.query(
      'INSERT INTO quote_script_blocks (block_key, category, body, updated_at) VALUES ($1,$2,$3,NOW()) ' +
      'ON CONFLICT (block_key, category) DO UPDATE SET body = EXCLUDED.body, updated_at = NOW()',
      [r.block_key, category, s(r.body, 4000)]); n++;
  }
  await audit(req, 'script_updated', { blocks: n });
  res.json({ ok: true, saved: n });
});

router.put('/admin/settings', requireAuth, requireManage, async (req, res) => {
  const b = req.body || {};
  const pairs = [['quote_parts_line', s(b.parts_line, 300)], ['quote_surcharge_disclosure', s(b.surcharge_disclosure, 500)]];
  // Blank is a real answer here (every city takes quotes), so it is saved as ''.
  if (typeof b.excluded_cities === 'string') {
    const codes = b.excluded_cities.split(',').map(function (x) { return x.trim().toUpperCase().slice(0, 10); }).filter(Boolean);
    await pool.query("INSERT INTO settings (key, value) VALUES ('quote_excluded_cities', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [codes.join(',')]);
  }
  for (const p of pairs) {
    if (p[1] === null) continue;
    await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [p[0], p[1]]);
  }
  if (Array.isArray(b.decline_reasons)) {
    const labels = b.decline_reasons.map(function (x) { return s(x, 80); }).filter(Boolean);
    await pool.query('UPDATE quote_decline_reasons SET active = false');
    for (var i = 0; i < labels.length; i++) {
      await pool.query(
        'INSERT INTO quote_decline_reasons (label, sort, active) VALUES ($1,$2,true) ON CONFLICT (label) DO UPDATE SET sort = EXCLUDED.sort, active = true',
        [labels[i], (i + 1) * 10]);
    }
  }
  await audit(req, 'settings_updated', b);
  res.json({ ok: true });
});

// Account rates live with the quote script, not on the Accounts screen, so a
// rate is only ever edited by someone holding manage_pricing.
router.get('/admin/accounts/:id', requireAuth, requireManage, async (req, res) => {
  const id = intOrNull(req.params.id);
  const v = await pool.query('SELECT id, name, quote_fallback FROM vendors WHERE id = $1', [id]);
  if (!v.rows.length) return res.status(404).json({ error: 'Account not found' });
  const rates = (await pool.query('SELECT category, city_code, first_hour, addl_hour FROM quote_account_rates WHERE account_id = $1 ORDER BY category, city_code', [id])).rows;
  const prices = (await pool.query(
    'SELECT p.task_id, t.name AS task_name, t.category, p.city_code, p.package_price, p.unit_prices FROM quote_account_task_prices p ' +
    'JOIN quote_tasks t ON t.id = p.task_id WHERE p.account_id = $1 ORDER BY t.category, t.sort, p.city_code', [id])).rows;
  res.json({ account: v.rows[0], rates: rates, task_prices: prices });
});

router.put('/admin/accounts/:id', requireAuth, requireManage, async (req, res) => {
  const id = intOrNull(req.params.id);
  const b = req.body || {};
  const v = await pool.query('SELECT id, name, quote_fallback FROM vendors WHERE id = $1', [id]);
  if (!v.rows.length) return res.status(404).json({ error: 'Account not found' });
  const fallback = b.fallback === 'retail' ? 'retail' : 'no_quote';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE vendors SET quote_fallback = $2 WHERE id = $1', [id, fallback]);
    await client.query('DELETE FROM quote_account_rates WHERE account_id = $1', [id]);
    await client.query('DELETE FROM quote_account_task_prices WHERE account_id = $1', [id]);
    for (const r of (Array.isArray(b.rates) ? b.rates : [])) {
      const category = cat(r.category);
      const first = engine.numOrNull(r.first_hour);
      if (!category || first === null) continue;
      await client.query(
        'INSERT INTO quote_account_rates (account_id, category, city_code, first_hour, addl_hour) VALUES ($1,$2,$3,$4,$5) ' +
        'ON CONFLICT (account_id, category, city_code) DO UPDATE SET first_hour = EXCLUDED.first_hour, addl_hour = EXCLUDED.addl_hour',
        [id, category, engine.cleanCity(r.city_code), first, engine.numOrNull(r.addl_hour)]);
    }
    for (const p of (Array.isArray(b.task_prices) ? b.task_prices : [])) {
      const taskId = intOrNull(p.task_id);
      const pkg = engine.numOrNull(p.package_price);
      if (!taskId || pkg === null) continue;
      const up = {};
      Object.keys(p.unit_prices || {}).forEach(function (k) { const n = engine.numOrNull(p.unit_prices[k]); if (n !== null) up[String(k).slice(0, 30)] = n; });
      await client.query(
        'INSERT INTO quote_account_task_prices (account_id, task_id, city_code, package_price, unit_prices) VALUES ($1,$2,$3,$4,$5) ' +
        'ON CONFLICT (account_id, task_id, city_code) DO UPDATE SET package_price = EXCLUDED.package_price, unit_prices = EXCLUDED.unit_prices',
        [id, taskId, engine.cleanCity(p.city_code), pkg, JSON.stringify(up)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
  await audit(req, 'account_rates_updated', { account_id: id, account: v.rows[0].name, fallback: fallback, rates: b.rates || [], task_prices: b.task_prices || [] });
  res.json({ ok: true });
});

// ===========================================================================
// Report (manage_pricing)
// ===========================================================================
router.get('/report', requireAuth, requireManage, async (req, res) => {
  const to = s(req.query.to, 10) || new Date().toISOString().slice(0, 10);
  const from = s(req.query.from, 10) || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'Bad date' });
  const params = [from, to];
  const W = "created_at >= $1::date AND created_at < ($2::date + 1)";
  const BOOKED = "outcome IN ('booked_asap','booked_scheduled')";
  const totals = (await pool.query(
    'SELECT COUNT(*)::int AS quotes, ' +
    '  COUNT(*) FILTER (WHERE ' + BOOKED + ')::int AS booked, ' +
    "  COUNT(*) FILTER (WHERE outcome = 'booked_asap')::int AS asap, " +
    "  COUNT(*) FILTER (WHERE outcome = 'booked_scheduled')::int AS scheduled, " +
    "  COUNT(*) FILTER (WHERE outcome = 'declined')::int AS declined, " +
    "  COUNT(*) FILTER (WHERE outcome = 'callback')::int AS callback, " +
    '  COUNT(*) FILTER (WHERE price_missing)::int AS price_missing, ' +
    '  ROUND(AVG(total) FILTER (WHERE total IS NOT NULL), 2) AS avg_quoted, ' +
    '  COUNT(*) FILTER (WHERE upsell_offered)::int AS upsell_offered, ' +
    '  COUNT(*) FILTER (WHERE upsell_accepted)::int AS upsell_accepted ' +
    'FROM dispatch_quotes WHERE ' + W, params)).rows[0];
  function grouped(col) {
    return pool.query(
      'SELECT ' + col + ' AS k, COUNT(*)::int AS quotes, COUNT(*) FILTER (WHERE ' + BOOKED + ')::int AS booked ' +
      'FROM dispatch_quotes WHERE ' + W + ' GROUP BY 1 ORDER BY 2 DESC LIMIT 50', params).then(function (r) { return r.rows; });
  }
  const byTask = await grouped("COALESCE(task_name, '(deleted)') || ' (' || COALESCE(category, '') || ')'");
  const byDispatcher = await grouped("COALESCE(created_by_name, 'Unknown')");
  const byCity = await grouped('city_code');
  const reasons = (await pool.query(
    "SELECT COALESCE(decline_reason, 'No reason given') AS k, COUNT(*)::int AS n FROM dispatch_quotes WHERE " + W +
    " AND outcome = 'declined' GROUP BY 1 ORDER BY 2 DESC", params)).rows;
  const missing = (await pool.query(
    "SELECT task_name || ' (' || COALESCE(city_code, '') || ')' AS k, COUNT(*)::int AS n FROM dispatch_quotes WHERE " + W +
    ' AND price_missing GROUP BY 1 ORDER BY 2 DESC LIMIT 20', params)).rows;
  const openCallbacks = (await pool.query(
    "SELECT id, created_at, created_by_name, city_code, task_name, customer_name, total FROM dispatch_quotes " +
    "WHERE outcome = 'callback' AND created_at < NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 50")).rows;
  res.json({ from: from, to: to, totals: totals, by_task: byTask, by_dispatcher: byDispatcher, by_city: byCity,
    decline_reasons: reasons, price_missing: missing, open_callbacks: openCallbacks });
});

module.exports = router;
