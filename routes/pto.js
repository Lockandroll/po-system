// PTO — requests, approvals, ledger, team visibility, retroactive logging, settings.
// Everything is stored in HOURS (8 hrs = 1 day). The frontend displays hours for
// hourly/salary staff and days for commission staff. No backticks in this file.
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
let notify = null; try { notify = require('../utils/notify'); } catch (e) { notify = null; }
let sendEmail = null, emailTemplate = null, sendSms = null;
try { var _em = require('../utils/email'); sendEmail = _em.sendEmail; emailTemplate = _em.emailTemplate; } catch (e) { /* optional */ }
try { sendSms = require('../utils/sms').sendSms; } catch (e) { /* optional */ }
function appUrl(path) { return (process.env.APP_URL || '').replace(/\/$/, '') + (path || ''); }

const router = express.Router();

const HRS_PER_DAY = 8;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const APPROVED_VACATION_POSITION_ID = 5; // shift_positions row "Approved Vacation Day"
const UNPAID_VACATION_POSITION_ID = 7;   // shift_positions row "Unpaid Vacation Day"

// ---- small helpers ---------------------------------------------------------

function ymd(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function parseDate(v) {
  if (!RE_DATE.test(String(v || ''))) return null;
  const p = String(v).split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}
function businessDays(a, b) {
  const s = parseDate(a), e = parseDate(b);
  if (!s || !e || e < s) return 0;
  let n = 0; const d = new Date(s);
  while (d <= e) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); }
  return n;
}
// pg returns DATE columns as JS Date objects; String(date).slice(0,10) yields
// junk like "Thu Jul 02" (no year) which Postgres rejects. Always use this.
function ymdOf(v) {
  if (v instanceof Date) return ymd(v);
  return String(v || '').slice(0, 10);
}
async function getSetting(key, fallback) {
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (!r.rows.length) return fallback;
  return r.rows[0].value;
}
async function getJsonSetting(key, fallback) {
  const raw = await getSetting(key, null);
  if (raw === null || raw === undefined) return fallback;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return fallback; }
}

// Length-based escalation, mapped to org tiers.
// <=5 days = direct supervisor (t4); 6-10 = supervisor + COO (t2); >10 = CEO (t1).
function requiredTier(days) {
  if (days > 10) return { level: 1, label: 'CEO approval' };
  if (days > 5) return { level: 2, label: 'Supervisor + COO' };
  return { level: 4, label: 'Direct supervisor' };
}

// Walk the supervisor chain upward, returning ancestor user ids (closest first).
async function chainIds(userId) {
  const ids = []; let cur = userId, guard = 0;
  while (guard++ < 25) {
    const r = await pool.query('SELECT supervisor_id FROM users WHERE id = $1', [cur]);
    if (!r.rows.length || !r.rows[0].supervisor_id) break;
    const sid = r.rows[0].supervisor_id;
    if (ids.indexOf(sid) !== -1) break; // cycle guard
    ids.push(sid); cur = sid;
  }
  return ids;
}
// Approver may act if admin/owner, or if they sit above the requester in the chain.
async function canApprove(user, requesterId) {
  if (user.role === 'admin' || user.isOwner) return true;
  if (user.id === requesterId) return false; // never approve your own
  const chain = await chainIds(requesterId);
  return chain.indexOf(user.id) !== -1;
}
// True when managerId is somewhere above targetId (i.e. target is in manager's downline).
async function inDownline(managerId, targetId) {
  const chain = await chainIds(targetId);
  return chain.indexOf(managerId) !== -1;
}

// Tenure in whole years between hire date and now.
function tenureYears(hireDate) {
  if (!hireDate) return 0;
  const h = hireDate instanceof Date ? hireDate : parseDate(String(hireDate).slice(0, 10));
  if (!h) return 0;
  const now = new Date();
  let y = now.getFullYear() - h.getFullYear();
  const anniv = new Date(now.getFullYear(), h.getMonth(), h.getDate());
  if (now < anniv) y -= 1;
  return Math.max(0, y);
}
// Whole years of service as of an arbitrary date (anniversary-based). Used by the
// forward projection so accrual bands step up as the person crosses anniversaries.
function tenureAt(hireDate, at) {
  if (!hireDate) return 0;
  const h = hireDate instanceof Date ? hireDate : parseDate(String(hireDate).slice(0, 10));
  if (!h) return 0;
  let y = at.getFullYear() - h.getFullYear();
  const anniv = new Date(at.getFullYear(), h.getMonth(), h.getDate());
  if (at < anniv) y -= 1;
  return Math.max(0, y);
}
// Default accrual bands (days/year) if none configured in settings.
const DEFAULT_BANDS = [
  { from: 0, to: 1, days_per_year: 10 },
  { from: 1, to: 3, days_per_year: 12 },
  { from: 3, to: 5, days_per_year: 15 },
  { from: 5, to: null, days_per_year: 20 }
];
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
function monthlyHoursFromBand(band) {
  const dpy = Number(band && band.days_per_year) || 0;
  return (dpy * HRS_PER_DAY) / 12;
}

async function eligibleInfo(user, waitingDays) {
  const hire = user.hire_date ? parseDate(ymdOf(user.hire_date)) : null;
  if (!hire) return { eligible_date: null, eligible_now: true };
  const elig = new Date(hire); elig.setDate(elig.getDate() + (Number(waitingDays) || 0));
  return { eligible_date: ymd(elig), eligible_now: new Date() >= elig };
}

