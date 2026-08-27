'use strict';
/*
 * Render harness for the sticky list filters + column sorting.
 *
 * Russ Beechly, 2026-08-27: "If I sort, say by active, the sorting is reset when
 * I'm done looking at whatever invoice I clicked on and must reselect my filter."
 * These assertions pin the fix: the invoice and quote lists hand their controls,
 * page and sort back exactly as they were left, and a header sorts the WHOLE
 * filtered set rather than the page you happen to be looking at.
 *
 *   node test-list-state-dom.js
 */
var fs = require('fs');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(h, n, l) { ok(String(h).indexOf(n) !== -1, l + '  (missing: ' + n + ')'); }
function lacks(h, n, l) { ok(String(h).indexOf(n) === -1, l + '  (unexpectedly present: ' + n + ')'); }
function before(h, a, b, l) {
  var ia = String(h).indexOf(a), ib = String(h).indexOf(b);
  ok(ia !== -1 && ib !== -1 && ia < ib, l + '  (' + a + ' @' + ia + ' should precede ' + b + ' @' + ib + ')');
}

// ---- pull the real slices out of app.js ------------------------------------
var SRC = fs.readFileSync('public/js/app.js', 'utf8');
function slice(from, to, label) {
  var a = SRC.indexOf(from), b = SRC.indexOf(to);
  ok(a > 0 && b > a, 'found the ' + label + ' slice in app.js');
  var s = SRC.slice(a, b);
  ok(s.indexOf('`') === -1, 'the ' + label + ' slice is backtick-free (Windows-safe)');
  return s;
}
var HELPERS = slice('var _listUiState = {};', 'function poPaginate(p)', 'list-state helpers');
var INVOICES = slice('function invExt(it)', '// ---------- Create / edit form ----------', 'invoice list');
var QUOTES = slice('let _quotePage = 1;', 'async function renderEditQuote(el, id)', 'quote list');

// ---- a DOM just real enough ------------------------------------------------
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
var els = {};
function fakeInput(id, v) {
  var e = { id: id, value: v || '', innerHTML: '', textContent: '', style: {}, _attrs: {} };
  e.setAttribute = function (k, val) { this._attrs[k] = val; };
  e.getAttribute = function (k) { return this._attrs[k]; };
  els[id] = e;
  return e;
}
// A <select> refuses a value it has no option for - the browser drops it to ''.
// That is the case that decides whether a stale saved filter can hide rows.
function fakeSelect(id, opts) {
  var e = fakeInput(id, '');
  var v = '';
  e.options = opts;
  Object.defineProperty(e, 'value', {
    get: function () { return v; },
    set: function (x) { v = (opts.indexOf(x) !== -1) ? x : ''; }
  });
  return e;
}
var doc = {
  getElementById: function (id) { return els[id] || null; },
  querySelectorAll: function () { return []; }
};
var win = {};
function stubPagination() { return '<!--pg-->'; }
function stubBadge(s) { return '<span class="badge">' + escHtml(s || '') + '</span>'; }
function stubDate(d) { return d ? String(d).slice(0, 10) : ''; }

var INV = new Function(
  'window', 'document', 'escHtml', 'renderPagination', 'invStatusBadge', 'formatDate', 'parsePageSize', 'INV_STATUSES',
  HELPERS + '\n' + INVOICES + '\nreturn {' +
  ' listState:listState, listStateCapture:listStateCapture, listStateRestore:listStateRestore,' +
  ' listStateForget:listStateForget, listSortToggle:listSortToggle, listSortRows:listSortRows,' +
  ' listSortTh:listSortTh, listSortNum:listSortNum, listSortTime:listSortTime,' +
  ' invListRenderTable:invListRenderTable, invListSort:invListSort, invListClearFilters:invListClearFilters,' +
  ' filterInvoices:filterInvoices, invListFilteredRows:invListFilteredRows,' +
  ' INV_LIST_SORTS:INV_LIST_SORTS, INV_LIST_FILTER_IDS:INV_LIST_FILTER_IDS,' +
  ' setPage:function(p){_invListPage=p;}, getPage:function(){return _invListPage;},' +
  ' setSize:function(n){_invListPageSize=n;} };'
)(win, doc, escHtml, stubPagination, stubBadge, stubDate, function (v) { return parseInt(v, 10) || 10; }, ['draft', 'awaiting_payment', 'paid']);

