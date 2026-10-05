// Swoop Surveys page (Agero / Swoop post-job reviews). Classic script, loaded
// after app.js, so it uses app.js globals: api, escHtml, can, showToast,
// novaAlert, novaConfirm, parsePartsCSV, pageSizeControl, parsePageSize,
// csvCell, geicoStatCard, FB_STATUS, feedbackOpen. Mirrors the Geico page.
// House style: string concatenation, no template literals; &#39; for an
// apostrophe inside an HTML attribute (CLAUDE.md 1.1 / 1.2).

var _swoopRows = [];
var _swoopStats = null;
var _swoopPage = 1;
var SWOOP_PAGE_SIZE = 10;
var _swoopEmployees = [];

async function renderSwoopSurveys(el) {
  if (!can('manage_geico')) { el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
  var cities = [];
  try { cities = await api('GET', '/cities'); } catch (e) { cities = []; }
  try { _swoopEmployees = await api('GET', '/swoop/employees') || []; } catch (e) { _swoopEmployees = []; }
  var cityOpts = '<option value="">All cities</option>' + cities.map(function (c) {
    return '<option value="' + escHtml(c.code) + '">' + escHtml(c.name) + '</option>';
  }).join('');
  var iS = 'padding:8px 10px;background:var(--surface-color);border:1px solid rgba(249,115,22,0.35);border-radius:6px;color:var(--text-color);font-size:13px;outline:none';
  var lbl = 'display:block;font-size:11px;color:var(--text-muted-color);margin-bottom:4px';
  el.innerHTML =
    '<div class="page-header"><div><div class="page-title">Swoop Surveys</div>' +
      '<div class="page-subtitle">Agero / Swoop post-job reviews, NPS by city &amp; technician</div></div>' +
      '<div><button class="btn btn-secondary btn-sm" id="swoop-check-btn" onclick="swoopCheckNow(this)">Check mail now</button></div></div>' +
    '<div id="swoop-note" style="font-size:12px;color:var(--text-muted-color);margin:-6px 0 14px">' +
      'Checks the mailbox every 20 minutes. Swoop&#39;s driver name is a guess until the job is verified (picked below or uploaded).</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-bottom:16px">' +
      '<div><label style="' + lbl + '">From</label><input type="date" id="swoop-from" style="' + iS + '" onchange="swoopLoad()" /></div>' +
      '<div><label style="' + lbl + '">To</label><input type="date" id="swoop-to" style="' + iS + '" onchange="swoopLoad()" /></div>' +
      '<div><label style="' + lbl + '">City</label><select id="swoop-city" style="' + iS + '" onchange="swoopLoad()">' + cityOpts + '</select></div>' +
      '<div><label style="' + lbl + '">Score</label><select id="swoop-band" style="' + iS + '" onchange="swoopLoad()">' +
        '<option value="">All scores</option><option value="promoter">Promoters (NPS 100)</option>' +
        '<option value="passive">Passives (NPS 0)</option><option value="detractor">Detractors (NPS -100)</option></select></div>' +
      '<div><label style="' + lbl + '">Verified</label><select id="swoop-verified" style="' + iS + '" onchange="swoopLoad()">' +
        '<option value="">All</option><option value="yes">Verified</option><option value="no">Not verified</option></select></div>' +
      '<div><label style="' + lbl + '">Employee</label><select id="swoop-employee" style="' + iS + '" onchange="swoopLoad()"><option value="">All employees</option></select></div>' +
      '<button class="btn btn-secondary btn-sm" onclick="swoopClearFilters()">Clear</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="swoopExportCSV()">&#8595; Export CSV</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="document.getElementById(&#39;swoop-csv-input&#39;).click()">&#8593; Upload Verification</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="swoopDownloadSample()">Verification Sample CSV</button>' +
      '<input type="file" id="swoop-csv-input" accept=".csv,text/csv" style="display:none" onchange="swoopOnCsvChosen(this)" />' +
    '</div>' +
    '<div id="swoop-stats" style="margin-bottom:16px"></div>' +
    '<div id="swoop-table-wrap"></div>' +
    '<div id="swoop-employee-wrap" style="margin-top:16px"></div>';
  await swoopLoad(true);
}

function swoopClearFilters() {
  ['swoop-from', 'swoop-to', 'swoop-city', 'swoop-band', 'swoop-verified', 'swoop-employee'].forEach(function (id) {
    var e = document.getElementById(id); if (e) e.value = '';
  });
  swoopLoad();
}

function swoopQS() {
  var parts = [];
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  var from = val('swoop-from'), to = val('swoop-to');
  if (from) parts.push('from=' + encodeURIComponent(from));
  // The "To" box is inclusive for people; the API's "to" is exclusive.
  if (to) {
    var d = new Date(to + 'T00:00:00Z');
    if (!isNaN(d.getTime())) { d.setUTCDate(d.getUTCDate() + 1); parts.push('to=' + d.toISOString().slice(0, 10)); }
  }
  [['city_code', 'swoop-city'], ['band', 'swoop-band'], ['verified', 'swoop-verified'], ['employee', 'swoop-employee']].forEach(function (p) {
    var v = val(p[1]); if (v) parts.push(p[0] + '=' + encodeURIComponent(v));
  });
  return parts.length ? ('?' + parts.join('&')) : '';
}

async function swoopLoad(initial) {
  var statsEl = document.getElementById('swoop-stats');
  var tableEl = document.getElementById('swoop-table-wrap');
  if (!statsEl || !tableEl) return;
  tableEl.innerHTML = '<div style="color:var(--text-muted-color);padding:12px">Loading...</div>';
  try {
    var qs = swoopQS();
    var stats = await api('GET', '/swoop/stats' + qs);
    var rows = await api('GET', '/swoop' + qs);
    _swoopStats = stats; _swoopRows = rows || []; _swoopPage = 1;
    if (initial) swoopPopulateEmployeeFilter(stats);
    swoopRenderStats(stats);
    swoopRenderTable(_swoopRows);
  } catch (e) {
    tableEl.innerHTML = '<div class="alert alert-error">' + escHtml((e && e.message) || 'Could not load Swoop surveys.') + '</div>';
  }
}

function swoopPopulateEmployeeFilter(stats) {
  var sel = document.getElementById('swoop-employee'); if (!sel) return;
  var keep = sel.value;
  var names = (stats.byEmployee || []).map(function (e) { return e.k; }).filter(function (k) { return k && k !== '(unassigned)'; });
  names.sort(function (a, b) { return String(a).localeCompare(String(b)); });
  sel.innerHTML = '<option value="">All employees</option>' + names.map(function (n) {
    return '<option value="' + escHtml(n) + '"' + (n === keep ? ' selected' : '') + '>' + escHtml(n) + '</option>';
  }).join('');
}

function swoopNpsColor(n) {
  if (n == null || isNaN(n)) return 'var(--text-muted-color)';
  return n >= 50 ? '#4f9d69' : (n >= 0 ? '#c9a13b' : '#cf5a52');
}
function swoopNpsText(n) {
  if (n == null || isNaN(n)) return 'n/a';
  var r = Math.round(Number(n));
  return (r > 0 ? '+' : '') + r;
}

function swoopRenderStats(s) {
  var el = document.getElementById('swoop-stats'); if (!el || !s) return;
  var t = s.total || {};
  var b = s.bands || { detractorMax: 5, passiveMax: 8 };
  var bandNote = '0-' + b.detractorMax + ' = -100 · ' + (b.detractorMax + 1) + '-' + b.passiveMax + ' = 0 · ' + (b.passiveMax + 1) + '-10 = 100';
  var cards =
    geicoStatCard('Total Surveys', t.n || 0, (t.scored || 0) + ' with a score') +
    geicoStatCard('NPS', swoopNpsText(t.nps), bandNote, swoopNpsColor(t.nps)) +
    geicoStatCard('Promoters', t.promoters || 0, 'NPS 100', '#4f9d69') +
    geicoStatCard('Passives', t.passives || 0, 'NPS 0', '#c9a13b') +
    geicoStatCard('Detractors', t.detractors || 0, 'NPS -100 · complaint at ' + s.complaintMaxScore + ' or below', '#cf5a52') +
    geicoStatCard('Verified', (t.verified || 0) + ' of ' + (t.n || 0), 'jobs with a confirmed technician');
  var cityCards = (s.byCity || []).map(function (c) {
    var tip = c.k + ': NPS ' + swoopNpsText(c.nps) + ' over ' + c.scored + ' scored survey' + (c.scored === 1 ? '' : 's');
    return '<div class="card" style="padding:16px;min-width:150px;flex:0 0 auto;text-align:center" title="' + escHtml(tip) + '">' +
      '<div style="font-size:13px;color:var(--text-muted-color)">' + (c.n || 0) + ' survey' + (c.n === 1 ? '' : 's') + '</div>' +
      '<div style="font-size:32px;font-weight:800;color:' + swoopNpsColor(c.nps) + ';line-height:1.1;margin:2px 0 4px">' + escHtml(swoopNpsText(c.nps)) + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted-color);margin-bottom:8px">NPS</div>' +
      '<div style="font-size:13px;color:var(--text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px">' + escHtml(c.k) + '</div>' +
    '</div>';
  }).join('') || '<div style="color:var(--text-muted-color);font-size:13px">No surveys in this range.</div>';
  el.innerHTML =
    '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px">' + cards + '</div>' +
    '<div class="card" style="padding:16px"><div style="font-size:12px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px">By City</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:12px">' + cityCards + '</div></div>';
  swoopRenderEmployeeTable(s);
}

