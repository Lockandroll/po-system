// Fleet documents: front-end rendering tests.
//
// Runs the SHIPPED code, not a copy of it: the block is sliced out of
// public/js/app.js by its own comment markers and evaluated in jsdom with the
// handful of globals it expects (escHtml, api, novaAlert, novaConfirm,
// applyFleetFilters). If someone edits the block in app.js, this test sees the
// edit. md5-match the slice against the clone before trusting a run.
//
// House style: string concatenation only, no template literals.
const fs = require('fs');
const { JSDOM } = require('jsdom');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
     'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function has(name, hay, needle) { ok(name, String(hay).indexOf(needle) !== -1, 'missing: ' + needle); }
function hasNot(name, hay, needle) { ok(name, String(hay).indexOf(needle) === -1, 'unexpectedly present: ' + needle); }

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.setTimeout = dom.window.setTimeout.bind(dom.window);
global.clearTimeout = dom.window.clearTimeout.bind(dom.window);

// The real escHtml from app.js, verbatim.
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var apiCalls = [];
var apiHandler = null;
async function api(method, path, body) {
  apiCalls.push({ method: method, path: path, body: body });
  if (apiHandler) return apiHandler(method, path, body);
  return {};
}
var alerts = [];
function novaAlert(m) { alerts.push(m); }
var confirmAnswer = true;
async function novaConfirm() { return confirmAnswer; }
var filterCalls = 0;
function applyFleetFilters() { filterCalls++; }

// Slice the block straight out of the shipped app.js by its own comment
// markers, so this test can never drift from what actually ships. jsdom is not
// installed on the Windows clone and it has no network, so the run happens in a
// container against a copy of the same slice - md5-match the two before
// believing a green run.
function readBlock() {
  var full = __dirname + '/public/js/app.js';
  if (fs.existsSync(full)) {
    var app = fs.readFileSync(full, 'utf8');
    var a = app.indexOf('// ===== Fleet documents: registration + insurance =====');
    var b = app.indexOf('function vhFilter() {');
    if (a === -1 || b === -1 || b <= a) throw new Error('Could not find the fleet documents block in app.js');
    return app.slice(a, b);
  }
  return fs.readFileSync(__dirname + '/fleetdocs-slice.js', 'utf8');
}
const src = readBlock();
// vdIsAdmin() reads the global `state`. app.js declares it with top-level const,
// which lives in the global LEXICAL environment and is NOT a window property, so
// the harness has to pass it in the same shape rather than setting window.state.
const factory = new Function(
  'escHtml', 'api', 'novaAlert', 'novaConfirm', 'applyFleetFilters', 'document', 'window', 'setTimeout', 'clearTimeout', 'state',
  src + '\n; return {' +
  ' fdDate: fdDate, fdChip: fdChip, fleetDocCell: fleetDocCell, fleetDocStates: fleetDocStates,' +
  ' fleetDocMatches: fleetDocMatches, fdRenderBanner: fdRenderBanner, fdShowAttention: fdShowAttention,' +
  ' loadFleetDocSummary: loadFleetDocSummary, loadVehicleDocs: loadVehicleDocs, vdRenderCard: vdRenderCard,' +
  ' vdRow: vdRow, vdOpen: vdOpen, vdDetach: vdDetach, vdAttachOpen: vdAttachOpen, vdAttachClose: vdAttachClose,' +
  ' vdAttachList: vdAttachList, vdAttachPick: vdAttachPick, vdAttachSave: vdAttachSave,' +
  ' vdUnsetFleet: vdUnsetFleet, vdIsAdmin: vdIsAdmin,' +
  ' setSummary: function (s, c) { _fleetDocSummary = s; _fleetDocCounts = c; },' +
  ' setVehDocs: function (d) { _vehDocs = d; },' +
  ' setAttachFiles: function (f, pick, vid) { _vdAttach = { vehicleId: vid || 1, pick: pick == null ? null : pick, files: f, timer: null }; },' +
  ' FD_KINDS: FD_KINDS' +
  '};'
);
function build(role) {
  return factory(escHtml, api, novaAlert, novaConfirm, applyFleetFilters, document, dom.window, global.setTimeout, global.clearTimeout, { user: { role: role } });
}
const M = build('admin');
const MTech = build('locksmith');

