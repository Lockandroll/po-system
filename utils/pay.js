const { pool } = require('../db');

// ---------------------------------------------------------------------------
//  What a tech is paid for a call
// ---------------------------------------------------------------------------
// The engine reads its OWN tables. It never derives pay from the price, and the
// reason is EDU: a child locked in a hot car is free to the customer and still
// paid to the tech. Anything shaped like "pay = 40% of what we charged" pays
// zero for the one call type where somebody is trapped.
//
// A person's effective pay table is:
//     their grade's rows for the call's city
//   + any user_id override row of the same scope, REPLACING the grade row
//
// One row wins per call. Two labor types - holiday_additional and out_of_area -
// are multipliers layered on top of the winner, never winners themselves.
// ---------------------------------------------------------------------------

const BASE_TYPES = ['completed_call', 'service_labor', 'percent_labor', 'percent_parts_margin'];
const GOA_TYPES = ['gone_on_arrival'];
const UPLIFT_TYPES = ['holiday_additional', 'out_of_area'];
const ALL_TYPES = BASE_TYPES.concat(GOA_TYPES, UPLIFT_TYPES);

// percent_parts_margin ships dormant. It stays in the type list so a row can be
// written and reviewed, but it is never selected: switching it on means reading
// parts revenue and parts COGS off the invoice, and Nova has already been bitten
// once by a labor charge booked as parts cost. On a report that is embarrassing;
// on a paycheck it is a dispute.
const DORMANT_TYPES = ['percent_parts_margin'];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function money(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
}
function arr(v) {
  if (!Array.isArray(v)) return [];
  return v.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return isFinite(x); });
}

// ---------------------------------------------------------------------------
//  Loading the effective table
// ---------------------------------------------------------------------------

// Two rows have the same SCOPE when they answer the same question - same
// service list, same account rule, same time codes, same EDU flag, same labor
// type. That is the key an override row replaces a grade row on. Comparing
// titles instead would break the moment somebody renamed one.
function scopeKey(row) {
  return [
    row.labor_type,
    arr(row.service_type_ids).sort(function (a, b) { return a - b; }).join('.'),
    row.account_id || (row.applies_accounts ? 'A' : '') + (row.applies_public ? 'P' : ''),
    arr(row.code_ids).sort(function (a, b) { return a - b; }).join('.'),
    row.edu_only ? 'edu' : ''
  ].join('|');
}

/**
 * Every row that could pay this person in this city on this date.
 * @param {object} o user_id, city_code, grade_id, when (Date), client
 */
async function effectiveRows(o) {
  const opts = o || {};
  const q = (opts.client || pool);
  const uid = parseInt(opts.user_id, 10) || null;
  const city = opts.city_code ? String(opts.city_code).trim() : null;
  if (!uid || !city) return [];

  var gradeId = opts.grade_id === undefined ? undefined : opts.grade_id;
  if (gradeId === undefined) {
    const u = await q.query('SELECT pay_grade_id FROM users WHERE id = $1', [uid]);
    gradeId = u.rows.length ? u.rows[0].pay_grade_id : null;
  }

  const when = opts.when ? new Date(opts.when) : new Date();
  const day = when.toISOString().slice(0, 10);

  const r = await q.query(
    'SELECT * FROM pay_rows WHERE active = true AND TRIM(city_code) = TRIM($1) ' +
    '  AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date) ' +
    '  AND (user_id = $3 OR ($4::int IS NOT NULL AND grade_id = $4::int)) ' +
    'ORDER BY id',
    [city, day, uid, gradeId]);

  // The override replaces the grade row rather than sitting beside it. Both
  // present would mean two rows of identical scope, and the whole "ties are
  // impossible" guarantee rests on that not happening.
  const byScope = {};
  r.rows.forEach(function (row) {
    const k = scopeKey(row);
    const prev = byScope[k];
    if (!prev || (row.user_id && !prev.user_id)) byScope[k] = row;
  });
  return Object.keys(byScope).map(function (k) { return byScope[k]; });
}

// ---------------------------------------------------------------------------
//  Matching one row to one call
// ---------------------------------------------------------------------------
// Four facts come off the call: service type, account or not, time code, EDU.
// A row is a CANDIDATE only if it matches all four. Among candidates the most
// specific wins, and the scores are deliberately spread so no combination of
// weaker matches can outrank a stronger one on a different axis.

function serviceScore(row, serviceTypeId) {
  const list = arr(row.service_type_ids);
  if (!list.length) return 1;                    // All services
  if (!serviceTypeId) return 0;                  // row is scoped, call is not
  if (list.indexOf(serviceTypeId) === -1) return 0;
  return list.length === 1 ? 3 : 2;              // named beats a list
}

