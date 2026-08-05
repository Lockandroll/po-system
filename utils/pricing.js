const { pool } = require('../db');
const tc = require('./timeCodes');
const zones = require('./zones');

// ---------------------------------------------------------------------------
//  What a call costs, and what ETA the customer is told
// ---------------------------------------------------------------------------
// Resolution order, and it is not negotiable:
//   1. account + service + city + time code
//   2. account + service + city   (any code)
//   3. account + service          (any city, any code)
//   4. the TIME CODE covering the moment the call was created  <- the retail path
//   5. nothing matched -> no price, shown amber as "Price not set"
// Then the coverage zone's override, when zones land.
//
// Everything the answer depended on is snapshotted onto the call, not just the
// number: which time code, which source. A price change next month must not
// restate what a customer was quoted last Tuesday, and nobody should have to
// reverse-engineer a figure six months later.
// ---------------------------------------------------------------------------

async function cityTimezone(cityCode) {
  if (!cityCode) return 'America/New_York';
  try {
    const r = await pool.query('SELECT timezone FROM cities WHERE TRIM(code) = TRIM($1)', [cityCode]);
    return (r.rows[0] && r.rows[0].timezone) || 'America/New_York';
  } catch (e) { return 'America/New_York'; }
}

async function eduIsFree() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'dispatch_edu_free'");
    if (!r.rows.length) return true;
    return String(r.rows[0].value) !== '0';
  } catch (e) { return true; }
}

async function timeCodesFor(cityCode, serviceTypeId) {
  if (!cityCode || !serviceTypeId) return [];
  const r = await pool.query(
    'SELECT stc.* FROM service_time_codes stc ' +
    'JOIN location_services ls ON ls.id = stc.location_service_id ' +
    'WHERE TRIM(ls.city_code) = TRIM($1) AND ls.service_type_id = $2 ' +
    '  AND ls.active = true AND stc.active = true ORDER BY stc.code_id',
    [cityCode, serviceTypeId]);
  return r.rows;
}

// Most specific wins. Ordered in SQL rather than in JS so the tie-break is the
// same wherever this is called from.
async function accountPriceFor(accountId, serviceTypeId, cityCode, codeId) {
  if (!accountId || !serviceTypeId) return null;
  const r = await pool.query(
    'SELECT * FROM account_service_prices ' +
    'WHERE account_id = $1 AND service_type_id = $2 AND active = true ' +
    '  AND effective_from <= CURRENT_DATE ' +
    '  AND (effective_to IS NULL OR effective_to >= CURRENT_DATE) ' +
    '  AND (city_code IS NULL OR TRIM(city_code) = TRIM($3)) ' +
    '  AND (code_id IS NULL OR code_id = $4) ' +
    'ORDER BY (city_code IS NOT NULL)::int DESC, (code_id IS NOT NULL)::int DESC, ' +
    '         effective_from DESC, id DESC LIMIT 1',
    [accountId, serviceTypeId, cityCode || null, codeId || null]);
  return r.rows[0] || null;
}

/**
 * @param {object} o service_type_id, city_code, account_id, is_edu, when
 * @returns price / additional / eta / source / time_code_id, plus a reason when
 *          nothing could be worked out.
 */
