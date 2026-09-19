// ---------------------------------------------------------------------------
// Sales tax: setup, address resolution, and the breakdown report.
//
// Model (address-driven):
//  - TAXABILITY (does a state tax parts, labor, or both for an account type) is
//    state law, so it keys on (state, account_type) in tax_rules.
//  - The RATE is per county, in tax_counties, resolved from the invoice SERVICE
//    ADDRESS via utils/geocode (county + state come back from the geocoder).
//  - Ships DARK: settings.tax_gate_enabled is a JSON array of enabled state
//    codes (or "all"). Until a state is listed, tax resolution and the
//    finish-line gate do not apply to it.
//
// House style: string concatenation, no backticks. Perms are dark.
// ---------------------------------------------------------------------------
const express = require('express');
const { pool } = require('../db');
const geo = require('../utils/geocode');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

var ACCOUNT_TYPES = ['automotive', 'commercial', 'residential'];

function cleanType(t) {
  t = String(t == null ? '' : t).trim().toLowerCase();
  return ACCOUNT_TYPES.indexOf(t) === -1 ? null : t;
}
function cleanState(s) {
  s = String(s == null ? '' : s).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}
// Match "Orange", "Orange County", "orange  county" to one key.
function normCounty(c) {
  return String(c == null ? '' : c).trim().toUpperCase()
    .replace(/\s+(COUNTY|PARISH|BOROUGH)$/, '').replace(/\s+/g, ' ').trim();
}
function cleanRate(r) {
  var n = parseFloat(r);
  if (isNaN(n) || n < 0) n = 0;
  if (n > 100) n = 100;
  return Math.round(n * 1000) / 1000;
}

