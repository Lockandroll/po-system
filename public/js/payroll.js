// Payroll module - front end.
//
// Owner-only workspace. The hub holds one live tool for now, the Compliance
// Check (upload the Event-to-Event CSVs + the Paychex journal, review the wages
// Nova read, run the minimum-wage / overtime tests per state, file the PDF).
// Screens are dispatched from app.js render() by view name.
//
// Classic script - everything global, uses api(), state, navigate(), escHtml()
// from app.js. House style: string concatenation only, no template literals;
// &#39; for apostrophes inside HTML strings.

function payMoney(n) {
  var v = Number(n) || 0;
  var neg = v < 0;
  v = Math.abs(v).toFixed(2);
  var p = v.split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + p[0] + '.' + p[1];
}
function payRate(n) { return '$' + (Number(n) || 0).toFixed(2); }
function payChip(status) {
  if (status === 'action') return '<span style="display:inline-block;background:rgba(239,68,68,.15);color:#f87171;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px">Action</span>';
  if (status === 'pass') return '<span style="display:inline-block;background:rgba(34,197,94,.15);color:#4ade80;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px">Pass</span>';
  return '<span style="display:inline-block;background:var(--bg-elevated);color:var(--text-muted-color);font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px">' + escHtml(status || '-') + '</span>';
}
function payLockPill() {
  return '<span style="font-size:11px;color:var(--primary);border:1px solid rgba(249,115,22,.4);border-radius:20px;padding:2px 10px;font-weight:700">Owner only</span>';
}
function payGuard() {
  if (!(state.user && state.user.isOwner)) { return '<div class="alert alert-error">Payroll is owner-only.</div>'; }
  return null;
}

// ---- Hub -----------------------------------------------------------------

