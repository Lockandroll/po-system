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
    'SELECT id, invoice_number, status, subtotal, tax_amount, surcharge_amount, surcharge_rate, tip_amount, grand_total, authorized_total, locksmith_id, followup_task_id FROM invoices WHERE id = $1',
    [row.invoice_id]
  );
  const inv = invRes.rows[0];
  if (!inv) {
    await markRow(row.id, { status: 'failed', last_error: 'Invoice no longer exists' });
    return { ok: false, reason: 'invoice_gone', row: row };
  }

  // Square can apply its OWN card surcharge at the device or location level,
  // entirely outside anything Nova computed. It lands INSIDE amount_money (so
  // inside total_money and the pre-tip figure below), but Nova never added it to
  // the invoice total it sent, so before this fix every surcharged card failed the
  // amount check and demanded a manager (invoice 8000009, 2026-08-06). Pull it out
  // before comparing, then record it in surcharge_amount below so grand_total still
  // equals the card. Square only surcharges credit; debit and un-synced devices
  // report nothing, so this stays 0 on the normal path and changes nothing there.
  let squareSurchargeCents = 0;
  try {
    squareSurchargeCents = Number(payment.card_details.applied_card_surcharge_details.card_surcharge_money.amount) || 0;
  } catch (e) { squareSurchargeCents = 0; }
  if (!(squareSurchargeCents > 0)) squareSurchargeCents = 0;

  // Amount check. Compare the pre-tip figures, because the tip is the one part the
  // customer is allowed to change inside Square. Square's own surcharge is the only
  // other sanctioned addition, so it is removed here too; anything else moving means
  // the amount was edited on the device, and that must not silently mark paid.
  const invoicePreTip = money(inv.grand_total) - money(inv.tip_amount);
  const squareChargedPreTip = totalCents - tipCents;
  const squareBasePreTip = squareChargedPreTip - squareSurchargeCents;
  if (Math.abs(invoicePreTip - squareBasePreTip) > 1) {
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
      mismatch_reason: 'Invoice is ' + (invoicePreTip / 100).toFixed(2) + ' before tip; Square charged ' + (squareBasePreTip / 100).toFixed(2) + ' before tip' + (squareSurchargeCents > 0 ? (' (after removing a ' + (squareSurchargeCents / 100).toFixed(2) + ' card surcharge)') : '') + '.'
    });
    return { ok: false, reason: 'amount_mismatch', row: row, invoice: inv };
  }

  const payTypes = await allowedPayTypes();
  const payType = brandToPayType(card.card_brand, payTypes);
  const newTip = tipCents / 100;
  // WARNING: surcharge_amount MUST be in this sum. It is a real part of what the
  // card was charged, it lives in its own column and not in subtotal (so it stays
  // out of Pulsar and the royalty base), and leaving it out here silently rewrites
  // grand_total DOWN by the surcharge on every single Square payment. The amount
  // check above would still pass, because it compares against grand_total before
  // this line runs — so the invoice would settle as paid, look right, and disagree
  // with the card by 2.5% in the one column the dispute packet reads.
  // The surcharge to record on THIS payment: Square's applied surcharge when it
  // charged one, otherwise whatever the invoice already carried (so an invoice that
  // used Nova's own surcharge with Square's turned off is never silently rewritten
  // down). It stays in its own column, out of subtotal, so it never enters Pulsar
  // or the royalty base.
  const effectiveSurcharge = squareSurchargeCents > 0
    ? (squareSurchargeCents / 100)
    : (Number(inv.surcharge_amount) || 0);
  const effectiveRate = (squareSurchargeCents > 0 && squareBasePreTip > 0)
    ? Math.round((squareSurchargeCents / squareBasePreTip) * 1000) / 10
    : (Number(inv.surcharge_rate) || 0);
  const newGrand = (Number(inv.subtotal) || 0) + (Number(inv.tax_amount) || 0) +
    effectiveSurcharge + newTip;

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
    'surcharge_amount = $9, surcharge_rate = $10, ' +
    // A Square payment IS the finish line, so it stamps the same completion
    // fields the Complete Invoice button does and clears the waiting clock.
    // completed_by is the tech who started the payment, not "Square", so the
    // 15-minute reopen grace behaves the same either way.
    "status = 'paid', completed_at = NOW(), completed_by = $8, waiting_since = NULL, updated_at = NOW() WHERE id = $7",
    [
      payType,
      card.last_4 || null,
      (payment.card_details && payment.card_details.auth_result_code) || null,
      newTip,
      newGrand,
      (Number(inv.authorized_total) || Number(inv.grand_total) || 0),
      inv.id,
      row.initiated_by || null,
      effectiveSurcharge,
      effectiveRate
    ]
  );

  // Close the chase task if this invoice had one. Money is in; nobody should be
  // reminded to collect it.
  if (inv.followup_task_id) {
    try {
      await pool.query(
        "UPDATE tasks SET status = 'done', completed_at = NOW(), completed_by = $1, updated_at = NOW() " +
        "WHERE id = $2 AND status <> 'done'",
        [row.initiated_by || null, inv.followup_task_id]
      );
    } catch (e) {
      console.error('Could not close follow-up task ' + inv.followup_task_id + ':', e.message);
    }
  }

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