async function getEnabledStates() {
  try {
    var r = await pool.query("SELECT value FROM settings WHERE key = 'tax_gate_enabled'");
    var v = (r.rows[0] && r.rows[0].value) || '';
    if (String(v).trim().toLowerCase() === 'all') return 'all';
    var arr = [];
    try { arr = JSON.parse(v); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    return arr.map(cleanState).filter(Boolean);
  } catch (e) { return []; }
}

// ---- Setup: taxability rules (state x account type) ------------------------
router.get('/rules', requireAuth, requirePermission('view_tax_setup'), async function (req, res) {
  try {
    var st = await pool.query("SELECT DISTINCT state FROM cities WHERE state IS NOT NULL AND TRIM(state) <> '' ORDER BY state");
    var rules = await pool.query('SELECT state, account_type, tax_parts, tax_labor FROM tax_rules');
    var enabled = await getEnabledStates();
    res.json({
      account_types: ACCOUNT_TYPES,
      states: st.rows.map(function (r) { return String(r.state).trim(); }),
      rules: rules.rows,
      enabled_states: enabled === 'all' ? 'all' : enabled
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load tax rules' }); }
});

router.put('/rules', requireAuth, requirePermission('manage_tax_setup'), async function (req, res) {
  var rows = Array.isArray((req.body || {}).rules) ? req.body.rules : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (var i = 0; i < rows.length; i++) {
      var state = cleanState(rows[i].state);
      var type = cleanType(rows[i].account_type);
      if (!state || !type) continue;
      await client.query(
        'INSERT INTO tax_rules (state, account_type, tax_parts, tax_labor, updated_by, updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,NOW()) ' +
        'ON CONFLICT (state, account_type) DO UPDATE SET tax_parts = EXCLUDED.tax_parts, ' +
        'tax_labor = EXCLUDED.tax_labor, updated_by = EXCLUDED.updated_by, updated_at = NOW()',
        [state, type, rows[i].tax_parts === true, rows[i].tax_labor === true, req.user.id]
      );
    }
    await client.query('COMMIT'); client.release();
    res.json({ ok: true, saved: rows.length });
  } catch (err) { await client.query('ROLLBACK').catch(function () {}); client.release(); console.error(err); res.status(500).json({ error: 'Failed to save tax rules' }); }
});

// ---- Setup: the dark switch (which states the gate is live in) --------------
router.put('/enabled-states', requireAuth, requirePermission('manage_tax_setup'), async function (req, res) {
  try {
    var body = req.body || {};
    var value;
    if (String(body.states) === 'all' || body.all === true) value = 'all';
    else {
      var arr = Array.isArray(body.states) ? body.states.map(cleanState).filter(Boolean) : [];
      value = JSON.stringify(arr);
    }
    await pool.query("INSERT INTO settings (key, value, updated_at) VALUES ('tax_gate_enabled', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [value]);
    try { await logAudit({ entity_type: 'settings', entity_id: 0, action: 'tax_gate_enabled', user_id: req.user.id, user_name: req.user.name, details: { value: value } }); } catch (e) {}
    res.json({ ok: true, value: value });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update enabled states' }); }
});

// ---- Setup: county rates ---------------------------------------------------
router.get('/counties', requireAuth, requirePermission('view_tax_setup'), async function (req, res) {
  try {
    var r = await pool.query('SELECT id, state, county, rate FROM tax_counties ORDER BY state, county');
    res.json({ counties: r.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load county rates' }); }
});

// Bulk upsert from the grid or a CSV import (parsed to JSON client-side).
// Body: { counties: [{state, county, rate}] }.
router.put('/counties', requireAuth, requirePermission('manage_tax_setup'), async function (req, res) {
  var rows = Array.isArray((req.body || {}).counties) ? req.body.counties : [];
  const client = await pool.connect();
  var saved = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    for (var i = 0; i < rows.length; i++) {
      var state = cleanState(rows[i].state);
      var county = normCounty(rows[i].county);
      if (!state || !county) { skipped++; continue; }
      await client.query(
        'INSERT INTO tax_counties (state, county, rate, updated_by, updated_at) ' +
        'VALUES ($1,$2,$3,$4,NOW()) ' +
        'ON CONFLICT (state, county) DO UPDATE SET rate = EXCLUDED.rate, updated_by = EXCLUDED.updated_by, updated_at = NOW()',
        [state, county, cleanRate(rows[i].rate), req.user.id]
      );
      saved++;
    }
    await client.query('COMMIT'); client.release();
    res.json({ ok: true, saved: saved, skipped: skipped });
  } catch (err) { await client.query('ROLLBACK').catch(function () {}); client.release(); console.error(err); res.status(500).json({ error: 'Failed to save county rates' }); }
});

router.delete('/counties/:id', requireAuth, requirePermission('manage_tax_setup'), async function (req, res) {
  try { await pool.query('DELETE FROM tax_counties WHERE id = $1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete county rate' }); }
});

// County list for a state, for the manual picker fallback.
router.get('/counties/state/:state', requireAuth, requirePermission('view_invoices'), async function (req, res) {
  try {
    var state = cleanState(req.params.state);
    if (!state) return res.json({ counties: [] });
    var r = await pool.query('SELECT county, rate FROM tax_counties WHERE state = $1 ORDER BY county', [state]);
    res.json({ counties: r.rows });
  } catch (err) { console.error(err); res.json({ counties: [] }); }
});

// ---- Resolve a service address to jurisdiction + rate + taxability ---------
// Used by the invoice/quote editor. NEVER blocks: on any miss it returns
// resolved:false and whatever it did find, so the editor shows a county picker.
router.get('/resolve', requireAuth, requirePermission('view_invoices'), async function (req, res) {
  try {
    var type = cleanType(req.query.account_type);
    var address = String(req.query.address || '').trim();
    var csz = String(req.query.city_state_zip || '').trim();
    var zip = String(req.query.zip || '').trim();
    var state = cleanState(req.query.state);
    var county = null;

    if (address || csz || zip) {
      var g = null;
      try { g = await geo.geocode({ address: address, city_state_zip: csz, zip: zip }); } catch (e) { g = null; }
      if (g) {
        if (g.county) county = normCounty(g.county);
        if (g.admin_state && cleanState(g.admin_state)) state = cleanState(g.admin_state);
      }
    }

    var out = { resolved: false, county: null, county_display: null, state: state || null, rate: null, tax_parts: null, tax_labor: null, gate_on: false };
    var enabled = await getEnabledStates();
    out.gate_on = state ? (enabled === 'all' || (Array.isArray(enabled) && enabled.indexOf(state) !== -1)) : false;

    if (state && type) {
      var tr = await pool.query('SELECT tax_parts, tax_labor FROM tax_rules WHERE state = $1 AND account_type = $2', [state, type]);
      if (tr.rows.length) { out.tax_parts = tr.rows[0].tax_parts === true; out.tax_labor = tr.rows[0].tax_labor === true; }
    }
    if (state && county) {
      var cr = await pool.query('SELECT county, rate FROM tax_counties WHERE state = $1', [state]);
      for (var i = 0; i < cr.rows.length; i++) {
        if (normCounty(cr.rows[i].county) === county) { out.rate = parseFloat(cr.rows[i].rate); out.county = county; out.county_display = cr.rows[i].county; break; }
      }
      if (out.county == null) { out.county = county; out.county_display = county; }
    }
    out.resolved = !!(out.rate != null && out.tax_parts != null);
    res.json(out);
  } catch (err) { console.error(err); res.json({ resolved: false }); }
});

// ---- File-ready breakdown report -------------------------------------------
// accrual: recognised on invoice_date for any billed (non-draft, non-canceled)
// invoice. cash: recognised on completed_at for paid invoices only. Refunds are
// netted by refund date; exempt sales are broken out.
router.get('/report', requireAuth, requirePermission('view_tax_report'), async function (req, res) {
  try {
    var start = String(req.query.start || '').slice(0, 10);
    var end = String(req.query.end || '').slice(0, 10);
    var basis = String(req.query.basis || 'accrual').toLowerCase() === 'cash' ? 'cash' : 'accrual';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'start and end dates (YYYY-MM-DD) are required' });
    }
    var dateCol = basis === 'cash' ? 'completed_at' : 'invoice_date';
    var statusWhere = basis === 'cash' ? "status = 'paid'" : "status NOT IN ('draft','canceled')";
    var CTY = "COALESCE(NULLIF(TRIM(tax_county),''), NULLIF(TRIM(city_code),''), '(none)')";
    var ST = "COALESCE(NULLIF(TRIM(tax_state),''), '?')";

    var inv = await pool.query(
      'SELECT ' + ST + ' AS st, ' + CTY + ' AS cty, ' +
      '  SUM(CASE WHEN tax_exempt THEN 0 ELSE tax_amount END) AS tax_gross, ' +
      '  SUM(CASE WHEN tax_exempt THEN subtotal ELSE 0 END) AS exempt_sales, ' +
      '  SUM(CASE WHEN tax_exempt THEN 0 ELSE subtotal END) AS taxable_sales, ' +
      '  COUNT(*) AS invoices ' +
      'FROM invoices WHERE ' + statusWhere + ' AND ' + dateCol + '::date >= $1 AND ' + dateCol + '::date <= $2 ' +
      'GROUP BY 1,2', [start, end]);

    var li = await pool.query(
      "SELECT COALESCE(NULLIF(TRIM(i.tax_county),''), NULLIF(TRIM(i.city_code),''), '(none)') AS cty, " +
      "  COALESCE(NULLIF(TRIM(i.tax_state),''), '?') AS st, " +
      "  COALESCE(SUM(CASE WHEN l.line_type <> 'labor' AND l.taxable THEN l.quantity*l.unit_price ELSE 0 END),0) AS taxable_parts, " +
      "  COALESCE(SUM(CASE WHEN l.line_type = 'labor' AND l.taxable THEN l.quantity*l.unit_price ELSE 0 END),0) AS taxable_labor " +
      'FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id ' +
      'WHERE i.' + statusWhere + ' AND i.' + dateCol + '::date >= $1 AND i.' + dateCol + '::date <= $2 ' +
      'GROUP BY 1,2', [start, end]);

    // Refund netting is best-effort: if the refund schema differs, report gross.
    var refunds = { rows: [] };
    var refunds_netted = true;
    try {
      refunds = await pool.query(
        "SELECT COALESCE(NULLIF(TRIM(i.tax_state),''), '?') AS st, " +
        "  COALESCE(NULLIF(TRIM(i.tax_county),''), NULLIF(TRIM(i.city_code),''), '(none)') AS cty, " +
        '  COALESCE(SUM(r.tax_refunded),0) AS tax_refunded ' +
        'FROM invoice_refunds r JOIN invoices i ON i.id = r.invoice_id ' +
        "WHERE r.status <> 'void' AND r.created_at::date >= $1 AND r.created_at::date <= $2 " +
        'GROUP BY 1,2', [start, end]);
    } catch (e) { refunds_netted = false; refunds = { rows: [] }; }

    var by = {};
    function cell(st, cty) {
      var k = st + '|' + cty;
      if (!by[k]) by[k] = { state: st, county: cty, tax_gross: 0, tax_refunded: 0, tax_net: 0, taxable_parts: 0, taxable_labor: 0, taxable_sales: 0, exempt_sales: 0, invoices: 0 };
      return by[k];
    }
    inv.rows.forEach(function (r) { var c = cell(r.st, r.cty); c.tax_gross = parseFloat(r.tax_gross) || 0; c.exempt_sales = parseFloat(r.exempt_sales) || 0; c.taxable_sales = parseFloat(r.taxable_sales) || 0; c.invoices = parseInt(r.invoices, 10) || 0; });
    li.rows.forEach(function (r) { var c = cell(r.st, r.cty); c.taxable_parts = parseFloat(r.taxable_parts) || 0; c.taxable_labor = parseFloat(r.taxable_labor) || 0; });
    refunds.rows.forEach(function (r) { var c = cell(r.st, r.cty); c.tax_refunded = parseFloat(r.tax_refunded) || 0; });

    var out = Object.keys(by).map(function (k) { by[k].tax_net = Math.round((by[k].tax_gross - by[k].tax_refunded) * 100) / 100; return by[k]; });
    out.sort(function (a, b) { return (a.state + a.county).localeCompare(b.state + b.county); });
    var totals = out.reduce(function (t, r) {
      t.tax_gross += r.tax_gross; t.tax_refunded += r.tax_refunded; t.tax_net += r.tax_net;
      t.taxable_parts += r.taxable_parts; t.taxable_labor += r.taxable_labor;
      t.taxable_sales += r.taxable_sales; t.exempt_sales += r.exempt_sales; t.invoices += r.invoices;
      return t;
    }, { tax_gross: 0, tax_refunded: 0, tax_net: 0, taxable_parts: 0, taxable_labor: 0, taxable_sales: 0, exempt_sales: 0, invoices: 0 });

    res.json({ start: start, end: end, basis: basis, refunds_netted: refunds_netted, rows: out, totals: totals });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to build tax report' }); }
});

module.exports = router;
