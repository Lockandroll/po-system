// Employee records - performance documentation, positive and negative.
//
// This is the structured half of Employee Files. The documents half already
// exists in routes/onboarding.js (hr_documents, encrypted to R2); this adds the
// records that sit alongside them on one timeline.
//
// Four kinds of record share one table:
//   recognition   - praise. The only kind that can reach a shared screen.
//   coaching      - a documented conversation. No signature.
//   performance   - a neutral observation for the file.
//   disciplinary  - a formal notice, levels 1-5, approval + signature + follow-up.
//
// Three rules run through the whole file and are worth stating once:
//
//  1. SCOPE IS VISIBILITY, CHAIN IS AUTHORITY. Who you can OPEN is decided by
//     utils/org.js teamIds() (your downline plus the cities you manage). What
//     you can DO is decided by permissions plus the guards in canActOn().
//  2. NOTHING PUBLIC LEAKS DISCIPLINE. Only type 'recognition' with
//     show_in_wins can be read by someone who is not in scope, and there is no
//     endpoint anywhere that returns a per-person record COUNT to a
//     non-privileged viewer. A number that rises when somebody is written up is
//     a write-up in disguise.
//  3. AN ISSUED NOTICE IS APPEND-ONLY. Once a disciplinary record has been sent
//     it cannot be edited. It is voided with a reason and reissued. Everything
//     that happens to it lands in employee_record_events.
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const org = require('../utils/org');
const notify = require('../utils/notify');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const recordCheck = require('../utils/recordCheck');
const permissions = require('../utils/permissions');
const r2 = require('../utils/r2');
const policySuggest = require('../utils/policySuggest');
const docText = require('../utils/docText');

// ---------------------------------------------------------------- constants

var TYPES = ['recognition', 'coaching', 'performance', 'disciplinary'];
var NOTE_TYPES = ['recognition', 'coaching', 'performance'];

// The ladder. Suspension is NOT its own rung - it rides on the final written
// warning, which is how Tony runs it and how the notice reads.
var LEVELS = [
  { n: 1, key: 'verbal', label: 'Verbal Warning (documented)' },
  { n: 2, key: 'written_1', label: 'First Written Warning' },
  { n: 3, key: 'written_2', label: 'Second Written Warning' },
  { n: 4, key: 'final', label: 'Final Written Warning', suspension: true },
  { n: 5, key: 'termination', label: 'Termination' }
];

// Default consequence wording per level. Overridable per company through the
// settings key employee_record_consequences, so the language can be reviewed by
// a lawyer and changed without a deploy. Multi-state, and the wording varies.
var DEFAULT_CONSEQUENCES = {
  1: 'Any further occurrence will result in a First Written Warning.',
  2: 'Any further occurrence within 90 days of this notice will result in a Second Written Warning.',
  3: 'Any further occurrence within 90 days of this notice will result in a Final Written Warning, which carries a suspension.',
  4: 'Any further occurrence within 90 days of this notice will result in termination of employment.',
  5: 'Employment is terminated effective on the date of this notice.'
};

var CATEGORIES = ['Attendance', 'Safety', 'Conduct', 'Performance', 'Policy violation',
  'Customer complaint', 'Vehicle or equipment', 'Cash handling', 'Teamwork', 'Customer service', 'Other'];

var SIGN_WINDOW_DAYS = 14;   // a signature request expires after this
var REMIND_EVERY_DAYS = 2;   // and is nudged this often until it does

function levelInfo(n) {
  n = parseInt(n, 10) || 0;
  for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].n === n) return LEVELS[i];
  return null;
}
function levelLabel(n) {
  var l = levelInfo(n);
  return l ? l.label : '';
}

// ---------------------------------------------------------------- helpers

function isAdminLike(user) {
  return !!(user && (user.role === 'admin' || user.isOwner === true));
}

function clean(v, max) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function cleanDate(v) {
  var s = clean(v);
  return (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null;
}

// pg returns a DATE column as a JS Date, not a string. String(thatDate) is
// "Mon Nov 16 2026 ...", so any lexicographic YYYY-MM-DD comparison against it
// quietly returns the wrong answer - which is how a warning past its escalation
// window would have carried on counting toward the ladder. Everything that
// compares dates goes through here. Local components, not toISOString, so a
// server behind UTC cannot shift the calendar day backwards.
function dstr(v) {
  if (!v) return null;
  if (v instanceof Date) {
    var m = v.getMonth() + 1, d = v.getDate();
    return v.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  }
  return String(v).slice(0, 10);
}

function addDays(dateStr, days) {
  var d = dateStr ? new Date(dateStr + 'T00:00:00Z') : new Date();
  d.setUTCDate(d.getUTCDate() + (parseInt(days, 10) || 0));
  return d.toISOString().slice(0, 10);
}

async function settingJson(key, fallback) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (!r.rows.length || !r.rows[0].value) return fallback;
    var parsed = JSON.parse(r.rows[0].value);
    return (parsed && typeof parsed === 'object') ? parsed : fallback;
  } catch (e) { return fallback; }
}

async function consequenceDefaults() {
  var custom = await settingJson('employee_record_consequences', null);
  var out = {};
  Object.keys(DEFAULT_CONSEQUENCES).forEach(function (k) {
    out[k] = (custom && typeof custom[k] === 'string' && custom[k].trim()) ? custom[k] : DEFAULT_CONSEQUENCES[k];
  });
  return out;
}

async function logEvent(recordId, action, actor, note, details) {
  try {
    await pool.query(
      'INSERT INTO employee_record_events (record_id, action, note, details, user_id, user_name) VALUES ($1,$2,$3,$4,$5,$6)',
      [recordId, String(action).slice(0, 40), note || null, details ? JSON.stringify(details) : null,
        (actor && actor.id) || null, (actor && actor.name) || null]
    );
  } catch (e) { console.error('[employee-records] event log failed:', e.message); }
}

// Everyone this viewer may OPEN. Admin and owner get the company; everyone else
// gets teamIds(), which is their reporting downline UNION the cities they
// manage. Note what that means in practice: a tech with no home_city set and no
// supervisor link is invisible to a city manager. That is a data problem, not a
// permissions one, and the roster endpoint reports it rather than hiding it.
async function scopeIds(user) {
  if (isAdminLike(user)) return null; // null = everybody
  return await org.teamIds(user.id);
}

// Whether this viewer may OPEN this person's file.
//
// Delegates to utils/org.js canOpenFile, which adds the rank rule on top of
// scope: a file can only be opened by somebody strictly ABOVE the person it
// belongs to. That is what stops admin reading admin and one city manager
// reading another. Scope alone would let both through.
async function inScope(user, targetId) {
  var t = await userRow(targetId);
  if (!t) return false;
  return await org.canOpenFile(user, t);
}

// Whether this viewer may WRITE a record about this person. Scope is necessary
// but not sufficient: you may never document yourself, and you may never
// document somebody above you in the reporting line. Both of those are how a
// records system gets used as a weapon, so they are blocked outright rather
// than left to policy.
async function canActOn(user, targetId) {
  targetId = parseInt(targetId, 10) || 0;
  if (!targetId) return { ok: false, why: 'Unknown employee.' };
  if (targetId === user.id) return { ok: false, why: 'You cannot write a record about yourself.' };
  if (await org.isUpline(targetId, user.id)) {
    return { ok: false, why: 'You cannot write a record about someone you report to.' };
  }
  // Same gate as opening the file. If you cannot read it you certainly cannot
  // write to it, and this is what keeps peers out of each other's records.
  if (!(await inScope(user, targetId))) {
    return { ok: false, why: 'You cannot write a record on that person.' };
  }
  return { ok: true };
}

function rowIsDisciplinary(r) { return r && r.type === 'disciplinary'; }

// Late deposits for one person. A manager marks these by hand on the deposit or
// on the Pulsar reconciliation board (routes/deposits.js POST /:id/late); this
// only counts them and hands back the dates.
//
// Why it lives here: "how many times has he been late?" is asked at exactly the
// moment somebody is writing a warning, and answering it from memory is how a
// warning ends up wrong. Wrapped, because a deployment where the deposits
// migration has not landed yet must not take the employee file down with it.
async function lateDeposits(userId, months) {
  months = months || 12;
  try {
    const r = await pool.query(
      'SELECT id, deposit_number, deposit_date, city_code, late_marked_by_name, late_reason ' +
      "FROM deposits WHERE user_id = $1 AND is_late = true AND deposit_date > CURRENT_DATE - ($2 || ' months')::interval " +
      'ORDER BY deposit_date DESC LIMIT 50',
      [userId, String(months)]
    );
    // Bucketed by month as well as listed, because "is this getting better or
    // worse" is a different question from "how many", and it is the one worth
    // answering before anybody writes anything.
    var byMonth = [];
    try {
      const m = await pool.query(
        "SELECT TO_CHAR(DATE_TRUNC('month', deposit_date), 'YYYY-MM') AS ym, COUNT(*)::int AS n " +
        "FROM deposits WHERE user_id = $1 AND is_late = true AND deposit_date > CURRENT_DATE - ($2 || ' months')::interval " +
        "GROUP BY DATE_TRUNC('month', deposit_date) ORDER BY 1 ASC",
        [userId, String(months)]
      );
      byMonth = m.rows.map(function (x) { return { month: x.ym, count: x.n }; });
    } catch (e) { byMonth = []; }

    return {
      available: true,
      months: months,
      count: r.rows.length,
      by_month: byMonth,
      deposits: r.rows.map(function (d) {
        return {
          id: d.id, number: d.deposit_number, date: dstr(d.deposit_date),
          city: d.city_code, marked_by: d.late_marked_by_name, reason: d.late_reason
        };
      })
    };
  } catch (e) {
    return { available: false, months: months, count: 0, by_month: [], deposits: [] };
  }
}

