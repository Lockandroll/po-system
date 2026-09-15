// Shared logic for Separation Agreements.
//
// Everything here is pure: no database, no network, no Express. It lives out of
// routes/separation.js so the rules that decide whether an agreement may be sent,
// whether a signing link still works, and what the departing person is allowed to
// see can be read and tested on their own rather than only through an HTTP round
// trip. Same split as utils/release.js, which this feature is modelled on.
//
// House style: string concatenation only, no template literals/backticks.

// The lifecycle. draft -> sent -> employee_signed -> completed, falling out to
// declined / voided / expired at any point before that.
var STATUSES = ['draft', 'sent', 'employee_signed', 'completed', 'declined', 'voided', 'expired'];
// Reached one of these and it is finished: no edits, no re-sends, no signatures.
var TERMINAL = ['completed', 'declined', 'voided', 'expired'];
// Shorter than a release's 14 days on purpose. A separation agreement is signed
// at the end of employment, not chased for a fortnight, and a link that outlives
// the conversation is a link sitting in an ex-employee's inbox.
var DEFAULT_EXPIRY_DAYS = 10;

// Mirrors GONE_OUTCOMES in utils/property.js. Duplicated deliberately and kept
// to one line: importing the property module here would drag the receipt's whole
// vocabulary into the agreement's, and these two files are meant to stay
// separately testable. If one changes, change both - there is a test for it.
var GONE_OUTCOMES = ['not_returned', 'lost', 'stolen', 'kept'];

function usd(n) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A DATE column comes back from pg as a local-midnight Date. Read the local
// parts, never the ISO string, or every date west of UTC prints a day early.
function mdy(d) {
  if (!d) return '';
  var t = (d instanceof Date) ? d : new Date(d);
  if (isNaN(t.getTime())) return String(d);
  var m = t.getMonth() + 1, day = t.getDate();
  return (m < 10 ? '0' : '') + m + '/' + (day < 10 ? '0' : '') + day + '/' + t.getFullYear();
}

// Hours, the unit PTO is stored in everywhere else in Nova, shown as hours AND
// days because 8h = 1 day is not obvious to somebody reading their own payout.
function hoursText(h) {
  var v = Number(h);
  if (!isFinite(v) || v <= 0) return '0 hours';
  var days = v / 8;
  var d = (Math.round(days * 100) / 100);
  return (Math.round(v * 100) / 100) + ' hours (' + d + ' day' + (d === 1 ? '' : 's') + ')';
}

// What has to be filled in before an agreement can go to the person signing it.
// Returned as plain labels so the browser can name the empty fields rather than
// just refusing. An agreement missing any of these is not a document anybody
// should sign: without a last day there is nothing being agreed to, and without
// a named countersigner there is no second party.
function missingForSend(agr) {
  agr = agr || {};
  var out = [];
  if (!agr.employee_name || !String(agr.employee_name).trim()) out.push('Employee name');
  if (!agr.last_day) out.push('Last day');
  if (!agr.rep_name || !String(agr.rep_name).trim()) out.push('Countersigning manager');
  if (!agr.terms_body || !String(agr.terms_body).trim()) out.push('Agreement wording');
  return out;
}

// Why a token cannot be used, or null when it can. Checked on EVERY public
// route, not just the first: a link that was live when the page loaded can be
// dead by the time the signature is submitted.
//
// Order matters. Status is checked before the clock, so an agreement that was
// voided and has also run past its date reports "withdrawn" rather than
// "expired" - the more accurate of the two, and the one that matches what the
// person who voided it would say.
function tokenError(agr) {
  if (!agr) return null;
  if (agr.status === 'voided') return { code: 410, msg: 'This agreement has been withdrawn.' };
  if (agr.status === 'declined') return { code: 410, msg: 'This agreement was declined.' };
  if (agr.status === 'expired') return { code: 410, msg: 'This signing link has expired.' };
  if (agr.status === 'employee_signed' || agr.status === 'completed') {
    return { code: 410, msg: 'You have already signed this agreement. Thank you.' };
  }
  if (agr.employee_token_expires_at && new Date(agr.employee_token_expires_at) < new Date()) {
    return { code: 410, msg: 'This signing link has expired.' };
  }
  return null;
}

// What blocks sending because of the property receipt, or null.
//
// The receipt has to be POSTED before the agreement goes out, because the
// agreement prints the property list and a signature against an unposted draft
// would attest to a list that can still change. "Nothing to return" is a posted
// receipt too - it is an answer, not an omission.
function receiptBlocker(agr) {
  if (!agr) return null;
  if (!agr.receipt_id) {
    return 'Start the Receipt of Property first. The agreement lists what they handed back, so it cannot go out before that is recorded.';
  }
  if (agr.receipt_status !== 'posted') {
    return 'The Receipt of Property is still a draft. Post it before sending, so what they sign is what was actually recorded.';
  }
  return null;
}

