/* Nova - Weekly Revenue Report
 * ---------------------------------------------------------------------------
 * Revenue by service class, per location, week over week, built from the
 * CallSearch export. Three tabs: the report, the CSV drop that feeds it, and
 * the settings for the Monday email.
 *
 * The charts here are inline SVG drawn from the same /revenue/report payload
 * the PDF is drawn from. They are not a separate calculation and they must
 * never become one - if the screen and the PDF ever disagree about a figure,
 * nobody trusts either.
 *
 * Like every chart in the PDF, each one is scaled to ITS OWN service class.
 * Battery is a few percent of revenue and vanishes on a shared axis. The cost
 * is that heights are not comparable between the three charts, which the page
 * says out loud rather than leaving a reader to discover.
 *
 * House style (CLAUDE.md): string concatenation, no backticks, and &#39; for
 * an apostrophe inside an HTML string.
 * --------------------------------------------------------------------------- */

var _revTab = 'report';          // report | import | settings
var _revMeta = null;             // /revenue/meta
var _revReport = null;           // /revenue/report
var _revPage = 'company';        // 'company' or a location name
var _revEnd = '';                // ISO Monday, '' = latest complete week
var _revPreview = null;          // parsed /revenue/preview result
var _revCsv = null;              // { text, filename } waiting to be imported

