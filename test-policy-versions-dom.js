// Policy versions - DOM tests for public/js/policyVersions.js in jsdom.
//   node test-policy-versions-dom.js
// The module is evaluated as the classic script it is, against stand-ins for
// the app.js globals it uses (api, state, escHtml, navigate, novaConfirm...).
// House style: string concatenation only, no template literals.
var fs = require('fs');
var JSDOM = require('jsdom').JSDOM;

var pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 5); }); }

var dom = new JSDOM('<!doctype html><body><div id="content"></div></body>', { runScripts: 'outside-only' });
var w = dom.window;
var CALLS = [], ROUTES = {}, NAV = [], TOASTS = [], CONFIRM = true, PUTS = [];
w.eval('var state = { user: { id: 1, role: "admin", name: "Tony" }, currentView: "documents" };');
w.escHtml = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
w.api = async function (method, path, body) {
  CALLS.push(method + ' ' + path + (body ? ' ' + JSON.stringify(body) : ''));
  var h = ROUTES[method + ' ' + path.split('?')[0]];
  if (!h) throw new Error('no stub for ' + method + ' ' + path);
  return typeof h === 'function' ? h(body) : JSON.parse(JSON.stringify(h));
};
w.navigate = function (v, p) { NAV.push([v, p]); };
w.showToast = function (m, t) { TOASTS.push([t, m]); };
w.novaConfirm = async function () { return CONFIRM; };
w.can = function () { return false; };
w.docDownload = function () {};
w.docReload = function () {};
w.loadSOPList = function () {};
w.loadPdfJs = async function () {};
w.extractPdfText = async function () { return 'New PTO text that is long enough to count.'; };
w.fetch = async function (url, o) { PUTS.push([url, o.method]); return { ok: true }; };

w.eval(fs.readFileSync(__dirname + '/public/js/policyVersions.js', 'utf8'));
var d = w.document;

ROUTES['GET /documents/5/versions'] = { current: { id: 5, name: 'PTO Policy.pdf', version: 2, size_bytes: 2048, version_by_name: 'Tony', version_at: '2026-10-09T12:00:00Z', version_note: 'New accrual' },
  history: [{ id: 9, version: 1, name: 'PTO Policy.pdf', uploaded_by_name: 'Ben', uploaded_at: '2026-01-01', replaced_by_name: 'Tony', replaced_at: '2026-10-09', note: null }], can_edit: true };
ROUTES['GET /documents/5/usage'] = { onboarding_steps: [{ id: 3, title: 'Acknowledge the PTO policy', type: 'acknowledge', phase: 1 }], memos: [{ id: 2, memo_no: 'M-0001', title: 'PTO change', status: 'sent' }], vehicles: 0, policy_folder: true };