// ---- fixtures --------------------------------------------------------------
function inv(id, num, cust, city, acct, status, total, date, extra) {
  var r = { id: id, invoice_number: num, customer_name: cust, city_code: city, account_name: acct,
    status: status, grand_total: total, invoice_date: date, customer_po_wo: '', locksmith_name: 'Russ Beechly' };
  if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
  return r;
}
var ROWS = [
  inv(1, '9', 'Acme Towing', 'ATL', 'Geico', 'awaiting_payment', '250.00', '2026-08-01', { vehicle_make: 'Toyota' }),
  inv(2, '10', 'Bell Auto', 'ATL', 'Allstate', 'paid', '1200.50', '2026-08-20', {}),
  inv(3, '11', 'Coop Fleet', 'SAV', 'Geico', 'awaiting_payment', '75.25', '2026-07-15', { vehicle_make: 'Ford' }),
  inv(4, '12', 'Delta Rentals', 'SAV', '', 'draft', '0.00', '2026-08-26', {})
];
function buildInvoiceDom() {
  els = {};
  fakeInput('invoice-search', '');
  fakeSelect('invoice-filter-status', ['', 'draft', 'awaiting_payment', 'paid']);
  fakeSelect('invoice-filter-city', ['', 'ATL', 'SAV']);
  fakeSelect('invoice-filter-account', ['', 'Geico', 'Allstate']);
  fakeSelect('invoice-filter-locksmith', ['', 'Russ Beechly']);
  fakeInput('invoice-result-count', '');
  fakeInput('invoice-filter-badge', '');
  fakeInput('invoices-table-wrap', '');
  fakeInput('invoices-pagination', '');
  fakeInput('invoice-filter-panel', '').style.display = 'none';
  fakeInput('invoice-filter-toggle', '');
  win._invoicesData = ROWS;
  win._invoicesSeeAll = true;
}
function tbody() { return els['invoices-table-wrap'].innerHTML; }

console.log('\n--- shared helpers ---');
buildInvoiceDom();
els['invoice-filter-status'].value = 'awaiting_payment';
els['invoice-search'].value = 'acme';
INV.listStateCapture('invoices', INV.INV_LIST_FILTER_IDS);
buildInvoiceDom();  // the re-render: brand new, empty controls
eq(els['invoice-filter-status'].value, '', 'a fresh render starts with empty controls');
ok(INV.listStateRestore('invoices', INV.INV_LIST_FILTER_IDS), 'restore reports it put something back');
eq(els['invoice-filter-status'].value, 'awaiting_payment', 'the status filter came back');
eq(els['invoice-search'].value, 'acme', 'the search text came back');

// A filter on an option the data no longer has must NOT survive, or the user
// gets an empty list with no way to see why.
buildInvoiceDom();
INV.listState('invoices').fields['invoice-filter-account'] = 'Vanished Account';
INV.listStateRestore('invoices', INV.INV_LIST_FILTER_IDS);
eq(els['invoice-filter-account'].value, '', 'a filter whose option is gone falls back to All');
eq(INV.listState('invoices').fields['invoice-filter-account'], '', 'and the dead value is dropped from the record');

INV.listStateForget('invoices', INV.INV_LIST_FILTER_IDS);
eq(INV.listState('invoices').fields['invoice-search'], '', 'forget clears the saved search');

var st = INV.listState('invoices');
st.sort = ''; st.dir = 'asc';
INV.listSortToggle('invoices', 'total');
eq(st.sort + '/' + st.dir, 'total/asc', 'first header click sorts ascending');
INV.listSortToggle('invoices', 'total');
eq(st.sort + '/' + st.dir, 'total/desc', 'second click flips it');
INV.listSortToggle('invoices', 'total');
eq(st.sort + '/' + st.dir, '/asc', 'third click clears the sort');
INV.listSortToggle('invoices', 'total');
INV.listSortToggle('invoices', 'date');
eq(st.sort + '/' + st.dir, 'date/asc', 'a different column starts ascending again');

st.sort = 'account'; st.dir = 'asc';
var byAcct = INV.listSortRows(ROWS, INV.INV_LIST_SORTS, 'invoices');
eq(byAcct[byAcct.length - 1].id, 4, 'ascending: the blank account sorts last');
st.dir = 'desc';
byAcct = INV.listSortRows(ROWS, INV.INV_LIST_SORTS, 'invoices');
eq(byAcct[byAcct.length - 1].id, 4, 'descending: the blank account is STILL last');
eq(ROWS[0].id, 1, 'sorting does not reorder the caller array');

