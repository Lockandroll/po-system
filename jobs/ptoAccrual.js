// PTO accrual + carryover cron. Runs daily at 1am America/New_York.
// - Monthly accrual is idempotent: it posts the current month's accrual line only
//   if one does not already exist (unique partial index uq_pto_accrual_month), so a
//   missed 1st self-heals on the next daily run and a restart never double-credits.
// - Carryover runs once a year on Jan 1: anything over the cap is forfeited.
// Everything is stored in HOURS (8 hrs = 1 day). No backticks in this file.
const cron = require('node-cron');
const { pool } = require('../db');

const HRS_PER_DAY = 8;
const TZ = 'America/New_York';

const DEFAULT_BANDS = [
  { from: 0, to: 1, days_per_year: 10 },
  { from: 1, to: 3, days_per_year: 12 },
  { from: 3, to: 5, days_per_year: 15 },
  { from: 5, to: null, days_per_year: 20 }
];

// Today's calendar date in the cron timezone, as YYYY-MM-DD.
function todayET() { return new Date().toLocaleString('en-CA', { timeZone: TZ }).slice(0, 10); }

async function getSetting(key, fallback) {
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (!r.rows.length) return fallback;
  return r.rows[0].value;
}
async function getJson(key, fallback) {
  const raw = await getSetting(key, null);
  if (raw === null || raw === undefined) return fallback;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return fallback; }
}
function tenureYears(hireStr, todayStr) {
  if (!hireStr) return null;
  const h = String(hireStr).slice(0, 10).split('-');
  const t = todayStr.split('-');
  let y = (+t[0]) - (+h[0]);
  // subtract a year if the anniversary has not happened yet this year
  if ((+t[1] < +h[1]) || (+t[1] === +h[1] && +t[2] < +h[2])) y -= 1;
  return Math.max(0, y);
}
function resolveBand(bands, years) {
  const list = (Array.isArray(bands) && bands.length) ? bands : DEFAULT_BANDS;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const from = Number(b.from) || 0;
    const to = (b.to === null || b.to === undefined || b.to === '') ? Infinity : Number(b.to);
    if (years >= from && years < to) return b;
  }
  return list[list.length - 1];
}
function monthlyHours(band) { return ((Number(band && band.days_per_year) || 0) * HRS_PER_DAY) / 12; }

// ---- monthly accrual -------------------------------------------------------
async function runAccrual(todayStr) {
  const today = todayStr || todayET();
  const period = today.slice(0, 7); // YYYY-MM
  const bands = await getJson('pto_accrual_bands', DEFAULT_BANDS);
  const capDaysRaw = await getSetting('pto_balance_cap_days', null);
  const capHours = (capDaysRaw === null || capDaysRaw === undefined || capDaysRaw === '') ? null : (Number(capDaysRaw) * HRS_PER_DAY);

  const users = await pool.query(
    'SELECT id, hire_date, COALESCE(pto_balance_hours,0) AS bal FROM users ' +
    'WHERE active IS NOT FALSE AND pto_exempt IS NOT TRUE AND hire_date IS NOT NULL'
  );
  let posted = 0;
  for (let i = 0; i < users.rows.length; i++) {
    const u = users.rows[i];
    const years = tenureYears(u.hire_date, today);
    if (years === null) continue;
    let amt = monthlyHours(resolveBand(bands, years));
    if (amt <= 0) continue;
    // Respect a balance cap: never accrue past it.
    if (capHours !== null) {
      const room = capHours - Number(u.bal);
      if (room <= 0) continue;
      if (amt > room) amt = room;
    }
    amt = Math.round(amt * 100) / 100;
    try {
      const ins = await pool.query(
        'INSERT INTO pto_ledger (user_id, entry_date, kind, amount_hours, description, accrual_period) ' +
        "VALUES ($1, $2, 'accrual', $3, $4, $5) " +
        "ON CONFLICT (user_id, accrual_period) WHERE kind = 'accrual' DO NOTHING RETURNING id",
        [u.id, today, amt, 'Monthly accrual (' + period + ')', period]
      );
      if (ins.rows.length) {
        await pool.query('UPDATE users SET pto_balance_hours = COALESCE(pto_balance_hours,0) + $1 WHERE id = $2', [amt, u.id]);
        posted++;
      }
    } catch (e) {
      console.error('[ptoAccrual] accrual failed for user', u.id, e.message);
    }
  }
  if (posted) console.log('[ptoAccrual] posted ' + posted + ' accrual line(s) for ' + period);
  return posted;
}

// ---- yearly carryover cap (Jan 1) -----------------------------------------
async function runCarryover(todayStr) {
  const today = todayStr || todayET();
  if (today.slice(5) !== '01-01') return 0; // only on Jan 1
  const capDaysRaw = await getSetting('pto_carryover_days', null);
  if (capDaysRaw === null || capDaysRaw === undefined || capDaysRaw === '') return 0; // unlimited
  const capHours = Number(capDaysRaw) * HRS_PER_DAY;

  const users = await pool.query('SELECT id, COALESCE(pto_balance_hours,0) AS bal FROM users WHERE active IS NOT FALSE');
  let cut = 0;
  for (let i = 0; i < users.rows.length; i++) {
    const u = users.rows[i];
    const over = Number(u.bal) - capHours;
    if (over <= 0) continue;
    // idempotency: skip if a carryover line already exists for this Jan 1
    const dup = await pool.query("SELECT 1 FROM pto_ledger WHERE user_id = $1 AND kind = 'carryover' AND entry_date = $2 LIMIT 1", [u.id, today]);
    if (dup.rows.length) continue;
    try {
      await pool.query(
        'INSERT INTO pto_ledger (user_id, entry_date, kind, amount_hours, description) ' +
        "VALUES ($1, $2, 'carryover', $3, $4)",
        [u.id, today, -over, 'Carryover cap applied (' + (Number(capDaysRaw)) + ' days)']
      );
      await pool.query('UPDATE users SET pto_balance_hours = $1 WHERE id = $2', [capHours, u.id]);
      cut++;
    } catch (e) {
      console.error('[ptoAccrual] carryover failed for user', u.id, e.message);
    }
  }
  if (cut) console.log('[ptoAccrual] carryover applied to ' + cut + ' user(s)');
  return cut;
}

async function runPtoAccrual() {
  const today = todayET();
  try { await runCarryover(today); } catch (e) { console.error('[ptoAccrual] carryover error:', e.message); }
  try { await runAccrual(today); } catch (e) { console.error('[ptoAccrual] accrual error:', e.message); }
}

function startPtoAccrual() {
  // 1am ET, every day. Idempotent, so daily runs are safe and self-healing.
  cron.schedule('0 1 * * *', function () {
    runPtoAccrual();
  }, { timezone: TZ });
  console.log('[ptoAccrual] Daily PTO accrual/carryover job scheduled (01:00 ' + TZ + ')');
}

module.exports = { startPtoAccrual, runPtoAccrual, runAccrual, runCarryover };
