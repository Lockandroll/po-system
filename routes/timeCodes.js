const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const tc = require('../utils/timeCodes');
const pricing = require('../utils/pricing');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Location Settings - Pricing & Service
// ---------------------------------------------------------------------------
// Per service, per location: the named windows of the week that carry a price
// and three ETAs. The one rule worth knowing is that a save is REFUSED if the
// week has a gap or an overlap - a 2am call landing in an uncovered minute has
// no price and no ETA, and you find out at 2am.
// ---------------------------------------------------------------------------

function s(v, n) {
  return v === undefined || v === null ? null : String(v).trim().slice(0, n) || null;
}
function money(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function smallint(v, min, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

// ---- which services a city offers ----------------------------------------
router.get('/locations/:cityCode/services', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  const city = String(req.params.cityCode || '').trim().slice(0, 3);
  const r = await pool.query(
    'SELECT ls.id, ls.service_type_id, ls.active, ls.sort, st.code, st.name, st.category_code, ' +
    '       (SELECT COUNT(*)::int FROM service_time_codes x WHERE x.location_service_id = ls.id AND x.active = true) AS code_count, ' +
    '       (SELECT COUNT(*)::int FROM service_time_codes x WHERE x.location_service_id = ls.id AND x.active = true AND x.full_charge IS NULL) AS unpriced ' +
    'FROM location_services ls JOIN service_types st ON st.id = ls.service_type_id ' +
    'WHERE TRIM(ls.city_code) = TRIM($1) ORDER BY ls.sort, st.name', [city]);
  const tz = await pool.query('SELECT name, timezone FROM cities WHERE TRIM(code) = TRIM($1)', [city]);
  res.json({
    city_code: city,
    city_name: (tz.rows[0] && tz.rows[0].name) || city,
    timezone: (tz.rows[0] && tz.rows[0].timezone) || 'America/New_York',
    services: r.rows
  });
});

router.post('/locations/:cityCode/services', requireAuth, requirePermission('manage_pricing'), async function (req, res) {
  const city = String(req.params.cityCode || '').trim().slice(0, 3);
  const stId = parseInt((req.body && req.body.service_type_id) || 0, 10);
  if (!stId) return res.status(400).json({ error: 'Pick a service.' });
  const r = await pool.query(
    'INSERT INTO location_services (city_code, service_type_id) VALUES ($1,$2) ' +
    'ON CONFLICT (city_code, service_type_id) DO UPDATE SET active = true RETURNING id',
    [city, stId]);
  res.json({ ok: true, id: r.rows[0].id });
});

router.post('/locations/:cityCode/timezone', requireAuth, requirePermission('manage_pricing'), async function (req, res) {
  const city = String(req.params.cityCode || '').trim().slice(0, 3);
  const zone = s(req.body && req.body.timezone, 64) || 'America/New_York';
  // Prove the zone is real before storing it: a typo here silently moves every
  // future call in that city into the wrong time code.
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date()); }
  catch (e) { return res.status(400).json({ error: 'That is not a time zone Nova recognises.' }); }
  await pool.query('UPDATE cities SET timezone = $1 WHERE TRIM(code) = TRIM($2)', [zone, city]);
  await logAudit({ entity_type: 'city', entity_number: city, action: 'timezone',
    user_id: req.user.id, user_name: req.user.name, details: { timezone: zone }, ip: req.ip });
  res.json({ ok: true, timezone: zone });
});

// ---- the time codes on one service at one location ------------------------
router.get('/service/:locationServiceId', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  const id = parseInt(req.params.locationServiceId, 10);
  const ls = await pool.query(
    'SELECT ls.*, st.name AS service_name, st.code AS service_code, c.name AS city_name, c.timezone ' +
    'FROM location_services ls JOIN service_types st ON st.id = ls.service_type_id ' +
    'LEFT JOIN cities c ON TRIM(c.code) = TRIM(ls.city_code) WHERE ls.id = $1', [id]);
  if (!ls.rows.length) return res.status(404).json({ error: 'Not found' });
  const codes = await pool.query(
    'SELECT * FROM service_time_codes WHERE location_service_id = $1 ORDER BY start_minute', [id]);
  res.json({
    service: ls.rows[0],
    codes: codes.rows.map(function (c) {
      return Object.assign({}, c, {
        start_label: tc.minuteToHhmm(c.start_minute),
        end_label: tc.minuteToHhmm(c.end_minute),
        days_list: tc.dayMaskToList(c.days)
      });
    }),
    coverage: tc.checkCoverage(codes.rows)
  });
});