// Unaccounted shortages. Only the ones a manager RESOLVED as cash that cannot
// be accounted for ever get here - an unlogged expense or a typo closed the row
// on the reconciliation board and is none of the employee file's business.
// Wrapped for the same reason as the late one.
async function unaccountedShortages(userId, months) {
  months = months || 12;
  try {
    const r = await pool.query(
      'SELECT id, period_start, gap_amount, note, resolved_by_name ' +
      "FROM deposit_shortages WHERE user_id = $1 AND counts = true AND period_start > CURRENT_DATE - ($2 || ' months')::interval " +
      'ORDER BY period_start DESC LIMIT 50',
      [userId, String(months)]
    );
    var total = 0;
    var list = r.rows.map(function (x) {
      total += Number(x.gap_amount || 0);
      return {
        id: x.id, period_start: dstr(x.period_start), amount: Number(x.gap_amount || 0),
        note: x.note, resolved_by: x.resolved_by_name
      };
    });
    return { available: true, months: months, count: list.length, total: Math.round(total * 100) / 100, shortages: list };
  } catch (e) {
    return { available: false, months: months, count: 0, total: 0, shortages: [] };
  }
}

function shortageText(sh) {
  if (!sh || !sh.count) return '';
  var lines = sh.shortages.slice(0, 8).map(function (x) {
    return 'Pay week beginning ' + x.period_start + ': $' + x.amount.toFixed(2) +
      (x.note ? ' - ' + x.note : '');
  });
  return sh.count + ' pay week' + (sh.count === 1 ? '' : 's') + ' in the last ' + sh.months +
    ' months where cash could not be accounted for, totalling $' + sh.total.toFixed(2) + '.\n' + lines.join('\n');
}

// The sentence a manager would otherwise have to assemble by hand. Facts only:
// dates, count, and any reasons that were typed at the time. No adjectives -
// the wording check would flag them anyway, and rightly.
function lateDepositText(name, late) {
  if (!late || !late.count) return '';
  var dates = late.deposits.map(function (d) { return d.date; }).filter(Boolean);
  var shown = dates.slice(0, 8);
  var txt = late.count + ' deposit' + (late.count === 1 ? '' : 's') +
    ' recorded late in the last ' + late.months + ' months' +
    (shown.length ? ' (' + shown.join(', ') + (dates.length > shown.length ? ', and ' + (dates.length - shown.length) + ' more' : '') + ')' : '') + '.';
  var reasons = late.deposits.filter(function (d) { return d.reason; })
    .slice(0, 4).map(function (d) { return d.date + ': ' + d.reason; });
  if (reasons.length) txt += '\nRecorded at the time: ' + reasons.join('; ') + '.';
  return txt;
}

// What the employee themself is allowed to see of a record.
// The employee's view of one record. Attachments are passed IN rather than
// looked up here: this function is the single place that decides what an
// employee is allowed to see of a record, and a query hidden inside it would be
// a second place, reachable from any caller that forgot the visibility filter.
function employeeView(r, attachments) {
  return {
    attachments: attachments || [],
    id: r.id,
    type: r.type,
    level: r.level,
    level_label: levelLabel(r.level),
    category: r.category,
    occurred_on: dstr(r.occurred_on),
    body: r.body,
    corrective_action: r.corrective_action,
    consequence: r.consequence,
    sop_label: r.sop_label,
    status: r.status,
    created_at: r.created_at,
    created_by_name: r.created_by_name,
    approver_name: r.approver_name,
    sent_at: r.sent_at,
    signed_at: r.signed_at,
    refused_at: r.refused_at,
    acknowledged_at: r.acknowledged_at,
    employee_response: r.employee_response,
    employee_response_at: r.employee_response_at,
    expires_at: r.expires_at,
    needs_signature: r.type === 'disciplinary' && r.status === 'sent'
  };
}

// The SOP library, for the "Policy or SOP violated" dropdown. Only active
// documents, and only id + title - the bodies are large and the form has no use
// for them.
//
// Wrapped, because an empty or missing sop_documents table must not stop anybody
// writing a notice. With no library the dropdown simply offers the free-text
// option, which is what the field was before this existed.
async function activePolicies() {
  var out = [];
  try {
    const r = await pool.query('SELECT id, title FROM sop_documents WHERE active = true ORDER BY title ASC');
    r.rows.forEach(function (x) {
      out.push({ value: 'sop:' + x.id, source: 'sop', id: x.id, title: x.title, group: 'SOP library' });
    });
  } catch (e) {
    console.error('[employee-records] SOP list failed:', e.message);
  }
  // Files in a Document Vault folder an admin flagged as a policy source. Only
  // ones that actually produced text: a scanned PDF sitting in Policies cannot
  // be quoted, so offering it in the dropdown would promise something the
  // suggester can never deliver.
  try {
    const r = await pool.query(
      docText.POLICY_TREE_CTE +
      " SELECT d.id, d.name FROM documents d JOIN document_text t ON t.document_id = d.id " +
      " WHERE d.status = 'ready' AND t.status = 'ok' AND d.folder_id IN (SELECT id FROM policy_tree) " +
      ' ORDER BY d.name ASC'
    );
    r.rows.forEach(function (x) {
      out.push({ value: 'doc:' + x.id, source: 'document', id: x.id, title: x.name, group: 'Policy folder' });
    });
  } catch (e) {
    console.error('[employee-records] vault policy list failed:', e.message);
  }
  return out;
}

async function loadRecord(id) {
  const r = await pool.query('SELECT * FROM employee_records WHERE id = $1', [parseInt(id, 10) || 0]);
  return r.rows.length ? r.rows[0] : null;
}

// ---------------------------------------------------------------- attachments

// Supporting documentation hung off a record: the photo, the signed policy page,
// the customer email, the timesheet. Bytes go browser <-> R2 direct through a
// presigned URL and never pass through this API, the same way HR documents and
// A/P bills already work (see utils/r2.js and CLAUDE.md section 9).
var ATTACH_PREFIX = 'employee-records/';
var MAX_ATTACH_BYTES = 25 * 1024 * 1024;

// Statuses an employee never sees on their own file. Kept next to the gate that
// uses it rather than inlined, because GET /me filters on the same list and the
// two drifting apart is exactly how a draft accusation ends up shared.
var EMPLOYEE_HIDDEN_STATUSES = ['draft', 'pending_approval', 'returned', 'void'];

