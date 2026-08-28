// Release of Liability - receipt of payment and release, sent to a customer
// after Nova pays for damage caused on a job.
//
// Two routers, mounted separately in server.js (see the signatures module for
// the same shape):
//   router  - staff, behind requireAuth + a permission
//   pub     - the customer, holding nothing but a single-use token
//
// The document itself is DRAWN by utils/releasePdf.js from the release_forms
// row, not uploaded, which is what lets a release open pre-filled from a
// complaint. Two signers in order: the claimant through the token link, then the
// representative named on the form, inside Nova.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const { logActivity } = require('../utils/feedbackIntake');
const r2 = require('../utils/r2');
const releasePdf = require('../utils/releasePdf');
const relUtil = require('../utils/release');

const router = express.Router();
const pub = express.Router();

// The lifecycle rules, the send gate, the token gate and the public projection
// all live in utils/release.js. They are pure, so test-release.js can exercise
// them directly instead of only through an HTTP round trip - and there is one
// copy of each rule rather than one here and one in a test.
const DEFAULT_EXPIRY_DAYS = relUtil.DEFAULT_EXPIRY_DAYS;
const TERMINAL = relUtil.TERMINAL;
const esc = relUtil.esc;
const usd = relUtil.usd;
const missingForSend = relUtil.missingForSend;
const tokenError = relUtil.tokenError;
const canCountersign = relUtil.canCountersign;

// ---------------------------------------------------------------- helpers

function clientIp(req) {
  if (!req || !req.headers) return '';
  const xf = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return (xf || req.ip || '').toString().slice(0, 64);
}

// Append one row to the audit trail. Fails quiet: a release must never fail to
// send because the log insert did.
async function logEvent(releaseId, type, actor, req, detail) {
  try {
    await pool.query(
      'INSERT INTO release_events (release_id, event_type, actor, ip, user_agent, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [releaseId, type, actor || null, clientIp(req),
       (req && req.headers && req.headers['user-agent'] || '').toString().slice(0, 1000) || null,
       detail ? JSON.stringify(detail) : null]
    );
  } catch (e) { console.error('[release] event log:', e.message); }
}

// Year-sequenced, e.g. ROL-2026-0001.
async function generateReleaseNumber() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(release_number, '-', 3) AS INTEGER)) AS maxseq FROM release_forms WHERE release_number LIKE $1",
    ['ROL-' + year + '-%']
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'ROL-' + year + '-' + seq;
}

async function settingsMap(keys) {
  const out = {};
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [keys]);
    rows.forEach(function (r) { out[r.key] = r.value; });
  } catch (e) { console.error('[release] settings:', e.message); }
  return out;
}

// The wording on the form. Seeded into settings on first use so Legal can revise
// it without a deploy; a single release can still override it before sending.
async function defaultReleaseBody() {
  const s = await settingsMap(['release_body_default']);
  if (s.release_body_default && String(s.release_body_default).trim()) return s.release_body_default;
  try {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('release_body_default', $1) ON CONFLICT (key) DO NOTHING",
      [releasePdf.DEFAULT_RELEASE_BODY]
    );
  } catch (e) { console.error('[release] seed body:', e.message); }
  return releasePdf.DEFAULT_RELEASE_BODY;
}

async function companyInfo() {
  const s = await settingsMap(['company_name', 'logo']);
  return { name: s.company_name || 'Lock and Roll LLC', logo: s.logo || null };
}

function releaseLink(token) {
  return (process.env.APP_URL || '').replace(/\/$/, '') + '/release/' + token;
}

// admin/owner see every city; everyone else only their own. Mirrors cityScope()
// in routes/feedback.js - a release inherits the scope of the complaint it came
// from, and a release with no complaint behind it is not a city record at all.
async function cityScope(user) {
  if (!user) return [];
  if (user.role === 'admin' || user.role === 'owner') return null;
  const { rows } = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [user.id]);
  return rows.map(function (r) { return r.city_code; });
}

async function loadRelease(id) {
  const { rows } = await pool.query(
    'SELECT r.*, u.name AS created_by_name, f.city_code AS feedback_city ' +
    'FROM release_forms r ' +
    'LEFT JOIN users u ON u.id = r.created_by ' +
    'LEFT JOIN customer_feedback f ON f.id = r.feedback_id WHERE r.id = $1',
    [id]
  );
  return rows.length ? rows[0] : null;
}

async function inScope(rel, user) {
  const scope = await cityScope(user);
  if (scope === null) return true;
  if (!rel.feedback_id || !rel.feedback_city) return true;
  return scope.indexOf(rel.feedback_city) !== -1;
}


