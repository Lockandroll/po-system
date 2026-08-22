// DOM assertions for the check-in UI. Evaluates the ACTUAL shipped source of the
// new block inside jsdom, so a broken string concat shows up here.
var fs = require('fs');
var { JSDOM } = require('jsdom');

var whole = fs.readFileSync('public/js/app.js', 'utf8');
var lines = whole.split(/\r?\n/);
var start = lines.findIndex(l => l.indexOf('// Check-In / Check-Out') !== -1 && l.indexOf('//  ') === -1);
var end = lines.findIndex(l => l.indexOf('// Draft store (IndexedDB)') !== -1);
if (start < 0 || end < 0) { console.error('could not locate the block', start, end); process.exit(2); }
var block = lines.slice(start - 2, end - 1).join('\n');
if (block.indexOf('function checkinCardHtml') === -1) { console.error('block missed the card fn'); process.exit(2); }

var pass = 0, fail = 0, failures = [];
function ok(n, c, x) { if (c) pass++; else { fail++; failures.push(n + (x !== undefined ? ' :: ' + String(JSON.stringify(x)).slice(0, 300) : '')); } }
function eq(n, a, b) { ok(n, a === b, { got: a, want: b }); }
function has(n, h, x) { ok(n, String(h).indexOf(x) !== -1, { got: String(h).slice(0, 300), want: x }); }
function hasnt(n, h, x) { ok(n, String(h).indexOf(x) === -1, { got: String(h).slice(0, 300), notWant: x }); }

var dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, runScripts: 'outside-only' });
var w = dom.window;
global.window = w; global.document = w.document;

var shim = [
  "function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'); }",
  "function formatDate(d){ return 'FMT(' + String(d).slice(0,10) + ')'; }",
  "var __perms = {}; function can(p){ return !!__perms[p]; }",
  "var state = { user: { id: 1, role: 'admin' } };",
  "var __calls = []; var __responses = {};",
  "async function api(m,p,b){ __calls.push(m+' '+p); if(__responses[p] instanceof Error) throw __responses[p]; if(!(p in __responses)) throw new Error('no stub for '+p); return __responses[p]; }",
  "function novaAlert(m){ __alerts.push(m); return Promise.resolve(); } var __alerts=[];",
  "function novaConfirm(){ return Promise.resolve(true); }",
  "function novaPrompt(){ return Promise.resolve('1'); }",
  "function navigate(){ }",
  "var icons = {}; var NAVI = {};"
].join('\n');
w.eval(shim + '\n' + block);
function tick(n) { return new Promise(r => setTimeout(r, n || 0)); }

function baseState(over) {
  return Object.assign({
    work_order_id: 41, account_name: '23rd Group', wo_number: '4419-88213',
    checkin_phone: '800-555-0142', checkin_reference: '4471',
    checkin_instructions: 'Call on arrival, enter ID then WO number.',
    checked_in_at: null, checked_out_at: null, auth_number: null,
    profile: { id: 1, name: '23rd Group', method: 'phone', phone_number: '800-555-0142', active: true, needs_review: false, capture_label: 'Authorization number' },
    can_call: true, blocked_reason: null, number_mismatch: false,
    checkin: null, checkout: null, events: []
  }, over || {});
}

