// Dispatch Quote Script, Phase 1: residential + commercial (2026-10-08).
//
// Three screens:
//   renderQuoteScript()   Dispatch > Quote. The dispatcher panel: zip, account,
//                         task, quantities -> price, ETA and the words to say,
//                         then log the outcome. use_quote_script (ships dark).
//   renderQuotePricing()  Dispatching Setup > Quote Pricing & Scripts. Rate
//                         cards, tasks and flat prices, account rates, script
//                         wording, settings. manage_pricing (admin/owner).
//   renderQuoteReport()   Dispatching Setup > Quote Report. manage_pricing.
//
// The server prices everything (utils/quoteScript.js). Nothing here does money
// math beyond displaying what came back, so the panel, the log and the report
// can never disagree.
//
// House style: string concatenation only, no template literals; &#39; for an
// apostrophe inside an HTML string (CLAUDE.md 1.2). Bare "state", never
// "window.state" (nova-window-state-gotcha).

var QS_CATS = [{ k: 'residential', l: 'Residential' }, { k: 'commercial', l: 'Commercial' }];
var QS_OUTCOME_LABELS = { booked_asap: 'Booked ASAP', booked_scheduled: 'Booked (scheduled)', callback: 'Callback', declined: 'Declined' };

function qsMoney(n) {
  if (n === null || n === undefined || n === '' || !isFinite(Number(n))) return '';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function qsNum(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  var n = Number(String(v).replace(/[$,]/g, ''));
  return isFinite(n) ? n : null;
}
function qsInputVal(n) { return (n === null || n === undefined) ? '' : Number(n).toFixed(2); }
function qsSlug(label) { return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30); }
function qsWhen(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function qsStyles() {
  if (document.getElementById('qs-style')) return;
  var st = document.createElement('style');
  st.id = 'qs-style';
  st.textContent =
    '.qs-grid{display:grid;grid-template-columns:minmax(240px,300px) minmax(280px,1fr) minmax(320px,430px);gap:14px;align-items:start}' +
    '@media(max-width:1100px){.qs-grid{grid-template-columns:1fr}}' +
    '.qs-col{padding:14px}' +
    '.qs-label{display:block;font-size:12px;color:var(--text-muted-color);margin:12px 0 4px}' +
    '.qs-label:first-child{margin-top:0}' +
    '.qs-col input[type=text],.qs-col select,.qs-col textarea{width:100%}' +
    '.qs-pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}' +
    '.qs-pill{display:inline-block;white-space:nowrap;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:var(--bg-elevated);color:var(--text-dim);border:1px solid var(--border)}' +
    '.qs-pill.ok{color:var(--success);border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.1)}' +
    '.qs-pill.warn{color:var(--warning);border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.1)}' +
    '.qs-pill.bad{color:var(--danger);border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.1)}' +
    '.qs-cats{display:flex;gap:6px;margin-top:14px}' +
    '.qs-cat{flex:1;padding:9px;border:1px solid var(--border);border-radius:6px;background:var(--bg-elevated);color:var(--text-dim);font-weight:600;cursor:pointer;text-align:center}' +
    '.qs-cat.on{border-color:var(--primary);color:var(--primary);background:rgba(249,115,22,.08)}' +
    '.qs-cat[disabled]{opacity:.45;cursor:not-allowed}' +
    '.qs-group{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--primary);margin:12px 0 6px}' +
    '.qs-opt{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--bg-elevated);cursor:pointer}' +
    '.qs-opt:hover{border-color:var(--text-muted-color)}' +
    '.qs-opt.on{border-color:var(--primary)}' +
    '.qs-qty{display:flex;align-items:center;gap:6px}' +
    '.qs-qty b{min-width:28px;text-align:center}' +
    '.qs-qb{width:28px;height:28px;padding:0;border-radius:6px;display:inline-flex;align-items:center;justify-content:center}' +
    '.qs-price{font-size:38px;font-weight:800;color:var(--primary);line-height:1.05}' +
    '.qs-price small{font-size:14px;color:var(--text-muted-color);font-weight:500}' +
    '.qs-lines{margin:12px 0;border-top:1px solid var(--border)}' +
    '.qs-lines div{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;color:var(--text-dim)}' +
    '.qs-eta{display:flex;gap:8px;margin-top:8px}' +
    '.qs-eta>div{flex:1;padding:8px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px}' +
    '.qs-eta span{display:block;color:var(--text-muted-color);font-size:12px}' +
    '.qs-eta b{font-size:17px}' +
    '.qs-sect{margin-top:12px}' +
    '.qs-sect h4{margin:0 0 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--primary)}' +
    '.qs-sect p{margin:0;color:var(--text);line-height:1.5}' +
    '.qs-warn{border:1px solid rgba(245,158,11,.4);background:rgba(245,158,11,.08);color:var(--warning);border-radius:6px;padding:8px 10px;font-size:13px;margin-top:8px}' +
    '.qs-out{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}' +
    '.qs-out .btn{flex:1;min-width:110px}' +
    '.qs-step{margin-top:10px;padding:10px;border:1px dashed var(--border);border-radius:6px}' +
    '.qs-chip{display:inline-block;margin:3px 4px 3px 0;padding:5px 10px;border-radius:999px;border:1px solid var(--border);background:var(--bg-elevated);cursor:pointer;font-size:13px}' +
    '.qs-chip.on{border-color:var(--danger);color:var(--danger)}' +
    '.qs-acct-res{border:1px solid var(--border);border-radius:6px;margin-top:4px;max-height:220px;overflow:auto;background:var(--bg-card)}' +
    '.qs-acct-res div{padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)}' +
    '.qs-acct-res div:hover{background:var(--bg-elevated)}' +
    '.qs-toggle{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}' +
    '.qs-toggle button{border:0;background:var(--bg-elevated);color:var(--text-dim);padding:4px 10px;cursor:pointer;font-size:12px}' +
    '.qs-toggle button.on{background:var(--primary);color:#fff}' +
    '.qa-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}' +
    '.qa-tabs .btn.on{background:var(--primary);border-color:var(--primary);color:#fff}' +
    '.qa-two{display:grid;grid-template-columns:minmax(320px,1fr) minmax(340px,480px);gap:14px;align-items:start}' +
    '@media(max-width:1100px){.qa-two{grid-template-columns:1fr}}' +
    '.qa-num{width:96px;text-align:right}' +
    '.qa-row-on{background:rgba(249,115,22,.08)}' +
    '.qa-block{border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;background:var(--bg-card)}' +
    '.qa-block textarea{width:100%;min-height:64px}' +
    '.qa-help{font-size:12px;color:var(--text-muted-color)}' +
    '.qr-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}' +
    '@media(max-width:1000px){.qr-grid{grid-template-columns:1fr}}';
  document.head.appendChild(st);
}

// ===========================================================================
// The dispatcher panel
// ===========================================================================

var _qs = null;
var _qsPriceTimer = null;
var _qsDraftTimer = null;
var _qsAcctTimer = null;

function qsFresh(boot) {
  return {
    boot: boot, city: '', zip: '', zone: null, outOfArea: false, category: 'residential', catalog: null,
    taskId: null, qty: {}, account: null, customer: '', result: null, filter: '', close: 'asap',
    step: null, reason: null, pulsar: '', note: '', upsellAccepted: false, saving: false, recent: []
  };
}
function qsDraftKey() { return 'quote-script:' + ((state.user && state.user.id) || 0); }

async function renderQuoteScript(el) {
  if (!can('use_quote_script')) { el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
  qsStyles();
  var boot;
  try { boot = await api('GET', '/quote-script/bootstrap'); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">' + escHtml(e.message || 'Could not load the quote panel.') + '</div>'; return; }
  _qs = qsFresh(boot);
  var liveCities = boot.cities.filter(function (c) { return c.live.residential || c.live.commercial; });
  var home = (state.user && state.user.home_city) ? String(state.user.home_city).trim().toUpperCase() : '';
  _qs.city = (liveCities.filter(function (c) { return c.code === home; })[0] || liveCities[0] || boot.cities[0] || {}).code || '';

  el.innerHTML =
    '<div class="page-header"><div><div class="page-title">Quote</div>' +
      '<div class="page-subtitle">Residential and commercial pricing and the words to say. Enter the call in Pulsar as usual.</div></div>' +
      (boot.can_manage ? '<div style="display:flex;gap:8px"><button class="btn btn-secondary btn-sm" onclick="navigate(&#39;quote-pricing&#39;)">Pricing &amp; Scripts</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="navigate(&#39;quote-report&#39;)">Report</button></div>' : '') +
    '</div>' +
    (liveCities.length ? '' : '<div class="alert alert-error" style="margin-bottom:12px">No city has rates set yet. ' +
      (boot.can_manage ? 'Fill in the rate cards under Quote Pricing &amp; Scripts.' : 'Ask an admin to set the rate cards.') + '</div>') +
    '<div id="qs-draft"></div>' +
    '<div class="qs-grid">' +
      '<div class="card qs-col" id="qs-left"></div>' +
      '<div class="card qs-col"><input type="text" id="qs-filter" placeholder="Search tasks (lockout, deadbolt, smart lock...)" oninput="qsFilter(this.value)">' +
        '<div id="qs-tasks" style="margin-top:6px"></div></div>' +
      '<div class="card qs-col" id="qs-answer"></div>' +
    '</div>' +
    '<div class="card" style="margin-top:16px"><div class="card-header"><span class="card-title">My recent quotes</span></div>' +
      '<div class="card-body" id="qs-recent"><div class="loading">Loading...</div></div></div>';

  qsRenderLeft();
  await qsLoadCatalog();
  qsRenderAnswer();
  qsLoadRecent();
  qsOfferDraft();
  if (!window._qsVisHooked) {
    window._qsVisHooked = true;
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') qsSaveDraftNow(); });
  }
}

function qsCity(code) { return (_qs.boot.cities.filter(function (c) { return c.code === code; })[0]) || null; }

function qsRenderLeft() {
  var box = document.getElementById('qs-left');
  if (!box) return;
  var c = qsCity(_qs.city);
  var pills = '';
  if (c) pills += '<span class="qs-pill ok">' + escHtml(c.name) + '</span>';
  if (_qs.zone) pills += '<span class="qs-pill">Zone: ' + escHtml(_qs.zone.name) + '</span>';
  if (_qs.outOfArea) pills += '<span class="qs-pill warn">Outside coverage map</span>';
  var acct = _qs.account
    ? '<div class="qs-opt on" style="cursor:default"><span><b>' + escHtml(_qs.account.name) + '</b><br><small style="color:var(--text-muted-color)">' +
        (_qs.account.has_rates ? 'Has its own rates' : (_qs.account.quote_fallback === 'retail' ? 'No contracted rate: quote retail' : 'No contracted rate: do not quote')) +
      '</small></span><button class="btn btn-ghost btn-sm" onclick="qsClearAccount()">&#x2715;</button></div>'
    : '<input type="text" id="qs-acct-q" placeholder="Retail (cash / card). Type to find an account..." oninput="qsAcctSearch(this.value)" autocomplete="off"><div id="qs-acct-res"></div>';
  var cats = QS_CATS.map(function (k) {
    var live = c && c.live[k.k];
    return '<button class="qs-cat' + (_qs.category === k.k ? ' on' : '') + '"' + (live ? '' : ' disabled title="Rates not set for this city"') +
      ' onclick="qsSetCategory(&#39;' + k.k + '&#39;)">' + k.l + '</button>';
  }).join('');
  box.innerHTML =
    '<label class="qs-label">Caller zip</label>' +
    '<input type="text" id="qs-zip" value="' + escHtml(_qs.zip) + '" placeholder="e.g. 32807" maxlength="10" onchange="qsZip(this.value)" onkeydown="if(event.key===&#39;Enter&#39;)qsZip(this.value)">' +
    '<label class="qs-label">City</label>' +
    '<select id="qs-city" onchange="qsSetCity(this.value)">' + _qs.boot.cities.map(function (x) {
      var live = x.live.residential || x.live.commercial;
      return '<option value="' + escHtml(x.code) + '"' + (x.code === _qs.city ? ' selected' : '') + '>' + escHtml(x.name) + (live ? '' : ' (no rates yet)') + '</option>';
    }).join('') + '</select>' +
    '<div class="qs-pills">' + pills + '</div>' +
    '<label class="qs-label">Customer</label>' + acct +
    '<label class="qs-label">Customer name (optional, for the log)</label>' +
    '<input type="text" id="qs-cust" value="' + escHtml(_qs.customer) + '" maxlength="120" oninput="_qs.customer=this.value;qsQueueDraft()">' +
    '<div class="qs-cats">' + cats + '</div>';
}

async function qsZip(v) {
  _qs.zip = String(v || '').trim();
  _qs.zone = null; _qs.outOfArea = false;
  if (_qs.zip) {
    try {
      var z = await api('GET', '/quote-script/zip?zip=' + encodeURIComponent(_qs.zip) + '&city=' + encodeURIComponent(_qs.city));
      _qs.zone = z.zone; _qs.outOfArea = !!z.out_of_area;
      if (z.city_code && z.city_code !== _qs.city && qsCity(z.city_code)) { await qsSetCity(z.city_code, true); return; }
    } catch (e) { /* a zip with no zone is fine */ }
  }
  qsRenderLeft();
  qsQueuePrice();
  qsQueueDraft();
}

async function qsSetCity(code, keepZone) {
  _qs.city = code;
  if (!keepZone) { _qs.zone = null; _qs.outOfArea = false; }
  var c = qsCity(code);
  if (c && !c.live[_qs.category]) {
    var other = QS_CATS.filter(function (k) { return c.live[k.k]; })[0];
    if (other) { _qs.category = other.k; _qs.taskId = null; }
  }
  qsRenderLeft();
  await qsLoadCatalog();
  qsQueuePrice();
  qsQueueDraft();
}

async function qsSetCategory(k) {
  if (_qs.category === k) return;
  _qs.category = k; _qs.taskId = null; _qs.qty = {}; _qs.result = null; _qs.step = null;
  qsRenderLeft();
  await qsLoadCatalog();
  qsRenderAnswer();
  qsQueueDraft();
}

function qsAcctSearch(q) {
  clearTimeout(_qsAcctTimer);
  var box = document.getElementById('qs-acct-res');
  if (!q || q.trim().length < 2) { if (box) box.innerHTML = ''; return; }
  _qsAcctTimer = setTimeout(async function () {
    var rows = [];
    try { rows = await api('GET', '/quote-script/accounts?q=' + encodeURIComponent(q.trim())); } catch (e) { rows = []; }
    window._qsAcctRows = rows;
    var b = document.getElementById('qs-acct-res');
    if (!b) return;
    b.innerHTML = rows.length
      ? '<div class="qs-acct-res">' + rows.map(function (r, i) {
          return '<div onclick="qsPickAccount(' + i + ')">' + escHtml(r.name) + (r.has_rates ? ' <span class="qs-pill ok">rates</span>' : '') + '</div>';
        }).join('') + '</div>'
      : '<div class="qa-help" style="margin-top:4px">No matching account.</div>';
  }, 250);
}
function qsPickAccount(i) {
  var r = (window._qsAcctRows || [])[i];
  if (!r) return;
  _qs.account = r;
  qsRenderLeft(); qsQueuePrice(); qsQueueDraft();
}
function qsClearAccount() { _qs.account = null; qsRenderLeft(); qsQueuePrice(); qsQueueDraft(); }

async function qsLoadCatalog() {
  var box = document.getElementById('qs-tasks');
  if (!_qs.city) { if (box) box.innerHTML = '<div class="empty-state">Pick a city.</div>'; return; }
  if (box) box.innerHTML = '<div class="loading">Loading...</div>';
  try {
    _qs.catalog = await api('GET', '/quote-script/catalog?city=' + encodeURIComponent(_qs.city) + '&category=' + _qs.category);
  } catch (e) {
    _qs.catalog = null;
    if (box) box.innerHTML = '<div class="alert alert-error">' + escHtml(e.message || 'Could not load tasks.') + '</div>';
    return;
  }
  if (_qs.taskId && !qsTask(_qs.taskId)) { _qs.taskId = null; _qs.result = null; }
  qsRenderTasks();
}
function qsTask(id) {
  if (!_qs.catalog) return null;
  return _qs.catalog.tasks.filter(function (t) { return t.id === id; })[0] || null;
}
function qsFilter(v) { _qs.filter = String(v || '').toLowerCase(); qsRenderTasks(); }

function qsLead(t) {
  if (t.lead_price === null || t.lead_price === undefined) return '<span class="qs-pill warn">Price not set</span>';
  if (t.pricing === 'hourly') return '<span class="qs-pill">1st hr ' + qsMoney(t.lead_price) + '</span>';
  return '<span class="qs-pill">' + (t.units.length ? 'from ' : '') + qsMoney(t.lead_price) + '</span>';
}

function qsRenderTasks() {
  var box = document.getElementById('qs-tasks');
  if (!box || !_qs.catalog) return;
  var cat = _qs.catalog;
  if (!cat.live) {
    box.innerHTML = '<div class="qs-warn">' + (_qs.category === 'commercial' ? 'Commercial' : 'Residential') +
      ' rates are not set for this city yet, so it cannot be quoted here.</div>';
    return;
  }
  var html = '';
  var lastGroup = null;
  cat.tasks.forEach(function (t) {
    if (_qs.filter && (t.name + ' ' + t.group_name).toLowerCase().indexOf(_qs.filter) === -1) return;
    if (t.group_name !== lastGroup) { html += '<div class="qs-group">' + escHtml(t.group_name) + '</div>'; lastGroup = t.group_name; }
    html += '<div class="qs-opt' + (t.id === _qs.taskId ? ' on' : '') + '" onclick="qsPickTask(' + t.id + ')"><span>' +
      (t.id === _qs.taskId ? '<b>' + escHtml(t.name) + '</b>' : escHtml(t.name)) +
      (t.tech_confirms ? ' <span class="qs-pill warn">Tech quotes on site</span>' : '') + '</span>' + qsLead(t) + '</div>';
    if (t.id === _qs.taskId && t.units.length) html += qsQtyHtml(t);
  });
  box.innerHTML = html || '<div class="empty-state">No task matches that search.</div>';
}

function qsQtyHtml(t) {
  return '<div style="margin:2px 0 10px 10px">' + t.units.map(function (u) {
    var q = _qs.qty[u.code];
    return '<div class="qs-opt" style="cursor:default"><span>' + escHtml(u.label.charAt(0).toUpperCase() + u.label.slice(1)) + 's' +
      ' <small style="color:var(--text-muted-color)">' + u.included_qty + ' included' +
      (u.addl_price !== null && u.addl_price !== undefined ? ', ' + qsMoney(u.addl_price) + ' each extra' : ', extra price not set') + '</small></span>' +
      '<span class="qs-qty"><button class="btn btn-secondary qs-qb" onclick="event.stopPropagation();qsQty(&#39;' + escHtml(u.code) + '&#39;,-1)">-</button>' +
      '<b>' + q + '</b><button class="btn btn-secondary qs-qb" onclick="event.stopPropagation();qsQty(&#39;' + escHtml(u.code) + '&#39;,1)">+</button></span></div>';
  }).join('') + '</div>';
}

function qsPickTask(id) {
  var t = qsTask(id);
  if (!t) return;
  if (_qs.taskId !== id) {
    _qs.taskId = id; _qs.qty = {}; _qs.step = null; _qs.upsellAccepted = false;
    t.units.forEach(function (u) { _qs.qty[u.code] = Number(u.included_qty) || 0; });
  }
  qsRenderTasks();
  qsQueuePrice(true);
  qsQueueDraft();
}
function qsQty(code, d) {
  var v = (Number(_qs.qty[code]) || 0) + d;
  _qs.qty[code] = Math.max(0, Math.min(999, v));
  qsRenderTasks();
  qsQueuePrice();
  qsQueueDraft();
}

function qsQueuePrice(now) {
  clearTimeout(_qsPriceTimer);
  if (!_qs.taskId) { _qs.result = null; qsRenderAnswer(); return; }
  _qsPriceTimer = setTimeout(qsPrice, now ? 0 : 150);
}
function qsInputs() {
  return { city_code: _qs.city, task_id: _qs.taskId, quantities: _qs.qty, account_id: _qs.account ? _qs.account.id : null, zip: _qs.zip };
}
async function qsPrice() {
  if (!_qs.taskId) return;
  var ask = JSON.stringify(qsInputs());
  try {
    var r = await api('POST', '/quote-script/price', qsInputs());
    if (ask !== JSON.stringify(qsInputs())) return; // inputs moved on; a newer price is coming
    _qs.result = r;
  } catch (e) {
    _qs.result = { error: e.message || 'Could not price that.' };
  }
  qsRenderAnswer();
}

function qsRenderAnswer() {
  var box = document.getElementById('qs-answer');
  if (!box) return;
  var r = _qs.result;
  if (!_qs.taskId || !r) {
    box.innerHTML = '<div class="empty-state" style="padding:30px 10px">Pick a task to see the price and the script.</div>';
    return;
  }
  if (r.error) { box.innerHTML = '<div class="alert alert-error">' + escHtml(r.error) + '</div>'; return; }
  var hourly = r.task.pricing === 'hourly';
  var head = r.source === 'no_quote'
    ? '<div class="qs-price" style="font-size:24px">Do not quote</div><div class="qa-help">Bill per account terms.</div>'
    : (r.total === null
        ? '<div class="qs-price" style="font-size:24px;color:var(--warning)">Price not set</div>'
        : '<div class="qa-help">' + (hourly ? 'First hour, includes the trip' : 'Total') + (r.source === 'account' ? ' (account rate)' : '') + '</div>' +
          '<div class="qs-price">' + qsMoney(r.total) + ' <small>plus tax</small></div>');
  var lines = r.lines.map(function (l) {
    return '<div><span>' + escHtml(l.label) + '</span><span>' + (l.amount < 0 ? '-' : '') + qsMoney(Math.abs(l.amount)) + '</span></div>';
  }).join('');
  if (r.parts_line) lines += '<div><span>Parts</span><span>' + escHtml(r.parts_line) + '</span></div>';
  var warns = r.warnings.map(function (w) { return '<div class="qs-warn">' + escHtml(w.text) + '</div>'; }).join('');
  if (r.task.tech_confirms && r.source !== 'no_quote') warns += '<div class="qs-warn">Tech gives a full quote on site before doing anything past the first hour.</div>';
  var eta = r.eta ? (r.eta.low === r.eta.high ? r.eta.low + ' min' : r.eta.low + '-' + r.eta.high + ' min') : 'n/a';
  var script = r.script.map(function (s) {
    if (s.section === 'close_asap' && _qs.close !== 'asap') return '';
    if (s.section === 'close_scheduled' && _qs.close !== 'scheduled') return '';
    var h = s.section.indexOf('close') === 0
      ? 'Close <span class="qs-toggle" style="margin-left:6px"><button class="' + (_qs.close === 'asap' ? 'on' : '') + '" onclick="qsClose(&#39;asap&#39;)">ASAP</button>' +
        '<button class="' + (_qs.close === 'scheduled' ? 'on' : '') + '" onclick="qsClose(&#39;scheduled&#39;)">Scheduled</button></span>'
      : escHtml(s.label);
    return '<div class="qs-sect"><h4>' + h + '</h4><p>' + escHtml(s.text) + '</p></div>';
  }).join('');
  box.innerHTML = head +
    (lines ? '<div class="qs-lines">' + lines + '</div>' : '') + warns +
    '<div class="qs-eta"><div><span>ETA (if ASAP)</span><b>' + escHtml(eta) + '</b></div><div><span>Pulsar type</span><b>' + escHtml(r.task.service_code) + '</b></div></div>' +
    script + qsOutcomeHtml(r);
}
function qsClose(m) { _qs.close = m; qsRenderAnswer(); }

function qsOutcomeHtml(r) {
  var step = _qs.step;
  var html = '<div class="qs-out">' +
    '<button class="btn ' + (step === 'booked_asap' ? 'btn-primary' : 'btn-secondary') + '" onclick="qsStep(&#39;booked_asap&#39;)">Booked ASAP</button>' +
    '<button class="btn ' + (step === 'booked_scheduled' ? 'btn-primary' : 'btn-secondary') + '" onclick="qsStep(&#39;booked_scheduled&#39;)">Scheduled</button>' +
    '<button class="btn ' + (step === 'callback' ? 'btn-primary' : 'btn-secondary') + '" onclick="qsStep(&#39;callback&#39;)">Callback</button>' +
    '<button class="btn ' + (step === 'declined' ? 'btn-primary' : 'btn-secondary') + '" onclick="qsStep(&#39;declined&#39;)">Declined</button></div>';
  if (!step) return html;
  var body = '';
  if (step === 'booked_asap' || step === 'booked_scheduled') {
    body += '<label class="qs-label">Pulsar call # (optional)</label><input type="text" id="qs-pulsar" maxlength="40" value="' + escHtml(_qs.pulsar) + '" oninput="_qs.pulsar=this.value">';
    if (step === 'booked_scheduled') body += '<div class="qa-help" style="margin-top:6px">Book the appointment time in Pulsar.</div>';
    if (r.upsell && r.upsell.price !== null) {
      body += '<label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox"' + (_qs.upsellAccepted ? ' checked' : '') +
        ' onchange="_qs.upsellAccepted=this.checked"> Customer added the ' + escHtml(r.upsell.name.toLowerCase()) + '</label>';
    }
  } else if (step === 'declined') {
    body += '<div class="qa-help" style="margin-bottom:4px">Why? (required)</div>' + _qs.boot.decline_reasons.map(function (x, i) {
      return '<span class="qs-chip' + (_qs.reason === x ? ' on' : '') + '" onclick="qsReason(' + i + ')">' + escHtml(x) + '</span>';
    }).join('');
  }
  body += '<label class="qs-label">Note (optional)</label><input type="text" id="qs-note" maxlength="500" value="' + escHtml(_qs.note) + '" oninput="_qs.note=this.value">';
  body += '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="qsStep(null)">Cancel</button>' +
    '<button class="btn btn-primary btn-sm" id="qs-save" onclick="qsSaveOutcome()"' + (_qs.saving ? ' disabled' : '') + '>Log ' + escHtml(QS_OUTCOME_LABELS[step]) + '</button></div>';
  return html + '<div class="qs-step">' + body + '</div>';
}
function qsStep(s) { _qs.step = s; if (s !== 'declined') _qs.reason = null; qsRenderAnswer(); }
function qsReason(i) { _qs.reason = _qs.boot.decline_reasons[i] || null; qsRenderAnswer(); }

async function qsSaveOutcome() {
  if (!_qs.step || _qs.saving) return;
  if (_qs.step === 'declined' && !_qs.reason) { showToast('Pick a reason first.', 'error'); return; }
  _qs.saving = true;
  var body = qsInputs();
  body.outcome = _qs.step;
  body.decline_reason = _qs.reason;
  body.pulsar_call_number = _qs.pulsar;
  body.note = _qs.note;
  body.customer_name = _qs.customer;
  body.upsell_accepted = !!_qs.upsellAccepted;
  try {
    await api('POST', '/quote-script/quotes', body);
    showToast('Quote logged: ' + QS_OUTCOME_LABELS[_qs.step], 'success');
    novaDraftDel(qsDraftKey());
    // Ready for the next call: keep the city and category, clear the caller.
    var keep = { city: _qs.city, category: _qs.category, boot: _qs.boot, catalog: _qs.catalog };
    _qs = qsFresh(keep.boot);
    _qs.city = keep.city; _qs.category = keep.category; _qs.catalog = keep.catalog;
    var f = document.getElementById('qs-filter'); if (f) f.value = '';
    qsRenderLeft(); qsRenderTasks(); qsRenderAnswer(); qsLoadRecent();
  } catch (e) {
    _qs.saving = false;
    showToast(e.message || 'Could not log the quote.', 'error');
    qsRenderAnswer();
  }
}

async function qsLoadRecent() {
  var box = document.getElementById('qs-recent');
  if (!box) return;
  var rows = [];
  try { rows = await api('GET', '/quote-script/quotes?mine=1&limit=15'); } catch (e) { rows = []; }
  _qs.recent = rows;
  if (!rows.length) { box.innerHTML = '<div class="empty-state">No quotes logged yet.</div>'; return; }
  box.innerHTML = '<div class="table-wrap"><table><thead><tr><th>When</th><th>Task</th><th>City</th><th>Customer</th><th class="text-right">Quoted</th><th>Outcome</th><th></th></tr></thead><tbody>' +
    rows.map(function (q) {
      var acts = '';
      if (q.outcome === 'callback') {
        acts = '<button class="btn btn-secondary btn-sm" onclick="qsRecentOutcome(' + q.id + ',&#39;booked_asap&#39;)">Booked</button> ' +
          '<select onchange="qsRecentDecline(' + q.id + ',this.value)" style="width:auto"><option value="">Declined...</option>' +
          _qs.boot.decline_reasons.map(function (x, i) { return '<option value="' + i + '">' + escHtml(x) + '</option>'; }).join('') + '</select>';
      }
      return '<tr><td>' + escHtml(qsWhen(q.created_at)) + '</td><td>' + escHtml(q.task_name || '') + (q.account_name ? '<br><small class="text-muted">' + escHtml(q.account_name) + '</small>' : '') + '</td>' +
        '<td>' + escHtml(q.city_code || '') + '</td><td>' + escHtml(q.customer_name || '') + '</td>' +
        '<td class="text-right mono">' + (q.total !== null ? qsMoney(q.total) : (q.price_source === 'no_quote' ? 'Account' : '')) + '</td>' +
        '<td><span class="badge">' + escHtml(QS_OUTCOME_LABELS[q.outcome] || q.outcome) + '</span>' + (q.decline_reason ? '<br><small class="text-muted">' + escHtml(q.decline_reason) + '</small>' : '') + '</td>' +
        '<td class="row-actions">' + acts + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}
async function qsRecentOutcome(id, outcome, reason) {
  try {
    await api('PATCH', '/quote-script/quotes/' + id + '/outcome', { outcome: outcome, decline_reason: reason || null });
    showToast('Updated', 'success');
  } catch (e) { showToast(e.message || 'Could not update.', 'error'); }
  qsLoadRecent();
}
function qsRecentDecline(id, idx) {
  if (idx === '') return;
  qsRecentOutcome(id, 'declined', _qs.boot.decline_reasons[parseInt(idx, 10)]);
}

// ---- autosave (CLAUDE.md 9: every form autosaves) --------------------------
function qsDraftState() {
  var t = qsTask(_qs.taskId);
  return { city: _qs.city, zip: _qs.zip, category: _qs.category, taskId: _qs.taskId, taskName: t ? t.name : '',
    qty: _qs.qty, account: _qs.account, customer: _qs.customer, savedAt: Date.now() };
}
function qsQueueDraft() {
  clearTimeout(_qsDraftTimer);
  _qsDraftTimer = setTimeout(qsSaveDraftNow, 400);
}
function qsSaveDraftNow() {
  clearTimeout(_qsDraftTimer);
  if (!_qs || !document.getElementById('qs-left')) return;
  if (!_qs.taskId && !_qs.zip && !_qs.account && !_qs.customer) { novaDraftDel(qsDraftKey()); return; }
  novaDraftPut(qsDraftKey(), qsDraftState());
}
async function qsOfferDraft() {
  var d = await novaDraftGet(qsDraftKey());
  var box = document.getElementById('qs-draft');
  if (!box || !d || !d.taskId) return;
  window._qsDraft = d;
  box.innerHTML = '<div class="alert" style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px;border:1px solid var(--border)">' +
    '<span>Unfinished quote from ' + escHtml(qsWhen(d.savedAt)) + ': ' + escHtml(d.taskName || 'a task') + (d.customer ? ' for ' + escHtml(d.customer) : '') + '</span>' +
    '<span style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" onclick="qsRestoreDraft()">Restore draft</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="qsDiscardDraft()">Discard</button></span></div>';
}
async function qsRestoreDraft() {
  var d = window._qsDraft;
  var box = document.getElementById('qs-draft'); if (box) box.innerHTML = '';
  if (!d) return;
  _qs.city = d.city || _qs.city; _qs.zip = d.zip || ''; _qs.category = d.category || 'residential';
  _qs.account = d.account || null; _qs.customer = d.customer || '';
  qsRenderLeft();
  await qsLoadCatalog();
  if (d.taskId && qsTask(d.taskId)) { _qs.taskId = d.taskId; _qs.qty = d.qty || {}; qsRenderTasks(); qsQueuePrice(true); }
  if (_qs.zip) qsZip(_qs.zip);
}
function qsDiscardDraft() {
  novaDraftDel(qsDraftKey());
  var box = document.getElementById('qs-draft'); if (box) box.innerHTML = '';
}

// ===========================================================================
// Quote Pricing & Scripts (manage_pricing)
// ===========================================================================

var _qa = { data: null, tab: 'rates', cat: 'residential', city: '', taskId: null, draftTask: null, acct: null, acctData: null };
var QA_TABS = [['rates', 'Rate cards'], ['tasks', 'Tasks &amp; flat prices'], ['accounts', 'Account rates'], ['scripts', 'Scripts'], ['settings', 'Settings']];

async function renderQuotePricing(el) {
  if (!can('manage_pricing')) { el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
  qsStyles();
  el.innerHTML = '<div class="page-header"><div><div class="page-title">Quote Pricing &amp; Scripts</div>' +
    '<div class="page-subtitle">Residential and commercial. Every hourly task uses its city&#39;s rate card; flat tasks have their own prices.</div></div>' +
    '<div style="display:flex;gap:8px"><button class="btn btn-secondary btn-sm" onclick="navigate(&#39;quote-script&#39;)">Open the Quote panel</button>' +
    '<button class="btn btn-secondary btn-sm" onclick="navigate(&#39;quote-report&#39;)">Report</button></div></div>' +
    '<div class="qa-tabs" id="qa-tabs"></div><div id="qa-body"><div class="loading">Loading...</div></div>';
  await qaLoad();
}
async function qaLoad() {
  try { _qa.data = await api('GET', '/quote-script/admin'); }
  catch (e) { var b = document.getElementById('qa-body'); if (b) b.innerHTML = '<div class="alert alert-error">' + escHtml(e.message || 'Could not load.') + '</div>'; return; }
  if (!_qa.city && _qa.data.cities.length) _qa.city = _qa.data.cities[0].code;
  qaRender();
}
function qaTab(t) { _qa.tab = t; qaRender(); }
function qaRender() {
  var tabs = document.getElementById('qa-tabs');
  if (tabs) tabs.innerHTML = QA_TABS.map(function (t) {
    return '<button class="btn btn-secondary btn-sm' + (_qa.tab === t[0] ? ' on' : '') + '" onclick="qaTab(&#39;' + t[0] + '&#39;)">' + t[1] + '</button>';
  }).join('');
  var b = document.getElementById('qa-body');
  if (!b || !_qa.data) return;
  if (_qa.tab === 'rates') b.innerHTML = qaRatesHtml();
  else if (_qa.tab === 'tasks') b.innerHTML = qaTasksHtml();
  else if (_qa.tab === 'accounts') b.innerHTML = qaAccountsHtml();
  else if (_qa.tab === 'scripts') b.innerHTML = qaScriptsHtml();
  else b.innerHTML = qaSettingsHtml();
}

// Two clicks for anything that overwrites other cities.
function qaArm(btn, fn) {
  if (btn.getAttribute('data-armed') === '1') { btn.removeAttribute('data-armed'); fn(); return; }
  var orig = btn.innerHTML;
  btn.setAttribute('data-armed', '1');
  btn.innerHTML = 'Click again to confirm';
  setTimeout(function () { if (btn.getAttribute('data-armed') === '1') { btn.removeAttribute('data-armed'); btn.innerHTML = orig; } }, 3500);
}

// ---- rate cards ------------------------------------------------------------
function qaCard(city, category) {
  return _qa.data.rate_cards.filter(function (r) { return r.city_code === city && r.category === category; })[0] || {};
}
function qaRatesHtml() {
  var rows = _qa.data.cities.map(function (c) {
    var r = qaCard(c.code, 'residential'), m = qaCard(c.code, 'commercial');
    var resLive = r.first_hour !== null && r.first_hour !== undefined, comLive = m.first_hour !== null && m.first_hour !== undefined;
    var status = resLive && comLive ? '<span class="qs-pill ok">Live</span>' : (resLive ? '<span class="qs-pill warn">Residential only</span>' :
      (comLive ? '<span class="qs-pill warn">Commercial only</span>' : '<span class="qs-pill bad">Hidden</span>'));
    function inp(cat, f, v) { return '<td><input type="text" class="qa-num" id="qa-rc-' + c.code + '-' + cat + '-' + f + '" value="' + qsInputVal(v) + '" placeholder="not set"></td>'; }
    return '<tr><td><b>' + escHtml(c.name) + '</b></td>' + inp('residential', 'first', r.first_hour) + inp('residential', 'addl', r.addl_hour) +
      inp('commercial', 'first', m.first_hour) + inp('commercial', 'addl', m.addl_hour) + '<td>' + status + '</td>' +
      '<td><button class="btn btn-ghost btn-sm" onclick="qaArm(this,function(){qaCopy(&#39;rate_cards&#39;,&#39;' + c.code + '&#39;)})">Copy to all cities</button></td></tr>';
  }).join('');
  return '<div class="card"><div class="card-body">' +
    '<p class="qa-help" style="margin-top:0">First hour includes the trip. Each additional hour is billed in full hours. Same rate 24/7. ' +
    'A category stays hidden from dispatchers in a city until its first-hour rate is set.</p>' +
    '<div class="table-wrap"><table><thead><tr><th>City</th><th>Res 1st hour</th><th>Res each add&#39;l hr</th><th>Com 1st hour</th><th>Com each add&#39;l hr</th><th>Status</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>' +
    '<div style="text-align:right;margin-top:12px"><button class="btn btn-primary" onclick="qaSaveRates()">Save rate cards</button></div></div></div>';
}
async function qaSaveRates() {
  var rows = [];
  _qa.data.cities.forEach(function (c) {
    ['residential', 'commercial'].forEach(function (cat) {
      var f = document.getElementById('qa-rc-' + c.code + '-' + cat + '-first');
      var a = document.getElementById('qa-rc-' + c.code + '-' + cat + '-addl');
      if (!f || !a) return;
      rows.push({ city_code: c.code, category: cat, first_hour: qsNum(f.value), addl_hour: qsNum(a.value) });
    });
  });
  try {
    var r = await api('PUT', '/quote-script/admin/rate-cards', { rows: rows });
    showToast(r.changed ? ('Saved ' + r.changed + ' change' + (r.changed === 1 ? '' : 's')) : 'Nothing changed', 'success');
    await qaLoad();
  } catch (e) { showToast(e.message || 'Could not save.', 'error'); }
}
async function qaCopy(scope, fromCity, taskId) {
  try {
    var r = await api('POST', '/quote-script/admin/copy', { scope: scope, from_city: fromCity, task_id: taskId || null });
    showToast('Copied to ' + r.to.length + ' cit' + (r.to.length === 1 ? 'y' : 'ies'), 'success');
    await qaLoad();
  } catch (e) { showToast(e.message || 'Could not copy.', 'error'); }
}

// ---- tasks & flat prices -----------------------------------------------------
function qaTasksOf(cat) { return _qa.data.tasks.filter(function (t) { return t.category === cat; }); }
function qaFlat(taskId, city) {
  var p = _qa.data.flat_prices.filter(function (x) { return x.task_id === taskId && x.city_code === city; })[0];
  return p ? p.package_price : null;
}
function qaUnitPrice(taskId, code, city) {
  var p = _qa.data.unit_prices.filter(function (x) { return x.task_id === taskId && x.unit_code === code && x.city_code === city; })[0];
  return p ? p.addl_price : null;
}
function qaSetCat(c) { _qa.cat = c; _qa.taskId = null; _qa.draftTask = null; qaRender(); }
// Prices in the editor belong to one city, so switching city drops any
// unsaved price edits for the old one (names, units and wording are kept).
function qaSetCity(c) { qaCaptureTask(); if (_qa.draftTask) _qa.draftTask.prices = {}; _qa.city = c; qaRender(); }
function qaPickTask(id) {
  var t = _qa.data.tasks.filter(function (x) { return x.id === id; })[0];
  if (!t) return;
  _qa.taskId = id;
  _qa.draftTask = JSON.parse(JSON.stringify(t));
  _qa.draftTask.prices = {};
  qaRender();
}
function qaNewTask() {
  _qa.taskId = 'new';
  _qa.draftTask = { id: null, category: _qa.cat, group_name: '', name: '', pricing: 'hourly', tech_confirms: false, show_parts_line: false,
    upsell_task_id: null, qualify_text: '', price_text: '', policy_text: '', upsell_text: '', sort: (qaTasksOf(_qa.cat).length + 1) * 10, active: true, units: [], prices: {} };
  qaRender();
}

function qaTasksHtml() {
  var list = qaTasksOf(_qa.cat).map(function (t) {
    var fp = qaFlat(t.id, _qa.city);
    var pr = t.pricing === 'hourly' ? '<span class="qs-pill">Hourly</span>' : (fp === null ? '<span class="qs-pill warn">Flat, not set</span>' : '<span class="qs-pill ok">Flat ' + qsMoney(fp) + '</span>');
    return '<tr class="' + (t.id === _qa.taskId ? 'qa-row-on' : '') + '" style="cursor:pointer;' + (t.active ? '' : 'opacity:.5') + '" onclick="qaPickTask(' + t.id + ')">' +
      '<td>' + escHtml(t.group_name) + '</td><td>' + escHtml(t.name) + (t.active ? '' : ' (off)') + '</td><td>' + pr + '</td>' +
      '<td>' + (t.show_parts_line ? 'yes' : '') + '</td><td>' + (t.tech_confirms ? 'yes' : '') + '</td></tr>';
  }).join('');
  var cityOpts = _qa.data.cities.map(function (c) { return '<option value="' + escHtml(c.code) + '"' + (c.code === _qa.city ? ' selected' : '') + '>' + escHtml(c.name) + '</option>'; }).join('');
  return '<div class="filter-bar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">' +
      '<span class="qs-toggle">' + QS_CATS.map(function (k) { return '<button class="' + (_qa.cat === k.k ? 'on' : '') + '" onclick="qaSetCat(&#39;' + k.k + '&#39;)">' + k.l + '</button>'; }).join('') + '</span>' +
      '<label class="qa-help">Prices for</label><select onchange="qaSetCity(this.value)" style="width:auto;max-width:220px">' + cityOpts + '</select>' +
      '<button class="btn btn-ghost btn-sm" onclick="qaArm(this,function(){qaCopy(&#39;all_flat&#39;,_qa.city)})">Copy every flat price in this city to all cities</button>' +
      '<button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="qaNewTask()">+ New task</button></div>' +
    '<div class="qa-two"><div class="card"><div class="table-wrap"><table><thead><tr><th>Group</th><th>Task</th><th>Pricing</th><th>Parts line</th><th>Tech quotes</th></tr></thead><tbody>' +
      (list || '<tr><td colspan="5" class="empty-state">No tasks yet.</td></tr>') + '</tbody></table></div></div>' +
    '<div class="card"><div class="card-body" id="qa-task-editor">' + qaTaskEditorHtml() + '</div></div></div>';
}

function qaTaskEditorHtml() {
  var t = _qa.draftTask;
  if (!t) return '<div class="empty-state">Pick a task to edit it, or add a new one.</div>';
  var city = _qa.city;
  var cityName = (_qa.data.cities.filter(function (c) { return c.code === city; })[0] || {}).name || city;
  var groups = {};
  _qa.data.tasks.forEach(function (x) { groups[x.group_name] = 1; });
  var upsellOpts = '<option value="">None</option>' + qaTasksOf(t.category).filter(function (x) { return x.id !== t.id; }).map(function (x) {
    return '<option value="' + x.id + '"' + (x.id === t.upsell_task_id ? ' selected' : '') + '>' + escHtml(x.name) + '</option>';
  }).join('');
  var flat = t.pricing === 'flat';
  var pkg = t.prices.package !== undefined ? t.prices.package : (t.id ? qaFlat(t.id, city) : null);
  var units = (t.units || []).map(function (u, i) {
    var code = u.code || qsSlug(u.label);
    var p = t.prices['u_' + code] !== undefined ? t.prices['u_' + code] : (t.id ? qaUnitPrice(t.id, code, city) : null);
    return '<tr><td><input type="text" id="qa-u-label-' + i + '" value="' + escHtml(u.label) + '" placeholder="keyway" style="width:100%;min-width:90px"' + (u.code ? ' title="code: ' + escHtml(u.code) + '"' : '') + '></td>' +
      '<td><input type="text" class="qa-num" id="qa-u-inc-' + i + '" value="' + (Number(u.included_qty) || 0) + '" style="width:60px"></td>' +
      '<td><input type="text" class="qa-num" id="qa-u-price-' + i + '" value="' + qsInputVal(p) + '" placeholder="not set"></td>' +
      '<td><button class="btn btn-ghost btn-sm" onclick="qaRemoveUnit(' + i + ')">&#x2715;</button></td></tr>';
  }).join('');
  function ta(id, label, v) {
    return '<label class="qs-label">' + label + '</label><textarea id="' + id + '" rows="2" style="width:100%" placeholder="Blank = use the default script">' + escHtml(v || '') + '</textarea>';
  }
  return '<h3 style="margin:0 0 6px">' + (t.id ? escHtml(t.name) : 'New ' + escHtml(t.category) + ' task') + '</h3>' +
    '<div class="form-row" style="display:flex;gap:8px"><div class="form-group" style="flex:2"><label class="qs-label">Name</label><input type="text" id="qa-t-name" value="' + escHtml(t.name) + '" style="width:100%"></div>' +
      '<div class="form-group" style="flex:1"><label class="qs-label">Group</label><input type="text" id="qa-t-group" list="qa-groups" value="' + escHtml(t.group_name) + '" style="width:100%">' +
      '<datalist id="qa-groups">' + Object.keys(groups).map(function (g) { return '<option value="' + escHtml(g) + '">'; }).join('') + '</datalist></div></div>' +
    '<div style="display:flex;gap:8px"><div style="flex:1"><label class="qs-label">Pricing</label><select id="qa-t-pricing" onchange="qaCaptureTask();_qa.draftTask.pricing=this.value;qaRerenderEditor()" style="width:100%">' +
      '<option value="hourly"' + (flat ? '' : ' selected') + '>Hourly (city rate card)</option><option value="flat"' + (flat ? ' selected' : '') + '>Flat (package price)</option></select></div>' +
      '<div style="flex:1"><label class="qs-label">Upsell</label><select id="qa-t-upsell" style="width:100%">' + upsellOpts + '</select></div>' +
      '<div style="width:80px"><label class="qs-label">Sort</label><input type="text" id="qa-t-sort" value="' + (t.sort || 0) + '" style="width:100%"></div></div>' +
    '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px">' +
      '<label><input type="checkbox" id="qa-t-tech"' + (t.tech_confirms ? ' checked' : '') + '> Tech quotes on site</label>' +
      '<label><input type="checkbox" id="qa-t-parts"' + (t.show_parts_line ? ' checked' : '') + '> Read the parts line</label>' +
      '<label><input type="checkbox" id="qa-t-active"' + (t.active ? ' checked' : '') + '> Active</label></div>' +
    (flat
      ? '<div style="margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:8px">' +
          '<label class="qs-label" style="margin-top:0">Package price in ' + escHtml(cityName) + ' (includes the trip and the included units)</label>' +
          '<input type="text" class="qa-num" id="qa-t-pkg" value="' + qsInputVal(pkg) + '" placeholder="not set">' +
          '<label class="qs-label">Units (extra price is for ' + escHtml(cityName) + ')</label>' +
          '<table style="width:100%"><thead><tr><th>Unit (singular)</th><th>Included</th><th>Each extra</th><th></th></tr></thead><tbody>' + units + '</tbody></table>' +
          '<button class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="qaAddUnit()">+ Add unit</button>' +
          (t.id ? ' <button class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="qaArm(this,function(){qaCopy(&#39;task&#39;,_qa.city,' + t.id + ')})">Copy this task&#39;s ' + escHtml(cityName) + ' prices to all cities</button>' : '') +
        '</div>'
      : '<p class="qa-help" style="margin-top:10px">Hourly: priced from the city&#39;s ' + escHtml(t.category) + ' rate card. Nothing to set here.</p>') +
    '<details style="margin-top:12px"><summary style="cursor:pointer">Script for this task</summary>' +
      ta('qa-t-qualify', 'Qualify questions', t.qualify_text) + ta('qa-t-price', 'Price wording (fields: {price} {included} {first_hour} {addl_hour} {unit_price_&lt;unit&gt;})', t.price_text) +
      ta('qa-t-policy', 'Policies', t.policy_text) + ta('qa-t-upselltext', 'Upsell wording', t.upsell_text) + '</details>' +
    '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button class="btn btn-ghost" onclick="_qa.taskId=null;_qa.draftTask=null;qaRender()">Close</button>' +
      '<button class="btn btn-primary" onclick="qaSaveTask()">Save task</button></div>';
}
function qaRerenderEditor() { var e = document.getElementById('qa-task-editor'); if (e) e.innerHTML = qaTaskEditorHtml(); }
// Read every editor field back into the draft, so adding a unit or switching
// city never throws away what was typed.
function qaCaptureTask() {
  var t = _qa.draftTask;
  if (!t || !document.getElementById('qa-t-name')) return;
  function v(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function c(id) { var e = document.getElementById(id); return !!(e && e.checked); }
  t.name = v('qa-t-name'); t.group_name = v('qa-t-group'); t.pricing = v('qa-t-pricing') || t.pricing;
  t.upsell_task_id = parseInt(v('qa-t-upsell'), 10) || null; t.sort = parseInt(v('qa-t-sort'), 10) || 0;
  t.tech_confirms = c('qa-t-tech'); t.show_parts_line = c('qa-t-parts'); t.active = c('qa-t-active');
  if (document.getElementById('qa-t-qualify')) {
    t.qualify_text = v('qa-t-qualify'); t.price_text = v('qa-t-price'); t.policy_text = v('qa-t-policy'); t.upsell_text = v('qa-t-upselltext');
  }
  if (document.getElementById('qa-t-pkg')) {
    t.prices.package = qsNum(v('qa-t-pkg'));
    (t.units || []).forEach(function (u, i) {
      if (!document.getElementById('qa-u-label-' + i)) return;
      u.label = v('qa-u-label-' + i).trim();
      u.included_qty = parseInt(v('qa-u-inc-' + i), 10) || 0;
      var code = u.code || qsSlug(u.label);
      if (code) t.prices['u_' + code] = qsNum(v('qa-u-price-' + i));
    });
  }
  t._capturedCity = _qa.city;
}
function qaAddUnit() { qaCaptureTask(); _qa.draftTask.units.push({ label: '', included_qty: 0 }); qaRerenderEditor(); }
function qaRemoveUnit(i) { qaCaptureTask(); _qa.draftTask.units.splice(i, 1); qaRerenderEditor(); }

async function qaSaveTask() {
  qaCaptureTask();
  var t = _qa.draftTask;
  if (!t.name.trim()) { showToast('Give the task a name.', 'error'); return; }
  var units = (t.pricing === 'flat' ? t.units : t.units || []).filter(function (u) { return u.label; }).map(function (u) {
    return { code: u.code || qsSlug(u.label), label: u.label, included_qty: u.included_qty };
  });
  var body = { category: t.category, group_name: t.group_name, name: t.name, pricing: t.pricing, tech_confirms: t.tech_confirms,
    show_parts_line: t.show_parts_line, upsell_task_id: t.upsell_task_id, qualify_text: t.qualify_text, price_text: t.price_text,
    policy_text: t.policy_text, upsell_text: t.upsell_text, sort: t.sort, active: t.active, units: units };
  try {
    var r = t.id ? await api('PUT', '/quote-script/admin/tasks/' + t.id, body) : await api('POST', '/quote-script/admin/tasks', body);
    var id = r.id || t.id;
    if (t.pricing === 'flat') {
      var up = {};
      units.forEach(function (u) { if (t.prices['u_' + u.code] !== undefined) up[u.code] = t.prices['u_' + u.code]; });
      await api('PUT', '/quote-script/admin/flat-prices', { task_id: id, city_code: _qa.city, package_price: t.prices.package !== undefined ? t.prices.package : qaFlat(id, _qa.city), units: up });
    }
    showToast('Task saved', 'success');
    await qaLoad();
    qaPickTask(id);
  } catch (e) { showToast(e.message || 'Could not save the task.', 'error'); }
}

// ---- account rates -------------------------------------------------------------
function qaAccountsHtml() {
  var head = '<div class="card" style="margin-bottom:12px"><div class="card-body">' +
    '<p class="qa-help" style="margin-top:0">Accounts with their own rates. Most specific wins: a rate for one city beats "All cities". ' +
    'An account with nothing set follows its "when nothing is set" choice.</p>' +
    '<input type="text" placeholder="Find an account..." oninput="qaAcctSearch(this.value)" style="width:100%;max-width:420px" autocomplete="off"><div id="qa-acct-res" style="max-width:420px"></div></div></div>';
  return head + '<div id="qa-acct-editor">' + qaAcctEditorHtml() + '</div>';
}
function qaAcctSearch(q) {
  clearTimeout(_qsAcctTimer);
  var box = document.getElementById('qa-acct-res');
  if (!q || q.trim().length < 2) { if (box) box.innerHTML = ''; return; }
  _qsAcctTimer = setTimeout(async function () {
    var rows = [];
    try { rows = await api('GET', '/quote-script/accounts?q=' + encodeURIComponent(q.trim())); } catch (e) { rows = []; }
    window._qaAcctRows = rows;
    var b = document.getElementById('qa-acct-res');
    if (b) b.innerHTML = rows.length ? '<div class="qs-acct-res">' + rows.map(function (r, i) {
      return '<div onclick="qaPickAccount(' + i + ')">' + escHtml(r.name) + (r.has_rates ? ' <span class="qs-pill ok">rates</span>' : '') + '</div>';
    }).join('') + '</div>' : '<div class="qa-help">No matching account.</div>';
  }, 250);
}
async function qaPickAccount(i) {
  var r = (window._qaAcctRows || [])[i];
  if (!r) return;
  var b = document.getElementById('qa-acct-res'); if (b) b.innerHTML = '';
  try {
    var d = await api('GET', '/quote-script/admin/accounts/' + r.id);
    _qa.acctData = { account: d.account, fallback: d.account.quote_fallback || 'no_quote', rates: d.rates, task_prices: d.task_prices };
  } catch (e) { showToast(e.message || 'Could not load the account.', 'error'); return; }
  var ed = document.getElementById('qa-acct-editor'); if (ed) ed.innerHTML = qaAcctEditorHtml();
}
function qaCitySelect(id, val, allLabel) {
  return '<select id="' + id + '" style="width:auto"><option value="">' + allLabel + '</option>' + _qa.data.cities.map(function (c) {
    return '<option value="' + escHtml(c.code) + '"' + (String(val || '').trim() === c.code ? ' selected' : '') + '>' + escHtml(c.name) + '</option>';
  }).join('') + '</select>';
}
function qaAcctEditorHtml() {
  var d = _qa.acctData;
  if (!d) return '';
  var rates = d.rates.map(function (r, i) {
    return '<tr><td><select id="qa-ar-cat-' + i + '" style="width:auto">' + QS_CATS.map(function (k) { return '<option value="' + k.k + '"' + (r.category === k.k ? ' selected' : '') + '>' + k.l + '</option>'; }).join('') + '</select></td>' +
      '<td>' + qaCitySelect('qa-ar-city-' + i, r.city_code, 'All cities') + '</td>' +
      '<td><input type="text" class="qa-num" id="qa-ar-first-' + i + '" value="' + qsInputVal(r.first_hour) + '"></td>' +
      '<td><input type="text" class="qa-num" id="qa-ar-addl-' + i + '" value="' + qsInputVal(r.addl_hour) + '"></td>' +
      '<td><button class="btn btn-ghost btn-sm" onclick="qaAcctRemove(&#39;rates&#39;,' + i + ')">&#x2715;</button></td></tr>';
  }).join('');
  var flatTasks = _qa.data.tasks.filter(function (t) { return t.pricing === 'flat' && t.active; });
  var prices = d.task_prices.map(function (p, i) {
    var task = _qa.data.tasks.filter(function (t) { return t.id === p.task_id; })[0] || { units: [] };
    var up = p.unit_prices || {};
    return '<tr><td><select id="qa-ap-task-' + i + '" onchange="qaAcctCapture();_qa.acctData.task_prices[' + i + '].task_id=parseInt(this.value,10);qaAcctRerender()" style="width:auto">' +
        flatTasks.map(function (t) { return '<option value="' + t.id + '"' + (t.id === p.task_id ? ' selected' : '') + '>' + escHtml(t.name) + ' (' + t.category.slice(0, 3) + ')</option>'; }).join('') + '</select></td>' +
      '<td>' + qaCitySelect('qa-ap-city-' + i, p.city_code, 'All cities') + '</td>' +
      '<td><input type="text" class="qa-num" id="qa-ap-pkg-' + i + '" value="' + qsInputVal(p.package_price) + '"></td>' +
      '<td>' + task.units.map(function (u) {
        return '<span style="white-space:nowrap;margin-right:8px">' + escHtml(u.label) + ' <input type="text" class="qa-num" style="width:76px" id="qa-ap-u-' + i + '-' + escHtml(u.code) + '" value="' + qsInputVal(up[u.code]) + '" placeholder="retail"></span>';
      }).join('') + '</td>' +
      '<td><button class="btn btn-ghost btn-sm" onclick="qaAcctRemove(&#39;task_prices&#39;,' + i + ')">&#x2715;</button></td></tr>';
  }).join('');
  return '<div class="card"><div class="card-body"><h3 style="margin:0 0 8px">' + escHtml(d.account.name) + '</h3>' +
    '<div style="margin-bottom:12px"><b>When nothing is set for a job:</b> ' +
      '<label style="margin-left:10px"><input type="radio" name="qa-fb" value="no_quote"' + (d.fallback !== 'retail' ? ' checked' : '') + ' onchange="_qa.acctData.fallback=this.value"> Do not quote, bill per account terms</label>' +
      '<label style="margin-left:10px"><input type="radio" name="qa-fb" value="retail"' + (d.fallback === 'retail' ? ' checked' : '') + ' onchange="_qa.acctData.fallback=this.value"> Quote retail</label></div>' +
    '<h4 style="margin:12px 0 6px">Hourly rates</h4><div class="table-wrap"><table><thead><tr><th>Category</th><th>City</th><th>1st hour</th><th>Each add&#39;l hr</th><th></th></tr></thead><tbody>' +
      (rates || '<tr><td colspan="5" class="text-muted">None. Retail or do-not-quote applies.</td></tr>') + '</tbody></table></div>' +
    '<button class="btn btn-ghost btn-sm" onclick="qaAcctAdd(&#39;rates&#39;)">+ Hourly rate</button>' +
    '<h4 style="margin:16px 0 6px">Flat task prices</h4><div class="table-wrap"><table><thead><tr><th>Task</th><th>City</th><th>Package</th><th>Each extra (blank = retail)</th><th></th></tr></thead><tbody>' +
      (prices || '<tr><td colspan="5" class="text-muted">None.</td></tr>') + '</tbody></table></div>' +
    (flatTasks.length ? '<button class="btn btn-ghost btn-sm" onclick="qaAcctAdd(&#39;task_prices&#39;)">+ Flat task price</button>' : '') +
    '<div style="text-align:right;margin-top:12px"><button class="btn btn-primary" onclick="qaSaveAccount()">Save account rates</button></div></div></div>';
}
function qaAcctRerender() { var ed = document.getElementById('qa-acct-editor'); if (ed) ed.innerHTML = qaAcctEditorHtml(); }
function qaAcctCapture() {
  var d = _qa.acctData;
  if (!d) return;
  function v(id) { var e = document.getElementById(id); return e ? e.value : null; }
  d.rates.forEach(function (r, i) {
    if (v('qa-ar-cat-' + i) === null) return;
    r.category = v('qa-ar-cat-' + i); r.city_code = v('qa-ar-city-' + i) || '';
    r.first_hour = qsNum(v('qa-ar-first-' + i)); r.addl_hour = qsNum(v('qa-ar-addl-' + i));
  });
  d.task_prices.forEach(function (p, i) {
    if (v('qa-ap-task-' + i) === null) return;
    p.task_id = parseInt(v('qa-ap-task-' + i), 10); p.city_code = v('qa-ap-city-' + i) || '';
    p.package_price = qsNum(v('qa-ap-pkg-' + i));
    var task = _qa.data.tasks.filter(function (t) { return t.id === p.task_id; })[0] || { units: [] };
    var up = {};
    task.units.forEach(function (u) { var n = qsNum(v('qa-ap-u-' + i + '-' + u.code)); if (n !== null) up[u.code] = n; });
    p.unit_prices = up;
  });
}
function qaAcctAdd(kind) {
  qaAcctCapture();
  if (kind === 'rates') _qa.acctData.rates.push({ category: 'commercial', city_code: '', first_hour: null, addl_hour: null });
  else {
    var ft = _qa.data.tasks.filter(function (t) { return t.pricing === 'flat' && t.active; })[0];
    if (ft) _qa.acctData.task_prices.push({ task_id: ft.id, city_code: '', package_price: null, unit_prices: {} });
  }
  qaAcctRerender();
}
function qaAcctRemove(kind, i) { qaAcctCapture(); _qa.acctData[kind].splice(i, 1); qaAcctRerender(); }
async function qaSaveAccount() {
  qaAcctCapture();
  var d = _qa.acctData;
  try {
    await api('PUT', '/quote-script/admin/accounts/' + d.account.id, { fallback: d.fallback, rates: d.rates, task_prices: d.task_prices });
    showToast('Account rates saved', 'success');
  } catch (e) { showToast(e.message || 'Could not save.', 'error'); }
}

// ---- scripts ---------------------------------------------------------------------
function qaBlock(key, cat) {
  var b = _qa.data.blocks.filter(function (x) { return x.block_key === key && (x.category || '') === cat; })[0];
  return b ? (b.body || '') : '';
}
function qaScriptsHtml() {
  return '<p class="qa-help" style="margin-top:0">Read in this order: Greeting, Qualify, Price, Policies, Upsell, Close. A task&#39;s own wording ' +
    '(Tasks tab) beats these. A Residential or Commercial override beats Global; leave an override blank to use Global.<br>' +
    'Fields: {first_hour} {addl_hour} {price} {included} {task} {city} {eta} {parts_line} {surcharge_disclosure} {upsell_task} {upsell_price} {upsell_included} {account} {dispatcher}</p>' +
    _qa.data.block_keys.map(function (k) {
      var r = qaBlock(k.key, 'residential'), c = qaBlock(k.key, 'commercial');
      return '<div class="qa-block"><b>' + escHtml(k.label) + '</b> <span class="qa-help">' + escHtml(k.help) + '</span>' +
        '<textarea id="qa-b-' + k.key + '-g" style="margin-top:6px">' + escHtml(qaBlock(k.key, '')) + '</textarea>' +
        '<details' + (r || c ? ' open' : '') + ' style="margin-top:6px"><summary class="qa-help" style="cursor:pointer">Residential / Commercial overrides</summary>' +
          '<label class="qs-label">Residential</label><textarea id="qa-b-' + k.key + '-r">' + escHtml(r) + '</textarea>' +
          '<label class="qs-label">Commercial</label><textarea id="qa-b-' + k.key + '-c">' + escHtml(c) + '</textarea></details></div>';
    }).join('') +
    '<div style="text-align:right"><button class="btn btn-primary" onclick="qaSaveScripts()">Save scripts</button></div>';
}
async function qaSaveScripts() {
  var out = [];
  _qa.data.block_keys.forEach(function (k) {
    [['g', ''], ['r', 'residential'], ['c', 'commercial']].forEach(function (p) {
      var e = document.getElementById('qa-b-' + k.key + '-' + p[0]);
      if (e) out.push({ block_key: k.key, category: p[1], body: e.value });
    });
  });
  try { await api('PUT', '/quote-script/admin/blocks', { blocks: out }); showToast('Scripts saved', 'success'); await qaLoad(); }
  catch (e) { showToast(e.message || 'Could not save.', 'error'); }
}

// ---- settings --------------------------------------------------------------------
function qaSettingsHtml() {
  var s = _qa.data.settings;
  return '<div class="card"><div class="card-body">' +
    '<label class="qs-label" style="margin-top:0">Parts line (one line for every task that reads it)</label><input type="text" id="qa-s-parts" value="' + escHtml(s.parts_line) + '" style="width:100%">' +
    '<label class="qs-label">Card surcharge disclosure (read on every quote; never part of the price)</label><input type="text" id="qa-s-surcharge" value="' + escHtml(s.surcharge_disclosure) + '" style="width:100%">' +
    '<label class="qs-label">Decline reasons (one per line)</label><textarea id="qa-s-reasons" rows="7" style="width:100%">' + escHtml(_qa.data.decline_reasons.join('\n')) + '</textarea>' +
    '<div style="text-align:right;margin-top:12px"><button class="btn btn-primary" onclick="qaSaveSettings()">Save settings</button></div></div></div>';
}
async function qaSaveSettings() {
  var reasons = document.getElementById('qa-s-reasons').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
  if (!reasons.length) { showToast('Keep at least one decline reason.', 'error'); return; }
  try {
    await api('PUT', '/quote-script/admin/settings', {
      parts_line: document.getElementById('qa-s-parts').value,
      surcharge_disclosure: document.getElementById('qa-s-surcharge').value,
      decline_reasons: reasons
    });
    showToast('Settings saved', 'success');
    await qaLoad();
  } catch (e) { showToast(e.message || 'Could not save.', 'error'); }
}

// ===========================================================================
// Quote Report (manage_pricing)
// ===========================================================================
var _qr = { from: '', to: '' };
async function renderQuoteReport(el) {
  if (!can('manage_pricing')) { el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
  qsStyles();
  if (!_qr.to) {
    var d = new Date(); _qr.to = d.toISOString().slice(0, 10);
    _qr.from = new Date(d.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  }
  el.innerHTML = '<div class="page-header"><div><div class="page-title">Quote Report</div><div class="page-subtitle">Residential and commercial quotes logged from the Quote panel</div></div>' +
    '<div style="display:flex;gap:8px;align-items:center"><input type="date" id="qr-from" value="' + _qr.from + '"><span class="text-muted">to</span>' +
    '<input type="date" id="qr-to" value="' + _qr.to + '"><button class="btn btn-secondary btn-sm" onclick="qrApply()">Apply</button></div></div>' +
    '<div id="qr-body"><div class="loading">Loading...</div></div>';
  var r;
  try { r = await api('GET', '/quote-script/report?from=' + _qr.from + '&to=' + _qr.to); }
  catch (e) { document.getElementById('qr-body').innerHTML = '<div class="alert alert-error">' + escHtml(e.message || 'Could not load.') + '</div>'; return; }
  var t = r.totals;
  function pct(a, b) { return b ? Math.round(a * 100 / b) + '%' : '-'; }
  function stat(v, l) { return '<div class="stat-card"><div class="stat-value">' + v + '</div><div class="stat-label">' + l + '</div></div>'; }
  function tbl(title, rows) {
    return '<div class="card"><div class="card-header"><span class="card-title">' + title + '</span></div><div class="card-body"><div class="table-wrap"><table>' +
      '<thead><tr><th></th><th class="text-right">Quotes</th><th class="text-right">Booked</th><th class="text-right">Close rate</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (x) {
        return '<tr><td>' + escHtml(x.k || '') + '</td><td class="text-right">' + x.quotes + '</td><td class="text-right">' + x.booked + '</td><td class="text-right">' + pct(x.booked, x.quotes) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="text-muted">Nothing yet.</td></tr>') + '</tbody></table></div></div></div>';
  }
  function list(title, rows) {
    return '<div class="card"><div class="card-header"><span class="card-title">' + title + '</span></div><div class="card-body"><div class="table-wrap"><table><tbody>' +
      (rows.length ? rows.map(function (x) { return '<tr><td>' + escHtml(x.k || '') + '</td><td class="text-right">' + x.n + '</td></tr>'; }).join('') : '<tr><td class="text-muted">Nothing.</td></tr>') +
      '</tbody></table></div></div></div>';
  }
  document.getElementById('qr-body').innerHTML =
    '<div class="stats-grid" style="margin-bottom:14px">' + stat(t.quotes, 'Quotes') + stat(pct(t.booked, t.quotes), 'Booked') +
      stat(t.asap + ' / ' + t.scheduled, 'ASAP / Scheduled') + stat(t.avg_quoted ? qsMoney(t.avg_quoted) : '-', 'Avg quoted') +
      stat(t.upsell_offered ? pct(t.upsell_accepted, t.upsell_offered) : '-', 'Upsell taken') + stat(t.price_missing, 'Hit "Price not set"') + '</div>' +
    '<div class="qr-grid">' + tbl('By task', r.by_task) + tbl('By dispatcher', r.by_dispatcher) +
      tbl('By city', r.by_city) + list('Decline reasons', r.decline_reasons) + list('Price not set (fill these first)', r.price_missing) +
      '<div class="card"><div class="card-header"><span class="card-title">Callbacks still open after 24 hours</span></div><div class="card-body"><div class="table-wrap"><table><tbody>' +
        (r.open_callbacks.length ? r.open_callbacks.map(function (q) {
          return '<tr><td>' + escHtml(qsWhen(q.created_at)) + '</td><td>' + escHtml(q.created_by_name || '') + '</td><td>' + escHtml(q.task_name || '') + '</td><td>' + escHtml(q.customer_name || '') + '</td><td class="text-right">' + qsMoney(q.total) + '</td></tr>';
        }).join('') : '<tr><td class="text-muted">None.</td></tr>') + '</tbody></table></div></div></div>' +
    '</div>';
}
function qrApply() {
  _qr.from = document.getElementById('qr-from').value || _qr.from;
  _qr.to = document.getElementById('qr-to').value || _qr.to;
  navigate('quote-report');
}