// Store a signature PNG in R2 and return its key. Validates hard, because this
// value arrives from a page anyone holding the link can open.
async function putSignature(releaseId, who, dataUrl) {
  if (!r2.configured()) throw new Error('File storage is not configured.');
  const bad = relUtil.checkSignatureDataUrl(dataUrl);
  if (bad) throw new Error(bad);
  const buf = Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
  const key = 'releases/' + releaseId + '/' + who + '-sig-' + Date.now() + '.png';
  await r2.putObject(key, buf, 'image/png');
  return key;
}

async function sigBuffer(key) {
  if (!key) return null;
  try { return await r2.getObjectBuffer(key); }
  catch (e) { console.error('[release] sig fetch:', e.message); return null; }
}

async function eventsFor(releaseId) {
  const { rows } = await pool.query('SELECT * FROM release_events WHERE release_id = $1 ORDER BY created_at ASC, id ASC', [releaseId]);
  return rows;
}

// Build the finished PDF, store it, and put it everywhere it belongs: the
// complaint's attachments, the Documents vault, and both parties' inboxes.
// Every side effect gets its own try/catch - a failed vault drop must not undo
// a signature that has already been given.
async function finalize(releaseId) {
  const rel = await loadRelease(releaseId);
  if (!rel) return;
  const company = await companyInfo();
  const body = await defaultReleaseBody();
  const events = await eventsFor(releaseId);
  const custSig = await sigBuffer(rel.customer_sig_r2_key);
  const repSig = await sigBuffer(rel.rep_sig_r2_key);

  const withBody = Object.assign({}, rel, { release_body: rel.release_body || body });
  const buf = await releasePdf.buildReleasePdf(withBody, events, {
    company: company, logo: company.logo, customerSig: custSig, repSig: repSig
  });

  const key = 'releases/' + rel.id + '/' + rel.release_number + '-signed.pdf';
  await r2.putObject(key, buf, 'application/pdf');
  await pool.query(
    "UPDATE release_forms SET signed_r2_key = $1, status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $2",
    [key, rel.id]
  );
  await logEvent(rel.id, 'completed', null, null, { signed_key: key });

  // The complaint's Attachments card points at the SAME R2 object rather than a
  // second copy, so there is one signed PDF in the world, not two.
  if (rel.feedback_id) {
    try {
      await pool.query(
        'INSERT INTO customer_feedback_attachments (feedback_id, r2_key, file_name, mime_type, size_bytes, status, uploaded_by, uploaded_by_name) ' +
        "VALUES ($1,$2,$3,'application/pdf',$4,'ready',$5,$6) ON CONFLICT (r2_key) DO NOTHING",
        [rel.feedback_id, key, rel.release_number + '-signed.pdf', buf.length, rel.created_by, rel.created_by_name || null]
      );
      await logActivity(rel.feedback_id, null, 'event',
        'Release of liability ' + rel.release_number + ' completed and filed.', 'app');
    } catch (e) { console.error('[release] complaint attach:', e.message); }
  }

  // Documents vault, owned by whoever created the release.
  try {
    const creator = (await pool.query('SELECT name FROM users WHERE id = $1', [rel.created_by])).rows[0] || {};
    let folderId = null;
    const sf = await pool.query("SELECT id FROM document_folders WHERE name = 'Signed Documents' AND owner_id = $1 AND parent_id IS NULL", [rel.created_by]);
    if (sf.rows.length) folderId = sf.rows[0].id;
    else {
      const nsf = await pool.query("INSERT INTO document_folders (name, parent_id, owner_id, owner_name) VALUES ('Signed Documents', NULL, $1, $2) RETURNING id", [rel.created_by, creator.name || null]);
      folderId = nsf.rows[0].id;
    }
    await pool.query(
      'INSERT INTO documents (name, folder_id, r2_key, mime_type, size_bytes, status, owner_id, owner_name) ' +
      "VALUES ($1,$2,$3,'application/pdf',$4,'ready',$5,$6)",
      ['Release of Liability ' + rel.release_number + ' (signed).pdf', folderId, key, buf.length, rel.created_by, creator.name || null]
    );
  } catch (e) { console.error('[release] vault drop:', e.message); }

  // Both parties get the finished document.
  try {
    const rep = (await pool.query('SELECT email FROM users WHERE id = $1', [rel.rep_user_id])).rows[0] || {};
    const to = [];
    if (rel.claimant_email) to.push(rel.claimant_email);
    if (rep.email) to.push(rep.email);
    if (to.length) {
      const html = emailTemplate({
        badge: 'Completed', badgeColor: 'green',
        title: 'Release of liability completed',
        body: 'The release for ' + esc(rel.claimant_name) + ' has been signed by both parties. A copy is attached for your records.',
        details: [{ label: 'Reference', value: rel.release_number },
                  { label: 'Settlement amount', value: usd(rel.settlement_amount) }],
        footerNote: 'Keep this document. It is the record of the payment and the release.',
        brand: company.name
      });
      await sendEmail(to, 'Completed: release of liability ' + rel.release_number, html, null,
        [{ filename: rel.release_number + '-signed.pdf', content: buf.toString('base64') }]);
    }
  } catch (e) { console.error('[release] completion email:', e.message); }
}