function attachKey(recordId, filename) {
  return ATTACH_PREFIX + recordId + '/' + Date.now() + '-' +
    String(filename || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function attachView(a) {
  return {
    id: a.id,
    record_id: a.record_id,
    filename: a.filename,
    content_type: a.content_type,
    size_bytes: (a.size_bytes === null || a.size_bytes === undefined) ? null : Number(a.size_bytes),
    uploaded_by: a.uploaded_by,
    uploaded_by_name: a.uploaded_by_name,
    created_at: a.created_at
  };
}

// Attachments for a whole page of records at once, as { recordId: [...] }. One
// query on purpose: the file screen renders every record it loaded, and doing
// this per row is the obvious N+1 waiting to be written.
//
// Wrapped, because a deploy where the migration has not landed yet must not take
// the employee file down with it. A file with no attachment list still works; a
// file that 500s does not.
async function attachmentsByRecord(ids) {
  var out = {};
  if (!ids || !ids.length) return out;
  try {
    const rows = (await pool.query(
      'SELECT * FROM employee_record_attachments WHERE record_id = ANY($1::int[]) ORDER BY id',
      [ids]
    )).rows;
    rows.forEach(function (a) {
      if (!out[a.record_id]) out[a.record_id] = [];
      out[a.record_id].push(attachView(a));
    });
  } catch (e) {
    console.error('[employee-records] attachment load failed:', e.message);
  }
  return out;
}

// requirePermission() cannot express "a manager in scope OR this record's own
// employee", and the download route needs exactly that. This is the permission
// half of it, extra_perms included, mirroring middleware/auth.js so one person
// granted a capability directly is not silently locked out here.
async function viewerHasPerm(req, perm) {
  try {
    if (await permissions.hasPermission(req.user.role, perm)) return true;
  } catch (e) {
    try { if (permissions.defaultHas(req.user.role, perm)) return true; } catch (_) {}
  }
  try {
    var cached = req._userRow;
    if (cached && cached.id === req.user.id) {
      return Array.isArray(cached.extra_perms) && cached.extra_perms.indexOf(perm) !== -1;
    }
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    var ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf(perm) !== -1;
  } catch (e) { return false; }
}

// Who may READ the documents on a record. Two doors, deliberately different:
//
//   * a manager comes in through view_employee_records plus scope;
//   * the employee comes in only on their OWN record, and only once it is both
//     shared with them and past the statuses above.
//
// An attachment inherits the visibility of the record it hangs on. There is no
// per-file share flag anywhere in this module, and that is a decision rather
// than an omission: two flags means two rules, and the way two rules eventually
// disagree here is that something private lands on somebody's My File screen.
//
// The draft clause is the same one GET /employee/:id enforces on the record
// text. A half-written accusation is private to whoever is writing it, and so
// is every photo attached to it - including from an admin.
async function canReadAttachments(req, rec) {
  if (!rec) return false;
  if (rec.status === 'draft' && rec.created_by !== req.user.id) return false;
  if (await viewerHasPerm(req, 'view_employee_records')) {
    if (await inScope(req.user, rec.user_id)) return true;
  }
  if (rec.approver_id === req.user.id && rec.status === 'pending_approval') {
    if (await viewerHasPerm(req, 'approve_discipline')) return true;
  }
  if (rec.user_id === req.user.id) {
    return !!rec.visible_to_employee && EMPLOYEE_HIDDEN_STATUSES.indexOf(rec.status) === -1;
  }
  return false;
}

// Who may ADD or REMOVE documents. Same authority as writing the record itself
// (canActOn: in scope, not yourself, not somebody you report to) plus the draft
// rule. A void record is frozen: it stays readable forever, but nothing new is
// hung off it, because a void notice is evidence of what was decided and when.
async function canWriteAttachments(req, rec) {
  if (!rec) return { ok: false, why: 'Not found.' };
  if (rec.status === 'void') return { ok: false, why: 'That record is void. Nothing more can be attached to it.' };
  if (rec.status === 'draft' && rec.created_by !== req.user.id) {
    return { ok: false, why: 'That draft belongs to somebody else.' };
  }
  return await canActOn(req.user, rec.user_id);
}

async function userRow(id) {
  const r = await pool.query(
    'SELECT id, name, email, phone, role, home_city, supervisor_id, active, receive_emails, receive_sms FROM users WHERE id = $1',
    [parseInt(id, 10) || 0]
  );
  return r.rows.length ? r.rows[0] : null;
}

function appUrl(path) {
  return (process.env.APP_URL || '').replace(/\/$/, '') + (path || '');
}

// Tell the employee something landed. Email plus SMS, both honouring their own
// notification preferences. Deliberately vague in the SMS: the fact that a
// notice exists is not something to spell out in a message that shows on a
// lock screen.
async function tellEmployee(u, subject, bodyHtml, smsText, opts) {
  if (!u) return;
  opts = opts || {};
  try {
    if (u.email && u.receive_emails !== false) {
      var html = emailTemplate({
        badge: opts.badge || 'Nova',
        badgeColor: opts.badgeColor || null,
        title: subject,
        body: bodyHtml,
        buttonText: opts.buttonText || null,
        buttonUrl: opts.buttonUrl || null,
        footerNote: opts.footerNote || null
      });
      await sendEmail(u.email, subject, html);
    }
  } catch (e) { console.error('[employee-records] email failed:', e.message); }
  try {
    if (smsText && u.phone && u.receive_sms) await sendSms(u.phone, smsText);
  } catch (e) { console.error('[employee-records] sms failed:', e.message); }
}

// ---------------------------------------------------------------- meta

// Everything the front end needs to draw the forms without hardcoding it.
router.get('/meta', requireAuth, requirePermission('view_employee_records'), async (req, res) => {
  res.json({
    types: TYPES,
    levels: LEVELS.map(function (l) { return { n: l.n, key: l.key, label: l.label, suspension: !!l.suspension }; }),
    categories: CATEGORIES,
    consequences: await consequenceDefaults(),
    policies: await activePolicies(),
    sign_window_days: SIGN_WINDOW_DAYS,
    default_escalation_days: 90,
    ai_available: !!process.env.ANTHROPIC_API_KEY
  });
});

// ---------------------------------------------------------------- roster

router.get('/roster', requireAuth, requirePermission('view_employee_records'), async (req, res) => {
  try {
    var ids = await scopeIds(req.user);
    var rows;
    if (ids === null) {
      rows = (await pool.query(
        'SELECT id, name, role, home_city FROM users WHERE active IS NOT FALSE ORDER BY name ASC'
      )).rows;
    } else {
      if (!ids.length) return res.json({ employees: [], stats: emptyStats(), no_city: 0 });
      rows = (await pool.query(
        'SELECT id, name, role, home_city FROM users WHERE id = ANY($1::int[]) AND active IS NOT FALSE ORDER BY name ASC',
        [ids]
      )).rows;
    }
    // Drop anyone at or above the viewer's own rank, and the viewer themself.
    // Without this an admin lists every other admin and the owner, and a city
    // manager lists the other manager in their city - and a name on a roster
    // with a records count beside it is already a disclosure.
    rows = org.filterOpenable(req.user, rows);
    var idList = rows.map(function (u) { return u.id; });
    var counts = { rows: [] };
    if (idList.length) {
      counts = await pool.query(
        "SELECT user_id, type, COUNT(*)::int AS n FROM employee_records " +
        "WHERE user_id = ANY($1::int[]) AND status <> 'void' AND status <> 'draft' " +
        "AND created_at > NOW() - INTERVAL '12 months' GROUP BY user_id, type",
        [idList]
      );
    }
    var last = { rows: [] };
    if (idList.length) {
      last = await pool.query(
        "SELECT user_id, MAX(updated_at) AS at FROM employee_records WHERE user_id = ANY($1::int[]) AND status <> 'draft' GROUP BY user_id",
        [idList]
      );
    }
    var docs = { rows: [] };
    if (idList.length) {
      try {
        docs = await pool.query(
          "SELECT user_id, COUNT(*)::int AS n FROM hr_documents WHERE user_id = ANY($1::int[]) AND review_status <> 'superseded' GROUP BY user_id",
          [idList]
        );
      } catch (e) { docs = { rows: [] }; }
    }
    var cmap = {}, lmap = {}, dmap = {};
    counts.rows.forEach(function (c) { (cmap[c.user_id] = cmap[c.user_id] || {})[c.type] = c.n; });
    last.rows.forEach(function (l) { lmap[l.user_id] = l.at; });
    docs.rows.forEach(function (d) { dmap[d.user_id] = d.n; });

    var noCity = 0;
    var employees = rows.map(function (u) {
      if (!u.home_city) noCity++;
      var c = cmap[u.id] || {};
      return {
        id: u.id, name: u.name, role: u.role, home_city: u.home_city || null,
        counts: {
          recognition: c.recognition || 0,
          coaching: c.coaching || 0,
          performance: c.performance || 0,
          disciplinary: c.disciplinary || 0
        },
        doc_count: dmap[u.id] || 0,
        last_activity: lmap[u.id] || null
      };
    });
    res.json({ employees: employees, stats: await rosterStats(req.user, idList), no_city: noCity });
  } catch (e) {
    console.error('[employee-records] roster failed:', e);
    res.status(500).json({ error: 'Could not load the roster.' });
  }
});

function emptyStats() {
  return { people: 0, praise_90: 0, open_followups: 0, awaiting_signature: 0, pending_approval: 0 };
}

async function rosterStats(user, idList) {
  var s = emptyStats();
  s.people = idList.length;
  if (!idList.length) return s;
  try {
    const r = await pool.query(
      "SELECT " +
      "  COUNT(*) FILTER (WHERE type = 'recognition' AND created_at > NOW() - INTERVAL '90 days')::int AS praise_90," +
      "  COUNT(*) FILTER (WHERE followup_on IS NOT NULL AND followup_outcome IS NULL AND status NOT IN ('draft','void'))::int AS open_followups," +
      "  COUNT(*) FILTER (WHERE status = 'sent')::int AS awaiting_signature," +
      "  COUNT(*) FILTER (WHERE status = 'pending_approval')::int AS pending_approval " +
      "FROM employee_records WHERE user_id = ANY($1::int[])",
      [idList]
    );
    if (r.rows.length) {
      s.praise_90 = r.rows[0].praise_90 || 0;
      s.open_followups = r.rows[0].open_followups || 0;
      s.awaiting_signature = r.rows[0].awaiting_signature || 0;
      s.pending_approval = r.rows[0].pending_approval || 0;
    }
  } catch (e) {}
  return s;
}

// ---------------------------------------------------------------- one file

router.get('/employee/:id', requireAuth, requirePermission('view_employee_records'), async (req, res) => {
  try {
    var target = parseInt(req.params.id, 10) || 0;
    if (!(await inScope(req.user, target))) {
      return res.status(403).json({ error: 'You cannot open that file.' });
    }
    var u = await userRow(target);
    if (!u) return res.status(404).json({ error: 'Not found.' });

    // A draft is private to whoever is writing it. Nobody else, not even an
    // admin, sees half-written accusations sitting on someone's file.
    const rows = (await pool.query(
      "SELECT * FROM employee_records WHERE user_id = $1 AND (status <> 'draft' OR created_by = $2) ORDER BY COALESCE(occurred_on, created_at::date) DESC, id DESC",
      [target, req.user.id]
    )).rows;

    var attach = await attachmentsByRecord(rows.map(function (r) { return r.id; }));

    var sup = u.supervisor_id ? await userRow(u.supervisor_id) : null;
    var late = await lateDeposits(target, 12);
    var shorts = await unaccountedShortages(target, 12);
    res.json({
      late_deposits: { count: late.count, months: late.months, available: late.available, by_month: late.by_month || [] },
      late_deposit_text: lateDepositText(u.name, late),
      shortages: { count: shorts.count, total: shorts.total, months: shorts.months, available: shorts.available },
      shortage_text: shortageText(shorts),
      user: {
        id: u.id, name: u.name, role: u.role, home_city: u.home_city,
        email: u.email || null, has_email: !!u.email,
        supervisor: sup ? { id: sup.id, name: sup.name } : null
      },
      records: rows.map(function (r) {
        return Object.assign({}, r, {
          level_label: levelLabel(r.level),
          occurred_on: dstr(r.occurred_on),
          followup_on: dstr(r.followup_on),
          counts_until: dstr(r.counts_until),
          attachments: attach[r.id] || []
        });
      }),
      ladder: ladderFor(rows),
      can_act: (await canActOn(req.user, target)).ok
    });
  } catch (e) {
    console.error('[employee-records] file failed:', e);
    res.status(500).json({ error: 'Could not load the file.' });
  }
});

// Where this person sits on the ladder, and what the next notice should be.
// Only notices that are still inside their escalation window count. A warning
// from two years ago stays on the file forever but stops escalating, which is
// how progressive discipline is meant to work and what stops an old note being
// used to justify a termination.
function ladderFor(rows) {
  var today = new Date().toISOString().slice(0, 10);
  var live = (rows || []).filter(function (r) {
    if (r.type !== 'disciplinary') return false;
    if (['draft', 'pending_approval', 'void'].indexOf(r.status) !== -1) return false;
    if (!r.counts_until) return true;
    return dstr(r.counts_until) >= today;
  });
  var highest = 0;
  live.forEach(function (r) { if ((r.level || 0) > highest) highest = r.level; });
  var all = (rows || []).filter(function (r) {
    return r.type === 'disciplinary' && ['draft', 'pending_approval', 'void'].indexOf(r.status) === -1;
  });
  return {
    highest_live: highest,
    suggested_next: Math.min(highest + 1, 5),
    suggested_label: levelLabel(Math.min(highest + 1, 5)),
    live_count: live.length,
    total_count: all.length,
    priors: all.slice(0, 6).map(function (r) {
      return {
        id: r.id, level: r.level, level_label: levelLabel(r.level), category: r.category,
        occurred_on: dstr(r.occurred_on), status: r.status, created_at: r.created_at,
        counts_until: dstr(r.counts_until),
        live: live.some(function (x) { return x.id === r.id; })
      };
    })
  };
}

// ---------------------------------------------------------------- notes

// Recognition, coaching and performance notes. One endpoint, because they are
// the same shape - what differs is only the defaults the front end applies.
router.post('/notes', requireAuth, requirePermission('create_employee_note'), async (req, res) => {
  try {
    var b = req.body || {};
    var type = clean(b.type, 24);
    if (NOTE_TYPES.indexOf(type) === -1) return res.status(400).json({ error: 'Pick a record type.' });
    var target = parseInt(b.user_id, 10) || 0;
    var guard = await canActOn(req.user, target);
    if (!guard.ok) return res.status(403).json({ error: guard.why });
    var body = clean(b.body, 8000);
    if (!body) return res.status(400).json({ error: 'Say what happened.' });

    var u = await userRow(target);
    var visible = b.visible_to_employee === true;
    // A win nobody can attribute is not a win: Recent Wins requires that the
    // person can see it in their own file.
    var wins = (type === 'recognition') && visible && b.show_in_wins === true;

    const ins = await pool.query(
      'INSERT INTO employee_records (user_id, type, category, occurred_on, body, source, external_ref, status, ' +
      'visible_to_employee, show_in_wins, city_code, created_by, created_by_name) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12) RETURNING *",
      [target, type, clean(b.category, 60), cleanDate(b.occurred_on) || new Date().toISOString().slice(0, 10),
        body, clean(b.source, 40), clean(b.external_ref, 80), visible, wins,
        (u && u.home_city) || null, req.user.id, req.user.name]
    );
    var rec = ins.rows[0];
    await logEvent(rec.id, 'created', req.user, null, { type: type, visible: visible, wins: wins });
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'created',
      user_id: req.user.id, user_name: req.user.name,
      details: { type: type, employee: (u && u.name) || target, visible_to_employee: visible, show_in_wins: wins }
    });

    if (visible && b.notify !== false && u) {
      var isPraise = type === 'recognition';
      await tellEmployee(
        u,
        isPraise ? 'Nice work' : 'A note has been added to your file',
        '<p>' + (isPraise
          ? 'Your manager added a recognition to your file.'
          : 'Your manager added a note to your file.') + '</p>' +
        '<p style="white-space:pre-wrap">' + escapeHtml(body) + '</p>' +
        '<p><a href="' + appUrl('/?view=my-file') + '">Open your file in Nova</a></p>',
        isPraise ? 'Nova: your manager added a recognition to your file.' : null
      );
      await pool.query('UPDATE employee_records SET notified_at = NOW() WHERE id = $1', [rec.id]);
    }
    res.json({ success: true, id: rec.id });
  } catch (e) {
    console.error('[employee-records] note failed:', e);
    res.status(500).json({ error: 'Could not save the record.' });
  }
});

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------- wording check

