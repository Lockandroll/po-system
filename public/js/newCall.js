// ===========================================================================
//  NEW CALL - full-page screen (desktop) / single column (phone)
// ===========================================================================
// Plan: project doc claude/nova-dispatch-new-call-plan.md (Tony 2026-10-13).
//
//  - Anyone with manage_dispatch OR add_dispatch_call can open it. The server
//    checks the same thing on every endpoint this page calls.
//  - Required: callback phone, customer name, service type, address, zip. The
//    city fills itself from the zip.
//  - Typing the callback number looks the caller up: a call already on the
//    board gets a banner with Open call; finished calls offer Open, Fill from
//    this call and Redispatch.
//  - Price and ETA come from the same pricing code the create uses, shown live
//    before the call is saved. Leaving the boxes blank lets the server price it;
//    typing a number overrides it (what the customer was told wins).
//  - Who goes: people who may assign get a list (Nobody yet is the default for
//    now; best ETA ranking is a later step). Everyone else gets "Take this call
//    myself".
//  - Half-typed calls survive a reload: autosaved per person in IndexedDB.
//
//  Classic script, string building only. No backticks (Windows corruption rule).
// ---------------------------------------------------------------------------

var _ncRef = null;
var _ncS = null;            // per-render state
var _ncT = {};              // debounce timers
var NC_FIELDS = ['cb', 'cid', 'name', 'biz', 'email', 'svc', 'addr', 'zip', 'city', 'cross', 'vloc',
  'vyear', 'vmake', 'vmodel', 'vcolor', 'plate', 'tstate', 'account', 'po', 'notes', 'price', 'eta'];
var NC_REQUIRED = { cb: 'callback phone', name: 'customer name', svc: 'service type', addr: 'address', zip: 'zip' };
var NC_TECH_ROLES = ['locksmith', 'roadside_technician'];

function ncEl(id) { return document.getElementById('nc-' + id); }
function ncVal(id) { var e = ncEl(id); return e ? String(e.value || '').trim() : ''; }
function ncSet(id, v) { var e = ncEl(id); if (e) e.value = (v === null || v === undefined) ? '' : String(v); }
function ncDigits(s) { return String(s || '').replace(/[^0-9]/g, '').slice(-10); }
function ncDebounce(key, ms, fn) { clearTimeout(_ncT[key]); _ncT[key] = setTimeout(fn, ms); }
function ncDraftKey() { return 'dispatchnew:' + ((state.user && state.user.id) || 0); }
function ncMoney(n) { var x = parseFloat(n); return isFinite(x) ? '$' + x.toFixed(2) : ''; }
function ncAgo(t) {
  if (!t) return '';
  var d = new Date(t); if (isNaN(d)) return '';
  var days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return days + ' days ago';
  return d.toLocaleDateString();
}

// Nova's own confirm dialog when it is there (a browser confirm() freezes the page).
async function ncConfirm(msg) {
  if (typeof novaConfirm === 'function') return !!(await novaConfirm(msg));
  return window.confirm(msg);
}

