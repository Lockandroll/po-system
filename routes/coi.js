// Certificates of Insurance.
//
// Three things live behind this router:
//   1. What each account REQUIRES on its certificate (account_coi_requirements)
//   2. Every certificate ever issued to them (account_coi_certificates, R2-backed)
//   3. The once-a-year renewal cycle that gets new ones out (coi_renewal_*)
//
// Read access rides on the Accounts permissions (view_vendors / manage_vendors).
// WRITING is gated on its own permission, manage_coi, so whoever handles the
// insurance renewal can do it without being handed every vendor portal password.
//
// House style: string concatenation only, no template literals.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const r2 = require('../utils/r2');
const coi = require('../utils/coi');
const { logAudit } = require('../utils/audit');
const { sendEmail } = require('../utils/email');
const { buildPacketPdf } = require('../utils/coiPacketPdf');

const router = express.Router();
router.use(requireAuth);

const ITEM_STATUSES = ['needed', 'requested', 'received', 'sent', 'confirmed', 'waived'];
const SUBMIT_METHODS = ['email', 'portal', 'mail'];
const MAX_EMAIL_BYTES = 20 * 1024 * 1024;

// ---- access ---------------------------------------------------------------

async function hasPerm(req, perm) {
  if (!req.user) return false;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (_) {}
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf(perm) !== -1;
  } catch (_) { return false; }
}

async function canManage(req) { return hasPerm(req, 'manage_coi'); }

// Anyone who can see the Accounts module can read COI. Nothing secret lives
// here - the credentials stayed on the account row.
async function requireViewCoi(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    var perms = ['manage_coi', 'manage_vendors', 'view_vendors'];
    for (var i = 0; i < perms.length; i++) {
      if (await hasPerm(req, perms[i])) return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
}

async function requireManageCoi(req, res, next) {
  try {
    if (await canManage(req)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
}

// ---- sanitizers -----------------------------------------------------------

function str(v, max) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max || 255);
}

function bool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

function dateOnly(v) {
  var s = str(v, 30);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function intOrNull(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  if (!isFinite(n)) return null;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

// Additional insured: an ordered list of { name, relationship }. A row with no
// name is dropped so an empty trailing row in the editor does not persist.
function cleanAdditionalInsured(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  var arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { return undefined; } }
  if (!Array.isArray(arr)) return undefined;
  var out = [];
  for (var i = 0; i < arr.length && out.length < 25; i++) {
    var row = arr[i] || {};
    var name = str(row.name, 255);
    if (!name) continue;
    out.push({ name: name, relationship: str(row.relationship, 80) || '' });
  }
  return out.length ? out : null;
}

function sanitizeMethod(v) {
  var s = String(v || '').trim().toLowerCase();
  return SUBMIT_METHODS.indexOf(s) !== -1 ? s : 'email';
}

// Split a comma / semicolon / newline separated recipient list into valid
// addresses. An address that does not parse is dropped rather than sent to.
function parseEmails(v) {
  var raw = String(v || '').split(/[,;\n]/);
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var e = raw[i].trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && out.indexOf(e) === -1) out.push(e);
  }
  return out;
}

function escEmail(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeName(name) {
  return String(name || 'certificate.pdf').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'certificate.pdf';
}

// ---- shared queries -------------------------------------------------------

const REQ_SELECT = 'r.*';
// The current certificate for each account: highest expiry among the ready,
// un-superseded rows. DISTINCT ON keeps it to one row per account.
const CURRENT_CERT_SQL =
  'SELECT DISTINCT ON (account_id) * FROM account_coi_certificates ' +
  "WHERE status = 'ready' AND superseded = false " +
  'ORDER BY account_id, expires_on DESC NULLS LAST, id DESC';

function certDates(c) {
  if (!c) return c;
  // pg returns DATE as a JS Date in the server timezone; slice it back to a
  // plain YYYY-MM-DD so nothing downstream can shift it across midnight.
  ['effective_on', 'expires_on'].forEach(function (k) {
    if (c[k] instanceof Date) c[k] = c[k].toISOString().slice(0, 10);
    else if (c[k]) c[k] = String(c[k]).slice(0, 10);
  });
  return c;
}

// Recompute which certificate is current for an account, and re-check the
// current one against the requirements. Called after every write that could
// change either side of that comparison.
async function resyncAccount(accountId) {
  const rq = await pool.query('SELECT * FROM account_coi_requirements WHERE account_id = $1', [accountId]);
  const reqRow = rq.rows[0] || null;
  const cr = await pool.query(
    "SELECT * FROM account_coi_certificates WHERE account_id = $1 AND status = 'ready' " +
    'ORDER BY expires_on DESC NULLS LAST, id DESC', [accountId]
  );
  if (!cr.rows.length) return null;
  const winner = cr.rows[0];
  for (var i = 0; i < cr.rows.length; i++) {
    var row = cr.rows[i];
    var shouldBeSuperseded = row.id !== winner.id;
    if (row.superseded !== shouldBeSuperseded) {
      await pool.query('UPDATE account_coi_certificates SET superseded = $1 WHERE id = $2', [shouldBeSuperseded, row.id]);
    }
  }
  const mismatch = coi.computeMismatch(reqRow, winner);
  await pool.query('UPDATE account_coi_certificates SET mismatch = $1, updated_at = NOW() WHERE id = $2',
    [mismatch.length ? JSON.stringify(mismatch) : null, winner.id]);
  winner.mismatch = mismatch.length ? mismatch : null;
  winner.superseded = false;
  return certDates(winner);
}

async function readPolicy() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'coi_policy'");
    if (!r.rows.length || !r.rows[0].value) return {};
    return JSON.parse(r.rows[0].value);
  } catch (e) { return {}; }
}

