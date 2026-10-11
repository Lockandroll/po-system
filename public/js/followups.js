// Customer Follow-Ups report (Tony, 2026-10-11). Server: routes/followups.js.
// Plan: claude/nova-customer-follow-up-plan.md. View id 'followup-report', gated
// by view_followup_report (ships dark: admin and owner only until ticked).
//
// The point of this screen is to catch review gating: who got a Google review
// request and who got the survey instead, and the reasons given, per city and
// per locksmith. Classic script, string concatenation only (CLAUDE.md 1.1).

var _fuRep = { from: '', to: '', city: '', data: null };

function fuPct(v) { return v == null ? '&mdash;' : (Math.round(v) === v ? v : v.toFixed(1)) + '%'; }

function fuTile(value, label, sub) {
  return '<div style="flex:1 1 180px;border:1px solid var(--border);border-radius:10px;padding:14px 16px">' +
    '<div style="font-size:26px;font-weight:700">' + value + '</div>' +
    '<div style="font-size:13px;color:var(--text-muted-color)">' + label + '</div>' +
    (sub ? '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px">' + sub + '</div>' : '') +
  '</div>';
}

function fuReasonsText(list) {
  if (!list || !list.length) return '<span style="color:var(--text-muted-color)">&mdash;</span>';
  return list.map(function (r) { return escHtml(r.label) + ' ' + r.count; }).join(', ');
}

function fuWeeksHtml(weeks) {
  var bars = (weeks || []).map(function (w, i) {
    var v = w.google_pct;
    var n = w.google + w.survey_tech;
    var h = v == null ? 2 : Math.max(2, Math.round(v * 1.3));
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;min-width:0" title="' +
        escHtml(w.start + ' to ' + w.end + ': ' + w.google + ' Google, ' + w.survey_tech + ' survey') + '">' +
      '<div style="font-size:10.5px;color:var(--text-muted-color)">' + (v == null ? '' : Math.round(v) + '%') + '</div>' +
      '<div style="width:70%;height:' + h + 'px;background:' + (v == null ? 'var(--border)' : '#f97316') + ';border-radius:4px 4px 0 0;opacity:' + (i === weeks.length - 1 ? 1 : 0.6) + '"></div>' +
      '<div style="font-size:10px;color:var(--text-muted-color);white-space:nowrap">' + escHtml(String(w.end).slice(5)) + '</div>' +
      '<div style="font-size:10px;color:var(--text-muted-color)">' + (n ? n : '') + '</div>' +
    '</div>';
  }).join('');
  return '<div style="font-size:13px;font-weight:600;margin:6px 0 8px">Google review % by week (the locksmith&#39;s own choices)</div>' +
    '<div style="display:flex;align-items:flex-end;gap:6px;height:190px;border-bottom:1px solid var(--border);margin-bottom:18px;overflow-x:auto">' + bars + '</div>';
}