function ncInjectStyles() {
  if (document.getElementById('nc-styles')) return;
  var css =
    '.nc-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}' +
    '.nc-head .nc-title{font-size:22px;font-weight:700;flex:1;min-width:160px}' +
    '.nc-saved{font-size:12px;color:var(--text-muted-color)}' +
    '.nc-wrap{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}' +
    '.nc-main{display:flex;flex-direction:column;gap:14px;min-width:0}' +
    '.nc-aside{display:flex;flex-direction:column;gap:14px;position:sticky;top:12px}' +
    '.nc-card{background:var(--card-bg,#1a1a1a);border:1px solid var(--border,#2a2a2a);border-radius:12px;padding:16px}' +
    '.nc-card h3{margin:0 0 12px;font-size:12px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--text-muted-color)}' +
    '.nc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}' +
    '.nc-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 12px}' +
    '.nc-req{color:var(--danger,#ef4444);margin-left:2px}' +
    '.nc-miss input,.nc-miss select{border-color:var(--danger,#ef4444)!important;box-shadow:0 0 0 2px rgba(239,68,68,.2)}' +
    '.nc-banner{border-radius:10px;padding:12px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:14px;margin-top:10px}' +
    '.nc-banner.warn{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.5)}' +
    '.nc-banner.info{background:rgba(59,130,246,.10);border:1px solid rgba(59,130,246,.45)}' +
    '.nc-banner.bad{background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.5)}' +
    '.nc-banner .nc-grow{flex:1;min-width:180px}' +
    '.nc-prev{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--border,#2a2a2a);font-size:13px}' +
    '.nc-prev:first-child{border-top:0}' +
    '.nc-seg{display:flex;gap:6px}' +
    '.nc-seg button{flex:1;height:40px;border-radius:8px;border:1px solid var(--border,#2e2e2e);background:transparent;color:inherit;font:inherit;font-size:14px;cursor:pointer}' +
    '.nc-seg button.on{border-color:var(--primary,#f97316);background:rgba(249,115,22,.14);color:var(--primary,#f97316);font-weight:700}' +
    '.nc-price{font-size:34px;font-weight:700;line-height:1.1}' +
    '.nc-sub{font-size:13px;color:var(--text-muted-color)}' +
    '.nc-who label{display:flex;gap:10px;align-items:center;padding:9px 4px;border-top:1px solid var(--border,#2a2a2a);cursor:pointer;font-size:14px;margin:0}' +
    '.nc-who label:first-child{border-top:0}' +
    '.nc-who input{width:18px;height:18px;margin:0;padding:0;accent-color:var(--primary,#f97316)}' +
    '.nc-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}' +
    '.nc-actions{display:flex;flex-direction:column;gap:8px}' +
    '.nc-actions .btn{width:100%;justify-content:center;min-height:46px;font-size:15px}' +
    '.nc-check{display:flex;gap:10px;align-items:flex-start;cursor:pointer;margin:0}' +
    '.nc-check input{width:18px;height:18px;margin:2px 0 0;padding:0;accent-color:var(--primary,#f97316);flex:none}' +
    '@media (max-width:760px){' +
      '.nc-wrap{grid-template-columns:minmax(0,1fr)}' +
      '.nc-aside{position:static}' +
      '.nc-grid,.nc-grid3{grid-template-columns:minmax(0,1fr)}' +
      '.nc-grid3.nc-keep{grid-template-columns:repeat(3,minmax(0,1fr))}' +
      '.nc-wrap{padding-bottom:84px}' +
      '.nc-actions{position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--bg,#0f0f0f);' +
        'padding:10px calc(16px + env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left));' +
        'flex-direction:row;border-top:1px solid var(--border,#2a2a2a)}' +
      '.nc-head .nc-title{min-width:0}' +
      '.nc-head .nc-back{display:none}' +
      '.nc-actions .btn{min-height:52px}' +
      '.nc-actions .nc-another{display:none}' +
      '.nc-card input,.nc-card select,.nc-card textarea{font-size:16px}' +
    '}';
  var st = document.createElement('style');
  st.id = 'nc-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

// --- options ---------------------------------------------------------------
function ncSvcOptions() {
  var types = (_ncRef && _ncRef.service_types) || [];
  var cats = (_ncRef && _ncRef.categories) || [];
  var out = '<option value="">Pick a service...</option>';
  var used = {};
  cats.forEach(function (c) {
    var group = types.filter(function (t) { return t.category_code === c.code; });
    if (!group.length) return;
    out += '<optgroup label="' + escHtml(c.name) + '">' + group.map(function (t) {
      used[t.id] = 1;
      return '<option value="' + t.id + '">' + escHtml(t.name) + '</option>';
    }).join('') + '</optgroup>';
  });
  var rest = types.filter(function (t) { return !used[t.id]; });
  if (rest.length) out += rest.map(function (t) { return '<option value="' + t.id + '">' + escHtml(t.name) + '</option>'; }).join('');
  return out;
}
function ncCityOptions() {
  return '<option value="">From the zip...</option>' + ((_ncRef && _ncRef.cities) || []).map(function (c) {
    return '<option value="' + escHtml(String(c.code || '').trim()) + '">' + escHtml(c.name) + '</option>';
  }).join('');
}
function ncAccountOptions() {
  var accts = ((_ncRef && _ncRef.accounts) || []).slice().sort(function (a, b) {
    var ta = a.dispatch_tier || 9, tb = b.dispatch_tier || 9;
    return ta !== tb ? ta - tb : String(a.name).localeCompare(String(b.name));
  });
  return '<option value="">Retail (no account)</option>' + accts.map(function (a) {
    return '<option value="' + a.id + '">' + escHtml(a.name) +
      (a.dispatch_tier ? ' (Tier ' + a.dispatch_tier + ')' : '') + (a.po_required ? ' - PO required' : '') + '</option>';
  }).join('');
}
function ncCityName(code) {
  code = String(code || '').trim();
  var c = (((_ncRef && _ncRef.cities) || []).filter(function (x) { return String(x.code || '').trim() === code; }))[0];
  return c ? c.name : code;
}

// --- page ------------------------------------------------------------------
function ncField(id, label, attrs, wide) {
  var req = NC_REQUIRED[id] ? '<span class="nc-req" aria-hidden="true">*</span>' : '';
  return '<div class="form-group" id="nc-g-' + id + '"' + (wide ? ' style="grid-column:1/-1"' : '') + '>' +
    '<label for="nc-' + id + '">' + label + req + '</label>' +
    '<input id="nc-' + id + '" ' + (attrs || '') + (NC_REQUIRED[id] ? ' aria-required="true"' : '') + '></div>';
}
function ncSelect(id, label, opts) {
  var req = NC_REQUIRED[id] ? '<span class="nc-req" aria-hidden="true">*</span>' : '';
  return '<div class="form-group" id="nc-g-' + id + '"><label for="nc-' + id + '">' + label + req + '</label>' +
    '<select id="nc-' + id + '"' + (NC_REQUIRED[id] ? ' aria-required="true"' : '') + '>' + opts + '</select></div>';
}

function ncPageHtml(me) {
  var takeDefault = NC_TECH_ROLES.indexOf(String(me.role || '')) !== -1;
  var geoBtn = (_ncRef && _ncRef.geocode_ready && navigator.geolocation)
    ? '<button type="button" class="btn btn-secondary btn-sm" id="nc-geo" onclick="ncUseMyLocation()">Use my location</button>' : '';
  var backBtn = can('view_dispatch')
    ? '<button type="button" class="btn btn-ghost btn-sm nc-back" onclick="navigate(&quot;dispatch&quot;)">Back to the board</button>' : '';
  var who = me.can_assign
    ? '<div class="nc-who" id="nc-who"><div class="nc-sub">Pick a service and city to see who can go.</div></div>'
    : '<label class="nc-check" for="nc-take"><input type="checkbox" id="nc-take"' + (takeDefault ? ' checked' : '') + '>' +
        '<span><b>Take this call myself</b><br><span class="nc-sub">Leave it off to put it on the board for dispatch.</span></span></label>';

  return '' +
    '<div class="nc-head">' +
      '<div class="nc-title">New call</div>' +
      '<span class="nc-saved" id="nc-saved" aria-live="polite"></span>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="ncDiscard()">Discard draft</button>' +
      backBtn +
    '</div>' +
    '<div id="nc-redo"></div>' +
    '<form class="nc-wrap" id="nc-form" onsubmit="event.preventDefault();ncSubmit(false)" novalidate>' +
      '<div class="nc-main">' +

        '<section class="nc-card" aria-labelledby="nc-h-caller"><h3 id="nc-h-caller">Caller</h3>' +
          '<div class="nc-grid">' +
            ncField('cb', 'Callback phone', 'type="tel" inputmode="tel" autocomplete="off" placeholder="(555) 555-5555"') +
            ncField('cid', 'Caller ID', 'type="tel" inputmode="tel" autocomplete="off"') +
            ncField('name', 'Customer name', 'autocomplete="off" placeholder="Name on the call"') +
            ncField('biz', 'Business name', 'autocomplete="off"') +
            ncField('email', 'Email', 'type="email" inputmode="email" autocomplete="off"', true) +
          '</div>' +
          '<div id="nc-lookup" aria-live="polite"></div>' +
        '</section>' +

        '<section class="nc-card" aria-labelledby="nc-h-need"><h3 id="nc-h-need">What they need</h3>' +
          '<div class="nc-grid">' +
            ncSelect('svc', 'Service type', ncSvcOptions()) +
            '<div class="form-group"><label>Priority</label><div class="nc-seg" id="nc-pri" role="radiogroup" aria-label="Priority">' +
              '<button type="button" role="radio" data-v="normal" class="on" aria-checked="true" onclick="ncPri(&quot;normal&quot;)">Normal</button>' +
              '<button type="button" role="radio" data-v="urgent" aria-checked="false" onclick="ncPri(&quot;urgent&quot;)">Urgent</button>' +
              '<button type="button" role="radio" data-v="low" aria-checked="false" onclick="ncPri(&quot;low&quot;)">Low</button>' +
            '</div></div>' +
          '</div>' +
          '<label class="nc-check" for="nc-edu"><input type="checkbox" id="nc-edu">' +
            '<span><b>EDU</b> - child or pet locked in a vehicle <span class="nc-sub">(forces urgent and alerts until somebody has it)</span></span></label>' +
        '</section>' +

        '<section class="nc-card" aria-labelledby="nc-h-where"><h3 id="nc-h-where" style="display:flex;align-items:center;gap:10px">' +
            '<span style="flex:1">Where</span>' + geoBtn + '</h3>' +
          '<div class="nc-grid">' +
            ncField('addr', 'Address', 'autocomplete="off" placeholder="Street address"', true) +
            ncField('zip', 'Zip', 'inputmode="numeric" autocomplete="off" maxlength="10"') +
            ncSelect('city', 'Our city', ncCityOptions()) +
            ncField('cross', 'Cross street', 'autocomplete="off"') +
            ncField('vloc', 'Exact spot', 'autocomplete="off" placeholder="Front lot, level 2..."') +
          '</div>' +
          '<div id="nc-where-note" aria-live="polite"></div>' +
        '</section>' +

        '<section class="nc-card" aria-labelledby="nc-h-veh"><h3 id="nc-h-veh">Vehicle</h3>' +
          '<div class="nc-grid3 nc-keep">' +
            ncField('vyear', 'Year', 'inputmode="numeric" maxlength="4"') +
            ncField('vmake', 'Make', 'autocomplete="off"') +
            ncField('vmodel', 'Model', 'autocomplete="off"') +
          '</div>' +
          '<div class="nc-grid3 nc-keep">' +
            ncField('vcolor', 'Color', 'autocomplete="off"') +
            ncField('plate', 'Plate', 'autocapitalize="characters" autocomplete="off"') +
            ncField('tstate', 'State', 'autocapitalize="characters" maxlength="4" autocomplete="off"') +
          '</div>' +
        '</section>' +

        '<section class="nc-card" aria-labelledby="nc-h-acct"><h3 id="nc-h-acct">Account and notes</h3>' +
          '<div class="nc-grid">' +
            ncSelect('account', 'Account', ncAccountOptions()) +
            '<div class="form-group" id="nc-g-po"><label for="nc-po">Account PO <span class="nc-req" id="nc-po-req"></span></label><input id="nc-po" autocomplete="off"></div>' +
          '</div>' +
          '<div id="nc-acct-note"></div>' +
          '<div class="form-group" style="margin-bottom:0"><label for="nc-notes">Notes for the tech</label>' +
            '<textarea id="nc-notes" rows="3" placeholder="Gate code, keys inside, anything the tech needs"></textarea></div>' +
        '</section>' +
      '</div>' +

      '<aside class="nc-aside">' +
        '<section class="nc-card" aria-labelledby="nc-h-quote"><h3 id="nc-h-quote">Quote</h3>' +
          '<div id="nc-quote" aria-live="polite"><div class="nc-sub">Pick a service and enter the zip to see the price.</div></div>' +
          '<div class="nc-grid" style="margin-top:12px">' +
            '<div class="form-group" style="margin-bottom:0"><label for="nc-price">Price override</label><input id="nc-price" inputmode="decimal" autocomplete="off"></div>' +
            '<div class="form-group" style="margin-bottom:0"><label for="nc-eta">ETA min</label><input id="nc-eta" inputmode="numeric" autocomplete="off"></div>' +
          '</div>' +
          '<div class="nc-sub" style="margin-top:6px">Leave blank to use the quote.</div>' +
        '</section>' +
        '<section class="nc-card" aria-labelledby="nc-h-who"><h3 id="nc-h-who">Who goes</h3>' + who + '</section>' +
        (_ncRef && _ncRef.customer_link_enabled
          ? '<label class="nc-check" for="nc-link" style="padding:0 2px"><input type="checkbox" id="nc-link" checked>' +
            '<span><b>Text the customer a link</b><br><span class="nc-sub">Status, tech photo, fix details, add ID, cancel.</span></span></label>'
          : '') +
        '<div id="nc-err" role="alert"></div>' +
        '<div class="nc-actions">' +
          '<button type="submit" class="btn btn-primary" id="nc-go">Create call</button>' +
          '<button type="button" class="btn btn-secondary nc-another" onclick="ncSubmit(true)">Create and start another</button>' +
        '</div>' +
      '</aside>' +
    '</form>';
}

async function renderDispatchNew(content, param) {
  if (typeof dispStop === 'function') dispStop();
  if (typeof dispInjectStyles === 'function') dispInjectStyles();
  ncInjectStyles();
  Object.keys(_ncT).forEach(function (k) { clearTimeout(_ncT[k]); });
  content.innerHTML = '<div class="nc-head"><div class="nc-title">New call</div></div><div class="nc-sub">Loading...</div>';
  try { _ncRef = await api('GET', '/dispatch/reference'); }
  catch (e) {
    content.innerHTML = '<div class="nc-head"><div class="nc-title">New call</div></div>' +
      '<div class="nc-card">' + escHtml(e.message || 'Could not load the call form.') + '</div>';
    return;
  }
  if (typeof _dispRef !== 'undefined' && !_dispRef) _dispRef = _ncRef;
  var me = _ncRef.me || {};
  if (!me.can_create) {
    content.innerHTML = '<div class="nc-head"><div class="nc-title">New call</div></div>' +
      '<div class="nc-card">You are not set up to add calls. Ask a manager to turn on Add Calls for your role.</div>';
    return;
  }
  _ncS = { me: me, redispatchOf: null, redispatchLabel: '', pri: 'normal', cityTouched: false,
    lookupKey: '', quoteKey: '', whoKey: '', assignTo: '', loading: false, ready: false };
  content.innerHTML = ncPageHtml(me);
  ncWire();

  var redo = /^r(\d+)$/.exec(String(param || ''));
  if (redo) {
    await ncLoadRedispatch(parseInt(redo[1], 10));
  } else {
    var d = null;
    try { d = typeof novaDraftGet === 'function' ? await novaDraftGet(ncDraftKey()) : null; } catch (e) { d = null; }
    if (d && d.fields) {
      ncApplyDraft(d);
      ncSaved('Draft restored');
    }
  }
  _ncS.ready = true;
  ncAccountChanged();
  ncLookupNow();
  ncQuoteNow();
  var first = ncEl('cb');
  if (first && !ncVal('cb') && window.innerWidth > 760) first.focus();
}

function ncWire() {
  var form = document.getElementById('nc-form');
  if (!form) return;
  form.addEventListener('input', function (ev) {
    var id = String((ev.target && ev.target.id) || '').replace(/^nc-/, '');
    var g = document.getElementById('nc-g-' + id);
    if (g) g.classList.remove('nc-miss');
    if (id === 'cb') ncDebounce('lookup', 450, ncLookupNow);
    if (id === 'zip') ncDebounce('quote', 400, ncQuoteNow);
    ncScheduleDraft();
  });
  form.addEventListener('change', function (ev) {
    var id = String((ev.target && ev.target.id) || '').replace(/^nc-/, '');
    var g = document.getElementById('nc-g-' + id);
    if (g) g.classList.remove('nc-miss');
    if (id === 'city') _ncS.cityTouched = !!ncVal('city');
    if (id === 'account') ncAccountChanged();
    if (id === 'edu') { if (ncEl('edu').checked) ncPri('urgent'); }
    if (id === 'svc' || id === 'city' || id === 'account' || id === 'edu' || id === 'zip') ncQuoteNow();
    if (ev.target && ev.target.name === 'nc-who') _ncS.assignTo = ev.target.value;
    ncScheduleDraft();
  });
}

function ncPri(v) {
  if (ncEl('edu') && ncEl('edu').checked && v !== 'urgent') {
    if (typeof showToast === 'function') showToast('EDU calls are always urgent.', 'error');
    v = 'urgent';
  }
  _ncS.pri = v;
  var btns = document.querySelectorAll('#nc-pri button');
  for (var i = 0; i < btns.length; i++) {
    var on = btns[i].getAttribute('data-v') === v;
    btns[i].classList.toggle('on', on);
    btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
  }
  ncScheduleDraft();
}

function ncAccountChanged() {
  var id = parseInt(ncVal('account'), 10) || null;
  var acc = (((_ncRef && _ncRef.accounts) || []).filter(function (a) { return a.id === id; }))[0];
  var req = ncEl('po-req');
  if (req) req.textContent = acc && acc.po_required ? '*' : '';
  var note = ncEl('acct-note');
  if (note) {
    note.innerHTML = acc && acc.dispatch_notes
      ? '<div class="nc-banner info" style="margin:0 0 12px"><span class="nc-grow"><b>' + escHtml(acc.name) + ':</b> ' + escHtml(acc.dispatch_notes) + '</span></div>'
      : '';
  }
}

// --- drafts ----------------------------------------------------------------
function ncCollectFields() {
  var f = {};
  NC_FIELDS.forEach(function (k) { f[k] = ncVal(k); });
  f.edu = !!(ncEl('edu') && ncEl('edu').checked);
  f.pri = _ncS ? _ncS.pri : 'normal';
  f.take = !!(ncEl('take') && ncEl('take').checked);
  return f;
}
function ncHasContent(f) {
  return NC_FIELDS.some(function (k) { return k !== 'city' && f[k]; }) || f.edu;
}
function ncScheduleDraft() {
  if (!_ncS || !_ncS.ready) return;
  ncDebounce('draft', 800, function () {
    if (typeof novaDraftPut !== 'function') return;
    var f = ncCollectFields();
    if (!ncHasContent(f)) { novaDraftDel(ncDraftKey()); ncSaved(''); return; }
    novaDraftPut(ncDraftKey(), { fields: f, redispatchOf: _ncS.redispatchOf, redispatchLabel: _ncS.redispatchLabel,
      cityTouched: _ncS.cityTouched, assignTo: _ncS.assignTo, at: Date.now() });
    ncSaved('Draft saved');
  });
}
function ncSaved(msg) { var e = document.getElementById('nc-saved'); if (e) e.textContent = msg || ''; }
function ncApplyDraft(d) {
  var f = d.fields || {};
  NC_FIELDS.forEach(function (k) { if (f[k] !== undefined) ncSet(k, f[k]); });
  if (ncEl('edu')) ncEl('edu').checked = !!f.edu;
  if (ncEl('take') && f.take !== undefined) ncEl('take').checked = !!f.take;
  ncPri(f.pri || 'normal');
  _ncS.cityTouched = !!d.cityTouched;
  _ncS.assignTo = d.assignTo || '';
  if (d.redispatchOf) ncSetRedispatch(d.redispatchOf, d.redispatchLabel || '');
}
async function ncDiscard() {
  var f = ncCollectFields();
  if (ncHasContent(f) && !(await ncConfirm('Clear this call and start over?'))) return;
  if (typeof novaDraftDel === 'function') { try { await novaDraftDel(ncDraftKey()); } catch (e) {} }
  renderDispatchNew(document.getElementById('content'), null);
}

// --- repeat callers --------------------------------------------------------
async function ncLookupNow() {
  var box = ncEl('lookup');
  if (!box) return;
  var digits = ncDigits(ncVal('cb'));
  if (digits.length < 7) { _ncS.lookupKey = ''; box.innerHTML = ''; return; }
  if (digits === _ncS.lookupKey) return;
  _ncS.lookupKey = digits;
  var data;
  try { data = await api('GET', '/dispatch/lookup?phone=' + encodeURIComponent(digits)); }
  catch (e) { box.innerHTML = ''; return; }
  if (_ncS.lookupKey !== digits) return;          // typed on; a newer lookup owns the box
  _ncS.lookupOpen = data.open || [];
  _ncS.lookupPrev = data.previous || [];
  var html = '';
  var canOpen = can('view_dispatch');
  _ncS.lookupOpen.forEach(function (j) {
    var st = (typeof DISP_STATUS !== 'undefined' && DISP_STATUS[j.status]) ? DISP_STATUS[j.status].label : j.status;
    html += '<div class="nc-banner warn"><span class="nc-grow"><b>Already on the board:</b> ' +
      escHtml(j.job_number || '') + ' ' + escHtml(j.service_type || '') +
      ' &middot; ' + escHtml(st) + (j.assigned_name ? ' &middot; ' + escHtml(j.assigned_name) : '') +
      (j.address ? '<br><span class="nc-sub">' + escHtml(j.address) + '</span>' : '') + '</span>' +
      (canOpen ? '<button type="button" class="btn btn-secondary btn-sm" onclick="navigate(&quot;dispatch-call&quot;,' + j.id + ')">Open call</button>' : '') +
      '</div>';
  });
  if (_ncS.lookupPrev.length) {
    html += '<div class="nc-banner info" style="display:block"><b>Called before</b>' +
      _ncS.lookupPrev.map(function (j, i) {
        var veh = [j.vehicle_color, j.vehicle_year, j.vehicle_make, j.vehicle_model].filter(Boolean).join(' ');
        return '<div class="nc-prev"><span class="nc-grow">' + escHtml(j.job_number || '') + ' ' +
          escHtml(j.service_type || '') + ' &middot; ' + escHtml(ncAgo(j.created_at)) +
          (j.customer_name ? ' &middot; ' + escHtml(j.customer_name) : '') +
          '<br><span class="nc-sub">' + escHtml([j.address, j.city_name].filter(Boolean).join(', ')) +
          (veh ? ' &middot; ' + escHtml(veh) : '') + '</span></span>' +
          (canOpen ? '<button type="button" class="btn btn-ghost btn-sm" onclick="navigate(&quot;dispatch-call&quot;,' + j.id + ')">Open</button>' : '') +
          '<button type="button" class="btn btn-secondary btn-sm" onclick="ncFillFrom(' + i + ',false)">Fill from this call</button>' +
          (j.status === 'done' || j.status === 'goa'
            ? '<button type="button" class="btn btn-secondary btn-sm" onclick="ncFillFrom(' + i + ',true)">Redispatch</button>' : '') +
          '</div>';
      }).join('') + '</div>';
  }
  box.innerHTML = html;
}

function ncFillJob(j, withService) {
  var map = { name: j.customer_name, biz: j.business_name, email: j.customer_email, addr: j.address,
    cross: j.cross_street, zip: j.zip, vloc: j.vehicle_location, vyear: j.vehicle_year, vmake: j.vehicle_make,
    vmodel: j.vehicle_model, vcolor: j.vehicle_color, plate: j.license_tag, tstate: j.tag_state,
    account: j.account_id || '' };
  if (j.callback_phone || j.customer_phone) map.cb = j.callback_phone || j.customer_phone;
  if (withService && j.service_type_id) map.svc = j.service_type_id;
  Object.keys(map).forEach(function (k) { if (map[k] !== null && map[k] !== undefined && map[k] !== '') ncSet(k, map[k]); });
  if (j.city_code) { ncSet('city', String(j.city_code).trim()); _ncS.cityTouched = true; }
  ncAccountChanged();
}

function ncFillFrom(i, redispatch) {
  var j = (_ncS.lookupPrev || [])[i];
  if (!j) return;
  ncFillJob(j, redispatch);
  if (redispatch) ncSetRedispatch(j.id, j.job_number || '');
  ncQuoteNow();
  ncScheduleDraft();
  if (typeof showToast === 'function') showToast(redispatch ? 'Redispatching ' + (j.job_number || 'that call') : 'Filled from ' + (j.job_number || 'the last call'), 'success');
}

function ncSetRedispatch(id, label) {
  _ncS.redispatchOf = id || null;
  _ncS.redispatchLabel = label || '';
  var box = document.getElementById('nc-redo');
  if (!box) return;
  box.innerHTML = id
    ? '<div class="nc-banner info" style="margin:0 0 14px"><span class="nc-grow"><b>Redispatch</b> of ' + escHtml(label || ('call ' + id)) +
      '. The new call is linked to it both ways.</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="ncSetRedispatch(null);ncScheduleDraft()">Not a redispatch</button></div>'
    : '';
  var go = document.getElementById('nc-go');
  if (go) go.textContent = id ? 'Create redispatch' : 'Create call';
}

async function ncLoadRedispatch(id) {
  var data;
  try { data = await api('GET', '/dispatch/jobs/' + id); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message || 'Could not open that call.', 'error'); return; }
  var j = (data && data.job) || {};
  ncFillJob(j, true);
  if (j.is_edu && ncEl('edu')) { ncEl('edu').checked = true; ncPri('urgent'); }
  ncSetRedispatch(j.id, j.job_number || '');
}