// ---- overview -------------------------------------------------------------

// Every account with a COI record, plus the counts the badge and the stat row
// use. Accounts that have never been set up simply do not appear: you tell Nova
// which accounts need a certificate, it does not guess.
router.get('/', requireViewCoi, async function (req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT v.id AS account_id, v.name AS account_name, v.city_code, ' +
      '       ' + REQ_SELECT + ', ' +
      '       c.id AS cert_id, c.file_name, c.expires_on, c.effective_on, c.mismatch, c.sent_at, c.carrier ' +
      'FROM vendors v ' +
      'JOIN account_coi_requirements r ON r.account_id = v.id ' +
      'LEFT JOIN (' + CURRENT_CERT_SQL + ') c ON c.account_id = v.id ' +
      'ORDER BY v.name ASC'
    );
    const today = coi.etToday();
    const accounts = rows.map(function (row) {
      certDates(row);
      const status = coi.coiStatus(row, today);
      return {
        account_id: row.account_id,
        account_name: row.account_name,
        city_code: row.city_code,
        coi_required: row.coi_required,
        off_cycle: row.off_cycle,
        holder_name: row.holder_name,
        submit_method: row.submit_method,
        submit_emails: row.submit_emails,
        submit_portal_url: row.submit_portal_url,
        cert_id: row.cert_id,
        file_name: row.file_name,
        carrier: row.carrier,
        effective_on: row.effective_on,
        expires_on: row.expires_on,
        sent_at: row.sent_at,
        mismatch: row.mismatch,
        status: status
      };
    });
    const counts = coi.tally(rows, today);
    const cy = await pool.query("SELECT * FROM coi_renewal_cycles WHERE status = 'open' ORDER BY id DESC LIMIT 1");
    res.json({
      accounts: accounts,
      counts: counts,
      policy: await readPolicy(),
      open_cycle: cy.rows[0] || null,
      storage_ready: r2.configured(),
      can_manage: await canManage(req)
    });
  } catch (err) {
    console.error('COI list error:', err);
    res.status(500).json({ error: 'Failed to load certificates' });
  }
});

// The badge count on its own, for the accounts screen and the nav.
router.get('/summary', requireViewCoi, async function (req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT r.coi_required, c.expires_on, c.mismatch ' +
      'FROM account_coi_requirements r ' +
      'LEFT JOIN (' + CURRENT_CERT_SQL + ') c ON c.account_id = r.account_id'
    );
    rows.forEach(certDates);
    res.json({ counts: coi.tally(rows) });
  } catch (err) {
    console.error('COI summary error:', err);
    res.status(500).json({ error: 'Failed to load COI summary' });
  }
});

// ---- one account ----------------------------------------------------------

router.get('/account/:accountId', requireViewCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.accountId, 10);
    const av = await pool.query('SELECT id, name, city_code FROM vendors WHERE id = $1', [id]);
    if (!av.rows.length) return res.status(404).json({ error: 'Account not found' });
    const rq = await pool.query('SELECT * FROM account_coi_requirements WHERE account_id = $1', [id]);
    const cr = await pool.query(
      "SELECT * FROM account_coi_certificates WHERE account_id = $1 AND status <> 'pending' " +
      'ORDER BY expires_on DESC NULLS LAST, id DESC', [id]
    );
    const certs = cr.rows.map(certDates);
    const current = certs.filter(function (c) { return !c.superseded; })[0] || null;
    const status = coi.coiStatus({
      coi_required: rq.rows.length ? rq.rows[0].coi_required : false,
      expires_on: current ? current.expires_on : null,
      mismatch: current ? current.mismatch : null
    });
    res.json({
      account: av.rows[0],
      requirements: rq.rows[0] || null,
      certificates: certs,
      current_id: current ? current.id : null,
      status: status,
      limit_fields: coi.LIMIT_FIELDS,
      storage_ready: r2.configured(),
      can_manage: await canManage(req)
    });
  } catch (err) {
    console.error('COI account error:', err);
    res.status(500).json({ error: 'Failed to load account COI' });
  }
});