// The property lines as the person signing should see them. Enough to recognise
// each item and disagree if it is wrong, and nothing about where it went
// afterwards - which shelf a returned tool landed on is our business, not theirs.
// Value appears ONLY on what did not come back, because that is the part they
// are being asked to agree to.
function propertyView(lines) {
  return (lines || []).map(function (l) {
    var gone = GONE_OUTCOMES.indexOf(l.outcome) !== -1;
    var qty = Number(l.qty) || 1;
    var cost = Number(l.unit_cost) || 0;
    return {
      label: l.label,
      serial_number: l.serial_number || l.asset_tag || null,
      qty: qty,
      outcome: l.outcome,
      note: l.note || null,
      value: gone && cost > 0 ? Math.round(qty * cost * 100) / 100 : null
    };
  });
}

function propertyTotals(lines) {
  var gone = 0, value = 0;
  (lines || []).forEach(function (l) {
    if (GONE_OUTCOMES.indexOf(l.outcome) === -1) return;
    gone += 1;
    value += (Number(l.qty) || 1) * (Number(l.unit_cost) || 0);
  });
  return { not_returned: gone, value_not_returned: Math.round(value * 100) / 100 };
}

// Everything the public page needs and nothing it does not. No ids, no token, no
// internal notes, no reason for the departure, no rehire eligibility, no other
// record. Anything added to separation_agreements stays invisible to the person
// signing until it is added HERE, which is the intended default - this row sits
// next to notes a departing employee must never read.
function publicView(agr, companyName, propertyLines) {
  return {
    property: propertyView(propertyLines),
    property_totals: propertyTotals(propertyLines),
    property_recorded_at: agr.receipt_posted_at || null,
    nothing_to_return: !!agr.nothing_to_return,
    agreement_number: agr.agreement_number,
    company: companyName,
    employee_name: agr.employee_name,
    job_title: agr.job_title,
    last_day: agr.last_day,
    final_check_date: agr.final_check_date,
    severance_amount: agr.severance_amount,
    pto_payout_hours: agr.pto_payout_hours,
    property_notes: agr.property_notes,
    terms_body: String(agr.terms_body || '').replace(/\{\{COMPANY\}\}/g, companyName),
    rep_name: agr.rep_name,
    rep_title: agr.rep_title,
    consent_accepted: !!agr.employee_consent
  };
}

// Who may countersign: the manager named ON THE AGREEMENT, plus admin/owner.
// Deliberately not a permission. The signature belongs to the person named on
// the form; manage_offboarding is about running the process, not signing for
// somebody else. Same rule as canCountersign() in utils/release.js.
function canCountersign(agr, user) {
  if (!agr || !user) return false;
  if (user.role === 'admin' || user.role === 'owner') return true;
  return agr.rep_user_id != null && Number(agr.rep_user_id) === Number(user.id);
}

// A signature arriving from a public page. Validated hard and identically
// wherever it comes in, so the in-person path cannot be looser than the link.
function checkSignatureDataUrl(dataUrl) {
  var s = String(dataUrl || '');
  if (!/^data:image\/png;base64,/.test(s)) return 'Signature must be a PNG image.';
  var b64 = s.replace(/^data:image\/png;base64,/, '');
  var bytes = Math.floor(b64.length * 3 / 4);
  if (!bytes) return 'Signature image is not a usable size.';
  if (bytes > 2 * 1024 * 1024) return 'Signature image is not a usable size.';
  return null;
}

function isValidToken(token) {
  return !!token && /^[a-f0-9]{64}$/i.test(String(token));
}

// A very light email check. The point is to catch a typo before a link is fired
// at nobody, not to be RFC 5322 - the address is typed by a manager reading it
// off a phone screen, and the real check is whether the person replies.
function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
}

module.exports = {
  STATUSES: STATUSES,
  TERMINAL: TERMINAL,
  DEFAULT_EXPIRY_DAYS: DEFAULT_EXPIRY_DAYS,
  usd: usd,
  esc: esc,
  mdy: mdy,
  hoursText: hoursText,
  missingForSend: missingForSend,
  receiptBlocker: receiptBlocker,
  propertyView: propertyView,
  propertyTotals: propertyTotals,
  GONE_OUTCOMES: GONE_OUTCOMES,
  tokenError: tokenError,
  publicView: publicView,
  canCountersign: canCountersign,
  checkSignatureDataUrl: checkSignatureDataUrl,
  isValidToken: isValidToken,
  looksLikeEmail: looksLikeEmail
};
