// Separation Agreement - the document the departing person actually signs.
//
// Before this existed, the offboarding checklist had a step called "Collect
// signed exit documentation" that was a checkbox and a note box. There was
// nowhere in Nova to sign anything, and no record afterwards beyond whatever
// somebody typed in the note. This is that missing surface.
//
// Two routers, mounted separately in server.js (same shape as the signatures and
// releases modules):
//   router  - staff, behind requireAuth + a permission
//   pub     - the departing employee, holding nothing but a single-use token
//
// The token link matters more here than anywhere else in Nova: by the time this
// is signed, the person's Nova login is usually switched off (the revoke job in
// jobs/offboarding.js), so "just log in and sign it" is not available. The link
// is emailed to whatever address the manager types, which is normally a personal
// one, because the work address is disabled at the same moment.
//
// The document itself is DRAWN by utils/separationPdf.js from this row, so what
// the manager fills in is exactly what the employee signs. Two signers in order:
// the employee through the token link (or in person on the manager's device),
// then the manager named on the form, inside Nova.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const r2 = require('../utils/r2');
const sepPdf = require('../utils/separationPdf');
const sepUtil = require('../utils/separation');
// The posted receipt lines are printed onto the document, so the agreement reads
// them; it never writes them. routes/property.js owns that table.
const property = require('./property');
// One copy of the org-tree rule, not two. routes/offboarding.js owns it because
// that is where the tree scoping for this whole area is defined; requiring it
// here is one-directional (offboarding does not require this file back).
const { canReachUser } = require('./offboarding');

const router = express.Router();
const pub = express.Router();

const DEFAULT_EXPIRY_DAYS = sepUtil.DEFAULT_EXPIRY_DAYS;
const TERMINAL = sepUtil.TERMINAL;
const esc = sepUtil.esc;
const mdy = sepUtil.mdy;
const missingForSend = sepUtil.missingForSend;
const tokenError = sepUtil.tokenError;
const canCountersign = sepUtil.canCountersign;

// ---------------------------------------------------------------- helpers

function clientIp(req) {
  if (!req || !req.headers) return '';
  const xf = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return (xf || req.ip || '').toString().slice(0, 64);
}

// Append one row to the audit trail. Fails quiet: an agreement must never fail
// to send because the log insert did.
async function logEvent(agreementId, type, actor, req, detail) {
  try {
    await pool.query(
      'INSERT INTO separation_events (agreement_id, event_type, actor, ip, user_agent, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [agreementId, type, actor || null, clientIp(req),
       (req && req.headers && req.headers['user-agent'] || '').toString().slice(0, 1000) || null,
       detail ? JSON.stringify(detail) : null]
    );
  } catch (e) { console.error('[separation] event log:', e.message); }
}

// The offboarding record's own activity feed, so somebody reading the
// offboarding sees the agreement move without opening it.
async function logOffboardingEvent(offboardingId, actorId, kind, detail) {
  try {
    await pool.query(
      'INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at) VALUES ($1,$2,$3,$4,NOW())',
      [offboardingId, actorId || null, kind, JSON.stringify(detail || {})]
    );
  } catch (e) { console.error('[separation] offboarding event:', e.message); }
}

// Year-sequenced, e.g. SEP-2026-0001.
async function generateAgreementNumber() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(agreement_number, '-', 3) AS INTEGER)) AS maxseq FROM separation_agreements WHERE agreement_number LIKE $1",
    ['SEP-' + year + '-%']
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'SEP-' + year + '-' + seq;
}

async function settingsMap(keys) {
  const out = {};
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [keys]);
    rows.forEach(function (r) { out[r.key] = r.value; });
  } catch (e) { console.error('[separation] settings:', e.message); }
  return out;
}

// The wording on the form. Seeded into settings on first use so it can be
// revised - by a lawyer, ideally - without a deploy; a single agreement can
// still override it before sending. See the long note at the top of
// utils/separationPdf.js about what the shipped default does and does not say.
async function defaultBody() {
  const s = await settingsMap(['separation_body_default']);
  if (s.separation_body_default && String(s.separation_body_default).trim()) return s.separation_body_default;
  try {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('separation_body_default', $1) ON CONFLICT (key) DO NOTHING",
      [sepPdf.DEFAULT_SEPARATION_BODY]
    );
  } catch (e) { console.error('[separation] seed body:', e.message); }
  return sepPdf.DEFAULT_SEPARATION_BODY;
}

async function companyInfo() {
  const s = await settingsMap(['company_name', 'logo']);
  return { name: s.company_name || 'Lock and Roll LLC', logo: s.logo || null };
}

function sepLink(token) {
  return (process.env.APP_URL || '').replace(/\/$/, '') + '/separation/' + token;
}

