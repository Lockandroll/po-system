const express = require('express');
const https = require('https');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { hasPermission } = require('../utils/permissions');
const r2 = require('../utils/r2');

const router = express.Router();

// Roles that can see every deposit (not just their own)
const SEE_ALL = ['admin', 'manager'];
// Roles that can export and delete
const MANAGE = ['admin', 'manager'];

// ---------------------------------------------------------------------------
// Editing an already-submitted deposit
// ---------------------------------------------------------------------------
// The city-scope rule lives in utils/depositAccess.js because the Pulsar
// reconciliation writes to deposits too ("Correct Deposit Amount") and has to be
// held to exactly the same rule. Do not re-inline a second copy here.
const { editCityScope, scopeAllows, mayEditCity } = require('../utils/depositAccess');

// Late is counted from BOTH shapes it comes in - a deposit marked late, and a
// pay week where no deposit was ever submitted. utils/lateEvents.js is the only
// place that knows the two add up to one number; nothing here counts is_late on
// its own any more.
const { lateEvents, lateCount } = require('../utils/lateEvents');

// ---------------------------------------------------------------------------
// Expense attachments (spreadsheets, PDFs - anything that is not a photo)
// ---------------------------------------------------------------------------
// A receipt is not always a photo. A parts order or a fuel account arrives as a
// spreadsheet, and the expense line had nowhere to put one: the picker was
// accept="image/*" and the bytes were base64'd straight into the row.
//
// Those files go to Cloudflare R2 instead - browser to R2 direct via a presigned
// PUT, exactly like the Document Vault - and only the pointer is stored here.
// Nothing about the photo path changed: receipt_image still holds the inline
// data URL, old rows included, and the receipt policy is unchanged in substance -
// a line carries EITHER a photo, OR a file, OR a written "no receipt" reason.
const EXPENSE_FILE_PREFIX = 'deposits/expenses/';
function sanitizeFileName(s) {
  return String(s || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'file';
}
// A key coming back from a browser is only honoured if it sits under the prefix
// this server handed THAT user. Without this check a submitted key would be an
// open pointer into the bucket and anyone could claim someone else's object.
function ownsExpenseKey(key, userId) {
  const m = /^deposits\/expenses\/(\d+)\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,200}$/.exec(String(key || ''));
  return !!m && m[1] === String(userId);
}
// Turn what the client SAYS it uploaded into something worth storing. The bytes
// never pass through this server, so existence has to be asked of R2 directly.
// Returns { file, error }: error is a message safe to hand the user verbatim.
async function resolveExpenseFile(ex, userId) {
  const key = (ex && ex.file_key != null) ? String(ex.file_key) : '';
  if (!key) return { file: null, error: null };
  if (!ownsExpenseKey(key, userId)) {
    return { file: null, error: 'That attachment could not be verified. Please attach the file again.' };
  }
  let size = parseInt(ex.file_size, 10);
  if (isNaN(size) || size < 0) size = null;
  if (r2.configured()) {
    let head;
    // A storage hiccup must not reject a receipt the tech really did upload, so
    // only a definite "not there" (null) fails the line. A thrown error is
    // transient by definition here and the claim is taken at face value.
    try { head = await r2.headObject(key); } catch (e) { head = undefined; }
    if (head === null) {
      return { file: null, error: 'That attachment did not finish uploading. Please attach the file again.' };
    }
    if (head && head.size) size = head.size;
  }
  return {
    file: {
      key: key,
      name: String(ex.file_name || key.split('/').pop() || 'receipt').slice(0, 255),
      mime: String(ex.file_mime || 'application/octet-stream').slice(0, 255),
      size: size
    },
    error: null
  };
}
// Orphaned objects are harmless but they are still the company's storage bill,
// so a removed or replaced attachment takes its bytes with it. Always best
// effort and always AFTER the transaction commits: losing the object matters
// far less than failing a save that already succeeded in the database.
async function dropExpenseObjects(keys) {
  for (let i = 0; i < (keys || []).length; i++) {
    if (!keys[i]) continue;
    try { if (r2.configured()) await r2.deleteObject(keys[i]); }
    catch (e) { console.error('Deposit expense file cleanup failed:', e.message); }
  }
}
// "create_deposit OR edit_deposit": a tech attaching a file to the deposit they
// are filing, or a manager attaching one while correcting a filed deposit.
// Composed from the existing requirePermission rather than reimplementing its
// role + extra-perm lookup, so that rule keeps exactly one definition.
function gateAllows(gate, req) {
  return new Promise(function (resolve) {
    let done = false;
    const fake = {
      status: function () { return fake; },
      json: function () { if (!done) { done = true; resolve(false); } return fake; },
      send: function () { if (!done) { done = true; resolve(false); } return fake; }
    };
    try { gate(req, fake, function () { if (!done) { done = true; resolve(true); } }); }
    catch (e) { if (!done) { done = true; resolve(false); } }
  });
}
function requireAnyPermission(perms) {
  const gates = perms.map(function (p) { return requirePermission(p); });
  return async function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    for (let i = 0; i < gates.length; i++) {
      if (await gateAllows(gates[i], req)) return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  };
}

// ---------------------------------------------------------------------------
// Expense review
// ---------------------------------------------------------------------------
// Every expense line carries an approve/deny decision. A DENIED line is an
// expense the company is not accepting, so it must not reduce what the tech
// owes: it drops out of every total, everywhere. PENDING still counts, so a
// deposit nobody has reviewed yet reads exactly as it did before this shipped.
// The rule below is the whole feature - keep every expense SUM in this file
// (and the Pulsar reconciliation in routes/pulsar.js) going through it.
const REVIEW_STATUSES = ['pending', 'approved', 'denied'];
function counted(alias) {
  const a = alias ? alias + '.' : '';
  return "COALESCE(" + a + "review_status, 'pending') <> 'denied'";
}
function denied(alias) {
  const a = alias ? alias + '.' : '';
  return "COALESCE(" + a + "review_status, 'pending') = 'denied'";
}
// One column list, so the three places that hand a deposit back to the client
// can never drift apart on which review fields they include.
// file_key is deliberately NOT handed to the client: it is a pointer into the
// bucket, and downloads go through the authenticated /file endpoint instead.
const EXPENSE_COLS = 'id, description, amount, receipt_image, receipt_filename, ' +
  'file_name, file_mime, file_size, ' +
  'COALESCE(no_receipt, FALSE) AS no_receipt, no_receipt_reason, ' +
  "COALESCE(review_status, 'pending') AS review_status, review_reason, reviewed_by_name, reviewed_at";

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function dateOrNull(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function money2(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}
// node-pg hands a DATE column back as a JS Date at LOCAL midnight, so
// String(d).slice(0,10) yields "Tue Aug 11" and toISOString() shifts the day on
// any server that is not UTC. Format from the local parts instead.
function ymdOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  try {
    var m = String(v.getMonth() + 1); if (m.length < 2) m = '0' + m;
    var d = String(v.getDate()); if (d.length < 2) d = '0' + d;
    return v.getFullYear() + '-' + m + '-' + d;
  } catch (e) { return null; }
}

// The edit history shown on the deposit page. Read straight out of audit_logs
// rather than a new table, so the on-page panel and the Audit Log can never
// disagree about what happened.
async function depositHistory(id) {
  try {
    const { rows } = await pool.query(
      'SELECT id, action, user_name, details, created_at FROM audit_logs ' +
      "WHERE entity_type = 'deposit' AND entity_id = $1 ORDER BY created_at ASC, id ASC",
      [id]
    );
    return rows.map(function (r) {
      var det = null;
      try { det = r.details ? JSON.parse(r.details) : null; } catch (e) { det = null; }
      return { id: r.id, action: r.action, user_name: r.user_name, details: det, created_at: r.created_at };
    });
  } catch (e) {
    return [];
  }
}

async function generateDepositNumber() {
  const year = new Date().getFullYear();
  const prefix = 'DEP-' + year + '-%';
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(deposit_number, '-', 3) AS INTEGER)) as maxseq FROM deposits WHERE deposit_number LIKE $1",
    [prefix]
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'DEP-' + year + '-' + seq;
}

