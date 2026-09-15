// Licensing & the shared register: browser rendering tests.
//
// public/js/licenses.js is a classic script, so it is evaluated inside a jsdom
// window with the handful of globals app.js normally provides (api, escHtml,
// can, showToast, formatDate, copyToClipboard, novaConfirm, icons, state)
// replaced by stubs. Every API call is answered from fixtures, so nothing here
// touches a network or a DB.
//
//   node test-licensing-dom.js
//
// The assertions that matter most are the ones about what a VIEW-ONLY user
// sees: no password, no answers, no editor. The server already strips those
// (test-licensing-ledger.js proves it), and this file proves the screen does
// not invent an edit path the server would refuse.
//
// House style: string concatenation only, no template literals.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
     'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function has(name, hay, needle) { ok(name, String(hay).indexOf(needle) !== -1, 'missing: ' + needle); }
function hasnt(name, hay, needle) { ok(name, String(hay).indexOf(needle) === -1, 'unexpectedly present: ' + needle); }

function licenseFixture(over) {
  return Object.assign({
    id: 1, name: 'Birmingham Occupational Tax', kind: 'occupational_tax',
    authority: 'City of Birmingham Revenue Department', license_number: 'BHM-99123',
    city_code: 'BHM', jurisdiction: 'Birmingham, AL',
    website: 'https://birminghamal.gov', username: 'lockandroll', password: 'hunter2',
    security_questions: [{ q: 'First street', a: 'Elm' }],
    issued_on: '2026-01-02', expires_on: '2026-10-01', renewal_interval: 'annual',
    renewal_fee: 340, responsible_user_id: 3, responsible_name: 'Bridget Mier',
    restricted_to: null, notes: 'They always ask for the prior-year return.', active: true,
    ledger_total: 1234.56, ledger_count: 3, last_entry_on: '2026-03-12',
    status: { key: 'expiring', label: 'Renew soon', tone: 'amber', note: 'in 17 days' }
  }, over || {});
}

var FIXTURES = {};

function resetFixtures() {
  FIXTURES = {
    '/licenses': {
      can_manage: true,
      expiring_days: 60,
      licenses: [
        licenseFixture(),
        licenseFixture({ id: 2, name: 'Alabama Sales Tax', kind: 'sales_tax',
          authority: 'Alabama Department of Revenue', license_number: 'AL-55512',
          jurisdiction: 'Alabama', expires_on: '2027-06-30', renewal_fee: null,
          ledger_total: 0, ledger_count: 0, last_entry_on: null, responsible_name: null,
          security_questions: [],
          status: { key: 'current', label: 'Current', tone: 'green', note: '' } }),
        licenseFixture({ id: 3, name: 'Savannah Business License', kind: 'business_license',
          authority: 'City of Savannah', license_number: 'SAV-201', jurisdiction: 'Savannah, GA',
          expires_on: '2026-08-01', renewal_fee: 210, ledger_total: 210, ledger_count: 1,
          last_entry_on: '2025-08-04', security_questions: [],
          status: { key: 'expired', label: 'Expired', tone: 'red', note: '44 days ago' } }),
        licenseFixture({ id: 4, name: 'Old Alarm Permit', kind: 'alarm', active: false,
          authority: 'Jefferson County', license_number: 'JC-7', jurisdiction: 'Jefferson County, AL',
          expires_on: null, renewal_fee: null, ledger_total: 0, ledger_count: 0,
          last_entry_on: null, security_questions: [],
          status: { key: 'inactive', label: 'Inactive', tone: 'grey', note: '' } })
      ]
    },
    '/licenses/pickable-users': [
      { id: 3, name: 'Bridget Mier', role: 'manager' },
      { id: 4, name: 'Russ Beechly', role: 'admin' }
    ],
    '/cities': [{ code: 'BHM', name: 'Birmingham' }, { code: 'SAV', name: 'Savannah' }],
    '/ledger/license/1': {
      subject: { type: 'license', id: 1, name: 'Birmingham Occupational Tax' },
      can_manage: true,
      kinds: ['payment', 'filing', 'renewal', 'credit', 'refund', 'note'],
      methods: ['card', 'ach', 'check', 'cash', 'online', 'auto_draft', 'other'],
      totals: { paid: 1234.56, credited: 100, net: 1134.56, with_amount: 2 },
      entries: [
        { id: 31, entry_date: '2026-04-02', kind: 'filing', amount: null,
          reason: 'annual return filed, nothing owed', method: null, reference: null,
          period_label: '2026', notes: null, created_by_name: 'Tony McKeon' },
        { id: 30, entry_date: '2026-04-01', kind: 'credit', amount: 100,
          reason: 'overpayment returned', method: 'check', reference: '4471',
          period_label: '2026', notes: null, created_by_name: 'Tony McKeon' },
        { id: 29, entry_date: '2026-03-12', kind: 'payment', amount: 1234.56,
          reason: '2026 occupational tax', method: 'ach', reference: '88213',
          period_label: '2026', notes: 'Portal was down, filed by phone.',
          created_by_name: 'Bridget Mier' }
      ]
    },
    '/ledger/account/9': {
      subject: { type: 'account', id: 9, name: 'Amazon Business' },
      can_manage: false,
      kinds: ['payment'], methods: ['card'],
      totals: { paid: 0, credited: 0, net: 0, with_amount: 0 },
      entries: []
    }
  };
}

