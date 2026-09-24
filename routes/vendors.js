const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const permissions = require('../utils/permissions');

const router = express.Router();

// Every account route requires auth. Read access needs view_vendors OR
// manage_vendors; mutations require manage_vendors. Portal credentials
// (username / password / security answers) are OWNER-ONLY: stripped in the
// GET handler below for everyone else, including admins and managers.
router.use(requireAuth);

// True if this request can fully manage accounts (role perm or per-user grant).
async function canManageVendors(req) {
  if (!req.user) return false;
  try { if (await permissions.hasPermission(req.user.role, 'manage_vendors')) return true; } catch (_) {}
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf('manage_vendors') !== -1;
  } catch (_) { return false; }
}

// Gate for read access: allow view_vendors or manage_vendors (role or per-user).
async function requireViewVendors(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    for (const perm of ['manage_vendors', 'view_vendors']) {
      try { if (await permissions.hasPermission(req.user.role, perm)) return next(); } catch (_) {}
    }
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    if (Array.isArray(ep) && (ep.indexOf('manage_vendors') !== -1 || ep.indexOf('view_vendors') !== -1)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) {
    return res.status(403).json({ error: 'Forbidden' });
  }
}

// Sanitize a restricted_to allowlist into a de-duped array of positive int IDs.
function cleanRestrictedTo(v) {
  if (!Array.isArray(v)) return null;
  const ids = Array.from(new Set(v.map(function (x) { return parseInt(x, 10); }).filter(function (n) { return Number.isInteger(n) && n > 0; })));
  return ids.length ? ids : null;
}

// Sanitize a per-account required-photo override into an array of slot keys.
// undefined  -> leave the column alone (the caller did not mean to change it)
// null / ''  -> clear it, i.e. fall back to the global Invoice Setup list
// []         -> a real answer: this account requires NO photos
function cleanRequiredPhotos(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!Array.isArray(v)) return null;
  const keys = Array.from(new Set(v
    .map(function (x) { return String(x == null ? '' : x).trim().toLowerCase().slice(0, 40); })
    .filter(Boolean)));
  return keys;
}

// Hard limits, shared with the browser editor so what you type is what gets
// stored. The route rejects anything past them rather than trimming: a
// silently shortened answer is a WRONG answer, and you would only find that
// out when a vendor portal locks the account.
const SQ_MAX_ROWS = 25;
const SQ_MAX_LEN = 300;

// Sanitize the security-question list into an ordered array of { q, a } pairs.
// Same undefined-guard contract as cleanRequiredPhotos, and for the same
// reason: the Invoice Setup screen PUTs an account with only its own fields
// (public/js/app.js, invSetupSave), and a save that never mentions security
// questions must not erase them.
//   undefined         -> leave the column alone
//   null / '' / []    -> a real answer: this account has no security questions
//   anything else     -> undefined, i.e. ALSO leave the column alone
// That last line is deliberate. Answers are unrecoverable secrets, so a
// payload we cannot make sense of must never be read as "delete them all";
// the only thing that clears them is an explicit empty list.
// A row is kept when it has a question OR an answer; a row with neither is
// dropped so an empty trailing row in the editor does not persist. Only the
// edges are trimmed - some portals compare the answer as an exact string.
// Throws on over-length input so the caller gets a 400 instead of a quiet
// truncation.
function cleanSecurityQuestions(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!Array.isArray(v)) return undefined;
  if (v.length > SQ_MAX_ROWS) {
    const e = new Error('An account can hold at most ' + SQ_MAX_ROWS + ' security questions.');
    e.status = 400;
    throw e;
  }
  const out = [];
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const q = String(row.q == null ? '' : row.q).trim();
    const a = String(row.a == null ? '' : row.a).trim();
    if (q.length > SQ_MAX_LEN || a.length > SQ_MAX_LEN) {
      const e = new Error('Security questions and answers are limited to ' + SQ_MAX_LEN + ' characters.');
      e.status = 400;
      throw e;
    }
    if (!q && !a) continue;
    out.push({ q: q, a: a });
  }
  return out.length ? out : null;
}