function swoopRenderEmployeeTable(s) {
  var el = document.getElementById('swoop-employee-wrap'); if (!el) return;
  var emps = (s.byEmployee || []).slice();
  emps.sort(function (a, b) {
    if (a.k === '(unassigned)') return 1;
    if (b.k === '(unassigned)') return -1;
    return (Number(b.nps) - Number(a.nps)) || (b.n - a.n);
  });
  if (!emps.length) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<div class="card"><div style="padding:14px 16px 0;font-size:12px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:0.5px">By Employee</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Employee</th><th style="text-align:right">Surveys</th><th style="text-align:right">NPS</th>' +
      '<th style="text-align:right">Promoters</th><th style="text-align:right">Passives</th><th style="text-align:right">Detractors</th><th style="text-align:right">Verified</th></tr></thead><tbody>' +
    emps.map(function (e) {
      var unver = (e.n || 0) - (e.verified || 0);
      return '<tr><td>' + escHtml(e.k) + '</td>' +
        '<td style="text-align:right">' + (e.n || 0) + '</td>' +
        '<td style="text-align:right;font-weight:700;color:' + swoopNpsColor(e.nps) + '">' + escHtml(swoopNpsText(e.nps)) + '</td>' +
        '<td style="text-align:right">' + (e.promoters || 0) + '</td>' +
        '<td style="text-align:right">' + (e.passives || 0) + '</td>' +
        '<td style="text-align:right">' + (e.detractors || 0) + '</td>' +
        '<td style="text-align:right">' + (e.verified || 0) + (unver > 0 && e.k !== '(unassigned)' ? ' <span style="color:#c9a13b" title="Credited from Swoop&#39;s driver name, not yet verified">(' + unver + ' unverified)</span>' : '') + '</td></tr>';
    }).join('') +
    '</tbody></table></div></div>';
}