// Create or update an account's requirements. Upsert on account_id: there is
// exactly one requirements row per account and the editor always sends the
// whole thing, so a partial save cannot half-erase it.
router.put('/account/:accountId', requireManageCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.accountId, 10);
    const av = await pool.query('SELECT id, name FROM vendors WHERE id = $1', [id]);
    if (!av.rows.length) return res.status(404).json({ error: 'Account not found' });
    const b = req.body || {};

    var cols = ['account_id', 'coi_required', 'holder_name', 'holder_address', 'additional_insured',
      'ai_wording', 'waiver_gl', 'waiver_auto', 'waiver_wc', 'primary_noncontrib', 'req_wc_statutory',
      'cancel_notice_days', 'named_insured', 'submit_method', 'submit_emails', 'submit_portal_url',
      'submit_notes', 'off_cycle', 'source_note', 'updated_by', 'updated_by_name'];
    var ai = cleanAdditionalInsured(b.additional_insured);
    var vals = [
      id,
      b.coi_required === undefined ? true : bool(b.coi_required),
      str(b.holder_name, 255),
      str(b.holder_address, 2000),
      ai === undefined ? null : (ai ? JSON.stringify(ai) : null),
      str(b.ai_wording, 4000),
      bool(b.waiver_gl), bool(b.waiver_auto), bool(b.waiver_wc),
      bool(b.primary_noncontrib), bool(b.req_wc_statutory),
      intOrNull(b.cancel_notice_days, 0, 365),
      str(b.named_insured, 255),
      sanitizeMethod(b.submit_method),
      str(b.submit_emails, 1000),
      str(b.submit_portal_url, 255),
      str(b.submit_notes, 2000),
      bool(b.off_cycle),
      str(b.source_note, 1000),
      req.user.id, req.user.name
    ];
    coi.LIMIT_FIELDS.forEach(function (f) {
      cols.push(coi.reqCol(f.key));
      vals.push(coi.num(b[coi.reqCol(f.key)]));
    });

    var placeholders = cols.map(function (_, i) { return '$' + (i + 1); }).join(',');
    var updates = cols.slice(1).map(function (c, i) { return c + ' = $' + (i + 2); }).join(', ');
    await pool.query(
      'INSERT INTO account_coi_requirements (' + cols.join(',') + ') VALUES (' + placeholders + ') ' +
      'ON CONFLICT (account_id) DO UPDATE SET ' + updates + ', updated_at = NOW()',
      vals
    );

    // Requirements changed, so the current certificate may have just become
    // compliant or non-compliant. Re-check it now rather than at read time.
    const current = await resyncAccount(id);
    logAudit({ entity_type: 'coi', entity_id: id, entity_number: av.rows[0].name, action: 'requirements_saved',
      user_id: req.user.id, user_name: req.user.name, ip: req.ip });
    res.json({ success: true, current: current });
  } catch (err) {
    console.error('COI requirements save error:', err);
    res.status(500).json({ error: 'Failed to save requirements' });
  }
});

router.delete('/account/:accountId', requireManageCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.accountId, 10);
    const cc = await pool.query('SELECT COUNT(*)::int AS n FROM account_coi_certificates WHERE account_id = $1', [id]);
    if (cc.rows[0].n > 0) {
      return res.status(409).json({ error: 'This account has ' + cc.rows[0].n + ' stored certificate(s). Delete those first, or untick "COI required" instead.' });
    }
    await pool.query('DELETE FROM account_coi_requirements WHERE account_id = $1', [id]);
    logAudit({ entity_type: 'coi', entity_id: id, action: 'requirements_deleted', user_id: req.user.id, user_name: req.user.name, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error('COI requirements delete error:', err);
    res.status(500).json({ error: 'Failed to remove COI setup' });
  }
});

// ---- certificates ---------------------------------------------------------

