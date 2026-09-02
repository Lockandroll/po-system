'use strict';
/*
 * The front half of verified inspection capture, run for real in jsdom.
 *
 * The single most important assertion in this file is the boring one: that the
 * inspection form no longer contains a file input. Everything else here is polish;
 * that one is the feature. A camera-roll picker sitting next to the Nova camera
 * would quietly reopen the exact hole the server work was built to close.
 *
 *   node test-inspection-photo-dom.js
 */
var fs = require('fs');
var { JSDOM } = require('jsdom');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) { PASS++; } else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(h, n, l) { ok(String(h).indexOf(n) !== -1, l + '  (missing: ' + n + ')'); }
function lacks(h, n, l) { ok(String(h).indexOf(n) === -1, l + '  (unexpectedly present: ' + n + ')'); }

var SRC = fs.readFileSync('public/js/app.js', 'utf8');

// Pull one top-level function out of app.js by matching its braces.
function slice(name) {
  var start = SRC.indexOf('function ' + name + '(');
  if (start === -1) start = SRC.indexOf('async function ' + name + '(');
  if (start === -1) throw new Error('function not found in app.js: ' + name);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  var i = SRC.indexOf('{', start), depth = 0;
  for (var j = i; j < SRC.length; j++) {
    var ch = SRC.charAt(j);
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

var dom = new JSDOM('<!doctype html><html><body><div id="content"></div></body></html>', { url: 'https://nova.test/' });
var win = dom.window;
// Node 22 defines a getter-only global navigator; the sliced code takes everything
// it needs as an explicit parameter, so nothing has to be planted on the global.
global.window = win;
global.document = win.document;

// ---- the small bits of Nova the sliced code leans on ----
win.escHtml = function (s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
win.formatDate = function (d) { return new Date(d).toISOString().slice(0, 10); };
win.state = { user: { id: 7, role: 'manager' }, currentView: 'inspection-form', currentParam: null };
win.INSP_CAMERA_SVG = '<svg></svg>';
win._inspChecklist = [];
win._inspCamTarget = { vehicle_id: 3, inspection_id: null };
var TOASTS = [];
win.showToast = function (m) { TOASTS.push(m); };
win.novaConfirm = async function () { return true; };

var API = [];
var API_REPLIES = {};
win.api = async function (method, path, body) {
  API.push({ method: method, path: path, body: body });
  var key = method + ' ' + path.replace(/\/[0-9]+(?=\/|$)/g, '/:id');
  if (API_REPLIES[key]) return API_REPLIES[key];
  if (path.indexOf('/capture-token') !== -1) {
    return { token: '11111111-2222-3333-4444-555555555555', expires_at: new Date(Date.now() + 3600000).toISOString(), issued_at: new Date().toISOString(), window_minutes: 180 };
  }
  if (path.indexOf('/photo') !== -1 && path.indexOf('/capture/') !== -1) {
    return { id: 901, uploadUrl: 'https://bucket.example/put', captured_at: '2026-08-31T14:00:00.000Z' };
  }
  if (path.indexOf('/confirm') !== -1) return { success: true, duplicate_of: null };
  return {};
};
var PUTS = [];
win.fetch = async function (url, opts) { PUTS.push({ url: url, opts: opts }); return { ok: true }; };

// A canvas jsdom will not give us. The hash is arithmetic over pixels, so a fake
// that returns known pixels tests the arithmetic, which is the part that can be wrong.
var FAKE_PIXELS = null;
var realCreate = win.document.createElement.bind(win.document);
win.document.createElement = function (tag) {
  if (tag === 'canvas') {
    var c = realCreate('div');
    c.width = 0; c.height = 0;
    c.getContext = function () {
      return {
        drawImage: function () {},
        getImageData: function () { return { data: FAKE_PIXELS }; }
      };
    };
    c.toBlob = function (cb) { cb({ size: 1234, type: 'image/jpeg' }); };
    return c;
  }
  return realCreate(tag);
};
win.URL.createObjectURL = function () { return 'blob:fake'; };

var names = ['inspIsExempt', 'inspComplianceStatusKey', 'inspStatusChip', 'inspPerceptualHash',
             'inspPhotoTiles', 'inspRenderPhotoStrip', 'inspViewPhotoTile', 'inspCamShoot',
             'inspEnsureCaptureToken', 'inspCamClose', 'inspOpenCamera', 'inspRetakePhoto'];
var code = names.map(slice).join('\n\n') +
  '\nreturn { ' + names.map(function (n) { return n + ': ' + n; }).join(', ') +
  ', get photos() { return _inspPhotos; }, set photos(v) { _inspPhotos = v; }' +
  ', get capture() { return _inspCapture; }, set capture(v) { _inspCapture = v; }' +
  ', set camCtx(v) { _inspCamCtx = v; } };';

var F = new Function('window', 'document', 'navigator', 'escHtml', 'formatDate', 'state', 'api',
                     'fetch', 'novaConfirm', 'showToast', 'URL', 'INSP_CAMERA_SVG',
                     'var _inspPhotos = [], _inspCapture = null, _inspCamStream = null, _inspCamCtx = null;\n' + code);
var M = F(win, win.document, win.navigator, win.escHtml, win.formatDate, win.state, win.api,
          win.fetch, win.novaConfirm, win.showToast, win.URL, win.INSP_CAMERA_SVG);

console.log('\n--- The file picker is gone ---');
var formStart = SRC.indexOf('async function renderInspectionForm(');
var formEnd = SRC.indexOf('function inspTintSelect(', formStart);
var formSrc = SRC.slice(formStart, formEnd);
ok(formStart > 0 && formEnd > formStart, 'found renderInspectionForm in app.js');
lacks(formSrc, 'type="file"', 'the inspection form contains NO file input at all');
lacks(formSrc, 'capture="environment"', 'and no camera-roll capture attribute');
has(formSrc, 'inspOpenCamera(', 'photos are taken through the in-app camera instead');
has(formSrc, 'insp-item-photos-', 'each checklist item gets its own photo strip');
lacks(SRC.slice(SRC.indexOf('async function inspCamShoot('), SRC.indexOf('function inspPhotoTiles(')),
      'localStorage', 'the camera path stores nothing in the browser');

console.log('\n--- Compliance status ---');
// Cutoff set past today on purpose, so "no inspection yet" reads Due rather than
// Overdue whatever day this test happens to run.
var meta = { month: '2026-08', current_month: '2026-08', cutoff_day: 31 };
eq(M.inspComplianceStatusKey({ inspection_id: 5, retake_count: 0 }, meta), 'done', 'a clean inspection is Done');
eq(M.inspComplianceStatusKey({ inspection_id: 5, retake_count: 2 }, meta), 'retake',
   'an inspection owing a photo is NOT Done - it reads Retake needed, so the review block is visible on the grid');
eq(M.inspComplianceStatusKey({ inspection_id: 5, retake_count: '3' }, meta), 'retake', 'the count survives arriving as a string from pg');
eq(M.inspComplianceStatusKey({ inspection_id: null, retake_count: 0 }, meta), 'due', 'no inspection yet is still Due');
eq(M.inspComplianceStatusKey({ inspection_id: 5, retake_count: 2, inspection_exempt: true }, meta), 'exempt', 'exempt still wins');
eq(M.inspComplianceStatusKey({ inspection_id: null, retake_count: 0 }, { month: '2026-07', current_month: '2026-08', cutoff_day: 31 }), 'overdue', 'a past month with no inspection is Overdue');
has(M.inspStatusChip('retake'), 'Retake needed', 'the chip has a label');

console.log('\n--- Perceptual hash ---');
function pixels(fn) {
  var a = new Uint8ClampedArray(64 * 4);
  for (var i = 0; i < 64; i++) { var v = fn(i); a[i * 4] = v; a[i * 4 + 1] = v; a[i * 4 + 2] = v; a[i * 4 + 3] = 255; }
  return a;
}
FAKE_PIXELS = pixels(function (i) { return i < 32 ? 20 : 220; });
var hA = M.inspPerceptualHash({});
eq(typeof hA, 'string', 'the hash is a string');
eq(hA.length, 16, 'sixteen hex characters, i.e. 64 bits');
ok(/^[0-9a-f]{16}$/.test(hA), 'and it really is hex');
FAKE_PIXELS = pixels(function (i) { return i < 32 ? 20 : 220; });
eq(M.inspPerceptualHash({}), hA, 'the same image hashes the same way twice');
FAKE_PIXELS = pixels(function (i) { return i % 2 ? 10 : 240; });
ok(M.inspPerceptualHash({}) !== hA, 'a different image hashes differently');
FAKE_PIXELS = pixels(function () { return 128; });
eq(M.inspPerceptualHash({}), '0000000000000000', 'a flat image is all zero bits, as the definition requires');
FAKE_PIXELS = null;
eq(M.inspPerceptualHash({}), null, 'and a canvas it cannot read returns null rather than throwing');

console.log('\n--- Photo tiles on the inspection page ---');
var accepted = { id: 1, status: 'ready', url: 'u1', capture_source: 'nova_camera', captured_at: '2026-08-31T12:00:00Z', uploaded_by_name: 'Manager Mike' };
var tAcc = M.inspViewPhotoTile(accepted, true, null);
has(tAcc, 'Send back', 'a reviewer can send an accepted photo back');
lacks(tAcc, 'UNVERIFIED', 'a photo shot in Nova is not labelled unverified');
lacks(tAcc, 'RETAKE NEEDED', 'and is not labelled as owed');

var tAccNoPerm = M.inspViewPhotoTile(accepted, false, null);
lacks(tAccNoPerm, 'Send back', 'somebody without the permission gets no button - the server decides, the client just draws');

var rejected = { id: 2, status: 'rejected', url: 'u2', capture_source: 'nova_camera', reject_reason: 'Tire is out of frame', rejected_by_name: 'Manager Mike', item_key: 'tires' };
var tRej = M.inspViewPhotoTile(rejected, true, null);
has(tRej, 'RETAKE NEEDED', 'a rejected photo is labelled');
has(tRej, 'out of frame', 'the reason is shown, not just the fact');
has(tRej, 'Manager Mike', 'and who sent it back');
has(tRej, 'inspRetakePhoto(2,&quot;tires&quot;)'.replace(/&quot;/g, '"'), 'Retake is wired to that photo and its checklist item');
has(tRej, 'inspUnrejectPhoto(2)', 'with an undo beside it');

var tRepl = M.inspViewPhotoTile(rejected, true, 99);
has(tRepl, 'REPLACED', 'once retaken it reads Replaced');
lacks(tRepl, 'inspRetakePhoto', 'and offers no second retake');
lacks(tRepl, 'inspUnrejectPhoto', 'nor an undo, which would make both photos count');

var legacy = { id: 3, status: 'ready', url: 'u3', capture_source: 'legacy_upload' };
has(M.inspViewPhotoTile(legacy, true, null), 'UNVERIFIED',
    'a photo from before verified capture is labelled honestly rather than passed off as verified');

var dupe = { id: 4, status: 'ready', url: 'u4', capture_source: 'nova_camera', duplicate_of: 3 };
has(M.inspViewPhotoTile(dupe, true, null), 'POSSIBLE DUPLICATE', 'a suspected duplicate is flagged for the manager');

var noPreview = { id: 5, status: 'ready', url: null, capture_source: 'nova_camera' };
has(M.inspViewPhotoTile(noPreview, true, null), 'no preview', 'a photo whose link failed to sign still renders');

var nasty = { id: 6, status: 'rejected', url: 'u6', capture_source: 'nova_camera', reject_reason: '<img src=x onerror=alert(1)>', rejected_by_name: '<b>x</b>' };
lacks(M.inspViewPhotoTile(nasty, true, null), '<img src=x', 'a rejection reason is escaped, not injected');

console.log('\n--- Shooting ---');
win.document.body.innerHTML =
  '<video id="insp-cam-video"></video><div id="insp-cam-status"></div><button id="insp-cam-shoot"></button>';
var video = win.document.getElementById('insp-cam-video');
Object.defineProperty(video, 'videoWidth', { value: 4000, configurable: true });
Object.defineProperty(video, 'videoHeight', { value: 3000, configurable: true });
FAKE_PIXELS = pixels(function (i) { return i < 32 ? 20 : 220; });
API.length = 0; PUTS.length = 0;
M.photos = [];
M.capture = null;
M.camCtx = { item_key: 'tires', replaces_photo_id: null, target: { vehicle_id: 3, inspection_id: null } };
var btn = win.document.getElementById('insp-cam-shoot');

(async function () {
  await M.inspCamShoot(btn);

  eq(API.length, 3, 'a shot is three calls: mint the session, reserve the shot, confirm the upload');
  has(API[0].path, '/inspections/capture-token', 'the session is minted first');
  eq(API[0].body.vehicle_id, 3, 'against the vehicle when there is no inspection yet');
  has(API[1].path, '/capture/11111111-2222-3333-4444-555555555555/photo', 'the shot is reserved against that token');
  eq(API[1].body.item_key, 'tires', 'carrying the checklist item');
  eq(API[1].body.replaces_photo_id, undefined, 'and no retake link on a first shot');
  eq(PUTS.length, 1, 'the bytes go straight to the bucket');
  eq(PUTS[0].opts.method, 'PUT', 'by PUT');
  has(API[2].path, '/photos/901/confirm', 'then the upload is confirmed');
  eq(typeof API[2].body.phash, 'string', 'the perceptual hash rides along on the confirm');
  eq(API[2].body.phash.length, 16, 'as 16 hex chars');
  lacks(JSON.stringify(API[2].body), 'size_bytes',
        'and the client does NOT get to report the file size - the server HEADs the bucket for that');
  eq(M.photos.length, 1, 'the photo joins the strip');
  eq(M.photos[0].id, 901, 'with its server id, because it is already saved');

  // A retake goes to the inspection, not the vehicle, and carries the link.
  API.length = 0; PUTS.length = 0;
  M.capture = null;
  win.document.body.innerHTML = '<video id="insp-cam-video"></video><div id="insp-cam-status"></div><button id="insp-cam-shoot"></button>';
  var v2 = win.document.getElementById('insp-cam-video');
  Object.defineProperty(v2, 'videoWidth', { value: 1000, configurable: true });
  Object.defineProperty(v2, 'videoHeight', { value: 1000, configurable: true });
  M.camCtx = { item_key: 'tires', replaces_photo_id: 55, target: { vehicle_id: 3, inspection_id: 12 } };
  await M.inspCamShoot(win.document.getElementById('insp-cam-shoot'));
  eq(API[0].body.inspection_id, 12, 'a retake mints its session against the inspection');
  eq(API[0].body.vehicle_id, undefined, 'not the vehicle, or it could land on the wrong month');
  eq(API[1].body.replaces_photo_id, 55, 'and the shot is chained to the photo it replaces');

  // Session reuse: a second shot in the same visit does not mint a second token.
  API.length = 0;
  win.document.body.innerHTML = '<video id="insp-cam-video"></video><div id="insp-cam-status"></div><button id="insp-cam-shoot"></button>';
  var v3 = win.document.getElementById('insp-cam-video');
  Object.defineProperty(v3, 'videoWidth', { value: 800, configurable: true });
  Object.defineProperty(v3, 'videoHeight', { value: 600, configurable: true });
  M.camCtx = { item_key: 'lights', replaces_photo_id: 55, target: { vehicle_id: 3, inspection_id: 12 } };
  await M.inspCamShoot(win.document.getElementById('insp-cam-shoot'));
  eq(API.length, 2, 'the live session is reused rather than re-minted');

  // An expiring session is replaced rather than used.
  M.capture = { token: 'old', expires_at: new Date(Date.now() + 20000).toISOString(), _vehicle_id: 3, _inspection_id: 12 };
  var reused = await M.inspEnsureCaptureToken({ vehicle_id: 3, inspection_id: 12 });
  ok(reused.token !== 'old', 'a session with under a minute left is replaced - it would be refused mid-upload otherwise');

  console.log('\n--- A failed upload does not fake success ---');
  win.fetch = async function () { return { ok: false, status: 500 }; };
  var F2 = new Function('window', 'document', 'navigator', 'escHtml', 'formatDate', 'state', 'api',
                        'fetch', 'novaConfirm', 'showToast', 'URL', 'INSP_CAMERA_SVG',
                        'var _inspPhotos = [], _inspCapture = null, _inspCamStream = null, _inspCamCtx = null;\n' + code);
  var M2 = F2(win, win.document, win.navigator, win.escHtml, win.formatDate, win.state, win.api,
              win.fetch, win.novaConfirm, win.showToast, win.URL, win.INSP_CAMERA_SVG);
  win.document.body.innerHTML = '<video id="insp-cam-video"></video><div id="insp-cam-status"></div><button id="insp-cam-shoot"></button>';
  var v4 = win.document.getElementById('insp-cam-video');
  Object.defineProperty(v4, 'videoWidth', { value: 800, configurable: true });
  Object.defineProperty(v4, 'videoHeight', { value: 600, configurable: true });
  M2.camCtx = { item_key: 'tires', replaces_photo_id: null, target: { vehicle_id: 3, inspection_id: null } };
  var shootBtn = win.document.getElementById('insp-cam-shoot');
  await M2.inspCamShoot(shootBtn);
  eq(M2.photos.length, 0, 'a photo whose upload failed never joins the strip');
  has(win.document.getElementById('insp-cam-status').textContent, 'did not upload', 'and the person is told');
  eq(shootBtn.disabled, false, 'with the shutter live again so they can retry');

  console.log('\n--- No camera, no crash ---');
  var savedMedia = win.navigator.mediaDevices;
  try { Object.defineProperty(win.navigator, 'mediaDevices', { value: undefined, configurable: true }); } catch (e) {}
  var alerted = null;
  win.novaAlert = function (m) { alerted = m; };
  await M.inspOpenCamera('tires', null, { vehicle_id: 3 });
  ok(alerted && alerted.indexOf('camera') !== -1, 'a browser with no camera API says so plainly instead of throwing');
  try { Object.defineProperty(win.navigator, 'mediaDevices', { value: savedMedia, configurable: true }); } catch (e) {}

  console.log('\n' + (FAIL === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + PASS + ' passed, ' + FAIL + ' failed\n');
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(function (e) { console.error(e); process.exit(1); });