// Tell the named representative the claimant has signed and it is their turn.
async function notifyRep(releaseId) {
  try {
    const rel = await loadRelease(releaseId);
    if (!rel || !rel.rep_user_id) return;
    const u = (await pool.query('SELECT name, email, phone, receive_sms FROM users WHERE id = $1', [rel.rep_user_id])).rows[0];
    if (!u) return;
    const company = await companyInfo();
    const url = (process.env.APP_URL || '').replace(/\/$/, '') + '/?view=release&id=' + rel.id;
    if (u.email) {
      const html = emailTemplate({
        badge: 'Your signature needed', badgeColor: 'orange',
        title: 'A release is waiting on your countersignature',
        body: esc(rel.claimant_name) + ' has signed release ' + esc(rel.release_number) + '. It is complete once you countersign.',
        details: [{ label: 'Claimant', value: rel.claimant_name || '' },
                  { label: 'Settlement amount', value: usd(rel.settlement_amount) }],
        buttonText: 'Open and countersign', buttonUrl: url,
        footerNote: 'Automated Nova notification.', brand: company.name
      });
      await sendEmail(u.email, 'Countersignature needed: ' + rel.release_number, html);
    }
    if (u.phone && u.receive_sms) {
      try { await sendSms(u.phone, rel.claimant_name + ' signed release ' + rel.release_number + '. Your countersignature is needed: ' + url); } catch (e) {}
    }
  } catch (e) { console.error('[release] notify rep:', e.message); }
}

// Email and/or text the claimant their single-use link.
async function notifyClaimant(rel, company, channel, fromUser, message) {
  const link = releaseLink(rel.customer_token);
  const wantEmail = (channel === 'email' || channel === 'both');
  const wantSms = (channel === 'sms' || channel === 'both');
  if (wantEmail && rel.claimant_email) {
    const html = emailTemplate({
      badge: 'Signature requested', badgeColor: 'orange',
      title: 'Please review and sign your release',
      body: 'Hi ' + esc(String(rel.claimant_name || 'there').split(' ')[0]) + ',<br><br>' +
            (message ? (esc(message) + '<br><br>') : '') +
            'Please review the release below and sign it electronically. It takes about a minute on your phone.',
      details: [{ label: 'Reference', value: rel.release_number },
                { label: 'Settlement amount', value: usd(rel.settlement_amount) }],
      buttonText: 'Review and sign', buttonUrl: link,
      footerNote: 'This is a secure, single-use link. Please do not forward it.',
      brand: company.name
    });
    await sendEmail(rel.claimant_email, 'Please sign: release of liability ' + rel.release_number, html, null, null,
      (fromUser && fromUser.email) ? { replyTo: fromUser.email } : null);
  }
  if (wantSms && rel.claimant_phone) {
    try {
      await sendSms(rel.claimant_phone,
        (message ? (message + ' ') : (company.name + ': please review and sign your release. ')) + link);
    } catch (e) { console.error('[release] sms:', e.message); }
  }
}

// ---------------------------------------------------------------- staff API

// GET /api/releases - list, newest first. ?status= and ?feedback_id= filter.
router.get('/', requireAuth, requirePermission('view_releases'), async function (req, res) {
  try {
    const where = [];
    const args = [];
    if (req.query.status) { args.push(req.query.status); where.push('r.status = $' + args.length); }
    if (req.query.feedback_id) { args.push(parseInt(req.query.feedback_id, 10)); where.push('r.feedback_id = $' + args.length); }
    const scope = await cityScope(req.user);
    if (scope !== null) {
      args.push(scope);
      where.push('(r.feedback_id IS NULL OR f.city_code = ANY($' + args.length + '))');
    }
    const { rows } = await pool.query(
      'SELECT r.id, r.release_number, r.status, r.claimant_name, r.settlement_amount, r.feedback_id, ' +
      '       r.rep_name, r.sent_at, r.completed_at, r.created_at, u.name AS created_by_name ' +
      'FROM release_forms r ' +
      'LEFT JOIN users u ON u.id = r.created_by ' +
      'LEFT JOIN customer_feedback f ON f.id = r.feedback_id ' +
      (where.length ? ('WHERE ' + where.join(' AND ') + ' ') : '') +
      'ORDER BY r.created_at DESC LIMIT 300',
      args
    );
    res.json({ releases: rows, storageReady: r2.configured() });
  } catch (e) {
    console.error('GET /releases:', e.message);
    res.status(500).json({ error: 'Failed to load releases' });
  }
});

