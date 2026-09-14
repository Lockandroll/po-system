// Licensing & compliance: the things we have to hold, renew and pay for in
// order to keep operating in a territory -- business licences, city
// occupational tax registrations, sales-tax accounts, alarm and contractor
// licences, franchise registrations.
//
// Deliberately NOT part of routes/vendors.js. An account is somebody we buy
// from; a licence is permission to trade, granted by an authority, with a
// renewal date and a fee attached. Sharing the vendors table would mean a
// column set where half the columns are always null for one of the two -- which
// is exactly how the vendors table got the way it is.
//
// Shaped like Accounts on purpose: an authority, a number, a portal login and
// security questions, because renewing one of these means logging into a portal
// at 11pm the night before it lapses and being asked your mother's maiden name.
// What we actually DID once inside that portal is the ledger (routes/ledger.js).
//
// Ships dark behind view_licenses / manage_licenses (CLAUDE.md 1.5): on deploy
// only admin and owner can reach any of it.
//
// House style: string concatenation only, no template literals.
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

const KINDS = ['business_license', 'occupational_tax', 'sales_tax', 'contractor',
  'alarm', 'franchise', 'vehicle', 'insurance', 'other'];
const INTERVALS = ['annual', 'biennial', 'quarterly', 'monthly', 'none'];

// A certificate is "expiring" this far out. Same 60 days the COI screen uses,
// so the two compliance surfaces do not disagree about what counts as soon.
const EXPIRING_DAYS = 60;

// Shared with the browser editor. The server REJECTS past these rather than
// trimming: a silently shortened security answer is a WRONG answer, and you
// only find that out when the portal locks the account.
const SQ_MAX_ROWS = 25;
const SQ_MAX_LEN = 300;

async function hasPerm(req, perm) {
  if (!req.user) return false;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (_) {}
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf(perm) !== -1;
  } catch (_) { return false; }
}

async function canManage(req) { return hasPerm(req, 'manage_licenses'); }

async function requireView(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (await hasPerm(req, 'manage_licenses')) return next();
    if (await hasPerm(req, 'view_licenses')) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
}

async function requireManage(req, res, next) {
  try {
    if (await canManage(req)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
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

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// An unrecoverable secret gets the same undefined-guard the security answers
// get, and for the same reason. A key that is absent means "leave it alone";
// only an explicit null or empty string clears the stored password.
function passwordOf(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v);
}

function kindOf(v) {
  var s = String(v || '').trim().toLowerCase();
  return KINDS.indexOf(s) !== -1 ? s : 'other';
}

function intervalOf(v) {
  var s = String(v || '').trim().toLowerCase();
  return INTERVALS.indexOf(s) !== -1 ? s : 'annual';
}

// Same allowlist contract as vendors.restricted_to: a de-duped array of
// positive int IDs, or null for "everyone who can see the module".
function cleanRestrictedTo(v) {
  if (!Array.isArray(v)) return null;
  var ids = Array.from(new Set(v.map(function (x) { return parseInt(x, 10); })
    .filter(function (n) { return Number.isInteger(n) && n > 0; })));
  return ids.length ? ids : null;
}

// Same undefined-guard contract as routes/vendors.js, and for the same reason:
// answers are unrecoverable secrets, so a payload we cannot make sense of must
// never be read as "delete them all". Only an explicit empty list clears them.
//   undefined      -> leave the column alone
//   null / '' / [] -> a real answer: this licence has no security questions
//   anything else  -> ALSO leave the column alone
function cleanSecurityQuestions(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!Array.isArray(v)) return undefined;
  if (v.length > SQ_MAX_ROWS) {
    var e = new Error('A licence can hold at most ' + SQ_MAX_ROWS + ' security questions.');
    e.status = 400;
    throw e;
  }
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var row = v[i];
    if (!row || typeof row !== 'object') continue;
    var q = String(row.q == null ? '' : row.q).trim();
    var a = String(row.a == null ? '' : row.a).trim();
    if (q.length > SQ_MAX_LEN || a.length > SQ_MAX_LEN) {
      var e2 = new Error('Security questions and answers are limited to ' + SQ_MAX_LEN + ' characters.');
      e2.status = 400;
      throw e2;
    }
    if (!q && !a) continue;
    out.push({ q: q, a: a });
  }
  return out.length ? out : null;
}

function readSecurityQuestions(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { var p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; }
  }
  return [];
}