function swoopScoreBadge(r) {
  if (r.score == null) return '<span style="color:var(--text-muted-color)">—</span>';
  var c = swoopNpsColor(r.nps);
  return '<span style="display:inline-block;min-width:28px;text-align:center;padding:2px 8px;border-radius:10px;font-weight:700;border:1px solid ' + c + ';color:' + c + '">' + escHtml(String(r.score)) + '</span>';
}

function swoopEmployeeCell(r) {
  var verified = r.employee_source === 'import' || r.employee_source === 'manual';
  var sel = r.employee_user_id ? String(r.employee_user_id) : '';
  var act = '', former = '';
  for (var i = 0; i < _swoopEmployees.length; i++) {
    var u = _swoopEmployees[i];
    var opt = '<option value="' + u.id + '"' + (sel === String(u.id) ? ' selected' : '') + '>' + escHtml(u.name || '') + '</option>';
    if (u.active) act += opt; else former += opt;
  }
  // An imported name nobody on the roster matched stays visible, selected.
  var raw = (!sel && r.employee_name) ? '<option value="__raw__" selected>' + escHtml(r.employee_name) + ' (imported)</option>' : '';
  var st = 'padding:4px 6px;background:var(--surface-color);border:1px solid ' + (verified ? 'rgba(79,157,105,0.6)' : 'rgba(201,161,59,0.6)') + ';border-radius:6px;color:var(--text-color);font-size:12px;max-width:180px';
  var badge = verified
    ? '<div style="font-size:10px;color:#4f9d69">Verified</div>'
    : (r.employee_user_id ? '<div style="font-size:10px;color:#c9a13b">From Swoop driver, not verified</div>' : '<div style="font-size:10px;color:var(--text-muted-color)">Not verified</div>');
  return '<select style="' + st + '" onchange="swoopAssignEmployee(&#39;' + escHtml(String(r.job_id)) + '&#39;, this.value, this)">' +
    raw + '<option value=""' + ((!sel && !raw) ? ' selected' : '') + '>Unassigned</option>' + act +
    (former ? '<optgroup label="Former">' + former + '</optgroup>' : '') + '</select>' + badge;
}

