// Square callbacks. Mounted in server.js BEFORE express.json() so the webhook
// can read the raw body for signature verification — same reason routes/inbound
// is mounted early for Resend.
//
// Both routes here are UNAUTHENTICATED, because Square redirects a raw browser
// at the callback and POSTs the webhook from its own servers. Neither route can
// mark an invoice paid. The callback only moves an invoice_payments row from
// 'initiated' to 'returned'; the webhook only triggers a reconcile. The actual
// money write happens in utils/square.js reconcilePayment(), which asks Square
// directly rather than trusting anything that arrived in the request.
//
// NOTE: no backtick characters in this file. Windows corrupts them on this repo.

const express = require('express');
const { pool } = require('../db');
const square = require('../utils/square');

const router = express.Router();

// Where to send the browser back to. SQUARE_RETURN_BASE only exists as an
// override; the rest of Nova already uses APP_URL, so there is no reason to make
// anyone set a second variable that says the same thing.
function baseUrl(req) {
  if (process.env.SQUARE_RETURN_BASE) return String(process.env.SQUARE_RETURN_BASE).replace(/\/+$/, '');
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/+$/, '');
  const cb = square.callbackUrl();
  if (cb) {
    try {
      const u = new URL(cb);
      return u.origin;
    } catch (e) {}
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}

// Nova's SPA has no hash router — it deep-links off ?view=&id= (see the deep
// link IIFE in public/js/app.js), so the return uses the same shape and adds the
// nonce so the invoice screen knows which attempt to poll.
function backToInvoice(req, res, invoiceId, params) {
  const qs = ['view=view-invoice', 'id=' + Number(invoiceId)];
  Object.keys(params || {}).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  });
  res.redirect(302, baseUrl(req) + '/?' + qs.join('&'));
}

// Square gave us nothing we can tie to an invoice. There is nowhere sensible to
// send the browser, so say so plainly instead of bouncing to a random screen.
function deadEnd(res, message) {
  res.status(400).type('html').send(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0f0f0f;color:#f0f0f0;padding:32px;line-height:1.6">' +
    '<h2 style="margin:0 0 10px">Could not match this payment</h2>' +
    '<p style="color:#bbb;margin:0 0 18px">' + String(message || '') + '</p>' +
    '<p style="color:#888;font-size:13px;margin:0">Check the Square app to see whether the card was actually charged before trying again.</p>' +
    '</body>'
  );
}

// ---------------------------------------------------------------------------
// Point of Sale API return
//
// iOS redirects with ?data={json}. Android POSTs form-encoded extras.
// ---------------------------------------------------------------------------
async function handleCallback(req, res) {
  const src = Object.assign({}, req.query || {}, req.body || {});

  let state = src['com.squareup.pos.REQUEST_METADATA'] || src.state || '';
  let transactionId = src['com.squareup.pos.SERVER_TRANSACTION_ID'] || src.transaction_id || '';
  let clientTransactionId = src['com.squareup.pos.CLIENT_TRANSACTION_ID'] || src.client_transaction_id || '';
  let errorCode = src['com.squareup.pos.ERROR_CODE'] || src.error_code || '';
  let errorDescription = src['com.squareup.pos.ERROR_DESCRIPTION'] || src.error_description || '';

  // iOS packs everything into a single JSON blob.
  if (src.data) {
    try {
      const d = JSON.parse(src.data);
      state = d.state || state;
      transactionId = d.transaction_id || transactionId;
      clientTransactionId = d.client_transaction_id || clientTransactionId;
      errorCode = d.error_code || errorCode;
      errorDescription = d.error_description || d.error_message || errorDescription;
      if (d.status === 'error' && !errorCode) errorCode = 'data_invalid';
    } catch (e) {}
  }

  const v = square.verifyState(state);
  if (!v.ok) {
    return deadEnd(res, v.reason === 'expired'
      ? 'That payment attempt is older than 30 minutes, so Nova will not accept it automatically.'
      : 'The response from Square did not carry a valid Nova reference.');
  }

  // Single-use: the same UPDATE that finds the row consumes it. Read-then-write
  // would race if Square (or a retrying browser) fires the redirect twice.
  const claim = await pool.query(
    "UPDATE invoice_payments SET status = 'returned', returned_at = NOW(), updated_at = NOW() " +
    "WHERE state_nonce = $1 AND invoice_id = $2 AND status = 'initiated' RETURNING *",
    [v.nonce, v.invoiceId]
  );
  const row = claim.rows[0];

  if (!row) {
    // Already consumed, canceled, or never existed. If a row exists at all, send
    // the tech back to the invoice so they can see its real state.
    const existing = await pool.query('SELECT id FROM invoice_payments WHERE state_nonce = $1', [v.nonce]);
    if (existing.rows[0]) return backToInvoice(req, res, v.invoiceId, { sq: v.nonce });
    return deadEnd(res, 'Nova has no record of that payment attempt.');
  }

  if (errorCode) {
    const cancelled = square.isCancel(errorCode);

    // Nova's plain-English text WINS over Square's. Square's ERROR_DESCRIPTION is
    // written for a developer reading a stack trace, not a tech in a parking lot,
    // and on iOS it does not exist at all. Square's raw text is kept in last_error
    // so a manager can still see exactly what Square said.
    let msg = square.errorMessage(errorCode);

    // A location failure is the one error where the generic sentence is actively
    // misleading — the city IS mapped, it is just mapped to a location this phone
    // cannot charge against. Name both so nobody has to guess which of the two.
    if (square.isLocationError(errorCode)) {
      let cityCode = '';
      try {
        const c = await pool.query('SELECT city_code FROM invoices WHERE id = $1', [row.invoice_id]);
        cityCode = (c.rows[0] && c.rows[0].city_code) || '';
      } catch (e) {}
      msg = square.locationErrorMessage(cityCode, row.square_location_id);
    }

    await pool.query(
      'UPDATE invoice_payments SET status = $1, error_code = $2, error_description = $3, last_error = $4, updated_at = NOW() WHERE id = $5',
      [
        cancelled ? 'canceled' : 'failed',
        String(errorCode).slice(0, 60),
        msg.slice(0, 500),
        errorDescription ? ('Square said: ' + String(errorDescription)).slice(0, 500) : null,
        row.id
      ]
    );
    return backToInvoice(req, res, row.invoice_id, { sq: v.nonce });
  }

  // Offline mode: Square took the card on the device but has no server-side
  // payment yet. NOT paid. The cron sweep and the webhook finish it later.
  const status = transactionId ? 'returned' : 'offline_pending';
  await pool.query(
    'UPDATE invoice_payments SET status = $1, square_transaction_id = $2, square_client_transaction_id = $3, updated_at = NOW() WHERE id = $4',
    [status, transactionId || null, clientTransactionId || null, row.id]
  );

  // Kick the reconcile off now so the SPA usually finds it done on the first poll.
  if (transactionId) {
    square.reconcilePayment(row.id).catch(function (e) {
      console.error('Square reconcile failed for payment row ' + row.id + ':', e.message);
    });
  }

  return backToInvoice(req, res, row.invoice_id, { sq: v.nonce });
}