// --- price and ETA ---------------------------------------------------------
async function ncQuoteNow() {
  var box = ncEl('quote');
  if (!box || !_ncS) return;
  var q = { service_type_id: ncVal('svc'), city_code: ncVal('city'), zip: ncVal('zip'),
    account_id: ncVal('account'), is_edu: ncEl('edu') && ncEl('edu').checked ? '1' : '0' };
  var key = JSON.stringify(q);
  if (key === _ncS.quoteKey) return;
  _ncS.quoteKey = key;
  if (!q.service_type_id && !q.zip) {
    box.innerHTML = '<div class="nc-sub">Pick a service and enter the zip to see the price.</div>';
    ncWhereNote(null); ncWhoNow(); return;
  }
  var qs = Object.keys(q).filter(function (k) { return q[k]; }).map(function (k) {
    return k + '=' + encodeURIComponent(q[k]);
  }).join('&');
  var r;
  try { r = await api('GET', '/dispatch/quote-preview?' + qs); }
  catch (e) { box.innerHTML = '<div class="nc-sub">' + escHtml(e.message || 'Could not price this.') + '</div>'; return; }
  if (_ncS.quoteKey !== key) return;
  // City fills itself from the zip unless somebody picked one on purpose.
  if (r.city_from_zip && !_ncS.cityTouched && ncVal('city') !== r.city_from_zip) {
    ncSet('city', r.city_from_zip);
  }
  ncWhereNote(r);
  var html = '';
  if (r.price !== null && r.price !== undefined) {
    html += '<div class="nc-price">' + escHtml(ncMoney(r.price)) + '</div>';
  } else if (r.reason === 'no_service_type') {
    html += '<div class="nc-sub">Pick a service to see the price.</div>';
  } else if (r.reason === 'no_city') {
    html += '<div class="nc-sub">Enter the zip or pick a city to see the price.</div>';
  } else {
    html += '<div class="nc-sub">No price set for this. Type the price you quote below.</div>';
  }
  var bits = [];
  if (r.eta_minutes) bits.push('ETA ' + r.eta_minutes + ' min');
  if (r.time_code_title) bits.push(r.time_code_title);
  if (r.zone && r.zone.name) bits.push(r.zone.name);
  if (bits.length) html += '<div class="nc-sub" style="margin-top:4px">' + escHtml(bits.join(' \u00b7 ')) + '</div>';
  if (r.shutdown_message) html += '<div class="nc-banner bad"><span class="nc-grow">' + escHtml(r.shutdown_message) + '</span></div>';
  box.innerHTML = html;
  var pr = ncEl('price'), et = ncEl('eta');
  if (pr) pr.placeholder = r.price !== null && r.price !== undefined ? String(r.price) : '';
  if (et) et.placeholder = r.eta_minutes ? String(r.eta_minutes) : '';
  ncWhoNow();
}

