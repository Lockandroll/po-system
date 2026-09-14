// The register. One dated row per thing we did on an account or a licence:
// "paid $340 on 2026-03-12 for the 2026 Birmingham occupational tax, ACH,
// confirmation 88213".
//
// Why this exists: Accounts held the LOGIN for a portal and nothing held the
// record of what we did once we were inside it. That record was living in
// somebody's memory, and the moment you want it is a year later when the same
// bill comes round and the only useful question is "what did we pay last time,
// and when".
//
// One table, two subjects. A ledger row hangs off EXACTLY ONE of an account
// (vendors) or a licence (licenses) -- the DB enforces that with the
// account_ledger_one_subject CHECK constraint in db.js, because a row that
// belongs to nothing is invisible forever.
//
// Permissions ride on the SUBJECT, never on the ledger itself. Reading an
// account's register needs whatever reading that account needs, writing to it
// needs manage_vendors; a licence's register answers to view_licenses /
// manage_licenses. That includes the per-account restricted_to allowlist: an
// account you are not allowed to see must not leak its payment history either.
//
// House style: string concatenation only, no template literals.
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// What a row IS. Money is optional on every one of them: filing a zero-dollar
// annual return is a thing that happened and is worth a line.
const KINDS = ['payment', 'filing', 'renewal', 'credit', 'refund', 'note'];
const METHODS = ['card', 'ach', 'check', 'cash', 'online', 'auto_draft', 'other'];

const SUBJECTS = {
  account: { table: 'vendors', column: 'account_id', view: ['manage_vendors', 'view_vendors'], manage: 'manage_vendors', label: 'account' },
  license: { table: 'licenses', column: 'license_id', view: ['manage_licenses', 'view_licenses'], manage: 'manage_licenses', label: 'licence' }
};

async function hasPerm(req, perm) {
  if (!req.user) return false;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (_) {}
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf(perm) !== -1;
  } catch (_) { return false; }
}

function str(v, max) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  return s ? s.slice(0, max || 255) : null;
}

function dateOnly(v) {
  var s = str(v, 30);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Money is stored as a number, never as whatever the box contained. Currency
// symbols, commas and stray spaces are stripped; anything left that is not a
// number becomes null rather than 0, because a blank amount and a zero amount
// mean different things on a register.
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(n)) return null;
  if (Math.abs(n) > 99999999) return null;
  return Math.round(n * 100) / 100;
}

function kindOf(v) {
  var s = String(v || '').trim().toLowerCase();
  return KINDS.indexOf(s) !== -1 ? s : 'payment';
}

function methodOf(v) {
  var s = String(v || '').trim().toLowerCase();
  return METHODS.indexOf(s) !== -1 ? s : null;
}

function ymd(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function rowOut(r) {
  var o = Object.assign({}, r);
  o.entry_date = ymd(r.entry_date);
  o.amount = (r.amount === null || r.amount === undefined) ? null : parseFloat(r.amount);
  return o;
}

// Can this caller see this particular subject, and may they write to it?
// Returns null when the subject does not exist or is out of bounds, so every
// caller can answer 404 without leaking which of the two it was.
async function resolveSubject(req, kind, id) {
  var spec = SUBJECTS[kind];
  if (!spec) return null;
  var sid = parseInt(id, 10);
  if (!Number.isInteger(sid) || sid <= 0) return null;

  var canView = false;
  for (var i = 0; i < spec.view.length; i++) {
    if (await hasPerm(req, spec.view[i])) { canView = true; break; }
  }
  if (!canView) return null;

  var r = await pool.query('SELECT id, name, restricted_to FROM ' + spec.table + ' WHERE id = $1', [sid]);
  if (!r.rows.length) return null;

  // The per-subject allowlist. Admins and owners always pass, exactly as they
  // do on the Accounts table itself; everyone else has to be named on it.
  var arr = Array.isArray(r.rows[0].restricted_to) ? r.rows[0].restricted_to : [];
  var isAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'owner');
  if (arr.length && !isAdmin && arr.indexOf(req.user.id) === -1) return null;

  return {
    spec: spec,
    id: sid,
    name: r.rows[0].name,
    canManage: await hasPerm(req, spec.manage)
  };
}

// Totals the screen shows above the rows. Computed here rather than in the
// browser so a filtered or paged view can never quietly change the total.
function totalsOf(rows) {
  var paid = 0, credited = 0, n = 0;
  for (var i = 0; i < rows.length; i++) {
    var a = rows[i].amount;
    if (a === null || a === undefined) continue;
    a = parseFloat(a);
    if (!isFinite(a)) continue;
    n++;
    if (rows[i].kind === 'credit' || rows[i].kind === 'refund') credited += a;
    else paid += a;
  }
  return {
    paid: Math.round(paid * 100) / 100,
    credited: Math.round(credited * 100) / 100,
    net: Math.round((paid - credited) * 100) / 100,
    with_amount: n
  };
}

// GET /api/ledger/account/12  |  GET /api/ledger/license/4
router.get('/:subject/:id', async function (req, res) {
  try {
    const subject = await resolveSubject(req, req.params.subject, req.params.id);
    if (!subject) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      'SELECT * FROM account_ledger_entries WHERE ' + subject.spec.column + ' = $1' +
      ' ORDER BY entry_date DESC, id DESC',
      [subject.id]
    );
    res.json({
      subject: { type: req.params.subject, id: subject.id, name: subject.name },
      entries: rows.map(rowOut),
      totals: totalsOf(rows),
      can_manage: subject.canManage,
      kinds: KINDS,
      methods: METHODS
    });
  } catch (err) {
    console.error('Ledger list error:', err);
    res.status(500).json({ error: 'Failed to load the ledger' });
  }
});

