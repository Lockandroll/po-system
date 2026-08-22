// DOM assertions for the Document Vault list, focused on the Expiration column.
// Slices the ACTUAL shipped source out of public/js/app.js and runs it in jsdom,
// so a broken string concat or a column that stops lining up shows up here.
var fs = require('fs');
var path = require('path');

var lines = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8').split(/\r?\n/);
function slice(startsWith, endsWith) {
  var a = lines.findIndex(function (l) { return l.indexOf(startsWith) === 0; });
  var b = lines.findIndex(function (l) { return l.indexOf(endsWith) === 0; });
  if (a < 0 || b < 0 || b <= a) { console.error('could not locate the block: ' + startsWith); process.exit(2); }
  return lines.slice(a, b).join('\n');
}
// The list itself, then the expiration helpers that sit further down the file.
var block = slice('var docClipboard = null;', 'function docReload()') + '\n\n' +
            slice('// ---- Document expiration ----', 'function docSetExpiry(');
['function renderDocuments', 'function docExpiryCell', 'function docExpiryBadge', 'function docMenu'].forEach(function (n) {
  if (block.indexOf(n) === -1) { console.error('block missed ' + n); process.exit(2); }
});

var { JSDOM } = require('jsdom');

var pass = 0, fail = 0, failures = [];
function ok(n, c, x) { if (c) pass++; else { fail++; failures.push(n + (x !== undefined ? ' :: ' + String(JSON.stringify(x)).slice(0, 400) : '')); } }
function eq(n, a, b) { ok(n, a === b, { got: a, want: b }); }
function has(n, h, x) { ok(n, String(h).indexOf(x) !== -1, { want: x }); }
function hasnt(n, h, x) { ok(n, String(h).indexOf(x) === -1, { notWant: x }); }

var dom = new JSDOM('<!doctype html><html><body><div id="content"></div></body></html>', { runScripts: 'outside-only' });
var w = dom.window;

var shim = [
  "function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'); }",
  "var state = { user: { id: 1, role: 'admin', isOwner: false }, currentParam: null };",
  "var __resp = null; var __calls = [];",
  "async function api(m,p,b){ __calls.push(m+' '+p); return __resp; }",
  "function navigate(){}",
  "function novaAlert(){ return Promise.resolve(); }",
  "function novaPrompt(){ return Promise.resolve(''); }",
  "function showToast(){}"
].join('\n');
w.eval(shim + '\n' + block);

