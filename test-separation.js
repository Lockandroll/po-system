// Separation agreement checks. Run by hand: node test-separation.js
//
// Exercises the pure rules in utils/separation.js and actually builds a PDF with
// utils/separationPdf.js. No database and no network - the logo is passed in as
// an empty buffer so the builder never reaches for the CDN - so this is safe to
// run anywhere, unlike the tests that need a live Postgres.
//
// The rules worth guarding here are the ones that are invisible when they break:
// what the public payload leaks, who is allowed to countersign, and whether a
// dead link is really refused.
//
// House style: string concatenation only, no template literals/backticks.
var assert = require('assert');
var sep = require('./utils/separation');
var pdf = require('./utils/separationPdf');
var n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.deepStrictEqual(a, b, msg); }

// ---- tokenError: status beats the clock, and a signed doc cannot be re-signed
var past = new Date(Date.now() - 86400000);
eq(sep.tokenError({ status: 'sent', employee_token_expires_at: new Date(Date.now() + 8.64e7) }), null, 'live link works');
ok(sep.tokenError({ status: 'sent', employee_token_expires_at: past }).code === 410, 'expired link refused');
ok(/withdrawn/i.test(sep.tokenError({ status: 'voided', employee_token_expires_at: past }).msg), 'voided+expired reports withdrawn');
ok(/already signed/i.test(sep.tokenError({ status: 'employee_signed' }).msg), 'no second signature');
ok(/already signed/i.test(sep.tokenError({ status: 'completed' }).msg), 'completed is closed');
ok(/declined/i.test(sep.tokenError({ status: 'declined' }).msg), 'declined is closed');

// ---- missingForSend names every empty field, not just the first
var empty = sep.missingForSend({});
eq(empty.length, 4, 'four fields required to send');
eq(sep.missingForSend({ employee_name: 'A', last_day: '2026-09-14', rep_name: 'B', terms_body: 'x' }), [], 'complete draft can send');
eq(sep.missingForSend({ employee_name: '   ', last_day: '2026-09-14', rep_name: 'B', terms_body: 'x' }), ['Employee name'], 'whitespace is not a name');

// ---- publicView must not leak anything the departing person should not see
var row = {
  id: 7, agreement_number: 'SEP-2026-0001', employee_token: 'deadbeef'.repeat(8),
  employee_name: 'Joshua Cisneros', job_title: 'Locksmith', last_day: '2026-09-14',
  terms_body: 'Between the Employee and {{COMPANY}}.', rep_name: 'Tony McKeon',
  employee_signed_ip: '10.0.0.4', declined_reason: 'internal note', facts: { secret: 1 },
  user_id: 42, offboarding_id: 9, created_by: 1, severance_amount: '250.00'
};
var view = sep.publicView(row, 'Lock and Roll LLC');
var leaked = ['employee_token', 'id', 'user_id', 'offboarding_id', 'created_by',
              'employee_signed_ip', 'declined_reason', 'facts'];
leaked.forEach(function (k) { ok(!(k in view), 'public view hides ' + k); });
ok(view.terms_body.indexOf('Lock and Roll LLC') !== -1, 'company placeholder filled');
ok(view.terms_body.indexOf('{{COMPANY}}') === -1, 'no placeholder left behind');

// ---- countersign gate
var agr = { rep_user_id: 5 };
ok(sep.canCountersign(agr, { id: 5, role: 'manager' }) === true, 'named manager signs');
ok(sep.canCountersign(agr, { id: 6, role: 'manager' }) === false, 'another manager cannot');
ok(sep.canCountersign(agr, { id: 6, role: 'admin' }) === true, 'admin can');
ok(sep.canCountersign(agr, { id: 6, role: 'owner' }) === true, 'owner can');
ok(sep.canCountersign({ rep_user_id: null }, { id: 6, role: 'manager' }) === false, 'nobody named, nobody signs');
ok(sep.canCountersign(agr, null) === false, 'no user, no signature');

// ---- signature validation
var tiny = 'data:image/png;base64,' + Buffer.from('x').toString('base64');
eq(sep.checkSignatureDataUrl(tiny), null, 'small png accepted');
ok(sep.checkSignatureDataUrl('data:image/jpeg;base64,abcd') !== null, 'jpeg refused');
ok(sep.checkSignatureDataUrl('') !== null, 'empty refused');
ok(sep.checkSignatureDataUrl('data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024)) !== null, 'oversize refused');

// ---- token shape
ok(sep.isValidToken('a'.repeat(64)) === true, '64 hex is a token');
ok(sep.isValidToken('a'.repeat(63)) === false, 'short is not');
ok(sep.isValidToken("' OR 1=1--") === false, 'junk is not');

// ---- email
ok(sep.looksLikeEmail('a@b.co') === true);
ok(sep.looksLikeEmail('nope') === false);
ok(sep.looksLikeEmail('') === false);

// ---- hours reads as hours AND days
ok(sep.hoursText(8) === '8 hours (1 day)', sep.hoursText(8));
ok(sep.hoursText(0) === '0 hours');
ok(sep.hoursText(12) === '12 hours (1.5 days)', sep.hoursText(12));

// ---- the PDF actually builds, with signatures and a certificate page
// 1x1 white PNG
var png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
var full = {
  agreement_number: 'SEP-2026-0001', status: 'completed',
  employee_name: 'Joshua Cisneros', job_title: 'Locksmith', last_day: '2026-09-14',
  final_check_date: '2026-09-19', pto_payout_hours: 12.5, severance_amount: 0,
  property_notes: 'All returned', terms_body: pdf.DEFAULT_SEPARATION_BODY,
  employee_printed_name: 'Joshua Cisneros', employee_signed_at: new Date(),
  rep_name: 'Tony McKeon', rep_title: 'COO', rep_signed_at: new Date(), completed_at: new Date()
};
var events = [
  { event_type: 'created', actor: 'Tony McKeon', created_at: new Date(), ip: '10.0.0.1' },
  { event_type: 'sent', actor: 'Tony McKeon', created_at: new Date(), ip: '10.0.0.1' },
  { event_type: 'signed', actor: 'Joshua Cisneros', created_at: new Date(), ip: '10.0.0.9' },
  { event_type: 'countersigned', actor: 'Tony McKeon', created_at: new Date(), ip: '10.0.0.1' }
];

// certificate:false and no logo fetch, so the test never touches the network.
pdf.buildSeparationPdf(full, events, { company: { name: 'Lock and Roll LLC' }, logo: Buffer.alloc(0), employeeSig: png, repSig: png })
  .then(function (buf) {
    n++; assert.ok(Buffer.isBuffer(buf) && buf.length > 3000, 'pdf has bytes: ' + buf.length);
    n++; assert.ok(buf.slice(0, 5).toString() === '%PDF-', 'starts with %PDF-');
    var pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    n++; assert.ok(pages >= 2, 'document + certificate page, got ' + pages);
    n++; assert.ok(buf.toString('latin1').indexOf('&#39;') === -1, 'html entities decoded for print');

    // A draft with nothing filled in must still render rather than throw.
    return pdf.buildSeparationPdf({ agreement_number: 'SEP-2026-0002' }, [], { company: { name: 'Lock and Roll LLC' }, logo: Buffer.alloc(0) });
  })
  .then(function (buf2) {
    n++; assert.ok(Buffer.isBuffer(buf2) && buf2.length > 1000, 'empty draft renders');
    console.log('\nALL PASS - ' + n + ' assertions');
  })
  .catch(function (e) { console.error('FAILED:', e && e.stack || e); process.exit(1); });