(async function () {
  console.log('Policy versions DOM tests');
  await w.pvDocVersions(5);
  var m = d.getElementById('pv-doc');
  ok('the versions dialog opens', !!m);
  ok('title names the file', m.querySelector('.modal-title').textContent.indexOf('PTO Policy.pdf') !== -1);
  ok('current version badge says v2', m.textContent.indexOf('v2') !== -1);
  ok('the note shows', m.textContent.indexOf('New accrual') !== -1);
  ok('history lists v1 with who replaced it', m.textContent.indexOf('v1') !== -1 && m.textContent.indexOf('by Tony') !== -1);
  ok('where-used names the onboarding step', m.textContent.indexOf('Acknowledge the PTO policy') !== -1);
  ok('and says memos keep their own copy', m.textContent.indexOf('keeps its own copy') !== -1);
  ok('the relink button is offered when onboarding uses it', m.innerHTML.indexOf('pvDocRelinkPick(5)') !== -1);
  ok('the upload form is there for an editor', !!d.getElementById('pv-doc-file'));

  // Upload with no file chosen.
  await w.pvDocUpload(5);
  ok('no file -> a plain error, no API call', d.getElementById('pv-doc-msg').textContent.indexOf('Choose the new file') !== -1);

  // Upload a file.
  var input = d.getElementById('pv-doc-file');
  var file = new w.File(['%PDF-1.4 new'], 'PTO 2027.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file] });
  d.getElementById('pv-doc-note').value = 'Accrual 1.5 hrs';
  ROUTES['POST /documents/5/version-url'] = { key: 'documents/abc/PTO_2027.pdf', uploadUrl: 'https://r2.test/put' };
  ROUTES['POST /documents/5/version'] = { success: true, version: 3, name: 'PTO Policy.pdf', usage: { onboarding_steps: [{ id: 3, title: 'Acknowledge the PTO policy', type: 'acknowledge', phase: 1 }], memos: [], vehicles: 0, policy_folder: true } };
  CALLS = [];
  await w.pvDocUpload(5);
  eq('asks for an upload URL, PUTs the bytes, then confirms', CALLS.map(function (c) { return c.split(' ').slice(0, 2).join(' '); }), ['POST /documents/5/version-url', 'POST /documents/5/version']);
  eq('the PUT went to the presigned URL', PUTS, [['https://r2.test/put', 'PUT']]);
  ok('the confirm carries the key, note and keep_name', CALLS[1].indexOf('"key":"documents/abc/PTO_2027.pdf"') !== -1 && CALLS[1].indexOf('"note":"Accrual 1.5 hrs"') !== -1 && CALLS[1].indexOf('"keep_name":true') !== -1);
  ok('the versions dialog closed', !d.getElementById('pv-doc'));
  var done = d.getElementById('pv-done');
  ok('a result dialog says version 3', done && done.textContent.indexOf('version 3') !== -1);
  ok('and lists the step that now shows it', done.textContent.indexOf('Acknowledge the PTO policy') !== -1);
  ok('an admin is offered the memo', done.innerHTML.indexOf('pvMemoFromDoc(5)') !== -1);

  // Send a memo about it.
  ROUTES['POST /memos'] = function (b) { return { memo: { id: 44, title: b.title } }; };
  ROUTES['POST /memos/44/from-vault'] = { memo: { id: 44 } };
  CALLS = [];
  await w.pvMemoFromDoc(5);
  ok('a Policy update memo is started', CALLS.some(function (c) { return c.indexOf('POST /memos {') === 0 && c.indexOf('"type":"Policy update"') !== -1 && c.indexOf('Updated: PTO Policy') !== -1; }), CALLS.join(' | '));
  ok('with the file attached from the vault', CALLS.indexOf('POST /memos/44/from-vault {"document_id":5}') !== -1);
  eq('and opens the draft', NAV[NAV.length - 1], ['memo-edit', 44]);

  // A tech-level user never sees the memo offer.
  w.eval('state.user.role = "manager";');
  w.pvClose('pv-done');
  await w.pvDocVersions(5);
  ok('a non-admin does not get the where-used section', d.getElementById('pv-doc').textContent.indexOf('Where this file is used') === -1);
  w.eval('state.user.role = "admin";');
  w.pvClose('pv-doc');

  // Relink picker.
  ROUTES['GET /documents/search'] = { files: [{ id: 7, name: 'PTO Policy 2027.pdf', folder_path: 'Policies' }, { id: 8, name: 'Handbook.pdf', folder_path: 'Policies' }] };
  ROUTES['POST /documents/5/relink'] = { success: true, moved: [{ id: 3, title: 'Acknowledge' }], to_name: 'PTO Policy 2027.pdf' };
  w.pvDocRelinkPick(5);
  await tick(260);
  ok('the picker lists vault files', d.getElementById('pv-pick-list').textContent.indexOf('PTO Policy 2027.pdf') !== -1);
  CALLS = [];
  w.pvPickChoose(7);
  await tick(20);
  ok('choosing one relinks', CALLS.indexOf('POST /documents/5/relink {"to_document_id":7}') !== -1, CALLS.join(' | '));
  ok('and says how many steps moved', TOASTS.some(function (t) { return /1 onboarding step now show PTO Policy 2027/.test(t[1]); }), JSON.stringify(TOASTS));

  // SOP versions.
  ROUTES['GET /sops/12/versions'] = { current: { id: 12, title: 'PTO SOP', version: 1, char_count: 4000, active: true, uploaded_by_name: 'Ben', created_at: '2026-01-01' }, history: [] };
  ROUTES['GET /sops/12/usage'] = { onboarding_steps: [{ id: 4, title: 'PTO quiz', type: 'quiz', phase: 2 }], active: true };
  ROUTES['GET /sops'] = [{ id: 12, title: 'PTO SOP', active: true }, { id: 13, title: 'PTO SOP 2027', active: true }];
  await w.pvSopVersions(12);
  var sm = d.getElementById('pv-sop');
  ok('SOP dialog opens with v1', sm && sm.textContent.indexOf('v1') !== -1);
  ok('says the quiz uses it', sm.textContent.indexOf('PTO quiz') !== -1);
  ok('and that Nova AI quotes it', sm.textContent.indexOf('Nova AI quotes it') !== -1);
  ok('the move-to select offers only the OTHER SOPs', d.getElementById('pv-sop-to').options.length === 1 && d.getElementById('pv-sop-to').options[0].value === '13');
  var sin = d.getElementById('pv-sop-file');
  Object.defineProperty(sin, 'files', { value: [new w.File(['%PDF'], 'pto27.pdf', { type: 'application/pdf' })] });
  ROUTES['POST /sops/12/version'] = { success: true, sop: { id: 12, title: 'PTO SOP', version: 2 }, usage: { onboarding_steps: [{ id: 4, title: 'PTO quiz', type: 'quiz', phase: 2 }], active: true } };
  CALLS = [];
  await w.pvSopUpload(12);
  ok('the extracted text is sent as the new version', CALLS.some(function (c) { return c.indexOf('POST /sops/12/version') === 0 && c.indexOf('New PTO text') !== -1 && c.indexOf('"filename":"pto27.pdf"') !== -1; }), CALLS.join(' | '));
  ok('result names version 2', d.getElementById('pv-done').textContent.indexOf('version 2') !== -1);
  w.pvClose('pv-done');

  // Onboarding banner.
  var holder = d.createElement('div'); holder.innerHTML = '<p>builder</p>'; d.body.appendChild(holder);
  ROUTES['GET /onboarding/admin/link-health'] = { problems: [{ step_id: 3, title: 'Acknowledge the PTO policy', problem: 'Its Vault file was deleted, so hires see a blank step.' }] };
  await w.pvOnboardingHealth(holder);
  var ban = d.getElementById('pv-onb-health');
  ok('the banner appears at the top of the builder', ban && holder.firstChild === ban);
  ok('naming the step and the problem', ban.textContent.indexOf('1 onboarding step needs a document fixed') !== -1 && ban.textContent.indexOf('blank step') !== -1);
  ROUTES['GET /onboarding/admin/link-health'] = { problems: [] };
  await w.pvOnboardingHealth(holder);
  ok('no problems -> no banner', !d.getElementById('pv-onb-health'));

  // Memo -> Vault.
  ROUTES['POST /memos/44/publish-to-vault'] = { success: true, document_id: 7, name: 'PTO Policy 2027.pdf', version: 4, usage: { onboarding_steps: [{ id: 3, title: 'Acknowledge the PTO policy', type: 'acknowledge', phase: 1 }] } };
  w.pvMemoPublish(44, 7);
  await tick(260);
  ok('the picker marks the file the memo came from', d.getElementById('pv-pick-list').textContent.indexOf('memo came from this') !== -1);
  CALLS = [];
  w.pvPickChoose(7);
  await tick(20);
  ok('publishing posts the chosen file', CALLS.indexOf('POST /memos/44/publish-to-vault {"document_id":7}') !== -1, CALLS.join(' | '));
  ok('and confirms the new version', d.getElementById('pv-done') && d.getElementById('pv-done').textContent.indexOf('version 4') !== -1);
  CONFIRM = false; w.pvClose('pv-done');
  w.pvMemoPublish(44, 7); await tick(260); CALLS = []; w.pvPickChoose(7); await tick(20);
  eq('cancelling the confirm publishes nothing', CALLS.length, 0);

  // No backticks (CLAUDE.md 1.1).
  ok('no backticks in the module', fs.readFileSync(__dirname + '/public/js/policyVersions.js', 'utf8').indexOf(String.fromCharCode(96)) === -1);

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
