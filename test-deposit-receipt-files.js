process.env.JWT_SECRET = 'x';
var path = require('path');
var deleted = [], heads = {};
var r2p = require.resolve('./utils/r2');
require.cache[r2p] = { id: r2p, filename: r2p, loaded: true, exports: {
  configured: function () { return true; },
  presignUpload: async function (k) { heads[k] = { size: 1234 }; return 'https://r2.test/put/' + k; },
  presignDownload: async function (k, n, inline) { return 'https://r2.test/get/' + k + '?inline=' + inline; },
  headObject: async function (k) { return heads[k] || null; },
  deleteObject: async function (k) { deleted.push(k); },
  getObjectBuffer: async function () { return null; }, putObject: async function () {}
}};
var express = require('express'); var jwt = require('jsonwebtoken');
var { pool } = require('./db');
var pass = 0, fail = 0;
function ok(c, m, x) { if (c) pass++; else { fail++; console.log('FAIL', m, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); } }
(async function () {
  await pool.query("INSERT INTO cities (name, code) VALUES ('Orlando','ORL') ON CONFLICT (code) DO NOTHING");
  async function mk(name, role) { return (await pool.query("INSERT INTO users (name,email,password_hash,role,active) VALUES ($1,$2,'x',$3,true) RETURNING id", [name, name.replace(/ /g,'') + Math.random() + '@t.t', role])).rows[0].id; }
  var A = await mk('Ada Admin', 'admin'), J = await mk('Dan Tech', 'locksmith'), K = await mk('Other Tech', 'locksmith');
  var TA = jwt.sign({ id: A, role: 'admin' }, 'x'), TJ = jwt.sign({ id: J, role: 'locksmith' }, 'x'), TK = jwt.sign({ id: K, role: 'locksmith' }, 'x');
  var app = express(); app.use(express.json({ limit: '20mb' })); app.use('/api/deposits', require('./routes/deposits'));
  var srv = app.listen(0); var base = 'http://127.0.0.1:' + srv.address().port + '/api';
  async function call(m, p, t, b) { var r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); var j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j: j }; }
  var up = await call('POST', '/deposits/expense-file/upload-url', TJ, { file_name: 'bank receipt.pdf', mime_type: 'application/pdf' });
  ok(up.s === 200 && up.j.file_key, 'tech gets upload url', up.j);
  var photo = 'data:image/jpeg;base64,/9j/AAAA';
  var body = { amount: '250.00', pulsar_owed: '250.00', deposit_date: '2026-09-28', period_start: '2026-09-21', period_end: '2026-09-27', city_code: 'ORL',
    receipts: [{ image: photo, filename: 'slip.jpg' }, { file_key: up.j.file_key, file_name: 'bank receipt.pdf', file_mime: 'application/pdf', file_size: 99 }], expenses: [], idempotency_key: 'k1' };
  var c = await call('POST', '/deposits', TJ, body); ok(c.s === 201, 'create with photo + file', c.j);
  var id = c.j.id;
  var g = await call('GET', '/deposits/' + id, TJ); var rc = g.j.receipts;
  ok(rc.length === 2 && rc[0].image === photo && !rc[0].file_name, 'photo receipt intact', rc);
  ok(!rc[1].image && rc[1].file_name === 'bank receipt.pdf' && rc[1].file_mime === 'application/pdf' && String(rc[1].file_size) === '1234' && rc[1].file_key === undefined, 'file receipt returned without key, size from R2 head', rc[1]);
  var lnk = await call('GET', '/deposits/' + id + '/receipts/' + rc[1].id + '/file?inline=1', TJ);
  ok(lnk.s === 200 && /inline=true/.test(lnk.j.url) && lnk.j.url.indexOf(up.j.file_key) !== -1, 'owner gets file link', lnk.j);
  ok((await call('GET', '/deposits/' + id + '/receipts/' + rc[1].id + '/file', TK)).s === 403, 'other tech blocked from link');
  ok((await call('GET', '/deposits/' + id + '/receipts/' + rc[0].id + '/file', TJ)).s === 404, 'photo row has no file link');
  // file-only deposit
  var up2 = await call('POST', '/deposits/expense-file/upload-url', TJ, { file_name: 'scan.pdf', mime_type: 'application/pdf' });
  var c2 = await call('POST', '/deposits', TJ, Object.assign({}, body, { amount: '100.00', idempotency_key: 'k2', receipts: [{ file_key: up2.j.file_key, file_name: 'scan.pdf', file_mime: 'application/pdf' }] }));
  ok(c2.s === 201, 'file-only receipt deposit', c2.j);
  // forged key (another user's prefix) rejected
  var upK = await call('POST', '/deposits/expense-file/upload-url', TK, { file_name: 'x.pdf', mime_type: 'application/pdf' });
  var c3 = await call('POST', '/deposits', TJ, Object.assign({}, body, { amount: '77.00', idempotency_key: 'k3', receipts: [{ file_key: upK.j.file_key, file_name: 'x.pdf' }] }));
  ok(c3.s === 400 && /verified/.test(c3.j.error), 'someone else\'s key rejected', c3.j);
  // never-uploaded key rejected
  var c4 = await call('POST', '/deposits', TJ, Object.assign({}, body, { amount: '78.00', idempotency_key: 'k4', receipts: [{ file_key: 'deposits/expenses/' + J + '/00000000-0000-0000-0000-000000000000/n.pdf', file_name: 'n.pdf' }] }));
  ok(c4.s === 400 && /finish uploading/.test(c4.j.error), 'missing object rejected', c4.j);
  // edit: admin drops the file receipt, adds a new file
  var upA = await call('POST', '/deposits/expense-file/upload-url', TA, { file_name: 'new.pdf', mime_type: 'application/pdf' });
  var e = await call('PUT', '/deposits/' + id, TA, { amount: '250.00', pulsar_owed: '250.00', deposit_date: '2026-09-28', period_start: '2026-09-21', period_end: '2026-09-27', city_code: 'ORL', expenses: [],
    receipts_keep: [rc[0].id], receipts_add: [{ file_key: upA.j.file_key, file_name: 'new.pdf', file_mime: 'application/pdf', file_size: 5 }, { image: photo, filename: 'b.jpg' }] });
  ok(e.s === 200, 'edit save', e.j);
  var g2 = await call('GET', '/deposits/' + id, TA);
  var names = g2.j.receipts.map(function (r) { return r.file_name || r.filename; });
  ok(g2.j.receipts.length === 3 && names.indexOf('new.pdf') !== -1 && names.indexOf('bank receipt.pdf') === -1, 'edit kept photo, dropped old file, added file + photo', names);
  ok(deleted.indexOf(up.j.file_key) !== -1, 'dropped file removed from R2', deleted);
  // delete deposit cleans receipt file objects
  var dl = await call('DELETE', '/deposits/' + id, TA); ok(dl.s === 200, 'delete', dl.j);
  ok(deleted.indexOf(upA.j.file_key) !== -1, 'delete cleans receipt file from R2', deleted);
  srv.close(); await pool.end();
  console.log('PASS', pass, 'FAIL', fail); process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
