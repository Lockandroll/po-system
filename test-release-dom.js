// Releases of liability: browser rendering tests.
//
// public/js/releases.js is a classic script, so it is evaluated inside a jsdom
// window with the handful of globals app.js normally provides (api, escHtml,
// can, showToast, navigate, novaAlert...) replaced by stubs. Every API call is
// answered from fixtures, so nothing here touches a network or a DB.
//
//   node test-release-dom.js
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

var DRAFT = {
  id: 27, release_number: 'ROL-2026-0042', status: 'draft', feedback_id: 118,
  claimant_name: 'Marcus Whitfield', claimant_phone: '(904) 555-0182', claimant_email: 'mwhitfield@example.com',
  claimant_address: null, claimant_city: 'Jacksonville', claimant_state: null, claimant_zip: null,
  vehicle_year: '2024', vehicle_make: 'Toyota', vehicle_model: 'Highlander', vehicle_color: null,
  license_plate: null, vin: null, service_date: '2026-05-20', job_ref: '271884',
  damage_description: 'Body damage to front right passenger side door.',
  settlement_amount: '0.00', rep_user_id: null, rep_name: null, rep_title: null, release_body: null
};

function completed() {
  var r = JSON.parse(JSON.stringify(DRAFT));
  r.status = 'completed'; r.claimant_address = '1420 Larkspur Way'; r.claimant_state = 'FL';
  r.claimant_zip = '32210'; r.settlement_amount = '2845.00'; r.rep_user_id = 7;
  r.rep_name = 'Alan Reyes'; r.rep_title = 'Southeast Director';
  r.signed_r2_key = 'releases/27/ROL-2026-0042-signed.pdf'; r.completed_at = '2026-08-27T13:12:00Z';
  return r;
}

var EVENTS = [
  { event_type: 'created', actor: 'Alan Reyes', created_at: '2026-08-26T20:04:00Z' },
  { event_type: 'sent', actor: 'Alan Reyes', created_at: '2026-08-26T20:12:00Z' },
  { event_type: 'signed', actor: 'Marcus Whitfield', ip: '198.51.100.24', created_at: '2026-08-26T22:41:00Z' }
];

var FIXTURES = {};
function resetFixtures() {
  FIXTURES = {
    '/releases': { releases: [
      { id: 27, release_number: 'ROL-2026-0042', status: 'completed', claimant_name: 'Marcus Whitfield',
        settlement_amount: '2845.00', rep_name: 'Alan Reyes', completed_at: '2026-08-27T13:12:00Z' },
      { id: 28, release_number: 'ROL-2026-0043', status: 'sent', claimant_name: 'Dana Ruiz',
        settlement_amount: '410.00', rep_name: null, sent_at: '2026-08-27T15:00:00Z' }
    ], storageReady: true },
    '/releases/27': { release: DRAFT, events: [], missing: ['Mailing address', 'State', 'ZIP code', 'Countersigning representative', 'Settlement amount'], canCountersign: false, storageReady: true },
    '/releases/reps': { reps: [{ id: 7, name: 'Alan Reyes', title: 'Southeast Director', email: 'areyes@example.com' }] },
    '/feedback/118': { feedback: { id: 118, customer_name: 'Marcus Whitfield' }, activity: [], attachments: [], releases: [], storageReady: true }
  };
}