async function renderPayrollHub(el) {
  var g = payGuard(); if (g) { el.innerHTML = g; return; }
  el.innerHTML = '<div class="loading">Loading…</div>';
  var runs = [];
  try { runs = await api('GET', '/payroll/runs'); } catch (e) {}

  var tile = function (icon, title, desc, live, view) {
    var corner = live
      ? '<span style="position:absolute;top:14px;right:14px;background:rgba(34,197,94,.15);color:#4ade80;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px">Live</span>'
      : '<span style="position:absolute;top:14px;right:14px;background:var(--bg-elevated);color:var(--text-muted-color);font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px">Soon</span>';
    return '<div ' + (live ? 'onclick="navigate(\'' + view + '\')" ' : '') +
      'style="position:relative;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:18px;' +
      (live ? 'cursor:pointer' : 'opacity:.55') + '">' + corner +
      '<div style="width:38px;height:38px;border-radius:9px;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:19px;margin-bottom:12px">' + icon + '</div>' +
      '<h3 style="margin:0 0 5px;font-size:15px">' + title + '</h3>' +
      '<p style="margin:0;font-size:12.5px;color:var(--text-muted-color);line-height:1.45">' + desc + '</p></div>';
  };

  var recent = '';
  if (runs && runs.length) {
    recent = '<div class="card" style="margin-top:18px"><div class="card-body" style="padding:0">' +
      '<div style="padding:14px 18px;border-bottom:1px solid var(--border);font-weight:600">Recent compliance runs</div>' +
      '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
      '<th style="text-align:left;padding:10px 16px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Pay period</th>' +
      '<th style="text-align:left;padding:10px 16px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Min wage</th>' +
      '<th style="text-align:left;padding:10px 16px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Overtime</th>' +
      '<th style="text-align:right;padding:10px 16px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Owed</th>' +
      '<th style="padding:10px 16px"></th></tr></thead><tbody>' +
      runs.slice(0, 5).map(function (r) {
        var owed = (Number(r.total_trueup) || 0) + (Number(r.total_ot) || 0);
        var target = (r.status === 'draft') ? 'payroll-review' : 'payroll-results';
        return '<tr>' +
          '<td style="padding:11px 16px;font-family:\'Fira Code\',monospace">' + escHtml(payPeriodShort(r)) + '</td>' +
          '<td style="padding:11px 16px">' + payChip(r.status_minwage) + '</td>' +
          '<td style="padding:11px 16px">' + payChip(r.status_ot) + '</td>' +
          '<td style="padding:11px 16px;text-align:right;font-family:\'Fira Code\',monospace">' + payMoney(owed) + '</td>' +
          '<td style="padding:11px 16px;text-align:right"><a style="color:var(--primary);cursor:pointer" onclick="navigate(\'' + target + '\',' + r.id + ')">Open</a></td>' +
          '</tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  el.innerHTML =
    '<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
      '<div><div class="page-title">Payroll</div><div class="page-subtitle" style="color:var(--text-muted-color)">Owner-only workspace. Compliance is live now; the rest of the hub comes later.</div></div>' +
      '<div style="display:flex;gap:8px;align-items:center">' + payLockPill() +
      '<button class="btn btn-secondary btn-sm" onclick="navigate(\'payroll-thresholds\')">Minimum wage by state</button></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin-top:16px">' +
      tile('🛡️', 'Compliance Check', 'Upload the Event-to-Event CSVs and the Paychex journal. Nova runs the minimum-wage and overtime tests and files the record before you submit payroll.', true, 'payroll-compliance') +
      tile('📄', 'Payroll Journals', 'Every Paychex journal, stored and searchable by period, employee and department.', false) +
      tile('👤', 'Employee Pay', 'Per-employee pay history across periods: earnings, hours, effective-rate trends.', false) +
      tile('🗓️', 'Pay Periods', 'The payroll calendar: what is open, what is filed, what is due to Paychex next.', false) +
    '</div>' + recent;
}

function payPeriodShort(r) {
  var s = String(r.period_start || '').slice(5, 10).replace('-', '/');
  var e = String(r.period_end || '').slice(5, 10).replace('-', '/');
  return s && e ? (s + ' - ' + e) : (r.period_end || 'Run ' + r.id);
}

// ---- Thresholds ----------------------------------------------------------

async function renderPayrollThresholds(el) {
  var g = payGuard(); if (g) { el.innerHTML = g; return; }
  el.innerHTML = '<div class="loading">Loading…</div>';
  var rows = [];
  try { rows = await api('GET', '/payroll/thresholds'); } catch (e) {}
  var byState = {}; rows.forEach(function (r) { byState[r.state] = r; });
  var names = { FL: 'Florida', GA: 'Georgia', AL: 'Alabama' };
  var cities = { FL: 'Orlando, Jacksonville, Tampa, Clearwater, Tallahassee', GA: 'Savannah, Columbus', AL: 'Birmingham' };

  var body = ['FL', 'GA', 'AL'].map(function (st) {
    var r = byState[st] || {};
    return '<tr>' +
      '<td style="padding:12px 14px"><b>' + names[st] + '</b><div style="font-size:11.5px;color:var(--text-muted-color)">' + cities[st] + '</div></td>' +
      '<td style="padding:12px 14px;font-family:\'Fira Code\',monospace">' + payRate(r.legal_min) + '</td>' +
      '<td style="padding:12px 14px"><input type="number" step="0.01" id="thr-applied-' + st + '" value="' + (r.applied_min != null ? Number(r.applied_min).toFixed(2) : '') + '" style="width:100px;padding:6px 8px;font-family:\'Fira Code\',monospace"></td>' +
      '<td style="padding:12px 14px"><input type="number" step="0.01" id="thr-next-' + st + '" value="' + (r.next_applied != null ? Number(r.next_applied).toFixed(2) : '') + '" style="width:100px;padding:6px 8px;font-family:\'Fira Code\',monospace"></td>' +
      '<td style="padding:12px 14px"><input type="date" id="thr-eff-' + st + '" value="' + (r.next_effective ? String(r.next_effective).slice(0, 10) : '') + '" style="width:150px;padding:6px 8px"></td>' +
      '</tr>';
  }).join('');

  el.innerHTML =
    '<div class="page-header"><div class="page-title">Minimum wage by state</div>' +
      '<div class="page-subtitle" style="color:var(--text-muted-color)">One threshold per state we operate in. A tech is measured against their own state.</div></div>' +
    '<div style="border:1px solid rgba(249,115,22,.35);background:rgba(249,115,22,.06);border-left:3px solid var(--primary);border-radius:8px;padding:12px 15px;margin:14px 0;font-size:12.5px;color:var(--text-dim);line-height:1.5">' +
      'Each state carries the <b>legal minimum</b> (the statutory floor) and the <b>company standard applied</b> (what the check enforces). Florida follows the law and steps to $15.00 on 9/30/2026. Georgia and Alabama only require the federal $7.25, but the company pays the same standard. The next value takes effect on its date automatically, and each filed record stamps the rate applied.</div>' +
    '<div id="thr-msg"></div>' +
    '<div class="card"><div class="card-body" style="padding:0">' +
      '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
      '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">State</th>' +
      '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Legal minimum</th>' +
      '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Applied now</th>' +
      '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Next applied</th>' +
      '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Effective</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>' +
      '<div style="padding:14px 16px;border-top:1px solid var(--border);display:flex;gap:8px">' +
      '<button class="btn btn-secondary" onclick="navigate(\'payroll\')">Back</button>' +
      '<button class="btn btn-primary" onclick="savePayrollThresholds()">Save thresholds</button></div>' +
    '</div></div>';
}

async function savePayrollThresholds() {
  var msg = document.getElementById('thr-msg');
  try {
    var states = ['FL', 'GA', 'AL'];
    for (var i = 0; i < states.length; i++) {
      var st = states[i];
      var applied = document.getElementById('thr-applied-' + st).value;
      var next = document.getElementById('thr-next-' + st).value;
      var eff = document.getElementById('thr-eff-' + st).value;
      await api('PUT', '/payroll/thresholds/' + st, {
        applied_min: applied === '' ? null : Number(applied),
        next_applied: next === '' ? null : Number(next),
        next_effective: eff || null
      });
    }
    if (msg) msg.innerHTML = '<div class="alert" style="background:rgba(34,197,94,.12);color:#4ade80;padding:10px 14px;border-radius:8px;margin-bottom:12px">Saved.</div>';
  } catch (e) {
    if (msg) msg.innerHTML = '<div class="alert alert-error">Could not save: ' + escHtml(e.message || 'error') + '</div>';
  }
}

// ---- Compliance Check: upload -------------------------------------------

async function renderPayrollCompliance(el) {
  var g = payGuard(); if (g) { el.innerHTML = g; return; }
  var today = new Date();
  var end = new Date(today.getTime()); var start = new Date(today.getTime() - 6 * 86400000);
  var iso = function (d) { return d.toISOString().slice(0, 10); };

  el.innerHTML =
    '<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
      '<div><div class="page-title">Compliance Check</div><div class="page-subtitle" style="color:var(--text-muted-color)">Step 1 of 3 - upload the pay-period reports.</div></div>' + payLockPill() +
    '</div>' +
    '<div id="pay-up-msg"></div>' +
    '<div class="card" style="margin-top:14px"><div class="card-body">' +
      '<label style="font-weight:600">Pulsar Event-to-Event CSVs <span style="color:var(--text-muted-color);font-weight:400">(one or more; export with 30-minute gap time)</span></label>' +
      '<input type="file" id="pay-csv" accept=".csv,text/csv" multiple style="margin-top:8px">' +
    '</div></div>' +
    '<div class="card"><div class="card-body">' +
      '<label style="font-weight:600">Paychex payroll journal <span style="color:var(--text-muted-color);font-weight:400">(PDF - Nova reads each tech&#39;s W-2 taxable wages from this)</span></label>' +
      '<input type="file" id="pay-journal" accept="application/pdf,.pdf" style="margin-top:8px">' +
    '</div></div>' +
    '<div class="card"><div class="card-body">' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px">' +
        '<div><label>Pay period start</label><input type="date" id="pay-start" value="' + iso(start) + '"></div>' +
        '<div><label>Pay period end</label><input type="date" id="pay-end" value="' + iso(end) + '"></div>' +
        '<div><label>Paychex check date</label><input type="date" id="pay-check"></div>' +
        '<div><label>Review date</label><input type="date" id="pay-review" value="' + iso(today) + '"></div>' +
      '</div>' +
      '<div style="margin-top:14px;max-width:260px"><label>Overtime method</label>' +
        '<select id="pay-otmethod"><option value="half">Half-time (0.5x) - default</option><option value="full">Full (1.5x reference)</option></select>' +
        '<div style="font-size:11.5px;color:var(--text-muted-color);margin-top:5px">Half-time premium on hours over 40 (29 CFR 778.118). Commission already pays straight time on every hour.</div>' +
      '</div>' +
    '</div></div>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button class="btn btn-secondary" onclick="navigate(\'payroll\')">Cancel</button>' +
      '<button class="btn btn-primary" id="pay-run-btn" onclick="submitPayrollRun()">Read journal &amp; continue</button>' +
    '</div>';
}

async function payrollUpload(file, kind) {
  var ct = kind === 'journal' ? 'application/pdf' : 'text/csv';
  var pres = await api('POST', '/payroll/uploads/url', { kind: kind, filename: file.name, contentType: ct });
  var put = await fetch(pres.url, { method: 'PUT', headers: { 'Content-Type': ct }, body: file });
  if (!put.ok) throw new Error('Upload failed for ' + file.name);
  return pres.key;
}

async function submitPayrollRun() {
  var msg = document.getElementById('pay-up-msg');
  var btn = document.getElementById('pay-run-btn');
  var csvInput = document.getElementById('pay-csv');
  var journalInput = document.getElementById('pay-journal');
  var csvs = csvInput && csvInput.files ? Array.prototype.slice.call(csvInput.files) : [];
  var journal = journalInput && journalInput.files && journalInput.files[0];
  if (!csvs.length) { msg.innerHTML = '<div class="alert alert-error">Add at least one Event-to-Event CSV.</div>'; return; }
  if (!journal) { msg.innerHTML = '<div class="alert alert-error">Add the Paychex journal PDF.</div>'; return; }
  if (btn) { btn.disabled = true; }
  msg.innerHTML = '<div class="alert" style="background:var(--bg-elevated);padding:10px 14px;border-radius:8px;margin-bottom:12px">Uploading and reading the journal… this can take a minute.</div>';
  try {
    var csvKeys = [];
    for (var i = 0; i < csvs.length; i++) { csvKeys.push(await payrollUpload(csvs[i], 'csv')); }
    var journalKey = await payrollUpload(journal, 'journal');
    var body = {
      csv_keys: csvKeys, journal_key: journalKey,
      period_start: val('pay-start'), period_end: val('pay-end'),
      check_date: val('pay-check'), review_date: val('pay-review'),
      ot_method: val('pay-otmethod')
    };
    var out = await api('POST', '/payroll/runs', body);
    navigate('payroll-review', out.run_id);
  } catch (e) {
    if (btn) btn.disabled = false;
    msg.innerHTML = '<div class="alert alert-error">' + escHtml(e.message || 'Something went wrong.') + '</div>';
  }
  function val(id) { var n = document.getElementById(id); return n ? n.value : null; }
}

// ---- Compliance Check: review wages -------------------------------------

async function renderPayrollReview(el, runId) {
  var g = payGuard(); if (g) { el.innerHTML = g; return; }
  runId = runId || state.currentParam;
  el.innerHTML = '<div class="loading">Loading…</div>';
  var data;
  try { data = await api('GET', '/payroll/runs/' + runId); } catch (e) { el.innerHTML = '<div class="alert alert-error">Could not load the run.</div>'; return; }
  var lines = data.lines || [];

  var stateSel = function (id, cur) {
    return '<select id="' + id + '" style="width:70px;padding:5px 6px">' +
      ['FL', 'GA', 'AL'].map(function (s) { return '<option value="' + s + '"' + (s === cur ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>';
  };
  var body = lines.map(function (l) {
    var flagged = l.match_method === 'unmatched';
    return '<tr' + (flagged ? ' style="background:rgba(245,158,11,.07)"' : '') + '>' +
      '<td style="padding:10px 12px"><input type="checkbox" id="pex-' + l.id + '"' + (l.excluded ? ' checked' : '') + ' style="width:auto"></td>' +
      '<td style="padding:10px 12px">' + escHtml(l.tech_name) + '</td>' +
      '<td style="padding:10px 12px;text-align:right;font-family:\'Fira Code\',monospace">' + Number(l.hours).toFixed(1) + '</td>' +
      '<td style="padding:10px 12px">' + stateSel('pst-' + l.id, l.state) + '</td>' +
      '<td style="padding:10px 12px"><input type="number" step="0.01" id="pwg-' + l.id + '" value="' + (Number(l.wages).toFixed(2)) + '" style="width:100px;padding:5px 8px;text-align:right;font-family:\'Fira Code\',monospace"></td>' +
      '<td style="padding:10px 12px;font-size:12px;color:var(--text-muted-color)">' + escHtml(l.components || '') + (flagged ? ' <span style="color:#fbbf24;font-weight:600">needs review</span>' : (l.match_method === 'last_name' ? ' <span style="color:#fbbf24">last-name match</span>' : '')) + '</td>' +
      '</tr>';
  }).join('');

  var unmatchedWages = (data.run && data.run.__unmatched) || null; // not persisted; informational only

  el.innerHTML =
    '<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
      '<div><div class="page-title">Compliance Check</div><div class="page-subtitle" style="color:var(--text-muted-color)">Step 2 of 3 - review the wages Nova read from the journal.</div></div>' + payLockPill() +
    '</div>' +
    '<div style="border:1px solid rgba(249,115,22,.35);background:rgba(249,115,22,.06);border-left:3px solid var(--primary);border-radius:8px;padding:12px 15px;margin:14px 0;font-size:12.5px;color:var(--text-dim);line-height:1.5">' +
      'Nova matched each technician to their Pulsar hours and read their W-2 taxable wages off the journal. Because a PDF read is never perfect and this math is legally load-bearing, nothing runs until you confirm it. Every wage is editable; anything Nova was unsure about is flagged. <b>W-2 taxable wages</b> is all of it (salary + commission + tips + bonus + stipends), not Pulsar&#39;s per-hour column.</div>' +
    '<div id="pay-rev-msg"></div>' +
    '<div class="card"><div class="card-body" style="padding:0">' +
      '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
      '<th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Exclude</th>' +
      '<th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Technician</th>' +
      '<th style="text-align:right;padding:10px 12px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Hours</th>' +
      '<th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">State</th>' +
      '<th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">W-2 wages</th>' +
      '<th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Components</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div></div>' +
    '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:12px">Tip: exclude salaried managers, 1099 contractors, standard-rate hourly staff and locksmiths (separate review). Nova only tests the line technicians left in.</div>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button class="btn btn-secondary" onclick="navigate(\'payroll-compliance\')">Start over</button>' +
      '<button class="btn btn-primary" id="pay-compute-btn" onclick="computePayrollRun(' + runId + ')">Looks right - run check</button>' +
    '</div>';
}

async function savePayrollReview(runId) {
  var lines = [];
  document.querySelectorAll('[id^="pwg-"]').forEach(function (inp) {
    var id = inp.id.slice(4);
    var st = document.getElementById('pst-' + id);
    var ex = document.getElementById('pex-' + id);
    lines.push({ id: Number(id), wages: inp.value === '' ? null : Number(inp.value), state: st ? st.value : null, excluded: ex ? ex.checked : false });
  });
  await api('PUT', '/payroll/runs/' + runId + '/wages', { lines: lines });
}

async function computePayrollRun(runId) {
  var msg = document.getElementById('pay-rev-msg');
  var btn = document.getElementById('pay-compute-btn');
  if (btn) btn.disabled = true;
  try {
    await savePayrollReview(runId);
    await api('POST', '/payroll/runs/' + runId + '/compute', {});
    navigate('payroll-results', runId);
  } catch (e) {
    if (btn) btn.disabled = false;
    if (msg) msg.innerHTML = '<div class="alert alert-error">' + escHtml(e.message || 'Could not run the check.') + '</div>';
  }
}

// ---- Compliance Check: results ------------------------------------------

async function renderPayrollResults(el, runId) {
  var g = payGuard(); if (g) { el.innerHTML = g; return; }
  runId = runId || state.currentParam;
  el.innerHTML = '<div class="loading">Loading…</div>';
  var data;
  try { data = await api('GET', '/payroll/runs/' + runId); } catch (e) { el.innerHTML = '<div class="alert alert-error">Could not load the run.</div>'; return; }
  var run = data.run || {};
  var lines = (data.lines || []).filter(function (l) { return !l.excluded; });
  var trueupLines = lines.filter(function (l) { return l.flagged_minwage; });
  var otLines = lines.filter(function (l) { return l.flagged_ot; });
  var full = run.ot_method === 'full';

  var panel = function (title, status, desc, tone) {
    var col = tone === 'red' ? '#f87171' : (tone === 'amber' ? '#fbbf24' : '#4ade80');
    var bg = tone === 'red' ? 'rgba(239,68,68,.08)' : (tone === 'amber' ? 'rgba(245,158,11,.08)' : 'rgba(34,197,94,.08)');
    var bd = tone === 'red' ? 'rgba(239,68,68,.4)' : (tone === 'amber' ? 'rgba(245,158,11,.4)' : 'rgba(34,197,94,.4)');
    return '<div style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:8px;padding:16px 18px">' +
      '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted-color);font-weight:600">' + title + '</div>' +
      '<div style="font-size:18px;font-weight:700;margin-top:6px;color:' + col + '">' + status + '</div>' +
      '<div style="font-size:12.5px;color:var(--text-dim);margin-top:5px">' + desc + '</div></div>';
  };
  var mwAction = run.status_minwage === 'action';
  var otAction = run.status_ot === 'action';

  var actionBlock = function (tone, title, rowsHtml) {
    var col = tone === 'red' ? '#f87171' : '#fbbf24';
    var bg = tone === 'red' ? 'rgba(239,68,68,.08)' : 'rgba(245,158,11,.08)';
    var bd = tone === 'red' ? 'rgba(239,68,68,.35)' : 'rgba(245,158,11,.35)';
    return '<div style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:8px;padding:14px 16px;margin-bottom:14px">' +
      '<div style="font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:9px;color:' + col + '">' + title + '</div>' + rowsHtml + '</div>';
  };
  var abRow = function (label, amt) {
    return '<div style="display:flex;gap:10px;font-size:13px;padding:6px 0;border-top:1px solid rgba(255,255,255,.05)"><span>' + label + '</span><span style="margin-left:auto;font-family:\'Fira Code\',monospace;font-weight:700">' + amt + '</span></div>';
  };

  var actions = '';
  if (trueupLines.length) {
    actions += actionBlock('red', 'Enter in Paychex: Minimum Compensation true-up',
      trueupLines.map(function (l) { return abRow(escHtml(l.tech_name) + ' &middot; ' + Number(l.hours).toFixed(1) + ' hrs @ ' + payRate(l.effective_rate) + ' (' + l.state + ' floor ' + payRate(l.threshold) + ')', payMoney(l.trueup)); }).join(''));
  }
  if (otLines.length) {
    actions += actionBlock('amber', 'Enter in Paychex: Overtime premium (half-time)',
      otLines.map(function (l) { return abRow(escHtml(l.tech_name) + ' &middot; ' + Number(l.ot_hours).toFixed(1) + ' OT hrs @ reg ' + payRate(l.reg_rate), payMoney(full ? l.ot_premium_full : l.ot_premium_half)); }).join(''));
  }
  if (!trueupLines.length && !otLines.length) {
    actions = '<div style="background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.4);border-radius:8px;padding:14px 16px;margin-bottom:14px;color:#4ade80;font-weight:600">No action required. Every technician cleared minimum wage and none exceeded 40 hours.</div>';
  }

  var roster = lines.map(function (l) {
    var tint = l.flagged_minwage ? 'background:rgba(239,68,68,.07)' : (l.flagged_ot ? 'background:rgba(245,158,11,.07)' : '');
    return '<tr style="' + tint + '">' +
      '<td style="padding:10px 14px">' + escHtml(l.tech_name) + '</td>' +
      '<td style="padding:10px 14px;text-align:right;font-family:\'Fira Code\',monospace">' + Number(l.hours).toFixed(1) + '</td>' +
      '<td style="padding:10px 14px;text-align:right;font-family:\'Fira Code\',monospace">' + payMoney(l.wages) + '</td>' +
      '<td style="padding:10px 14px;text-align:right;font-family:\'Fira Code\',monospace' + (l.flagged_minwage ? ';color:#f87171;font-weight:700' : '') + '">' + payRate(l.effective_rate) + '</td>' +
      '<td style="padding:10px 14px">' + escHtml(l.state || '') + '</td>' +
      '<td style="padding:10px 14px;text-align:right;font-family:\'Fira Code\',monospace">' + (Number(l.ot_hours) > 0 ? Number(l.ot_hours).toFixed(1) : '-') + '</td>' +
      '</tr>';
  }).join('');

  var owed = (Number(run.total_trueup) || 0) + (Number(run.total_ot) || 0);
  var filed = run.status === 'filed';

  el.innerHTML =
    '<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
      '<div><div class="page-title">Compliance Check - Results</div>' +
      '<div class="page-subtitle" style="color:var(--text-muted-color)">' + escHtml(payPeriodShort(run)) + ' &middot; threshold applied per state</div></div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-secondary btn-sm" id="pay-file-btn" onclick="filePayrollRun(' + runId + ')">' + (filed ? 'Re-file record' : 'File the record (PDF)') + '</button>' +
        (filed ? '<button class="btn btn-primary btn-sm" onclick="openPayrollPdf(' + runId + ')">Open filed PDF</button>' : '') +
      '</div>' +
    '</div>' +
    '<div id="pay-res-msg"></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0">' +
      panel('Minimum wage', mwAction ? 'Action required' : 'Pass', mwAction ? (trueupLines.length + ' below the floor. True-up owed ' + payMoney(run.total_trueup) + '.') : 'All technicians at or above the floor.', mwAction ? 'red' : 'green') +
      panel('Overtime', otAction ? 'Action required' : 'Pass', otAction ? (otLines.length + ' over 40 hours. Premium owed ' + payMoney(run.total_ot) + '.') : 'No technician over 40 hours.', otAction ? 'amber' : 'green') +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px">' +
      payStat(run.roster_count, 'Techs tested') + payStat(payRate(run.lowest_rate), 'Lowest rate') +
      payStat(payMoney(run.total_trueup), 'True-ups owed') + payStat(payMoney(run.total_ot), 'OT premiums owed') +
    '</div>' + actions +
    '<div class="card"><div class="card-body" style="padding:0">' +
      '<div style="padding:14px 18px;border-bottom:1px solid var(--border);font-weight:600">Roster tested <span style="color:var(--text-muted-color);font-weight:400;font-size:12px">(sorted lowest rate first)</span></div>' +
      '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
      '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Technician</th>' +
      '<th style="text-align:right;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Hours</th>' +
      '<th style="text-align:right;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">W-2 wages</th>' +
      '<th style="text-align:right;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Eff. rate</th>' +
      '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">State</th>' +
      '<th style="text-align:right;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">OT hrs</th>' +
      '</tr></thead><tbody>' + roster + '</tbody></table></div></div>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button class="btn btn-secondary" onclick="navigate(\'payroll-review\',' + runId + ')">Back to review</button>' +
      '<button class="btn btn-secondary" onclick="navigate(\'payroll-log\')">Compliance log</button>' +
    '</div>';
}

function payStat(value, label) {
  return '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:14px 16px">' +
    '<div style="font-size:24px;font-weight:700;color:var(--primary);font-family:\'Fira Code\',monospace">' + value + '</div>' +
    '<div style="font-size:12px;color:var(--text-muted-color);margin-top:3px">' + label + '</div></div>';
}

async function filePayrollRun(runId) {
  var msg = document.getElementById('pay-res-msg');
  var btn = document.getElementById('pay-file-btn');
  if (btn) btn.disabled = true;
  if (msg) msg.innerHTML = '<div class="alert" style="background:var(--bg-elevated);padding:10px 14px;border-radius:8px;margin-bottom:12px">Filing the record…</div>';
  try {
    await api('POST', '/payroll/runs/' + runId + '/file', {});
    if (msg) msg.innerHTML = '<div class="alert" style="background:rgba(34,197,94,.12);color:#4ade80;padding:10px 14px;border-radius:8px;margin-bottom:12px">Filed. The PDF is stored and listed in the compliance log.</div>';
    navigate('payroll-results', runId);
  } catch (e) {
    if (btn) btn.disabled = false;
    if (msg) msg.innerHTML = '<div class="alert alert-error">' + escHtml(e.message || 'Could not file the record.') + '</div>';
  }
}

async function openPayrollPdf(runId) {
  try {
    var r = await api('GET', '/payroll/runs/' + runId + '/pdf?inline=1');
    if (r && r.url) window.open(r.url, '_blank');
  } catch (e) { alert('Could not open the record: ' + (e.message || 'error')); }
}

// ---- Compliance log ------------------------------------------------------

async function renderPayrollLog(el) {
  var g = payGuard(); if (g) { el.innerHTML = g; return; }
  el.innerHTML = '<div class="loading">Loading…</div>';
  var runs = [];
  try { runs = await api('GET', '/payroll/runs'); } catch (e) {}

  var rows = (runs || []).map(function (r) {
    var owed = (Number(r.total_trueup) || 0) + (Number(r.total_ot) || 0);
    var pdf = r.pdf_key ? '<a style="color:var(--primary);cursor:pointer" onclick="openPayrollPdf(' + r.id + ')">Record</a>' : '<span style="color:var(--text-muted-color)">-</span>';
    var target = (r.status === 'draft') ? 'payroll-review' : 'payroll-results';
    return '<tr>' +
      '<td style="padding:11px 14px;font-family:\'Fira Code\',monospace"><a style="color:var(--text);cursor:pointer" onclick="navigate(\'' + target + '\',' + r.id + ')">' + escHtml(payPeriodShort(r)) + '</a></td>' +
      '<td style="padding:11px 14px;font-family:\'Fira Code\',monospace;color:var(--text-muted-color)">' + escHtml(String(r.filed_at || r.created_at || '').slice(0, 10)) + '</td>' +
      '<td style="padding:11px 14px">' + payChip(r.status_minwage) + '</td>' +
      '<td style="padding:11px 14px">' + payChip(r.status_ot) + '</td>' +
      '<td style="padding:11px 14px;text-align:right;font-family:\'Fira Code\',monospace">' + payMoney(owed) + '</td>' +
      '<td style="padding:11px 14px">' + pdf + '</td></tr>';
  }).join('');

  el.innerHTML =
    '<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
      '<div><div class="page-title">Compliance log</div><div class="page-subtitle" style="color:var(--text-muted-color)">Every period, clean or not. This is the retention record.</div></div>' +
      '<button class="btn btn-primary btn-sm" onclick="navigate(\'payroll-compliance\')">New check</button>' +
    '</div>' +
    '<div class="card" style="margin-top:14px"><div class="card-body" style="padding:0">' +
      (rows ? '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
        '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Pay period</th>' +
        '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Filed</th>' +
        '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Min wage</th>' +
        '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Overtime</th>' +
        '<th style="text-align:right;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Owed</th>' +
        '<th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;color:var(--text-muted-color)">Record</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="empty-state" style="padding:40px;text-align:center;color:var(--text-muted-color)">No runs yet. Start a Compliance Check.</div>') +
    '</div></div>';
}
