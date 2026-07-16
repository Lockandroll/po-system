// Work Orders intake job — polls the work-orders mailbox via Microsoft Graph,
// parses each new email with Claude, resolves the account, creates a pending
// sign-off sheet, and drops the work order into the review queue (status
// 'received'). Mirrors the GEICO ingest pattern. Idempotent: dedup on
// email_message_id (UNIQUE), so re-polling the same window is safe.

const cron = require('node-cron');
const { pool } = require('../db');
const { getInboxMessages, getMessageAttachments } = require('../utils/graph');
const { looksLikeWorkOrder, parseWorkOrderEmail } = require('../utils/workOrderParser');
const notify = require('../utils/notify');
const push = require('../utils/push');
const { logAudit } = require('../utils/audit');
const { sendEmail, emailTemplate } = require('../utils/email');

const ATTACH_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per attachment cap

async function getSetting(key) {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : null;
  } catch (e) { return null; }
}

async function cfg() {
  const mailbox = process.env.WORK_ORDERS_MAILBOX || (await getSetting('work_orders_mailbox')) || 'workorders@popalockar.com';
  const enabledSetting = await getSetting('work_orders_enabled');
  const enabled = (process.env.WORK_ORDERS_ENABLED === 'true') || (enabledSetting === 'true');
  const systemUserId = parseInt(process.env.WORK_ORDERS_SYSTEM_USER_ID || (await getSetting('work_orders_system_user_id')) || '0', 10) || null;
  const signoffOn = (await getSetting('work_orders_signoff_on')) || 'accept';
  return { mailbox: mailbox, enabled: enabled, systemUserId: systemUserId, signoffOn: signoffOn };
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'unknown' || s.toLowerCase() === 'null') return null;
  return s;
}
function dateOrNull(v) {
  const s = strOrNull(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
// VINs are printed one character per box on these forms, so the AI can hand back
// "5 L M P J 8 K A 3 T J 0 6 2 3 3 7". Strip everything that is not a VIN character.
function normalizeVin(v) {
  const s = strOrNull(v);
  if (!s) return null;
  const clean = s.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
  return clean.length >= 11 ? clean.slice(0, 17) : null;
}
// NTE comes off the form as "$1,250.00", "1250", "NTE 450" — anything but a number.
function moneyOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (!s || s === '.' || s === '-') return null;
  const n = parseFloat(s);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}
function money(n) {
  if (n === null || n === undefined || n === '') return 'none';
  const v = parseFloat(n);
  if (!isFinite(v)) return 'none';
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Trust the AI's call, but a VIN or a vehicle repair code is decisive on its own.
function jobTypeOf(parsed) {
  const t = String((parsed && parsed.job_type) || '').toLowerCase();
  if (t === 'vehicle') return 'vehicle';
  if (t === 'site') return 'site';
  return normalizeVin(parsed && parsed.vin) ? 'vehicle' : 'site';
}

async function genWoRef() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(wo_ref,'-',3) AS INTEGER)) AS maxseq FROM work_orders WHERE wo_ref LIKE $1",
    ['WO-' + year + '-%']
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'WO-' + year + '-' + seq;
}
async function genSignoffNumber() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(form_number,'-',3) AS INTEGER)) AS maxseq FROM signoff_forms WHERE form_number LIKE $1",
    ['SO-' + year + '-%']
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'SO-' + year + '-' + seq + '-WO';
}

async function addActivity(woId, user, type, body) {
  try {
    await pool.query(
      'INSERT INTO work_order_activity (work_order_id, user_id, user_name, type, body) VALUES ($1,$2,$3,$4,$5)',
      [woId, user ? user.id : null, user ? user.name : 'System', type, body]
    );
  } catch (e) { console.error('[work-orders] activity log failed:', e.message); }
}

// All known account names (for the AI to match account_name against first).
async function getKnownAccounts() {
  try {
    const { rows } = await pool.query("SELECT name FROM vendors WHERE name IS NOT NULL AND TRIM(name) <> '' ORDER BY name");
    return rows.map(function (r) { return r.name; });
  } catch (e) { return []; }
}