function makeWindow(opts) {
  opts = opts || {};
  resetFixtures();
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div><div id="content"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://nova.test' + (opts.path || '/') });
  const w = dom.window;
  w.apiCalls = []; w.toasts = []; w.navigations = []; w.alerts = []; w.fetches = [];
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
  w.can = function (p) { return opts.perms ? opts.perms.indexOf(p) !== -1 : true; };
  w.showToast = function (m, t) { w.toasts.push([m, t]); };
  w.navigate = function (v, p) { w.navigations.push([v, p]); };
  w.novaAlert = function (m) { w.alerts.push(m); return Promise.resolve(); };
  w.novaConfirm = function () { return Promise.resolve(true); };
  w.novaPrompt = function (q, d) { return Promise.resolve(opts.promptAnswer !== undefined ? opts.promptAnswer : d); };
  w.state = { user: { id: 7, name: 'Alan Reyes' } };
  w.fetch = function (url, o) {
    w.fetches.push([url, o]);
    var body = (opts.pubResponse !== undefined) ? opts.pubResponse : { release: opts.pubRelease || null };
    return Promise.resolve({ ok: opts.pubOk === false ? false : true, status: opts.pubStatus || 200,
      json: function () { return Promise.resolve(body); } });
  };
  // app.js defines these before releases.js loads; the wrappers in releases.js
  // chain onto them, so they have to exist here too.
  w.renderFeedbackDetail = function (host, id) { w.feedbackRendered = [host, id]; return Promise.resolve(); };
  w.sigShowTemplates = function () {
    var ov = w.document.createElement('div');
    ov.id = 'sig-tmpl-ov';
    ov.innerHTML = '<div><div>Templates header</div><div class="tmpl-row">An uploaded PDF</div></div>';
    w.document.body.appendChild(ov);
    return Promise.resolve();
  };
  w.sigTmplClose = function () { var o = w.document.getElementById('sig-tmpl-ov'); if (o) o.remove(); };

  // jsdom ships no canvas. Stub just enough of it that the signature pad can be
  // driven here; the drawing itself is a browser concern, not a logic one.
  w.HTMLCanvasElement.prototype.getContext = function () {
    return { fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', font: '',
      textAlign: '', textBaseline: '',
      fillRect: function () {}, beginPath: function () {}, moveTo: function () {},
      lineTo: function () {}, stroke: function () {}, fillText: function () {},
      measureText: function (t) { return { width: String(t).length * 20 }; } };
  };
  w.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,STUB'; };
  w.eval(fs.readFileSync(path.join(__dirname, 'public', 'js', 'releases.js'), 'utf8'));
  return w;
}