// Run the AI wording check on demand. Returns the same shape that gets stored on
// the record, so the front end can render it identically before and after save.
router.post('/check', requireAuth, requirePermission('create_employee_note'), async (req, res) => {
  try {
    var b = req.body || {};
    var result = await recordCheck.checkRecord({
      body: clean(b.body, 8000),
      corrective_action: clean(b.corrective_action, 4000),
      consequence: clean(b.consequence, 4000)
    }, { levelLabel: levelLabel(b.level), category: clean(b.category, 60) });
    res.json(result);
  } catch (e) {
    console.error('[employee-records] check failed:', e);
    // Never fail closed. Losing the check must not stop somebody documenting.
    res.json({ available: false, fields: {}, reds: 0, ambers: 0, checked_at: new Date().toISOString() });
  }
});

// Suggest which SOP the described incident breached. Retrieval over the SOP
// library, then the model, then a quote check - see utils/policySuggest.js. It
// suggests and never selects: the manager still picks the policy, and an empty
// list is a normal answer rather than an error.
router.post('/policy-suggest', requireAuth, requirePermission('create_employee_note'), async (req, res) => {
  try {
    var b = req.body || {};
    var out = await policySuggest.suggest(pool, {
      body: clean(b.body, 8000),
      category: clean(b.category, 60)
    });
    res.json(out);
  } catch (e) {
    console.error('[employee-records] policy suggest failed:', e);
    // Same rule as the wording check: never fail closed. Losing the suggestion
    // must not stop somebody citing the policy themselves.
    res.json({ available: false, reason: 'ai_failed', candidates: [] });
  }
});

// ---------------------------------------------------------------- disciplinary

// Create or update a DRAFT disciplinary notice. Once submitted it is frozen.
router.post('/disciplinary', requireAuth, requirePermission('create_disciplinary'), async (req, res) => {
  try {
    var b = req.body || {};
    var id = parseInt(b.id, 10) || 0;
    var existing = id ? await loadRecord(id) : null;
    if (id && !existing) return res.status(404).json({ error: 'Not found.' });
    if (existing && existing.status !== 'draft' && existing.status !== 'returned') {
      return res.status(409).json({ error: 'This notice has been submitted and can no longer be edited.' });
    }
    if (existing && existing.created_by !== req.user.id && !isAdminLike(req.user)) {
      return res.status(403).json({ error: 'This draft belongs to someone else.' });
    }
    var target = existing ? existing.user_id : (parseInt(b.user_id, 10) || 0);
    var guard = await canActOn(req.user, target);
    if (!guard.ok) return res.status(403).json({ error: guard.why });

    var level = parseInt(b.level, 10) || 0;
    if (!levelInfo(level)) return res.status(400).json({ error: 'Pick a level.' });
    var body = clean(b.body, 8000);
    var corrective = clean(b.corrective_action, 4000);
    var consequence = clean(b.consequence, 4000);
    var followup = cleanDate(b.followup_on);
    var occurred = cleanDate(b.occurred_on) || new Date().toISOString().slice(0, 10);
    var escDays = parseInt(b.escalation_days, 10);
    if (!isFinite(escDays) || escDays < 0 || escDays > 3650) escDays = 90;

    var u = await userRow(target);
    // Two citation columns because a policy now comes from one of two places:
    // sop_id for the SOP library, policy_document_id for a file in a policy
    // folder. Exactly one is set. sop_label is what actually prints on the
    // notice, and is filled from whichever title was chosen.
    var citedSop = parseInt(b.sop_id, 10) || null;
    var citedDoc = parseInt(b.policy_document_id, 10) || null;
    if (citedSop && citedDoc) citedDoc = null;
    var fields = [target, 'disciplinary', level, clean(b.category, 60), occurred, body, corrective, consequence,
      citedSop, clean(b.sop_label, 200), followup, escDays,
      addDays(occurred, escDays), (u && u.home_city) || null];

    var rec;
    if (existing) {
      rec = (await pool.query(
        'UPDATE employee_records SET level=$2, category=$3, occurred_on=$4, body=$5, corrective_action=$6, ' +
        'consequence=$7, sop_id=$8, sop_label=$9, followup_on=$10, escalation_days=$11, counts_until=$12, ' +
        'policy_document_id=$13, ' +
        "status='draft', updated_at=NOW() WHERE id=$1 RETURNING *",
        [existing.id, level, fields[3], occurred, body, corrective, consequence, fields[8], fields[9], followup, escDays, fields[12], citedDoc]
      )).rows[0];
      await logEvent(rec.id, 'draft_saved', req.user);
    } else {
      rec = (await pool.query(
        'INSERT INTO employee_records (user_id, type, level, category, occurred_on, body, corrective_action, ' +
        'consequence, sop_id, sop_label, followup_on, escalation_days, counts_until, city_code, status, ' +
        'visible_to_employee, created_by, created_by_name, policy_document_id) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15,$16,$17,$18) RETURNING *",
        fields.concat([b.visible_to_employee !== false, req.user.id, req.user.name, citedDoc])
      )).rows[0];
      await logEvent(rec.id, 'created', req.user, null, { level: level });
    }
    res.json({ success: true, id: rec.id, record: Object.assign({ level_label: levelLabel(rec.level) }, rec) });
  } catch (e) {
    console.error('[employee-records] disciplinary save failed:', e);
    res.status(500).json({ error: 'Could not save the notice.' });
  }
});