// account_number/name -> { account_id, city_code }
async function resolveAccount(parsed) {
  const acct = strOrNull(parsed && parsed.account_number);
  const name = strOrNull(parsed && parsed.account_name);
  try {
    if (acct) {
      const { rows } = await pool.query(
        'SELECT id, city_code FROM vendors WHERE UPPER(TRIM(account_number)) = UPPER(TRIM($1)) LIMIT 1',
        [acct]
      );
      if (rows.length) return { account_id: rows[0].id, city_code: rows[0].city_code || null };
    }
    if (name) {
      const { rows } = await pool.query(
        'SELECT id, city_code FROM vendors WHERE name ILIKE $1 ORDER BY id LIMIT 1',
        ['%' + name + '%']
      );
      if (rows.length) return { account_id: rows[0].id, city_code: rows[0].city_code || null };
    }
  } catch (e) { console.error('[work-orders] resolveAccount failed:', e.message); }
  return { account_id: null, city_code: null };
}

// Derive the city from the SERVICE address rather than the account.
// A dispatcher like Fenkell is a Michigan company that sends jobs to whichever city
// the vehicle happens to be sitting in, so inheriting city_code from the vendor row
// files a Jacksonville job under Michigan. For vehicle jobs (and any account with no
// city of its own) we match the service location against the cities table instead.
// Returns null when nothing matches, which leaves the work order flagged for review.
async function deriveCityCode(parsed, acct) {
  const isVehicle = parsed && String(parsed.job_type || '').toLowerCase() === 'vehicle';
  if (acct && acct.city_code && !isVehicle) return acct.city_code;

  const hay = [
    strOrNull(parsed && parsed.city_state_zip),
    strOrNull(parsed && parsed.yard_name),
    strOrNull(parsed && parsed.address)
  ].filter(Boolean).join(' ').toUpperCase();
  if (!hay) return acct ? (acct.city_code || null) : null;

  try {
    const { rows } = await pool.query("SELECT code, name FROM cities WHERE active = true AND name IS NOT NULL AND TRIM(name) <> ''");
    // Longest city name first so "West Palm Beach" beats "Palm Beach".
    rows.sort(function (a, b) { return String(b.name).length - String(a.name).length; });
    for (let i = 0; i < rows.length; i++) {
      if (hay.indexOf(String(rows[i].name).toUpperCase()) !== -1) return rows[i].code;
    }
    // Fall back to a bare 3-letter code appearing in the yard string (e.g. "JAX").
    for (let i = 0; i < rows.length; i++) {
      const re = new RegExp('\\b' + String(rows[i].code).toUpperCase() + '\\b');
      if (re.test(hay)) return rows[i].code;
    }
  } catch (e) { console.error('[work-orders] deriveCityCode failed:', e.message); }
  return acct ? (acct.city_code || null) : null;
}

// Create a pending sign-off sheet from a work order row. Returns signoff id.
async function createSignoffForWO(wo, systemUserId, assignedTo) {
  const formNumber = await genSignoffNumber();
  const notesParts = [];
  if (wo.service_requested) notesParts.push(wo.service_requested);
  if (wo.special_instructions) notesParts.push(wo.special_instructions);
  if (wo.notes) notesParts.push(wo.notes);
  const { rows } = await pool.query(
    'INSERT INTO signoff_forms (form_number, status, wo_number, po_number, account, store_name, store_number, address, city_state_zip, service_requested_by, notes, created_by, assigned_to) ' +
    "VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id",
    [formNumber, wo.wo_number || wo.po_number || null, wo.po_number || null, wo.account_name || null,
     wo.store_name || wo.yard_name || null,
     wo.store_number || wo.bay_location || null, wo.address || null, wo.city_state_zip || null, wo.service_requested_by || null,
     notesParts.join(' — ') || null, systemUserId,
     ((assignedTo !== undefined && assignedTo !== null) ? assignedTo : (wo.assigned_to || null))]
  );
  // Seed the trip series so the auto-close (which keys off trip_group_id) can match this sheet.
  // Mirrors the manual-create path in routes/signoffs.js.
  await pool.query('UPDATE signoff_forms SET trip_group_id = id, trip_base_number = form_number WHERE id = $1', [rows[0].id]);
  return rows[0].id;
}