function accountScore(row, accountId) {
  if (accountId) {
    if (row.account_id) return row.account_id === accountId ? 3 : 0;
    return row.applies_accounts ? 2 : 0;
  }
  // A public call. A row scoped to one account cannot pay it, and neither can
  // an accounts-only row - that is exactly what the two flags are for.
  if (row.account_id) return 0;
  return row.applies_public ? 1 : 0;
}

function codeScore(row, codeId) {
  const list = arr(row.code_ids);
  if (!list.length) return 1;                    // All TCs
  if (codeId === null || codeId === undefined) return 0;
  return list.indexOf(parseInt(codeId, 10)) === -1 ? 0 : 2;
}

function eduScore(row, isEdu) {
  if (row.edu_only) return isEdu ? 2 : 0;        // an EDU row pays EDU only
  return 1;
}

/**
 * @param {array} rows effective rows
 * @param {object} facts service_type_id, account_id, code_id, is_edu, types
 * @returns {row, score, tie} - tie names the other row when two score equally,
 *          which is a configuration bug worth surfacing rather than resolving.
 */
function pickRow(rows, facts) {
  const f = facts || {};
  const types = f.types || BASE_TYPES;
  var best = null, bestScore = -1, tie = null;
  (rows || []).forEach(function (row) {
    if (types.indexOf(row.labor_type) === -1) return;
    if (DORMANT_TYPES.indexOf(row.labor_type) !== -1) return;
    const s1 = serviceScore(row, f.service_type_id ? parseInt(f.service_type_id, 10) : null);
    if (!s1) return;
    const s2 = accountScore(row, f.account_id ? parseInt(f.account_id, 10) : null);
    if (!s2) return;
    const s3 = codeScore(row, f.code_id);
    if (!s3) return;
    const s4 = eduScore(row, !!f.is_edu);
    if (!s4) return;
    // EDU is the outermost axis on purpose: an EDU-specific row must beat a
    // more narrowly scoped general row, because the whole point of writing one
    // is that this call type pays differently.
    const score = (s4 * 1000) + (s2 * 100) + (s1 * 10) + s3;
    if (score > bestScore) { bestScore = score; best = row; tie = null; }
    else if (score === bestScore && best) { tie = row; }
  });
  return { row: best, score: bestScore, tie: tie };
}

// ---------------------------------------------------------------------------
//  Calculating
// ---------------------------------------------------------------------------

// A multiplier row's amount is a PERCENT ADDED ON TOP: 25 means the base is
// paid at 125%. Written as an uplift rather than a replacement so a holiday and
// an out-of-area call stack the way anyone would expect them to.
function upliftFor(rows, facts, type) {
  const hit = pickRow(rows, Object.assign({}, facts, { types: [type] }));
  if (!hit.row) return null;
  const pct = num(hit.row.amount);
  if (pct === null || !pct) return null;
  return { row: hit.row, pct: pct };
}

/**
 * The whole calculation, with no database access - so it is testable, and so
 * the same numbers come out whether this runs at close-out or in a preview.
 *
 * @param {object} o
 *   rows           effective pay rows
 *   outcome        'done' | 'goa'
 *   service_type_id, account_id, code_id, is_edu
 *   is_holiday, out_of_area
 *   labor_amount   basis for percent_labor
 *   tip_amount
 *   split_pct      vehicle_split_pct off the user
 */