router.get('/pos-callback', function (req, res) {
  handleCallback(req, res).catch(function (e) {
    console.error('Square pos-callback error:', e);
    deadEnd(res, 'Nova hit an error handling the response from Square.');
  });
});

router.post('/pos-callback', express.urlencoded({ extended: false, limit: '256kb' }), function (req, res) {
  handleCallback(req, res).catch(function (e) {
    console.error('Square pos-callback error:', e);
    deadEnd(res, 'Nova hit an error handling the response from Square.');
  });
});

// ---------------------------------------------------------------------------
// Webhook
//
// The safety net for when the phone backgrounds and the redirect never lands.
// Always answer 200 quickly — Square retries on anything else, and a retry storm
// on a bug is worse than a missed event we can pick up on the cron sweep.
// ---------------------------------------------------------------------------
router.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const sig = req.get('x-square-hmacsha256-signature');
  const notifyUrl = process.env.SQUARE_WEBHOOK_URL || (baseUrl(req) + '/api/square/webhook');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));

  if (!square.verifyWebhook(raw, sig, notifyUrl)) {
    return res.status(401).json({ error: 'bad signature' });
  }

  let evt = null;
  try { evt = JSON.parse(raw.toString('utf8')); } catch (e) { evt = null; }
  if (!evt) return res.json({ ok: true });

  res.json({ ok: true });

  try {
    const type = String(evt.type || '');
    const obj = (evt.data && evt.data.object) || {};
    const payment = obj.payment || null;

    // Refund events. A card refund is accepted as PENDING and settles over the
    // next few days, so this is how a refund Nova sent becomes COMPLETED -- and,
    // more importantly, how one Square later gives up on gets put back in front
    // of a manager instead of sitting in Processed while the customer waits for
    // money that is never arriving.
    //
    // settleRefund() only ever updates a row Nova already sent (matched on the
    // Square refund id, or on a SENDING row whose response was lost). A refund
    // issued straight from the Square dashboard has no Nova row and is ignored
    // here on purpose: inventing a refund record from a webhook would let anyone
    // with the signature key write money off an invoice.
    if (type === 'refund.created' || type === 'refund.updated') {
      const refund = obj.refund || null;
      if (refund && refund.id) {
        try {
          await square.settleRefund(refund);
        } catch (e) {
          console.error('Square refund webhook failed for ' + refund.id + ':', e.message);
        }
      }
      return;
    }

    if (type === 'payment.created' || type === 'payment.updated') {
      const row = await square.findRowForPayment(payment);
      if (row) {
        if (row.status !== 'reconciled') {
          if (!row.square_transaction_id && payment.order_id) {
            await pool.query('UPDATE invoice_payments SET square_transaction_id = $1, updated_at = NOW() WHERE id = $2', [payment.order_id, row.id]);
          }
          await square.reconcilePayment(row.id);
        }
      } else if (payment && String(payment.status) === 'COMPLETED') {
        // A completed payment with no Nova invoice behind it. Not an error, but
        // it is exactly what the reconciliation report is for, so keep it.
        await pool.query(
          'INSERT INTO square_orphan_payments (square_payment_id, square_order_id, location_id, amount_cents, note, team_member_id, taken_at, raw_payment) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (square_payment_id) DO NOTHING',
          [
            payment.id,
            payment.order_id || null,
            payment.location_id || null,
            (payment.total_money && Number(payment.total_money.amount)) || 0,
            (payment.note || '').slice(0, 500),
            payment.team_member_id || payment.employee_id || null,
            payment.created_at || null,
            payment
          ]
        );
      }
    }
  } catch (e) {
    console.error('Square webhook handling error:', e.message);
  }
});

module.exports = router;