async function renderFollowupReport(el) {
  el.innerHTML = '<div class="loading">Loading' + String.fromCharCode(8230) + '</div>';
  var qs = [];
  if (_fuRep.from) qs.push('from=' + encodeURIComponent(_fuRep.from));
  if (_fuRep.to) qs.push('to=' + encodeURIComponent(_fuRep.to));
  if (_fuRep.city) qs.push('city=' + encodeURIComponent(_fuRep.city));
  var d;
  try { d = await api('GET', '/followups/report' + (qs.length ? '?' + qs.join('&') : '')); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>'; return; }
  _fuRep.data = d;
  var c = d.company || {};
  var cityOpts = '<option value="">All cities</option>' + (d.cities || []).map(function (x) {
    return '<option value="' + escHtml(x.code) + '"' + (_fuRep.city === x.code ? ' selected' : '') + '>' + escHtml(x.name) + '</option>';
  }).join('');

  var areaRows = (d.areas || []).map(function (a) {
    return '<tr><td>' + escHtml(a.area) + '</td><td>' + a.sent + '</td><td><b>' + fuPct(a.google_pct) + '</b></td><td>' + a.google + ' / ' + a.survey_tech + '</td>' +
      '<td>' + (a.survey_auto + a.survey_only) + '</td><td>' + fuPct(a.google_click_pct) + '</td><td>' + (a.reviews_est == null ? '&mdash;' : a.reviews_est) + '</td><td>' + fuPct(a.survey_done_pct) + '</td></tr>';
  }).join('');
  var techRows = (d.locksmiths || []).map(function (t) {
    var n = t.google + t.survey_tech;
    return '<tr' + (t.flag ? ' style="background:rgba(249,115,22,.08)"' : '') + '><td>' + escHtml(t.locksmith) + '</td><td>' + escHtml(t.area || '') + '</td><td>' + n + '</td>' +
      '<td>' + (t.flag ? '<b style="color:#f97316">' + fuPct(t.google_pct) + '</b> <span style="font-size:11px;font-weight:700;border-radius:10px;padding:2px 8px;background:rgba(249,115,22,.15);color:#f97316">Check</span>' : fuPct(t.google_pct)) + '</td>' +
      '<td>' + t.google + '</td><td>' + t.survey_tech + '</td><td>' + (t.survey_auto + t.survey_only) + '</td>' +
      '<td style="font-size:12.5px;color:var(--text-muted-color)">' + fuReasonsText(t.reasons) + '</td></tr>';
  }).join('');

  el.innerHTML =
    '<div class="page-header"><div><div class="page-title">Customer Follow-Ups</div>' +
      '<div class="page-subtitle">Who was sent a Google review request and who got the survey, and why. Built to catch review gating early.</div></div></div>' +
    '<div class="card mb-4"><div class="card-body" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">' +
      '<div class="form-group" style="margin:0"><label>From</label><input type="date" id="fu-from" value="' + escHtml(d.from) + '" /></div>' +
      '<div class="form-group" style="margin:0"><label>To</label><input type="date" id="fu-to" value="' + escHtml(d.to) + '" /></div>' +
      '<div class="form-group" style="margin:0"><label>City</label><select id="fu-city">' + cityOpts + '</select></div>' +
      '<button class="btn btn-primary btn-sm" onclick="fuApplyFilters()">Apply</button>' +
    '</div></div>' +
    '<div class="card mb-4"><div class="card-body">' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
        fuTile(fuPct(c.google_pct), 'Picked Google review', c.google + ' Google, ' + c.survey_tech + ' survey by choice') +
        fuTile(fuPct(c.google_click_pct), 'Opened the Google link', c.google_clicks + ' of ' + c.google + ' tapped the button') +
        fuTile(c.reviews_est == null ? '&mdash;' : String(c.reviews_est), 'Google reviews posted (est.)', d.reviews_feed ? 'New reviews in that city within 3 days of a request' : 'Review feed not connected') +
        fuTile(fuPct(c.survey_done_pct), 'Surveys completed', c.surveys_done + ' of ' + c.survey_sent + ' sent') +
      '</div>' +
      fuWeeksHtml(d.weeks) +
      '<div style="font-size:12.5px;color:var(--text-muted-color);line-height:1.6">' + c.sent + ' follow-ups sent in this period. ' +
        (c.survey_auto + c.survey_only) + ' surveys were picked by Nova (commercial job, repeat customer) or by the account&#39;s Survey only setting; those are never counted against the locksmith. ' +
        '<b>Google %</b> = Google requests &divide; (Google requests + surveys the locksmith picked).</div>' +
    '</div></div>' +
    '<div class="card mb-4"><div class="card-header"><span class="card-title">By city</span></div><div class="card-body"><div class="table-wrap"><table>' +
      '<thead><tr><th>Area</th><th>Sent</th><th>Google %</th><th>Google / survey</th><th>Automatic</th><th>Opened Google</th><th>Reviews (est.)</th><th>Survey done</th></tr></thead>' +
      '<tbody>' + (areaRows || '<tr><td colspan="8" class="text-muted">Nothing sent in this period.</td></tr>') + '</tbody></table></div></div></div>' +
    '<div class="card mb-4"><div class="card-header"><span class="card-title">By locksmith</span></div><div class="card-body"><div class="table-wrap"><table>' +
      '<thead><tr><th>Locksmith</th><th>Area</th><th>Choices</th><th>Google %</th><th>Google</th><th>Survey</th><th>Automatic</th><th>Survey reasons</th></tr></thead>' +
      '<tbody>' + (techRows || '<tr><td colspan="8" class="text-muted">Nothing sent in this period.</td></tr>') + '</tbody></table></div>' +
      '<div style="font-size:12.5px;color:var(--text-muted-color);margin-top:8px">Flags anyone more than ' + d.flag_points + ' points below the company Google % with at least ' + d.flag_min + ' choices. A flag is a question to ask, not a verdict.</div>' +
    '</div></div>';
}

function fuApplyFilters() {
  _fuRep.from = (document.getElementById('fu-from') || {}).value || '';
  _fuRep.to = (document.getElementById('fu-to') || {}).value || '';
  _fuRep.city = (document.getElementById('fu-city') || {}).value || '';
  var el = document.getElementById('content');
  if (el) renderFollowupReport(el); else render();
}