// The agreement plus the offboarding facts it hangs off. employee_name and
// last_day live on the JOIN rather than being copied onto the row, so editing
// the offboarding's last day does not silently leave a stale date on an unsent
// agreement. They ARE snapshotted into facts at send time - see /send.
async function loadAgreement(id) {
  const { rows } = await pool.query(
    'SELECT a.*, o.last_day, o.type AS separation_type, o.final_check_date AS ob_final_check_date, ' +
    '       o.status AS offboarding_status, o.contact_email, u.name AS employee_name, u.title AS job_title, ' +
    '       u.email AS work_email, c.name AS created_by_name, ' +
    '       pr.id AS receipt_id, pr.status AS receipt_status, pr.receipt_number, ' +
    '       pr.nothing_to_return, pr.posted_at AS receipt_posted_at ' +
    'FROM separation_agreements a ' +
    'JOIN offboardings o ON o.id = a.offboarding_id ' +
    'JOIN users u ON u.id = a.user_id ' +
    'LEFT JOIN users c ON c.id = a.created_by ' +
    'LEFT JOIN property_receipts pr ON pr.offboarding_id = a.offboarding_id ' +
    'WHERE a.id = $1',
    [id]
  );
  return rows.length ? rows[0] : null;
}

async function loadAgreementByToken(token) {
  if (!sepUtil.isValidToken(token)) return null;
  const { rows } = await pool.query(
    'SELECT a.*, o.last_day, o.final_check_date AS ob_final_check_date, ' +
    '       u.name AS employee_name, u.title AS job_title, ' +
    '       pr.id AS receipt_id, pr.status AS receipt_status, pr.nothing_to_return, ' +
    '       pr.posted_at AS receipt_posted_at ' +
    'FROM separation_agreements a ' +
    'JOIN offboardings o ON o.id = a.offboarding_id ' +
    'JOIN users u ON u.id = a.user_id ' +
    'LEFT JOIN property_receipts pr ON pr.offboarding_id = a.offboarding_id ' +
    'WHERE a.employee_token = $1',
    [token]
  );
  return rows.length ? rows[0] : null;
}

// Store a signature PNG in R2 and return its key. Validates hard, because this
// value arrives from a page anyone holding the link can open.
async function putSignature(agreementId, who, dataUrl) {
  if (!r2.configured()) throw new Error('File storage is not configured.');
  const bad = sepUtil.checkSignatureDataUrl(dataUrl);
  if (bad) throw new Error(bad);
  const buf = Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
  const key = 'separation/' + agreementId + '/' + who + '-sig-' + Date.now() + '.png';
  await r2.putObject(key, buf, 'image/png');
  return key;
}

async function sigBuffer(key) {
  if (!key) return null;
  try { return await r2.getObjectBuffer(key); }
  catch (e) { console.error('[separation] sig fetch:', e.message); return null; }
}

async function eventsFor(agreementId) {
  const { rows } = await pool.query(
    'SELECT * FROM separation_events WHERE agreement_id = $1 ORDER BY created_at ASC, id ASC',
    [agreementId]
  );
  return rows;
}

// Tick the checklist step this agreement stands for. The step is matched on
// auto_key, never on its title - a manager can rename a step in Setup, and a
// renamed step must not quietly stop being satisfied. Fails quiet: a signature
// that has already been given must not be undone by a checklist write.
async function completeChecklistStep(offboardingId, agreement) {
  try {
    await pool.query(
      "UPDATE offboarding_steps SET status = 'done', completed_at = NOW(), evidence = $2 " +
      "WHERE offboarding_id = $1 AND auto_key = 'separation_agreement' AND status <> 'done'",
      [offboardingId, JSON.stringify({
        note: 'Separation agreement ' + agreement.agreement_number + ' signed by both parties.',
        agreement_id: agreement.id,
        r2_keys: agreement.signed_r2_key ? [agreement.signed_r2_key] : []
      })]
    );
  } catch (e) { console.error('[separation] step complete:', e.message); }
}