function calculate(o) {
  const f = o || {};
  const out = {
    pay_row_id: null, pay_row_title: null, pay_labor_type: null,
    pay_basis_amount: null, pay_total: 0, pay_job_amount: 0,
    pay_vehicle_amount: 0, pay_split_pct: null, pay_tip_amount: 0,
    uplifts: [], flags: [], note: null
  };

  const outcome = f.outcome === 'goa' ? 'goa' : 'done';
  const split = num(f.split_pct);
  out.pay_split_pct = split === null ? 0 : Math.min(100, Math.max(0, split));
  out.pay_tip_amount = money(f.tip_amount) || 0;

  const facts = {
    service_type_id: f.service_type_id, account_id: f.account_id,
    code_id: f.code_id, is_edu: !!f.is_edu,
    types: outcome === 'goa' ? GOA_TYPES : BASE_TYPES
  };
  const hit = pickRow(f.rows || [], facts);

  if (!hit.row) {
    // ⚠️ $0 plus a flag, never a silent $0. An unpaid call that nobody was told
    // about is indistinguishable from a rate somebody meant to set at zero, and
    // the tech finds out on payday.
    out.flags.push(outcome === 'goa' ? 'no_goa_row' : 'no_pay_row');
    out.pay_total = 0;
    out.pay_job_amount = out.pay_tip_amount;
    out.pay_vehicle_amount = 0;
    return out;
  }
  if (hit.tie) {
    out.flags.push('ambiguous_row');
    out.note = 'Two rows of equal scope matched: "' + hit.row.title + '" and "' + hit.tie.title + '".';
  }

  const row = hit.row;
  out.pay_row_id = row.id;
  out.pay_row_title = row.title;
  out.pay_labor_type = row.labor_type;

  var base = 0;
  if (row.labor_type === 'percent_labor') {
    const labor = money(f.labor_amount);
    out.pay_basis_amount = labor === null ? 0 : labor;
    base = (out.pay_basis_amount * num(row.amount)) / 100;
    // A percentage of a free EDU is zero, and it is zero for a reason that
    // looks like a bug from the paycheck end. Say so.
    if (f.is_edu && !out.pay_basis_amount) out.flags.push('edu_percent_of_free');
    else if (!out.pay_basis_amount) out.flags.push('no_labor_basis');
  } else {
    out.pay_basis_amount = money(row.amount);
    base = out.pay_basis_amount || 0;
  }

  // ---- uplifts, on top of the winner and never on their own ---------------
  var total = base;
  if (f.is_holiday) {
    const up = upliftFor(f.rows || [], facts, 'holiday_additional');
    if (up) {
      const add = Math.round(base * (up.pct / 100) * 100) / 100;
      total += add;
      out.uplifts.push({ type: 'holiday_additional', title: up.row.title, pct: up.pct, amount: add });
    }
  }
  if (f.out_of_area) {
    const up2 = upliftFor(f.rows || [], facts, 'out_of_area');
    if (up2) {
      const add2 = Math.round(base * (up2.pct / 100) * 100) / 100;
      total += add2;
      out.uplifts.push({ type: 'out_of_area', title: up2.row.title, pct: up2.pct, amount: add2 });
    }
  }

  out.pay_total = Math.round(total * 100) / 100;

  // ---- the split ----------------------------------------------------------
  // Vehicle money comes out of the CALL pay only. Tips are the customer's, they
  // are 100% the tech's, and they are job pay - splitting a tip into vehicle
  // reimbursement would be inventing a mileage claim out of a gratuity.
  const veh = Math.round(out.pay_total * (out.pay_split_pct / 100) * 100) / 100;
  out.pay_vehicle_amount = veh;
  out.pay_job_amount = Math.round((out.pay_total - veh + out.pay_tip_amount) * 100) / 100;
  return out;
}

// ---------------------------------------------------------------------------
//  Database glue
// ---------------------------------------------------------------------------

async function isHoliday(when, client) {
  try {
    const q = client || pool;
    const day = (when ? new Date(when) : new Date()).toISOString().slice(0, 10);
    const r = await q.query('SELECT 1 FROM holidays WHERE holiday_date = $1::date', [day]);
    return !!r.rows.length;
  } catch (e) { return false; }
}

// The time code stored on the job is the service_time_codes row id; pay rows
// scope by the CODE NUMBER (TC1..TC6), which is what a person types into the
// table. Translate once, here, rather than in three callers.
async function codeNumberFor(timeCodeId, client) {
  if (!timeCodeId) return null;
  try {
    const q = client || pool;
    const r = await q.query('SELECT code_id FROM service_time_codes WHERE id = $1', [timeCodeId]);
    return r.rows.length ? r.rows[0].code_id : null;
  } catch (e) { return null; }
}

// Outside a PRIMARY zone. Two ways to be outside one: matching no zone at all
// in a city that has drawn its map, or matching a zone somebody deliberately
// flagged as non-primary. "No zones drawn yet" is not out of area - the same
// distinction the pricing side already makes, and getting it wrong here pays an
// out-of-area uplift on every call in a city nobody has mapped.
async function isOutOfArea(job, client) {
  const q = client || pool;
  try {
    if (job.zone_id) {
      const z = await q.query('SELECT is_primary FROM coverage_zones WHERE id = $1', [job.zone_id]);
      return z.rows.length ? z.rows[0].is_primary === false : false;
    }
    if (!job.city_code) return false;
    const any = await q.query(
      'SELECT 1 FROM coverage_zones WHERE active = true AND TRIM(city_code) = TRIM($1) LIMIT 1',
      [job.city_code]);
    return !!any.rows.length;
  } catch (e) { return false; }
}