st.sort = 'total'; st.dir = 'desc';
eq(INV.listSortRows(ROWS, INV.INV_LIST_SORTS, 'invoices')[0].id, 2, 'money sorts as a number, not as text');
st.sort = 'number'; st.dir = 'asc';
eq(INV.listSortRows(ROWS, INV.INV_LIST_SORTS, 'invoices')[0].id, 1, 'invoice #9 sorts before #10');
st.sort = 'date'; st.dir = 'desc';
eq(INV.listSortRows(ROWS, INV.INV_LIST_SORTS, 'invoices')[0].id, 4, 'newest first when the date arrow points down');
st.sort = ''; st.dir = 'asc';
eq(INV.listSortRows(ROWS, INV.INV_LIST_SORTS, 'invoices')[0].id, 1, 'no sort chosen leaves the server order alone');

var th = INV.listSortTh('invoices', 'total', 'Total', 'invListSort', 'class="text-right"');
has(th, 'onclick="invListSort(&#39;total&#39;)"', 'the header uses the HTML entity for its apostrophes');
lacks(th, "('total')", 'no raw apostrophe reaches the attribute');
has(th, 'class="text-right"', 'extra attributes are kept');

console.log('\n--- invoice list ---');
buildInvoiceDom();
INV.listStateForget('invoices', INV.INV_LIST_FILTER_IDS);
INV.listState('invoices').sort = ''; INV.listState('invoices').dir = 'asc';
INV.setSize(15); INV.setPage(1);
INV.invListRenderTable();
has(tbody(), 'onclick="invListSort(&#39;status&#39;)"', 'every column header is clickable');
has(tbody(), 'onclick="invListSort(&#39;locksmith&#39;)"', 'admins get a sortable Locksmith column too');
eq(els['invoice-result-count'].textContent, '4 invoices', 'the count reflects all four rows');

els['invoice-filter-status'].value = 'awaiting_payment';
INV.invListRenderTable();
eq(els['invoice-result-count'].textContent, '2 invoices', 'the status filter narrows the list');
eq(els['invoice-filter-badge'].textContent, ' (1)', 'the Filters button shows one active filter');
eq(INV.listState('invoices').fields['invoice-filter-status'], 'awaiting_payment',
  'drawing the table saves the filter, so clicking a row cannot lose it');

INV.invListSort('total');
INV.invListSort('total');   // second click: descending
before(tbody(), 'Acme Towing', 'Coop Fleet', 'sorted by total, descending, inside the filtered set');
eq(INV.getPage(), 1, 'a new sort goes back to page 1');

// The actual complaint: leave the list, come back, everything is still set.
INV.setSize(1); INV.setPage(2);
INV.invListRenderTable();
has(tbody(), 'Coop Fleet', 'page 2 of the filtered and sorted list holds the second row');
buildInvoiceDom();   // navigate away and back: a completely fresh DOM
INV.listStateRestore('invoices', INV.INV_LIST_FILTER_IDS);
INV.invListRenderTable();
eq(els['invoice-filter-status'].value, 'awaiting_payment', 'the filter survived the round trip');
eq(INV.getPage(), 2, 'so did the page');
has(tbody(), 'Coop Fleet', 'and the same row is on screen');
eq(INV.listState('invoices').sort, 'total', 'so did the sort column');
eq(INV.listState('invoices').dir, 'desc', 'and its direction');

INV.setPage(9);
INV.invListRenderTable();
eq(INV.getPage(), 2, 'a page past the end is clamped to the last real one');

INV.setSize(15);
INV.invListClearFilters();
eq(els['invoice-filter-status'].value, '', 'Clear filters empties the dropdown');
eq(INV.listState('invoices').fields['invoice-filter-status'], '', 'and forgets it, so it cannot come back');
eq(els['invoice-result-count'].textContent, '4 invoices', 'all four rows are listed again');
eq(INV.listState('invoices').sort, 'total', 'clearing FILTERS leaves the chosen sort alone');

console.log('\n--- quote list ---');
var QT = new Function(
  'window', 'document', 'escHtml', 'renderPagination', 'renderQuoteRows',
  HELPERS + '\n' + QUOTES + '\nreturn {' +
  ' listState:listState, listStateRestore:listStateRestore,' +
  ' filterQuotes:filterQuotes, quoteListSort:quoteListSort, clearQuoteFilters:clearQuoteFilters,' +
  ' QUOTE_LIST_FILTER_IDS:QUOTE_LIST_FILTER_IDS, QUOTE_LIST_SORTS:QUOTE_LIST_SORTS,' +
  ' setPage:function(p){_quotePage=p;}, getPage:function(){return _quotePage;},' +
  ' setSize:function(n){QUOTE_PAGE_SIZE=n;} };'
)(win, doc, escHtml, stubPagination, function (rows) {
  return rows.map(function (r) { return '<tr>' + escHtml(r.quote_number) + '|' + escHtml(r.customer_name) + '</tr>'; }).join('');
});

