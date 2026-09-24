/* Reliability tracker (public/js/reliability.js) - manager/admin/owner dashboard
 * over the schedule's attendance markings. Reads /api/reliability; writes nothing.
 * Position weights + the exclude flag are edited in the Schedule > Positions manager. */

var _relData = null;
var _relCity = '';
var _relSearch = '';

function relCanSee() {
  var u = (typeof state !== 'undefined' && state.user) || {};
  return u.isOwner === true || u.role === 'admin' || u.role === 'manager';
}
function relBand(p, th) {
  th = th || { green: 97, amber: 90 };
  if (p == null) return { key: 'none', label: '--', color: '#6b7280', fill: '#6b7280' };
  if (p >= th.green) return { key: 'g', label: 'GOOD', color: '#7ff0a8', bg: 'rgba(34,197,94,0.14)', fill: '#22c55e' };
  if (p >= th.amber) return { key: 'a', label: 'WATCH', color: '#ffd66b', bg: 'rgba(245,180,0,0.14)', fill: '#f5b400' };
  return { key: 'r', label: 'REVIEW', color: '#ff9a9a', bg: 'rgba(239,68,68,0.14)', fill: '#ef4444' };
}
function relFmtPct(p) { return p == null ? '--' : (p.toFixed(1) + '%'); }
function relToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
function relMonthsAgo(n) {
  var t = relToday().split('-').map(Number);
  var d = new Date(Date.UTC(t[0], t[1] - 1, t[2]));
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}
function relYtdStart() { return relToday().slice(0, 4) + '-01-01'; }