// Build the finished PDF, store it, and put it where it belongs: on the record,
// on the checklist, in the Documents vault, and in both parties' inboxes. Every
// side effect gets its own try/catch - a failed vault drop must not undo a
// signature that has already been given.
async function finalize(agreementId) {
  const agr = await loadAgreement(agreementId);
  if (!agr) return;
  const company = await companyInfo();
  const body = await defaultBody();
  const events = await eventsFor(agreementId);
  const empSig = await sigBuffer(agr.employee_sig_r2_key);
  const repSig = await sigBuffer(agr.rep_sig_r2_key);

  const propertyLines = agr.receipt_id ? await property.linesFor(agr.receipt_id) : [];
  const withBody = Object.assign({}, agr, { terms_body: agr.terms_body || body });
  const buf = await sepPdf.buildSeparationPdf(withBody, events, {
    company: company, logo: company.logo, employeeSig: empSig, repSig: repSig,
    property: sepUtil.propertyView(propertyLines),
    propertyTotals: sepUtil.propertyTotals(propertyLines)
  });

  const key = 'separation/' + agr.id + '/' + agr.agreement_number + '-signed.pdf';
  await r2.putObject(key, buf, 'application/pdf');
  await pool.query(
    "UPDATE separation_agreements SET signed_r2_key = $1, status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $2",
    [key, agr.id]
  );
  await logEvent(agr.id, 'completed', null, null, { signed_key: key });
  await logOffboardingEvent(agr.offboarding_id, agr.rep_user_id,
    'separation_agreement_completed', { agreement_number: agr.agreement_number });
  await completeChecklistStep(agr.offboarding_id, Object.assign({}, agr, { signed_r2_key: key }));

  // Documents vault, owned by whoever started the agreement.
  try {
    const creator = (await pool.query('SELECT name FROM users WHERE id = $1', [agr.created_by])).rows[0] || {};
    let folderId = null;
    const sf = await pool.query(
      "SELECT id FROM document_folders WHERE name = 'Signed Documents' AND owner_id = $1 AND parent_id IS NULL",
      [agr.created_by]
    );
    if (sf.rows.length) folderId = sf.rows[0].id;
    else {
      const nsf = await pool.query(
        "INSERT INTO document_folders (name, parent_id, owner_id, owner_name) VALUES ('Signed Documents', NULL, $1, $2) RETURNING id",
        [agr.created_by, creator.name || null]
      );
      folderId = nsf.rows[0].id;
    }
    await pool.query(
      'INSERT INTO documents (name, folder_id, r2_key, mime_type, size_bytes, status, owner_id, owner_name) ' +
      "VALUES ($1,$2,$3,'application/pdf',$4,'ready',$5,$6) ON CONFLICT (r2_key) DO NOTHING",
      ['Separation Agreement ' + agr.agreement_number + ' (' + (agr.employee_name || '') + ').pdf',
       folderId, key, buf.length, agr.created_by, creator.name || null]
    );
  } catch (e) { console.error('[separation] vault drop:', e.message); }

  // Both parties get the finished document. The employee copy goes to the
  // address the link went to, which is the one they can still read.
  try {
    const rep = (await pool.query('SELECT email FROM users WHERE id = $1', [agr.rep_user_id])).rows[0] || {};
    const to = [];
    if (agr.employee_email) to.push(agr.employee_email);
    if (rep.email) to.push(rep.email);
    if (to.length) {
      const html = emailTemplate({
        badge: 'Completed', badgeColor: 'green',
        title: 'Separation agreement completed',
        body: 'The separation agreement for ' + esc(agr.employee_name) + ' has been signed by both parties. ' +
              'A copy is attached for your records.',
        details: [{ label: 'Reference', value: agr.agreement_number },
                  { label: 'Last day', value: mdy(agr.last_day) }],
        footerNote: 'Keep this document. It is the record of the separation.',
        brand: company.name
      });
      await sendEmail(to, 'Completed: separation agreement ' + agr.agreement_number, html, null,
        [{ filename: agr.agreement_number + '-signed.pdf', content: buf.toString('base64') }]);
    }
  } catch (e) { console.error('[separation] completion email:', e.message); }
}

// Tell the named manager the employee has signed and it is their turn.
async function notifyRep(agreementId) {
  try {
    const agr = await loadAgreement(agreementId);
    if (!agr || !agr.rep_user_id) return;
    const u = (await pool.query('SELECT name, email, phone, receive_sms FROM users WHERE id = $1', [agr.rep_user_id])).rows[0];
    if (!u) return;
    const company = await companyInfo();
    const url = (process.env.APP_URL || '').replace(/\/$/, '') + '/?view=offboarding-detail&id=' + agr.offboarding_id;
    if (u.email) {
      const html = emailTemplate({
        badge: 'Your signature needed', badgeColor: 'orange',
        title: 'A separation agreement is waiting on your countersignature',
        body: esc(agr.employee_name) + ' has signed ' + esc(agr.agreement_number) + '. ' +
              'The offboarding cannot be finalized until it is countersigned.',
        details: [{ label: 'Employee', value: agr.employee_name || '' },
                  { label: 'Last day', value: mdy(agr.last_day) }],
        buttonText: 'Open and countersign', buttonUrl: url,
        footerNote: 'Automated Nova notification.', brand: company.name
      });
      await sendEmail(u.email, 'Countersignature needed: ' + agr.agreement_number, html);
    }
    if (u.phone && u.receive_sms) {
      try {
        await sendSms(u.phone, agr.employee_name + ' signed separation agreement ' +
          agr.agreement_number + '. Your countersignature is needed: ' + url);
      } catch (e) {}
    }
  } catch (e) { console.error('[separation] notify rep:', e.message); }
}