// ---------------------------------------------------------------------------
// Refunds
//
// Nova's refund ledger (invoice_refunds) is the record. This is the part that
// actually moves the money: POST /v2/refunds against the Square payment the
// invoice was settled with.
//
// Design rules, all of which exist because a refund CANNOT BE UNDONE:
//
//   1. The idempotency key is written to the row BEFORE Square is called and
//      reused on every retry. A double tap, a crashed request, or a browser
//      refresh reaches Square with the same key and Square returns the same
//      refund instead of making a second one.
//   2. The ceiling comes from Square (total charged minus everything already
//      refunded), not from Nova's ledger, and it is TIP INCLUSIVE. The tip is
//      added on the reader after the customer signs, so the Square payment is
//      routinely larger than the figure the invoice was authorized at. Trusting
//      Nova's own numbers here would under-refund every tipped job.
//   3. PENDING counts as issued. The money leaves Square the moment the refund
//      is accepted; it just takes a few days to land. Holding the ledger at
//      'approved' until COMPLETED would have Nova claiming the customer had not
//      been paid back while their bank was already processing it.
//   4. Anything Square refuses leaves the row exactly where it was, so the
//      manual paste-the-reference path still works. A failed API call must
//      never strand a refund in a state a human cannot finish.
// ---------------------------------------------------------------------------

// Square's own words, translated. Same rule as the payment errors: name the
// specific thing and the actual cause, because whoever reads this is being
// asked by a customer where their money is.
const REFUND_ERROR_TEXT = {
  INSUFFICIENT_FUNDS: 'Square does not have enough in the account to cover this refund right now. Square usually pulls the difference from the linked bank account within a day, so try again tomorrow, or move money into Square and retry. Nothing was refunded.',
  PAYMENT_NOT_REFUNDABLE: 'Square will not refund this payment. Square blocks refunds on a card payment more than one year old, and on a payment that was already fully refunded or charged back. Nothing was refunded.',
  REFUND_AMOUNT_INVALID: 'Square rejected the refund amount. It is either more than is left on the payment or not a whole number of cents. Nothing was refunded.',
  INVALID_AMOUNT: 'Square rejected the refund amount. Nothing was refunded.',
  REFUND_ALREADY_PENDING: 'Square already has a refund in progress against this payment. Wait for that one to finish before sending another. Nothing new was refunded by this attempt.',
  REFUND_DECLINED: 'The card issuer declined the refund. The card may be closed or expired. Refund the customer another way and record it here by hand. Nothing was refunded.',
  UNAUTHORIZED: 'Nova is not allowed to issue refunds on this Square account. The Square access token needs the Payments write permission. Nothing was refunded.',
  FORBIDDEN: 'Nova is not allowed to issue refunds on this Square account. The Square access token needs the Payments write permission. Nothing was refunded.',
  NOT_FOUND: 'Square has no record of the payment this invoice was settled with, under the account Nova is connected to. Nothing was refunded.',
  VERSION_MISMATCH: 'Square changed this payment while Nova was refunding it. Open the invoice again and retry. Nothing was refunded.',
  RATE_LIMITED: 'Square is rate limiting Nova right now. Wait a minute and try again. Nothing was refunded.',
  BAD_REQUEST: 'Square rejected the refund request. Tell an admin. Nothing was refunded.',
  unconfigured: 'Square is not connected to Nova yet, so a refund cannot be sent automatically. Issue it in the Square app and record the reference here by hand.'
};

function refundErrorMessage(code) {
  return REFUND_ERROR_TEXT[String(code || '')] ||
    'Square would not complete this refund. Check the Square dashboard before retrying so the customer is not refunded twice. Nothing was refunded.';
}

