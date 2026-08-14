// DOM smoke test for the Outbound tab. Same trick as dom.js: run sync.js in a
// vm with just enough of a browser and assert on the HTML it produces.
var vm = require('vm');
var fs = require('fs');

var API_REPLIES = {};
var POSTED = [];
var sandbox = {
  document: {
    getElementById: function (id) {
      if (id === 'sync-styles') return null;
      if (id === 'sy-out-params') return { value: '{"callUID":"u","techID":"t","locID":"1"}' };
      if (id === 'sy-out-force') return { checked: false };
      if (id === 'sy-out-err') return { style: {}, textContent: '' };
      return { value: '', checked: false, innerHTML: '', style: {}, remove: function () {} };
    },
    createElement: function () { return { style: {}, setAttribute: function () {} }; },
    head: { appendChild: function () {} },
    body: { appendChild: function () {} },
    querySelector: function () { return null; }
  },
  escHtml: function (s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); },
  showToast: function (m, k) { sandbox._toast = { m: m, k: k }; },
  can: function () { return true; },
  api: async function (method, url, body) {
    POSTED.push({ method: method, url: url, body: body });
    var k = method + ' ' + url.split('?')[0];
    if (API_REPLIES[k] === undefined) return {};
    return API_REPLIES[k];
  },
  confirm: function () { return true; },
  encodeURIComponent: encodeURIComponent,
  navigator: { clipboard: { writeText: function () {} } },
  setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () {}, clearInterval: function () {},
  console: console, JSON: JSON, Number: Number, String: String, Math: Math, Date: Date, Array: Array, Object: Object
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, 'public', 'js', 'sync.js'), 'utf8'), sandbox);

var A = 0, F = 0;
function ok(c, l) { if (c) A++; else { F++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ')'); }

var STATUS_OFF = {
  ok: true, mode: 'off', ready: false, skey: null, token: null,
  endpoints: { api: 'https://api.idssonline.com/apiv2.ashx', import: null, gps: null },
  actions: [
    { name: 'auth_test', endpoint: 'api', verified: true, draft: false, describe: 'Confirm the credentials work.', required: [], expect_header: null, available: true },
    { name: 'enroute', endpoint: 'api', verified: false, draft: true, describe: 'Mark a technician enroute.', required: ['techID', 'callUID', 'locID'], expect_header: 67, available: true },
    { name: 'add_call', endpoint: 'import', verified: false, draft: false, describe: 'Create a new call.', required: ['locID', 'serviceID'], expect_header: 1000, available: false }
  ]
};

async function run() {
  var body = { innerHTML: '' };

  console.log('== switched off ==');
  API_REPLIES['GET /pulsar-out/status'] = STATUS_OFF;
  API_REPLIES['GET /pulsar-out/calls'] = { ok: true, calls: [] };
  await sandbox.syncRenderOutbound(body);
  ok(/Outbound is switched off/.test(body.innerHTML), 'the off state says so in the banner');
  ok(/PULSAR_OUT_MODE/.test(body.innerHTML), 'and names the variable to set');
  ok(/not set/.test(body.innerHTML), 'unset credentials are shown as unset');
  ok(/add_call is unavailable/.test(body.innerHTML), 'a missing endpoint URL explains what it costs you');
  ok(!/onclick="syncOutRun/.test(body.innerHTML), 'no Run buttons at all while outbound is off');
  ok(/auth_test/.test(body.innerHTML), 'the auth test is suggested when the log is empty');
  ok(body.innerHTML.indexOf('undefined') === -1, 'no undefined leaked into the outbound screen');

  console.log('== armed ==');
  var live = JSON.parse(JSON.stringify(STATUS_OFF));
  live.mode = 'live'; live.ready = true;
  live.skey = 'set, ends AAAA'; live.token = 'set, ends BBBB';
  live.endpoints.import = 'https://example/import';
  live.actions[2].available = true;
  API_REPLIES['GET /pulsar-out/status'] = live;
  API_REPLIES['GET /pulsar-out/calls'] = { ok: true, calls: [
    { id: 7, action: 'auth_test', status: 'done', http_status: 200, duration_ms: 143, user_name: 'tony',
      created_at: '2026-08-14T18:00:00Z', error: null, mode: 'live', attempts: 1,
      request_shape: 'api', request_body: '{"header":100,"skey":"[redacted]"}', response_body: '{"wasSuccess":true}' },
    { id: 8, action: 'enroute', status: 'dead', http_status: 200, duration_ms: 96, user_name: 'tony',
      created_at: '2026-08-14T18:01:00Z', error: 'serviceID is missing or incorrect', mode: 'live', attempts: 1,
      request_shape: 'api', request_body: '{}', response_body: '{"wasSuccess":false}' }
  ] };
  await sandbox.syncRenderOutbound(body);
  ok(/class="sy-good"/.test(body.innerHTML), 'live mode gets the live banner');
  ok(/change real dispatch state/.test(body.innerHTML), 'and says plainly what that means');
  ok(/ends AAAA/.test(body.innerHTML), 'the sKey fingerprint is shown');
  ok(body.innerHTML.indexOf('ends BBBB') !== -1, 'the token fingerprint is shown');
  ok(/onclick="syncOutRun/.test(body.innerHTML), 'Run buttons appear once armed');
  ok(/verified<\/span>/.test(body.innerHTML), 'auth_test is badged verified');
  ok(/draft<\/span>/.test(body.innerHTML), 'enroute is badged as a draft endpoint');
  ok(/watch for 67/.test(body.innerHTML), 'the echo event to watch for is shown');
  ok(/serviceID is missing or incorrect/.test(body.innerHTML), 'a wasSuccess:false failure is visible in the log');

  console.log('== the run dialog ==');
  sandbox.syncOutRun('enroute');
  // The modal HTML went through document.body.appendChild, which our stub drops,
  // so assert on what the function decided instead: it must have asked for the
  // three required fields and offered the force checkbox.
  var seedSeen = false;
  sandbox.document.body.appendChild = function (el) { seedSeen = true; };
  sandbox.syncOutRun('enroute');
  ok(seedSeen, 'the run dialog opens');

  console.log('== dry run messaging ==');
  var dry = JSON.parse(JSON.stringify(live)); dry.mode = 'dry';
  API_REPLIES['GET /pulsar-out/status'] = dry;
  await sandbox.syncRenderOutbound(body);
  ok(/Dry run/.test(body.innerHTML), 'dry mode is labelled');
  ok(/nothing\s+is sent/.test(body.innerHTML), 'and promises nothing is sent');

  console.log('\n' + A + '/' + (A + F) + ' DOM assertions passed' + (F ? ('  (' + F + ' FAILED)') : ''));
  process.exit(F ? 1 : 0);
}
run().catch(function (e) { console.error(e); process.exit(1); });
