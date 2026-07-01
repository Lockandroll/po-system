/* PTO frontend module. Loaded after app.js; uses its globals: api(), state, can(),
   escHtml(), showToast(). One nav entry ('pto'); the sub-screens are internal tabs.
   Styles are namespaced with .pto- so they cannot collide with the rest of the app.
   No backticks in this file. */
(function () {
  'use strict';

  var HRS_PER_DAY = 8;
  var TAB = 'me';           // me | approvals | team | settings
  var CACHE = {};           // per-tab fetched data

  // ---- styles (injected once) ---------------------------------------------
  function injectStyles() {
    if (document.getElementById('pto-styles')) return;
    var css = [
      '.pto-wrap{max-width:1050px}',
      '.pto-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 16px}',
      '.pto-tab{padding:8px 14px;border-radius:999px;background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);color:var(--text-dim,#9a9a9a);cursor:pointer;font-weight:600;font-size:13px;user-select:none}',
      '.pto-tab:hover{color:var(--text,#ededed)}',
      '.pto-tab.active{background:var(--primary,#f97316);color:#0f0f0f;border-color:var(--primary,#f97316)}',
      '.pto-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}',
      '.pto-card{background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:14px;padding:15px}',
      '.pto-card h4{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim,#9a9a9a);font-weight:700}',
      '.pto-stat{font-size:26px;font-weight:800;letter-spacing:-.5px}',
      '.pto-stat.sm{font-size:17px}',
      '.pto-sub{color:var(--text-dim,#9a9a9a);font-size:12px;margin-top:2px}',
      '.pto-panel{background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:14px;padding:18px;margin-top:16px}',
      '.pto-panel h3{margin:0 0 2px;font-size:16px}',
      '.pto-desc{color:var(--text-dim,#9a9a9a);font-size:12px;margin-bottom:12px}',
      '.pto-row{display:flex;gap:12px;flex-wrap:wrap}',
      '.pto-row>div{flex:1;min-width:150px}',
      '.pto-label{display:block;font-size:12px;color:var(--text-dim,#9a9a9a);margin:10px 0 5px;font-weight:600}',
      '.pto-input,.pto-select,.pto-textarea{width:100%;background:var(--bg,#1f1f1f);border:1px solid var(--border,#2a2a2a);color:var(--text,#ededed);border-radius:9px;padding:10px 11px;font-size:14px;font-family:inherit;color-scheme:dark}',
      '.pto-input:focus,.pto-select:focus,.pto-textarea:focus{outline:none;border-color:var(--primary,#f97316)}',
      '.pto-btn{background:var(--primary,#f97316);color:#0f0f0f;border:none;border-radius:9px;padding:10px 16px;font-weight:700;cursor:pointer;font-size:14px}',
      '.pto-btn:disabled{opacity:.4;cursor:not-allowed}',
      '.pto-btn.ghost{background:transparent;color:var(--text,#ededed);border:1px solid var(--border,#2a2a2a)}',
      '.pto-btn.ok{background:#22c55e}',
      '.pto-btn.no{background:#ef4444;color:#fff}',
      '.pto-btn.sm{padding:6px 12px;font-size:12px}',
      '.pto-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700}',
      '.pto-pill.pending{background:rgba(234,179,8,.15);color:#eab308}',
      '.pto-pill.approved{background:rgba(34,197,94,.15);color:#22c55e}',
      '.pto-pill.denied,.pto-pill.cancelled{background:rgba(239,68,68,.15);color:#ef4444}',
      '.pto-pill.locked{background:rgba(59,130,246,.15);color:#3b82f6}',
      '.pto-table{width:100%;border-collapse:collapse;margin-top:6px}',
      '.pto-table th,.pto-table td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--border,#2a2a2a);font-size:13px;vertical-align:middle}',
      '.pto-table th{color:var(--text-dim,#9a9a9a);font-size:11px;text-transform:uppercase;letter-spacing:.5px}',
      '.pto-routebox{background:var(--bg,#1f1f1f);border:1px dashed var(--border,#3a3a3a);border-radius:10px;padding:12px 14px;margin-top:10px;font-size:13px}',
      '.pto-warn{color:#ef4444;font-weight:600;font-size:12px;margin-top:8px}',
      '.pto-mask{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:300;padding:16px}',
      '.pto-dlg{background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:14px;padding:20px;max-width:460px;width:100%}',
      '.pto-dlg h3{margin:0 0 4px;font-size:17px}',
      '.pto-flag{color:#eab308;font-size:11px;margin-top:8px}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'pto-styles'; s.textContent = css;
    document.head.appendChild(s);
  }

  // ---- date helpers --------------------------------------------------------
  function parseLocal(v) { if (!v) return null; var p = String(v).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function bizDays(a, b) {
    var s = parseLocal(a), e = parseLocal(b || a); if (!s || !e || e < s) return 0;
    var n = 0, d = new Date(s); while (d <= e) { var w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); } return n;
  }
  function fmtDate(v) { var d = parseLocal(v); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''; }
  function isCommission(pt) { return pt === 'commission'; }
  function unitLabel(pt) { return isCommission(pt) ? 'days' : 'hrs'; }
  function toUnit(hours, pt) { return isCommission(pt) ? (hours / HRS_PER_DAY) : hours; }
  function fmtAmt(hours, pt) { return toUnit(hours, pt).toFixed(1) + ' ' + unitLabel(pt); }
  function tierLabel(days) { if (days > 10) return 'CEO approval'; if (days > 5) return 'Supervisor + COO'; return 'Direct supervisor'; }

  // ---- shell + tab routing -------------------------------------------------
  window.renderPto = async function (content) {
    injectStyles();
    var manage = window.can && can('manage_pto');
    var tabs = [['me', 'My PTO']];
    if (manage) { tabs.push(['approvals', 'Approvals'], ['team', 'Team PTO'], ['settings', 'Settings']); }
    if (!manage && TAB !== 'me') TAB = 'me';
    var bar = '<div class="pto-tabs">' + tabs.map(function (t) {
      return '<div class="pto-tab' + (TAB === t[0] ? ' active' : '') + '" onclick="ptoGo(\'' + t[0] + '\')">' + t[1] + '</div>';
    }).join('') + '</div>';
    content.innerHTML = '<div class="pto-wrap"><h2 style="margin:0 0 14px">Time Off</h2>' + bar + '<div id="pto-body"><div class="loading">Loading…</div></div></div>';
    var body = document.getElementById('pto-body');
    try {
      if (TAB === 'me') await tabMe(body);
      else if (TAB === 'approvals') await tabApprovals(body);
      else if (TAB === 'team') await tabTeam(body);
      else if (TAB === 'settings') await tabSettings(body);
    } catch (e) {
      body.innerHTML = '<div class="alert alert-error">Could not load PTO (' + escHtml(e.message || 'error') + ').</div>';
    }
  };
  window.ptoGo = function (t) { TAB = t; renderPto(document.getElementById('content')); };
  function reload() { renderPto(document.getElementById('content')); }

  // ---- MY PTO --------------------------------------------------------------
  async function tabMe(body) {
    var me = await api('GET', '/pto/me'); CACHE.me = me;
    var pt = me.pay_type || 'hourly';
    var bal = Number(me.balance_hours) || 0;
    var accMonthlyHrs = Number(me.accrual_monthly_hours) || 0;
    var accStat = isCommission(pt) ? (accMonthlyHrs / HRS_PER_DAY).toFixed(2) + ' days' : accMonthlyHrs.toFixed(2) + ' hrs';
    var elig = me.eligible_now ? 'Cleared' : (me.eligible_date || '—');
    var rows = (me.requests || []).map(function (r) {
      var d = fmtDate(r.start_date) + (String(r.end_date).slice(0, 10) !== String(r.start_date).slice(0, 10) ? ' – ' + fmtDate(r.end_date) : '');
      var canCancel = (r.status === 'pending' || r.status === 'approved');
      return '<tr><td>' + d + '</td><td>' + r.business_days + '</td><td>' + escHtml(r.type || '') + '</td>' +
        '<td>' + (r.paid ? 'Paid' : 'Unpaid') + '</td>' +
        '<td><span class="pto-pill ' + escHtml(r.status) + '">' + escHtml(r.status) + '</span></td>' +
        '<td>' + (canCancel ? '<button class="pto-btn ghost sm" onclick="ptoCancel(' + r.id + ')">' + (r.status === 'approved' ? 'Request change' : 'Withdraw') + '</button>' : '') + '</td></tr>';
    }).join('');

    body.innerHTML =
      '<div class="pto-cards">' +
        '<div class="pto-card"><h4>Current Balance</h4><div class="pto-stat">' + toUnit(bal, pt).toFixed(1) + ' <span style="font-size:14px;color:var(--text-dim)">' + unitLabel(pt) + '</span></div><div class="pto-sub">' + (isCommission(pt) ? 'commission — tracked in days' : (bal / HRS_PER_DAY).toFixed(1) + ' days available') + '</div></div>' +
        '<div class="pto-card"><h4>Accrual Rate</h4><div class="pto-stat sm">' + accStat + '</div><div class="pto-sub">per month · ' + escHtml(String(me.tenure_years)) + ' yr tenure</div></div>' +
        '<div class="pto-card"><h4>Eligible To Use</h4><div class="pto-stat sm">' + escHtml(elig) + '</div><div class="pto-sub">' + (me.eligible_now ? 'past waiting period' : 'inside first 90 days') + '</div></div>' +
      '</div>' +
      '<div class="pto-panel">' +
        '<h3>Request Time Off</h3><div class="pto-desc">Pick your dates. You will see your balance after the request and who it routes to before you submit.</div>' +
        '<div class="pto-row">' +
          '<div><label class="pto-label">Start date</label><input type="date" id="pto-start" class="pto-input"></div>' +
          '<div><label class="pto-label">End date</label><input type="date" id="pto-end" class="pto-input"></div>' +
          '<div><label class="pto-label">Type</label><select id="pto-type" class="pto-select"><option>Vacation</option><option>Personal</option><option>Sick</option></select></div>' +
          '<div><label class="pto-label">Paid?</label><select id="pto-paid" class="pto-select"><option value="paid">Paid (uses balance)</option><option value="unpaid">Unpaid</option></select></div>' +
        '</div>' +
        '<div class="pto-routebox" id="pto-preview">Select dates to see the summary.</div>' +
        '<div class="pto-warn" id="pto-req-err" style="display:none"></div>' +
        '<div style="margin-top:14px"><button class="pto-btn" id="pto-submit">Submit Request</button></div>' +
      '</div>' +
      '<div class="pto-panel"><h3>My Requests</h3>' +
        '<table class="pto-table"><thead><tr><th>Dates</th><th>Days</th><th>Type</th><th>Pay</th><th>Status</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="pto-sub">No requests yet.</td></tr>') + '</tbody></table>' +
      '</div>';

    var sd = document.getElementById('pto-start'), ed = document.getElementById('pto-end');
    function preview() {
      var days = bizDays(sd.value, ed.value || sd.value);
      var paid = document.getElementById('pto-paid').value === 'paid';
      var pv = document.getElementById('pto-preview');
      if (!days) { pv.textContent = 'Select dates to see the summary.'; return; }
      var amt = days * HRS_PER_DAY;
      var after = bal - (paid ? amt : 0);
      pv.innerHTML = '<b>' + days + '</b> business day' + (days > 1 ? 's' : '') + ' · deducts <b>' + (paid ? fmtAmt(amt, pt) : '0 ' + unitLabel(pt)) + '</b> · balance after <b style="color:' + (after < 0 ? '#ef4444' : '#22c55e') + '">' + fmtAmt(after, pt) + '</b><br>Routes to: <b>' + escHtml(tierLabel(days)) + '</b>';
    }
    sd.onchange = ed.onchange = preview;
    document.getElementById('pto-paid').onchange = preview;
    document.getElementById('pto-submit').onclick = submitRequest;
  }

  async function submitRequest() {
    var err = document.getElementById('pto-req-err');
    var start = document.getElementById('pto-start').value;
    var end = document.getElementById('pto-end').value || start;
    if (!start) { err.textContent = 'Pick a start date.'; err.style.display = 'block'; return; }
    var body = { start_date: start, end_date: end, type: document.getElementById('pto-type').value, paid: document.getElementById('pto-paid').value === 'paid' };
    try {
      await api('POST', '/pto/requests', body);
      showToast('Request submitted — pending approval.', 'success');
      reload();
    } catch (e) {
      err.textContent = e.message || 'Could not submit.'; err.style.display = 'block';
    }
  }
  window.ptoCancel = async function (id) {
    try { var r = await api('POST', '/pto/requests/' + id + '/cancel', {}); showToast(r.status === 'cancel_requested' ? 'Change request sent to your approver.' : 'Request cancelled.', 'info'); reload(); }
    catch (e) { showToast(e.message || 'Could not cancel.', 'error'); }
  };

  // ---- APPROVALS -----------------------------------------------------------
  async function tabApprovals(body) {
    var list = await api('GET', '/pto/approvals'); CACHE.approvals = list;
    var rows = (list || []).map(function (r) {
      var d = fmtDate(r.start_date) + (String(r.end_date).slice(0, 10) !== String(r.start_date).slice(0, 10) ? ' – ' + fmtDate(r.end_date) : '');
      var cov = r.coverage_cap === null || r.coverage_cap === undefined ? '<span class="pto-sub">no cap</span>'
        : '<span class="pto-pill ' + (r.coverage_over ? 'denied' : 'approved') + '">' + (r.coverage_over ? '⚠ ' : '') + r.coverage_used + ' of ' + r.coverage_cap + '</span>';
      return '<tr><td><b>' + escHtml(r.user_name || '') + '</b><br><span class="pto-sub">' + escHtml(r.pay_type || '') + '</span></td>' +
        '<td>' + d + '</td><td>' + r.business_days + '</td><td>' + fmtAmt(Number(r.hours), r.pay_type) + '</td>' +
        '<td>' + cov + '</td>' +
        '<td style="white-space:nowrap"><button class="pto-btn ok sm" onclick="ptoApprove(' + r.id + ',' + (r.coverage_over ? 'true' : 'false') + ')">Approve</button> <button class="pto-btn no sm" onclick="ptoDeny(' + r.id + ')">Deny</button></td></tr>';
    }).join('');
    body.innerHTML = '<div class="pto-panel"><h3>Pending Approvals</h3><div class="pto-desc">Requests from your reporting line. Approving over the coverage cap requires a reason (logged to audit).</div>' +
      '<table class="pto-table"><thead><tr><th>Employee</th><th>Dates</th><th>Days</th><th>Amount</th><th>Coverage</th><th>Actions</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" class="pto-sub">Nothing pending. 🎉</td></tr>') + '</tbody></table></div>';
  }
  window.ptoApprove = function (id, over) {
    if (over) return openOverride(id);
    doApprove(id, '');
  };
  async function doApprove(id, reason) {
    try { await api('POST', '/pto/requests/' + id + '/approve', reason ? { override_reason: reason } : {}); showToast('Approved — shifts set to Approved Vacation Day.', 'success'); reload(); }
    catch (e) { if ((e.message || '').indexOf('coverage_override_required') !== -1) { openOverride(id); } else { showToast(e.message || 'Approve failed.', 'error'); } }
  }
  window.ptoDeny = async function (id) {
    var reason = window.prompt('Reason for denial (optional):', '') || '';
    try { await api('POST', '/pto/requests/' + id + '/deny', { reason: reason }); showToast('Request denied.', 'info'); reload(); }
    catch (e) { showToast(e.message || 'Deny failed.', 'error'); }
  };
  function openOverride(id) {
    var m = document.createElement('div'); m.className = 'pto-mask';
    m.innerHTML = '<div class="pto-dlg"><h3>Override — reason required</h3><div class="pto-desc">Approving this exceeds the coverage cap. A reason is required and will be logged to the audit trail.</div>' +
      '<textarea id="pto-ov-reason" class="pto-textarea" rows="3" placeholder="Why are you approving over the cap?"></textarea>' +
      '<div class="pto-warn" id="pto-ov-err" style="display:none">A reason is required.</div>' +
      '<div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end"><button class="pto-btn ghost" id="pto-ov-cancel">Cancel</button><button class="pto-btn ok" id="pto-ov-ok">Approve with reason</button></div></div>';
    document.body.appendChild(m);
    m.querySelector('#pto-ov-cancel').onclick = function () { document.body.removeChild(m); };
    m.querySelector('#pto-ov-ok').onclick = function () {
      var r = m.querySelector('#pto-ov-reason').value.trim();
      if (!r) { m.querySelector('#pto-ov-err').style.display = 'block'; return; }
      document.body.removeChild(m); doApprove(id, r);
    };
  }

  // ---- TEAM PTO ------------------------------------------------------------
  async function tabTeam(body) {
    var list = await api('GET', '/pto/team'); CACHE.team = list;
    var rows = (list || []).map(function (p) {
      var warn = p.hire_date ? '' : ' <span class="pto-flag">⚠ no hire date</span>';
      return '<tr><td><b>' + escHtml(p.name) + '</b>' + warn + '<br><span class="pto-sub">' + escHtml(p.title || '') + (p.exempt ? ' · exempt' : '') + '</span></td>' +
        '<td>' + escHtml(p.pay_type) + '</td><td><b>' + fmtAmt(Number(p.balance_hours), p.pay_type) + '</b></td>' +
        '<td>' + (p.pending ? fmtDate(p.pending) : '—') + '</td>' +
        '<td style="white-space:nowrap"><button class="pto-btn ghost sm" onclick="ptoLedger(' + p.id + ',this)">View ledger</button> <button class="pto-btn sm" onclick="ptoOpenLog(' + p.id + ')">Log PTO</button></td></tr>' +
        '<tr id="pto-led-' + p.id + '" style="display:none"><td colspan="5"></td></tr>';
    }).join('');
    body.innerHTML = '<div class="pto-panel"><h3>Team PTO</h3><div class="pto-desc">Read-only. Everyone in your reporting line. Click a person to view their append-only ledger.</div>' +
      '<table class="pto-table"><thead><tr><th>Employee</th><th>Pay</th><th>Balance</th><th>Pending</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="pto-sub">No one reports to you.</td></tr>') + '</tbody></table></div>';
  }
  window.ptoLedger = async function (id, btn) {
    var tr = document.getElementById('pto-led-' + id);
    if (tr.style.display !== 'none') { tr.style.display = 'none'; btn.textContent = 'View ledger'; return; }
    var pt = 'hourly'; (CACHE.team || []).forEach(function (p) { if (p.id === id) pt = p.pay_type; });
    try {
      var led = await api('GET', '/pto/team/' + id + '/ledger');
      var body = led.map(function (l) {
        var amt = Number(l.amount_hours);
        return '<tr><td style="width:80px">' + fmtDate(l.entry_date) + '</td><td>' + escHtml(l.description || l.kind) + '</td><td style="color:' + (amt >= 0 ? '#22c55e' : '#ef4444') + '">' + (amt >= 0 ? '+' : '') + fmtAmt(Math.abs(amt), pt).replace(unitLabel(pt), unitLabel(pt)) + '</td></tr>';
      }).join('');
      tr.querySelector('td').innerHTML = '<div style="background:var(--bg,#1f1f1f);border-radius:10px;padding:10px 12px"><div class="pto-sub" style="font-weight:700;margin-bottom:6px">PTO ledger (append-only)</div><table class="pto-table" style="margin:0"><thead><tr><th>Date</th><th>Entry</th><th>Change</th></tr></thead><tbody>' + (body || '<tr><td class="pto-sub">No entries.</td></tr>') + '</tbody></table></div>';
      tr.style.display = 'table-row'; btn.textContent = 'Hide ledger';
    } catch (e) { showToast(e.message || 'Could not load ledger.', 'error'); }
  };
  window.ptoOpenLog = function (id) {
    var person = null; (CACHE.team || []).forEach(function (p) { if (p.id === id) person = p; });
    var pt = person ? person.pay_type : 'hourly';
    var m = document.createElement('div'); m.className = 'pto-mask';
    m.innerHTML = '<div class="pto-dlg"><h3>Log PTO (after the fact)</h3><div class="pto-desc">For a call-out converted to PTO after the day passed. Records who logged it and why.</div>' +
      '<div class="pto-row"><div><label class="pto-label">Start (past)</label><input type="date" id="pto-log-s" class="pto-input"></div><div><label class="pto-label">End</label><input type="date" id="pto-log-e" class="pto-input"></div></div>' +
      '<label class="pto-label">Type</label><select id="pto-log-paid" class="pto-select"><option value="paid">Approved Vacation Day (paid)</option><option value="unpaid">Unpaid Vacation Day</option></select>' +
      '<label class="pto-label">Reason (required)</label><textarea id="pto-log-reason" class="pto-textarea" rows="2" placeholder="e.g. Called out sick, converting to PTO"></textarea>' +
      '<div class="pto-sub" id="pto-log-prev" style="margin-top:8px"></div>' +
      '<div class="pto-warn" id="pto-log-err" style="display:none"></div>' +
      '<div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end"><button class="pto-btn ghost" id="pto-log-cancel">Cancel</button><button class="pto-btn ok" id="pto-log-ok">Log PTO</button></div></div>';
    document.body.appendChild(m);
    var s = m.querySelector('#pto-log-s'), e = m.querySelector('#pto-log-e');
    function prev() {
      var days = bizDays(s.value, e.value || s.value); if (!days) { m.querySelector('#pto-log-prev').textContent = ''; return; }
      var paid = m.querySelector('#pto-log-paid').value === 'paid';
      var bal = person ? Number(person.balance_hours) : 0, after = bal - (paid ? days * HRS_PER_DAY : 0);
      m.querySelector('#pto-log-prev').innerHTML = 'Deducts <b>' + (paid ? fmtAmt(days * HRS_PER_DAY, pt) : '0 ' + unitLabel(pt)) + '</b> (' + days + ' business days) → after <b style="color:' + (after < 0 ? '#ef4444' : '#22c55e') + '">' + fmtAmt(after, pt) + '</b>';
    }
    s.onchange = e.onchange = prev; m.querySelector('#pto-log-paid').onchange = prev;
    m.querySelector('#pto-log-cancel').onclick = function () { document.body.removeChild(m); };
    m.querySelector('#pto-log-ok').onclick = async function () {
      var err = m.querySelector('#pto-log-err');
      var payload = { user_id: id, start_date: s.value, end_date: e.value || s.value, paid: m.querySelector('#pto-log-paid').value === 'paid', reason: m.querySelector('#pto-log-reason').value.trim() };
      if (!payload.start_date) { err.textContent = 'Pick the dates.'; err.style.display = 'block'; return; }
      if (!payload.reason) { err.textContent = 'A reason is required.'; err.style.display = 'block'; return; }
      try { await api('POST', '/pto/log', payload); document.body.removeChild(m); showToast('PTO logged.', 'success'); reload(); }
      catch (ex) { err.textContent = ex.message || 'Could not log.'; err.style.display = 'block'; }
    };
  };

  // (Per-user PTO setup lives on the Edit User form now — hire date + balance.)

  // ---- SETTINGS ------------------------------------------------------------
  var BANDS = [];
  async function tabSettings(body) {
    var s = await api('GET', '/pto/settings'); CACHE.settings = s;
    BANDS = (s.accrual_bands && s.accrual_bands.length) ? s.accrual_bands.slice() : [];
    var caps = s.coverage_caps || {};
    body.innerHTML = '<div class="pto-panel"><h3>PTO Accrual Policy</h3><div class="pto-desc">Company-wide. Each person\'s rate is picked from their time since hire date. Accrual posts monthly. 1 day = 8 hours.</div>' +
      '<table class="pto-table" id="pto-bands"><thead><tr><th style="width:100px">From (yrs)</th><th style="width:100px">To (yrs)</th><th>Days / year</th><th>Days / mo</th><th>Hrs / mo</th><th style="width:40px"></th></tr></thead><tbody></tbody></table>' +
      '<div style="margin-top:10px"><button class="pto-btn ghost sm" id="pto-band-add">+ Add band</button></div></div>' +
      '<div class="pto-panel"><h3>Eligibility &amp; Carryover</h3>' +
        '<div class="pto-row"><div><label class="pto-label">Waiting period (days)</label><input type="number" min="0" id="pto-wait" class="pto-input" value="' + (Number(s.waiting_days) || 90) + '"></div>' +
        '<div><label class="pto-label">Max carryover / year (days)</label><input type="number" min="0" step="0.5" id="pto-carry" class="pto-input" value="' + (s.carryover_days === null || s.carryover_days === undefined ? '' : escHtml(String(s.carryover_days))) + '" placeholder="blank = unlimited"></div>' +
        '<div><label class="pto-label">Balance cap (days)</label><input type="number" min="0" step="0.5" id="pto-cap" class="pto-input" value="' + (s.balance_cap_days === null || s.balance_cap_days === undefined ? '' : escHtml(String(s.balance_cap_days))) + '" placeholder="blank = none"></div></div></div>' +
      '<div class="pto-panel"><h3>Coverage Guardrails</h3><div class="pto-desc">Soft cap — approver can override with a reason. Max people on PTO per day.</div>' +
        '<div class="pto-row"><div><label class="pto-label">Default max on PTO / day</label><input type="number" min="0" id="pto-cov-def" class="pto-input" value="' + (s.coverage_default === null || s.coverage_default === undefined ? '' : escHtml(String(s.coverage_default))) + '" placeholder="blank = no cap"></div></div>' +
        '<div class="pto-flag">Per-market caps (by city code) are stored in pto_coverage_caps; the default applies when a market has none.</div></div>' +
      '<div style="margin-top:16px"><button class="pto-btn" id="pto-save">Save PTO Settings</button></div>';
    renderBands();
    document.getElementById('pto-band-add').onclick = function () { BANDS.push({ from: '', to: '', days_per_year: 0 }); renderBands(); };
    document.getElementById('pto-save').onclick = saveSettings;
  }
  function renderBands() {
    var tb = document.querySelector('#pto-bands tbody'); if (!tb) return; tb.innerHTML = '';
    BANDS.forEach(function (b, i) {
      var dpy = Number(b.days_per_year) || 0;
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><input type="number" min="0" step="0.5" class="pto-input" style="max-width:88px" value="' + (b.from === '' ? '' : b.from) + '" data-i="' + i + '" data-k="from"></td>' +
        '<td><input type="number" min="0" step="0.5" class="pto-input" style="max-width:88px" value="' + (b.to === null || b.to === undefined || b.to === '' ? '' : b.to) + '" placeholder="+ up" data-i="' + i + '" data-k="to"></td>' +
        '<td><input type="number" min="0" step="1" class="pto-input" style="max-width:88px" value="' + dpy + '" data-i="' + i + '" data-k="days_per_year"></td>' +
        '<td>' + (dpy / 12).toFixed(2) + '</td><td>' + (dpy * 8 / 12).toFixed(2) + '</td>' +
        '<td><button class="pto-btn no sm" data-del="' + i + '">✕</button></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('input').forEach(function (inp) {
      inp.oninput = function () {
        var i = +inp.dataset.i, k = inp.dataset.k; BANDS[i][k] = inp.value === '' ? '' : (+inp.value);
        var dpy = Number(BANDS[i].days_per_year) || 0, c = inp.closest('tr').querySelectorAll('td');
        c[3].textContent = (dpy / 12).toFixed(2); c[4].textContent = (dpy * 8 / 12).toFixed(2);
      };
    });
    tb.querySelectorAll('[data-del]').forEach(function (bt) { bt.onclick = function () { BANDS.splice(+bt.dataset.del, 1); renderBands(); }; });
  }
  async function saveSettings() {
    var carry = document.getElementById('pto-carry').value, cap = document.getElementById('pto-cap').value, covd = document.getElementById('pto-cov-def').value;
    var payload = {
      accrual_bands: BANDS.map(function (b) { return { from: Number(b.from) || 0, to: (b.to === '' || b.to === null || b.to === undefined) ? null : Number(b.to), days_per_year: Number(b.days_per_year) || 0 }; }),
      waiting_days: Number(document.getElementById('pto-wait').value) || 0,
      carryover_days: carry === '' ? null : Number(carry),
      balance_cap_days: cap === '' ? null : Number(cap),
      coverage_default: covd === '' ? null : Number(covd)
    };
    try { await api('PUT', '/pto/settings', payload); showToast('PTO settings saved.', 'success'); }
    catch (e) { showToast(e.message || 'Save failed.', 'error'); }
  }
})();