// GET /api/releases/reps - who can be named as the countersigner. Their stored
// title comes along so it is not retyped on every release.
router.get('/reps', requireAuth, requirePermission('manage_releases'), async function (req, res) {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, title, email FROM users WHERE active = true AND role IN ('admin','owner','manager') ORDER BY name"
    );
    res.json({ reps: rows });
  } catch (e) {
    console.error('GET /releases/reps:', e.message);
    res.status(500).json({ error: 'Failed to load representatives' });
  }
});

// POST /api/releases - create a draft. When feedback_id is given the pre-fill is
// done HERE, from the complaint row, so the browser cannot invent it.
router.post('/', requireAuth, requirePermission('manage_releases'), async function (req, res) {
  try {
    const b = req.body || {};
    let seed = {};
    let feedbackId = null;
    if (b.feedback_id) {
      feedbackId = parseInt(b.feedback_id, 10);
      const f = await pool.query('SELECT * FROM customer_feedback WHERE id = $1', [feedbackId]);
      if (!f.rows.length) return res.status(404).json({ error: 'Complaint not found' });
      const scope = await cityScope(req.user);
      if (scope !== null && scope.indexOf(f.rows[0].city_code) === -1) {
        return res.status(403).json({ error: 'Not in your cities' });
      }
      const fb = f.rows[0];
      seed = {
        claimant_name: fb.customer_name,
        claimant_phone: fb.customer_phone,
        claimant_email: fb.customer_email,
        // job_location is where the tech went, which is often but not always
        // where the customer lives. The city rides along as a starting point;
        // the street address is deliberately left blank so it gets asked for.
        claimant_city: fb.job_location || null,
        vehicle_year: fb.vehicle_year,
        vehicle_make: fb.vehicle_make,
        vehicle_model: fb.vehicle_model,
        job_ref: fb.invoice_ref,
        damage_description: fb.ai_summary || fb.incident_text || null,
        service_date: fb.received_at ? new Date(fb.received_at) : null
      };
    }
    const number = await generateReleaseNumber();
    const body = await defaultReleaseBody();
    const { rows } = await pool.query(
      'INSERT INTO release_forms (release_number, status, feedback_id, work_order_id, claimant_name, claimant_phone, ' +
      ' claimant_email, claimant_city, vehicle_year, vehicle_make, vehicle_model, job_ref, damage_description, ' +
      ' service_date, release_body, created_by) ' +
      "VALUES ($1,'draft',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id",
      [number, feedbackId, b.work_order_id || null,
       seed.claimant_name || b.claimant_name || 'Unknown', seed.claimant_phone || null, seed.claimant_email || null,
       seed.claimant_city || null, seed.vehicle_year || null, seed.vehicle_make || null, seed.vehicle_model || null,
       seed.job_ref || null, seed.damage_description || null, seed.service_date || null, body, req.user.id]
    );
    const relId = rows[0].id;
    await logEvent(relId, 'created', req.user.name, req, { from_complaint: feedbackId });
    if (feedbackId) {
      await logActivity(feedbackId, req.user, 'event', 'started a release of liability (' + number + ').', 'app');
    }
    res.json({ id: relId, release_number: number });
  } catch (e) {
    console.error('POST /releases:', e.message);
    res.status(500).json({ error: 'Failed to create release' });
  }
});

// GET /api/releases/:id - the record, its audit trail, and what this user may do.
router.get('/:id', requireAuth, requirePermission('view_releases'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const rel = await loadRelease(id);
    if (!rel) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(rel, req.user))) return res.status(403).json({ error: 'Not in your cities' });
    const events = await eventsFor(id);
    const company = await companyInfo();
    res.json({
      release: rel,
      events: events,
      company: company.name,
      missing: missingForSend(rel),
      canCountersign: canCountersign(rel, req.user),
      canManage: !!(req.user && (req.user.role === 'admin' || req.user.role === 'owner')) || undefined,
      storageReady: r2.configured()
    });
  } catch (e) {
    console.error('GET /releases/:id:', e.message);
    res.status(500).json({ error: 'Failed to load release' });
  }
});