// Email the employee their single-use link.
async function notifyEmployee(agr, company, message, fromUser) {
  const link = sepLink(agr.employee_token);
  if (!agr.employee_email) return;
  const html = emailTemplate({
    badge: 'Signature requested', badgeColor: 'orange',
    title: 'Please review and sign your separation agreement',
    body: 'Hi ' + esc(String(agr.employee_name || 'there').split(' ')[0]) + ',<br><br>' +
          (message ? (esc(message) + '<br><br>') : '') +
          'Please review the agreement below and sign it electronically. It takes about a minute on your phone. ' +
          'A signed copy is emailed to you once it is countersigned.',
    details: [{ label: 'Reference', value: agr.agreement_number },
              { label: 'Last day', value: mdy(agr.last_day) }],
    buttonText: 'Review and sign', buttonUrl: link,
    footerNote: 'This is a secure, single-use link. Please do not forward it.',
    brand: company.name
  });
  await sendEmail(agr.employee_email, 'Please sign: separation agreement ' + agr.agreement_number, html, null, null,
    (fromUser && fromUser.email) ? { replyTo: fromUser.email } : null);
}

// Every staff route that touches one agreement runs this first. Returns the row
// or sends the response itself, so callers read as: load, then act.
async function loadForStaff(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!(id > 0)) { res.status(400).json({ error: 'Bad id' }); return null; }
  const agr = await loadAgreement(id);
  if (!agr) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!(await canReachUser(req.user, agr.user_id))) {
    res.status(403).json({ error: 'This person is outside your team.' });
    return null;
  }
  return agr;
}

// ---------------------------------------------------------------- staff API

// GET /api/separation/by-offboarding/:obId - the agreement for one offboarding,
// or null. This is what the offboarding detail screen calls to draw its card.
router.get('/by-offboarding/:obId', requireAuth, requirePermission('view_offboarding'), async function (req, res) {
  try {
    const obId = parseInt(req.params.obId, 10);
    if (!(obId > 0)) return res.status(400).json({ error: 'Bad id' });
    const ob = (await pool.query('SELECT id, user_id FROM offboardings WHERE id = $1', [obId])).rows[0];
    if (!ob) return res.status(404).json({ error: 'Not found' });
    if (!(await canReachUser(req.user, ob.user_id))) {
      return res.status(403).json({ error: 'This person is outside your team.' });
    }
    const row = (await pool.query('SELECT id FROM separation_agreements WHERE offboarding_id = $1', [obId])).rows[0];
    if (!row) return res.json({ agreement: null, default_body: await defaultBody() });
    const agr = await loadAgreement(row.id);
    const events = await eventsFor(row.id);
    res.json({
      agreement: agr,
      events: events,
      can_countersign: canCountersign(agr, req.user),
      receipt_blocker: sepUtil.receiptBlocker(agr),
      link: agr.employee_token ? sepLink(agr.employee_token) : null,
      default_body: await defaultBody()
    });
  } catch (e) {
    console.error('GET /separation/by-offboarding:', e.message);
    res.status(500).json({ error: 'Failed to load agreement' });
  }
});

// GET /api/separation/signers - who can be named as the countersigner. Managers
// and above only: this is the Company's side of the signature, not a field that
// should offer the whole staff list. Declared BEFORE '/:id' so it is not
// shadowed by it.
router.get('/signers', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, title, role FROM users WHERE active = true AND role IN ('manager','admin','owner') ORDER BY name ASC"
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /separation/signers:', e.message);
    res.status(500).json({ error: 'Failed to load signers' });
  }
});

// POST /api/separation - start the agreement for an offboarding, pre-filled from
// the record. One per offboarding, enforced by a unique index as well as here.
router.post('/', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const obId = parseInt(req.body && req.body.offboarding_id, 10);
    if (!(obId > 0)) return res.status(400).json({ error: 'offboarding_id is required' });
    const ob = (await pool.query(
      'SELECT o.*, u.name AS employee_name, u.email AS work_email FROM offboardings o JOIN users u ON u.id = o.user_id WHERE o.id = $1',
      [obId]
    )).rows[0];
    if (!ob) return res.status(404).json({ error: 'Offboarding not found' });
    if (!(await canReachUser(req.user, ob.user_id))) {
      return res.status(403).json({ error: 'This person is outside your team.' });
    }
    const existing = (await pool.query('SELECT id FROM separation_agreements WHERE offboarding_id = $1', [obId])).rows[0];
    if (existing) return res.json({ id: existing.id, existed: true });

    // Who countersigns, by default: the person creating it. They can change it
    // before sending, and only the named person (or admin/owner) may sign.
    const me = (await pool.query('SELECT name, title FROM users WHERE id = $1', [req.user.id])).rows[0] || {};
    const body = await defaultBody();
    const number = await generateAgreementNumber();
    const ins = await pool.query(
      'INSERT INTO separation_agreements ' +
      '(offboarding_id, user_id, agreement_number, status, terms_body, final_check_date, pto_payout_hours, ' +
      ' employee_email, rep_user_id, rep_name, rep_title, created_by) ' +
      "VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
      [obId, ob.user_id, number, body, ob.final_check_date || null, ob.pto_balance_snapshot || 0,
       ob.contact_email || ob.work_email || null, req.user.id, me.name || req.user.name || null, me.title || null, req.user.id]
    );
    const id = ins.rows[0].id;
    await logEvent(id, 'created', req.user.name, req, { offboarding_id: obId });
    await logOffboardingEvent(obId, req.user.id, 'separation_agreement_created', { agreement_number: number });
    res.status(201).json({ id: id, agreement_number: number });
  } catch (e) {
    console.error('POST /separation:', e.message);
    res.status(500).json({ error: 'Failed to create agreement' });
  }
});