async function notifyReceived(wo) {
  try {
    const rec = await notify.broadcastRecipients('work_order_received', "role IN ('admin','manager')");
    await push.sendPushToUsers(rec.userIds, { title: 'New work order', body: 'A new work order was received.', url: '/' });
    const emails = rec.emails || [];
    if (!emails.length) return;
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    const html = emailTemplate({
      badge: 'New work order', badgeColor: 'orange',
      title: 'New work order received',
      body: 'A new work order came in and is waiting for review.',
      details: [
        { label: 'Ref', value: wo.wo_ref || '—' },
        { label: 'Account', value: wo.account_name || '—' },
        { label: 'Store', value: (wo.store_name || '—') + (wo.store_number ? ' (#' + wo.store_number + ')' : '') },
        { label: 'Service', value: wo.service_requested || '—' },
        { label: 'Needed by', value: wo.needed_by || wo.service_requested_by || '—' }
      ],
      buttonText: 'Review Work Order',
      buttonUrl: base + '/?view=work-orders',
      footerNote: 'Automated notification from Nova when a work order is received.'
    });
    await sendEmail(emails, 'New Work Order: ' + (wo.account_name || wo.wo_ref || 'received'), html);
  } catch (e) { console.error('[work-orders] notify failed:', e.message); }
}

// ---- NTE revisions ---------------------------------------------------------
// When a dispatcher approves an NTE increase they send the SAME work order back with a
// higher limit. It arrives as a different email (different message id), so dedup does
// not catch it — we match on the dispatcher's own wo_number instead, scoped to the
// account, and update the original job rather than opening a second one.
//
// Match rules, deliberately strict (a wrong merge is worse than a duplicate):
//   - wo_number must be present on the new form and equal (case/space-insensitive)
//   - the live work order must still be open (not rejected, superseded, or an error stub)
//   - the accounts must not contradict each other (same account_id, or one side unknown)
async function findRevisionTarget(parsed, excludeId) {
  const wono = strOrNull(parsed && parsed.wo_number);
  if (!wono) return null;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM work_orders WHERE UPPER(REPLACE(wo_number,' ','')) = UPPER(REPLACE($1,' ','')) " +
      "AND id <> $2 AND status NOT IN ('rejected','superseded','error') ORDER BY id ASC",
      [wono, excludeId || 0]
    );
    if (!rows.length) return null;
    const acct = await resolveAccount(parsed);
    const match = rows.filter(function (r) {
      // An unknown account on EITHER side must not authorize a merge — require both present and
      // equal. Ambiguous cases fall through as a new WO rather than risking a bad merge.
      return acct.account_id && r.account_id && r.account_id === acct.account_id;
    });
    // Oldest open match is the original job; anything newer with the same number is noise.
    return match.length ? match[0] : null;
  } catch (e) {
    console.error('[work-orders] findRevisionTarget failed:', e.message);
    return null;
  }
}