// PUT /api/releases/:id - save the form. Drafts only: once a release has been
// sent the customer may be looking at it, and once signed the wording is what
// somebody agreed to. Neither may move underneath them.
const EDITABLE = ['claimant_name', 'claimant_phone', 'claimant_email', 'claimant_address', 'claimant_city',
  'claimant_state', 'claimant_zip', 'vehicle_year', 'vehicle_make', 'vehicle_model', 'vehicle_color',
  'license_plate', 'vin', 'job_ref', 'damage_description', 'release_body'];

router.put('/:id', requireAuth, requirePermission('manage_releases'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const rel = await loadRelease(id);
    if (!rel) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(rel, req.user))) return res.status(403).json({ error: 'Not in your cities' });
    if (rel.status !== 'draft') {
      return res.status(400).json({ error: 'This release has already been sent and can no longer be edited. Void it and start a new one.' });
    }
    const b = req.body || {};
    const sets = [];
    const args = [];
    EDITABLE.forEach(function (col) {
      if (Object.prototype.hasOwnProperty.call(b, col)) {
        args.push(b[col] === '' ? null : b[col]);
        sets.push(col + ' = $' + args.length);
      }
    });
    if (Object.prototype.hasOwnProperty.call(b, 'service_date')) {
      args.push(b.service_date || null); sets.push('service_date = $' + args.length);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'settlement_amount')) {
      const amt = Number(b.settlement_amount);
      if (!isFinite(amt) || amt < 0) return res.status(400).json({ error: 'Settlement amount must be a positive number.' });
      args.push(amt); sets.push('settlement_amount = $' + args.length);
    }
    // rep_user_id carries the name and title with it: the PDF prints what was
    // true when the release was signed, not whatever the roster says later.
    if (Object.prototype.hasOwnProperty.call(b, 'rep_user_id')) {
      const repId = b.rep_user_id ? parseInt(b.rep_user_id, 10) : null;
      let repName = null;
      let repTitle = b.rep_title || null;
      if (repId) {
        const u = (await pool.query('SELECT name, title FROM users WHERE id = $1', [repId])).rows[0];
        if (!u) return res.status(400).json({ error: 'That representative no longer exists.' });
        repName = u.name;
        if (!repTitle) repTitle = u.title || null;
      }
      args.push(repId); sets.push('rep_user_id = $' + args.length);
      args.push(repName); sets.push('rep_name = $' + args.length);
      args.push(repTitle); sets.push('rep_title = $' + args.length);
    } else if (Object.prototype.hasOwnProperty.call(b, 'rep_title')) {
      args.push(b.rep_title || null); sets.push('rep_title = $' + args.length);
    }
    if (!sets.length) return res.json({ success: true, missing: missingForSend(rel) });
    args.push(id);
    await pool.query('UPDATE release_forms SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $' + args.length, args);
    const after = await loadRelease(id);
    res.json({ success: true, missing: missingForSend(after) });
  } catch (e) {
    console.error('PUT /releases/:id:', e.message);
    res.status(500).json({ error: 'Failed to save release' });
  }
});