function ncWhereNote(r) {
  var box = ncEl('where-note');
  if (!box) return;
  if (!r) { box.innerHTML = ''; return; }
  var html = '';
  if (r.out_of_area) {
    html += '<div class="nc-banner bad"><span class="nc-grow"><b>Outside our coverage.</b> Zip ' + escHtml(ncVal('zip')) +
      ' is not in any ' + escHtml(ncCityName(r.city_code)) + ' zone. Check the zip before you promise a time.</span></div>';
  }
  if (r.wrong_city && r.city_from_zip) {
    html += '<div class="nc-banner warn"><span class="nc-grow">Zip ' + escHtml(ncVal('zip')) + ' belongs to <b>' +
      escHtml(ncCityName(r.city_from_zip)) + '</b>, not ' + escHtml(ncCityName(ncVal('city'))) + '.</span>' +
      '<button type="button" class="btn btn-secondary btn-sm" onclick="ncSwitchCity(&quot;' + escHtml(r.city_from_zip) + '&quot;)">Switch to ' +
      escHtml(ncCityName(r.city_from_zip)) + '</button></div>';
  }
  box.innerHTML = html;
}
function ncSwitchCity(code) {
  ncSet('city', code);
  _ncS.cityTouched = true;
  ncQuoteNow();
  ncScheduleDraft();
}