// Rows come back from JSONB already parsed, but a hand-edited or legacy value
// could be anything. Normalize to an array so the callers below can count and
// map without guarding every time.
function readSecurityQuestions(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; }
  }
  return [];
}

// Active users for the per-account restriction picker (managers only).
router.get('/pickable-users', requirePermission('manage_vendors'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, role FROM users WHERE active IS NOT false ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Portal credentials (username / password / security answers) are OWNER-ONLY.
// GET / strips them per-row; this does the same for a create/update response so
// an edit's RETURNING * cannot echo a stored login back to an admin or manager.
// Owner's role is coerced to 'admin' upstream, so key off req.user.isOwner.
function credsForViewer(req, row) {
  if (!row || (req.user && req.user.isOwner)) return row;
  const c = Object.assign({}, row);
  hideCreds(c, row);
  return c;
}

// Strip the secrets but keep presence flags. Before these flags, a manager or
// admin who typed a login and hit Save got a dash back in the Accounts table
// (the server had saved it, then correctly refused to show it), which read as
// "the login did not save". The flags carry no secret: only whether one exists.
function hideCreds(c, src) {
  const sq = readSecurityQuestions(src.security_questions);
  c.creds_hidden = true;
  c.has_username = !!(src.username && String(src.username).trim());
  c.has_password = !!(src.password && String(src.password));
  c.security_questions_count = sq.length;
  c.username = null; c.password = null; c.security_questions = [];
}

// GET all vendors (view or manage). Portal credentials are OWNER-ONLY (below).
router.get('/', requireViewVendors, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM vendors ORDER BY name ASC');
    const manage = await canManageVendors(req);
    const isAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'owner');
    // Portal creds are OWNER-ONLY. The owner's role is coerced to 'admin'
    // upstream (middleware/auth.js), so key off isOwner, NOT the role, or every
    // admin would qualify. Tony's call 2026-09-20: admins/managers still work in
    // the account section, but only the owner sees stored logins.
    const isOwner = !!(req.user && req.user.isOwner);
    const uid = req.user && req.user.id;
    const out = [];
    for (const v of rows) {
      const arr = Array.isArray(v.restricted_to) ? v.restricted_to : [];
      const restricted = arr.length > 0;
      const allowed = isAdmin || (uid != null && arr.indexOf(uid) !== -1);
      if (restricted && !allowed) continue; // whole account hidden from non-permitted people
      const showCreds = isOwner; // owner-only: not admins, not managers, not the allowlist
      const c = Object.assign({}, v);
      if (!manage) c.restricted_to = null; // only managers see/edit the allowlist
      c.security_questions = readSecurityQuestions(v.security_questions);
      // Answers are credentials. They ride out on exactly the same gate as the
      // username and password, so a view-only caller never receives them - not
      // hidden in the UI, absent from the response.
      if (!showCreds) hideCreds(c, v);
      out.push(c);
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vendors' });
  }
});

