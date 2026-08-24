// Daily certificate-of-insurance watch.
//
// Three things can go wrong with a COI and they fail on different clocks, so
// they are notified differently:
//
//   1. A certificate is about to expire  -> one lead-time notice, then one on
//      the day, deduped per certificate via reminder_sent_at /
//      expiry_notice_sent_at. Same shape as jobs/docExpiry.js.
//   2. An account that requires one has none at all, or has one that falls
//      short of what it requires -> there is no per-certificate flag to dedup
//      against, and a daily nag about a state that takes weeks to fix trains
//      people to ignore the email. That section goes out WEEKLY, on Mondays.
//   3. Our own master policy is coming up for renewal -> fire on exact
//      day-counts out, so it lands several times without needing any stored
//      state to remember whether it already went.
//
// House style: string concatenation only, no template literals.
const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('../utils/email');
const { broadcastRecipients } = require('../utils/notify');
const coi = require('../utils/coi');

const COI_EVENT = 'coi_expiring';
const DEFAULT_WHERE = "role IN ('admin','manager')";
// Days before the master policy expires that we nudge someone to open a cycle.
const POLICY_NOTICE_DAYS = [60, 45, 30, 14, 7];

function fmtDate(iso) {
  if (!iso) return '';
  var s = String(iso).slice(0, 10);
  var d = new Date(s + 'T00:00:00');
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function isMondayET(todayISO) {
  return new Date(todayISO + 'T12:00:00Z').getUTCDay() === 1;
}

async function readPolicy() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'coi_policy'");
    if (!r.rows.length || !r.rows[0].value) return {};
    return JSON.parse(r.rows[0].value);
  } catch (e) { return {}; }
}

// Every account that requires a certificate, with its current one attached.
async function loadAccounts() {
  const { rows } = await pool.query(
    'SELECT v.name AS account_name, r.account_id, r.coi_required, ' +
    '       c.id AS cert_id, c.file_name, c.mismatch, c.reminder_sent_at, c.expiry_notice_sent_at, ' +
    "       to_char(c.expires_on, 'YYYY-MM-DD') AS expires_on " +
    'FROM account_coi_requirements r ' +
    'JOIN vendors v ON v.id = r.account_id ' +
    'LEFT JOIN (SELECT DISTINCT ON (account_id) * FROM account_coi_certificates ' +
    "          WHERE status = 'ready' AND superseded = false " +
    '          ORDER BY account_id, expires_on DESC NULLS LAST, id DESC) c ON c.account_id = r.account_id ' +
    'WHERE r.coi_required = true ORDER BY v.name ASC'
  );
  return rows;
}

async function digest(appUrl, emails, opts) {
  if (!emails.length || !opts.details.length) return;
  const html = emailTemplate({
    badge: opts.badge, badgeColor: opts.color,
    title: opts.title, body: opts.body, details: opts.details,
    buttonText: 'Open the COI screen', buttonUrl: appUrl + '/?view=coi',
    footerNote: 'You are receiving this because you are on the certificate of insurance distribution list. Update recipients under Settings &rarr; Notifications.'
  });
  try { await sendEmail(emails, opts.subject, html); console.log('[coiExpiry] Sent ' + opts.badge + ' digest (' + opts.details.length + ') to ' + emails.length + ' recipient(s).'); }
  catch (e) { console.error('[coiExpiry] ' + opts.badge + ' email failed:', e.message); }
}