async function main() {
  console.log('Release of liability DOM tests');
  console.log('------------------------------');

  // ---- list screen -------------------------------------------------------
  var w = makeWindow();
  var host = w.document.getElementById('content');
  await w.renderReleases(host);
  var html = host.innerHTML;
  has('the list page has a title', html, 'Releases of Liability');
  has('a completed release is listed', html, 'ROL-2026-0042');
  has('a sent release is listed', html, 'ROL-2026-0043');
  has('the settlement amount is formatted', html, '$2,845.00');
  has('completed reads as completed', html, 'Completed');
  has('a sent release says who it is waiting on', html, 'Waiting on customer');
  has('a manager gets the New release button', html, 'New release');

  // A viewer without manage_releases can look but not start one.
  w = makeWindow({ perms: ['view_releases'] });
  host = w.document.getElementById('content');
  await w.renderReleases(host);
  hasnt('a read-only viewer gets no New release button', host.innerHTML, 'New release');

  // No permission at all: the screen refuses.
  w = makeWindow({ perms: [] });
  host = w.document.getElementById('content');
  await w.renderReleases(host);
  has('no permission means access denied', host.innerHTML, 'Access denied');

  // Storage down: say so, plainly.
  w = makeWindow();
  host = w.document.getElementById('content');
  FIXTURES['/releases'].storageReady = false;
  await w.renderReleases(host);
  has('a broken storage config is explained, not hidden', host.innerHTML, 'File storage isn');

  // ---- the builder -------------------------------------------------------
  w = makeWindow();
  host = w.document.getElementById('content');
  await w.renderReleaseForm(host, 27);
  html = host.innerHTML;
  has('the builder shows the release number', html, 'ROL-2026-0042');
  has('the builder says where it came from', html, 'from complaint #118');
  ok('every claimant field is on the form', !!(w.document.getElementById('rel-name') &&
    w.document.getElementById('rel-addr') && w.document.getElementById('rel-city') &&
    w.document.getElementById('rel-state') && w.document.getElementById('rel-zip')));
  ok('every vehicle field is on the form', !!(w.document.getElementById('rel-vyear') &&
    w.document.getElementById('rel-vmake') && w.document.getElementById('rel-vmodel') &&
    w.document.getElementById('rel-vcolor') && w.document.getElementById('rel-plate') &&
    w.document.getElementById('rel-vin')));
  ok('the settlement amount is on the form', !!w.document.getElementById('rel-amount'));
  eq('the claimant name is pre-filled', w.document.getElementById('rel-name').value, 'Marcus Whitfield');
  eq('the vehicle is pre-filled', w.document.getElementById('rel-vmake').value, 'Toyota');
  eq('the date of service arrives as a date input value', w.document.getElementById('rel-date').value, '2026-05-20');
  eq('the mailing address is left blank to be asked for', w.document.getElementById('rel-addr').value, '');
  ok('pre-filled fields are marked', w.document.getElementById('rel-name').className.indexOf('rel-pre') !== -1);
  ok('empty fields are not marked as pre-filled', w.document.getElementById('rel-addr').className.indexOf('rel-pre') === -1);
  has('what is still missing is spelled out', html, 'Mailing address');
  has('the send button is there', html, 'Send to customer');
  has('signing at the vehicle is offered', html, 'Sign in person');
  has('the PDF can be previewed before anyone signs', html, 'Preview PDF');

  // The rep dropdown is filled from its own endpoint.
  await new Promise(function (r) { setTimeout(r, 10); });
  var repSel = w.document.getElementById('rel-rep');
  ok('the representative list loads', repSel && repSel.innerHTML.indexOf('Alan Reyes') !== -1);
  has('a representative brings their title with them', repSel.innerHTML, 'Southeast Director');

  // ---- a completed release is read-only ----------------------------------
  w = makeWindow();
  host = w.document.getElementById('content');
  FIXTURES['/releases/27'] = { release: completed(), events: EVENTS, missing: [], canCountersign: false, storageReady: true };
  await w.renderReleaseForm(host, 27);
  html = host.innerHTML;
  ok('a completed release is not editable', !w.document.getElementById('rel-name'));
  has('a completed release still shows the amount', html, '$2,845.00');
  has('a completed release names the countersigner', html, 'Alan Reyes');
  has('the signed PDF can be opened', html, 'Open the signed PDF');
  hasnt('a completed release cannot be voided', html, 'onclick="relVoid');
  has('the audit trail renders', html, 'Audit trail');
  has('an audit row names the event', html, 'Signed by the claimant');
  has('an audit row keeps the IP', html, '198.51.100.24');
  has('the certificate connection is explained', html, 'certificate page');

  // ---- countersigning ----------------------------------------------------
  w = makeWindow();
  host = w.document.getElementById('content');
  var waiting = completed(); waiting.status = 'customer_signed'; delete waiting.signed_r2_key;
  FIXTURES['/releases/27'] = { release: waiting, events: EVENTS, missing: [], canCountersign: true, storageReady: true };
  await w.renderReleaseForm(host, 27);
  html = host.innerHTML;
  has('the named rep is asked to sign', html, 'Tap to sign');
  has('the completing action is offered', html, 'Countersign and complete');
  has('the status reads as waiting on a countersignature', html, 'Waiting on countersignature');

  // Somebody else looking at the same release is told who it is waiting on.
  w = makeWindow();
  host = w.document.getElementById('content');
  FIXTURES['/releases/27'] = { release: waiting, events: EVENTS, missing: [], canCountersign: false, storageReady: true };
  await w.renderReleaseForm(host, 27);
  html = host.innerHTML;
  hasnt('nobody else gets a signature pad', html, 'Countersign and complete');
  has('they are told who it is waiting on', html, 'Alan Reyes');

  // Countersigning without a signature is refused before it reaches the server.
  w = makeWindow();
  await w.relCountersign(27);
  ok('countersigning with no signature is refused locally',
     w.toasts.length > 0 && /signature first/i.test(w.toasts[0][0]));
  ok('and nothing was sent to the server',
     w.apiCalls.filter(function (c) { return c[1].indexOf('rep-sign') !== -1; }).length === 0);

  // ---- the signature pad -------------------------------------------------
  w = makeWindow();
  var applied = null;
  w.novaSigPad({ title: 'Sign here', defaultName: 'Marcus Whitfield', onApply: function (d) { applied = d; } });
  ok('the pad opens', !!w.document.getElementById('rel-pad-ov'));
  has('the pad offers drawing', w.document.getElementById('rel-pad-ov').innerHTML, 'Draw');
  has('the pad offers typing', w.document.getElementById('rel-pad-ov').innerHTML, 'Type');
  eq('the pad pre-fills the name it was given', w.document.getElementById('rel-pad-text').value, 'Marcus Whitfield');
  w.relPadMode('type');
  eq('typing mode is shown', w.document.getElementById('rel-pad-type').style.display, '');
  eq('drawing is hidden in typing mode', w.document.getElementById('rel-pad-draw').style.display, 'none');
  w.relPadPreview();
  has('the typed name previews', w.document.getElementById('rel-pad-preview').textContent, 'Marcus Whitfield');
  // An empty draw canvas must not be accepted as a signature.
  w.relPadMode('draw');
  w.relPadApply();
  ok('an untouched canvas is not a signature', applied === null);
  ok('and the person is told why', w.toasts.some(function (t) { return /Draw your signature/i.test(t[0]); }));
  ok('the pad stays open so they can try again', !!w.document.getElementById('rel-pad-ov'));
  // Typing an empty name is refused too.
  w.relPadMode('type');
  w.document.getElementById('rel-pad-text').value = '   ';
  w.relPadApply();
  ok('whitespace is not a typed signature', applied === null);
  w.relPadClose();
  ok('closing removes the pad', !w.document.getElementById('rel-pad-ov'));

  // ---- the card on a complaint -------------------------------------------
  w = makeWindow();
  ok('the complaint page is wrapped, not replaced', typeof w.renderFeedbackDetail === 'function');
  host = w.document.getElementById('content');
  host.innerHTML = '<div style="x"><div id="fb-recordings"></div></div>';
  await w.renderFeedbackDetail(host, 118);
  await new Promise(function (r) { setTimeout(r, 10); });
  var card = w.document.getElementById('rel-fb-card');
  ok('the card is added to the complaint page', !!card);
  has('the empty state explains what the button does', card.innerHTML, 'carried over');
  has('the empty state offers to create one', card.innerHTML, 'Create release of liability');
  ok('the card sits above the call recordings',
     card.nextSibling && card.nextSibling.querySelector &&
     !!card.nextSibling.querySelector('#fb-recordings'));

  // With a release already on the complaint the card becomes a status row.
  w = makeWindow();
  host = w.document.getElementById('content');
  host.innerHTML = '<div style="x"><div id="fb-recordings"></div></div>';
  FIXTURES['/feedback/118'].releases = [{ id: 27, release_number: 'ROL-2026-0042', status: 'completed',
    settlement_amount: '2845.00', claimant_name: 'Marcus Whitfield', rep_name: 'Alan Reyes', completed_at: '2026-08-27T13:12:00Z' }];
  await w.renderFeedbackDetail(host, 118);
  await new Promise(function (r) { setTimeout(r, 10); });
  card = w.document.getElementById('rel-fb-card');
  has('an existing release is shown by number', card.innerHTML, 'ROL-2026-0042');
  has('with its amount', card.innerHTML, '$2,845.00');
  has('and who signed it', card.innerHTML, 'Alan Reyes');
  has('and can be opened', card.innerHTML, 'Open');

  // Someone without view_releases sees no card at all.
  w = makeWindow({ perms: ['view_feedback'] });
  host = w.document.getElementById('content');
  host.innerHTML = '<div style="x"><div id="fb-recordings"></div></div>';
  await w.renderFeedbackDetail(host, 118);
  await new Promise(function (r) { setTimeout(r, 10); });
  ok('no permission means no card on the complaint', !w.document.getElementById('rel-fb-card'));

  // The complaint page must still render if the release lookup fails.
  w = makeWindow();
  host = w.document.getElementById('content');
  host.innerHTML = '<div style="x"><div id="fb-recordings"></div></div>';
  w.api = function () { return Promise.reject(new Error('boom')); };
  var threw = false;
  try { await w.renderFeedbackDetail(host, 118); } catch (e) { threw = true; }
  ok('a failing release lookup never breaks the complaint page', !threw);

  // ---- the token in the URL ----------------------------------------------
  w = makeWindow({ path: '/release/' + 'a1b2c3d4'.repeat(8) });
  eq('the token is read from the path', w.relGetUrlToken(), 'a1b2c3d4'.repeat(8));
  w = makeWindow({ path: '/' });
  eq('an ordinary page has no release token', w.relGetUrlToken(), null);
  w = makeWindow({ path: '/?release_token=abc123' });
  eq('the query string form also works', w.relGetUrlToken(), 'abc123');
  w = makeWindow({ path: '/releases' });
  eq('the staff list page is not mistaken for a token', w.relGetUrlToken(), null);

  // ---- the public signing page -------------------------------------------
  var PUB = {
    release_number: 'ROL-2026-0042', company: 'Lock and Roll LLC',
    claimant_name: 'Marcus Whitfield', claimant_phone: '(904) 555-0182',
    claimant_address: '1420 Larkspur Way', claimant_city: 'Jacksonville',
    claimant_state: 'FL', claimant_zip: '32210',
    vehicle_year: '2024', vehicle_make: 'Toyota', vehicle_model: 'Highlander', vehicle_color: 'Silver',
    license_plate: 'GTX 4471', vin: '5TDZA23C13S012345',
    service_date: '2026-05-20', job_ref: '271884',
    damage_description: 'Body damage to front right passenger side door.',
    settlement_amount: '2845.00',
    release_body: 'The undersigned Claimant hereby acknowledges receipt of payment from Lock and Roll LLC.',
    rep_name: 'Alan Reyes', rep_title: 'Southeast Director', consent_accepted: false
  };
  w = makeWindow({ pubRelease: PUB });
  var app = w.document.getElementById('app');
  await w.renderReleasePage(app, 'a1b2c3d4'.repeat(8));
  html = app.innerHTML;
  has('the document renders for the customer', html, 'Release of Liability');
  has('the company is named', html, 'Lock and Roll LLC');
  has('the claimant sees their own name', html, 'Marcus Whitfield');
  has('the vehicle is shown', html, 'Highlander');
  has('the settlement amount is shown', html, '$2,845.00');
  has('the release wording is shown', html, 'acknowledges receipt of payment');
  has('the date of service reads as a date', html, '05/20/2026');
  has('the consent line is the exact wording used elsewhere', html, 'legally binding');
  has('signing is offered', html, 'Sign and submit');
  has('declining is offered', html, 'Decline');
  has('the reference is shown', html, 'ROL-2026-0042');
  ok('there is a printed-name field', !!w.document.getElementById('rel-pub-name'));
  ok('there is a consent checkbox', !!w.document.getElementById('rel-pub-consent'));
  hasnt('the public page has no sidebar', app.className, 'sidebar-open');
  eq('the page is loaded with the token', w.fetches[0][0], '/api/release/' + 'a1b2c3d4'.repeat(8));

  // Submitting without consent, a name, or a signature is refused locally.
  w = makeWindow({ pubRelease: PUB });
  app = w.document.getElementById('app');
  await w.renderReleasePage(app, 'a1b2c3d4'.repeat(8));
  var before = w.fetches.length;
  await w.relPubSubmit();
  ok('signing without ticking consent is refused', w.alerts.some(function (a) { return /tick the box/i.test(a); }));
  eq('and nothing is sent', w.fetches.length, before);

  w.document.getElementById('rel-pub-consent').checked = true;
  w.document.getElementById('rel-pub-name').value = '';
  await w.relPubSubmit();
  ok('signing without a printed name is refused', w.alerts.some(function (a) { return /printed name/i.test(a); }));
  eq('and still nothing is sent', w.fetches.length, before);

  w.document.getElementById('rel-pub-name').value = 'Marcus Whitfield';
  await w.relPubSubmit();
  ok('signing without a signature is refused', w.alerts.some(function (a) { return /add your signature/i.test(a); }));
  eq('and still nothing is sent', w.fetches.length, before);

  // A dead link explains itself instead of showing an empty document.
  w = makeWindow({ pubOk: false, pubStatus: 410, pubResponse: { error: 'This release link has expired.' } });
  app = w.document.getElementById('app');
  await w.renderReleasePage(app, 'a1b2c3d4'.repeat(8));
  has('an expired link says so', app.innerHTML, 'This release link has expired.');
  has('and tells them what to do next', app.innerHTML, 'fresh link');
  hasnt('a dead link shows no signature box', app.innerHTML, 'Sign and submit');

  // ---- escaping ----------------------------------------------------------
  var nasty = JSON.parse(JSON.stringify(PUB));
  nasty.claimant_name = '<script>alert(1)</script>';
  nasty.damage_description = 'Door "damaged" & <b>bent</b>';
  w = makeWindow({ pubRelease: nasty });
  app = w.document.getElementById('app');
  await w.renderReleasePage(app, 'a1b2c3d4'.repeat(8));
  eq('a name cannot inject a script tag', app.querySelectorAll('script').length, 0);
  has('it is escaped instead', app.innerHTML, '&lt;script&gt;');
  has('quotes and ampersands survive as text', app.innerHTML, '&amp;');

  w = makeWindow();
  host = w.document.getElementById('content');
  FIXTURES['/releases'].releases[0].claimant_name = '<img src=x onerror=alert(1)>';
  await w.renderReleases(host);
  eq('the list escapes a hostile name too', host.querySelectorAll('img').length, 0);

  // ---- the Templates dialog entry ----------------------------------------
  w = makeWindow();
  ok('the Templates dialog is wrapped, not replaced', typeof w.sigShowTemplates === 'function');
  await w.sigShowTemplates();
  var ov = w.document.getElementById('sig-tmpl-ov');
  ok('the templates dialog still opens', !!ov);
  has('the uploaded templates are still listed', ov.innerHTML, 'An uploaded PDF');
  has('Nova built-in forms are listed too', ov.innerHTML, 'Nova built-in forms');
  has('the release is one of them', ov.innerHTML, 'Release of Liability');
  has('it explains what it does', ov.innerHTML, 'Fills itself in from a complaint');
  ok('built-in forms sit above the uploaded ones',
     ov.innerHTML.indexOf('Nova built-in forms') < ov.innerHTML.indexOf('An uploaded PDF'));

  // Choosing it closes the dialog and starts a release.
  w = makeWindow();
  await w.sigShowTemplates();
  w.relFromTemplates();
  await new Promise(function (r) { setTimeout(r, 10); });
  ok('choosing the built-in form closes the dialog', !w.document.getElementById('sig-tmpl-ov'));
  ok('and creates a release', w.apiCalls.some(function (c) { return c[0] === 'POST' && c[1] === '/releases'; }));

  // Someone who can only view releases gets no built-in entry to click.
  w = makeWindow({ perms: ['view_releases', 'manage_signatures'] });
  await w.sigShowTemplates();
  hasnt('a read-only viewer gets no built-in form entry',
        w.document.getElementById('sig-tmpl-ov').innerHTML, 'Nova built-in forms');

  // ---- the send dialog ---------------------------------------------------
  w = makeWindow();
  host = w.document.getElementById('content');
  FIXTURES['/releases/27'] = { release: completed(), events: [], missing: [], canCountersign: false, storageReady: true };
  await w.renderReleaseForm(host, 27);
  await w.relSendDialog(27);
  await new Promise(function (r) { setTimeout(r, 10); });
  var send = w.document.getElementById('rel-send-ov');
  ok('the send dialog opens', !!send);
  has('it names the customer', send.innerHTML, 'Marcus Whitfield');
  has('texting is offered', send.innerHTML, 'Text');
  has('emailing is offered', send.innerHTML, 'Email');
  has('sending both is offered', send.innerHTML, 'Both');
  has('copying the link is offered', send.innerHTML, 'Copy link only');
  has('the sender can be chosen', send.innerHTML, 'areyes@example.com');
  has('the reply behaviour is explained', send.innerHTML, 'not to no-reply');
  ok('the expiry defaults to 14 days', w.document.getElementById('rel-exp').value === '14');
  w.relChan('link');
  has('copy-link explains that nothing is sent', w.document.getElementById('rel-dest').innerHTML, 'Nothing is sent');
  w.relChan('sms');
  has('texting names the number', w.document.getElementById('rel-dest').innerHTML, '(904) 555-0182');
  w.relSendClose();
  ok('the dialog closes', !w.document.getElementById('rel-send-ov'));

  // An incomplete release is stopped before the dialog ever opens.
  w = makeWindow();
  host = w.document.getElementById('content');
  await w.renderReleaseForm(host, 27);
  await w.relSendDialog(27);
  await new Promise(function (r) { setTimeout(r, 10); });
  ok('an incomplete release cannot be sent', !w.document.getElementById('rel-send-ov'));
  ok('and the empty fields are named', w.alerts.some(function (a) { return /Mailing address/.test(a); }));

  console.log('------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error('CRASH', e); process.exit(1); });
