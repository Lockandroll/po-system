'use strict';
/*
 * Verified inspection photo capture + per-photo rejection.
 *
 * The thing under test is a claim: that a photo on an inspection was taken by this
 * person, for this vehicle, just now. EXIF cannot carry that claim - iOS strips GPS
 * on the way through a web file picker, a browser camera capture has none to begin
 * with, and every field in it is rewritable by anyone who cares to. So the claim is
 * issued server-side instead: a capture token with a server-clock expiry, and
 * captured_at stamped at the shutter.
 *
 * These run against a REAL Postgres, because almost everything here is SQL: the
 * expiry comparison, the adoption of a capture session's photos, and above all the
 * outstanding-retake subquery that the review gate and the compliance grid share.
 *
 *   node test-inspection-photo-verification.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-inspection-photos';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://tester@/novatest?host=/tmp/pgs&port=55432';

var http = require('http');
var jwt = require('jsonwebtoken');
var express = require('express');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) { PASS++; } else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(h, n, l) { ok(String(h).indexOf(n) !== -1, l + '  (missing: ' + n + ')'); }

// ---- R2 stub. The bucket is the one thing we genuinely cannot run here, and it is
// also the thing the confirm step is supposed to distrust, so the stub tracks what
// actually got "uploaded" and answers HEAD honestly.
var R2 = {};                 // key -> size
var r2 = require('./utils/r2');
r2.configured = function () { return true; };
r2.presignUpload = async function (key) { return 'https://bucket.example/' + encodeURIComponent(key); };
r2.presignDownload = async function (key) { return 'https://bucket.example/get/' + encodeURIComponent(key); };
r2.headObject = async function (key) { return Object.prototype.hasOwnProperty.call(R2, key) ? { size: R2[key], contentType: 'image/jpeg' } : null; };
r2.deleteObject = async function (key) { delete R2[key]; };

// ---- notification stubs, patched BEFORE the route destructures them.
var SMS = [], EMAIL = [], PUSH = [];
var emailMod = require('./utils/email');
emailMod.sendEmail = async function (to, subject, html) { EMAIL.push({ to: to, subject: subject, html: html }); return { ok: true }; };
var smsMod = require('./utils/sms');
smsMod.sendSms = async function (to, message) { SMS.push({ to: to, message: message }); return { ok: true }; };
var pushMod = require('./utils/push');
pushMod.sendPushToUsers = async function (ids, payload) { PUSH.push({ ids: ids, payload: payload }); };

var db = require('./db');
var pool = db.pool;
var inspections = require('./routes/inspections');
var cleanup = require('./jobs/cleanup');

var app = express();
app.use(express.json());
app.use('/api/inspections', inspections);
var server, BASE;

function tokenFor(u) { return jwt.sign({ id: u.id, role: u.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

function req(method, path, user, body) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : JSON.stringify(body);
    var r = http.request(BASE + path, {
      method: method,
      headers: Object.assign(
        { 'Authorization': 'Bearer ' + tokenFor(user) },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
      )
    }, function (res) {
      var chunks = '';
      res.on('data', function (d) { chunks += d; });
      res.on('end', function () {
        var parsed = null;
        try { parsed = JSON.parse(chunks); } catch (e) { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Shoot a photo the way the browser does: reserve, PUT, confirm.
async function shoot(user, token, opts) {
  opts = opts || {};
  var reserve = await req('POST', '/api/inspections/capture/' + token + '/photo', user, {
    name: 'shot.jpg', mime_type: 'image/jpeg', item_key: opts.item_key || null, replaces_photo_id: opts.replaces_photo_id || null
  });
  if (reserve.status !== 200) return { reserve: reserve, confirm: null };
  if (!opts.skipUpload) {
    var kr = await pool.query('SELECT r2_key FROM inspection_photos WHERE id = $1', [reserve.body.id]);
    R2[kr.rows[0].r2_key] = opts.size || 240000;
  }
  var confirm = await req('POST', '/api/inspections/photos/' + reserve.body.id + '/confirm', user, { phash: opts.phash || null, size_bytes: 11 });
  return { reserve: reserve, confirm: confirm, id: reserve.body.id };
}

var U = {}, VEH = {};

async function seed() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.initDB();
  // Roles: an owner who can do anything, a city manager who is the driver's
  // supervisor (and therefore the inspector), a tech who drives the van, and an
  // unrelated tech who should be able to touch none of it.
  async function mkUser(email, name, role, supervisorId, city) {
    const { rows } = await pool.query(
      "INSERT INTO users (email, name, password_hash, role, active, supervisor_id, home_city, phone, receive_sms, receive_emails, session_epoch) " +
      "VALUES ($1,$2,'x',$3,true,$4,$5,'+15550001111',true,true,0) RETURNING *",
      [email, name, role, supervisorId, city]
    );
    return rows[0];
  }
  U.owner = await mkUser('owner@x.com', 'Owner Ann', 'owner', null, 'ATL');
  U.mgr = await mkUser('mgr@x.com', 'Manager Mike', 'manager', U.owner.id, 'ATL');
  U.tech = await mkUser('tech@x.com', 'Tech Tina', 'locksmith', U.mgr.id, 'ATL');
  U.other = await mkUser('other@x.com', 'Other Otto', 'locksmith', U.owner.id, 'ATL');

  const v1 = await pool.query(
    "INSERT INTO vehicles (year, make_model, license_plate, city_code, assigned_user_id, active) VALUES (2022,'Ford Transit','ABC123','ATL',$1,true) RETURNING *",
    [U.tech.id]
  );
  VEH.a = v1.rows[0];
  const v2 = await pool.query(
    "INSERT INTO vehicles (year, make_model, license_plate, city_code, assigned_user_id, active) VALUES (2021,'Ford Transit','XYZ789','ATL',$1,true) RETURNING *",
    [U.tech.id]
  );
  VEH.b = v2.rows[0];
}

async function main() {
  await seed();
  await new Promise(function (r) { server = app.listen(0, function () { BASE = 'http://127.0.0.1:' + server.address().port; r(); }); });

  console.log('\n--- Schema ---');
  var cols = await pool.query("SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'inspection_photos'");
  var byName = {};
  cols.rows.forEach(function (c) { byName[c.column_name] = c; });
  ['capture_token', 'captured_at', 'capture_source', 'phash', 'duplicate_of', 'replaces_photo_id', 'reject_reason', 'rejected_by', 'rejected_by_name', 'rejected_at'].forEach(function (c) {
    ok(!!byName[c], 'inspection_photos.' + c + ' exists');
  });
  has(byName.capture_source.column_default, 'legacy_upload',
    'capture_source defaults to legacy_upload, so photos taken before this deploy are labelled honestly rather than silently promoted');
  eq(byName.inspection_id.is_nullable, 'YES', 'inspection_id is nullable - a photo exists before the inspection row does');
  var tok = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'inspection_capture_tokens'");
  ok(tok.rows.length > 0, 'inspection_capture_tokens table exists');

  console.log('\n--- Minting a capture session ---');
  var t1 = await req('POST', '/api/inspections/capture-token', U.mgr, { vehicle_id: VEH.a.id });
  eq(t1.status, 201, 'the driver\'s manager can open a capture session');
  ok(!!t1.body.token, 'a token comes back');
  eq(t1.body.window_minutes, 180, 'the default window is 180 minutes');
  var mins = (new Date(t1.body.expires_at) - new Date(t1.body.issued_at)) / 60000;
  ok(Math.abs(mins - 180) < 1, 'expires_at is 180 minutes after issued_at (got ' + mins.toFixed(1) + ')');

  var tDenied = await req('POST', '/api/inspections/capture-token', U.other, { vehicle_id: VEH.a.id });
  eq(tDenied.status, 403, 'an unrelated tech cannot open a capture session on somebody else\'s van');

  await pool.query("INSERT INTO settings (key, value) VALUES ('inspection_capture_window_min','30') ON CONFLICT (key) DO UPDATE SET value = '30'");
  var t30 = await req('POST', '/api/inspections/capture-token', U.mgr, { vehicle_id: VEH.a.id });
  eq(t30.body.window_minutes, 30, 'the window is settable');
  await pool.query("DELETE FROM settings WHERE key = 'inspection_capture_window_min'");

  console.log('\n--- Shooting against a live session ---');
  var s1 = await shoot(U.mgr, t1.body.token, { item_key: 'tires', phash: '0f0f0f0f0f0f0f0f' });
  eq(s1.reserve.status, 200, 'a shot reserves against a live token');
  eq(s1.confirm.status, 200, 'and confirms once the bytes are in the bucket');
  var row = (await pool.query('SELECT * FROM inspection_photos WHERE id = $1', [s1.id])).rows[0];
  eq(row.status, 'ready', 'the photo is ready');
  eq(row.capture_source, 'nova_camera', 'it is marked as shot in Nova, not uploaded');
  ok(!!row.captured_at, 'captured_at is stamped');
  eq(row.inspection_id, null, 'and it is parked against the token, because no inspection row exists yet');
  eq(Number(row.size_bytes), 240000,
    'size comes from the R2 HEAD, not from the size_bytes the client claimed (11)');

  var stolen = await req('POST', '/api/inspections/capture/' + t1.body.token + '/photo', U.other, { name: 'x.jpg', mime_type: 'image/jpeg' });
  eq(stolen.status, 403, 'somebody else\'s token is not usable, even by a valid Nova login');
  var badUuid = await req('POST', '/api/inspections/capture/not-a-uuid/photo', U.mgr, { name: 'x.jpg', mime_type: 'image/jpeg' });
  eq(badUuid.status, 400, 'a malformed token is rejected before it reaches Postgres');
  var pdf = await req('POST', '/api/inspections/capture/' + t1.body.token + '/photo', U.mgr, { name: 'x.pdf', mime_type: 'application/pdf' });
  eq(pdf.status, 400, 'only images can be attached');

  console.log('\n--- Freshness: this is the whole point ---');
  var tExp = await req('POST', '/api/inspections/capture-token', U.mgr, { vehicle_id: VEH.a.id });
  await pool.query("UPDATE inspection_capture_tokens SET expires_at = NOW() - interval '1 minute' WHERE token = $1", [tExp.body.token]);
  var expShot = await req('POST', '/api/inspections/capture/' + tExp.body.token + '/photo', U.mgr, { name: 'old.jpg', mime_type: 'image/jpeg' });
  eq(expShot.status, 410, 'a shot against an EXPIRED session is refused outright');

  // And the race: reserved while live, expired before the upload finished.
  var tRace = await req('POST', '/api/inspections/capture-token', U.mgr, { vehicle_id: VEH.a.id });
  var raceRes = await req('POST', '/api/inspections/capture/' + tRace.body.token + '/photo', U.mgr, { name: 'race.jpg', mime_type: 'image/jpeg' });
  var raceKey = (await pool.query('SELECT r2_key FROM inspection_photos WHERE id = $1', [raceRes.body.id])).rows[0].r2_key;
  R2[raceKey] = 100000;
  await pool.query("UPDATE inspection_capture_tokens SET expires_at = NOW() - interval '1 second' WHERE token = $1", [tRace.body.token]);
  var raceConf = await req('POST', '/api/inspections/photos/' + raceRes.body.id + '/confirm', U.mgr, {});
  eq(raceConf.status, 410, 'a photo whose session lapsed before the upload landed never goes ready');
  var raceRow = (await pool.query('SELECT status FROM inspection_photos WHERE id = $1', [raceRes.body.id])).rows[0];
  eq(raceRow.status, 'expired', 'it is marked expired');
  ok(!Object.prototype.hasOwnProperty.call(R2, raceKey), 'and its bytes are dropped from the bucket rather than left to rot');

  console.log('\n--- The bucket is the authority on whether an upload happened ---');
  var ghost = await shoot(U.mgr, t1.body.token, { item_key: 'lights', skipUpload: true });
  var ghostId = ghost.id;
  eq(ghost.confirm.status, 400, 'confirming a photo that was never actually PUT is refused');
  var ghostRow = (await pool.query('SELECT status FROM inspection_photos WHERE id = $1', [ghost.id])).rows[0];
  eq(ghostRow.status, 'pending', 'it stays pending and never counts');

  console.log('\n--- Duplicate detection (advisory) ---');
  var dup = await shoot(U.mgr, t1.body.token, { item_key: 'exterior', phash: '0f0f0f0f0f0f0f0f' });
  eq(dup.confirm.status, 200, 'a near-identical photo still saves');
  // It cannot match yet: the earlier photo is not on an inspection, and the lookup
  // only compares against a vehicle's submitted history.
  var far = await shoot(U.mgr, t1.body.token, { item_key: 'exterior', phash: 'ffffffffffffffff' });
  eq(far.confirm.body.duplicate_of, null, 'an unrelated photo is not flagged');

  console.log('\n--- Submitting adopts the session\'s photos ---');
  var orphan = await req('POST', '/api/inspections/capture-token', U.owner, { vehicle_id: VEH.a.id });
  // Same token, different person: a leaked token must not drag in a stranger's photo.
  await pool.query(
    "INSERT INTO inspection_photos (item_key, name, r2_key, mime_type, uploaded_by, uploaded_by_name, status, capture_token, captured_at, capture_source) " +
    "VALUES ('tires','sneak.jpg','k/sneak','image/jpeg',$1,'Other Otto','ready',$2,NOW(),'nova_camera')",
    [U.other.id, t1.body.token]
  );
  var created = await req('POST', '/api/inspections', U.mgr, {
    vehicle_id: VEH.a.id, mileage: 42000, notes: 'ok',
    items: [{ item_key: 'tires', label: 'Tires', answer: 'OK', color: 'green' }],
    capture_token: t1.body.token
  });
  eq(created.status, 201, 'the inspection is created');
  var INSP = created.body.id;
  var adopted = await pool.query("SELECT id, uploaded_by FROM inspection_photos WHERE inspection_id = $1 ORDER BY id", [INSP]);
  eq(adopted.rows.length, 3, 'only the three READY photos this person shot are adopted');
  var stillPending = (await pool.query("SELECT inspection_id, status FROM inspection_photos WHERE id = $1", [ghostId])).rows[0];
  eq(stillPending.inspection_id, null,
    'a half-finished upload is NOT adopted - attached it would be invisible, uncounted, and permanently missed by the orphan sweep');
  ok(adopted.rows.every(function (r) { return r.uploaded_by === U.mgr.id; }),
    'a photo uploaded by somebody else under the same token is NOT adopted');

  console.log('\n--- Duplicate detection, now that the vehicle has history ---');
  var t2 = await req('POST', '/api/inspections/capture-token', U.mgr, { inspection_id: INSP });
  var dupNow = await shoot(U.mgr, t2.body.token, { item_key: 'exterior', phash: '0f0f0f0f0f0f0f0f' });
  eq(dupNow.confirm.body.duplicate_of !== null, true, 'a photo matching one already on this vehicle is flagged');
  var tB = await req('POST', '/api/inspections/capture-token', U.mgr, { vehicle_id: VEH.b.id });
  var otherVan = await shoot(U.mgr, tB.body.token, { item_key: 'exterior', phash: '0f0f0f0f0f0f0f0f' });
  eq(otherVan.confirm.body.duplicate_of, null,
    'the same hash on a DIFFERENT van is not flagged - two vans in one bay legitimately look alike');

  console.log('\n--- The legacy upload route is closed ---');
  var legacy = await req('POST', '/api/inspections/' + INSP + '/photos/upload-url', U.mgr, { name: 'roll.jpg' });
  eq(legacy.status, 410, 'the old free-form upload endpoint refuses');
  has(legacy.body.error, 'reopen Nova', 'and tells a stale client what to do about it');

  console.log('\n--- Sending one photo back ---');
  var target = adopted.rows[0].id;
  var noReason = await req('POST', '/api/inspections/photos/' + target + '/reject', U.mgr, { reason: '   ' });
  eq(noReason.status, 400, 'a rejection without a reason is refused - the point is telling them what to retake');
  var byStranger = await req('POST', '/api/inspections/photos/' + target + '/reject', U.other, { reason: 'nope' });
  eq(byStranger.status, 403, 'an unrelated tech cannot send a photo back');

  SMS.length = 0; EMAIL.length = 0; PUSH.length = 0;
  var rej = await req('POST', '/api/inspections/photos/' + target + '/reject', U.mgr, { reason: 'Tire is out of frame, get the whole driver-side rear.' });
  eq(rej.status, 200, 'the reviewer sends it back');
  eq(rej.body.outstanding, 1, 'one retake is now outstanding');
  var rejRow = (await pool.query('SELECT * FROM inspection_photos WHERE id = $1', [target])).rows[0];
  eq(rejRow.status, 'rejected', 'the photo is marked rejected, not deleted');
  has(rejRow.reject_reason, 'out of frame', 'the reason is stored');
  eq(rejRow.rejected_by, U.mgr.id, 'and who sent it back');
  eq(SMS.length, 1, 'the person who took it gets an SMS');
  has(SMS[0].message, 'out of frame', 'the SMS carries the reason');
  eq(EMAIL.length, 1, 'and an email');
  has(EMAIL[0].html, 'out of frame', 'which also carries the reason');
  eq(PUSH.length, 1, 'and a push notification');

  var twice = await req('POST', '/api/inspections/photos/' + target + '/reject', U.mgr, { reason: 'again' });
  eq(twice.status, 400, 'a photo already sent back cannot be sent back twice');

  console.log('\n--- The block is real, and visible ---');
  var mgrReview = await req('POST', '/api/inspections/' + INSP + '/review', U.mgr, { note: 'looks fine' });
  eq(mgrReview.status, 403,
    'marking an inspection reviewed stays a manage_inspections power - a city manager completes and polices one, an admin signs it off');
  var blocked = await req('POST', '/api/inspections/' + INSP + '/review', U.owner, { note: 'looks fine' });
  eq(blocked.status, 409, 'the inspection cannot be marked reviewed while a photo is owed');
  eq(blocked.body.outstanding, 1, 'and it says how many');
  var stillOpen = (await pool.query('SELECT status FROM vehicle_inspections WHERE id = $1', [INSP])).rows[0];
  eq(stillOpen.status, 'submitted', 'the inspection really did not close');

  var grid = await req('GET', '/api/inspections/compliance?month=' + created.body.period_month, U.owner);
  var gridRow = grid.body.vehicles.filter(function (v) { return v.vehicle_id === VEH.a.id; })[0];
  eq(Number(gridRow.retake_count), 1,
    'the compliance grid sees the same outstanding count - a green Done next to a blocked close would make the block invisible');

  var cannotDelete = await req('DELETE', '/api/inspections/photos/' + target, U.mgr);
  eq(cannotDelete.status, 409, 'and the block cannot be cleared by deleting the rejected photo');

  console.log('\n--- Retaking clears it ---');
  var t3 = await req('POST', '/api/inspections/capture-token', U.tech, { inspection_id: INSP });
  eq(t3.status, 403, 'the driver is not automatically allowed to retake - the same rule as completing the inspection');
  var t4 = await req('POST', '/api/inspections/capture-token', U.mgr, { inspection_id: INSP });
  var retake = await shoot(U.mgr, t4.body.token, { replaces_photo_id: target });
  eq(retake.confirm.status, 200, 'the retake saves');
  var retakeRow = (await pool.query('SELECT * FROM inspection_photos WHERE id = $1', [retake.id])).rows[0];
  eq(retakeRow.replaces_photo_id, target, 'it is chained to the photo it replaces, so the history survives');
  eq(retakeRow.item_key, rejRow.item_key, 'and inherits the checklist item of the photo it replaces');
  eq(retakeRow.inspection_id, INSP, 'a retake attaches to the inspection immediately, with no submit step');

  var detail = await req('GET', '/api/inspections/' + INSP, U.mgr);
  eq(detail.body.outstanding_retakes, 0, 'nothing is outstanding any more');
  eq(detail.body.can_manage_photos, true, 'the server tells the client whether to draw the buttons');
  var stillThere = detail.body.photos.filter(function (p) { return p.id === target; })[0];
  ok(!!stillThere, 'the rejected photo is still returned, so the reviewer can see what came back');
  eq(stillThere.status, 'rejected', 'labelled as rejected');

  var reviewed = await req('POST', '/api/inspections/' + INSP + '/review', U.owner, { note: 'good now' });
  eq(reviewed.status, 200, 'and now the inspection closes');
  var closed = (await pool.query('SELECT status FROM vehicle_inspections WHERE id = $1', [INSP])).rows[0];
  eq(closed.status, 'reviewed', 'for real');

  var afterReview = await req('POST', '/api/inspections/capture-token', U.mgr, { inspection_id: INSP });
  eq(afterReview.status, 400, 'a reviewed inspection takes no more photos');
  var detail2 = await req('GET', '/api/inspections/' + INSP, U.mgr);
  eq(detail2.body.can_manage_photos, false, 'and the buttons go away');

  console.log('\n--- Undoing a rejection ---');
  var t5 = await req('POST', '/api/inspections/capture-token', U.mgr, { vehicle_id: VEH.b.id });
  var pb = await shoot(U.mgr, t5.body.token, { item_key: 'tires' });
  var cb = await req('POST', '/api/inspections', U.mgr, {
    vehicle_id: VEH.b.id, mileage: 100, items: [{ item_key: 'tires', label: 'Tires', answer: 'OK', color: 'green' }], capture_token: t5.body.token
  });
  await req('POST', '/api/inspections/photos/' + pb.id + '/reject', U.mgr, { reason: 'blurry' });
  var undo = await req('POST', '/api/inspections/photos/' + pb.id + '/unreject', U.mgr, {});
  eq(undo.status, 200, 'a rejection made by mistake can be undone');
  eq(undo.body.outstanding, 0, 'which clears the block');
  var back = (await pool.query('SELECT status, reject_reason FROM inspection_photos WHERE id = $1', [pb.id])).rows[0];
  eq(back.status, 'ready', 'the photo is accepted again');
  eq(back.reject_reason, null, 'and the reason is cleared');

  await req('POST', '/api/inspections/photos/' + pb.id + '/reject', U.mgr, { reason: 'actually no' });
  var t6 = await req('POST', '/api/inspections/capture-token', U.mgr, { inspection_id: cb.body.id });
  await shoot(U.mgr, t6.body.token, { replaces_photo_id: pb.id });
  var lateUndo = await req('POST', '/api/inspections/photos/' + pb.id + '/unreject', U.mgr, {});
  eq(lateUndo.status, 409, 'once a retake exists the rejection cannot be undone, or both photos would count');

  console.log('\n--- Sweeping abandoned capture sessions ---');
  var t7 = await req('POST', '/api/inspections/capture-token', U.mgr, { vehicle_id: VEH.a.id });
  var abandoned = await shoot(U.mgr, t7.body.token, { item_key: 'lights' });
  var abKey = (await pool.query('SELECT r2_key FROM inspection_photos WHERE id = $1', [abandoned.id])).rows[0].r2_key;
  await pool.query("UPDATE inspection_photos SET created_at = NOW() - interval '5 days' WHERE id = $1", [abandoned.id]);
  var attachedBefore = (await pool.query('SELECT COUNT(*)::int n FROM inspection_photos WHERE inspection_id IS NOT NULL')).rows[0].n;
  await cleanup.purgeOrphanInspectionPhotos();
  var gone = (await pool.query('SELECT COUNT(*)::int n FROM inspection_photos WHERE id = $1', [abandoned.id])).rows[0].n;
  eq(gone, 0, 'a photo shot for an inspection that was never submitted is swept');
  ok(!Object.prototype.hasOwnProperty.call(R2, abKey), 'and its bytes leave the bucket with it');
  var attachedAfter = (await pool.query('SELECT COUNT(*)::int n FROM inspection_photos WHERE inspection_id IS NOT NULL')).rows[0].n;
  eq(attachedAfter, attachedBefore, 'photos that made it onto an inspection are never touched by the sweep');

  console.log('\n' + (FAIL === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + PASS + ' passed, ' + FAIL + ' failed\n');
  server.close();
  await pool.end();
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(function (e) { console.error(e); process.exit(1); });