// Insert a ledger line and move the cached balance in one shot (call inside a tx).
async function postLedger(client, e) {
  await client.query(
    'INSERT INTO pto_ledger (user_id, entry_date, kind, amount_hours, description, accrual_period, request_id, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [e.user_id, e.entry_date, e.kind, e.amount_hours, e.description || null, e.accrual_period || null, e.request_id || null, e.created_by || null]
  );
  await client.query('UPDATE users SET pto_balance_hours = COALESCE(pto_balance_hours,0) + $1 WHERE id = $2', [e.amount_hours, e.user_id]);
}

// Count distinct people already off (approved) on any day overlapping [from,to].
async function coverageOverlapCount(from, to, excludeUserId) {
  const r = await pool.query(
    'SELECT COUNT(DISTINCT user_id)::int AS c FROM pto_requests ' +
    'WHERE status = $1 AND NOT (end_date < $2 OR start_date > $3) AND user_id <> $4',
    ['approved', from, to, excludeUserId || 0]
  );
  return r.rows.length ? r.rows[0].c : 0;
}
// The coverage cap that applies (per-market caps are keyed by city_code; MVP falls
// back to a single default when we cannot resolve the requester's market).
async function coverageCap(cityCode) {
  const caps = await getJsonSetting('pto_coverage_caps', {});
  if (cityCode && caps && caps[cityCode] !== undefined) return Number(caps[cityCode]);
  const def = await getSetting('pto_coverage_default', null);
  return def === null || def === undefined ? null : Number(def);
}

// ---- notifications (email + SMS, non-fatal) --------------------------------
async function notifyApprover(supId, requesterName, from, to, days, paid, type, tierText) {
  if (!supId) return;
  try {
    var rec = notify ? await notify.broadcastRecipients('pto_submitted', 'id = ' + supId) : { emails: [], phones: [] };
    var dates = from + (to !== from ? ' to ' + to : '');
    if (rec.emails && rec.emails.length && sendEmail && emailTemplate) {
      var html = emailTemplate({
        badge: 'PTO Request', badgeColor: 'orange', title: requesterName + ' requested time off',
        body: 'A PTO request is waiting for your approval. Nothing is taken until you approve.',
        details: [
          { label: 'Employee', value: requesterName },
          { label: 'Dates', value: dates },
          { label: 'Business days', value: String(days) },
          { label: 'Type', value: (paid ? 'Paid' : 'Unpaid') + ' ' + type },
          { label: 'Approval needed', value: tierText }
        ],
        buttonText: 'Review in Nova', buttonUrl: appUrl('/'), footerNote: 'Open Nova, then Time Off, then Approvals.'
      });
      await sendEmail(rec.emails, 'PTO approval needed: ' + requesterName + ' (' + dates + ')', html);
    }
    if (rec.phones && rec.phones.length && sendSms) {
      await sendSms(rec.phones, 'Lock & Roll: ' + requesterName + ' requested PTO ' + dates + ' (' + days + ' days). Approve in Nova: ' + appUrl('/'));
    }
  } catch (e) { console.error('[pto] approver notify failed:', e.message); }
}
async function notifyRequester(userId, decision, from, to, days, approverName, reason) {
  if (!userId) return;
  try {
    var rec = notify ? await notify.broadcastRecipients('pto_decided', 'id = ' + userId) : { emails: [], phones: [] };
    var dates = from + (to !== from ? ' to ' + to : '');
    var approved = decision === 'approved';
    if (rec.emails && rec.emails.length && sendEmail && emailTemplate) {
      var html = emailTemplate({
        badge: approved ? 'Approved' : 'Not Approved', badgeColor: approved ? 'green' : 'red',
        title: approved ? 'Your PTO is approved' : 'Your PTO was not approved',
        body: approved ? 'Your time off has been approved. This is your clearance to take the time.' : ('Your PTO request was not approved' + (reason ? ': ' + reason : '.')),
        details: [
          { label: 'Dates', value: dates },
          { label: 'Business days', value: String(days) },
          { label: approved ? 'Approved by' : 'Reviewed by', value: approverName || 'your manager' }
        ],
        buttonText: 'View in Nova', buttonUrl: appUrl('/')
      });
      await sendEmail(rec.emails, (approved ? 'PTO approved: ' : 'PTO not approved: ') + dates, html);
    }
    if (rec.phones && rec.phones.length && sendSms) {
      var msg = approved
        ? ('Lock & Roll: Your PTO ' + dates + ' was approved by ' + (approverName || 'your manager') + '.')
        : ('Lock & Roll: Your PTO ' + dates + ' was not approved' + (reason ? ' (' + reason + ')' : '') + '.');
      await sendSms(rec.phones, msg + ' ' + appUrl('/'));
    }
  } catch (e) { console.error('[pto] requester notify failed:', e.message); }
}