// Step 1 of the upload: reserve the row and hand back a presigned PUT. Bytes go
// browser to R2 directly, exactly as the document vault does.
router.post('/account/:accountId/upload-url', requireManageCoi, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet. Add the R2_* environment variables in Railway.' });
    const id = parseInt(req.params.accountId, 10);
    const av = await pool.query('SELECT id FROM vendors WHERE id = $1', [id]);
    if (!av.rows.length) return res.status(404).json({ error: 'Account not found' });
    const name = str(req.body.name, 255) || 'certificate.pdf';
    const mime = str(req.body.mime_type, 255) || 'application/pdf';
    const key = 'coi/' + id + '/' + crypto.randomUUID() + '/' + sanitizeName(name);
    const { rows } = await pool.query(
      "INSERT INTO account_coi_certificates (account_id, r2_key, file_name, mime_type, status, uploaded_by, uploaded_by_name) " +
      "VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING id",
      [id, key, name, mime, req.user.id, req.user.name]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('COI upload-url error:', err);
    res.status(500).json({ error: 'Failed to start the upload' });
  }
});

// Read the certificate detail fields off a request body.
function certFields(b) {
  var out = {
    effective_on: dateOnly(b.effective_on),
    expires_on: dateOnly(b.expires_on),
    carrier: str(b.carrier, 255),
    policy_numbers: str(b.policy_numbers, 500),
    has_ai: bool(b.has_ai),
    has_waiver: bool(b.has_waiver),
    has_pnc: bool(b.has_pnc),
    has_wc: bool(b.has_wc),
    notes: str(b.notes, 2000)
  };
  coi.LIMIT_FIELDS.forEach(function (f) { out[coi.limCol(f.key)] = coi.num(b[coi.limCol(f.key)]); });
  return out;
}

async function writeCertFields(certId, fields, extra) {
  var cols = Object.keys(fields);
  var sets = cols.map(function (c, i) { return c + ' = $' + (i + 1); });
  var vals = cols.map(function (c) { return fields[c]; });
  if (extra) {
    Object.keys(extra).forEach(function (c) { sets.push(c + ' = $' + (vals.length + 1)); vals.push(extra[c]); });
  }
  vals.push(certId);
  await pool.query('UPDATE account_coi_certificates SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $' + vals.length, vals);
}

// Step 2: the bytes are in R2. Record the detail fields, mark it ready, and run
// the requirement check. A certificate that falls short is still SAVED - it is
// what the carrier actually issued. Nova reports the shortfall, it does not
// refuse the file.
router.post('/certificates/:id/confirm', requireManageCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cr = await pool.query('SELECT * FROM account_coi_certificates WHERE id = $1', [id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    const cert = cr.rows[0];
    // The browser PUT the bytes straight to R2, so this server never saw them.
    // Ask R2 whether the object is really there instead of taking the client's
    // word for it - a failed upload must not become a certificate on file.
    var size = Math.max(0, parseInt(req.body.size_bytes, 10) || 0);
    if (r2.configured()) {
      var head;
      try { head = await r2.headObject(cert.r2_key); }
      catch (e) { console.error('COI head check failed:', e.message); return res.status(502).json({ error: 'Could not verify the upload with storage. Try again.' }); }
      if (!head) return res.status(400).json({ error: 'The upload did not complete. Try again.' });
      size = head.size || size;
    }
    const fields = certFields(req.body || {});
    await writeCertFields(id, fields, { size_bytes: size, status: 'ready', cycle_id: intOrNull(req.body.cycle_id) });
    const current = await resyncAccount(cert.account_id);
    const fresh = await pool.query('SELECT * FROM account_coi_certificates WHERE id = $1', [id]);
    logAudit({ entity_type: 'coi', entity_id: cert.account_id, action: 'certificate_uploaded',
      user_id: req.user.id, user_name: req.user.name, details: { file: cert.file_name, expires_on: fields.expires_on }, ip: req.ip });

    // If this account is on an open cycle and was still waiting on the agent,
    // the upload IS the receipt. Advance it rather than making someone tick it.
    await pool.query(
      "UPDATE coi_renewal_items i SET status = 'received', certificate_id = $1, updated_at = NOW() " +
      'FROM coi_renewal_cycles c WHERE i.cycle_id = c.id AND c.status = ' + "'open' " +
      'AND i.account_id = $2 AND i.status IN (' + "'needed','requested')", [id, cert.account_id]
    );
    res.json({ success: true, certificate: certDates(fresh.rows[0]), current_id: current ? current.id : null });
  } catch (err) {
    console.error('COI confirm error:', err);
    res.status(500).json({ error: 'Failed to save the certificate' });
  }
});

// Edit a stored certificate's dates / limits / boxes. Re-runs the check.
router.put('/certificates/:id', requireManageCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cr = await pool.query('SELECT * FROM account_coi_certificates WHERE id = $1', [id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    const fields = certFields(req.body || {});
    // Changing the expiry re-arms both reminder flags, so the new date gets its
    // own warning instead of being silently treated as already-notified.
    var extra = {};
    var prev = cr.rows[0].expires_on ? String(certDates(cr.rows[0]).expires_on) : null;
    if (fields.expires_on !== prev) { extra.reminder_sent_at = null; extra.expiry_notice_sent_at = null; }
    await writeCertFields(id, fields, extra);
    const current = await resyncAccount(cr.rows[0].account_id);
    const fresh = await pool.query('SELECT * FROM account_coi_certificates WHERE id = $1', [id]);
    res.json({ success: true, certificate: certDates(fresh.rows[0]), current_id: current ? current.id : null });
  } catch (err) {
    console.error('COI certificate update error:', err);
    res.status(500).json({ error: 'Failed to update the certificate' });
  }
});

