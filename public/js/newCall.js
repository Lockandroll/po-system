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
//  - When: Now, or Schedule for later (Tony 2026-10-15). The date and time are
//    the call's city clock; the server prices it for that time and releases it
//    onto the live board dispatch_schedule_lead_minutes ahead. EDU is always Now.
//
//  Classic script, string building only. No backticks (Windows corruption rule).
// ---------------------------------------------------------------------------

var _ncRef = null;
var _ncS = null;            // per-render state
var _ncT = {};              // debounce timers
var NC_FIELDS = ['cb', 'cid', 'name', 'biz', 'email', 'svc', 'addr', 'zip', 'city', 'cross', 'vloc',
  'vyear', 'vmake', 'vmodel', 'vcolor', 'plate', 'tstate', 'account', 'po', 'notes', 'price', 'eta', 'sdate', 'stime'];
var NC_EXTRA_LABEL = { sdate: 'scheduled date', stime: 'scheduled time' };
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
    '.nc-lc{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--border,#2a2a2a);border-radius:10px;margin-top:8px}' +
    '.nc-lc:first-child{margin-top:0}' +
    '.nc-lc.mine{border-color:var(--primary,#f97316);background:rgba(249,115,22,.07)}' +
    '.nc-lc.sel{border-color:#22c55e;background:rgba(34,197,94,.08)}' +
    '.nc-lc.ended{opacity:.65}' +
    '.nc-lc .ph{font-weight:700;font-size:15px;font-variant-numeric:tabular-nums}' +
    '.nc-lc .st{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}' +
    '.nc-lc .btn{white-space:nowrap}' +
    '@media (max-width:760px){.nc-lc{flex-wrap:wrap}.nc-lc .btn{width:100%;justify-content:center}}' +
    '.nc-best{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:10px;background:rgba(249,115,22,.16);color:var(--primary,#f97316);font-size:11px;font-weight:800}' +
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

        (_ncRef && _ncRef.goto_live
          ? '<section class="nc-card" id="nc-live" aria-labelledby="nc-h-live"><h3 id="nc-h-live" style="display:flex;align-items:center;gap:8px">' +
              '<span style="flex:1">Calls on the line</span><span class="nc-sub" style="text-transform:none;letter-spacing:0;font-weight:500">from GoTo, updates on its own</span></h3>' +
              '<div id="nc-live-list" aria-live="polite"><div class="nc-sub">Loading...</div></div></section>'
          : '') +
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
        '<section class="nc-card" aria-labelledby="nc-h-when"><h3 id="nc-h-when">When</h3>' +
          '<div class="nc-seg" id="nc-when" role="radiogroup" aria-label="When">' +
            '<button type="button" role="radio" data-v="now" class="on" aria-checked="true" onclick="ncWhen(&quot;now&quot;)">Now</button>' +
            '<button type="button" role="radio" data-v="later" aria-checked="false" onclick="ncWhen(&quot;later&quot;)">Schedule for later</button>' +
          '</div>' +
          '<div class="nc-grid" id="nc-sched" style="margin-top:12px" hidden>' +
            '<div class="form-group" id="nc-g-sdate" style="margin-bottom:0"><label for="nc-sdate">Date <span class="nc-req">*</span></label><input type="date" id="nc-sdate"></div>' +
            '<div class="form-group" id="nc-g-stime" style="margin-bottom:0"><label for="nc-stime">Time <span class="nc-req">*</span></label><input type="time" id="nc-stime" step="300"></div>' +
          '</div>' +
          '<div class="nc-sub" id="nc-sched-note" style="margin-top:8px" hidden></div>' +
        '</section>' +
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
  _ncS = { me: me, redispatchOf: null, redispatchLabel: '', pri: 'normal', cityTouched: false, when: 'now',
    lookupKey: '', quoteKey: '', whoKey: '', assignTo: '', loading: false, ready: false };
  content.innerHTML = ncPageHtml(me);
  ncWire();

  var redo = /^r(\d+)$/.exec(String(param || ''));
  var pop = window._novaPop || null;
  window._novaPop = null;
  if (redo) {
    await ncLoadRedispatch(parseInt(redo[1], 10));
  } else {
    var d = null;
    try { d = typeof novaDraftGet === 'function' ? await novaDraftGet(ncDraftKey()) : null; } catch (e) { d = null; }
    if (pop) {
      // A new caller wins, but a half-typed call is parked, not thrown away.
      if (d && d.fields && ncHasContent(d.fields)) ncParkDraft(d);
      await ncApplyPop(pop);
    } else if (d && d.fields) {
      ncApplyDraft(d);
      ncSaved('Draft restored');
    }
  }
  _ncS.ready = true;
  ncLiveStart();
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
    if (id === 'zip' || id === 'sdate' || id === 'stime') ncDebounce('quote', 400, ncQuoteNow);
    if (id === 'addr' || id === 'zip') ncDebounce('who', 900, ncWhoNow);
    ncScheduleDraft();
  });
  form.addEventListener('change', function (ev) {
    var id = String((ev.target && ev.target.id) || '').replace(/^nc-/, '');
    var g = document.getElementById('nc-g-' + id);
    if (g) g.classList.remove('nc-miss');
    if (id === 'city') _ncS.cityTouched = !!ncVal('city');
    if (id === 'account') ncAccountChanged();
    if (id === 'edu') { if (ncEl('edu').checked) { ncPri('urgent'); if (_ncS.when === 'later') ncWhen('now', true); } }
    if (id === 'city') ncSchedNote();
    if (id === 'svc' || id === 'city' || id === 'account' || id === 'edu' || id === 'zip') ncQuoteNow();
    if (ev.target && ev.target.name === 'nc-who') { _ncS.assignTo = ev.target.value; _ncS.whoTouched = true; }
    if (id === 'account' || id === 'edu') ncWhoNow();
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

// --- when: now or scheduled --------------------------------------------------
function ncWhen(v, quiet) {
  if (!_ncS) return;
  if (v === 'later' && ncEl('edu') && ncEl('edu').checked) {
    if (typeof showToast === 'function') showToast('EDU calls go out now. They cannot be scheduled.', 'error');
    v = 'now';
  }
  _ncS.when = v === 'later' ? 'later' : 'now';
  var later = _ncS.when === 'later';
  var btns = document.querySelectorAll('#nc-when button');
  for (var i = 0; i < btns.length; i++) {
    var on = btns[i].getAttribute('data-v') === _ncS.when;
    btns[i].classList.toggle('on', on);
    btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
  }
  var box = ncEl('sched');
  if (box) box.hidden = !later;
  var d = ncEl('sdate');
  if (d) { var t = new Date(); d.min = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); }
  // A scheduled call carries no "minutes away" ETA; its promise is the time.
  var eta = ncEl('eta');
  if (eta) { eta.disabled = later; if (later) eta.value = ''; }
  ncGoLabel();
  ncSchedNote();
  if (!quiet && later && d && !d.value) { try { d.focus(); } catch (e) {} }
  ncQuoteNow();
  ncWhoNow();
  ncScheduleDraft();
}
function ncSchedValue() {
  if (!_ncS || _ncS.when !== 'later') return '';
  var d = ncVal('sdate'), t = ncVal('stime');
  return d && t ? d + 'T' + t : '';
}
function ncSchedNote(label, err) {
  var n = ncEl('sched-note');
  if (!n) return;
  if (!_ncS || _ncS.when !== 'later') { n.hidden = true; return; }
  var lead = (_ncRef && _ncRef.schedule_lead_minutes !== undefined) ? _ncRef.schedule_lead_minutes : 60;
  var city = ncVal('city') ? ncCityName(ncVal('city')) + ' time' : 'City time';
  n.hidden = false;
  n.innerHTML = (err ? '<span style="color:var(--danger,#ef4444)">' + escHtml(err) + '</span><br>' : '') +
    (label ? '<b>' + escHtml(label) + '</b><br>' : '') +
    escHtml(city) + '. It goes on the board ' + lead + ' min before, and whoever is on it gets the call then.';
}
function ncGoLabel(busy) {
  var go = document.getElementById('nc-go');
  if (!go || !_ncS) return;
  var later = _ncS.when === 'later';
  if (busy) { go.textContent = later ? 'Scheduling...' : 'Creating...'; return; }
  go.textContent = later ? (_ncS.redispatchOf ? 'Schedule redispatch' : 'Schedule call')
    : (_ncS.redispatchOf ? 'Create redispatch' : 'Create call');
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
  f.when = _ncS ? _ncS.when : 'now';
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
  _ncS.whoTouched = !!d.assignTo;
  if (d.redispatchOf) ncSetRedispatch(d.redispatchOf, d.redispatchLabel || '');
  if (f.when === 'later') ncWhen('later', true);
}
async function ncDiscard() {
  var f = ncCollectFields();
  if (ncHasContent(f) && !(await ncConfirm('Clear this call and start over?'))) return;
  if (typeof novaDraftDel === 'function') { try { await novaDraftDel(ncDraftKey()); } catch (e) {} }
  renderDispatchNew(document.getElementById('content'), null);
}

// --- Calls on the line (GoTo live calls) -----------------------------------
// Tony 2026-10-14: no screen pop jumping in front of a dispatcher who is on the
// phone. The calls coming in are listed here; they pick the one they are on.
// The one answered by this dispatcher is marked "Your call" and sorted first.
var NC_LIVE_SHOW = 4;
function ncLiveStart() {
  clearInterval(_ncT.live);
  if (!document.getElementById('nc-live')) return;
  ncLiveLoad();
  _ncT.live = setInterval(function () {
    if (!document.getElementById('nc-live')) { clearInterval(_ncT.live); return; }
    if (document.hidden) return;
    ncLiveLoad();
  }, 5000);
}
function ncAgoShort(t) {
  if (!t) return '';
  var s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
  return s < 60 ? s + 's' : (s < 3600 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : Math.floor(s / 3600) + 'h');
}
async function ncLiveLoad() {
  var box = document.getElementById('nc-live-list');
  if (!box || !_ncS) return;
  var r;
  try { r = await api('GET', '/dispatch/live-calls'); } catch (e) { return; }
  if (!document.getElementById('nc-live-list')) return;
  _ncS.live = (r && r.calls) || [];
  ncLiveDraw();
}
function ncLiveDraw() {
  var box = document.getElementById('nc-live-list');
  if (!box) return;
  var calls = _ncS.live || [];
  var sel = _ncS.gotoCallId;
  // The picked call stays on screen even after it drops off the feed.
  if (sel && _ncS.gotoCall && !calls.some(function (c) { return c.id === sel; })) calls = [_ncS.gotoCall].concat(calls);
  if (!calls.length) { box.innerHTML = '<div class="nc-sub">No calls coming in right now.</div>'; return; }
  var shown = _ncS.liveAll ? calls : calls.slice(0, NC_LIVE_SHOW);
  box.innerHTML = shown.map(function (c) {
    var isSel = c.id === sel;
    var color = c.state === 'active' ? '#22c55e' : (c.state === 'ringing' ? '#f59e0b' : '#71717a');
    var line = c.state === 'active'
      ? 'On the line' + (c.answered_name ? ' with ' + escHtml(c.answered_name) : '') + ' &middot; ' + ncAgoShort(c.answered_at || c.started_at)
      : (c.state === 'ringing' ? 'Ringing' + (c.ringing ? ' (' + escHtml(c.ringing) + ')' : '') + ' &middot; ' + ncAgoShort(c.started_at)
        : 'Ended ' + ncAgoShort(c.ended_at) + ' ago');
    var city = c.city_name ? escHtml(c.city_name) + (c.city_source === 'line' ? ' line' : (c.city_source === 'last_call' ? ' (last call)' : ' (area code)')) : '';
    return '<div class="nc-lc' + (c.mine ? ' mine' : '') + (isSel ? ' sel' : '') + (c.state === 'ended' ? ' ended' : '') + '">' +
      '<span class="st" style="background:' + color + '" aria-hidden="true"></span>' +
      '<div style="flex:1;min-width:0">' +
        '<div><span class="ph">' + escHtml(ncFmtPhone(c.digits)) + '</span>' +
          (c.name ? ' <span class="nc-sub">' + escHtml(c.name) + '</span>' : '') +
          (c.mine ? ' <span class="nc-best">Your call</span>' : '') + '</div>' +
        '<div class="nc-sub">' + line + (city ? ' &middot; ' + city : '') + '</div>' +
      '</div>' +
      (isSel
        ? '<button type="button" class="btn btn-ghost btn-sm" onclick="ncLiveClear()">Not this one</button>'
        : '<button type="button" class="btn ' + (c.mine ? 'btn-primary' : 'btn-secondary') + ' btn-sm" onclick="ncLiveUse(&quot;' + escHtml(c.id) + '&quot;)">This is my call</button>') +
      '</div>';
  }).join('') +
  (calls.length > NC_LIVE_SHOW
    ? '<button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="_ncS.liveAll=!_ncS.liveAll;ncLiveDraw()">' +
        (_ncS.liveAll ? 'Show fewer' : 'Show ' + (calls.length - NC_LIVE_SHOW) + ' more') + '</button>' : '');
}
function ncLiveUse(id) {
  var c = (_ncS.live || []).filter(function (x) { return x.id === id; })[0];
  if (!c) return;
  _ncS.gotoCallId = c.id;
  _ncS.gotoCall = c;
  _ncS.via = 'goto';
  var num = ncFmtPhone(c.digits);
  ncSet('cb', num);
  ncSet('cid', num);
  var nm = ncPersonName(c.name);
  if (nm && !ncVal('name')) ncSet('name', nm);
  if (c.city_code && !_ncS.cityTouched) ncSet('city', c.city_code);
  ['cb', 'name', 'city'].forEach(function (k) { var g = document.getElementById('nc-g-' + k); if (g) g.classList.remove('nc-miss'); });
  ncLiveDraw();
  ncLookupNow(); ncQuoteNow(); ncWhoNow();
  ncScheduleDraft();
  var next = ncVal('name') ? ncEl('svc') : ncEl('name');
  if (next && window.innerWidth > 760) { try { next.focus(); } catch (e) {} }
}
function ncLiveClear() {
  _ncS.gotoCallId = null; _ncS.gotoCall = null;
  if (_ncS.via === 'goto') _ncS.via = null;
  ncLiveDraw();
}

// --- GoTo screen pop (step 6) ------------------------------------------------
// GoTo opens /?view=dispatch-new&cnum=<caller>&cnam=<caller ID name>. Caller ID
// names are often the carrier's ("WIRELESS CALLER", "ORLANDO FL"), so only a
// name that looks like a person's goes into Customer name.
function ncFmtPhone(s) {
  var d = String(s || '').replace(/[^0-9]/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(s || '');
}
function ncPersonName(n) {
  n = String(n || '').replace(/\s+/g, ' ').trim();
  if (!n || /[0-9@]/.test(n)) return '';
  // Carrier fillers and "CITY ST" place names are not people.
  if (/\b(wireless|caller|cellular|cell phone|mobile|unknown|unavailable|private|anonymous|restricted|toll free|out of area|name not|inc|llc|corp)\b/i.test(n)) return '';
  if (/^[A-Za-z .]+ [A-Z]{2}$/.test(n)) return '';
  var parts = n.split(/[ ,]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return '';
  // US caller ID sends "LAST,FIRST" or "LAST FIRST" in capitals.
  if (n.indexOf(',') !== -1) parts = parts.slice(1).concat(parts[0]);
  else if (n === n.toUpperCase() && parts.length === 2) parts = [parts[1], parts[0]];
  return parts.map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(); }).join(' ');
}
async function ncApplyPop(pop) {
  _ncS.via = 'goto';
  var num = ncFmtPhone(pop.cnum);
  if (num) { ncSet('cb', num); ncSet('cid', num); }
  var nm = ncPersonName(pop.cnam);
  if (nm) ncSet('name', nm);
  var box = document.getElementById('nc-redo');
  var note = 'Incoming call' + (pop.cnam ? ' from ' + escHtml(pop.cnam) : '') + (num ? ' &middot; ' + escHtml(num) : '');
  if (box) box.insertAdjacentHTML('afterbegin', '<div class="nc-banner info" id="nc-pop" style="margin:0 0 14px"><span class="nc-grow"><b>GoTo:</b> ' + note +
    '<span id="nc-pop-city"></span></span></div>');
  var r = null;
  try { r = await api('GET', '/dispatch/pop-city?phone=' + encodeURIComponent(pop.cnum || '') + (pop.line ? '&line=' + encodeURIComponent(pop.line) : '')); }
  catch (e) { r = null; }
  if (r && r.city_code && !ncVal('city')) {
    ncSet('city', r.city_code);
    var why = { line: 'the line they called', last_call: 'their last call', area_code: 'the area code' }[r.source] || '';
    var el = document.getElementById('nc-pop-city');
    if (el) el.innerHTML = '<br><span class="nc-sub">City set to ' + escHtml(r.city_name || r.city_code) + (why ? ' from ' + why : '') + '. Change it if they are somewhere else.</span>';
  }
  var first = ncEl('name');
  if (first && window.innerWidth > 760) { try { (ncVal('name') ? ncEl('svc') : first).focus(); } catch (e) {} }
}
function ncParkDraft(d) {
  _ncS.parked = d;
  var f = d.fields || {};
  var who = [f.name, f.addr].filter(Boolean).join(', ') || 'a call you were typing';
  var box = document.getElementById('nc-redo');
  if (box) box.insertAdjacentHTML('beforeend', '<div class="nc-banner warn" id="nc-parked" style="margin:0 0 14px"><span class="nc-grow">' +
    'Your half-typed call (' + escHtml(who) + ') is saved.</span>' +
    '<button type="button" class="btn btn-secondary btn-sm" onclick="ncRestoreParked()">Go back to it</button></div>');
}
function ncRestoreParked() {
  var d = _ncS && _ncS.parked;
  if (!d) return;
  NC_FIELDS.forEach(function (k) { ncSet(k, ''); });
  _ncS.via = null;
  ncApplyDraft(d);
  _ncS.parked = null;
  ['nc-parked', 'nc-pop'].forEach(function (id) { var e = document.getElementById(id); if (e) e.parentNode.removeChild(e); });
  _ncS.lookupKey = ''; _ncS.quoteKey = ''; _ncS.whoKey = '';
  ncAccountChanged(); ncLookupNow(); ncQuoteNow();
  ncScheduleDraft();
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
  ncGoLabel();
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
    account_id: ncVal('account'), is_edu: ncEl('edu') && ncEl('edu').checked ? '1' : '0',
    scheduled_for: ncSchedValue() };
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
  var later = _ncS.when === 'later';
  if (later) ncSchedNote(r.scheduled_label || '', r.schedule_error || '');
  if (later && r.scheduled_label) bits.push('Priced for ' + r.scheduled_label);
  if (r.eta_minutes && !later) bits.push('ETA ' + r.eta_minutes + ' min');
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
  var addr = ncVal('addr'), zip = ncVal('zip');
  var edu = ncEl('edu') && ncEl('edu').checked ? '1' : '';
  var key = [city, svc, addr, zip, ncVal('account'), edu, _ncS.when].join('|');
  if (key === _ncS.whoKey) return;
  _ncS.whoKey = key;
  if (!city) { box.innerHTML = '<div class="nc-sub">Enter the zip or pick a city to see who can go.</div>'; return; }
  var r;
  // Address + zip let the server put the call on the map and rank by best ETA.
  var qs = 'city_code=' + encodeURIComponent(city) + (svc ? '&service_type_id=' + encodeURIComponent(svc) : '') +
    (addr && /^\d{5}/.test(zip) ? '&address=' + encodeURIComponent(addr) + '&zip=' + encodeURIComponent(zip) : '') +
    (ncVal('account') ? '&account_id=' + encodeURIComponent(ncVal('account')) : '') + (edu ? '&is_edu=1' : '');
  try { r = await api('GET', '/dispatch/assignable-preview?' + qs); }
  catch (e) { box.innerHTML = '<div class="nc-sub">' + escHtml(e.message || 'Could not load the list.') + '</div>'; return; }
  if (_ncS.whoKey !== key) return;
  var people = r.people || [];
  _ncS.bestId = r.best_user_id || null;
  var sel = String(_ncS.assignTo || '');
  if (sel && !people.some(function (p) { return String(p.user_id) === sel; })) { sel = ''; _ncS.whoTouched = false; }
  // Tony: Who goes = best ETA, pre-selected. A pick the dispatcher made by hand stays.
  // Not for a scheduled call: who is closest NOW says nothing about later.
  var later = _ncS.when === 'later';
  if (!_ncS.whoTouched && r.best_user_id && !later) sel = String(r.best_user_id);
  _ncS.assignTo = sel;
  function row(val, label, sub, dot) {
    return '<label><input type="radio" name="nc-who" id="nc-who-' + (val || 'none') + '" value="' + escHtml(val) + '"' +
      (String(val) === sel ? ' checked' : '') + '>' +
      (dot ? '<span class="nc-dot" style="background:' + dot + '"></span>' : '') +
      '<span style="flex:1">' + label + (sub ? '<br><span class="nc-sub">' + sub + '</span>' : '') + '</span></label>';
  }
  var html = row('', '<b>Nobody yet</b>', later ? 'Dispatch picks someone when it goes live' : 'Goes on the board for dispatch', null);
  if (later) html = '<div class="nc-sub" style="padding-bottom:6px">Times and Best ETA below are for right now. Pick someone only if they are booked for it.</div>' + html;
  html += people.map(function (p) {
    var bits = [];
    if (p.eta_minutes !== undefined && p.eta_minutes !== null) {
      bits.push(p.eta_minutes + ' min' + (p.miles !== null && p.miles !== undefined ? ' \u00b7 ' + p.miles + ' mi' : ''));
      if (p.free_in) bits.push('free in ' + p.free_in);
    } else bits.push(p.ready ? 'Ready' : 'Off duty');
    if (p.open_calls) bits.push(p.open_calls + ' open call' + (p.open_calls === 1 ? '' : 's'));
    if (p.stale) bits.push('old location');
    var label = escHtml(p.name) + (p.user_id === r.best_user_id ? ' <span class="nc-best">Best ETA</span>' : '');
    return row(String(p.user_id), label, escHtml(bits.join(' \u00b7 ')), p.ready ? '#22c55e' : '#71717a');
  }).join('');
  if (r.why) html += '<div class="nc-sub" style="padding-top:8px">' + escHtml(r.why) + '</div>';
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
  var labels = keys.map(function (k) { return NC_REQUIRED[k] || NC_EXTRA_LABEL[k] || k; });
  var err = document.getElementById('nc-err');
  if (err) err.innerHTML = '<div class="nc-banner bad" style="margin:0"><span class="nc-grow">Still needed: ' + escHtml(labels.join(', ')) + '.</span></div>';
  if (first) { try { first.focus(); first.scrollIntoView({ block: 'center' }); } catch (e) {} }
}