// POST /api/releases/:id/send - mint the token and deliver it.
// channel: 'email' | 'sms' | 'both' | 'link'. 'link' mints the token and hands
// back the URL for a manager to paste into their own thread; it still counts as
// sent, so the timeline tells the truth either way.
router.post('/:id/send', requireAuth, requirePermission('manage_releases'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const rel = await loadRelease(id);
    if (!rel) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(rel, req.user))) return res.status(403).json({ error: 'Not in your cities' });
    if (TERMINAL.indexOf(rel.status) !== -1) return res.status(400).json({ error: 'This release is closed.' });
    if (rel.status === 'customer_signed') return res.status(400).json({ error: 'The claimant has already signed this release.' });
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet (R2_* env vars), so a signature could not be saved.' });

    const missing = missingForSend(rel);
    if (missing.length) return res.status(400).json({ error: 'Fill these in first: ' + missing.join(', ') + '.', missing: missing });

    const channel = ['email', 'sms', 'both', 'link'].indexOf(req.body && req.body.channel) !== -1 ? req.body.channel : 'email';
    if (channel === 'email' && !rel.claimant_email) return res.status(400).json({ error: 'This release has no claimant email address.' });
    if (channel === 'sms' && !rel.claimant_phone) return res.status(400).json({ error: 'This release has no claimant phone number.' });
    if (channel === 'both' && !rel.claimant_email && !rel.claimant_phone) return res.status(400).json({ error: 'This release has no email address or phone number.' });

    const days = Math.min(90, Math.max(1, parseInt((req.body && req.body.expiry_days) || DEFAULT_EXPIRY_DAYS, 10) || DEFAULT_EXPIRY_DAYS));
    const expires = new Date(Date.now() + days * 86400000);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "UPDATE release_forms SET customer_token = $1, customer_token_expires_at = $2, expires_at = $2, status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $3",
      [token, expires, id]
    );
    rel.customer_token = token;

    let fromUser = null;
    if (req.body && req.body.from_user_id) {
      fromUser = (await pool.query('SELECT name, email FROM users WHERE id = $1', [parseInt(req.body.from_user_id, 10)])).rows[0] || null;
    }
    const company = await companyInfo();
    const message = (req.body && req.body.message) ? String(req.body.message).slice(0, 600) : '';

    if (channel !== 'link') {
      notifyClaimant(rel, company, channel, fromUser, message)
        .catch(function (e) { console.error('[release] notify:', e.message); });
    }
    await logEvent(id, 'sent', req.user.name, req, { channel: channel, from: fromUser ? fromUser.email : null });
    if (rel.feedback_id) {
      await logActivity(rel.feedback_id, req.user, 'event',
        'sent a release of liability to the customer (' + rel.release_number + ').', 'app');
    }
    res.json({ success: true, link: releaseLink(token), expires_at: expires });
  } catch (e) {
    console.error('POST /releases/:id/send:', e.message);
    res.status(500).json({ error: 'Failed to send release' });
  }
});

// POST /api/releases/:id/remind - re-send the live link, unchanged.
router.post('/:id/remind', requireAuth, requirePermission('manage_releases'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const rel = await loadRelease(id);
    if (!rel) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(rel, req.user))) return res.status(403).json({ error: 'Not in your cities' });
    if (rel.status !== 'sent' || !rel.customer_token) return res.status(400).json({ error: 'There is no live signing link to resend.' });
    const channel = ['email', 'sms', 'both'].indexOf(req.body && req.body.channel) !== -1 ? req.body.channel : 'email';
    const company = await companyInfo();
    notifyClaimant(rel, company, channel, null, '').catch(function (e) { console.error('[release] remind:', e.message); });
    await logEvent(id, 'reminder_sent', req.user.name, req, { channel: channel });
    res.json({ success: true });
  } catch (e) {
    console.error('POST /releases/:id/remind:', e.message);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// POST /api/releases/:id/in-person - the claimant signs on a Nova user's device
// at the vehicle. Same record, same audit trail; the event detail records who was
// holding the device, which is the honest description of what happened.
router.post('/:id/in-person', requireAuth, requirePermission('manage_releases'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const rel = await loadRelease(id);
    if (!rel) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(rel, req.user))) return res.status(403).json({ error: 'Not in your cities' });
    if (rel.status !== 'draft' && rel.status !== 'sent') return res.status(400).json({ error: 'This release is not open for signature.' });
    const missing = missingForSend(rel);
    if (missing.length) return res.status(400).json({ error: 'Fill these in first: ' + missing.join(', ') + '.', missing: missing });
    const printed = String((req.body && req.body.printed_name) || '').trim();
    if (!printed) return res.status(400).json({ error: 'The claimant must type their printed name.' });
    const key = await putSignature(id, 'customer', req.body && req.body.image);
    await pool.query(
      'UPDATE release_forms SET customer_sig_r2_key = $1, customer_printed_name = $2, customer_signed_at = NOW(), ' +
      "customer_signed_ip = $3, customer_consent = true, customer_token = NULL, status = 'customer_signed', updated_at = NOW() WHERE id = $4",
      [key, printed.slice(0, 255), clientIp(req), id]
    );
    await logEvent(id, 'consented', printed, req, { in_person: true, witnessed_by: req.user.name });
    await logEvent(id, 'signed', printed, req, { in_person: true, witnessed_by: req.user.name });
    if (rel.feedback_id) {
      await logActivity(rel.feedback_id, req.user, 'event',
        'witnessed the customer signing the release of liability in person (' + rel.release_number + ').', 'app');
    }
    notifyRep(id).catch(function (e) { console.error('[release] rep notify:', e.message); });
    res.json({ success: true });
  } catch (e) {
    console.error('POST /releases/:id/in-person:', e.message);
    res.status(400).json({ error: e.message || 'Failed to record signature' });
  }
});