router.get('/certificates/:id/download', requireViewCoi, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet.' });
    const id = parseInt(req.params.id, 10);
    const cr = await pool.query("SELECT r2_key, file_name, mime_type FROM account_coi_certificates WHERE id = $1 AND status = 'ready'", [id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    const url = await r2.presignDownload(cr.rows[0].r2_key, cr.rows[0].file_name, req.query.inline === '1');
    res.json({ url: url });
  } catch (err) {
    console.error('COI download error:', err);
    res.status(500).json({ error: 'Failed to open the certificate' });
  }
});

router.delete('/certificates/:id', requireManageCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cr = await pool.query('SELECT * FROM account_coi_certificates WHERE id = $1', [id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    try { if (r2.configured()) await r2.deleteObject(cr.rows[0].r2_key); }
    catch (e) { console.error('COI R2 delete failed (row removed anyway):', e.message); }
    await pool.query('UPDATE coi_renewal_items SET certificate_id = NULL WHERE certificate_id = $1', [id]);
    await pool.query('DELETE FROM account_coi_certificates WHERE id = $1', [id]);
    await resyncAccount(cr.rows[0].account_id);
    logAudit({ entity_type: 'coi', entity_id: cr.rows[0].account_id, action: 'certificate_deleted',
      user_id: req.user.id, user_name: req.user.name, details: { file: cr.rows[0].file_name }, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error('COI certificate delete error:', err);
    res.status(500).json({ error: 'Failed to delete the certificate' });
  }
});

// Send the stored certificate to the account. Recipients default to the
// requirements row and are editable in the dialog; a portal account has no
// address to send to and is marked submitted by hand instead.
router.post('/certificates/:id/email', requireManageCoi, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet.' });
    const id = parseInt(req.params.id, 10);
    const cr = await pool.query(
      'SELECT c.*, v.name AS account_name FROM account_coi_certificates c ' +
      "JOIN vendors v ON v.id = c.account_id WHERE c.id = $1 AND c.status = 'ready'", [id]
    );
    if (!cr.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    const cert = cr.rows[0];
    const rq = await pool.query('SELECT * FROM account_coi_requirements WHERE account_id = $1', [cert.account_id]);
    const to = parseEmails(req.body.to !== undefined ? req.body.to : (rq.rows[0] ? rq.rows[0].submit_emails : ''));
    if (!to.length) return res.status(400).json({ error: 'No valid recipient address. Add one on the account, or type one here.' });
    if (Number(cert.size_bytes) > MAX_EMAIL_BYTES) return res.status(413).json({ error: 'This file is over 20 MB and is too large to email as an attachment.' });

    let buf;
    try { buf = await r2.getObjectBuffer(cert.r2_key); }
    catch (e) { console.error('COI R2 fetch for email failed:', e.message); return res.status(502).json({ error: 'Could not retrieve the certificate to send.' }); }

    const message = str(req.body.message, 2000);
    const safeMsg = message ? escEmail(message).replace(/\n/g, '<br>') : '';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6">' +
      '<p>Hello,</p>' +
      '<p>Attached is the current certificate of insurance for Lock and Roll LLC' +
      (cert.expires_on ? (', valid through ' + escEmail(String(certDates(cert).expires_on))) : '') + '.</p>' +
      (safeMsg ? ('<p>' + safeMsg + '</p>') : '') +
      '<p>Please let us know if anything on it needs to be corrected.</p>' +
      '<p>Sent by ' + escEmail(req.user.name) + ' on behalf of Lock and Roll LLC.</p>' +
      '<p style="color:#888;font-size:12px;border-top:1px solid #eee;padding-top:10px;margin-top:18px">This message was sent from an unmonitored address. Please contact Lock and Roll LLC directly with any questions.</p>' +
      '</div>';

    await sendEmail(to, 'Certificate of Insurance - Lock and Roll LLC', html, req.user.email || null,
      [{ filename: cert.file_name, content: buf.toString('base64'), content_type: cert.mime_type || 'application/pdf' }]);

    await pool.query('UPDATE account_coi_certificates SET sent_at = NOW(), sent_to = $1, sent_by = $2, sent_by_name = $3 WHERE id = $4',
      [to.join(', '), req.user.id, req.user.name, id]);
    await pool.query(
      "UPDATE coi_renewal_items i SET status = 'sent', sent_at = NOW(), certificate_id = $1, updated_at = NOW() " +
      "FROM coi_renewal_cycles c WHERE i.cycle_id = c.id AND c.status = 'open' " +
      "AND i.account_id = $2 AND i.status <> 'confirmed'", [id, cert.account_id]
    );
    logAudit({ entity_type: 'coi', entity_id: cert.account_id, action: 'certificate_emailed',
      user_id: req.user.id, user_name: req.user.name, details: { to: to.join(', '), file: cert.file_name }, ip: req.ip });
    res.json({ success: true, sent_to: to.join(', ') });
  } catch (err) {
    console.error('COI email error:', err);
    res.status(500).json({ error: 'Failed to send the certificate' });
  }
});

// A portal account has no address to send to: the certificate is uploaded into
// their compliance portal by hand. This records that it went, so the renewal
// checklist and the "sent" stamp mean the same thing for every account.
router.post('/certificates/:id/mark-submitted', requireManageCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cr = await pool.query('SELECT * FROM account_coi_certificates WHERE id = $1', [id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    await pool.query('UPDATE account_coi_certificates SET sent_at = NOW(), sent_to = $1, sent_by = $2, sent_by_name = $3 WHERE id = $4',
      ['Submitted through the portal', req.user.id, req.user.name, id]);
    await pool.query(
      "UPDATE coi_renewal_items i SET status = 'sent', sent_at = NOW(), certificate_id = $1, updated_at = NOW() " +
      "FROM coi_renewal_cycles c WHERE i.cycle_id = c.id AND c.status = 'open' " +
      "AND i.account_id = $2 AND i.status <> 'confirmed'", [id, cr.rows[0].account_id]
    );
    logAudit({ entity_type: 'coi', entity_id: cr.rows[0].account_id, action: 'certificate_submitted_portal',
      user_id: req.user.id, user_name: req.user.name, details: { file: cr.rows[0].file_name }, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error('COI mark-submitted error:', err);
    res.status(500).json({ error: 'Failed to record the submission' });
  }
});

// ---- our own policy -------------------------------------------------------

router.get('/policy', requireViewCoi, async function (req, res) {
  res.json(await readPolicy());
});

router.put('/policy', requireManageCoi, async function (req, res) {
  try {
    const b = req.body || {};
    const clean = {
      named_insured: str(b.named_insured, 255),
      address: str(b.address, 500),
      carrier: str(b.carrier, 255),
      agency: str(b.agency, 255),
      agent_name: str(b.agent_name, 255),
      agent_email: str(b.agent_email, 255),
      agent_phone: str(b.agent_phone, 60),
      policy_gl: str(b.policy_gl, 120),
      policy_auto: str(b.policy_auto, 120),
      policy_umbrella: str(b.policy_umbrella, 120),
      policy_wc: str(b.policy_wc, 120),
      policy_effective: dateOnly(b.policy_effective),
      policy_expires: dateOnly(b.policy_expires)
    };
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('coi_policy', $1, NOW()) " +
      'ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()', [JSON.stringify(clean)]
    );
    logAudit({ entity_type: 'coi', action: 'policy_saved', user_id: req.user.id, user_name: req.user.name, ip: req.ip });
    res.json({ success: true, policy: clean });
  } catch (err) {
    console.error('COI policy save error:', err);
    res.status(500).json({ error: 'Failed to save the policy details' });
  }
});

// ---- renewal cycles -------------------------------------------------------

router.get('/cycles', requireViewCoi, async function (req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT c.*, ' +
      '  (SELECT COUNT(*)::int FROM coi_renewal_items i WHERE i.cycle_id = c.id) AS total, ' +
      "  (SELECT COUNT(*)::int FROM coi_renewal_items i WHERE i.cycle_id = c.id AND i.status = 'confirmed') AS confirmed " +
      'FROM coi_renewal_cycles c ORDER BY c.id DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('COI cycles error:', err);
    res.status(500).json({ error: 'Failed to load renewal cycles' });
  }
});

// Open a cycle. This SNAPSHOTS the accounts that require a certificate right
// now; off-cycle accounts (their own contract date, not our policy date) are
// deliberately left out of the batch.
router.post('/cycles', requireManageCoi, async function (req, res) {
  try {
    const open = await pool.query("SELECT id, name FROM coi_renewal_cycles WHERE status = 'open' LIMIT 1");
    if (open.rows.length) return res.status(409).json({ error: 'A renewal cycle is already open: ' + open.rows[0].name + '. Close it before starting another.' });
    const b = req.body || {};
    const name = str(b.name, 120) || 'Renewal';
    const { rows } = await pool.query(
      'INSERT INTO coi_renewal_cycles (name, policy_effective, policy_expires, created_by, created_by_name) ' +
      'VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, dateOnly(b.policy_effective), dateOnly(b.policy_expires), req.user.id, req.user.name]
    );
    const cycle = rows[0];
    const ins = await pool.query(
      'INSERT INTO coi_renewal_items (cycle_id, account_id) ' +
      'SELECT $1, r.account_id FROM account_coi_requirements r ' +
      'WHERE r.coi_required = true AND r.off_cycle = false ' +
      'ON CONFLICT (cycle_id, account_id) DO NOTHING', [cycle.id]
    );
    logAudit({ entity_type: 'coi', entity_id: cycle.id, entity_number: name, action: 'cycle_opened',
      user_id: req.user.id, user_name: req.user.name, details: { accounts: ins.rowCount }, ip: req.ip });
    res.json({ success: true, cycle: cycle, accounts: ins.rowCount });
  } catch (err) {
    console.error('COI cycle create error:', err);
    res.status(500).json({ error: 'Failed to start the renewal cycle' });
  }
});

router.get('/cycles/:id', requireViewCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cy = await pool.query('SELECT * FROM coi_renewal_cycles WHERE id = $1', [id]);
    if (!cy.rows.length) return res.status(404).json({ error: 'Renewal cycle not found' });
    const it = await pool.query(
      'SELECT i.*, v.name AS account_name, r.submit_method, r.submit_emails, r.submit_portal_url, ' +
      '       c.file_name, c.expires_on, c.mismatch ' +
      'FROM coi_renewal_items i ' +
      'JOIN vendors v ON v.id = i.account_id ' +
      'LEFT JOIN account_coi_requirements r ON r.account_id = i.account_id ' +
      'LEFT JOIN account_coi_certificates c ON c.id = i.certificate_id ' +
      'WHERE i.cycle_id = $1 ORDER BY v.name ASC', [id]
    );
    const items = it.rows.map(certDates);
    const off = await pool.query(
      'SELECT v.id AS account_id, v.name AS account_name, r.submit_method, c.expires_on, c.mismatch ' +
      'FROM account_coi_requirements r JOIN vendors v ON v.id = r.account_id ' +
      'LEFT JOIN (' + CURRENT_CERT_SQL + ') c ON c.account_id = r.account_id ' +
      'WHERE r.coi_required = true AND r.off_cycle = true ORDER BY v.name ASC'
    );
    res.json({
      cycle: cy.rows[0],
      items: items,
      off_cycle: off.rows.map(certDates),
      policy: await readPolicy(),
      can_manage: await canManage(req)
    });
  } catch (err) {
    console.error('COI cycle detail error:', err);
    res.status(500).json({ error: 'Failed to load the renewal cycle' });
  }
});