// Reverse an approved PTO: restore paid hours and clear the vacation shifts.
// Must be called inside a transaction (pass the connected client).
async function reverseAndClear(client, r, actorId) {
  const from = ymdOf(r.start_date), to = ymdOf(r.end_date);
  if (r.paid) {
    await postLedger(client, { user_id: r.user_id, entry_date: from, kind: 'reversal', amount_hours: Number(r.hours), description: 'PTO cancelled ' + from, request_id: r.id, created_by: actorId });
  }
  await client.query('UPDATE pto_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['cancelled', r.id]);
  await client.query('UPDATE shifts SET position_id = NULL, updated_at = NOW() WHERE user_id = $1 AND shift_date BETWEEN $2 AND $3 AND position_id = ANY($4::int[])', [r.user_id, from, to, [APPROVED_VACATION_POSITION_ID, UNPAID_VACATION_POSITION_ID]]);
}

// Notify the employee that their manager wants to cancel an approved PTO.
async function notifyCancelOffer(userId, from, to, memo, managerName) {
  if (!userId) return;
  try {
    var rec = notify ? await notify.broadcastRecipients('pto_decided', 'id = ' + userId) : { emails: [], phones: [] };
    var dates = from + (to !== from ? ' to ' + to : '');
    if (rec.emails && rec.emails.length && sendEmail && emailTemplate) {
      var html = emailTemplate({
        badge: 'Action Needed', badgeColor: 'orange', title: 'A cancellation of your approved PTO needs your OK',
        body: (managerName || 'Your manager') + ' has asked to cancel your approved time off. It stays approved until you accept. Open Nova to accept or decline.',
        details: [
          { label: 'Dates', value: dates },
          { label: 'Requested by', value: managerName || 'your manager' },
          { label: 'Reason', value: memo || '(none given)' }
        ],
        buttonText: 'Review in Nova', buttonUrl: appUrl('/'), footerNote: 'Open Nova, then Time Off, then My PTO.'
      });
      await sendEmail(rec.emails, 'Please review: cancellation of your PTO ' + dates, html);
    }
    if (rec.phones && rec.phones.length && sendSms) {
      await sendSms(rec.phones, 'Lock & Roll: ' + (managerName || 'Your manager') + ' asked to cancel your approved PTO ' + dates + '. It stays approved until you accept in Nova: ' + appUrl('/'));
    }
  } catch (e) { console.error('[pto] cancel-offer notify failed:', e.message); }
}

// Notify the initiating manager of the employee decision.
async function notifyCancelResult(managerId, accepted, employeeName, from, to) {
  if (!managerId) return;
  try {
    var rec = notify ? await notify.broadcastRecipients('pto_decided', 'id = ' + managerId) : { emails: [], phones: [] };
    var dates = from + (to !== from ? ' to ' + to : '');
    if (rec.emails && rec.emails.length && sendEmail && emailTemplate) {
      var html = emailTemplate({
        badge: accepted ? 'Cancellation Accepted' : 'Cancellation Declined', badgeColor: accepted ? 'green' : 'red',
        title: (employeeName || 'The employee') + (accepted ? ' accepted the cancellation' : ' declined the cancellation'),
        body: accepted ? 'The PTO has been cancelled and any hours restored.' : 'The PTO stays approved. You can propose a cancellation again if needed.',
        details: [ { label: 'Employee', value: employeeName || '' }, { label: 'Dates', value: dates } ],
        buttonText: 'View in Nova', buttonUrl: appUrl('/')
      });
      await sendEmail(rec.emails, (accepted ? 'PTO cancellation accepted: ' : 'PTO cancellation declined: ') + dates, html);
    }
    if (rec.phones && rec.phones.length && sendSms) {
      await sendSms(rec.phones, 'Lock & Roll: ' + (employeeName || 'Employee') + (accepted ? ' accepted' : ' declined') + ' the cancellation of PTO ' + dates + '. ' + appUrl('/'));
    }
  } catch (e) { console.error('[pto] cancel-result notify failed:', e.message); }
}

// ---- MY PTO ----------------------------------------------------------------

router.get('/me', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const ur = await pool.query('SELECT id, name, pay_type, hire_date, pto_balance_hours, pto_exempt, org_level FROM users WHERE id = $1', [uid]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = ur.rows[0];
  const bands = await getJsonSetting('pto_accrual_bands', DEFAULT_BANDS);
  const waiting = Number(await getSetting('pto_waiting_days', 90)) || 90;
  const years = tenureYears(u.hire_date);
  const band = resolveBand(bands, years);
  const monthlyHours = monthlyHoursFromBand(band);
  const elig = await eligibleInfo(u, waiting);
  const ledger = await pool.query(
    'SELECT id, entry_date, kind, amount_hours, description, created_at FROM pto_ledger WHERE user_id = $1 ORDER BY entry_date DESC, id DESC LIMIT 100',
    [uid]
  );
  const reqs = await pool.query(
    'SELECT r.id, r.start_date, r.end_date, r.business_days, r.hours, r.type, r.paid, r.status, r.required_level, r.override_reason, r.created_at, r.cancel_memo, ci.name AS cancel_by_name ' +
    'FROM pto_requests r LEFT JOIN users ci ON ci.id = r.cancel_initiated_by WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 100',
    [uid]
  );
  res.json({
    pay_type: u.pay_type || 'hourly',
    balance_hours: Number(u.pto_balance_hours) || 0,
    accrual_monthly_hours: monthlyHours,
    accrual_days_per_year: Number(band && band.days_per_year) || 0,
    tenure_years: years,
    exempt: u.pto_exempt === true,
    eligible_date: elig.eligible_date,
    eligible_now: elig.eligible_now,
    ledger: ledger.rows,
    requests: reqs.rows
  });
});

// GET /pto/project?date=YYYY-MM-DD
// Accurate forward projection of banked PTO. Mirrors jobs/ptoAccrual.js exactly so
// the estimate matches what the balance will actually do:
//   - one monthly accrual at each upcoming month start (the current month already
//     accrued, so we start from next month);
//   - accrual bands step up as the person crosses service anniversaries;
//   - the balance cap fills partially and never accrues past itself;
//   - Jan 1 carryover forfeiture is applied BEFORE that day's accrual (cron order);
//   - exempt staff and staff with no hire date do not accrue.
// Approved time off is already reflected in the balance; pending requests are excluded.
router.get('/project', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const target = String(req.query.date || '').slice(0, 10);
  if (!RE_DATE.test(target)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required.' });

  const ur = await pool.query('SELECT pay_type, hire_date, COALESCE(pto_balance_hours,0) AS bal, pto_exempt FROM users WHERE id = $1', [uid]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = ur.rows[0];

  const bands = await getJsonSetting('pto_accrual_bands', DEFAULT_BANDS);
  const capRaw = await getSetting('pto_balance_cap_days', null);
  const carryRaw = await getSetting('pto_carryover_days', null);
  const capHours = (capRaw === null || capRaw === undefined || capRaw === '') ? null : Number(capRaw) * HRS_PER_DAY;
  const carryHours = (carryRaw === null || carryRaw === undefined || carryRaw === '') ? null : Number(carryRaw) * HRS_PER_DAY;
  const exempt = u.pto_exempt === true;
  const accrues = !exempt && !!u.hire_date;

  const startBal = Number(u.bal) || 0;
  const t = parseDate(target);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let bal = startBal, accrued = 0, forfeited = 0, months = 0, hitCap = false;
  if (t && t > today) {
    let d = new Date(today.getFullYear(), today.getMonth() + 1, 1); // first upcoming month start
    let guard = 0;
    while (d <= t && guard++ < 600) {
      // Jan 1 carryover forfeiture runs before that day's accrual, matching the cron.
      if (d.getMonth() === 0 && d.getDate() === 1 && carryHours !== null && bal > carryHours) {
        forfeited += bal - carryHours;
        bal = carryHours;
      }
      if (accrues) {
        let amt = monthlyHoursFromBand(resolveBand(bands, tenureAt(u.hire_date, d)));
        if (amt > 0 && capHours !== null) {
          const room = capHours - bal;
          amt = room <= 0 ? 0 : Math.min(amt, room);
        }
        amt = Math.round(amt * 100) / 100;
        if (amt > 0) { bal += amt; accrued += amt; }
      }
      months++;
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
    if (capHours !== null && bal >= capHours - 0.001) hitCap = true;
  }

  res.json({
    pay_type: u.pay_type || 'hourly',
    exempt: exempt,
    accrues: accrues,
    target_date: target,
    start_balance_hours: Math.round(startBal * 100) / 100,
    projected_hours: Math.round(bal * 100) / 100,
    accrued_hours: Math.round(accrued * 100) / 100,
    forfeited_hours: Math.round(forfeited * 100) / 100,
    months: months,
    cap_hours: capHours,
    carryover_hours: carryHours,
    hit_cap: hitCap
  });
});

// ---- CREATE A REQUEST ------------------------------------------------------

router.post('/requests', requireAuth, async (req, res) => {
  const b = req.body || {};
  const uid = req.user.id;
  if (!RE_DATE.test(b.start_date)) return res.status(400).json({ error: 'Start date is required' });
  const start = b.start_date;
  const end = RE_DATE.test(b.end_date) ? b.end_date : b.start_date;
  if (parseDate(end) < parseDate(start)) return res.status(400).json({ error: 'End date is before start date' });
  const days = businessDays(start, end);
  if (!days) return res.status(400).json({ error: 'Select at least one business day' });
  const hours = days * HRS_PER_DAY;

  const ur = await pool.query('SELECT id, name, hire_date, pto_balance_hours, supervisor_id FROM users WHERE id = $1', [uid]);
  const u = ur.rows[0];
  const waiting = Number(await getSetting('pto_waiting_days', 90)) || 90;
  const elig = await eligibleInfo(u, waiting);
  if (!elig.eligible_now) return res.status(400).json({ error: 'You are inside your first ' + waiting + ' days. Eligible ' + elig.eligible_date + '.' });

  const balance = Number(u.pto_balance_hours) || 0;
  const paid = b.paid !== false;
  // The no-negative-balance wall applies only to paid time.
  if (paid && balance - hours < 0) {
    return res.status(400).json({ error: 'This exceeds your balance. No negative balances.' });
  }
  const tier = requiredTier(days);
  const ins = await pool.query(
    'INSERT INTO pto_requests (user_id, start_date, end_date, business_days, hours, type, paid, status, required_level, created_at, updated_at) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()) RETURNING *',
    [uid, start, end, days, hours, (b.type || 'Vacation'), paid, 'pending', tier.level]
  );
  const reqRow = ins.rows[0];
  await logAudit({ entity_type: 'pto_request', entity_id: reqRow.id, action: 'submitted', user_id: uid, user_name: u.name, details: { start, end, days, tier: tier.label } });
  // Notify the approver line (supervisor) by email + SMS.
  await notifyApprover(parseInt(u.supervisor_id, 10) || 0, u.name, start, end, days, paid, (b.type || 'Vacation'), tier.label);
  res.json(reqRow);
});

// ---- APPROVALS QUEUE (requests I can act on) -------------------------------

router.get('/approvals', requireAuth, async (req, res) => {
  const pend = await pool.query(
    'SELECT r.*, u.name AS user_name, u.pay_type FROM pto_requests r JOIN users u ON u.id = r.user_id ' +
    "WHERE r.status IN ('pending','cancel_requested') ORDER BY r.created_at ASC"
  );
  const out = [];
  for (let i = 0; i < pend.rows.length; i++) {
    const r = pend.rows[i];
    if (await canApprove(req.user, r.user_id)) {
      const already = await coverageOverlapCount(ymdOf(r.start_date), ymdOf(r.end_date), r.user_id);
      const cap = await coverageCap(null);
      r.coverage_used = already + 1;
      r.coverage_cap = cap;
      r.coverage_over = cap !== null && (already + 1) > cap;
      out.push(r);
    }
  }
  res.json(out);
});

// ---- APPROVED HISTORY (requests I can act on, already decided-approved) -----
// Paginated. Same reporting-line scope as the pending queue. Newest first.
router.get('/approved', requireAuth, async (req, res) => {
  const pageSize = Math.min(Math.max(parseInt(req.query.page_size, 10) || 10, 1), 50);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const appr = await pool.query(
    'SELECT r.*, u.name AS user_name, u.pay_type, a.name AS approver_name ' +
    'FROM pto_requests r JOIN users u ON u.id = r.user_id ' +
    'LEFT JOIN users a ON a.id = r.approver_id ' +
    "WHERE r.status = 'approved' ORDER BY COALESCE(r.decided_at, r.updated_at) DESC, r.id DESC"
  );
  // Filter to the reporting line (admins/owner see all) — mirrors /approvals.
  const mine = [];
  for (let i = 0; i < appr.rows.length; i++) {
    const r = appr.rows[i];
    if (await canApprove(req.user, r.user_id)) mine.push(r);
  }
  const total = mine.length;
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  const start = (page - 1) * pageSize;
  const rows = mine.slice(start, start + pageSize);
  res.json({ rows: rows, total: total, page: page, page_size: pageSize, pages: pages });
});

// ---- APPROVE ---------------------------------------------------------------

router.post('/requests/:id/approve', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const rr = await pool.query('SELECT * FROM pto_requests WHERE id = $1', [id]);
  if (!rr.rows.length) return res.status(404).json({ error: 'Request not found' });
  const r = rr.rows[0];
  if (!(await canApprove(req.user, r.user_id))) return res.status(403).json({ error: 'Not your request to approve' });
  if (r.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

  const from = ymdOf(r.start_date), to = ymdOf(r.end_date);
  const already = await coverageOverlapCount(from, to, r.user_id);
  const cap = await coverageCap(null);
  const over = cap !== null && (already + 1) > cap;
  const overrideReason = String((req.body && req.body.override_reason) || '').trim();
  if (over && !overrideReason) {
    return res.status(400).json({ error: 'coverage_override_required', coverage_used: already + 1, coverage_cap: cap });
  }

  // Re-check the hard wall at approval time for paid requests.
  if (r.paid) {
    const bal = await pool.query('SELECT COALESCE(pto_balance_hours,0) AS b FROM users WHERE id = $1', [r.user_id]);
    if (Number(bal.rows[0].b) - Number(r.hours) < 0) return res.status(400).json({ error: 'Employee no longer has the balance for this.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE pto_requests SET status = $1, approver_id = $2, decided_at = NOW(), coverage_override = $3, override_reason = $4, updated_at = NOW() WHERE id = $5',
      ['approved', req.user.id, over, over ? overrideReason : null, id]
    );
    if (r.paid) {
      await postLedger(client, {
        user_id: r.user_id, entry_date: from, kind: 'usage', amount_hours: -Number(r.hours),
        description: 'PTO ' + from + (to !== from ? ' to ' + to : ''), request_id: id, created_by: req.user.id
      });
    }
    // Flip the scheduled shifts to Approved / Unpaid Vacation Day (kept visible, not deleted).
    const posId = r.paid ? APPROVED_VACATION_POSITION_ID : UNPAID_VACATION_POSITION_ID;
    await client.query(
      'UPDATE shifts SET position_id = $1, updated_at = NOW() WHERE user_id = $2 AND shift_date BETWEEN $3 AND $4',
      [posId, r.user_id, from, to]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Approve failed: ' + e.message });
  } finally {
    client.release();
  }

  await logAudit({
    entity_type: 'pto_request', entity_id: id, action: over ? 'approved_override' : 'approved',
    user_id: req.user.id, user_name: req.user.name,
    details: { dates: from + ' to ' + to, coverage_used: already + 1, coverage_cap: cap, override_reason: over ? overrideReason : null }
  });
  await notifyRequester(r.user_id, 'approved', from, to, r.business_days, req.user.name, null);
  res.json({ success: true, coverage_override: over });
});

// ---- DENY ------------------------------------------------------------------

router.post('/requests/:id/deny', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const rr = await pool.query('SELECT * FROM pto_requests WHERE id = $1', [id]);
  if (!rr.rows.length) return res.status(404).json({ error: 'Request not found' });
  const r = rr.rows[0];
  if (!(await canApprove(req.user, r.user_id))) return res.status(403).json({ error: 'Not your request to approve' });
  if (r.status !== 'pending' && r.status !== 'cancel_requested') return res.status(400).json({ error: 'Nothing to deny' });
  const reason = String((req.body && req.body.reason) || '').trim();
  // Denying a CANCELLATION request keeps the PTO approved — nothing is reversed.
  if (r.status === 'cancel_requested') {
    await pool.query('UPDATE pto_requests SET status = $1, decision_reason = $2, updated_at = NOW() WHERE id = $3', ['approved', reason || null, id]);
    await logAudit({ entity_type: 'pto_request', entity_id: id, action: 'cancel_denied', user_id: req.user.id, user_name: req.user.name, details: { reason: reason } });
    return res.json({ success: true, status: 'approved' });
  }
  await pool.query(
    'UPDATE pto_requests SET status = $1, approver_id = $2, decided_at = NOW(), decision_reason = $3, updated_at = NOW() WHERE id = $4',
    ['denied', req.user.id, reason || null, id]
  );
  await logAudit({ entity_type: 'pto_request', entity_id: id, action: 'denied', user_id: req.user.id, user_name: req.user.name, details: { reason: reason } });
  await notifyRequester(r.user_id, 'denied', ymdOf(r.start_date), ymdOf(r.end_date), r.business_days, req.user.name, reason);
  res.json({ success: true });
});

// ---- CANCEL / WITHDRAW -----------------------------------------------------

router.post('/requests/:id/cancel', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const rr = await pool.query('SELECT * FROM pto_requests WHERE id = $1', [id]);
  if (!rr.rows.length) return res.status(404).json({ error: 'Request not found' });
  const r = rr.rows[0];
  const mine = r.user_id === req.user.id;
  const canApp = await canApprove(req.user, r.user_id);
  if (!mine && !canApp) return res.status(403).json({ error: 'Not allowed' });

  // Pending request: withdraw outright (nothing was deducted).
  if (r.status === 'pending') {
    await pool.query('UPDATE pto_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['cancelled', id]);
    return res.json({ success: true, status: 'cancelled' });
  }
  // Approved request: employee asks, approver confirms; only then restore + revert.
  if (r.status === 'approved' || r.status === 'cancel_requested') {
    if (mine && !canApp) {
      if (r.status === 'cancel_requested') return res.json({ success: true, status: 'cancel_requested' });
      await pool.query('UPDATE pto_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['cancel_requested', id]);
      return res.json({ success: true, status: 'cancel_requested' });
    }
    const from = ymdOf(r.start_date), to = ymdOf(r.end_date);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (r.paid) {
        await postLedger(client, { user_id: r.user_id, entry_date: from, kind: 'reversal', amount_hours: Number(r.hours), description: 'PTO cancelled ' + from, request_id: id, created_by: req.user.id });
      }
      await client.query('UPDATE pto_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['cancelled', id]);
      await client.query('UPDATE shifts SET position_id = NULL, updated_at = NOW() WHERE user_id = $1 AND shift_date BETWEEN $2 AND $3 AND position_id = ANY($4::int[])', [r.user_id, from, to, [APPROVED_VACATION_POSITION_ID, UNPAID_VACATION_POSITION_ID]]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Cancel failed: ' + e.message });
    } finally { client.release(); }
    await logAudit({ entity_type: 'pto_request', entity_id: id, action: 'cancelled', user_id: req.user.id, user_name: req.user.name, details: { dates: from + ' to ' + to } });
    return res.json({ success: true, status: 'cancelled' });
  }
  return res.status(400).json({ error: 'Nothing to cancel' });
});

// Manager/approver proposes cancelling an already-approved PTO. The employee must
// accept before anything is reversed. Admins/owner may force it through immediately.
// Body: { memo (required), force (optional; admin/owner only) }.
router.post('/requests/:id/mgr-cancel', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const memo = String((req.body && req.body.memo) || '').trim();
  const force = (req.body && req.body.force) === true;
  const rr = await pool.query('SELECT * FROM pto_requests WHERE id = $1', [id]);
  if (!rr.rows.length) return res.status(404).json({ error: 'Request not found' });
  const r = rr.rows[0];
  if (r.user_id === req.user.id) return res.status(400).json({ error: 'Use the normal cancel on your own request' });
  if (!(await canApprove(req.user, r.user_id))) return res.status(403).json({ error: 'Not in this employee approval line' });
  if (r.status !== 'approved') return res.status(400).json({ error: 'Only an approved request can be cancelled here' });
  if (!memo) return res.status(400).json({ error: 'A reason memo is required' });

  const isAdmin = req.user.role === 'admin' || req.user.isOwner;
  const from = ymdOf(r.start_date), to = ymdOf(r.end_date);

  // Admin/owner force: reverse immediately, no employee approval, memo logged.
  if (force && isAdmin) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE pto_requests SET cancel_memo = $1, cancel_initiated_by = $2, cancel_initiated_at = NOW() WHERE id = $3', [memo, req.user.id, id]);
      await reverseAndClear(client, r, req.user.id);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Force cancel failed: ' + e.message });
    } finally { client.release(); }
    await logAudit({ entity_type: 'pto_request', entity_id: id, action: 'cancelled_forced', user_id: req.user.id, user_name: req.user.name, details: { dates: from + ' to ' + to, memo: memo } });
    await notifyRequester(r.user_id, 'not', from, to, r.business_days, req.user.name, 'Cancelled by ' + req.user.name + ': ' + memo);
    return res.json({ success: true, status: 'cancelled' });
  }

  // Standard path: offer the cancellation to the employee for approval.
  await pool.query('UPDATE pto_requests SET status = $1, cancel_memo = $2, cancel_initiated_by = $3, cancel_initiated_at = NOW(), updated_at = NOW() WHERE id = $4', ['cancel_offered', memo, req.user.id, id]);
  await logAudit({ entity_type: 'pto_request', entity_id: id, action: 'cancel_offered', user_id: req.user.id, user_name: req.user.name, details: { dates: from + ' to ' + to, memo: memo } });
  await notifyCancelOffer(r.user_id, from, to, memo, req.user.name);
  return res.json({ success: true, status: 'cancel_offered' });
});

// Employee responds to a manager-proposed cancellation. Body: { accept: bool }.
router.post('/requests/:id/cancel-respond', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const accept = (req.body && req.body.accept) === true;
  const rr = await pool.query('SELECT * FROM pto_requests WHERE id = $1', [id]);
  if (!rr.rows.length) return res.status(404).json({ error: 'Request not found' });
  const r = rr.rows[0];
  if (r.user_id !== req.user.id) return res.status(403).json({ error: 'Only the employee can respond to this' });
  if (r.status !== 'cancel_offered') return res.status(400).json({ error: 'No cancellation is awaiting your response' });
  const from = ymdOf(r.start_date), to = ymdOf(r.end_date);

  if (!accept) {
    await pool.query('UPDATE pto_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['approved', id]);
    await logAudit({ entity_type: 'pto_request', entity_id: id, action: 'cancel_declined', user_id: req.user.id, user_name: req.user.name, details: { dates: from + ' to ' + to } });
    await notifyCancelResult(r.cancel_initiated_by, false, req.user.name, from, to);
    return res.json({ success: true, status: 'approved' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await reverseAndClear(client, r, req.user.id);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Cancel failed: ' + e.message });
  } finally { client.release(); }
  await logAudit({ entity_type: 'pto_request', entity_id: id, action: 'cancel_accepted', user_id: req.user.id, user_name: req.user.name, details: { dates: from + ' to ' + to } });
  await notifyCancelResult(r.cancel_initiated_by, true, req.user.name, from, to);
  return res.json({ success: true, status: 'cancelled' });
});

// ---- TEAM (read-only, downline) -------------------------------------------

router.get('/team', requireAuth, requirePermission('manage_pto'), async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.isOwner;
  const ur = await pool.query('SELECT id, name, title, pay_type, org_level, hire_date, pto_exempt, pto_balance_hours, supervisor_id FROM users WHERE active IS NOT FALSE ORDER BY name ASC');
  const out = [];
  for (let i = 0; i < ur.rows.length; i++) {
    const u = ur.rows[i];
    if (u.id === req.user.id) continue;
    if (isAdmin || (await inDownline(req.user.id, u.id))) {
      const pend = await pool.query("SELECT start_date, end_date FROM pto_requests WHERE user_id = $1 AND status = 'pending' ORDER BY start_date ASC LIMIT 1", [u.id]);
      out.push({
        id: u.id, name: u.name, title: u.title, pay_type: u.pay_type || 'hourly',
        balance_hours: Number(u.pto_balance_hours) || 0,
        hire_date: u.hire_date ? ymdOf(u.hire_date) : null,
        exempt: u.pto_exempt === true,
        pending: pend.rows.length ? ymdOf(pend.rows[0].start_date) : null
      });
    }
  }
  res.json(out);
});

router.get('/team/:userId/ledger', requireAuth, requirePermission('manage_pto'), async (req, res) => {
  const target = parseInt(req.params.userId, 10) || 0;
  const isAdmin = req.user.role === 'admin' || req.user.isOwner;
  if (!isAdmin && !(await inDownline(req.user.id, target))) return res.status(403).json({ error: 'Not in your team' });
  const rows = await pool.query('SELECT id, entry_date, kind, amount_hours, description, created_at FROM pto_ledger WHERE user_id = $1 ORDER BY entry_date DESC, id DESC LIMIT 200', [target]);
  res.json(rows.rows);
});

// ---- RETROACTIVE LOG (manager/admin, for a downline report) ----------------

router.post('/log', requireAuth, requirePermission('manage_pto'), async (req, res) => {
  const b = req.body || {};
  const target = parseInt(b.user_id, 10) || 0;
  if (!target) return res.status(400).json({ error: 'Employee is required' });
  const isAdmin = req.user.role === 'admin' || req.user.isOwner;
  if (!isAdmin && !(await inDownline(req.user.id, target))) return res.status(403).json({ error: 'Not in your team' });
  if (!RE_DATE.test(b.start_date)) return res.status(400).json({ error: 'Start date is required' });
  const from = b.start_date, to = RE_DATE.test(b.end_date) ? b.end_date : b.start_date;
  const days = businessDays(from, to);
  if (!days) return res.status(400).json({ error: 'Select at least one business day' });
  const paid = b.paid !== false;
  const reason = String(b.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to log PTO after the fact' });
  const hours = days * HRS_PER_DAY;

  const ur = await pool.query('SELECT name, COALESCE(pto_balance_hours,0) AS bal FROM users WHERE id = $1', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'Employee not found' });
  if (paid && Number(ur.rows[0].bal) - hours < 0) return res.status(400).json({ error: 'Exceeds available balance. No negative balances.' });

  const client = await pool.connect();
  let reqId = null;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      'INSERT INTO pto_requests (user_id, start_date, end_date, business_days, hours, type, paid, status, required_level, approver_id, decided_at, retroactive, decision_reason, created_at, updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),TRUE,$11,NOW(),NOW()) RETURNING id',
      [target, from, to, days, hours, (b.type || 'Vacation'), paid, 'approved', 4, req.user.id, reason]
    );
    reqId = ins.rows[0].id;
    if (paid) {
      await postLedger(client, { user_id: target, entry_date: from, kind: 'usage', amount_hours: -hours, description: 'Logged after the fact — ' + from + ' (' + reason + ')', request_id: reqId, created_by: req.user.id });
    }
    const posId = paid ? APPROVED_VACATION_POSITION_ID : UNPAID_VACATION_POSITION_ID;
    await client.query('UPDATE shifts SET position_id = $1, updated_at = NOW() WHERE user_id = $2 AND shift_date BETWEEN $3 AND $4', [posId, target, from, to]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Log failed: ' + e.message });
  } finally { client.release(); }

  await logAudit({ entity_type: 'pto_request', entity_id: reqId, action: 'logged_retroactive', user_id: req.user.id, user_name: req.user.name, details: { target: target, dates: from + ' to ' + to, reason: reason, paid: paid } });
  res.json({ success: true, request_id: reqId });
});

// ---- SETTINGS (accrual bands, coverage caps, waiting/carryover) ------------

router.get('/settings', requireAuth, requirePermission('manage_pto'), async (req, res) => {
  res.json({
    accrual_bands: await getJsonSetting('pto_accrual_bands', DEFAULT_BANDS),
    waiting_days: Number(await getSetting('pto_waiting_days', 90)) || 90,
    carryover_days: await getSetting('pto_carryover_days', null),
    balance_cap_days: await getSetting('pto_balance_cap_days', null),
    coverage_caps: await getJsonSetting('pto_coverage_caps', {}),
    coverage_default: await getSetting('pto_coverage_default', null)
  });
});

router.put('/settings', requireAuth, requirePermission('manage_pto'), async (req, res) => {
  const b = req.body || {};
  async function put(key, val) {
    if (val === undefined) return;
    const v = (typeof val === 'object') ? JSON.stringify(val) : String(val);
    await pool.query('INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()', [key, v]);
  }
  await put('pto_accrual_bands', b.accrual_bands);
  await put('pto_waiting_days', b.waiting_days);
  await put('pto_carryover_days', b.carryover_days);
  await put('pto_balance_cap_days', b.balance_cap_days);
  await put('pto_coverage_caps', b.coverage_caps);
  await put('pto_coverage_default', b.coverage_default);
  await logAudit({ entity_type: 'pto_settings', action: 'updated', user_id: req.user.id, user_name: req.user.name, details: {} });
  res.json({ success: true });
});

// ---- PER-USER PTO SETUP (hire date, exempt, optional starting balance) ------
// hire_date + exempt can be set by any manager over the person; setting a starting
// balance is admin/owner only (it writes a one-time adjustment line to the ledger).
router.put('/user/:id', requireAuth, requirePermission('manage_pto'), async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  if (!target) return res.status(400).json({ error: 'Employee is required' });
  const isAdmin = req.user.role === 'admin' || req.user.isOwner;
  if (!isAdmin && !(await inDownline(req.user.id, target))) return res.status(403).json({ error: 'Not in your team' });
  const b = req.body || {};
  const hire = RE_DATE.test(b.hire_date) ? b.hire_date : null;
  const exemptVal = (b.exempt === true) ? true : (b.exempt === false ? false : null); // only change when provided
  await pool.query('UPDATE users SET hire_date = COALESCE($1, hire_date), pto_exempt = COALESCE($2, pto_exempt) WHERE id = $3', [hire, exemptVal, target]);

  if (isAdmin && b.set_balance_days !== undefined && b.set_balance_days !== null && String(b.set_balance_days) !== '') {
    const targetHours = Number(b.set_balance_days) * HRS_PER_DAY;
    const cur = await pool.query('SELECT COALESCE(pto_balance_hours,0) AS b, name FROM users WHERE id = $1', [target]);
    const delta = targetHours - Number(cur.rows[0].b);
    if (delta !== 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await postLedger(client, {
          user_id: target, entry_date: ymd(new Date()), kind: 'adjustment', amount_hours: delta,
          description: 'Starting balance set to ' + Number(b.set_balance_days) + ' days', created_by: req.user.id
        });
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); return res.status(500).json({ error: 'Balance set failed: ' + e.message }); }
      finally { client.release(); }
    }
  }
  await logAudit({ entity_type: 'pto_user', entity_id: target, action: 'setup', user_id: req.user.id, user_name: req.user.name, details: { hire_date: hire, exempt: b.exempt === true } });
  res.json({ success: true });
});