function entryFields(b) {
  return {
    entry_date: dateOnly(b.entry_date),
    kind: kindOf(b.kind),
    amount: money(b.amount),
    reason: str(b.reason, 255),
    method: methodOf(b.method),
    reference: str(b.reference, 120),
    period_label: str(b.period_label, 60),
    notes: str(b.notes, 8000)
  };
}

// POST /api/ledger/account/12  |  POST /api/ledger/license/4
router.post('/:subject/:id', async function (req, res) {
  try {
    const subject = await resolveSubject(req, req.params.subject, req.params.id);
    if (!subject) return res.status(404).json({ error: 'Not found' });
    if (!subject.canManage) return res.status(403).json({ error: 'Forbidden' });
    const f = entryFields(req.body || {});
    if (!f.entry_date) return res.status(400).json({ error: 'A date is required (YYYY-MM-DD).' });
    // A row with neither money nor a reason is not a record of anything.
    if (f.amount === null && !f.reason && !f.notes) {
      return res.status(400).json({ error: 'Add an amount, a reason, or a note.' });
    }
    const cols = ['entry_date', 'kind', 'amount', 'reason', 'method', 'reference',
      'period_label', 'notes', 'created_by', 'created_by_name', subject.spec.column];
    const vals = [f.entry_date, f.kind, f.amount, f.reason, f.method, f.reference,
      f.period_label, f.notes, req.user.id, req.user.name, subject.id];
    const marks = vals.map(function (_, i) { return '$' + (i + 1); });
    const { rows } = await pool.query(
      'INSERT INTO account_ledger_entries (' + cols.join(', ') + ') VALUES (' + marks.join(', ') + ') RETURNING *',
      vals
    );
    // This moves money, so it is audited (CLAUDE.md 9).
    logAudit({ entity_type: 'ledger', entity_id: rows[0].id, action: 'created',
      user_id: req.user.id, user_name: req.user.name,
      details: { subject: req.params.subject, subject_id: subject.id, subject_name: subject.name,
        kind: f.kind, amount: f.amount, reason: f.reason, entry_date: f.entry_date },
      ip: req.ip });
    res.status(201).json(rowOut(rows[0]));
  } catch (err) {
    console.error('Ledger create error:', err);
    res.status(500).json({ error: 'Failed to save the entry' });
  }
});

// Find the entry and re-check permission against whichever subject it hangs
// off, so an id guessed from another module cannot be edited.
async function loadEntry(req, entryId) {
  var id = parseInt(entryId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  var r = await pool.query('SELECT * FROM account_ledger_entries WHERE id = $1', [id]);
  if (!r.rows.length) return null;
  var row = r.rows[0];
  var kind = row.account_id ? 'account' : 'license';
  var subject = await resolveSubject(req, kind, row.account_id || row.license_id);
  if (!subject) return null;
  return { row: row, subject: subject };
}

router.put('/entry/:entryId', async function (req, res) {
  try {
    const found = await loadEntry(req, req.params.entryId);
    if (!found) return res.status(404).json({ error: 'Entry not found' });
    if (!found.subject.canManage) return res.status(403).json({ error: 'Forbidden' });
    const f = entryFields(req.body || {});
    if (!f.entry_date) return res.status(400).json({ error: 'A date is required (YYYY-MM-DD).' });
    if (f.amount === null && !f.reason && !f.notes) {
      return res.status(400).json({ error: 'Add an amount, a reason, or a note.' });
    }
    const { rows } = await pool.query(
      'UPDATE account_ledger_entries SET entry_date=$1, kind=$2, amount=$3, reason=$4, method=$5,' +
      ' reference=$6, period_label=$7, notes=$8, updated_at=NOW() WHERE id=$9 RETURNING *',
      [f.entry_date, f.kind, f.amount, f.reason, f.method, f.reference, f.period_label,
       f.notes, found.row.id]
    );
    logAudit({ entity_type: 'ledger', entity_id: found.row.id, action: 'updated',
      user_id: req.user.id, user_name: req.user.name,
      details: { subject_name: found.subject.name,
        was: { amount: found.row.amount === null ? null : parseFloat(found.row.amount),
               entry_date: ymd(found.row.entry_date), reason: found.row.reason },
        now: { amount: f.amount, entry_date: f.entry_date, reason: f.reason } },
      ip: req.ip });
    res.json(rowOut(rows[0]));
  } catch (err) {
    console.error('Ledger update error:', err);
    res.status(500).json({ error: 'Failed to update the entry' });
  }
});

router.delete('/entry/:entryId', async function (req, res) {
  try {
    const found = await loadEntry(req, req.params.entryId);
    if (!found) return res.status(404).json({ error: 'Entry not found' });
    if (!found.subject.canManage) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM account_ledger_entries WHERE id = $1', [found.row.id]);
    // The whole row goes into the audit detail. A deleted payment record is
    // exactly the thing somebody will need to reconstruct later.
    logAudit({ entity_type: 'ledger', entity_id: found.row.id, action: 'deleted',
      user_id: req.user.id, user_name: req.user.name,
      details: { subject_name: found.subject.name,
        entry: { entry_date: ymd(found.row.entry_date), kind: found.row.kind,
                 amount: found.row.amount === null ? null : parseFloat(found.row.amount),
                 reason: found.row.reason, method: found.row.method,
                 reference: found.row.reference, period_label: found.row.period_label } },
      ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error('Ledger delete error:', err);
    res.status(500).json({ error: 'Failed to delete the entry' });
  }
});

module.exports = router;