router.put('/cycles/:id/items/:itemId', requireManageCoi, async function (req, res) {
  try {
    const cycleId = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);
    const status = String(req.body.status || '').trim();
    if (ITEM_STATUSES.indexOf(status) === -1) return res.status(400).json({ error: 'Unknown status' });
    const ir = await pool.query('SELECT * FROM coi_renewal_items WHERE id = $1 AND cycle_id = $2', [itemId, cycleId]);
    if (!ir.rows.length) return res.status(404).json({ error: 'Checklist row not found' });
    var sets = ['status = $1', 'updated_at = NOW()'];
    var vals = [status];
    if (status === 'requested' && !ir.rows[0].requested_at) sets.push('requested_at = NOW()');
    if (status === 'sent' && !ir.rows[0].sent_at) sets.push('sent_at = NOW()');
    if (status === 'confirmed') sets.push('confirmed_at = NOW()');
    if (req.body.notes !== undefined) { vals.push(str(req.body.notes, 1000)); sets.push('notes = $' + vals.length); }
    vals.push(itemId);
    await pool.query('UPDATE coi_renewal_items SET ' + sets.join(', ') + ' WHERE id = $' + vals.length, vals);
    const fresh = await pool.query('SELECT * FROM coi_renewal_items WHERE id = $1', [itemId]);
    res.json({ success: true, item: fresh.rows[0] });
  } catch (err) {
    console.error('COI item update error:', err);
    res.status(500).json({ error: 'Failed to update the checklist' });
  }
});