async function renderReliability(content) {
  if (!relCanSee()) { content.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
  content.innerHTML = '<div class="page-header"><div class="page-title"><h2>Reliability</h2><p>Loading&hellip;</p></div></div>';
  try {
    _relData = await api('GET', '/reliability/summary');
  } catch (e) {
    content.innerHTML = '<div class="alert alert-error">' + escHtml(e.message || 'Could not load reliability.') + '</div>';
    return;
  }
  relDraw(content);
}

function relDraw(content) {
  var d = _relData || {};
  var th = d.thresholds || { green: 97, amber: 90 };
  var rng = d.range || {};
  var positions = d.positions || [];

  var cities = [];
  (d.rows || []).forEach(function (r) { if (r.city_name && cities.indexOf(r.city_name) === -1) cities.push(r.city_name); });
  cities.sort();

  var tiles =
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0">' +
      relTile('Team average', d.team_avg == null ? '--' : (d.team_avg.toFixed(1) + '%'), (d.people || 0) + ' scheduled staff', relBand(d.team_avg, th).fill) +
      relTile('Below ' + th.amber + '%', String(d.below_count || 0), 'flagged for review', (d.below_count ? '#ef4444' : 'var(--text-color,#fff)')) +
      relTile('Window', '6 mo', (rng.from || '') + ' → ' + (rng.to || ''), 'var(--text-color,#fff)') +
    '</div>';

  var legend = '<div style="display:flex;gap:14px;align-items:center;font-size:11.5px;color:var(--text-muted-color,#9a9a9a);margin-left:auto">' +
    relDot('#22c55e', '&ge; ' + th.green + '%') + relDot('#f5b400', th.amber + '–' + th.green + '%') + relDot('#ef4444', '&lt; ' + th.amber + '%') + '</div>';

  var cityOpts = '<option value="">All cities</option>' + cities.map(function (c) {
    return '<option value="' + escHtml(c) + '"' + (c === _relCity ? ' selected' : '') + '>' + escHtml(c) + '</option>';
  }).join('');

  var bar = '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">' +
    '<select id="rel-city" onchange="_relCity=this.value;relDraw(document.getElementById(&#39;content&#39;))" style="background:var(--bg-elevated,#1f1f1f);color:var(--text-color,#fff);border:1px solid var(--border,#333);border-radius:8px;padding:8px 11px;font-size:12.5px">' + cityOpts + '</select>' +
    '<input id="rel-search" placeholder="Search name&hellip;" value="' + escHtml(_relSearch) + '" oninput="_relSearch=this.value;relBody()" style="flex:1;min-width:170px;background:var(--bg-elevated,#1f1f1f);color:var(--text-color,#fff);border:1px solid var(--border,#333);border-radius:8px;padding:8px 11px;font-size:12.5px">' +
    legend + '</div>';

  var head = '<tr><th style="text-align:left">Employee</th><th style="text-align:left">City</th><th style="text-align:left;min-width:210px">Reliability (6 mo)</th><th style="text-align:center">Expected</th>' +
    positions.map(function (p) { return '<th style="text-align:center" title="weight ' + p.weight + '">' + escHtml(p.name) + '</th>'; }).join('') +
    '<th style="text-align:center">Points</th><th></th></tr>';

  var foot = '<p style="color:var(--text-muted-color,#9a9a9a);font-size:11.5px;margin-top:12px">' +
    '<b style="color:#f97316">Points</b> = weighted shifts lost (' +
    positions.map(function (p) { return escHtml(p.name) + ' ' + p.weight; }).join(' · ') +
    '). Excluded positions (off / vacation) never count. Set weights in Schedule › Positions.</p>';

  content.innerHTML =
    '<div class="page-header"><div class="page-title"><h2>Reliability</h2>' +
      '<p>Rolling 6 months · manager, admin &amp; owner only · informational, no automatic action.</p></div></div>' +
    tiles + bar +
    '<div class="table-wrap" style="overflow-x:auto"><table class="table" style="width:100%"><thead>' + head + '</thead><tbody id="rel-tbody"></tbody></table></div>' +
    foot;

  relBody();
}

function relTile(label, val, sub, color) {
  return '<div style="background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:12px;padding:13px 15px">' +
    '<div style="color:var(--text-muted-color,#9a9a9a);font-size:11px;text-transform:uppercase;letter-spacing:.05em">' + label + '</div>' +
    '<div style="font-size:25px;font-weight:700;margin-top:5px;color:' + color + '">' + val + '</div>' +
    '<div style="color:var(--text-muted-color,#9a9a9a);font-size:11px;margin-top:3px">' + sub + '</div></div>';
}
function relDot(c, lab) { return '<span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + c + ';margin-right:5px;vertical-align:middle"></span>' + lab + '</span>'; }

function relBody() {
  var d = _relData || {};
  var th = d.thresholds || { green: 97, amber: 90 };
  var positions = d.positions || [];
  var tb = document.getElementById('rel-tbody');
  if (!tb) return;
  var q = (_relSearch || '').trim().toLowerCase();
  var rows = (d.rows || []).filter(function (r) {
    if (_relCity && r.city_name !== _relCity) return false;
    if (q && String(r.name || '').toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="' + (5 + positions.length) + '" style="text-align:center;color:var(--text-muted-color,#9a9a9a);padding:22px">No one to show.</td></tr>'; return; }
  tb.innerHTML = rows.map(function (r) {
    var b = relBand(r.reliability, th);
    var w = r.reliability == null ? 0 : Math.max(2, Math.round(r.reliability));
    var relcell = '<div style="display:flex;align-items:center;gap:9px">' +
      '<span style="font-weight:700;width:52px;color:' + b.fill + '">' + relFmtPct(r.reliability) + '</span>' +
      '<div style="flex:1;height:7px;background:#2a2a2a;border-radius:6px;overflow:hidden"><div style="height:100%;width:' + w + '%;background:' + b.fill + '"></div></div>' +
      '<span style="font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;color:' + b.color + ';background:' + (b.bg || 'transparent') + '">' + b.label + '</span></div>';
    var posCells = positions.map(function (p) {
      var c = (r.counts && r.counts[p.id]) || 0;
      return '<td style="text-align:center;' + (c ? '' : 'color:var(--text-muted-color,#6f6f6f)') + '">' + c + '</td>';
    }).join('');
    var pts = r.points ? r.points.toFixed(1) : '<span style="color:var(--text-muted-color,#6f6f6f)">0</span>';
    return '<tr style="cursor:pointer" onclick="relOpenUser(' + r.user_id + ')">' +
      '<td style="font-weight:600">' + escHtml(r.name) + '</td>' +
      '<td style="color:var(--text-muted-color,#9a9a9a)">' + escHtml(r.city_name || '') + '</td>' +
      '<td>' + relcell + '</td>' +
      '<td style="text-align:center">' + r.expected + '</td>' +
      posCells +
      '<td style="text-align:center;font-weight:700">' + pts + '</td>' +
      '<td style="text-align:center;color:var(--text-muted-color,#6f6f6f)">&rsaquo;</td></tr>';
  }).join('');
}

/* ---- detail / eval modal ------------------------------------------------- */
var _relDetailId = null;
var _relPreset = '6mo';

async function relOpenUser(id, preset) {
  _relDetailId = id;
  if (preset) _relPreset = preset;
  var qs = '';
  if (_relPreset === '6mo') qs = '?from=' + relMonthsAgo(6);
  else if (_relPreset === '12mo') qs = '?from=' + relMonthsAgo(12);
  else if (_relPreset === 'ytd') qs = '?from=' + relYtdStart();
  else if (_relPreset === 'custom') {
    var f = (document.getElementById('rel-cust-from') || {}).value;
    var t = (document.getElementById('rel-cust-to') || {}).value;
    qs = '?from=' + (f || relMonthsAgo(6)) + '&to=' + (t || relToday());
  }
  var data;
  try { data = await api('GET', '/reliability/user/' + id + qs); }
  catch (e) { novaAlert(e.message || 'Could not load.'); return; }
  relRenderDetail(data);
}
function relCloseModal() { var m = document.getElementById('rel-modal'); if (m) m.remove(); }

function relRenderDetail(d) {
  relCloseModal();
  var th = d.thresholds || { green: 97, amber: 90 };
  var b = relBand(d.reliability, th);
  var u = d.user || {};
  var rng = d.range || {};
  function pbtn(k, lab) {
    var on = _relPreset === k;
    return '<button onclick="relOpenUser(' + d.user.id + ',&#39;' + k + '&#39;)" style="background:' + (on ? '#f97316' : 'transparent') + ';color:' + (on ? '#111' : 'var(--text-muted-color,#9a9a9a)') + ';border:none;padding:7px 13px;font-size:12.5px;font-weight:' + (on ? '600' : '400') + ';cursor:pointer">' + lab + '</button>';
  }
  var custom = _relPreset === 'custom'
    ? '<div style="display:flex;gap:8px;align-items:center;margin:10px 0 2px"><input type="date" id="rel-cust-from" value="' + (rng.from || '') + '" style="background:var(--bg-elevated,#1f1f1f);color:var(--text-color,#fff);border:1px solid var(--border,#333);border-radius:7px;padding:6px"><span style="color:var(--text-muted-color,#9a9a9a)">to</span><input type="date" id="rel-cust-to" value="' + (rng.to || '') + '" style="background:var(--bg-elevated,#1f1f1f);color:var(--text-color,#fff);border:1px solid var(--border,#333);border-radius:7px;padding:6px"><button class="btn btn-primary btn-sm" onclick="relOpenUser(' + u.id + ',&#39;custom&#39;)">Apply</button></div>'
    : '';

  var tiles = '<div style="display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:10px;margin:14px 0">' +
    relTileD('Reliability', relFmtPct(d.reliability), b.label, b.color, b.bg, b.fill) +
    relTileD('Points lost', (d.points || 0).toFixed(1), 'of ' + d.expected + ' expected', null) +
    relTileD('Expected', String(d.expected), 'off / PTO excluded', null) +
    relTileD('Incidents', String((d.incidents || []).length), '', null) + '</div>';

  var log = (d.incidents || []).map(function (it) {
    var note = it.manager_notes ? ('<span style="color:var(--text-muted-color,#9a9a9a);font-size:12.5px;font-style:italic"><b style="color:var(--text-muted-color,#6f6f6f);font-style:normal">Mgr note:</b> ' + escHtml(it.manager_notes) + '</span>') : '<span style="color:var(--text-muted-color,#6f6f6f);font-size:12.5px">No note</span>';
    return '<div style="display:flex;align-items:center;gap:13px;padding:10px 2px;border-bottom:1px solid var(--border,#2a2a2a)">' +
      '<div style="width:112px;flex:0 0 112px"><div style="font-weight:600;font-size:13px">' + escHtml(it.date) + '</div><div style="color:var(--text-muted-color,#6f6f6f);font-size:11px">' + escHtml(it.dow) + '</div></div>' +
      '<span style="font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:7px;min-width:110px;text-align:center;color:' + escHtml(it.color || '#f97316') + ';background:rgba(148,148,148,.14)">' + escHtml(it.position_name) + '</span>' +
      '<div style="flex:1">' + note + '</div>' +
      '<div style="width:52px;text-align:right;font-weight:700">' + Number(it.weight).toFixed(1) + '</div></div>';
  }).join('') || '<p style="color:var(--text-muted-color,#9a9a9a);padding:14px 2px">No incidents in this window.</p>';

  var html = '<div style="background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:14px;max-width:760px;width:94%;max-height:88vh;overflow:auto">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:18px 20px 14px;border-bottom:1px solid var(--border,#2a2a2a)">' +
      '<div><h3 style="margin:0;font-size:18px">' + escHtml(u.name || '') + '</h3><div style="color:var(--text-muted-color,#9a9a9a);font-size:12.5px;margin-top:2px">' + escHtml((u.title ? u.title + ' · ' : '') + (u.city_name || '')) + '</div></div>' +
      '<button onclick="relCloseModal()" style="background:transparent;border:none;color:var(--text-muted-color,#9a9a9a);font-size:18px;cursor:pointer">&times;</button></div>' +
    '<div style="padding:12px 20px 20px">' +
      '<div style="display:inline-flex;background:var(--bg-color,#1f1f1f);border:1px solid var(--border,#333);border-radius:9px;overflow:hidden">' + pbtn('6mo', 'Last 6 months') + pbtn('12mo', 'Last 12 months') + pbtn('ytd', 'Year to date') + pbtn('custom', 'Custom') + '</div>' +
      '<span style="color:var(--text-muted-color,#6f6f6f);font-size:12px;margin-left:10px">' + (rng.from || '') + ' → ' + (rng.to || '') + '</span>' +
      custom + tiles +
      '<h4 style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted-color,#9a9a9a);margin:14px 2px 6px">Incident log</h4>' +
      log +
    '</div></div>';

  var ov = document.createElement('div');
  ov.id = 'rel-modal';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:400;display:flex;align-items:flex-start;justify-content:center;padding:34px 12px';
  ov.innerHTML = html;
  ov.addEventListener('click', function (e) { if (e.target === ov) relCloseModal(); });
  document.body.appendChild(ov);
}
function relTileD(label, val, sub, color, bg, fill) {
  var band = (label === 'Reliability' && sub)
    ? '<span style="display:inline-block;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;margin-top:8px;color:' + color + ';background:' + (bg || 'transparent') + '">' + sub + '</span>'
    : '<div style="color:var(--text-muted-color,#6f6f6f);font-size:11px;margin-top:6px">' + (sub || '&nbsp;') + '</div>';
  return '<div style="background:var(--bg-color,#1f1f1f);border:1px solid var(--border,#2a2a2a);border-radius:11px;padding:12px 14px">' +
    '<div style="color:var(--text-muted-color,#9a9a9a);font-size:11px;text-transform:uppercase;letter-spacing:.05em">' + label + '</div>' +
    '<div style="font-size:' + (label === 'Reliability' ? '28' : '21') + 'px;font-weight:800;margin-top:5px;line-height:1;color:' + (fill || 'var(--text-color,#fff)') + '">' + val + '</div>' + band + '</div>';
}