/**
 * Work out what a job pays without writing anything. Used by the preview on the
 * call, and by the pay report when it explains a figure.
 */
async function previewForJob(job, client) {
  const q = client || pool;
  if (!job || !job.assigned_to) return null;
  const u = await q.query(
    'SELECT id, name, pay_grade_id, pay_arrangement, vehicle_split_pct FROM users WHERE id = $1',
    [job.assigned_to]);
  if (!u.rows.length) return null;
  const user = u.rows[0];

  const when = job.completed_at || job.goa_at || new Date();
  const rows = await effectiveRows({
    user_id: user.id, city_code: job.city_code, grade_id: user.pay_grade_id,
    when: when, client: q
  });
  const codeNum = await codeNumberFor(job.time_code_id, q);
  const res = calculate({
    rows: rows,
    outcome: job.status === 'goa' ? 'goa' : 'done',
    service_type_id: job.service_type_id,
    account_id: job.account_id,
    code_id: codeNum,
    is_edu: !!job.is_edu,
    is_holiday: await isHoliday(when, q),
    out_of_area: job.out_of_area === undefined ? await isOutOfArea(job, q) : !!job.out_of_area,
    labor_amount: job.labor_amount !== undefined && job.labor_amount !== null
      ? job.labor_amount : job.quoted_price,
    tip_amount: job.pay_tip_amount,
    split_pct: user.vehicle_split_pct
  });
  res.user_id = user.id;
  res.user_name = user.name;
  res.pay_arrangement = user.pay_arrangement;
  res.rows_available = rows.length;
  return res;
}

/**
 * Compute ONCE and freeze it on the job. Called from the done/goa transition.
 *
 * ⚠️ Re-entry is a no-op unless force is passed: a status bounced from done to
 * onscene and back must not re-price the call at whatever the table says today.
 * The snapshot is the record of what was actually paid.
 */
async function snapshotForJob(jobId, opts) {
  const o = opts || {};
  const q = o.client || pool;
  const id = parseInt(jobId, 10);
  if (!id) return null;
  const r = await q.query('SELECT * FROM dispatch_jobs WHERE id = $1', [id]);
  if (!r.rows.length) return null;
  const job = r.rows[0];
  if (job.pay_locked_at && !o.force) return { locked: true, job: job };
  if (job.status !== 'done' && job.status !== 'goa') return { skipped: 'not_closed' };
  if (!job.assigned_to) return { skipped: 'unassigned' };

  // Close-out can supply the labor line and a tip; neither is a column on the
  // call yet, and neither should be invented from the quoted price.
  if (o.labor_amount !== undefined && o.labor_amount !== null) job.labor_amount = o.labor_amount;
  if (o.tip_amount !== undefined && o.tip_amount !== null) job.pay_tip_amount = o.tip_amount;

  const res = await previewForJob(job, q);
  if (!res) return { skipped: 'no_user' };

  const note = [res.note, res.flags.length ? 'flags: ' + res.flags.join(', ') : null]
    .filter(Boolean).join(' ') || null;

  await q.query(
    'UPDATE dispatch_jobs SET pay_row_id=$1, pay_row_title=$2, pay_labor_type=$3, ' +
    'pay_basis_amount=$4, pay_total=$5, pay_job_amount=$6, pay_vehicle_amount=$7, ' +
    'pay_split_pct=$8, pay_tip_amount=$9, pay_locked_at=NOW(), pay_note=$10 ' +
    'WHERE id=$11',
    [res.pay_row_id, res.pay_row_title, res.pay_labor_type, res.pay_basis_amount,
      res.pay_total, res.pay_job_amount, res.pay_vehicle_amount, res.pay_split_pct,
      res.pay_tip_amount, note, id]);

  return { ok: true, pay: res, flags: res.flags };
}

module.exports = {
  BASE_TYPES: BASE_TYPES,
  GOA_TYPES: GOA_TYPES,
  UPLIFT_TYPES: UPLIFT_TYPES,
  ALL_TYPES: ALL_TYPES,
  DORMANT_TYPES: DORMANT_TYPES,
  scopeKey: scopeKey,
  effectiveRows: effectiveRows,
  pickRow: pickRow,
  calculate: calculate,
  isHoliday: isHoliday,
  codeNumberFor: codeNumberFor,
  isOutOfArea: isOutOfArea,
  previewForJob: previewForJob,
  snapshotForJob: snapshotForJob
};
