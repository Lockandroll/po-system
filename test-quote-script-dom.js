// Dispatch Quote Script: DOM smoke test for public/js/quoteScript.js.
//
// Evaluates the real module in jsdom, with api() wired to the REAL router over
// HTTP against a real Postgres (same DATABASE_URL as test-quote-script.js, run
// that one first so the seed and a few prices exist). So a click in the panel
// goes all the way to the engine and back, and what the dispatcher would read
// is asserted on the rendered page.
//
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-quote-script';
const fs = require('fs');
const path = require('path');
const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');
const { initDB, pool } = require('./db');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
  console.log('Quote script DOM tests');
  console.log('----------------------');
  await initDB();
  await pool.query("DELETE FROM users WHERE email LIKE '%@quotedom.local'");
  await pool.query("DELETE FROM cities WHERE code = 'TSD'");
  await pool.query("INSERT INTO cities (name, code, active) VALUES ('Domtown','TSD',true)");
  await pool.query("DELETE FROM quote_rate_cards WHERE TRIM(city_code) = 'TSD'");
  await pool.query("INSERT INTO quote_rate_cards (city_code, category, first_hour, addl_hour) VALUES ('TSD','residential',119.99,89.99)");
  const rk = (await pool.query("SELECT id FROM quote_tasks WHERE code = 'RES_REKEY'")).rows[0].id;
  await pool.query("DELETE FROM quote_flat_prices WHERE TRIM(city_code) = 'TSD'");
  await pool.query("DELETE FROM quote_unit_prices WHERE TRIM(city_code) = 'TSD'");
  await pool.query("INSERT INTO quote_flat_prices (task_id, city_code, package_price) VALUES ($1,'TSD',138.99)", [rk]);
  await pool.query("INSERT INTO quote_unit_prices (task_id, unit_code, city_code, addl_price) VALUES ($1,'keyway','TSD',29.99), ($1,'key','TSD',4.99)", [rk]);
  function mk(name, role, extra) {
    return pool.query("INSERT INTO users (email, name, password_hash, role, active, session_epoch, extra_perms) VALUES ($1,$2,'x',$3,true,0,$4) RETURNING id",
      [name.toLowerCase().replace(/\s+/g, '.') + '@quotedom.local', name, role, extra || []]).then(function (r) { return { id: r.rows[0].id, name: name, role: role }; });
  }
  const disp = await mk('Dom Dispatch', 'dispatcher', ['use_quote_script']);
  const admin = await mk('Dom Admin', 'admin');

  const app = express();
  app.use(express.json());
  app.use('/api/quote-script', require('./routes/quoteScript'));
  app.use(function (err, req, res, next) { console.error(err); res.status(500).json({ error: err.message }); });
  const server = await new Promise(function (resolve) { const s = app.listen(0, function () { resolve(s); }); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api';

  async function makeDom(user) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="content"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const token = jwt.sign({ id: user.id, name: user.name, email: 'x@quotedom.local', role: user.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
    w.__toasts = [];
    w.__drafts = {};
    w.__nav = [];
    w.__fetch = function (method, p, body) {
      return fetch(base + p, { method: method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j && j.error || ('HTTP ' + r.status)); throw e; } return j; }); });
    };
    w.eval(
      'var state = { user: { id: ' + user.id + ', name: ' + JSON.stringify(user.name) + ', role: ' + JSON.stringify(user.role) + ' } };' +
      'var PERMS = ' + JSON.stringify(user.role === 'admin' ? ['*'] : ['use_quote_script']) + ';' +
      'function can(p) { return PERMS[0] === "*" || PERMS.indexOf(p) !== -1; }' +
      'function api(m, p, b) { return window.__fetch(m, p, b); }' +
      'function escHtml(s) { return String(s === null || s === undefined ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\'/g,"&#39;"); }' +
      'function showToast(m, t) { window.__toasts.push((t || "info") + ":" + m); }' +
      'function navigate(v) { window.__nav.push(v); }' +
      'function novaDraftPut(k, v) { window.__drafts[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); }' +
      'function novaDraftGet(k) { return Promise.resolve(window.__drafts[k] || null); }' +
      'function novaDraftDel(k) { delete window.__drafts[k]; return Promise.resolve(); }'
    );
    w.eval(fs.readFileSync(path.join(__dirname, 'public/js/quoteScript.js'), 'utf8'));
    return w;
  }
  function text(w, sel) { var e = w.document.querySelector(sel); return e ? e.textContent.replace(/\s+/g, ' ') : ''; }
  function clickOpt(w, label) {
    var opts = Array.prototype.slice.call(w.document.querySelectorAll('#qs-tasks .qs-opt'));
    var o = opts.filter(function (x) { return x.textContent.indexOf(label) !== -1; })[0];
    // runScripts:'outside-only' does not fire inline onclick attributes, so run
    // the handler text itself, exactly as the browser would.
    if (o) w.eval(o.getAttribute('onclick'));
    return !!o;
  }
  function clickBtn(w, scope, label) {
    var b = Array.prototype.slice.call(w.document.querySelectorAll(scope + ' button')).filter(function (x) { return x.textContent.trim() === label; })[0];
    if (b) b.click();
    return !!b;
  }

  // ---- dispatcher panel --------------------------------------------------------
  const w = await makeDom(disp);
  await w.renderQuoteScript(w.document.getElementById('content'));
  await sleep(150);
  ok('panel renders three columns', !!w.document.getElementById('qs-left') && !!w.document.getElementById('qs-tasks') && !!w.document.getElementById('qs-answer'));
  ok('no manage buttons for a dispatcher', text(w, '.page-header').indexOf('Pricing') === -1);
  w.document.getElementById('qs-city').value = 'TSD';
  await w.qsSetCity('TSD');
  await sleep(150);
  ok('residential tab enabled in TSD', !w.document.querySelectorAll('.qs-cat')[0].disabled);
  ok('commercial tab disabled (no commercial card in TSD)', w.document.querySelectorAll('.qs-cat')[1].disabled);
  ok('task list grouped', text(w, '#qs-tasks').indexOf('LOCKOUTS') !== -1 || text(w, '#qs-tasks').indexOf('Lockouts') !== -1);
  ok('lockout shows first-hour lead price', text(w, '#qs-tasks').indexOf('1st hr $119.99') !== -1, text(w, '#qs-tasks').slice(0, 200));
  ok('picked a task', clickOpt(w, 'House lockout'));
  await sleep(400);
  var ans = text(w, '#qs-answer');
  ok('answer shows the first hour', ans.indexOf('$119.99') !== -1 && ans.indexOf('plus tax') !== -1, ans.slice(0, 200));
  ok('answer shows each additional hour', ans.indexOf('$89.99') !== -1);
  ok('answer shows the rekey upsell', ans.indexOf('$138.99') !== -1 && ans.indexOf('Upsell') !== -1);
  ok('answer shows the surcharge disclosure', ans.indexOf('processing surcharge') !== -1);
  ok('ASAP close shown by default', ans.indexOf('technician there in') !== -1);
  w.qsClose('scheduled');
  ok('scheduled close toggles', text(w, '#qs-answer').indexOf('What day and time') !== -1);
  ok('draft autosaves after picking a task', await (async function () { await sleep(600); return !!w.__drafts['quote-script:' + disp.id]; })());

  // Rekey with quantities.
  ok('picked rekey', clickOpt(w, 'Residential rekey'));
  await sleep(300);
  w.qsQty('keyway', 1); w.qsQty('keyway', 1); w.qsQty('key', 1);
  await sleep(500);
  ans = text(w, '#qs-answer');
  ok('rekey total updates with quantities (203.96)', ans.indexOf('$203.96') !== -1, ans.slice(0, 200));
  ok('rekey wording reads 4 keyways and 3 keys', ans.indexOf('4 keyways and 3 keys') !== -1);

  // Decline needs a reason.
  w.qsStep('declined');
  w.qsSaveOutcome();
  await sleep(100);
  ok('declined without a reason is blocked', w.__toasts.some(function (t) { return t.indexOf('Pick a reason') !== -1; }));
  w.qsReason(0);
  await w.qsSaveOutcome();
  await sleep(300);
  ok('quote logged toast', w.__toasts.some(function (t) { return t.indexOf('success:Quote logged') === 0; }), w.__toasts.join(' | '));
  ok('draft cleared after logging', !w.__drafts['quote-script:' + disp.id]);
  ok('panel reset for the next call', !w._qs.taskId && w._qs.city === 'TSD');
  var logged = (await pool.query("SELECT total, outcome, decline_reason FROM dispatch_quotes WHERE created_by = $1 ORDER BY id DESC LIMIT 1", [disp.id])).rows[0];
  ok('row saved with the server total', logged && Number(logged.total) === 203.96 && logged.outcome === 'declined' && logged.decline_reason === 'Too expensive', JSON.stringify(logged));
  await sleep(200);
  ok('recent quotes list shows it', text(w, '#qs-recent').indexOf('Residential rekey') !== -1 && text(w, '#qs-recent').indexOf('Declined') !== -1);

  // Callback then booked from the recent list.
  clickOpt(w, 'House lockout'); await sleep(300);
  w.qsStep('callback'); await w.qsSaveOutcome(); await sleep(300);
  var cb = (await pool.query("SELECT id FROM dispatch_quotes WHERE created_by = $1 AND outcome = 'callback' ORDER BY id DESC LIMIT 1", [disp.id])).rows[0];
  ok('callback logged', !!cb);
  await w.qsRecentOutcome(cb.id, 'booked_asap');
  ok('callback re-marked booked', (await pool.query('SELECT outcome FROM dispatch_quotes WHERE id = $1', [cb.id])).rows[0].outcome === 'booked_asap');

  // Draft restore.
  clickOpt(w, 'House lockout'); await sleep(200);
  w.qsSaveDraftNow();
  const w2 = await makeDom(disp);
  w2.__drafts = w.__drafts;
  await w2.renderQuoteScript(w2.document.getElementById('content'));
  await sleep(200);
  ok('restore-draft banner offered', text(w2, '#qs-draft').indexOf('Restore draft') !== -1, text(w2, '#qs-draft'));
  await w2.qsRestoreDraft();
  await sleep(500);
  ok('draft restored the task and price', text(w2, '#qs-answer').indexOf('$119.99') !== -1);

  // ---- admin screens ------------------------------------------------------------
  const a = await makeDom(admin);
  await a.renderQuotePricing(a.document.getElementById('content'));
  await sleep(200);
  ok('pricing screen renders rate cards', !!a.document.getElementById('qa-rc-TSD-residential-first'));
  ok('TSD residential shows its rate', a.document.getElementById('qa-rc-TSD-residential-first').value === '119.99');
  a.document.getElementById('qa-rc-TSD-commercial-first').value = '149.99';
  a.document.getElementById('qa-rc-TSD-commercial-addl').value = '109.99';
  await a.qaSaveRates();
  await sleep(200);
  ok('commercial card saved from the screen', (await pool.query("SELECT first_hour FROM quote_rate_cards WHERE TRIM(city_code)='TSD' AND category='commercial'")).rows.length === 1);
  a.qaTab('tasks');
  a._qa.city = 'TSD'; a.qaRender();
  ok('tasks tab lists tasks', text(a, '#qa-body').indexOf('Residential rekey') !== -1);
  a.qaPickTask(rk);
  ok('task editor opens with the package price', a.document.getElementById('qa-t-pkg').value === '138.99');
  a.document.getElementById('qa-t-pkg').value = '139.99';
  a.qaAddUnit();
  ok('adding a unit keeps the typed package price', a.document.getElementById('qa-t-pkg').value === '139.99');
  a.qaRemoveUnit(2);
  await a.qaSaveTask();
  await sleep(300);
  ok('flat price saved from the editor', Number((await pool.query("SELECT package_price FROM quote_flat_prices WHERE task_id=$1 AND TRIM(city_code)='TSD'", [rk])).rows[0].package_price) === 139.99);
  a.qaTab('scripts');
  ok('scripts tab renders every block', a.document.querySelectorAll('.qa-block').length >= 12);
  a.qaTab('settings');
  ok('settings tab shows the parts line', a.document.getElementById('qa-s-parts').value.indexOf('$4') !== -1);
  a.qaTab('accounts');
  ok('account tab renders search', text(a, '#qa-body').indexOf('Find an account') !== -1 || !!a.document.querySelector('#qa-body input'));

  await a.renderQuoteReport(a.document.getElementById('content'));
  await sleep(200);
  ok('report renders totals', text(a, '#qr-body').indexOf('Quotes') !== -1 && text(a, '#qr-body').indexOf('Decline reasons') !== -1);

  // Access denied paths.
  const d3 = await makeDom(disp);
  await d3.renderQuotePricing(d3.document.getElementById('content'));
  ok('dispatcher sees access denied on pricing', text(d3, '#content').indexOf('Access denied') !== -1);

  server.close();
  await pool.end();
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