// --- who goes ---------------------------------------------------------------
async function ncWhoNow() {
  var box = document.getElementById('nc-who');
  if (!box || !_ncS || !_ncS.me.can_assign) return;
  var city = ncVal('city'), svc = ncVal('svc');
  var key = city + '|' + svc;
  if (key === _ncS.whoKey) return;
  _ncS.whoKey = key;
  if (!city) { box.innerHTML = '<div class="nc-sub">Enter the zip or pick a city to see who can go.</div>'; return; }
  var r;
  try { r = await api('GET', '/dispatch/assignable-preview?city_code=' + encodeURIComponent(city) +
    (svc ? '&service_type_id=' + encodeURIComponent(svc) : '')); }
  catch (e) { box.innerHTML = '<div class="nc-sub">' + escHtml(e.message || 'Could not load the list.') + '</div>'; return; }
  if (_ncS.whoKey !== key) return;
  var people = r.people || [];
  var sel = String(_ncS.assignTo || '');
  if (sel && !people.some(function (p) { return String(p.user_id) === sel; })) sel = '';
  _ncS.assignTo = sel;
  function row(val, label, sub, dot) {
    return '<label><input type="radio" name="nc-who" id="nc-who-' + (val || 'none') + '" value="' + escHtml(val) + '"' +
      (String(val) === sel ? ' checked' : '') + '>' +
      (dot ? '<span class="nc-dot" style="background:' + dot + '"></span>' : '') +
      '<span style="flex:1">' + label + (sub ? '<br><span class="nc-sub">' + sub + '</span>' : '') + '</span></label>';
  }
  var html = row('', '<b>Nobody yet</b>', 'Goes on the board for dispatch', null);
  html += people.map(function (p) {
    var bits = [];
    bits.push(p.ready ? 'Ready' : 'Off duty');
    if (p.open_calls) bits.push(p.open_calls + ' open call' + (p.open_calls === 1 ? '' : 's'));
    return row(String(p.user_id), escHtml(p.name), escHtml(bits.join(' \u00b7 ')), p.ready ? '#22c55e' : '#71717a');
  }).join('');
  if (!people.length) html += '<div class="nc-sub" style="padding-top:8px">Nobody in ' + escHtml(ncCityName(city)) + ' is set up for this kind of call.</div>';
  box.innerHTML = html;
}