async function swoopAssignEmployee(jobId, value, selEl) {
  if (value === '__raw__') return;
  var userId = value ? parseInt(value, 10) : null;
  if (selEl) selEl.disabled = true;
  try {
    var r = await api('PUT', '/swoop/assign-employee', { job_id: jobId, user_id: userId });
    for (var i = 0; i < _swoopRows.length; i++) {
      if (String(_swoopRows[i].job_id) === String(jobId)) {
        _swoopRows[i].employee_name = r.employee_name || null;
        _swoopRows[i].employee_user_id = r.employee_user_id || null;
        _swoopRows[i].employee_source = r.employee_source || null;
        break;
      }
    }
    swoopRenderTable(_swoopRows);
    showToast(r.employee_name ? ('Verified: ' + r.employee_name + '.') : 'Employee cleared.', 'success');
    swoopRefreshStats();
  } catch (e) {
    if (selEl) { selEl.disabled = false; selEl.style.borderColor = '#dc2626'; }
    showToast((e && e.message) ? e.message : 'Could not save that employee.', 'error');
  }
}

// Repaint the cards without resetting the table page.
async function swoopRefreshStats() {
  try {
    var stats = await api('GET', '/swoop/stats' + swoopQS());
    _swoopStats = stats;
    swoopRenderStats(stats);
    var esel = document.getElementById('swoop-employee');
    if (esel && !esel.value) swoopPopulateEmployeeFilter(stats);
  } catch (e) { /* the table already shows the truth */ }
}

async function swoopFileComplaint(jobId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Filing...'; }
  try {
    var r = await api('POST', '/swoop/file-complaint', { job_id: jobId });
    for (var i = 0; i < _swoopRows.length; i++) {
      if (String(_swoopRows[i].job_id) === String(jobId)) {
        _swoopRows[i].complaint_id = r.id;
        if (!_swoopRows[i].complaint_status) _swoopRows[i].complaint_status = 'new';
        break;
      }
    }
    swoopRenderTable(_swoopRows);
    showToast(r.duplicate ? ('That survey is already complaint #' + r.id + '.') : ('Complaint #' + r.id + ' filed and assigned.'), r.duplicate ? 'info' : 'success');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'File'; }
    showToast((e && e.message) || 'Could not file the complaint.', 'error');
  }
}

async function swoopCheckNow(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
  try {
    var r = await api('POST', '/swoop/check-now', {});
    var msg = r.mailboxOk
      ? ('Read ' + r.fetched + ' Swoop email' + (r.fetched === 1 ? '' : 's') + ', ' + r.inserted + ' new.')
      : 'Could not read the mailbox (see the server log).';
    if (r.filed) msg += ' Filed ' + r.filed + ' complaint' + (r.filed === 1 ? '' : 's') + '.';
    showToast(msg, r.mailboxOk ? 'success' : 'error');
    swoopLoad();
  } catch (e) {
    showToast((e && e.message) || 'Check failed.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check mail now'; }
  }
}

function swoopPaginate(p) { _swoopPage = p; swoopRenderTable(_swoopRows); }
function swoopPageSize(v) { SWOOP_PAGE_SIZE = parsePageSize(v); _swoopPage = 1; swoopRenderTable(_swoopRows); }

