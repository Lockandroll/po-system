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
const HELPERS = ['escHtml', 'formatDate', 'formatDateTime', 'timeAgo', 'resolveTokens', 'quoteRowActivityHtml'].map(sliceFunction).join('\n');

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
b = sandbox.quoteStatusBannerHtml({ status: 'expired' });
has('expired banner tells you what to do', b, 're-send');
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

console.log('\n' + '-'.repeat(60));
console.log(PASS + ' passed, ' + FAIL + ' failed');
if (FAILURES.length) { console.log('\nFailures:'); FAILURES.forEach(function (f) { console.log('  - ' + f); }); }
process.exit(FAIL ? 1 : 0);
