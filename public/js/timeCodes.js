/* Nova - Location Settings: Pricing & Service (time codes)
 * ---------------------------------------------------------------------------
 * Per service, per location: the named windows of the week that carry a price,
 * an additional charge, and three ETAs (public / account / EDU).
 *
 * The rule that matters: a save is refused if the week has a gap or an overlap.
 * The server enforces it; this screen just shows you where. A 2am call landing
 * in an uncovered minute has no price and no ETA, and you find out at 2am.
 * --------------------------------------------------------------------------- */

var _tcCity = null;
var _tcCities = [];
var _tcServices = [];
var _tcCurrent = null;      // { service, codes, coverage }
var _tcAccounts = [];
var _tcTypes = [];

var TC_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
var TC_DAYBITS = [1, 2, 4, 8, 16, 32, 64];
var TC_COLORS = ['#22c55e', '#f59e0b', '#3b82f6', '#a855f7', '#ef4444', '#14b8a6', '#eab308'];

function tcCodesInjectStyles() {
  if (document.getElementById('tc-codes-styles')) return;
  var css =
    '.tc-grid{display:grid;grid-template-columns:250px 1fr;gap:16px;align-items:start}' +
    '@media(max-width:900px){.tc-grid{grid-template-columns:1fr}}' +
    '.tc-svc{padding:8px 11px;border-radius:6px;font-size:13.5px;cursor:pointer;display:flex;' +
      'align-items:center;gap:8px}' +
    '.tc-svc:hover{background:var(--bg-elevated)}' +
    '.tc-svc.on{background:rgba(249,115,22,.16);color:var(--primary);font-weight:700}' +
    '.tc-svc .warn{margin-left:auto;font-size:10.5px;color:#fbbf24;font-weight:700}' +
    '.tc-tbl{width:100%;border-collapse:collapse;min-width:900px}' +
    '.tc-tbl th{text-align:left;font-size:10.5px;font-weight:800;letter-spacing:.06em;' +
      'text-transform:uppercase;color:var(--text-muted-color);padding:8px 7px;' +
      'border-bottom:1px solid var(--border);white-space:nowrap}' +
    '.tc-tbl td{padding:5px 7px;border-bottom:1px solid var(--border-light);vertical-align:middle}' +
    '.tc-tbl input{padding:6px 8px!important;font-size:13px;width:100%;margin:0}' +
    '.tc-tbl input.num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.tc-bar{position:relative;height:32px;border-radius:6px;overflow:hidden;' +
      'border:1px solid var(--border);background:var(--bg-elevated)}' +
    '.tc-seg{position:absolute;top:0;bottom:0;font-size:10px;font-weight:800;color:#0f0f0f;' +
      'display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap;' +
      'border-right:1px solid rgba(0,0,0,.35)}' +
    '.tc-gapseg{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(45deg,' +
      '#ef4444,#ef4444 5px,#7f1d1d 5px,#7f1d1d 10px)}' +
    '.tc-ax{display:flex;justify-content:space-between;font-size:10.5px;' +
      'color:var(--text-muted-color);margin-top:4px}' +
    '.tc-days{display:flex;gap:3px;flex-wrap:wrap}' +
    '.tc-day{font-size:10px;font-weight:700;padding:2px 5px;border-radius:4px;cursor:pointer;' +
      'border:1px solid var(--border);color:var(--text-muted-color);user-select:none}' +
    '.tc-day.on{background:rgba(249,115,22,.18);color:var(--primary);border-color:rgba(249,115,22,.4)}' +
    '.tc-note{font-size:12px;color:var(--text-muted-color);line-height:1.6}';
  var st = document.createElement('style');
  st.id = 'tc-codes-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function tcMinToHhmm(n) {
  n = parseInt(n, 10);
  if (!isFinite(n)) return '';
  var h = Math.floor(n / 60), m = n % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function tcHhmmToMin(s) {
  var m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// ---------------------------------------------------------------------------
async function renderTimeCodes(content) {
  tcCodesInjectStyles();
  content.innerHTML = '<div class="page-header"><div><div class="page-title">Pricing &amp; Service</div>' +
    '<div class="page-subtitle">Loading...</div></div></div>';
  try {
    var ref = await api('GET', '/dispatch/reference');
    _tcCities = ref.cities || [];
    _tcAccounts = ref.accounts || [];
    _tcTypes = ref.service_types || [];
  } catch (e) {
    content.innerHTML = '<div class="card"><div class="card-body">Could not load. ' + escHtml(e.message || '') + '</div></div>';
    return;
  }
  if (!_tcCity) _tcCity = ((_tcCities[0] || {}).code || '').trim();

  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Pricing &amp; Service</div>' +
      '<div class="page-subtitle">Time codes: what a service costs and how long you promise, ' +
      'window by window, for each city.</div></div>' +
      '<div class="flex-gap">' +
        '<select id="tc-city" onchange="tcPickCity(this.value)" style="width:auto">' +
          _tcCities.map(function (c) {
            var code = (c.code || '').trim();
            return '<option value="' + escHtml(code) + '"' + (code === _tcCity ? ' selected' : '') + '>' +
              escHtml(c.name) + '</option>';
          }).join('') +
        '</select>' +
        '<button class="btn btn-secondary btn-sm" onclick="tcAccountPrices()">Account prices</button>' +
      '</div>' +
    '</div>' +
    '<div id="tc-body"></div>';
  await tcLoadCity();
}

function tcPickCity(code) { _tcCity = code; _tcCurrent = null; tcLoadCity(); }

async function tcLoadCity() {
  var body = document.getElementById('tc-body');
  if (!body) return;
  body.innerHTML = '<div class="card"><div class="card-body">Loading services...</div></div>';
  var data;
  try { data = await api('GET', '/time-codes/locations/' + encodeURIComponent(_tcCity) + '/services'); }
  catch (e) { body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  _tcServices = data.services || [];
  body.innerHTML =
    '<div class="tc-grid">' +
      '<div>' +
        '<div class="card"><div class="card-header"><div class="card-title">Services</div>' +
          '<span class="tc-note">' + escHtml(data.city_name || '') + '</span></div>' +
        '<div class="card-body" style="padding:9px">' +
          (_tcServices.length ? _tcServices.map(function (s) {
            return '<div class="tc-svc" data-ls="' + s.id + '" onclick="tcOpenService(' + s.id + ')">' +
              escHtml(s.name) +
              (s.unpriced ? '<span class="warn">' + s.unpriced + ' unpriced</span>' : '') +
              '</div>';
          }).join('') : '<div class="tc-note">No services set up for this city yet.</div>') +
        '</div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-body">' +
          '<label style="font-size:11px;font-weight:700;color:var(--text-muted-color);' +
            'text-transform:uppercase;letter-spacing:.06em">Time zone</label>' +
          '<select id="tc-tz" onchange="tcSaveTz(this.value)" style="margin-top:6px">' +
            ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
             'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu'].map(function (z) {
              return '<option value="' + z + '"' + (z === data.timezone ? ' selected' : '') + '>' +
                z.split('/')[1].replace(/_/g, ' ') + '</option>';
            }).join('') +
          '</select>' +
          '<div class="tc-note" style="margin-top:8px">A time code resolves in <b>this city\'s</b> ' +
            'clock. Birmingham is an hour behind Orlando, and a call at 11:58 PM has to land in ' +
            'Overnight, not tomorrow morning.</div>' +
        '</div></div>' +
      '</div>' +
      '<div id="tc-detail"><div class="card"><div class="empty-state">Pick a service on the left.</div></div></div>' +
    '</div>';
  if (_tcServices.length) tcOpenService(_tcServices[0].id);
}

async function tcSaveTz(zone) {
  try { await api('POST', '/time-codes/locations/' + encodeURIComponent(_tcCity) + '/timezone', { timezone: zone }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof showToast === 'function') showToast('Time zone saved.', 'success');
}

async function tcOpenService(lsId) {
  var el = document.getElementById('tc-detail');
  if (!el) return;
  document.querySelectorAll('.tc-svc').forEach(function (n) {
    n.classList.toggle('on', String(n.getAttribute('data-ls')) === String(lsId));
  });
  el.innerHTML = '<div class="card"><div class="card-body">Loading...</div></div>';
  try { _tcCurrent = await api('GET', '/time-codes/service/' + lsId); }
  catch (e) { el.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  tcRenderDetail();
}

function tcRowHtml(c, i) {
  function n(v) { return v === null || v === undefined ? '' : v; }
  var mask = parseInt(c.days, 10);
  if (!isFinite(mask)) mask = 127;
  var days = TC_DAYS.map(function (d, k) {
    return '<span class="tc-day' + ((mask & TC_DAYBITS[k]) ? ' on' : '') + '" data-bit="' + TC_DAYBITS[k] +
      '" onclick="this.classList.toggle(&quot;on&quot;);tcPreview()">' + d + '</span>';
  }).join('');
  return '<tr class="tc-row">' +
    '<td style="width:60px"><input class="num tc-code" value="' + n(c.code_id) + '" onchange="tcPreview()"></td>' +
    '<td style="min-width:120px"><input class="tc-title" value="' + escHtml(n(c.title)) + '"></td>' +
    '<td style="width:104px"><input type="time" class="tc-start" value="' + tcMinToHhmm(c.start_minute) + '" onchange="tcPreview()"></td>' +
    '<td style="width:104px"><input type="time" class="tc-end" value="' + tcMinToHhmm(c.end_minute) + '" onchange="tcPreview()"></td>' +
    '<td><div class="tc-days">' + days + '</div></td>' +
    '<td style="width:96px"><input class="num tc-full" value="' + n(c.full_charge) + '" placeholder="not set"></td>' +
    '<td style="width:88px"><input class="num tc-add" value="' + n(c.additional_charge) + '"></td>' +
    '<td style="width:72px"><input class="num tc-clow" value="' + n(c.eta_core_low) + '"></td>' +
    '<td style="width:72px"><input class="num tc-chigh" value="' + n(c.eta_core_high) + '"></td>' +
    '<td style="width:72px"><input class="num tc-acct" value="' + n(c.eta_account) + '"></td>' +
    '<td style="width:72px"><input class="num tc-edu" value="' + n(c.eta_edu) + '"></td>' +
    '<td style="width:44px;text-align:right">' +
      '<button class="btn btn-ghost btn-sm" onclick="this.closest(&quot;tr&quot;).remove();tcPreview()">&#x2715;</button></td>' +
    '</tr>';
}

function tcRenderDetail() {
  var el = document.getElementById('tc-detail');
  if (!el || !_tcCurrent) return;
  var svc = _tcCurrent.service || {};
  var rows = (_tcCurrent.codes || []).map(tcRowHtml).join('');
  el.innerHTML =
    '<div class="card" style="margin-bottom:14px"><div class="card-header">' +
      '<div class="card-title">' + escHtml(svc.city_name || '') + ' &rarr; ' + escHtml(svc.service_name || '') + '</div>' +
      '<div class="flex-gap">' +
        '<button class="btn btn-secondary btn-sm" onclick="tcAddRow()">+ Time code</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="tcCopyToAll()">Copy windows to all services</button>' +
        '<button class="btn btn-primary btn-sm" onclick="tcSave()">Save</button>' +
      '</div></div>' +
      '<div class="table-wrap"><table class="tc-tbl"><thead><tr>' +
        '<th>Code</th><th>Title</th><th>Start</th><th>End</th><th>Days</th>' +
        '<th style="text-align:right">Full charge</th><th style="text-align:right">Additional</th>' +
        '<th style="text-align:right">Core low</th><th style="text-align:right">Core high</th>' +
        '<th style="text-align:right">Account</th><th style="text-align:right">EDU</th><th></th>' +
      '</tr></thead><tbody id="tc-rows">' + rows + '</tbody></table></div>' +
      '<div class="card-body" style="padding-top:12px">' +
        '<div class="tc-note"><b>Core</b> is the range you quote a member of the public. ' +
        '<b>Account</b> is that account\'s SLA. <b>EDU</b> is the emergency number for a child or ' +
        'a pet locked in a vehicle. Leave <b>Full charge</b> blank and the call shows ' +
        '"Price not set" rather than quoting a wrong number.</div>' +
      '</div>' +
    '</div>' +
    '<div class="card"><div class="card-body">' +
      '<div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;' +
        'color:var(--primary);margin-bottom:10px">Coverage</div>' +
      '<div id="tc-cov"></div>' +
    '</div></div>';
  tcPreview();
}

function tcAddRow() {
  var tb = document.getElementById('tc-rows');
  if (!tb) return;
  var used = {};
  tb.querySelectorAll('.tc-code').forEach(function (n) { used[n.value] = 1; });
  var next = 1;
  while (used[String(next)]) next++;
  tb.insertAdjacentHTML('beforeend', tcRowHtml({ code_id: next, days: 127 }));
  tcPreview();
}

function tcReadRows() {
  var out = [];
  document.querySelectorAll('#tc-rows .tc-row').forEach(function (tr) {
    function v(cls) { var n = tr.querySelector('.' + cls); return n ? n.value : ''; }
    var mask = 0;
    tr.querySelectorAll('.tc-day.on').forEach(function (d) { mask |= parseInt(d.getAttribute('data-bit'), 10); });
    out.push({
      code_id: parseInt(v('tc-code'), 10),
      title: v('tc-title'),
      start_minute: tcHhmmToMin(v('tc-start')),
      end_minute: tcHhmmToMin(v('tc-end')),
      days: mask || 127,
      full_charge: v('tc-full'),
      additional_charge: v('tc-add'),
      eta_core_low: v('tc-clow'),
      eta_core_high: v('tc-chigh'),
      eta_account: v('tc-acct'),
      eta_edu: v('tc-edu')
    });
  });
  return out;
}

// A live picture of Monday, drawn from what is on screen right now rather than
// from what was last saved - the point is to see the gap BEFORE pressing Save.
function tcPreview() {
  var box = document.getElementById('tc-cov');
  if (!box) return;
  var rows = tcReadRows().filter(function (r) {
    return isFinite(r.start_minute) && r.start_minute !== null && r.end_minute !== null;
  });
  var owned = new Array(1440).fill(null);
  var clash = false;
  rows.forEach(function (r, i) {
    if (!(r.days & 1)) return;   // Monday only, for the picture
    var s = r.start_minute, e = r.end_minute;
    var paint = function (from, to) {
      for (var m = from; m <= to; m++) {
        if (owned[m] !== null) clash = true; else owned[m] = i;
      }
    };
    if (e >= s) paint(s, e); else { paint(s, 1439); paint(0, e); }
  });
  var segs = '';
  var m2 = 0;
  while (m2 < 1440) {
    var who = owned[m2];
    var start = m2;
    while (m2 < 1440 && owned[m2] === who) m2++;
    var w = ((m2 - start) / 1440 * 100).toFixed(3);
    var left = (start / 1440 * 100).toFixed(3);
    if (who === null) {
      segs += '<div class="tc-gapseg" style="left:' + left + '%;width:' + w + '%"></div>';
    } else {
      var label = (rows[who] && rows[who].title) || '';
      segs += '<div class="tc-seg" style="left:' + left + '%;width:' + w + '%;background:' +
        TC_COLORS[who % TC_COLORS.length] + '">' + escHtml(label) + '</div>';
    }
  }
  var uncovered = owned.filter(function (x) { return x === null; }).length;
  box.innerHTML =
    '<div class="tc-bar">' + segs + '</div>' +
    '<div class="tc-ax"><span>12a</span><span>6a</span><span>Noon</span><span>6p</span><span>12a</span></div>' +
    (uncovered === 0 && !clash
      ? '<div style="margin-top:11px;color:#4ade80;font-size:13px">&#10003; Monday is fully covered. ' +
        'The server checks all 10,080 minutes of the week when you save.</div>'
      : '<div style="margin-top:11px;color:#f87171;font-size:13px">' +
        (clash ? 'Two windows overlap. ' : '') +
        (uncovered ? uncovered + ' minute' + (uncovered === 1 ? '' : 's') + ' of Monday nobody covers. ' : '') +
        'Saving will be refused until this is clean.</div>');
}

async function tcSave() {
  var codes = tcReadRows();
  for (var i = 0; i < codes.length; i++) {
    if (!isFinite(codes[i].code_id) || codes[i].start_minute === null || codes[i].end_minute === null || !codes[i].title) {
      if (typeof showToast === 'function') showToast('Every row needs a number, a title, a start and an end.', 'error');
      return;
    }
  }
  try {
    var r = await api('POST', '/time-codes/service/' + _tcCurrent.service.id, { codes: codes });
    _tcCurrent.coverage = r.coverage;
  } catch (e) {
    if (typeof showToast === 'function') showToast(e.message || 'Could not save.', 'error');
    return;
  }
  if (typeof apiBustCache === 'function') apiBustCache('/time-codes');
  if (typeof showToast === 'function') showToast('Saved.', 'success');
  tcLoadCity();
}

async function tcCopyToAll() {
  if (!(await novaConfirm('Copy these windows and ETAs onto every other service in this city? ' +
      'Prices are NOT copied - a lockout and a rekey do not cost the same.'))) return;
  try {
    var r = await api('POST', '/time-codes/service/' + _tcCurrent.service.id + '/copy-to-all', {});
    if (typeof showToast === 'function') showToast('Copied onto ' + r.services + ' other services. Their prices are still blank.', 'success');
  } catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/time-codes');
  tcLoadCity();
}

// ---------------------------------------------------------------------------
//  Account price exceptions
// ---------------------------------------------------------------------------
async function tcAccountPrices() {
  var data;
  try { data = await api('GET', '/time-codes/account-prices'); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  var rows = (data.prices || []).map(function (p) {
    return '<tr><td><b>' + escHtml(p.account_name) + '</b></td><td>' + escHtml(p.service_name) + '</td>' +
      '<td>' + escHtml(p.city_name || 'Any city') + '</td>' +
      '<td>' + (p.code_id ? 'Code ' + p.code_id : 'Any time') + '</td>' +
      '<td style="text-align:right">$' + escHtml(p.full_charge) + '</td>' +
      '<td style="text-align:right">' + (p.eta_minutes ? p.eta_minutes + ' min' : '-') + '</td>' +
      '<td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="tcDeletePrice(' + p.id + ')">Remove</button></td></tr>';
  }).join('');

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'tc-acct-modal';
  overlay.innerHTML =
    '<div class="modal" style="max-width:900px">' +
      '<div class="modal-header"><h3>Account prices</h3></div>' +
      '<div class="modal-body">' +
        '<div class="tc-note" style="margin-bottom:12px">Accounts that do not pay the retail ' +
          'time-code price. <b>An account with no row here simply pays the time code</b> - that is ' +
          'what Retail means, so there is no second table to keep in step.</div>' +
        '<div class="table-wrap"><table><thead><tr><th>Account</th><th>Service</th><th>City</th>' +
          '<th>Time code</th><th style="text-align:right">Price</th><th style="text-align:right">ETA</th><th></th>' +
          '</tr></thead><tbody>' + (rows || '<tr><td colspan="7" class="text-muted">No exceptions yet.</td></tr>') +
          '</tbody></table></div>' +
        '<div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px">' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">' +
            '<div class="form-group"><label>Account</label><select id="tcp-acct">' +
              _tcAccounts.map(function (a) { return '<option value="' + a.id + '">' + escHtml(a.name) + '</option>'; }).join('') +
            '</select></div>' +
            '<div class="form-group"><label>Service</label><select id="tcp-svc">' +
              _tcTypes.map(function (t) { return '<option value="' + t.id + '">' + escHtml(t.name) + '</option>'; }).join('') +
            '</select></div>' +
            '<div class="form-group"><label>City</label><select id="tcp-city">' +
              '<option value="">Any city</option>' +
              _tcCities.map(function (c) { return '<option value="' + escHtml((c.code || '').trim()) + '">' + escHtml(c.name) + '</option>'; }).join('') +
            '</select></div>' +
            '<div class="form-group"><label>Time code</label><input id="tcp-code" placeholder="Any"></div>' +
            '<div class="form-group"><label>Price</label><input id="tcp-price" placeholder="79.95"></div>' +
            '<div class="form-group"><label>ETA (min)</label><input id="tcp-eta" placeholder="40"></div>' +
          '</div>' +
          '<button class="btn btn-primary btn-sm" onclick="tcAddPrice()">Add exception</button>' +
        '</div>' +
      '</div>' +
      '<div class="modal-footer"><button class="btn btn-secondary" onclick="this.closest(\'.modal-overlay\').remove()">Close</button></div>' +
    '</div>';
  document.body.appendChild(overlay);
}

async function tcAddPrice() {
  function v(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  try {
    await api('POST', '/time-codes/account-prices', {
      account_id: v('tcp-acct'), service_type_id: v('tcp-svc'), city_code: v('tcp-city'),
      code_id: v('tcp-code'), full_charge: v('tcp-price'), eta_minutes: v('tcp-eta')
    });
  } catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  var m = document.getElementById('tc-acct-modal');
  if (m) m.remove();
  if (typeof apiBustCache === 'function') apiBustCache('/time-codes');
  tcAccountPrices();
}

async function tcDeletePrice(id) {
  try { await api('DELETE', '/time-codes/account-prices/' + id); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  var m = document.getElementById('tc-acct-modal');
  if (m) m.remove();
  if (typeof apiBustCache === 'function') apiBustCache('/time-codes');
  tcAccountPrices();
}