function swoopRenderTable(rows) {
  var wrap = document.getElementById('swoop-table-wrap'); if (!wrap) return;
  var canFile = can('manage_feedback');
  var canOpen = can('view_feedback');
  var total = rows.length;
  var totalPages = Math.max(1, Math.ceil(total / SWOOP_PAGE_SIZE));
  if (_swoopPage > totalPages) _swoopPage = totalPages;
  if (_swoopPage < 1) _swoopPage = 1;
  var start = (_swoopPage - 1) * SWOOP_PAGE_SIZE;
  var page = rows.slice(start, start + SWOOP_PAGE_SIZE);
  var showing = total === 0 ? '0' : ((start + 1) + '-' + Math.min(start + SWOOP_PAGE_SIZE, total));
  var btns = '';
  if (totalPages > 1) {
    for (var i = 1; i <= totalPages; i++) btns += '<button class="btn btn-sm ' + (i === _swoopPage ? 'btn-primary' : 'btn-secondary') + '" onclick="swoopPaginate(' + i + ')">' + i + '</button> ';
    btns = '<button class="btn btn-secondary btn-sm" onclick="swoopPaginate(' + (_swoopPage - 1) + ')" ' + (_swoopPage === 1 ? 'disabled' : '') + '>&lsaquo;</button> ' + btns +
      '<button class="btn btn-secondary btn-sm" onclick="swoopPaginate(' + (_swoopPage + 1) + ')" ' + (_swoopPage === totalPages ? 'disabled' : '') + '>&rsaquo;</button>';
  }
  var pager = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px">' + pageSizeControl(SWOOP_PAGE_SIZE, 'swoopPageSize') + btns + '</div>';
  wrap.innerHTML =
    '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:8px">Showing ' + showing + ' of ' + total + ' survey' + (total === 1 ? '' : 's') + '</div>' +
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>Received</th><th>Job ID</th><th>City</th><th style="text-align:center">Score</th><th style="text-align:right">NPS</th>' +
      '<th>Feedback</th><th>Customer</th><th>Swoop Driver</th><th>Employee</th><th style="text-align:center">Complaint</th></tr></thead><tbody>' +
    (total === 0
      ? '<tr><td colspan="10" style="text-align:center;color:var(--text-muted-color);padding:32px">No Swoop surveys found.</td></tr>'
      : page.map(function (r) {
          var cmp;
          if (r.complaint_id) {
            var stLine = r.complaint_status ? '<div style="font-size:10px;color:var(--text-muted-color)">' + escHtml(FB_STATUS[r.complaint_status] || r.complaint_status) + '</div>' : '';
            cmp = (canOpen
              ? '<a href="#" onclick="feedbackOpen(' + r.complaint_id + ');return false" style="color:var(--primary);font-weight:600;text-decoration:none">#' + r.complaint_id + '</a>'
              : '<span style="font-weight:600">#' + r.complaint_id + '</span>') + stLine;
          } else if (canFile && r.job_id) {
            cmp = '<button class="btn btn-secondary btn-sm" title="Open a complaint for this survey" onclick="swoopFileComplaint(&#39;' + escHtml(String(r.job_id)) + '&#39;, this)">File</button>';
          } else {
            cmp = '<span style="color:var(--text-muted-color)">—</span>';
          }
          var fb = r.feedback ? String(r.feedback) : '';
          var fbCell = fb
            ? '<div style="max-width:260px;white-space:normal;font-size:12px" title="' + escHtml(fb) + '">' + escHtml(fb.length > 140 ? fb.slice(0, 140) + '…' : fb) + '</div>'
            : '<span style="color:var(--text-muted-color)">—</span>';
          var cust = escHtml(r.pickup_contact || '—') + (r.pickup_phone ? '<div style="font-size:11px;color:var(--text-muted-color)">' + escHtml(r.pickup_phone) + '</div>' : '');
          return '<tr>' +
            '<td style="white-space:nowrap">' + escHtml(r.date_received || '—') + '</td>' +
            '<td>' + escHtml(r.job_id || '—') + '</td>' +
            '<td>' + escHtml(r.city_name || '—') + '</td>' +
            '<td style="text-align:center">' + swoopScoreBadge(r) + '</td>' +
            '<td style="text-align:right;font-weight:700;color:' + swoopNpsColor(r.nps) + '">' + (r.nps == null ? '—' : escHtml(swoopNpsText(r.nps))) + '</td>' +
            '<td>' + fbCell + '</td>' +
            '<td style="white-space:nowrap">' + cust + '</td>' +
            '<td>' + escHtml(r.driver_raw || '—') + '</td>' +
            '<td>' + swoopEmployeeCell(r) + '</td>' +
            '<td style="white-space:nowrap;text-align:center">' + cmp + '</td>' +
          '</tr>';
        }).join('')) +
    '</tbody></table></div></div>' + pager;
}