const CUR = { state: 'current', dated: true, expires_on: '2027-03-04', days: 189, count: 1 };
const SOON = { state: 'expiring', dated: true, expires_on: '2026-09-05', days: 9, count: 1 };
const DEAD = { state: 'expired', dated: true, expires_on: '2026-08-02', days: -25, count: 1 };
const NODATE = { state: 'current', dated: false, expires_on: null, days: null, count: 1 };
const GONE = { state: 'missing', dated: false, expires_on: null, days: null, count: 0 };
const REG = M.FD_KINDS[0], INS = M.FD_KINDS[1];

// ---------- chips ----------
has('current chip uses the green badge', M.fdChip(REG, CUR), 'badge-approved');
has('expiring chip uses the amber badge', M.fdChip(REG, SOON), 'badge-submitted');
has('expired chip uses the red badge', M.fdChip(REG, DEAD), 'badge-rejected');
has('missing chip uses the muted badge', M.fdChip(REG, GONE), 'badge-inactive');
has('missing chip shows a dash', M.fdChip(REG, GONE), '&mdash;');
has('expiring chip counts the days down', M.fdChip(REG, SOON), 'REG 9d');
has('expired chip says so in words', M.fdChip(REG, DEAD), 'REG expired');
eq('a current chip is just the label', M.fdChip(REG, CUR).indexOf('REG</span>') !== -1, true);
has('insurance chip uses its own short label', M.fdChip(INS, CUR), 'INS');
// Tooltips go through escHtml, so an HTML entity inside one comes out literal.
// Plain words only.
hasNot('tooltips contain no HTML entities', M.fdChip(REG, DEAD), 'title="Registration expired &');
has('expired tooltip reads as prose', M.fdChip(REG, DEAD), 'title="Registration expired Aug 2, 2026"');
has('undated current says so in the tooltip', M.fdChip(REG, NODATE), 'no expiration set');

// ---------- the registry cell ----------
M.setSummary(null, null);
has('while the summary loads the cell shows an ellipsis', M.fleetDocCell({ id: 1, active: true }), '&hellip;');
M.setSummary({ 7: { registration: CUR, insurance: CUR }, 8: { registration: DEAD, insurance: CUR } }, null);
has('a graded vehicle shows both chips', M.fleetDocCell({ id: 7, active: true }), 'REG');
has('...including insurance', M.fleetDocCell({ id: 7, active: true }), 'INS');
eq('a sold vehicle is not graded', M.fleetDocCell({ id: 7, active: false }), '<span style="color:var(--text-muted-color)">&mdash;</span>');
has('an expired vehicle shows red', M.fleetDocCell({ id: 8, active: true }), 'badge-rejected');
eq('a vehicle the summary has never heard of falls back to missing',
   M.fleetDocCell({ id: 99, active: true }).split('badge-inactive').length - 1, 2);

// ---------- the filter ----------
M.setSummary({
  1: { registration: CUR, insurance: CUR },
  2: { registration: SOON, insurance: CUR },
  3: { registration: DEAD, insurance: CUR },
  4: { registration: GONE, insurance: CUR }
}, null);
eq('attention filter keeps an expired vehicle', M.fleetDocMatches({ id: 3, active: true }, 'attention'), true);
eq('attention filter keeps an expiring vehicle', M.fleetDocMatches({ id: 2, active: true }, 'attention'), true);
eq('attention filter keeps a vehicle missing a document', M.fleetDocMatches({ id: 4, active: true }, 'attention'), true);
eq('attention filter drops a fully covered vehicle', M.fleetDocMatches({ id: 1, active: true }, 'attention'), false);
eq('expired filter is exact', M.fleetDocMatches({ id: 2, active: true }, 'expired'), false);
eq('expiring filter is exact', M.fleetDocMatches({ id: 2, active: true }, 'expiring'), true);
eq('missing filter is exact', M.fleetDocMatches({ id: 4, active: true }, 'missing'), true);
eq('a sold vehicle never matches a document filter', M.fleetDocMatches({ id: 3, active: false }, 'attention'), false);
M.setSummary(null, null);
eq('while loading, the filter hides nothing', M.fleetDocMatches({ id: 3, active: true }, 'expired'), true);