// POST /api/releases/:id/rep-sign - the countersignature, which completes it.
// Behind view_releases, not manage_releases: the gate that matters is
// canCountersign, because the signature belongs to the person named on the form.
router.post('/:id/rep-sign', requireAuth, requirePermission('view_releases'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const rel = await loadRelease(id);
    if (!rel) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(rel, req.user))) return res.status(403).json({ error: 'Not in your cities' });
    if (!canCountersign(rel, req.user)) {
      return res.status(403).json({ error: 'Only ' + (rel.rep_name || 'the named representative') + ' can countersign this release.' });
    }
    if (rel.status !== 'customer_signed') {
      return res.status(400).json({ error: rel.status === 'completed' ? 'This release is already complete.' : 'The claimant has not signed yet.' });
    }
    const key = await putSignature(id, 'rep', req.body && req.body.image);
    await pool.query(
      'UPDATE release_forms SET rep_sig_r2_key = $1, rep_signed_at = NOW(), rep_signed_ip = $2, updated_at = NOW() WHERE id = $3',
      [key, clientIp(req), id]
    );
    await logEvent(id, 'countersigned', req.user.name, req, {});
    await finalize(id);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /releases/:id/rep-sign:', e.message);
    res.status(400).json({ error: e.message || 'Failed to countersign' });
  }
});

// POST /api/releases/:id/void - kill the link and close the record.
router.post('/:id/void', requireAuth, requirePermission('manage_releases'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const rel = await loadRelease(id);
    if (!rel) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(rel, req.user))) return res.status(403).json({ error: 'Not in your cities' });
    if (rel.status === 'completed') return res.status(400).json({ error: 'A completed release cannot be voided.' });
    await pool.query("UPDATE release_forms SET status = 'voided', customer_token = NULL, updated_at = NOW() WHERE id = $1", [id]);
    await logEvent(id, 'voided', req.user.name, req, { reason: (req.body && req.body.reason) || null });
    if (rel.feedback_id) {
      await logActivity(rel.feedback_id, req.user, 'event', 'voided the release of liability ' + rel.release_number + '.', 'app');
    }
    res.json({ success: true });
  } catch (e) {
    console.error('POST /releases/:id/void:', e.message);
    res.status(500).json({ error: 'Failed to void release' });
  }
});

// GET /api/releases/:id/download - the signed PDF, or a live preview of a draft
// so the form can be checked before anyone is asked to sign it.
router.get('/:id/download', requireAuth, requirePermission('view_releases'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const rel = await loadRelease(id);
    if (!rel) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(rel, req.user))) return res.status(403).json({ error: 'Not in your cities' });
    if (rel.signed_r2_key) {
      const url = await r2.presignDownload(rel.signed_r2_key, rel.release_number + '-signed.pdf', true);
      return res.json({ url: url });
    }
    const company = await companyInfo();
    const body = await defaultReleaseBody();
    const withBody = Object.assign({}, rel, { release_body: rel.release_body || body });
    const buf = await releasePdf.buildReleasePdf(withBody, [], {
      company: company, logo: company.logo,
      customerSig: await sigBuffer(rel.customer_sig_r2_key), certificate: false
    });
    res.json({ preview: buf.toString('base64'), filename: rel.release_number + '-preview.pdf' });
  } catch (e) {
    console.error('GET /releases/:id/download:', e.message);
    res.status(500).json({ error: 'Failed to build the document' });
  }
});

// DELETE /api/releases/:id - drafts only. Anything sent leaves a record.
router.delete('/:id', requireAuth, requirePermission('manage_releases'), async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const rel = await loadRelease(id);
    if (!rel) return res.status(404).json({ error: 'Not found' });
    if (rel.status !== 'draft') return res.status(400).json({ error: 'Only a draft can be deleted. Void this one instead.' });
    await pool.query('DELETE FROM release_forms WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /releases/:id:', e.message);
    res.status(500).json({ error: 'Failed to delete release' });
  }
});

// ------------------------------------------------------------- public API
// No JWT. Everything hangs off the single-use token on the release row.

async function loadByToken(token) {
  if (!relUtil.isValidToken(token)) return null;
  const { rows } = await pool.query('SELECT * FROM release_forms WHERE customer_token = $1', [token]);
  return rows.length ? rows[0] : null;
}

pub.get('/:token', async function (req, res) {
  try {
    const rel = await loadByToken(req.params.token);
    if (!rel) return res.status(404).json({ error: 'This signing link is not valid.' });
    const te = tokenError(rel);
    if (te) return res.status(te.code).json({ error: te.msg });
    const company = await companyInfo();
    const body = await defaultReleaseBody();
    await logEvent(rel.id, 'viewed', rel.claimant_name, req, {});
    res.json({ release: relUtil.publicView(rel, company.name, body) });
  } catch (e) {
    console.error('GET /release/:token:', e.message);
    res.status(500).json({ error: 'Failed to load this document' });
  }
});