// PUT /api/separation/:id - edit the draft. Still editable after sending, on
// purpose: the commonest fix at this point is a mistyped personal email address,
// and the alternative is withdrawing and starting again over a typo. The public
// page reads the wording live, so an edit is seen rather than hidden - and every
// edit sits in the audit trail either way. Locked the moment the employee signs:
// the wording they agreed to is the wording that gets countersigned.
router.put('/:id', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const agr = await loadForStaff(req, res);
    if (!agr) return;
    if (agr.status !== 'draft' && agr.status !== 'sent') {
      return res.status(400).json({ error: 'This agreement can no longer be edited.' });
    }
    const b = req.body || {};
    let repUserId = agr.rep_user_id, repName = agr.rep_name, repTitle = agr.rep_title;
    if (b.rep_user_id != null) {
      const rid = parseInt(b.rep_user_id, 10);
      const r = (await pool.query('SELECT id, name, title FROM users WHERE id = $1', [rid])).rows[0];
      if (!r) return res.status(400).json({ error: 'That countersigner is not a Nova user.' });
      repUserId = r.id; repName = r.name; repTitle = r.title || null;
    }
    if (b.rep_title != null) repTitle = String(b.rep_title).slice(0, 120);

    const sev = (b.severance_amount === '' || b.severance_amount == null) ? null : Number(b.severance_amount);
    if (sev != null && (!isFinite(sev) || sev < 0)) return res.status(400).json({ error: 'Separation pay must be a number.' });
    const pto = (b.pto_payout_hours === '' || b.pto_payout_hours == null) ? agr.pto_payout_hours : Number(b.pto_payout_hours);
    if (pto != null && (!isFinite(pto) || pto < 0)) return res.status(400).json({ error: 'Time off hours must be a number.' });

    await pool.query(
      'UPDATE separation_agreements SET terms_body = $1, severance_amount = $2, pto_payout_hours = $3, ' +
      'property_notes = $4, final_check_date = $5, employee_email = $6, rep_user_id = $7, rep_name = $8, ' +
      'rep_title = $9, updated_at = NOW() WHERE id = $10',
      [b.terms_body != null ? String(b.terms_body) : agr.terms_body,
       sev,
       pto,
       b.property_notes != null ? String(b.property_notes).slice(0, 2000) : agr.property_notes,
       b.final_check_date || agr.final_check_date || null,
       b.employee_email != null ? String(b.employee_email).trim().slice(0, 255) : agr.employee_email,
       repUserId, repName, repTitle, agr.id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PUT /separation/:id:', e.message);
    res.status(500).json({ error: 'Failed to save agreement' });
  }
});