// Fold a revision email (stub row stubId) into the original work order.
async function applyRevision(target, parsed, stubId, msg) {
  const oldNte = (target.nte_amount === null || target.nte_amount === undefined) ? null : parseFloat(target.nte_amount);
  const newNte = moneyOrNull(parsed.nte_amount);
  const needed = dateOrNull(parsed.needed_by);

  // The new PDF is the current form — hang it on the original so the tech opens the
  // right one. The stub keeps its email metadata but hands over its files.
  await pool.query('UPDATE work_order_attachments SET work_order_id = $1 WHERE work_order_id = $2', [target.id, stubId]);

  const nteChanged = (newNte !== null && newNte !== oldNte);
  const fields = ['revision_count = COALESCE(revision_count,0) + 1', 'last_revision_at = NOW()', 'updated_at = NOW()'];
  const params = [];
  if (nteChanged) { params.push(newNte); fields.push('nte_amount = $' + params.length); }
  if (needed) { params.push(needed); fields.push('needed_by = $' + params.length); }
  // A revision may also carry a longer scope of work — only fill blanks, never overwrite
  // something a manager has already corrected by hand.
  const si = strOrNull(parsed.special_instructions);
  if (si && !target.special_instructions) { params.push(si); fields.push('special_instructions = $' + params.length); }
  params.push(target.id);
  await pool.query('UPDATE work_orders SET ' + fields.join(', ') + ' WHERE id = $' + params.length, params);

  if (nteChanged) {
    await pool.query(
      "INSERT INTO work_order_nte_history (work_order_id, old_amount, new_amount, source, revision_wo_id, changed_by_name, note) " +
      "VALUES ($1,$2,$3,'email',$4,'System',$5)",
      [target.id, oldNte, newNte, stubId, 'Revised work order received: ' + (msg && msg.subject ? msg.subject : '(no subject)')]
    );
  }

  // Park the revision email as a superseded stub pointing at the original. It keeps the
  // email_message_id (so re-polling the mailbox stays idempotent) and preserves the audit trail.
  await pool.query(
    "UPDATE work_orders SET status='superseded', revision_of_id=$1, parsed=$2, account_name=$3, wo_number=$4, " +
    "nte_amount=$5, updated_at=NOW() WHERE id=$6",
    [target.id, JSON.stringify(parsed), strOrNull(parsed.account_name), strOrNull(parsed.wo_number), newNte, stubId]
  );

  let line;
  if (nteChanged && oldNte !== null && newNte > oldNte) {
    line = 'NTE increased from ' + money(oldNte) + ' to ' + money(newNte) + ' — revised work order received by email (new form attached)';
  } else if (nteChanged && oldNte !== null) {
    line = 'NTE changed from ' + money(oldNte) + ' to ' + money(newNte) + ' — revised work order received by email (new form attached)';
  } else if (nteChanged) {
    line = 'NTE set to ' + money(newNte) + ' — revised work order received by email (new form attached)';
  } else if (newNte !== null) {
    line = 'revised work order received by email — NTE unchanged at ' + money(newNte) + ' (new form attached)';
  } else {
    line = 'revised work order received by email, but no NTE amount could be read from it — open the attached form and set the NTE by hand';
  }
  await addActivity(target.id, null, 'event', line);

  try {
    await logAudit({
      entity_type: 'work_order', entity_id: target.id, entity_number: target.wo_ref,
      action: nteChanged ? 'nte_revised' : 'revision_received', user_id: null, user_name: 'System',
      details: { old_nte: oldNte, new_nte: newNte, wo_number: target.wo_number, subject: msg ? msg.subject : null }
    });
  } catch (e) {}

  await notifyRevision(target, oldNte, newNte, nteChanged);
  return { nteChanged: nteChanged, oldNte: oldNte, newNte: newNte };
}

async function notifyRevision(target, oldNte, newNte, nteChanged) {
  try {
    const rec = await notify.broadcastRecipients('work_order_received', "role IN ('admin','manager')");
    const userIds = (rec.userIds || []).slice();
    const emails = (rec.emails || []).slice();
    // The tech standing at the vehicle is the person who most needs to know the ceiling moved.
    if (target.assigned_to) {
      if (userIds.indexOf(target.assigned_to) === -1) userIds.push(target.assigned_to);
      const u = await pool.query('SELECT email FROM users WHERE id = $1 AND active IS NOT FALSE', [target.assigned_to]);
      if (u.rows.length && u.rows[0].email && emails.indexOf(u.rows[0].email) === -1) emails.push(u.rows[0].email);
    }
    const headline = nteChanged
      ? 'NTE now ' + money(newNte) + ' (was ' + money(oldNte) + ')'
      : 'Revised work order received';
    await push.sendPushToUsers(userIds, { title: 'Work order revised', body: (target.wo_ref || 'Work order') + ': ' + headline, url: '/' });
    if (!emails.length) return;
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    const html = emailTemplate({
      badge: nteChanged ? 'NTE increase' : 'Revised work order', badgeColor: 'orange',
      title: nteChanged ? 'Not-to-exceed raised on ' + (target.wo_ref || 'a work order') : 'Revised work order received',
      body: 'A revised work order came in for a job we already have. The original work order has been updated — no new work order was created.',
      details: [
        { label: 'Ref', value: target.wo_ref || '—' },
        { label: 'WO #', value: target.wo_number || '—' },
        { label: 'Account', value: target.account_name || '—' },
        { label: 'Previous NTE', value: money(oldNte) },
        { label: 'New NTE', value: money(newNte) }
      ],
      buttonText: 'Open Work Order',
      buttonUrl: base + '/?view=work-orders',
      footerNote: 'Automated notification from Nova when a revised work order raises the NTE.'
    });
    await sendEmail(emails, (nteChanged ? 'NTE Increase: ' : 'Revised Work Order: ') + (target.wo_ref || '') + ' ' + (target.account_name || ''), html);
  } catch (e) { console.error('[work-orders] revision notify failed:', e.message); }
}