// ---------- the banner ----------
document.getElementById('root').innerHTML = '<div id="fleet-doc-banner"></div><select id="fleet-docs"><option value=""></option><option value="attention"></option></select>';
M.setSummary({}, { expired: 1, expiring: 1, missing: 1, total: 3 });
M.fdRenderBanner();
var banner = document.getElementById('fleet-doc-banner').innerHTML;
has('banner counts the vehicles', banner, '3 vehicles need document attention');
has('banner breaks down the expired', banner, '1 expired');
has('banner breaks down the expiring', banner, '1 expiring soon');
has('banner breaks down the missing', banner, '1 missing a document');
has('banner offers the shortcut', banner, 'fdShowAttention()');
M.setSummary({}, { expired: 1, expiring: 0, missing: 0, total: 1 });
M.fdRenderBanner();
has('banner is singular for one vehicle', document.getElementById('fleet-doc-banner').innerHTML, '1 vehicle need');
hasNot('...and does not list categories that are zero', document.getElementById('fleet-doc-banner').innerHTML, 'expiring soon');
M.setSummary({}, { expired: 0, expiring: 0, missing: 0, total: 0 });
M.fdRenderBanner();
eq('a clean fleet gets no banner at all', document.getElementById('fleet-doc-banner').innerHTML, '');
filterCalls = 0;
M.fdShowAttention();
eq('the shortcut sets the dropdown', document.getElementById('fleet-docs').value, 'attention');
eq('...and re-runs the filter', filterCalls, 1);

// ---------- the document rows ----------
var dReg = { link_id: 5, document_id: 11, kind: 'registration', kind_label: 'Registration', name: 'Reg 2026.pdf',
             folder_path: 'Fleet / Registrations', covers: 1, link_source: 'manual', created_by_name: 'Tony McKeon', status: SOON };
var dIns = { link_id: null, document_id: 12, kind: 'insurance', kind_label: 'Insurance', name: 'Auto ID Cards.pdf',
             folder_path: 'Fleet / Insurance', covers: 12, link_source: 'fleet', created_by_name: null, status: CUR };

var rowReg = M.vdRow(3, dReg, true);
has('an expiring row is amber', rowReg, '#f59e0b');
has('...and counts the days', rowReg, '9 days');
has('...and names the vault folder', rowReg, 'Vault: Fleet / Registrations');
has('...and says who attached it', rowReg, 'Attached by Tony McKeon');
has('...and offers Remove to someone who may manage', rowReg, 'vdDetach(3,5)');
has('View opens inline', rowReg, 'vdOpen(3,11,1)');
has('Download does not', rowReg, 'vdOpen(3,11,0)');
hasNot('a single-vehicle file does not claim to cover several', rowReg, 'Covers');

var rowIns = M.vdRow(3, dIns, true);
has('the fleet-wide card says so', rowIns, 'Applies to the whole fleet');
has('...and reports how many vehicles it covers', rowIns, 'Covers 12 vehicles');
hasNot('...and cannot be detached, because there is no link to remove', rowIns, 'vdDetach');

hasNot('someone without manage rights gets no Remove button', M.vdRow(3, dReg, false), 'vdDetach');
has('an expired row is red', M.vdRow(3, Object.assign({}, dReg, { status: DEAD }), true), '#ef4444');
has('an expired row says Expired, not Expires', M.vdRow(3, Object.assign({}, dReg, { status: DEAD }), true), 'Expired Aug 2, 2026');
has('a current row says Expires', M.vdRow(3, Object.assign({}, dReg, { status: CUR }), true), 'Expires Mar 4, 2027');
has('a file with no expiry says so plainly', M.vdRow(3, Object.assign({}, dReg, { status: NODATE }), true), 'No expiration set');
var singularRow = M.vdRow(3, Object.assign({}, dReg, { status: { state: 'expiring', dated: true, expires_on: '2026-08-28', days: 1 } }), true);
has('one day left is singular', singularRow, '1 day<');

// A document name is user input. It must not be able to close the tag it sits in.
var nasty = M.vdRow(3, Object.assign({}, dReg, { name: '<img src=x onerror=alert(1)>"evil.pdf' }), true);
hasNot('a hostile file name cannot inject a tag', nasty, '<img src=x');
has('...it is escaped instead', nasty, '&lt;img src=x');
has('...quotes too', nasty, '&quot;evil.pdf');

