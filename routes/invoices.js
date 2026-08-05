const express = require('express');
const https = require('https');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const notify = require('../utils/notify');
const push = require('../utils/push');
const r2 = require('../utils/r2');
const { buildInvoicePdf } = require('../utils/invoicePdf');
const { buildDisputePdf } = require('../utils/disputePdf');
const square = require('../utils/square');
const { notifyTaskAssigned, notifyTaskCc } = require('../jobs/taskReminders');

const router = express.Router();

// Statuses in which the money is settled and the invoice is frozen. Changing
// what a customer was charged after this point goes through routes/refunds.js
// so there is a record, not through a silent edit.
var LOCKED_STATUSES = ['paid', 'partially_refunded', 'refunded'];

function sanitizeName(n) {
  return String(n || 'photo').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'photo';
}

// Persist a scanned driver-license/ID photo to private R2 storage and record it on
// the invoice. Deliberately kept OUT of invoice_photos so it never lands on the
// customer copy; only managers can retrieve it (chargeback disputes). Replaces any
// prior image for the invoice. Never throws for expected conditions — returns
// { saved, reason } so a bad/oversized image can't fail the whole invoice save.
async function storeIdImage(invoiceId, dataUrl, userId) {
  if (!dataUrl) return { saved: false, reason: 'no_image' };
  if (!r2.configured()) return { saved: false, reason: 'storage_unconfigured' };
  const m = /^data:([^;]+);base64,(.*)$/i.exec(String(dataUrl));
  if (!m) return { saved: false, reason: 'bad_format' };
  const mime = m[1];
  if (!/^image\//i.test(mime)) return { saved: false, reason: 'not_image' };
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch (e) { return { saved: false, reason: 'decode_failed' }; }
  if (!buf || !buf.length) return { saved: false, reason: 'empty' };
  if (buf.length > 12 * 1024 * 1024) return { saved: false, reason: 'too_large' };
  const ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
  const key = 'invoices/' + invoiceId + '/id/' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  let oldKey = null;
  try {
    const prev = await pool.query('SELECT id_image_r2_key FROM invoices WHERE id = $1', [invoiceId]);
    oldKey = prev.rows[0] && prev.rows[0].id_image_r2_key;
    await r2.putObject(key, buf, mime);
    await pool.query(
      'UPDATE invoices SET id_image_r2_key=$1, id_image_mime=$2, id_image_uploaded_at=NOW(), id_image_uploaded_by=$3 WHERE id=$4',
      [key, mime, userId || null, invoiceId]
    );
  } catch (e) {
    console.error('storeIdImage failed:', e.message);
    return { saved: false, reason: 'storage_error' };
  }
  if (oldKey && oldKey !== key) { try { await r2.deleteObject(oldKey); } catch (e) {} }
  return { saved: true };
}

// ---- helpers ---------------------------------------------------------------

async function getSetting(key, fallback) {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : fallback;
  } catch (e) { return fallback; }
}

// The raw Square payload can carry the buyer's email if they took a digital
// receipt, and internal risk-evaluation fields. The client never needs either,
// so it is stripped on the way out rather than filtered in the view layer.
function scrubPaymentRow(row) {
  if (!row) return null;
  const out = Object.assign({}, row);
  delete out.raw_payment;
  delete out.state_nonce;
  return out;
}

async function generateInvoiceNumber(cityCode) {
  // Per-city leading number: each city has an invoice_prefix (e.g. 1 -> 1xxxxx).
  let prefix = null;
  if (cityCode) {
    try {
      const cr = await pool.query('SELECT invoice_prefix FROM cities WHERE code = $1', [String(cityCode).trim().toUpperCase()]);
      if (cr.rows[0] && cr.rows[0].invoice_prefix != null) prefix = parseInt(cr.rows[0].invoice_prefix, 10);
    } catch (e) {}
  }
  if (prefix != null && prefix > 0) {
    const lo = prefix * 100000;      // e.g. prefix 1 -> 100000
    const hi = lo + 99999;           // 199999
    const { rows } = await pool.query('SELECT MAX(invoice_number) AS maxn FROM invoices WHERE invoice_number >= $1 AND invoice_number <= $2', [lo, hi]);
    const maxn = rows[0] && rows[0].maxn != null ? parseInt(rows[0].maxn, 10) : null;
    return maxn != null ? (maxn + 1) : (lo + 1);   // first invoice for the city = prefix00001
  }
  // Fallback (no prefix set): number within the city's own band so a prefix-less
  // city doesn't collide with other cities' sequences. Only a truly city-less
  // invoice falls back to the legacy global sequence.
  const startRaw = await getSetting('invoice_start_number', '100001');
  const start = parseInt(startRaw, 10) || 100001;
  let rows;
  if (cityCode) {
    ({ rows } = await pool.query('SELECT MAX(invoice_number) AS maxn FROM invoices WHERE city_code = $1', [String(cityCode).trim().toUpperCase()]));
  } else {
    ({ rows } = await pool.query('SELECT MAX(invoice_number) AS maxn FROM invoices'));
  }
  const maxn = rows[0] && rows[0].maxn != null ? parseInt(rows[0].maxn, 10) : null;
  return maxn != null ? (maxn + 1) : start;
}

// ---------------------------------------------------------------------------
// Card surcharge.
//
// The customer picks Cash or Card at close-out. Card adds a percentage of
// (subtotal + sales tax).
//
// WARNING: the surcharge is deliberately NOT a line item and never enters
// labor, parts, subtotal or the taxable base. Those are the figures a human
// reads off the close-out card and types into Pulsar, and the royalty CSV is
// downloaded FROM Pulsar. A surcharge that leaks into any of them pays a
// royalty and an ad fee on money that is not sales. Keeping it out of the
// taxable base is also what guarantees sales tax does not move on a Card job.
//
// Rounded to the cent HERE and nowhere else, so the number the customer signs,
// the number sent to Square, and the number stored are byte-identical.
function computeSurcharge(pay_method, subtotal, tax_amount, surcharge_rate) {
  if (String(pay_method || '') !== 'card') return 0;
  const rate = parseFloat(surcharge_rate) || 0;
  if (!(rate > 0)) return 0;
  const base = (parseFloat(subtotal) || 0) + (parseFloat(tax_amount) || 0);
  if (!(base > 0)) return 0;
  return Math.round(base * rate) / 100;
}

function computeTotals(line_items, tax_rate, tip_amount, tax_exempt, pay_method, surcharge_rate) {
  const rate = parseFloat(tax_rate) || 0;
  let labor = 0, parts = 0, taxable = 0, parts_cost = 0, cogs_incomplete = false;
  (line_items || []).forEach(function (it) {
    // Skip exactly what insertLineItems skips. A row with no description is
    // dropped on the way into the table, so counting it here would store totals
    // the persisted line items cannot reproduce.
    if (!it || !it.description) return;
    const qty = parseFloat(it.quantity) || 0;
    const ext = qty * (parseFloat(it.unit_price) || 0);
    if (it.line_type === 'labor') labor += ext; else parts += ext;
    if (it.taxable) taxable += ext;
    // COGS is parts only — Pulsar takes labor as its own separate field, so
    // rolling labor in here would double-count it on their side.
    if (it.line_type !== 'labor') {
      if (it.cost_unknown === true) cogs_incomplete = true;
      else parts_cost += qty * (parseFloat(it.unit_cost) || 0);
    }
  });
  const subtotal = labor + parts;
  const tax_amount = tax_exempt ? 0 : (taxable * rate / 100);
  const tip = parseFloat(tip_amount) || 0;
  // Surcharge sits between tax and tip: after tax because it is charged on the
  // taxed total, before tip because a tip is added later inside Square and must
  // not be surcharged.
  const surcharge = computeSurcharge(pay_method, subtotal, tax_amount, surcharge_rate);
  const grand_total = subtotal + tax_amount + surcharge + tip;
  return {
    labor: labor, parts: parts, subtotal: subtotal, tax_amount: tax_amount, tip: tip, grand_total: grand_total,
    surcharge: surcharge, surcharge_rate: (surcharge > 0 ? (parseFloat(surcharge_rate) || 0) : 0),
    parts_cost: parts_cost, cogs_incomplete: cogs_incomplete,
    // What a human types into Pulsar. Sales only: no surcharge, no tip.
    pulsar_total: subtotal + tax_amount
  };
}

// The company-wide surcharge rate, or 0 when the master switch is off. Read
// straight from settings on every save rather than cached, because a stale rate
// silently charges the wrong amount and nobody would notice.
async function surchargeRate() {
  try {
    const r = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('invoice_surcharge_enabled', 'invoice_surcharge_rate')"
    );
    const map = {};
    r.rows.forEach(function (row) { map[row.key] = row.value; });
    if (String(map.invoice_surcharge_enabled || '') !== 'true') return 0;
    const rate = parseFloat(map.invoice_surcharge_rate);
    // Clamped to the network ceiling. A typo of 25 must not charge 25%.
    if (!(rate > 0)) return 0;
    return Math.min(rate, 3);
  } catch (e) {
    // A settings read that fails must never surcharge. Zero is the safe answer.
    return 0;
  }
}

// 'cash' | 'card' | null. Anything else is treated as "not asked yet".
function normalizePayMethod(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'cash' || s === 'card') return s;
  return null;
}

// ---------------------------------------------------------------------------
// Customer-facing boundary.
//
// COGS is internal. It must never reach the printed invoice, the emailed PDF, or
// the Square dispute packet. Both PDF builders read only named fields today, so
// nothing leaks — but "nothing renders it right now" is a property of code that
// someone will edit later, not a guarantee. Strip the cost out of the data on the
// way to any customer-facing renderer, so the guarantee holds even if a future
// change starts iterating over whatever it is handed.
const LINE_COST_FIELDS = ['unit_cost', 'cost_unknown', 'cost_unknown_reason', 'cost_source'];
const INVOICE_COST_FIELDS = ['parts_cost_total', 'cogs_incomplete', 'cogs'];

function customerSafeInvoice(inv) {
  const out = Object.assign({}, inv || {});
  INVOICE_COST_FIELDS.forEach(function (k) { delete out[k]; });
  return out;
}

function customerSafeLines(items) {
  return (items || []).map(function (it) {
    const out = Object.assign({}, it || {});
    LINE_COST_FIELDS.forEach(function (k) { delete out[k]; });
    return out;
  });
}

// "No cost available" is the escape hatch on the close-out gate, so it is also
// the way to defeat it. Every override is logged with its reason — a tech ticking
// the box on every line shows up here as a pattern rather than disappearing.
async function auditCostOverrides(line_items, invoiceId, invoiceNumber, user) {
  const overrides = (line_items || []).filter(function (it) {
    return it && it.description && it.line_type !== 'labor' && it.cost_unknown === true;
  });
  if (!overrides.length) return;
  try {
    await logAudit({
      entity_type: 'invoice', entity_id: invoiceId, entity_number: String(invoiceNumber || ''),
      action: 'cogs cost override', user_id: user.id, user_name: user.name,
      details: {
        count: overrides.length,
        lines: overrides.map(function (it) {
          return { description: String(it.description), reason: String(it.cost_unknown_reason || '').trim() || null };
        })
      }
    });
  } catch (e) {}
}

// Part lines that can't produce a COGS figure yet: no cost captured and not
// explicitly marked "no cost available". Returned to the client so it can put up
// the fix-it modal instead of a bare error string.
function missingCostLines(line_items) {
  const out = [];
  (line_items || []).forEach(function (it, i) {
    if (!it || !it.description) return;
    if (it.line_type === 'labor') return;
    if (it.cost_unknown === true) return;
    const hasCost = it.unit_cost != null && it.unit_cost !== '' && !isNaN(parseFloat(it.unit_cost));
    if (hasCost) return;
    out.push({
      index: i,
      description: String(it.description),
      item_number: it.item_number || null,
      quantity: parseFloat(it.quantity) || 1,
      unit_price: parseFloat(it.unit_price) || 0,
      from_catalog: !!it.part_id
    });
  });
  return out;
}

function httpsGetJson(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON from upstream')); }
      });
    }).on('error', reject);
  });
}

function anthropicVision(dataUrl, instruction) {
  return new Promise(function (resolve, reject) {
    let media = 'image/jpeg', b64 = dataUrl;
    const m = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl || '');
    if (m) { media = m[1]; b64 = m[2]; }
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: b64 } },
          { type: 'text', text: instruction }
        ]
      }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Failed to parse Anthropic response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, function () { req.destroy(new Error('ID scan timed out. Please try again.')); });
    req.write(body);
    req.end();
  });
}

// Team-wide invoice visibility. Admins and managers have always had it; as of
// 2026-08-05 locksmith coordinators do too (Tony's call). The role coordinates
// the locksmiths and needs the whole team's invoices, not just its own. This gate
// also governs the manager-level invoice surfaces (ID-on-file image, dispute
// packet, Square reconciliation) and lets the holder act on any invoice they can
// also WRITE, so a coordinator only reaches those once they hold view_invoices or
// edit_invoice in Roles & Access, which is the separate go-live toggle.
function canSeeAll(role) { return role === 'admin' || role === 'manager' || role === 'locksmith_coordinator'; }

// ---- config / accounts -----------------------------------------------------

// Accounts that are flagged to appear in the invoice dropdown, with their config.
router.get('/accounts', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, account_number, invoice_notes, auto_line_items, agreement_text FROM vendors WHERE show_in_invoice = true ORDER BY name ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoice accounts' });
  }
});

// Default agreement text + start number (for the form + setup screen).
router.get('/config', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const agreement = await getSetting('invoice_default_agreement', '');
    let pay_types = [];
    try { pay_types = JSON.parse(await getSetting('invoice_pay_types', '[]')); } catch (e) { pay_types = []; }
    if (!Array.isArray(pay_types) || !pay_types.length) pay_types = ['Cash', 'Check', 'Visa', 'Mastercard', 'Amex', 'Discover', 'Debit', 'Motor Club', 'Account / Invoice', 'Other'];
    // Nova's pay types are finer-grained than Pulsar's (four card brands where
    // Pulsar wants one "Credit Card"), so the close-out card copies the mapped
    // label instead of making the tech translate in their head. Unmapped types
    // fall through to their own name.
    let pulsar_pay_map = {};
    try { pulsar_pay_map = JSON.parse(await getSetting('pulsar_pay_type_map', '{}')) || {}; } catch (e) { pulsar_pay_map = {}; }
    if (typeof pulsar_pay_map !== 'object' || Array.isArray(pulsar_pay_map)) pulsar_pay_map = {};
    const hc = await pool.query('SELECT home_city FROM users WHERE id = $1', [req.user.id]);
    // The surcharge rate is shipped to the client for DISPLAY only. Every stored
    // figure is computed on the server; a client that posts its own number is
    // ignored. See computeSurcharge.
    const sur_rate = await surchargeRate();
    res.json({
      default_agreement: agreement, pay_types: pay_types, pulsar_pay_map: pulsar_pay_map,
      home_city: (hc.rows[0] && hc.rows[0].home_city) || null,
      surcharge_enabled: sur_rate > 0, surcharge_rate: sur_rate
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch invoice config' });
  }
});