// Process a single Graph message into a work_orders row.
// Returns 'created' | 'revision' | 'duplicate' | 'ignored'.
async function processMessage(msg, conf, mailbox, knownAccounts) {
  // Dedup
  const dup = await pool.query('SELECT id FROM work_orders WHERE email_message_id = $1', [msg.internetMessageId]);
  if (dup.rows.length) return 'duplicate';

  // Gate. The keyword list reads only the SUBJECT and BODY, but a dispatcher like
  // Fenkell puts the whole work order inside an attached form and sends a one-line
  // cover note — that used to be silently dropped here, before the PDF was ever
  // opened. So: if the message carries no document at all AND trips no keyword, it
  // is not a work order and we stop. If it has a document, we always read it and let
  // the AI's is_work_order flag be the real filter.
  const mightHaveDoc = !!(msg.hasAttachments || (msg.attachments || []).length);
  if (!mightHaveDoc && !looksLikeWorkOrder(msg.subject, msg.bodyText, false)) return 'ignored';

  // Fetch attachments BEFORE creating the row, so a message that turns out to carry
  // nothing usable (e.g. only an inline signature logo) can still be dropped cleanly.
  let rawAtts = msg.attachments || [];
  if (!rawAtts.length && msg.hasAttachments && mailbox) {
    try { rawAtts = await getMessageAttachments(mailbox, msg.id); }
    catch (e) { console.error('[work-orders] attachment fetch failed:', e.message); rawAtts = []; }
  }
  const usable = [];
  rawAtts.forEach(function (a) {
    if (a.isInline) return;            // skip email-signature logos
    if (!a.contentBytes) return;
    if ((a.size || 0) > ATTACH_MAX_BYTES) return;
    const mime = (a.mime || '').toLowerCase();
    const name = (a.filename || '').toLowerCase();
    const isPdf = mime.indexOf('pdf') !== -1 || /\.pdf$/.test(name);
    const isImg = mime.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(name);
    if (!isPdf && !isImg) return;      // only docs/images go to storage + AI
    usable.push({ filename: a.filename || null, mime: isPdf ? 'application/pdf' : (mime || 'image/jpeg'), contentBytes: a.contentBytes, size: a.size || null });
  });

  // Now the real gate, with the document in hand.
  if (!looksLikeWorkOrder(msg.subject, msg.bodyText, usable.length > 0)) return 'ignored';

  const woRef = await genWoRef();
  // Insert the base row so we always capture the email even if parsing fails.
  const ins = await pool.query(
    'INSERT INTO work_orders (wo_ref, source, status, email_message_id, email_from, email_subject, email_received_at, email_body) ' +
    "VALUES ($1,'email','received',$2,$3,$4,$5,$6) RETURNING id",
    [woRef, msg.internetMessageId, msg.fromAddress || null, msg.subject || null, msg.receivedDateTime || null, msg.bodyText || null]
  );
  const woId = ins.rows[0].id;

  for (let i = 0; i < usable.length; i++) {
    const a = usable[i];
    await pool.query(
      'INSERT INTO work_order_attachments (work_order_id, filename, mime_type, image_data, size_bytes) VALUES ($1,$2,$3,$4,$5)',
      [woId, a.filename, a.mime, a.contentBytes, a.size]
    );
  }

  // Parse with Claude
  let parsed = null, parseError = null;
  try {
    parsed = await parseWorkOrderEmail(msg.bodyText, usable, knownAccounts);
  } catch (e) {
    parseError = e.message || 'parse failed';
  }

  if (!parsed) {
    await pool.query("UPDATE work_orders SET status='error', parse_error=$1, updated_at=NOW() WHERE id=$2", [parseError, woId]);
    await addActivity(woId, null, 'event', 'parse failed: ' + parseError);
    return 'created';
  }

  if (parsed.is_work_order === false) {
    await pool.query("UPDATE work_orders SET status='rejected', parsed=$1, updated_at=NOW() WHERE id=$2", [JSON.stringify(parsed), woId]);
    await addActivity(woId, null, 'event', 'auto-rejected: not a work order');
    return 'created';
  }

  // Is this a revision of a job we already have? A dispatcher approving an NTE increase
  // re-sends the SAME work order number with a higher limit — that must UPDATE the
  // original, not open a second work order. Checked before we fill in the new row.
  const target = await findRevisionTarget(parsed, woId);
  if (target) {
    const r = await applyRevision(target, parsed, woId, msg);
    console.log('[work-orders] revision folded into ' + target.wo_ref + (r.nteChanged ? ' (NTE ' + money(r.oldNte) + ' -> ' + money(r.newNte) + ')' : ' (no NTE change)'));
    return 'revision';
  }

  const acct = await resolveAccount(parsed);
  const cityCode = await deriveCityCode(parsed, acct);
  const needed = dateOrNull(parsed.needed_by);
  let priority = 'normal';
  if (needed) {
    const days = (new Date(needed).getTime() - Date.now()) / 86400000;
    if (days <= 1) priority = 'urgent';
    else if (days <= 3) priority = 'high';
  }
  const jobType = jobTypeOf(parsed);

  await pool.query(
    'UPDATE work_orders SET account_id=$1, account_name=$2, account_number=$3, city_code=$4, po_number=$5, wo_number=$6, ' +
    'store_name=$7, store_number=$8, address=$9, city_state_zip=$10, service_requested=$11, service_requested_by=$12, ' +
    'contact_name=$13, contact_phone=$14, needed_by=$15, notes=$16, parsed=$17, confidence=$18, priority=$19, ' +
    'job_type=$20, claim_id=$21, vin=$22, vehicle_year=$23, vehicle_make=$24, vehicle_model=$25, vehicle_mileage=$26, ' +
    'repair_code=$27, yard_name=$28, bay_location=$29, special_instructions=$30, nte_amount=$31, updated_at=NOW() WHERE id=$32',
    [acct.account_id, strOrNull(parsed.account_name), strOrNull(parsed.account_number), cityCode,
     strOrNull(parsed.po_number), strOrNull(parsed.wo_number), strOrNull(parsed.store_name), strOrNull(parsed.store_number),
     strOrNull(parsed.address), strOrNull(parsed.city_state_zip), strOrNull(parsed.service_requested), strOrNull(parsed.service_requested_by),
     strOrNull(parsed.contact_name), strOrNull(parsed.contact_phone), needed, strOrNull(parsed.notes),
     JSON.stringify(parsed), strOrNull(parsed.confidence), priority,
     jobType, strOrNull(parsed.claim_id), normalizeVin(parsed.vin), strOrNull(parsed.vehicle_year),
     strOrNull(parsed.vehicle_make), strOrNull(parsed.vehicle_model), strOrNull(parsed.vehicle_mileage),
     strOrNull(parsed.repair_code), strOrNull(parsed.yard_name), strOrNull(parsed.bay_location),
     strOrNull(parsed.special_instructions), moneyOrNull(parsed.nte_amount), woId]
  );
  await addActivity(woId, null, 'event', 'received by email and parsed as a ' + jobType + ' job (confidence: ' + (strOrNull(parsed.confidence) || 'n/a') + ')');
  // A vehicle job with no VIN is the one failure worth shouting about — the VIN IS
  // the job. Leave a breadcrumb so whoever reviews it knows to open the PDF.
  if (jobType === 'vehicle' && !normalizeVin(parsed.vin)) {
    await addActivity(woId, null, 'event', 'no VIN could be read from this work order — check the attached form');
  }

  // Optionally create the pending sign-off now
  if (conf.signoffOn !== 'accept') {
    try {
      const woRow = (await pool.query('SELECT * FROM work_orders WHERE id=$1', [woId])).rows[0];
      const sid = await createSignoffForWO(woRow, conf.systemUserId);
      await pool.query('UPDATE work_orders SET signoff_id=$1 WHERE id=$2', [sid, woId]);
      await addActivity(woId, null, 'event', 'pending sign-off sheet created');
    } catch (e) { console.error('[work-orders] signoff create failed:', e.message); }
  }

  const finalRow = (await pool.query('SELECT * FROM work_orders WHERE id=$1', [woId])).rows[0];
  try { await logAudit({ entity_type: 'work_order', entity_id: woId, entity_number: woRef, action: 'received', user_id: null, user_name: 'System', details: { account: finalRow.account_name, subject: msg.subject } }); } catch (e) {}
  await notifyReceived(finalRow);
  return 'created';
}

