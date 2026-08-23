const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');

// A quote line is either labor we perform or a part we buy. Anything unrecognised
// is treated as a part, which is the conservative default everywhere downstream.
function normLineType(v) { return String(v || '').trim().toLowerCase() === 'labor' ? 'labor' : 'part'; }
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const notify = require('../utils/notify');
const push = require('../utils/push');

const router = express.Router();
const pub = express.Router();          // customer-facing token surface, no JWT

// ===================== Customer approval helpers =====================
// The customer never logs in. Everything they can reach hangs off a random
// 64-char token that lives on the quote row, exactly like the signer tokens in
// routes/signatures.js. See server.js for where `pub` is mounted.

const APPROVAL_STATUSES = ['draft', 'sent', 'viewed', 'approved', 'declined', 'changes_requested', 'expired'];

// A quote is "out" once it has been sent: the customer may be looking at it, so
// its numbers must not move under them. Draft is the only freely editable state.
function isOut(status) { return !!status && status !== 'draft'; }

// A quote that has already been answered. These never accept a second answer.
function isAnswered(status) { return status === 'approved' || status === 'declined'; }

function appBase() { return (process.env.APP_URL || '').replace(/\/$/, ''); }
function quoteLink(token) { return appBase() + '/quote/' + token; }

function newApprovalToken() { return crypto.randomBytes(32).toString('hex'); }

function clientIp(req) {
  var raw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  return String(raw).slice(0, 64);
}

async function logQuoteEvent(quoteId, eventType, opts) {
  var o = opts || {};
  try {
    await pool.query(
      'INSERT INTO quote_events (quote_id, event_type, actor_name, ip, user_agent, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [quoteId, eventType, o.actorName || null,
       o.req ? clientIp(o.req) : null,
       o.req ? String(o.req.headers['user-agent'] || '').slice(0, 500) : null,
       o.details ? JSON.stringify(o.details) : null]
    );
  } catch (e) { console.error('[quotes] event log failed:', e.message); }
}

// Totals are recomputed from the line items rather than read off the row, so a
// customer can never be shown a total that drifted from what is on the page.
// Mirrors the math in POST / PUT above and in printQuote() on the frontend.
function quoteTotals(items, taxRate) {
  var rate = parseFloat(taxRate) || 0;
  var subtotal = 0, taxable = 0;
  (items || []).forEach(function (it) {
    var line = (parseFloat(it.quantity) || 0) * (parseFloat(it.list_price) || 0);
    subtotal += line;
    if (it.taxable) taxable += line;
  });
  var tax = taxable * rate / 100;
  return { subtotal: subtotal, tax_rate: rate, tax_amount: tax, total: subtotal + tax };
}

// The ONLY shape that ever reaches a customer. A whitelist, never SELECT *.
//
// Deliberately absent: unit_price (OUR COST), item_number, manufacturer, url,
// requester_id, city_code, and every internal id. That matches exactly what
// printQuote() already puts in front of a customer today - description,
// quantity, list price, line total - and nothing more.
function publicQuotePayload(quote, items, settings) {
  var t = quoteTotals(items, quote.tax_rate);
  return {
    quote_number: quote.quote_number,
    status: quote.status,
    customer_name: quote.customer_name,
    customer_street: quote.customer_street,
    customer_city: quote.customer_city,
    customer_state: quote.customer_state,
    customer_zip: quote.customer_zip,
    customer_phone: quote.customer_phone,
    customer_email: quote.customer_email,
    notes: quote.notes,
    important_info: quote.important_info,
    message: quote.customer_message,
    created_at: quote.created_at,
    sent_at: quote.sent_at,
    expires_at: quote.token_expires_at,
    responded_at: quote.responded_at,
    approver_name: quote.approver_name,
    approver_title: quote.approver_title,
    approved_total: quote.approved_total == null ? null : parseFloat(quote.approved_total),
    decline_reason: quote.decline_reason,
    prepared_by: { name: quote.requester_name || null, email: quote.requester_email || null, phone: quote.requester_phone || null },
    company: settings || {},
    subtotal: t.subtotal,
    tax_rate: t.tax_rate,
    tax_amount: t.tax_amount,
    total: t.total,
    line_items: (items || []).map(function (it) {
      return {
        description: it.description,
        quantity: parseFloat(it.quantity) || 0,
        list_price: parseFloat(it.list_price) || 0,
        taxable: !!it.taxable,
        line_type: normLineType(it.line_type)
      };
    })
  };
}

// The company header fields the customer page renders. Same whitelist the
// authenticated /api/settings exposes to non-admins.
async function publicCompanySettings() {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('logo','company_name','company_phone','company_address','company_city_state_zip')"
    );
    var out = {};
    rows.forEach(function (r) { out[r.key] = r.value; });
    return out;
  } catch (e) { return {}; }
}

// The name a CUSTOMER sees, from Settings. One field drives the email header,
// the SMS, the approval page and the email sender's display name, so a franchise
// name change is not a code edit. Internal Nova notifications are untouched -
// they keep using emailTemplate's own default.
const DEFAULT_BRAND = 'Lock and Roll LLC';
async function customerBrand() {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'company_name'");
    const v = rows.length ? String(rows[0].value || '').trim() : '';
    return v || DEFAULT_BRAND;
  } catch (e) { return DEFAULT_BRAND; }
}

// The sender Resend is handed. QUOTE_FROM_EMAIL is an env var and not a setting
// because the DOMAIN has to be verified in Resend before it will send at all -
// that is a DNS decision, not something to change from a text box. The display
// NAME in front of it is free, so when no override is set we keep FROM_EMAIL's
// verified address and put the Settings brand in front of it. That means the
// name a customer sees can change today, with no DNS work.
function quoteFromAddress(brand) {
  if (process.env.QUOTE_FROM_EMAIL) return process.env.QUOTE_FROM_EMAIL;
  const base = process.env.FROM_EMAIL || '';
  const m = base.match(/<([^>]+)>/);
  const addr = m ? m[1] : base.trim();
  if (!addr) return undefined;
  return brand + ' <' + addr + '>';
}

// Customer SMS wording lives in Settings so it can be changed without a deploy.
// Tokens match the {brace} convention already used by recurring tasks and
// scheduled messages (see utils/messageTokens.js).
const DEFAULT_QUOTE_SMS = '{company}: your quote {quote_number} for {total} is ready to review and approve. {link}';
const SMS_TOKENS = ['company', 'customer', 'quote_number', 'total', 'link', 'prepared_by', 'expires'];

async function quoteSmsTemplate() {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'quote_sms_template'");
    const v = rows.length ? String(rows[0].value || '').trim() : '';
    return v || DEFAULT_QUOTE_SMS;
  } catch (e) { return DEFAULT_QUOTE_SMS; }
}

