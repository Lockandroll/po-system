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
      '.pto-pill.cancel_offered,.pto-pill.cancel_requested{background:rgba(168,85,247,.15);color:#a855f7}',
      '.pto-table{width:100%;border-collapse:collapse;margin-top:6px}',
      '.pto-table th,.pto-table td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--border,#2a2a2a);font-size:13px;vertical-align:middle}',
      '.pto-table th{color:var(--text-dim,#9a9a9a);font-size:11px;text-transform:uppercase;letter-spacing:.5px}',
      '.pto-routebox{background:var(--bg,#1f1f1f);border:1px dashed var(--border,#3a3a3a);border-radius:10px;padding:12px 14px;margin-top:10px;font-size:13px}',
      '.pto-warn{color:#ef4444;font-weight:600;font-size:12px;margin-top:8px}',
      '.pto-mask{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:300;padding:16px}',
      '.pto-dlg{background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:14px;padding:20px;max-width:460px;width:100%}',
      '.pto-dlg h3{margin:0 0 4px;font-size:17px}',
      '.pto-flag{color:#eab308;font-size:11px;margin-top:8px}',
      '.pto-daylist{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto;margin:4px 0;padding:2px}',
      '.pto-daytag{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--bg,#1f1f1f);border:1px solid var(--border,#2a2a2a);border-radius:9px;padding:7px 10px}',
      '.pto-dayname{font-size:13px;font-weight:600}',
      '.pto-daysel{max-width:172px}',
      '.pto-daysel.k-off{color:#9ca3af}',
      '.pto-daysel.k-unpaid{color:#eab308}',
      '.pto-dayctl{display:flex;align-items:center;gap:6px}',
      '.pto-dayhrs{max-width:78px;text-align:right}',
      '.pto-dayhrs.hidden{visibility:hidden}',
      '.pto-hrsunit{font-size:11px;color:var(--text-dim,#9a9a9a)}',
      '.pto-hrsunit.hidden{visibility:hidden}',
      // Approval detail dialog. Wider than .pto-dlg because it carries a
      // three-week schedule grid; scrolls internally so the page behind stays put.
      '.pto-dlg.wide{max-width:920px;max-height:86vh;overflow:auto}',
      '.pto-clickable{cursor:pointer}',
      '.pto-clickable:hover>td{background:rgba(255,255,255,.035)}',
      '.pto-clickable:focus-visible{outline:2px solid var(--primary,#f97316);outline-offset:-2px}',
      '.pto-neg{color:#ef4444;font-weight:700}',
      '.pto-pos{color:#22c55e;font-weight:700}',
      '.pto-sec{margin-top:18px;padding-top:14px;border-top:1px solid var(--border,#2a2a2a)}',
      '.pto-sec:first-child{margin-top:0;padding-top:0;border-top:none}',
      '.pto-sec h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim,#9a9a9a);font-weight:700}',
      '.pto-wk{margin-bottom:14px}',
      '.pto-wk-hd{font-size:12px;font-weight:700;color:var(--text-dim,#9a9a9a);margin-bottom:6px}',
      '.pto-wk-hd.is-req{color:var(--primary,#f97316)}',
      '.pto-days{display:flex;gap:5px;overflow-x:auto;padding-bottom:4px}',
      // flex-basis 0 so the seven columns share the width evenly instead of the
      // last one clipping off the right edge; min-width is the point at which
      // the week starts scrolling rather than squashing.
      '.pto-day{flex:1 1 0;min-width:96px;border-radius:7px;padding:0 4px 4px;border:1px solid transparent}',
      '.pto-day-hd{font-weight:700;font-size:11px;padding:4px;margin-bottom:5px;border-bottom:1px solid var(--border,#2a2a2a);white-space:nowrap}',
      // A requested day is the whole point of this grid, so it gets the entire
      // column: tinted ground, a solid border, and a label saying what kind of
      // day it is. Tinting only the header text made them easy to scroll past.
      '.pto-day.req{background:rgba(249,115,22,.11);border-color:rgba(249,115,22,.55)}',
      '.pto-day.req .pto-day-hd{color:var(--primary,#f97316);border-bottom-color:rgba(249,115,22,.45)}',
      '.pto-day-tag{display:block;font-size:9.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:2px 4px;margin:0 -4px 5px;border-radius:4px;text-align:center}',
      '.pto-day-tag.k-paid{background:rgba(249,115,22,.9);color:#0f0f0f}',
      '.pto-day-tag.k-unpaid{background:rgba(234,179,8,.9);color:#0f0f0f}',
      '.pto-day-tag.k-off{background:rgba(156,163,175,.85);color:#0f0f0f}',
      '.pto-day-sel{display:block;width:100%;margin:0 0 5px;padding:2px 3px;border-radius:4px;border:none;font-size:9.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;text-align:center;cursor:pointer;font-family:inherit;color-scheme:dark;appearance:none;-webkit-appearance:none}',
      '.pto-day-sel.k-paid{background:rgba(249,115,22,.9);color:#0f0f0f}',
      '.pto-day-sel.k-unpaid{background:rgba(234,179,8,.9);color:#0f0f0f}',
      '.pto-day-sel.k-off{background:rgba(156,163,175,.85);color:#0f0f0f}',
      '.pto-day-sel.moved{outline:2px solid #fff;outline-offset:-2px}',
      '.pto-day-hrs{display:block;width:100%;margin:0 0 5px;padding:2px 3px;border-radius:4px;border:1px solid var(--border,#3a3a3a);background:var(--bg,#1f1f1f);color:inherit;font-size:10.5px;font-weight:700;text-align:center;font-family:inherit;color-scheme:dark}',
      '.pto-day-hrs.hidden{display:none}',
      '.pto-day-hrs.moved{outline:2px solid #fff;outline-offset:-2px}',
      '.pto-day.moved{border-color:#fff}',
      '.pto-retag{margin-top:8px;font-size:12.5px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.06);border:1px solid var(--border,#2a2a2a)}',
      '.pto-day.today .pto-day-hd{text-decoration:underline}',
      '.pto-reqline{font-size:13px;margin:0 0 10px;padding:8px 10px;border-radius:8px;background:rgba(249,115,22,.1);border:1px solid rgba(249,115,22,.45)}',
      '.pto-reqline b{color:var(--primary,#f97316)}',
      '.pto-key{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 10px;font-size:11px;color:var(--text-dim,#9a9a9a)}',
      '.pto-key i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px;font-style:normal}',
      '.pto-chip{border:1px solid var(--border,#2a2a2a);border-radius:6px;padding:4px 5px;margin-bottom:5px;font-size:11px;line-height:1.3;overflow-wrap:anywhere}',
      '.pto-chip.me{outline:2px solid var(--primary,#f97316);outline-offset:-1px}',
      '.pto-chip b{display:block;font-size:11px}',
      '.pto-chip .m{color:var(--text-dim,#9a9a9a);font-size:10.5px}',
      '.pto-empty{color:var(--text-dim,#777);font-size:11px;padding:3px 4px}'
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
  // 'Mon Aug 24'. The weekday is what an approver actually reasons about when
  // judging coverage, and a bare date makes them count on their fingers.
  function fmtDayDate(v) {
    var d = parseLocal(v);
    return d ? d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + fmtDate(v) : '';
  }
  // Local-date string arithmetic for the detail dialog's schedule grid. Mirrors
  // the server's addDaysStr/mondayOfStr, but built on local dates so the grid
  // lines up with what the approver sees everywhere else in the app.
  function addDaysLocal(dateStr, n) {
    var d = parseLocal(dateStr); if (!d) return dateStr;
    d.setDate(d.getDate() + n); return ymdLocal(d);
  }
  function mondayLocal(dateStr) {
    var d = parseLocal(dateStr); if (!d) return dateStr;
    var w = d.getDay(); // 0=Sun..6=Sat
    return addDaysLocal(dateStr, -(w === 0 ? 6 : w - 1));
  }
  // Compact 'Sep 7 – Sep 9', collapsing to one date for a single-day range.
  function rangeShort(a, b) {
    return String(b).slice(0, 10) === String(a).slice(0, 10) ? fmtDate(a) : fmtDate(a) + ' \u2013 ' + fmtDate(b);
  }
  function isCommission(pt) { return pt === 'commission'; }
  function unitLabel(pt) { return isCommission(pt) ? 'days' : 'hrs'; }
  function toUnit(hours, pt) { return isCommission(pt) ? (hours / HRS_PER_DAY) : hours; }
  function fmtAmt(hours, pt) { return toUnit(hours, pt).toFixed(1) + ' ' + unitLabel(pt); }
  function tierLabel(days) { if (days > 10) return 'CEO approval'; if (days > 5) return 'Supervisor + COO'; return 'Direct supervisor'; }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function ymdLocal(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  // Every calendar date string in [a,b] inclusive (weekends included — 24/7 crew).
  function eachDayList(a, b) {
    var s = parseLocal(a), e = parseLocal(b || a), out = [];
    if (!s || !e || e < s) return out;
    var d = new Date(s); while (d <= e) { out.push(ymdLocal(d)); d.setDate(d.getDate() + 1); } return out;
  }
  // Read the per-day tag selects out of the request form as [{date, kind, hours}].
  // hours is only meaningful on a paid day; 0 on a paid day means the box was left
  // blank or nonsense, which submitRequest refuses rather than charging a full 8.
  function collectDaysFromDom() {
    var out = [], sels = document.querySelectorAll('#pto-daygrid .pto-daysel');
    for (var i = 0; i < sels.length; i++) {
      var dt = sels[i].getAttribute('data-date');
      var kind = sels[i].value;
      var box = document.querySelector('#pto-daygrid .pto-dayhrs[data-hrs="' + dt + '"]');
      var h = box ? Number(box.value) : HRS_PER_DAY;
      if (!isFinite(h) || h <= 0) h = 0;
      out.push({ date: dt, kind: kind, hours: kind === 'paid' ? h : 0 });
    }
    return out;
  }
  // Total a set of tagged days costs. Only paid days spend balance.
  function paidHoursOf(days) {
    var t = 0;
    (days || []).forEach(function (x) { if (x.kind === 'paid') t += (Number(x.hours) > 0 ? Number(x.hours) : 0); });
    return Math.round(t * 100) / 100;
  }
  function hrsText(h) { return (Math.round(Number(h) * 10) / 10).toFixed(1) + 'h'; }
  // Commission staff are tracked in DAYS — balance, awards and reports are all in
  // days — so part days are for hourly and salary people only. Tony's call,
  // 2026-08-24. The server enforces the same rule; this only keeps the box off
  // the screen for someone who could not use it.
  function takesPartDays(pt) { return !isCommission(pt); }
  // Human summary of a request's day mix, with a fallback for legacy rows.
  function dayBreakdown(r) {
    var p = Number(r.paid_days) || 0, u = Number(r.unpaid_days) || 0, o = Number(r.off_days) || 0;
    if (!p && !u && !o) { var bd = Number(r.business_days) || 0; return bd + (r.paid ? ' paid' : ' unpaid'); }
    var parts = [];
    if (p) parts.push(p + ' paid');
    if (u) parts.push(u + ' unpaid');
    if (o) parts.push(o + ' off');
    return parts.join(' · ') || '0';
  }
  function statusText(s) {
    if (s === 'cancel_offered') return 'cancel \u2014 needs your OK';
    if (s === 'cancel_requested') return 'cancel requested';
    return s;
  }

  // ---- shell + tab routing -------------------------------------------------
  window.renderPto = async function (content) {
    injectStyles();
    var manage = window.can && can('manage_pto');
    var tabs = [['me', 'My PTO']];
    if (manage) { tabs.push(['approvals', 'Approvals'], ['cancellations', 'Cancellations'], ['team', 'Team PTO'], ['settings', 'Settings']); }
    if (!manage && TAB !== 'me') TAB = 'me';
    var bar = '<div class="pto-tabs">' + tabs.map(function (t) {
      return '<div class="pto-tab' + (TAB === t[0] ? ' active' : '') + '" onclick="ptoGo(\'' + t[0] + '\')">' + t[1] + '</div>';
    }).join('') + '</div>';
    content.innerHTML = '<div class="pto-wrap"><h2 style="margin:0 0 14px">Time Off</h2>' + bar + '<div id="pto-body"><div class="loading">Loading…</div></div></div>';
    var body = document.getElementById('pto-body');
    try {
      if (TAB === 'me') await tabMe(body);
      else if (TAB === 'approvals') await tabApprovals(body);
      else if (TAB === 'cancellations') await tabCancellations(body);
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
      var act = '';
      if (r.status === 'cancel_offered') {
        act = '<button class="pto-btn ok sm" onclick="ptoCancelAccept(' + r.id + ')">Accept cancel</button> <button class="pto-btn no sm" onclick="ptoCancelDecline(' + r.id + ')">Keep my PTO</button>';
      } else if (r.status === 'pending' || r.status === 'approved') {
        act = '<button class="pto-btn ghost sm" onclick="ptoCancel(' + r.id + ')">' + (r.status === 'approved' ? 'Request change' : 'Withdraw') + '</button>';
      }
      var memo = (r.status === 'cancel_offered' && r.cancel_memo) ? '<br><span class="pto-sub">' + escHtml(r.cancel_by_name || 'Manager') + ' wants to cancel: ' + escHtml(r.cancel_memo) + '</span>' : '';
      var usesTxt = Number(r.hours) > 0 ? fmtAmt(Number(r.hours), pt) : '<span class="pto-sub">—</span>';
      return '<tr><td>' + d + memo + '</td><td>' + dayBreakdown(r) + '</td><td>' + escHtml(r.type || '') + '</td>' +
        '<td>' + usesTxt + '</td>' +
        '<td><span class="pto-pill ' + escHtml(r.status) + '">' + escHtml(statusText(r.status)) + '</span></td>' +
        '<td>' + act + '</td></tr>';
    }).join('');

    body.innerHTML =
      '<div class="pto-cards">' +
        '<div class="pto-card"><h4>Current Balance</h4><div class="pto-stat">' + toUnit(bal, pt).toFixed(1) + ' <span style="font-size:14px;color:var(--text-dim)">' + unitLabel(pt) + '</span></div><div class="pto-sub">' + (isCommission(pt) ? 'commission — tracked in days' : (bal / HRS_PER_DAY).toFixed(1) + ' days available') + '</div></div>' +
        '<div class="pto-card"><h4>Accrual Rate</h4><div class="pto-stat sm">' + accStat + '</div><div class="pto-sub">per month · ' + escHtml(String(me.tenure_years)) + ' yr tenure</div></div>' +
        '<div class="pto-card"><h4>Eligible To Use</h4><div class="pto-stat sm">' + escHtml(elig) + '</div><div class="pto-sub">' + (me.eligible_now ? 'past waiting period' : 'inside first 90 days') + '</div></div>' +
      '</div>' +
      '<div class="pto-panel">' +
        '<h3>Request Time Off</h3><div class="pto-desc">Pick your dates, then mark each day Paid, Unpaid, or a regular scheduled day off. ' +
        (takesPartDays(pt)
          ? 'A paid day defaults to a full 8 hours \u2014 change it to take part of a day, down to a tenth of an hour. '
          : 'Your PTO is tracked in whole days. ') +
        'Only paid days use your balance.</div>' +
        '<div class="pto-row">' +
          '<div><label class="pto-label">Start date</label><input type="date" id="pto-start" class="pto-input"></div>' +
          '<div><label class="pto-label">End date</label><input type="date" id="pto-end" class="pto-input"></div>' +
          '<div><label class="pto-label">Type</label><select id="pto-type" class="pto-select"><option>Vacation</option><option>Personal</option><option>Sick</option></select></div>' +
        '</div>' +
        '<div id="pto-daygrid"></div>' +
        '<div class="pto-routebox" id="pto-preview">Select dates to see the summary.</div>' +
        '<div class="pto-warn" id="pto-req-err" style="display:none"></div>' +
        '<div style="margin-top:14px"><button class="pto-btn" id="pto-submit">Submit Request</button></div>' +
      '</div>' +
      '<div class="pto-panel"><h3>PTO Projection</h3><div class="pto-desc">Estimate how much PTO you will have banked by a future date, based on your current balance and accrual rate. Approved time off is already reflected in your balance.</div>' +
        '<div class="pto-row"><div><label class="pto-label">Project to date</label><input type="date" id="pto-proj-date" class="pto-input"></div></div>' +
        '<div class="pto-routebox" id="pto-proj-out">Pick a date to see your projected balance.</div>' +
      '</div>' +
      '<div class="pto-panel"><h3>My Requests</h3>' +
        '<table class="pto-table"><thead><tr><th>Dates</th><th>Days</th><th>Type</th><th>Uses</th><th>Status</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="pto-sub">No requests yet.</td></tr>') + '</tbody></table>' +
      '</div>';

    var sd = document.getElementById('pto-start'), ed = document.getElementById('pto-end');
    var dayKinds = {}; // date -> kind, remembered across grid rebuilds
    var dayHrs = {};   // date -> hours on a paid day, likewise remembered
    var partDays = takesPartDays(pt); // commission staff get no hours boxes at all
    function selClass(k) { return 'pto-select pto-daysel' + (k === 'off' ? ' k-off' : (k === 'unpaid' ? ' k-unpaid' : '')); }
    function buildGrid() {
      var grid = document.getElementById('pto-daygrid');
      var list = sd.value ? eachDayList(sd.value, ed.value || sd.value) : [];
      if (!list.length) { grid.innerHTML = ''; preview(); return; }
      if (list.length > 62) { grid.innerHTML = '<div class="pto-warn" style="display:block">That is a long stretch — please request up to about two months at a time.</div>'; preview(); return; }
      var rowsHtml = list.map(function (dt) {
        var k = dayKinds[dt] || 'paid';
        var hv = (dayHrs[dt] === undefined || dayHrs[dt] === '') ? HRS_PER_DAY : dayHrs[dt];
        var dow = parseLocal(dt).toLocaleDateString('en-US', { weekday: 'short' });
        var hoursCtl = partDays
          ? '<input type="number" class="pto-input pto-dayhrs' + (k === 'paid' ? '' : ' hidden') + '" data-hrs="' + dt + '" ' +
              'min="0.1" step="0.1" value="' + hv + '" aria-label="Hours of PTO on ' + escHtml(fmtDate(dt)) + '">' +
            '<span class="pto-hrsunit' + (k === 'paid' ? '' : ' hidden') + '" data-unit="' + dt + '">hrs</span>'
          : '';
        return '<div class="pto-daytag"><span class="pto-dayname">' + dow + ' ' + fmtDate(dt) + '</span>' +
          '<span class="pto-dayctl">' + hoursCtl +
          '<select class="' + selClass(k) + '" data-date="' + dt + '">' +
          '<option value="paid"' + (k === 'paid' ? ' selected' : '') + '>Paid</option>' +
          '<option value="unpaid"' + (k === 'unpaid' ? ' selected' : '') + '>Unpaid</option>' +
          '<option value="off"' + (k === 'off' ? ' selected' : '') + '>Scheduled off</option>' +
          '</select></span></div>';
      }).join('');
      grid.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px"><label class="pto-label" style="margin:0">Mark each day' + (partDays ? ' \u00b7 hours are editable on paid days' : '') + '</label>' +
        '<span style="display:flex;gap:6px"><button type="button" class="pto-btn ghost sm" id="pto-all-paid">All paid</button><button type="button" class="pto-btn ghost sm" id="pto-all-off">All off</button></span></div>' +
        '<div class="pto-daylist">' + rowsHtml + '</div>';
      var sels = grid.querySelectorAll('.pto-daysel');
      for (var i = 0; i < sels.length; i++) {
        sels[i].onchange = function () {
          var dt2 = this.getAttribute('data-date');
          dayKinds[dt2] = this.value;
          this.className = selClass(this.value);
          // The hours box belongs to a paid day only: an unpaid or scheduled-off
          // day costs nothing, so leaving an amount showing there would be a lie.
          var box = grid.querySelector('.pto-dayhrs[data-hrs="' + dt2 + '"]');
          var unit = grid.querySelector('.pto-hrsunit[data-unit="' + dt2 + '"]');
          if (box) box.className = 'pto-input pto-dayhrs' + (this.value === 'paid' ? '' : ' hidden');
          if (unit) unit.className = 'pto-hrsunit' + (this.value === 'paid' ? '' : ' hidden');
          preview();
        };
      }
      var hbs = grid.querySelectorAll('.pto-dayhrs');
      for (var j = 0; j < hbs.length; j++) {
        hbs[j].oninput = function () { dayHrs[this.getAttribute('data-hrs')] = this.value === '' ? '' : Number(this.value); preview(); };
      }
      var ap = document.getElementById('pto-all-paid'); if (ap) ap.onclick = function () { list.forEach(function (dt) { dayKinds[dt] = 'paid'; }); buildGrid(); };
      var ao = document.getElementById('pto-all-off'); if (ao) ao.onclick = function () { list.forEach(function (dt) { dayKinds[dt] = 'off'; }); buildGrid(); };
      preview();
    }
    function preview() {
      var pv = document.getElementById('pto-preview');
      var days = collectDaysFromDom();
      if (!days.length) { pv.textContent = 'Select dates to see the summary.'; return; }
      var paidN = 0, unpaidN = 0, offN = 0, partial = 0, blank = 0;
      days.forEach(function (x) {
        if (x.kind === 'unpaid') unpaidN++;
        else if (x.kind === 'off') offN++;
        else {
          paidN++;
          if (!(Number(x.hours) > 0)) blank++;
          else if (Number(x.hours) !== HRS_PER_DAY) partial++;
        }
      });
      var amt = paidHoursOf(days), after = bal - amt, away = paidN + unpaidN;
      var parts = ['<b>' + paidN + '</b> paid'];
      if (unpaidN) parts.push('<b>' + unpaidN + '</b> unpaid');
      if (offN) parts.push('<b>' + offN + '</b> scheduled off');
      // A partial day still costs a whole day of coverage, so say it once rather
      // than letting someone read a 3-hour ask as easier to get approved.
      var note = partial ? '<br><span class="pto-sub">' + partial + ' partial day' + (partial === 1 ? '' : 's') +
        ' \u2014 a part day still counts as a day away for scheduling.</span>' : '';
      if (blank) note += '<br><span style="color:#ef4444">Enter hours greater than 0 on every paid day.</span>';
      pv.innerHTML = parts.join(' · ') + ' · uses <b>' + fmtAmt(amt, pt) + '</b> · balance after <b style="color:' + (after < 0 ? '#ef4444' : '#22c55e') + '">' + fmtAmt(after, pt) + '</b><br>Routes to: <b>' + escHtml(tierLabel(away)) + '</b>' + note;
    }
    sd.onchange = ed.onchange = buildGrid;
    document.getElementById('pto-submit').onclick = submitRequest;

    // Projection: the server runs the accurate forward simulation (accrual band
    // step-ups at anniversaries, the tiered accrual cap, and anniversary rollover)
    // so this matches exactly what the real accrual job will do to the balance.
    var pd = document.getElementById('pto-proj-date');
    var projBusy = false;
    async function projPreview() {
      var out = document.getElementById('pto-proj-out');
      if (!pd.value) { out.textContent = 'Pick a date to see your projected balance.'; return; }
      var t = parseLocal(pd.value), today = new Date(); today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      if (t <= today) { out.innerHTML = 'Pick a date in the future.'; return; }
      if (projBusy) return;
      projBusy = true;
      out.textContent = 'Calculating\u2026';
      try {
        var r = await api('GET', '/pto/project?date=' + encodeURIComponent(pd.value));
        var start = Number(r.start_balance_hours) || 0;
        var projected = Number(r.projected_hours) || 0;
        var added = Number(r.accrued_hours) || 0;
        var forfeited = Number(r.forfeited_hours) || 0;
        var html = 'By <b>' + fmtDate(pd.value) + '</b> you will have about <b style="color:#22c55e">' + fmtAmt(projected, pt) + '</b>.' +
          '<br><span class="pto-sub">Now <b>' + fmtAmt(start, pt) + '</b> + ' + r.months + ' month' + (r.months === 1 ? '' : 's') + ' of accrual (<b>' + fmtAmt(added, pt) + '</b>)';
        if (forfeited > 0) html += ' \u2212 <b>' + fmtAmt(forfeited, pt) + '</b> forfeited at anniversary rollover';
        html += '. ';
        if (!r.accrues) html += (r.exempt ? 'Your role does not accrue PTO. ' : 'No hire date on file, so no accrual is projected. ');
        else if (r.hit_cap) html += 'Reaches the accrual cap \u2014 accrual stops there. ';
        html += 'Excludes any pending requests.</span>';
        out.innerHTML = html;
      } catch (e) {
        out.innerHTML = '<span style="color:#ef4444">Could not calculate projection. Please try again.</span>';
      } finally {
        projBusy = false;
      }
    }
    pd.onchange = projPreview;
  }

  async function submitRequest() {
    var err = document.getElementById('pto-req-err');
    var start = document.getElementById('pto-start').value;
    if (!start) { err.textContent = 'Pick a start date.'; err.style.display = 'block'; return; }
    var days = collectDaysFromDom();
    if (!days.length) { err.textContent = 'Pick your dates.'; err.style.display = 'block'; return; }
    var badDay = null;
    days.forEach(function (x) { if (!badDay && x.kind === 'paid' && !(Number(x.hours) > 0)) badDay = x.date; });
    if (badDay) { err.textContent = 'Enter hours greater than 0 for ' + fmtDate(badDay) + ', or mark that day unpaid or scheduled off.'; err.style.display = 'block'; return; }
    var body = { type: document.getElementById('pto-type').value, days: days, start_date: days[0].date, end_date: days[days.length - 1].date };
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
  window.ptoCancelAccept = async function (id) {
    if (!window.confirm('Accept this cancellation? Your time off will be removed and any hours restored to your balance.')) return;
    try { await api('POST', '/pto/requests/' + id + '/cancel-respond', { accept: true }); showToast('Cancellation accepted — hours restored.', 'success'); reload(); }
    catch (e) { showToast(e.message || 'Failed.', 'error'); }
  };
  window.ptoCancelDecline = async function (id) {
    try { await api('POST', '/pto/requests/' + id + '/cancel-respond', { accept: false }); showToast('Declined — your PTO stays approved.', 'info'); reload(); }
    catch (e) { showToast(e.message || 'Failed.', 'error'); }
  };

  // ---- APPROVALS -----------------------------------------------------------
  async function tabApprovals(body) {
    var list = await api('GET', '/pto/approvals'); CACHE.approvals = list;
    var rows = (list || []).map(function (r) {
      var d = fmtDate(r.start_date) + (String(r.end_date).slice(0, 10) !== String(r.start_date).slice(0, 10) ? ' – ' + fmtDate(r.end_date) : '');
      var cov = r.coverage_cap === null || r.coverage_cap === undefined ? '<span class="pto-sub">no cap</span>'
        : '<span class="pto-pill ' + (r.coverage_over ? 'denied' : 'approved') + '">' + (r.coverage_over ? '⚠ ' : '') + r.coverage_used + ' of ' + r.coverage_cap + '</span>';
      var isCancel = r.status === 'cancel_requested';
      var acts = isCancel
        ? '<button class="pto-btn ok sm" onclick="ptoCancelConfirm(' + r.id + ')">Approve cancellation</button> <button class="pto-btn no sm" onclick="ptoCancelKeep(' + r.id + ')">Keep approved</button>'
        : '<button class="pto-btn ok sm" onclick="ptoApprove(' + r.id + ',' + (r.coverage_over ? 'true' : 'false') + ')">Approve</button> <button class="pto-btn no sm" onclick="ptoDeny(' + r.id + ')">Deny</button>';
      return '<tr class="pto-clickable" tabindex="0" role="button" data-pto-open="' + r.id + '" ' +
        'aria-label="Open details for ' + escHtml(r.user_name || 'this request') + '">' +
        '<td><b>' + escHtml(r.user_name || '') + '</b>' + (isCancel ? ' <span class="pto-pill denied">CANCELLATION</span>' : '') + '<br><span class="pto-sub">' + escHtml(r.pay_type || '') + '</span></td>' +
        '<td>' + d + '</td><td>' + dayBreakdown(r) + '</td><td>' + fmtAmt(Number(r.hours), r.pay_type) + '</td>' +
        '<td>' + balanceCell(r) + '</td>' +
        '<td>' + cov + '</td>' +
        '<td style="white-space:nowrap">' + acts + '</td></tr>';
    }).join('');
    body.innerHTML = '<div class="pto-panel"><h3>Pending Approvals</h3><div class="pto-desc">Requests from your reporting line. Click a row for the employee&#39;s PTO history and the city schedule. Approving over the coverage cap requires a reason (logged to audit).</div>' +
      '<table class="pto-table"><thead><tr><th>Employee</th><th>Dates</th><th>Days</th><th>Amount</th><th>Balance</th><th>Coverage</th><th>Actions</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7" class="pto-sub">Nothing pending. 🎉</td></tr>') + '</tbody></table></div>' +
      '<div class="pto-panel"><h3>Approved</h3><div class="pto-desc">Time off you have approved, newest first.</div>' +
      '<div id="pto-appr-list"><div class="loading">Loading…</div></div></div>';
    wireRowOpen(body);
    loadApproved(1);
  }

  // Balance preview for a queue row. r.hours is paid-days-only, so an unpaid or
  // scheduled-off request reads "no charge" rather than a misleading 0.0.
  function balanceCell(r) {
    var pt = r.pay_type;
    var bal = Number(r.balance_hours);
    if (!isFinite(bal)) return '<span class="pto-sub">—</span>';
    var cost = Number(r.cost_hours) || 0;
    if (cost <= 0) return '<b>' + fmtAmt(bal, pt) + '</b><br><span class="pto-sub">no charge</span>';
    var after = Number(r.balance_after);
    var cls = r.insufficient ? 'pto-neg' : '';
    return '<b>' + fmtAmt(bal, pt) + '</b><br><span class="pto-sub">&rarr; <span class="' + cls + '">' +
      (r.insufficient ? '\u26a0 ' : '') + fmtAmt(after, pt) + '</span> after</span>';
  }

  // Row opens the detail dialog, but a click that lands on a button must still be
  // just that button — the approver should never have to close a dialog they did
  // not ask for. Enter/Space open it too, so the row is reachable by keyboard.
  function wireRowOpen(root) {
    var rows = (root || document).querySelectorAll('[data-pto-open]');
    for (var i = 0; i < rows.length; i++) {
      (function (tr) {
        var id = parseInt(tr.getAttribute('data-pto-open'), 10) || 0;
        tr.addEventListener('click', function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest('button,a,input,select,textarea')) return;
          window.ptoDetail(id);
        });
        tr.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
          if (ev.target && ev.target.closest && ev.target.closest('button,a,input,select,textarea')) return;
          ev.preventDefault();
          window.ptoDetail(id);
        });
      })(rows[i]);
    }
  }

  // ---- APPROVED HISTORY (paginated, 10 per page) ---------------------------
  var APPR_PAGE = 1;
  // Badge + memo for a PTO row that was approved over the coverage cap.
  // Returns '' for an ordinary approval so normal rows stay clean.
  function overrideNote(r) {
    if (!r || !r.coverage_override) return '';
    var reason = String(r.override_reason || '').trim();
    return '<br><span class="pto-pill denied" title="Approved over the coverage cap">override</span>' +
      (reason ? '<div class="pto-sub" style="font-style:italic;margin-top:3px">&ldquo;' + escHtml(reason) + '&rdquo;</div>' : '');
  }

  async function loadApproved(page) {
    var host = document.getElementById('pto-appr-list');
    if (!host) return;
    APPR_PAGE = page;
    host.innerHTML = '<div class="loading">Loading…</div>';
    try {
      var data = await api('GET', '/pto/approved?page=' + page + '&page_size=10');
      var list = (data && data.rows) || [];
      CACHE.approvedRows = list;
      var rows = list.map(function (r) {
        var d = fmtDate(r.start_date) + (String(r.end_date).slice(0, 10) !== String(r.start_date).slice(0, 10) ? ' – ' + fmtDate(r.end_date) : '');
        var tag = r.retroactive ? ' <span class="pto-pill locked">logged</span>' : '';
        return '<tr class="pto-clickable" tabindex="0" role="button" data-pto-open="' + r.id + '" ' +
          'aria-label="Open details for ' + escHtml(r.user_name || 'this request') + '">' +
          '<td><b>' + escHtml(r.user_name || '') + '</b>' + tag + '<br><span class="pto-sub">' + escHtml(r.pay_type || '') + '</span></td>' +
          '<td>' + d + '</td><td>' + dayBreakdown(r) + '</td><td>' + fmtAmt(Number(r.hours), r.pay_type) + '</td>' +
          '<td>' + escHtml(r.type || '') + '</td>' +
          // An override is the one row on this screen someone will later ask
          // "why?" about, so show the reason inline instead of making them dig
          // through the audit log. The approver was forced to type it at
          // approval time (routes/pto.js refuses with coverage_override_required
          // when it is blank), so it is never empty on an overridden row.
          '<td>' + escHtml(r.approver_name || '—') + overrideNote(r) + '</td>' +
          '<td>' + (r.decided_at ? fmtDate(r.decided_at) : '—') + '</td>' +
          '<td style="white-space:nowrap"><button class="pto-btn no sm" onclick="ptoMgrCancel(' + r.id + ')">Cancel</button></td></tr>';
      }).join('');
      var table = '<table class="pto-table"><thead><tr><th>Employee</th><th>Dates</th><th>Days</th><th>Amount</th><th>Type</th><th>Approved by</th><th>Decided</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="8" class="pto-sub">Nothing approved yet.</td></tr>') + '</tbody></table>';
      var pages = (data && data.pages) || 1, cur = (data && data.page) || 1, total = (data && data.total) || 0;
      var pager = '';
      if (pages > 1) {
        pager = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px">' +
          '<span class="pto-sub">' + total + ' total · page ' + cur + ' of ' + pages + '</span>' +
          '<span style="display:flex;gap:8px">' +
            '<button class="pto-btn ghost sm" ' + (cur <= 1 ? 'disabled' : '') + ' onclick="ptoApprPage(' + (cur - 1) + ')">Prev</button>' +
            '<button class="pto-btn ghost sm" ' + (cur >= pages ? 'disabled' : '') + ' onclick="ptoApprPage(' + (cur + 1) + ')">Next</button>' +
          '</span></div>';
      }
      host.innerHTML = table + pager;
      wireRowOpen(host);
    } catch (e) {
      host.innerHTML = '<div class="alert alert-error">Could not load approved list (' + escHtml(e.message || 'error') + ').</div>';
    }
  }
  window.ptoApprPage = function (p) { loadApproved(p); };

  // ---- CANCELLATIONS LOG (manager view, 10 per page) -----------------------
  function cancelSourceLabel(x) {
    if (x === 'manager_forced') return 'Admin forced';
    if (x === 'manager_offer_accepted') return 'Mgr proposed, employee OK';
    if (x === 'employee_requested') return 'Employee requested';
    if (x === 'manager_direct') return 'Manager direct';
    return x || '\u2014';
  }
  async function tabCancellations(body) {
    body.innerHTML = '<div class="pto-panel"><h3>Cancellations</h3><div class="pto-desc">Every cancelled PTO from your reporting line, newest first.</div><div id="pto-canc-list"><div class="loading">Loading\u2026</div></div></div>';
    loadCancellations(1);
  }
  async function loadCancellations(page) {
    var host = document.getElementById('pto-canc-list');
    if (!host) return;
    host.innerHTML = '<div class="loading">Loading\u2026</div>';
    try {
      var data = await api('GET', '/pto/cancellations?page=' + page + '&page_size=10');
      var list = (data && data.rows) || [];
      var rows = list.map(function (r) {
        var d = fmtDate(r.start_date) + (String(r.end_date).slice(0, 10) !== String(r.start_date).slice(0, 10) ? ' \u2013 ' + fmtDate(r.end_date) : '');
        return '<tr><td><b>' + escHtml(r.user_name || '') + '</b><br><span class="pto-sub">' + escHtml(r.pay_type || '') + '</span></td>' +
          '<td>' + d + '</td><td>' + r.business_days + '</td><td>' + fmtAmt(Number(r.hours), r.pay_type) + '</td>' +
          '<td>' + (r.paid ? 'Paid' : 'Unpaid') + ' ' + escHtml(r.type || '') + '</td>' +
          '<td><span class="pto-sub">' + escHtml(cancelSourceLabel(r.source)) + '</span></td>' +
          '<td>' + (r.memo ? escHtml(r.memo) : '<span class="pto-sub">\u2014</span>') + '</td>' +
          '<td>' + escHtml(r.decided_by_name || r.initiated_by_name || '\u2014') + '</td>' +
          '<td>' + (r.created_at ? fmtDate(r.created_at) : '\u2014') + '</td></tr>';
      }).join('');
      var table = '<table class="pto-table"><thead><tr><th>Employee</th><th>Dates</th><th>Days</th><th>Amount</th><th>Type</th><th>How</th><th>Reason</th><th>By</th><th>When</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="9" class="pto-sub">No cancellations yet.</td></tr>') + '</tbody></table>';
      var pages = (data && data.pages) || 1, cur = (data && data.page) || 1, total = (data && data.total) || 0;
      var pager = '';
      if (pages > 1) {
        pager = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px">' +
          '<span class="pto-sub">' + total + ' total \u00b7 page ' + cur + ' of ' + pages + '</span>' +
          '<span style="display:flex;gap:8px">' +
            '<button class="pto-btn ghost sm" ' + (cur <= 1 ? 'disabled' : '') + ' onclick="ptoCancPage(' + (cur - 1) + ')">Prev</button>' +
            '<button class="pto-btn ghost sm" ' + (cur >= pages ? 'disabled' : '') + ' onclick="ptoCancPage(' + (cur + 1) + ')">Next</button>' +
          '</span></div>';
      }
      host.innerHTML = table + pager;
    } catch (e) {
      host.innerHTML = '<div class="alert alert-error">Could not load cancellations (' + escHtml(e.message || 'error') + ').</div>';
    }
  }
  window.ptoCancPage = function (p) { loadCancellations(p); };
  window.ptoApprove = function (id, over, days) {
    if (over) return openOverride(id, days);
    doApprove(id, '', days);
  };
  // days is the approver's per-day re-tag, or null to approve exactly as
  // submitted. It has to survive both retry paths below, or a correction would
  // be silently dropped the moment an override or a negative balance is in play.
  async function doApprove(id, reason, days) {
    function payload(extra) {
      var b = extra || {};
      if (reason) b.override_reason = reason;
      if (days && days.length) b.days = days;
      return b;
    }
    function okToast(r) {
      var n = (r && r.retagged && r.retagged.length) || 0;
      showToast(n ? ('Approved with ' + n + ' day' + (n === 1 ? '' : 's') + ' changed — the employee was told what changed.')
                  : 'Approved — shifts set to Approved Vacation Day.', 'success');
    }
    try { var r1 = await api('POST', '/pto/requests/' + id + '/approve', payload()); okToast(r1); reload(); }
    catch (e) {
      var msg = e.message || '';
      if (msg.indexOf('coverage_override_required') !== -1) { openOverride(id, days); return; }
      var isAdmin = !!(state && state.user && (state.user.role === 'admin' || state.user.role === 'owner' || state.user.isOwner));
      if (isAdmin && msg.indexOf('balance') !== -1) {
        var ok = (typeof novaConfirm === 'function') ? await novaConfirm('This employee does not have enough PTO for this. Approve anyway and let the balance go negative?') : window.confirm('This employee does not have enough PTO for this. Approve anyway and let the balance go negative?');
        if (!ok) return;
        try { var r2 = await api('POST', '/pto/requests/' + id + '/approve', payload({ allow_negative: true })); okToast(r2); reload(); }
        catch (e2) { showToast(e2.message || 'Approve failed.', 'error'); }
        return;
      }
      showToast(msg || 'Approve failed.', 'error');
    }
  }
  window.ptoDeny = async function (id) {
    var reason = window.prompt('Reason for denial (optional):', '') || '';
    try { await api('POST', '/pto/requests/' + id + '/deny', { reason: reason }); showToast('Request denied.', 'info'); reload(); }
    catch (e) { showToast(e.message || 'Deny failed.', 'error'); }
  };
  window.ptoCancelConfirm = async function (id) {
    if (!window.confirm('Approve this cancellation? Any deducted hours are restored and the vacation shifts are cleared.')) return;
    try { await api('POST', '/pto/requests/' + id + '/cancel', {}); showToast('Cancellation approved — hours restored.', 'success'); reload(); }
    catch (e) { showToast(e.message || 'Cancel failed.', 'error'); }
  };
  window.ptoCancelKeep = async function (id) {
    var reason = window.prompt('Reason for keeping the PTO approved (optional):', '') || '';
    try { await api('POST', '/pto/requests/' + id + '/deny', { reason: reason }); showToast('Cancellation declined — PTO stays approved.', 'info'); reload(); }
    catch (e) { showToast(e.message || 'Failed.', 'error'); }
  };
  window.ptoMgrCancel = function (id) {
    var isAdmin = !!(state && state.user && (state.user.role === 'admin' || state.user.isOwner));
    var forceRow = isAdmin ? '<label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;color:var(--text-dim,#9a9a9a)"><input type="checkbox" id="pto-mc-force"> Cancel immediately without employee approval (admin)</label>' : '';
    var m = document.createElement('div'); m.className = 'pto-mask';
    m.innerHTML = '<div class="pto-dlg"><h3>Cancel approved PTO</h3><div class="pto-desc">The employee must accept before anything is reversed. A reason memo is required and is logged to the audit trail.</div>' +
      '<textarea id="pto-mc-memo" class="pto-textarea" rows="3" placeholder="Reason for cancelling (required)"></textarea>' +
      '<div class="pto-warn" id="pto-mc-err" style="display:none">A reason is required.</div>' + forceRow +
      '<div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end"><button class="pto-btn ghost" id="pto-mc-cancel">Never mind</button><button class="pto-btn no" id="pto-mc-ok">Send to employee</button></div></div>';
    document.body.appendChild(m);
    document.getElementById('pto-mc-cancel').onclick = function () { document.body.removeChild(m); };
    document.getElementById('pto-mc-ok').onclick = async function () {
      var memo = document.getElementById('pto-mc-memo').value.trim();
      var err = document.getElementById('pto-mc-err');
      if (!memo) { err.textContent = 'A reason is required.'; err.style.display = 'block'; return; }
      var fc = document.getElementById('pto-mc-force');
      var force = !!(isAdmin && fc && fc.checked);
      try {
        var r = await api('POST', '/pto/requests/' + id + '/mgr-cancel', { memo: memo, force: force });
        document.body.removeChild(m);
        showToast(r.status === 'cancelled' ? 'PTO cancelled.' : 'Sent to the employee for approval.', 'success');
        reload();
      } catch (e) { err.textContent = e.message || 'Failed.'; err.style.display = 'block'; }
    };
  };
  function openOverride(id, days) {
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
      document.body.removeChild(m); doApprove(id, r, days);
    };
  }


  // ---- APPROVAL DETAIL DIALOG ----------------------------------------------
  // Opens instantly from the cached queue row, then hydrates from
  // /pto/requests/:id/context. Everything an approver needs to decide is here:
  // what it costs them, what they have already taken, who else is off, and what
  // the market's schedule looks like around the dates.
  var DLG = null;

  function closeDetail() {
    if (!DLG) return;
    var m = DLG;
    DLG = null; // clear first, so an observer firing mid-teardown is a no-op
    if (m._obs) { try { m._obs.disconnect(); } catch (e) { /* ignore */ } m._obs = null; }
    if (m.parentNode) m.parentNode.removeChild(m);
    document.removeEventListener('keydown', onDetailKey);
    document.body.style.overflow = m._prevOverflow || '';
  }
  // The mask hangs off document.body, so an app-level navigation that swaps out
  // #content would leave it floating over the next screen with the page scroll
  // still locked. Watch the content host and close if it is rebuilt underneath us.
  function watchForNavigation(m) {
    var host = document.getElementById('content');
    if (!host || typeof MutationObserver !== 'function') return;
    var obs = new MutationObserver(function () { if (DLG === m) closeDetail(); });
    obs.observe(host, { childList: true });
    m._obs = obs;
  }
  function onDetailKey(ev) { if (ev.key === 'Escape') closeDetail(); }

  function pill(status) {
    var cls = status === 'approved' ? 'approved'
      : (status === 'denied' || status === 'cancelled') ? 'denied'
      : (status === 'pending') ? 'pending' : 'locked';
    return '<span class="pto-pill ' + cls + '">' + escHtml(statusText(status)) + '</span>';
  }
  function longDate(v) {
    var d = parseLocal(v);
    return d ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }
  function rangeText(a, b) {
    return String(b).slice(0, 10) === String(a).slice(0, 10) ? longDate(a) : longDate(a) + ' – ' + longDate(b);
  }
  function hhmm(t) {
    var p = String(t || '').split(':'); if (p.length < 2) return String(t || '');
    var h = parseInt(p[0], 10); if (!isFinite(h)) return String(t || '');
    var ap = h >= 12 ? 'p' : 'a', h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + (p[1] === '00' ? '' : ':' + p[1]) + ap;
  }

  // shift_positions.color is admin-editable free text and it lands inside a
  // style attribute, so anything that is not plainly a colour is refused rather
  // than escaped — a mangled swatch is fine, a stray event handler is not.
  // Restricted to 3- and 6-digit hex, and shorthand is expanded, because the
  // caller appends a two-digit alpha ('#f00' + '14' would be the invalid
  // '#f0014' and the tint would just vanish).
  function safeColor(v) {
    var c = String(v === null || v === undefined ? '' : v).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
    if (/^#[0-9a-fA-F]{3}$/.test(c)) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    return '#3b82f6';
  }

  // One week of the market's grid, in the same visual language as the schedule
  // screen. Deliberately a local copy rather than a call into app.js's
  // mySchedWeekHtml, which reads that module's globals.
  function ptoWeekHtml(monday, shifts, meId, reqKinds, label, editable, reqHours, partDays) {
    var byDay = {};
    (shifts || []).forEach(function (s) { (byDay[s.shift_date] = byDay[s.shift_date] || []).push(s); });
    var today = ymdLocal(new Date());
    var touched = false, cols = '';
    for (var i = 0; i < 7; i++) {
      var day = addDaysLocal(monday, i);
      var kind = reqKinds[day];
      var isReq = !!kind;
      if (isReq) touched = true;
      var tag = '';
      if (isReq && editable) {
        // The approver corrects the day right where they are looking at the
        // roster for it, rather than in a separate form away from the evidence.
        var opts = ['paid', 'unpaid', 'off'].map(function (k) {
          return '<option value="' + k + '"' + (k === kind ? ' selected' : '') + '>' +
            (k === 'off' ? 'DAY OFF' : k.toUpperCase() + ' PTO') + '</option>';
        }).join('');
        var hv = (reqHours && reqHours[day] > 0) ? reqHours[day] : HRS_PER_DAY;
        tag = '<select class="pto-day-sel k-' + kind + '" data-retag="' + day + '" ' +
          'title="Change how this day is classified" ' +
          'aria-label="Classification for ' + escHtml(fmtDate(day)) + '">' + opts + '</select>' +
          // The amount sits under the classification, so one column answers both
          // questions an approver has about a day: what kind, and how much. Absent
          // for commission staff, who take whole days and have no hours to correct.
          (partDays
            ? '<input type="number" class="pto-day-hrs' + (kind === 'paid' ? '' : ' hidden') + '" data-retaghrs="' + day + '" ' +
                'min="0.1" step="0.1" value="' + hv + '" title="Hours of PTO on this day" ' +
                'aria-label="Hours of PTO on ' + escHtml(fmtDate(day)) + '">'
            : '');
      } else if (isReq) {
        var hs = (partDays && kind === 'paid' && reqHours && reqHours[day] > 0 && reqHours[day] !== HRS_PER_DAY)
          ? (' \u00b7 ' + hrsText(reqHours[day])) : '';
        tag = '<span class="pto-day-tag k-' + kind + '">' + (kind === 'off' ? 'day off' : kind + ' PTO') + escHtml(hs) + '</span>';
      }
      var list = (byDay[day] || []).slice().sort(function (a, b) { return String(a.start_time).localeCompare(String(b.start_time)); });
      var items = list.map(function (s) {
        var col = safeColor(s.position_color);
        var meta = [];
        if (s.position_name) meta.push(escHtml(s.position_name));
        if (s.notes) meta.push(escHtml(s.notes));
        return '<div class="pto-chip' + (Number(s.user_id) === Number(meId) ? ' me' : '') + '" ' +
          'style="background:' + col + '14;border-left:3px solid ' + col + '">' +
          '<b>' + escHtml((s.user_name || '').trim()) + '</b>' +
          '<span class="m">' + escHtml(hhmm(s.start_time)) + '–' + escHtml(hhmm(s.end_time)) + '</span>' +
          (meta.length ? '<span class="m">' + meta.join(' · ') + '</span>' : '') + '</div>';
      }).join('') || '<div class="pto-empty">—</div>';
      cols += '<div class="pto-day' + (isReq ? ' req' : '') + (day === today ? ' today' : '') + '">' +
        '<div class="pto-day-hd">' + escHtml(fmtDayDate(day)) + '</div>' + tag + items + '</div>';
    }
    return '<div class="pto-wk"><div class="pto-wk-hd' + (touched ? ' is-req' : '') + '">' +
      escHtml(label) + '</div>' +
      '<div class="pto-days">' + cols + '</div></div>';
  }

  function detailBodyHtml(C, editable) {
    var pt = C.employee.pay_type;
    var partDays = takesPartDays(pt); // no hours to show, or change, for commission
    var reqKinds = {}, reqHours = {};
    (C.request.days || []).forEach(function (x) {
      reqKinds[x.date] = x.kind;
      reqHours[x.date] = Number(x.hours) > 0 ? Number(x.hours) : HRS_PER_DAY;
    });
    var meId = C.employee.id;

    // --- header
    var h = '<div class="pto-sec"><h3 style="margin:0 0 2px;font-size:18px">' + escHtml(C.employee.name) + '</h3>' +
      '<div class="pto-sub">' + escHtml(C.employee.title || '') + (C.employee.title ? ' · ' : '') + escHtml(pt) +
      (C.employee.hire_date ? ' · hired ' + escHtml(fmtDate(C.employee.hire_date)) + ' (' + C.employee.tenure_years + ' yr' + (C.employee.tenure_years === 1 ? '' : 's') + ')' : '') + '</div>' +
      '<div style="margin-top:8px;font-size:14px"><b>' + escHtml(rangeText(C.request.start_date, C.request.end_date)) + '</b></div>' +
      '<div class="pto-sub">' + dayBreakdown(C.request) + ' · ' + escHtml(C.request.type || 'Vacation') +
      ' · ' + escHtml(C.request.tier_label) + ' · submitted ' + escHtml(fmtDate(C.request.created_at)) + '</div>' +
      (C.request.cancel_memo ? '<div class="pto-sub" style="font-style:italic;margin-top:6px">&ldquo;' + escHtml(C.request.cancel_memo) + '&rdquo;</div>' : '') +
      '</div>';

    // --- balance
    var afterCls = C.balance.insufficient ? 'pto-neg' : 'pto-pos';
    h += '<div class="pto-sec"><h4>Balance</h4><div class="pto-cards">' +
      '<div class="pto-card"><h4>Available now</h4><div class="pto-stat">' + fmtAmt(C.balance.current_hours, pt) + '</div></div>' +
      '<div class="pto-card"><h4>This request</h4><div class="pto-stat">' +
        (C.balance.cost_hours > 0 ? '− ' + fmtAmt(C.balance.cost_hours, pt) : 'no charge') + '</div>' +
        (C.balance.cost_hours > 0 ? '' : '<div class="pto-sub">unpaid or scheduled off</div>') + '</div>' +
      '<div class="pto-card"><h4>After approval</h4><div class="pto-stat ' + afterCls + '">' + fmtAmt(C.balance.after_hours, pt) + '</div></div>' +
      '</div>' +
      (C.balance.insufficient ? '<div class="pto-warn">Approving this takes them negative. Only an admin can, and it must be deliberate.</div>' : '') +
      '<div class="pto-sub" style="margin-top:8px">' +
        (C.employee.accrues
          ? 'Accrues ' + (C.employee.accrual_monthly_hours / HRS_PER_DAY).toFixed(2) + ' days/mo (' + C.employee.accrual_days_per_year + ' days/yr band)'
          : 'Does not accrue — ' + (C.employee.exempt ? 'exempt role' : (C.employee.employment_type !== 'full_time' ? escHtml(C.employee.employment_type) : 'no hire date on file'))) +
        (C.employee.eligible_now ? '' : ' · <span class="pto-neg">not eligible until ' + escHtml(fmtDate(C.employee.eligible_date)) + '</span>') +
      '</div></div>';

    // --- last 12 months
    var hr = (C.history.requests || []).map(function (x) {
      return '<tr><td style="white-space:nowrap">' + escHtml(rangeShort(x.start_date, x.end_date)) + '</td>' +
        '<td>' + dayBreakdown(x) + '</td>' +
        '<td>' + (Number(x.hours) > 0 ? fmtAmt(Number(x.hours), pt) : '<span class="pto-sub">—</span>') + '</td>' +
        '<td>' + escHtml(x.type || '') + (x.retroactive ? ' <span class="pto-pill locked">logged</span>' : '') +
          (x.coverage_override ? ' <span class="pto-pill denied" title="' +
            escHtml(x.override_reason || 'Approved over the coverage cap') + '">override</span>' : '') + '</td>' +
        '<td>' + pill(x.status) + '</td>' +
        '<td class="pto-sub">' + escHtml(x.approver_name || '—') + '</td></tr>';
    }).join('');
    h += '<div class="pto-sec"><h4>Previous PTO · last 12 months</h4>' +
      '<div class="pto-desc">Used <b>' + fmtAmt(C.history.used_hours, pt) + '</b> since ' + escHtml(fmtDate(C.history.window_from)) + '. Denied and cancelled requests are included.</div>' +
      '<table class="pto-table"><thead><tr><th>Dates</th><th>Days</th><th>Amount</th><th>Type</th><th>Status</th><th>Decided by</th></tr></thead><tbody>' +
      (hr || '<tr><td colspan="6" class="pto-sub">No PTO in the last 12 months.</td></tr>') + '</tbody></table>';

    var lr = (C.history.ledger || []).map(function (l) {
      var amt = Number(l.amount_hours);
      return '<tr><td style="width:86px">' + escHtml(fmtDate(l.entry_date)) + '</td>' +
        '<td>' + escHtml(l.description || l.kind) + '</td>' +
        '<td style="color:' + (amt >= 0 ? '#22c55e' : '#ef4444') + '">' + (amt >= 0 ? '+' : '−') + fmtAmt(Math.abs(amt), pt) + '</td></tr>';
    }).join('');
    var up = (C.history.upcoming || []).map(function (x) {
      return '<li>' + escHtml(rangeShort(x.start_date, x.end_date)) + ' <span class="pto-sub">' +
        dayBreakdown(x) + ' · ' + escHtml(x.type || '') + '</span> ' + pill(x.status) + '</li>';
    }).join('');
    if (up) {
      h += '<div class="pto-sub" style="margin-top:10px;font-weight:700">Already booked ahead</div>' +
        '<ul style="margin:4px 0 0;padding-left:18px;font-size:13px">' + up + '</ul>';
    }
    h += '<details style="margin-top:10px"><summary class="pto-sub" style="cursor:pointer">Ledger detail (' + (C.history.ledger || []).length + ' entries)</summary>' +
      '<table class="pto-table" style="margin-top:6px"><thead><tr><th>Date</th><th>Entry</th><th>Change</th></tr></thead><tbody>' +
      (lr || '<tr><td colspan="3" class="pto-sub">No ledger entries in the window.</td></tr>') + '</tbody></table></details></div>';

    // --- coverage
    var cvPill = C.coverage.cap === null || C.coverage.cap === undefined
      ? '<span class="pto-sub">no cap set</span>'
      : '<span class="pto-pill ' + (C.coverage.over ? 'denied' : 'approved') + '">' + (C.coverage.over ? '⚠ ' : '') + C.coverage.used + ' of ' + C.coverage.cap + '</span>';
    // scoped tells us whether that number really is this market's. When a market
    // resolved but has no cap of its own the count is still company-wide, and
    // saying '2 of 1 in Atlanta' would pin a Nashville absence on Atlanta.
    var cvWhere = C.coverage.scoped
      ? '<span class="pto-sub">in ' + escHtml(C.coverage.city_name || C.coverage.city_code) + '</span>'
      : '<span class="pto-sub">counted company-wide against the default cap' +
        (C.coverage.city_code
          ? ' \u2014 no cap is set for ' + escHtml(C.coverage.city_name || C.coverage.city_code)
          : ' \u2014 no market on file for this employee') + '</span>';
    h += '<div class="pto-sec"><h4>Coverage</h4><div>' + cvPill + ' ' + cvWhere + '</div>';
    if ((C.coverage.others_off || []).length) {
      h += '<div class="pto-sub" style="margin-top:8px">Already off on overlapping days' +
        (C.coverage.scoped ? '' : ' (company-wide)') + ':</div><ul style="margin:4px 0 0;padding-left:18px;font-size:13px">' +
        C.coverage.others_off.map(function (x) {
          return '<li>' + escHtml(x.name) + ' <span class="pto-sub">' + escHtml(rangeShort(x.start_date, x.end_date)) + '</span></li>';
        }).join('') + '</ul>';
    } else {
      h += '<div class="pto-sub" style="margin-top:8px">Nobody else is off on these days.</div>';
    }
    if (C.coverage.names_truncated) {
      h += '<div class="pto-sub" style="margin-top:6px">Only the first names are listed; the count above is complete.</div>';
    }
    if ((C.coverage.others_pending || []).length) {
      h += '<div class="pto-sub" style="margin-top:8px">Also asked for these days (still pending):</div><ul style="margin:4px 0 0;padding-left:18px;font-size:13px;color:var(--text-dim,#9a9a9a)">' +
        C.coverage.others_pending.map(function (x) {
          return '<li>' + escHtml(x.name) + ' ' + escHtml(rangeShort(x.start_date, x.end_date)) + '</li>';
        }).join('') + '</ul>';
    }
    h += '</div>';

    // --- schedule: week before, week(s) of, week after
    h += '<div class="pto-sec"><h4>' + escHtml(C.schedule.city_name || C.schedule.city_code || 'City') + ' schedule</h4>';
    if (!C.schedule.city_code) {
      h += '<div class="pto-sub">No market resolved for this employee, so there is no city grid to show. Set their home city on the employee record.</div>';
    } else {
      // Spell the dates out. The tinting alone left approvers hunting for which
      // columns were the request.
      var firstName = escHtml(String(C.employee.name || 'their').split(' ')[0]);
      var kinds = {};
      (C.request.days || []).forEach(function (x) { kinds[x.kind] = (kinds[x.kind] || 0) + 1; });
      var kindBits = [];
      var paidHrs = 0, partialDays = 0;
      (C.request.days || []).forEach(function (x) {
        if (x.kind !== 'paid') return;
        var hx = Number(x.hours) > 0 ? Number(x.hours) : HRS_PER_DAY;
        paidHrs += hx;
        if (hx !== HRS_PER_DAY) partialDays++;
      });
      // Only spell the hours out when they are not the plain full days everyone
      // assumes — otherwise every request would read '2 paid (16.0h)' for nothing.
      if (kinds.paid) kindBits.push(kinds.paid + ' paid' + ((partDays && partialDays) ? ' (' + hrsText(paidHrs) + ' total, ' + partialDays + ' part day' + (partialDays === 1 ? '' : 's') + ')' : ''));
      if (kinds.unpaid) kindBits.push(kinds.unpaid + ' unpaid');
      if (kinds.off) kindBits.push(kinds.off + ' day off');
      h += '<div class="pto-reqline">Requesting <b>' + escHtml(rangeText(C.request.start_date, C.request.end_date)) +
        '</b>' + (kindBits.length ? ' &mdash; ' + escHtml(kindBits.join(', ')) : '') +
        '. Those days are the highlighted columns below.</div>';
      var key = '<span><i style="background:rgba(249,115,22,.9)"></i>paid PTO</span>';
      if (kinds.unpaid) key += '<span><i style="background:rgba(234,179,8,.9)"></i>unpaid</span>';
      if (kinds.off) key += '<span><i style="background:rgba(156,163,175,.85)"></i>day off</span>';
      key += '<span><i style="border:2px solid var(--primary,#f97316);background:transparent"></i>' + firstName + '&#39;s shifts</span>';
      h += '<div class="pto-key">' + key + '</div>' +
        '<div class="pto-desc">Published shifts for the week before, the requested weeks, and the week after.' +
        (editable
          ? (partDays
            ? ' You can re-classify any requested day, or change the hours on a paid one, before approving \u2014 the employee is told what changed.'
            : ' You can re-classify any requested day before approving \u2014 the employee is told what changed. This employee is tracked in whole days.')
          : '') +
        '</div>';
      var weeks = [];
      var wk = mondayLocal(C.schedule.from), guard = 0;
      while (wk <= C.schedule.to && guard++ < 8) { weeks.push(wk); wk = addDaysLocal(wk, 7); }
      var reqWeeks = weeks.filter(function (m) {
        for (var i = 0; i < 7; i++) { if (reqKinds[addDaysLocal(m, i)]) return true; }
        return false;
      });
      var firstReq = reqWeeks.length ? reqWeeks[0] : null;
      var lastReq = reqWeeks.length ? reqWeeks[reqWeeks.length - 1] : null;
      weeks.forEach(function (m) {
        var wkEnd = addDaysLocal(m, 6);
        var dates = fmtDayDate(m) + ' \u2013 ' + fmtDayDate(wkEnd);
        var role;
        if (firstReq && m < firstReq) role = 'Week before';
        else if (lastReq && m > lastReq) role = 'Week after';
        else if (reqWeeks.length > 1) role = 'Requested \u00b7 week ' + (reqWeeks.indexOf(m) + 1) + ' of ' + reqWeeks.length;
        else role = 'Requested';
        h += ptoWeekHtml(m, C.schedule.shifts, meId, reqKinds, role + '  \u00b7  ' + dates, editable, reqHours, partDays);
      });
      if (!(C.schedule.shifts || []).length) {
        h += '<div class="pto-sub">Nothing published in this window.</div>';
      }
      if (editable) {
        h += '<div class="pto-retag" id="pto-retag-note">No changes \u2014 approving exactly as requested.</div>';
      }
      if (C.schedule.shifts_truncated) {
        h += '<div class="pto-warn">This market has more shifts in the window than the grid will show. Open the schedule screen for the full picture.</div>';
      }
      if (C.schedule.truncated) {
        h += '<div class="pto-warn">This request runs to ' + escHtml(fmtDate(C.request.end_date)) +
          '. The grid stops at ' + escHtml(fmtDate(C.schedule.to)) + ' — open the schedule screen for the rest.</div>';
      }
    }
    h += '</div>';
    return h;
  }

  // Bind the per-day selects. Keeps a live picture of the corrected request and
  // restates what it will cost, because re-tagging a day changes the deduction
  // and the approver should see that before committing, not after.
  function wireRetag(m, C, onChange) {
    var orig = {}, origH = {};
    (C.request.days || []).forEach(function (x) {
      orig[x.date] = x.kind;
      origH[x.date] = Number(x.hours) > 0 ? Number(x.hours) : HRS_PER_DAY;
    });
    var cur = {}, curH = {};
    Object.keys(orig).forEach(function (k) { cur[k] = orig[k]; curH[k] = origH[k]; });
    var pt = C.employee.pay_type;
    var note = m.querySelector('#pto-retag-note');
    var sels = m.querySelectorAll('[data-retag]');
    var hrsBoxes = m.querySelectorAll('[data-retaghrs]');

    function hoursOn(d) { return cur[d] === 'paid' ? (Number(curH[d]) > 0 ? Number(curH[d]) : 0) : 0; }
    function moved(d) {
      // An hours edit on a day that stays paid moves the deduction and the
      // paycheck, so it counts as a change exactly like a re-classification.
      if (cur[d] !== orig[d]) return true;
      return cur[d] === 'paid' && hoursOn(d) !== origH[d];
    }
    function current() {
      return Object.keys(cur).sort().map(function (d) { return { date: d, kind: cur[d], hours: hoursOn(d) }; });
    }
    function changed() {
      return Object.keys(cur).sort().filter(moved)
        .map(function (d) { return { date: d, from: orig[d], to: cur[d], from_hours: origH[d], to_hours: hoursOn(d) }; });
    }
    function label(kind, hrs) { return kind === 'paid' ? 'paid ' + hrsText(hrs) : kind; }
    function refresh() {
      var diff = changed();
      var cost = 0, blank = 0;
      Object.keys(cur).forEach(function (d) {
        if (cur[d] !== 'paid') return;
        if (!(Number(curH[d]) > 0)) blank++;
        cost += hoursOn(d);
      });
      cost = Math.round(cost * 100) / 100;
      var was = C.balance.cost_hours;
      var after = Math.round((C.balance.current_hours - cost) * 100) / 100;
      if (note) {
        if (blank) {
          note.innerHTML = '<span style="color:#ef4444"><b>Enter hours greater than 0 on every paid day</b>' +
            ' \u2014 or mark that day unpaid or a day off.</span>';
        } else if (!diff.length) {
          note.innerHTML = 'No changes \u2014 approving exactly as requested.';
        } else {
          var lines = diff.map(function (c) {
            return '<li>' + escHtml(fmtDate(c.date)) + ': <b>' + escHtml(label(c.from, c.from_hours)) + '</b> \u2192 <b>' +
              escHtml(label(c.to, c.to_hours)) + '</b></li>';
          }).join('');
          note.innerHTML = '<b>' + diff.length + ' day' + (diff.length === 1 ? '' : 's') + ' changed</b>' +
            '<ul style="margin:5px 0 0;padding-left:18px">' + lines + '</ul>' +
            '<div style="margin-top:6px">Cost ' + (cost === was ? 'unchanged at <b>' + fmtAmt(cost, pt) + '</b>'
              : '<b>' + fmtAmt(was, pt) + '</b> \u2192 <b>' + fmtAmt(cost, pt) + '</b>') +
            ', leaving <b class="' + (after < 0 ? 'pto-neg' : 'pto-pos') + '">' + fmtAmt(after, pt) + '</b>.' +
            ' The employee will be told what changed.</div>';
        }
      }
      // A blank amount is not a correction anyone can act on, so it is never sent.
      onChange((diff.length && !blank) ? current() : null, after < 0);
    }
    function markCol(day) {
      var box = m.querySelector('[data-retaghrs="' + day + '"]');
      var sel = m.querySelector('[data-retag="' + day + '"]');
      var isMoved = moved(day);
      if (sel) sel.className = 'pto-day-sel k-' + cur[day] + (isMoved ? ' moved' : '');
      if (box) box.className = 'pto-day-hrs' + (cur[day] === 'paid' ? '' : ' hidden') + (isMoved ? ' moved' : '');
      var col = sel && sel.closest ? sel.closest('.pto-day') : null;
      if (col) col.className = 'pto-day req' + (isMoved ? ' moved' : '');
    }
    Array.prototype.forEach.call(sels, function (sel) {
      sel.onchange = function () {
        var day = sel.getAttribute('data-retag');
        cur[day] = sel.value;
        markCol(day);
        refresh();
      };
    });
    Array.prototype.forEach.call(hrsBoxes, function (box) {
      box.oninput = function () {
        var day = box.getAttribute('data-retaghrs');
        curH[day] = box.value === '' ? 0 : Number(box.value);
        markCol(day);
        refresh();
      };
    });
    refresh();
  }

  window.ptoDetail = async function (id) {
    closeDetail();
    var cached = null;
    (CACHE.approvals || []).forEach(function (x) { if (Number(x.id) === Number(id)) cached = x; });
    (CACHE.approvedRows || []).forEach(function (x) { if (Number(x.id) === Number(id)) cached = x; });

    var m = document.createElement('div');
    m.className = 'pto-mask';
    m._prevOverflow = document.body.style.overflow;
    var st = cached ? cached.status : null;
    var foot = st === 'pending'
      ? '<button class="pto-btn ok" id="pto-dt-ok">Approve</button> <button class="pto-btn no" id="pto-dt-no">Deny</button>'
      : (st === 'cancel_requested'
        ? '<button class="pto-btn ok" id="pto-dt-cok">Approve cancellation</button> <button class="pto-btn no" id="pto-dt-ckeep">Keep approved</button>'
        : '');
    m.innerHTML = '<div class="pto-dlg wide" role="dialog" aria-modal="true" aria-label="PTO request detail">' +
      '<div id="pto-dt-body"><div class="loading">Loading' + '…' + '</div>' +
        (cached ? '<div class="pto-sub" style="margin-top:6px">' + escHtml(cached.user_name || '') + ' · ' +
          escHtml(fmtDate(cached.start_date)) + '</div>' : '') + '</div>' +
      '<div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">' +
        foot + '<button class="pto-btn ghost" id="pto-dt-close">Close</button></div></div>';
    document.body.appendChild(m);
    document.body.style.overflow = 'hidden';
    DLG = m;
    watchForNavigation(m);
    document.addEventListener('keydown', onDetailKey);
    m.addEventListener('click', function (ev) { if (ev.target === m) closeDetail(); });
    m.querySelector('#pto-dt-close').onclick = closeDetail;
    var okBtn = m.querySelector('#pto-dt-ok'), noBtn = m.querySelector('#pto-dt-no');
    if (okBtn) okBtn.onclick = function () { var over = !!(cached && cached.coverage_over); closeDetail(); window.ptoApprove(id, over); };
    if (noBtn) noBtn.onclick = function () { closeDetail(); window.ptoDeny(id); };
    var cokBtn = m.querySelector('#pto-dt-cok'), ckeepBtn = m.querySelector('#pto-dt-ckeep');
    if (cokBtn) cokBtn.onclick = function () { closeDetail(); window.ptoCancelConfirm(id); };
    if (ckeepBtn) ckeepBtn.onclick = function () { closeDetail(); window.ptoCancelKeep(id); };

    try {
      var C = await api('GET', '/pto/requests/' + id + '/context');
      if (DLG !== m) return; // the approver closed it, or opened another row
      var editable = st === 'pending';
      m.querySelector('#pto-dt-body').innerHTML = detailBodyHtml(C, editable);
      // Keep the footer honest if the cap moved since the queue was fetched, and
      // carry any per-day correction through to the approve call.
      var retagDays = null;
      if (okBtn) okBtn.onclick = function () { var over = !!(C.coverage && C.coverage.over); closeDetail(); window.ptoApprove(id, over, retagDays); };
      if (editable) {
        wireRetag(m, C, function (days) {
          retagDays = days;
          if (okBtn) okBtn.textContent = days ? 'Approve with changes' : 'Approve';
        });
      }
    } catch (e) {
      if (DLG !== m) return;
      m.querySelector('#pto-dt-body').innerHTML = '<div class="alert alert-error">Could not load the detail (' + escHtml(e.message || 'error') + ').</div>';
    }
  };

  // ---- TEAM PTO ------------------------------------------------------------
  async function tabTeam(body) {
    var list = await api('GET', '/pto/team'); CACHE.team = list;
    var isAdmin = state && state.user && (state.user.role === 'admin' || state.user.role === 'owner' || state.user.isOwner);
    // Former employees sort to the bottom: still here to read and pay out, but out
    // of the way of the people you manage day to day.
    var sorted = (list || []).slice().sort(function (a, b) {
      if (!!a.former !== !!b.former) return a.former ? 1 : -1;
      return String(a.name).localeCompare(String(b.name));
    });
    var rows = sorted.map(function (p) {
      var warn = p.hire_date ? '' : ' <span class="pto-flag">⚠ no hire date</span>';
      var left = p.former ? ' <span class="pto-flag" style="background:rgba(148,163,184,.15);color:#94a3b8">left ' + (p.separation_date ? fmtDate(p.separation_date) : '') + '</span>' : '';
      return '<tr' + (p.former ? ' style="opacity:.72"' : '') + '><td><b>' + escHtml(p.name) + '</b>' + warn + left + '<br><span class="pto-sub">' + escHtml(p.title || '') + (p.exempt ? ' · exempt' : '') + '</span></td>' +
        '<td>' + escHtml(p.pay_type) + '</td><td><b>' + fmtAmt(Number(p.balance_hours), p.pay_type) + '</b></td>' +
        '<td>' + (p.pending ? fmtDate(p.pending) : '—') + '</td>' +
        '<td style="white-space:nowrap"><button class="pto-btn ghost sm" onclick="ptoLedger(' + p.id + ',this)">View ledger</button> <button class="pto-btn sm" onclick="ptoOpenLog(' + p.id + ')">Log PTO</button>' + (isAdmin ? ' <button class="pto-btn ok sm" onclick="ptoOpenAward(' + p.id + ')">Award</button>' : '') + '</td></tr>' +
        '<tr id="pto-led-' + p.id + '" style="display:none"><td colspan="5"></td></tr>';
    }).join('');
    body.innerHTML = '<div class="pto-panel"><h3>Team PTO</h3><div class="pto-desc">Read-only. Everyone in your reporting line, plus anyone who left in the last year - their balance stays here to be paid out. Click a person to view their append-only ledger.</div>' +
      '<table class="pto-table"><thead><tr><th>Employee</th><th>Pay</th><th>Balance</th><th>Pending</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="pto-sub">No one reports to you.</td></tr>') + '</tbody></table></div>';
  }
  window.ptoLedger = async function (id, btn) {
    var tr = document.getElementById('pto-led-' + id);
    if (tr.style.display !== 'none') { tr.style.display = 'none'; btn.textContent = 'View ledger'; return; }
    var person = null; (CACHE.team || []).forEach(function (p) { if (p.id === id) person = p; });
    var pt = person ? person.pay_type : 'hourly';
    var isAdmin = !!(state && state.user && (state.user.role === 'admin' || state.user.role === 'owner' || state.user.isOwner));
    try {
      var led = await api('GET', '/pto/team/' + id + '/ledger');
      var body = led.map(function (l) {
        var amt = Number(l.amount_hours);
        return '<tr><td style="width:80px">' + fmtDate(l.entry_date) + '</td><td>' + escHtml(l.description || l.kind) + '</td><td style="color:' + (amt >= 0 ? '#22c55e' : '#ef4444') + '">' + (amt >= 0 ? '+' : '') + fmtAmt(Math.abs(amt), pt).replace(unitLabel(pt), unitLabel(pt)) + '</td></tr>';
      }).join('');
      var adj = isAdmin ? ('<div style="margin-top:10px;border-top:1px solid var(--border,#2c2c2c);padding-top:10px"><div class="pto-sub" style="font-weight:700;margin-bottom:6px">Add adjustment</div><div class="pto-desc" style="margin-bottom:8px">Enter a positive number to add time or a negative number to dock it. A negative result is allowed as a deliberate exception, and every entry is recorded on this ledger.</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end"><div><label class="pto-label">Days (+/-)</label><input type="number" step="0.25" id="pto-adj-days-' + id + '" class="pto-input" style="max-width:120px" placeholder="e.g. -2"></div><div style="flex:1;min-width:180px"><label class="pto-label">Reason (required)</label><input type="text" id="pto-adj-reason-' + id + '" class="pto-input" placeholder="e.g. Correcting an overpaid PTO day"></div><button class="pto-btn ok" id="pto-adj-ok-' + id + '">Apply</button></div><div class="pto-sub" id="pto-adj-prev-' + id + '" style="margin-top:8px"></div><div class="pto-warn" id="pto-adj-err-' + id + '" style="display:none"></div></div>') : '';
      tr.querySelector('td').innerHTML = '<div style="background:var(--bg,#1f1f1f);border-radius:10px;padding:10px 12px"><div class="pto-sub" style="font-weight:700;margin-bottom:6px">PTO ledger (append-only)</div><table class="pto-table" style="margin:0"><thead><tr><th>Date</th><th>Entry</th><th>Change</th></tr></thead><tbody>' + (body || '<tr><td class="pto-sub">No entries.</td></tr>') + '</tbody></table>' + adj + '</div>';
      tr.style.display = 'table-row'; btn.textContent = 'Hide ledger';
      if (isAdmin) {
        var _dEl = document.getElementById('pto-adj-days-' + id), _rEl = document.getElementById('pto-adj-reason-' + id), _pEl = document.getElementById('pto-adj-prev-' + id), _eEl = document.getElementById('pto-adj-err-' + id), _okEl = document.getElementById('pto-adj-ok-' + id);
        var _bal = person ? Number(person.balance_hours) : 0;
        _dEl.oninput = function () { var n = Number(_dEl.value); if (_dEl.value === '' || !isFinite(n) || n === 0) { _pEl.textContent = ''; return; } var after = Math.round((_bal + n * HRS_PER_DAY) * 100) / 100; _pEl.innerHTML = (n > 0 ? 'Adds ' : 'Docks ') + '<b>' + fmtAmt(Math.abs(n) * HRS_PER_DAY, pt) + '</b> to a new balance of <b style="color:' + (after < 0 ? '#ef4444' : '#22c55e') + '">' + fmtAmt(after, pt) + '</b>'; };
        _okEl.onclick = async function () { _eEl.style.display = 'none'; var n = Number(_dEl.value); if (_dEl.value === '' || !isFinite(n) || n === 0) { _eEl.textContent = 'Enter a non-zero number of days (use a minus sign to dock).'; _eEl.style.display = 'block'; return; } var reason = (_rEl.value || '').trim(); if (!reason) { _eEl.textContent = 'A reason is required.'; _eEl.style.display = 'block'; return; } _okEl.disabled = true; try { await api('POST', '/pto/adjust', { user_id: id, days: n, reason: reason }); showToast((n > 0 ? 'Added ' : 'Docked ') + Math.abs(n) + ' day' + (Math.abs(n) === 1 ? '' : 's') + '.', 'success'); reload(); } catch (ex) { _okEl.disabled = false; _eEl.textContent = ex.message || 'Could not apply.'; _eEl.style.display = 'block'; } };
      }
    } catch (e) { showToast(e.message || 'Could not load ledger.', 'error'); }
  };
  window.ptoOpenLog = function (id) {
    var person = null; (CACHE.team || []).forEach(function (p) { if (p.id === id) person = p; });
    var pt = person ? person.pay_type : 'hourly';
    var isAdmin = !!(state && state.user && (state.user.role === 'admin' || state.user.role === 'owner' || state.user.isOwner));
    var m = document.createElement('div'); m.className = 'pto-mask';
    m.innerHTML = '<div class="pto-dlg"><h3>Log PTO (after the fact)</h3><div class="pto-desc">For a call-out converted to PTO after the day passed. Records who logged it and why.</div>' +
      '<div class="pto-row"><div><label class="pto-label">Start (past)</label><input type="date" id="pto-log-s" class="pto-input"></div><div><label class="pto-label">End</label><input type="date" id="pto-log-e" class="pto-input"></div></div>' +
      '<label class="pto-label">Type</label><select id="pto-log-paid" class="pto-select"><option value="paid">Approved Vacation Day (paid)</option><option value="unpaid">Unpaid Vacation Day</option><option value="off">Scheduled off (no charge)</option></select>' +
      '<label class="pto-label">' + (isCommission(pt) ? 'Days to deduct' : 'Hours to deduct') + ' <span style="font-weight:400;color:var(--text-dim,#9a9a9a)">(optional — blank = full day)</span></label><input type="number" min="0" step="' + (isCommission(pt) ? '0.5' : '0.1') + '" id="pto-log-hours" class="pto-input" placeholder="' + (isCommission(pt) ? 'e.g. 0.5 for half a day' : 'e.g. 2 for a couple of hours') + '">' +
      '<label class="pto-label">Reason (required)</label><textarea id="pto-log-reason" class="pto-textarea" rows="2" placeholder="e.g. Called out sick, converting to PTO"></textarea>' +
      '<div class="pto-sub" id="pto-log-prev" style="margin-top:8px"></div>' +
      (isAdmin ? '<label class="pto-label" style="display:flex;align-items:center;gap:8px;margin-top:8px;font-weight:400"><input type="checkbox" id="pto-log-neg" style="width:auto"> Allow negative balance (admin exception)</label>' : '') +
      '<div class="pto-warn" id="pto-log-err" style="display:none"></div>' +
      '<div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end"><button class="pto-btn ghost" id="pto-log-cancel">Cancel</button><button class="pto-btn ok" id="pto-log-ok">Log PTO</button></div></div>';
    document.body.appendChild(m);
    var s = m.querySelector('#pto-log-s'), e = m.querySelector('#pto-log-e'), hrsEl = m.querySelector('#pto-log-hours');
    // Explicit amount typed in the field, converted to HOURS (commission staff type days).
    function enteredHours() {
      var v = hrsEl.value;
      if (v === '' || v === null) return null;
      var n = Number(v);
      if (!isFinite(n) || n <= 0) return null;
      return isCommission(pt) ? n * HRS_PER_DAY : n;
    }
    function calDays(a, b) {
      var cs = parseLocal(a), ce = parseLocal(b || a); if (!cs || !ce || ce < cs) return 0;
      return Math.round((ce - cs) / 86400000) + 1;
    }
    function prev() {
      if (!s.value) { m.querySelector('#pto-log-prev').textContent = ''; return; }
      var biz = bizDays(s.value, e.value || s.value);
      var cal = calDays(s.value, e.value || s.value);
      if (!cal) { m.querySelector('#pto-log-prev').textContent = ''; return; }
      var baseDays = biz || cal;
      var paid = m.querySelector('#pto-log-paid').value === 'paid';
      var eh = enteredHours();
      var deduct = eh !== null ? eh : baseDays * HRS_PER_DAY;
      var bal = person ? Number(person.balance_hours) : 0, after = bal - (paid ? deduct : 0);
      var span = eh !== null ? 'you entered' : (baseDays + (biz ? ' business day' : ' day') + (baseDays > 1 ? 's' : ''));
      m.querySelector('#pto-log-prev').innerHTML = 'Deducts <b>' + (paid ? fmtAmt(deduct, pt) : '0 ' + unitLabel(pt)) + '</b> (' + span + ') → after <b style="color:' + (after < 0 ? '#ef4444' : '#22c55e') + '">' + fmtAmt(after, pt) + '</b>';
    }
    s.onchange = e.onchange = prev; hrsEl.oninput = prev; m.querySelector('#pto-log-paid').onchange = prev;
    m.querySelector('#pto-log-cancel').onclick = function () { document.body.removeChild(m); };
    m.querySelector('#pto-log-ok').onclick = async function () {
      var err = m.querySelector('#pto-log-err');
      var payload = { user_id: id, start_date: s.value, end_date: e.value || s.value, kind: m.querySelector('#pto-log-paid').value, paid: m.querySelector('#pto-log-paid').value === 'paid', reason: m.querySelector('#pto-log-reason').value.trim() };
      if (isAdmin && (m.querySelector('#pto-log-neg') || {}).checked) payload.allow_negative = true;
      if (!payload.start_date) { err.textContent = 'Pick the dates.'; err.style.display = 'block'; return; }
      if (!payload.reason) { err.textContent = 'A reason is required.'; err.style.display = 'block'; return; }
      if (hrsEl.value !== '' && hrsEl.value !== null) {
        var eh = enteredHours();
        if (eh === null) { err.textContent = (isCommission(pt) ? 'Days' : 'Hours') + ' must be a positive number, or blank for a full day.'; err.style.display = 'block'; return; }
        payload.hours = eh;
      }
      try { await api('POST', '/pto/log', payload); document.body.removeChild(m); showToast('PTO logged.', 'success'); reload(); }
      catch (ex) { err.textContent = ex.message || 'Could not log.'; err.style.display = 'block'; }
    };
  };

  // ---- AWARD PTO (admin/owner) --------------------------------------------
  window.ptoOpenAward = function (id) {
    var person = null; (CACHE.team || []).forEach(function (p) { if (p.id === id) person = p; });
    var pt = person ? person.pay_type : 'hourly';
    var name = person ? person.name : 'this employee';
    var m = document.createElement('div'); m.className = 'pto-mask';
    m.innerHTML = '<div class="pto-dlg"><h3>Award PTO</h3><div class="pto-desc">Adds bonus time on top of ' + escHtml(name) + '&#39;s current balance. Writes an award entry to their ledger.</div>' +
      '<label class="pto-label">Days to award</label><input type="number" min="0.5" step="0.5" id="pto-aw-days" class="pto-input" placeholder="e.g. 1">' +
      '<label class="pto-label">Reason (required)</label><textarea id="pto-aw-reason" class="pto-textarea" rows="2" placeholder="e.g. Covered a holiday shift"></textarea>' +
      '<div class="pto-sub" id="pto-aw-prev" style="margin-top:8px"></div>' +
      '<div class="pto-warn" id="pto-aw-err" style="display:none"></div>' +
      '<div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end"><button class="pto-btn ghost" id="pto-aw-cancel">Cancel</button><button class="pto-btn ok" id="pto-aw-ok">Award PTO</button></div></div>';
    document.body.appendChild(m);
    var dEl = m.querySelector('#pto-aw-days');
    function prev() {
      var days = Number(dEl.value);
      if (!isFinite(days) || days <= 0) { m.querySelector('#pto-aw-prev').textContent = ''; return; }
      var bal = person ? Number(person.balance_hours) : 0, after = bal + days * HRS_PER_DAY;
      m.querySelector('#pto-aw-prev').innerHTML = 'Adds <b>' + fmtAmt(days * HRS_PER_DAY, pt) + '</b> → new balance <b style="color:#22c55e">' + fmtAmt(after, pt) + '</b>';
    }
    dEl.oninput = prev;
    m.querySelector('#pto-aw-cancel').onclick = function () { document.body.removeChild(m); };
    m.querySelector('#pto-aw-ok').onclick = async function () {
      var err = m.querySelector('#pto-aw-err');
      var payload = { user_id: id, days: Number(dEl.value), reason: m.querySelector('#pto-aw-reason').value.trim() };
      if (!isFinite(payload.days) || payload.days <= 0) { err.textContent = 'Enter a positive number of days.'; err.style.display = 'block'; return; }
      if (!payload.reason) { err.textContent = 'A reason is required.'; err.style.display = 'block'; return; }
      try { await api('POST', '/pto/award', payload); document.body.removeChild(m); showToast('Awarded ' + payload.days + ' day' + (payload.days === 1 ? '' : 's') + ' to ' + name + '.', 'success'); reload(); }
      catch (ex) { err.textContent = ex.message || 'Could not award.'; err.style.display = 'block'; }
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
      '<div class="pto-panel"><h3>Eligibility, Cap &amp; Rollover</h3>' +
        '<div class="pto-row"><div><label class="pto-label">Waiting period (days)</label><input type="number" min="0" id="pto-wait" class="pto-input" value="' + (Number(s.waiting_days) || 90) + '"></div>' +
        '<div><label class="pto-label">Rollover at anniversary (days)</label><input type="number" min="0" step="0.5" id="pto-roll" class="pto-input" value="' + (s.rollover_days === null || s.rollover_days === undefined ? '' : escHtml(String(s.rollover_days))) + '" placeholder="blank = unlimited"></div>' +
        '<div><label class="pto-label">Cap multiplier (\u00d7 annual entitlement)</label><input type="number" min="0" step="0.1" id="pto-capmult" class="pto-input" value="' + (s.cap_multiplier === null || s.cap_multiplier === undefined ? '' : escHtml(String(s.cap_multiplier))) + '" placeholder="1.5"></div></div>' +
        '<div class="pto-flag">Cap = multiplier \u00d7 each tier\u2019s annual days (e.g. 1.5 \u2192 10/15/20-day tiers cap at 15/22/30 days). Rollover forfeits anything above the limit on each hire anniversary.</div></div>' +
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
    var roll = document.getElementById('pto-roll').value, capm = document.getElementById('pto-capmult').value, covd = document.getElementById('pto-cov-def').value;
    var payload = {
      accrual_bands: BANDS.map(function (b) { return { from: Number(b.from) || 0, to: (b.to === '' || b.to === null || b.to === undefined) ? null : Number(b.to), days_per_year: Number(b.days_per_year) || 0 }; }),
      waiting_days: Number(document.getElementById('pto-wait').value) || 0,
      rollover_days: roll === '' ? null : Number(roll),
      cap_multiplier: capm === '' ? null : Number(capm),
      balance_cap_days: null,
      carryover_days: null,
      coverage_default: covd === '' ? null : Number(covd)
    };
    try { await api('PUT', '/pto/settings', payload); showToast('PTO settings saved.', 'success'); }
    catch (e) { showToast(e.message || 'Save failed.', 'error'); }
  }
})();