// Poll the mailbox and process new messages. Returns a summary.
async function runIngest(options) {
  options = options || {};
  const conf = await cfg();
  if (!options.force && !conf.enabled) {
    return { skipped: true, reason: 'work orders intake disabled' };
  }
  if (!process.env.MS_TENANT_ID || !process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET) {
    return { skipped: true, reason: 'Microsoft Graph env vars missing' };
  }
  const sinceIso = options.sinceIso ||
    new Date(Date.now() - (parseInt(options.lookbackHours, 10) || 72) * 3600000).toISOString();
  const messages = await getInboxMessages(conf.mailbox, sinceIso, { top: options.top || 25, paginate: !!options.paginate });
  const knownAccounts = await getKnownAccounts();

  let created = 0, duplicate = 0, ignored = 0, revised = 0;
  for (let i = 0; i < messages.length; i++) {
    try {
      const r = await processMessage(messages[i], conf, conf.mailbox, knownAccounts);
      if (r === 'created') created++;
      else if (r === 'revision') revised++;
      else if (r === 'duplicate') duplicate++;
      else ignored++;
    } catch (e) {
      console.error('[work-orders] processMessage failed:', e.message);
    }
  }
  return { mailbox: conf.mailbox, fetched: messages.length, created: created, revised: revised, duplicate: duplicate, ignored: ignored, since: sinceIso };
}

