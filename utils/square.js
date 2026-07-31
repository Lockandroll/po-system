// Square integration — Point of Sale API (mobile web deep link) + Payments lookup.
//
// How the pieces fit:
//   1. A tech taps Collect Payment. routes/invoices.js mints an invoice_payments
//      row and calls buildPosUrls() below to get the deep link.
//   2. Square Point of Sale runs the card and redirects the browser back to
//      routes/square.js with a transaction id and our signed state.
//   3. reconcilePayment() below calls Square SERVER-SIDE to find out what actually
//      happened, and only then does the invoice get marked paid.
//
// The callback in step 2 is unauthenticated by necessity (Square redirects a raw
// browser at it, with no Nova token). It can only ever move a row from 'initiated'
// to 'returned'. Step 3 is the ONLY thing that writes money onto an invoice, and
// it talks to Square directly rather than trusting anything in the redirect.
//
// NOTE: this file must contain NO backtick characters. Windows corrupts them
// silently on this repo. Use string concatenation.

const crypto = require('crypto');
const { pool } = require('../db');
const { logAudit } = require('./audit');

const API_BASE = (process.env.SQUARE_ENVIRONMENT === 'sandbox')
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

// Square-Version is optional. When omitted Square uses the version the
// application is pinned to in the Developer Console, which is what we want —
// it means a Square deprecation never breaks us on a random Tuesday.
const API_VERSION = process.env.SQUARE_API_VERSION || '';

function configured() {
  return !!(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_APPLICATION_ID && process.env.SQUARE_STATE_SECRET);
}

function callbackUrl() {
  return process.env.SQUARE_POS_CALLBACK_URL || '';
}

