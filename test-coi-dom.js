// Certificates of insurance: browser rendering tests.
//
// public/js/coi.js is a classic script, so it is evaluated inside a jsdom
// window with the handful of globals app.js normally provides (api, escHtml,
// can, showToast, navigate, invDownloadBase64) replaced by stubs. Every API
// call is answered from fixtures, so nothing here touches a network or a DB.
//
//   node test-coi-dom.js
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

const LIMIT_FIELDS = require('./utils/coi').LIMIT_FIELDS;

const FIXTURES = {
  '/coi': {
    counts: { current: 2, expiring: 1, mismatch: 1, expired: 1, missing: 1, not_required: 1, attention: 4 },
    policy: { policy_effective: '2026-03-01', policy_expires: '2027-03-01', carrier: 'Tidewater Mutual', agent_email: 'dana@example.com' },
    open_cycle: { id: 7, name: '2026-2027 Renewal' },
    storage_ready: true,
    can_manage: true,
    accounts: [
      { account_id: 1, account_name: 'Geico ERS', holder_name: 'GEICO Insurance Agency, Inc.', coi_required: true,
        submit_method: 'email', expires_on: '2027-03-01', status: { key: 'current', label: 'Current', tone: 'green', note: '' } },
      { account_id: 2, account_name: 'Agero / Swoop', holder_name: 'Agero, Inc.', coi_required: true,
        submit_method: 'portal', expires_on: '2026-09-24', status: { key: 'expiring', label: 'Expiring', tone: 'amber', note: 'in 31 days' } },
      { account_id: 3, account_name: 'Allstate Roadside', holder_name: 'Allstate Roadside Services', coi_required: true,
        submit_method: 'email', expires_on: '2027-03-01', status: { key: 'mismatch', label: 'Below requirement', tone: 'amber', note: 'Automobile - combined single limit 500,000 vs 1,000,000 required' } },
      { account_id: 4, account_name: 'Harbor Point Apartments', holder_name: 'Harbor Point Apartments LLC', coi_required: true,
        submit_method: 'email', expires_on: '2026-06-30', status: { key: 'expired', label: 'Expired', tone: 'red', note: 'Expired 55 days ago' } },
      { account_id: 5, account_name: 'City of Norfolk', holder_name: 'City of Norfolk', coi_required: true,
        submit_method: 'mail', expires_on: null, status: { key: 'missing', label: 'Missing', tone: 'red', note: 'Never issued' } },
      { account_id: 6, account_name: 'Pop-A-Lock Corporate', holder_name: null, coi_required: false,
        submit_method: 'email', expires_on: null, status: { key: 'not_required', label: 'Not required', tone: 'grey', note: '' } }
    ]
  },
  '/coi/account/3': {
    account: { id: 3, name: 'Allstate Roadside', city_code: 'VAB' },
    requirements: {
      account_id: 3, coi_required: true, holder_name: 'Allstate Roadside Services',
      holder_address: '2775 Sanders Rd\nNorthbrook, IL 60062',
      additional_insured: [{ name: 'Allstate Insurance Company', relationship: 'Parent' }],
      ai_wording: 'Allstate and its subsidiaries named as additional insured.',
      waiver_gl: true, waiver_auto: true, waiver_wc: false, primary_noncontrib: true, req_wc_statutory: false,
      cancel_notice_days: 30, named_insured: 'Lock and Roll LLC', off_cycle: false,
      submit_method: 'email', submit_emails: 'certs@example.com', submit_portal_url: null,
      submit_notes: 'Reference vendor ID 4471', source_note: 'contract p.12',
      req_gl_occurrence: '1000000', req_gl_aggregate: '2000000', req_auto_csl: '1000000', req_garagekeepers: '100000'
    },
    certificates: [
      { id: 91, file_name: '2026-COI-Allstate.pdf', effective_on: '2026-03-01', expires_on: '2027-03-01',
        superseded: false, sent_at: null, carrier: 'Tidewater Mutual',
        lim_gl_occurrence: '1000000', lim_gl_aggregate: '2000000', lim_auto_csl: '500000', lim_garagekeepers: null,
        has_ai: true, has_waiver: true, has_pnc: false,
        mismatch: [{ field: 'auto_csl', label: 'Automobile - combined single limit', required: 1000000, actual: 500000, kind: 'limit' },
                   { field: 'garagekeepers', label: 'Garagekeepers', required: 100000, actual: null, kind: 'limit' },
                   { field: 'has_pnc', label: 'Primary & non-contributory', required: true, actual: false, kind: 'flag' }] },
      { id: 90, file_name: '2025-COI-Allstate.pdf', effective_on: '2025-03-01', expires_on: '2026-03-01',
        superseded: true, sent_at: '2025-03-06', mismatch: null }
    ],
    current_id: 91,
    status: { key: 'mismatch', label: 'Below requirement', tone: 'amber', note: 'Automobile - combined single limit 500,000 vs 1,000,000 required (+2 more)' },
    limit_fields: LIMIT_FIELDS,
    storage_ready: true,
    can_manage: true
  },
  '/account-docs/account/3': {
    documents: [
      { id: 5, kind: 'agreement', title: 'Master services agreement', file_name: 'allstate-msa.pdf',
        effective_on: '2026-01-01', expires_on: null, notes: 'Refuses 1099 work' },
      { id: 6, kind: 'w9', title: null, file_name: 'w9-2026.pdf', effective_on: null, expires_on: null, notes: null }
    ],
    can_manage: true, storage_ready: true
  },
  '/coi/cycles/7': {
    cycle: { id: 7, name: '2026-2027 Renewal', policy_effective: '2026-03-01', policy_expires: '2027-03-01',
      status: 'open', created_at: '2026-02-24', created_by_name: 'Tony McKeon', packet_generated_at: '2026-02-24' },
    items: [
      { id: 1, account_id: 1, account_name: 'Geico ERS', status: 'confirmed', confirmed_at: '2026-03-04', submit_method: 'email' },
      { id: 2, account_id: 2, account_name: 'Agero / Swoop', status: 'requested', requested_at: '2026-02-26', submit_method: 'portal' },
      { id: 3, account_id: 3, account_name: 'Allstate Roadside', status: 'received', updated_at: '2026-03-03', submit_method: 'email' },
      { id: 4, account_id: 4, account_name: 'Harbor Point Apartments', status: 'sent', sent_at: '2026-03-04', submit_method: 'email' },
      { id: 5, account_id: 5, account_name: 'City of Norfolk', status: 'needed', submit_method: 'mail' }
    ],
    off_cycle: [{ account_id: 9, account_name: 'Norfolk Naval Housing', expires_on: '2026-11-01' }],
    policy: { agent_email: 'dana@example.com' },
    can_manage: true
  }
};