function makeWindow(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html><body><div id="content"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://nova.test/' });
  const w = dom.window;
  w.apiCalls = [];
  w.toasts = [];
  w.confirmed = true;
  w.api = function (method, pathname, body) {
    w.apiCalls.push([method, pathname, body]);
    var key = pathname.split('?')[0];
    if (method === 'GET' && FIXTURES[key]) return Promise.resolve(JSON.parse(JSON.stringify(FIXTURES[key])));
    if (method !== 'GET') return Promise.resolve({ success: true });
    return Promise.resolve({});
  };
  w.escHtml = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  w.can = function (p) { return opts.can ? opts.can(p) : true; };
  w.showToast = function (m, t) { w.toasts.push([m, t]); };
  w.novaConfirm = function () { return Promise.resolve(w.confirmed); };
  w.copyToClipboard = function (t) { w.copied = t; };
  w.roleLabel = function (r) { return r; };
  w.vendorOpenSite = function (u, p) { w.opened = [u, p]; };
  w.icons = { trash: '<svg/>' };
  w.state = { currentView: 'licenses' };
  w.formatDate = function (d) {
    if (!d) return '—';
    var m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(d);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(m[2], 10) - 1] +
      ' ' + parseInt(m[3], 10) + ', ' + m[1];
  };
  w.eval(fs.readFileSync(path.join(__dirname, 'public', 'js', 'licenses.js'), 'utf8'));
  return w;
}