// Submit a draft for approval. This is where the wording check becomes a gate:
// a red flag stops the notice here. Ambers are recorded and waved through.
router.post('/disciplinary/:id/submit', requireAuth, requirePermission('create_disciplinary'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec || rec.type !== 'disciplinary') return res.status(404).json({ error: 'Not found.' });
    if (rec.status !== 'draft' && rec.status !== 'returned') {
      return res.status(409).json({ error: 'This notice has already been submitted.' });
    }
    if (rec.created_by !== req.user.id && !isAdminLike(req.user)) {
      return res.status(403).json({ error: 'This draft belongs to someone else.' });
    }
    if (!rec.body || !rec.corrective_action || !rec.consequence) {
      return res.status(400).json({ error: 'The incident, what must change and the consequence are all required.' });
    }
    if (!rec.followup_on) return res.status(400).json({ error: 'Set a follow-up date.' });

    var u = await userRow(rec.user_id);
    if (!u) return res.status(404).json({ error: 'Employee not found.' });
    if (!u.email) {
      return res.status(400).json({ error: u.name + ' has no email address on file, so the signature request cannot be sent. Add one under Settings > Users first.' });
    }

    var approverId = parseInt((req.body || {}).approver_id, 10) || u.supervisor_id || null;
    if (!approverId) return res.status(400).json({ error: 'Pick an approver.' });
    if (approverId === req.user.id) return res.status(400).json({ error: 'Somebody else has to approve it.' });
    var approver = await userRow(approverId);
    if (!approver || approver.active === false) return res.status(400).json({ error: 'That approver is not available.' });

    var check = await recordCheck.checkRecord(
      { body: rec.body, corrective_action: rec.corrective_action, consequence: rec.consequence },
      { levelLabel: levelLabel(rec.level), category: rec.category }
    );
    if (check.available && check.reds > 0 && (req.body || {}).override_reds !== true) {
      return res.status(422).json({ error: 'The wording check found ' + check.reds + ' red flag' + (check.reds === 1 ? '' : 's') + ' that must be cleared first.', check: check });
    }

    await pool.query(
      "UPDATE employee_records SET status='pending_approval', submitted_at=NOW(), approver_id=$2, approver_name=$3, " +
      'ai_check=$4, returned_at=NULL, approver_note=NULL, updated_at=NOW() WHERE id=$1',
      [rec.id, approver.id, approver.name, JSON.stringify(check)]
    );
    await logEvent(rec.id, 'submitted', req.user, clean((req.body || {}).note, 2000), { approver: approver.name, reds: check.reds, ambers: check.ambers });
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'submitted_for_approval',
      user_id: req.user.id, user_name: req.user.name,
      details: { employee: u.name, level: levelLabel(rec.level), approver: approver.name }
    });

    await tellEmployee(
      approver,
      'A disciplinary notice needs your approval',
      '<p>' + escapeHtml(req.user.name) + ' has submitted a ' + escapeHtml(levelLabel(rec.level)) +
      ' for ' + escapeHtml(u.name) + ' and needs your approval before it can be sent.</p>' +
      '<p><a href="' + appUrl('/?view=employee-files') + '">Review it in Nova</a></p>',
      'Nova: ' + req.user.name + ' needs your approval on a disciplinary notice.'
    );
    res.json({ success: true, check: check });
  } catch (e) {
    console.error('[employee-records] submit failed:', e);
    res.status(500).json({ error: 'Could not submit the notice.' });
  }
});

// What is waiting on ME to approve.
router.get('/approvals', requireAuth, requirePermission('approve_discipline'), async (req, res) => {
  try {
    var sql = "SELECT r.*, u.name AS employee_name, u.home_city FROM employee_records r " +
      'JOIN users u ON u.id = r.user_id ' +
      "WHERE r.status = 'pending_approval' ";
    var params = [];
    if (!isAdminLike(req.user)) { sql += 'AND r.approver_id = $1 '; params.push(req.user.id); }
    sql += 'ORDER BY r.submitted_at ASC';
    const rows = (await pool.query(sql, params)).rows;
    var attach = await attachmentsByRecord(rows.map(function (r) { return r.id; }));
    res.json(rows.map(function (r) {
      return Object.assign({ level_label: levelLabel(r.level), attachments: attach[r.id] || [] }, r);
    }));
  } catch (e) {
    console.error('[employee-records] approvals failed:', e);
    res.status(500).json({ error: 'Could not load approvals.' });
  }
});

// Approve, which also sends. The approver cannot edit the notice - if it is
// wrong it goes back to the person who wrote it, with everything they typed
// still in place.
router.post('/disciplinary/:id/approve', requireAuth, requirePermission('approve_discipline'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec || rec.type !== 'disciplinary') return res.status(404).json({ error: 'Not found.' });
    if (rec.status !== 'pending_approval') return res.status(409).json({ error: 'This notice is not waiting for approval.' });
    if (rec.approver_id !== req.user.id && !isAdminLike(req.user)) {
      return res.status(403).json({ error: 'This one is not yours to approve.' });
    }
    if (rec.created_by === req.user.id) return res.status(403).json({ error: 'You cannot approve your own notice.' });

    var u = await userRow(rec.user_id);
    await pool.query(
      "UPDATE employee_records SET status='sent', approved_at=NOW(), sent_at=NOW(), " +
      "expires_at = NOW() + ($3 || ' days')::interval, visible_to_employee=true, " +
      'approver_id=$2, approver_name=$4, approver_note=$5, updated_at=NOW() WHERE id=$1',
      [rec.id, req.user.id, String(SIGN_WINDOW_DAYS), req.user.name, clean((req.body || {}).note, 2000)]
    );
    await logEvent(rec.id, 'approved', req.user, clean((req.body || {}).note, 2000));
    await logEvent(rec.id, 'sent', req.user, null, { to: u && u.email });
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'approved_and_sent',
      user_id: req.user.id, user_name: req.user.name,
      details: { employee: u && u.name, level: levelLabel(rec.level) }
    });

    await tellEmployee(
      u,
      'A notice in your file needs your signature',
      '<p>A ' + escapeHtml(levelLabel(rec.level)) + ' has been issued and is waiting for your signature in Nova.</p>' +
      '<p>Signing confirms you have read it. It does not mean you agree with it, and you can attach a written ' +
      'response of your own.</p>' +
      '<p><a href="' + appUrl('/?view=my-file') + '">Open your file in Nova</a></p>',
      'Nova: a notice in your file needs your signature.'
    );

    var author = await userRow(rec.created_by);
    if (author) {
      await tellEmployee(author, 'Your notice was approved',
        '<p>' + escapeHtml(req.user.name) + ' approved the ' + escapeHtml(levelLabel(rec.level)) +
        ' for ' + escapeHtml((u && u.name) || '') + '. It has been sent for signature.</p>', null);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[employee-records] approve failed:', e);
    res.status(500).json({ error: 'Could not approve the notice.' });
  }
});

router.post('/disciplinary/:id/return', requireAuth, requirePermission('approve_discipline'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec || rec.type !== 'disciplinary') return res.status(404).json({ error: 'Not found.' });
    if (rec.status !== 'pending_approval') return res.status(409).json({ error: 'This notice is not waiting for approval.' });
    if (rec.approver_id !== req.user.id && !isAdminLike(req.user)) {
      return res.status(403).json({ error: 'This one is not yours to approve.' });
    }
    var note = clean((req.body || {}).note, 2000);
    if (!note) return res.status(400).json({ error: 'Say what needs changing.' });
    await pool.query(
      "UPDATE employee_records SET status='returned', returned_at=NOW(), approver_note=$2, updated_at=NOW() WHERE id=$1",
      [rec.id, note]
    );
    await logEvent(rec.id, 'returned', req.user, note);
    var author = await userRow(rec.created_by);
    var u = await userRow(rec.user_id);
    if (author) {
      await tellEmployee(author, 'Your notice was sent back',
        '<p>' + escapeHtml(req.user.name) + ' sent back the ' + escapeHtml(levelLabel(rec.level)) +
        ' for ' + escapeHtml((u && u.name) || '') + '.</p><p style="white-space:pre-wrap">' + escapeHtml(note) + '</p>' +
        '<p>Everything you wrote is still there.</p>', null);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[employee-records] return failed:', e);
    res.status(500).json({ error: 'Could not send it back.' });
  }
});