(async function () {
  w.eval("__perms = { checkin_job: true, manage_ivr_profiles: true, manage_work_orders: true };");

  // ---------- 1. the card, not checked in ----------
  var h = w.checkinCardHtml(baseState());
  has('card: titled Job Clock', h, 'Job Clock');
  has('card: names the account', h, '23rd Group');
  has('card: offers Check In', h, 'Check In Now');
  hasnt('card: does not offer Check Out before checking in', h, 'Check Out Now');
  has('card: shows the number printed on the work order', h, '800-555-0142');
  has('card: shows the ID printed on the work order', h, '4471');
  has('card: shows the instructions verbatim', h, 'Call on arrival, enter ID then WO number.');
  has('card: offers a plain tel: link even before any call', h, 'href="tel:8005550142"');
  var probe = w.document.createElement('div'); probe.innerHTML = h;
  ok('card: parses to real DOM', probe.querySelectorAll('.card').length === 1, probe.innerHTML.slice(0, 120));

  // ---------- 2. dialing ----------
  h = w.checkinCardHtml(baseState({ checkin: { id: 5, status: 'dialing', phone_number: '800-555-0142' } }));
  has('dialing: says it is calling', h, 'Calling 800-555-0142');
  has('dialing: shows a spinner', h, 'ci-spin');
  has('dialing: promises not to jump the gun', h, 'will not mark this done until the tree confirms');
  hasnt('dialing: hides the buttons while a call is live', h, 'Check In Now');

  // ---------- 3. confirmed ----------
  h = w.checkinCardHtml(baseState({
    checked_in_at: '2026-08-19T17:34:00Z',
    checkin: { id: 5, status: 'confirmed', confirmed_at: '2026-08-19T17:34:00Z', call_duration: 47, transcript: 'you are checked in' }
  }));
  has('confirmed: ticked', h, 'ci-tick');
  has('confirmed: offers the record', h, 'openCheckinRecord(5)');
  has('confirmed: now offers Check Out', h, 'Check Out Now');
  has('confirmed: shows the call length', h, '47s');

  // ---------- 4. THE failure case ----------
  h = w.checkinCardHtml(baseState({
    checkin: { id: 6, status: 'failed', phone_number: '800-555-0142', transcript: 'that identification number was not recognized',
      failure_reason: 'The call ran to the end but Nova never heard the confirmation phrase.' }
  }));
  has('failed: says NOT checked in, loudly', h, '<b>Not checked in.</b>');
  has('failed: repeats what went wrong', h, 'never heard the confirmation phrase');
  has('failed: tells the tech to call it in', h, 'Call it in yourself now');
  has('failed: green dial button', h, 'Call It In Yourself');
  has('failed: tel link is stripped to digits', h, 'href="tel:8005550142"');
  has('failed: number in the callout', h, '800-555-0142');
  has('failed: the ID too', h, '4471');
  has('failed: the work order number too', h, '4419-88213');
  has('failed: offers a retry', h, 'Have Nova retry');
  has('failed: offers the manual escape hatch', h, 'mark it done');
  has('failed: offers what Nova heard', h, 'What Nova heard');
  ok('failed: never claims a stamp', h.indexOf('ci-tick') === -1, h.slice(0, 200));

  // ---------- 5. blocked / not configured ----------
  h = w.checkinCardHtml(baseState({ can_call: false, profile: null, blocked_reason: 'No check-in profile has been set up for this account yet.' }));
  has('blocked: explains itself', h, 'No check-in profile has been set up');
  has('blocked: offers to set one up when you may', h, 'checkin-profiles');
  has('blocked: still offers a manual mark', h, 'Mark checked in');
  has('blocked: still shows the number off the work order', h, '800-555-0142');
  hasnt('blocked: does not offer to dial', h, 'Check In Now');

  // ---------- 6. number mismatch ----------
  h = w.checkinCardHtml(baseState({ number_mismatch: true, checkin_phone: '866-555-9999' }));
  has('mismatch: warns', h, 'but the saved script dials');
  has('mismatch: names both numbers', h, '866-555-9999');

  // ---------- 7. closed out ----------
  h = w.checkinCardHtml(baseState({
    checked_in_at: '2026-08-19T17:34:00Z', checked_out_at: '2026-08-19T19:06:00Z', auth_number: 'SC-77-4419-0093',
    checkin: { id: 5, status: 'confirmed', confirmed_at: '2026-08-19T17:34:00Z' },
    checkout: { id: 7, status: 'confirmed', confirmed_at: '2026-08-19T19:06:00Z' }
  }));
  has('closed: shows the authorization number', h, 'SC-77-4419-0093');
  has('closed: labels it from the profile', h, 'Authorization number');
  has('closed: computes time on site', h, '1h 32m');
  hasnt('closed: no more buttons', h, 'Check Out Now');

  // ---------- 8. permissions ----------
  w.eval("__perms = {};");
  h = w.checkinCardHtml(baseState());
  hasnt('no checkin_job: no dial button', h, 'Check In Now');
  hasnt('no checkin_job: no manual button', h, 'Mark checked in');
  has('no checkin_job: the number is still shown, because reading it is not a privilege', h, '800-555-0142');
  w.eval("__perms = { checkin_job: true, manage_ivr_profiles: true, manage_work_orders: true };");

  // ---------- 9. escaping ----------
  h = w.checkinCardHtml(baseState({ account_name: '<script>x</script>', checkin_instructions: "Bob's <b>notes</b>" }));
  hasnt('xss: account name not injected', h, '<script>x</script>');
  has('xss: account name escaped', h, '&lt;script&gt;');
  has('xss: instructions escaped', h, '&#39;');

  // ---------- 10. mount ----------
  w.document.body.innerHTML = '<div id="checkin-host"></div>';
  w.eval("__responses['/checkins/config'] = { voice: { configured: true, using_sms_number: false }, can_call: true, fields: [{key:'wo_number',label:'Work Order #'}] };");
  w.eval("__responses['/checkins/state/41'] = " + JSON.stringify(baseState()) + ";");
  await w.checkinMount('checkin-host', 41);
  has('mount: drew the card', w.document.getElementById('checkin-host').innerHTML, 'Job Clock');

  // nothing to say -> nothing drawn
  w.eval("__responses['/checkins/state/99'] = " + JSON.stringify({ work_order_id: 99, profile: null, checkin_phone: null, checkin: null, checkout: null, events: [] }) + ";");
  w.document.body.innerHTML = '<div id="checkin-host"></div>';
  await w.checkinMount('checkin-host', 99);
  eq('mount: draws nothing when there is nothing to say', w.document.getElementById('checkin-host').innerHTML, '');

  // ---------- 11. the record modal ----------
  w.eval("__responses['/checkins/event/5'] = " + JSON.stringify({
    id: 5, direction: 'in', status: 'confirmed', phone_number: '800-555-0142', requested_by_name: 'Mike Y.',
    requested_at: '2026-08-19T17:34:00Z', call_duration: 47, script_preview: 'dial 800-555-0142 -> wait 5s -> 1 -> 4471# -> 441988213#',
    gps_lat: '28.800000', gps_lon: '-81.600000', gps_accuracy: 16,
    transcript: 'Thank you. You are checked in at this time. Goodbye.', confirmation_text: 'You are checked in',
    auth_number: null, recording_url: 'https://r2.example/rec.mp3'
  }) + ";");
  await w.openCheckinRecord(5);
  await tick(0);
  var ov = w.document.querySelector('.nova-dialog-overlay');
  ok('record: modal opened', !!ov);
  has('record: shows the verdict', ov.textContent, 'Confirmed');
  has('record: shows what Nova dialled', ov.textContent, '441988213#');
  has('record: shows the transcript', ov.textContent, 'You are checked in at this time');
  ok('record: highlights the phrase that justified it', !!ov.querySelector('.ci-hl'), ov.innerHTML.slice(0, 200));
  eq('record: the highlight IS the matched phrase', ov.querySelector('.ci-hl').textContent, 'You are checked in');
  ok('record: offers the audio', !!ov.querySelector('audio'));
  has('record: shows where the tech was', ov.textContent, '28.800000');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  await tick(200);
  eq('record: Escape closes it', w.document.querySelectorAll('.nova-dialog-overlay').length, 0);

  // a failed record leads with why
  w.eval("__responses['/checkins/event/6'] = " + JSON.stringify({
    id: 6, direction: 'in', status: 'failed', phone_number: '800-555-0142',
    failure_reason: 'The call ran to the end but Nova never heard the confirmation phrase.',
    transcript: 'that identification number was not recognized'
  }) + ";");
  await w.openCheckinRecord(6); await tick(0);
  ov = w.document.querySelector('.nova-dialog-overlay');
  has('record: failed badge', ov.textContent, 'Failed');
  has('record: says why it failed', ov.textContent, 'never heard the confirmation phrase');
  ok('record: no highlight when nothing matched', !ov.querySelector('.ci-hl'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })); await tick(200);

  // ---------- 12. the script builder ----------
  w.eval("_ciFields = [{key:'wo_number',label:'Work Order #'},{key:'checkin_reference',label:'Check-In ID (work order)'}];");
  w.eval("_ciProfile = { id: 1, checkin_steps: [], checkout_steps: [] };");
  w.eval("ciAddStep('checkin_steps','wait'); ciAddStep('checkin_steps','press'); ciAddStep('checkin_steps','send');");
  eq('builder: three steps added', w.eval('_ciProfile.checkin_steps.length'), 3);
  eq('builder: a send step defaults to a real field', w.eval("_ciProfile.checkin_steps[2].field"), 'wo_number');
  eq('builder: a send step defaults to a pound suffix', w.eval("_ciProfile.checkin_steps[2].suffix"), '#');
  w.eval("ciSetField('checkin_steps',2,'checkin_reference');");
  eq('builder: field can be changed', w.eval("_ciProfile.checkin_steps[2].field"), 'checkin_reference');
  w.eval("ciSetSeconds('checkin_steps',0,'7');");
  eq('builder: seconds parse to a number', w.eval("_ciProfile.checkin_steps[0].seconds"), 7);
  w.eval("ciDelStep('checkin_steps',1);");
  eq('builder: a step can be removed', w.eval('_ciProfile.checkin_steps.length'), 2);
  var stepsHtml = w.eval("ciStepsHtml('checkin_steps')");
  has('builder: renders a field picker, not a text box', stepsHtml, '<select');
  has('builder: offers the field labels', stepsHtml, 'Check-In ID (work order)');
  has('builder: offers to add each step type', stepsHtml, 'Send a field');

  // ---------- 12b. draft protection for the script editor ----------
  w.eval("var __drafts = {};");
  w.eval("function novaDraftPut(k,v){ __drafts[k]=v; return Promise.resolve(); }");
  w.eval("function novaDraftGet(k){ return Promise.resolve(__drafts[k]||null); }");
  w.eval("function novaDraftDel(k){ delete __drafts[k]; return Promise.resolve(); }");
  w.eval("_ciProfile = { id: 7, vendor_id: 3, method:'phone', phone_number:'800-555-0142', confirm_phrases:'you are checked in', checkin_steps: [{type:'wait',seconds:5}], checkout_steps: [] };");
  w.eval("_ciVendors = [{id:3,name:'23rd Group'}];");
  w.document.body.innerHTML =
    '<div id="ci-draft"></div>' +
    '<select id="ci-vendor"><option value="3" selected>23rd Group</option></select>' +
    '<select id="ci-method"><option value="phone" selected>phone</option></select>' +
    '<input id="ci-phone" value="800-555-0142" /><input id="ci-phrases" value="you are checked in" />' +
    '<input id="ci-phrases-out" value="" /><input id="ci-capture" value="" /><input id="ci-caplabel" value="" />' +
    '<div id="ci-steps-checkin_steps"></div><div id="ci-steps-checkout_steps"></div>';

  eq('draft key is per user and per script', w.eval("ciDraftKey(7)"), 'ivr:1:7');
  ok('draft key for a brand new script is distinct', w.eval("ciDraftKey(null)") === 'ivr:1:new');

  // editing a step writes a draft
  w.eval("ciAddStep('checkin_steps','press');");
  await tick(900);
  ok('a step edit saves a draft', Object.keys(w.eval('__drafts')).length === 1, w.eval('JSON.stringify(Object.keys(__drafts))'));

  // a draft identical to what loaded must NOT nag
  w.eval("__drafts = {}; __drafts['ivr:1:7'] = { v:1, at: 1, body: { phone_number:'800-555-0142', confirm_phrases:'you are checked in', checkin_steps: _ciProfile.checkin_steps, checkout_steps: [] } };");
  await w.ciDraftRestore(7);
  eq('an identical draft does not nag', w.document.getElementById('ci-draft').innerHTML, '');
  ok('and it is cleaned up', !w.eval("__drafts['ivr:1:7']"));

  // a genuinely different draft offers itself
  w.eval("__drafts['ivr:1:7'] = { v:1, at: 1755600000000, body: { phone_number:'866-555-9999', confirm_phrases:'you are checked in', checkin_steps: [{type:'wait',seconds:9},{type:'press',digits:'2'}], checkout_steps: [] } };");
  await w.ciDraftRestore(7);
  var db = w.document.getElementById('ci-draft');
  has('a changed draft offers itself back', db.textContent, 'Unsaved changes recovered');
  ok('with a Restore button', !!w.document.getElementById('ci-draft-use'));
  ok('and a Discard button', !!w.document.getElementById('ci-draft-drop'));
  ok('and nothing is applied until asked', w.document.getElementById('ci-phone').value === '800-555-0142');

  w.document.getElementById('ci-draft-use').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(0);
  eq('Restore puts the typed number back', w.document.getElementById('ci-phone').value, '866-555-9999');
  eq('Restore puts the steps back too', w.eval('_ciProfile.checkin_steps.length'), 2);
  has('and says so', w.document.getElementById('ci-draft').textContent, 'Restored');

  // discard path
  w.eval("__drafts['ivr:1:7'] = { v:1, at: 1755600000000, body: { phone_number:'999-999-9999', checkin_steps: [], checkout_steps: [] } };");
  await w.ciDraftRestore(7);
  w.document.getElementById('ci-draft-drop').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(0);
  eq('Discard clears the banner', w.document.getElementById('ci-draft').innerHTML, '');
  ok('and deletes the draft', !w.eval("__drafts['ivr:1:7']"));

  // ---------- 13. the call sites in the real file ----------
  var wo = whole.slice(whole.indexOf('async function renderViewWorkOrder'), whole.indexOf('function woSignoffTripsCard'));
  has('work order page: has a host element', wo, 'id="checkin-host"');
  has('work order page: mounts the card', wo, "checkinMount('checkin-host', id)");
  var comp = whole.slice(whole.indexOf('async function renderCompleteSignoff'), whole.indexOf('function setupSignaturePad'));
  has('sign-off complete: has a host element', comp, 'id="checkin-host"');
  has('sign-off complete: mounts through the linked work order', comp, "checkinMount('checkin-host', form.work_order_link.id)");
  var view = whole.slice(whole.indexOf('async function renderViewSignoff'), whole.indexOf('function signoffCompletedHtml'));
  has('sign-off view: mounts too', view, "checkinMount('checkin-host', f.work_order_link.id)");
  has('router: monitor wired', whole, "state.currentView === 'checkin-monitor'");
  has('router: profiles wired', whole, "state.currentView === 'checkin-profiles'");
  has('router: one profile wired', whole, "state.currentView === 'checkin-profile'");
  has('nav: Check-Ins row exists', whole, "navItem('checkin-monitor', 'Check-Ins'");
  has('roles page: checkin_job has a row (or saveRoles would wipe it)', whole, "{k:'checkin_job'");
  has('roles page: manage_ivr_profiles has a row', whole, "{k:'manage_ivr_profiles'");
  has('roles page: override_checkin has a row', whole, "{k:'override_checkin'");
  ok('each new function is defined exactly once',
     (whole.match(/function checkinCardHtml\(/g) || []).length === 1 &&
     (whole.match(/function openCheckinRecord\(/g) || []).length === 1 &&
     (whole.match(/function renderCheckinMonitor\(/g) || []).length === 1);

  // ---------- 14. is any of this required? ----------
  h = w.checkinCardHtml(baseState({ checkin_required: 'yes', checkin_pay_gated: true }));
  has('required: a pay-gated job says so on the card', h, 'Required for payment');
  h = w.checkinCardHtml(baseState({ checkin_required: 'yes', checkin_pay_gated: false }));
  has('required: an ordinary one just says required', h, '>Required<');
  hasnt('required: and does not claim payment rides on it', h, 'Required for payment');
  h = w.checkinCardHtml(baseState({ checkin_required: 'unknown' }));
  has('required: an unknown answer says it is unsure rather than guessing', h, 'Not sure it is required');
  h = w.checkinCardHtml(baseState({ checkin_required: 'yes', checkin_evidence: 'Tech must IVR in/out for each site visit.' }));
  has('required: the sentence that proves it is quoted', h, 'Tech must IVR in/out for each site visit.');
  h = w.checkinCardHtml(baseState({ checkin_ai_note: 'The document uses check-in language but the parser answered no.' }));
  has('required: a parser disagreement is shown to a manager', h, 'parser answered no');
  w.eval("__perms = { checkin_job: true };");
  h = w.checkinCardHtml(baseState({ checkin_ai_note: 'The document uses check-in language but the parser answered no.' }));
  hasnt('required: but not to a technician, who cannot act on it', h, 'parser answered no');
  w.eval("__perms = { checkin_job: true, manage_ivr_profiles: true, manage_work_orders: true };");

  h = w.checkinCardHtml(baseState({ by_hand: true, can_call: false, checkin_method: 'app',
    blocked_reason: 'This account checks in through their app, so it has to be done by hand.' }));
  has('required: an app-only account says so', h, 'through their app');
  hasnt('required: and offers no Call button', h, 'Check In Now');
  has('required: but still shows the number to tap', h, 'href="tel:8005550142"');

  h = w.checkinCardHtml(baseState({ profile: Object.assign({}, baseState().profile, { mode: 'ai' }) }));
  has('required: the card says which lane this account is on', h, 'AI navigator');

  // A job the account exempted should not be showing anybody a button.
  var host = w.document.createElement('div'); host.id = 'ci-host-x'; w.document.body.appendChild(host);
  w.eval("__responses['/checkins/config'] = { voice: { configured: true }, can_call: true, fields: [] };");
  w.eval("__responses['/checkins/state/77'] = { work_order_id: 77, checkin_required: 'no', checkin_phone: '800-555-0142', profile: { id: 1, method: 'phone' }, checkin: null, checkout: null, events: [] };");
  await w.checkinMount('ci-host-x', 77);
  eq('required: a job marked NOT required draws nothing at all', host.innerHTML, '');

  // ...unless the parser and the keyword sweep disagree, in which case burying
  // the card would bury the one case where the "no" is most likely wrong.
  w.eval("__responses['/checkins/state/78'] = { work_order_id: 78, checkin_required: 'no', checkin_ai_note: 'The document uses check-in language but the parser answered no.', checkin_phone: '800-555-0142', profile: { id: 1, method: 'phone' }, checkin: null, checkout: null, events: [] };");
  var host2 = w.document.createElement('div'); host2.id = 'ci-host-y'; w.document.body.appendChild(host2);
  await w.checkinMount('ci-host-y', 78);
  has('required: a flagged NO still draws, so somebody sees the flag', host2.innerHTML, 'parser answered no');

  // ---------- 15. asking the tech in the moment ----------
  var ASK = [
    { key: 'job_status', label: 'Job status', type: 'choice', why: 'The check-out tree asks whether the job is finished.',
      options: [{ value: 'complete', label: 'Finished, nothing left to do' }, { value: 'return_trip', label: 'Not finished, coming back' }] },
    { key: 'num_technicians', label: 'Technicians on site', type: 'number', why: 'The check-out tree asks how many technicians were on site.', suggested: '1' }
  ];
  w.checkinAskSheet(41, 'out', ASK);
  var sheet = w.document.querySelector('.nova-dialog-overlay');
  ok('ask: a sheet opens', !!sheet);
  has('ask: it explains why it is asking', sheet.innerHTML, 'has not answered yet');
  has('ask: the choice is a dropdown', sheet.innerHTML, '<select id="ci-ask-0"');
  has('ask: with the account wording', sheet.innerHTML, 'Finished, nothing left to do');
  has('ask: the count is a number box', sheet.innerHTML, 'type="number"');
  has('ask: pre-filled with the obvious answer', sheet.innerHTML, 'value="1"');
  has('ask: each question says why the tree wants it', sheet.innerHTML, 'how many technicians were on site');

  w.eval("__responses['/checkins/41/out'] = { id: 9, status: 'dialing' };");
  w.eval("__responses['/checkins/state/41'] = { work_order_id: 41, profile: { id: 1, method: 'phone' }, checkin: null, checkout: null, events: [] };");
  w.eval("__calls.length = 0; __lastBody = null;");
  w.eval("api = async function(m,p,b){ __calls.push(m+' '+p); __lastBody = b; if(!(p in __responses)) throw new Error('no stub for '+p); return __responses[p]; };");
  sheet.querySelector('#ci-ask-go').click();
  await tick(30);
  var body = w.eval('__lastBody');
  ok('ask: answering fires the call', w.eval('__calls').indexOf('POST /checkins/41/out') !== -1, w.eval('__calls'));
  eq('ask: and carries the answers', body.answers.job_status, 'complete');
  eq('ask: including the head count', body.answers.num_technicians, '1');
  ok('ask: the sheet closes behind it', !w.document.querySelector('.nova-dialog-overlay:not(.closing)'));

  // A 422 from the server is a question, not a failure: it must open the sheet
  // rather than throw an alert at somebody standing at a door.
  w.eval("__alerts.length = 0; __calls.length = 0;");
  w.eval("api = async function(m,p,b){ __calls.push(m+' '+p); if (p === '/checkins/41/out') { var e = new Error('needs answers'); e.status = 422; e.data = { needs_answers: true, ask: " + JSON.stringify(ASK) + " }; throw e; } if(!(p in __responses)) throw new Error('no stub for '+p); return __responses[p]; };");
  Array.prototype.slice.call(w.document.querySelectorAll('.nova-dialog-overlay')).forEach(function (n) { n.remove(); });
  await w.checkinFire(41, 'out', null);
  await tick(20);
  ok('ask: a 422 opens the sheet', !!w.document.querySelector('.nova-dialog-overlay'));
  eq('ask: and says nothing scary', w.eval('__alerts').length, 0);
  Array.prototype.slice.call(w.document.querySelectorAll('.nova-dialog-overlay')).forEach(function (n) { n.remove(); });

  // ---------- 16. the record, for an AI call ----------
  w.eval("__responses['/checkins/event/31'] = " + JSON.stringify({
    id: 31, direction: 'in', status: 'confirmed', verdict_source: 'ai_quoted',
    ai_quote: 'You are checked in at this time', confirmation_text: 'You are checked in at this time',
    phone_number: '800-555-0142', live_transcript: 'For English press 1. You are checked in at this time.',
    transcript: null, turns: [
      { n: 1, heard: 'For English, press 1.', action: 'press', digits: '1', reason: 'language menu', confidence: 'high', source: 'model' },
      { n: 2, heard: 'You are checked in at this time.', action: 'confirm', source: 'model' }
    ]
  }) + ";");
  w.eval("api = async function(m,p,b){ __calls.push(m+' '+p); if(!(p in __responses)) throw new Error('no stub for '+p); return __responses[p]; };");
  await w.openCheckinRecord(31);
  await tick(20);
  var dlg = w.document.querySelector('.nova-dialog-overlay .nova-dlg');
  has('record: says how Nova knows', dlg.innerHTML, 'How Nova knows');
  has('record: and that the quote was checked against the recording', dlg.innerHTML, 'found those words in the recording');
  has('record: shows the conversation turn by turn', dlg.innerHTML, 'Turn by turn');
  has('record: including what the tree said', dlg.innerHTML, 'For English, press 1.');
  has('record: and what Nova did about it', dlg.innerHTML, 'pressed 1');
  has('record: falls back to the live transcript before the recording lands', dlg.innerHTML, 'live from the call');
  Array.prototype.slice.call(w.document.querySelectorAll('.nova-dialog-overlay')).forEach(function (n) { n.remove(); });

  w.eval("__responses['/checkins/event/32'] = " + JSON.stringify({
    id: 32, direction: 'in', status: 'failed',
    failure_reason: 'The AI said this job was checked in, but the words it quoted are not in the recording.',
    ai_quote: 'your check in has been recorded successfully',
    live_transcript: 'Thank you. Your entry has been received.', turns: []
  }) + ";");
  await w.openCheckinRecord(32);
  await tick(20);
  dlg = w.document.querySelector('.nova-dialog-overlay .nova-dlg');
  has('record: an invented quote is shown', dlg.innerHTML, 'recorded successfully');
  has('record: and marked as not found', dlg.innerHTML, 'not found in the recording');
  Array.prototype.slice.call(w.document.querySelectorAll('.nova-dialog-overlay')).forEach(function (n) { n.remove(); });

  // ---------- 17. the profile screen ----------
  has('profile: the AI card exists', whole, 'ciAiCardHtml');
  has('profile: mode is collected', whole, "mode: v('ci-mode')");
  has('profile: so is the playbook', whole, "playbook: v('ci-playbook')");
  has('profile: and what the line asks for', whole, 'needs: (function ()');
  has('profile: the status map is per account, not per call', whole, "id=\"ci-status-");
  has('profile: promotion is offered, never automatic', whole, 'Save it as the check-in script');
  has('profile: the PIN is write-only', whole, 'replace the saved PIN');
  has('profile: an AI profile with NO steps can still be test called', whole, "(_ciProfile.mode || 'script') !== 'script'");
  has('profile: and the lane is passed through', whole, "direction: dir, mode: lane");
  has('profile: draft cover includes the new inputs', whole, "'ci-playbook','ci-maxturns'");
  has('profile: the checkbox reset is present or the list balloons', fs.readFileSync('public/index.html', 'utf8'), '.ci-need input[type="checkbox"]');

  console.log('\nPASS ' + pass + '   FAIL ' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