pub.post('/:token/consent', async function (req, res) {
  try {
    const rel = await loadByToken(req.params.token);
    if (!rel) return res.status(404).json({ error: 'This signing link is not valid.' });
    const te = tokenError(rel);
    if (te) return res.status(te.code).json({ error: te.msg });
    await pool.query('UPDATE release_forms SET customer_consent = true, updated_at = NOW() WHERE id = $1', [rel.id]);
    await logEvent(rel.id, 'consented', rel.claimant_name, req, {});
    res.json({ success: true });
  } catch (e) {
    console.error('POST /release/:token/consent:', e.message);
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

pub.post('/:token/submit', async function (req, res) {
  try {
    const rel = await loadByToken(req.params.token);
    if (!rel) return res.status(404).json({ error: 'This signing link is not valid.' });
    const te = tokenError(rel);
    if (te) return res.status(te.code).json({ error: te.msg });
    if (!rel.customer_consent && !(req.body && req.body.consent)) {
      return res.status(400).json({ error: 'Please agree to sign electronically first.' });
    }
    const printed = String((req.body && req.body.printed_name) || '').trim();
    if (!printed) return res.status(400).json({ error: 'Please type your printed name.' });
    const key = await putSignature(rel.id, 'customer', req.body && req.body.image);
    // The token is nulled in the same statement that records the signature, so
    // the link is dead the moment it is used and cannot be replayed.
    await pool.query(
      'UPDATE release_forms SET customer_sig_r2_key = $1, customer_printed_name = $2, customer_signed_at = NOW(), ' +
      "customer_signed_ip = $3, customer_consent = true, customer_token = NULL, status = 'customer_signed', updated_at = NOW() WHERE id = $4",
      [key, printed.slice(0, 255), clientIp(req), rel.id]
    );
    await logEvent(rel.id, 'signed', printed, req, {});
    if (rel.feedback_id) {
      await logActivity(rel.feedback_id, null, 'event',
        printed + ' signed the release of liability (' + rel.release_number + ').', 'app');
    }
    notifyRep(rel.id).catch(function (e) { console.error('[release] rep notify:', e.message); });
    res.json({ success: true });
  } catch (e) {
    console.error('POST /release/:token/submit:', e.message);
    res.status(400).json({ error: e.message || 'Failed to record your signature' });
  }
});

pub.post('/:token/decline', async function (req, res) {
  try {
    const rel = await loadByToken(req.params.token);
    if (!rel) return res.status(404).json({ error: 'This signing link is not valid.' });
    const te = tokenError(rel);
    if (te) return res.status(te.code).json({ error: te.msg });
    const reason = String((req.body && req.body.reason) || '').slice(0, 1000);
    await pool.query(
      "UPDATE release_forms SET status = 'declined', declined_reason = $1, customer_token = NULL, updated_at = NOW() WHERE id = $2",
      [reason || null, rel.id]
    );
    await logEvent(rel.id, 'declined', rel.claimant_name, req, { reason: reason || null });
    if (rel.feedback_id) {
      await logActivity(rel.feedback_id, null, 'event',
        'The customer declined to sign the release of liability (' + rel.release_number + ').', 'app');
    }
    // Whoever sent it needs to know immediately; a declined release usually
    // means the conversation is not over.
    try {
      const c = (await pool.query('SELECT email FROM users WHERE id = $1', [rel.created_by])).rows[0];
      if (c && c.email) {
        const company = await companyInfo();
        await sendEmail(c.email, 'Declined: release of liability ' + rel.release_number,
          emailTemplate({
            badge: 'Declined', badgeColor: 'red', title: 'The claimant declined to sign',
            body: esc(rel.claimant_name) + ' declined release ' + esc(rel.release_number) + '.' + (reason ? ('<br><br>Reason given: ' + esc(reason)) : ''),
            details: [{ label: 'Reference', value: rel.release_number }],
            footerNote: 'Automated Nova notification.', brand: company.name
          }));
      }
    } catch (e) { console.error('[release] decline email:', e.message); }
    res.json({ success: true });
  } catch (e) {
    console.error('POST /release/:token/decline:', e.message);
    res.status(500).json({ error: 'Failed to record your response' });
  }
});

module.exports = router;
module.exports.publicRouter = pub;