// Resend or extend a signature request that is sitting unsigned.
router.post('/disciplinary/:id/resend', requireAuth, requirePermission('create_disciplinary'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec || rec.status !== 'sent') return res.status(409).json({ error: 'Nothing to resend.' });
    var guard = await canActOn(req.user, rec.user_id);
    if (!guard.ok) return res.status(403).json({ error: guard.why });
    var u = await userRow(rec.user_id);
    var extend = (req.body || {}).extend === true;
    if (extend) {
      await pool.query("UPDATE employee_records SET expires_at = NOW() + ($2 || ' days')::interval, updated_at=NOW() WHERE id=$1",
        [rec.id, String(SIGN_WINDOW_DAYS)]);
      await logEvent(rec.id, 'extended', req.user, null, { days: SIGN_WINDOW_DAYS });
    }
    await pool.query('UPDATE employee_records SET reminded_at=NOW(), reminder_count=reminder_count+1 WHERE id=$1', [rec.id]);
    await logEvent(rec.id, 'reminded', req.user);
    await tellEmployee(u, 'Reminder: a notice needs your signature',
      '<p>A ' + escapeHtml(levelLabel(rec.level)) + ' in your file is still waiting for your signature.</p>' +
      '<p><a href="' + appUrl('/?view=my-file') + '">Open your file in Nova</a></p>',
      'Nova: a notice in your file is still waiting for your signature.');
    res.json({ success: true });
  } catch (e) {
    console.error('[employee-records] resend failed:', e);
    res.status(500).json({ error: 'Could not resend.' });
  }
});

// Record that the employee will not sign.
//
// There is no witness field and that is deliberate: one person administers a
// notice here, so a witness line would be theatre. What replaces it is the
// delivery trail already on the row - approved, emailed, opened, reminded,
// expiring - which is stronger evidence than a colleague's signature because
// the system recorded it rather than a person attesting to it.
router.post('/disciplinary/:id/refuse', requireAuth, requirePermission('create_disciplinary'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec || rec.type !== 'disciplinary') return res.status(404).json({ error: 'Not found.' });
    if (['sent', 'expired'].indexOf(rec.status) === -1) return res.status(409).json({ error: 'This notice is not out for signature.' });
    var guard = await canActOn(req.user, rec.user_id);
    if (!guard.ok) return res.status(403).json({ error: guard.why });
    var kind = clean((req.body || {}).kind, 40);
    if (['declined_in_request', 'told_me_directly', 'no_response'].indexOf(kind) === -1) {
      return res.status(400).json({ error: 'Say what happened.' });
    }
    await pool.query(
      "UPDATE employee_records SET status='refused', refused_at=NOW(), refusal_kind=$2, refusal_note=$3, " +
      'refusal_by=$4, refusal_by_name=$5, updated_at=NOW() WHERE id=$1',
      [rec.id, kind, clean((req.body || {}).note, 4000), req.user.id, req.user.name]
    );
    await logEvent(rec.id, 'refused', req.user, clean((req.body || {}).note, 4000), { kind: kind });
    var u = await userRow(rec.user_id);
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'refusal_recorded',
      user_id: req.user.id, user_name: req.user.name,
      details: { employee: u && u.name, kind: kind, level: levelLabel(rec.level) }
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[employee-records] refuse failed:', e);
    res.status(500).json({ error: 'Could not record the refusal.' });
  }
});

// ---------------------------------------------------------------- follow-up

router.post('/:id/followup', requireAuth, requirePermission('create_disciplinary'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found.' });
    var guard = await canActOn(req.user, rec.user_id);
    if (!guard.ok) return res.status(403).json({ error: guard.why });
    var b = req.body || {};
    var outcome = clean(b.outcome, 24);
    if (['corrected', 'not_corrected', 'extended'].indexOf(outcome) === -1) {
      return res.status(400).json({ error: 'Pick an outcome.' });
    }
    var note = clean(b.note, 4000);
    if (!note) return res.status(400).json({ error: 'Write a short note on what happened.' });
    var u = await userRow(rec.user_id);

    if (outcome === 'extended') {
      var next = cleanDate(b.followup_on);
      if (!next) return res.status(400).json({ error: 'Pick the new follow-up date.' });
      await pool.query('UPDATE employee_records SET followup_on=$2, followup_note=$3, followup_nagged_at=NULL, updated_at=NOW() WHERE id=$1',
        [rec.id, next, note]);
      await logEvent(rec.id, 'followup_extended', req.user, note, { to: next });
      return res.json({ success: true, extended_to: next });
    }

    await pool.query(
      'UPDATE employee_records SET followup_outcome=$2::varchar, followup_note=$3, followup_done_at=NOW(), ' +
      "status = CASE WHEN $2::text = 'corrected' THEN 'closed'::varchar ELSE status END, updated_at=NOW() WHERE id=$1",
      [rec.id, outcome, note]
    );
    await logEvent(rec.id, 'followup_' + outcome, req.user, note);
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'followup_' + outcome,
      user_id: req.user.id, user_name: req.user.name, details: { employee: u && u.name }
    });

    if (outcome === 'corrected' && b.tell_employee !== false && u) {
      await tellEmployee(u, 'Follow-up closed out',
        '<p>Your manager has closed out the follow-up on a notice in your file and recorded it as corrected.</p>' +
        '<p style="white-space:pre-wrap">' + escapeHtml(note) + '</p>', null);
    }
    res.json({ success: true, next_level: outcome === 'not_corrected' ? Math.min((rec.level || 0) + 1, 5) : null });
  } catch (e) {
    console.error('[employee-records] followup failed:', e);
    res.status(500).json({ error: 'Could not record the follow-up.' });
  }
});

// What Nova has seen either side of a notice. Evidence, not a verdict - the
// front end says so on the page, and it matters that it does.
router.get('/:id/signals', requireAuth, requirePermission('view_employee_records'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found.' });
    if (!(await inScope(req.user, rec.user_id))) {
      return res.status(403).json({ error: 'Not permitted.' });
    }
    var since = rec.sent_at || rec.approved_at || rec.created_at;
    var out = { since: since, before_days: 30, signals: [] };

    // Records on their file since the notice. Always available, no other module
    // required, so this panel is never empty.
    const after = await pool.query(
      "SELECT type, COUNT(*)::int AS n FROM employee_records WHERE user_id=$1 AND created_at > $2 AND id <> $3 AND status NOT IN ('draft','void') GROUP BY type",
      [rec.user_id, since, rec.id]
    );
    var amap = {};
    after.rows.forEach(function (r) { amap[r.type] = r.n; });
    out.signals.push({ label: 'Recognition on their file', since: amap.recognition || 0, before: null, good: true });
    out.signals.push({ label: 'Further notices on their file', since: (amap.disciplinary || 0) + (amap.coaching || 0), before: null, good: false });

    // Late clock-ins, when the time clock module has the columns for it. Wrapped
    // because a missing table must never take the page down.
    try {
      const late = await pool.query(
        'SELECT ' +
        '  COUNT(*) FILTER (WHERE clock_in_at > $2)::int AS since_n,' +
        "  COUNT(*) FILTER (WHERE clock_in_at > $2::timestamptz - INTERVAL '30 days' AND clock_in_at <= $2)::int AS before_n " +
        'FROM time_entries WHERE user_id = $1 AND COALESCE(late_minutes, 0) > 0',
        [rec.user_id, since]
      );
      if (late.rows.length) {
        out.signals.push({ label: 'Late clock-ins', since: late.rows[0].since_n, before: late.rows[0].before_n, good: false });
      }
    } catch (e) { /* module shape differs - skip the row rather than the page */ }

    try {
      const dl = await pool.query(
        'SELECT ' +
        '  COUNT(*) FILTER (WHERE deposit_date > $2::date)::int AS since_n,' +
        "  COUNT(*) FILTER (WHERE deposit_date > $2::date - 30 AND deposit_date <= $2::date)::int AS before_n " +
        'FROM deposits WHERE user_id = $1 AND is_late = true',
        [rec.user_id, since]
      );
      if (dl.rows.length) {
        out.signals.push({ label: 'Late deposits', since: dl.rows[0].since_n, before: dl.rows[0].before_n, good: false });
      }
    } catch (e) { /* deposits migration not landed - skip the row, not the page */ }

    try {
      const fb = await pool.query(
        'SELECT ' +
        '  COUNT(*) FILTER (WHERE created_at > $2)::int AS since_n,' +
        "  COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '30 days' AND created_at <= $2)::int AS before_n " +
        'FROM customer_feedback WHERE tech_user_id = $1',
        [rec.user_id, since]
      );
      if (fb.rows.length) {
        out.signals.push({ label: 'Customer feedback records', since: fb.rows[0].since_n, before: fb.rows[0].before_n, good: false });
      }
    } catch (e) { /* same */ }

    res.json(out);
  } catch (e) {
    console.error('[employee-records] signals failed:', e);
    res.status(500).json({ error: 'Could not load the signals.' });
  }
});