// POST create vendor
router.post('/', requirePermission('manage_vendors'), async (req, res) => {
  const { name, website, account_number, username, password, notes, rep_name, rep_email, rep_phone, city_code, show_in_invoice, invoice_notes, auto_line_items, agreement_text, restricted_to, required_photos, require_signature, require_entitlement, require_vehicle, require_photos, security_questions, account_type } = req.body;
  if (!name) return res.status(400).json({ error: 'Vendor name is required' });
  const _reqPhotos = cleanRequiredPhotos(required_photos);
  let _secQs;
  try { _secQs = cleanSecurityQuestions(security_questions); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  try {
    const { rows } = await pool.query(
      'INSERT INTO vendors (name, website, account_number, username, password, notes, rep_name, rep_email, rep_phone, city_code, show_in_invoice, invoice_notes, auto_line_items, agreement_text, restricted_to, required_photos, require_signature, require_entitlement, require_vehicle, require_photos, security_questions, account_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *',
      [name, website || null, account_number || null, username || null, password || null, notes || null, rep_name || null, rep_email || null, rep_phone || null, city_code || null, show_in_invoice === true, invoice_notes || null, (auto_line_items != null ? JSON.stringify(auto_line_items) : null), agreement_text || null, cleanRestrictedTo(restricted_to), (_reqPhotos === undefined || _reqPhotos === null) ? null : JSON.stringify(_reqPhotos), require_signature === true, require_entitlement === true, require_vehicle === true, require_photos === true, (_secQs === undefined || _secQs === null) ? null : JSON.stringify(_secQs), (account_type || null)]
    );
    if (account_number) {
      await pool.query('UPDATE geico_surveys SET city_code = $1, updated_at = NOW() WHERE UPPER(TRIM(account_number)) = UPPER(TRIM($2))', [city_code || null, account_number]);
    }
    res.status(201).json(credsForViewer(req, rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create vendor' });
  }
});

// PUT update vendor
router.put('/:id', requirePermission('manage_vendors'), async (req, res) => {
  const { name, website, account_number, username, password, notes, rep_name, rep_email, rep_phone, city_code, show_in_invoice, invoice_notes, auto_line_items, agreement_text, restricted_to, required_photos, require_signature, require_entitlement, require_vehicle, require_photos, security_questions, account_type, send_completion, completion_to, completion_cc, completion_reply_to, completion_send_signoffs, completion_send_invoice, completion_send_photos } = req.body;
  if (!name) return res.status(400).json({ error: 'Vendor name is required' });
  // restricted_to and required_photos are only touched when the caller actually
  // sent them. The Invoice Setup screen saves an account with the invoice fields
  // only; before this guard that save silently wiped the account's user
  // allowlist, which reads as "someone opened the account to everybody".
  const _params = [name, website || null, account_number || null, notes || null, rep_name || null, rep_email || null, rep_phone || null, city_code || null];
  const _sets = ['name=$1', 'website=$2', 'account_number=$3', 'notes=$4', 'rep_name=$5', 'rep_email=$6', 'rep_phone=$7', 'city_code=$8'];
  // Invoice-only per-account fields, guarded the same way as require_* below.
  // Invoice Setup owns these; show_in_invoice is ALSO settable from the Add/Edit
  // Account modal. Guard each so a save that omits the key can't wipe it: before
  // this, the Account modal (which sends none of them) silently reset
  // show_in_invoice to false -- pulling the account out of invoicing -- and
  // nulled invoice_notes, auto_line_items and agreement_text on every edit.
  if (show_in_invoice !== undefined) { _params.push(show_in_invoice === true); _sets.push('show_in_invoice=$' + _params.length); }
  if (invoice_notes !== undefined) { _params.push(invoice_notes || null); _sets.push('invoice_notes=$' + _params.length); }
  if (auto_line_items !== undefined) { _params.push(auto_line_items != null ? JSON.stringify(auto_line_items) : null); _sets.push('auto_line_items=$' + _params.length); }
  if (agreement_text !== undefined) { _params.push(agreement_text || null); _sets.push('agreement_text=$' + _params.length); }
  // Username/password are guarded, NOT set unconditionally. The Add/Edit Account
  // modal now opens these BLANK on purpose - browsers kept auto-filling the
  // operator's own Nova login over the account's stored portal creds, and a blank
  // field then wiped the real login on save. So an empty value here means "leave
  // the saved login alone", never "clear it"; a real change is a non-empty value.
  // Credential lookup lives on the Accounts table row (toggleVendorPw), not this
  // modal. invSetupSave re-sends the real stored values, so it is unaffected.
  if (username !== undefined && username !== null && String(username).trim() !== '') { _params.push(String(username).trim()); _sets.push('username=$' + _params.length); }
  if (password !== undefined && password !== null && String(password) !== '') { _params.push(String(password)); _sets.push('password=$' + _params.length); }
  if (restricted_to !== undefined) { _params.push(cleanRestrictedTo(restricted_to)); _sets.push('restricted_to=$' + _params.length); }
  const _reqPhotos = cleanRequiredPhotos(required_photos);
  if (_reqPhotos !== undefined) { _params.push(_reqPhotos === null ? null : JSON.stringify(_reqPhotos)); _sets.push('required_photos=$' + _params.length); }
  // Close-out requirement booleans, guarded the same way: a save that does not
  // send the key (e.g. an A/R-only or Invoice-Setup save) must not reset them.
  if (require_signature !== undefined) { _params.push(require_signature === true); _sets.push('require_signature=$' + _params.length); }
  if (require_entitlement !== undefined) { _params.push(require_entitlement === true); _sets.push('require_entitlement=$' + _params.length); }
  if (require_vehicle !== undefined) { _params.push(require_vehicle === true); _sets.push('require_vehicle=$' + _params.length); }
  if (require_photos !== undefined) { _params.push(require_photos === true); _sets.push('require_photos=$' + _params.length); }
  // Completion Paperwork per-account routing (Invoice Setup > Configure). Guarded like
  // the close-out require_* fields above so an A/R or Invoice-Setup save can't wipe them.
  if (send_completion !== undefined) { _params.push(send_completion === true); _sets.push('send_completion=$' + _params.length); }
  if (completion_to !== undefined) { _params.push(completion_to || null); _sets.push('completion_to=$' + _params.length); }
  if (completion_cc !== undefined) { _params.push(completion_cc || null); _sets.push('completion_cc=$' + _params.length); }
  if (completion_reply_to !== undefined) { _params.push(completion_reply_to || null); _sets.push('completion_reply_to=$' + _params.length); }
  if (completion_send_signoffs !== undefined) { _params.push(completion_send_signoffs === true); _sets.push('completion_send_signoffs=$' + _params.length); }
  if (completion_send_invoice !== undefined) { _params.push(completion_send_invoice === true); _sets.push('completion_send_invoice=$' + _params.length); }
  if (completion_send_photos !== undefined) { _params.push(completion_send_photos === true); _sets.push('completion_send_photos=$' + _params.length); }
  if (account_type !== undefined) { _params.push(account_type || null); _sets.push('account_type=$' + _params.length); }
  // Security questions get the same guard. The Invoice Setup screen saves an
  // account without ever sending this key; without the guard that save would
  // silently wipe every question on the account.
  let _secQs;
  try { _secQs = cleanSecurityQuestions(security_questions); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  // Non-owners never receive the saved questions (GET strips them), so the
  // Edit Account modal opens with an empty list for them and used to send that
  // empty list straight back - wiping every saved question on every manager or
  // admin edit. For a non-owner, what they send is ADDED to the saved list;
  // they cannot remove or replace answers they are not allowed to see. The
  // owner still gets full replace semantics (clear every row = really clear).
  if (_secQs !== undefined && !(req.user && req.user.isOwner)) {
    if (!_secQs || !_secQs.length) { _secQs = undefined; }
    else {
      const cur = await pool.query('SELECT security_questions FROM vendors WHERE id = $1', [req.params.id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'Vendor not found' });
      const merged = readSecurityQuestions(cur.rows[0].security_questions).concat(_secQs);
      if (merged.length > SQ_MAX_ROWS) return res.status(400).json({ error: 'An account can hold at most ' + SQ_MAX_ROWS + ' security questions.' });
      _secQs = merged;
    }
  }
  if (_secQs !== undefined) { _params.push(_secQs === null ? null : JSON.stringify(_secQs)); _sets.push('security_questions=$' + _params.length); }
  _params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      'UPDATE vendors SET ' + _sets.join(', ') + ', updated_at=NOW() WHERE id=$' + _params.length + ' RETURNING *',
      _params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Vendor not found' });
    if (account_number) {
      await pool.query('UPDATE geico_surveys SET city_code = $1, updated_at = NOW() WHERE UPPER(TRIM(account_number)) = UPPER(TRIM($2))', [city_code || null, account_number]);
    }
    res.json(credsForViewer(req, rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update vendor' });
  }
});

// DELETE vendor
router.delete('/:id', requirePermission('manage_vendors'), async (req, res) => {
  try {
    await pool.query('DELETE FROM vendors WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete vendor' });
  }
});

module.exports = router;
