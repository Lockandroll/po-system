// The customer invoice page: /i/<token>. No login. Everything hangs off
// invoices.customer_link_token, a 32-character random token minted the first
// time a follow-up text or email goes out (utils/invoiceReviewRequest.js).
//
// Plan: claude/nova-customer-follow-up-plan.md (Tony, 2026-10-11).
//   GET  /i/:token             the page: invoice buttons + ONE follow-up
//   GET  /i/:token/pdf         the customer copy PDF (?dl=1 downloads it)
//   GET  /i/:token/google      counts the tap, then redirects to the city's Google review link
//   POST /i/:token/email-copy  { email } emails the PDF; 3 per invoice per day
//   POST /i/:token/survey      the feedback survey (utils/invoiceSurvey.js)
//
// Which follow-up shows is whatever actually went out (invoices.followup_mode):
// 'google' -> the Google button only; 'survey' -> the survey only (no Google link
// on that page, Tony's call); 'survey_only' (account set to Survey only) -> the
// survey with NO invoice buttons, because that customer is not the payer.
//
// Mounted on '/i' in server.js, outside '/api/', so the general /api limiter
// does not see it; it carries its own. public/sw.js skips /i/ so a staff phone's
// service worker never caches a customer page as the app shell.
//
// The invoice part opens only while the invoice is awaiting payment or
// finished. A reopened (draft) invoice is mid-correction, a canceled one was
// never a bill.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const fu = require('../utils/invoiceReviewRequest');
const survey = require('../utils/invoiceSurvey');
const { sendEmailDetailed } = require('../utils/email');

const router = express.Router();

const pageLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: 'Too many requests. Please try again in a few minutes.' });
const postLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please try again in a few minutes.' } });

var EMAIL_COPY_PER_DAY = 3;
var esc = fu.esc;

function noStore(res) { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); }

function clientIp(req) { return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '').slice(0, 60); }

async function loadByToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const r = await pool.query('SELECT * FROM invoices WHERE customer_link_token = $1', [token]);
  return r.rows[0] || null;
}

async function logEvent(inv, kind, detail, req) {
  try {
    await pool.query('INSERT INTO invoice_link_events (invoice_id, kind, detail, ip) VALUES ($1,$2,$3,$4)', [inv.id, kind, detail ? String(detail).slice(0, 255) : null, req ? clientIp(req) : null]);
  } catch (e) { console.error('[invoiceLink] event:', e.message); }
}

function invoiceOpen(inv) { return fu.LINK_OPEN.indexOf(inv.status) !== -1; }