function renderQuoteSms(template, vals) {
  var out = String(template || DEFAULT_QUOTE_SMS).replace(/\{(\w+)\}/g, function (m, key) {
    return Object.prototype.hasOwnProperty.call(vals, key) ? String(vals[key] == null ? '' : vals[key]) : m;
  });
  // A quote text without the link is a dead end, so the link is appended when
  // the template forgot it rather than sending something the customer cannot act on.
  if (vals.link && out.indexOf(vals.link) === -1) out = out.replace(/\s*$/, '') + ' ' + vals.link;
  // One segment is 160 chars; the link eats ~70 of them. Trim the PROSE, never
  // the link, so an over-long template degrades instead of breaking.
  const MAX = 320;
  if (out.length > MAX && vals.link) {
    const tail = ' ' + vals.link;
    out = out.slice(0, Math.max(0, MAX - tail.length)).replace(/\s+\S*$/, '') + tail;
  }
  return out;
}

// Everything a customer SMS can say about one quote.
function quoteSmsVars(quote, items, brand) {
  const t = quoteTotals(items, quote.tax_rate);
  return {
    company: brand,
    customer: quote.customer_name || '',
    quote_number: quote.quote_number,
    total: '$' + t.total.toFixed(2),
    link: quoteLink(quote.approval_token),
    prepared_by: quote.requester_name || brand,
    expires: quote.token_expires_at
      ? new Date(quote.token_expires_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' })
      : ''
  };
}

// Load a quote by token and decide whether it is still usable. Returns
// { quote, items, expired } or null when the token matches nothing.
async function loadByToken(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return null;
  const { rows } = await pool.query(
    'SELECT q.*, u.name AS requester_name, u.email AS requester_email, u.phone AS requester_phone ' +
    'FROM quotes q JOIN users u ON q.requester_id = u.id WHERE q.approval_token = $1',
    [token]
  );
  if (!rows.length) return null;
  const quote = rows[0];
  const { rows: items } = await pool.query('SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY id', [quote.id]);
  var expired = quote.status === 'expired' ||
    (!isAnswered(quote.status) && quote.token_expires_at && new Date(quote.token_expires_at) < new Date());
  return { quote: quote, items: items, expired: expired };
}

function getInitials(name) {
  return name.split(' ').filter(Boolean).map(function(p) { return p[0]; }).join('').toUpperCase().slice(0, 3);
}

async function generateQuoteNumber(userInitials) {
  const year = new Date().getFullYear();
  const prefix = 'QT-' + year + '-%';
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(quote_number, '-', 3) AS INTEGER)) as maxseq FROM quotes WHERE quote_number LIKE $1",
    [prefix]
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'QT-' + year + '-' + seq + '-' + userInitials;
}

// Normalize the optional customer-contact fields captured on a quote. These
// carry over to the invoice on push-to-invoice, so we keep the same shape and
// length limits as the matching invoices table columns.
function pickCustomerContact(b) {
  return {
    customer_street: b.customer_street ? String(b.customer_street).trim().slice(0, 255) : null,
    customer_city: b.customer_city ? String(b.customer_city).trim().slice(0, 120) : null,
    customer_state: b.customer_state ? String(b.customer_state).trim().toUpperCase().slice(0, 4) : null,
    customer_zip: b.customer_zip ? String(b.customer_zip).trim().slice(0, 12) : null,
    customer_phone: b.customer_phone ? String(b.customer_phone).trim().slice(0, 50) : null,
    customer_email: b.customer_email ? String(b.customer_email).trim().slice(0, 255) : null
  };
}

// The list payload already carries notes / important_info / customer_* via q.*,
// so the only thing the browser cannot see is the line items. Roll those up
// into one column here so a dashboard search for a part number, manufacturer
// or item description finds the quote.
const ITEMS_JOIN =
  " LEFT JOIN (SELECT quote_id," +
  "   string_agg(COALESCE(item_number,'') || ' ' || COALESCE(manufacturer,'') || ' ' || COALESCE(description,''), ' ') AS items_text," +
  "   COUNT(*) AS item_count" +
  "  FROM quote_line_items GROUP BY quote_id) li ON li.quote_id = q.id";

const LIST_SELECT =
  "SELECT q.*, u.name as requester_name," +
  " COALESCE(li.items_text, '') AS items_text," +
  " COALESCE(li.item_count, 0)::int AS item_count" +
  " FROM quotes q JOIN users u ON q.requester_id = u.id" + ITEMS_JOIN;

// Escape LIKE wildcards so a customer name containing _ or % does not turn into
// a wildcard match. Postgres LIKE/ILIKE uses backslash as the escape by default.
function likeTerm(s) {
  return '%' + String(s).replace(/([\\%_])/g, '\\$1') + '%';
}

// Who reads quotes team-wide vs. only their own. Admins and managers always have,
// and as of 2026-08-05 locksmith coordinators do too: the role exists to coordinate
// the locksmiths, so it needs to see the whole team's quotes, not just its own
// (Tony's call). READ scope only. Editing or deleting someone else's quote stays
// admin-only below, exactly as it already is for managers.
function canSeeAllQuotes(role) {
  return role === 'admin' || role === 'manager' || role === 'locksmith_coordinator';
}

