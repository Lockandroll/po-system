/* Nova - Call Search
 * ---------------------------------------------------------------------------
 * History, not the live board. It includes done, GOA and cancelled calls, which
 * the board never shows, and it is deliberately a separate screen so nobody
 * confuses "what happened" with "what is happening".
 *
 * Three things here are load-bearing and are enforced on the SERVER as well,
 * not just drawn differently:
 *   - which rows you get (own calls / your city / everything)
 *   - whether customer names and addresses are masked
 *   - which columns the CSV export contains
 * The screen never decides any of them. It only asks.
 * --------------------------------------------------------------------------- */

var _csCols = [];        // every column this person may choose from
var _csSel = [];         // the ones they have chosen, in order
var _csRows = [];
var _csTotal = 0;
var _csScope = 'own';
var _csMasked = false;
var _csRef = null;       // service types / cities / accounts / tags
var _csBusy = false;
var _csOffset = 0;
var CS_PAGE = 100;

function csInjectStyles() {
  if (document.getElementById('cs-styles')) return;
  var css =
    '.cs-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}' +
    '.cs-filters .form-group{margin-bottom:0}' +
    '.cs-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}' +
    '.cs-scope{font-size:12px;color:var(--text-muted-color)}' +
    '.cs-mask{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;' +
      'letter-spacing:.04em;text-transform:uppercase;color:#fbbf24;background:rgba(245,158,11,.12);' +
      'border:1px solid rgba(245,158,11,.35);border-radius:20px;padding:3px 10px}' +
    '.cs-row{cursor:pointer}' +
    '.cs-row:hover td{background:rgba(249,115,22,.07)}' +
    '.cs-cols{max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius);padding:8px}' +
    '.cs-col{display:flex;align-items:center;gap:9px;padding:5px 6px;border-radius:5px;font-size:13.5px}' +
    '.cs-col:hover{background:var(--bg-elevated)}' +
    '.cs-col input{width:16px!important;height:16px;padding:0!important;margin:0;flex:0 0 auto;accent-color:var(--primary)}' +
    '.cs-col .cs-m{font-size:10.5px;color:#fbbf24;margin-left:auto}' +
    '.cs-num{font-variant-numeric:tabular-nums}' +
    '.cs-edu{background:rgba(239,68,68,.18);color:#fca5a5;border-radius:5px;padding:1px 6px;' +
      'font-size:10.5px;font-weight:800;letter-spacing:.04em}';
  var st = document.createElement('style');
  st.id = 'cs-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function csToday(offsetDays) {
  var d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  // Local date, not the UTC slice. Slicing an ISO string puts a late-evening
  // call on the wrong day, which is a bug Nova has already shipped once.
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function csVal(id) { var e = document.getElementById(id); return e ? e.value : ''; }

// ---------------------------------------------------------------------------
//  Render
// ---------------------------------------------------------------------------
async function renderCallSearch(content) {
  csInjectStyles();
  content.innerHTML = '<div class="page-header"><div><div class="page-title">Call Search</div>' +
    '<div class="page-subtitle">Loading...</div></div></div>';

  try {
    var cols = await api('GET', '/call-search/columns');
    _csCols = cols.available || [];
    _csSel = cols.selected || cols.defaults || [];
    _csScope = cols.scope || 'own';
    _csMasked = !cols.canSeePii;
  } catch (e) {
    content.innerHTML = '<div class="card"><div class="card-body">Could not load Call Search. ' +
      escHtml(e.message || '') + '</div></div>';
    return;
  }
  try { _csRef = await api('GET', '/dispatch/reference'); } catch (e) { _csRef = null; }

  var svcOpts = '<option value="">Any service</option>' +
    (((_csRef && _csRef.service_types) || []).map(function (s) {
      return '<option value="' + s.id + '">' + escHtml(s.name) + '</option>';
    }).join(''));
  var catOpts = '<option value="">Any category</option>' +
    (((_csRef && _csRef.categories) || []).map(function (c) {
      return '<option value="' + escHtml(c.code) + '">' + escHtml(c.name) + '</option>';
    }).join(''));
  var cityOpts = '<option value="">Any city</option>' +
    (((_csRef && _csRef.cities) || []).map(function (c) {
      return '<option value="' + escHtml((c.code || '').trim()) + '">' + escHtml(c.name) + '</option>';
    }).join(''));
  var accOpts = '<option value="">Any account</option>' +
    (((_csRef && _csRef.accounts) || []).map(function (a) {
      return '<option value="' + a.id + '">' + escHtml(a.name) + '</option>';
    }).join(''));
  var tagOpts = '<option value="">Any tag</option>' +
    (((_csRef && _csRef.tags) || []).map(function (t) {
      return '<option value="' + t.id + '">' + escHtml(t.name) + '</option>';
    }).join(''));

  var scopeText = _csScope === 'all' ? 'Every call, every city.'
    : _csScope === 'city' ? 'Every call in your home city.'
    : 'Calls you were assigned or created.';

  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Call Search</div>' +
      '<div class="page-subtitle">Closed, GOA and cancelled calls too - everything the live board does not show.</div>' +
    '</div></div>' +
    '<div class="card" style="margin-bottom:16px"><div class="card-body">' +
      '<div class="cs-filters">' +
        '<div class="form-group"><label>From</label><input type="date" id="cs-from" value="' + csToday(-30) + '"></div>' +
        '<div class="form-group"><label>To</label><input type="date" id="cs-to" value="' + csToday(0) + '"></div>' +
        '<div class="form-group"><label>City</label><select id="cs-city">' + cityOpts + '</select></div>' +
        '<div class="form-group"><label>Service</label><select id="cs-service">' + svcOpts + '</select></div>' +
        '<div class="form-group"><label>Category</label><select id="cs-cat">' + catOpts + '</select></div>' +
        '<div class="form-group"><label>Status</label><select id="cs-status">' +
          '<option value="">Any status</option>' +
          '<option value="new">Unassigned</option><option value="assigned">Dispatched</option>' +
          '<option value="accepted">Accepted</option><option value="enroute">En-route</option>' +
          '<option value="onscene">On scene</option><option value="done">Completed</option>' +
          '<option value="goa">GOA</option><option value="cancelled">Cancelled</option>' +
        '</select></div>' +
        '<div class="form-group"><label>Account</label><select id="cs-account">' + accOpts + '</select></div>' +
        '<div class="form-group"><label>Tag</label><select id="cs-tag">' + tagOpts + '</select></div>' +
        '<div class="form-group"><label>Search</label>' +
          '<input id="cs-text" placeholder="Job #, customer, business, address, phone, plate, VIN, PO"></div>' +
      '</div>' +
      '<div class="cs-bar">' +
        '<label style="display:flex;align-items:center;gap:8px;margin:0;font-size:13.5px;cursor:pointer">' +
          '<input type="checkbox" id="cs-edu" style="width:16px;height:16px;padding:0;margin:0;accent-color:var(--primary)"> EDU only</label>' +
        '<button class="btn btn-primary btn-sm" onclick="csSearch(0)">Search</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="csReset()">Reset</button>' +
        '<span style="margin-left:auto"></span>' +
        '<button class="btn btn-secondary btn-sm" onclick="csColumnPicker()">Columns</button>' +
        (_csScope === 'all' ? '<button class="btn btn-secondary btn-sm" onclick="csExport()">Export CSV</button>' : '') +
      '</div>' +
      '<div class="cs-scope" style="margin-top:10px">' + escHtml(scopeText) +
        (_csMasked ? ' Customer names and addresses are shortened for you here.' : '') + '</div>' +
    '</div></div>' +
    '<div id="cs-results"></div>';

  var box = document.getElementById('cs-text');
  if (box) box.addEventListener('keydown', function (e) { if (e.key === 'Enter') csSearch(0); });

  await csSearch(0);
}

function csReset() {
  ['cs-city', 'cs-service', 'cs-cat', 'cs-status', 'cs-account', 'cs-tag'].forEach(function (id) {
    var e = document.getElementById(id); if (e) e.value = '';
  });
  var t = document.getElementById('cs-text'); if (t) t.value = '';
  var edu = document.getElementById('cs-edu'); if (edu) edu.checked = false;
  var f = document.getElementById('cs-from'); if (f) f.value = csToday(-30);
  var to = document.getElementById('cs-to'); if (to) to.value = csToday(0);
  csSearch(0);
}

function csQuery() {
  var p = [];
  function add(k, v) { if (v !== '' && v !== null && v !== undefined) p.push(k + '=' + encodeURIComponent(v)); }
  add('from', csVal('cs-from'));
  add('to', csVal('cs-to'));
  add('city', csVal('cs-city'));
  add('service_type_id', csVal('cs-service'));
  add('category', csVal('cs-cat'));
  add('status', csVal('cs-status'));
  add('account_id', csVal('cs-account'));
  add('tag_id', csVal('cs-tag'));
  add('text', csVal('cs-text'));
  if ((document.getElementById('cs-edu') || {}).checked) add('edu', '1');
  if (_csSel.length) add('columns', _csSel.join(','));
  return p.join('&');
}

async function csSearch(offset) {
  if (_csBusy) return;
  _csBusy = true;
  _csOffset = offset || 0;
  var target = document.getElementById('cs-results');
  if (target) target.innerHTML = '<div class="card"><div class="card-body">Searching...</div></div>';
  try {
    var q = csQuery() + '&limit=' + CS_PAGE + '&offset=' + _csOffset;
    var r = await api('GET', '/call-search/?' + q);
    _csRows = r.rows || [];
    _csTotal = r.total || 0;
    _csMasked = !!r.masked;
    csRenderResults(r.columns || []);
  } catch (e) {
    if (target) target.innerHTML = '<div class="card"><div class="card-body">' +
      escHtml(e.message || 'Search failed.') + '</div></div>';
  } finally {
    _csBusy = false;
  }
}

function csCell(key, v, row) {
  if (v === null || v === undefined || v === '') return '<span style="color:var(--text-muted-color)">-</span>';
  if (key === 'created_at') {
    try {
      var d = new Date(v);
      return '<span class="cs-num">' + d.toLocaleDateString('en-US') + '</span>' +
        '<div style="font-size:11px;color:var(--text-muted-color)">' +
        d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '</div>';
    } catch (e) { return escHtml(v); }
  }
  if (key === 'age_at_close') {
    var s = parseInt(v, 10);
    if (!isFinite(s)) return '-';
    return '<span class="cs-num">' + (s < 3600 ? Math.round(s / 60) + 'm'
      : Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm') + '</span>';
  }
  if (key === 'on_time') {
    return v === true ? '<span style="color:#4ade80;font-weight:700">On time</span>'
      : '<span style="color:#f87171;font-weight:700">Late</span>';
  }
  if (key === 'is_edu') return v === true ? '<span class="cs-edu">EDU</span>' : '-';
  if (key === 'status') {
    var LBL = { new: 'Unassigned', assigned: 'Dispatched', accepted: 'Accepted', enroute: 'En-route',
      onscene: 'On scene', done: 'Completed', goa: 'GOA', cancelled: 'Cancelled' };
    return escHtml(LBL[v] || v);
  }
  if (key === 'quoted_price') return '<span class="cs-num">$' + escHtml(v) + '</span>';
  if (key === 'eta_minutes') return '<span class="cs-num">' + escHtml(v) + ' min</span>';
  return escHtml(v);
}

function csRenderResults(columns) {
  var target = document.getElementById('cs-results');
  if (!target) return;
  if (!_csRows.length) {
    target.innerHTML = '<div class="card"><div class="empty-state">No calls match that.<br>' +
      '<span style="font-size:13px">Widen the dates, or clear a filter.</span></div></div>';
    return;
  }
  var head = columns.map(function (c) { return '<th>' + escHtml(c.label) + '</th>'; }).join('');
  var body = _csRows.map(function (row) {
    var tds = columns.map(function (c) { return '<td>' + csCell(c.key, row[c.key], row) + '</td>'; }).join('');
    return '<tr class="cs-row" onclick="csOpen(' + (row.id || 0) + ')">' + tds + '</tr>';
  }).join('');

  var shown = _csOffset + _csRows.length;
  var pager = '';
  if (_csTotal > _csRows.length) {
    pager = '<div class="card-body" style="border-top:1px solid var(--border);display:flex;' +
      'align-items:center;gap:10px;justify-content:flex-end">' +
      '<span class="cs-scope">Showing ' + (_csOffset + 1) + '-' + shown + ' of ' + _csTotal + '</span>' +
      (_csOffset > 0 ? '<button class="btn btn-secondary btn-sm" onclick="csSearch(' + Math.max(0, _csOffset - CS_PAGE) + ')">Previous</button>' : '') +
      (shown < _csTotal ? '<button class="btn btn-secondary btn-sm" onclick="csSearch(' + (_csOffset + CS_PAGE) + ')">Next</button>' : '') +
      '</div>';
  }

  target.innerHTML =
    '<div class="card">' +
      '<div class="card-header">' +
        '<div class="card-title">' + _csTotal + (_csTotal === 1 ? ' call' : ' calls') + '</div>' +
        '<div class="flex-gap">' +
          (_csMasked ? '<span class="cs-mask">PII shortened</span>' : '') +
          '<span class="cs-scope">Click a row to open the call</span>' +
        '</div>' +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      pager +
    '</div>';
}

function csOpen(id) {
  if (!id) return;
  // Reuse the dispatch call screen rather than building a second read-only one -
  // two screens showing the same call is two places to fix a bug.
  if (typeof dispOpenCall === 'function') return dispOpenCall(id, true);
  if (typeof navigate === 'function') return navigate('dispatch');
}

// ---------------------------------------------------------------------------
//  Columns
// ---------------------------------------------------------------------------
// The list offered here is already filtered by the server. A column somebody is
// not allowed to see can never appear, which is what stops the export being
// used to widen a view.
function csColumnPicker() {
  var rows = _csCols.map(function (c) {
    var on = _csSel.indexOf(c.key) !== -1;
    return '<label class="cs-col">' +
      '<input type="checkbox" class="cs-colbox" value="' + escHtml(c.key) + '"' + (on ? ' checked' : '') +
      (c.key === 'job_number' ? ' disabled' : '') + '>' +
      escHtml(c.label) +
      (c.masked ? '<span class="cs-m">shortened</span>' : '') +
      '</label>';
  }).join('');

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal">' +
      '<div class="modal-header"><h3>Columns</h3></div>' +
      '<div class="modal-body">' +
        '<div class="cs-cols">' + rows + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-top:10px;line-height:1.6">' +
          'Saved to your account. <b>Export writes exactly these columns, in this order</b> - ' +
          'no more, no less. Job # is always included so a row can be quoted back to someone.' +
        '</div>' +
      '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-secondary" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="csSaveColumns(this)">Save</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
}

async function csSaveColumns(btn) {
  var boxes = document.querySelectorAll('.cs-colbox');
  var picked = [];
  for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) picked.push(boxes[i].value);
  if (!picked.length) {
    if (typeof showToast === 'function') showToast('Pick at least one column.', 'error');
    return;
  }
  try {
    var r = await api('POST', '/call-search/columns', { columns: picked });
    _csSel = r.columns || picked;
  } catch (e) {
    if (typeof showToast === 'function') showToast(e.message, 'error');
    return;
  }
  var ov = btn.closest('.modal-overlay');
  if (ov) ov.remove();
  csSearch(0);
}

// ---------------------------------------------------------------------------
//  Export
// ---------------------------------------------------------------------------
// Goes through the authenticated api() helper rather than a bare link, because
// a plain href would drop the JWT and the audit log entry with it.
async function csExport() {
  try {
    var res = await fetch('/api/call-search/export?' + csQuery(), {
      headers: state.token ? { Authorization: 'Bearer ' + state.token } : {}
    });
    if (!res.ok) throw new Error('Export failed (' + res.status + ')');
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'nova-calls.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    if (typeof showToast === 'function') showToast('Exported. This download is recorded in the audit log.', 'success');
  } catch (e) {
    if (typeof showToast === 'function') showToast(e.message || 'Export failed.', 'error');
  }
}