var QROWS = [
  { id: 1, quote_number: 'Q-9', customer_name: 'Acme Towing', city_code: 'ATL', status: 'sent', total_amount: '900.00', created_at: '2026-08-02T14:00:00Z', requester_id: 5, requester_name: 'Russ Beechly' },
  { id: 2, quote_number: 'Q-10', customer_name: 'Bell Auto', city_code: 'SAV', status: 'draft', total_amount: '150.00', created_at: '2026-08-21T14:00:00Z', requester_id: 6, requester_name: 'Tony McKeon' },
  { id: 3, quote_number: 'Q-11', customer_name: 'Coop Fleet', city_code: 'ATL', status: 'approved', total_amount: '4000.00', created_at: '2026-07-11T14:00:00Z', requester_id: 5, requester_name: 'Russ Beechly' }
];
function buildQuoteDom() {
  els = {};
  fakeInput('quote-search', '');
  fakeSelect('quote-filter-city', ['', 'ATL', 'SAV']);
  fakeSelect('quote-filter-status', ['', 'open', 'draft', 'sent', 'viewed', 'changes_requested', 'approved', 'declined', 'expired']);
  fakeSelect('quote-filter-by', ['', '5', '6']);
  fakeInput('quote-filter-from', '');
  fakeInput('quote-filter-to', '');
  fakeInput('quote-filter-min', '');
  fakeInput('quote-filter-max', '');
  fakeInput('quotes-count', '');
  fakeInput('quotes-table-wrap', '');
  win._quotesData = QROWS;
  win._quotesIsAdmin = true;
}
function qwrap() { return els['quotes-table-wrap'].innerHTML; }

buildQuoteDom();
QT.setSize(10); QT.setPage(1);
QT.filterQuotes();
has(qwrap(), 'onclick="quoteListSort(&#39;total&#39;)"', 'the quote header is clickable');
QT.quoteListSort('number');
before(qwrap(), 'Q-9', 'Q-10', 'Q-9 sorts before Q-10 (digits, not text)');
QT.quoteListSort('total');
QT.quoteListSort('total');
before(qwrap(), 'Coop Fleet', 'Acme Towing', 'quote totals sort as money');

els['quote-filter-city'].value = 'ATL';
QT.filterQuotes(true);
eq(QT.getPage(), 1, 'changing a filter resets the quote page');
lacks(qwrap(), 'Bell Auto', 'the city filter drops the SAV quote');
QT.setSize(1); QT.setPage(2);
QT.filterQuotes();
buildQuoteDom();   // navigate away and back
QT.listStateRestore('quotes', QT.QUOTE_LIST_FILTER_IDS);
QT.filterQuotes();
eq(els['quote-filter-city'].value, 'ATL', 'the quote city filter survived the round trip');
eq(QT.getPage(), 2, 'and so did the page');
eq(QT.listState('quotes').sort, 'total', 'and the sort column');

QT.clearQuoteFilters();
eq(els['quote-filter-city'].value, '', 'Clear empties the quote city filter');
eq(QT.listState('quotes').fields['quote-filter-city'], '', 'and forgets it');
eq(QT.getPage(), 1, 'Clear goes back to page 1');

console.log('\n--- work order route: sort whitelist ---');
var WO = fs.readFileSync('routes/workOrders.js', 'utf8');
has(WO, 'const WO_SORTS = {', 'the route has a sort whitelist');
has(WO, "WO_SORTS[String(req.query.sort || '')] || null", 'only a whitelisted key can pick a sort expression');
lacks(WO, "'ORDER BY ' + req.query.sort", 'the raw query value is never put into the SQL');
has(WO, "=== 'desc' ? 'DESC' : 'ASC'", 'the direction is one of two literals');
has(WO, 'NULLS LAST, w.created_at DESC', 'a sorted page has a stable tiebreaker');
has(WO, "ORDER BY CASE w.status WHEN 'received'", 'the unsorted default order is unchanged');
var APP = SRC;
has(APP, "listSortTh('work-orders', 'account', 'Account', 'woSortBy')", 'the work order header is clickable');
has(APP, "qs.push('sort=' + encodeURIComponent(woSortState.sort))", 'the work order list asks the server for the sort');

console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