// ---- AWARD PTO (admin/owner only — additive bonus days) --------------------
// Grants extra PTO on top of the current balance. Writes a single 'award' ledger
// line (audited). Distinct from /user set_balance (which sets an exact amount).
router.post('/award', requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.isOwner || req.user.role === 'owner';
  if (!isAdmin) return res.status(403).json({ error: 'Only an admin or owner can award PTO' });
  const b = req.body || {};
  const target = parseInt(b.user_id, 10) || 0;
  if (!target) return res.status(400).json({ error: 'Employee is required' });
  const days = Number(b.days);
  if (!isFinite(days) || days <= 0) return res.status(400).json({ error: 'Enter a positive number of days to award' });
  const reason = String(b.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to award PTO' });
  const hours = days * HRS_PER_DAY;
  const ur = await pool.query('SELECT name FROM users WHERE id = $1', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'Employee not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await postLedger(client, {
      user_id: target, entry_date: ymd(new Date()), kind: 'award', amount_hours: hours,
      description: 'Awarded ' + days + ' day' + (days === 1 ? '' : 's') + ' — ' + reason, created_by: req.user.id
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Award failed: ' + e.message });
  } finally { client.release(); }

  await logAudit({ entity_type: 'pto_user', entity_id: target, action: 'awarded_pto', user_id: req.user.id, user_name: req.user.name, details: { target: target, days: days, reason: reason } });
  res.json({ success: true, awarded_days: days });
});

module.exports = router;