// ---------------------------------------------------------------- record admin

router.get('/:id/events', requireAuth, requirePermission('view_employee_records'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found.' });
    if (!(await inScope(req.user, rec.user_id))) {
      return res.status(403).json({ error: 'Not permitted.' });
    }
    // Opening a disciplinary record is itself an event worth keeping. Who has
    // been reading somebody's file is a fair question to be able to answer.
    if (rowIsDisciplinary(rec)) {
      await logAudit({
        entity_type: 'employee_record', entity_id: rec.id, action: 'viewed',
        user_id: req.user.id, user_name: req.user.name, details: { level: levelLabel(rec.level) }
      });
    }
    const rows = (await pool.query(
      'SELECT id, action, note, details, user_name, created_at FROM employee_record_events WHERE record_id=$1 ORDER BY id ASC',
      [rec.id]
    )).rows;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not load the history.' });
  }
});

// Change who can see a record after the fact. Kept narrow on purpose: this is
// the only way an issued record changes at all, and every use is logged.
router.put('/:id/visibility', requireAuth, requirePermission('create_employee_note'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found.' });
    var guard = await canActOn(req.user, rec.user_id);
    if (!guard.ok) return res.status(403).json({ error: guard.why });
    if (rec.type === 'disciplinary' && ['sent', 'signed', 'refused'].indexOf(rec.status) !== -1) {
      return res.status(409).json({ error: 'A notice that has been sent stays visible to the employee.' });
    }
    var visible = (req.body || {}).visible_to_employee === true;
    var wins = rec.type === 'recognition' && visible && (req.body || {}).show_in_wins === true;
    await pool.query('UPDATE employee_records SET visible_to_employee=$2, show_in_wins=$3, updated_at=NOW() WHERE id=$1',
      [rec.id, visible, wins]);
    await logEvent(rec.id, 'visibility_changed', req.user, null, { visible: visible, wins: wins });
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'visibility_changed',
      user_id: req.user.id, user_name: req.user.name, details: { visible_to_employee: visible, show_in_wins: wins }
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not change visibility.' });
  }
});

// Void a record. An issued notice is never edited and never quietly deleted -
// it is voided with a reason, and it stays on the file marked void so the gap
// in the history is visible rather than invisible.
router.post('/:id/void', requireAuth, requirePermission('manage_employee_records'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found.' });
    var reason = clean((req.body || {}).reason, 2000);
    if (!reason) return res.status(400).json({ error: 'Voiding a record needs a reason.' });
    await pool.query("UPDATE employee_records SET status='void', voided_at=NOW(), void_reason=$2, show_in_wins=false, updated_at=NOW() WHERE id=$1",
      [rec.id, reason]);
    await logEvent(rec.id, 'voided', req.user, reason);
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'voided',
      user_id: req.user.id, user_name: req.user.name, details: { reason: reason }
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not void the record.' });
  }
});

// A draft was never issued, so it can simply go.
router.delete('/:id', requireAuth, requirePermission('create_disciplinary'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec) return res.json({ success: true });
    if (rec.status !== 'draft' && rec.status !== 'returned') {
      return res.status(409).json({ error: 'Only a draft can be deleted. Void it instead.' });
    }
    if (rec.created_by !== req.user.id && !isAdminLike(req.user)) {
      return res.status(403).json({ error: 'That draft belongs to someone else.' });
    }
    await pool.query('DELETE FROM employee_records WHERE id=$1', [rec.id]);
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'draft_deleted',
      user_id: req.user.id, user_name: req.user.name, details: {}
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete the draft.' });
  }
});

// The late-deposit history behind the count, plus the sentence that would go on
// a record. The UI calls this when a manager presses "Document these", so the
// dates come from the database rather than from anybody's memory.
router.get('/employee/:id/late-deposits', requireAuth, requirePermission('view_employee_records'), async (req, res) => {
  try {
    var target = parseInt(req.params.id, 10) || 0;
    if (!(await inScope(req.user, target))) {
      return res.status(403).json({ error: 'Not permitted.' });
    }
    var u = await userRow(target);
    if (!u) return res.status(404).json({ error: 'Not found.' });
    var months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 60);
    var late = await lateDeposits(target, months);
    res.json({ user: { id: u.id, name: u.name }, late: late, suggested_text: lateDepositText(u.name, late) });
  } catch (e) {
    console.error('[employee-records] late deposits failed:', e);
    res.status(500).json({ error: 'Could not load the late deposits.' });
  }
});

// The unaccounted shortages behind the count, plus the sentence that would go
// on a record. Same shape and the same scoping as the late-deposit drill-down.
router.get('/employee/:id/shortages', requireAuth, requirePermission('view_employee_records'), async (req, res) => {
  try {
    var target = parseInt(req.params.id, 10) || 0;
    if (!(await inScope(req.user, target))) {
      return res.status(403).json({ error: 'Not permitted.' });
    }
    var u = await userRow(target);
    if (!u) return res.status(404).json({ error: 'Not found.' });
    var months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 60);
    var sh = await unaccountedShortages(target, months);
    res.json({ user: { id: u.id, name: u.name }, shortages: sh, suggested_text: shortageText(sh) });
  } catch (e) {
    console.error('[employee-records] shortages failed:', e);
    res.status(500).json({ error: 'Could not load the shortages.' });
  }
});

// ---------------------------------------------------------------- attachments

// Three calls to add a file, matching routes/ap.js and routes/onboarding.js:
// presign, the browser PUTs the bytes straight to R2, then confirm. The server
// never handles the bytes, so a 40MB photo does not have to fit through
// express.json and does not sit in this process's memory.
//
// Read access is decided by canReadAttachments(), which is the ONLY gate in
// this section. A manager reaches these through scope; the employee reaches
// their own once the record is shared with them.

router.post('/:id/attachments/upload-url', requireAuth, requirePermission('create_employee_note'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found.' });
    var guard = await canWriteAttachments(req, rec);
    if (!guard.ok) return res.status(403).json({ error: guard.why });
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet.' });

    var b = req.body || {};
    var fname = clean(b.filename, 255) || 'attachment';
    var ctype = clean(b.content_type, 120) || 'application/octet-stream';
    var size = parseInt(b.size_bytes, 10) || 0;
    if (size > MAX_ATTACH_BYTES) {
      return res.status(413).json({
        error: 'That file is larger than ' + Math.round(MAX_ATTACH_BYTES / 1048576) + 'MB. Attach a smaller copy.'
      });
    }
    var key = attachKey(rec.id, fname);
    var url = await r2.presignUpload(key, ctype);
    res.json({ success: true, url: url, key: key, filename: fname, content_type: ctype });
  } catch (e) {
    console.error('[employee-records] attachment presign failed:', e);
    res.status(500).json({ error: 'Could not start the upload.' });
  }
});

router.post('/:id/attachments/confirm', requireAuth, requirePermission('create_employee_note'), async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found.' });
    var guard = await canWriteAttachments(req, rec);
    if (!guard.ok) return res.status(403).json({ error: guard.why });

    var b = req.body || {};
    var key = clean(b.key, 500);
    // The key must be one WE handed out, for THIS record. A client that names
    // its own key could point a row at another employee's evidence and this
    // route would file the pointer without ever reading the object.
    if (!key || key.indexOf(ATTACH_PREFIX + rec.id + '/') !== 0) {
      return res.status(400).json({ error: 'Bad upload key.' });
    }

    // Trust the object, not the browser, for the size - and check the PUT
    // actually landed, so a failed upload leaves no row pointing at nothing.
    // headObject() returns null only when the object is definitely absent and
    // rethrows anything else; a transient R2 error must not lose the manager's
    // file, so that case falls through to the size the browser reported.
    var size = parseInt(b.size_bytes, 10) || null;
    try {
      var head = await r2.headObject(key);
      if (!head) return res.status(400).json({ error: 'That upload did not arrive. Try it again.' });
      size = head.size || size;
    } catch (e) {
      console.error('[employee-records] attachment head failed:', e.message);
    }

    const ins = await pool.query(
      'INSERT INTO employee_record_attachments (record_id, r2_key, filename, content_type, size_bytes, uploaded_by, uploaded_by_name) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [rec.id, key, clean(b.filename, 255), clean(b.content_type, 120), size, req.user.id, req.user.name]
    );
    var row = ins.rows[0];
    await logEvent(rec.id, 'attachment_added', req.user, clean(b.filename, 255), { filename: row.filename, bytes: size });
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'attachment_added',
      user_id: req.user.id, user_name: req.user.name,
      details: { filename: row.filename, bytes: size }
    });
    res.json({ success: true, attachment: attachView(row) });
  } catch (e) {
    console.error('[employee-records] attachment confirm failed:', e);
    res.status(500).json({ error: 'Could not save the attachment.' });
  }
});

// The list for one record. Used by the disciplinary form, which is looking at a
// draft that no other endpoint returns yet.
router.get('/:id/attachments', requireAuth, async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec || !(await canReadAttachments(req, rec))) return res.status(404).json({ error: 'Not found.' });
    const rows = (await pool.query(
      'SELECT * FROM employee_record_attachments WHERE record_id = $1 ORDER BY id', [rec.id]
    )).rows;
    res.json({ attachments: rows.map(attachView) });
  } catch (e) {
    console.error('[employee-records] attachment list failed:', e);
    res.status(500).json({ error: 'Could not load the documents.' });
  }
});