// POST /api/separation/:id/send - mint a single-use token and email the link.
router.post('/:id/send', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const agr = await loadForStaff(req, res);
    if (!agr) return;
    if (TERMINAL.indexOf(agr.status) !== -1) return res.status(400).json({ error: 'This agreement is closed.' });
    if (agr.status === 'employee_signed') return res.status(400).json({ error: 'They have already signed it.' });
    if (!r2.configured()) {
      return res.status(503).json({ error: 'File storage is not configured yet (R2_* env vars), so a signature could not be saved.' });
    }
    const missing = missingForSend(agr);
    if (missing.length) return res.status(400).json({ error: 'Fill these in first: ' + missing.join(', ') + '.', missing: missing });
    const rcpBlocked = sepUtil.receiptBlocker(agr);
    if (rcpBlocked) return res.status(400).json({ error: rcpBlocked, needs_receipt: true });

    // The address is the whole delivery mechanism here, so it is checked rather
    // than assumed - by now their work mailbox is usually gone. Falls back to the
    // offboarding's contact_email, which is the one field this is asked for in.
    const email = String((req.body && req.body.email) || agr.employee_email || agr.contact_email || '').trim();
    if (!sepUtil.looksLikeEmail(email)) {
      return res.status(400).json({ error: 'A working email address is needed. Their work address is usually switched off by now, so use a personal one.' });
    }

    const days = Math.min(60, Math.max(1, parseInt((req.body && req.body.expiry_days) || DEFAULT_EXPIRY_DAYS, 10) || DEFAULT_EXPIRY_DAYS));
    const expires = new Date(Date.now() + days * 86400000);
    const token = crypto.randomBytes(32).toString('hex');

    // Snapshot the facts as they stood when the link was sent. The PDF is drawn
    // from the live JOIN, but this is the answer to "what did we show them?" if
    // the offboarding's dates are edited afterwards.
    const facts = {
      employee_name: agr.employee_name, job_title: agr.job_title, last_day: agr.last_day,
      final_check_date: agr.final_check_date, pto_payout_hours: agr.pto_payout_hours,
      severance_amount: agr.severance_amount, property_notes: agr.property_notes,
      rep_name: agr.rep_name, rep_title: agr.rep_title
    };
    await pool.query(
      "UPDATE separation_agreements SET employee_token = $1, employee_token_expires_at = $2, employee_email = $3, " +
      "facts = $4, status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $5",
      [token, expires, email, JSON.stringify(facts), agr.id]
    );
    agr.employee_token = token;
    agr.employee_email = email;

    const company = await companyInfo();
    const message = (req.body && req.body.message) ? String(req.body.message).slice(0, 600) : '';
    const fromUser = (await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.id])).rows[0] || null;
    notifyEmployee(agr, company, message, fromUser)
      .catch(function (e) { console.error('[separation] notify:', e.message); });

    await logEvent(agr.id, 'sent', req.user.name, req, { to: email, expires_at: expires });
    await logOffboardingEvent(agr.offboarding_id, req.user.id, 'separation_agreement_sent', { to: email });
    res.json({ success: true, link: sepLink(token), expires_at: expires });
  } catch (e) {
    console.error('POST /separation/:id/send:', e.message);
    res.status(500).json({ error: 'Failed to send agreement' });
  }
});

// POST /api/separation/:id/remind - re-send the live link, unchanged.
router.post('/:id/remind', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const agr = await loadForStaff(req, res);
    if (!agr) return;
    if (agr.status !== 'sent' || !agr.employee_token) {
      return res.status(400).json({ error: 'There is no live signing link to resend.' });
    }
    const company = await companyInfo();
    notifyEmployee(agr, company, '', null).catch(function (e) { console.error('[separation] remind:', e.message); });
    await logEvent(agr.id, 'reminder_sent', req.user.name, req, { to: agr.employee_email });
    res.json({ success: true });
  } catch (e) {
    console.error('POST /separation/:id/remind:', e.message);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// POST /api/separation/:id/in-person - they sign on the manager's device on the
// last day. Same record, same audit trail; the event detail records who was
// holding the device, which is the honest description of what happened.
router.post('/:id/in-person', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const agr = await loadForStaff(req, res);
    if (!agr) return;
    if (agr.status !== 'draft' && agr.status !== 'sent') {
      return res.status(400).json({ error: 'This agreement is not open for signature.' });
    }
    const missing = missingForSend(agr);
    if (missing.length) return res.status(400).json({ error: 'Fill these in first: ' + missing.join(', ') + '.', missing: missing });
    // Signing in person is still signing: the property list has to be settled
    // first here too, or they put their name to a page that is still moving.
    const rcpBlockedIp = sepUtil.receiptBlocker(agr);
    if (rcpBlockedIp) return res.status(400).json({ error: rcpBlockedIp, needs_receipt: true });
    const printed = String((req.body && req.body.printed_name) || '').trim();
    if (!printed) return res.status(400).json({ error: 'They must type their printed name.' });
    const key = await putSignature(agr.id, 'employee', req.body && req.body.image);
    await pool.query(
      'UPDATE separation_agreements SET employee_sig_r2_key = $1, employee_printed_name = $2, employee_signed_at = NOW(), ' +
      "employee_signed_ip = $3, employee_consent = true, employee_token = NULL, status = 'employee_signed', updated_at = NOW() WHERE id = $4",
      [key, printed.slice(0, 255), clientIp(req), agr.id]
    );
    await logEvent(agr.id, 'consented', printed, req, { in_person: true, witnessed_by: req.user.name });
    await logEvent(agr.id, 'signed', printed, req, { in_person: true, witnessed_by: req.user.name });
    await logOffboardingEvent(agr.offboarding_id, req.user.id, 'separation_agreement_signed', { in_person: true });
    notifyRep(agr.id).catch(function (e) { console.error('[separation] rep notify:', e.message); });
    res.json({ success: true });
  } catch (e) {
    console.error('POST /separation/:id/in-person:', e.message);
    res.status(400).json({ error: e.message || 'Failed to record signature' });
  }
});