async function quote(o) {
  const opts = o || {};
  const out = {
    time_code_id: null, time_code_title: null,
    price: null, additional: null, price_source: null,
    eta_minutes: null, eta_low: null, eta_high: null, eta_source: null,
    reason: null
  };
  if (!opts.service_type_id) { out.reason = 'no_service_type'; return out; }
  if (!opts.city_code) { out.reason = 'no_city'; return out; }

  const tz = await cityTimezone(opts.city_code);
  const codes = await timeCodesFor(opts.city_code, opts.service_type_id);
  const when = opts.when ? new Date(opts.when) : new Date();
  const code = tc.codeAt(codes, when, tz);

  if (code) {
    out.time_code_id = code.id;
    out.time_code_title = code.title;
    // A shutdown message means the service is deliberately closed then. That is
    // an answer, not a gap, and it belongs in front of the dispatcher.
    if (code.shutdown_message) out.shutdown_message = code.shutdown_message;
  } else if (!codes.length) {
    out.reason = 'no_time_codes';
  } else {
    // Configured, but this minute belongs to nobody. Deliberately loud.
    out.reason = 'uncovered_minute';
  }

  // ---- price -------------------------------------------------------------
  const acct = await accountPriceFor(opts.account_id, opts.service_type_id,
    opts.city_code, code ? code.code_id : null);
  if (acct) {
    out.price = Number(acct.full_charge);
    out.additional = Number(acct.additional_charge || 0);
    out.price_source = 'account';
    if (acct.eta_minutes) {
      out.eta_minutes = acct.eta_minutes;
      out.eta_low = acct.eta_minutes;
      out.eta_high = acct.eta_minutes;
      out.eta_source = 'account';
    }
  } else if (code && code.full_charge !== null && code.full_charge !== undefined) {
    out.price = Number(code.full_charge);
    out.additional = Number(code.additional_charge || 0);
    out.price_source = 'time_code';
  } else if (!out.reason) {
    out.reason = 'price_not_set';
  }

  // ---- EDU is free to the customer --------------------------------------
  // Applied AFTER the price is worked out, and it does not touch the pay side:
  // the tech is still paid for an EDU from their own pay row. A pay engine that
  // derived pay from price would quietly pay nothing for the one call type
  // where somebody is trapped in a hot car.
  if (opts.is_edu && (await eduIsFree())) {
    out.price = 0;
    out.additional = 0;
    out.price_source = 'edu_free';
    if (out.reason === 'price_not_set') out.reason = null;
  }

  // ---- the coverage zone, on top of whatever won ------------------------
  // Applied LAST, so it modifies the winning price rather than competing with
  // it. That is the whole reason zones may not overlap: one match, one
  // adjustment, no precedence rule to forget.
  if (opts.zone) {
    out.zone_id = opts.zone.id;
    out.zone_name = opts.zone.name;
    // ⚠️ NOT on a free EDU. A zone surcharge on a child locked in a hot car
    // would turn a free public service into a $25 bill, which is both wrong and
    // the sort of wrong that ends up in a local news story. The ETA adjustment
    // below still applies - a far zone really is further away, and promising 20
    // minutes when it is 35 is a worse lie on an EDU than on a lockout.
    if (out.price_source === 'edu_free') {
      out.zone_price_adj = null;
    } else {
      const adj = zones.applyPriceAdjust(out.price, opts.zone);
      out.price = adj.price;
      out.zone_price_adj = adj.adjust;
      if (adj.adjust) out.price_source = (out.price_source || 'time_code') + '+zone';
    }
  } else if (opts.out_of_area) {
    out.out_of_area = true;
  }

  // ---- ETA ---------------------------------------------------------------
  if (!out.eta_source) {
    const eta = tc.etaFor(code, { is_edu: !!opts.is_edu, has_account: !!opts.account_id });
    if (eta) {
      out.eta_minutes = eta.minutes;
      out.eta_low = eta.low;
      out.eta_high = eta.high;
      out.eta_source = eta.source;
    }
  }
  // Last resort: the catalog default on the service type itself, so a city with
  // no time codes configured yet still quotes something sane.
  if (!out.eta_minutes) {
    try {
      const st = await pool.query('SELECT default_eta_minutes FROM service_types WHERE id = $1', [opts.service_type_id]);
      if (st.rows[0] && st.rows[0].default_eta_minutes) {
        out.eta_minutes = st.rows[0].default_eta_minutes;
        out.eta_low = out.eta_minutes;
        out.eta_high = out.eta_minutes;
        out.eta_source = 'default';
      }
    } catch (e) {}
  }
  // The zone's ETA adjustment rides on top of whichever ETA won, for the same
  // reason the price adjustment does.
  if (opts.zone && out.eta_minutes) {
    const before = out.eta_minutes;
    out.eta_minutes = zones.applyEtaAdjust(out.eta_minutes, opts.zone);
    if (out.eta_low) out.eta_low = zones.applyEtaAdjust(out.eta_low, opts.zone);
    if (out.eta_high) out.eta_high = zones.applyEtaAdjust(out.eta_high, opts.zone);
    if (out.eta_minutes !== before) out.eta_source = (out.eta_source || 'core') + '+zone';
  }
  return out;
}

module.exports = {
  quote: quote,
  cityTimezone: cityTimezone,
  timeCodesFor: timeCodesFor,
  accountPriceFor: accountPriceFor,
  eduIsFree: eduIsFree
};