function shortName(n) {
  var parts = String(n || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.length > 1 ? (parts[0] + ' ' + parts[parts.length - 1].charAt(0) + '.') : parts[0];
}

function fmtDate(d) {
  if (!d) return '';
  try {
    var dt = (d instanceof Date) ? d : new Date(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return ''; }
}

function simplePage(res, code, title, msg) {
  noStore(res);
  res.status(code).set('Content-Type', 'text/html; charset=utf-8').send(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>' + esc(title) + '</title></head><body style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#222;line-height:1.6">' +
    '<h2 style="margin-bottom:8px">' + esc(title) + '</h2><p>' + esc(msg) + '</p></body></html>'
  );
}

var CSS =
  '*{box-sizing:border-box}body{margin:0;background:#f3f3f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#1b1b1b}' +
  '.wrap{max-width:460px;margin:0 auto;padding-bottom:24px}@media(min-width:700px){.wrap{padding-top:32px}.top{border-radius:14px 14px 0 0}.sec:last-of-type{border-radius:0 0 14px 14px}}' +
  '.top{background:#111;padding:18px 20px}.brand{font-weight:800;font-size:20px;color:#f97316}.brand small{display:block;color:#bbb;font-weight:500;font-size:12px;margin-top:2px}' +
  '.sec{background:#fff;padding:20px;margin-top:10px}.sec.first{margin-top:0}' +
  '.hi{font-size:15px;color:#555;margin:0 0 4px}.num{font-size:22px;font-weight:700;margin:0 0 14px}' +
  '.badge{display:inline-block;font-weight:700;font-size:12px;border-radius:20px;padding:3px 10px;margin-left:8px;vertical-align:3px}.badge.paid{background:#e7f7ec;color:#167a3a}.badge.due{background:#fff3e0;color:#b45309}' +
  '.sum{border:1px solid #eee;border-radius:12px;padding:12px 16px;margin-bottom:16px}.row{display:flex;justify-content:space-between;gap:12px;font-size:14px;padding:3px 0;color:#444}.row.t{font-weight:700;color:#111;font-size:17px;border-top:1px solid #eee;margin-top:6px;padding-top:9px}' +
  '.btns{display:flex;gap:8px}.b{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;border:1px solid #ddd;border-radius:12px;padding:11px 4px;font-size:13px;font-weight:600;background:#fff;color:#1b1b1b;text-decoration:none;cursor:pointer;font-family:inherit}.b.p{background:#f97316;border-color:#f97316;color:#fff}.b svg{width:20px;height:20px}' +
  '.ec{display:none;border:1px solid #f3c9a6;background:#fffaf5;border-radius:12px;padding:14px;margin-top:10px}.ec.on{display:block}.ec label{font-size:13px;color:#555;display:block;margin-bottom:6px}' +
  'input[type=email],textarea{width:100%;border:1px solid #ccc;border-radius:10px;padding:12px;font:inherit;font-size:16px}textarea{min-height:84px}' +
  '.go{width:100%;border:0;border-radius:12px;padding:15px;font-size:16px;font-weight:600;background:#f97316;color:#fff;margin-top:10px;cursor:pointer;font-family:inherit;display:block;text-align:center;text-decoration:none}.go.g{background:#1a73e8}.go[disabled]{opacity:.6}' +
  '.fine{font-size:12px;color:#888;margin-top:6px}.msg{font-size:14px;margin-top:8px}.msg.err{color:#b91c1c}.msg.ok{color:#167a3a}' +
  '.h{font-size:18px;font-weight:700;margin:0 0 4px}.sub{font-size:14px;color:#666;margin:0 0 16px;line-height:1.5}' +
  '.q{margin-bottom:16px}.q .l{font-size:14px;font-weight:600;margin-bottom:8px}.ch{display:flex;gap:8px;flex-wrap:wrap}.c{border:1px solid #d6d6d6;border-radius:20px;padding:8px 14px;font-size:14px;background:#fff;cursor:pointer;font-family:inherit;color:#1b1b1b}.c.on{background:#111;border-color:#111;color:#fff}' +
  '.faces{display:flex;gap:6px}.f{flex:1;text-align:center;border:1px solid #d6d6d6;border-radius:12px;padding:9px 2px;font-size:12px;color:#444;background:#fff;cursor:pointer;font-family:inherit}.f b{display:block;font-size:22px;margin-bottom:3px}.f.on{border-color:#f97316;background:#fff4ea;color:#c2560c;font-weight:600}' +
  '.ok{display:flex;gap:12px;align-items:flex-start;background:#eefaf2;border:1px solid #bfe6cc;border-radius:12px;padding:14px;font-size:15px;line-height:1.5}.ck{background:#1f9d55;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}' +
  '.foot{text-align:center;font-size:13px;color:#777;margin-top:16px}.foot a{color:#c2560c;font-weight:600;text-decoration:none}';

var ICON = {
  view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/></svg>'
};

function surveyHtml(done) {
  if (done) {
    return '<div class="sec" id="survey"><div class="ok"><div class="ck">&#10003;</div><div><b>Thank you.</b><br>We have your feedback. It went straight to the local manager.</div></div></div>';
  }
  var faces = [['1', '&#128542;', 'Poor'], ['2', '&#128528;', 'Okay'], ['3', '&#128578;', 'Good'], ['4', '&#128512;', 'Great'], ['5', '&#129321;', 'Excellent']];
  function yn(name, label) {
    return '<div class="q"><div class="l">' + label + '</div><div class="ch" data-q="' + name + '">' +
      '<button type="button" class="c" data-v="yes">Yes</button><button type="button" class="c" data-v="no">No</button><button type="button" class="c" data-v="unsure">Not sure</button></div></div>';
  }
  return '<div class="sec" id="survey"><p class="h">How did we do?</p><p class="sub">Takes 30 seconds. It goes straight to the local manager, not the locksmith.</p>' +
    '<div class="q"><div class="l">Overall, how was your experience?</div><div class="faces" data-q="overall">' +
      faces.map(function (f) { return '<button type="button" class="f" data-v="' + f[0] + '"><b>' + f[1] + '</b>' + f[2] + '</button>'; }).join('') + '</div></div>' +
    yn('arrived', 'Did the locksmith arrive when we said?') +
    yn('price_explained', 'Was the price explained before work started?') +
    yn('professional', 'Was the locksmith professional and courteous?') +
    '<div class="q"><div class="l">Anything else we should know? <span style="font-weight:400;color:#888">(optional)</span></div><textarea id="sv-comment" maxlength="2000"></textarea></div>' +
    '<div class="q"><div class="l">Can a manager contact you about this?</div><div class="ch" data-q="call_me"><button type="button" class="c" data-v="yes">Yes, call me</button><button type="button" class="c" data-v="no">No thanks</button></div></div>' +
    '<button type="button" class="go" id="sv-send">Send feedback</button><div class="msg" id="sv-msg"></div></div>';
}

async function renderPage(inv, mode, surveyDone) {
  var co = await fu.companyInfo();
  var brand = co.name || 'Pop-A-Lock';
  var first = fu.firstName(inv.customer_name);
  var showInvoice = mode !== 'survey_only' && invoiceOpen(inv);
  var body = '';
  body += '<div class="top"><div class="brand">' + esc(brand) + '<small>Lock and Roll LLC</small></div></div>';
  if (showInvoice) {
    var paid = fu.FINISHED.indexOf(inv.status) !== -1;
    body += '<div class="sec first"><p class="hi">' + (first ? ('Hi ' + esc(first) + ', here is your invoice.') : 'Here is your invoice.') + '</p>' +
      '<p class="num">Invoice #' + esc(String(inv.invoice_number || inv.id)) + (paid ? ' <span class="badge paid">Paid</span>' : ' <span class="badge due">Payment due</span>') + '</p>' +
      '<div class="sum">' +
        '<div class="row"><span>Date</span><span>' + esc(fmtDate(inv.invoice_date || inv.created_at)) + '</span></div>' +
        (inv.locksmith_name ? '<div class="row"><span>Locksmith</span><span>' + esc(shortName(inv.locksmith_name)) + '</span></div>' : '') +
        '<div class="row t"><span>Total</span><span>' + fu.money(inv.grand_total) + '</span></div>' +
      '</div>' +
      '<div class="btns">' +
        '<a class="b p" href="' + esc(inv.customer_link_token) + '/pdf" target="_blank" rel="noopener">' + ICON.view + 'View</a>' +
        '<button type="button" class="b" id="ec-toggle">' + ICON.mail + 'Email copy</button>' +
        '<a class="b" href="' + esc(inv.customer_link_token) + '/pdf?dl=1">' + ICON.dl + 'Download</a>' +
        '<button type="button" class="b" id="share-btn" style="display:none">' + ICON.share + 'Share</button>' +
      '</div>' +
      '<div class="ec" id="ec"><label for="ec-email">Send a copy to</label><input type="email" id="ec-email" autocomplete="email" placeholder="name@example.com" />' +
        '<button type="button" class="go" id="ec-send">Send invoice</button><div class="fine">We will email the PDF of this invoice. Limited to a few sends per day.</div><div class="msg" id="ec-msg"></div></div>' +
      '</div>';
  } else if (mode === 'survey_only') {
    body += '<div class="sec first"><p class="hi">' + (first ? ('Hi ' + esc(first) + ', thank you') : 'Thank you') + ' for having us out today.</p></div>';
  } else {
    body += '<div class="sec first"><p class="hi">This invoice is being updated right now. Please check back a little later, or call us for a copy.</p></div>';
  }
  if (mode === 'google') {
    body += '<div class="sec"><p class="h">How did we do?</p><p class="sub">We would appreciate your honest feedback on Google. It takes a minute and helps other people find a locksmith they can trust.</p>' +
      '<a class="go g" href="' + esc(inv.customer_link_token) + '/google" target="_blank" rel="noopener">Leave a Google review</a></div>';
  } else if (mode === 'survey' || mode === 'survey_only') {
    body += surveyHtml(surveyDone);
  }
  if (co.phone) {
    body += '<div class="foot">Questions? <a href="tel:' + esc(String(co.phone).replace(/[^0-9+]/g, '')) + '">Call ' + esc(co.phone) + '</a></div>';
  }
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>' + (showInvoice ? ('Invoice #' + esc(String(inv.invoice_number || inv.id)) + ' | ') : '') + esc(brand) + '</title>' +
    '<base href="/i/">' +
    '<style>' + CSS + '</style></head><body data-token="' + esc(inv.customer_link_token) + '" data-title="' + esc('Invoice #' + (inv.invoice_number || inv.id)) + '">' +
    '<div class="wrap">' + body + '</div><script src="/js/customerPage.js?v=1"></script></body></html>';
}

router.get('/:token', pageLimiter, async (req, res) => {
  try {
    const inv = await loadByToken(req.params.token);
    if (!inv) return simplePage(res, 404, 'Not found', 'This link is not valid. Please contact us and we will send it again.');
    if (inv.status === 'canceled') return simplePage(res, 410, 'No longer available', 'This invoice was canceled. Please contact us with any questions.');
    var mode = inv.followup_mode || null;
    var done = false;
    if (mode === 'survey' || mode === 'survey_only') {
      try { done = (await pool.query('SELECT 1 FROM invoice_surveys WHERE invoice_id = $1', [inv.id])).rows.length > 0; } catch (e) {}
    }
    await logEvent(inv, 'page_open', null, req);
    try { await pool.query('UPDATE invoices SET customer_link_viewed_at = COALESCE(customer_link_viewed_at, NOW()) WHERE id = $1', [inv.id]); } catch (e) {}
    noStore(res);
    res.set('Content-Type', 'text/html; charset=utf-8').send(await renderPage(inv, mode, done));
  } catch (err) {
    console.error('[invoiceLink] page failed:', err);
    simplePage(res, 500, 'Something went wrong', 'We could not open this page right now. Please try again shortly.');
  }
});

router.get('/:token/pdf', pageLimiter, async (req, res) => {
  try {
    const inv = await loadByToken(req.params.token);
    if (!inv) return simplePage(res, 404, 'Not found', 'This link is not valid. Please contact us and we will send it again.');
    if (inv.followup_mode === 'survey_only' || !invoiceOpen(inv)) {
      return simplePage(res, 409, 'Invoice not available', 'This invoice is not available here right now. Please contact us for a copy.');
    }
    const pdf = await fu.buildCustomerPdf(inv);
    await logEvent(inv, 'pdf', req.query.dl ? 'download' : 'view', req);
    noStore(res);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + '; filename="Invoice-' + String(inv.invoice_number || inv.id).replace(/[^A-Za-z0-9_-]/g, '') + '.pdf"');
    res.send(pdf);
  } catch (err) {
    console.error('[invoiceLink] pdf failed:', err);
    simplePage(res, 500, 'Something went wrong', 'We could not open this invoice right now. Please try again shortly.');
  }
});

// Counts the tap so the report can show how many customers opened Google,
// then sends them on. Only for a Google follow-up: a survey page has no Google
// link and this route will not invent one for it.
router.get('/:token/google', pageLimiter, async (req, res) => {
  try {
    const inv = await loadByToken(req.params.token);
    if (!inv) return simplePage(res, 404, 'Not found', 'This link is not valid.');
    if (inv.followup_mode !== 'google') return res.redirect(302, '/i/' + inv.customer_link_token);
    const url = await fu.reviewLinkFor(inv.city_code);
    if (!url) return res.redirect(302, '/i/' + inv.customer_link_token);
    await logEvent(inv, 'google_click', null, req);
    noStore(res);
    res.redirect(302, url);
  } catch (err) {
    console.error('[invoiceLink] google failed:', err);
    simplePage(res, 500, 'Something went wrong', 'Please try again shortly.');
  }
});

router.post('/:token/email-copy', postLimiter, async (req, res) => {
  try {
    const inv = await loadByToken(req.params.token);
    if (!inv) return res.status(404).json({ error: 'This link is not valid.' });
    if (inv.followup_mode === 'survey_only' || !invoiceOpen(inv)) return res.status(409).json({ error: 'This invoice is not available right now.' });
    var to = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 255);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const cnt = await pool.query("SELECT COUNT(*)::int AS n FROM invoice_link_events WHERE invoice_id = $1 AND kind = 'email_copy' AND created_at > NOW() - INTERVAL '1 day'", [inv.id]);
    if (cnt.rows[0].n >= EMAIL_COPY_PER_DAY) return res.status(429).json({ error: 'This invoice has been emailed the most times allowed today. Please try again tomorrow or call us.' });
    const pdf = await fu.buildCustomerPdf(inv);
    var co = await fu.companyInfo();
    var brand = co.name || 'Pop-A-Lock';
    var num = String(inv.invoice_number || inv.id);
    var html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.6;max-width:560px">' +
      '<p>Hello,</p><p>Here is a copy of invoice <strong>#' + esc(num) + '</strong> from ' + esc(brand) + ', requested from the invoice page.</p>' +
      (co.phone ? '<p>Questions? Call us at ' + esc(co.phone) + '.</p>' : '') +
      '<p style="color:#888;font-size:12px;border-top:1px solid #eee;padding-top:10px;margin-top:18px">This message was sent from an unmonitored address. Please contact ' + esc(brand) + ' directly with any questions.</p></div>';
    var base = process.env.QUOTE_FROM_EMAIL || '';
    if (!base) { var m = (process.env.FROM_EMAIL || '').match(/<([^>]+)>/); base = brand + ' <' + ((m ? m[1] : (process.env.FROM_EMAIL || '').trim()) || 'onboarding@resend.dev') + '>'; }
    var r = await sendEmailDetailed(to, 'Invoice #' + num + ' from ' + brand, html, null,
      [{ filename: 'Invoice-' + num + '.pdf', content: pdf.toString('base64'), content_type: 'application/pdf' }], { from: base });
    if (!r.ok) return res.status(502).json({ error: 'The email did not send. Please try again, or call us.' });
    await logEvent(inv, 'email_copy', to, req);
    res.json({ ok: true });
  } catch (err) {
    console.error('[invoiceLink] email copy failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again shortly.' });
  }
});

router.post('/:token/survey', postLimiter, async (req, res) => {
  try {
    const inv = await loadByToken(req.params.token);
    if (!inv) return res.status(404).json({ error: 'This link is not valid.' });
    if (inv.followup_mode !== 'survey' && inv.followup_mode !== 'survey_only') return res.status(409).json({ error: 'There is no survey for this invoice.' });
    if (inv.status === 'canceled') return res.status(409).json({ error: 'This invoice was canceled.' });
    var r = await survey.submitSurvey(inv, req.body || {}, clientIp(req));
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true, already: !!r.already });
  } catch (err) {
    console.error('[invoiceLink] survey failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again shortly.' });
  }
});

module.exports = router;
module.exports.renderPage = renderPage;
