// test-quote-approval-dom.js
// Frontend half of the customer quote approval feature.
//
//   node test-quote-approval-dom.js
//
// No dependencies and no jsdom: every function under test is a pure string
// builder, so they are sliced straight out of public/js/app.js and run in a vm
// with stubbed globals. Slicing (rather than copying) means this test fails if
// app.js changes shape, instead of quietly testing a stale copy.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let PASS = 0, FAIL = 0;
const FAILURES = [];
function ok(name, cond, detail) {
  if (cond) PASS++;
  else { FAIL++; FAILURES.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
function has(name, hay, needle) { ok(name, String(hay).indexOf(needle) !== -1, 'missing: ' + needle); }
function lacks(name, hay, needle) { ok(name, String(hay).indexOf(needle) === -1, 'should not contain: ' + needle); }
function section(t) { console.log('\n== ' + t + ' =='); }

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');

// Pull one top-level `function name(...) { ... }` out by brace matching.
function sliceFunction(name) {
  const start = SRC.indexOf('\nfunction ' + name + '(');
  if (start === -1) throw new Error('app.js no longer defines function ' + name);
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces slicing ' + name);
}

// Pull an anchored region out verbatim.
function sliceRegion(from, to, label) {
  const a = SRC.indexOf(from);
  if (a === -1) throw new Error('app.js no longer contains the ' + label + ' region start');
  const b = SRC.indexOf(to, a);
  if (b === -1) throw new Error('app.js no longer contains the ' + label + ' region end');
  return SRC.slice(a, b);
}

const STAFF = sliceRegion('var QUOTE_STATUSES = {', '// ===== Quote photos', 'staff-side quote approval');
const PUBLIC = sliceRegion('var qaData = null;', '// ----- Public signing page (no login) -----', 'customer approval page');
const HELPERS = ['escHtml', 'formatDate', 'formatDateTime', 'timeAgo', 'resolveTokens', 'quoteValidDate', 'ymdPlusDays', 'quoteAgo', 'quoteRowActivityHtml'].map(sliceFunction).join('\n');

const sandbox = {
  console: console,
  location: { pathname: '/' },
  document: { getElementById: function () { return null; }, createElement: function () { return { style: {}, addEventListener: function () {} }; } },
  window: {},
  navigator: {},
  can: function () { return true; },
  api: function () { return Promise.resolve([]); },
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  novaBtnBusy: function () {}, novaBtnReset: function () {},
  novaAlert: function () {}, novaConfirm: function () { return Promise.resolve(false); },
  navigate: function () {},
  _currentQuote: null
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(HELPERS + '\n' + STAFF + '\n' + PUBLIC, sandbox);
ok('sliced the quote approval code out of app.js', typeof sandbox.quoteStatusPill === 'function' && typeof sandbox.qaLineItemsHtml === 'function');

// ---------------------------------------------------------------------------
section('Status pills');
const STATES = ['draft', 'sent', 'viewed', 'changes_requested', 'approved', 'declined', 'expired'];
STATES.forEach(function (st) {
  const html = sandbox.quoteStatusPill(st);
  ok('pill for ' + st + ' renders a badge', /^<span class="badge badge-[a-z]+">/.test(html), html);
  ok('pill for ' + st + ' is not blank', html.indexOf('</span>') > 30);
});
// Distinct classes, or the list becomes a wall of identical chips.
const classes = STATES.map(function (st) { return sandbox.quoteStatusPill(st).match(/badge-([a-z]+)/)[1]; });
eq('every status gets its own badge class', new Set(classes).size, STATES.length);
eq('an unknown status falls back to draft', sandbox.quoteStatusPill('nonsense'), sandbox.quoteStatusPill('draft'));
eq('a missing status falls back to draft', sandbox.quoteStatusPill(undefined), sandbox.quoteStatusPill('draft'));

section('Row hint');
const day = 86400000;
has('a sent row says it has not been opened', sandbox.quoteRowActivityHtml({ status: 'sent', sent_at: new Date(Date.now() - 3 * day), reminder_count: 0 }), 'not opened');
has('a sent row counts its reminders', sandbox.quoteRowActivityHtml({ status: 'sent', sent_at: new Date(Date.now() - 3 * day), reminder_count: 2 }), '2 reminders');
has('one reminder is singular', sandbox.quoteRowActivityHtml({ status: 'sent', sent_at: new Date(Date.now() - 3 * day), reminder_count: 1 }), '1 reminder,');
has('a viewed row says no answer yet', sandbox.quoteRowActivityHtml({ status: 'viewed', first_viewed_at: new Date(Date.now() - 2 * 3600000) }), 'no answer');
has('a changes row says it is on you', sandbox.quoteRowActivityHtml({ status: 'changes_requested' }), 'Waiting on you');
eq('a draft row adds no hint', sandbox.quoteRowActivityHtml({ status: 'draft' }), '');

// timeAgo() returns null past 7 days. Caught by a screenshot: a quote sent 9
// days ago rendered as the literal "Sent null" in the list.
const OLD = new Date(Date.now() - 9 * day);
const older = sandbox.quoteRowActivityHtml({ status: 'sent', sent_at: OLD, reminder_count: 2 });
lacks('a quote sent over a week ago never renders "null"', older, 'null');
has('it falls back to the date', older, 'Sent on');
lacks('a viewed quote over a week old never renders "null"', sandbox.quoteRowActivityHtml({ status: 'viewed', first_viewed_at: OLD }), 'null');
lacks('a declined quote over a week old never renders "null"', sandbox.quoteRowActivityHtml({ status: 'declined', responded_at: OLD }), 'null');
has('and says what happened', sandbox.quoteRowActivityHtml({ status: 'declined', responded_at: OLD }), 'Declined on');
has('a recently declined quote still reads as relative', sandbox.quoteRowActivityHtml({ status: 'declined', responded_at: new Date(Date.now() - 2 * day) }), 'Declined 2d ago');
lacks('a missing timestamp never renders "null"', sandbox.quoteRowActivityHtml({ status: 'sent', sent_at: null, reminder_count: 0 }), 'null');
lacks('the banner never renders "null" for an old send', sandbox.quoteStatusBannerHtml({ status: 'sent', sent_at: OLD, sent_to: 'a@b.com', reminder_count: 0 }), 'null');
lacks('the banner never renders "null" for an old view', sandbox.quoteStatusBannerHtml({ status: 'viewed', first_viewed_at: OLD, sent_to: 'a@b.com', reminder_count: 0 }), 'null');

section('Status banner');
let b = sandbox.quoteStatusBannerHtml({ status: 'draft' });
has('draft banner explains the lock', b, 'locks until the customer answers');
b = sandbox.quoteStatusBannerHtml({ status: 'approved', approver_name: 'Danielle Harlow', approver_title: 'Property Manager', approved_total: 2486.4, responded_at: new Date() });
has('approved banner names the approver', b, 'Danielle Harlow');
has('approved banner shows the approved total', b, '$2486.40');
has('approved banner shows the title', b, 'Property Manager');
b = sandbox.quoteStatusBannerHtml({ status: 'declined', approver_name: 'Danielle Harlow', decline_reason: 'Went with in-house', responded_at: new Date() });
has('declined banner shows the reason', b, 'Went with in-house');
b = sandbox.quoteStatusBannerHtml({ status: 'declined', approver_name: 'D H', decline_reason: null, responded_at: new Date() });
has('a declined quote with no reason says so', b, 'No reason given');
b = sandbox.quoteStatusBannerHtml({ status: 'changes_requested' });
has('changes banner warns that editing voids the link', b, 'void their link');
b = sandbox.quoteStatusBannerHtml({ status: 'expired', valid_until: '2026-08-01' });
has('expired banner tells you what to do', b, 'Change date');
// Customer-supplied text must be escaped everywhere it lands.
b = sandbox.quoteStatusBannerHtml({ status: 'declined', approver_name: '<img src=x onerror=alert(1)>', decline_reason: '<script>bad()</script>', responded_at: new Date() });
lacks('a hostile approver name is escaped', b, '<img src=x');
lacks('a hostile decline reason is escaped', b, '<script>');

section('Send button');
let sb = sandbox.quoteSendButtonHtml({ id: 7, status: 'draft', customer_email: 'a@b.com' });
has('a draft offers Send to Customer', sb, 'Send to Customer');
has('and wires it to the dialog', sb, 'openQuoteSendDialog(7)');
lacks('and is not disabled', sb, 'disabled');
sb = sandbox.quoteSendButtonHtml({ id: 7, status: 'draft', customer_email: null });
has('a draft with no email disables the button', sb, 'disabled');
has('and says why', sb, 'customer email');
sb = sandbox.quoteSendButtonHtml({ id: 7, status: 'sent' });
has('a sent quote offers a reminder', sb, 'Send a reminder');
has('and the customer link', sb, 'Customer link');
lacks('and never offers Send again', sb, 'Send to Customer');
eq('an answered quote offers neither', sandbox.quoteSendButtonHtml({ id: 7, status: 'approved' }), '');
eq('a declined quote offers neither', sandbox.quoteSendButtonHtml({ id: 7, status: 'declined' }), '');

section('Customer page: token routing');
function tokenFor(p) { sandbox.location.pathname = p; return sandbox.qaGetUrlToken(); }
const GOOD = 'a1b2c3d4'.repeat(8);
eq('a 64-char hex path is a token', tokenFor('/quote/' + GOOD), GOOD);
eq('a trailing slash still resolves', tokenFor('/quote/' + GOOD + '/'), GOOD);
eq('a short token is rejected', tokenFor('/quote/abc123'), null);
eq('an uppercase token is rejected', tokenFor('/quote/' + GOOD.toUpperCase()), null);
eq('a non-hex token is rejected', tokenFor('/quote/' + 'z'.repeat(64)), null);
eq('the app root is not a token', tokenFor('/'), null);
eq('the signing path is not a quote token', tokenFor('/sign/' + GOOD), null);
eq('a lookalike prefix is rejected', tokenFor('/quotes/' + GOOD), null);

section('Customer page: line items');
const PAYLOAD = {
  quote_number: 'QT-2026-0418-TM', status: 'viewed', customer_name: 'Riverbend Storage LLC',
  created_at: new Date('2026-08-23T14:00:00Z'), expires_at: new Date('2026-09-22T14:00:00Z'),
  notes: 'Panic bar is a special order.', important_info: 'Valid through {default_date}.',
  message: 'Let me know if anything looks off.',
  prepared_by: { name: 'Tony McKeon', email: 'tony@lockandroll.com', phone: '(404) 555-0100' },
  company: { company_name: 'Lock and Roll LLC', company_phone: '(404) 555-0100' },
  subtotal: 2055.50, tax_rate: 8.9, tax_amount: 36.31, total: 2091.81,
  line_items: [
    { description: 'Rekey existing mortise cylinder, keyed alike', quantity: 6, list_price: 68, taxable: true, line_type: 'part' },
    { description: 'Panic bar installation, labor', quantity: 3.5, list_price: 185, taxable: false, line_type: 'labor' }
  ]
};
const items = sandbox.qaLineItemsHtml(PAYLOAD);
has('the description is shown', items, 'Rekey existing mortise cylinder');
has('the unit list price is shown', items, '$68.00');
has('the line total is computed', items, '$408.00');
has('a fractional quantity survives', items, '3.5');
has('labor line total is right', items, '$647.50');
has('the subtotal is shown', items, '$2055.50');
has('the tax rate is shown', items, '8.9%');
has('the grand total is shown', items, '$2091.81');
// The reason a customer never sees our cost is the payload, but the renderer
// must not invent a column for it either.
lacks('there is no cost column', items, 'Cost');
lacks('there is no item number column', items, 'Item #');
lacks('there is no supplier column', items, 'Supplier');
eq('exactly four header cells', (items.match(/<th /g) || []).length, 4);

const noTax = sandbox.qaLineItemsHtml(Object.assign({}, PAYLOAD, { tax_amount: 0, tax_rate: 0 }));
lacks('a zero-tax quote hides the tax row', noTax, 'Tax (');
has('and still shows the total', noTax, 'Total');

const nasty = sandbox.qaLineItemsHtml(Object.assign({}, PAYLOAD, {
  line_items: [{ description: '<img src=x onerror=alert(1)>', quantity: 1, list_price: 10, taxable: false, line_type: 'part' }]
}));
lacks('a hostile description is escaped', nasty, '<img src=x');
has('and is still rendered as text', nasty, '&lt;img');

section('Customer page: receipt');
const approved = Object.assign({}, PAYLOAD, {
  status: 'approved', approver_name: 'Danielle Harlow', approver_title: 'Property Manager',
  approved_total: 2091.81, responded_at: new Date('2026-08-23T18:14:00Z')
});
const rec = sandbox.qaReceiptHtml(approved);
has('the receipt thanks them by first name', rec, 'thank you, Danielle');
has('the receipt names the preparer', rec, 'Tony McKeon');
has('the receipt carries the approved total', rec, '$2091.81');
has('the receipt carries the reference', rec, 'QT-2026-0418-TM');
has('the receipt shows the title', rec, 'Property Manager');
has('the receipt offers a printable copy', rec, 'window.print()');

const declined = Object.assign({}, PAYLOAD, { status: 'declined', approver_name: 'Danielle Harlow', responded_at: new Date() });
const drec = sandbox.qaReceiptHtml(declined);
has('a declined receipt says so', drec, 'Quote declined');
lacks('a declined receipt claims no approved total', drec, '$2091.81');

section('Customer page: shell');
const shell = sandbox.qaShell('<p>body</p>', PAYLOAD.company);
has('the shell shows the company name', shell, 'Lock and Roll LLC');
has('the shell shows the phone', shell, '(404) 555-0100');
has('the shell renders the body', shell, '<p>body</p>');
const logoShell = sandbox.qaShell('x', { logo: 'data:image/png;base64,AAA', company_name: 'Lock and Roll LLC' });
has('a configured logo is used', logoShell, 'data:image/png;base64,AAA');
lacks('and replaces the fallback lockup', logoShell, '&#128274;');
const bare = sandbox.qaShell('x', {});
has('with no settings it still names the company', bare, 'Lock and Roll LLC');
has('the shell fills the flex parent', shell, 'flex:1');
has('and spans the full width', shell, 'width:100%');
has('and covers the viewport height', shell, 'min-height:100vh');
has('and paints its own background', shell, 'background:var(--bg)');
lacks('and never uses a CSS variable Nova does not define', shell, '--bg-color');
lacks('the line items table uses a real border token', sandbox.qaLineItemsHtml(PAYLOAD), '--border-color');
lacks('the banner does not use --border-color', sandbox.quoteStatusBannerHtml({ status: 'draft' }), '--border-color');
lacks('the banner does not use --bg-color', sandbox.quoteStatusBannerHtml({ status: 'draft' }), '--bg-color');

section('Customer page: money');
eq('money formats two decimals', sandbox.qaMoney(2486.4), '$2486.40');
eq('money handles a string', sandbox.qaMoney('68'), '$68.00');
eq('money handles null', sandbox.qaMoney(null), '$0.00');
eq('money handles undefined', sandbox.qaMoney(undefined), '$0.00');
eq('money rounds a float', sandbox.qaMoney(0.1 + 0.2), '$0.30');

section('Activity feed text');
const T = sandbox.quoteEventText;
has('a sent event names the recipient', T({ event_type: 'sent', actor_name: 'Tony McKeon', details: { to: 'd.harlow@riverbendstor.com' } }), 'd.harlow@riverbendstor.com');
has('a viewed event reads plainly', T({ event_type: 'viewed', details: {} }), 'Opened the quote');
has('an automatic reminder says so', T({ event_type: 'reminded', actor_name: 'system', details: {} }), 'automatically');
has('an approval shows the amount', T({ event_type: 'approved', actor_name: 'Danielle Harlow', details: { total: 2486.4 } }), '$2486.40');
has('a signed approval says so', T({ event_type: 'approved', actor_name: 'D H', details: { total: 1, signed: true } }), 'signed');
has('a decline shows the reason', T({ event_type: 'declined', actor_name: 'D H', details: { reason: 'Went with in-house' } }), 'Went with in-house');
has('a changes request shows the message', T({ event_type: 'changes_requested', details: { message: 'hold the panic bar' } }), 'hold the panic bar');
has('a void caused by an edit says so', T({ event_type: 'link_voided', actor_name: 'Tony', details: { reason: 'edited' } }), 'quote was edited');
has('an unknown event still renders', T({ event_type: 'some_new_thing', details: {} }), 'some new thing');
lacks('a hostile event message is escaped', T({ event_type: 'changes_requested', details: { message: '<script>x</script>' } }), '<script>');

section('The valid-through date');

// {default_date} used to be "today + 30, computed right now", so the same quote
// claimed a different date every day it was opened and could never lapse.
const TERMS = 'This proposal is valid until {default_date}. Any major changes to the cost of parts will be discussed.';
eq('the token resolves to the quote\'s own date', sandbox.resolveTokens(TERMS, '2026-09-22').indexOf('valid until 09/22/2026') !== -1, true);
eq('a date-only string works', sandbox.quoteValidDate('2026-09-22'), '09/22/2026');
eq('an ISO timestamp is trimmed to its day', sandbox.quoteValidDate('2026-09-22T00:00:00.000Z'), '09/22/2026');
eq('a missing date yields null', sandbox.quoteValidDate(null), null);
eq('junk yields null', sandbox.quoteValidDate('next tuesday'), null);
// A quote with no date must not have a promise invented for it.
eq('with no date the token is left visible, not guessed', sandbox.resolveTokens(TERMS, null), TERMS);
eq('and the same for junk', sandbox.resolveTokens(TERMS, 'whenever'), TERMS);
eq('empty text is passed through', sandbox.resolveTokens('', '2026-09-22'), '');

// The old bug, asserted directly: two renders of the same quote must agree.
const r1 = sandbox.resolveTokens(TERMS, '2026-09-22');
const r2 = sandbox.resolveTokens(TERMS, '2026-09-22');
eq('the same quote always renders the same date', r1, r2);
lacks('and it is not derived from today', sandbox.resolveTokens(TERMS, '2020-01-05'), String(new Date().getFullYear() + 1));
has('a date in the past renders as the past', sandbox.resolveTokens(TERMS, '2020-01-05'), '01/05/2020');

// The date input helper the editor and send dialog both prefill from.
ok('ymdPlusDays returns an input-ready date', /^\d{4}-\d{2}-\d{2}$/.test(sandbox.ymdPlusDays(30)), sandbox.ymdPlusDays(30));
ok('30 days out is later than today', sandbox.ymdPlusDays(30) > sandbox.ymdPlusDays(0));
ok('and 0 is today', sandbox.ymdPlusDays(0) === sandbox.ymdPlusDays());

section('Past its date, but still answerable');
let pb = sandbox.quoteStatusBannerHtml({ status: 'expired', valid_until: '2026-08-01' });
has('the banner no longer claims the link is dead', pb, 'still works');
has('and names the date it was good through', pb, '08/01/2026');
lacks('and never says "expired link"', pb.toLowerCase(), 'link expired');
eq('the pill reads as a date, not a dead end', sandbox.quoteStatusPill('expired').indexOf('Past valid date') !== -1, true);
has('the row hint says the link still works', sandbox.quoteRowActivityHtml({ status: 'expired' }), 'link still works');

section('A late approval is flagged');
let ab = sandbox.quoteStatusBannerHtml({ status: 'approved', approver_name: 'Danielle Harlow', approved_total: 2486.4, responded_at: new Date(), approved_late_days: 12 });
has('the banner shows the customer PO', sandbox.quoteStatusBannerHtml({ status: 'approved', approver_name: 'D H', approved_total: 1, responded_at: new Date(), customer_po_number: 'PO-4500123987' }), 'PO-4500123987');
has('and their note', sandbox.quoteStatusBannerHtml({ status: 'approved', approver_name: 'D H', approved_total: 1, responded_at: new Date(), customer_approval_notes: 'Gate code is 4412' }), 'Gate code is 4412');
lacks('a hostile note is escaped on the banner', sandbox.quoteStatusBannerHtml({ status: 'approved', approver_name: 'D H', approved_total: 1, responded_at: new Date(), customer_approval_notes: '<script>x</script>' }), '<script>');
has('the trail shows the PO', sandbox.quoteEventText({ event_type: 'approved', actor_name: 'D H', details: { total: 1, po_number: 'PO-99' } }), 'Their PO PO-99');
has('an edit while the customer is looking is on the trail', sandbox.quoteEventText({ event_type: 'edited_while_out', actor_name: 'Tony', details: {} }), 'their link still works');
has('the banner says how many days late', ab, '12 days past its valid date');
has('and tells you to re-check pricing', ab, 'Check the pricing still works');
let ok1 = sandbox.quoteStatusBannerHtml({ status: 'approved', approver_name: 'D H', approved_total: 100, responded_at: new Date(), approved_late_days: null });
lacks('an on-time approval says nothing about lateness', ok1, 'past its valid date');
has('one day late is singular', sandbox.quoteStatusBannerHtml({ status: 'approved', approver_name: 'D H', approved_total: 1, responded_at: new Date(), approved_late_days: 1 }), '1 day past');
has('the trail flags a late approval', sandbox.quoteEventText({ event_type: 'approved', actor_name: 'D H', details: { total: 1, late_days: 12 } }), '12 days past its valid date');
lacks('and not an on-time one', sandbox.quoteEventText({ event_type: 'approved', actor_name: 'D H', details: { total: 1 } }), 'past its valid date');
has('a date change is on the trail', sandbox.quoteEventText({ event_type: 'valid_until_changed', actor_name: 'Tony', details: { from: '2026-08-01', to: '2026-09-30', extended: true } }), 'extended to 09/30/2026');
has('and says where it moved from', sandbox.quoteEventText({ event_type: 'valid_until_changed', actor_name: 'Tony', details: { from: '2026-08-01', to: '2026-09-30', extended: true } }), 'from 08/01/2026');
has('shortening reads as changed, not extended', sandbox.quoteEventText({ event_type: 'valid_until_changed', actor_name: 'Tony', details: { from: '2026-09-30', to: '2026-08-01', extended: false } }), 'changed to');

section('Editing no longer voids, so the page guards the total instead');
has('the approve dialog asks for their PO number', String(sandbox.qaOpenApprove), 'qa-po');
has('and for a note', String(sandbox.qaOpenApprove), 'qa-anote');
has('the PO field explains why it is worth filling in', String(sandbox.qaOpenApprove), 'on the invoice');
has('the submit sends the fingerprint it rendered', String(sandbox.qaSubmitApprove), 'seen_version');
has('and reads it off the payload the page drew', String(sandbox.qaSubmitApprove), 'qaData && qaData.version');
has('a changed quote reloads instead of approving', String(sandbox.qaSubmitApprove), 'quote_changed');
has('and says so in the customer\'s words', String(sandbox.qaSubmitApprove), 'updated since you opened it');
has('the receipt shows their PO back to them', String(sandbox.qaReceiptHtml), 'customer_po_number');

section('The customer page offers approve or ask');
ok('the decline dialog is gone from the build', typeof sandbox.qaOpenDecline === 'undefined');
ok('approve is still there', typeof sandbox.qaOpenApprove === 'function');
ok('and ask a question is still there', typeof sandbox.qaOpenMessage === 'function');

console.log('\n' + '-'.repeat(60));
console.log(PASS + ' passed, ' + FAIL + ' failed');
if (FAILURES.length) { console.log('\nFailures:'); FAILURES.forEach(function (f) { console.log('  - ' + f); }); }
process.exit(FAIL ? 1 : 0);