// Terminal in Square's eyes and NOT a transfer of money. These are the two
// statuses that have to put the refund back in the queue.
function refundFailed(status) {
  const s = String(status || '').toUpperCase();
  return s === 'REJECTED' || s === 'FAILED';
}

// Money has left (or is leaving) the account.
function refundLive(status) {
  const s = String(status || '').toUpperCase();
  return s === 'PENDING' || s === 'COMPLETED';
}

function newIdempotencyKey(refundRowId) {
  // Max 45 characters. This lands at 25.
  return 'nova-rf-' + Number(refundRowId) + '-' + crypto.randomBytes(5).toString('hex');
}

// The Square payment this invoice was actually settled with. Only a reconciled
// row counts: a returned-but-unreconciled attempt has no confirmed payment
// behind it, and refunding against a guess is how you refund a payment that
// never completed.
async function settledPaymentForInvoice(invoiceId) {
  const r = await pool.query(
    "SELECT * FROM invoice_payments WHERE invoice_id = $1 AND status = 'reconciled' " +
    'AND square_payment_id IS NOT NULL ORDER BY id DESC LIMIT 1',
    [invoiceId]
  );
  return r.rows[0] || null;
}

// What Square will still let us give back on this payment, in cents.
//
// TIP INCLUSIVE and deliberately so. total_money is what actually hit the card,
// tip and all. Nova's grand_total may be smaller (the invoice was authorized
// pre-tip) or the ledger may have been edited since, and neither is the number
// the bank moved.
function refundableCents(payment) {
  const total = (payment && payment.total_money && Number(payment.total_money.amount)) || 0;
  const already = (payment && payment.refunded_money && Number(payment.refunded_money.amount)) || 0;
  const left = total - already;
  return left > 0 ? left : 0;
}