// GET all quotes (own only, unless you can see all; see canSeeAllQuotes)
router.get('/', requireAuth, requirePermission('view_quotes'), async (req, res) => {
  try {
    let query, params;
    if (canSeeAllQuotes(req.user.role)) {
      query = LIST_SELECT + ' ORDER BY q.created_at DESC';
      params = [];
    } else {
      query = LIST_SELECT + ' WHERE q.requester_id = $1 ORDER BY q.created_at DESC';
      params = [req.user.id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});

// GET /search?q=...&limit=20 - server-side search used by the global command
// palette, and by anything else that needs to find a quote without loading the
// whole dashboard. MUST stay registered above '/:id', otherwise Express reads
// 'search' as a quote id.
router.get('/search', requireAuth, requirePermission('view_quotes'), async (req, res) => {
  try {
    const term = String(req.query.q || '').trim();
    if (term.length < 2) return res.json([]);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const params = [likeTerm(term)];

    // Phone numbers are stored however the tech typed them, so once the term
    // looks like a phone number compare on digits only.
    const digits = term.replace(/[^0-9]/g, '');
    let phoneClause = '';
    if (digits.length >= 7) {
      params.push('%' + digits + '%');
      phoneClause = " OR regexp_replace(COALESCE(q.customer_phone,''), '[^0-9]', '', 'g') LIKE $" + params.length;
    }

    let scope = '';
    if (!canSeeAllQuotes(req.user.role)) {
      params.push(req.user.id);
      scope = ' AND q.requester_id = $' + params.length;
    }
    params.push(limit);

    const { rows } = await pool.query(
      'SELECT q.id, q.quote_number, q.customer_name, q.city_code, q.total_amount, q.created_at,' +
      ' u.name AS requester_name' +
      ' FROM quotes q JOIN users u ON q.requester_id = u.id' +
      ' WHERE (' +
      '   q.quote_number ILIKE $1 OR q.customer_name ILIKE $1 OR q.city_code ILIKE $1' +
      '   OR u.name ILIKE $1 OR q.notes ILIKE $1 OR q.important_info ILIKE $1' +
      '   OR q.customer_phone ILIKE $1 OR q.customer_email ILIKE $1' +
      '   OR q.customer_street ILIKE $1 OR q.customer_city ILIKE $1' +
      '   OR q.customer_state ILIKE $1 OR q.customer_zip ILIKE $1' +
      '   OR EXISTS (SELECT 1 FROM quote_line_items li WHERE li.quote_id = q.id' +
      '     AND (li.item_number ILIKE $1 OR li.manufacturer ILIKE $1 OR li.description ILIKE $1))' +
      phoneClause +
      ' )' + scope +
      ' ORDER BY q.created_at DESC LIMIT $' + params.length,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Quote search failed' });
  }
});

// GET single quote with line items and requester contact info
router.get('/:id', requireAuth, requirePermission('view_quotes'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT q.*, u.name as requester_name, u.email as requester_email, u.phone as requester_phone FROM quotes q JOIN users u ON q.requester_id = u.id WHERE q.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (!canSeeAllQuotes(req.user.role) && quote.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows: items } = await pool.query(
      'SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY id',
      [req.params.id]
    );
    quote.line_items = items;
    res.json(quote);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// POST create quote
router.post('/', requireAuth, requirePermission('create_quote'), async (req, res) => {
  const { customer_name, city_code, notes, important_info, tax_rate, line_items } = req.body;
  const cc = pickCustomerContact(req.body);
  if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
  for (const item of (line_items || [])) {
    if (!(parseFloat(item.quantity) > 0)) return res.status(400).json({ error: 'Line item quantity must be greater than 0' });
    if (item.unit_price != null && item.unit_price !== '' && !(parseFloat(item.unit_price) >= 0)) return res.status(400).json({ error: 'Line item unit price must be 0 or greater' });
    if (item.list_price != null && item.list_price !== '' && !(parseFloat(item.list_price) >= 0)) return res.status(400).json({ error: 'Line item list price must be 0 or greater' });
  }
  const initials = getInitials(req.user.name);
  const taxRateVal = parseFloat(tax_rate) || 0;
  const subtotal = (line_items || []).reduce(function(sum, item) {
    return sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0));
  }, 0);
  const taxableSubtotal = (line_items || []).reduce(function(sum, item) {
    return item.taxable ? sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0)) : sum;
  }, 0);
  const tax_amount = taxableSubtotal * taxRateVal / 100;
  const total = subtotal + tax_amount;

  for (var attempt = 0; attempt < 10; attempt++) {
    const quote_number = await generateQuoteNumber(initials);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'INSERT INTO quotes (quote_number, requester_id, customer_name, city_code, notes, important_info, tax_rate, tax_amount, total_amount, customer_street, customer_city, customer_state, customer_zip, customer_phone, customer_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
        [quote_number, req.user.id, customer_name, city_code || null, notes || null, important_info || null, taxRateVal, tax_amount, total, cc.customer_street, cc.customer_city, cc.customer_state, cc.customer_zip, cc.customer_phone, cc.customer_email]
      );
      const quote = rows[0];
      for (const item of (line_items || [])) {
        await client.query(
          'INSERT INTO quote_line_items (quote_id, item_number, manufacturer, description, quantity, unit_price, list_price, taxable, url, line_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [quote.id, item.item_number || null, item.manufacturer || null, item.description, item.quantity, item.unit_price || 0, item.list_price || 0, item.taxable || false, item.url || null, normLineType(item.line_type)]
        );
      }
      await client.query('COMMIT');
      client.release();
      try { await logAudit({ entity_type: 'quote', entity_id: quote.id, entity_number: quote_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { customer: customer_name, total } }); } catch(e) {}
      try {
        const _q = await notify.broadcastRecipients('quote_created', "role IN ('admin', 'owner')");
        await push.sendPushToUsers(_q.userIds, { title: 'New quote', body: req.user.name + ' created a new quote.', url: '/' });
        const emailAdmins = _q.emails;
        const smsAdmins = _q.phones;
        if (emailAdmins.length) {
          const emails = emailAdmins;
          const html = emailTemplate({
            badge: 'New quote', title: 'A new quote has been created',
            body: '<strong>' + req.user.name + '</strong> created a new quote.',
            details: [
              { label: 'Quote number', value: quote_number },
              { label: 'Customer', value: customer_name },
              { label: 'City', value: city_code || '—' },
              { label: 'Total', value: '$' + total.toFixed(2) },
              { label: 'Created by', value: req.user.name }
            ],
            buttonText: 'View Quote',
            buttonUrl: (process.env.APP_URL || '').replace(/\/$/, '') + '/?view=view-quote&id=' + quote.id
          });
          await sendEmail(emails, 'New Quote: ' + quote_number, html);
        }
        if (smsAdmins.length) {
          const phones = smsAdmins;
          await sendSms(phones, 'Lock & Roll: ' + req.user.name + ' created quote ' + quote_number + ' for ' + customer_name + '. Total: $' + total.toFixed(2) + '. ' + ((process.env.APP_URL || '').replace(/\/$/, '') + '/?view=view-quote&id=' + quote.id));
        }
      } catch(e) { console.error('Quote email/SMS failed:', e); }
      return res.status(201).json(quote);
    } catch (err) {
      await client.query('ROLLBACK').catch(function(){});
      client.release();
      // Retry on duplicate quote number
      if (err.code === '23505' && err.constraint === 'quotes_quote_number_key' && attempt < 9) continue;
      console.error(err);
      return res.status(500).json({ error: 'Failed to create quote: ' + err.message });
    }
  }
});