function swoopExportCSV() {
  var rows = _swoopRows || [];
  if (!rows.length) { novaAlert('Nothing to export with the current filters.'); return; }
  var header = ['Received', 'Job ID', 'City', 'Score', 'NPS', 'Feedback', 'Customer', 'Customer Phone', 'Swoop Driver', 'Employee', 'Verified', 'Complaint #'];
  var lines = [header.map(csvCell).join(',')];
  rows.forEach(function (r) {
    lines.push([
      r.date_received || '', r.job_id || '', r.city_name || '', r.score == null ? '' : r.score, r.nps == null ? '' : r.nps,
      r.feedback || '', r.pickup_contact || '', r.pickup_phone || '', r.driver_raw || '', r.employee_name || '',
      (r.employee_source === 'import' || r.employee_source === 'manual') ? 'Yes' : 'No', r.complaint_id || ''
    ].map(csvCell).join(','));
  });
  var blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'swoop-surveys-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function swoopDownloadSample() {
  var csv = 'Job ID,Employee\r\n' +
    '115320408,Jesse Beardshear\r\n' +
    '115320511,"Benson, Chris"\r\n';
  var blob = new Blob([csv], { type: 'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'swoop-verification-sample.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function swoopOnCsvChosen(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function (e) { input.value = ''; swoopHandleCsv(e.target.result); };
  reader.readAsText(file);
}

// Parse the verification CSV into [{ job_id, employee_name }]. Pure, so it can
// be tested without a browser.
function swoopParseVerificationCsv(text) {
  var grid = parsePartsCSV(text);
  if (grid.length < 2) return { error: 'That CSV looks empty. Use the Verification Sample CSV as your template.' };
  var header = grid[0].map(function (h) { return String(h || '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s#]+/g, '_').replace(/^_+|_+$/g, ''); });
  function colIdx(names) { for (var n = 0; n < names.length; n++) { var k = header.indexOf(names[n]); if (k !== -1) return k; } return -1; }
  var ji = colIdx(['job_id', 'job', 'id', 'swoop_id', 'swoop_job_id', 'job_number', 'po', 'po_number']);
  var ei = colIdx(['employee', 'employee_name', 'tech', 'technician', 'tech_id', 'driver', 'name']);
  if (ji === -1) return { error: 'Could not find a "Job ID" column in that CSV. Use the Verification Sample CSV as your template.' };
  if (ei === -1) return { error: 'Could not find an "Employee" column in that CSV. Use the Verification Sample CSV as your template.' };
  var rows = [];
  for (var i = 1; i < grid.length; i++) {
    var job = String(grid[i][ji] || '').replace(/^#/, '').trim();
    var emp = String(grid[i][ei] || '').trim();
    if (job && emp) rows.push({ job_id: job, employee_name: emp });
  }
  if (!rows.length) return { error: 'No rows had both a Job ID and an Employee name.' };
  return { rows: rows };
}

async function swoopHandleCsv(text) {
  var parsed = swoopParseVerificationCsv(text);
  if (parsed.error) { novaAlert(parsed.error); return; }
  var rows = parsed.rows;
  if (!await novaConfirm('Verify the technician on ' + rows.length + ' Swoop job' + (rows.length === 1 ? '' : 's') + '?')) return;
  try {
    var resp = await api('POST', '/swoop/import-employees', { rows: rows });
    var msg = 'Verified ' + resp.updated + ' survey' + (resp.updated === 1 ? '' : 's') + '.';
    msg += '\nMatched ' + resp.matched + ' to a Nova user.';
    if (resp.unmatched) msg += '\n' + resp.unmatched + ' name(s) matched nobody on the roster and were kept as plain text.';
    if (resp.unmatchedNames && resp.unmatchedNames.length) msg += '\nUnmatched: ' + resp.unmatchedNames.join(', ') + '.';
    if (resp.manualKept) msg += '\nLeft ' + resp.manualKept + ' row(s) alone because an employee was picked by hand there.';
    if (resp.skipped) msg += '\nSkipped ' + resp.skipped + ' row(s) with a missing Job ID or name.';
    if (resp.notFound) { msg += '\n' + resp.notFound + ' Job ID(s) were not found'; if (resp.notFoundList && resp.notFoundList.length) msg += ': ' + resp.notFoundList.join(', '); msg += '.'; }
    novaAlert(msg);
    swoopLoad(true);
  } catch (e) {
    novaAlert('Import failed: ' + (e && e.message ? e.message : e));
  }
}