// ---------------------------------------------------------------------------
// Square REST helper
// ---------------------------------------------------------------------------
async function sq(method, path, body) {
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    const e = new Error('Square is not configured');
    e.code = 'unconfigured';
    throw e;
  }
  const headers = {
    'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (API_VERSION) headers['Square-Version'] = API_VERSION;

  const opts = { method: method, headers: headers };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);

  const resp = await fetch(API_BASE + path, opts);
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }

  if (!resp.ok) {
    const err = new Error('Square ' + method + ' ' + path + ' failed with ' + resp.status);
    err.status = resp.status;
    err.body = json || text;
    // Square returns a machine-readable code we want to branch on.
    try { err.squareCode = json.errors[0].code; } catch (e) { err.squareCode = ''; }
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Signed state
//
// Square registers ONE callback URL for the whole application, so the state
// parameter is the only thing tying a response back to an invoice. It is
// HMAC-signed so it cannot be forged, carries a timestamp so it cannot be
// replayed a week later, and the nonce is consumed single-use by the callback.
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signState(nonce, invoiceId) {
  const payload = b64url(JSON.stringify({ n: nonce, i: Number(invoiceId), t: Math.floor(Date.now() / 1000) }));
  const mac = b64url(crypto.createHmac('sha256', String(process.env.SQUARE_STATE_SECRET || '')).update(payload).digest());
  return payload + '.' + mac;
}

// Returns { ok, nonce, invoiceId, reason }. Never throws on bad input — a
// malformed state is an attacker or a mangled redirect, not a server error.
function verifyState(state) {
  try {
    const parts = String(state || '').split('.');
    if (parts.length !== 2) return { ok: false, reason: 'malformed' };
    const expected = b64url(crypto.createHmac('sha256', String(process.env.SQUARE_STATE_SECRET || '')).update(parts[0]).digest());
    const a = Buffer.from(parts[1]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
    const data = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const age = Math.floor(Date.now() / 1000) - Number(data.t || 0);
    if (!(age >= -300 && age <= 1800)) return { ok: false, reason: 'expired' };
    if (!data.n || !data.i) return { ok: false, reason: 'malformed' };
    return { ok: true, nonce: String(data.n), invoiceId: Number(data.i) };
  } catch (e) {
    return { ok: false, reason: 'malformed' };
  }
}

function newNonce() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------------------------------------------------------------------------
// Deep links
//
// Android takes an intent: URL with typed extras (S. = string, i. = int,
// l. = long). iOS takes a custom scheme with percent-encoded JSON.
// Cash is deliberately absent from the tender list — see reconcilePayment.
// ---------------------------------------------------------------------------
function buildPosUrls(opts) {
  const cents = Math.round(Number(opts.amountCents) || 0);
  const note = String(opts.note || '').slice(0, 500);
  const cb = callbackUrl();
  const clientId = process.env.SQUARE_APPLICATION_ID || '';

  const androidParts = [
    'intent:#Intent',
    'action=com.squareup.pos.action.CHARGE',
    'package=com.squareup',
    'S.com.squareup.pos.WEB_CALLBACK_URI=' + cb,
    'S.com.squareup.pos.CLIENT_ID=' + clientId,
    'S.com.squareup.pos.API_VERSION=v2.0',
    'i.com.squareup.pos.TOTAL_AMOUNT=' + cents,
    'S.com.squareup.pos.CURRENCY_CODE=USD',
    'S.com.squareup.pos.TENDER_TYPES=com.squareup.pos.TENDER_CARD',
    'S.com.squareup.pos.NOTE=' + encodeURIComponent(note),
    'S.com.squareup.pos.REQUEST_METADATA=' + opts.state,
    'l.com.squareup.pos.AUTO_RETURN_TIMEOUT_MS=3200'
  ];
  if (opts.locationId) androidParts.push('S.com.squareup.pos.LOCATION_ID=' + opts.locationId);
  if (opts.fallbackUrl) androidParts.push('S.browser_fallback_url=' + encodeURIComponent(opts.fallbackUrl));
  androidParts.push('end');

  const iosData = {
    amount_money: { amount: cents, currency_code: 'USD' },
    callback_url: cb,
    client_id: clientId,
    version: '1.3',
    notes: note,
    state: opts.state,
    options: {
      supported_tender_types: ['CREDIT_CARD'],
      auto_return: true,
      clear_default_fees: false
    }
  };
  if (opts.locationId) iosData.location_id = opts.locationId;

  return {
    android: androidParts.join(';'),
    ios: 'square-commerce-v1://payment/create?data=' + encodeURIComponent(JSON.stringify(iosData))
  };
}

// ---------------------------------------------------------------------------
// Card brand -> Nova pay type
//
// Nova's pay types are configurable (settings.invoice_pay_types) and the value
// is rendered into a dropdown, so a brand that maps to something not in the
// list falls back to 'Other' rather than writing a value the UI cannot show.
// ---------------------------------------------------------------------------
const BRAND_MAP = {
  VISA: 'Visa',
  MASTERCARD: 'Mastercard',
  AMERICAN_EXPRESS: 'Amex',
  DISCOVER: 'Discover',
  DISCOVER_DINERS: 'Discover',
  JCB: 'Other',
  CHINA_UNIONPAY: 'Other',
  SQUARE_GIFT_CARD: 'Other',
  INTERAC: 'Debit',
  EFTPOS: 'Debit',
  FELICA: 'Other',
  EBT: 'Other',
  OTHER_BRAND: 'Other'
};

function brandToPayType(brand, allowedList) {
  const mapped = BRAND_MAP[String(brand || '').toUpperCase()] || 'Other';
  const allowed = Array.isArray(allowedList) && allowedList.length ? allowedList : null;
  if (!allowed) return mapped;
  for (let i = 0; i < allowed.length; i++) {
    if (String(allowed[i]).toLowerCase() === mapped.toLowerCase()) return allowed[i];
  }
  for (let j = 0; j < allowed.length; j++) {
    if (String(allowed[j]).toLowerCase() === 'other') return allowed[j];
  }
  return 'Other';
}

// ---------------------------------------------------------------------------
// Plain-English errors
//
// A tech standing in a parking lot should never read UNAUTHORIZED_CLIENT_ID.
// ---------------------------------------------------------------------------
const ERROR_TEXT = {
  USER_NOT_LOGGED_IN: 'Sign in to the Square app first, then tap Collect Payment again.',
  not_logged_in: 'Sign in to the Square app first, then tap Collect Payment again.',
  NO_NETWORK: 'No signal. Square could not reach the bank.',
  no_network_connection: 'No signal. Square could not reach the bank.',
  TRANSACTION_CANCELED: 'Payment canceled.',
  payment_canceled: 'Payment canceled.',
  UNAUTHORIZED_CLIENT_ID: 'Nova is not connected to Square yet. Tell an admin.',
  unauthorized_client_id: 'Nova is not connected to Square yet. Tell an admin.',
  // These two are overridden by locationErrorMessage() below, which names the
  // city and the location. This generic text is only the last resort.
  ILLEGAL_LOCATION_ID: 'Square would not accept the location this city is mapped to. Nothing was charged.',
  invalid_location_id: 'Square would not accept the location this city is mapped to. Nothing was charged.',
  user_not_active: 'That Square account is not active.',
  USER_NOT_ACTIVE: 'That Square account is not active.',
  INVALID_REQUEST: 'Square rejected the request. Tell an admin.',
  data_invalid: 'Square rejected the request. Tell an admin.',
  amount_invalid_format: 'Square rejected the amount. Tell an admin.',
  UNSUPPORTED_API_VERSION: 'The Square app on this phone is out of date. Update it.',
  unsupported_api_version: 'The Square app on this phone is out of date. Update it.',
  currency_code_mismatch: 'Square rejected the currency. Tell an admin.',
  invalid_tender_type: 'Square would not take a card for this. Tell an admin.',
  CLIENT_NOT_AUTHORIZED_FOR_USER: 'This Square login is not allowed to take payments for the company. Tell an admin.'
};

function errorMessage(code) {
  return ERROR_TEXT[String(code || '')] || 'Square could not complete the payment. Nothing was charged to the customer twice — check the Square app before retrying.';
}

function isCancel(code) {
  const c = String(code || '');
  return c === 'TRANSACTION_CANCELED' || c === 'payment_canceled';
}

function isLocationError(code) {
  const c = String(code || '');
  return c === 'ILLEGAL_LOCATION_ID' || c === 'invalid_location_id' || c === 'INVALID_LOCATION_ID';
}

// Square rejects a location for exactly two reasons, and the fix is different
// for each, so the message has to name both possibilities and name the city and
// location id. "This city is not set up in Square" was the original text here and
// it was wrong: the city IS set up, it is mapped to a location Square will not
// take. Whoever reads this is standing in front of a customer.
function locationErrorMessage(cityCode, locationId) {
  const where = cityCode ? (cityCode + ' is mapped') : 'This city is mapped';
  const which = locationId ? (' to Square location ' + locationId) : '';
  return where + which + ', but Square would not take a payment for it. Either the city is pointed at the wrong Square location in Invoice Setup, or the Square account signed in on this phone does not have access to that location. Nothing was charged.';
}

// ---------------------------------------------------------------------------
// Webhook signature
//
// Square signs HMAC-SHA256 over (notification URL + raw body) with the
// subscription's signature key.
// ---------------------------------------------------------------------------
function verifyWebhook(rawBody, signatureHeader, notificationUrl) {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!key) return false;
  try {
    const expected = crypto.createHmac('sha256', key)
      .update(String(notificationUrl) + rawBody.toString('utf8'))
      .digest('base64');
    const a = Buffer.from(String(signatureHeader || ''));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reconcile
//
// The heart of the whole thing. Given an invoice_payments row that has a Square
// transaction id, go ask Square what really happened and, only if everything
// lines up, write it onto the invoice.
//
// Callable from three places: the SPA poll, the webhook, and the cron sweep.
// Idempotent — invoice_payments.square_payment_id is UNIQUE and the writer
// refuses an invoice already paid against a different payment.
// ---------------------------------------------------------------------------
function money(n) { return Math.round((Number(n) || 0) * 100); }

async function allowedPayTypes() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'invoice_pay_types'");
    const list = JSON.parse((r.rows[0] && r.rows[0].value) || '[]');
    return Array.isArray(list) && list.length ? list : null;
  } catch (e) {
    return null;
  }
}

async function markRow(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(function (k, i) { return k + ' = $' + (i + 1); });
  sets.push('updated_at = NOW()');
  const vals = keys.map(function (k) { return fields[k]; });
  vals.push(id);
  await pool.query('UPDATE invoice_payments SET ' + sets.join(', ') + ' WHERE id = $' + vals.length, vals);
}

async function reconcilePayment(paymentRowId) {
  const rowRes = await pool.query('SELECT * FROM invoice_payments WHERE id = $1', [paymentRowId]);
  const row = rowRes.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'reconciled') return { ok: true, already: true, row: row };
  if (!row.square_transaction_id) {
    return { ok: false, reason: 'no_transaction_yet', row: row };
  }

  await pool.query('UPDATE invoice_payments SET reconcile_attempts = COALESCE(reconcile_attempts,0) + 1, updated_at = NOW() WHERE id = $1', [row.id]);

  let payment = null;
  let orderId = row.square_order_id || null;
  try {
    if (!row.square_payment_id) {
      // For the Point of Sale API the transaction id IS the order id.
      const ord = await sq('GET', '/v2/orders/' + encodeURIComponent(row.square_transaction_id));
      const order = ord && ord.order;
      orderId = (order && order.id) || row.square_transaction_id;
      const tenders = (order && order.tenders) || [];
      const paymentId = tenders.length ? tenders[0].payment_id : null;
      if (!paymentId) {
        await markRow(row.id, { last_error: 'Square order has no card tender yet' });
        return { ok: false, reason: 'no_tender', row: row };
      }
      const pay = await sq('GET', '/v2/payments/' + encodeURIComponent(paymentId));
      payment = pay && pay.payment;
    } else {
      const pay = await sq('GET', '/v2/payments/' + encodeURIComponent(row.square_payment_id));
      payment = pay && pay.payment;
    }
  } catch (e) {
    // NOT_FOUND here usually means the tech's Square app is signed into a
    // different Square account than the one Nova holds a token for. That is a
    // real operational problem, so say so rather than retrying forever.
    const notFound = (e.status === 404 || e.squareCode === 'NOT_FOUND');
    await markRow(row.id, {
      last_error: notFound
        ? 'Square does not have this payment under the company account. The phone may be signed in to a different Square account.'
        : ('Square lookup failed: ' + (e.message || 'unknown'))
    });
    return { ok: false, reason: notFound ? 'wrong_square_account' : 'lookup_failed', row: row };
  }

  if (!payment) {
    await markRow(row.id, { last_error: 'Square returned no payment' });
    return { ok: false, reason: 'no_payment', row: row };
  }

  const sqStatus = String(payment.status || '');
  if (sqStatus === 'CANCELED' || sqStatus === 'FAILED') {
    await markRow(row.id, {
      status: 'failed',
      square_payment_id: payment.id || null,
      square_order_id: orderId,
      square_status: sqStatus,
      error_description: 'Square reports this payment as ' + sqStatus.toLowerCase() + '.'
    });
    return { ok: false, reason: 'square_failed', row: row };
  }
  if (sqStatus !== 'COMPLETED') {
    // APPROVED means authorized but not captured. Leave it alone and retry.
    await markRow(row.id, { square_status: sqStatus, square_payment_id: payment.id || null, square_order_id: orderId });
    return { ok: false, reason: 'not_complete', row: row };
  }

  const card = (payment.card_details && payment.card_details.card) || {};
  const tipCents = (payment.tip_money && Number(payment.tip_money.amount)) || 0;
  const totalCents = (payment.total_money && Number(payment.total_money.amount)) || 0;
  let feeCents = 0;
  try {
    (payment.processing_fee || []).forEach(function (f) { feeCents += Number((f.amount_money || {}).amount) || 0; });
  } catch (e) { feeCents = 0; }

  const invRes = await pool.query(
    'SELECT id, invoice_number, status, subtotal, tax_amount, tip_amount, grand_total, authorized_total, locksmith_id FROM invoices WHERE id = $1',
    [row.invoice_id]
  );
  const inv = invRes.rows[0];
  if (!inv) {
    await markRow(row.id, { status: 'failed', last_error: 'Invoice no longer exists' });
    return { ok: false, reason: 'invoice_gone', row: row };
  }

  // Amount check. Compare the pre-tip figures, because the tip is the one part
  // the customer is allowed to change inside Square. Anything else moving means
  // the amount was edited on the device, and that must not silently mark paid.
  const invoicePreTip = money(inv.grand_total) - money(inv.tip_amount);
  const squarePreTip = totalCents - tipCents;
  if (Math.abs(invoicePreTip - squarePreTip) > 1) {
    await markRow(row.id, {
      status: 'mismatch',
      square_payment_id: payment.id || null,
      square_order_id: orderId,
      square_status: sqStatus,
      card_brand: card.card_brand || null,
      card_last4: card.last_4 || null,
      auth_result_code: (payment.card_details && payment.card_details.auth_result_code) || null,
      entry_method: (payment.card_details && payment.card_details.entry_method) || null,
      tip_cents: tipCents,
      total_cents: totalCents,
      receipt_url: payment.receipt_url || null,
      raw_payment: payment,
      mismatch_reason: 'Invoice is ' + (invoicePreTip / 100).toFixed(2) + ' before tip; Square charged ' + (squarePreTip / 100).toFixed(2) + ' before tip.'
    });
    return { ok: false, reason: 'amount_mismatch', row: row, invoice: inv };
  }

  const payTypes = await allowedPayTypes();
  const payType = brandToPayType(card.card_brand, payTypes);
  const newTip = tipCents / 100;
  const newGrand = (Number(inv.subtotal) || 0) + (Number(inv.tax_amount) || 0) + newTip;

  // Refuse if this invoice is already settled against a DIFFERENT Square payment.
  const otherRes = await pool.query(
    "SELECT id, square_payment_id FROM invoice_payments WHERE invoice_id = $1 AND status = 'reconciled' AND id <> $2",
    [row.invoice_id, row.id]
  );
  if (otherRes.rows.length && otherRes.rows[0].square_payment_id !== payment.id) {
    await markRow(row.id, {
      status: 'mismatch',
      square_payment_id: payment.id || null,
      raw_payment: payment,
      mismatch_reason: 'This invoice was already settled against Square payment ' + otherRes.rows[0].square_payment_id + '. A manager has to sort this out.'
    });
    return { ok: false, reason: 'already_settled', row: row };
  }

  // ---- The narrow writer -------------------------------------------------
  // Same shape as POST /invoices/:id/signature: one statement, only the payment
  // columns, deliberately NOT gated on LOCKED_STATUSES because the invoice
  // becomes locked as a RESULT of this write.
  //
  // WARNING: this is the only writer permitted to change grand_total after a
  // signature exists. Never "fix" a future problem by loosening PUT /:id to
  // allow it instead — the Square dispute packet depends on frozen numbers.
  await pool.query(
    'UPDATE invoices SET pay_type = $1, card_last4 = $2, cc_online = false, approval_code = $3, ' +
    'tip_amount = $4, grand_total = $5, authorized_total = COALESCE(authorized_total, $6), ' +
    "status = 'paid', updated_at = NOW() WHERE id = $7",
    [
      payType,
      card.last_4 || null,
      (payment.card_details && payment.card_details.auth_result_code) || null,
      newTip,
      newGrand,
      (Number(inv.authorized_total) || Number(inv.grand_total) || 0),
      inv.id
    ]
  );

  // Soft cross-check: did the Square team member who ran the card match the tech
  // on the invoice? Not a block — a tech legitimately running a card for someone
  // else's job is a real thing — but worth flagging on the reconciliation report.
  let teamMismatch = false;
  const teamMemberId = payment.team_member_id || payment.employee_id || null;
  if (teamMemberId && inv.locksmith_id) {
    try {
      const u = await pool.query('SELECT square_team_member_id FROM users WHERE id = $1', [inv.locksmith_id]);
      const mapped = u.rows[0] && u.rows[0].square_team_member_id;
      if (mapped && mapped !== teamMemberId) teamMismatch = true;
    } catch (e) { teamMismatch = false; }
  }

  await markRow(row.id, {
    status: 'reconciled',
    square_payment_id: payment.id || null,
    square_order_id: orderId,
    square_status: sqStatus,
    card_brand: card.card_brand || null,
    card_last4: card.last_4 || null,
    auth_result_code: (payment.card_details && payment.card_details.auth_result_code) || null,
    entry_method: (payment.card_details && payment.card_details.entry_method) || null,
    avs_status: (payment.card_details && payment.card_details.avs_status) || null,
    cvv_status: (payment.card_details && payment.card_details.cvv_status) || null,
    tip_cents: tipCents,
    total_cents: totalCents,
    processing_fee_cents: feeCents,
    receipt_url: payment.receipt_url || null,
    receipt_number: payment.receipt_number || null,
    square_team_member_id: teamMemberId,
    team_member_mismatch: teamMismatch,
    square_created_at: payment.created_at || null,
    raw_payment: payment,
    reconciled_at: new Date(),
    last_error: null
  });

  try {
    await logAudit({
      entity_type: 'invoice',
      entity_id: inv.id,
      entity_number: String(inv.invoice_number),
      action: 'paid_via_square',
      user_id: row.initiated_by || null,
      user_name: 'Square',
      details: {
        square_payment_id: payment.id,
        card_brand: card.card_brand,
        last_4: card.last_4,
        entry_method: (payment.card_details && payment.card_details.entry_method) || null,
        tip: newTip,
        total: newGrand,
        team_member_mismatch: teamMismatch
      }
    });
  } catch (e) {}

  return { ok: true, row: row, invoice: inv, payment: payment, tip: newTip, grand_total: newGrand };
}

