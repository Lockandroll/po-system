// Geico ERS survey - pure helpers (no DB, no scheduling).
// Parsing, date math, CSV building, and the Resend send call live here so they
// can be reused by the ingest/report orchestration in jobs/geicoIngest.js.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function isoDateUTC(d) {
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function prettyUTC(d) {
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}

// Previous full Monday..Sunday window relative to `now` (UTC based). end exclusive.
function previousWeekWindow(now) {
  const day = now.getUTCDay();            // 0=Sun .. 6=Sat
  const daysSinceMonday = (day + 6) % 7;  // 0 if Monday
  const thisMonday = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday, 0, 0, 0, 0
  ));
  const start = new Date(thisMonday.getTime() - 7 * 86400000);
  const end = thisMonday;
  const lastDay = new Date(end.getTime() - 86400000);
  return {
    start: start, end: end,
    startIso: start.toISOString(), endIso: end.toISOString(),
    startDate: isoDateUTC(start), endDate: isoDateUTC(end),
    label: prettyUTC(start) + ' - ' + prettyUTC(lastDay),
    fileDate: isoDateUTC(start)
  };
}

function field(bodyText, label) {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*:[ \\t]*([^\\r\\n]*)', 'i');
  const m = bodyText.match(re);
  return m ? m[1].trim() : '';
}

// MM/DD/YYYY -> YYYY-MM-DD (or null if unparseable)
function parseDispatchDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return m[3] + '-' + pad2(parseInt(m[1], 10)) + '-' + pad2(parseInt(m[2], 10));
}

// Parse one survey email message into a normalized record.
// msg = { subject, receivedDateTime, bodyText, internetMessageId }
function parseSurvey(msg) {
  const subject = msg.subject || '';
  const body = msg.bodyText || '';
  const accountNumber = subject.split(' - PO Number')[0].trim();
  const received = msg.receivedDateTime ? isoDateUTC(new Date(msg.receivedDateTime)) : '';
  return {
    dateReceived: received,
    accountNumber: accountNumber,
    poNumber: field(body, 'PO Number'),
    service: field(body, 'Service'),
    lossState: field(body, 'Loss State'),
    dateOfDispatch: parseDispatchDate(field(body, 'Date of Dispatch')),
    arrivedOnTime: field(body, 'Provider Arrived On Time'),
    timeToArrive: field(body, 'How Long Till Provider Arrived'),
    rating: field(body, 'Rating of Technician'),
    internetMessageId: msg.internetMessageId || ''
  };
}

function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

// rows: normalized objects with keys
// dateReceived, accountNumber, cityName, poNumber, service, lossState,
// dateOfDispatch, arrivedOnTime, timeToArrive, rating
function buildCsv(rows) {
  const header = [
    'Date Received', 'Account #', 'City', 'PO Number', 'Service', 'Loss State',
    'Date of Dispatch', 'Provider Arrived On Time', 'How Long Till Provider Arrived',
    'Rating of Technician'
  ];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach(function (r) {
    lines.push([
      r.dateReceived, r.accountNumber, r.cityName, r.poNumber, r.service, r.lossState,
      r.dateOfDispatch, r.arrivedOnTime, r.timeToArrive, r.rating
    ].map(csvCell).join(','));
  });
  return lines.join('\r\n');
}

const DEFAULT_RECIPIENTS = [
  'tony@popalockar.com', 'ben@popalockar.com', 'bmier@popalockar.com', 'rbeechly@popalockar.com'
];

function getRecipients() {
  const raw = process.env.GEICO_REPORT_RECIPIENTS;
  if (raw && raw.trim()) {
    return raw.split(/[,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  return DEFAULT_RECIPIENTS.slice();
}

function buildEmailHtml(count, label, filename) {
  const countLine = '<strong>' + count + '</strong> survey' + (count === 1 ? '' : 's') +
    ' received for ' + label + '.';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:0;background:#e5e5e5;font-family:-apple-system,Helvetica Neue,Arial,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 16px">' +
    '<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden">' +
    '<tr><td style="background:#111111;padding:20px 28px">' +
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
        '<td style="background:#f97316;width:36px;height:36px;border-radius:6px;text-align:center;vertical-align:middle;font-size:18px;line-height:36px">&#128274;</td>' +
        '<td style="padding-left:12px;color:#ffffff;font-size:16px;font-weight:700;vertical-align:middle">Lock and Roll LLC</td>' +
      '</tr></table>' +
    '</td></tr>' +
    '<tr><td style="padding:32px 28px">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:16px"><tr>' +
        '<td style="background:#fff3e8;color:#c2520a;font-size:11px;font-weight:700;padding:4px 10px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px">Geico ERS Surveys</td>' +
      '</tr></table>' +
      '<h1 style="font-size:20px;font-weight:700;color:#111111;margin:0 0 12px">Weekly Survey Report</h1>' +
      '<p style="font-size:14px;color:#555555;line-height:1.6;margin:0 0 20px">' + countLine +
        ' The full breakdown is attached as a CSV (' + filename + ').</p>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #eeeeee;padding-top:20px">' +
        '<p style="font-size:12px;color:#aaaaaa;line-height:1.6;margin:0">Automated report from the Geico survey emails received in the Pop-A-Lock AR mailbox.</p>' +
      '</td></tr></table>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

async function sendReportEmail(recipients, subject, html, filename, csvBase64) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const payload = {
    from: process.env.FROM_EMAIL || 'Lock and Roll <onboarding@resend.dev>',
    to: recipients, subject: subject, html: html,
    attachments: [{ filename: filename, content: csvBase64 }]
  };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error('Resend error ' + resp.status + ': ' + t); }
  return resp.json().catch(function () { return {}; });
}

module.exports = {
  pad2, isoDateUTC, prettyUTC, previousWeekWindow, field, parseDispatchDate,
  parseSurvey, csvCell, buildCsv, getRecipients, buildEmailHtml, sendReportEmail
};