var _woIngestRunning = false;
function startWorkOrders() {
  // Every minute; idempotent (dedup on email_message_id). Guard prevents overlapping runs.
  cron.schedule('* * * * *', function () {
    if (_woIngestRunning) return;
    _woIngestRunning = true;
    runIngest({})
      .then(function (s) { if (!s.skipped && (s.created || s.fetched)) console.log('[work-orders] ingest: fetched ' + s.fetched + ', created ' + s.created + ', revised ' + s.revised + ', dup ' + s.duplicate + ', ignored ' + s.ignored); })
      .catch(function (err) { console.error('[work-orders] ingest failed:', err.message); })
      .then(function () { _woIngestRunning = false; });
  });
  console.log('[work-orders] Mailbox ingest scheduled (every 1 min)');
}

module.exports = {
  deriveCityCode: deriveCityCode,
  normalizeVin: normalizeVin,
  moneyOrNull: moneyOrNull,
  money: money,
  findRevisionTarget: findRevisionTarget,
  applyRevision: applyRevision,
  jobTypeOf: jobTypeOf,
  runIngest: runIngest,
  processMessage: processMessage,
  createSignoffForWO: createSignoffForWO,
  genWoRef: genWoRef,
  addActivity: addActivity,
  startWorkOrders: startWorkOrders
};