// Mark every account on the cycle as requested in one go, for the moment the
// packet actually goes to the agent.
router.post('/cycles/:id/mark-requested', requireManageCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      "UPDATE coi_renewal_items SET status = 'requested', requested_at = COALESCE(requested_at, NOW()), updated_at = NOW() " +
      "WHERE cycle_id = $1 AND status = 'needed'", [id]
    );
    res.json({ success: true, updated: r.rowCount });
  } catch (err) {
    console.error('COI mark-requested error:', err);
    res.status(500).json({ error: 'Failed to update the checklist' });
  }
});

router.post('/cycles/:id/close', requireManageCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query("UPDATE coi_renewal_cycles SET status = 'closed', closed_at = NOW() WHERE id = $1", [id]);
    logAudit({ entity_type: 'coi', entity_id: id, action: 'cycle_closed', user_id: req.user.id, user_name: req.user.name, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error('COI cycle close error:', err);
    res.status(500).json({ error: 'Failed to close the cycle' });
  }
});

// ---- the agent packet -----------------------------------------------------

async function packetData(cycleId) {
  const cy = await pool.query('SELECT * FROM coi_renewal_cycles WHERE id = $1', [cycleId]);
  if (!cy.rows.length) return null;
  const rows = await pool.query(
    'SELECT i.status, v.name AS account_name, r.* ' +
    'FROM coi_renewal_items i JOIN vendors v ON v.id = i.account_id ' +
    'LEFT JOIN account_coi_requirements r ON r.account_id = i.account_id ' +
    'WHERE i.cycle_id = $1 ORDER BY v.name ASC', [cycleId]
  );
  return { cycle: cy.rows[0], accounts: rows.rows, policy: await readPolicy() };
}