async function main() {
  console.log('Licensing DOM tests');
  console.log('-------------------');
  resetFixtures();

  // ---- the licensing table -----------------------------------------------
  var w = makeWindow();
  var el = w.document.getElementById('content');
  await w.renderLicenses(el);
  var html = el.innerHTML;

  has('page title renders', html, 'Licensing &amp; Compliance');
  eq('every license gets a row', el.querySelectorAll('tbody tr').length, 4);
  has('the occupational tax is named', html, 'Birmingham Occupational Tax');
  has('its type is spelled out, not left as a slug', html, 'Occupational tax');
  hasnt('the raw slug never reaches the screen', html, 'occupational_tax<');
  has('the issuing authority is shown', html, 'City of Birmingham Revenue Department');
  has('the license number is shown', html, 'BHM-99123');
  has('an expiring license gets the amber pill', html, 'badge-submitted');
  has('an expired license gets the red pill', html, 'badge-rejected');
  has('a current license gets the green pill', html, 'badge-approved');
  has('an inactive license gets the grey pill', html, 'badge-inactive');
  has('the status note is carried through', html, 'in 17 days');
  has('the renewal cadence is shown', html, 'Annually');
  has('an inactive license is greyed out', html, 'user-row-inactive');
  has('the person who owns it is shown', html, 'Bridget Mier');

  // The banner counts what needs a human, from the same statuses the pills use.
  has('the banner counts what needs attention', html, '2 licenses need attention');
  has('and says how many expired', html, '1 expired');
  has('and how many are due soon', html, '1 due within 60 days');

  // The register cell is the point of the exercise.
  has('the register cell shows the running total', html, '$1,234.56');
  // jsdom serializes innerHTML with the entity already decoded, so assert on
  // the character the browser would actually paint.
  has('and how many entries there are', html, '\u00b7 3');
  has('and when the last one was', html, 'last Mar 12, 2026');
  has('a license with no entries still offers the register', html, '>Open<');
  has('the register button calls into the shared popup', html, "openLedger('license',1,");

  // A manager gets the editing affordances.
  has('a manager is offered the add button', html, '+ Add License');
  has('and an edit button per row', html, 'showLicenseModal(1)');
  has('and a delete button', html, 'deleteLicense(1)');

  // Search
  w.licensesFilter('savannah');
  eq('search matches the license name', el.querySelectorAll('tbody tr').length, 1);
  w.licensesFilter('alabama department');
  eq('search also matches the authority', el.querySelectorAll('tbody tr').length, 1);
  w.licensesFilter('AL-55512');
  eq('and the license number', el.querySelectorAll('tbody tr').length, 1);
  w.licensesFilter('zzzz');
  has('an empty result says so', el.innerHTML, 'No licenses found');
  w.licensesFilter('');
  eq('clearing the search brings them all back', el.querySelectorAll('tbody tr').length, 4);

  // ---- a view-only user ---------------------------------------------------
  resetFixtures();
  FIXTURES['/licenses'].can_manage = false;
  FIXTURES['/licenses'].licenses.forEach(function (l) {
    // Exactly what the server sends a view-only caller: credentials absent,
    // not merely hidden.
    l.username = null; l.password = null; l.security_questions = [];
  });
  var wv = makeWindow({ can: function (p) { return p === 'view_licenses'; } });
  var elv = wv.document.getElementById('content');
  await wv.renderLicenses(elv);
  var hv = elv.innerHTML;
  eq('a view-only user still sees every license', elv.querySelectorAll('tbody tr').length, 4);
  hasnt('but is not offered the add button', hv, '+ Add License');
  hasnt('nor an edit button', hv, 'showLicenseModal(');
  hasnt('nor a delete button', hv, 'deleteLicense(');
  hasnt('and no password reaches the page', hv, 'hunter2');
  hasnt('and no security answer reaches the page', hv, 'Elm');
  hasnt('and no Q&A button is offered', hv, 'licenseViewQuestions(');
  has('the register is still readable', hv, "openLedger('license',1,");
  eq('a view-only user is not asked for the user picker', wv.apiCalls.filter(function (c) {
    return c[1] === '/licenses/pickable-users';
  }).length, 0);

  // Somebody with neither permission gets nothing at all.
  var wn = makeWindow({ can: function () { return false; } });
  await wn.renderLicenses(wn.document.getElementById('content'));
  has('no permission means access denied', wn.document.getElementById('content').innerHTML, 'Access denied');

  // ---- the register popup -------------------------------------------------
  resetFixtures();
  w = makeWindow();
  await w.openLedger('license', 1, 'Birmingham Occupational Tax');
  var overlay = w.document.getElementById('ledger-overlay');
  ok('the register opens', !!overlay);
  var lh = overlay.innerHTML;

  has('the register names its subject', lh, 'Birmingham Occupational Tax');
  eq('every entry gets a row', overlay.querySelectorAll('tbody tr').length, 3);
  has('the paid total is shown', lh, '$1,234.56');
  has('the credited total is shown separately', lh, '$100.00');
  has('and the net', lh, '$1,134.56');
  has('a payment reads as what it was for', lh, '2026 occupational tax');
  has('a credit is drawn as money coming back', lh, '-$100.00');
  // The filing is the newest row, so it is the first one. Its amount cell must
  // be a dash: a zero there would read as "we paid nothing", which is a
  // different claim from "no money was involved".
  var filingAmount = overlay.querySelectorAll('tbody tr')[0].children[2].textContent.trim();
  eq('a moneyless filing shows a dash, not $0.00', filingAmount, '\u2014');
  has('the confirmation number is kept', lh, '88213');
  has('the method is spelled out', lh, 'ACH');
  has('the note rides under the reason', lh, 'Portal was down, filed by phone.');
  has('the writer is credited', lh, 'Bridget Mier');
  has('newest entry is first', lh.indexOf('Apr 2, 2026') < lh.indexOf('Mar 12, 2026') ? 'yes' : 'no', 'yes');

  // The editor
  has('a manager is offered the add button', lh, 'ledgerNew()');
  hasnt('but the form is not in the way until they ask', lh, 'id="lg-date"');
  w.ledgerNew();
  var lh2 = w.document.getElementById('ledger-overlay').innerHTML;
  has('asking opens the form', lh2, 'id="lg-date"');
  has('with today prefilled', lh2, new Date().getFullYear() + '-');
  has('the type list is offered', lh2, 'Payment');
  has('and the method list', lh2, 'Auto-draft');
  has('the button says add, not save', lh2, '>Add entry<');

  w.ledgerEdit(29);
  var lh3 = w.document.getElementById('ledger-overlay').innerHTML;
  has('editing an entry loads its date', lh3, 'value="2026-03-12"');
  eq('and its amount', w.document.getElementById('lg-amount').value, '1234.56');
  eq('and its reason', w.document.getElementById('lg-reason').value, '2026 occupational tax');
  eq('and its method', w.document.getElementById('lg-method').value, 'ach');
  has('the button now says save', lh3, '>Save changes<');

  // Saving an edit hits the entry endpoint, not the subject one -- the server
  // re-checks the subject from the entry, so getting this wrong is a 404 the
  // user would read as "it vanished".
  w.apiCalls = [];
  await w.ledgerSave();
  var putCall = w.apiCalls.filter(function (c) { return c[0] === 'PUT'; })[0];
  ok('an edit PUTs to the entry', !!putCall && putCall[1] === '/ledger/entry/29', putCall && putCall[1]);
  eq('and sends the amount as typed', putCall[2].amount, '1234.56');

  w.ledgerNew();
  w.document.getElementById('lg-amount').value = '';
  w.document.getElementById('lg-reason').value = 'filed, nothing owed';
  w.apiCalls = [];
  await w.ledgerSave();
  var postCall = w.apiCalls.filter(function (c) { return c[0] === 'POST'; })[0];
  ok('a new entry POSTs to the subject', !!postCall && postCall[1] === '/ledger/license/1', postCall && postCall[1]);
  eq('an empty amount is sent as null, never as zero', postCall[2].amount, null);

  // A date is the one thing the register cannot do without.
  w.ledgerNew();
  w.document.getElementById('lg-date').value = '';
  w.apiCalls = [];
  await w.ledgerSave();
  eq('a missing date is caught before the request', w.apiCalls.filter(function (c) { return c[0] === 'POST'; }).length, 0);
  has('and says so on screen', w.document.getElementById('ledger-msg').innerHTML, 'Pick a date');

  // ---- a read-only register -----------------------------------------------
  var wr = makeWindow();
  await wr.openLedger('account', 9, 'Amazon Business');
  var ro = wr.document.getElementById('ledger-overlay').innerHTML;
  has('a read-only register still opens', ro, 'Amazon Business');
  hasnt('but offers no add button', ro, 'ledgerNew()');
  hasnt('no edit button', ro, 'ledgerEdit(');
  hasnt('and no delete button', ro, 'ledgerDelete(');
  has('an empty register says so', ro, 'Nothing recorded yet');
  hasnt('and does not invite a read-only user to add the first one', ro, 'Add the first entry');

  // ---- the license editor -------------------------------------------------
  resetFixtures();
  w = makeWindow();
  await w.renderLicenses(w.document.getElementById('content'));
  w.showLicenseModal(1);
  var modal = w.document.getElementById('license-modal-overlay');
  ok('the editor opens', !!modal);
  eq('the name is prefilled', w.document.getElementById('lm-name').value, 'Birmingham Occupational Tax');
  eq('the type is preselected', w.document.getElementById('lm-kind').value, 'occupational_tax');
  eq('the authority is prefilled', w.document.getElementById('lm-authority').value, 'City of Birmingham Revenue Department');
  eq('the renewal date is prefilled', w.document.getElementById('lm-expires').value, '2026-10-01');
  eq('the cadence is preselected', w.document.getElementById('lm-interval').value, 'annual');
  eq('the fee is prefilled', w.document.getElementById('lm-fee').value, '340');
  eq('the owner is preselected', w.document.getElementById('lm-owner').value, '3');
  eq('the password starts masked', w.document.getElementById('lm-password').type, 'password');
  eq('the existing security question is loaded', w.document.querySelector('.lm-sq-q').value, 'First street');
  eq('so is its answer', w.document.querySelector('.lm-sq-a').value, 'Elm');
  eq('the answer starts masked', w.document.querySelector('.lm-sq-a').type, 'password');
  eq('active is ticked', w.document.getElementById('lm-active').checked, true);
  eq('restrict starts unticked for an unrestricted license', w.document.getElementById('lm-restrict').checked, false);

  w.apiCalls = [];
  await w.saveLicense(1);
  var put = w.apiCalls.filter(function (c) { return c[0] === 'PUT'; })[0];
  ok('saving PUTs to the license', !!put && put[1] === '/licenses/1', put && put[1]);
  eq('the security questions ride along, so clearing them all really clears them',
     put[2].security_questions, [{ q: 'First street', a: 'Elm' }]);
  eq('the password is always sent from this modal', put[2].password, 'hunter2');
  eq('an unticked restrict box sends null, not an empty list', put[2].restricted_to, null);
  eq('the fee is sent as typed and parsed server-side', put[2].renewal_fee, '340');

  // An inactive license round-trips its flag rather than silently reviving.
  w.showLicenseModal(4);
  eq('an inactive license opens unticked', w.document.getElementById('lm-active').checked, false);
  w.apiCalls = [];
  await w.saveLicense(4);
  eq('and saves as inactive', w.apiCalls.filter(function (c) { return c[0] === 'PUT'; })[0][2].active, false);

  // Adding a license sends no id.
  w.showLicenseModal();
  eq('a new license starts blank', w.document.getElementById('lm-name').value, '');
  eq('and defaults to active', w.document.getElementById('lm-active').checked, true);
  w.document.getElementById('lm-name').value = 'Tallahassee Business Tax';
  w.apiCalls = [];
  await w.saveLicense(null);
  var post = w.apiCalls.filter(function (c) { return c[0] === 'POST'; })[0];
  ok('a new license POSTs', !!post && post[1] === '/licenses', post && post[1]);
  eq('with the typed name', post[2].name, 'Tallahassee Business Tax');

  // A nameless license never reaches the server.
  w.showLicenseModal();
  w.apiCalls = [];
  await w.saveLicense(null);
  eq('a nameless license is caught in the browser', w.apiCalls.filter(function (c) { return c[0] === 'POST'; }).length, 0);
  has('and says why', w.document.getElementById('license-modal-error').innerHTML, 'License name is required');

  // ---- security questions popup -------------------------------------------
  w = makeWindow();
  await w.renderLicenses(w.document.getElementById('content'));
  w.licenseViewQuestions(1);
  var sq = w.document.getElementById('license-sq-overlay');
  ok('the Q&A popup opens', !!sq);
  has('the question is readable', sq.innerHTML, 'First street');
  hasnt('the answer starts masked', sq.innerHTML, '>Elm<');
  var btn = { textContent: 'Show' };
  w.licenseSqReveal(0, btn);
  eq('revealing shows the answer', w.document.getElementById('lsq-0').textContent, 'Elm');
  w.licenseSqReveal(0, { textContent: 'Hide' });
  eq('hiding masks it again', w.document.getElementById('lsq-0').textContent, '••••••••');
  w.licenseSqCopy(0, null);
  eq('copy takes the answer', w.copied, 'Elm');
  w.licenseCloseQuestions();
  ok('closing removes the popup', !w.document.getElementById('license-sq-overlay'));

  // ---- deleting warns about the history it takes with it ------------------
  w = makeWindow();
  await w.renderLicenses(w.document.getElementById('content'));
  w.confirmed = false;
  w.apiCalls = [];
  await w.deleteLicense(1);
  eq('a declined confirm deletes nothing', w.apiCalls.filter(function (c) { return c[0] === 'DELETE'; }).length, 0);
  w.confirmed = true;
  await w.deleteLicense(1);
  eq('a confirmed delete goes through', w.apiCalls.filter(function (c) { return c[0] === 'DELETE'; })[0][1], '/licenses/1');

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