// A short-lived presigned GET. No permission middleware on purpose: the gate is
// canReadAttachments(), because the employee has no record permission at all and
// still has to be able to open the evidence attached to their own notice.
router.get('/attachments/:aid/download', requireAuth, async (req, res) => {
  try {
    const a = (await pool.query(
      'SELECT * FROM employee_record_attachments WHERE id = $1', [parseInt(req.params.aid, 10) || 0]
    )).rows[0];
    if (!a) return res.status(404).json({ error: 'Not found.' });
    var rec = await loadRecord(a.record_id);
    if (!(await canReadAttachments(req, rec))) return res.status(404).json({ error: 'Not found.' });
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet.' });
    var url = await r2.presignDownload(a.r2_key, a.filename || 'attachment', true, 300, a.content_type || undefined);
    res.json({ success: true, url: url });
  } catch (e) {
    console.error('[employee-records] attachment download failed:', e);
    res.status(500).json({ error: 'Could not open that document.' });
  }
});

// Removing one. The row goes, then the object; an orphaned object in R2 is
// harmless where a row pointing at a deleted object is a broken link on
// somebody's file. Logged either way - what was attached to a notice and when
// it stopped being attached is exactly the kind of thing that gets asked about
// a year later.
router.delete('/attachments/:aid', requireAuth, requirePermission('create_employee_note'), async (req, res) => {
  try {
    const a = (await pool.query(
      'SELECT * FROM employee_record_attachments WHERE id = $1', [parseInt(req.params.aid, 10) || 0]
    )).rows[0];
    if (!a) return res.status(404).json({ error: 'Not found.' });
    var rec = await loadRecord(a.record_id);
    if (!rec) return res.status(404).json({ error: 'Not found.' });
    var guard = await canWriteAttachments(req, rec);
    if (!guard.ok) return res.status(403).json({ error: guard.why });

    await pool.query('DELETE FROM employee_record_attachments WHERE id = $1', [a.id]);
    try { if (r2.configured()) await r2.deleteObject(a.r2_key); } catch (e) { /* orphan object is harmless */ }
    await logEvent(rec.id, 'attachment_removed', req.user, a.filename || null, { filename: a.filename });
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'attachment_removed',
      user_id: req.user.id, user_name: req.user.name, details: { filename: a.filename }
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[employee-records] attachment delete failed:', e);
    res.status(500).json({ error: 'Could not remove that document.' });
  }
});

// ---------------------------------------------------------------- employee side

// The employee's own view. No permission gate - this is their own file, the
// same way My Documents works. Returns ONLY records marked visible, so an
// internal coaching note is not merely hidden in the UI, it never leaves the
// server.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const rows = (await pool.query(
      "SELECT * FROM employee_records WHERE user_id=$1 AND visible_to_employee=true AND status NOT IN ('draft','pending_approval','returned','void') " +
      'ORDER BY COALESCE(occurred_on, created_at::date) DESC, id DESC',
      [req.user.id]
    )).rows;
    // Opening the file is what marks a sent notice as seen. That timestamp is
    // half the delivery trail, so it is written here and nowhere else.
    var unseen = rows.filter(function (r) { return r.status === 'sent' && !r.opened_at; });
    if (unseen.length) {
      await pool.query('UPDATE employee_records SET opened_at=NOW() WHERE id = ANY($1::int[])',
        [unseen.map(function (r) { return r.id; })]);
      for (var i = 0; i < unseen.length; i++) await logEvent(unseen[i].id, 'opened', req.user);
    }
    var attach = await attachmentsByRecord(rows.map(function (r) { return r.id; }));
    res.json({ records: rows.map(function (r) { return employeeView(r, attach[r.id] || []); }) });
  } catch (e) {
    console.error('[employee-records] me failed:', e);
    res.status(500).json({ error: 'Could not load your file.' });
  }
});

// Sign. In-app rather than a public tokenised link: everybody here has a Nova
// login, so the signature is tied to an authenticated session instead of to
// whoever happens to have the URL, and the notice never has to leave the app.
router.post('/me/:id/sign', requireAuth, async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec || rec.user_id !== req.user.id) return res.status(404).json({ error: 'Not found.' });
    if (rec.status !== 'sent') return res.status(409).json({ error: 'This notice is not waiting for a signature.' });
    var b = req.body || {};
    var typed = clean(b.typed_name, 160);
    var drawn = clean(b.signature_data, 400000);
    if (!typed && !drawn) return res.status(400).json({ error: 'Sign your name.' });
    var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
    await pool.query(
      "UPDATE employee_records SET status='signed', signed_at=NOW(), signature_name=$2, signature_data=$3, signature_ip=$4, updated_at=NOW() WHERE id=$1",
      [rec.id, typed || req.user.name, drawn, ip]
    );
    await logEvent(rec.id, 'signed', req.user, null, { ip: ip, typed: !!typed, drawn: !!drawn });
    await logAudit({
      entity_type: 'employee_record', entity_id: rec.id, action: 'signed',
      user_id: req.user.id, user_name: req.user.name, ip: ip, details: { level: levelLabel(rec.level) }
    });
    var author = await userRow(rec.created_by);
    if (author) {
      await tellEmployee(author, req.user.name + ' signed the notice',
        '<p>' + escapeHtml(req.user.name) + ' has signed the ' + escapeHtml(levelLabel(rec.level)) + '.</p>', null);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[employee-records] sign failed:', e);
    res.status(500).json({ error: 'Could not record your signature.' });
  }
});

// Acknowledge a record that needs no signature.
router.post('/me/:id/acknowledge', requireAuth, async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec || rec.user_id !== req.user.id || !rec.visible_to_employee) return res.status(404).json({ error: 'Not found.' });
    await pool.query('UPDATE employee_records SET acknowledged_at=NOW(), updated_at=NOW() WHERE id=$1 AND acknowledged_at IS NULL', [rec.id]);
    await logEvent(rec.id, 'acknowledged', req.user);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not acknowledge.' });
  }
});

// The employee's written response. Append-only, and it can never be edited or
// removed by anyone once written - that is the entire point of it. It is the
// cheapest protection in the module for both sides.
router.post('/me/:id/response', requireAuth, async (req, res) => {
  try {
    var rec = await loadRecord(req.params.id);
    if (!rec || rec.user_id !== req.user.id || !rec.visible_to_employee) return res.status(404).json({ error: 'Not found.' });
    if (rec.employee_response) return res.status(409).json({ error: 'You have already attached a response to this notice.' });
    var text = clean((req.body || {}).text, 8000);
    if (!text) return res.status(400).json({ error: 'Write your response first.' });
    await pool.query('UPDATE employee_records SET employee_response=$2, employee_response_at=NOW(), updated_at=NOW() WHERE id=$1', [rec.id, text]);
    await logEvent(rec.id, 'employee_response', req.user);
    var author = await userRow(rec.created_by);
    if (author) {
      await tellEmployee(author, req.user.name + ' attached a response',
        '<p>' + escapeHtml(req.user.name) + ' has attached a written response to a notice in their file.</p>' +
        '<p style="white-space:pre-wrap">' + escapeHtml(text) + '</p>', null);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not attach your response.' });
  }
});

// ---------------------------------------------------------------- recent wins

// The Home screen card. City-scoped, three of them, NO DATES - Tony's call, so
// a quiet week never reads as a stale card.
//
// Note what is not here: no counts, no per-person totals, no "most recognised"
// ranking. Recognition is the only record type this endpoint can see at all,
// and it returns rows rather than numbers, because a number derived from this
// table is one join away from telling everybody who got written up.
router.get('/wins', requireAuth, async (req, res) => {
  try {
    var limit = Math.min(parseInt(req.query.limit, 10) || 3, 10);
    var city = null;
    const me = await userRow(req.user.id);
    city = me && me.home_city ? String(me.home_city).trim().toUpperCase() : null;

    var sql =
      'SELECT r.id, r.body, r.category, r.user_id, u.name AS employee_name ' +
      'FROM employee_records r JOIN users u ON u.id = r.user_id ' +
      "WHERE r.show_in_wins = true AND r.type = 'recognition' AND r.status = 'active' " +
      'AND u.active IS NOT FALSE ';
    var params = [];
    if (city) { sql += 'AND UPPER(TRIM(COALESCE(u.home_city, r.city_code, $1))) = $1 '; params.push(city); }
    sql += 'ORDER BY r.created_at DESC LIMIT ' + limit;
    const rows = (await pool.query(sql, params)).rows;
    res.json({
      city: city,
      wins: rows.map(function (r) {
        return {
          id: r.id, name: r.employee_name, category: r.category, body: r.body,
          is_me: r.user_id === req.user.id
        };
      })
    });
  } catch (e) {
    console.error('[employee-records] wins failed:', e);
    res.json({ city: null, wins: [] });
  }
});

module.exports = router;
module.exports.SIGN_WINDOW_DAYS = SIGN_WINDOW_DAYS;
module.exports.REMIND_EVERY_DAYS = REMIND_EVERY_DAYS;
module.exports.levelLabel = levelLabel;