async function ncSubmit(another) {
  if (!_ncS || _ncS.loading) return;
  var err = document.getElementById('nc-err');
  if (err) err.innerHTML = '';
  var missing = Object.keys(NC_REQUIRED).filter(function (k) { return !ncVal(k); });
  if (_ncS.when === 'later') ['sdate', 'stime'].forEach(function (k) { if (!ncVal(k)) missing.push(k); });
  if (missing.length) return ncShowMissing(missing);
  var acctId = parseInt(ncVal('account'), 10) || null;
  var acc = (((_ncRef && _ncRef.accounts) || []).filter(function (a) { return a.id === acctId; }))[0];
  if (acc && acc.po_required && !ncVal('po')) {
    if (!(await ncConfirm(acc.name + ' needs a PO. Create the call without one for now?'))) { var p = ncEl('po'); if (p) p.focus(); return; }
  }
  var body = {
    created_via: _ncS.via || 'new_call',
    callback_phone: ncVal('cb'), caller_id: ncVal('cid'), customer_name: ncVal('name'),
    business_name: ncVal('biz'), customer_email: ncVal('email'),
    service_type_id: parseInt(ncVal('svc'), 10) || null,
    is_edu: !!(ncEl('edu') && ncEl('edu').checked), priority: _ncS.pri,
    address: ncVal('addr'), zip: ncVal('zip'), city_code: ncVal('city'),
    cross_street: ncVal('cross'), vehicle_location: ncVal('vloc'),
    vehicle_year: ncVal('vyear'), vehicle_make: ncVal('vmake'), vehicle_model: ncVal('vmodel'),
    vehicle_color: ncVal('vcolor'), license_tag: ncVal('plate'), tag_state: ncVal('tstate'),
    account_id: acctId, account_po: ncVal('po'), notes: ncVal('notes'),
    quoted_price: ncVal('price'), eta_minutes: _ncS.when === 'later' ? '' : ncVal('eta')
  };
  if (_ncS.when === 'later') body.scheduled_for = ncSchedValue();
  if (_ncS.redispatchOf) body.redispatch_of = _ncS.redispatchOf;
  if (_ncS.gotoCallId) body.goto_call_id = _ncS.gotoCallId;
  if (ncEl('link')) body.send_customer_link = !!ncEl('link').checked;
  if (_ncS.me.can_assign) {
    if (_ncS.assignTo) body.assigned_to = parseInt(_ncS.assignTo, 10);
    if (_ncS.bestId) body.suggested_user_id = _ncS.bestId;
  }
  else if (ncEl('take') && ncEl('take').checked) body.take_myself = true;

  _ncS.loading = true;
  var go = document.getElementById('nc-go');
  if (go) { go.disabled = true; ncGoLabel(true); }
  var job;
  try { job = await api('POST', '/dispatch/jobs', body); }
  catch (e) {
    _ncS.loading = false;
    if (go) { go.disabled = false; ncGoLabel(); }
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
  if (typeof showToast === 'function') {
    showToast('Call ' + (job.job_number || '') + (job.status === 'scheduled' ? ' scheduled for ' + ncWhenLabel(job) : ' created'), 'success');
  }
  if (job.customer_link && !job.customer_link.sent && typeof showToast === 'function') {
    showToast('The customer link did not text: ' + (job.customer_link.error || 'unknown problem') + '. You can send it from the call.', 'error');
  }
  if (another) return renderDispatchNew(document.getElementById('content'), null);
  if (can('view_dispatch') && job.id) return navigate('dispatch-call', job.id);
  ncDone(job);
}

function ncWhenLabel(job) {
  try {
    return new Date(job.scheduled_for).toLocaleString('en-US', { timeZone: job.city_tz || 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { return ''; }
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
      '<div style="margin-top:12px">' + (job.status === 'scheduled'
        ? 'Scheduled for <b>' + escHtml(ncWhenLabel(job)) + '</b>. It goes on the board before then' + (mine ? ' and comes to you.' : '.')
        : (mine ? 'It is yours. It is on your calls list.' : 'It is on the board for dispatch.')) + '</div>' +
      '<div style="margin-top:16px"><button type="button" class="btn btn-primary" onclick="renderDispatchNew(document.getElementById(&quot;content&quot;),null)">Add another call</button></div>' +
    '</div>';
}