var REV_COLOR = { roadside: '#1baf7a', battery: '#eb6834', locksmith: '#2a78d6', total: '#1a1a19' };
var REV_CLASSES = ['roadside', 'battery', 'locksmith'];
var REV_LABEL = { roadside: 'Roadside', battery: 'Battery', locksmith: 'Locksmith' };
var REV_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function revInjectStyles() {
  if (document.getElementById('rev-styles')) return;
  var css =
    '.rev-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap}' +
    '.rev-tab{padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-muted-color)}' +
    '.rev-tab.on{color:var(--primary);border-bottom-color:var(--primary)}' +
    '.rev-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:18px}' +
    '.rev-card{background:var(--card-bg,rgba(127,127,127,.06));border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;border-left-width:4px;border-left-style:solid}' +
    '.rev-card.total{background:rgba(127,127,127,.13)}' +
    '.rev-card .k{font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted-color)}' +
    '.rev-card .v{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:4px}' +
    '.rev-card .s{font-size:11.5px;color:var(--text-muted-color);margin-top:5px;line-height:1.5}' +
    '.rev-up{color:#16a06a;font-weight:700}.rev-down{color:#e2563a;font-weight:700}.rev-flat{color:var(--text-muted-color);font-weight:700}' +
    '.rev-chart{margin-bottom:14px}' +
    '.rev-chart h4{font-size:13px;font-weight:700;margin:0 0 2px}' +
    '.rev-chart .cap{font-size:11px;color:var(--text-muted-color);margin-bottom:6px}' +
    '.rev-num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.rev-pick{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}' +
    '.rev-pick button{padding:6px 12px;font-size:12.5px;font-weight:600;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--text-muted-color);cursor:pointer}' +
    '.rev-pick button.on{background:var(--primary);border-color:var(--primary);color:#fff}' +
    '.rev-note{font-size:12px;color:var(--text-muted-color);line-height:1.65;border-top:1px solid var(--border);padding-top:12px;margin-top:18px}' +
    '.rev-warn{background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.35);border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.rev-good{background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.3);border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.rev-drop{border:2px dashed var(--border);border-radius:var(--radius);padding:26px;text-align:center;font-size:13.5px;color:var(--text-muted-color)}' +
    '.rev-kv{display:grid;grid-template-columns:200px 1fr;gap:8px 16px;font-size:13.5px;align-items:center;max-width:620px}' +
    '.rev-kv .lbl{color:var(--text-muted-color)}';
  var st = document.createElement('style');
  st.id = 'rev-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

/* ------------------------------------------------------------ formatting */

function revMoney(n, cents) {
  var v = Number(n || 0);
  var s = Math.abs(v).toFixed(cents ? 2 : 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-$' : '$') + s;
}

function revDelta(p) {
  if (p === null || p === undefined || !isFinite(p)) return '<span class="rev-flat">n/a</span>';
  var v = Math.round(p * 10) / 10;
  var cls = v > 0.05 ? 'rev-up' : (v < -0.05 ? 'rev-down' : 'rev-flat');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
}

function revParts(ymd) {
  var p = String(ymd || '').split('-');
  return { y: parseInt(p[0], 10), m: parseInt(p[1], 10), d: parseInt(p[2], 10) };
}
function revShort(ymd) {
  var p = revParts(ymd);
  if (!p.m) return '';
  return REV_MONTHS[p.m - 1] + ' ' + p.d;
}
function revAddDays(ymd, n) {
  var p = revParts(ymd);
  var d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function revWeekLabel(monday) {
  if (!monday) return '';
  return revShort(monday) + ' - ' + revShort(revAddDays(monday, 6)) + ', ' + revParts(monday).y;
}

/* ---------------------------------------------------------------- loading */

async function renderRevenue(content) {
  revInjectStyles();
  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Weekly Revenue</div>' +
      '<div class="page-subtitle">Revenue by service class, per location, week over week.</div></div>' +
      '<div class="flex-gap" id="rev-actions"></div></div>' +
    '<div class="rev-tabs">' +
      '<div class="rev-tab' + (_revTab === 'report' ? ' on' : '') + '" onclick="revGo(\'report\')">Report</div>' +
      (can('manage_revenue')
        ? '<div class="rev-tab' + (_revTab === 'import' ? ' on' : '') + '" onclick="revGo(\'import\')">Import</div>' +
          '<div class="rev-tab' + (_revTab === 'settings' ? ' on' : '') + '" onclick="revGo(\'settings\')">Settings</div>'
        : '') +
    '</div>' +
    '<div id="rev-body"><div class="loading">Loading…</div></div>';

  try { _revMeta = await api('GET', '/revenue/meta'); }
  catch (e) {
    document.getElementById('rev-body').innerHTML =
      '<div class="rev-warn">Could not load the revenue history: ' + escHtml(e.message || 'unknown error') + '</div>';
    return;
  }
  await revDraw();
}

function revGo(tab) {
  _revTab = tab;
  renderRevenue(document.getElementById('content') || document.querySelector('.content'));
}

async function revDraw() {
  var body = document.getElementById('rev-body');
  if (!body) return;
  if (_revTab === 'import') return revDrawImport(body);
  if (_revTab === 'settings') return revDrawSettings(body);
  return revDrawReport(body);
}

// The banner every tab shows: how much history is in Nova and whether it is
// old enough to be lying to you.
function revHistoryBanner() {
  var h = (_revMeta && _revMeta.history) || {};
  if (!h.calls) {
    return '<div class="rev-warn"><strong>No history yet.</strong> ' +
      'Import a CallSearch export on the Import tab and the report builds itself.</div>';
  }
  var stale = false, age = 0;
  if (h.last_date && _revMeta.today) {
    age = Math.round((new Date(_revMeta.today + 'T00:00:00Z') - new Date(h.last_date + 'T00:00:00Z')) / 86400000);
    stale = age > ((_revMeta.settings && _revMeta.settings.staleDays) || 10);
  }
  var line = h.calls.toLocaleString() + ' calls, ' + revMoney(h.revenue) + ' across ' +
    h.weeks + ' weeks and ' + h.locations + ' locations. Newest call: ' + escHtml(h.last_date || '-') + '.';
  if (stale) {
    return '<div class="rev-warn"><strong>This data is ' + age + ' days old.</strong> ' + line +
      ' Drop a fresh export on the Import tab before anyone reads these figures.</div>';
  }
  return '<div class="rev-good">' + line + '</div>';
}

/* ----------------------------------------------------------------- report */

async function revDrawReport(body) {
  body.innerHTML = revHistoryBanner() + '<div class="loading">Building the report…</div>';
  var qs = '/revenue/report' + (_revEnd ? '?end=' + encodeURIComponent(_revEnd) : '');
  try { _revReport = await api('GET', qs); }
  catch (e) {
    body.innerHTML = revHistoryBanner() +
      '<div class="rev-warn">Could not build the report: ' + escHtml(e.message || 'unknown error') + '</div>';
    return;
  }

  var r = _revReport;
  var acts = document.getElementById('rev-actions');
  if (acts) {
    acts.innerHTML =
      '<button class="btn btn-secondary btn-sm" onclick="revDownloadPdf()">Download PDF</button>' +
      (can('manage_revenue')
        ? '<button class="btn btn-primary btn-sm" onclick="revSendNow()">Email it</button>' : '');
  }

  if (!r.locations.length) {
    body.innerHTML = revHistoryBanner() +
      '<div class="rev-warn">There are no calls in the ' + r.window.count + ' weeks ending ' +
      escHtml(revWeekLabel(r.window.last)) + '. Import an export that covers this window, ' +
      'or pick an earlier week below.</div>' + revWeekPicker(r);
    return;
  }

  // Which page (company, or one location) the charts and table are showing.
  var names = r.locations.map(function (p) { return p.name; });
  if (_revPage !== 'company' && names.indexOf(_revPage) === -1) _revPage = 'company';
  var page = _revPage === 'company' ? r.company : r.locations[names.indexOf(_revPage)];

  body.innerHTML =
    revHistoryBanner() +
    revWeekPicker(r) +
    '<div class="rev-pick">' +
      '<button class="' + (_revPage === 'company' ? 'on' : '') + '" onclick="revPick(\'company\')">All Locations</button>' +
      names.map(function (n) {
        return '<button class="' + (_revPage === n ? 'on' : '') + '" onclick="revPick(' +
          JSON.stringify(n).replace(/"/g, '&quot;') + ')">' + escHtml(n) + '</button>';
      }).join('') +
    '</div>' +
    '<h3 style="margin:0 0 4px;font-size:16px">' + escHtml(page.name) + '</h3>' +
    '<div class="page-subtitle" style="margin-bottom:12px">Week of ' + escHtml(revWeekLabel(r.window.last)) +
      ' &middot; ' + r.window.count + '-week window</div>' +
    revCardsHtml(page) +
    REV_CLASSES.map(function (c) { return revChartHtml(page, c); }).join('') +
    revTableHtml(page) +
    (_revPage === 'company' ? revComparisonHtml(r) : '') +
    revMethodologyHtml(r);
}

function revWeekPicker(r) {
  var weeks = (_revMeta && _revMeta.weeks) || [];
  if (!weeks.length) return '';
  var opts = weeks.map(function (w) {
    return '<option value="' + escHtml(w.week_start) + '"' +
      (w.week_start === r.window.last ? ' selected' : '') + '>' +
      escHtml(revWeekLabel(w.week_start)) + '  (' + w.calls + ' calls)</option>';
  }).join('');
  return '<div class="rev-kv" style="margin-bottom:14px">' +
    '<span class="lbl">Report through week of</span>' +
    '<select id="rev-end" onchange="revSetEnd(this.value)" style="max-width:320px">' + opts + '</select>' +
    '</div>';
}

function revSetEnd(v) { _revEnd = v; revDraw(); }
function revPick(name) { _revPage = name; revDraw(); }

function revCardsHtml(page) {
  var order = REV_CLASSES.concat(['total']);
  return '<div class="rev-cards">' + order.map(function (key) {
    var c = page.cards[key];
    var label = key === 'total' ? 'Total Revenue' : REV_LABEL[key];
    return '<div class="rev-card' + (key === 'total' ? ' total' : '') + '" style="border-left-color:' + REV_COLOR[key] + '">' +
      '<div class="k">' + escHtml(label) + '</div>' +
      '<div class="v">' + revMoney(c.value) + '</div>' +
      '<div class="s">' + revDelta(c.d_prior) + ' vs prior week<br>' +
        revDelta(c.d_average) + ' vs ' + (c.average === null ? 'average' : revMoney(c.average) + ' avg') +
      '</div></div>';
  }).join('') + '</div>';
}

/*
 * One chart, inline SVG. Same rules as the PDF: a bar per week, scaled to this
 * class's own peak, every bar directly labelled.
 */
function revChartHtml(page, cls) {
  var rows = page.rows;
  var max = 0;
  rows.forEach(function (r) { if (r[cls] > max) max = r[cls]; });

  var W = 1000, H = 150, padTop = 16, padBottom = 20;
  var plot = H - padTop - padBottom;
  var gap = 8;
  var bw = (W - gap * (rows.length - 1)) / rows.length;

  var bars = rows.map(function (r, i) {
    var x = i * (bw + gap);
    var v = r[cls];
    var h = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * plot) : 0;
    var y = padTop + plot - h;
    var mid = x + bw / 2;
    var isLast = i === rows.length - 1;
    return (h > 0 ? '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + h.toFixed(1) + '" fill="' + REV_COLOR[cls] + '" rx="2"></rect>' : '') +
      '<text x="' + mid.toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="middle" ' +
        'font-size="11" font-weight="700" fill="currentColor">' + revMoney(v) + '</text>' +
      '<text x="' + mid.toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle" font-size="11" ' +
        'fill="currentColor" opacity="' + (isLast ? '1' : '.55') + '"' +
        (isLast ? ' font-weight="700"' : '') + '>' + escHtml(revShort(r.week_start)) + '</text>';
  }).join('');

  return '<div class="rev-chart">' +
    '<h4 style="color:' + REV_COLOR[cls] + '">' + escHtml(REV_LABEL[cls]) + '</h4>' +
    '<div class="cap">' + (max > 0
      ? 'scaled to this chart, peak ' + revMoney(max) + ' - heights are not comparable with the other two charts'
      : 'no revenue in this window') + '</div>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" ' +
      'preserveAspectRatio="none" role="img" aria-label="' + escHtml(REV_LABEL[cls]) + ' revenue by week">' +
      bars +
      '<line x1="0" y1="' + (padTop + plot) + '" x2="' + W + '" y2="' + (padTop + plot) +
        '" stroke="currentColor" stroke-opacity=".2" stroke-width="1"></line>' +
    '</svg></div>';
}

/*
 * The weekly table. No combined column and no total row, deliberately: this is
 * a week-over-week comparison WITHIN each service class, and the combined
 * figure lives on the Total Revenue card.
 */
function revTableHtml(page) {
  var head = '<tr><th>Week</th>' +
    REV_CLASSES.map(function (c) {
      return '<th class="rev-num" style="color:' + REV_COLOR[c] + '">' + escHtml(REV_LABEL[c]) + '</th>';
    }).join('') +
    '<th class="rev-num">Calls</th></tr>';

  var body = page.rows.slice().reverse().map(function (r) {
    return '<tr>' +
      '<td>' + escHtml(revShort(r.week_start)) + '</td>' +
      REV_CLASSES.map(function (c) {
        return '<td class="rev-num">' + revMoney(r[c]) +
          ' <span style="font-size:11.5px">' + revDelta(r['d_' + c]) + '</span></td>';
      }).join('') +
      '<td class="rev-num">' + r.calls + '</td></tr>';
  }).join('');

  return '<div class="table-container" style="margin-top:6px"><table><thead>' + head +
    '</thead><tbody>' + body + '</tbody></table></div>';
}

function revComparisonHtml(r) {
  var rows = r.locations.map(function (p) {
    return '<tr><td>' + escHtml(p.name) + '</td>' +
      REV_CLASSES.map(function (c) {
        return '<td class="rev-num">' + revMoney(p.cards[c].value) + '</td>';
      }).join('') +
      '<td class="rev-num"><strong>' + revMoney(p.cards.total.value) + '</strong></td>' +
      '<td class="rev-num">' + revDelta(p.cards.total.d_prior) + '</td></tr>';
  }).join('');
  var tot = '<tr style="border-top:2px solid var(--border)"><td><strong>All Locations</strong></td>' +
    REV_CLASSES.map(function (c) {
      return '<td class="rev-num"><strong>' + revMoney(r.company.cards[c].value) + '</strong></td>';
    }).join('') +
    '<td class="rev-num"><strong>' + revMoney(r.company.cards.total.value) + '</strong></td>' +
    '<td class="rev-num">' + revDelta(r.company.cards.total.d_prior) + '</td></tr>';

  return '<h3 style="margin:24px 0 8px;font-size:16px">Location comparison</h3>' +
    '<div class="page-subtitle" style="margin-bottom:10px">Week of ' + escHtml(revWeekLabel(r.window.last)) + '</div>' +
    '<div class="table-container"><table><thead><tr><th>Location</th>' +
      REV_CLASSES.map(function (c) {
        return '<th class="rev-num" style="color:' + REV_COLOR[c] + '">' + escHtml(REV_LABEL[c]) + '</th>';
      }).join('') +
      '<th class="rev-num">Total</th><th class="rev-num">WoW</th></tr></thead><tbody>' +
      rows + tot + '</tbody></table></div>';
}

function revMethodologyHtml(r) {
  return '<div class="rev-note"><strong>How these numbers are built.</strong> ' +
    'Revenue is Collected Cash + Check + CC + Account from the CallSearch export, dated by DT Complete, ' +
    'with weeks running Monday through Sunday. ' +
    '<strong>GOA calls count</strong> - a GOA that collected a trip fee collected real money. ' +
    'Each chart is scaled to its own class, so bar heights are not comparable between the three. ' +
    'The average on each card is taken over the weeks in this window before the latest one, counting ' +
    'only weeks with data. A task code is split on its dots: any <code>LS</code> segment makes it ' +
    'Locksmith, else any <code>Bat</code> segment makes it Battery, else Roadside - which puts ' +
    '<code>Pick</code> tasks in Roadside, because they carry no <code>.LS</code> suffix in CallSearch. ' +
    'Clearwater and Tampa report together as Suncoast. ' +
    'Figures restate as late payments post, so a prior week can move between runs.</div>';
}

/* --------------------------------------------------------------- download */

async function revDownloadPdf() {
  try {
    var qs = '/api/revenue/report.pdf' + (_revEnd ? '?end=' + encodeURIComponent(_revEnd) : '');
    var headers = {};
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    if (state.viewAsId) headers['X-View-As'] = String(state.viewAsId);
    var res = await fetch(qs, { headers: headers });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'nova-revenue-week-ending-' +
      (_revReport ? revAddDays(_revReport.window.last, 6) : new Date().toISOString().slice(0, 10)) + '.pdf';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast('Could not download the PDF: ' + (e.message || 'unknown error'), 'error');
  }
}

async function revSendNow() {
  var to = (_revMeta && _revMeta.settings && _revMeta.settings.recipients) || [];
  var who = to.length ? to.join(', ') : 'nobody - no recipients are configured';
  var go = await novaConfirm('Email this week&#39;s report to: ' + who + '?',
    { title: 'Send the revenue report', okText: 'Send it' });
  if (!go) return;
  try {
    var out = await api('POST', '/revenue/send', { end: _revEnd || null });
    if (out.sent) showToast('Sent to ' + out.recipients.length + ' recipient(s).', 'success');
    else showToast(out.error || 'The report was built but not sent.', 'error');
    _revMeta = await api('GET', '/revenue/meta');
  } catch (e) {
    showToast('Send failed: ' + (e.message || 'unknown error'), 'error');
  }
}

/* ----------------------------------------------------------------- import */

function revDrawImport(body) {
  var imports = (_revMeta && _revMeta.imports) || [];
  body.innerHTML =
    revHistoryBanner() +
    '<div class="rev-note" style="border-top:none;padding-top:0;margin-top:0;margin-bottom:14px">' +
      '<strong>Send a trailing 3 to 4 week export, not just the newest week.</strong> ' +
      'A call completed in one week can have its payment posted or corrected in the next. Nova matches on ' +
      'Call UID, so re-importing weeks you have already sent changes nothing except the rows that actually ' +
      'moved - which is how prior weeks restate themselves instead of freezing at whatever they were the ' +
      'day they were pulled.</div>' +
    '<div class="rev-drop" id="rev-drop">' +
      '<input type="file" id="rev-file" accept=".csv,text/csv" style="display:none" onchange="revFilePicked(this)">' +
      '<div style="font-weight:600;margin-bottom:6px">Drop the CallSearch CSV here</div>' +
      '<div style="margin-bottom:12px">or <a href="#" onclick="document.getElementById(\'rev-file\').click();return false">choose a file</a></div>' +
      '<div style="font-size:12px">Needs the columns DT Complete, Location, Task, Call UID and the four Collected columns.</div>' +
    '</div>' +
    '<div id="rev-preview" style="margin-top:16px"></div>' +
    (imports.length
      ? '<h3 style="margin:26px 0 8px;font-size:16px">Recent imports</h3>' +
        '<div class="table-container"><table><thead><tr><th>When</th><th>File</th><th>By</th>' +
        '<th>Covers</th><th class="rev-num">Rows</th><th class="rev-num">New</th>' +
        '<th class="rev-num">Updated</th><th class="rev-num">Corrections</th>' +
        '<th class="rev-num">Revenue</th></tr></thead><tbody>' +
        imports.map(function (i) {
          return '<tr><td>' + escHtml(String(i.created_at).slice(0, 10)) + '</td>' +
            '<td>' + escHtml(i.filename || '-') + '</td>' +
            '<td>' + escHtml(i.uploaded_by_name || '-') + '</td>' +
            '<td>' + escHtml(String(i.first_date || '').slice(0, 10)) + ' to ' +
              escHtml(String(i.last_date || '').slice(0, 10)) + '</td>' +
            '<td class="rev-num">' + (i.kept_rows || 0) + '</td>' +
            '<td class="rev-num">' + (i.inserted_rows || 0) + '</td>' +
            '<td class="rev-num">' + (i.updated_rows || 0) + '</td>' +
            '<td class="rev-num">' + (i.changed_rows || 0) + '</td>' +
            '<td class="rev-num">' + revMoney(i.revenue_total) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '');

  var drop = document.getElementById('rev-drop');
  if (drop) {
    drop.ondragover = function (e) { e.preventDefault(); drop.style.borderColor = 'var(--primary)'; };
    drop.ondragleave = function () { drop.style.borderColor = ''; };
    drop.ondrop = function (e) {
      e.preventDefault();
      drop.style.borderColor = '';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) revReadFile(e.dataTransfer.files[0]);
    };
  }
}

function revFilePicked(input) {
  if (input.files && input.files[0]) revReadFile(input.files[0]);
}

function revReadFile(file) {
  var reader = new FileReader();
  reader.onload = function () {
    _revCsv = { text: String(reader.result || ''), filename: file.name };
    revRunPreview();
  };
  reader.onerror = function () { showToast('Could not read that file.', 'error'); };
  reader.readAsText(file);
}

async function revRunPreview() {
  var box = document.getElementById('rev-preview');
  if (!box || !_revCsv) return;
  box.innerHTML = '<div class="loading">Reading ' + escHtml(_revCsv.filename) + '…</div>';
  try {
    _revPreview = await api('POST', '/revenue/preview', { csv: _revCsv.text, filename: _revCsv.filename });
  } catch (e) {
    _revPreview = null;
    box.innerHTML = '<div class="rev-warn">' + escHtml(e.message || 'Could not read that file.') + '</div>';
    return;
  }
  var p = _revPreview;
  var d = p.diff;
  var skipped = p.meta.skipped || {};
  var skipNote = [];
  if (skipped.noUid) skipNote.push(skipped.noUid + ' with no Call UID');
  if (skipped.noDate) skipNote.push(skipped.noDate + ' with no usable date');
  if (skipped.noLocation) skipNote.push(skipped.noLocation + ' with no Location');
  if (skipped.duplicateUid) skipNote.push(skipped.duplicateUid + ' repeated inside the file');

  box.innerHTML =
    '<h3 style="margin:0 0 8px;font-size:16px">' + escHtml(_revCsv.filename) + '</h3>' +
    '<div class="rev-cards">' +
      '<div class="rev-card" style="border-left-color:#1baf7a"><div class="k">New calls</div>' +
        '<div class="v">' + d.new + '</div><div class="s">not in Nova yet</div></div>' +
      '<div class="rev-card" style="border-left-color:#eb6834"><div class="k">Changed</div>' +
        '<div class="v">' + d.changed + '</div><div class="s">already here, figures moved</div></div>' +
      '<div class="rev-card" style="border-left-color:#8a8a88"><div class="k">Unchanged</div>' +
        '<div class="v">' + d.unchanged + '</div><div class="s">already here, identical</div></div>' +
      '<div class="rev-card total" style="border-left-color:#1a1a19"><div class="k">Revenue in file</div>' +
        '<div class="v">' + revMoney(d.revenue_total) + '</div>' +
        '<div class="s">' + (d.revenue_delta >= 0 ? '+' : '') + revMoney(d.revenue_delta) +
        ' net change to the history</div></div>' +
    '</div>' +
    (skipNote.length
      ? '<div class="rev-warn">Skipped ' + escHtml(skipNote.join(', ')) + '. Everything else imports.</div>'
      : '') +
    '<div class="table-container" style="margin-bottom:14px"><table><thead><tr><th>Week</th>' +
      '<th class="rev-num">Calls</th><th class="rev-num">Revenue</th></tr></thead><tbody>' +
      p.weeks.map(function (w) {
        return '<tr><td>' + escHtml(revWeekLabel(w.week_start)) + '</td>' +
          '<td class="rev-num">' + w.calls + '</td>' +
          '<td class="rev-num">' + revMoney(w.revenue) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
    '<div class="table-container" style="margin-bottom:14px"><table><thead><tr>' +
      '<th>Location in the file</th><th>Reported as</th><th class="rev-num">Calls</th>' +
      '</tr></thead><tbody>' +
      p.locations.map(function (l) {
        return '<tr><td>' + escHtml(l.location_raw) + '</td>' +
          '<td>' + escHtml(l.location) +
          (l.location !== l.location_raw ? ' <span style="font-size:11px;color:var(--text-muted-color)">(consolidated)</span>' : '') +
          '</td><td class="rev-num">' + l.calls + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
    '<div class="flex-gap">' +
      '<button class="btn btn-primary" id="rev-commit" onclick="revCommit()">Import ' +
        p.meta.keptRows + ' calls</button>' +
      '<button class="btn btn-secondary" onclick="revCancelImport()">Cancel</button>' +
    '</div>';
}

function revCancelImport() {
  _revCsv = null;
  _revPreview = null;
  var box = document.getElementById('rev-preview');
  if (box) box.innerHTML = '';
}

async function revCommit() {
  if (!_revCsv) return;
  var btn = document.getElementById('rev-commit');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  try {
    var out = await api('POST', '/revenue/import', { csv: _revCsv.text, filename: _revCsv.filename });
    showToast(out.inserted + ' new, ' + out.updated + ' updated (' + out.payment_corrections +
      ' with figures that moved).', 'success');
    _revCsv = null;
    _revPreview = null;
    _revMeta = await api('GET', '/revenue/meta');
    _revEnd = '';
    _revTab = 'report';
    renderRevenue(document.getElementById('content') || document.querySelector('.content'));
  } catch (e) {
    showToast('Import failed: ' + (e.message || 'unknown error'), 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Retry import'; }
  }
}

/* --------------------------------------------------------------- settings */

function revDrawSettings(body) {
  var s = (_revMeta && _revMeta.settings) || {};
  var runs = (_revMeta && _revMeta.runs) || [];
  var map = s.locationMap || {};
  body.innerHTML =
    '<div class="rev-kv" style="margin-bottom:18px">' +
      '<span class="lbl">Monday email</span>' +
      '<label><input type="checkbox" id="rev-enabled"' + (s.enabled ? ' checked' : '') + '> ' +
        'Send the report automatically, Mondays at 7:30am ET</label>' +

      '<span class="lbl">Recipients</span>' +
      '<textarea id="rev-recipients" rows="3" style="width:100%" ' +
        'placeholder="one address per line, or comma separated">' +
        escHtml((s.recipients || []).join('\n')) + '</textarea>' +

      '<span class="lbl">Weeks in the window</span>' +
      '<input type="number" id="rev-weeks" min="2" max="52" value="' + (s.weeks || 12) + '" style="max-width:120px">' +

      '<span class="lbl">Warn when data is older than</span>' +
      '<span><input type="number" id="rev-stale" min="1" max="120" value="' + (s.staleDays || 10) +
        '" style="max-width:120px"> days</span>' +

      '<span class="lbl">Consolidated locations</span>' +
      '<textarea id="rev-map" rows="4" style="width:100%" ' +
        'placeholder="clearwater = Suncoast">' +
        escHtml(Object.keys(map).map(function (k) { return k + ' = ' + map[k]; }).join('\n')) +
      '</textarea>' +
    '</div>' +
    '<div class="rev-note" style="border-top:none;padding-top:0;margin-top:0;margin-bottom:16px">' +
      'Consolidation is one rule per line, <code>source name = reported as</code>. It is applied when the ' +
      'numbers are added up, not when they are stored, so changing it re-reports the whole history ' +
      'immediately and nothing needs re-importing.</div>' +
    '<div class="flex-gap" style="margin-bottom:24px">' +
      '<button class="btn btn-primary" onclick="revSaveSettings()">Save</button>' +
      '<button class="btn btn-secondary" onclick="revTestSend()">Send a test to me</button>' +
    '</div>' +
    (runs.length
      ? '<h3 style="margin:0 0 8px;font-size:16px">Recent sends</h3>' +
        '<div class="table-container"><table><thead><tr><th>When</th><th>Week ending</th>' +
        '<th>Recipients</th><th>Trigger</th><th class="rev-num">Total</th><th>Result</th>' +
        '</tr></thead><tbody>' +
        runs.map(function (r) {
          return '<tr><td>' + escHtml(String(r.created_at).slice(0, 16).replace('T', ' ')) + '</td>' +
            '<td>' + escHtml(String(r.week_end).slice(0, 10)) + '</td>' +
            '<td style="font-size:12px">' + escHtml(r.recipients || '-') + '</td>' +
            '<td>' + escHtml(r.triggered_by || '') + '</td>' +
            '<td class="rev-num">' + revMoney(r.revenue_total) + '</td>' +
            '<td>' + (r.ok ? '<span class="rev-up">sent</span>'
              : '<span class="rev-down">' + escHtml(r.error || 'failed') + '</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '');
}

function revReadMap() {
  var raw = (document.getElementById('rev-map') || {}).value || '';
  var out = {};
  raw.split(/[\r\n]+/).forEach(function (line) {
    var i = line.indexOf('=');
    if (i === -1) return;
    var k = line.slice(0, i).trim();
    var v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  });
  return out;
}

async function revSaveSettings() {
  try {
    var out = await api('PUT', '/revenue/settings', {
      enabled: !!(document.getElementById('rev-enabled') || {}).checked,
      recipients: (document.getElementById('rev-recipients') || {}).value || '',
      weeks: parseInt((document.getElementById('rev-weeks') || {}).value, 10) || 12,
      staleDays: parseInt((document.getElementById('rev-stale') || {}).value, 10) || 10,
      locationMap: revReadMap()
    });
    _revMeta.settings = out.settings;
    showToast('Saved.', 'success');
    revDraw();
  } catch (e) {
    showToast('Could not save: ' + (e.message || 'unknown error'), 'error');
  }
}

async function revTestSend() {
  var me = (state.user && state.user.email) || '';
  if (!me) { showToast('Your account has no email address on it.', 'error'); return; }
  try {
    var out = await api('POST', '/revenue/send', { to: me });
    if (out.sent) showToast('Sent to ' + me + '.', 'success');
    else showToast(out.error || 'The report was built but not sent.', 'error');
  } catch (e) {
    showToast('Send failed: ' + (e.message || 'unknown error'), 'error');
  }
}