// PUT update quote
router.put('/:id', requireAuth, requirePermission('edit_quote'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (req.user.role !== 'admin' && quote.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // A sent quote is read-only. The customer may have the page open right now,
    // so the numbers must not move under them. Editing is still allowed, but it
    // is an explicit act that VOIDS the link they were sent - the frontend turns
    // this 409 into the "this will void the link you sent <name>" confirm.
    if (isOut(quote.status) && !req.body.confirm_void) {
      return res.status(409).json({
        error: 'quote_is_out',
        status: quote.status,
        sent_to: quote.sent_to || quote.customer_email || null,
        message: 'This quote has already been sent to the customer. Editing it will void the link they were sent and put the quote back in draft.'
      });
    }
    const { customer_name, city_code, notes, important_info, tax_rate, line_items } = req.body;
    const cc = pickCustomerContact(req.body);
    if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
    for (const item of (line_items || [])) {
      if (!(parseFloat(item.quantity) > 0)) return res.status(400).json({ error: 'Line item quantity must be greater than 0' });
      if (item.unit_price != null && item.unit_price !== '' && !(parseFloat(item.unit_price) >= 0)) return res.status(400).json({ error: 'Line item unit price must be 0 or greater' });
      if (item.list_price != null && item.list_price !== '' && !(parseFloat(item.list_price) >= 0)) return res.status(400).json({ error: 'Line item list price must be 0 or greater' });
    }
    const taxRateVal = parseFloat(tax_rate) || 0;
    const subtotal = (line_items || []).reduce(function(sum, item) {
      return sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0));
    }, 0);
    const taxableSubtotal = (line_items || []).reduce(function(sum, item) {
      return item.taxable ? sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0)) : sum;
    }, 0);
    const tax_amount = taxableSubtotal * taxRateVal / 100;
    const total = subtotal + tax_amount;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE quotes SET customer_name=$1, city_code=$2, notes=$3, important_info=$4, tax_rate=$5, tax_amount=$6, total_amount=$7, customer_street=$8, customer_city=$9, customer_state=$10, customer_zip=$11, customer_phone=$12, customer_email=$13, updated_at=NOW() WHERE id=$14',
        [customer_name, city_code || null, notes || null, important_info || null, taxRateVal, tax_amount, total, cc.customer_street, cc.customer_city, cc.customer_state, cc.customer_zip, cc.customer_phone, cc.customer_email, req.params.id]
      );
      // Voiding happens in the SAME transaction as the edit, so a quote can never
      // end up edited but still reachable on the old link.
      if (isOut(quote.status)) {
        await client.query(
          "UPDATE quotes SET status = 'draft', approval_token = NULL, token_expires_at = NULL, " +
          'sent_at = NULL, sent_to = NULL, first_viewed_at = NULL, last_reminded_at = NULL, reminder_count = 0 ' +
          'WHERE id = $1',
          [req.params.id]
        );
      }
      await client.query('DELETE FROM quote_line_items WHERE quote_id = $1', [req.params.id]);
      for (const item of (line_items || [])) {
        await client.query(
          'INSERT INTO quote_line_items (quote_id, item_number, manufacturer, description, quantity, unit_price, list_price, taxable, url, line_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [req.params.id, item.item_number || null, item.manufacturer || null, item.description, item.quantity, item.unit_price || 0, item.list_price || 0, item.taxable || false, item.url || null, normLineType(item.line_type)]
        );
      }
      await client.query('COMMIT');
      await logAudit({ entity_type: 'quote', entity_id: parseInt(req.params.id), entity_number: quote.quote_number, action: 'edited', user_id: req.user.id, user_name: req.user.name });
      if (isOut(quote.status)) {
        await logQuoteEvent(parseInt(req.params.id), 'link_voided', { actorName: req.user.name, req: req, details: { was: quote.status, reason: 'edited' } });
        try { await logAudit({ entity_type: 'quote', entity_id: parseInt(req.params.id), entity_number: quote.quote_number, action: 'customer_link_voided', user_id: req.user.id, user_name: req.user.name, details: { was: quote.status } }); } catch (e) {}
      }
      res.json({ success: true, id: parseInt(req.params.id), voided: isOut(quote.status) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update quote' });
  }
});