// POST /api/separation/:id/rep-sign - the countersignature, which completes it.
// Behind view_offboarding, not manage_offboarding: the gate that matters is
// canCountersign, because the signature belongs to the person named on the form.
router.post('/:id/rep-sign', requireAuth, requirePermission('view_offboarding'), async function (req, res) {
  try {
    const agr = await loadForStaff(req, res);
    if (!agr) return;
    if (!canCountersign(agr, req.user)) {
      return res.status(403).json({ error: 'Only ' + (agr.rep_name || 'the named manager') + ' can countersign this agreement.' });
    }
    if (agr.status !== 'employee_signed') {
      return res.status(400).json({
        error: agr.status === 'completed' ? 'This agreement is already complete.' : 'They have not signed it yet.'
      });
    }
    const key = await putSignature(agr.id, 'rep', req.body && req.body.image);
    await pool.query(
      'UPDATE separation_agreements SET rep_sig_r2_key = $1, rep_signed_at = NOW(), rep_signed_ip = $2, updated_at = NOW() WHERE id = $3',
      [key, clientIp(req), agr.id]
    );
    await logEvent(agr.id, 'countersigned', req.user.name, req, {});
    await finalize(agr.id);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /separation/:id/rep-sign:', e.message);
    res.status(400).json({ error: e.message || 'Failed to countersign' });
  }
});

// POST /api/separation/:id/void - kill the link and close the record. A completed
// agreement is never voided: it happened, and the PDF is the record of it.
router.post('/:id/void', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const agr = await loadForStaff(req, res);
    if (!agr) return;
    if (agr.status === 'completed') return res.status(400).json({ error: 'A completed agreement cannot be withdrawn.' });
    const reason = String((req.body && req.body.reason) || '').slice(0, 1000);
    await pool.query(
      "UPDATE separation_agreements SET status = 'voided', employee_token = NULL, declined_reason = $1, updated_at = NOW() WHERE id = $2",
      [reason || null, agr.id]
    );
    await logEvent(agr.id, 'voided', req.user.name, req, { reason: reason });
    await logOffboardingEvent(agr.offboarding_id, req.user.id, 'separation_agreement_voided', { reason: reason });
    res.json({ success: true });
  } catch (e) {
    console.error('POST /separation/:id/void:', e.message);
    res.status(500).json({ error: 'Failed to withdraw agreement' });
  }
});

// POST /api/separation/:id/reopen - put a declined or withdrawn agreement back
// to draft. There is one agreement row per offboarding (unique index), so
// without this a decline is a dead end that no amount of clicking gets out of.
// Signatures already given are cleared with it: reopening means the document is
// being changed, and a signature on the old wording must not survive onto the new.
router.post('/:id/reopen', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const agr = await loadForStaff(req, res);
    if (!agr) return;
    if (agr.status !== 'declined' && agr.status !== 'voided' && agr.status !== 'expired') {
      return res.status(400).json({ error: 'Only a declined or withdrawn agreement can be reopened.' });
    }
    await pool.query(
      "UPDATE separation_agreements SET status = 'draft', employee_token = NULL, employee_token_expires_at = NULL, " +
      'employee_sig_r2_key = NULL, employee_printed_name = NULL, employee_signed_at = NULL, employee_signed_ip = NULL, ' +
      'employee_consent = false, declined_reason = NULL, sent_at = NULL, updated_at = NOW() WHERE id = $1',
      [agr.id]
    );
    await logEvent(agr.id, 'created', req.user.name, req, { reopened: true, from_status: agr.status });
    res.json({ success: true });
  } catch (e) {
    console.error('POST /separation/:id/reopen:', e.message);
    res.status(500).json({ error: 'Failed to reopen agreement' });
  }
});

// GET /api/separation/:id/download - a short-lived link to the signed PDF.
router.get('/:id/download', requireAuth, requirePermission('view_offboarding'), async function (req, res) {
  try {
    const agr = await loadForStaff(req, res);
    if (!agr) return;
    if (!agr.signed_r2_key) return res.status(404).json({ error: 'Nothing signed yet.' });
    const url = await r2.presignDownload(agr.signed_r2_key, agr.agreement_number + '-signed.pdf', false, 300, 'application/pdf');
    res.json({ url: url });
  } catch (e) {
    console.error('GET /separation/:id/download:', e.message);
    res.status(500).json({ error: 'Failed to build download link' });
  }
});

// ---------------------------------------------------------------- public API
// No login and no JWT: the whole session is the token in the URL. Every route
// re-checks the token, because a link that was live when the page loaded can be
// dead by the time the signature arrives.

