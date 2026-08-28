// Shared logic for Releases of Liability.
//
// Everything here is pure: no database, no network, no Express. It lives out of
// routes/releases.js so the rules that decide whether a release may be sent, and
// whether a signing link still works, can be tested directly (test-release.js)
// instead of only through an HTTP round trip.
//
// House style: string concatenation only, no template literals/backticks.

// The lifecycle. A release moves draft -> sent -> customer_signed -> completed,
// and can fall out to declined / voided / expired at any point before that.
var STATUSES = ['draft', 'sent', 'customer_signed', 'completed', 'declined', 'voided', 'expired'];
// Reached one of these and it is finished: no edits, no re-sends, no signatures.
var TERMINAL = ['completed', 'declined', 'voided', 'expired'];
var DEFAULT_EXPIRY_DAYS = 14;

function usd(n) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// What has to be filled in before a release can go to a customer. Returned as
// plain labels so the browser can name the empty fields rather than just saying
// no. A release with any of these missing is not a document anyone should sign:
// without an address there is no identified party, and without an amount there
// is no consideration.
function missingForSend(rel) {
  rel = rel || {};
  var need = [
    ['claimant_name', 'Claimant printed name'],
    ['claimant_address', 'Mailing address'],
    ['claimant_city', 'City'],
    ['claimant_state', 'State'],
    ['claimant_zip', 'ZIP code'],
    ['damage_description', 'Description of damage'],
    ['rep_name', 'Countersigning representative']
  ];
  var out = [];
  need.forEach(function (n) {
    var v = rel[n[0]];
    if (v == null || String(v).trim() === '') out.push(n[1]);
  });
  if (!rel.service_date) out.push('Date of service');
  if (!(Number(rel.settlement_amount) > 0)) out.push('Settlement amount');
  return out;
}

// Why a token cannot be used, or null when it can. Checked on EVERY public
// route, not just the first: a link that was live when the page loaded can be
// dead by the time the signature is submitted.
//
// Note the order. Status is checked before the clock, so a release that was
// voided and has also run past its date reports "canceled" rather than
// "expired" - the more accurate of the two, and the one that matches what the
// person who voided it would say.
function tokenError(rel) {
  if (!rel) return null;
  if (rel.status === 'voided') return { code: 410, msg: 'This release has been canceled.' };
  if (rel.status === 'declined') return { code: 410, msg: 'This release has been declined.' };
  if (rel.status === 'expired') return { code: 410, msg: 'This release link has expired.' };
  if (rel.status === 'customer_signed' || rel.status === 'completed') {
    return { code: 410, msg: 'This release has already been signed. Thank you.' };
  }
  if (rel.customer_token_expires_at && new Date(rel.customer_token_expires_at) < new Date()) {
    return { code: 410, msg: 'This release link has expired.' };
  }
  return null;
}

// Everything the public page needs and nothing it does not: no ids, no token,
// no internal notes, no staff names beyond the representative who will sign,
// and no other release. Anything added to release_forms is invisible to the
// customer until it is added HERE, which is the intended default.
function publicView(rel, companyName, defaultBody) {
  return {
    release_number: rel.release_number,
    company: companyName,
    claimant_name: rel.claimant_name,
    claimant_phone: rel.claimant_phone,
    claimant_address: rel.claimant_address,
    claimant_city: rel.claimant_city,
    claimant_state: rel.claimant_state,
    claimant_zip: rel.claimant_zip,
    vehicle_year: rel.vehicle_year,
    vehicle_make: rel.vehicle_make,
    vehicle_model: rel.vehicle_model,
    vehicle_color: rel.vehicle_color,
    license_plate: rel.license_plate,
    vin: rel.vin,
    service_date: rel.service_date,
    job_ref: rel.job_ref,
    damage_description: rel.damage_description,
    settlement_amount: rel.settlement_amount,
    release_body: String(rel.release_body || defaultBody || '').replace(/\{\{COMPANY\}\}/g, companyName),
    rep_name: rel.rep_name,
    rep_title: rel.rep_title,
    consent_accepted: !!rel.customer_consent
  };
}

// Only the representative named ON THE FORM may countersign, plus admin/owner.
// This is deliberately not a permission: the signature is that person's, and
// manage_releases is about sending paperwork, not signing it.
function canCountersign(rel, user) {
  if (!rel || !user) return false;
  if (user.role === 'admin' || user.role === 'owner') return true;
  return rel.rep_user_id != null && Number(rel.rep_user_id) === Number(user.id);
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

module.exports = {
  STATUSES: STATUSES,
  TERMINAL: TERMINAL,
  DEFAULT_EXPIRY_DAYS: DEFAULT_EXPIRY_DAYS,
  usd: usd,
  esc: esc,
  missingForSend: missingForSend,
  tokenError: tokenError,
  publicView: publicView,
  canCountersign: canCountersign,
  checkSignatureDataUrl: checkSignatureDataUrl,
  isValidToken: isValidToken
};