// --- use my location ---------------------------------------------------------
function ncUseMyLocation() {
  var btn = ncEl('geo');
  if (!navigator.geolocation) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Finding you...'; }
  navigator.geolocation.getCurrentPosition(async function (pos) {
    var r = null;
    try { r = await api('GET', '/dispatch/reverse-geocode?lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude); }
    catch (e) { r = null; }
    if (btn) { btn.disabled = false; btn.textContent = 'Use my location'; }
    if (!r || !r.found) {
      if (typeof showToast === 'function') showToast('Could not find a street address here. Type it in.', 'error');
      return;
    }
    if (r.address) ncSet('addr', r.address);
    if (r.zip) ncSet('zip', r.zip);
    if (r.city_code && !_ncS.cityTouched) ncSet('city', r.city_code);
    ['addr', 'zip'].forEach(function (k) { var g = document.getElementById('nc-g-' + k); if (g) g.classList.remove('nc-miss'); });
    ncQuoteNow();
    ncScheduleDraft();
  }, function () {
    if (btn) { btn.disabled = false; btn.textContent = 'Use my location'; }
    if (typeof showToast === 'function') showToast('Location is off for Nova. Type the address instead.', 'error');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// --- create -----------------------------------------------------------------
function ncShowMissing(keys) {
  var first = null;
  keys.forEach(function (k) {
    var g = document.getElementById('nc-g-' + k);
    if (g) { g.classList.add('nc-miss'); if (!first) first = ncEl(k); }
  });
  var labels = keys.map(function (k) { return NC_REQUIRED[k] || k; });
  var err = document.getElementById('nc-err');
  if (err) err.innerHTML = '<div class="nc-banner bad" style="margin:0"><span class="nc-grow">Still needed: ' + escHtml(labels.join(', ')) + '.</span></div>';
  if (first) { try { first.focus(); first.scrollIntoView({ block: 'center' }); } catch (e) {} }
}

async function ncSubmit(another) {
  if (!_ncS || _ncS.loading) return;
  var err = document.getElementById('nc-err');
  if (err) err.innerHTML = '';
  var missing = Object.keys(NC_REQUIRED).filter(function (k) { return !ncVal(k); });
  if (missing.length) return ncShowMissing(missing);
  var acctId = parseInt(ncVal('account'), 10) || null;
  var acc = (((_ncRef && _ncRef.accounts) || []).filter(function (a) { return a.id === acctId; }))[0];
  if (acc && acc.po_required && !ncVal('po')) {
    if (!(await ncConfirm(acc.name + ' needs a PO. Create the call without one for now?'))) { var p = ncEl('po'); if (p) p.focus(); return; }
  }
  var body = {
    created_via: 'new_call',
    callback_phone: ncVal('cb'), caller_id: ncVal('cid'), customer_name: ncVal('name'),
    business_name: ncVal('biz'), customer_email: ncVal('email'),
    service_type_id: parseInt(ncVal('svc'), 10) || null,
    is_edu: !!(ncEl('edu') && ncEl('edu').checked), priority: _ncS.pri,
    address: ncVal('addr'), zip: ncVal('zip'), city_code: ncVal('city'),
    cross_street: ncVal('cross'), vehicle_location: ncVal('vloc'),
    vehicle_year: ncVal('vyear'), vehicle_make: ncVal('vmake'), vehicle_model: ncVal('vmodel'),
    vehicle_color: ncVal('vcolor'), license_tag: ncVal('plate'), tag_state: ncVal('tstate'),
    account_id: acctId, account_po: ncVal('po'), notes: ncVal('notes'),
    quoted_price: ncVal('price'), eta_minutes: ncVal('eta')
  };
  if (_ncS.redispatchOf) body.redispatch_of = _ncS.redispatchOf;
  if (ncEl('link')) body.send_customer_link = !!ncEl('link').checked;
  if (_ncS.me.can_assign) { if (_ncS.assignTo) body.assigned_to = parseInt(_ncS.assignTo, 10); }
  else if (ncEl('take') && ncEl('take').checked) body.take_myself = true;

  _ncS.loading = true;
  var go = document.getElementById('nc-go');
  if (go) { go.disabled = true; go.textContent = 'Creating...'; }
  var job;
  try { job = await api('POST', '/dispatch/jobs', body); }
  catch (e) {
    _ncS.loading = false;
    if (go) { go.disabled = false; go.textContent = _ncS.redispatchOf ? 'Create redispatch' : 'Create call'; }
    var miss = (e.data && e.data.missing) || [];
    if (miss.length) {
      var back = { 'callback phone': 'cb', 'customer name': 'name', 'service type': 'svc', 'address': 'addr', 'zip': 'zip' };
      return ncShowMissing(miss.map(function (m) { return back[m] || m; }));
    }
    if (err) err.innerHTML = '<div class="nc-banner bad" style="margin:0"><span class="nc-grow">' + escHtml(e.message || 'Could not create the call.') + '</span></div>';
    return;
  }
  clearTimeout(_ncT.draft);
  if (typeof novaDraftDel === 'function') { try { await novaDraftDel(ncDraftKey()); } catch (e2) {} }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  _ncS.loading = false;
  if (typeof showToast === 'function') showToast('Call ' + (job.job_number || '') + ' created', 'success');
  if (job.customer_link && !job.customer_link.sent && typeof showToast === 'function') {
    showToast('The customer link did not text: ' + (job.customer_link.error || 'unknown problem') + '. You can send it from the call.', 'error');
  }
  if (another) return renderDispatchNew(document.getElementById('content'), null);
  if (can('view_dispatch') && job.id) return navigate('dispatch-call', job.id);
  ncDone(job);
}

function ncDone(job) {
  var content = document.getElementById('content');
  if (!content) return;
  var mine = job.assigned_to && state.user && job.assigned_to === state.user.id;
  content.innerHTML = '<div class="nc-head"><div class="nc-title">Call created</div></div>' +
    '<div class="nc-card" style="max-width:520px">' +
      '<div class="nc-price" style="font-size:26px">' + escHtml(job.job_number || '') + '</div>' +
      '<div style="margin-top:6px">' + escHtml(job.service_type || '') + (job.customer_name ? ' &middot; ' + escHtml(job.customer_name) : '') + '</div>' +
      '<div class="nc-sub" style="margin-top:4px">' + escHtml(job.address || '') + '</div>' +
      '<div style="margin-top:12px">' + (mine ? 'It is yours. It is on your calls list.' : 'It is on the board for dispatch.') + '</div>' +
      '<div style="margin-top:16px"><button type="button" class="btn btn-primary" onclick="renderDispatchNew(document.getElementById(&quot;content&quot;),null)">Add another call</button></div>' +
    '</div>';
}
