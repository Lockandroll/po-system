/* Nova - Pulsar Call Data
 * ---------------------------------------------------------------------------
 * A raw dump of the Pulsar Call Search export for evaluation. Every column of
 * every row is kept as exported; Nova upserts on Call UID so re-dropping an
 * overlapping export only changes what actually moved.
 *
 * Tabs: Browse (filter + export), Summary (rollups), SQL (admin/owner),
 * Import (manage_call_data). Server side lives in routes/callData.js.
 *
 * The CSV is parsed HERE, in the browser, and posted in batches of 1,000 rows,
 * because a three-year export is far bigger than one request should carry.
 *
 * House style (CLAUDE.md): string concatenation, no backticks, and &#39; for
 * an apostrophe inside an HTML string.
 * --------------------------------------------------------------------------- */

var _cdTab = 'browse';
var _cdMeta = null;
var _cdF = {};                   // shared filters: from,to,location,status,tech,task,account,q,col,op,val
var _cdSort = { key: 'call_at', dir: 'desc', label: '' };
var _cdPage = 1;
var _cdLimit = 50;
var _cdSum = { group: 'week', by: 'location', byCol: '' };
var _cdSumRows = null;
var _cdSqlOut = null;
var _cdFile = null;              // { name, headers, rows } parsed and waiting
var _cdBusy = false;
var CD_BATCH = 1000;