pub.get('/:token', async function (req, res) {
  try {
    const agr = await loadAgreementByToken(req.params.token);
    if (!agr) return res.status(404).json({ error: 'This link is not valid.' });
    const te = tokenError(agr);
    if (te) return res.status(te.code).json({ error: te.msg });
    const company = await companyInfo();
    const lines = agr.receipt_id ? await property.linesFor(agr.receipt_id) : [];
    await logEvent(agr.id, 'viewed', agr.employee_name, req, {});
    res.json({ agreement: sepUtil.publicView(agr, company.name, lines) });
  } catch (e) {
    console.error('GET /sep/:token:', e.message);
    res.status(500).json({ error: 'Could not load the agreement.' });
  }
});

pub.post('/:token/consent', async function (req, res) {
  try {
    const agr = await loadAgreementByToken(req.params.token);
    if (!agr) return res.status(404).json({ error: 'This link is not valid.' });
    const te = tokenError(agr);
    if (te) return res.status(te.code).json({ error: te.msg });
    await pool.query('UPDATE separation_agreements SET employee_consent = true, updated_at = NOW() WHERE id = $1', [agr.id]);
    await logEvent(agr.id, 'consented', agr.employee_name, req, {});
    res.json({ success: true });
  } catch (e) {
    console.error('POST /sep/:token/consent:', e.message);
    res.status(500).json({ error: 'Could not record consent.' });
  }
});

pub.post('/:token/submit', async function (req, res) {
  try {
    const agr = await loadAgreementByToken(req.params.token);
    if (!agr) return res.status(404).json({ error: 'This link is not valid.' });
    const te = tokenError(agr);
    if (te) return res.status(te.code).json({ error: te.msg });
    const printed = String((req.body && req.body.printed_name) || '').trim();
    if (!printed) return res.status(400).json({ error: 'Please type your printed name.' });
    if (!(req.body && req.body.consent)) return res.status(400).json({ error: 'Please agree to sign electronically.' });
    const key = await putSignature(agr.id, 'employee', req.body && req.body.image);
    // The token is burned here, not on view: one link, one signature.
    await pool.query(
      'UPDATE separation_agreements SET employee_sig_r2_key = $1, employee_printed_name = $2, employee_signed_at = NOW(), ' +
      "employee_signed_ip = $3, employee_consent = true, employee_token = NULL, status = 'employee_signed', updated_at = NOW() WHERE id = $4",
      [key, printed.slice(0, 255), clientIp(req), agr.id]
    );
    await logEvent(agr.id, 'signed', printed, req, {});
    await logOffboardingEvent(agr.offboarding_id, null, 'separation_agreement_signed', { in_person: false });
    notifyRep(agr.id).catch(function (e) { console.error('[separation] rep notify:', e.message); });
    res.json({ success: true, rep_name: agr.rep_name || null });
  } catch (e) {
    console.error('POST /sep/:token/submit:', e.message);
    res.status(400).json({ error: e.message || 'Could not record your signature.' });
  }
});

pub.post('/:token/decline', async function (req, res) {
  try {
    const agr = await loadAgreementByToken(req.params.token);
    if (!agr) return res.status(404).json({ error: 'This link is not valid.' });
    const te = tokenError(agr);
    if (te) return res.status(te.code).json({ error: te.msg });
    const reason = String((req.body && req.body.reason) || '').slice(0, 2000);
    await pool.query(
      "UPDATE separation_agreements SET status = 'declined', declined_reason = $1, employee_token = NULL, updated_at = NOW() WHERE id = $2",
      [reason || null, agr.id]
    );
    await logEvent(agr.id, 'declined', agr.employee_name, req, { reason: reason });
    await logOffboardingEvent(agr.offboarding_id, null, 'separation_agreement_declined', { reason: reason });
    // A decline is a person saying no to a document about the end of their job.
    // It goes to the named manager immediately rather than waiting to be noticed.
    try {
      const u = (await pool.query('SELECT email FROM users WHERE id = $1', [agr.rep_user_id])).rows[0];
      const company = await companyInfo();
      if (u && u.email) {
        await sendEmail(u.email, 'Declined: separation agreement ' + agr.agreement_number,
          emailTemplate({
            badge: 'Declined', badgeColor: 'red',
            title: 'A separation agreement was declined',
            body: esc(agr.employee_name) + ' declined to sign ' + esc(agr.agreement_number) + '.' +
                  (reason ? ('<br><br>They said: ' + esc(reason)) : ''),
            footerNote: 'Automated Nova notification.', brand: company.name
          }));
      }
    } catch (e) { console.error('[separation] decline notify:', e.message); }
    res.json({ success: true });
  } catch (e) {
    console.error('POST /sep/:token/decline:', e.message);
    res.status(500).json({ error: 'Could not record that.' });
  }
});

module.exports = router;
module.exports.publicRouter = pub;