function dollars(cents) {
  return '$' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// issueRefund — the narrow refund writer.
//
// Hand it a Nova invoice_refunds row id. It validates against Square, sends the
// refund, and writes the result back onto that ONE row. It touches no other
// table: the invoice's own figures are never edited by a refund (that is the
// whole premise of the ledger) and refunded_total is already covered because
// 'approved' and 'processed' both count toward it, so a refund reaching Square
// moves no money on the invoice that was not already committed at approval.
//
// Returns { ok, status, message, refund } and never throws for a Square-side
// refusal — a refusal is an answer, not a crash.
// ---------------------------------------------------------------------------
// Has this payment already been refunded by an attempt Nova failed to record?
//
// Square's Payment object carries refund_ids, so this asks Square directly
// rather than guessing. A candidate only counts when it is for exactly the
// amount Nova was trying to refund, Square did not reject it, and no other Nova
// row has already claimed it. Anything short of all three and this returns null
// and the ordinary path runs, because adopting the wrong refund would be worse
// than making somebody reconcile by hand.
async function findUnrecordedRefund(payment, amountCents) {
  const ids = (payment && payment.refund_ids) || [];
  if (!ids.length || !(amountCents > 0)) return null;
  for (let i = 0; i < ids.length; i++) {
    let r = null;
    try {
      const got = await sq('GET', '/v2/refunds/' + encodeURIComponent(ids[i]));
      r = got && got.refund;
    } catch (e) { continue; }
    if (!r || !r.id) continue;
    if (refundFailed(String(r.status || '').toUpperCase())) continue;
    const cents = (r.amount_money && Number(r.amount_money.amount)) || 0;
    if (cents !== amountCents) continue;
    try {
      const taken = await pool.query('SELECT id FROM invoice_refunds WHERE square_refund_id = $1', [r.id]);
      if (taken.rowCount) continue;
    } catch (e) { continue; }
    return r;
  }
  return null;
}

async function issueRefund(refundRowId, actorUserId) {
  const rowRes = await pool.query('SELECT * FROM invoice_refunds WHERE id = $1', [refundRowId]);
  const row = rowRes.rows[0];
  if (!row) return { ok: false, reason: 'not_found', message: 'Refund not found.' };

  if (refundLive(row.square_status) && row.square_refund_id) {
    return {
      ok: true, already: true, status: String(row.square_status).toUpperCase(), row: row,
      message: 'Refund ' + row.refund_number + ' was already sent to Square as ' + row.square_refund_id + '.'
    };
  }
  if (row.status !== 'approved') {
    return { ok: false, reason: 'bad_status', message: 'Only an approved refund can be sent to Square (refund ' + row.refund_number + ' is ' + row.status + ').' };
  }
  if (row.method !== 'card') {
    return { ok: false, reason: 'not_card', message: 'Refund ' + row.refund_number + ' is set to give the money back as ' + row.method + ', not to the card, so Square cannot process it. Record it here by hand instead.' };
  }
  if (!configured()) {
    return { ok: false, reason: 'unconfigured', message: refundErrorMessage('unconfigured') };
  }

  const invRes = await pool.query('SELECT id, invoice_number, grand_total, tip_amount FROM invoices WHERE id = $1', [row.invoice_id]);
  const inv = invRes.rows[0];
  if (!inv) return { ok: false, reason: 'invoice_gone', message: 'The invoice behind refund ' + row.refund_number + ' no longer exists.' };

  const settled = await settledPaymentForInvoice(row.invoice_id);
  if (!settled) {
    return {
      ok: false, reason: 'no_square_payment',
      message: 'Invoice #' + inv.invoice_number + ' was not paid through Square in Nova, so there is no Square payment to refund against. Either the card was run outside Nova or it was paid another way. Issue the refund in the Square app and record the reference here by hand.'
    };
  }

  // Ask Square what the payment looks like RIGHT NOW rather than trusting the
  // snapshot Nova stored when it settled. Somebody may have refunded part of it
  // from the Square dashboard in the meantime, and Nova would not know.
  let payment = null;
  try {
    const got = await sq('GET', '/v2/payments/' + encodeURIComponent(settled.square_payment_id));
    payment = got && got.payment;
  } catch (e) {
    const code = e.squareCode || (e.status === 404 ? 'NOT_FOUND' : (e.code === 'unconfigured' ? 'unconfigured' : ''));
    await markRefund(row.id, {
      square_status: 'FAILED',
      square_error_code: String(code || 'lookup_failed').slice(0, 60),
      square_error: refundErrorMessage(code),
      square_attempts: Number(row.square_attempts || 0) + 1
    });
    return { ok: false, reason: 'lookup_failed', message: refundErrorMessage(code) };
  }
  if (!payment) {
    const msg = refundErrorMessage('NOT_FOUND');
    await markRefund(row.id, { square_status: 'FAILED', square_error_code: 'NOT_FOUND', square_error: msg, square_attempts: Number(row.square_attempts || 0) + 1 });
    return { ok: false, reason: 'no_payment', message: msg };
  }

  const amountCents = Math.round((Number(row.amount) || 0) * 100);
  if (!(amountCents > 0)) {
    return { ok: false, reason: 'zero', message: 'Refund ' + row.refund_number + ' is for nothing, so there is nothing to send.' };
  }

  // ---- Recover a refund that went out but never got written ---------------
  // A row sitting in SENDING with no refund id means Square WAS asked and Nova
  // never managed to record the answer. Retrying blind is no good: Square has
  // already taken the money, so refundableCents is now zero and the ceiling
  // check below would refuse it forever, leaving the ledger permanently
  // claiming a customer had not been paid back when they had. Ask Square what
  // it actually did with this payment and adopt that refund instead.
  let recovered = null;
  if (String(row.square_status || '').toUpperCase() === 'SENDING' && !row.square_refund_id) {
    try { recovered = await findUnrecordedRefund(payment, amountCents); } catch (e) { recovered = null; }
    if (recovered) {
      console.log('Recovering Square refund ' + recovered.id + ' for ' + dollars(amountCents) +
        ' on invoice #' + inv.invoice_number + ': it went out on an earlier attempt that Nova never recorded.');
    }
  }

  const ceiling = refundableCents(payment);
  if (!recovered && amountCents > ceiling) {
    const totalCents = (payment.total_money && Number(payment.total_money.amount)) || 0;
    const doneCents = (payment.refunded_money && Number(payment.refunded_money.amount)) || 0;
    const msg = ceiling <= 0
      ? ('Square payment ' + payment.id + ' on invoice #' + inv.invoice_number + ' has already been refunded in full (' + dollars(doneCents) + ' of ' + dollars(totalCents) + '). There is nothing left to give back. Nothing was refunded.')
      : ('Refund ' + row.refund_number + ' is for ' + dollars(amountCents) + ', but only ' + dollars(ceiling) + ' is left on Square payment ' + payment.id + ' (' + dollars(totalCents) + ' was charged and ' + dollars(doneCents) + ' has already been refunded, possibly from the Square dashboard). Nothing was refunded.');
    await markRefund(row.id, {
      square_payment_id: payment.id,
      square_status: 'FAILED',
      square_error_code: 'REFUND_AMOUNT_INVALID',
      square_error: msg,
      square_attempts: Number(row.square_attempts || 0) + 1
    });
    return { ok: false, reason: 'over_ceiling', message: msg, refundable_cents: ceiling };
  }

  // Claim the row and pin the idempotency key BEFORE Square is called. COALESCE
  // means a retry reuses the original key, which is the whole safety net: Square
  // answers a repeat of the same key with the SAME refund rather than a new one.
  // The guard is square_refund_id IS NULL, so a previous FAILED attempt can be
  // retried but an accepted one can never be sent twice.
  const claim = await pool.query(
    'UPDATE invoice_refunds SET square_idempotency_key = COALESCE(square_idempotency_key, $1), ' +
    "square_payment_id = $2, square_order_id = $3, square_amount_cents = $4, square_status = 'SENDING', " +
    'square_sent_at = NOW(), square_sent_by = $5, square_attempts = COALESCE(square_attempts, 0) + 1, ' +
    'square_error = NULL, square_error_code = NULL, updated_at = NOW() ' +
    "WHERE id = $6 AND status = 'approved' AND square_refund_id IS NULL RETURNING *",
    [newIdempotencyKey(row.id), payment.id, payment.order_id || settled.square_order_id || null, amountCents, actorUserId || null, row.id]
  );
  if (!claim.rowCount) {
    return { ok: false, reason: 'raced', message: 'That refund was just changed by someone else. Reload and check whether it already went to Square.' };
  }
  const claimed = claim.rows[0];

  // Attribute the refund to the person issuing it where Nova knows their Square
  // team member id. Silent when it is not mapped — a missing mapping must never
  // stop a customer getting their money back.
  let teamMemberId = null;
  if (!recovered && actorUserId) {
    try {
      const u = await pool.query('SELECT square_team_member_id FROM users WHERE id = $1', [actorUserId]);
      teamMemberId = (u.rows[0] && u.rows[0].square_team_member_id) || null;
    } catch (e) { teamMemberId = null; }
  }

  const body = {
    idempotency_key: claimed.square_idempotency_key,
    payment_id: payment.id,
    amount_money: { amount: amountCents, currency: (payment.total_money && payment.total_money.currency) || 'USD' },
    reason: ('Nova ' + (claimed.refund_number || '') + ' invoice ' + inv.invoice_number + ' ' + (claimed.reason_code || '')).trim().slice(0, 190)
  };
  if (teamMemberId) body.team_member_id = teamMemberId;

  // The recovery case is already holding Square's answer, so it must NOT post
  // again. Everything below this point treats the two paths identically.
  let refund = recovered;
  try {
    if (!recovered) {
      const resp = await sq('POST', '/v2/refunds', body);
      refund = resp && resp.refund;
    }
  } catch (e) {
    const code = e.squareCode || (e.status === 429 ? 'RATE_LIMITED' : (e.status === 401 || e.status === 403 ? 'UNAUTHORIZED' : 'BAD_REQUEST'));
    const msg = refundErrorMessage(code);
    let raw = null;
    try { raw = e.body && e.body.errors ? e.body.errors[0].detail : null; } catch (e2) { raw = null; }
    await markRefund(claimed.id, {
      square_status: 'FAILED',
      square_error_code: String(code).slice(0, 60),
      square_error: msg + (raw ? (' Square said: ' + String(raw)) : '')
    });
    return { ok: false, reason: 'square_refused', code: code, message: msg, square_detail: raw };
  }

  if (!refund || !refund.id) {
    const msg = refundErrorMessage('BAD_REQUEST');
    await markRefund(claimed.id, { square_status: 'FAILED', square_error_code: 'no_refund', square_error: msg });
    return { ok: false, reason: 'no_refund', message: msg };
  }

  const sqStatus = String(refund.status || 'PENDING').toUpperCase();

  // Square took the request but will not pay it. Leave the ledger at 'approved'
  // so it stays in the queue and the manual path is still open.
  if (refundFailed(sqStatus)) {
    const msg = 'Square ' + sqStatus.toLowerCase() + ' this refund (' + refund.id + '). ' + refundErrorMessage('REFUND_DECLINED');
    await markRefund(claimed.id, {
      square_status: sqStatus,
      square_error_code: sqStatus,
      square_error: msg,
      raw_refund: refund
    });
    return { ok: false, reason: 'square_failed', status: sqStatus, message: msg };
  }

  let feeCents = 0;
  try {
    (refund.processing_fee || []).forEach(function (f) { feeCents += Number((f.amount_money || {}).amount) || 0; });
  } catch (e) { feeCents = 0; }

  // ---- The write --------------------------------------------------------
  // One statement, only this row, guarded on 'approved' so it cannot resurrect
  // a refund somebody voided while Square was thinking. external_ref is filled
  // with the Square refund id, which is exactly what a human would have pasted
  // in by hand, so every downstream reader keeps working untouched.
  // The ::text casts are load bearing. A parameter used in two places has to
  // resolve to ONE type, and square_refund_id next to external_ref, or
  // square_status next to a comparison, gives Postgres two candidates and it
  // refuses the whole statement with "inconsistent types deduced for
  // parameter". Pinning both sides to text settles it.
  //
  // PAST THIS POINT THE MONEY HAS ALREADY LEFT THE ACCOUNT. Everything below is
  // recording, not deciding, so nothing here is allowed to throw its way out of
  // this function. An exception escaping here is how Nova once ended up with a
  // refund the customer had been paid and no record of it: the column was too
  // narrow for the Square refund id, the UPDATE threw, and the caller reported a
  // failure for money that was gone.
  let done = null;
  let writeError = null;
  try {
    done = await pool.query(
      "UPDATE invoice_refunds SET status = 'processed', square_refund_id = $1::text, square_status = $2::text, " +
      "square_processing_fee_cents = $3, square_settled_at = CASE WHEN $2::text = 'COMPLETED' THEN NOW() ELSE NULL END, " +
      'external_ref = $1::text, processed_by = COALESCE($4, approved_by), processed_at = NOW(), ' +
      // Square shows the refund on the PAYMENT's receipt (same receipt number),
      // so this is payment.receipt_url. There is no separate refund receipt.
      'refund_date = CURRENT_DATE, raw_refund = $5, square_receipt_url = $7::text, square_error = NULL, square_error_code = NULL, updated_at = NOW() ' +
      "WHERE id = $6 AND status = 'approved' RETURNING *",
      [refund.id, sqStatus, feeCents, actorUserId || null, refund, claimed.id, payment.receipt_url || null]
    );
  } catch (e) {
    writeError = e;
    console.error('MONEY MOVED BUT NOVA COULD NOT RECORD IT. Square refund ' + refund.id +
      ' for ' + dollars(amountCents) + ' on invoice #' + inv.invoice_number + ':', e.message);
  }

  if (writeError || !done.rowCount) {
    // Square HAS refunded the money but Nova could not write the normal row,
    // either because it moved out from under us or because the write itself
    // failed. Do not lose the refund id: without it nobody can tie the money
    // back to a record. Written unguarded on purpose, and loudly.
    const why = writeError
      ? ('Square issued refund ' + refund.id + ' for ' + dollars(amountCents) + ', but Nova could not save it (' + writeError.message + '). The money HAS left the account. A manager needs to reconcile this by hand.')
      : ('Square issued refund ' + refund.id + ' for ' + dollars(amountCents) + ', but this refund record had already changed status. The money HAS left the account. A manager needs to reconcile this by hand.');
    try {
      await markRefund(claimed.id, {
        square_refund_id: refund.id,
        square_status: sqStatus,
        raw_refund: refund,
        square_receipt_url: payment.receipt_url || null,
        square_error: why
      });
    } catch (e) {
      // Even the recovery write failed. square_error is TEXT and always fits, so
      // fall back to it alone rather than leaving no trace at all.
      console.error('Could not record Square refund ' + refund.id + ' on refund row ' + claimed.id + ':', e.message);
      try {
        await pool.query('UPDATE invoice_refunds SET square_error = $1, updated_at = NOW() WHERE id = $2', [why, claimed.id]);
      } catch (e2) { console.error('Could not even write square_error for refund row ' + claimed.id + ':', e2.message); }
    }
    try {
      await logAudit({
        entity_type: 'refund', entity_id: claimed.id, entity_number: claimed.refund_number,
        action: 'square_refund_orphaned', user_id: actorUserId || null, user_name: 'Square',
        details: { square_refund_id: refund.id, amount_cents: amountCents, invoice: inv.invoice_number, write_error: writeError ? writeError.message : null }
      });
    } catch (e) {}
    return {
      ok: false,
      reason: writeError ? 'write_failed_after_send' : 'raced_after_send',
      money_moved: true,
      square_refund_id: refund.id,
      message: 'Square issued refund ' + refund.id + ' for ' + dollars(amountCents) + ', but Nova could not record it. THE MONEY HAS LEFT THE ACCOUNT. Do not send this refund again. Check the invoice and the Square dashboard before doing anything else.'
    };
  }

  try {
    await logAudit({
      entity_type: 'refund', entity_id: claimed.id, entity_number: claimed.refund_number,
      action: 'refunded_via_square', user_id: actorUserId || null, user_name: 'Square',
      details: {
        invoice: inv.invoice_number,
        square_refund_id: refund.id,
        square_payment_id: payment.id,
        amount: (amountCents / 100),
        square_status: sqStatus,
        processing_fee_returned: (feeCents / 100)
      }
    });
  } catch (e) {}

  return {
    ok: true,
    status: sqStatus,
    recovered: !!recovered,
    refund: refund,
    row: done.rows[0],
    amount_cents: amountCents,
    // The recovery wording matters. Telling a manager "Square refunded $1.00"
    // when the money actually went out days ago would have them looking for a
    // second charge on the customer statement that is not there.
    message: recovered
      ? ('This refund had already gone through Square (' + refund.id + ') on an earlier attempt that Nova failed to record. Nothing new was charged or refunded. The record is now correct: ' + dollars(amountCents) + ' back to the card ending ' + (settled.card_last4 || '----') + '.')
      : (sqStatus === 'COMPLETED'
        ? ('Square refunded ' + dollars(amountCents) + ' to the card ending ' + (settled.card_last4 || '----') + '.')
        : ('Square accepted the ' + dollars(amountCents) + ' refund. It usually reaches the customer bank in a few business days.'))
  };
}

async function markRefund(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(function (k, i) { return k + ' = $' + (i + 1); });
  sets.push('updated_at = NOW()');
  const vals = keys.map(function (k) { return fields[k]; });
  vals.push(id);
  await pool.query('UPDATE invoice_refunds SET ' + sets.join(', ') + ' WHERE id = $' + vals.length, vals);
}

// ---------------------------------------------------------------------------
// settleRefund — apply a Square refund object to the Nova row it belongs to.
//
// Called by the webhook (refund.created / refund.updated) and by the SPA poll.
// This is how a PENDING refund becomes COMPLETED, and, more importantly, how a
// refund Square later gives up on gets put back in front of a human instead of
// sitting in 'Processed' forever while the customer waits for money that is
// never coming.
// ---------------------------------------------------------------------------
async function settleRefund(squareRefund) {
  if (!squareRefund || !squareRefund.id) return { ok: false, reason: 'no_refund' };
  const found = await pool.query('SELECT * FROM invoice_refunds WHERE square_refund_id = $1', [squareRefund.id]);
  let row = found.rows[0];
  // A refund Nova sent whose response never came back (crashed request, lost
  // connection). The idempotency key ties it home.
  if (!row && squareRefund.payment_id) {
    const byPay = await pool.query(
      "SELECT * FROM invoice_refunds WHERE square_payment_id = $1 AND square_status = 'SENDING' " +
      'AND square_refund_id IS NULL ORDER BY id DESC LIMIT 1',
      [squareRefund.payment_id]
    );
    row = byPay.rows[0];
  }
  if (!row) return { ok: false, reason: 'not_ours' };

  const sqStatus = String(squareRefund.status || '').toUpperCase();
  if (!sqStatus) return { ok: false, reason: 'no_status' };
  if (String(row.square_status || '').toUpperCase() === sqStatus && row.square_refund_id) {
    return { ok: true, already: true, row: row };
  }

  let feeCents = 0;
  try {
    (squareRefund.processing_fee || []).forEach(function (f) { feeCents += Number((f.amount_money || {}).amount) || 0; });
  } catch (e) { feeCents = 0; }

  if (refundFailed(sqStatus)) {
    // The money did NOT move. Put the refund back in the awaiting queue with the
    // reason attached, and take the Square reference off external_ref so nobody
    // reads a rejected refund id as proof the customer was paid. The ledger
    // amount is untouched, so refunded_total does not move either: 'approved'
    // and 'processed' both count, which is exactly why this reversal is safe.
    await pool.query(
      "UPDATE invoice_refunds SET status = CASE WHEN status = 'processed' THEN 'approved' ELSE status END, " +
      'square_status = $1::text, square_settled_at = NOW(), square_processing_fee_cents = $2, raw_refund = $3, ' +
      'square_error_code = $1::text, square_error = $4, ' +
      "external_ref = CASE WHEN external_ref = square_refund_id THEN NULL ELSE external_ref END, " +
      "processed_by = CASE WHEN status = 'processed' THEN NULL ELSE processed_by END, " +
      "processed_at = CASE WHEN status = 'processed' THEN NULL ELSE processed_at END, " +
      'updated_at = NOW() WHERE id = $5',
      [
        sqStatus,
        feeCents,
        squareRefund,
        'Square ' + sqStatus.toLowerCase() + ' refund ' + squareRefund.id + ' after accepting it. The customer has NOT been paid. ' + refundErrorMessage('REFUND_DECLINED'),
        row.id
      ]
    );
    try {
      await logAudit({
        entity_type: 'refund', entity_id: row.id, entity_number: row.refund_number,
        action: 'square_refund_failed', user_id: null, user_name: 'Square',
        details: { square_refund_id: squareRefund.id, status: sqStatus }
      });
    } catch (e) {}
    return { ok: false, reason: 'square_failed', status: sqStatus, row: row };
  }

  await pool.query(
    'UPDATE invoice_refunds SET square_refund_id = $1::text, square_status = $2::text, square_processing_fee_cents = $3, ' +
    "square_settled_at = CASE WHEN $2::text = 'COMPLETED' THEN NOW() ELSE square_settled_at END, " +
    'raw_refund = $4, square_error = NULL, square_error_code = NULL, ' +
    'external_ref = COALESCE(external_ref, $1::text), updated_at = NOW() WHERE id = $5',
    [squareRefund.id, sqStatus, feeCents, squareRefund, row.id]
  );
  return { ok: true, status: sqStatus, row: row };
}

// Ask Square directly what a refund is doing. Used by the SPA poll so a manager
// watching the screen does not have to wait for a webhook to arrive.
// A row left in SENDING with no refund id is a refund Square DID take and Nova
// never managed to write down. Until this existed, nothing healed it on its own:
// the webhook is the only other route home, and if that never lands the ledger
// sits there claiming a customer was not paid back when they were. Ask Square
// what it actually did with the payment and adopt it.
//
// Read-only against Square. It can never ISSUE a refund, so it is safe to call
// from a plain GET that any viewer can trigger.
async function recoverStuckRefund(refundRowId) {
  const r = await pool.query('SELECT * FROM invoice_refunds WHERE id = $1', [refundRowId]);
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.square_refund_id) return { ok: false, reason: 'already_recorded' };
  if (String(row.square_status || '').toUpperCase() !== 'SENDING') return { ok: false, reason: 'not_stuck' };
  if (!row.square_payment_id) return { ok: false, reason: 'no_payment' };
  const amountCents = Number(row.square_amount_cents) || Math.round((Number(row.amount) || 0) * 100);
  if (!(amountCents > 0)) return { ok: false, reason: 'zero' };
  try {
    const got = await sq('GET', '/v2/payments/' + encodeURIComponent(row.square_payment_id));
    const payment = got && got.payment;
    if (!payment) return { ok: false, reason: 'no_payment' };
    const found = await findUnrecordedRefund(payment, amountCents);
    if (!found) return { ok: false, reason: 'nothing_to_adopt' };
    console.log('Recovering Square refund ' + found.id + ' onto refund row ' + row.id +
      ': it went out on an earlier attempt that Nova never recorded.');
    return await settleRefund(found);
  } catch (e) {
    return { ok: false, reason: 'lookup_failed', message: e.message };
  }
}

async function refreshRefund(refundRowId) {
  const r = await pool.query('SELECT * FROM invoice_refunds WHERE id = $1', [refundRowId]);
  const row = r.rows[0];
  if (!row || !row.square_refund_id) return { ok: false, reason: 'not_sent' };
  try {
    const got = await sq('GET', '/v2/refunds/' + encodeURIComponent(row.square_refund_id));
    const refund = got && got.refund;
    if (!refund) return { ok: false, reason: 'not_found' };
    return await settleRefund(refund);
  } catch (e) {
    return { ok: false, reason: 'lookup_failed', message: e.message };
  }
}

module.exports = {
  configured: configured,
  callbackUrl: callbackUrl,
  sq: sq,
  issueRefund: issueRefund,
  settleRefund: settleRefund,
  refreshRefund: refreshRefund,
  recoverStuckRefund: recoverStuckRefund,
  refundErrorMessage: refundErrorMessage,
  refundFailed: refundFailed,
  refundLive: refundLive,
  refundableCents: refundableCents,
  settledPaymentForInvoice: settledPaymentForInvoice,
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