// ---- smart inputs ----------------------------------------------------------

// Save the editable pay-type list (managers/admin).
router.post('/pay-types', requireAuth, requirePermission('manage_invoice_setup'), async (req, res) => {
  const { pay_types } = req.body;
  if (!Array.isArray(pay_types)) return res.status(400).json({ error: 'pay_types must be an array' });
  const clean = pay_types.map(function (p) { return String(p == null ? '' : p).trim(); }).filter(Boolean);
  try {
    await pool.query("INSERT INTO settings (key, value, updated_at) VALUES ('invoice_pay_types', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(clean)]);
    res.json({ ok: true, pay_types: clean });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save pay types' }); }
});

// Set Cash or Card on one invoice and re-price it.
//
// This exists so the close-out popup does not have to round-trip the whole
// invoice form just to record the customer's answer. It touches ONLY
// pay_method, surcharge_amount, surcharge_rate and grand_total, and it rebuilds
// them from the invoice's own persisted line items rather than anything in the
// request body, so it can never move labor, parts, subtotal, tax or the tip.
//
// Refused once the invoice is locked: changing the surcharge after the money is
// taken would rewrite what the customer was charged. Issue a refund instead.
router.post('/:id/pay-method', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  const method = normalizePayMethod((req.body || {}).pay_method);
  if (!method) return res.status(400).json({ error: 'Pick Cash or Card.' });
  try {
    const r = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    const inv = r.rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!canSeeAll(req.user.role) && inv.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (LOCKED_STATUSES.indexOf(inv.status) !== -1) {
      return res.status(409).json({
        error: 'Invoice #' + inv.invoice_number + ' is already settled, so how it was paid can no longer change the amount. Use Issue Refund.'
      });
    }
    const _existingRate = parseFloat(inv.surcharge_rate) || 0;
    const sur_rate = _existingRate > 0 ? _existingRate : await surchargeRate();
    const items = (await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1', [inv.id])).rows;
    const t = computeTotals(items, inv.tax_rate, inv.tip_amount, inv.tax_exempt === true, method, sur_rate);
    const upd = await pool.query(
      'UPDATE invoices SET pay_method = $1, surcharge_amount = $2, surcharge_rate = $3, grand_total = $4, updated_at = NOW() ' +
      'WHERE id = $5 RETURNING *',
      [method, t.surcharge, t.surcharge_rate, t.grand_total, inv.id]
    );
    try {
      await logAudit({
        entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number),
        action: 'updated', user_id: req.user.id, user_name: req.user.name,
        details: { pay_method: method, surcharge: t.surcharge, grand_total: t.grand_total }
      });
    } catch (e) {}
    res.json(customerSafeInvoice(upd.rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save the payment method' }); }
});

// Save the card surcharge policy (managers/admin). One company-wide rate.
//
// The rate is CLAMPED to 0.01-3. Above 3 breaks the card network cap; a zero or
// negative rate would read as "on but free", which is a confusing state, so
// turning it off is done with the enabled flag and nothing else.
router.post('/surcharge', requireAuth, requirePermission('manage_invoice_setup'), async (req, res) => {
  const b = req.body || {};
  const enabled = b.enabled === true || b.enabled === 'true';
  let rate = parseFloat(b.rate);
  if (enabled) {
    if (!(rate > 0)) return res.status(400).json({ error: 'Enter a surcharge percentage greater than 0.' });
    if (rate > 3) return res.status(400).json({ error: 'A card surcharge cannot be more than 3%. That is the card network cap, not a Nova limit.' });
  }
  if (!(rate > 0)) rate = 0;
  rate = Math.round(rate * 100) / 100;
  try {
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('invoice_surcharge_enabled', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [enabled ? 'true' : 'false']
    );
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('invoice_surcharge_rate', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [String(rate)]
    );
    try {
      await logAudit({
        entity_type: 'settings', entity_id: 0, entity_number: 'invoice_surcharge',
        action: 'updated', user_id: req.user.id, user_name: req.user.name,
        details: { enabled: enabled, rate: rate }
      });
    } catch (e) {}
    res.json({ ok: true, enabled: enabled, rate: rate });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save the surcharge setting' }); }
});

// Save the Nova pay type -> Pulsar label map (managers/admin). Blank values are
// dropped so an unmapped type just copies its own name.
router.post('/pulsar-pay-map', requireAuth, requirePermission('manage_invoice_setup'), async (req, res) => {
  const map = req.body && req.body.map;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return res.status(400).json({ error: 'map must be an object' });
  const clean = {};
  Object.keys(map).forEach(function (k) {
    const key = String(k == null ? '' : k).trim();
    const val = String(map[k] == null ? '' : map[k]).trim();
    if (key && val) clean[key] = val;
  });
  try {
    await pool.query("INSERT INTO settings (key, value, updated_at) VALUES ('pulsar_pay_type_map', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(clean)]);
    res.json({ ok: true, map: clean });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save the Pulsar pay type map' }); }
});

// ---- Square payment collection --------------------------------------------
// See utils/square.js for how the handoff works end to end. These routes are
// registered ahead of GET /:id so 'square-config' is never read as an id.

// Which Square location each city's money lands in. Deliberately has no default:
// an unmapped city REFUSES to collect rather than guessing, because a payment in
// the wrong Square location is silently wrong in deposits, royalty and the
// per-city P&L and nobody notices for a month.
async function squareLocationMap() {
  try { return JSON.parse(await getSetting('square_location_map', '{}')) || {}; } catch (e) { return {}; }
}

router.get('/square-config', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const map = await squareLocationMap();
    const cities = await pool.query('SELECT code, name FROM cities WHERE active = true ORDER BY name');
    const out = {
      configured: square.configured(),
      environment: process.env.SQUARE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production',
      callback_url: square.callbackUrl(),
      application_id_tail: (process.env.SQUARE_APPLICATION_ID || '').slice(-4),
      webhook_key_set: !!process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      location_map: map,
      cities: cities.rows
    };
    // Only a setup user needs the live Square location list, and it costs an API
    // call, so it is not on the read path every tech hits.
    if (square.configured() && req.query.locations === '1') {
      try {
        const locs = await square.sq('GET', '/v2/locations');
        out.square_locations = (locs.locations || []).map(function (l) {
          return { id: l.id, name: l.name, status: l.status };
        });
      } catch (e) {
        out.square_locations_error = e.message;
      }
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load the Square config' });
  }
});

router.put('/square-config', requireAuth, requirePermission('manage_invoice_setup'), async (req, res) => {
  const map = req.body && req.body.location_map;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return res.status(400).json({ error: 'location_map must be an object' });
  const clean = {};
  Object.keys(map).forEach(function (k) {
    const key = String(k == null ? '' : k).trim().toUpperCase();
    const val = String(map[k] == null ? '' : map[k]).trim();
    if (key && val) clean[key] = val;
  });
  try {
    // Validate every id against the live Square location list before saving. A
    // wrong-but-plausible location id is otherwise invisible until a tech is
    // standing in front of a customer and Square bounces the payment, which is
    // exactly how this went wrong the first time.
    if (square.configured() && Object.keys(clean).length) {
      let known = null;
      try {
        const locs = await square.sq('GET', '/v2/locations');
        known = {};
        (locs.locations || []).forEach(function (l) { known[l.id] = l; });
      } catch (e) { known = null; }
      if (known) {
        const bad = [];
        Object.keys(clean).forEach(function (code) {
          const l = known[clean[code]];
          if (!l) bad.push(code + ' points at ' + clean[code] + ', which is not a location on this Square account');
          else if (l.status && l.status !== 'ACTIVE') bad.push(code + ' points at ' + (l.name || l.id) + ', which is ' + String(l.status).toLowerCase() + ' in Square');
        });
        if (bad.length) return res.status(400).json({ error: 'Not saved. ' + bad.join('. ') + '.' });
      }
    }
    await pool.query("INSERT INTO settings (key, value, updated_at) VALUES ('square_location_map', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(clean)]);
    res.json({ ok: true, location_map: clean });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save the Square location map' });
  }
});

// Daily reconciliation. Two columns matter: invoices marked paid with no Square
// payment behind them, and Square payments with no invoice at all.
router.get('/square-reconciliation', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  if (!canSeeAll(req.user.role)) return res.status(403).json({ error: 'Access denied' });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : null;
  try {
    const params = day ? [day] : [];
    const dayWhere = day ? 'i.invoice_date = $1' : "i.invoice_date >= CURRENT_DATE - INTERVAL '1 day'";
    const paidNoSquare = await pool.query(
      'SELECT i.id, i.invoice_number, i.grand_total, i.city_code, i.locksmith_name, i.invoice_date ' +
      'FROM invoices i LEFT JOIN invoice_payments p ON p.invoice_id = i.id AND p.status = \'reconciled\' ' +
      "WHERE i.status = 'paid' AND p.id IS NULL AND " + dayWhere + ' ORDER BY i.id DESC LIMIT 200',
      params
    );
    const stuck = await pool.query(
      "SELECT p.*, i.invoice_number FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id " +
      "WHERE p.status IN ('offline_pending','mismatch','returned') ORDER BY p.id DESC LIMIT 200"
    );
    const orphans = await pool.query(
      'SELECT id, square_payment_id, location_id, amount_cents, note, team_member_id, taken_at ' +
      'FROM square_orphan_payments WHERE resolved = false ORDER BY id DESC LIMIT 200'
    );
    const mism = await pool.query(
      'SELECT p.id, p.invoice_id, i.invoice_number, p.square_team_member_id ' +
      'FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id ' +
      "WHERE p.status = 'reconciled' AND p.team_member_mismatch = true ORDER BY p.id DESC LIMIT 100"
    );
    res.json({
      paid_no_square: paidNoSquare.rows,
      stuck: stuck.rows,
      orphans: orphans.rows,
      wrong_tech: mism.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build the reconciliation report' });
  }
});

// Scan VIN from a photo: AI reads the 17-character VIN off the plate/sticker/barcode.
router.post('/scan-vin', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided.' });
  const instruction = 'This image shows a vehicle VIN (dash, door-jamb sticker, or a barcode label). Find the 17-character Vehicle Identification Number and respond with ONLY a JSON object: {"vin":""}. A VIN is exactly 17 characters of letters and digits (no I, O, or Q). If you cannot read it, return {"vin":""}.';
  try {
    const resp = await anthropicVision(image, instruction);
    let text = '';
    if (resp && Array.isArray(resp.content)) resp.content.forEach(function (b) { if (b.type === 'text') text += b.text; });
    let parsed = {};
    const jm = text.match(/\{[\s\S]*\}/);
    try { parsed = JSON.parse(jm ? jm[0] : text); } catch (e) { parsed = {}; }
    const vin = String(parsed.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    res.json({ vin: vin });
  } catch (err) {
    console.error('VIN scan failed:', err.message);
    res.status(502).json({ error: 'Could not read the VIN. Enter it manually.' });
  }
});

// VIN decode via NHTSA vPIC (free, no key). Returns year/make/model.
router.get('/decode-vin/:vin', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const vin = String(req.params.vin || '').trim();
  if (vin.length < 11) return res.status(400).json({ error: 'Enter a full VIN.' });
  try {
    const url = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/' + encodeURIComponent(vin) + '?format=json';
    const j = await httpsGetJson(url);
    const r = (j.Results && j.Results[0]) || {};
    res.json({
      year: r.ModelYear || '',
      make: r.Make ? (r.Make.charAt(0) + r.Make.slice(1).toLowerCase()) : '',
      model: r.Model || '',
      raw: { make: r.Make || '', model: r.Model || '', year: r.ModelYear || '' }
    });
  } catch (err) {
    console.error('VIN decode failed:', err.message);
    res.status(502).json({ error: 'Could not reach the VIN decoder. Enter the vehicle manually.' });
  }
});

// ID scan: extract customer fields from a photo of a license (front or back).
router.post('/scan-id', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided.' });
  const instruction = 'This is a photo of a driver license or state ID. Extract the holder information and respond with ONLY a JSON object, no prose, using these exact keys (use an empty string if a field is not present): {"customer_name":"","dl_number":"","dl_state":"","street_address":"","city":"","state":"","zip":""}. customer_name should be the full name in First Last order. dl_state and state are 2-letter codes.';
  try {
    const resp = await anthropicVision(image, instruction);
    let text = '';
    if (resp && Array.isArray(resp.content)) {
      resp.content.forEach(function (b) { if (b.type === 'text') text += b.text; });
    }
    if (!text) return res.status(502).json({ error: 'Could not read the ID. Enter details manually.' });
    let parsed = {};
    const jm = text.match(/\{[\s\S]*\}/);
    try { parsed = JSON.parse(jm ? jm[0] : text); } catch (e) { parsed = {}; }
    res.json({
      customer_name: parsed.customer_name || '',
      dl_number: parsed.dl_number || '',
      dl_state: parsed.dl_state || '',
      street_address: parsed.street_address || '',
      city: parsed.city || '',
      state: parsed.state || '',
      zip: parsed.zip || ''
    });
  } catch (err) {
    console.error('ID scan failed:', err.message);
    res.status(502).json({ error: 'Could not read the ID. Enter details manually.' });
  }
});


// Plate scan: read a license plate number + state from a photo.
router.post('/scan-plate', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided.' });
  const instruction = 'This is a photo of a vehicle license plate (tag). Read the plate and respond with ONLY a JSON object, no prose, using these exact keys (use an empty string if a field is not present): {"plate":"","state":""}. plate is the alphanumeric plate/tag number with no spaces or dashes, uppercase. state is the 2-letter code of the issuing state if it is printed on the plate. Ignore slogans, county names, sticker months, and the word the state spells out unless it is the issuing state. If you cannot read the plate, return {"plate":"","state":""}.';
  try {
    const resp = await anthropicVision(image, instruction);
    let text = '';
    if (resp && Array.isArray(resp.content)) resp.content.forEach(function (b) { if (b.type === 'text') text += b.text; });
    let parsed = {};
    const jm = text.match(/\{[\s\S]*\}/);
    try { parsed = JSON.parse(jm ? jm[0] : text); } catch (e) { parsed = {}; }
    const plate = String(parsed.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const state = String(parsed.state || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
    res.json({ plate: plate, state: state });
  } catch (err) {
    console.error('Plate scan failed:', err.message);
    res.status(502).json({ error: 'Could not read the plate. Enter it manually.' });
  }
});

// ---- parts usage report ----------------------------------------------------

// Aggregated part usage for a month (YYYY-MM). Feeds month-end ordering.
router.get('/parts-report', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const month = String(req.query.month || '').trim();
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    const now = new Date();
    let y = now.getFullYear(), mo = now.getMonth() + 1;
    if (m) { y = parseInt(m[1], 10); mo = parseInt(m[2], 10); }
    const start = y + '-' + String(mo).padStart(2, '0') + '-01';
    const ny = mo === 12 ? y + 1 : y;
    const nmo = mo === 12 ? 1 : mo + 1;
    const end = ny + '-' + String(nmo).padStart(2, '0') + '-01';
    const { rows } = await pool.query(
      "SELECT COALESCE(NULLIF(li.item_number, ''), p.item_number) AS item_number, " +
      "       li.description, p.preferred_vendor, " +
      "       SUM(li.quantity - COALESCE(rs.restocked_qty, 0)) AS total_qty, COUNT(DISTINCT inv.id) AS invoice_count, " +
      "       AVG(li.unit_price) AS avg_price " +
      "FROM invoice_line_items li " +
      "JOIN invoices inv ON inv.id = li.invoice_id " +
      "LEFT JOIN parts p ON p.id = li.part_id " +
      // A refunded part flagged restock went back on the shelf, so it must not
      // drive next month's order. A part refunded on a comeback (restock false)
      // was still consumed and stays counted.
      "LEFT JOIN ( SELECT l.invoice_line_item_id, SUM(l.quantity) AS restocked_qty " +
      "            FROM invoice_refund_lines l JOIN invoice_refunds r ON r.id = l.refund_id " +
      "            WHERE l.restock = true AND r.status IN ('approved', 'processed') " +
      "            GROUP BY l.invoice_line_item_id ) rs ON rs.invoice_line_item_id = li.id " +
      "WHERE li.line_type = 'part' AND inv.invoice_date >= $1 AND inv.invoice_date < $2 " +
      "GROUP BY COALESCE(NULLIF(li.item_number, ''), p.item_number), li.description, p.preferred_vendor " +
      "HAVING SUM(li.quantity - COALESCE(rs.restocked_qty, 0)) > 0 " +
      "ORDER BY total_qty DESC",
      [start, end]
    );
    res.json({ month: y + '-' + String(mo).padStart(2, '0'), items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build parts report' });
  }
});

// Push selected aggregated parts into the Monthly Req (running list).
router.post('/parts-report/add-to-req', requireAuth, requirePermission('manage_running'), async (req, res) => {
  const { items, city_code } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items to add.' });
  try {
    for (const it of items) {
      await pool.query(
        'INSERT INTO running_list_items (requester_id, city_code, description, quantity, unit_price, vendor_name, part_number, notes, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [req.user.id, city_code || null, it.description || 'Part', parseFloat(it.quantity) || 1, it.unit_price != null ? it.unit_price : null, it.vendor_name || null, it.item_number || null, 'From invoices parts report', 'active']
      );
    }
    res.json({ ok: true, added: items.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add to Monthly Req' });
  }
});

// ---- CRUD ------------------------------------------------------------------

router.get('/', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    let query, params;
    if (canSeeAll(req.user.role)) {
      query = 'SELECT i.*, u.name AS locksmith_name_join, COALESCE(i.city_code, v.city_code, u.home_city) AS city_code FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id LEFT JOIN vendors v ON i.account_id = v.id ORDER BY i.created_at DESC';
      params = [];
    } else {
      query = 'SELECT i.*, u.name AS locksmith_name_join, COALESCE(i.city_code, v.city_code, u.home_city) AS city_code FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id LEFT JOIN vendors v ON i.account_id = v.id WHERE i.locksmith_id = $1 ORDER BY i.created_at DESC';
      params = [req.user.id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/:id', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT i.*, u.name AS locksmith_name_join, u.phone AS locksmith_phone, u.email AS locksmith_email FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id WHERE i.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = rows[0];
    if (!canSeeAll(req.user.role) && invoice.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // Each line also reports how much of it is already refunded (or waiting on
    // approval), so the refund picker can cap what is left and nothing gets
    // given back twice.
    let items;
    try {
      items = await pool.query(
        'SELECT li.*, COALESCE(rl.refunded_qty, 0) AS refunded_qty FROM invoice_line_items li ' +
        'LEFT JOIN ( SELECT l.invoice_line_item_id, SUM(l.quantity) AS refunded_qty ' +
        '            FROM invoice_refund_lines l JOIN invoice_refunds r ON r.id = l.refund_id ' +
        "            WHERE r.status IN ('requested', 'approved', 'processed') " +
        '            GROUP BY l.invoice_line_item_id ) rl ON rl.invoice_line_item_id = li.id ' +
        'WHERE li.invoice_id = $1 ORDER BY li.position, li.id',
        [req.params.id]
      );
    } catch (e) {
      items = await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position, id', [req.params.id]);
    }
    invoice.line_items = items.rows;
    // Attach photos with short-lived presigned view URLs (if R2 is configured).
    invoice.photos = [];
    try {
      const ph = await pool.query("SELECT id, filename, mime_type, caption, show_in_print, position, r2_key FROM invoice_photos WHERE invoice_id = $1 AND status = 'ready' ORDER BY position, id", [req.params.id]);
      for (const p of ph.rows) {
        let url = null;
        if (r2.configured()) { try { url = await r2.presignDownload(p.r2_key, p.filename || 'photo', true); } catch (e) {} }
        invoice.photos.push({ id: p.id, filename: p.filename, mime_type: p.mime_type, caption: p.caption, show_in_print: p.show_in_print, position: p.position, url: url });
      }
    } catch (e) { /* table may not exist yet on first deploy */ }
    // Flag whether a scanned ID is on file (managers view it via /:id/id-image).
    // Never leak the R2 key or the other internal ID-image columns to the client.
    invoice.has_id_image = !!invoice.id_image_r2_key;
    delete invoice.id_image_r2_key;
    delete invoice.id_image_mime;
    delete invoice.id_image_uploaded_by;
    // Refund ledger for this invoice. The invoice's own figures are never touched
    // by a refund, so the view layer needs both: the original totals and what has
    // since come back off them.
    invoice.refunds = [];
    try {
      const rf = await pool.query(
        'SELECT r.*, req.name AS requested_by_name, app.name AS approved_by_name, proc.name AS processed_by_name, ' +
        // ⚠️ Must stay in step with REFUND_SELECT in routes/refunds.js. The
        // Refund History table on THIS page and the one on the Refunds page are
        // the same renderer fed by two different queries, so a column added to
        // one and not the other makes the UI silently differ between screens.
        // Square puts the refund on the PAYMENT's receipt, so fall back to the
        // payment row for refunds that never captured their own copy.
        '       COALESCE(r.square_receipt_url, sp.receipt_url) AS square_receipt_url_eff ' +
        'FROM invoice_refunds r ' +
        'LEFT JOIN users req ON r.requested_by = req.id ' +
        'LEFT JOIN users app ON r.approved_by = app.id ' +
        'LEFT JOIN users proc ON r.processed_by = proc.id ' +
        'LEFT JOIN LATERAL (' +
        '  SELECT receipt_url FROM invoice_payments ' +
        "  WHERE invoice_id = r.invoice_id AND status = 'reconciled' AND square_payment_id IS NOT NULL " +
        '  ORDER BY id DESC LIMIT 1' +
        ') sp ON true ' +
        'WHERE r.invoice_id = $1 ORDER BY r.id',
        [req.params.id]
      );
      invoice.refunds = rf.rows;
      if (invoice.refunds.length) {
        const rl = await pool.query(
          'SELECT * FROM invoice_refund_lines WHERE refund_id = ANY($1::int[]) ORDER BY id',
          [invoice.refunds.map(function (x) { return x.id; })]
        );
        const byRefund = {};
        rl.rows.forEach(function (l) {
          if (!byRefund[l.refund_id]) byRefund[l.refund_id] = [];
          byRefund[l.refund_id].push(l);
        });
        invoice.refunds.forEach(function (x) { x.lines = byRefund[x.id] || []; });
      }
    } catch (e) { /* table may not exist yet on first deploy */ }
    invoice.refunded_total = parseFloat(invoice.refunded_total || 0) || 0;
    invoice.net_total = Math.round(((parseFloat(invoice.grand_total) || 0) - invoice.refunded_total) * 100) / 100;
    invoice.pending_refund_total = Math.round(invoice.refunds
      .filter(function (r) { return r.status === 'requested'; })
      .reduce(function (sum, r) { return sum + (parseFloat(r.amount) || 0); }, 0) * 100) / 100;
    invoice.locked = LOCKED_STATUSES.indexOf(invoice.status) !== -1;
    // Latest Square payment attempt, so the view can show 'paid in Square'
    // with the real card data, or the stuck/offline state if it never settled.
    // Process state for the Complete button, the reopen grace period and the
    // split-billing link. Computed here so the client never has to guess.
    try {
      invoice.gates = invoiceGates(invoice, invoice.line_items);
      invoice.can_complete = gatesPass(invoice.gates);
    } catch (e) { invoice.gates = []; invoice.can_complete = false; }
    invoice.reopen_seconds_left = graceLeft(invoice);
    invoice.can_reopen_now = invoice.status === 'paid' && invoice.reopen_seconds_left > 0 && invoice.completed_by === req.user.id;
    invoice.billed_pay_types = await billedPayTypes();
    invoice.split_siblings = [];
    try {
      if (invoice.split_group_id) {
        const sib = await pool.query(
          'SELECT id, invoice_number, account_name, customer_name, grand_total, status FROM invoices WHERE split_group_id = $1 AND id <> $2 ORDER BY id',
          [invoice.split_group_id, invoice.id]
        );
        invoice.split_siblings = sib.rows;
      }
    } catch (e) { /* column may not exist yet on first deploy */ }
    invoice.followup = null;
    try {
      if (invoice.followup_task_id) {
        const ft = await pool.query('SELECT id, title, due_date, status FROM tasks WHERE id = $1', [invoice.followup_task_id]);
        invoice.followup = ft.rows[0] || null;
      }
    } catch (e) {}
    invoice.square_payment = null;
    invoice.square_enabled = square.configured();
    try {
      const sp = await pool.query('SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1', [req.params.id]);
      invoice.square_payment = scrubPaymentRow(sp.rows[0]);
    } catch (e) { /* table may not exist yet on first deploy */ }
    // COGS for the Pulsar close-out card, computed from the stored per-line
    // snapshots. A refunded part flagged restock went back on the shelf and must
    // come OUT of cost of goods; a part refunded on a comeback (restock false)
    // was still consumed and stays in. Same rule the month-end parts report uses.
    try {
      // The SUM is deliberately restricted to costed lines while the counts are
      // not: an earlier cut put "count the unknown lines" inside a WHERE that
      // excluded unknown lines, so the number a manager relies on to judge how
      // much of the figure is guesswork was structurally always zero.
      const cg = await pool.query(
        'SELECT COALESCE(SUM(CASE WHEN li.cost_unknown IS NOT TRUE ' +
        '                         THEN GREATEST(li.quantity - COALESCE(rs.restocked_qty, 0), 0) * COALESCE(li.unit_cost, 0) ' +
        '                         ELSE 0 END), 0) AS cogs, ' +
        '       COUNT(*) AS part_lines, ' +
        '       COUNT(*) FILTER (WHERE li.cost_unknown IS TRUE) AS unknown_lines, ' +
        '       COUNT(*) FILTER (WHERE li.cost_unknown IS NOT TRUE AND li.unit_cost IS NOT NULL) AS costed_lines, ' +
        '       COUNT(*) FILTER (WHERE li.cost_unknown IS NOT TRUE AND li.unit_cost IS NULL) AS uncosted_lines ' +
        '  FROM invoice_line_items li ' +
        '  LEFT JOIN ( SELECT l.invoice_line_item_id, SUM(l.quantity) AS restocked_qty ' +
        '                FROM invoice_refund_lines l JOIN invoice_refunds r ON r.id = l.refund_id ' +
        "               WHERE l.restock = true AND r.status IN ('approved', 'processed') " +
        '               GROUP BY l.invoice_line_item_id ) rs ON rs.invoice_line_item_id = li.id ' +
        " WHERE li.invoice_id = $1 AND li.line_type <> 'labor'",
        [req.params.id]
      );
      const row = cg.rows[0] || {};
      const cogs = Math.round((parseFloat(row.cogs) || 0) * 100) / 100;
      const unknown = parseInt(row.unknown_lines, 10) || 0;
      const uncosted = parseInt(row.uncosted_lines, 10) || 0;
      invoice.cogs = {
        total: cogs,
        // Incomplete covers BOTH ways the figure can be short: a line the tech
        // explicitly marked "no cost available", and a legacy line the backfill
        // could not price. Reporting "all costed" over a partial figure is worse
        // than reporting no figure, because the tech has no reason to doubt it.
        incomplete: invoice.cogs_incomplete === true || unknown > 0 || uncosted > 0,
        unknown_lines: unknown,
        uncosted_lines: uncosted,
        costed_lines: parseInt(row.costed_lines, 10) || 0,
        part_lines: parseInt(row.part_lines, 10) || 0,
        gross_profit: Math.round((((parseFloat(invoice.subtotal) || 0) - cogs)) * 100) / 100
      };
    } catch (e) {
      invoice.cogs = { total: parseFloat(invoice.parts_cost_total) || 0, incomplete: invoice.cogs_incomplete === true, unknown_lines: 0, uncosted_lines: 0, costed_lines: 0, part_lines: 0, gross_profit: 0 };
    }
    res.json(invoice);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// ---- Scanned ID image (managers only) -------------------------------------
// The customer's driver-license photo, returned as base64 so the browser can show
// it from a local blob (no public/presigned URL floating around). Gated to
// managers/admins and audit-logged, since this is sensitive identity evidence.
router.get('/:id/id-image', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    if (!canSeeAll(req.user.role)) return res.status(403).json({ error: 'Only managers can view the ID on file.' });
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT id_image_r2_key, id_image_mime, id_image_uploaded_at FROM invoices WHERE id = $1', [id]);
    if (!r.rows.length || !r.rows[0].id_image_r2_key) return res.status(404).json({ error: 'No ID image on file for this invoice.' });
    if (!r2.configured()) return res.status(503).json({ error: 'Image storage is not configured.' });
    let buf;
    try { buf = await r2.getObjectBuffer(r.rows[0].id_image_r2_key); }
    catch (e) { console.error('ID image fetch failed:', e.message); return res.status(502).json({ error: 'Could not load the ID image from storage.' }); }
    try { await logAudit({ entity_type: 'invoice', entity_id: id, action: 'view_id_image', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json({ mime: r.rows[0].id_image_mime || 'image/jpeg', data: buf.toString('base64'), uploaded_at: r.rows[0].id_image_uploaded_at });
  } catch (err) {
    console.error('id-image error:', err);
    res.status(500).json({ error: 'Failed to load ID image' });
  }
});

// ---- Square dispute evidence packet (managers only) -----------------------
// Assembles everything Square accepts as chargeback evidence for one invoice into a
// single PDF: cardholder identity (+ the government-ID photo), the signed
// authorization (agreement + signature + timestamp), timestamped proof of service
// (date, times, line items, work photos) and the payment reference (approval code +
// card last 4 only). Nova never stores full card numbers or CVV, so the packet is
// compliant with Square's upload rules by construction. Returned as base64 for a
// clean client-side download.
router.get('/:id/dispute-packet', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    if (!canSeeAll(req.user.role)) return res.status(403).json({ error: 'Only managers can generate the dispute evidence packet.' });
    const id = parseInt(req.params.id, 10);
    const ir = await pool.query('SELECT i.*, u.name AS locksmith_name_join, u.phone AS locksmith_phone, u.email AS locksmith_email FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id WHERE i.id = $1', [id]);
    if (!ir.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const inv = ir.rows[0];
    const items = (await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position, id', [id])).rows;
    // Every ready work photo is timestamped proof of service (not just print-flagged).
    const photos = [];
    try {
      const ph = (await pool.query("SELECT r2_key, caption, created_at FROM invoice_photos WHERE invoice_id = $1 AND status = 'ready' ORDER BY position, id", [id])).rows;
      if (ph.length && r2.configured()) {
        for (const p of ph) {
          try { photos.push({ buffer: await r2.getObjectBuffer(p.r2_key), caption: p.caption, created_at: p.created_at }); } catch (e) { console.error('R2 photo fetch failed:', e.message); }
        }
      }
    } catch (e) { /* table may be absent on first deploy */ }
    // The government-ID photo (identity evidence).
    let idImage = null;
    if (inv.id_image_r2_key && r2.configured()) {
      try { idImage = await r2.getObjectBuffer(inv.id_image_r2_key); } catch (e) { console.error('R2 ID image fetch failed:', e.message); }
    }
    const company = {
      name: await getSetting('company_name', 'Pop-A-Lock'),
      address: await getSetting('company_address', ''),
      csz: await getSetting('company_city_state_zip', ''),
      phone: await getSetting('company_phone', '')
    };
    let pdfBuf;
    try {
      // Any refund already issued on this invoice is evidence in its own right.
      let refundRows = [];
      try {
        refundRows = (await pool.query(
          'SELECT r.*, app.name AS approved_by_name FROM invoice_refunds r LEFT JOIN users app ON r.approved_by = app.id ' +
          "WHERE r.invoice_id = $1 AND r.status IN ('approved', 'processed') ORDER BY r.id",
          [id]
        )).rows;
        if (refundRows.length) {
          const _rl = await pool.query('SELECT * FROM invoice_refund_lines WHERE refund_id = ANY($1::int[]) ORDER BY id', [refundRows.map(function (x) { return x.id; })]);
          refundRows.forEach(function (x) {
            x.lines = _rl.rows.filter(function (l) { return l.refund_id === x.id; });
          });
        }
      } catch (e) { refundRows = []; }
      pdfBuf = await buildDisputePdf(customerSafeInvoice(inv), customerSafeLines(items), { idImage: idImage, idMime: inv.id_image_mime, idUploadedAt: inv.id_image_uploaded_at, photos: photos, refunds: refundRows }, { company: company });
    } catch (e) { console.error('Dispute packet build failed:', e); return res.status(500).json({ error: 'Could not build the dispute packet.' }); }
    if (pdfBuf.length > 40 * 1024 * 1024) return res.status(413).json({ error: 'The packet is over 40 MB. Remove some photos and try again.' });
    try { await logAudit({ entity_type: 'invoice', entity_id: id, entity_number: String(inv.invoice_number || ''), action: 'dispute_packet', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json({ filename: 'Dispute-Evidence-Invoice-' + (inv.invoice_number || id) + '.pdf', mime: 'application/pdf', data: pdfBuf.toString('base64') });
  } catch (err) {
    console.error('Dispute packet error:', err);
    res.status(500).json({ error: 'Failed to build the dispute packet' });
  }
});

// ---- Invoice photos (Cloudflare R2) ---------------------------------------
// Confirm the caller may modify this invoice (owner or a see-all role).
async function loadInvoiceForWrite(id, user) {
  const r = await pool.query('SELECT id, locksmith_id FROM invoices WHERE id = $1', [id]);
  if (!r.rows.length) return { error: 404 };
  if (!canSeeAll(user.role) && r.rows[0].locksmith_id !== user.id) return { error: 403 };
  return { invoice: r.rows[0] };
}

// Step 1: reserve a photo row + presigned PUT URL. Browser uploads bytes to R2 directly.
router.post('/:id/photos/upload-url', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not configured yet. Add the R2_* environment variables in Railway.' });
    const id = parseInt(req.params.id, 10);
    const chk = await loadInvoiceForWrite(id, req.user);
    if (chk.error === 404) return res.status(404).json({ error: 'Invoice not found' });
    if (chk.error === 403) return res.status(403).json({ error: 'Access denied' });
    const name = sanitizeName(req.body.name);
    const mime = (req.body.mime_type || 'image/jpeg').slice(0, 255);
    if (!/^image\//.test(mime)) return res.status(400).json({ error: 'Only image files can be attached as photos.' });
    const posRow = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM invoice_photos WHERE invoice_id = $1', [id]);
    const key = 'invoices/' + id + '/' + crypto.randomUUID() + '/' + name;
    const { rows } = await pool.query(
      "INSERT INTO invoice_photos (invoice_id, r2_key, filename, mime_type, position, status, uploaded_by) VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING id",
      [id, key, name, mime, posRow.rows[0].next, req.user.id]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('Invoice photo upload-url error:', err);
    res.status(500).json({ error: 'Failed to start photo upload' });
  }
});

// Step 2: confirm the upload finished; mark ready + record size.
router.post('/:id/photos/:photoId/confirm', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const photoId = parseInt(req.params.photoId, 10);
    const chk = await loadInvoiceForWrite(id, req.user);
    if (chk.error) return res.status(chk.error).json({ error: chk.error === 404 ? 'Invoice not found' : 'Access denied' });
    const size = Math.max(0, parseInt(req.body.size_bytes, 10) || 0);
    const caption = (req.body.caption || '').toString().slice(0, 300);
    const r = await pool.query("UPDATE invoice_photos SET status = 'ready', size_bytes = $1, caption = $2 WHERE id = $3 AND invoice_id = $4 RETURNING id", [size, caption, photoId, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Photo not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Invoice photo confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm photo' });
  }
});

// Update caption / show_in_print.
router.patch('/:id/photos/:photoId', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const photoId = parseInt(req.params.photoId, 10);
    const chk = await loadInvoiceForWrite(id, req.user);
    if (chk.error) return res.status(chk.error).json({ error: chk.error === 404 ? 'Invoice not found' : 'Access denied' });
    const sets = [], params = [];
    if (req.body.caption !== undefined) { params.push(String(req.body.caption).slice(0, 300)); sets.push('caption = $' + params.length); }
    if (req.body.show_in_print !== undefined) { params.push(req.body.show_in_print === true); sets.push('show_in_print = $' + params.length); }
    if (!sets.length) return res.json({ success: true });
    params.push(photoId); params.push(id);
    const r = await pool.query('UPDATE invoice_photos SET ' + sets.join(', ') + ' WHERE id = $' + (params.length - 1) + ' AND invoice_id = $' + params.length + ' RETURNING id', params);
    if (!r.rows.length) return res.status(404).json({ error: 'Photo not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Invoice photo patch error:', err);
    res.status(500).json({ error: 'Failed to update photo' });
  }
});

// Delete a photo (R2 object + row).
router.delete('/:id/photos/:photoId', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const photoId = parseInt(req.params.photoId, 10);
    const chk = await loadInvoiceForWrite(id, req.user);
    if (chk.error) return res.status(chk.error).json({ error: chk.error === 404 ? 'Invoice not found' : 'Access denied' });
    const r = await pool.query('SELECT r2_key FROM invoice_photos WHERE id = $1 AND invoice_id = $2', [photoId, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Photo not found' });
    try { await r2.deleteObject(r.rows[0].r2_key); } catch (e) { console.error('R2 delete failed:', e.message); }
    await pool.query('DELETE FROM invoice_photos WHERE id = $1 AND invoice_id = $2', [photoId, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Invoice photo delete error:', err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// ---- Email the whole invoice as a PDF attachment (mirrors the document vault) ----
function escEmail(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
router.post('/:id/email', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ir = await pool.query('SELECT i.*, u.name AS locksmith_name_join FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id WHERE i.id = $1', [id]);
    if (!ir.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const inv = ir.rows[0];
    if (!canSeeAll(req.user.role) && inv.locksmith_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const to = (req.body.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid recipient email address' });
    const toName = (req.body.to_name || '').toString().slice(0, 120);
    const message = (req.body.message || '').toString().slice(0, 2000);

    const items = (await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position, id', [id])).rows;

    // Print-flagged photos → buffers from R2.
    const photos = [];
    try {
      const ph = (await pool.query("SELECT r2_key, caption FROM invoice_photos WHERE invoice_id = $1 AND show_in_print = true AND status = 'ready' ORDER BY position, id", [id])).rows;
      if (ph.length && r2.configured()) {
        for (const p of ph) {
          try { photos.push({ buffer: await r2.getObjectBuffer(p.r2_key), caption: p.caption }); } catch (e) { console.error('R2 photo fetch failed:', e.message); }
        }
      }
    } catch (e) { /* table may be absent on first deploy */ }

    const company = {
      name: await getSetting('company_name', 'Pop-A-Lock'),
      address: await getSetting('company_address', ''),
      csz: await getSetting('company_city_state_zip', ''),
      phone: await getSetting('company_phone', ''),
      logo: await getSetting('logo', '')
    };

    let pdfBuf;
    // The emailed copy shows the original total and anything refunded off it.
    let invRefunds = [];
    try {
      invRefunds = (await pool.query(
        "SELECT refund_number, amount, refund_date, status FROM invoice_refunds WHERE invoice_id = $1 AND status IN ('approved', 'processed') ORDER BY id",
        [id]
      )).rows;
    } catch (e) { invRefunds = []; }
    try { pdfBuf = await buildInvoicePdf(customerSafeInvoice(inv), customerSafeLines(items), photos, { company: company, refunds: invRefunds }); }
    catch (e) { console.error('Invoice PDF build failed:', e); return res.status(500).json({ error: 'Could not build the invoice PDF.' }); }
    if (pdfBuf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'The invoice PDF is over 20 MB and is too large to email. Remove some photos from the printed version and try again.' });

    const safeMsg = message ? escEmail(message).replace(/\n/g, '<br>') : '';
    const fileName = 'Invoice-' + (inv.invoice_number || id) + '.pdf';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6">' +
      '<p>' + (toName ? ('Hi ' + escEmail(toName) + ',') : 'Hello,') + '</p>' +
      '<p>Please find attached invoice <strong>#' + escEmail(String(inv.invoice_number || id)) + '</strong>' + (inv.grand_total != null ? (' for a total of <strong>$' + Number(inv.grand_total).toFixed(2) + '</strong>') : '') + '.</p>' +
      (safeMsg ? ('<p>' + safeMsg + '</p>') : '') +
      '<p>Sent by ' + escEmail(req.user.name) + ' on behalf of Lock and Roll LLC.</p>' +
      '<p style="color:#888;font-size:12px;border-top:1px solid #eee;padding-top:10px;margin-top:18px">This message was sent from an unmonitored address. Please contact Lock and Roll LLC directly with any questions.</p>' +
      '</div>';

    await sendEmail(
      to,
      'Invoice #' + (inv.invoice_number || id) + ' from Lock and Roll LLC',
      html,
      req.user.email || null,
      [{ filename: fileName, content: pdfBuf.toString('base64'), content_type: 'application/pdf' }]
    );
    try { await logAudit({ entity_type: 'invoice', entity_id: id, entity_number: String(inv.invoice_number || ''), action: 'email', user_id: req.user.id, user_name: req.user.name, details: { to: to } }); } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    console.error('Invoice email error:', err);
    res.status(500).json({ error: 'Failed to send the invoice' });
  }
});

function pickInvoiceFields(b) {
  return {
    account_id: b.account_id || null,
    account_name: b.account_name || null,
    customer_po_wo: b.customer_po_wo || null,
    pay_type: b.pay_type || null,
    card_last4: b.card_last4 ? String(b.card_last4).replace(/\D/g, '').slice(-4) : null,
    cc_online: b.cc_online === true,
    time_in: b.time_in || null,
    time_out: b.time_out || null,
    customer_name: b.customer_name || null,
    dl_number: b.dl_number || null,
    dl_state: b.dl_state || null,
    street_address: b.street_address || null,
    city: b.city || null,
    state: b.state || null,
    zip: b.zip || null,
    phone: b.phone || null,
    email: b.email || null,
    vehicle_year: b.vehicle_year || null,
    vehicle_make: b.vehicle_make || null,
    vehicle_model: b.vehicle_model || null,
    license_tag: b.license_tag || null,
    tag_state: b.tag_state || null,
    vin: b.vin || null,
    mileage: b.mileage || null,
    ent_registration: b.ent_registration === true,
    ent_insurance: b.ent_insurance === true,
    ent_title: b.ent_title === true,
    ent_rental: b.ent_rental === true,
    notes: b.notes || null,
    payments_note: b.payments_note || null,
    agreement_text: b.agreement_text || null,
    signature_image: b.signature_image || null,
    signed_name: b.signed_name || b.customer_name || null,
    approval_code: b.approval_code || null,
    tax_exempt: b.tax_exempt === true,
    signature_required: b.signature_required === true,
    city_code: (b.city_code ? String(b.city_code).trim().toUpperCase().slice(0, 3) : null)
  };
}

async function insertLineItems(client, invoiceId, line_items) {
  let pos = 0;
  for (const it of (line_items || [])) {
    if (!it || !it.description) continue;
    const isLabor = it.line_type === 'labor';
    const costUnknown = !isLabor && it.cost_unknown === true;
    const hasCost = !isLabor && !costUnknown && it.unit_cost != null && it.unit_cost !== '' && !isNaN(parseFloat(it.unit_cost));
    let source = null;
    if (isLabor) source = 'none';
    else if (costUnknown) source = 'none';
    else if (hasCost) source = (it.cost_source === 'catalog' || it.cost_source === 'backfill') ? it.cost_source : 'manual';
    await client.query(
      'INSERT INTO invoice_line_items (invoice_id, line_type, part_id, item_number, description, quantity, unit_price, unit_cost, cost_unknown, cost_unknown_reason, cost_source, taxable, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [
        invoiceId, isLabor ? 'labor' : 'part', it.part_id || null, it.item_number || null, it.description,
        parseFloat(it.quantity) || 1, parseFloat(it.unit_price) || 0,
        hasCost ? parseFloat(it.unit_cost) : null,
        costUnknown,
        costUnknown ? (String(it.cost_unknown_reason || '').trim().slice(0, 255) || null) : null,
        source,
        it.taxable === true, pos++
      ]
    );
  }
}

// The create handler, named rather than inline so POST /from-signoff below can
// reuse it verbatim instead of duplicating fifty-odd columns of INSERT, the
// number generator, the totals math and the close-out gates. Registered
// immediately after the function body.
async function invoiceCreateHandler(req, res) {
  const b = req.body || {};
  const f = pickInvoiceFields(b);
  const status = ['draft', 'awaiting_payment', 'paid'].indexOf(b.status) !== -1 ? b.status : 'draft';
  if (f.signature_required && status !== 'draft' && !f.signature_image) {
    return res.status(400).json({ error: 'A signature is required before this invoice can be marked ' + status + '. Save as draft, or capture a signature.' });
  }
  for (const it of (b.line_items || [])) {
    if (!it || !it.description) continue;
    if (it.quantity != null && it.quantity !== '' && !(parseFloat(it.quantity) > 0)) return res.status(400).json({ error: 'Line item quantity must be greater than 0' });
    if (it.unit_price != null && it.unit_price !== '' && !(parseFloat(it.unit_price) >= 0)) return res.status(400).json({ error: 'Line item unit price must be 0 or greater' });
  }
  // Close-out gate: Pulsar needs a COGS figure, so a non-draft invoice can't
  // carry a part line with no cost and no "no cost available" reason.
  const _missing = status !== 'draft' ? missingCostLines(b.line_items) : [];
  if (_missing.length) {
    return res.status(400).json({
      error: 'Cost is missing on ' + _missing.length + ' part line' + (_missing.length === 1 ? '' : 's') + '.',
      cogs_missing: _missing
    });
  }
  const tax_rate = parseFloat(b.tax_rate) || 0;
  // The rate is read from settings on the server, never taken from the request.
  // A client that posts its own surcharge or rate is ignored.
  const pay_method = normalizePayMethod(b.pay_method);
  const sur_rate = await surchargeRate();
  const t = computeTotals(b.line_items, tax_rate, b.tip_amount, b.tax_exempt === true, pay_method, sur_rate);
  const invoice_date = b.invoice_date || new Date().toISOString().split('T')[0];
  const signedAt = f.signature_image ? new Date() : null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const invoice_number = await generateInvoiceNumber(f.city_code);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        'INSERT INTO invoices (invoice_number, locksmith_id, locksmith_name, invoice_date, status, account_id, account_name, customer_po_wo, pay_type, card_last4, cc_online, time_in, time_out, customer_name, dl_number, dl_state, street_address, city, state, zip, phone, email, vehicle_year, vehicle_make, vehicle_model, license_tag, tag_state, vin, mileage, ent_registration, ent_insurance, ent_title, ent_rental, tax_rate, labor_amount, parts_amount, subtotal, tax_amount, tip_amount, grand_total, notes, payments_note, agreement_text, signature_image, signed_name, signed_at, approval_code, tax_exempt, signature_required, city_code, parts_cost_total, cogs_incomplete, surcharge_amount, surcharge_rate, pay_method) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55) RETURNING *',
        [invoice_number, req.user.id, req.user.name, invoice_date, status, f.account_id, f.account_name, f.customer_po_wo, f.pay_type, f.card_last4, f.cc_online, f.time_in, f.time_out, f.customer_name, f.dl_number, f.dl_state, f.street_address, f.city, f.state, f.zip, f.phone, f.email, f.vehicle_year, f.vehicle_make, f.vehicle_model, f.license_tag, f.tag_state, f.vin, f.mileage, f.ent_registration, f.ent_insurance, f.ent_title, f.ent_rental, tax_rate, t.labor, t.parts, t.subtotal, t.tax_amount, t.tip, t.grand_total, f.notes, f.payments_note, f.agreement_text, f.signature_image, f.signed_name, signedAt, f.approval_code, f.tax_exempt, f.signature_required, f.city_code, t.parts_cost, t.cogs_incomplete, t.surcharge, t.surcharge_rate, pay_method]
      );
      const invoice = ins.rows[0];
      await insertLineItems(client, invoice.id, b.line_items);
      await client.query('COMMIT');
      client.release();
      try { await logAudit({ entity_type: 'invoice', entity_id: invoice.id, entity_number: String(invoice_number), action: 'created', user_id: req.user.id, user_name: req.user.name, details: { customer: f.customer_name, total: t.grand_total } }); } catch (e) {}
      await auditCostOverrides(b.line_items, invoice.id, invoice_number, req.user);
      try {
        const _q = await notify.broadcastRecipients('invoice_created', "role IN ('admin', 'owner')");
        await push.sendPushToUsers(_q.userIds, { title: 'New invoice', body: req.user.name + ' created invoice #' + invoice_number + '.', url: '/' });
        if (_q.emails && _q.emails.length) {
          const html = emailTemplate({
            badge: 'New invoice', title: 'A new invoice was created',
            body: '<strong>' + req.user.name + '</strong> created invoice #' + invoice_number + '.',
            details: [
              { label: 'Invoice #', value: String(invoice_number) },
              { label: 'Customer', value: f.customer_name || '—' },
              { label: 'Account', value: f.account_name || '—' },
              { label: 'Grand Total', value: '$' + t.grand_total.toFixed(2) },
              { label: 'Created by', value: req.user.name }
            ],
            buttonText: 'View Invoice',
            buttonUrl: (process.env.APP_URL || '').replace(/\/$/, '') + '/?view=view-invoice&id=' + invoice.id
          });
          await sendEmail(_q.emails, 'New Invoice #' + invoice_number, html);
        }
      } catch (e) { console.error('Invoice notify failed:', e); }
      // Persist the scanned ID photo (if the tech captured one) as dispute evidence.
      // Runs after commit; a storage hiccup must not undo the saved invoice.
      if (b.id_image) {
        try {
          const _idr = await storeIdImage(invoice.id, b.id_image, req.user.id);
          invoice.id_image_saved = _idr.saved;
          if (_idr.saved) invoice.has_id_image = true;
        } catch (e) { console.error('ID image save (create) failed:', e); invoice.id_image_saved = false; }
      }
      delete invoice.id_image_r2_key;
      delete invoice.id_image_mime;
      delete invoice.id_image_uploaded_by;
      return res.status(201).json(invoice);
    } catch (err) {
      await client.query('ROLLBACK').catch(function () {});
      client.release();
      if (err.code === '23505' && attempt < 9) continue;
      console.error(err);
      return res.status(500).json({ error: 'Failed to create invoice: ' + err.message });
    }
  }
}
router.post('/', requireAuth, requirePermission('create_invoice'), invoiceCreateHandler);

// ---------------------------------------------------------------------------
// Create an invoice straight off a sign-off sheet.
//
// The tech is standing on site with a REQUIRED "Invoice Number" box in front of
// them and nothing to type into it. This is that box's way out.
//
// The unit is the JOB, not the sheet. A job that needs three visits is three
// sign-off sheets sharing one trip_group_id, and all three bill onto ONE
// invoice. See the signoff_group_id migration in db.js for why this is not
// grouped on po_number.
//
// Server-side on purpose. The quote equivalent (pushQuoteToInvoice in app.js)
// builds its payload in the browser; doing that here would let a double-tap
// create two invoices for one job, and would make the invoice_number write-back
// across a trip group non-atomic.
// ---------------------------------------------------------------------------

function normAcct(x) {
  return String(x == null ? '' : x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Match the sheet's free-text account against the invoice account list.
// Deliberately conservative: anything ambiguous returns NOTHING rather than a
// guess, because the wrong account silently drags the wrong agreement text,
// auto line items and tax treatment onto the invoice. A miss is visible and
// fixable in one dropdown; a wrong match is neither.
async function matchSignoffAccount(accountText) {
  var want = normAcct(accountText);
  if (!want) return null;
  var q = await pool.query(
    'SELECT id, name, invoice_notes, auto_line_items, agreement_text FROM vendors WHERE show_in_invoice = true'
  );
  var rows = q.rows || [];
  var exact = rows.filter(function (r) { return normAcct(r.name) === want; });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  var partial = rows.filter(function (r) {
    var nm = normAcct(r.name);
    return nm && (nm.indexOf(want) !== -1 || want.indexOf(nm) !== -1);
  });
  return partial.length === 1 ? partial[0] : null;
}

// "Mount Dora, FL 32757" -> { city, state, zip }. Tolerates a missing comma and
// a ZIP+4. Anything it cannot read comes back empty rather than wrong.
function splitCityStateZip(x) {
  var out = { city: '', state: '', zip: '' };
  var raw = String(x == null ? '' : x).trim();
  if (!raw) return out;
  var m = raw.match(/^(.*?)[,\s]+([A-Za-z]{2})[,\s]+(\d{5}(?:-\d{4})?)\s*$/);
  if (m) { out.city = m[1].trim(); out.state = m[2].toUpperCase(); out.zip = m[3]; return out; }
  var m2 = raw.match(/^(.*?)[,\s]+([A-Za-z]{2})\s*$/);
  if (m2) { out.city = m2[1].trim(); out.state = m2[2].toUpperCase(); return out; }
  out.city = raw;
  return out;
}

// city_code picks the invoice NUMBER BAND (cities.invoice_prefix), so a wrong
// guess misfiles the sequence permanently. Exact name match only, then the
// tech's home city, then nothing. Never invent one.
async function cityCodeForSignoff(cityName, userId) {
  var want = normAcct(cityName);
  if (want) {
    try {
      var cq = await pool.query('SELECT code, name FROM cities');
      var hit = (cq.rows || []).filter(function (c) { return normAcct(c.name) === want; });
      if (hit.length === 1) return hit[0].code;
    } catch (e) {}
  }
  try {
    var uq = await pool.query('SELECT home_city FROM users WHERE id = $1', [userId]);
    if (uq.rows[0] && uq.rows[0].home_city) return uq.rows[0].home_city;
  } catch (e) {}
  return null;
}

// Stamp the number onto every sheet on the job that does not already carry one.
// The IS NULL guard matters: a sheet with a hand-typed number is somebody's
// deliberate answer and must not be overwritten by this.
async function linkSignoffGroup(groupId, invoiceNumber) {
  try {
    await pool.query(
      "UPDATE signoff_forms SET invoice_number = $1, updated_at = NOW() WHERE trip_group_id = $2 AND (invoice_number IS NULL OR invoice_number = '')",
      [String(invoiceNumber), groupId]
    );
  } catch (e) { console.error('Sign-off invoice link failed:', e && e.message); }
}

router.post('/from-signoff/:signoffId', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  try {
    var sq = await pool.query('SELECT * FROM signoff_forms WHERE id = $1', [req.params.signoffId]);
    if (!sq.rows.length) return res.status(404).json({ error: 'Sign-off sheet not found' });
    var form = sq.rows[0];
    // Same access rule routes/signoffs.js enforces, restated because this route
    // lives in the invoices file.
    if (['admin', 'manager'].indexOf(req.user.role) === -1 && form.assigned_to !== req.user.id && form.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    var groupId = form.trip_group_id || form.id;

    // One invoice per job. If the group already has a live one, hand that back
    // rather than making a second. This is also what makes a double-tap safe.
    var exq = await pool.query(
      'SELECT id, invoice_number, status FROM invoices WHERE signoff_group_id = $1 ORDER BY id DESC LIMIT 1',
      [groupId]
    );
    var existing = exq.rows.length ? exq.rows[0] : null;
    // ONE invoice per job, full stop. Status is deliberately not consulted: a
    // paid or refunded invoice is still THIS job's invoice, and the sheet's job
    // is to point at it, never to quietly open a second one behind the tech's
    // back. This is also what makes a double-tap safe.
    if (existing) {
      await linkSignoffGroup(groupId, existing.invoice_number);
      return res.json({
        reused: true,
        invoice_id: existing.id,
        invoice_number: String(existing.invoice_number),
        invoice_status: existing.status,
        account_matched: true,
        account_text: form.account || null
      });
    }
    // Falling through means the job has no invoice at all yet.

    var acct = await matchSignoffAccount(form.account);
    var csz = splitCityStateZip(form.city_state_zip);
    var cityCode = await cityCodeForSignoff(csz.city, req.user.id);

    // The line items are the ACCOUNT's standard ones and nothing else. The
    // sign-off's work description is a narrative, not a billable line, so it goes
    // into the notes instead of being priced. Applied here rather than left to
    // the editor: invAccountChange() only fires on a user CHANGE, so an account
    // preselected by this route would otherwise never apply them.
    var lines = [];
    if (acct && Array.isArray(acct.auto_line_items)) {
      acct.auto_line_items.forEach(function (li) {
        if (!li || !li.description) return;
        lines.push({
          line_type: li.line_type === 'labor' ? 'labor' : 'part',
          item_number: li.item_number || '',
          description: String(li.description).slice(0, 500),
          quantity: li.quantity != null ? li.quantity : 1,
          unit_price: li.unit_price != null ? li.unit_price : '',
          taxable: li.taxable === true
        });
      });
    }

    var store = String(form.store_name || '').trim();
    var storeNo = String(form.store_number || '').trim();
    var noteBits = ['From sign-off ' + form.form_number + (form.po_number ? ' (PO ' + form.po_number + ')' : '')];
    if (form.service_requested_by) noteBits.push('Requested by: ' + form.service_requested_by);
    // The work description lands here, not on a line item. It is what happened,
    // not what is being charged for.
    var desc = String(form.work_description || '').trim();
    if (desc) noteBits.push('Work performed: ' + desc);
    if (form.notes) noteBits.push(String(form.notes).trim());

    var body = {
      status: 'draft',
      account_id: acct ? acct.id : null,
      account_name: acct ? acct.name : null,
      customer_po_wo: form.po_number || null,
      customer_name: store ? (store + (storeNo ? ' #' + storeNo : '')) : null,
      street_address: form.address || null,
      city: csz.city || null,
      state: csz.state || null,
      zip: csz.zip || null,
      // time_in / time_out are VARCHAR(20). The sign-off fields are free text
      // and routinely longer ("8/3/26 11:40 AM"). Truncate rather than 500.
      time_in: form.start_time ? String(form.start_time).slice(0, 20) : null,
      time_out: form.end_time ? String(form.end_time).slice(0, 20) : null,
      notes: noteBits.join('\n'),
      agreement_text: (acct && acct.agreement_text) ? acct.agreement_text : null,
      city_code: cityCode,
      line_items: lines
    };

    // Reuse the real create handler rather than duplicating its INSERT. It
    // writes its own response, so capture that instead of letting it reply, and
    // fail loudly if it did not produce an invoice.
    var captured = null;
    var shim = {
      code: 200,
      status: function (c) { this.code = c; return this; },
      json: function (payload) { captured = { code: this.code, body: payload }; return this; }
    };
    await invoiceCreateHandler({ user: req.user, body: body }, shim);
    if (!captured || captured.code >= 400 || !captured.body || !captured.body.id) {
      return res.status(captured && captured.code >= 400 ? captured.code : 500)
        .json((captured && captured.body && captured.body.error) ? captured.body : { error: 'Failed to create the invoice for this sign-off.' });
    }
    var invoice = captured.body;

    await pool.query('UPDATE invoices SET signoff_group_id = $1 WHERE id = $2', [groupId, invoice.id]);
    await linkSignoffGroup(groupId, invoice.invoice_number);

    try {
      await logAudit({
        entity_type: 'invoice', entity_id: invoice.id, entity_number: String(invoice.invoice_number),
        action: 'created_from_signoff', user_id: req.user.id, user_name: req.user.name,
        details: {
          signoff_id: form.id, signoff_number: form.form_number, trip_group_id: groupId,
          account_matched: !!acct
        }
      });
    } catch (e) {}

    return res.status(201).json({
      reused: false,
      invoice_id: invoice.id,
      invoice_number: String(invoice.invoice_number),
      account_matched: !!acct,
      account_text: form.account || null
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create invoice from sign-off: ' + err.message });
  }
});

// Sign an invoice, and ONLY sign it.
// A paid invoice is frozen by PUT /:id because the Square dispute packet is
// built from its numbers, but the real field order is do the job, take the
// payment, THEN hand the customer the phone. Locking the signature behind the
// same gate made the authorization impossible to collect after the fact. This
// route is deliberately narrow: it writes signature_image / signed_name /
// signed_at and nothing else, it never touches money, status or line items, and
// it refuses to overwrite a signature that is already there.
router.post('/:id/signature', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, invoice_number, locksmith_id, customer_name, signature_image FROM invoices WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const inv = r.rows[0];
    if (!canSeeAll(req.user.role) && inv.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const img = (req.body || {}).signature_image;
    if (typeof img !== 'string' || img.indexOf('data:image/png;base64,') !== 0) {
      return res.status(400).json({ error: 'A signature image is required.' });
    }
    if (img.length > 4000000) {
      return res.status(400).json({ error: 'That signature image is too large.' });
    }
    // A signature is evidence. Replacing one is an admin decision, not something
    // a second pass over the same invoice should do quietly.
    if (inv.signature_image && ['admin', 'owner'].indexOf(req.user.role) === -1) {
      return res.status(409).json({ error: 'This invoice is already signed. Ask an admin to replace the signature.' });
    }
    const name = (req.body.signed_name || inv.customer_name || '').toString().trim().slice(0, 255) || null;
    const upd = await pool.query(
      'UPDATE invoices SET signature_image = $1, signed_name = $2, signed_at = NOW(), updated_at = NOW() WHERE id = $3 RETURNING signature_image, signed_name, signed_at',
      [img, name, inv.id]
    );
    try { await logAudit({ entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number), action: 'signed', user_id: req.user.id, user_name: req.user.name, details: { signed_name: name, replaced: !!inv.signature_image } }); } catch (e) {}
    res.json(upd.rows[0]);
  } catch (err) {
    console.error('Sign invoice error:', err);
    res.status(500).json({ error: 'Failed to save the signature' });
  }
});

// ---- Collect payment in Square --------------------------------------------
// Mints an invoice_payments row and hands back the two deep links. The client
// picks by platform. Nothing is charged here; this only prepares the handoff.
router.post('/:id/collect-payment', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  if (!square.configured()) {
    return res.status(400).json({ error: 'Square is not connected yet. An admin has to set it up under Invoice Setup.' });
  }
  if (!square.callbackUrl()) {
    return res.status(400).json({ error: 'Square has no callback URL configured. Tell an admin.' });
  }
  try {
    const r = await pool.query(
      'SELECT id, invoice_number, status, customer_name, grand_total, tip_amount, city_code, locksmith_id, signature_required, signature_image, pay_method, surcharge_amount FROM invoices WHERE id = $1',
      [req.params.id]
    );
    const inv = r.rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!canSeeAll(req.user.role) && inv.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // 'draft' is displayed as "Active" and is the normal state of an invoice a
    // tech is holding in front of the customer, so it CANNOT be refused outright.
    // Refusing it made Collect Payment unreachable: the only other unlocked
    // status is 'awaiting_payment', which needs a chase date first, and 'paid' is
    // locked. What actually has to be true is that the invoice is FINISHABLE --
    // the same gates the Complete Invoice button checks -- because a Square
    // payment IS the finish line (the narrow writer in utils/square.js stamps
    // status='paid' and completed_at). Anything that could not be completed must
    // not be chargeable either.
    if (inv.status === 'draft') {
      const gitems = (await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1', [inv.id])).rows;
      const ggates = invoiceGates(inv, gitems);
      if (!gatesPass(ggates)) {
        const gmissing = ggates.filter(function (g) { return !g.ok; }).map(function (g) { return g.label.toLowerCase(); });
        return res.status(400).json({
          error: 'Invoice #' + inv.invoice_number + ' is not finished yet: ' + gmissing.join(', ') + '. Fix that and the card can be run. Nothing was charged.',
          gates: ggates
        });
      }
    }
    if (LOCKED_STATUSES.indexOf(inv.status) !== -1) {
      return res.status(409).json({ error: 'This invoice is already settled.' });
    }
    if (inv.signature_required && !inv.signature_image) {
      return res.status(400).json({ error: 'A signature is required before this invoice can be paid.' });
    }
    // Collecting in Square IS a card payment. If the invoice still says the
    // customer is paying cash, the surcharge was never added and running the card
    // now would undercharge by the surcharge on every job. Refuse and name the
    // fix, rather than silently charging the cash price to a card.
    if (await surchargeRate() > 0 && normalizePayMethod(inv.pay_method) !== 'card') {
      return res.status(400).json({
        error: normalizePayMethod(inv.pay_method) === 'cash'
          ? ('Invoice #' + inv.invoice_number + ' is set to Cash, so it carries no card surcharge. Reopen it and switch the customer to Card before running the card. Nothing was charged.')
          : ('Nobody has asked how invoice #' + inv.invoice_number + ' is being paid yet. Reopen it, pick Card, and the surcharge is added. Nothing was charged.')
      });
    }
    const cents = Math.round((parseFloat(inv.grand_total) || 0) * 100);
    if (cents <= 0) return res.status(400).json({ error: 'There is nothing to charge on this invoice.' });

    const map = await squareLocationMap();
    const code = String(inv.city_code || '').toUpperCase();
    const locationId = code ? map[code] : null;
    if (!locationId) {
      return res.status(400).json({
        error: code
          ? ('The city ' + code + ' is not mapped to a Square location yet. Tell an admin. Nothing was charged.')
          : 'This invoice has no city on it, so Nova cannot tell which Square location the money belongs to.'
      });
    }

    // Already settled against Square? Do not open a second charge.
    const done = await pool.query("SELECT id FROM invoice_payments WHERE invoice_id = $1 AND status = 'reconciled'", [inv.id]);
    if (done.rows.length) return res.status(409).json({ error: 'This invoice already has a completed Square payment.' });

    // A payment still waiting on Square blocks a retry, because two open
    // attempts is how a customer gets charged twice.
    const open = await pool.query(
      "SELECT id, status, initiated_at FROM invoice_payments WHERE invoice_id = $1 AND status IN ('returned','offline_pending') ORDER BY id DESC LIMIT 1",
      [inv.id]
    );
    if (open.rows.length) {
      return res.status(409).json({ error: 'A Square payment for this invoice is still being confirmed. Wait for it to finish before starting another.' });
    }

    // Abandoned attempts (tech backed out and never came back) go stale after
    // 30 minutes and stop blocking.
    await pool.query(
      "UPDATE invoice_payments SET status = 'canceled', updated_at = NOW() " +
      "WHERE invoice_id = $1 AND status = 'initiated' AND initiated_at < NOW() - INTERVAL '30 minutes'",
      [inv.id]
    );
    const stillOpen = await pool.query("SELECT id FROM invoice_payments WHERE invoice_id = $1 AND status = 'initiated'", [inv.id]);
    if (stillOpen.rows.length) {
      await pool.query("UPDATE invoice_payments SET status = 'canceled', updated_at = NOW() WHERE id = ANY($1::int[])", [stillOpen.rows.map(function (x) { return x.id; })]);
    }

    const nonce = square.newNonce();
    const platform = String((req.body && req.body.platform) || '').toLowerCase() === 'ios' ? 'ios' : (String((req.body && req.body.platform) || '').toLowerCase() === 'android' ? 'android' : null);
    const ins = await pool.query(
      'INSERT INTO invoice_payments (invoice_id, state_nonce, status, amount_requested_cents, square_location_id, platform, initiated_by) ' +
      "VALUES ($1,$2,'initiated',$3,$4,$5,$6) RETURNING id",
      [inv.id, nonce, cents, locationId, platform, req.user.id]
    );

    const state = square.signState(nonce, inv.id);
    const urls = square.buildPosUrls({
      amountCents: cents,
      note: 'Nova Invoice ' + inv.invoice_number,
      state: state,
      locationId: locationId,
      fallbackUrl: String(process.env.SQUARE_RETURN_BASE || process.env.APP_URL || '').replace(/\/+$/, '') + '/?view=view-invoice&id=' + inv.id + '&sq_missing=1'
    });

    try {
      await logAudit({
        entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number),
        action: 'square_payment_started', user_id: req.user.id, user_name: req.user.name,
        details: { amount_cents: cents, location_id: locationId }
      });
    } catch (e) {}

    res.json({
      payment_id: ins.rows[0].id,
      nonce: nonce,
      amount_cents: cents,
      location_id: locationId,
      city_code: code,
      android_url: urls.android,
      ios_url: urls.ios
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start the Square payment' });
  }
});

// Polled by the SPA after Square hands the browser back. Also does a lazy
// reconcile, so the common case resolves on the first poll without waiting for
// the webhook.
router.get('/:id/payment-status', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const inv = await pool.query('SELECT id, status, locksmith_id, grand_total, tip_amount, authorized_total FROM invoices WHERE id = $1', [req.params.id]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    if (!canSeeAll(req.user.role) && inv.rows[0].locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    let rowRes;
    if (req.query.nonce) {
      rowRes = await pool.query('SELECT * FROM invoice_payments WHERE invoice_id = $1 AND state_nonce = $2', [req.params.id, req.query.nonce]);
    } else {
      rowRes = await pool.query('SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1', [req.params.id]);
    }
    let row = rowRes.rows[0] || null;

    if (row && (row.status === 'returned' || row.status === 'offline_pending') && row.square_transaction_id) {
      try { await square.reconcilePayment(row.id); } catch (e) {}
      const again = await pool.query('SELECT * FROM invoice_payments WHERE id = $1', [row.id]);
      row = again.rows[0] || row;
    }

    const fresh = await pool.query('SELECT status, pay_type, card_last4, approval_code, tip_amount, grand_total, authorized_total FROM invoices WHERE id = $1', [req.params.id]);
    res.json({ payment: row ? scrubPaymentRow(row) : null, invoice: fresh.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read the payment status' });
  }
});

// Manual retry for a stuck row. Managers only — this is the escape hatch when
// the callback was lost AND the webhook never landed.
router.post('/:id/payments/:pid/reconcile', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  if (!canSeeAll(req.user.role)) return res.status(403).json({ error: 'Access denied' });
  try {
    const r = await pool.query('SELECT id FROM invoice_payments WHERE id = $1 AND invoice_id = $2', [req.params.pid, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Payment attempt not found' });
    const out = await square.reconcilePayment(r.rows[0].id);
    const again = await pool.query('SELECT * FROM invoice_payments WHERE id = $1', [r.rows[0].id]);
    res.json({ ok: !!out.ok, reason: out.reason || null, payment: scrubPaymentRow(again.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Reconcile failed' });
  }
});

// Give up on an attempt the tech backed out of, so the button comes back.
router.post('/:id/payments/:pid/cancel', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE invoice_payments SET status = 'canceled', updated_at = NOW() " +
      "WHERE id = $1 AND invoice_id = $2 AND status = 'initiated' RETURNING id",
      [req.params.pid, req.params.id]
    );
    res.json({ ok: !!r.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not cancel that attempt' });
  }
});

// ---- Invoice process: Active / Waiting for Payment / Completed -------------
//
// Field feedback was that "Completed" and "Paid" both read as a finish line, so
// techs picked whichever and the reports stopped meaning anything. There is now
// one finish line and one named branch:
//
//   Active -> Completed                 paid on the spot, or billed to an account
//   Active -> Waiting for Payment -> Completed
//
// ⚠️ The STORED values did not change. 'draft' displays as "Active" and 'paid'
// displays as "Completed"; only 'awaiting_payment' is new. LOCKED_STATUSES,
// refunds.status_before_refund, the Square narrow writer and the reconciliation
// query all key on 'paid'. Do not "tidy" this by renaming the stored values.

// How long the person who completed an invoice can put it back without help.
// Every user-facing message below derives from this, so changing it here is the
// only edit needed.
var COMPLETE_GRACE_MINUTES = 5;

// Pay types that are BILLED rather than collected, so an invoice on one of them
// finishes immediately instead of waiting for money nobody is going to chase.
async function billedPayTypes() {
  try {
    const raw = await getSetting('invoice_billed_pay_types', '["Account / Invoice","Motor Club"]');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return ['Account / Invoice', 'Motor Club'];
  }
}

function isBilledPayType(payType, list) {
  const p = String(payType || '').trim().toLowerCase();
  if (!p) return false;
  return (list || []).some(function (x) { return String(x).trim().toLowerCase() === p; });
}

// Everything that has to be true before an invoice can reach a finish line.
// Returned to the client so the button can show WHY it is disabled instead of
// failing after a save, which is how these gates behaved before.
function invoiceGates(inv, items) {
  const lines = (items || []).filter(function (i) { return i && String(i.description || '').trim(); });
  const g = [];
  g.push({ key: 'customer', label: 'Customer name', ok: !!String(inv.customer_name || '').trim(), detail: inv.customer_name || 'Missing' });
  g.push({ key: 'items', label: 'At least one line item', ok: lines.length > 0, detail: lines.length ? String(lines.length) : 'Missing' });
  g.push({ key: 'city', label: 'City, for sales tax', ok: !!inv.city_code, detail: inv.city_code || 'Missing' });
  if (inv.signature_required) {
    g.push({ key: 'signature', label: 'Signature (required by policy)', ok: !!inv.signature_image, detail: inv.signature_image ? 'Captured' : 'Not captured' });
  }
  g.push({ key: 'total', label: 'Invoice total', ok: (parseFloat(inv.grand_total) || 0) !== 0, detail: '$' + (parseFloat(inv.grand_total) || 0).toFixed(2) });
  return g;
}

function gatesPass(gates) {
  return gates.every(function (g) { return g.ok; });
}

// Seconds of reopen grace left, or 0. NULL completed_at (every invoice from
// before this shipped) means no grace, which is the safe direction.
function graceLeft(inv) {
  if (!inv.completed_at) return 0;
  const ms = COMPLETE_GRACE_MINUTES * 60000 - (Date.now() - new Date(inv.completed_at).getTime());
  return ms > 0 ? Math.floor(ms / 1000) : 0;
}

// The chase task closes itself the moment the invoice is settled. Without this
// you accumulate a graveyard of stale follow-ups and nobody trusts the list.
async function closeFollowupTask(inv, user) {
  if (!inv || !inv.followup_task_id) return;
  try {
    await pool.query(
      "UPDATE tasks SET status = 'done', completed_at = NOW(), completed_by = $1, updated_at = NOW() " +
      "WHERE id = $2 AND status <> 'done'",
      [(user && user.id) || null, inv.followup_task_id]
    );
  } catch (e) {
    console.error('Could not close invoice follow-up task ' + inv.followup_task_id + ':', e.message);
  }
}

// Who gets the FYI. The tech's supervisor, falling back to the city's primary
// manager, which is the same rule customer feedback already uses.
async function managerFor(userId, cityCode) {
  try {
    if (userId) {
      const u = await pool.query('SELECT supervisor_id FROM users WHERE id = $1', [userId]);
      const sup = u.rows[0] && u.rows[0].supervisor_id;
      if (sup) return sup;
    }
  } catch (e) {}
  try {
    if (cityCode) {
      const c = await pool.query('SELECT manager_user_id FROM cities WHERE UPPER(code) = UPPER($1)', [cityCode]);
      const m = c.rows[0] && c.rows[0].manager_user_id;
      if (m) return m;
    }
  } catch (e) {}
  return null;
}

// Move an invoice to the finish line. Shared by the Complete Invoice button, the
// status dropdown, and the Waiting-for-Payment screen.
router.post('/:id/complete', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    const inv = r.rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!canSeeAll(req.user.role) && inv.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (LOCKED_STATUSES.indexOf(inv.status) !== -1) {
      return res.status(409).json({ error: 'This invoice is already completed.' });
    }
    const items = (await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1', [inv.id])).rows;
    const gates = invoiceGates(inv, items);
    if (!gatesPass(gates)) {
      const missing = gates.filter(function (g) { return !g.ok; }).map(function (g) { return g.label.toLowerCase(); });
      return res.status(400).json({ error: 'Not finished yet: ' + missing.join(', ') + '.', gates: gates });
    }

    const b = req.body || {};
    const payType = String(b.pay_type || inv.pay_type || '').trim();
    if (!payType) {
      return res.status(400).json({ error: 'Say how this was paid before completing it.' });
    }
    const last4 = b.card_last4 != null ? String(b.card_last4).replace(/\D/g, '').slice(-4) : inv.card_last4;
    const approval = b.approval_code != null ? String(b.approval_code).trim() : inv.approval_code;
    // With surcharging on, an invoice cannot reach the finish line until somebody
    // has actually asked the customer. NULL pay_method is "not asked yet", which
    // is a different answer from Cash and must not be allowed to pass as one.
    if (await surchargeRate() > 0 && !normalizePayMethod(inv.pay_method)) {
      return res.status(400).json({
        error: 'Ask the customer Cash or Card first. Reopen invoice #' + inv.invoice_number + ' and pick one; Card adds the surcharge, Cash does not.',
        needs_pay_method: true
      });
    }

    const upd = await pool.query(
      "UPDATE invoices SET status = 'paid', pay_type = $1, card_last4 = $2, approval_code = $3, " +
      'completed_at = NOW(), completed_by = $4, waiting_since = NULL, ' +
      'authorized_total = COALESCE(authorized_total, grand_total), updated_at = NOW() ' +
      'WHERE id = $5 RETURNING *',
      [payType, last4 || null, approval || null, req.user.id, inv.id]
    );
    await closeFollowupTask(inv, req.user);
    try {
      await logAudit({
        entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number),
        action: 'completed', user_id: req.user.id, user_name: req.user.name,
        details: { pay_type: payType, total: inv.grand_total, from: inv.status }
      });
    } catch (e) {}
    res.json({ ok: true, invoice: upd.rows[0], grace_seconds: COMPLETE_GRACE_MINUTES * 60 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not complete the invoice' });
  }
});

// Park an invoice as Waiting for Payment and raise the chase task.
router.post('/:id/waiting', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    const inv = r.rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!canSeeAll(req.user.role) && inv.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (LOCKED_STATUSES.indexOf(inv.status) !== -1) {
      return res.status(409).json({ error: 'This invoice is already completed.' });
    }
    const items = (await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1', [inv.id])).rows;
    const gates = invoiceGates(inv, items);
    if (!gatesPass(gates)) {
      const missing = gates.filter(function (g) { return !g.ok; }).map(function (g) { return g.label.toLowerCase(); });
      return res.status(400).json({ error: 'Not finished yet: ' + missing.join(', ') + '.', gates: gates });
    }

    const b = req.body || {};
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.followup_date || '')) ? b.followup_date : null;
    if (!due) return res.status(400).json({ error: 'Pick a date for someone to chase this.' });
    const note = String(b.note || '').trim().slice(0, 2000);

    await pool.query(
      "UPDATE invoices SET status = 'awaiting_payment', waiting_since = COALESCE(waiting_since, NOW()), " +
      'completed_at = NULL, completed_by = NULL, updated_at = NOW() WHERE id = $1',
      [inv.id]
    );

    // One open chase task per invoice. Re-parking an invoice reuses the existing
    // task and just moves its date, rather than stacking duplicates on somebody.
    let taskId = inv.followup_task_id;
    let reused = false;
    if (taskId) {
      const t = await pool.query("SELECT id, status FROM tasks WHERE id = $1", [taskId]);
      if (t.rows.length && t.rows[0].status !== 'done') {
        await pool.query('UPDATE tasks SET due_date = $1, updated_at = NOW() WHERE id = $2', [due, taskId]);
        reused = true;
      } else {
        taskId = null;
      }
    }

    if (!taskId) {
      const assignee = inv.locksmith_id || req.user.id;
      const owed = (parseFloat(inv.grand_total) || 0).toFixed(2);
      const title = 'Collect $' + owed + ' on Invoice #' + inv.invoice_number + (inv.customer_name ? (' - ' + inv.customer_name) : '');
      const desc = (note ? (note + '\n\n') : '') + 'Invoice #' + inv.invoice_number + ' is waiting for payment. Open it in Nova to record the payment or run the card.';
      const topPos = (await pool.query("SELECT COALESCE(MIN(position),0)-1 AS p FROM tasks WHERE status = 'todo'")).rows[0].p;
      const ins = await pool.query(
        "INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, position) " +
        "VALUES ($1,$2,'todo','medium',$3,$4,$5,$6) RETURNING id",
        [title.slice(0, 255), desc, assignee, req.user.id, due, topPos]
      );
      taskId = ins.rows[0].id;

      const mgr = await managerFor(assignee, inv.city_code);
      if (mgr && mgr !== assignee) {
        try {
          await pool.query('INSERT INTO task_cc (task_id, user_id) VALUES ($1,$2) ON CONFLICT (task_id, user_id) DO NOTHING', [taskId, mgr]);
        } catch (e) {}
      }
      await pool.query('UPDATE invoices SET followup_task_id = $1 WHERE id = $2', [taskId, inv.id]);

      // Reuse the real task notification path rather than inventing a parallel
      // one, so this inherits the reminders and FYI emails that already exist.
      try { await notifyTaskAssigned(taskId); } catch (e) {}
      try { await notifyTaskCc(taskId); } catch (e) {}
    }

    try {
      await logAudit({
        entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number),
        action: 'waiting_for_payment', user_id: req.user.id, user_name: req.user.name,
        details: { followup_date: due, task_id: taskId, reused_task: reused }
      });
    } catch (e) {}

    const fresh = await pool.query('SELECT * FROM invoices WHERE id = $1', [inv.id]);
    res.json({ ok: true, invoice: fresh.rows[0], task_id: taskId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not set this invoice to Waiting for Payment' });
  }
});

// The 15-minute undo. Deliberately narrow: the person who completed it, inside
// the window. Everyone else still goes through an admin, exactly as before.
router.post('/:id/reopen', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    const inv = r.rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (LOCKED_STATUSES.indexOf(inv.status) === -1) {
      return res.status(400).json({ error: 'This invoice is not completed.' });
    }
    if (inv.status !== 'paid') {
      return res.status(409).json({ error: 'This invoice has refunds against it. Reopening it would strand them.' });
    }

    // Money that actually moved through Square cannot be walked back by flipping
    // a status. The refund flow exists for that and leaves a record.
    try {
      const sq = await pool.query("SELECT id FROM invoice_payments WHERE invoice_id = $1 AND status = 'reconciled'", [inv.id]);
      if (sq.rows.length) {
        return res.status(409).json({ error: 'A card was already run in Square for this invoice. Use a refund so there is a record.' });
      }
    } catch (e) { /* table may not exist yet on first deploy */ }

    const isAdmin = ['admin', 'owner'].indexOf(req.user.role) !== -1;
    const left = graceLeft(inv);
    const ownGrace = inv.completed_by === req.user.id && left > 0;
    if (!isAdmin && !ownGrace) {
      return res.status(403).json({
        error: inv.completed_by === req.user.id
          ? 'The ' + COMPLETE_GRACE_MINUTES + ' minutes to undo this has passed. Ask an admin.'
          : 'Only the person who completed this invoice can reopen it, and only for ' + COMPLETE_GRACE_MINUTES + ' minutes.'
      });
    }

    await pool.query(
      "UPDATE invoices SET status = 'draft', completed_at = NULL, completed_by = NULL, updated_at = NOW() WHERE id = $1",
      [inv.id]
    );
    try {
      await logAudit({
        entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number),
        action: 'reopened', user_id: req.user.id, user_name: req.user.name,
        details: { via: isAdmin && !ownGrace ? 'admin override' : 'grace period', seconds_after_completing: inv.completed_at ? Math.floor((Date.now() - new Date(inv.completed_at).getTime()) / 1000) : null }
      });
    } catch (e) {}
    const fresh = await pool.query('SELECT * FROM invoices WHERE id = $1', [inv.id]);
    res.json({ ok: true, invoice: fresh.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reopen the invoice' });
  }
});

// Split billing. One job, two invoices: an insurer or account covers part of it
// and the customer owes the rest.
//
// ⚠️ This SPLITS BY AMOUNT rather than duplicating the invoice, and that is the
// whole point. The month-end parts report and the COGS figure both sum
// invoice_line_items across every invoice in the period, so copying a $62 key
// onto a second invoice would order it twice next month and cost it twice on the
// P&L, with nothing to flag it because both invoices look normal on their own.
// Here the new invoice gets ONE labor line and no parts, so the key is costed
// exactly once by construction. Never "improve" this into a full duplicate.
router.post('/:id/split', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const client = await pool.connect();
  try {
    const r = await client.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    const inv = r.rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!canSeeAll(req.user.role) && inv.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (LOCKED_STATUSES.indexOf(inv.status) !== -1) {
      return res.status(409).json({ error: 'This invoice is completed. Split it before it is finished.' });
    }

    const b = req.body || {};
    const amount = Math.round((parseFloat(b.amount) || 0) * 100) / 100;
    const total = parseFloat(inv.grand_total) || 0;
    if (!(amount > 0)) return res.status(400).json({ error: 'Enter how much the account is covering.' });
    if (amount >= total) {
      return res.status(400).json({ error: 'That is the whole invoice. Change the account on this invoice instead of splitting it.' });
    }

    let accountId = b.account_id ? parseInt(b.account_id, 10) : null;
    let accountName = String(b.account_name || '').trim();
    if (accountId && !accountName) {
      const a = await client.query('SELECT name FROM vendors WHERE id = $1', [accountId]);
      accountName = (a.rows[0] && a.rows[0].name) || '';
    }
    if (!accountName) return res.status(400).json({ error: 'Say who is covering part of this.' });
    const desc = String(b.description || '').trim() || (accountName + ' portion');

    await client.query('BEGIN');

    // 1. Reduce the original with a visible, auditable negative LABOR line.
    //    Labor, not part, so it can never touch COGS or the parts report.
    //    Non-taxable on purpose: the taxable value of the sale did not change
    //    just because somebody else is paying part of it, so the tax stays whole
    //    across the pair. See the note to Tony if the accountant disagrees.
    const pos = (await client.query('SELECT COALESCE(MAX(position),0)+1 AS p FROM invoice_line_items WHERE invoice_id = $1', [inv.id])).rows[0].p;
    await client.query(
      "INSERT INTO invoice_line_items (invoice_id, line_type, description, quantity, unit_price, taxable, position) " +
      "VALUES ($1,'labor',$2,1,$3,false,$4)",
      [inv.id, ('Less ' + accountName + ' portion').slice(0, 500), -amount, pos]
    );

    // 2. The account's invoice: one labor line, no parts, no cost, no signature.
    const newNumber = await generateInvoiceNumber(inv.city_code);
    const groupId = inv.split_group_id || inv.id;
    const ni = await client.query(
      'INSERT INTO invoices (invoice_number, locksmith_id, locksmith_name, invoice_date, status, account_id, account_name, ' +
      'customer_po_wo, pay_type, customer_name, street_address, city, state, zip, phone, email, ' +
      'vehicle_year, vehicle_make, vehicle_model, license_tag, tag_state, vin, mileage, ' +
      "tax_rate, labor_amount, parts_amount, subtotal, tax_amount, tip_amount, grand_total, " +
      'agreement_text, signature_required, city_code, split_group_id, split_parent_id, notes) ' +
      "VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,0,$23,0,$23,0,0,$23,$24,false,$25,$26,$27,$28) RETURNING *",
      [
        newNumber, inv.locksmith_id, inv.locksmith_name, inv.invoice_date,
        accountId, accountName, inv.customer_po_wo,
        // Billed, so it finishes without anybody chasing a customer.
        'Account / Invoice',
        inv.customer_name, inv.street_address, inv.city, inv.state, inv.zip, inv.phone, inv.email,
        inv.vehicle_year, inv.vehicle_make, inv.vehicle_model, inv.license_tag, inv.tag_state, inv.vin, inv.mileage,
        amount, inv.agreement_text, inv.city_code, groupId, inv.id,
        'Split from Invoice #' + inv.invoice_number + '. ' + accountName + ' portion of the same job.'
      ]
    );
    const child = ni.rows[0];
    await client.query(
      "INSERT INTO invoice_line_items (invoice_id, line_type, description, quantity, unit_price, taxable, position) " +
      "VALUES ($1,'labor',$2,1,$3,false,0)",
      [child.id, desc.slice(0, 500), amount]
    );

    // 3. Point the original at the pair and rebuild its totals from its lines.
    await client.query('UPDATE invoices SET split_group_id = $1 WHERE id = $2', [groupId, inv.id]);
    const freshItems = (await client.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1', [inv.id])).rows;
    // Recompute the surcharge off THIS invoice's own stored rate, not the current
    // company setting. The original was quoted under a rate and a payment method,
    // and splitting it is not a re-quote — only the base it applies to shrank.
    const t = computeTotals(freshItems, inv.tax_rate, inv.tip_amount, inv.tax_exempt === true,
      inv.pay_method, inv.surcharge_rate);
    await client.query(
      'UPDATE invoices SET labor_amount=$1, parts_amount=$2, subtotal=$3, tax_amount=$4, tip_amount=$5, grand_total=$6, ' +
      'parts_cost_total=$7, cogs_incomplete=$8, surcharge_amount=$10, updated_at=NOW() WHERE id=$9',
      [t.labor, t.parts, t.subtotal, t.tax_amount, t.tip, t.grand_total, t.parts_cost, t.cogs_incomplete, inv.id, t.surcharge]
    );

    await client.query('COMMIT');

    try {
      await logAudit({
        entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number),
        action: 'split', user_id: req.user.id, user_name: req.user.name,
        details: { amount: amount, account: accountName, new_invoice_id: child.id, new_invoice_number: child.invoice_number }
      });
    } catch (e) {}

    const orig = await pool.query('SELECT * FROM invoices WHERE id = $1', [inv.id]);
    res.status(201).json({ ok: true, original: orig.rows[0], created: child });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error(err);
    res.status(500).json({ error: 'Could not split the invoice' });
  } finally {
    client.release();
  }
});

router.put('/:id', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  try {
    const cur = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const existing = cur.rows[0];
    if (!canSeeAll(req.user.role) && existing.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // A paid invoice is frozen. The customer signed a specific set of numbers and
    // the Square dispute packet is built from them, so the way to change the money
    // after the fact is a refund, not a quiet edit. Admins keep an override for
    // genuine data fixes (typo in a phone number, wrong VIN) and every edit is
    // still audited.
    if (LOCKED_STATUSES.indexOf(existing.status) !== -1 && ['admin', 'owner'].indexOf(req.user.role) === -1) {
      return res.status(403).json({
        error: 'This invoice is ' + existing.status.split('_').join(' ') + ' and is locked. Use Issue Refund to change what the customer was charged, or ask an admin to correct a typo.'
      });
    }
    const b = req.body || {};
    const f = pickInvoiceFields(b);
    let status = ['draft', 'awaiting_payment', 'paid'].indexOf(b.status) !== -1 ? b.status : existing.status;
    // An admin correcting a refunded invoice must not knock the refund status off
    // it: partially_refunded / refunded are derived from the ledger, not chosen in
    // the form, so they are held here whatever the client sent.
    const _refunded = parseFloat(existing.refunded_total) || 0;
    if (_refunded > 0) status = existing.status;
    if (f.signature_required && status !== 'draft' && !f.signature_image) {
      return res.status(400).json({ error: 'A signature is required before this invoice can be marked ' + status + '. Save as draft, or capture a signature.' });
    }
    for (const it of (b.line_items || [])) {
      if (!it || !it.description) continue;
      if (it.quantity != null && it.quantity !== '' && !(parseFloat(it.quantity) > 0)) return res.status(400).json({ error: 'Line item quantity must be greater than 0' });
      if (it.unit_price != null && it.unit_price !== '' && !(parseFloat(it.unit_price) >= 0)) return res.status(400).json({ error: 'Line item unit price must be 0 or greater' });
    }
    // Same close-out gate as create: no non-draft invoice without a COGS figure.
    const _missing = status !== 'draft' ? missingCostLines(b.line_items) : [];
    if (_missing.length) {
      return res.status(400).json({
        error: 'Cost is missing on ' + _missing.length + ' part line' + (_missing.length === 1 ? '' : 's') + '.',
        cogs_missing: _missing
      });
    }
    const tax_rate = parseFloat(b.tax_rate) || 0;
    // pay_method comes from the close-out popup. An absent key means "leave it
    // alone" (a partial save from some other screen must not silently wipe the
    // customer's answer and drop the surcharge); an explicit null clears it.
    const pay_method = Object.prototype.hasOwnProperty.call(b, 'pay_method')
      ? normalizePayMethod(b.pay_method)
      : normalizePayMethod(existing.pay_method);
    // Reuse the rate this invoice was already quoted under. Only a job that has
    // never carried a surcharge picks up the current company rate, so an admin
    // changing the setting mid-shift cannot re-price a job in progress.
    const _existingRate = parseFloat(existing.surcharge_rate) || 0;
    const sur_rate = _existingRate > 0 ? _existingRate : await surchargeRate();
    const t = computeTotals(b.line_items, tax_rate, b.tip_amount, b.tax_exempt === true, pay_method, sur_rate);
    // Never let an edit drop the invoice below what has already been given back,
    // which would leave a refund larger than the sale it came from.
    if (_refunded > 0 && t.grand_total < _refunded - 0.005) {
      return res.status(400).json({
        error: 'This invoice already has ' + _refunded.toFixed(2) + ' refunded against it, so it cannot be edited down to ' + t.grand_total.toFixed(2) + '. Void a refund first.'
      });
    }
    const invoice_date = b.invoice_date || existing.invoice_date;
    // Preserve original sign time; set it the first time a signature appears.
    let signedAt = existing.signed_at;
    if (f.signature_image && !existing.signed_at) signedAt = new Date();
    if (!f.signature_image) signedAt = existing.signed_at; // keep
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE invoices SET completed_at = CASE WHEN $42::text = \'paid\' AND status <> \'paid\' THEN NOW() WHEN $42::text <> \'paid\' THEN NULL ELSE completed_at END, ' +
        'completed_by = CASE WHEN $42::text = \'paid\' AND status <> \'paid\' THEN $51::int WHEN $42::text <> \'paid\' THEN NULL ELSE completed_by END, ' +
        'waiting_since = CASE WHEN $42::text = \'awaiting_payment\' THEN COALESCE(waiting_since, NOW()) ELSE NULL END, ' +
        'account_id=$1, account_name=$2, customer_po_wo=$3, pay_type=$4, card_last4=$5, cc_online=$6, time_in=$7, time_out=$8, customer_name=$9, dl_number=$10, dl_state=$11, street_address=$12, city=$13, state=$14, zip=$15, phone=$16, email=$17, vehicle_year=$18, vehicle_make=$19, vehicle_model=$20, license_tag=$21, tag_state=$22, vin=$23, mileage=$24, ent_registration=$25, ent_insurance=$26, ent_title=$27, ent_rental=$28, tax_rate=$29, labor_amount=$30, parts_amount=$31, subtotal=$32, tax_amount=$33, tip_amount=$34, grand_total=$35, notes=$36, payments_note=$37, agreement_text=$38, signature_image=$39, signed_name=$40, signed_at=$41, status=$42, invoice_date=$43, approval_code=$44, tax_exempt=$45, signature_required=$46, city_code=$47, parts_cost_total=$48, cogs_incomplete=$49, surcharge_amount=$52, surcharge_rate=$53, pay_method=$54, updated_at=NOW() WHERE id=$50',
        [f.account_id, f.account_name, f.customer_po_wo, f.pay_type, f.card_last4, f.cc_online, f.time_in, f.time_out, f.customer_name, f.dl_number, f.dl_state, f.street_address, f.city, f.state, f.zip, f.phone, f.email, f.vehicle_year, f.vehicle_make, f.vehicle_model, f.license_tag, f.tag_state, f.vin, f.mileage, f.ent_registration, f.ent_insurance, f.ent_title, f.ent_rental, tax_rate, t.labor, t.parts, t.subtotal, t.tax_amount, t.tip, t.grand_total, f.notes, f.payments_note, f.agreement_text, f.signature_image, f.signed_name, signedAt, status, invoice_date, f.approval_code, f.tax_exempt, f.signature_required, f.city_code, t.parts_cost, t.cogs_incomplete, req.params.id, req.user.id, t.surcharge, t.surcharge_rate, pay_method]
      );
      // An edit rewrites the line items wholesale: delete, then re-insert with
      // fresh ids. invoice_refund_lines.invoice_line_item_id is ON DELETE SET
      // NULL, so every refund silently loses its link to the line it came from —
      // which, now that COGS subtracts restocked parts, means a restocked part
      // quietly climbs back into cost of goods the first time anyone fixes a typo.
      // Capture the links before the delete and re-point them afterwards.
      let _refLinks = [];
      try {
        _refLinks = (await client.query(
          'SELECT l.id AS refund_line_id, li.position, li.description ' +
          '  FROM invoice_refund_lines l JOIN invoice_line_items li ON li.id = l.invoice_line_item_id ' +
          ' WHERE li.invoice_id = $1',
          [req.params.id]
        )).rows;
      } catch (e) { _refLinks = []; }
      await client.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [req.params.id]);
      await insertLineItems(client, parseInt(req.params.id, 10), b.line_items);
      if (_refLinks.length) {
        try {
          const fresh = (await client.query('SELECT id, position, description FROM invoice_line_items WHERE invoice_id = $1', [req.params.id])).rows;
          const byKey = {};
          fresh.forEach(function (n) { byKey[n.position + ' ' + n.description] = n.id; });
          for (const link of _refLinks) {
            // Match on position AND description. If the tech reworded or removed
            // the line, leave the refund unlinked rather than attach it to
            // whatever now happens to sit in that slot.
            const newId = byKey[link.position + ' ' + link.description];
            if (newId) await client.query('UPDATE invoice_refund_lines SET invoice_line_item_id = $1 WHERE id = $2', [newId, link.refund_line_id]);
          }
        } catch (e) { console.error('Could not re-link refund lines after invoice edit:', e.message); }
      }
      // The new total may have turned a partial refund into a full one (or back).
      if (_refunded > 0) {
        await client.query(
          "UPDATE invoices SET status = CASE WHEN $1 >= grand_total - 0.005 THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $2",
          [_refunded, req.params.id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }
    client.release();
    try { await logAudit({ entity_type: 'invoice', entity_id: parseInt(req.params.id, 10), entity_number: String(existing.invoice_number), action: 'edited', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    await auditCostOverrides(b.line_items, parseInt(req.params.id, 10), existing.invoice_number, req.user);
    // Replace/store the scanned ID photo if a new one was captured this edit.
    let idImageSaved = null;
    if (b.id_image) {
      try { const _idr = await storeIdImage(parseInt(req.params.id, 10), b.id_image, req.user.id); idImageSaved = _idr.saved; }
      catch (e) { console.error('ID image save (update) failed:', e); idImageSaved = false; }
    }
    res.json({ success: true, id: parseInt(req.params.id, 10), id_image_saved: idImageSaved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

router.delete('/:id', requireAuth, requirePermission('delete_invoice'), async (req, res) => {
  try {
    const cur = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const existing = cur.rows[0];
    if (!canSeeAll(req.user.role) && existing.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // An invoice with live refunds against it is part of the money trail; deleting
    // it would take the refund history with it (ON DELETE CASCADE).
    const _refs = await pool.query(
      "SELECT COUNT(*)::int AS n FROM invoice_refunds WHERE invoice_id = $1 AND status IN ('requested', 'approved', 'processed')",
      [req.params.id]
    );
    if (_refs.rows[0].n > 0) {
      return res.status(409).json({ error: 'This invoice has ' + _refs.rows[0].n + ' refund(s) on it. Void the refunds first if this invoice really needs to go.' });
    }
    // Remove the private ID image from R2 too (the DB row is cascade-deleted).
    if (existing.id_image_r2_key && r2.configured()) { try { await r2.deleteObject(existing.id_image_r2_key); } catch (e) {} }
    await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    try { await logAudit({ entity_type: 'invoice', entity_id: existing.id, entity_number: String(existing.invoice_number), action: 'deleted', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

module.exports = router;