function ymd(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// One place decides what a licence's standing is, so the row pill, the banner
// count and anything that later wants to email about it can never disagree.
// Mirrors the shape utils/coi.js returns (key / label / tone / note).
function statusOf(row, today) {
  if (row.active === false) return { key: 'inactive', label: 'Inactive', tone: 'grey', note: '' };
  var exp = ymd(row.expires_on);
  if (!exp) return { key: 'unknown', label: 'No date', tone: 'grey', note: 'No renewal date on file' };
  var days = Math.floor((Date.parse(exp + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  if (days < 0) return { key: 'expired', label: 'Expired', tone: 'red', note: Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's') + ' ago' };
  if (days <= EXPIRING_DAYS) return { key: 'expiring', label: 'Renew soon', tone: 'amber', note: 'in ' + days + ' day' + (days === 1 ? '' : 's') };
  return { key: 'current', label: 'Current', tone: 'green', note: '' };
}

function todayYmd() { return new Date().toISOString().slice(0, 10); }

// Active users for the per-licence restriction picker.
router.get('/pickable-users', requireManage, async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT id, name, role FROM users WHERE active IS NOT false ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error('Licence pickable-users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Every licence the caller is allowed to see, each with its server-computed
// status and its ledger total. Credentials are STRIPPED for view-only callers
// exactly as vendors does it -- not hidden in the UI, absent from the response.
router.get('/', requireView, async function (req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT l.*, u.name AS responsible_name,' +
      '  (SELECT COALESCE(SUM(e.amount), 0) FROM account_ledger_entries e WHERE e.license_id = l.id) AS ledger_total,' +
      '  (SELECT COUNT(*)::int FROM account_ledger_entries e WHERE e.license_id = l.id) AS ledger_count,' +
      '  (SELECT MAX(e.entry_date) FROM account_ledger_entries e WHERE e.license_id = l.id) AS last_entry_on' +
      ' FROM licenses l LEFT JOIN users u ON u.id = l.responsible_user_id' +
      ' ORDER BY l.active DESC, l.expires_on ASC NULLS LAST, l.name ASC'
    );
    const manage = await canManage(req);
    const isAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'owner');
    const uid = req.user && req.user.id;
    const today = todayYmd();
    const out = [];
    for (var i = 0; i < rows.length; i++) {
      var l = rows[i];
      var arr = Array.isArray(l.restricted_to) ? l.restricted_to : [];
      var restricted = arr.length > 0;
      var allowed = isAdmin || (uid != null && arr.indexOf(uid) !== -1);
      if (restricted && !allowed) continue; // whole licence hidden from non-permitted people
      var showCreds = manage || (restricted && allowed);
      var c = Object.assign({}, l);
      if (!manage) c.restricted_to = null; // only managers see or edit the allowlist
      c.security_questions = readSecurityQuestions(l.security_questions);
      if (!showCreds) { c.username = null; c.password = null; c.security_questions = []; }
      c.issued_on = ymd(l.issued_on);
      c.expires_on = ymd(l.expires_on);
      c.last_entry_on = ymd(l.last_entry_on);
      c.ledger_total = parseFloat(l.ledger_total || 0);
      c.status = statusOf(l, today);
      out.push(c);
    }
    res.json({ licenses: out, can_manage: manage, expiring_days: EXPIRING_DAYS });
  } catch (err) {
    console.error('Licences list error:', err);
    res.status(500).json({ error: 'Failed to load licences' });
  }
});

function bodyFields(b) {
  return {
    name: str(b.name, 255),
    kind: kindOf(b.kind),
    authority: str(b.authority, 255),
    license_number: str(b.license_number, 255),
    city_code: str(b.city_code, 40),
    jurisdiction: str(b.jurisdiction, 160),
    website: str(b.website, 255),
    username: str(b.username, 255),
    issued_on: dateOnly(b.issued_on),
    expires_on: dateOnly(b.expires_on),
    renewal_interval: intervalOf(b.renewal_interval),
    renewal_fee: money(b.renewal_fee),
    responsible_user_id: (function () { var n = parseInt(b.responsible_user_id, 10); return Number.isInteger(n) && n > 0 ? n : null; })(),
    notes: str(b.notes, 8000),
    active: b.active === false ? false : true
  };
}

router.post('/', requireManage, async function (req, res) {
  const f = bodyFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: 'Licence name is required.' });
  const pw = passwordOf((req.body || {}).password);
  let sq;
  try { sq = cleanSecurityQuestions((req.body || {}).security_questions); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  try {
    const { rows } = await pool.query(
      'INSERT INTO licenses (name, kind, authority, license_number, city_code, jurisdiction, website,' +
      ' username, password, security_questions, issued_on, expires_on, renewal_interval, renewal_fee,' +
      ' responsible_user_id, restricted_to, notes, active, created_by, created_by_name)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *',
      [f.name, f.kind, f.authority, f.license_number, f.city_code, f.jurisdiction, f.website,
       f.username, pw === undefined ? null : pw, (sq === undefined || sq === null) ? null : JSON.stringify(sq),
       f.issued_on, f.expires_on, f.renewal_interval, f.renewal_fee, f.responsible_user_id,
       cleanRestrictedTo((req.body || {}).restricted_to), f.notes, f.active,
       req.user.id, req.user.name]
    );
    logAudit({ entity_type: 'license', entity_id: rows[0].id, action: 'created',
      user_id: req.user.id, user_name: req.user.name, details: { name: f.name, kind: f.kind }, ip: req.ip });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Licence create error:', err);
    res.status(500).json({ error: 'Failed to create the licence' });
  }
});

router.put('/:id', requireManage, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const f = bodyFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: 'Licence name is required.' });
  const sets = ['name=$1', 'kind=$2', 'authority=$3', 'license_number=$4', 'city_code=$5',
    'jurisdiction=$6', 'website=$7', 'username=$8', 'issued_on=$9',
    'expires_on=$10', 'renewal_interval=$11', 'renewal_fee=$12', 'responsible_user_id=$13',
    'notes=$14', 'active=$15'];
  const params = [f.name, f.kind, f.authority, f.license_number, f.city_code, f.jurisdiction,
    f.website, f.username, f.issued_on, f.expires_on, f.renewal_interval,
    f.renewal_fee, f.responsible_user_id, f.notes, f.active];
  // password, restricted_to and security_questions are only touched when the
  // caller actually sent them, so a partial save from some future screen cannot
  // silently wipe a portal password, open a licence to everybody, or erase the
  // answers. The password guard is the one the licensing test caught: a save
  // that carried only a new renewal date was blanking the login.
  const pw = passwordOf((req.body || {}).password);
  if (pw !== undefined) { params.push(pw); sets.push('password=$' + params.length); }
  if ((req.body || {}).restricted_to !== undefined) {
    params.push(cleanRestrictedTo(req.body.restricted_to));
    sets.push('restricted_to=$' + params.length);
  }
  let sq;
  try { sq = cleanSecurityQuestions((req.body || {}).security_questions); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (sq !== undefined) {
    params.push(sq === null ? null : JSON.stringify(sq));
    sets.push('security_questions=$' + params.length);
  }
  params.push(id);
  try {
    const { rows } = await pool.query(
      'UPDATE licenses SET ' + sets.join(', ') + ', updated_at=NOW() WHERE id=$' + params.length + ' RETURNING *',
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Licence not found' });
    logAudit({ entity_type: 'license', entity_id: id, action: 'updated',
      user_id: req.user.id, user_name: req.user.name, details: { name: f.name }, ip: req.ip });
    res.json(rows[0]);
  } catch (err) {
    console.error('Licence update error:', err);
    res.status(500).json({ error: 'Failed to update the licence' });
  }
});

// Deleting takes the ledger with it (ON DELETE CASCADE), which is why the
// editor offers Inactive: a licence we no longer hold is still a licence we
// once paid for, and that history is the reason the ledger exists.
router.delete('/:id', requireManage, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  try {
    const dr = await pool.query('SELECT name FROM licenses WHERE id = $1', [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'Licence not found' });
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM account_ledger_entries WHERE license_id = $1', [id]);
    await pool.query('DELETE FROM licenses WHERE id = $1', [id]);
    logAudit({ entity_type: 'license', entity_id: id, action: 'deleted',
      user_id: req.user.id, user_name: req.user.name,
      details: { name: dr.rows[0].name, ledger_rows_removed: n.rows[0].n }, ip: req.ip });
    res.json({ success: true, ledger_rows_removed: n.rows[0].n });
  } catch (err) {
    console.error('Licence delete error:', err);
    res.status(500).json({ error: 'Failed to delete the licence' });
  }
});

module.exports = router;