// Collect the PDF into a Buffer rather than streaming it. The browser has to
// send the JWT as a header, which a plain window.open cannot do, so the packet
// comes back as base64 in a normal authenticated call and is turned into a
// download client-side. Putting the token in a URL instead would leak it into
// history and logs.
function packetBuffer(data) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var sink = {
      write: function (c) { chunks.push(Buffer.from(c)); return true; },
      end: function (c) { if (c) chunks.push(Buffer.from(c)); resolve(Buffer.concat(chunks)); },
      on: function () { return sink; }, once: function () { return sink; },
      emit: function () {}, removeListener: function () { return sink; }
    };
    try { buildPacketPdf(data, sink); } catch (e) { reject(e); }
  });
}

router.get('/cycles/:id/packet', requireViewCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const data = await packetData(id);
    if (!data) return res.status(404).json({ error: 'Renewal cycle not found' });
    const buf = await packetBuffer(data);
    await pool.query('UPDATE coi_renewal_cycles SET packet_generated_at = NOW() WHERE id = $1', [id]);
    res.json({
      data: buf.toString('base64'),
      mime: 'application/pdf',
      filename: 'COI-request-packet-' + String(data.cycle.name || 'renewal').replace(/[^A-Za-z0-9._-]+/g, '-') + '.pdf'
    });
  } catch (err) {
    console.error('COI packet error:', err);
    res.status(500).json({ error: 'Failed to build the packet' });
  }
});

// Email the packet straight to the agent, so the renewal starts without anyone
// downloading and re-attaching it.
router.post('/cycles/:id/email-packet', requireManageCoi, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const data = await packetData(id);
    if (!data) return res.status(404).json({ error: 'Renewal cycle not found' });
    const to = parseEmails(req.body.to !== undefined ? req.body.to : (data.policy.agent_email || ''));
    if (!to.length) return res.status(400).json({ error: 'No valid agent address. Add one under the policy details, or type one here.' });
    const buf = await packetBuffer(data);
    const count = data.accounts.length;
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6">' +
      '<p>Hello,</p>' +
      '<p>Attached is our certificate request packet for the ' + escEmail(data.cycle.name) + ' policy year: ' +
      count + ' certificate' + (count === 1 ? '' : 's') + ', each with the holder details, required limits and wording that account requires.</p>' +
      (str(req.body.message, 2000) ? ('<p>' + escEmail(str(req.body.message, 2000)).replace(/\n/g, '<br>') + '</p>') : '') +
      '<p>Thank you,<br>' + escEmail(req.user.name) + '<br>Lock and Roll LLC</p></div>';
    await sendEmail(to, 'Certificate request packet - Lock and Roll LLC (' + data.cycle.name + ')', html, req.user.email || null,
      [{ filename: 'COI-request-packet.pdf', content: buf.toString('base64'), content_type: 'application/pdf' }]);
    await pool.query('UPDATE coi_renewal_cycles SET packet_generated_at = NOW() WHERE id = $1', [id]);
    logAudit({ entity_type: 'coi', entity_id: id, action: 'packet_emailed', user_id: req.user.id, user_name: req.user.name, details: { to: to.join(', ') }, ip: req.ip });
    res.json({ success: true, sent_to: to.join(', ') });
  } catch (err) {
    console.error('COI packet email error:', err);
    res.status(500).json({ error: 'Failed to email the packet' });
  }
});

module.exports = router;