function iso(offsetDays) {
  var d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2);
}
function fmt(offsetDays) {
  var d = new Date(iso(offsetDays) + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}
function file(over) {
  return Object.assign({ id: 7, name: 'General COI.pdf', mime_type: 'application/pdf', size_bytes: 22630,
    owner_name: 'Tony McKeon', mine: true, canEdit: true, emailable: false, shareCount: 0,
    expires_on: null, reminder_lead_num: 2, reminder_lead_unit: 'weeks' }, over || {});
}
function payload(over) {
  return Object.assign({ folder: null, ancestors: [], canWriteHere: true, storageReady: true,
    folders: [], files: [] }, over || {});
}
async function draw(data) {
  w.eval('__resp = ' + JSON.stringify(data) + ';');
  var el = w.document.getElementById('content');
  await w.renderDocuments(el);
  return el;
}
function rowsOf(el) {
  var card = el.querySelector('#doc-droparea .card-body');
  return Array.prototype.slice.call(card.children);
}

(async function () {
  // ---- 1. header ----
  var el = await draw(payload({ files: [file()] }));
  var head = rowsOf(el)[0];
  has('header: labels Name', head.textContent, 'Name');
  has('header: labels Expiration', head.textContent, 'Expiration');
  has('header: labels Size', head.textContent, 'Size');
  has('header: labels Owner', head.textContent, 'Owner');
  eq('header: five cells', head.children.length, 5);
  eq('header: expiration is the 2nd cell', head.children[1].textContent, 'Expiration');
  ok('header: expiration hides on phones', head.children[1].className.indexOf('doc-hide-sm') !== -1);

  // ---- 2. column alignment: every row has the same cell count as the header ----
  var el2 = await draw(payload({
    folders: [{ id: 3, name: 'Forms', owner_name: 'Ben Landers', mine: false, canEdit: true, shareCount: 0 }],
    files: [file(), file({ id: 8, name: 'W-9.pdf', canEdit: false })]
  }));
  var rs = rowsOf(el2);
  eq('rows: header + folder + 2 files', rs.length, 4);
  eq('folder row: same cell count as the header', rs[1].children.length, 5);
  eq('file row: same cell count as the header', rs[2].children.length, 5);
  ['1','2','3'].forEach(function (i) {
    var r = rs[Number(i)];
    eq('row ' + i + ': expiration cell width matches header', r.children[1].style.width, head.children[1].style.width);
    eq('row ' + i + ': size cell width matches header', r.children[2].style.width, head.children[2].style.width);
    eq('row ' + i + ': owner cell width matches header', r.children[3].style.width, head.children[3].style.width);
    eq('row ' + i + ': action cell reserves the same room as the header', r.children[4].className, head.children[4].className);
  });
  eq('action column reserves room via .doc-actcol (phones give it back)', head.children[4].className, 'doc-actcol');
  ok('header itself is hidden on phones, where only Name survives', head.className.indexOf('doc-hide-sm') !== -1, head.className);
  eq('folder row: expiration cell is blank', rs[1].children[1].textContent.trim(), '');

  // ---- 3. no expiration ----
  var cell = rs[2].children[1];
  eq('no expiry: shows a dash', cell.textContent.trim(), '—');
  has('no expiry: editor can click to set one', cell.getAttribute('title'), 'Click to set one');
  has('no expiry: opens the picker', cell.getAttribute('onclick') || '', 'docSetExpiry(7)');
  var ro = rs[3].children[1];
  eq('no expiry, view-only: still a dash', ro.textContent.trim(), '—');
  eq('no expiry, view-only: not clickable', ro.getAttribute('onclick'), null);
  eq('no expiry, view-only: no pointer cursor', ro.style.cursor, '');

  // ---- 4. a date far in the future ----
  var el4 = await draw(payload({ files: [file({ expires_on: iso(400) })] }));
  var c4 = rowsOf(el4)[1].children[1];
  eq('future: prints the date', c4.textContent.trim(), fmt(400));
  eq('future: muted, not alarming', c4.style.color, 'var(--text-muted-color)');
  eq('future: not bold', c4.style.fontWeight, '');
  has('future: title says Expires', c4.getAttribute('title'), 'Expires');
  hasnt('future: no badge next to the name', rowsOf(el4)[1].children[0].innerHTML, 'doc-badge');

  // ---- 5. inside the reminder lead time (2 weeks) ----
  var el5 = await draw(payload({ files: [file({ expires_on: iso(5) })] }));
  var r5 = rowsOf(el5)[1];
  eq('expiring: amber', r5.children[1].style.color, 'rgb(234, 179, 8)');
  eq('expiring: bold', r5.children[1].style.fontWeight, '600');
  eq('expiring: prints the date', r5.children[1].textContent.trim(), fmt(5));
  has('expiring: title explains', r5.children[1].getAttribute('title'), 'Expiring soon');
  hasnt('expiring: tooltip is not double-escaped', r5.children[1].getAttribute('title'), '&');
  has('expiring: phone badge kept as the small-screen fallback', r5.children[0].innerHTML, 'doc-badge doc-show-sm');

  // ---- 5b. outside the lead time is NOT amber ----
  var el5b = await draw(payload({ files: [file({ expires_on: iso(20) })] }));
  eq('lead time respected: 20 days out with a 2-week lead is muted', rowsOf(el5b)[1].children[1].style.color, 'var(--text-muted-color)');
  var el5c = await draw(payload({ files: [file({ expires_on: iso(20), reminder_lead_num: 1, reminder_lead_unit: 'months' })] }));
  eq('lead time respected: same date with a 1-month lead is amber', rowsOf(el5c)[1].children[1].style.color, 'rgb(234, 179, 8)');

  // ---- 6. expired ----
  var el6 = await draw(payload({ files: [file({ expires_on: iso(-3) })] }));
  var r6 = rowsOf(el6)[1];
  eq('expired: red', r6.children[1].style.color, 'rgb(239, 68, 68)');
  eq('expired: bold', r6.children[1].style.fontWeight, '600');
  eq('expired: prints the date', r6.children[1].textContent.trim(), fmt(-3));
  has('expired: title says Expired', r6.children[1].getAttribute('title'), 'Expired');
  has('expired: phone badge kept', r6.children[0].innerHTML, 'doc-badge doc-show-sm');

  // ---- 6b. today counts as expired ----
  var el6b = await draw(payload({ files: [file({ expires_on: iso(0) })] }));
  eq('today: treated as expired', rowsOf(el6b)[1].children[1].style.color, 'rgb(239, 68, 68)');

  // ---- 7. junk date does not blow up the row ----
  var el7 = await draw(payload({ files: [file({ expires_on: 'not-a-date' })] }));
  eq('junk date: falls back to a dash', rowsOf(el7)[1].children[1].textContent.trim(), '—');
  eq('junk date: row still has all its cells', rowsOf(el7)[1].children.length, 5);

  // ---- 8. empty folder keeps its empty state, with no stray header ----
  var el8 = await draw(payload({ files: [], folders: [] }));
  has('empty: says so', el8.textContent, 'This folder is empty.');
  hasnt('empty: no column headings over nothing', el8.textContent, 'Expiration');

  // ---- 9. the rest of the row survived ----
  var el9 = await draw(payload({ files: [file({ name: 'Release_of_Liability_.pdf', size_bytes: 133632, emailable: true, expires_on: iso(30) })] }));
  var r9 = rowsOf(el9)[1];
  has('row: still shows the name', r9.children[0].textContent, 'Release_of_Liability_.pdf');
  has('row: still shows the size', r9.children[2].textContent, 'KB');
  has('row: still shows the owner', r9.children[3].textContent, 'Tony McKeon');
  has('row: still has the download button', r9.children[4].innerHTML, 'Download');
  has('row: still has the calendar button', r9.children[4].innerHTML, 'Set expiration');
  has('row: email badge intact', r9.children[0].innerHTML, '>email<');

  // ---- 10. escaping ----
  var el10 = await draw(payload({ files: [file({ name: '<img src=x onerror=1>.pdf', owner_name: 'A & B' })] }));
  eq('name is escaped, not parsed', rowsOf(el10)[1].querySelectorAll('img').length, 0);
  has('owner ampersand survives', rowsOf(el10)[1].children[3].textContent, 'A & B');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { failures.forEach(function (f) { console.log('  FAIL ' + f); }); process.exit(1); }
})().catch(function (e) { console.error(e); process.exit(2); });