// POST /ai-extract — read a deposit receipt photo and return amount + date.
// The tech reviews/edits the prefilled values before submitting.
router.post('/ai-extract', requireAuth, requirePermission('create_deposit'), async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
  const { imageData, mediaType } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data provided' });

  const prompt = 'You are reading a bank cash deposit receipt or deposit slip. ' +
    'Extract ONLY the following fields and return ONLY valid JSON (no explanation, no markdown):\n' +
    '{\n' +
    '  "amount": 0.00,\n' +
    '  "deposit_date": "YYYY-MM-DD"\n' +
    '}\n' +
    'amount is the total cash/deposit amount as a number with no currency symbol or commas. ' +
    'deposit_date is the date printed on the receipt in YYYY-MM-DD format. ' +
    'If a field is not found, use null.';

  const isPdf = (mediaType || '').toLowerCase() === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageData } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData } };

  const body = JSON.stringify({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    messages: [{ role: 'user', content: [ contentBlock, { type: 'text', text: prompt } ] }]
  });

  try {
    const result = await new Promise(function(resolve, reject) {
      var headers = {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      };
      if (isPdf) headers['anthropic-beta'] = 'pdfs-2024-09-25';
      const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: headers };
      const request = https.request(options, function(r) {
        var data = '';
        r.on('data', function(chunk) { data += chunk; });
        r.on('end', function() { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    });
    if (result.error) return res.status(500).json({ error: result.error.message });
    const text = (result.content[0].text || '').trim();
    // Extract the JSON object without relying on markdown fences (keeps this file backtick-free)
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const jsonStr = (start !== -1 && end !== -1) ? text.slice(start, end + 1) : text;
    const extracted = JSON.parse(jsonStr);
    res.json(extracted);
  } catch (err) {
    console.error('Deposit AI extract error:', err);
    res.status(500).json({ error: 'Failed to extract data from image' });
  }
});

// POST /expense-file/upload-url — reserve a spot in R2 for one expense
// attachment and hand back a presigned PUT the browser uploads to directly.
// Registered before the /:id routes so Express never reads "expense-file" as an id.
//
// Nothing is written to the database here. The key comes back on the deposit
// submission (or edit) and is verified there, so an upload that is started and
// abandoned leaves nothing behind but an unreferenced object.
router.post('/expense-file/upload-url', requireAuth, requireAnyPermission(['create_deposit', 'edit_deposit']), async function (req, res) {
  try {
    if (!r2.configured()) {
      return res.status(503).json({ error: 'File storage is not set up yet, so only photos can be attached. Ask an admin to add the R2 settings.' });
    }
    const name = (req.body && req.body.file_name != null ? String(req.body.file_name) : '').trim();
    if (!name) return res.status(400).json({ error: 'File name is required' });
    const mime = (req.body && req.body.mime_type != null ? String(req.body.mime_type) : '').trim().slice(0, 255) || 'application/octet-stream';
    const key = EXPENSE_FILE_PREFIX + req.user.id + '/' + crypto.randomUUID() + '/' + sanitizeFileName(name);
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ file_key: key, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('Deposit expense upload-url failed:', err.message);
    res.status(500).json({ error: 'Could not start that upload. Please try again.' });
  }
});

// POST / — submit a deposit with optional Pulsar-owed figure, multiple receipt
// photos, and expense lines (each expense may carry its own photo).
router.post('/', requireAuth, requirePermission('create_deposit'), async function(req, res) {
  const client = await pool.connect();
  try {
    const { amount, deposit_date, period_start, period_end, city_code, notes, pulsar_owed, receipt_image, receipt_filename } = req.body;
    // Expenses-only submission: a technician who paid cash out but banked nothing
    // still has to account for the week, so a 0.00 deposit is accepted as long as
    // there is real expense money on it. Totalled from the raw body here because the
    // per-line expense validation further down runs after this check.
    let bodyExpenseTotal = 0;
    (Array.isArray(req.body.expenses) ? req.body.expenses : []).forEach(function (ex) {
      if (!ex) return;
      const v = parseFloat(ex.amount);
      if (!isNaN(v) && v > 0) bodyExpenseTotal += v;
    });
    const amt = (amount === '' || amount == null) ? 0 : parseFloat(amount);
    if (isNaN(amt) || amt < 0) {
      return res.status(400).json({ error: 'A valid deposit amount is required' });
    }
    if (amt === 0 && bodyExpenseTotal <= 0) {
      return res.status(400).json({ error: 'A $0.00 deposit is only allowed when the submission has at least one expense on it.' });
    }
    if (!deposit_date) {
      return res.status(400).json({ error: 'Deposit date is required' });
    }
    if (pulsar_owed === '' || pulsar_owed == null || isNaN(parseFloat(pulsar_owed))) {
      return res.status(400).json({ error: 'Pulsar shows owed amount is required' });
    }
    if (!city_code) {
      return res.status(400).json({ error: 'City is required' });
    }
    const owed = parseFloat(pulsar_owed);
    // Who this deposit is CREDITED to. Defaults to whoever is submitting it.
    // A manager (or admin/owner) holding complete_deposit_for_employee may pick
    // someone else — the picker on the client only offers people in scope, but
    // that is a convenience, not the gate: this is re-checked here regardless of
    // what the client sent, exactly like editCityScope re-checks an edit.
    let targetUserId = req.user.id;
    let targetUserName = req.user.name;
    let submittedById = null;
    let submittedByName = null;
    const rawEmployeeId = req.body.employee_user_id;
    if (rawEmployeeId != null && rawEmployeeId !== '') {
      const empId = parseInt(rawEmployeeId, 10);
      if (isNaN(empId)) {
        return res.status(400).json({ error: 'Invalid employee selected' });
      }
      if (empId !== req.user.id) {
        const allowed = await hasPermission(req.user.role, 'complete_deposit_for_employee');
        if (!allowed) {
          return res.status(403).json({ error: 'You do not have permission to submit a deposit on behalf of someone else.' });
        }
        const empRows = await pool.query('SELECT id, name, home_city, active FROM users WHERE id = $1', [empId]);
        if (!empRows.rows.length || empRows.rows[0].active === false) {
          return res.status(400).json({ error: 'That employee could not be found.' });
        }
        const emp = empRows.rows[0];
        const scope = await editCityScope(req);
        if (!scopeAllows(scope, emp.home_city)) {
          return res.status(403).json({ error: 'You can only complete deposits for employees in the cities you are assigned to.' });
        }
        targetUserId = emp.id;
        targetUserName = emp.name;
        submittedById = req.user.id;
        submittedByName = req.user.name;
      }
    }
    // Receipt policy: every expense line must carry a photo OR a file, or an explicit
    // "no receipt" override with a written reason.  Enforced here so it cannot be
    // bypassed client-side.
    const rawExpenses = Array.isArray(req.body.expenses) ? req.body.expenses : [];
    // Attachments first, so the policy check below can treat a spreadsheet exactly
    // like a photo. Index-aligned with rawExpenses and reused by the insert loop.
    const expenseFiles = [];
    for (let k = 0; k < rawExpenses.length; k++) {
      const rf = await resolveExpenseFile(rawExpenses[k], req.user.id);
      if (rf.error) return res.status(400).json({ error: rf.error });
      expenseFiles.push(rf.file);
    }
    for (let k = 0; k < rawExpenses.length; k++) {
      const ex = rawExpenses[k];
      if (!ex) continue;
      const exAmtChk = parseFloat(ex.amount);
      const descChk = (ex.description == null ? '' : String(ex.description)).trim();
      const touchedChk = !!ex.image || !!expenseFiles[k] || ex.no_receipt === true || ex.no_receipt === 'true';
      if (!descChk && isNaN(exAmtChk) && !touchedChk) continue;
      // Description is mandatory: an amount with no explanation cannot be reconciled.
      if (!descChk) {
        return res.status(400).json({ error: 'A description is required for expense ' + (k + 1) + ' (what the money was spent on).' });
      }
      if (!isNaN(exAmtChk) && exAmtChk < 0) {
        return res.status(400).json({ error: 'Expense amount cannot be negative for "' + (descChk || ('expense ' + (k + 1))) + '".' });
      }
      const hasPhoto = !!ex.image || !!expenseFiles[k];
      const override = ex.no_receipt === true || ex.no_receipt === 'true';
      const reason = (ex.no_receipt_reason == null ? '' : String(ex.no_receipt_reason)).trim();
      const label = descChk || ('expense ' + (k + 1));
      if (!hasPhoto && !override) {
        return res.status(400).json({ error: 'A receipt is required for "' + label + '" - a photo or a file. If you do not have one, check "No receipt" and explain why.' });
      }
      if (!hasPhoto && override && !reason) {
        return res.status(400).json({ error: 'Please explain why there is no receipt for "' + label + '".' });
      }
    }
    // What the AI read off the deposit slip, and whether the tech changed it before submitting.
    const aiAmountRaw = parseFloat(req.body.ai_amount);
    const aiAmount = isNaN(aiAmountRaw) ? null : aiAmountRaw;
    const aiDate = (req.body.ai_deposit_date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.ai_deposit_date))) ? String(req.body.ai_deposit_date) : null;
    const amountEdited = aiAmount != null && Math.abs(aiAmount - amt) >= 0.005;
    const dateEdited = aiDate != null && aiDate !== String(deposit_date).slice(0, 10);
    const aiEdited = amountEdited || dateEdited;
    // Duplicate-submission guards.
    const idem = (req.body.idempotency_key == null ? '' : String(req.body.idempotency_key)).slice(0, 64) || null;
    const confirmDuplicate = req.body.confirm_duplicate === true || req.body.confirm_duplicate === 'true';
    const RETURN_COLS = 'id, deposit_number, user_id, user_name, city_code, amount, deposit_date, period_start, period_end, notes, pulsar_owed, ai_amount, ai_deposit_date, ai_edited, submitted_by_id, submitted_by_name, created_at';
    // Hard guard: identical idempotency key means the client already submitted this exact request — return the saved row instead of inserting again.
    if (idem) {
      const prior = await pool.query('SELECT ' + RETURN_COLS + ' FROM deposits WHERE idempotency_key = $1', [idem]);
      if (prior.rows.length) { return res.status(200).json(prior.rows[0]); }
    }
    // Soft guard: same person, date, amount and pay period already on file — ask the client to confirm before creating a second one.
    // Keyed on the CREDITED employee, not whoever is typing it in, so a manager
    // completing a second deposit for the same tech still gets warned.
    // Skipped on an expenses-only submission: the guard is keyed on the amount, so
    // every 0.00 deposit would look like a duplicate of the last one. What actually
    // distinguishes them is the expense lines, which this query cannot see.
    if (!confirmDuplicate && amt > 0) {
      const dupq = await pool.query(
        'SELECT id, deposit_number FROM deposits WHERE user_id = $1 AND deposit_date = $2 AND amount = $3 ' +
        'AND period_start IS NOT DISTINCT FROM $4::date AND city_code IS NOT DISTINCT FROM $5 ' +
        'ORDER BY created_at DESC LIMIT 1',
        [targetUserId, deposit_date, amt, period_start || null, city_code || null]
      );
      if (dupq.rows.length) {
        return res.status(200).json({ duplicate: true, existing_id: dupq.rows[0].id, existing_number: dupq.rows[0].deposit_number });
      }
    }
    // Receipts: prefer the receipts[] array; fall back to the legacy single image.
    let receipts = Array.isArray(req.body.receipts) ? req.body.receipts : [];
    if (!receipts.length && receipt_image) receipts = [{ image: receipt_image, filename: receipt_filename || null }];
    const expenses = rawExpenses;
    let dep = null;
    let expenseTotal = 0;
    var replayed = false;
    for (var attempt = 0; attempt < 10; attempt++) {
    expenseTotal = 0;
    const deposit_number = await generateDepositNumber();
    try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO deposits (deposit_number, user_id, user_name, city_code, amount, deposit_date, period_start, period_end, notes, pulsar_owed, idempotency_key, ai_amount, ai_deposit_date, ai_edited, submitted_by_id, submitted_by_name) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ' + RETURN_COLS,
      [
        deposit_number,
        targetUserId,
        targetUserName,
        city_code || null,
        amt,
        deposit_date,
        period_start || null,
        period_end || null,
        notes || null,
        owed,
        idem,
        aiAmount,
        aiDate,
        aiEdited,
        submittedById,
        submittedByName
      ]
    );
    dep = rows[0];
    for (let i = 0; i < receipts.length; i++) {
      const rc = receipts[i];
      if (rc && rc.image) {
        await client.query(
          'INSERT INTO deposit_receipts (deposit_id, image, filename) VALUES ($1,$2,$3)',
          [dep.id, rc.image, rc.filename || null]
        );
      }
    }
    for (let j = 0; j < expenses.length; j++) {
      const ex = expenses[j];
      if (!ex) continue;
      const exAmt = parseFloat(ex.amount);
      const desc = (ex.description == null ? '' : String(ex.description)).trim().slice(0, 500);
      if (!desc && isNaN(exAmt)) continue;
      const safeAmt = isNaN(exAmt) ? 0 : exAmt;
      expenseTotal += safeAmt;
      const exFile = expenseFiles[j] || null;
      const noRc = !ex.image && !exFile && (ex.no_receipt === true || ex.no_receipt === 'true');
      const noRcReason = noRc ? (ex.no_receipt_reason == null ? '' : String(ex.no_receipt_reason)).trim().slice(0, 1000) : null;
      await client.query(
        'INSERT INTO deposit_expenses (deposit_id, description, amount, receipt_image, receipt_filename, no_receipt, no_receipt_reason, file_key, file_name, file_mime, file_size) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          dep.id, desc || null, safeAmt, ex.image || null, ex.filename || null, noRc, noRcReason || null,
          exFile ? exFile.key : null, exFile ? exFile.name : null, exFile ? exFile.mime : null, exFile ? exFile.size : null
        ]
      );
    }
    await client.query('COMMIT');
    break;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) {}
      var isIdemHit = err.code === '23505' && ((err.constraint && err.constraint.indexOf('idempotency') !== -1) || (err.detail && err.detail.indexOf('idempotency_key') !== -1));
      if (isIdemHit && idem) {
        const prior = await pool.query('SELECT ' + RETURN_COLS + ' FROM deposits WHERE idempotency_key = $1', [idem]);
        if (prior.rows.length) { dep = prior.rows[0]; replayed = true; break; }
      }
      if (err.code === '23505' && attempt < 9) continue;
      throw err;
    }
    }
    if (!replayed) {
      await logAudit({
        entity_type: 'deposit',
        entity_id: dep.id,
        entity_number: dep.deposit_number,
        action: 'created',
        user_id: req.user.id,
        user_name: req.user.name,
        details: { amount: amt, pulsar_owed: owed, expense_total: expenseTotal, city_code: city_code || null, ai_amount: aiAmount, ai_deposit_date: aiDate, ai_edited: aiEdited, on_behalf_of: submittedById ? targetUserName : null }
      });
    }
    res.status(replayed ? 200 : 201).json(dep);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error(err);
    res.status(500).json({ error: 'Failed to submit deposit' });
  } finally {
    client.release();
  }
});