// Find the invoice_payments row a webhook event belongs to.
//
// Three ways in, in order of confidence:
//   1. The Square payment id, if we already recorded it.
//   2. The order id, which for a normal Point of Sale payment IS the
//      transaction id Square handed back in the redirect.
//   3. The invoice number in the note. This is the ONLY route home for an
//      OFFLINE payment: Square took the card with no signal, so the redirect
//      carried a client transaction id and nothing else, and the order id does
//      not exist until the device syncs. Without this the invoice would sit
//      pending forever and the payment would look like an orphan.
//
// A payment that matches none of the three really is a card run in the Square
// app with no Nova invoice behind it, which is what the orphan table is for.
async function findRowForPayment(payment) {
  if (!payment) return null;
  if (payment.id) {
    const byPay = await pool.query('SELECT * FROM invoice_payments WHERE square_payment_id = $1', [payment.id]);
    if (byPay.rows[0]) return byPay.rows[0];
  }
  if (payment.order_id) {
    const byOrder = await pool.query(
      'SELECT * FROM invoice_payments WHERE square_order_id = $1 OR square_transaction_id = $1 ORDER BY id DESC LIMIT 1',
      [payment.order_id]
    );
    if (byOrder.rows[0]) return byOrder.rows[0];
  }
  const m = /Nova Invoice\s+(\d+)/i.exec(String(payment.note || ''));
  if (m) {
    // Deliberately restricted to attempts Nova itself opened and has not yet
    // settled. Matching a reconciled row would let a second card run on the
    // same invoice number quietly overwrite a settled payment.
    const byNote = await pool.query(
      'SELECT p.* FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id ' +
      'WHERE i.invoice_number = $1 AND p.status IN (\'offline_pending\', \'returned\', \'initiated\') ' +
      'ORDER BY p.id DESC LIMIT 1',
      [m[1]]
    );
    if (byNote.rows[0]) return byNote.rows[0];
  }
  return null;
}

module.exports = {
  configured: configured,
  callbackUrl: callbackUrl,
  sq: sq,
  signState: signState,
  verifyState: verifyState,
  newNonce: newNonce,
  buildPosUrls: buildPosUrls,
  brandToPayType: brandToPayType,
  errorMessage: errorMessage,
  isCancel: isCancel,
  isLocationError: isLocationError,
  locationErrorMessage: locationErrorMessage,
  verifyWebhook: verifyWebhook,
  reconcilePayment: reconcilePayment,
  findRowForPayment: findRowForPayment
};