// One save endpoint for the whole set rather than per row, because coverage is
// a property of the SET. Saving one window at a time would mean every
// intermediate state is invalid and the check could never be enforced.
router.post('/service/:locationServiceId', requireAuth, requirePermission('manage_pricing'), async function (req, res) {
  const id = parseInt(req.params.locationServiceId, 10);
  const ls = await pool.query('SELECT * FROM location_services WHERE id = $1', [id]);
  if (!ls.rows.length) return res.status(404).json({ error: 'Not found' });

  const raw = (req.body && req.body.codes) || [];
  if (!Array.isArray(raw) || !raw.length) {
    return res.status(400).json({ error: 'A service needs at least one time code.' });
  }
  const codes = [];
  const seenIds = {};
  for (var i = 0; i < raw.length; i++) {
    const c = raw[i];
    const codeId = smallint(c.code_id, 1, 99);
    const start = smallint(c.start_minute, 0, 1439);
    const end = smallint(c.end_minute, 0, 1439);
    const title = s(c.title, 60);
    if (codeId === null || start === null || end === null || !title) {
      return res.status(400).json({ error: 'Every time code needs a number, a title, a start and an end.' });
    }
    if (seenIds[codeId]) {
      return res.status(400).json({ error: 'Two time codes are both numbered ' + codeId + '. The pay table refers to these numbers, so they have to be unique.' });
    }
    seenIds[codeId] = 1;
    codes.push({
      code_id: codeId, title: title, start_minute: start, end_minute: end,
      days: smallint(c.days, 1, 127) || 127,
      full_charge: money(c.full_charge),
      additional_charge: money(c.additional_charge) || 0,
      eta_core_low: smallint(c.eta_core_low, 1, 1440),
      eta_core_high: smallint(c.eta_core_high, 1, 1440),
      eta_account: smallint(c.eta_account, 1, 1440),
      eta_edu: smallint(c.eta_edu, 1, 1440),
      schedule_slots: smallint(c.schedule_slots, 0, 999) || 0,
      shutdown_message: s(c.shutdown_message, 2000),
      active: c.active === false ? false : true
    });
  }

  // A range quoted as 45 to 25 is a typo, and it would make every call look
  // late against the wrong end of it.
  for (var k = 0; k < codes.length; k++) {
    const c2 = codes[k];
    if (c2.eta_core_low && c2.eta_core_high && c2.eta_core_high < c2.eta_core_low) {
      return res.status(400).json({ error: 'On ' + c2.title + ', the top of the ETA range is lower than the bottom.' });
    }
  }

  const coverage = tc.checkCoverage(codes);
  if (!coverage.ok && !(req.body && req.body.force === true)) {
    return res.status(400).json({
      error: coverage.gaps.length
        ? 'The week is not fully covered. Nothing covers ' + coverage.gaps[0].label +
          (coverage.gaps.length > 1 ? ' (and ' + (coverage.gaps.length - 1) + ' more)' : '') + '.'
        : 'Two time codes both claim ' + coverage.overlaps[0].label +
          ' (codes ' + coverage.overlaps[0].a + ' and ' + coverage.overlaps[0].b + ').',
      reason: coverage.gaps.length ? 'gap' : 'overlap',
      coverage: coverage
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM service_time_codes WHERE location_service_id = $1', [id]);
    for (var n = 0; n < codes.length; n++) {
      const c3 = codes[n];
      await client.query(
        'INSERT INTO service_time_codes (location_service_id, code_id, title, start_minute, end_minute, ' +
        ' days, full_charge, additional_charge, eta_core_low, eta_core_high, eta_account, eta_edu, ' +
        ' schedule_slots, shutdown_message, active) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
        [id, c3.code_id, c3.title, c3.start_minute, c3.end_minute, c3.days, c3.full_charge,
          c3.additional_charge, c3.eta_core_low, c3.eta_core_high, c3.eta_account, c3.eta_edu,
          c3.schedule_slots, c3.shutdown_message, c3.active]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await logAudit({ entity_type: 'time_codes', entity_id: id, action: 'save',
    user_id: req.user.id, user_name: req.user.name,
    details: { count: codes.length, forced: !coverage.ok }, ip: req.ip });
  res.json({ ok: true, coverage: coverage });
});

// Copying a whole week of windows onto every other service in the city is the
// difference between setting this up once and setting it up thirteen times.
router.post('/service/:locationServiceId/copy-to-all', requireAuth, requirePermission('manage_pricing'), async function (req, res) {
  const id = parseInt(req.params.locationServiceId, 10);
  const src = await pool.query('SELECT * FROM location_services WHERE id = $1', [id]);
  if (!src.rows.length) return res.status(404).json({ error: 'Not found' });
  const codes = await pool.query('SELECT * FROM service_time_codes WHERE location_service_id = $1', [id]);
  if (!codes.rows.length) return res.status(400).json({ error: 'Nothing to copy.' });
  // Windows and ETAs travel; PRICES deliberately do not. A lockout and a
  // residential rekey do not cost the same, and copying the number across would
  // be a wrong price quoted to a real customer.
  const withPrices = !!(req.body && req.body.include_prices === true);
  const targets = await pool.query(
    'SELECT id FROM location_services WHERE TRIM(city_code) = TRIM($1) AND id <> $2 AND active = true',
    [src.rows[0].city_code, id]);
  const client = await pool.connect();
  var n = 0;
  try {
    await client.query('BEGIN');
    for (var t = 0; t < targets.rows.length; t++) {
      const tid = targets.rows[t].id;
      await client.query('DELETE FROM service_time_codes WHERE location_service_id = $1', [tid]);
      for (var c = 0; c < codes.rows.length; c++) {
        const x = codes.rows[c];
        await client.query(
          'INSERT INTO service_time_codes (location_service_id, code_id, title, start_minute, end_minute, ' +
          ' days, full_charge, additional_charge, eta_core_low, eta_core_high, eta_account, eta_edu, ' +
          ' schedule_slots, shutdown_message, active) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
          [tid, x.code_id, x.title, x.start_minute, x.end_minute, x.days,
            withPrices ? x.full_charge : null, withPrices ? x.additional_charge : 0,
            x.eta_core_low, x.eta_core_high, x.eta_account, x.eta_edu,
            x.schedule_slots, x.shutdown_message, x.active]);
      }
      n++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
  await logAudit({ entity_type: 'time_codes', entity_id: id, action: 'copy_to_all',
    user_id: req.user.id, user_name: req.user.name, details: { services: n, prices: withPrices }, ip: req.ip });
  res.json({ ok: true, services: n, prices_copied: withPrices });
});

// ---- account price exceptions --------------------------------------------
router.get('/account-prices', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  const params = [];
  var where = 'WHERE p.active = true';
  if (req.query.account_id) { params.push(parseInt(req.query.account_id, 10)); where += ' AND p.account_id = $' + params.length; }
  const r = await pool.query(
    'SELECT p.*, v.name AS account_name, st.name AS service_name, st.code AS service_code, c.name AS city_name ' +
    'FROM account_service_prices p ' +
    'JOIN vendors v ON v.id = p.account_id ' +
    'JOIN service_types st ON st.id = p.service_type_id ' +
    'LEFT JOIN cities c ON TRIM(c.code) = TRIM(p.city_code) ' +
    where + ' ORDER BY v.name, st.name, p.city_code NULLS FIRST, p.code_id NULLS FIRST', params);
  res.json({ prices: r.rows });
});

router.post('/account-prices', requireAuth, requirePermission('manage_pricing'), async function (req, res) {
  const b = req.body || {};
  const accountId = parseInt(b.account_id, 10);
  const stId = parseInt(b.service_type_id, 10);
  const full = money(b.full_charge);
  if (!accountId || !stId || full === null) {
    return res.status(400).json({ error: 'An exception needs an account, a service and a price.' });
  }
  const r = await pool.query(
    'INSERT INTO account_service_prices (account_id, service_type_id, city_code, code_id, ' +
    ' full_charge, additional_charge, eta_minutes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [accountId, stId, s(b.city_code, 3), smallint(b.code_id, 1, 99),
      full, money(b.additional_charge) || 0, smallint(b.eta_minutes, 1, 1440)]);
  await logAudit({ entity_type: 'acct_price', entity_id: r.rows[0].id, action: 'create',
    user_id: req.user.id, user_name: req.user.name, details: b, ip: req.ip });
  res.json({ ok: true, id: r.rows[0].id });
});

router.delete('/account-prices/:id', requireAuth, requirePermission('manage_pricing'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  // Deactivated, never deleted: a call priced under this row last month still
  // has to be explainable.
  const r = await pool.query('UPDATE account_service_prices SET active = false WHERE id = $1 RETURNING id', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---- what would this call cost? ------------------------------------------
// Used by the new-call form so the dispatcher sees the price before the
// customer is told, and by anyone checking why a call priced the way it did.
router.get('/quote', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  const q = await pricing.quote({
    service_type_id: parseInt(req.query.service_type_id, 10) || null,
    city_code: s(req.query.city_code, 3),
    account_id: parseInt(req.query.account_id, 10) || null,
    is_edu: String(req.query.is_edu || '') === '1',
    when: req.query.when ? new Date(req.query.when) : new Date()
  });
  res.json(q);
});

module.exports = router;