// GET / — list deposits (own for employees; all for see-all roles).
// Includes pulsar_owed and a summed expense total so the client can show Over/Short.
// Never returns receipt images in the list (kept lightweight).
router.get('/', requireAuth, requirePermission('view_deposits'), async function(req, res) {
  try {
    const cols = 'd.id, d.deposit_number, d.user_id, COALESCE(u.name, d.user_name) AS user_name, d.city_code, d.amount, d.pulsar_owed, d.deposit_date, d.period_start, d.period_end, d.notes, d.receipt_filename, ' +
      'd.ai_amount, d.ai_deposit_date, COALESCE(d.ai_edited, FALSE) AS ai_edited, ' +
      '(d.receipt_image IS NOT NULL OR EXISTS(SELECT 1 FROM deposit_receipts r WHERE r.deposit_id = d.id)) AS has_receipt, ' +
      'COALESCE((SELECT SUM(e.amount) FROM deposit_expenses e WHERE e.deposit_id = d.id AND ' + counted('e') + '), 0) AS total_expenses, ' +
      'COALESCE((SELECT SUM(e5.amount) FROM deposit_expenses e5 WHERE e5.deposit_id = d.id AND ' + denied('e5') + '), 0) AS denied_expenses, ' +
      "(SELECT COUNT(*) FROM deposit_expenses e6 WHERE e6.deposit_id = d.id AND COALESCE(e6.review_status, 'pending') = 'pending') AS pending_expense_count, " +
      // A denied line is not this deposit's problem any more, so its missing
      // receipt is not either - it would leave a flag nobody can ever clear.
      'EXISTS(SELECT 1 FROM deposit_expenses e2 WHERE e2.deposit_id = d.id AND e2.no_receipt = TRUE AND ' + counted('e2') + ') AS has_missing_expense_receipt, ' +
      'd.submitted_by_id, d.submitted_by_name, ' +
      'd.created_at';
    let query, params;
    if (SEE_ALL.includes(req.user.role)) {
      query = 'SELECT ' + cols + ' FROM deposits d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.deposit_date DESC, d.created_at DESC';
      params = [];
    } else {
      query = 'SELECT ' + cols + ' FROM deposits d LEFT JOIN users u ON u.id = d.user_id WHERE d.user_id = $1 ORDER BY d.deposit_date DESC, d.created_at DESC';
      params = [req.user.id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch deposits' });
  }
});

// GET /export — all deposits for CSV (admin/manager only). No images.
router.get('/export', requireAuth, requirePermission('export_deposits'), async function(req, res) {
  if (!MANAGE.includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT d.deposit_number, COALESCE(u.name, d.user_name) AS user_name, d.city_code, d.amount, d.pulsar_owed, d.deposit_date, d.period_start, d.period_end, d.notes, d.receipt_filename, ' +
      'd.ai_amount, d.ai_deposit_date, COALESCE(d.ai_edited, FALSE) AS ai_edited, ' +
      'EXISTS(SELECT 1 FROM deposit_expenses e2 WHERE e2.deposit_id = d.id AND e2.no_receipt = TRUE AND ' + counted('e2') + ') AS has_missing_expense_receipt, ' +
      '(d.receipt_image IS NOT NULL OR EXISTS(SELECT 1 FROM deposit_receipts r WHERE r.deposit_id = d.id)) AS has_receipt, ' +
      'COALESCE((SELECT SUM(e.amount) FROM deposit_expenses e WHERE e.deposit_id = d.id AND ' + counted('e') + '), 0) AS total_expenses, ' +
      'COALESCE((SELECT SUM(e5.amount) FROM deposit_expenses e5 WHERE e5.deposit_id = d.id AND ' + denied('e5') + '), 0) AS denied_expenses, ' +
      "(SELECT COUNT(*) FROM deposit_expenses e6 WHERE e6.deposit_id = d.id AND COALESCE(e6.review_status, 'pending') = 'pending') AS pending_expense_count, " +
      'd.submitted_by_id, d.submitted_by_name, ' +
      'd.created_at FROM deposits d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.deposit_date DESC, d.created_at DESC'
    );
    res.json({ deposits: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export deposits' });
  }
});

// GET /employees — who this manager (or admin/owner) may complete a deposit
// "on behalf of". Scoped exactly like editing a deposit (see utils/depositAccess.js):
// a manager only sees active users whose HOME CITY is one they are assigned to;
// admin/owner see everyone. Excludes the requester — submitting for yourself is
// the ordinary form above, it needs no picker. Must be registered before GET
// /:id, or Express would try to parse "employees" as a deposit id.
router.get('/employees', requireAuth, requirePermission('complete_deposit_for_employee'), async function(req, res) {
  try {
    const scope = await editCityScope(req);
    const { rows } = await pool.query(
      'SELECT id, name, home_city FROM users WHERE active = TRUE AND id <> $1 ORDER BY name ASC',
      [req.user.id]
    );
    const list = rows.filter(function (u) { return scopeAllows(scope, u.home_city); });
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch employee list' });
  }
});

// The full single-deposit shape: the row, its receipts, its expense lines with
// their review state, whether this viewer may edit it, and the history. Used by
// GET /:id and by the two writes that hand a fresh copy straight back, so a
// saved edit and a re-fetch can never disagree about what a deposit looks like.
async function depositPayload(req, id) {
  const { rows } = await pool.query('SELECT d.*, u.name AS current_user_name FROM deposits d LEFT JOIN users u ON u.id = d.user_id WHERE d.id = $1', [id]);
  if (!rows.length) return null;
  const dep = rows[0];
  if (dep.current_user_name) dep.user_name = dep.current_user_name;
  delete dep.current_user_name;
  dep.receipts = (await pool.query('SELECT id, image, filename FROM deposit_receipts WHERE deposit_id = $1 ORDER BY id', [dep.id])).rows;
  // Back-compat: surface the legacy single image as a receipt if no child rows exist.
  if (!dep.receipts.length && dep.receipt_image) {
    dep.receipts = [{ id: null, image: dep.receipt_image, filename: dep.receipt_filename || null }];
  }
  dep.expenses = (await pool.query('SELECT ' + EXPENSE_COLS + ' FROM deposit_expenses WHERE deposit_id = $1 ORDER BY id', [dep.id])).rows;
  // The client cannot work out the city scope on its own, so the server says
  // plainly whether THIS viewer may edit THIS deposit. The Edit and the
  // Approve/Deny buttons hang off this flag; both writes re-check it and never
  // trust the answer.
  dep.can_edit = await mayEditCity(req, dep.city_code);
  dep.history = await depositHistory(dep.id);
  return dep;
}

// Who is late, ranked, with the previous window beside it so the number means
// something. A count on its own says nothing: three in the last quarter is a
// problem if the quarter before was zero and an improvement if it was eight.
//
// Company-wide for a manager, matching how VIEWING deposits already works (the
// city scope in utils/depositAccess.js governs writing, not reading). A
// technician gets nothing here at all - one person's lateness is their own
// business, and a leaderboard of it is not something to hand the crew.
router.get('/late-summary', requireAuth, requirePermission('view_deposits'), async function (req, res) {
  try {
    if (!SEE_ALL.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    var months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 60);
    var city = (req.query.city || '').trim().toUpperCase();

    var params = [String(months)];
    var cityClause = '';
    if (city) { params.push(city); cityClause = ' AND UPPER(TRIM(d.city_code)) = $2 '; }
    var LATE = await lateEvents();

    const { rows } = await pool.query(
      'SELECT d.user_id, COALESCE(u.name, d.user_name) AS name, ' +
      '  MAX(UPPER(TRIM(COALESCE(u.home_city, d.city_code)))) AS city, ' +
      "  COUNT(*) FILTER (WHERE d.late_date > CURRENT_DATE - ($1 || ' months')::interval)::int AS n, " +
      "  COUNT(*) FILTER (WHERE d.late_date > CURRENT_DATE - ($1 || ' months')::interval * 2 " +
      "                     AND d.late_date <= CURRENT_DATE - ($1 || ' months')::interval)::int AS prev_n, " +
      // The half of the number that is worse than late, kept beside it rather
      // than folded away: three late deposits and three weeks that never
      // arrived are not the same conversation.
      "  COUNT(*) FILTER (WHERE d.missed AND d.late_date > CURRENT_DATE - ($1 || ' months')::interval)::int AS missed_n, " +
      "  MAX(d.late_date) FILTER (WHERE d.late_date > CURRENT_DATE - ($1 || ' months')::interval) AS last_date " +
      'FROM ' + LATE + ' d LEFT JOIN users u ON u.id = d.user_id ' +
      "WHERE d.late_date > CURRENT_DATE - ($1 || ' months')::interval * 2 " +
      cityClause +
      'GROUP BY d.user_id, COALESCE(u.name, d.user_name) ' +
      'HAVING COUNT(*) FILTER (WHERE d.late_date > CURRENT_DATE - ($1 || \' months\')::interval) > 0 ' +
      'ORDER BY n DESC, last_date DESC NULLS LAST',
      params
    );

    // Every late deposit in the window, bucketed by month, so the page can draw
    // the shape of it rather than only the total. Whether it is people or
    // process is usually visible here and nowhere else: everybody spiking in
    // the same month is a routine that broke, not a crew that got careless.
    var byMonth = [];
    try {
      const m = await pool.query(
        "SELECT TO_CHAR(DATE_TRUNC('month', d.late_date), 'YYYY-MM') AS ym, COUNT(*)::int AS n " +
        'FROM ' + LATE + ' d LEFT JOIN users u ON u.id = d.user_id ' +
        "WHERE d.late_date > CURRENT_DATE - ($1 || ' months')::interval " +
        cityClause +
        "GROUP BY DATE_TRUNC('month', d.late_date) ORDER BY 1 ASC",
        params
      );
      byMonth = m.rows.map(function (x) { return { month: x.ym, count: x.n }; });
    } catch (e) { byMonth = []; }

    res.json({
      months: months,
      city: city || null,
      total: rows.reduce(function (a, r) { return a + r.n; }, 0),
      people: rows.length,
      by_month: byMonth,
      rows: rows.map(function (r) {
        return {
          user_id: r.user_id,
          name: r.name,
          city: r.city || null,
          count: r.n,
          prev_count: r.prev_n,
          missed_count: r.missed_n || 0,
          last_date: ymdOf(r.last_date)
        };
      })
    });
  } catch (err) {
    console.error('[deposits] late summary failed:', err);
    res.status(500).json({ error: 'Could not build the late-deposit summary.' });
  }
});

/* ------------------------------------------------------ shortages ----------
   Resolving a gap between what Pulsar says was collected and what was banked.

   Two steps on purpose, and the reason is worth keeping in front of whoever
   edits this next. A late deposit is a fact: it arrived after the deadline or
   it did not. A shortage is a DISCREPANCY. It can be an expense nobody logged,
   a typo in the figure the technician typed, Pulsar being wrong, or cash that
   is genuinely missing, and until somebody looks you do not know which. Making
   a shortage one click from a write-up would mean documenting people for
   arithmetic.

   So the manager answers WHY first, and only 'cash_unaccounted' counts toward
   anybody's file. The other three answers close the row and count for nothing -
   which quietly gives you a measure of how often the board is wrong rather than
   the money.

   The gap is RECOMPUTED here from the Pulsar import and the deposits. The
   browser sends who and which pay week, never the number. */
var SHORTAGE_REASONS = ['expense_not_logged', 'typo', 'pulsar_wrong', 'cash_unaccounted'];
var SHORTAGE_MIN = 5;   // below this it is rounding noise, not a shortage

function n2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

// What the reconciliation board would show for this person in this pay week.
// Mirrors the maths in routes/pulsar.js: Pulsar cash minus (deposited plus the
// expenses that were not denied). A denied expense is one the company refused,
// so it stops offsetting what the technician owes.
async function shortageFigures(userId, periodStart, periodEnd) {
  const p = await pool.query(
    'SELECT COALESCE(SUM(cash), 0) AS cash FROM pulsar_cash_calls WHERE tech_user_id = $1 AND call_date >= $2 AND call_date <= $3',
    [userId, periodStart, periodEnd]
  );
  const d = await pool.query(
    'SELECT COALESCE(SUM(d.amount), 0) AS deposited, ' +
    "  COALESCE(SUM((SELECT COALESCE(SUM(e.amount), 0) FROM deposit_expenses e WHERE e.deposit_id = d.id AND COALESCE(e.review_status, 'pending') <> 'denied')), 0) AS expenses, " +
    '  MIN(d.city_code) AS city_code ' +
    'FROM deposits d WHERE d.user_id = $1 AND d.period_start = $2',
    [userId, periodStart]
  );
  var cash = n2(p.rows[0] && p.rows[0].cash);
  var deposited = n2(d.rows[0] && d.rows[0].deposited);
  var expenses = n2(d.rows[0] && d.rows[0].expenses);
  return {
    pulsar_cash: cash,
    deposited: deposited,
    expenses: expenses,
    gap: n2(cash - (deposited + expenses)),
    city_code: (d.rows[0] && d.rows[0].city_code) || null
  };
}

router.post('/shortage', requireAuth, requirePermission('edit_deposit'), async function (req, res) {
  try {
    if (!MANAGE.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    var b = req.body || {};
    var userId = parseInt(b.user_id, 10) || 0;
    var periodStart = String(b.period_start || '');
    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
      return res.status(400).json({ error: 'A technician and a pay period are required.' });
    }
    var reason = String(b.reason || '');
    if (SHORTAGE_REASONS.indexOf(reason) === -1) return res.status(400).json({ error: 'Say why the gap is there.' });

    const u = await pool.query('SELECT id, name, home_city FROM users WHERE id = $1', [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Technician not found' });

    var periodEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(b.period_end || '')) ? String(b.period_end) : periodStart;
    var fig = await shortageFigures(userId, periodStart, periodEnd);

    // The gap is the server's number, not the browser's, and the threshold is
    // enforced here as well as in the UI. A row that is a few cents out is
    // rounding, and counting it would make the number meaningless.
    if (fig.gap < SHORTAGE_MIN) {
      return res.status(400).json({ error: 'That pay week is not short by more than $' + SHORTAGE_MIN + '.' });
    }

    var city = fig.city_code || u.rows[0].home_city || null;
    const scope = await editCityScope(req);
    if (!scopeAllows(scope, city)) {
      return res.status(403).json({ error: 'You can only resolve shortages for the cities you are assigned to.' });
    }

    var counts = reason === 'cash_unaccounted';
    var note = (b.note != null) ? String(b.note).trim().slice(0, 2000) : null;
    if (counts && !note) return res.status(400).json({ error: 'Unaccounted cash needs a note saying what was established.' });

    const ins = await pool.query(
      'INSERT INTO deposit_shortages (user_id, user_name, city_code, period_start, period_end, gap_amount, ' +
      'pulsar_cash, deposited, expenses, reason, counts, note, resolved_by, resolved_by_name) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ' +
      'ON CONFLICT (user_id, period_start) DO UPDATE SET reason = EXCLUDED.reason, counts = EXCLUDED.counts, ' +
      'note = EXCLUDED.note, gap_amount = EXCLUDED.gap_amount, pulsar_cash = EXCLUDED.pulsar_cash, ' +
      'deposited = EXCLUDED.deposited, expenses = EXCLUDED.expenses, city_code = EXCLUDED.city_code, ' +
      'resolved_by = EXCLUDED.resolved_by, resolved_by_name = EXCLUDED.resolved_by_name, ' +
      'resolved_at = NOW(), updated_at = NOW() RETURNING id',
      [userId, u.rows[0].name, city, periodStart, periodEnd, fig.gap, fig.pulsar_cash, fig.deposited,
        fig.expenses, reason, counts, note, req.user.id, req.user.name]
    );

    await logAudit({
      entity_type: 'deposit_shortage', entity_id: ins.rows[0].id,
      action: counts ? 'shortage_unaccounted' : 'shortage_explained',
      user_id: req.user.id, user_name: req.user.name,
      details: { employee: u.rows[0].name, period_start: periodStart, gap: fig.gap, reason: reason }
    });

    var count = 0;
    try {
      const c = await pool.query(
        "SELECT COUNT(*)::int AS n FROM deposit_shortages WHERE user_id = $1 AND counts = true AND period_start > CURRENT_DATE - INTERVAL '12 months'",
        [userId]
      );
      count = c.rows.length ? c.rows[0].n : 0;
    } catch (e) {}

    res.json({ success: true, id: ins.rows[0].id, counts: counts, gap: fig.gap, unaccounted_12m: count });
  } catch (err) {
    console.error('[deposits] shortage resolve failed:', err);
    res.status(500).json({ error: 'Could not record the resolution.' });
  }
});

// Undo a resolution. The audit rows above are what remember it was ever made.
router.delete('/shortage/:id', requireAuth, requirePermission('edit_deposit'), async function (req, res) {
  try {
    if (!MANAGE.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await pool.query('SELECT * FROM deposit_shortages WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.json({ success: true });
    const scope = await editCityScope(req);
    if (!scopeAllows(scope, rows[0].city_code)) {
      return res.status(403).json({ error: 'You can only resolve shortages for the cities you are assigned to.' });
    }
    await pool.query('DELETE FROM deposit_shortages WHERE id = $1', [req.params.id]);
    await logAudit({
      entity_type: 'deposit_shortage', entity_id: rows[0].id, action: 'shortage_resolution_cleared',
      user_id: req.user.id, user_name: req.user.name,
      details: { employee: rows[0].user_name, period_start: rows[0].period_start, was: rows[0].reason }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[deposits] shortage clear failed:', err);
    res.status(500).json({ error: 'Could not clear it.' });
  }
});

// Unaccounted shortages for one person. Only the ones that COUNT come back -
// the explained ones are not part of anybody's record and are none of the
// employee file's business.
router.get('/shortages/:userId', requireAuth, requirePermission('view_deposits'), async function (req, res) {
  try {
    var uid = parseInt(req.params.userId, 10) || 0;
    if (!SEE_ALL.includes(req.user.role) && uid !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    var months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 60);
    const { rows } = await pool.query(
      'SELECT id, period_start, period_end, gap_amount, note, resolved_by_name, resolved_at, city_code ' +
      "FROM deposit_shortages WHERE user_id = $1 AND counts = true AND period_start > CURRENT_DATE - ($2 || ' months')::interval " +
      'ORDER BY period_start DESC',
      [uid, String(months)]
    );
    res.json({
      user_id: uid, months: months, count: rows.length,
      total: rows.reduce(function (a, r) { return a + Number(r.gap_amount || 0); }, 0),
      shortages: rows
    });
  } catch (err) {
    console.error('[deposits] shortage list failed:', err);
    res.status(500).json({ error: 'Could not load shortages.' });
  }
});

/* ------------------------------------------------------- missed ------------
   The deposit that never came.

   Marking a deposit late needs a deposit. The one row on the reconciliation
   board that cannot produce one is the worst row on it: Pulsar says cash was
   collected and nothing was ever submitted. Until this existed that row could
   be chased with a task and nothing else - the only case on the board that
   could not be documented was the case most worth documenting.

   So the mark hangs off the pay week instead, keyed by person and period the
   same way a shortage is, and it counts as one late deposit everywhere the
   count is read (utils/lateEvents.js).

   Gated exactly like marking a deposit late: edit_deposit, a manage role, and
   the city scope in utils/depositAccess.js. Same act, same rule.

   The city and the money are the SERVER's figures, taken from the Pulsar import
   for that person and week. The browser sends who and which week, never a
   number - the same rule as the shortage endpoint above. */

// Deposits are keyed on the pay week's Monday; the week runs six days past it.
function addDaysYmd(ymd, n) {
  var t = Date.parse(String(ymd) + 'T00:00:00Z');
  if (isNaN(t)) return ymd;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

// What Pulsar says this person collected in cash that week, and where.
async function missedFigures(userId, periodStart, periodEnd) {
  const p = await pool.query(
    'SELECT COALESCE(SUM(cash), 0) AS cash, COUNT(*)::int AS calls, MIN(city_code) AS city_code ' +
    'FROM pulsar_cash_calls WHERE tech_user_id = $1 AND call_date >= $2 AND call_date <= $3',
    [userId, periodStart, periodEnd]
  );
  var r = p.rows[0] || {};
  return { pulsar_cash: n2(r.cash), calls: r.calls || 0, city_code: r.city_code || null };
}

router.post('/missed', requireAuth, requirePermission('edit_deposit'), async function (req, res) {
  try {
    if (!MANAGE.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    var b = req.body || {};
    var userId = parseInt(b.user_id, 10) || 0;
    var periodStart = String(b.period_start || '');
    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
      return res.status(400).json({ error: 'A technician and a pay period are required.' });
    }
    var marking = !(b.missed === false || b.late === false);

    const u = await pool.query('SELECT id, name, home_city FROM users WHERE id = $1', [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Technician not found' });
    var who = u.rows[0].name;

    var periodEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(b.period_end || ''))
      ? String(b.period_end) : addDaysYmd(periodStart, 6);

    // Clearing first: it must keep working even for a week that has since
    // received its deposit, because that is exactly when somebody looks again.
    if (!marking) {
      const ex = await pool.query('SELECT * FROM deposit_missed WHERE user_id = $1 AND period_start = $2', [userId, periodStart]);
      if (!ex.rows.length) return res.json({ success: true, late: false, late_count_12m: await lateCount(userId, 12) });
      const scope0 = await editCityScope(req);
      if (!scopeAllows(scope0, ex.rows[0].city_code)) {
        return res.status(403).json({ error: 'You can only mark deposits late for the cities you are assigned to.' });
      }
      await pool.query('DELETE FROM deposit_missed WHERE id = $1', [ex.rows[0].id]);
      await logAudit({
        entity_type: 'deposit_missed', entity_id: ex.rows[0].id,
        entity_number: periodStart,
        action: 'late_cleared',
        user_id: req.user.id, user_name: req.user.name,
        details: { employee: who, period_start: periodStart, no_deposit: true }
      });
      return res.json({ success: true, late: false, late_count_12m: await lateCount(userId, 12) });
    }

    // A week that HAS a deposit is not a missed week, and letting it be marked
    // as one would put two marks on one week and count it twice. The deposit is
    // the better record when there is one, so the answer is to go mark that.
    const dep = await pool.query(
      'SELECT COUNT(*)::int AS n FROM deposits WHERE user_id = $1 AND period_start = $2',
      [userId, periodStart]
    );
    if (dep.rows[0] && dep.rows[0].n > 0) {
      return res.status(400).json({
        error: 'There is a deposit for that pay week now. Mark the deposit itself late instead.'
      });
    }

    var fig = await missedFigures(userId, periodStart, periodEnd);
    var city = fig.city_code || u.rows[0].home_city || null;
    const scope = await editCityScope(req);
    if (!scopeAllows(scope, city)) {
      return res.status(403).json({ error: 'You can only mark deposits late for the cities you are assigned to.' });
    }

    var reason = (b.reason != null) ? String(b.reason).trim().slice(0, 2000) : null;
    if (!reason) reason = null;

    const ins = await pool.query(
      'INSERT INTO deposit_missed (user_id, user_name, city_code, period_start, period_end, ' +
      'pulsar_cash, calls, reason, marked_by, marked_by_name) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ' +
      'ON CONFLICT (user_id, period_start) DO UPDATE SET period_end = EXCLUDED.period_end, ' +
      'city_code = EXCLUDED.city_code, pulsar_cash = EXCLUDED.pulsar_cash, calls = EXCLUDED.calls, ' +
      'reason = EXCLUDED.reason, marked_by = EXCLUDED.marked_by, marked_by_name = EXCLUDED.marked_by_name, ' +
      'marked_at = NOW(), updated_at = NOW() RETURNING id',
      [userId, who, city, periodStart, periodEnd, fig.pulsar_cash, fig.calls, reason, req.user.id, req.user.name]
    );

    await logAudit({
      entity_type: 'deposit_missed', entity_id: ins.rows[0].id,
      entity_number: periodStart,
      action: 'marked_late',
      user_id: req.user.id, user_name: req.user.name,
      details: {
        employee: who, period_start: periodStart, period_end: periodEnd,
        no_deposit: true, pulsar_cash: fig.pulsar_cash, reason: reason || undefined
      }
    });

    res.json({
      success: true, late: true, missed: true, id: ins.rows[0].id,
      pulsar_cash: fig.pulsar_cash,
      late_count_12m: await lateCount(userId, 12)
    });
  } catch (err) {
    console.error('[deposits] missed mark failed:', err);
    res.status(500).json({ error: 'Could not mark the pay week.' });
  }
});

// Every pay week marked as never deposited for one person. Same scoping as the
// late list below it.
router.get('/missed/:userId', requireAuth, requirePermission('view_deposits'), async function (req, res) {
  try {
    var uid = parseInt(req.params.userId, 10) || 0;
    if (!SEE_ALL.includes(req.user.role) && uid !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    var months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 60);
    const { rows } = await pool.query(
      'SELECT id, period_start, period_end, city_code, pulsar_cash, calls, reason, marked_by_name, marked_at ' +
      "FROM deposit_missed WHERE user_id = $1 AND COALESCE(period_end, period_start + 6) > CURRENT_DATE - ($2 || ' months')::interval " +
      'ORDER BY period_start DESC',
      [uid, String(months)]
    );
    res.json({ user_id: uid, months: months, count: rows.length, missed: rows });
  } catch (err) {
    console.error('[deposits] missed list failed:', err);
    res.status(500).json({ error: 'Could not load the missed deposits.' });
  }
});

// GET /:id — single deposit incl. receipts and expenses (owner or see-all roles)
router.get('/:id', requireAuth, requirePermission('view_deposits'), async function(req, res) {
  try {
    // The ownership gate runs on its own cheap query FIRST, so a tech who is
    // not allowed to see this deposit never causes its images to be read.
    const own = await pool.query('SELECT user_id FROM deposits WHERE id = $1', [req.params.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Deposit not found' });
    if (!SEE_ALL.includes(req.user.role) && own.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const dep = await depositPayload(req, req.params.id);
    if (!dep) return res.status(404).json({ error: 'Deposit not found' });
    res.json(dep);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch deposit' });
  }
});

// GET /:id/expenses/:expenseId/file — a short-lived link to that line's
// attachment. The bytes live in R2, so this hands back a presigned URL rather
// than proxying the file; ?inline=1 previews (PDFs, images) instead of saving.
// Gated exactly like GET /:id: a tech sees their own deposits, see-all roles see
// every one. Deliberately checked on its own cheap query before any key is read.
router.get('/:id/expenses/:expenseId/file', requireAuth, requirePermission('view_deposits'), async function(req, res) {
  try {
    const own = await pool.query('SELECT user_id FROM deposits WHERE id = $1', [req.params.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Deposit not found' });
    if (!SEE_ALL.includes(req.user.role) && own.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const exq = await pool.query(
      'SELECT file_key, file_name, file_mime FROM deposit_expenses WHERE id = $1 AND deposit_id = $2',
      [req.params.expenseId, req.params.id]
    );
    if (!exq.rows.length) return res.status(404).json({ error: 'That expense is not on this deposit.' });
    const row = exq.rows[0];
    if (!row.file_key) return res.status(404).json({ error: 'There is no file on that expense.' });
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not set up, so this attachment cannot be opened.' });
    const url = await r2.presignDownload(
      row.file_key,
      row.file_name || 'receipt',
      req.query.inline === '1',
      300,
      row.file_mime || undefined
    );
    res.json({ url: url, file_name: row.file_name || 'receipt' });
  } catch (err) {
    console.error('Deposit expense file link failed:', err.message);
    res.status(500).json({ error: 'Could not open that attachment.' });
  }
});

// PUT /:id — correct a submitted deposit. Manager-and-above, and a manager only
// within their own cities (see editCityScope above); admin/owner anywhere.
//
// Body is the DESIRED end state, not a patch:
//   amount, pulsar_owed, deposit_date, period_start, period_end, city_code, notes
//   expenses[]      - the full list. { id } keeps/updates an existing row,
//                     no id inserts a new one, and any existing row whose id is
//                     absent is deleted. { image } replaces that line's photo,
//                     { file_key } replaces it with an uploaded file (a photo and
//                     a file are the same slot - setting one clears the other),
//                     { remove_photo:true } clears whichever is there.
//   receipts_keep[] - ids of existing deposit_receipts rows to KEEP. Anything
//                     not listed is deleted.
//   receipts_add[]  - { image, filename } new photos.
//   keep_legacy_receipt - only meaningful on an old deposit whose single photo
//                     still lives in deposits.receipt_image. Either way that
//                     column is retired on the first edit: true migrates it into
//                     deposit_receipts, false drops it.
router.put('/:id', requireAuth, requirePermission('edit_deposit'), async function(req, res) {
  const client = await pool.connect();
  try {
    const { rows: cur } = await pool.query('SELECT * FROM deposits WHERE id = $1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Deposit not found' });
    const dep = cur[0];

    // Role + city gate on where the deposit is NOW.
    if (!MANAGE.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const scope = await editCityScope(req);
    if (!scopeAllows(scope, dep.city_code)) {
      return res.status(403).json({ error: 'You can only edit deposits for the cities you are assigned to.' });
    }

    const amt = money2(req.body.amount);
    if (amt === null || amt < 0) {
      return res.status(400).json({ error: 'A valid deposit amount is required' });
    }
    const deposit_date = dateOrNull(req.body.deposit_date);
    if (!deposit_date) {
      return res.status(400).json({ error: 'Deposit date is required' });
    }
    const owed = money2(req.body.pulsar_owed);
    if (owed === null) {
      return res.status(400).json({ error: 'Pulsar shows owed amount is required' });
    }
    const city_code = (req.body.city_code == null ? '' : String(req.body.city_code)).trim().toUpperCase() || null;
    if (!city_code) {
      return res.status(400).json({ error: 'City is required' });
    }
    // Moving a deposit INTO a city is the same act as editing one already there,
    // so the destination has to be in scope too. Otherwise a scoped manager
    // could push a deposit somewhere they cannot see it again.
    if (!scopeAllows(scope, city_code)) {
      return res.status(403).json({ error: 'You can only move a deposit into a city you are assigned to.' });
    }
    const period_start = dateOrNull(req.body.period_start);
    const period_end = dateOrNull(req.body.period_end);
    const notes = (req.body.notes == null || String(req.body.notes).trim() === '') ? null : String(req.body.notes);

    // Existing children, read before the transaction so validation can fail fast.
    const exRows = (await pool.query("SELECT id, receipt_image, file_key, amount, COALESCE(review_status, 'pending') AS review_status FROM deposit_expenses WHERE deposit_id = $1", [dep.id])).rows;
    const exById = {};
    exRows.forEach(function (r) { exById[String(r.id)] = r; });
    const rcRows = (await pool.query('SELECT id FROM deposit_receipts WHERE deposit_id = $1', [dep.id])).rows;
    const rcIds = rcRows.map(function (r) { return r.id; });

    // Same receipt policy as submission: every expense line carries a photo, or
    // an explicit "no receipt" with a written reason. An existing photo the
    // editor did not touch counts.
    const rawExpenses = Array.isArray(req.body.expenses) ? req.body.expenses : [];
    // Attachments resolved up front, same as on submission, so a spreadsheet
    // satisfies the receipt policy exactly like a photo does.
    const editFiles = [];
    for (let k = 0; k < rawExpenses.length; k++) {
      const rf = await resolveExpenseFile(rawExpenses[k], req.user.id);
      if (rf.error) return res.status(400).json({ error: rf.error });
      editFiles.push(rf.file);
    }
    // Objects whose row no longer points at them once this save lands. Deleted
    // from R2 after the COMMIT, never before - see dropExpenseObjects.
    const staleKeys = [];
    const cleanExpenses = [];
    for (let k = 0; k < rawExpenses.length; k++) {
      const ex = rawExpenses[k];
      if (!ex) continue;
      const exAmt = parseFloat(ex.amount);
      const desc = (ex.description == null ? '' : String(ex.description)).trim();
      const touched = !!ex.image || !!editFiles[k] || ex.no_receipt === true || ex.no_receipt === 'true' || (ex.id != null && ex.id !== '');
      if (!desc && isNaN(exAmt) && !touched) continue;
      // Description is mandatory: an amount with no explanation cannot be reconciled.
      if (!desc) {
        return res.status(400).json({ error: 'A description is required for expense ' + (k + 1) + ' (what the money was spent on).' });
      }
      const label = desc;
      if (!isNaN(exAmt) && exAmt < 0) {
        return res.status(400).json({ error: 'Expense amount cannot be negative for "' + label + '".' });
      }
      const existing = (ex.id != null && ex.id !== '') ? exById[String(ex.id)] : null;
      if (ex.id != null && ex.id !== '' && !existing) {
        return res.status(400).json({ error: 'An expense line on this form no longer exists. Reload the deposit and try again.' });
      }
      const removePhoto = ex.remove_photo === true || ex.remove_photo === 'true';
      const newPhoto = ex.image ? String(ex.image) : null;
      const newFile = editFiles[k] || null;
      // One attachment slot per line: a new photo replaces a file and vice versa,
      // and "remove" clears whichever is on the row.
      const keptPhoto = (!removePhoto && !newPhoto && !newFile && existing && existing.receipt_image) ? true : false;
      const keptFile = (!removePhoto && !newPhoto && !newFile && existing && existing.file_key) ? true : false;
      const hasPhoto = !!newPhoto || !!newFile || keptPhoto || keptFile;
      if (existing && existing.file_key && !keptFile) staleKeys.push(existing.file_key);
      const override = ex.no_receipt === true || ex.no_receipt === 'true';
      const reason = (ex.no_receipt_reason == null ? '' : String(ex.no_receipt_reason)).trim();
      if (!hasPhoto && !override) {
        return res.status(400).json({ error: 'A receipt is required for "' + label + '" - a photo or a file. If there is none, tick "No receipt" and explain why.' });
      }
      if (!hasPhoto && override && !reason) {
        return res.status(400).json({ error: 'Please explain why there is no receipt for "' + label + '".' });
      }
      // Changing what a line is WORTH invalidates any decision already made on
      // it: an approval was for the old figure, and a denial of the old figure
      // should not silently carry over to a corrected one. So an amount change
      // sends the line back to pending. Fixing a typo in the description, or
      // swapping the photo, leaves the decision alone.
      const newAmount = isNaN(exAmt) ? 0 : Math.round(exAmt * 100) / 100;
      const resetReview = !!existing && Math.abs(parseFloat(existing.amount || 0) - newAmount) >= 0.005;
      cleanExpenses.push({
        id: existing ? existing.id : null,
        description: desc.slice(0, 500) || null,
        amount: newAmount,
        resetReview: resetReview,
        // Where this line ENDS UP after the save - a new line and a reset line
        // are both pending, which counts.
        reviewStatus: (!existing || resetReview) ? 'pending' : existing.review_status,
        newPhoto: newPhoto,
        newFile: newFile,
        filename: ex.filename ? String(ex.filename).slice(0, 255) : null,
        removePhoto: removePhoto,
        hasPhoto: hasPhoto,
        no_receipt: !hasPhoto,
        no_receipt_reason: hasPhoto ? null : (reason.slice(0, 1000) || null)
      });
    }

    // Same rule as submission: an edit may zero the deposit, but only on a record
    // that still carries expense money. Checked here, once the lines are validated.
    let cleanExpenseTotal = 0;
    cleanExpenses.forEach(function (e) { if (e.amount > 0) cleanExpenseTotal += e.amount; });
    if (amt === 0 && cleanExpenseTotal <= 0) {
      return res.status(400).json({ error: 'A $0.00 deposit needs at least one expense on it.' });
    }

    // Receipts: which existing rows survive, and what is being added.
    const keepRaw = Array.isArray(req.body.receipts_keep) ? req.body.receipts_keep : rcIds;
    const keepIds = keepRaw.map(function (v) { return parseInt(v, 10); }).filter(function (n) { return !isNaN(n) && rcIds.indexOf(n) !== -1; });
    const addRaw = Array.isArray(req.body.receipts_add) ? req.body.receipts_add : [];
    const adds = addRaw.filter(function (r) { return r && r.image; });
    const hasLegacy = !!dep.receipt_image && rcIds.length === 0;
    const keepLegacy = hasLegacy && (req.body.keep_legacy_receipt === undefined || req.body.keep_legacy_receipt === true || req.body.keep_legacy_receipt === 'true');

    // Recompute the "changed after the AI read the receipt" flag against the NEW
    // numbers, so the banner on the deposit stays true after a correction.
    const aiAmount = (dep.ai_amount == null) ? null : parseFloat(dep.ai_amount);
    const aiDate = ymdOf(dep.ai_deposit_date);
    const aiEdited = (aiAmount != null && Math.abs(aiAmount - amt) >= 0.005) || (aiDate != null && aiDate !== deposit_date);

    // Counted only, both sides, so the "Expense total" line in the history is
    // comparing like with like and a denial does not read as a phantom edit.
    const oldExpenseTotal = (await pool.query('SELECT COALESCE(SUM(amount),0) AS t FROM deposit_expenses WHERE deposit_id = $1 AND ' + counted(), [dep.id])).rows[0].t;

    await client.query('BEGIN');
    await client.query(
      'UPDATE deposits SET amount = $1, pulsar_owed = $2, deposit_date = $3, period_start = $4, period_end = $5, ' +
      'city_code = $6, notes = $7, ai_edited = $8, updated_at = NOW() WHERE id = $9',
      [amt, owed, deposit_date, period_start, period_end, city_code, notes, aiEdited, dep.id]
    );

    // Retire the legacy single-image column on the first edit, either by moving
    // it into deposit_receipts or by dropping it, so every later edit deals with
    // one uniform list of receipt rows.
    if (hasLegacy) {
      if (keepLegacy) {
        await client.query('INSERT INTO deposit_receipts (deposit_id, image, filename) VALUES ($1,$2,$3)', [dep.id, dep.receipt_image, dep.receipt_filename || null]);
      }
      await client.query('UPDATE deposits SET receipt_image = NULL, receipt_filename = NULL WHERE id = $1', [dep.id]);
    }
    // Delete the receipts that were not kept.
    const dropIds = rcIds.filter(function (n) { return keepIds.indexOf(n) === -1; });
    if (dropIds.length) {
      await client.query('DELETE FROM deposit_receipts WHERE deposit_id = $1 AND id = ANY($2::int[])', [dep.id, dropIds]);
    }
    for (let a = 0; a < adds.length; a++) {
      await client.query('INSERT INTO deposit_receipts (deposit_id, image, filename) VALUES ($1,$2,$3)', [dep.id, adds[a].image, adds[a].filename || null]);
    }

    // Expenses: drop the lines that are gone, update the kept ones, insert new.
    const keptExpenseIds = cleanExpenses.map(function (e) { return e.id; }).filter(function (v) { return v != null; });
    const dropExpenseIds = exRows.map(function (r) { return r.id; }).filter(function (n) { return keptExpenseIds.indexOf(n) === -1; });
    exRows.forEach(function (r) { if (r.file_key && dropExpenseIds.indexOf(r.id) !== -1) staleKeys.push(r.file_key); });
    if (dropExpenseIds.length) {
      await client.query('DELETE FROM deposit_expenses WHERE deposit_id = $1 AND id = ANY($2::int[])', [dep.id, dropExpenseIds]);
    }
    let expenseTotal = 0;
    for (let j = 0; j < cleanExpenses.length; j++) {
      const e = cleanExpenses[j];
      if (e.reviewStatus !== 'denied') expenseTotal += e.amount;
      if (e.id != null) {
        if (e.newPhoto) {
          await client.query(
            'UPDATE deposit_expenses SET description = $1, amount = $2, receipt_image = $3, receipt_filename = $4, ' +
            'file_key = NULL, file_name = NULL, file_mime = NULL, file_size = NULL, ' +
            'no_receipt = FALSE, no_receipt_reason = NULL WHERE id = $5 AND deposit_id = $6',
            [e.description, e.amount, e.newPhoto, e.filename, e.id, dep.id]
          );
        } else if (e.newFile) {
          await client.query(
            'UPDATE deposit_expenses SET description = $1, amount = $2, receipt_image = NULL, receipt_filename = NULL, ' +
            'file_key = $3, file_name = $4, file_mime = $5, file_size = $6, ' +
            'no_receipt = FALSE, no_receipt_reason = NULL WHERE id = $7 AND deposit_id = $8',
            [e.description, e.amount, e.newFile.key, e.newFile.name, e.newFile.mime, e.newFile.size, e.id, dep.id]
          );
        } else if (e.removePhoto) {
          await client.query(
            'UPDATE deposit_expenses SET description = $1, amount = $2, receipt_image = NULL, receipt_filename = NULL, ' +
            'file_key = NULL, file_name = NULL, file_mime = NULL, file_size = NULL, ' +
            'no_receipt = $3, no_receipt_reason = $4 WHERE id = $5 AND deposit_id = $6',
            [e.description, e.amount, e.no_receipt, e.no_receipt_reason, e.id, dep.id]
          );
        } else {
          // Attachment untouched — leave receipt_image and the file pointer alone
          // rather than rewriting a multi-hundred-KB data URL on every save.
          await client.query(
            'UPDATE deposit_expenses SET description = $1, amount = $2, no_receipt = $3, no_receipt_reason = $4 WHERE id = $5 AND deposit_id = $6',
            [e.description, e.amount, e.no_receipt, e.no_receipt_reason, e.id, dep.id]
          );
        }
        // Kept out of the three branches above deliberately: it applies to all
        // of them and to none of their photo bookkeeping.
        if (e.resetReview) {
          await client.query(
            "UPDATE deposit_expenses SET review_status = 'pending', review_reason = NULL, reviewed_by = NULL, reviewed_by_name = NULL, reviewed_at = NULL WHERE id = $1 AND deposit_id = $2",
            [e.id, dep.id]
          );
        }
      } else {
        await client.query(
          'INSERT INTO deposit_expenses (deposit_id, description, amount, receipt_image, receipt_filename, no_receipt, no_receipt_reason, file_key, file_name, file_mime, file_size) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [
            dep.id, e.description, e.amount, e.newPhoto, e.filename, e.no_receipt, e.no_receipt_reason,
            e.newFile ? e.newFile.key : null, e.newFile ? e.newFile.name : null,
            e.newFile ? e.newFile.mime : null, e.newFile ? e.newFile.size : null
          ]
        );
      }
    }
    await client.query('COMMIT');
    // Committed, so the rows no longer point at these objects. Best effort.
    await dropExpenseObjects(staleKeys);

    // Field-by-field diff for the audit log and the on-page history panel.
    const changes = {};
    function note(field, from, to) {
      if (String(from == null ? '' : from) !== String(to == null ? '' : to)) changes[field] = { from: from == null ? null : from, to: to == null ? null : to };
    }
    note('amount', dep.amount == null ? null : parseFloat(dep.amount).toFixed(2), amt.toFixed(2));
    note('pulsar_owed', dep.pulsar_owed == null ? null : parseFloat(dep.pulsar_owed).toFixed(2), owed.toFixed(2));
    note('deposit_date', ymdOf(dep.deposit_date), deposit_date);
    note('period_start', ymdOf(dep.period_start), period_start);
    note('period_end', ymdOf(dep.period_end), period_end);
    note('city_code', dep.city_code ? String(dep.city_code).trim() : null, city_code);
    note('notes', dep.notes, notes);
    note('expense_total', parseFloat(oldExpenseTotal || 0).toFixed(2), expenseTotal.toFixed(2));
    note('expense_lines', exRows.length, cleanExpenses.length);
    note('receipt_count', rcIds.length + (hasLegacy ? 1 : 0), keepIds.length + adds.length + (keepLegacy ? 1 : 0));

    await logAudit({
      entity_type: 'deposit',
      entity_id: dep.id,
      entity_number: dep.deposit_number,
      action: 'edited',
      user_id: req.user.id,
      user_name: req.user.name,
      details: { changes: changes, reason: (req.body.edit_reason == null ? '' : String(req.body.edit_reason)).trim().slice(0, 500) || null }
    });

    // Hand back the same shape GET /:id returns so the client can re-render
    // without a second round trip.
    res.json(await depositPayload(req, dep.id));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Deposit edit failed:', err);
    res.status(500).json({ error: 'Failed to save changes to this deposit' });
  } finally {
    client.release();
  }
});

// POST /:id/expenses/:expenseId/review — approve or deny ONE expense line.
//
// Body: { status: 'approved' | 'denied' | 'pending', reason }
//   - a denial REQUIRES a written reason; it is what the tech will read.
//   - approving (or sending a line back to pending) clears any old reason.
// Held to exactly the same gate as editing the deposit: the edit_deposit
// permission, a manage role, and the manager's own cities. Denying a line
// changes what the tech owes, so it is an edit in every way that matters.
router.post('/:id/expenses/:expenseId/review', requireAuth, requirePermission('edit_deposit'), async function(req, res) {
  try {
    const { rows: cur } = await pool.query('SELECT id, deposit_number, city_code FROM deposits WHERE id = $1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Deposit not found' });
    const dep = cur[0];

    if (!MANAGE.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const scope = await editCityScope(req);
    if (!scopeAllows(scope, dep.city_code)) {
      return res.status(403).json({ error: 'You can only review expenses for the cities you are assigned to.' });
    }

    const status = (req.body.status == null ? '' : String(req.body.status)).trim().toLowerCase();
    if (REVIEW_STATUSES.indexOf(status) === -1) {
      return res.status(400).json({ error: 'Status must be approved, denied or pending.' });
    }
    const reason = (req.body.reason == null ? '' : String(req.body.reason)).trim().slice(0, 1000);
    if (status === 'denied' && !reason) {
      return res.status(400).json({ error: 'Please say why this expense is being denied.' });
    }

    const exq = await pool.query(
      "SELECT id, description, amount, COALESCE(review_status, 'pending') AS review_status, review_reason " +
      'FROM deposit_expenses WHERE id = $1 AND deposit_id = $2',
      [req.params.expenseId, dep.id]
    );
    if (!exq.rows.length) return res.status(404).json({ error: 'That expense is not on this deposit.' });
    const ex = exq.rows[0];
    const from = ex.review_status;
    const reviewed = status !== 'pending';

    await pool.query(
      'UPDATE deposit_expenses SET review_status = $1, review_reason = $2, reviewed_by = $3, reviewed_by_name = $4, ' +
      'reviewed_at = ' + (reviewed ? 'NOW()' : 'NULL') + ' WHERE id = $5 AND deposit_id = $6',
      [
        status,
        status === 'denied' ? reason : null,
        reviewed ? req.user.id : null,
        reviewed ? req.user.name : null,
        ex.id,
        dep.id
      ]
    );

    // Logged under its own action rather than 'edited' so the deposit's history
    // panel and the Audit Log page can tell "a manager denied a $40 line" apart
    // from "a manager retyped the deposit amount". Re-stating a decision that
    // has not actually changed writes nothing, so clicking Approve twice does
    // not fill the history with no-ops.
    if (from !== status || (status === 'denied' && (ex.review_reason || '') !== reason)) {
      await logAudit({
        entity_type: 'deposit',
        entity_id: dep.id,
        entity_number: dep.deposit_number,
        action: 'expense_review',
        user_id: req.user.id,
        user_name: req.user.name,
        details: {
          expense_id: ex.id,
          description: ex.description || null,
          amount: parseFloat(ex.amount || 0).toFixed(2),
          from: from,
          to: status,
          reason: status === 'denied' ? reason : null
        }
      });
    }

    res.json(await depositPayload(req, dep.id));
  } catch (err) {
    console.error('Deposit expense review failed:', err);
    res.status(500).json({ error: 'Failed to save that decision' });
  }
});

// DELETE /:id — admin/manager only. Child receipts/expenses cascade.
router.delete('/:id', requireAuth, requirePermission('delete_deposit'), async function(req, res) {
  if (!MANAGE.includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    // Read the expense attachments BEFORE the delete cascades their rows away,
    // so the objects can follow the record out. Never blocks the delete.
    let doomedKeys = [];
    try {
      doomedKeys = (await pool.query('SELECT file_key FROM deposit_expenses WHERE deposit_id = $1 AND file_key IS NOT NULL', [req.params.id]))
        .rows.map(function (r) { return r.file_key; });
    } catch (e) { doomedKeys = []; }
    const { rows } = await pool.query('DELETE FROM deposits WHERE id = $1 RETURNING id, deposit_number', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Deposit not found' });
    await dropExpenseObjects(doomedKeys);
    await logAudit({
      entity_type: 'deposit',
      entity_id: rows[0].id,
      entity_number: rows[0].deposit_number,
      action: 'deleted',
      user_id: req.user.id,
      user_name: req.user.name
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete deposit' });
  }
});

/* --------------------------------------------------------------- late ------
   Marking a deposit late.

   This is a judgment call and it stays one. Nova is not deciding lateness on
   its own: it has no view of the excuse, the truck that broke down or the bank
   that shut early, and a system that guessed would be wrong often enough to
   poison the very record this exists to feed. A manager marks it, their name
   goes on it, and it can be taken back off.

   Gated exactly like editing a deposit - role plus the city scope in
   utils/depositAccess.js - because it is the same kind of act: writing a
   judgment onto another location's books. One copy of that rule, one place to
   change it.

   The count is the point. "How many times has he been late?" is the question
   somebody is trying to answer at the moment they are writing a warning, and
   answering it from memory is how a warning ends up wrong. */
router.post('/:id/late', requireAuth, requirePermission('edit_deposit'), async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT id, deposit_number, city_code, user_id, user_name, deposit_date, is_late FROM deposits WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Deposit not found' });
    const dep = rows[0];

    if (!MANAGE.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    const scope = await editCityScope(req);
    if (!scopeAllows(scope, dep.city_code)) {
      return res.status(403).json({ error: 'You can only mark deposits late for the cities you are assigned to.' });
    }

    const late = req.body && req.body.late === false ? false : true;
    const reason = (req.body && req.body.reason != null) ? String(req.body.reason).trim().slice(0, 2000) : null;

    if (late) {
      await pool.query(
        'UPDATE deposits SET is_late = true, late_marked_at = NOW(), late_marked_by = $2, late_marked_by_name = $3, late_reason = $4, updated_at = NOW() WHERE id = $1',
        [dep.id, req.user.id, req.user.name, reason]
      );
    } else {
      // Clearing wipes the whole mark rather than leaving a half-record behind.
      // The audit row below is what remembers that it was ever set.
      await pool.query(
        'UPDATE deposits SET is_late = false, late_marked_at = NULL, late_marked_by = NULL, late_marked_by_name = NULL, late_reason = NULL, updated_at = NOW() WHERE id = $1',
        [dep.id]
      );
    }

    await logAudit({
      entity_type: 'deposit',
      entity_id: dep.id,
      entity_number: dep.deposit_number,
      action: late ? 'marked_late' : 'late_cleared',
      user_id: req.user.id,
      user_name: req.user.name,
      details: { employee: dep.user_name, deposit_date: dep.deposit_date, reason: reason || undefined }
    });

    // How many times this person has been late in the last 12 months, handed
    // straight back so the button can say so without a second round trip. Pay
    // weeks that never produced a deposit at all are part of that number - see
    // utils/lateEvents.js for why they are counted together and how a week that
    // is marked both ways is stopped from counting twice.
    var count = await lateCount(dep.user_id, 12);

    res.json({ success: true, late: late, late_count_12m: count });
  } catch (err) {
    console.error('[deposits] late mark failed:', err);
    res.status(500).json({ error: 'Could not mark the deposit.' });
  }
});

// Every late deposit for one person, newest first. Read by the Employee Files
// record module to pre-fill documentation with the real dates rather than a
// remembered number.
router.get('/late/:userId', requireAuth, requirePermission('view_deposits'), async function (req, res) {
  try {
    var uid = parseInt(req.params.userId, 10) || 0;
    if (!SEE_ALL.includes(req.user.role) && uid !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    var months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 60);
    // Field names are kept as they were so every existing reader still works;
    // a pay week that never produced a deposit arrives with id and number null,
    // missed = true, and the end of the pay week as its date.
    const { rows } = await pool.query(
      'SELECT d.deposit_id AS id, d.deposit_number, d.late_date AS deposit_date, d.amount, d.city_code, ' +
      '  d.marked_at AS late_marked_at, d.marked_by_name AS late_marked_by_name, d.reason AS late_reason, ' +
      '  d.missed, d.period_start ' +
      'FROM ' + (await lateEvents()) + ' d ' +
      "WHERE d.user_id = $1 AND d.late_date > CURRENT_DATE - ($2 || ' months')::interval " +
      'ORDER BY d.late_date DESC',
      [uid, String(months)]
    );
    res.json({ user_id: uid, months: months, count: rows.length, deposits: rows });
  } catch (err) {
    console.error('[deposits] late list failed:', err);
    res.status(500).json({ error: 'Could not load late deposits.' });
  }
});

module.exports = router;
