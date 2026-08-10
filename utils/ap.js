// ---------------------------------------------------------------------------
//  Accounts Payable - shared logic
// ---------------------------------------------------------------------------
// House style: string concatenation, no backticks (see CLAUDE.md 1.1). Nothing
// in here throws on bad input - a bill is entered by a person and confirmed by a
// person, so every parser below returns a SUGGESTION (or null), never a decision.
//
// The pure helpers (nextMonthlyDue, computeSummary, parseBillEmail and the
// money/date helpers) have no DB dependency and are covered by
// scripts/ap_selftest.js. The two intake helpers at the bottom touch the DB and
// R2 and are used by routes/inbound.js.
const https = require('https');
const { pool } = require('../db');

// A bill is money out. Two dp, or null when there is genuinely no number.
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function money(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function s(v, n) { return v === undefined || v === null ? null : String(v).trim().slice(0, n) || null; }
function ymd(v, fb) {
  const m = String(v || '').trim().match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? m[0] : fb;
}

// Categories and payment methods are conventions, not hard-coded law: the
// category list is overridable in settings (ap_categories), and the methods are
// just what the mark-paid dropdown offers. Kept here so one edit changes both
// the API validation and the screen.
const CATEGORIES = ['Rent', 'Utilities', 'Insurance', 'Supplies', 'Fuel', 'Vehicle',
  'Loan', 'Payroll', 'Taxes', 'Software', 'Marketing', 'Professional', 'Other'];
const METHODS = ['check', 'ach', 'card', 'cash', 'wire', 'other'];
const STATUSES = ['unpaid', 'paid', 'void', 'review'];

// ---------------------------------------------------------------------------
//  Dates
// ---------------------------------------------------------------------------
// Day-of-month is clamped to 1-28 for the same reason ar_statement_day is: the
// 29th, 30th and 31st do not exist every month, and "rent on the 31st" silently
// skipping February is exactly the kind of miss this module is meant to prevent.
function clampDom(d) {
  d = parseInt(d, 10);
  if (!isFinite(d)) return null;
  return Math.max(1, Math.min(28, d));
}

// The next occurrence of a monthly bill. Pure string math so there is no
// timezone in it - a due date is a calendar day, not an instant.
function nextMonthlyDue(dueDateStr, recurrenceDay) {
  const m = String(dueDateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  var y = parseInt(m[1], 10);
  var mon = parseInt(m[2], 10);
  var d = clampDom(recurrenceDay) || clampDom(m[3]);
  if (!d) return null;
  mon += 1;
  if (mon > 12) { mon = 1; y += 1; }
  return y + '-' + String(mon).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Add days to a YYYY-MM-DD, returning YYYY-MM-DD. Date is used only for the
// calendar arithmetic and is pinned to UTC, so it never drifts a day.
function addDays(ymdStr, n) {
  const m = String(ymdStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymdStr;
  const dt = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  dt.setUTCDate(dt.getUTCDate() + (parseInt(n, 10) || 0));
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
//  Summary
// ---------------------------------------------------------------------------
// The three numbers the top of the screen shows: what is unpaid, what is already
// overdue, and what falls due inside the window. String comparison is safe here
// because YYYY-MM-DD sorts chronologically. `today` is passed in so this is a
// pure function and the self-test is deterministic.
function computeSummary(bills, opts) {
  const o = opts || {};
  const today = o.today || new Date().toISOString().slice(0, 10);
  const soon = addDays(today, o.dueSoonDays == null ? 7 : o.dueSoonDays);
  const sum = {
    unpaid_count: 0, unpaid_total: 0,
    overdue_count: 0, overdue_total: 0,
    due_soon_count: 0, due_soon_total: 0,
    review_count: 0, paid_count: 0, paid_total: 0
  };
  (bills || []).forEach(function (b) {
    const amt = Number(b.amount) || 0;
    const due = b.due_date ? String(b.due_date).slice(0, 10) : null;
    if (b.status === 'review') { sum.review_count++; return; }
    if (b.status === 'void') return;
    if (b.status === 'paid') {
      sum.paid_count++;
      sum.paid_total = r2(sum.paid_total + (b.paid_amount != null ? Number(b.paid_amount) : amt));
      return;
    }
    // unpaid
    sum.unpaid_count++;
    sum.unpaid_total = r2(sum.unpaid_total + amt);
    if (due && due < today) { sum.overdue_count++; sum.overdue_total = r2(sum.overdue_total + amt); }
    else if (due && due <= soon) { sum.due_soon_count++; sum.due_soon_total = r2(sum.due_soon_total + amt); }
  });
  return sum;
}

// ---------------------------------------------------------------------------
//  Email parsing (suggestions only)
// ---------------------------------------------------------------------------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Prefer a labelled amount ("Amount Due: $123.45"); fall back to the largest
// dollar figure in the text. A guess, shown for confirmation, never posted.
function parseAmountFromText(text) {
  const t = String(text || '');
  const labeled = t.match(/(amount\s*due|total\s*due|balance\s*due|amount\s*payable|please\s*pay|invoice\s*total|total\s*amount|amount|total)\s*[:\-]?\s*\$?\s*([0-9][0-9,]*\.?[0-9]{0,2})/i);
  if (labeled) { const n = parseFloat(labeled[2].replace(/,/g, '')); if (isFinite(n) && n > 0) return r2(n); }
  var best = null, m;
  const re = /\$\s*([0-9][0-9,]*\.?[0-9]{0,2})/g;
  while ((m = re.exec(t))) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (isFinite(v) && (best === null || v > best)) best = v;
  }
  return best === null ? null : r2(best);
}

function normDate(y, mo, d) {
  y = parseInt(y, 10); mo = parseInt(mo, 10); d = parseInt(d, 10);
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Look hardest right after a "due" label, then anywhere. Handles ISO,
// US M/D/Y and "Month DD, YYYY".
function parseDateFromText(text) {
  const t = String(text || '');
  const dueCtx = t.match(/due[^0-9A-Za-z]{0,14}([A-Za-z0-9,\/\-\s]{6,24})/i);
  const scan = (dueCtx ? dueCtx[1] + '  ' : '') + t;
  var m = scan.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return normDate(m[1], m[2], m[3]);
  m = scan.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return normDate(y, m[1], m[2]); }
  m = scan.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return normDate(m[3], mo, m[2]); }
  return null;
}

function parseBillNumber(text) {
  // Scan every "invoice/bill/account ..." hit and return the first token that
  // has a digit in it - a real bill number does, whereas the words that follow
  // "Invoice" in a sentence ("Invoice from Acme") do not.
  const re = /\b(?:invoice|inv|bill|statement|account|acct)\s*#?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-]{1,19})\b/ig;
  var m;
  while ((m = re.exec(String(text || '')))) {
    if (/\d/.test(m[1])) return m[1];
  }
  return null;
}

// From a received email, produce a set of suggestions for a review draft. The
// forwarding staff member is NOT the payee - the vendor is inside the message -
// so payee is a soft guess from the subject and the person confirms it.
function parseBillEmail(email) {
  const e = email || {};
  const subject = String(e.subject || '');
  const text = String(e.text || '') || htmlToText(String(e.html || ''));
  const cleanSubj = subject.replace(/^\s*(re|fwd|fw)\s*:\s*/ig, '').replace(/^\s*(re|fwd|fw)\s*:\s*/ig, '').trim();
  const body = subject + '\n' + text;
  var payee = null;
  const fromCo = cleanSubj.match(/(?:from|for|by)\s+([A-Z][A-Za-z0-9&.\-' ]{2,40})/);
  if (fromCo) payee = fromCo[1].replace(/\s+(invoice|bill|statement).*$/i, '').trim();
  return {
    payee: payee || null,
    description: cleanSubj || 'Bill received by email',
    amount: parseAmountFromText(body),
    due_date: parseDateFromText(body),
    bill_number: parseBillNumber(body)
  };
}

// ---------------------------------------------------------------------------
//  Intake (DB + R2) - used by routes/inbound.js
// ---------------------------------------------------------------------------
// A bill that arrives by email is created as a REVIEW draft, never a live
// payable: the amount and due date are parser guesses, and putting a guessed
// number on a bill that then fires a "pay this" task is how the wrong amount
// gets paid. A person opens the draft, confirms the two fields, and saves it
// live. assigned_to is the staff member who forwarded it, so it lands on the
// desk of whoever sent it in.
async function createBillFromEmail(parsed, sender, opts) {
  const o = opts || {};
  const { rows } = await pool.query(
    'INSERT INTO ap_bills (payee, bill_number, description, amount, due_date, status, assigned_to, source, source_ref, raw_email, created_by) ' +
    "VALUES ($1,$2,$3,$4,$5,'review',$6,'email',$7,$8,$9) RETURNING id",
    [s(parsed.payee, 255), s(parsed.bill_number, 120), s(parsed.description, 4000),
      money(parsed.amount) || 0, ymd(parsed.due_date, null),
      sender && sender.id ? sender.id : null, s(o.source_ref, 255), s(o.raw_email, 20000),
      sender && sender.id ? sender.id : null]);
  return rows[0];
}

function fetchUrlBuffer(url) {
  return new Promise(function (resolve, reject) {
    try {
      https.get(url, function (res) {
        if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () { resolve(Buffer.concat(chunks)); });
      }).on('error', reject).setTimeout(30000, function () { this.destroy(new Error('attachment fetch timed out')); });
    } catch (e) { reject(e); }
  });
}

// Best-effort: store whatever attachments the webhook handed us onto the bill in
// R2. Resend's inbound payload shape varies (inline base64 vs a content URL), so
// this handles both and simply logs-and-continues on anything it does not
// recognise - the person can always attach the file by hand on the draft, which
// is the reliable path. Never throws into the webhook.
async function captureEmailAttachments(billId, attachments, uploaderId) {
  if (!Array.isArray(attachments) || !attachments.length) return 0;
  var r2mod;
  try { r2mod = require('./r2'); } catch (e) { return 0; }
  if (!r2mod.configured || !r2mod.configured()) return 0;
  var stored = 0;
  for (var i = 0; i < attachments.length; i++) {
    const a = attachments[i] || {};
    try {
      const name = (s(a.filename || a.name, 255) || ('attachment-' + (i + 1)));
      const ctype = (s(a.content_type || a.contentType || a.type, 120) || 'application/octet-stream');
      var buf = null;
      if (a.content) {
        const raw = typeof a.content === 'string' ? a.content : (a.content && a.content.data) || '';
        buf = Buffer.from(String(raw), 'base64');
      } else if (a.url || a.content_url || a.download_url) {
        buf = await fetchUrlBuffer(a.url || a.content_url || a.download_url);
      }
      if (!buf || !buf.length) continue;
      const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
      const key = 'ap-bills/' + billId + '/' + Date.now() + '-' + i + '-' + safe;
      await r2mod.putObject(key, buf, ctype);
      await pool.query(
        'INSERT INTO ap_bill_attachments (bill_id, r2_key, filename, content_type, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [billId, key, name, ctype, buf.length, uploaderId || null]);
      stored++;
    } catch (e) { console.error('[ap] attachment capture failed:', e.message); }
  }
  return stored;
}

module.exports = {
  CATEGORIES: CATEGORIES,
  METHODS: METHODS,
  STATUSES: STATUSES,
  r2: r2,
  money: money,
  s: s,
  ymd: ymd,
  clampDom: clampDom,
  nextMonthlyDue: nextMonthlyDue,
  addDays: addDays,
  computeSummary: computeSummary,
  htmlToText: htmlToText,
  parseAmountFromText: parseAmountFromText,
  parseDateFromText: parseDateFromText,
  parseBillNumber: parseBillNumber,
  parseBillEmail: parseBillEmail,
  createBillFromEmail: createBillFromEmail,
  captureEmailAttachments: captureEmailAttachments
};