// ---------- the card ----------
document.getElementById('root').innerHTML = '<div id="veh-docs"></div>';
M.vdRenderCard(3, { documents: [dReg, dIns], canManage: true });
var card = document.getElementById('veh-docs').innerHTML;
has('the card is titled Documents', card, 'Documents');
has('...offers the attach button to a manager', card, 'vdAttachOpen(3)');
has('...renders both documents', card, 'Reg 2026.pdf');
has('...including the insurance card', card, 'Auto ID Cards.pdf');
has('...and explains that nothing is copied', card, 'nothing is stored twice');

M.vdRenderCard(3, { documents: [], canManage: true });
has('an empty card says nothing is linked yet', document.getElementById('veh-docs').innerHTML, 'No registration or insurance card is linked');
has('...and tells a manager how to fix that', document.getElementById('veh-docs').innerHTML, 'Attach existing document');
M.vdRenderCard(3, { documents: [], canManage: false });
hasNot('...but does not tell someone who cannot', document.getElementById('veh-docs').innerHTML, 'Use Attach existing document');
hasNot('...and shows them no attach button', document.getElementById('veh-docs').innerHTML, 'vdAttachOpen');

// ---------- loading + failure ----------
apiHandler = function () { return { documents: [dReg], canManage: false }; };
apiCalls = [];
M.loadVehicleDocs(7).then(function () {
  eq('the card asks the vehicle endpoint', apiCalls[0].path, '/vehicles/7/documents');
  has('the loaded card renders', document.getElementById('veh-docs').innerHTML, 'Reg 2026.pdf');

  apiHandler = function () { throw new Error('Storage is not configured yet.'); };
  return M.loadVehicleDocs(7);
}).then(function () {
  has('a failure is shown in place, not swallowed', document.getElementById('veh-docs').innerHTML, 'Storage is not configured yet.');
  has('...as an error alert', document.getElementById('veh-docs').innerHTML, 'alert-error');

  // A summary that will not load must not take the registry with it.
  apiHandler = function () { throw new Error('boom'); };
  filterCalls = 0;
  return M.loadFleetDocSummary();
}).then(function () {
  eq('a failed summary still repaints the list', filterCalls, 1);
  eq('...and leaves the chips blank rather than wrong', M.fleetDocCell({ id: 1, active: true }).split('badge-inactive').length - 1, 2);

  // ---------- the attach picker ----------
  document.getElementById('root').innerHTML = '<div id="vd-attach-list"></div><div id="vd-attach-err"></div>' +
    '<select id="vd-attach-kind"><option value="registration">Registration</option><option value="insurance">Insurance</option></select>';
  M.setVehDocs({ documents: [{ document_id: 12 }] });
  M.setAttachFiles([
    { id: 11, name: 'Reg 2026.pdf', folder_path: 'Fleet / Registrations', expires_on: '2027-03-04' },
    { id: 12, name: 'Auto ID Cards.pdf', folder_path: 'Fleet / Insurance', expires_on: null }
  ], 11, 3);
  M.vdAttachList();
  var list = document.getElementById('vd-attach-list').innerHTML;
  has('the picker lists vault files', list, 'Reg 2026.pdf');
  has('...with their folder', list, 'Fleet / Registrations');
  has('...and their expiry', list, 'expires Mar 4, 2027');
  has('...and flags what is already on the vehicle', list, 'already on this vehicle');
  has('the picked row is highlighted', list, 'rgba(249,115,22,0.08)');
  eq('exactly one row is highlighted', list.split('rgba(249,115,22,0.08)').length - 1, 1);

  M.setAttachFiles([], null, 3);
  M.vdAttachList();
  has('an empty search says so', document.getElementById('vd-attach-list').innerHTML, 'Nothing in the vault matches that.');

  // Saving with nothing picked must not fire a request.
  M.setAttachFiles([{ id: 11, name: 'x' }], null, 3);
  apiCalls = [];
  return M.vdAttachSave();
}).then(function () {
  eq('attaching with nothing selected sends no request', apiCalls.length, 0);
  has('...and says why', document.getElementById('vd-attach-err').innerHTML, 'Pick a file first.');

  apiHandler = function () { return { success: true }; };
  M.setAttachFiles([{ id: 11, name: 'x' }], 11, 3);
  document.getElementById('vd-attach-kind').value = 'insurance';
  apiCalls = [];
  return M.vdAttachSave();
}).then(function () {
  eq('attach posts to the vehicle', apiCalls[0].path, '/vehicles/3/documents');
  eq('...with the chosen file', apiCalls[0].body.document_id, 11);
  eq('...and the chosen kind', apiCalls[0].body.kind, 'insurance');

  // Detach asks first, and a No means no request.
  confirmAnswer = false;
  apiCalls = [];
  return M.vdDetach(3, 5);
}).then(function () {
  eq('declining the confirm sends no delete', apiCalls.length, 0);
  confirmAnswer = true;
  apiCalls = [];
  return M.vdDetach(3, 5);
}).then(function () {
  eq('confirming deletes the LINK, not the file', apiCalls[0].path, '/vehicles/3/documents/5');
  eq('...with the DELETE verb', apiCalls[0].method, 'DELETE');

  // ---------- fleet-wide: the insurance shortcut ----------
  eq('an admin is recognised', M.vdIsAdmin(), true);
  eq('a tech is not', MTech.vdIsAdmin(), false);

  document.getElementById('root').innerHTML = '<div id="anchor"></div>';
  M.vdAttachOpen(3);
  var modal = document.getElementById('vd-attach-modal').innerHTML;
  has('an admin is offered the fleet-wide checkbox', modal, 'vd-attach-fleet');
  has('...and told what it is for', modal, 'covers every active vehicle');
  hasNot('the picker never offers an upload', modal, 'type="file"');
  M.vdAttachClose();
  eq('closing removes the modal', document.getElementById('vd-attach-modal'), null);

  MTech.vdAttachOpen(3);
  hasNot('a non-admin gets no fleet-wide checkbox', document.getElementById('vd-attach-modal').innerHTML, 'vd-attach-fleet');
  MTech.vdAttachClose();

  // Ticking it flags the FILE and creates no per-vehicle link.
  apiHandler = function () { return { success: true }; };
  M.vdAttachOpen(3);
  M.setAttachFiles([{ id: 12, name: 'Auto ID Cards.pdf' }], 12, 3);
  document.getElementById('vd-attach-kind').value = 'insurance';
  document.getElementById('vd-attach-fleet').checked = true;
  apiCalls = [];
  return M.vdAttachSave().then(function () {
    eq('fleet-wide sends exactly one request', apiCalls.length, 1);
    eq('...to the document, not the vehicle', apiCalls[0].path, '/documents/12');
    eq('...as a PUT', apiCalls[0].method, 'PUT');
    eq('...setting the flag', apiCalls[0].body.fleet_scope, true);
    eq('...with the kind', apiCalls[0].body.fleet_kind, 'insurance');

    // Unticked, the same picker makes an ordinary link.
    M.vdAttachOpen(3);
    M.setAttachFiles([{ id: 11, name: 'Reg.pdf' }], 11, 3);
    apiCalls = [];
    return M.vdAttachSave();
  }).then(function () {
    eq('unticked, it links to the vehicle instead', apiCalls[0].path, '/vehicles/3/documents');
    eq('...and does not touch the file', apiCalls[0].method, 'POST');

    // The way back out.
    var fleetRow = M.vdRow(3, dIns, true);
    has('an admin can stop a file being fleet-wide', fleetRow, 'vdUnsetFleet(3,12)');
    hasNot('a non-admin cannot', MTech.vdRow(3, dIns, true), 'vdUnsetFleet');
    hasNot('and an ordinary linked file has no such button', M.vdRow(3, dReg, true), 'vdUnsetFleet');

    confirmAnswer = false;
    apiCalls = [];
    return M.vdUnsetFleet(3, 12);
  }).then(function () {
    eq('declining leaves the flag alone', apiCalls.length, 0);
    confirmAnswer = true;
    apiCalls = [];
    return M.vdUnsetFleet(3, 12);
  }).then(function () {
    eq('confirming clears the flag', apiCalls[0].body.fleet_scope, false);
    eq('...and the kind with it', apiCalls[0].body.fleet_kind, null);

    // The picker warns rather than letting him set it twice.
    M.setVehDocs({ documents: [] });
    M.setAttachFiles([{ id: 12, name: 'Auto ID Cards.pdf', fleet_scope: true }], null, 3);
    document.getElementById('root').innerHTML = '<div id="vd-attach-list"></div>';
    M.vdAttachList();
    has('the picker says a file already covers the fleet', document.getElementById('vd-attach-list').innerHTML, 'already covers the whole fleet');

    console.log('');
    console.log('  ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  });
}).catch(function (e) { console.error(e); process.exit(1); });