// DELETE quote
router.delete('/:id', requireAuth, requirePermission('delete_quote'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (req.user.role !== 'admin' && quote.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // An approved quote is the record of what a customer agreed to and what they
    // will be billed against. Only an admin can destroy that.
    if (quote.status === 'approved' && req.user.role !== 'admin') {
      return res.status(409).json({ error: 'This quote was approved by the customer, so it is kept as a record. Ask an admin if it truly needs deleting.' });
    }
    await pool.query('DELETE FROM quotes WHERE id = $1', [req.params.id]);
    await logAudit({ entity_type: 'quote', entity_id: quote.id, entity_number: quote.quote_number, action: 'deleted', user_id: req.user.id, user_name: req.user.name });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

// POST push a quote into PO(s) - one PO per supplier (manufacturer); uses our cost (unit_price)
router.post('/:id/push-to-po', requireAuth, requirePermission('push_quote_po'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (req.user.role !== 'admin' && quote.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!quote.city_code) return res.status(400).json({ error: 'Set a city on the quote before pushing it to a PO.' });
    const { rows: allItems } = await pool.query('SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY id', [req.params.id]);
    if (!allItems.length) return res.status(400).json({ error: 'This quote has no line items.' });
    // Labor is work we perform, not stock we order. Putting it on a PO invents a
    // payable to a supplier that was never going to invoice us for it.
    const items = allItems.filter(function (it) { return normLineType(it.line_type) !== 'labor'; });
    if (!items.length) return res.status(400).json({ error: 'This quote is labor only, so there is nothing to purchase.' });

    const groups = {};
    const order = [];
    items.forEach(function (it) {
      const key = (it.manufacturer || '').trim() || 'Unspecified Supplier';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(it);
    });

    const initials = getInitials(req.user.name);
    const city = String(quote.city_code).toUpperCase();
    const year = new Date().getFullYear();
    let created = [];

    for (var attempt = 0; attempt < 10; attempt++) {
    created = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mx = await client.query("SELECT MAX(CAST(SPLIT_PART(po_number, '-', 3) AS INTEGER)) as maxseq FROM purchase_orders WHERE EXTRACT(YEAR FROM created_at) = $1", [year]);
      let seq = (mx.rows[0].maxseq || 0);
      for (let g = 0; g < order.length; g++) {
        const vendor = order[g];
        const grp = groups[vendor];
        seq++;
        const po_number = city + '-' + year + '-' + String(seq).padStart(4, '0') + '-' + initials;
        const total = grp.reduce(function (s, i) { return s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0); }, 0);
        const poRows = await client.query(
          'INSERT INTO purchase_orders (po_number, requester_id, vendor_name, customer_name, city_code, notes, total_amount, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [po_number, req.user.id, vendor, quote.customer_name || null, city, 'From quote ' + quote.quote_number, total, 'submitted']
        );
        const po = poRows.rows[0];
        for (let i = 0; i < grp.length; i++) {
          const it = grp[i];
          await client.query(
            'INSERT INTO po_line_items (po_id, item_number, manufacturer, description, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6)',
            [po.id, it.item_number || null, it.manufacturer || null, it.description, it.quantity, it.unit_price || 0]
          );
        }
        created.push({ id: po.id, po_number: po_number, vendor_name: vendor, total: total });
      }
      await client.query('COMMIT');
      client.release();
      break;
    } catch (err) {
      await client.query('ROLLBACK').catch(function(){});
      client.release();
      if (err.code === '23505' && attempt < 9) continue;
      console.error(err);
      return res.status(500).json({ error: 'Failed to create PO(s): ' + err.message });
    }
    }
    for (let c = 0; c < created.length; c++) {
      try { await logAudit({ entity_type: 'po', entity_id: created[c].id, entity_number: created[c].po_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { vendor: created[c].vendor_name, total: created[c].total, from_quote: quote.quote_number } }); } catch (e) {}
      try { await logAudit({ entity_type: 'po', entity_id: created[c].id, entity_number: created[c].po_number, action: 'submitted', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    }
    try {
      const base = (process.env.APP_URL || '').replace(/\/$/, '');
      const _q2 = await notify.broadcastRecipients('quote_to_pos', "role IN ('admin', 'owner')");
      await push.sendPushToUsers(_q2.userIds, { title: 'Quote pushed to POs', body: req.user.name + ' pushed a quote to purchase orders.', url: '/' });
      const emailAdmins = _q2.emails;
      const smsAdmins = _q2.phones;
      const listText = created.map(function (c) { return c.po_number + ' (' + c.vendor_name + ', $' + parseFloat(c.total).toFixed(2) + ')'; }).join(', ');
      if (emailAdmins.length) {
        const html = emailTemplate({
          badge: 'Action required',
          title: created.length === 1 ? 'Purchase order submitted for approval' : (created.length + ' purchase orders submitted for approval'),
          body: '<strong>' + req.user.name + '</strong> pushed quote ' + quote.quote_number + ' to ' + created.length + ' purchase order' + (created.length === 1 ? '' : 's') + ' that need your review.',
          details: created.map(function (c) { return { label: c.po_number, value: c.vendor_name + ' — $' + parseFloat(c.total).toFixed(2) }; }).concat([{ label: 'From quote', value: quote.quote_number }, { label: 'Customer/Employee', value: quote.customer_name || '—' }, { label: 'City', value: city }]),
          buttonText: 'Review POs',
          buttonUrl: base + '/?view=dashboard'
        });
        await sendEmail(emailAdmins, 'Action Required: ' + created.length + ' PO' + (created.length === 1 ? '' : 's') + ' from quote ' + quote.quote_number, html);
      }
      if (smsAdmins.length) {
        await sendSms(smsAdmins, 'Lock & Roll: ' + req.user.name + ' submitted ' + created.length + ' PO' + (created.length === 1 ? '' : 's') + ' from quote ' + quote.quote_number + ': ' + listText + '. ' + base + '/?view=dashboard');
      }
    } catch (e) { console.error('Push-to-PO notify failed:', e); }
    res.status(201).json({ ok: true, count: created.length, pos: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to push to PO' });
  }
});

// ===== Quote photos =====
// Reference images attached to a quote. Bytes live in Cloudflare R2; only
// metadata + the R2 key are stored here. Same access rule as the quote itself:
// admins/managers/locksmith coordinators see all, everyone else only their own.
function canAccessQuote(user, quote) {
  return canSeeAllQuotes(user.role) || quote.requester_id === user.id;
}

function sanitizePhotoName(name) {
  return String(name || 'photo').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'photo';
}

// List the ready photos for a quote, each with a short-lived inline preview URL.
router.get('/:id/photos', requireAuth, requirePermission('view_quotes'), async (req, res) => {
  try {
    const qr = await pool.query('SELECT id, requester_id FROM quotes WHERE id = $1', [req.params.id]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Quote not found' });
    if (!canAccessQuote(req.user, qr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await pool.query(
      "SELECT id, name, mime_type, size_bytes, uploaded_by_name, created_at, r2_key FROM quote_photos WHERE quote_id = $1 AND status = 'ready' ORDER BY id",
      [req.params.id]
    );
    const out = [];
    for (const p of rows) {
      let url = null;
      if (r2.configured()) {
        try { url = await r2.presignDownload(p.r2_key, p.name, true); } catch (e) {}
      }
      out.push({ id: p.id, name: p.name, mime_type: p.mime_type, size_bytes: p.size_bytes, uploaded_by_name: p.uploaded_by_name, created_at: p.created_at, url: url });
    }
    res.json(out);
  } catch (err) {
    console.error('List quote photos error:', err);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

// Step 1: reserve a record + presigned PUT URL. Browser uploads bytes to R2.
router.post('/:id/photos/upload-url', requireAuth, requirePermission('edit_quote'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not configured yet. Add the R2_* environment variables in Railway.' });
    const qr = await pool.query('SELECT id, requester_id FROM quotes WHERE id = $1', [req.params.id]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Quote not found' });
    if (!canAccessQuote(req.user, qr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    const name = (req.body.name || '').trim();
    const mime = (req.body.mime_type || 'application/octet-stream').slice(0, 255);
    if (!name) return res.status(400).json({ error: 'File name is required' });
    const key = 'quote-photos/' + req.params.id + '/' + crypto.randomUUID() + '/' + sanitizePhotoName(name);
    const { rows } = await pool.query(
      "INSERT INTO quote_photos (quote_id, name, r2_key, mime_type, uploaded_by, uploaded_by_name, status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id",
      [req.params.id, name.slice(0, 255), key, mime, req.user.id, req.user.name]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('Quote photo upload-url error:', err);
    res.status(500).json({ error: 'Failed to start upload' });
  }
});

// Step 2: confirm the upload completed; record the size and mark it ready.
router.post('/photos/:photoId/confirm', requireAuth, requirePermission('edit_quote'), async (req, res) => {
  try {
    const pr = await pool.query(
      'SELECT p.id, p.quote_id, q.requester_id FROM quote_photos p JOIN quotes q ON p.quote_id = q.id WHERE p.id = $1',
      [req.params.photoId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (!canAccessQuote(req.user, pr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    const size = Math.max(0, parseInt(req.body.size_bytes, 10) || 0);
    await pool.query("UPDATE quote_photos SET size_bytes = $1, status = 'ready' WHERE id = $2", [size, req.params.photoId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Quote photo confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

// Download / preview a single photo via a short-lived presigned GET URL.
router.get('/photos/:photoId/download', requireAuth, requirePermission('view_quotes'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not configured yet.' });
    const pr = await pool.query(
      "SELECT p.id, p.name, p.r2_key, p.quote_id, q.requester_id FROM quote_photos p JOIN quotes q ON p.quote_id = q.id WHERE p.id = $1 AND p.status = 'ready'",
      [req.params.photoId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (!canAccessQuote(req.user, pr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    const url = await r2.presignDownload(pr.rows[0].r2_key, pr.rows[0].name, req.query.inline === '1');
    res.json({ url: url });
  } catch (err) {
    console.error('Quote photo download error:', err);
    res.status(500).json({ error: 'Failed to generate download link' });
  }
});

// Delete a photo: remove the R2 object and the metadata row.
router.delete('/photos/:photoId', requireAuth, requirePermission('edit_quote'), async (req, res) => {
  try {
    const pr = await pool.query(
      'SELECT p.id, p.r2_key, p.quote_id, q.requester_id FROM quote_photos p JOIN quotes q ON p.quote_id = q.id WHERE p.id = $1',
      [req.params.photoId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (!canAccessQuote(req.user, pr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    try { if (r2.configured()) await r2.deleteObject(pr.rows[0].r2_key); } catch (e) { console.error('R2 delete failed:', e); }
    await pool.query('DELETE FROM quote_photos WHERE id = $1', [req.params.photoId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Quote photo delete error:', err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// ===================== Customer approval: staff side =====================

// Build and send the customer's email (and optional SMS). Used by both the
// initial send and the reminder job, so the two can never drift apart.
async function sendQuoteEmail(quote, items, opts) {
  var o = opts || {};
  var brand = o.brand || await customerBrand();
  var link = quoteLink(quote.approval_token);
  var t = quoteTotals(items, quote.tax_rate);
  var validThrough = quote.token_expires_at
    ? new Date(quote.token_expires_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  var greeting = 'Hi ' + (quote.customer_name || 'there') + ',';
  var intro = o.reminder
    ? 'Just a friendly reminder that your quote from ' + brand + ' is still waiting for your review.'
    : 'Here is the quote you asked for. You can review everything and approve it right from the link below.';
  var html = emailTemplate({
    badge: o.reminder ? 'Reminder' : 'Quote ready', badgeColor: 'orange',
    title: o.reminder ? 'Your quote is still waiting' : 'Your quote is ready to review',
    body: greeting + '<br><br>' + intro +
      (quote.customer_message ? ('<br><br>' + String(quote.customer_message).replace(/[<>]/g, '')) : ''),
    details: [
      { label: 'Quote number', value: quote.quote_number },
      { label: 'Prepared by', value: quote.requester_name || brand },
      { label: 'Total', value: '$' + t.total.toFixed(2) }
    ].concat(validThrough ? [{ label: 'Valid through', value: validThrough }] : []),
    buttonText: 'Review & approve', buttonUrl: link, brand: brand,
    footerNote: 'This link is unique to you, so please do not forward it. Questions? Just reply to this email and it goes straight to ' + (quote.requester_name || 'us') + '.'
  });
  // A customer-facing send, so it gets its own sender identity and a reply-to
  // that reaches a human. Falls back to the internal defaults when unset.
  return sendEmail(
    quote.sent_to || quote.customer_email,
    (o.reminder ? 'Reminder: your quote from ' : 'Your quote from ') + brand + ' - ' + quote.quote_number,
    html, null, null,
    {
      from: quoteFromAddress(brand),
      replyTo: process.env.QUOTE_REPLY_TO || quote.requester_email || undefined
    }
  );
}

// The customer SMS, wording from Settings. Shared by the send route and the
// reminder job so the two can never drift apart.
async function sendQuoteSms(to, quote, items, brand) {
  const body = renderQuoteSms(await quoteSmsTemplate(), quoteSmsVars(quote, items, brand || await customerBrand()));
  return sendSms(to, body);
}

// POST /:id/send - put the quote in front of the customer.
router.post('/:id/send', requireAuth, requirePermission('send_quote'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT q.*, u.name AS requester_name, u.email AS requester_email FROM quotes q JOIN users u ON q.requester_id = u.id WHERE q.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (!canAccessQuote(req.user, quote)) return res.status(403).json({ error: 'Access denied' });
    if (isOut(quote.status)) return res.status(409).json({ error: 'This quote has already been sent. Edit it to void the old link, or use Send a reminder.' });

    const to = String(req.body.to || quote.customer_email || '').trim().slice(0, 255);
    if (!to || to.indexOf('@') === -1) return res.status(400).json({ error: 'A customer email address is required to send a quote.' });
    const sms = req.body.sms_to ? String(req.body.sms_to).trim().slice(0, 50) : null;
    const message = req.body.message ? String(req.body.message).trim().slice(0, 2000) : null;

    const { rows: items } = await pool.query('SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY id', [req.params.id]);
    if (!items.length) return res.status(400).json({ error: 'This quote has no line items yet.' });

    // 1..365 days, defaulting to 30. The value doubles as the "valid through"
    // line the customer sees, so it is a business promise, not just a timer.
    var days = parseInt(req.body.expires_days, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) days = 30;
    const expires = new Date(Date.now() + days * 86400000);
    const token = newApprovalToken();

    const upd = await pool.query(
      "UPDATE quotes SET status = 'sent', approval_token = $1, token_expires_at = $2, sent_at = NOW(), sent_to = $3, " +
      'sent_by = $4, customer_message = $5, customer_email = COALESCE(NULLIF($6, \'\'), customer_email), ' +
      'first_viewed_at = NULL, responded_at = NULL, approver_name = NULL, approver_title = NULL, approver_ip = NULL, ' +
      'approved_total = NULL, signature_data = NULL, decline_reason = NULL, last_reminded_at = NULL, reminder_count = 0, ' +
      'updated_at = NOW() WHERE id = $7 RETURNING *',
      [token, expires, to, req.user.id, message, to, req.params.id]
    );
    const sent = Object.assign({}, upd.rows[0], { requester_name: quote.requester_name, requester_email: quote.requester_email });

    const brand = await customerBrand();
    var emailed = false;
    try { emailed = await sendQuoteEmail(sent, items, { brand: brand }); }
    catch (e) { console.error('[quotes] customer email failed:', e.message); }
    if (sms) {
      try { await sendQuoteSms(sms, sent, items, brand); }
      catch (e) { console.error('[quotes] customer SMS failed:', e.message); }
    }

    await logQuoteEvent(quote.id, 'sent', { actorName: req.user.name, req: req, details: { to: to, sms: sms || null, expires_days: days, emailed: emailed } });
    try { await logAudit({ entity_type: 'quote', entity_id: quote.id, entity_number: quote.quote_number, action: 'sent_to_customer', user_id: req.user.id, user_name: req.user.name, details: { to: to } }); } catch (e) {}

    res.json({ success: true, emailed: emailed, link: quoteLink(token), expires_at: expires });
  } catch (err) {
    console.error('Quote send error:', err);
    res.status(500).json({ error: 'Failed to send quote' });
  }
});

// POST /:id/remind - nudge a customer who has not answered yet.
router.post('/:id/remind', requireAuth, requirePermission('send_quote'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT q.*, u.name AS requester_name, u.email AS requester_email FROM quotes q JOIN users u ON q.requester_id = u.id WHERE q.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (!canAccessQuote(req.user, quote)) return res.status(403).json({ error: 'Access denied' });
    if (['sent', 'viewed', 'changes_requested'].indexOf(quote.status) === -1) {
      return res.status(409).json({ error: 'Nothing to remind - this quote is ' + quote.status + '.' });
    }
    if (!quote.approval_token) return res.status(409).json({ error: 'This quote has no active customer link.' });

    const { rows: items } = await pool.query('SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY id', [req.params.id]);
    var emailed = false;
    try { emailed = await sendQuoteEmail(quote, items, { reminder: true }); }
    catch (e) { console.error('[quotes] reminder failed:', e.message); }
    await pool.query('UPDATE quotes SET last_reminded_at = NOW(), reminder_count = reminder_count + 1 WHERE id = $1', [req.params.id]);
    await logQuoteEvent(quote.id, 'reminded', { actorName: req.user.name, req: req, details: { to: quote.sent_to, manual: true } });
    res.json({ success: true, emailed: emailed });
  } catch (err) {
    console.error('Quote remind error:', err);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// POST /:id/revoke - kill the customer link without editing anything.
router.post('/:id/revoke', requireAuth, requirePermission('send_quote'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (!canAccessQuote(req.user, quote)) return res.status(403).json({ error: 'Access denied' });
    if (!isOut(quote.status)) return res.status(409).json({ error: 'This quote has not been sent.' });
    if (isAnswered(quote.status) && req.user.role !== 'admin') {
      return res.status(409).json({ error: 'The customer has already answered this quote. Ask an admin to re-open it.' });
    }
    await pool.query(
      "UPDATE quotes SET status = 'draft', approval_token = NULL, token_expires_at = NULL, sent_at = NULL, sent_to = NULL, " +
      'first_viewed_at = NULL, last_reminded_at = NULL, reminder_count = 0, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    await logQuoteEvent(quote.id, 'link_voided', { actorName: req.user.name, req: req, details: { was: quote.status, reason: 'revoked' } });
    try { await logAudit({ entity_type: 'quote', entity_id: quote.id, entity_number: quote.quote_number, action: 'customer_link_voided', user_id: req.user.id, user_name: req.user.name, details: { was: quote.status } }); } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    console.error('Quote revoke error:', err);
    res.status(500).json({ error: 'Failed to revoke the link' });
  }
});

// POST /sms-preview - render a candidate SMS template against sample values.
//
// Deliberately server-side. A preview built separately in the browser is a
// second implementation that drifts from the one that actually sends; this runs
// the real renderQuoteSms, so what Settings shows is what a customer gets.
router.post('/sms-preview', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  try {
    const brand = await customerBrand();
    const template = (req.body && typeof req.body.template === 'string' && req.body.template.trim())
      ? req.body.template : await quoteSmsTemplate();
    const body = renderQuoteSms(template, {
      company: brand,
      customer: 'Riverbend Storage LLC',
      quote_number: 'QT-' + new Date().getFullYear() + '-0418-TM',
      total: '$2,486.40',
      link: appBase() + '/quote/' + 'a1b2c3d4'.repeat(8),
      prepared_by: req.user.name,
      expires: 'Sep 22'
    });
    // 160 chars per segment for plain GSM text, 153 once a message splits.
    const segments = body.length <= 160 ? 1 : Math.ceil(body.length / 153);
    res.json({ body: body, length: body.length, segments: segments, tokens: SMS_TOKENS, default_template: DEFAULT_QUOTE_SMS });
  } catch (err) {
    console.error('SMS preview error:', err);
    res.status(500).json({ error: 'Failed to render the preview' });
  }
});

// GET /:id/events - the customer-facing activity trail for one quote.
router.get('/:id/events', requireAuth, requirePermission('view_quotes'), async (req, res) => {
  try {
    const qr = await pool.query('SELECT id, requester_id FROM quotes WHERE id = $1', [req.params.id]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Quote not found' });
    if (!canAccessQuote(req.user, qr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await pool.query(
      'SELECT id, event_type, actor_name, ip, user_agent, details, created_at FROM quote_events WHERE quote_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Quote events error:', err);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ===================== Customer approval: public (token) =====================
// Mounted at /api/quote-approve in server.js. No JWT, no session, no cookies.

// Tell the team a customer did something. Best-effort on every channel.
async function notifyDecision(quote, kind, extra) {
  try {
    const base = appBase();
    const label = kind === 'approved' ? 'approved' : (kind === 'declined' ? 'declined' : 'asked for changes on');
    const url = base + '/?view=view-quote&id=' + quote.id;
    const who = quote.approver_name || quote.customer_name || 'The customer';

    // The person who wrote the quote always hears about it, plus whoever has the
    // broadcast turned on.
    const _q = await notify.broadcastRecipients('quote_' + kind, "role IN ('admin', 'owner')");
    var emails = (_q.emails || []).slice();
    var phones = (_q.phones || []).slice();
    var userIds = (_q.userIds || []).slice();
    try {
      const pr = await pool.query('SELECT id, email, phone, receive_emails, receive_sms FROM users WHERE id = $1', [quote.requester_id]);
      if (pr.rows.length) {
        const p = pr.rows[0];
        if (p.email && p.receive_emails !== false && emails.indexOf(p.email) === -1) emails.push(p.email);
        if (p.phone && p.receive_sms === true && phones.indexOf(p.phone) === -1) phones.push(p.phone);
        if (userIds.indexOf(p.id) === -1) userIds.push(p.id);
      }
    } catch (e) {}

    const amount = quote.approved_total != null ? ('$' + parseFloat(quote.approved_total).toFixed(2)) : null;
    try { await push.sendPushToUsers(userIds, { title: 'Quote ' + label, body: who + ' ' + label + ' ' + quote.quote_number + (amount ? (' - ' + amount) : ''), url: '/' }); } catch (e) {}

    if (emails.length) {
      const html = emailTemplate({
        badge: kind === 'approved' ? 'Approved' : (kind === 'declined' ? 'Declined' : 'Changes requested'),
        badgeColor: kind === 'approved' ? 'green' : 'red',
        title: 'Quote ' + quote.quote_number + ' was ' + label,
        body: '<strong>' + who + '</strong> ' + label + ' this quote.' + (extra ? ('<br><br>' + String(extra).replace(/[<>]/g, '')) : ''),
        details: [
          { label: 'Quote number', value: quote.quote_number },
          { label: 'Customer', value: quote.customer_name || '-' },
          { label: 'Prepared by', value: quote.requester_name || '-' }
        ].concat(amount ? [{ label: 'Approved total', value: amount }] : []),
        buttonText: 'Open the quote', buttonUrl: url
      });
      await sendEmail(emails, 'Quote ' + quote.quote_number + ' ' + label + ' by ' + (quote.customer_name || 'the customer'), html);
    }
    if (phones.length) {
      await sendSms(phones, 'Lock and Roll: ' + who + ' ' + label + ' quote ' + quote.quote_number + (amount ? (' (' + amount + ')') : '') + '. ' + url);
    }
  } catch (e) { console.error('[quotes] decision notify failed:', e.message); }
}

// GET /:token - what the customer sees. Records the view; changes nothing else.
//
// This is a GET, so it must stay safe: mail scanners and link prefetchers in
// Outlook and corporate gateways WILL fetch it unattended. Approving is a POST
// with a name and an explicit consent flag, below.
pub.get('/:token', async (req, res) => {
  try {
    const found = await loadByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'not_found' });
    const quote = found.quote;

    if (found.expired) {
      if (quote.status !== 'expired' && !isAnswered(quote.status)) {
        await pool.query("UPDATE quotes SET status = 'expired', updated_at = NOW() WHERE id = $1", [quote.id]);
        await logQuoteEvent(quote.id, 'expired', { req: req });
      }
      return res.status(410).json({
        error: 'expired',
        quote_number: quote.quote_number,
        company: await publicCompanySettings(),
        prepared_by: { name: quote.requester_name, email: quote.requester_email, phone: quote.requester_phone }
      });
    }

    // First open flips sent -> viewed and tells the team. Later opens only add
    // an event, so the trail shows "opened 3x" without re-notifying anybody.
    if (quote.status === 'sent') {
      await pool.query("UPDATE quotes SET status = 'viewed', first_viewed_at = COALESCE(first_viewed_at, NOW()), updated_at = NOW() WHERE id = $1", [quote.id]);
      quote.status = 'viewed';
      quote.first_viewed_at = quote.first_viewed_at || new Date();
      try {
        const pr = await pool.query('SELECT id FROM users WHERE id = $1', [quote.requester_id]);
        if (pr.rows.length) await push.sendPushToUsers([pr.rows[0].id], { title: 'Quote opened', body: (quote.customer_name || 'The customer') + ' opened ' + quote.quote_number + '.', url: '/' });
      } catch (e) {}
    }
    await logQuoteEvent(quote.id, 'viewed', { req: req });

    res.json(publicQuotePayload(quote, found.items, await publicCompanySettings()));
  } catch (err) {
    console.error('Public quote view error:', err);
    res.status(500).json({ error: 'Failed to load the quote' });
  }
});

// POST /:token/approve - the decision. Requires a typed name AND explicit consent.
pub.post('/:token/approve', async (req, res) => {
  try {
    const found = await loadByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'not_found' });
    const quote = found.quote;
    if (found.expired) return res.status(410).json({ error: 'This quote has expired. Please ask for an updated one.' });
    if (isAnswered(quote.status)) return res.status(409).json({ error: 'already_answered', status: quote.status });

    const name = String(req.body.name || '').trim().slice(0, 255);
    const title = req.body.title ? String(req.body.title).trim().slice(0, 120) : null;
    const signature = req.body.signature ? String(req.body.signature).slice(0, 400000) : null;
    if (name.length < 2) return res.status(400).json({ error: 'Please type your full name to approve.' });
    // The consent box is the part that carries weight; a click alone is not it.
    if (req.body.consent !== true) return res.status(400).json({ error: 'Please tick the authorization box to approve.' });

    // Recomputed here, not taken from the browser. The customer approves the
    // number the server says the quote is worth.
    const t = quoteTotals(found.items, quote.tax_rate);

    const upd = await pool.query(
      "UPDATE quotes SET status = 'approved', responded_at = NOW(), approver_name = $1, approver_title = $2, " +
      'approver_ip = $3, approved_total = $4, signature_data = $5, updated_at = NOW() ' +
      "WHERE id = $6 AND status NOT IN ('approved','declined') RETURNING id",
      [name, title, clientIp(req), t.total, signature, quote.id]
    );
    // Lost the race against another tab or a double tap: treat it as done, not an error.
    if (!upd.rows.length) return res.status(409).json({ error: 'already_answered' });

    quote.status = 'approved';
    quote.approver_name = name;
    quote.approver_title = title;
    quote.approved_total = t.total;
    await logQuoteEvent(quote.id, 'approved', { actorName: name, req: req, details: { title: title, total: t.total, signed: !!signature } });
    try { await logAudit({ entity_type: 'quote', entity_id: quote.id, entity_number: quote.quote_number, action: 'approved_by_customer', user_id: null, user_name: name, details: { total: t.total, title: title } }); } catch (e) {}
    notifyDecision(quote, 'approved', null).catch(function () {});

    res.json({ success: true, status: 'approved', approved_total: t.total, approver_name: name, responded_at: new Date() });
  } catch (err) {
    console.error('Quote approve error:', err);
    res.status(500).json({ error: 'Failed to record your approval' });
  }
});

// POST /:token/decline
pub.post('/:token/decline', async (req, res) => {
  try {
    const found = await loadByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'not_found' });
    const quote = found.quote;
    if (found.expired) return res.status(410).json({ error: 'This quote has expired.' });
    if (isAnswered(quote.status)) return res.status(409).json({ error: 'already_answered', status: quote.status });

    const name = String(req.body.name || quote.customer_name || '').trim().slice(0, 255);
    const reason = req.body.reason ? String(req.body.reason).trim().slice(0, 2000) : null;

    const upd = await pool.query(
      "UPDATE quotes SET status = 'declined', responded_at = NOW(), approver_name = $1, approver_ip = $2, " +
      "decline_reason = $3, updated_at = NOW() WHERE id = $4 AND status NOT IN ('approved','declined') RETURNING id",
      [name, clientIp(req), reason, quote.id]
    );
    if (!upd.rows.length) return res.status(409).json({ error: 'already_answered' });

    quote.status = 'declined';
    quote.approver_name = name;
    await logQuoteEvent(quote.id, 'declined', { actorName: name, req: req, details: { reason: reason } });
    try { await logAudit({ entity_type: 'quote', entity_id: quote.id, entity_number: quote.quote_number, action: 'declined_by_customer', user_id: null, user_name: name, details: { reason: reason } }); } catch (e) {}
    notifyDecision(quote, 'declined', reason).catch(function () {});

    res.json({ success: true, status: 'declined' });
  } catch (err) {
    console.error('Quote decline error:', err);
    res.status(500).json({ error: 'Failed to record your response' });
  }
});

// POST /:token/message - "ask a question". Deliberately NOT a decision: the
// quote stays open and answerable. Most quotes that die get negotiated, not
// rejected, and this is the path that catches them.
pub.post('/:token/message', async (req, res) => {
  try {
    const found = await loadByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'not_found' });
    const quote = found.quote;
    if (found.expired) return res.status(410).json({ error: 'This quote has expired.' });
    if (isAnswered(quote.status)) return res.status(409).json({ error: 'already_answered', status: quote.status });

    const message = String(req.body.message || '').trim().slice(0, 4000);
    const phone = req.body.phone ? String(req.body.phone).trim().slice(0, 50) : null;
    if (message.length < 2) return res.status(400).json({ error: 'Please tell us what you would like changed.' });

    await pool.query("UPDATE quotes SET status = 'changes_requested', updated_at = NOW() WHERE id = $1", [quote.id]);
    quote.status = 'changes_requested';
    await logQuoteEvent(quote.id, 'changes_requested', { actorName: quote.customer_name, req: req, details: { message: message, phone: phone } });
    notifyDecision(quote, 'changes_requested', message + (phone ? ('<br><br>Best number: ' + phone) : '')).catch(function () {});

    res.json({ success: true, status: 'changes_requested' });
  } catch (err) {
    console.error('Quote message error:', err);
    res.status(500).json({ error: 'Failed to send your message' });
  }
});

module.exports = router;
module.exports.publicRouter = pub;
// Exported for jobs/quoteReminders.js so the nudge email and the send email can
// never drift apart.
module.exports.sendQuoteEmail = sendQuoteEmail;
module.exports.quoteLink = quoteLink;