function cdInjectStyles() {
  if (document.getElementById('cd-styles')) return;
  var css =
    '.cd-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap}' +
    '.cd-tab{padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-muted-color)}' +
    '.cd-tab.on{color:var(--primary);border-bottom-color:var(--primary)}' +
    '.cd-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}' +
    '.cd-card{border:1px solid var(--border);border-radius:var(--radius);padding:10px 13px;background:rgba(127,127,127,.05)}' +
    '.cd-card .k{font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted-color)}' +
    '.cd-card .v{font-size:18px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums}' +
    '.cd-filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:10px;align-items:end}' +
    '.cd-filters label{display:block;font-size:11px;font-weight:700;color:var(--text-muted-color);margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em}' +
    '.cd-filters input,.cd-filters select{width:100%}' +
    '.cd-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}' +
    '.cd-bar .sp{flex:1}' +
    '.cd-num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.cd-tbl th{cursor:pointer;white-space:nowrap;user-select:none}' +
    '.cd-tbl td{white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}' +
    '.cd-muted{font-size:12px;color:var(--text-muted-color);line-height:1.6}' +
    '.cd-drop{border:2px dashed var(--border);border-radius:var(--radius);padding:26px;text-align:center;font-size:13.5px;color:var(--text-muted-color)}' +
    '.cd-warn{background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.35);border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.cd-good{background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.3);border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.cd-prog{height:8px;border-radius:99px;background:rgba(127,127,127,.18);overflow:hidden;margin:10px 0}' +
    '.cd-prog > div{height:100%;background:var(--primary);width:0;transition:width .2s}' +
    '.cd-cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:4px 12px;max-height:340px;overflow:auto;font-size:13px;padding:4px}' +
    '.cd-sql{width:100%;min-height:130px;font-family:ui-monospace,Consolas,monospace;font-size:13px}' +
    '.cd-chip{padding:5px 10px;font-size:12px;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--text-muted-color);cursor:pointer}';
  var st = document.createElement('style');
  st.id = 'cd-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function cdFmtInt(n) { return Number(n || 0).toLocaleString(); }
function cdMoney(n) {
  if (n === null || n === undefined) return '';
  var v = Number(n);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function cdNum(n) { return (n === null || n === undefined) ? '' : String(n); }

function cdQuery(extra) {
  var o = Object.assign({}, _cdF, extra || {});
  var parts = [];
  Object.keys(o).forEach(function (k) {
    var v = o[k];
    if (v === undefined || v === null || v === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

/* ---------------------------------------------------------------- loading */

async function renderCallData(content) {
  cdInjectStyles();
  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Pulsar Call Data</div>' +
      '<div class="page-subtitle">Every Call Search column, every call, in one place to evaluate.</div></div></div>' +
    '<div id="cd-cards"></div>' +
    '<div class="cd-tabs" id="cd-tabs"></div>' +
    '<div id="cd-body"><div class="loading">Loading…</div></div>';
  await cdLoadMeta();
  cdDraw();
}

async function cdLoadMeta() {
  try { _cdMeta = await api('GET', '/call-data/meta'); }
  catch (e) { _cdMeta = null; }
}

function cdDraw() {
  var body = document.getElementById('cd-body');
  if (!body) return;
  if (!_cdMeta) { body.innerHTML = '<div class="cd-warn">Could not load the call data.</div>'; return; }
  var m = _cdMeta;
  var last = (m.imports || []).filter(function (i) { return i.status !== 'running'; })[0];
  document.getElementById('cd-cards').innerHTML =
    '<div class="cd-cards">' +
      '<div class="cd-card"><div class="k">Calls stored</div><div class="v">' + cdFmtInt(m.calls) + '</div></div>' +
      '<div class="cd-card"><div class="k">Covers</div><div class="v" style="font-size:15px">' +
        (m.first_date ? escHtml(m.first_date) + ' to ' + escHtml(m.last_date) : '-') + '</div></div>' +
      '<div class="cd-card"><div class="k">Columns</div><div class="v">' + (m.columns || []).length + '</div></div>' +
      '<div class="cd-card"><div class="k">Last import</div><div class="v" style="font-size:15px">' +
        (last ? escHtml(String(last.created_at).slice(0, 10)) : 'never') + '</div></div>' +
    '</div>';
  var tabs = [['browse', 'Browse'], ['summary', 'Summary']];
  if (m.canSql) tabs.push(['sql', 'SQL']);
  if (m.canImport) tabs.push(['import', 'Import']);
  if (!tabs.some(function (t) { return t[0] === _cdTab; })) _cdTab = 'browse';
  document.getElementById('cd-tabs').innerHTML = tabs.map(function (t) {
    return '<div class="cd-tab' + (_cdTab === t[0] ? ' on' : '') + '" onclick="cdGo(\'' + t[0] + '\')">' + t[1] + '</div>';
  }).join('');
  if (!m.calls && _cdTab !== 'import') {
    body.innerHTML = '<div class="cd-warn"><strong>Nothing here yet.</strong> ' +
      (m.canImport ? 'Drop a Call Search export on the Import tab. Pull as far back as Pulsar allows; overlaps are free.'
                   : 'Somebody with import access needs to drop a Call Search export first.') + '</div>';
    return;
  }
  if (_cdTab === 'browse') cdDrawBrowse(body);
  else if (_cdTab === 'summary') cdDrawSummary(body);
  else if (_cdTab === 'sql') cdDrawSql(body);
  else cdDrawImport(body);
}

function cdGo(t) { _cdTab = t; cdDraw(); }

/* ---------------------------------------------------------------- filters */

function cdFilterBar(onApply) {
  var m = _cdMeta || {};
  function opt(list, cur) {
    return '<option value="">All</option>' + (list || []).map(function (x) {
      return '<option value="' + escHtml(x.name) + '"' + (cur === x.name ? ' selected' : '') + '>' +
        escHtml(x.name) + ' (' + cdFmtInt(x.calls) + ')</option>';
    }).join('');
  }
  var colOpts = '<option value="">(any column)</option>' + (m.columns || []).map(function (c) {
    return '<option value="' + escHtml(c) + '"' + (_cdF.col === c ? ' selected' : '') + '>' + escHtml(c) + '</option>';
  }).join('');
  var ops = [['contains', 'contains'], ['equals', 'equals'], ['empty', 'is empty'], ['notempty', 'is not empty']];
  return '<div class="cd-filters" onkeydown="if(event.key===\'Enter\'){' + onApply + '}">' +
    '<div><label>From</label><input type="date" id="cdf-from" value="' + escHtml(_cdF.from || '') + '"></div>' +
    '<div><label>To</label><input type="date" id="cdf-to" value="' + escHtml(_cdF.to || '') + '"></div>' +
    '<div><label>Location</label><select id="cdf-location">' + opt(m.locations, _cdF.location) + '</select></div>' +
    '<div><label>Status</label><select id="cdf-status">' + opt(m.statuses, _cdF.status) + '</select></div>' +
    '<div><label>Tech</label><input id="cdf-tech" placeholder="contains" value="' + escHtml(_cdF.tech || '') + '"></div>' +
    '<div><label>Task</label><input id="cdf-task" placeholder="contains" value="' + escHtml(_cdF.task || '') + '"></div>' +
    '<div><label>Account</label><input id="cdf-account" placeholder="contains" value="' + escHtml(_cdF.account || '') + '"></div>' +
    '<div><label>Search all</label><input id="cdf-q" placeholder="anything in the row" value="' + escHtml(_cdF.q || '') + '"></div>' +
    '<div><label>Column</label><select id="cdf-col">' + colOpts + '</select></div>' +
    '<div><label>Match</label><select id="cdf-op">' + ops.map(function (o) {
      return '<option value="' + o[0] + '"' + ((_cdF.op || 'contains') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') + '</select></div>' +
    '<div><label>Value</label><input id="cdf-val" value="' + escHtml(_cdF.val || '') + '"></div>' +
    '<div style="display:flex;gap:6px"><button class="btn btn-primary btn-sm" onclick="' + onApply + '">Apply</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="cdClearFilters()">Clear</button></div>' +
  '</div>';
}

function cdReadFilters() {
  var f = {};
  ['from', 'to', 'location', 'status', 'tech', 'task', 'account', 'q', 'col', 'op', 'val'].forEach(function (k) {
    var el = document.getElementById('cdf-' + k);
    if (el && String(el.value).trim() !== '') f[k] = String(el.value).trim();
  });
  if (!f.col) { delete f.op; delete f.val; }
  else if (f.op === 'contains' && !f.val) { delete f.col; delete f.op; }
  _cdF = f;
}

function cdClearFilters() {
  _cdF = {};
  _cdPage = 1;
  cdDraw();
}

/* ----------------------------------------------------------------- browse */

function cdVisibleCols() {
  var all = (_cdMeta && _cdMeta.columns) || [];
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('nova_cd_cols') || 'null'); } catch (e) { saved = null; }
  if (Array.isArray(saved)) {
    var keep = saved.filter(function (c) { return all.indexOf(c) !== -1; });
    if (keep.length) return keep;
  }
  return all.slice(0, 12);
}

function cdDrawBrowse(body) {
  body.innerHTML =
    cdFilterBar('cdApplyBrowse()') +
    '<div class="cd-bar"><span id="cd-count" class="cd-muted"></span><span class="sp"></span>' +
      '<button class="btn btn-secondary btn-sm" onclick="cdPickCols()">Columns</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="cdExport()">Export CSV</button></div>' +
    '<div id="cd-grid"><div class="loading">Loading…</div></div>';
  cdLoadRows();
}

function cdApplyBrowse() { cdReadFilters(); _cdPage = 1; cdLoadRows(); }

async function cdLoadRows() {
  var grid = document.getElementById('cd-grid');
  if (!grid) return;
  var data;
  try {
    data = await api('GET', '/call-data/rows' + cdQuery({ sort: _cdSort.key, dir: _cdSort.dir, page: _cdPage, limit: _cdLimit }));
  } catch (e) {
    grid.innerHTML = '<div class="cd-warn">' + escHtml(e.message || 'Could not load calls.') + '</div>';
    return;
  }
  var cols = cdVisibleCols();
  var pages = Math.max(1, Math.ceil(data.total / data.limit));
  var cnt = document.getElementById('cd-count');
  if (cnt) cnt.textContent = cdFmtInt(data.total) + ' calls match';
  var arrow = function (c) { return (_cdSort.label || _cdSort.key) === c ? (_cdSort.dir === 'asc' ? ' &#9650;' : ' &#9660;') : ''; };
  grid.innerHTML =
    '<div class="table-container"><table class="cd-tbl"><thead><tr>' +
      cols.map(function (c) {
        return '<th data-col="' + escHtml(c) + '" onclick="cdSortBy(this.getAttribute(\'data-col\'))">' + escHtml(c) + arrow(c) + '</th>';
      }).join('') +
    '</tr></thead><tbody>' +
      (data.rows.length ? data.rows.map(function (r) {
        return '<tr>' + cols.map(function (c) {
          var v = r.data[c];
          return '<td title="' + escHtml(v == null ? '' : v) + '">' + escHtml(v == null ? '' : v) + '</td>';
        }).join('') + '</tr>';
      }).join('') : '<tr><td colspan="' + cols.length + '" class="cd-muted">No calls match.</td></tr>') +
    '</tbody></table></div>' +
    '<div class="cd-bar" style="margin-top:10px">' +
      '<button class="btn btn-secondary btn-sm"' + (_cdPage <= 1 ? ' disabled' : '') + ' onclick="cdPageTo(' + (_cdPage - 1) + ')">Prev</button>' +
      '<span class="cd-muted">Page ' + _cdPage + ' of ' + cdFmtInt(pages) + '</span>' +
      '<button class="btn btn-secondary btn-sm"' + (_cdPage >= pages ? ' disabled' : '') + ' onclick="cdPageTo(' + (_cdPage + 1) + ')">Next</button>' +
      '<span class="sp"></span><span class="cd-muted">Rows per page</span>' +
      '<select onchange="cdSetLimit(this.value)" style="width:auto">' + [25, 50, 100, 250, 500].map(function (n) {
        return '<option' + (n === _cdLimit ? ' selected' : '') + '>' + n + '</option>';
      }).join('') + '</select>' +
    '</div>';
}

// Sort by the typed field when one backs this column (a real date or number
// sort); otherwise the server sorts the column as text.
function cdSortKeyFor(col) {
  var map = {};
  var imp = (_cdMeta && _cdMeta.imports || []).filter(function (i) { return i.mapping; })[0];
  var mp = imp ? imp.mapping : {};
  if (mp.when) map[mp.when] = 'call_at';
  if (mp.ata) map[mp.ata] = 'ata_mins';
  if (mp.onsite) map[mp.onsite] = 'onsite_mins';
  return map[col] || col;
}

function cdSortBy(col) {
  var key = cdSortKeyFor(col);
  if (_cdSort.key === key || _cdSort.key === col) _cdSort.dir = _cdSort.dir === 'asc' ? 'desc' : 'asc';
  else { _cdSort.key = key; _cdSort.dir = 'asc'; }
  _cdSort.label = col;
  _cdPage = 1;
  cdLoadRows();
}
function cdPageTo(p) { _cdPage = Math.max(1, p); cdLoadRows(); }
function cdSetLimit(v) { _cdLimit = parseInt(v, 10) || 50; _cdPage = 1; cdLoadRows(); }

function cdPickCols() {
  var all = (_cdMeta && _cdMeta.columns) || [];
  var vis = cdVisibleCols();
  var html =
    '<div class="cd-bar"><button class="cd-chip" onclick="cdColsAll(true)">All</button>' +
    '<button class="cd-chip" onclick="cdColsAll(false)">None</button></div>' +
    '<div class="cd-cols" id="cd-cols">' + all.map(function (c) {
      return '<label><input type="checkbox" value="' + escHtml(c) + '"' + (vis.indexOf(c) !== -1 ? ' checked' : '') + '> ' + escHtml(c) + '</label>';
    }).join('') + '</div>';
  cdModal('Columns to show', html, 'Show these', function () {
    var picked = [];
    document.querySelectorAll('#cd-cols input:checked').forEach(function (el) { picked.push(el.value); });
    try { localStorage.setItem('nova_cd_cols', JSON.stringify(picked)); } catch (e) {}
    cdLoadRows();
  });
}
function cdColsAll(on) { document.querySelectorAll('#cd-cols input').forEach(function (el) { el.checked = on; }); }

function cdModal(title, html, okText, onOk) {
  var old = document.getElementById('cd-modal');
  if (old) old.remove();
  var wrap = document.createElement('div');
  wrap.id = 'cd-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  wrap.innerHTML =
    '<div style="background:var(--card-bg,#1a1a1a);border:1px solid var(--border);border-radius:var(--radius);max-width:760px;width:100%;padding:18px">' +
      '<div style="font-weight:700;font-size:16px;margin-bottom:12px">' + escHtml(title) + '</div>' + html +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">' +
        '<button class="btn btn-secondary" id="cd-modal-x">Cancel</button>' +
        '<button class="btn btn-primary" id="cd-modal-ok">' + escHtml(okText) + '</button></div></div>';
  document.body.appendChild(wrap);
  document.getElementById('cd-modal-x').onclick = function () { wrap.remove(); };
  document.getElementById('cd-modal-ok').onclick = function () { onOk(); wrap.remove(); };
}

async function cdDownload(path, filename) {
  try {
    var headers = {};
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    if (state.viewAsId) headers['X-View-As'] = String(state.viewAsId);
    var res = await fetch('/api' + path, { headers: headers });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    var blob = await res.blob();
    cdSaveBlob(blob, filename);
  } catch (e) {
    showToast('Could not download: ' + (e.message || 'unknown error'), 'error');
  }
}
function cdSaveBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
function cdExport() {
  showToast('Building the export…', 'info');
  cdDownload('/call-data/export' + cdQuery(), 'pulsar-call-data-' + new Date().toISOString().slice(0, 10) + '.csv');
}

/* ---------------------------------------------------------------- summary */

var CD_SUM_COLS = [
  ['calls', 'Calls', 'int'], ['completed', 'Completed', 'int'], ['goa', 'GOA', 'int'], ['canceled', 'Canceled', 'int'],
  ['revenue', 'Revenue', 'money'], ['ata_avg', 'ATA avg', 'n'], ['ata_median', 'ATA median', 'n'], ['ata_p90', 'ATA p90', 'n'],
  ['onsite_avg', 'On-site avg', 'n'], ['onsite_median', 'On-site median', 'n']
];

function cdDrawSummary(body) {
  var cols = (_cdMeta && _cdMeta.columns) || [];
  var groups = [['day', 'Day'], ['week', 'Week (Mon)'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year'], ['none', 'Whole range']];
  var bys = [['location', 'Location'], ['tech', 'Tech'], ['task', 'Task'], ['service', 'Service class'], ['status', 'Status'],
    ['account', 'Account'], ['dow', 'Day of week'], ['hour', 'Hour of day'], ['none', 'Everything together'], ['col', 'Another column…']];
  function sel(id, list, cur, onch) {
    return '<select id="' + id + '" onchange="' + onch + '" style="width:auto">' + list.map(function (o) {
      return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') + '</select>';
  }
  body.innerHTML =
    cdFilterBar('cdApplySummary()') +
    '<div class="cd-bar"><span class="cd-muted">Per</span>' +
      sel('cds-group', groups, _cdSum.group, 'cdApplySummary()') +
      '<span class="cd-muted">by</span>' + sel('cds-by', bys, _cdSum.by, 'cdApplySummary()') +
      (_cdSum.by === 'col' ? sel('cds-col', cols.map(function (c) { return [c, c]; }), _cdSum.byCol, 'cdApplySummary()') : '') +
      '<span class="sp"></span><button class="btn btn-secondary btn-sm" onclick="cdSummaryCsv()">Download CSV</button></div>' +
    '<div id="cd-sum"><div class="loading">Adding it up…</div></div>' +
    '<div class="cd-muted" style="margin-top:12px">ATA and on-site figures ignore blanks and zeros. Median and p90 are shown beside the ' +
      'average because a handful of extreme ATAs drag the mean. Revenue is the sum of the Collected columns. Service class: a task ' +
      'segment of LS is Locksmith, BAT is Battery, everything else Roadside.</div>';
  cdLoadSummary();
}

function cdApplySummary() {
  cdReadFilters();
  var g = document.getElementById('cds-group'), b = document.getElementById('cds-by'), c = document.getElementById('cds-col');
  var prevBy = _cdSum.by;
  if (g) _cdSum.group = g.value;
  if (b) _cdSum.by = b.value;
  if (c) _cdSum.byCol = c.value;
  if (_cdSum.by === 'col' && !_cdSum.byCol) _cdSum.byCol = ((_cdMeta && _cdMeta.columns) || [])[0] || '';
  if (prevBy !== _cdSum.by) { cdDrawSummary(document.getElementById('cd-body')); return; }
  cdLoadSummary();
}

async function cdLoadSummary() {
  var box = document.getElementById('cd-sum');
  if (!box) return;
  try {
    var d = await api('GET', '/call-data/summary' + cdQuery({ group: _cdSum.group, by: _cdSum.by, byCol: _cdSum.by === 'col' ? _cdSum.byCol : '' }));
    _cdSumRows = d.rows;
  } catch (e) {
    box.innerHTML = '<div class="cd-warn">' + escHtml(e.message || 'Could not build the summary.') + '</div>';
    return;
  }
  var showPeriod = _cdSum.group !== 'none';
  var keyLabel = _cdSum.by === 'col' ? _cdSum.byCol : (document.getElementById('cds-by') || {}).selectedOptions
    ? document.getElementById('cds-by').selectedOptions[0].text : 'Group';
  box.innerHTML =
    '<div class="table-container"><table><thead><tr>' +
      (showPeriod ? '<th>Period</th>' : '') + '<th>' + escHtml(keyLabel) + '</th>' +
      CD_SUM_COLS.map(function (c) { return '<th class="cd-num">' + c[1] + '</th>'; }).join('') +
    '</tr></thead><tbody>' +
      (_cdSumRows.length ? _cdSumRows.map(function (r) {
        return '<tr>' + (showPeriod ? '<td>' + escHtml(r.period || '') + '</td>' : '') + '<td>' + escHtml(r.key) + '</td>' +
          CD_SUM_COLS.map(function (c) {
            var v = r[c[0]];
            return '<td class="cd-num">' + (c[2] === 'money' ? cdMoney(v) : c[2] === 'int' ? cdFmtInt(v) : cdNum(v)) + '</td>';
          }).join('') + '</tr>';
      }).join('') : '<tr><td colspan="12" class="cd-muted">No calls match.</td></tr>') +
    '</tbody></table></div>' +
    (_cdSumRows.length >= 5000 ? '<div class="cd-muted">Showing the first 5,000 groups. Narrow the filters or use a wider period.</div>' : '');
}

function cdToCsv(header, rows) {
  function cell(v) { var s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  return '﻿' + [header.map(cell).join(',')].concat(rows.map(function (r) { return r.map(cell).join(','); })).join('\r\n');
}

function cdSummaryCsv() {
  if (!_cdSumRows) return;
  var head = ['Period', 'Group'].concat(CD_SUM_COLS.map(function (c) { return c[1]; }));
  var rows = _cdSumRows.map(function (r) { return [r.period || '', r.key].concat(CD_SUM_COLS.map(function (c) { return r[c[0]]; })); });
  cdSaveBlob(new Blob([cdToCsv(head, rows)], { type: 'text/csv' }), 'call-data-summary-' + _cdSum.group + '-by-' + _cdSum.by + '.csv');
}

/* -------------------------------------------------------------------- sql */

var CD_SQL_EXAMPLES = [
  ['ATA by location, last 30 days',
   "SELECT location, COUNT(*) AS calls,\n  ROUND(AVG(ata_mins),1) AS ata_avg,\n  percentile_cont(0.9) WITHIN GROUP (ORDER BY ata_mins) AS ata_p90\nFROM cd_calls\nWHERE call_date >= CURRENT_DATE - 30 AND ata_mins > 0\nGROUP BY location ORDER BY ata_avg DESC"],
  ['Top 25 vehicle makes',
   "SELECT data->>'Car Make' AS make, COUNT(*) AS calls,\n  COUNT(*) FILTER (WHERE status = 'Completed') AS completed\nFROM cd_calls GROUP BY 1 ORDER BY calls DESC LIMIT 25"],
  ['Revenue by tech, this year',
   "SELECT tech, COUNT(*) AS calls, SUM(revenue) AS revenue\nFROM cd_calls\nWHERE call_date >= date_trunc('year', CURRENT_DATE)\nGROUP BY tech ORDER BY revenue DESC NULLS LAST"],
  ['Columns and how full they are',
   "SELECT c.name, COUNT(*) FILTER (WHERE COALESCE(k.data->>c.name,'') <> '') AS filled\nFROM cd_columns c CROSS JOIN cd_calls k\nGROUP BY c.name, c.position ORDER BY c.position"]
];

function cdDrawSql(body) {
  var cur = (document.getElementById('cd-sql-text') || {}).value || (_cdSqlOut && _cdSqlOut.sql) || CD_SQL_EXAMPLES[0][1];
  body.innerHTML =
    '<div class="cd-muted" style="margin-bottom:8px">Read-only, call data tables only: <strong>cd_calls</strong> (typed columns call_at, call_date, ' +
      'location, task, tech, status, account, ata_mins, onsite_mins, revenue, plus every export column in <code>data-&gt;&gt;\'Column Name\'</code>), ' +
      '<strong>cd_imports</strong>, <strong>cd_columns</strong>. 20-second limit, 2,000 rows shown.</div>' +
    '<div class="cd-bar">' + CD_SQL_EXAMPLES.map(function (x, i) {
      return '<button class="cd-chip" onclick="cdSqlExample(' + i + ')">' + escHtml(x[0]) + '</button>';
    }).join('') + '</div>' +
    '<textarea id="cd-sql-text" class="cd-sql" spellcheck="false">' + escHtml(cur) + '</textarea>' +
    '<div class="cd-bar" style="margin-top:8px"><button class="btn btn-primary btn-sm" onclick="cdRunSql()">Run</button>' +
      '<span class="cd-muted">Ctrl+Enter runs it</span><span class="sp"></span>' +
      '<button class="btn btn-secondary btn-sm" onclick="cdSqlCsv()">Download CSV</button></div>' +
    '<div id="cd-sql-out"></div>';
  document.getElementById('cd-sql-text').onkeydown = function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) cdRunSql(); };
  if (_cdSqlOut) cdDrawSqlOut();
}
function cdSqlExample(i) { document.getElementById('cd-sql-text').value = CD_SQL_EXAMPLES[i][1]; }

async function cdRunSql() {
  var sql = document.getElementById('cd-sql-text').value;
  var out = document.getElementById('cd-sql-out');
  out.innerHTML = '<div class="loading">Running…</div>';
  try {
    _cdSqlOut = await api('POST', '/call-data/sql', { sql: sql });
    _cdSqlOut.sql = sql;
    cdDrawSqlOut();
  } catch (e) {
    _cdSqlOut = null;
    out.innerHTML = '<div class="cd-warn">' + escHtml(e.message || 'Query failed.') + '</div>';
  }
}
function cdDrawSqlOut() {
  var o = _cdSqlOut, out = document.getElementById('cd-sql-out');
  if (!o || !out) return;
  out.innerHTML =
    '<div class="cd-muted" style="margin:8px 0">' + cdFmtInt(o.rows.length) + ' rows' + (o.truncated ? ' (capped at 2,000)' : '') + ' in ' + o.ms + ' ms</div>' +
    '<div class="table-container"><table class="cd-tbl"><thead><tr>' + o.columns.map(function (c) { return '<th>' + escHtml(c) + '</th>'; }).join('') +
    '</tr></thead><tbody>' + o.rows.map(function (r) {
      return '<tr>' + o.columns.map(function (c) {
        var v = r[c]; if (v !== null && typeof v === 'object') v = JSON.stringify(v);
        return '<td title="' + escHtml(v == null ? '' : v) + '">' + escHtml(v == null ? '' : v) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
}
function cdSqlCsv() {
  var o = _cdSqlOut; if (!o) return;
  var rows = o.rows.map(function (r) { return o.columns.map(function (c) { var v = r[c]; return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v; }); });
  cdSaveBlob(new Blob([cdToCsv(o.columns, rows)], { type: 'text/csv' }), 'call-data-query.csv');
}

/* ----------------------------------------------------------------- import */

function cdDrawImport(body) {
  var imports = (_cdMeta && _cdMeta.imports) || [];
  body.innerHTML =
    '<div class="cd-muted" style="margin-bottom:12px"><strong>Export whatever columns you like, as far back as Pulsar lets you.</strong> ' +
      'The one column the export must include is <strong>Call UID</strong>. Nova keeps every column as-is and matches on Call UID, so an ' +
      'overlapping export only changes the calls that actually moved, and a file with different columns adds them to the same calls ' +
      'instead of duplicating anything. Nothing here ever deletes.</div>' +
    '<div class="cd-drop" id="cd-drop">' +
      '<input type="file" id="cd-file" accept=".csv,text/csv" style="display:none" onchange="cdFilePicked(this)">' +
      '<div style="font-weight:600;margin-bottom:6px">Drop the Call Search CSV here</div>' +
      '<div>or <a href="#" onclick="document.getElementById(\'cd-file\').click();return false">choose a file</a></div>' +
    '</div>' +
    '<div id="cd-imp" style="margin-top:16px"></div>' +
    (imports.length
      ? '<h3 style="margin:26px 0 8px;font-size:16px">Imports</h3>' +
        '<div class="table-container"><table><thead><tr><th>When</th><th>File</th><th>By</th><th>Covers</th>' +
        '<th class="cd-num">Rows</th><th class="cd-num">New</th><th class="cd-num">Changed</th><th class="cd-num">Unchanged</th>' +
        '<th class="cd-num">Skipped</th><th>Status</th></tr></thead><tbody>' +
        imports.map(function (i) {
          return '<tr><td>' + escHtml(String(i.created_at).slice(0, 16).replace('T', ' ')) + '</td>' +
            '<td>' + escHtml(i.filename || '-') + '</td><td>' + escHtml(i.uploaded_by_name || '-') + '</td>' +
            '<td>' + (i.first_date ? escHtml(i.first_date) + ' to ' + escHtml(i.last_date) : '-') + '</td>' +
            '<td class="cd-num">' + cdFmtInt(i.total_rows) + '</td><td class="cd-num">' + cdFmtInt(i.inserted_rows) + '</td>' +
            '<td class="cd-num">' + cdFmtInt(i.updated_rows) + '</td><td class="cd-num">' + cdFmtInt(i.unchanged_rows) + '</td>' +
            '<td class="cd-num">' + cdFmtInt(i.skipped_rows) + '</td><td>' + escHtml(i.status) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '');
  var drop = document.getElementById('cd-drop');
  drop.ondragover = function (e) { e.preventDefault(); drop.style.borderColor = 'var(--primary)'; };
  drop.ondragleave = function () { drop.style.borderColor = ''; };
  drop.ondrop = function (e) {
    e.preventDefault(); drop.style.borderColor = '';
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) cdReadFile(e.dataTransfer.files[0]);
  };
  if (_cdFile) cdDrawFilePreview();
}

function cdFilePicked(input) { if (input.files && input.files[0]) cdReadFile(input.files[0]); }

function cdReadFile(file) {
  if (_cdBusy) return;
  var box = document.getElementById('cd-imp');
  box.innerHTML = '<div class="loading">Reading ' + escHtml(file.name) + '…</div>';
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var grid = cdParseCsv(String(reader.result || ''));
      if (grid.length < 2) throw new Error('That file has no data rows.');
      _cdFile = { name: file.name, headers: grid[0].map(function (h) { return String(h).trim(); }), rows: grid.slice(1) };
      cdDrawFilePreview();
    } catch (e) {
      _cdFile = null;
      box.innerHTML = '<div class="cd-warn">' + escHtml(e.message || 'Could not read that file.') + '</div>';
    }
  };
  reader.onerror = function () { box.innerHTML = '<div class="cd-warn">Could not read that file.</div>'; };
  reader.readAsText(file);
}

/*
 * RFC4180-ish tokenizer -> array of arrays. Quoted fields, doubled quotes,
 * embedded newlines, CRLF or LF, BOM. Rows that are entirely blank are dropped.
 */
function cdParseCsv(text) {
  var s = text;
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  var rows = [], row = [], field = '', inQ = false, i = 0, n = s.length, start;
  while (i < n) {
    var ch = s.charCodeAt(i);
    if (inQ) {
      if (ch === 34) {
        if (s.charCodeAt(i + 1) === 34) { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      start = i;
      while (i < n && s.charCodeAt(i) !== 34) i++;
      field += s.slice(start, i);
      continue;
    }
    if (ch === 34) { inQ = true; i++; continue; }
    if (ch === 44) { row.push(field); field = ''; i++; continue; }
    if (ch === 13) { i++; continue; }
    if (ch === 10) { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    start = i;
    while (i < n) { var c2 = s.charCodeAt(i); if (c2 === 44 || c2 === 10 || c2 === 13 || c2 === 34) break; i++; }
    field += s.slice(start, i);
  }
  row.push(field); rows.push(row);
  return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
}

function cdFindUid(headers) {
  var want = ['call uid', 'calluid', 'call_uid', 'call id', 'callid'];
  for (var i = 0; i < headers.length; i++) if (want.indexOf(headers[i].replace(/\s+/g, ' ').toLowerCase()) !== -1) return i;
  return -1;
}

function cdDrawFilePreview() {
  var f = _cdFile, box = document.getElementById('cd-imp');
  if (!f || !box) return;
  var uidIx = cdFindUid(f.headers);
  var named = f.headers.filter(Boolean);
  var known = (_cdMeta && _cdMeta.columns) || [];
  var fresh = named.filter(function (h) { return known.indexOf(h) === -1; });
  if (uidIx === -1) {
    box.innerHTML = '<div class="cd-warn"><strong>' + escHtml(f.name) + ' has no Call UID column.</strong> Add Call UID to the Call ' +
      'Search columns in Pulsar and export again. It is how Nova tells a re-import from a new call.</div>';
    return;
  }
  var blanks = 0;
  f.rows.forEach(function (r) { if (!String(r[uidIx] || '').trim()) blanks++; });
  box.innerHTML =
    '<div class="cd-good"><strong>' + escHtml(f.name) + '</strong>: ' + cdFmtInt(f.rows.length) + ' rows, ' + named.length + ' columns.' +
      (blanks ? ' ' + cdFmtInt(blanks) + ' rows have no Call UID and will be skipped.' : '') +
      (known.length && fresh.length ? '<br>New columns this file adds: ' + fresh.map(escHtml).join(', ') + '.' : '') +
    '</div>' +
    '<div class="cd-bar"><button class="btn btn-primary" id="cd-go" onclick="cdRunImport()">Import ' + cdFmtInt(f.rows.length) + ' rows</button>' +
      '<button class="btn btn-secondary" onclick="_cdFile=null;cdDraw()">Cancel</button></div>' +
    '<div id="cd-progress"></div>';
}

async function cdRunImport() {
  var f = _cdFile;
  if (!f || _cdBusy) return;
  _cdBusy = true;
  var btn = document.getElementById('cd-go'); if (btn) btn.disabled = true;
  var tot = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  var done = 0, imp = null, failed = null;
  // Looked up every time: the user may switch tabs mid-import, and the import
  // must keep going even though its progress bar is no longer on screen.
  function draw() {
    var prog = document.getElementById('cd-progress');
    if (!prog) return;
    var pct = f.rows.length ? Math.round(done / f.rows.length * 100) : 100;
    prog.innerHTML = '<div class="cd-prog"><div style="width:' + pct + '%"></div></div>' +
      '<div class="cd-muted">' + cdFmtInt(done) + ' of ' + cdFmtInt(f.rows.length) + ' rows. ' +
      cdFmtInt(tot.inserted) + ' new, ' + cdFmtInt(tot.updated) + ' changed, ' + cdFmtInt(tot.unchanged) + ' unchanged' +
      (tot.skipped ? ', ' + cdFmtInt(tot.skipped) + ' skipped' : '') + '.</div>';
  }
  draw();
  try {
    imp = await api('POST', '/call-data/imports', { filename: f.name, columns: f.headers, total_rows: f.rows.length });
    for (var i = 0; i < f.rows.length; i += CD_BATCH) {
      var batch = f.rows.slice(i, i + CD_BATCH).map(function (r) {
        var o = {};
        for (var c = 0; c < f.headers.length; c++) if (f.headers[c]) o[f.headers[c]] = r[c] == null ? '' : r[c];
        return o;
      });
      var res = null, tries = 0;
      while (!res) {
        try { res = await api('POST', '/call-data/imports/' + imp.id + '/rows', { rows: batch }); }
        catch (e) { tries++; if (tries >= 3) throw e; await new Promise(function (r) { setTimeout(r, 1500 * tries); }); }
      }
      Object.keys(tot).forEach(function (k) { tot[k] += res[k] || 0; });
      done += batch.length;
      draw();
    }
  } catch (e) {
    failed = e.message || 'unknown error';
  }
  if (imp) { try { await api('POST', '/call-data/imports/' + imp.id + '/finish', { status: failed ? 'partial' : 'done' }); } catch (e) {} }
  _cdBusy = false;
  _cdFile = null;
  if (typeof apiBustCache === 'function') apiBustCache('/call-data');
  await cdLoadMeta();
  cdDraw();
  var box = document.getElementById('cd-imp');
  if (box) box.innerHTML = failed
    ? '<div class="cd-warn"><strong>The import stopped part way: ' + escHtml(failed) + '</strong><br>' + cdFmtInt(done) + ' rows were saved. ' +
      'Drop the same file again to finish; the rows already saved will come back as unchanged.</div>'
    : '<div class="cd-good"><strong>Imported.</strong> ' + cdFmtInt(tot.inserted) + ' new calls, ' + cdFmtInt(tot.updated) + ' changed, ' +
      cdFmtInt(tot.unchanged) + ' unchanged' + (tot.skipped ? ', ' + cdFmtInt(tot.skipped) + ' skipped (no Call UID)' : '') + '.</div>';
  showToast(failed ? 'Import stopped part way' : 'Call data imported', failed ? 'error' : 'success');
}
