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

// Create a pending sign-off sheet from a work order row. Returns signoff id.
async function createSignoffForWO(wo, systemUserId) {
  const formNumber = await genSignoffNumber();
  const notesParts = [];
  if (wo.service_requested) notesParts.push(wo.service_requested);
  if (wo.notes) notesParts.push(wo.notes);
  const { rows } = await pool.query(
    'INSERT INTO signoff_forms (form_number, status, wo_number, po_number, account, store_name, store_number, address, city_state_zip, service_requested_by, notes, created_by) ' +
    "VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
    [formNumber, wo.po_number || null, wo.po_number || null, wo.account_name || null, wo.store_name || null,
     wo.store_number || null, wo.address || null, wo.city_state_zip || null, wo.service_requested_by || null,
     notesParts.join(' — ') || null, systemUserId]
  );
  return rows[0].id;
}

async function notifyReceived(wo) {
  try {
    const rec = await notify.broadcastRecipients('work_order_received', "role IN ('admin','manager')");
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

// Process a single Graph message into a work_orders row. Returns 'created' | 'duplicate' | 'ignored'.
async function processMessage(msg, conf, mailbox, knownAccounts) {
  // Dedup
  const dup = await pool.query('SELECT id FROM work_orders WHERE email_message_id = $1', [msg.internetMessageId]);
  if (dup.rows.length) return 'duplicate';

  // Keyword gate — skip obvious non-work-orders entirely
  if (!looksLikeWorkOrder(msg.subject, msg.bodyText)) return 'ignored';

  const woRef = await genWoRef();
  // Insert the base row first so we always capture the email even if parsing fails.
  const ins = await pool.query(
    'INSERT INTO work_orders (wo_ref, source, status, email_message_id, email_from, email_subject, email_received_at, email_body) ' +
    "VALUES ($1,'email','received',$2,$3,$4,$5,$6) RETURNING id",
    [woRef, msg.internetMessageId, msg.fromAddress || null, msg.subject || null, msg.receivedDateTime || null, msg.bodyText || null]
  );
  const woId = ins.rows[0].id;

  // Fetch + store attachments (images/pdf, under cap). Only happens here, after
  // dedup + keyword gate, so attachments are downloaded once per NEW message.
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

  const acct = await resolveAccount(parsed);
  const needed = dateOrNull(parsed.needed_by);
  let priority = 'normal';
  if (needed) {
    const days = (new Date(needed).getTime() - Date.now()) / 86400000;
    if (days <= 1) priority = 'urgent';
    else if (days <= 3) priority = 'high';
  }

  await pool.query(
    'UPDATE work_orders SET account_id=$1, account_name=$2, account_number=$3, city_code=$4, po_number=$5, wo_number=$6, ' +
    'store_name=$7, store_number=$8, address=$9, city_state_zip=$10, service_requested=$11, service_requested_by=$12, ' +
    'contact_name=$13, contact_phone=$14, needed_by=$15, notes=$16, parsed=$17, confidence=$18, priority=$19, updated_at=NOW() WHERE id=$20',
    [acct.account_id, strOrNull(parsed.account_name), strOrNull(parsed.account_number), acct.city_code,
     strOrNull(parsed.po_number), strOrNull(parsed.wo_number), strOrNull(parsed.store_name), strOrNull(parsed.store_number),
     strOrNull(parsed.address), strOrNull(parsed.city_state_zip), strOrNull(parsed.service_requested), strOrNull(parsed.service_requested_by),
     strOrNull(parsed.contact_name), strOrNull(parsed.contact_phone), needed, strOrNull(parsed.notes),
     JSON.stringify(parsed), strOrNull(parsed.confidence), priority, woId]
  );
  await addActivity(woId, null, 'event', 'received by email and parsed (confidence: ' + (strOrNull(parsed.confidence) || 'n/a') + ')');

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

  let created = 0, duplicate = 0, ignored = 0;
  for (let i = 0; i < messages.length; i++) {
    try {
      const r = await processMessage(messages[i], conf, conf.mailbox, knownAccounts);
      if (r === 'created') created++;
      else if (r === 'duplicate') duplicate++;
      else ignored++;
    } catch (e) {
      console.error('[work-orders] processMessage failed:', e.message);
    }
  }
  return { mailbox: conf.mailbox, fetched: messages.length, created: created, duplicate: duplicate, ignored: ignored, since: sinceIso };
}

var _woIngestRunning = false;
function startWorkOrders() {
  // Every minute; idempotent (dedup on email_message_id). Guard prevents overlapping runs.
  cron.schedule('* * * * *', function () {
    if (_woIngestRunning) return;
    _woIngestRunning = true;
    runIngest({})
      .then(function (s) { if (!s.skipped && (s.created || s.fetched)) console.log('[work-orders] ingest: fetched ' + s.fetched + ', created ' + s.created + ', dup ' + s.duplicate + ', ignored ' + s.ignored); })
      .catch(function (err) { console.error('[work-orders] ingest failed:', err.message); })
      .then(function () { _woIngestRunning = false; });
  });
  console.log('[work-orders] Mailbox ingest scheduled (every 1 min)');
}

module.exports = {
  runIngest: runIngest,
  processMessage: processMessage,
  createSignoffForWO: createSignoffForWO,
  genWoRef: genWoRef,
  addActivity: addActivity,
  startWorkOrders: startWorkOrders
};