async function runCoiWatch() {
  try {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const today = coi.etToday();
    const rows = await loadAccounts();
    if (!rows.length) { console.log('[coiExpiry] No accounts require a certificate.'); return; }

    var expiring = [], expired = [], missing = [], short = [];
    rows.forEach(function (r) {
      var st = coi.coiStatus(r, today);
      if (st.key === 'missing') { missing.push(r); return; }
      if (st.key === 'expired') { if (!r.expiry_notice_sent_at) expired.push(r); return; }
      if (st.key === 'mismatch') { short.push({ row: r, st: st }); return; }
      if (st.key === 'expiring') { if (!r.reminder_sent_at) expiring.push(r); }
    });

    const policy = await readPolicy();
    var policyDue = null;
    if (policy.policy_expires) {
      var out = coi.daysBetween(today, String(policy.policy_expires).slice(0, 10));
      if (POLICY_NOTICE_DAYS.indexOf(out) !== -1) policyDue = out;
    }

    const monday = isMondayET(today);
    const weekly = monday ? (missing.length + short.length) : 0;
    if (!expiring.length && !expired.length && !weekly && policyDue === null) {
      console.log('[coiExpiry] Nothing due today.'); return;
    }

    const recips = await broadcastRecipients(COI_EVENT, DEFAULT_WHERE);
    const emails = recips.emails || [];
    if (!emails.length) console.log('[coiExpiry] No recipients configured - marking as notified to avoid pile-up.');

    if (policyDue !== null) {
      await digest(appUrl, emails, {
        badge: 'Policy Renewal', color: 'orange',
        title: 'Our policy renews in ' + policyDue + ' days',
        body: 'The master policy expires ' + fmtDate(policy.policy_expires) + '. Open a renewal cycle in Nova to generate the certificate request packet for the agent.',
        details: [{ label: 'Carrier', value: policy.carrier || 'not recorded' },
                  { label: 'Agent', value: policy.agent_name || policy.agency || 'not recorded' },
                  { label: 'Accounts requiring a certificate', value: String(rows.length) }],
        subject: 'Insurance renewal in ' + policyDue + ' days - start the COI cycle'
      });
    }

    await digest(appUrl, emails, {
      badge: 'Expiring Soon', color: 'orange',
      title: expiring.length + ' certificate' + (expiring.length === 1 ? '' : 's') + ' expiring soon',
      body: 'These accounts need a fresh certificate of insurance before the date shown.',
      details: expiring.map(function (r) { return { label: r.account_name, value: 'Expires ' + fmtDate(r.expires_on) }; }),
      subject: expiring.length === 1
        ? 'COI expiring soon: ' + expiring[0].account_name
        : expiring.length + ' certificates of insurance expiring soon'
    });

    await digest(appUrl, emails, {
      badge: 'Expired', color: 'red',
      title: expired.length + ' certificate' + (expired.length === 1 ? '' : 's') + ' expired',
      body: 'These accounts are carrying an expired certificate of insurance.',
      details: expired.map(function (r) { return { label: r.account_name, value: 'Expired ' + fmtDate(r.expires_on) }; }),
      subject: expired.length === 1
        ? 'COI EXPIRED: ' + expired[0].account_name
        : expired.length + ' certificates of insurance have expired'
    });

    if (monday && (missing.length || short.length)) {
      var details = missing.map(function (r) { return { label: r.account_name, value: 'No certificate on file' }; })
        .concat(short.map(function (x) { return { label: x.row.account_name, value: x.st.note || 'Below requirement' }; }));
      await digest(appUrl, emails, {
        badge: 'Needs Attention', color: 'orange',
        title: details.length + ' account' + (details.length === 1 ? '' : 's') + ' without a compliant certificate',
        body: 'Weekly check. These accounts require a certificate of insurance and do not have a compliant one on file.',
        details: details,
        subject: details.length + ' account' + (details.length === 1 ? '' : 's') + ' without a compliant COI'
      });
    }

    // Stamp the per-certificate flags whether or not anyone was configured to
    // receive the mail, so a missing distribution list cannot build a backlog
    // that all fires at once the day somebody adds one.
    if (expiring.length) {
      await pool.query('UPDATE account_coi_certificates SET reminder_sent_at = NOW() WHERE id = ANY($1::int[])',
        [expiring.map(function (r) { return r.cert_id; })]);
    }
    if (expired.length) {
      await pool.query('UPDATE account_coi_certificates SET expiry_notice_sent_at = NOW() WHERE id = ANY($1::int[])',
        [expired.map(function (r) { return r.cert_id; })]);
    }
  } catch (err) {
    console.error('[coiExpiry] Job failed:', err.message);
  }
}

function startCoiExpiry() {
  // 08:15 ET, fifteen minutes after the document vault digest, so the two
  // never land in the same minute and get read as one email.
  cron.schedule('15 8 * * *', function () {
    console.log('[coiExpiry] Running daily certificate of insurance check…');
    runCoiWatch();
  }, { timezone: 'America/New_York' });
  console.log('[coiExpiry] Daily COI check scheduled (08:15 America/New_York)');
}

module.exports = { startCoiExpiry, runCoiWatch };
