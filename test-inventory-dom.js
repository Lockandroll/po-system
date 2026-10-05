// DOM test for the Parts Inventory screens (public/js/inventory.js) and the
// Equipment Replace button + dialog (app.js). The browser code runs in jsdom,
// but its api() goes over HTTP to the REAL routers on a REAL Postgres, so every
// click here exercises the same server path production does.
//
//   DATABASE_URL=... node test-inventory-dom.js
//
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-inventory-dom';
const fs = require('fs');
const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');
const { initDB, pool } = require('./db');

var pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Pull a top-level function out of app.js by brace counting. Only used on the
// small helpers, whose bodies have no braces inside strings.
function fnSrc(src, name) {
  var i = src.indexOf('\nfunction ' + name + '(');
  if (i === -1) throw new Error('no ' + name);
  i++;
  var j = src.indexOf('{', i), depth = 0;
  for (var k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}

async function mkUser(name, role, home, extra, cities) {
  const email = name.toLowerCase().replace(/[^a-z]/g, '') + '@invdom.local';
  const r = await pool.query("INSERT INTO users (email, name, password_hash, role, active, session_epoch, home_city, extra_perms) VALUES ($1,$2,'x',$3,true,0,$4,$5) RETURNING id",
    [email, name, role, home, extra || []]);
  for (var i = 0; i < (cities || []).length; i++) await pool.query('INSERT INTO user_cities (user_id, city_code) VALUES ($1,$2)', [r.rows[0].id, cities[i]]);
  return { id: r.rows[0].id, name: name, role: role, email: email };
}

async function main() {
  await initDB();
  const app = express();
  app.use(express.json());
  app.use('/api/assets', require('./routes/assets'));
  app.use('/api/inventory', require('./routes/inventory'));
  const server = await new Promise(function (r) { const s = app.listen(0, function () { r(s); }); });
  const base = 'http://127.0.0.1:' + server.address().port;

  await pool.query("INSERT INTO cities (name, code, active) VALUES ('Charleston','CHS',true) ON CONFLICT (code) DO NOTHING");
  const mgr = await mkUser('Dom Manager', 'manager', 'CHS', ['view_inventory', 'manage_inventory'], ['CHS']);
  const tech = await mkUser('Dom Tech', 'roadside_technician', 'CHS', ['view_inventory', 'add_inventory']);
  const part = (await pool.query("INSERT INTO parts (item_number, description, price) VALUES ('DOM1','Dom O&#39;Brien blade <b>x</b>',10) RETURNING *")).rows[0];
  const jump = (await pool.query("INSERT INTO asset_types (name, serialized, unit_cost) VALUES ('Dom Jumpbox',false,50) RETURNING *")).rows[0];
  await pool.query("INSERT INTO asset_stock (asset_type_id, city_code, qty_on_hand) VALUES ($1,'CHS',2)", [jump.id]);

  const appSrc = fs.readFileSync('public/js/app.js', 'utf8');
  const invSrc = fs.readFileSync('public/js/inventory.js', 'utf8');
  const helpers = ['escHtml', 'formatDate', 'formatDateTime', 'timeAgo', 'badgeHtml', 'roleLabel', 'assetMoney', 'assetCatTag', 'assetMonths'].map(function (n) { return fnSrc(appSrc, n); }).join('\n');
  const a = appSrc.indexOf('async function renderAssetTechDetail(');
  const b = appSrc.indexOf('async function assetCollect(');
  ok('tech detail + replace block found in app.js', a !== -1 && b > a);
  const replaceBlock = appSrc.slice(a, b);

  function makeWindow(user) {
    const dom = new JSDOM('<!doctype html><html><body><div id="content"></div></body></html>', { runScripts: 'dangerously', url: 'http://localhost/' });
    const w = dom.window;
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
    w.__toasts = [];
    w.__nav = [];
    w.__fetch = function (m, p, body) {
      return fetch(base + '/api' + p, { method: m, headers: Object.assign({ Authorization: 'Bearer ' + token }, body === undefined ? {} : { 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); });
    };
    w.eval(
      'var state = { user: { id: ' + user.id + ', name: ' + JSON.stringify(user.name) + ' }, currentView: null, currentParam: null };\n' +
      'var _perms = ' + JSON.stringify(user.perms || []) + ';\n' +
      'function can(p) { return _perms.indexOf(p) !== -1; }\n' +
      'var icons = { plus: "+", settings: "*", map: "m" }; var NAVI = { swap: "<i>swap</i>", box: "b", truck: "t" };\n' +
      'function showToast(m, t) { __toasts.push([m, t]); }\n' +
      'function navigate(v, p) { __nav.push([v, p]); state.currentView = v; state.currentParam = p; }\n' +
      'var __renders = 0; var __renderFn = null; function render() { __renders++; if (__renderFn) return __renderFn(); }\n' +
      'function api(m, p, body) { return __fetch(m, p, body).then(function (r) { if (r.status >= 400) { var e = new Error((r.j && r.j.error) || ("HTTP " + r.status)); e.data = r.j; e.status = r.status; throw e; } return r.j; }); }\n' +
      'var _novaDrafts = {}; function novaDraftPut(k, v) { _novaDrafts[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); }\n' +
      'function novaDraftGet(k) { return Promise.resolve(_novaDrafts[k] || null); } function novaDraftDel(k) { delete _novaDrafts[k]; return Promise.resolve(); }\n' +
      helpers + '\n' + replaceBlock + '\n' + invSrc
    );
    return w;
  }
  function $(w, sel) { return w.document.querySelector(sel); }
  function click(w, el) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }
  function setVal(w, el, v, evt) { el.value = v; el.dispatchEvent(new w.Event(evt || 'input', { bubbles: true })); }
  async function settle() { await sleep(350); }
  function onclickOf(w, text) {
    return Array.prototype.slice.call(w.document.querySelectorAll('button')).filter(function (x) { return x.textContent.indexOf(text) !== -1; });
  }

  // ===== Tech: My Van, add stock ===========================================
  tech.perms = ['view_inventory', 'add_inventory'];
  var w = makeWindow(tech);
  var el = $(w, '#content');
  w.__renderFn = function () { return w.renderMyVan(el); };
  await w.renderMyVan(el);
  ok('My Van renders title', /My Van/.test(el.innerHTML));
  ok('My Van says only a manager can lower a count', /Only a manager can lower a count/.test(el.innerHTML));
  ok('tech sees Add Stock', onclickOf(w, 'Add Stock').length === 1);
  ok('tech sees no Transfer button', onclickOf(w, 'Transfer').length === 0);
  ok('tech sees no Adjust button', onclickOf(w, 'Adjust').length === 0);
  click(w, onclickOf(w, 'Add Stock')[0]);
  await settle();
  ok('add modal open', !!$(w, '#invt-add-modal'));
  ok('tech add modal has no cost column', !/Unit cost/.test($(w, '#invt-add-modal').innerHTML));
  setVal(w, $(w, '#invt-add-q'), 'DOM1');
  await settle(); await settle();
  var addBtns = $(w, '#invt-add-results').querySelectorAll('button');
  ok('search found the part', addBtns.length === 1, $(w, '#invt-add-results').innerHTML.slice(0, 200));
  ok('part name escaped in results', $(w, '#invt-add-results').innerHTML.indexOf('<b>x</b>') === -1);
  click(w, addBtns[0]);
  ok('one line on the list', w._invt.addLines.length === 1);
  await settle(); await settle();
  ok('draft autosaved', Object.keys(w._novaDrafts).length === 1);
  var qtyIn = $(w, '#invt-add-lines input[type=number]');
  setVal(w, qtyIn, '-4');
  click(w, $(w, '#invt-add-go'));
  await settle();
  ok('client refuses a negative add', /whole number of 1 or more/.test($(w, '#invt-add-err').innerHTML));
  setVal(w, qtyIn, '6');
  click(w, $(w, '#invt-add-go'));
  await settle(); await settle();
  ok('add modal closed after submit', !$(w, '#invt-add-modal'));
  ok('toast says added', w.__toasts.some(function (t) { return /Added 1 part/.test(t[0]); }));
  ok('draft deleted on success', Object.keys(w._novaDrafts).length === 0);
  await settle();
  ok('van now shows 6 on hand', /<td class="text-right mono" style="font-weight:700;color:var\(--text\)">6<\/td>/.test(el.innerHTML));
  ok('activity shows +6 Added', /Added/.test(el.innerHTML) && />\+6</.test(el.innerHTML));
  var db6 = (await pool.query('SELECT SUM(qty_on_hand)::int AS n FROM part_stock WHERE part_id = $1', [part.id])).rows[0].n;
  ok('database has 6', db6 === 6);

  // Restore-draft offer when reopening with an unsent list.
  w._novaDrafts['inv-add:' + w._invt.cfg.my_van.id + ':' + tech.id] = { lines: [{ part_id: part.id, description: 'x', qty: 2, unit_cost: '' }], note: 'hi' };
  click(w, onclickOf(w, 'Add Stock')[0]);
  await settle();
  ok('reopen offers Restore draft', !!$(w, '#invt-add-restore'));
  click(w, $(w, '#invt-add-restore'));
  ok('restore puts the line back', w._invt.addLines.length === 1 && w._invt.addLines[0].qty === 2);
  ok('restore puts the note back', $(w, '#invt-add-note').value === 'hi');
  $(w, '#invt-add-modal').remove();

  // ===== Manager: All Stock, adjust, transfer, by location, settings =========
  mgr.perms = ['view_inventory', 'manage_inventory'];
  var m = makeWindow(mgr);
  var mel = $(m, '#content');
  m.__renderFn = function () { return m.renderInventory(mel); };
  await m.renderInventory(mel);
  await settle();
  ok('All Stock renders', /Inventory/.test(mel.innerHTML) && /Value on hand/.test(mel.innerHTML));
  ok('says tools live under Equipment', /Company tools live under Equipment/.test(mel.innerHTML));
  ok('row for the van appears', /Dom Tech&#39;s Van|Dom Tech's Van/.test(mel.innerHTML));
  ok('value $60.00 shown', /\$60\.00/.test(mel.innerHTML));
  click(m, onclickOf(m, 'Adjust')[0]);
  ok('adjust modal open', !!$(m, '#invt-adj-modal'));
  setVal(m, $(m, '#invt-adj-to'), '4');
  click(m, onclickOf(m, 'Save adjustment')[0]);
  await settle();
  ok('adjust without reason shows the error', /Write down why/.test($(m, '#invt-adj-err').innerHTML));
  setVal(m, $(m, '#invt-adj-note'), 'counted, 2 short');
  click(m, onclickOf(m, 'Save adjustment')[0]);
  await settle(); await settle();
  ok('adjust modal closed', !$(m, '#invt-adj-modal'));
  var d4 = (await pool.query('SELECT qty_on_hand FROM part_stock WHERE part_id = $1', [part.id])).rows[0].qty_on_hand;
  ok('database now 4', d4 === 4);

  // Transfer van -> shelf through the dialog.
  click(m, onclickOf(m, 'Transfer')[0]);
  await settle(); await settle();
  ok('transfer modal open', !!$(m, '#invt-xfer-modal'));
  var locs = m._invt.xfer.locs;
  var vanLoc = locs.filter(function (l) { return l.kind === 'van' && l.user_id === tech.id; })[0];
  var shelfLoc = locs.filter(function (l) { return l.kind === 'shelf'; })[0];
  setVal(m, $(m, '#invt-xfer-from'), String(vanLoc.id), 'change');
  await settle(); await settle();
  $(m, '#invt-xfer-to').value = String(shelfLoc.id);
  ok('transfer lists the van part', !!$(m, '#invt-xfer-q-0'));
  setVal(m, $(m, '#invt-xfer-q-0'), '1');
  click(m, onclickOf(m, 'Move it')[0]);
  await settle(); await settle();
  ok('transfer done toast', m.__toasts.some(function (t) { return /Transfer PT-/.test(t[0]); }));
  var sh = (await pool.query('SELECT qty_on_hand FROM part_stock WHERE part_id = $1 AND location_id = $2', [part.id, shelfLoc.id])).rows[0];
  ok('shelf received 1', sh && sh.qty_on_hand === 1);

  await m.renderInventoryLocations(mel);
  ok('By Location shows CHS heading and shelf card', /CHS/.test(mel.innerHTML) && /CHS Shelf/.test(mel.innerHTML) && /City shelf/.test(mel.innerHTML));
  await m.renderInventoryLocation(mel, shelfLoc.id);
  ok('location page has Back, Transfer, Add Stock', onclickOf(m, 'Back').length === 1 && onclickOf(m, 'Transfer').length === 1 && onclickOf(m, 'Add Stock').length === 1);
  ok('location activity shows Transfer in', /Transfer in/.test(mel.innerHTML));
  await m.renderInventorySettings(mel);
  await settle();
  ok('part settings lists the part', /DOM1/.test(mel.innerHTML));
  var sel = mel.querySelector('#invs-table select');
  setVal(m, sel, 'battery', 'change');
  await settle();
  var cat = (await pool.query('SELECT category FROM parts WHERE id = $1', [part.id])).rows[0].category;
  ok('category saved from the dropdown', cat === 'battery');

  // A tech forced onto a manager screen gets the server's 403 rendered.
  var t2 = makeWindow(tech);
  await t2.renderInventory($(t2, '#content'));
  ok('tech on All Stock sees an error, not data', /alert-error/.test($(t2, '#content').innerHTML));

  // ===== Equipment: Replace button and dialog =============================
  const r = await fetch(base + '/api/assets/acks', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt.sign({ id: mgr.id, name: mgr.name, email: mgr.email, role: 'manager', se: 0 }, process.env.JWT_SECRET), 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: tech.id, city_code: 'CHS', lines: [{ asset_type_id: jump.id, qty: 1 }] }) });
  ok('assigned a jumpbox', r.status === 201);
  mgr.perms = ['view_assets', 'manage_assets'];
  var e = makeWindow(mgr);
  var eel = $(e, '#content');
  e.__renderFn = function () { return e.renderAssetTechDetail(eel, tech.id); };
  await e.renderAssetTechDetail(eel, tech.id);
  var rep = onclickOf(e, 'Replace');
  ok('Replace button on the row', rep.length === 1);
  ok('Collect button still there', onclickOf(e, 'Collect').length === 1);
  click(e, rep[0]);
  await settle();
  var modal = $(e, '#asset-replace-modal');
  ok('replace dialog open', !!modal);
  ok('dialog shows the shelf count', /CHS shelf:<\/strong> 1 on hand/.test(modal.innerHTML));
  ok('dialog offers Replace now and Order instead', onclickOf(e, 'Replace now').length === 1 && onclickOf(e, 'Order instead').length === 1);
  setVal(e, $(e, '#arp-reason'), 'lost', 'change');
  e.assetReplaceReasonChanged();
  ok('lost hides the handed-in box', $(e, '#arp-handed-wrap').style.display === 'none' && $(e, '#arp-handed').checked === false);
  setVal(e, $(e, '#arp-reason'), 'broken', 'change');
  e.assetReplaceReasonChanged();
  ok('broken shows it again, ticked', $(e, '#arp-handed-wrap').style.display === '' && $(e, '#arp-handed').checked === true);
  setVal(e, $(e, '#arp-notes'), 'cracked');
  click(e, onclickOf(e, 'Replace now')[0]);
  await settle(); await settle();
  ok('dialog closed', !$(e, '#asset-replace-modal'));
  ok('toast names the new ack', e.__toasts.some(function (t) { return /Replaced\. AA-/.test(t[0]); }));
  ok('page re-rendered', e.__renders >= 1);
  await settle();
  ok('history now lists the broken one', /broken/.test(eel.innerHTML));
  var held = (await pool.query("SELECT COUNT(*)::int AS n FROM asset_holdings WHERE user_id = $1 AND asset_type_id = $2 AND returned_at IS NULL", [tech.id, jump.id])).rows[0].n;
  ok('tech still holds exactly one jumpbox', held === 1);

  // Shelf is now empty: the dialog switches to the request path.
  click(e, onclickOf(e, 'Replace')[0]);
  await settle();
  modal = $(e, '#asset-replace-modal');
  ok('empty shelf: warning shown', /Not enough to swap it now/.test(modal.innerHTML));
  ok('empty shelf: no Replace now button', onclickOf(e, 'Replace now').length === 0);
  click(e, onclickOf(e, 'Send replacement request')[0]);
  await settle(); await settle();
  ok('request toast', e.__toasts.some(function (t) { return /Request RR-/.test(t[0]); }));
  var rq = (await pool.query("SELECT COUNT(*)::int AS n FROM asset_requests WHERE user_id = $1 AND status = 'pending'", [tech.id])).rows[0].n;
  ok('pending request created', rq === 1);

  server.close();
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