function makeWindow() {
  const dom = new JSDOM('<!doctype html><html><body><div id="content"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://nova.test/' });
  const w = dom.window;
  w.apiCalls = [];
  w.toasts = [];
  w.navigations = [];
  w.api = function (method, path, body) {
    w.apiCalls.push([method, path, body]);
    var key = path.split('?')[0];
    if (FIXTURES[key]) return Promise.resolve(JSON.parse(JSON.stringify(FIXTURES[key])));
    return Promise.resolve({ success: true });
  };
  w.escHtml = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  w.can = function () { return true; };
  w.showToast = function (m, t) { w.toasts.push([m, t]); };
  w.navigate = function (v, p) { w.navigations.push([v, p]); };
  w.invDownloadBase64 = function () { w.downloaded = true; };
  w.confirm = function () { return true; };
  w.eval(fs.readFileSync(path.join(__dirname, 'public', 'js', 'coi.js'), 'utf8'));
  return w;
}

async function main() {
  console.log('COI DOM tests');
  console.log('-------------');

  // ---- screen 1 -----------------------------------------------------------
  var w = makeWindow();
  var el = w.document.getElementById('content');
  await w.renderCoi(el);
  var html = el.innerHTML;

  has('page title renders', html, 'Certificates of Insurance');
  has('policy line shows the year', html, '03/01/2026');
  has('carrier is shown', html, 'Tidewater Mutual');
  has('the open cycle offers a way in', html, '2026-2027 Renewal');
  hasnt('and does not also offer to start another', html, 'Start renewal cycle');
  eq('six stat cards', el.querySelectorAll('.stat-card').length, 6);
  eq('all six accounts listed', el.querySelectorAll('tbody tr').length, 6);
  has('a current account gets the green pill', html, 'badge-approved');
  has('an expired account gets the red pill', html, 'badge-rejected');
  has('a mismatch is spelled out in the note column', html, '500,000 vs 1,000,000 required');
  has('a portal account says Portal', html, 'Portal');
  has('a mail account says Mail', html, 'Mail');

  // Filtering
  w.coiSetStatus('attention');
  eq('the attention filter keeps the four that need one', el.querySelectorAll('tbody tr').length, 4);
  hasnt('and drops the healthy account', el.innerHTML, 'Geico ERS');
  w.coiSetStatus('missing');
  eq('a single-status filter narrows further', el.querySelectorAll('tbody tr').length, 1);
  has('to the right account', el.innerHTML, 'City of Norfolk');
  w.coiSetStatus('');
  w.coiSetQuery('harbor');
  eq('search matches on account name', el.querySelectorAll('tbody tr').length, 1);
  w.coiSetQuery('agero, inc');
  eq('search also matches the certificate holder', el.querySelectorAll('tbody tr').length, 1);
  w.coiSetQuery('zzzz');
  has('an empty result says so', el.innerHTML, 'No accounts match');
  w.coiSetQuery('');

  // Storage warning
  var w2 = makeWindow();
  FIXTURES['/coi'].storage_ready = false;
  await w2.renderCoi(w2.document.getElementById('content'));
  has('an unconfigured bucket is called out', w2.document.getElementById('content').innerHTML, 'File storage is not configured');
  FIXTURES['/coi'].storage_ready = true;

  // ---- screen 2 -----------------------------------------------------------
  w = makeWindow();
  el = w.document.getElementById('content');
  await w.renderCoiAccount(el, 3);
  html = el.innerHTML;

  has('account name is the title', html, 'Allstate Roadside');
  has('a short certificate shows the red banner', html, 'does not meet what the account requires');
  has('the banner names the shortfall', html, '500,000 against 1,000,000 required');
  has('and the missing box', html, 'Primary &amp; non-contributory is required');
  eq('holder name is prefilled', w.document.getElementById('coi-holder-name').value, 'Allstate Roadside Services');
  has('holder address is prefilled', w.document.getElementById('coi-holder-addr').value, 'Northbrook, IL 60062');
  eq('the additional insured row is prefilled', w.document.querySelector('.coi-ai-name').value, 'Allstate Insurance Company');
  eq('COI required is ticked', w.document.getElementById('coi-required').checked, true);
  eq('waiver GL is ticked', w.document.getElementById('coi-w-gl').checked, true);
  eq('waiver WC is not', w.document.getElementById('coi-w-wc').checked, false);
  eq('cancellation notice is prefilled', w.document.getElementById('coi-notice').value, '30');
  eq('a required limit is formatted with commas', w.document.getElementById('coi-req-auto_csl').value, '1,000,000');
  eq('an unset limit is blank, not zero', w.document.getElementById('coi-req-umbrella_each').value, '');
  eq('every limit line has an input', w.document.querySelectorAll('[id^="coi-req-"]').length, LIMIT_FIELDS.length);
  eq('send-to is prefilled', w.document.getElementById('coi-emails').value, 'certs@example.com');

  // Certificate history
  var histRows = el.querySelectorAll('.card table tbody tr');
  has('the current certificate is listed', html, '2026-COI-Allstate.pdf');
  has('the superseded one is too', html, '2025-COI-Allstate.pdf');
  has('the current short certificate reads as below requirement', html, '>Below requirement<');
  has('the old one reads as superseded', html, '>Superseded<');

  // Agreements
  has('the agreements card is on the same page', html, 'Agreements &amp; paperwork');
  has('an agreement is listed by title', html, 'Master services agreement');
  has('its note is visible without opening the file', html, 'Refuses 1099 work');
  has('a document with no title falls back to the file name', html, 'w9-2026.pdf');
  has('the type pill renders', html, '>W-9<');

  // Editing round-trip
  w.document.getElementById('coi-holder-name').value = 'Allstate Roadside Services LLC';
  w.document.getElementById('coi-req-umbrella_each').value = '5,000,000';
  w.document.getElementById('coi-w-wc').checked = true;
  w.coiAddAiRow();
  var names = w.document.querySelectorAll('.coi-ai-name');
  names[names.length - 1].value = 'Allstate Roadside Services';
  var payload = w.coiCollectRequirements();
  eq('the edited holder name is collected', payload.holder_name, 'Allstate Roadside Services LLC');
  eq('a limit typed with commas is sent as a number', payload.req_umbrella_each, 5000000);
  eq('the newly ticked waiver is collected', payload.waiver_wc, true);
  eq('both additional insured rows are collected', payload.additional_insured.length, 2);
  eq('an empty additional-insured row is dropped', (function () {
    w.coiAddAiRow(); return w.coiCollectRequirements().additional_insured.length;
  })(), 2);
  eq('unset limits are sent as null, not 0', payload.req_el_disease_policy, null);

  // ---- the upload dialog --------------------------------------------------
  w.coiUploadModal(3, 91);
  var modal = w.document.querySelector('.modal-overlay');
  ok('the dialog opened', !!modal);
  eq('the stored expiry is prefilled', w.document.getElementById('coi-exp').value, '2027-03-01');
  eq('the stored limit is prefilled', w.document.getElementById('coi-lim-auto_csl').value, '500,000');
  has('the preview names the account', modal.innerHTML, 'does not meet what Allstate Roadside requires');
  has('the preview names the low limit', modal.innerHTML, 'Automobile - combined single limit 500,000 vs 1,000,000 required');
  has('the preview says it will still be saved', modal.innerHTML, 'It will still be saved');
  var marks = modal.querySelectorAll('.coi-mm-mark');
  ok('a satisfied line gets a tick', modal.innerHTML.indexOf('&#10003;') !== -1 || modal.innerHTML.indexOf('✓') !== -1);

  // Fix the limit and the banner should clear once every line passes.
  w.document.getElementById('coi-lim-auto_csl').value = '1000000';
  w.document.getElementById('coi-lim-garagekeepers').value = '100000';
  w.document.getElementById('coi-has-pnc').checked = true;
  w.coiPreviewMismatch();
  eq('a compliant certificate clears the preview banner',
     w.document.getElementById('coi-mm-banner').innerHTML.trim(), '');
  var certPayload = w.coiCertPayload();
  eq('the corrected limit is collected', certPayload.lim_auto_csl, 1000000);
  eq('the box is collected', certPayload.has_pnc, true);

  // A save with no expiry is refused before anything is sent.
  w.document.getElementById('coi-exp').value = '';
  var before = w.apiCalls.length;
  await w.coiSaveCertificate({ disabled: false, textContent: '' });
  eq('saving without an expiry sends nothing', w.apiCalls.length, before);
  eq('and says why', w.toasts[w.toasts.length - 1][0], 'Enter the expiration date.');

  // A portal account is offered the portal, not an email form.
  var w3 = makeWindow();
  FIXTURES['/coi/account/3'].requirements.submit_method = 'portal';
  FIXTURES['/coi/account/3'].requirements.submit_portal_url = 'https://compliance.example.com';
  await w3.renderCoiAccount(w3.document.getElementById('content'), 3);
  w3.coiEmailModal(91);
  var pm = w3.document.querySelector('.modal-overlay').innerHTML;
  has('a portal account gets the portal dialog', pm, 'Submit through the portal');
  has('with the portal link', pm, 'https://compliance.example.com');
  has('and a way to record it went', pm, 'Mark as submitted');
  hasnt('and no email form', pm, 'coi-email-to');
  FIXTURES['/coi/account/3'].requirements.submit_method = 'email';
  FIXTURES['/coi/account/3'].requirements.submit_portal_url = null;

  // ---- screen 3 -----------------------------------------------------------
  w = makeWindow();
  el = w.document.getElementById('content');
  await w.renderCoiCycle(el, 7);
  html = el.innerHTML;

  has('cycle name is the title', html, '2026-2027 Renewal');
  has('progress counts the confirmed', html, '1 of 5 confirmed');
  has('and what is still with the agent', html, '2 still waiting on the agent');
  has('the packet stamp shows', html, 'packet generated 02/24/2026');
  eq('every account has a checklist row', el.querySelectorAll('.card table tbody tr').length, 5 + 1);
  has('a needed row offers to mark it requested', html, 'Mark requested');
  has('a requested row sends you to upload', html, 'Upload certificate');
  has('a received row sends you to send it', html, 'Open to send');
  has('a sent row offers to confirm', html, 'Mark confirmed');
  has('a confirmed row is done', html, '>Done<');
  has('the off-cycle accounts are listed apart', html, 'Off-cycle accounts');
  has('with the account on it', html, 'Norfolk Naval Housing');
  has('and a note that they are not counted', html, 'not counted above');

  // The packet download goes through an authenticated call, never a URL token.
  await w.coiOpenPacket(7);
  ok('the packet is fetched with the api helper', w.apiCalls.some(function (c) { return c[1] === '/coi/cycles/7/packet'; }));
  ok('and handed to the download helper', w.downloaded === true);

  console.log('-------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error('CRASH', e); process.exit(1); });
