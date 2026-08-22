// Employee Records - the structured half of Employee Files.
//
// Loaded AFTER js/onboarding.js on purpose. onboarding.js owns the documents
// half of the employee file (encrypted HR docs) and defines
// window.renderEmployeeFiles / window.onbOpenFile / window.renderMyFile. This
// file wraps those three rather than editing them:
//
//   * renderEmployeeFiles - replaced with the roster + timeline UI, but ONLY for
//     someone holding view_employee_records. Anyone else falls straight through
//     to the original documents-only page, so nothing a manager sees today
//     changes until an admin ticks the box in Roles & Access.
//   * renderMyFile        - wrapped. The shared records render above, then the
//     original My Documents list renders into a child div underneath.
//   * renderHomeScreen    - wrapped, to fill the Recent Wins placeholder.
//
// No backticks anywhere in this file (Windows corrupts them in .js).
(function () {
  'use strict';

  var API = '/employee-records';

  // ------------------------------------------------------------------ state
  var S = {
    view: 'roster',     // roster | file | disciplinary | approve | followup
    employeeId: null,
    recordId: null,
    file: null,
    roster: null,
    meta: null,
    draft: null,
    check: null,
    busy: false
  };

  var TYPE_META = {
    recognition: { label: 'Recognition', dot: '+', cls: 'pos', accent: '#22c55e' },
    coaching: { label: 'Coaching note', dot: '~', cls: 'coach', accent: '#f59e0b' },
    performance: { label: 'Performance note', dot: 'i', cls: 'note', accent: '#60a5fa' },
    disciplinary: { label: 'Disciplinary action', dot: '!', cls: 'neg', accent: '#ef4444' }
  };

  var STATUS_BADGE = {
    draft: ['badge-draft', 'Draft'],
    returned: ['badge-waiting', 'Sent back'],
    pending_approval: ['badge-waiting', 'Pending approval'],
    sent: ['badge-awaiting-signature', 'Awaiting signature'],
    signed: ['badge-signed', 'Signed'],
    refused: ['badge-rejected', 'Refused'],
    expired: ['badge-rejected', 'Expired'],
    closed: ['badge-completed', 'Closed'],
    void: ['badge-void', 'Void'],
    active: ['', '']
  };

  function esc(s) { return (typeof escHtml === 'function') ? escHtml(s) : String(s === null || s === undefined ? '' : s); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t); }
  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value : ''; }
  function checked(id) { var e = el(id); return !!(e && e.checked); }
  function content() { return document.getElementById('content'); }

  function shortDate(d) {
    if (!d) return '';
    try { return (typeof formatDate === 'function') ? formatDate(d) : String(d).slice(0, 10); }
    catch (e) { return String(d).slice(0, 10); }
  }

  function relDays(d) {
    if (!d) return '';
    var then = new Date(d).getTime();
    if (!isFinite(then)) return '';
    var days = Math.floor((Date.now() - then) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30) return days + ' days ago';
    if (days < 60) return 'Last month';
    return Math.floor(days / 30) + ' months ago';
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    return ((parts[0] || '')[0] || '?').toUpperCase() + ((parts[1] || '')[0] || '').toUpperCase();
  }

  function badge(status) {
    var b = STATUS_BADGE[status];
    if (!b || !b[0]) return '';
    return '<span class="badge ' + b[0] + '">' + b[1] + '</span>';
  }

  // ------------------------------------------------------------------ css
  var cssDone = false;
  function injectCss() {
    if (cssDone) return;
    cssDone = true;
    var st = document.createElement('style');
    st.textContent = [
      '.er-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:20px;flex-wrap:wrap}',
      '.er-tab{padding:10px 16px;font-size:14px;font-weight:500;color:var(--text-muted-color);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}',
      '.er-tab:hover{color:var(--text)}',
      '.er-tab.active{color:var(--primary);border-bottom-color:var(--primary);font-weight:600}',
      '.er-tab .er-c{font-size:11px;color:var(--text-muted-color);margin-left:5px}',
      '.er-tl{position:relative;padding-left:30px}',
      '.er-tl:before{content:"";position:absolute;left:9px;top:10px;bottom:10px;width:2px;background:var(--border)}',
      '.er-ev{position:relative;margin-bottom:14px}',
      '.er-dot{position:absolute;left:-30px;top:14px;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:3px solid var(--bg-card)}',
      '.er-dot.pos{background:#22c55e;color:#04240f}.er-dot.neg{background:#ef4444;color:#2d0505}',
      '.er-dot.coach{background:#f59e0b;color:#2d1c00}.er-dot.note{background:#60a5fa;color:#06182d}',
      '.er-card{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:13px 15px}',
      '.er-card.pos{border-left:3px solid #22c55e}.er-card.neg{border-left:3px solid #ef4444}',
      '.er-card.coach{border-left:3px solid #f59e0b}.er-card.note{border-left:3px solid #60a5fa}',
      '.er-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:5px;flex-wrap:wrap}',
      '.er-title{font-size:14px;font-weight:600;color:var(--text)}',
      '.er-body{font-size:13px;color:var(--text-dim);line-height:1.55;white-space:pre-wrap}',
      '.er-meta{font-size:12px;color:var(--text-muted-color);margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.er-meta .sep{opacity:.4}',
      '.er-eye{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px}',
      '.er-eye.on{background:#0d1e30;color:#60a5fa;border:1px solid #1e3a5f}',
      '.er-eye.off{background:#1a1a1a;color:#777;border:1px solid #2a2a2a}',
      '.er-acts{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}',
      '.er-ladder{display:flex;gap:5px}',
      '.er-step{flex:1;text-align:center;padding:8px 3px;border-radius:6px;font-size:10.5px;line-height:1.3;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text-muted-color)}',
      '.er-step.done{background:#2d2100;color:#f59e0b;border-color:#4a3500}',
      '.er-step.cur{background:#2d0d0d;color:#f87171;border-color:#4d1515;font-weight:700}',
      '.er-kv{display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid var(--border-light)}',
      '.er-kv:last-child{border-bottom:none}',
      '.er-kv span:first-child{color:var(--text-muted-color)}',
      '.er-kv span:last-child{color:var(--text);font-weight:600}',
      '.er-type{border:1px solid var(--border);background:var(--bg-elevated);border-radius:var(--radius);padding:11px 12px;cursor:pointer;text-align:left}',
      '.er-type.sel{border-color:var(--primary);background:rgba(249,115,22,0.10)}',
      '.er-type b{display:block;font-size:13px;color:var(--text);margin-bottom:2px}',
      '.er-type small{font-size:11px;color:var(--text-muted-color);line-height:1.4;display:block}',
      '.er-types{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '@media(max-width:640px){.er-types{grid-template-columns:1fr}}',
      '.er-toggle{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-elevated);cursor:pointer}',
      '.er-sw{width:38px;height:22px;border-radius:20px;background:#333;position:relative;flex-shrink:0;transition:background .15s}',
      '.er-sw:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#888;transition:left .15s,background .15s}',
      '.er-sw.on{background:rgba(249,115,22,.35)}.er-sw.on:after{left:19px;background:var(--primary)}',
      '.er-ai{border:1px solid #3b1f6e;background:#150c26;border-radius:var(--radius);padding:12px 14px;margin-top:10px}',
      '.er-ai.clear{border-color:#134d27;background:#0b1c12}',
      '.er-ai h5{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:#c084fc;font-weight:700;margin-bottom:9px}',
      '.er-ai.clear h5{color:#4ade80}',
      '.er-flag{display:flex;gap:9px;padding:8px 0;border-top:1px solid rgba(255,255,255,.06);font-size:12.5px;line-height:1.55;color:var(--text-dim)}',
      '.er-flag:first-of-type{border-top:none;padding-top:0}',
      '.er-flag b{color:var(--text)}',
      '.er-fdot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex-shrink:0}',
      '.er-fdot.red{background:#ef4444}.er-fdot.amber{background:#f59e0b}.er-fdot.green{background:#22c55e}',
      '.er-sugg{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:11px 13px;margin-top:10px;font-size:12.5px;line-height:1.6;color:var(--text-dim)}',
      '.er-bar{height:7px;border-radius:4px;background:var(--bg-elevated);overflow:hidden;margin:9px 0 6px}',
      '.er-bar i{display:block;height:100%;background:var(--warning)}',
      '.er-two{display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start}',
      '@media(max-width:1000px){.er-two{grid-template-columns:1fr}}',
      '.er-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}',
      '.er-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
      '@media(max-width:640px){.er-grid3,.er-grid2{grid-template-columns:1fr}}',
      '.er-row{cursor:pointer}',
      '.er-spark{display:flex;align-items:flex-end;gap:3px;height:44px;margin:12px 0 6px}',
      '.er-sb{flex:1;min-width:4px;border-radius:2px 2px 0 0;background:var(--bg-elevated);position:relative}',
      '.er-sb.hit{background:var(--warning)}',
      '.er-sblab{display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-muted-color)}',
      '.er-row:hover td{background:rgba(249,115,22,0.06)}',
      '.er-win{display:flex;gap:12px;padding:13px 0;border-bottom:1px solid var(--border-light)}',
      '.er-win:last-child{border-bottom:none}',
      '.er-win .who{font-size:13.5px;font-weight:600;color:var(--text)}',
      '.er-win .cat{font-size:12px;color:var(--text-muted-color)}',
      '.er-win .txt{font-size:13px;color:var(--text-dim);line-height:1.55;margin-top:4px;white-space:pre-wrap}',
      '.er-you{font-size:10px;font-weight:800;letter-spacing:.08em;background:rgba(249,115,22,.16);color:var(--primary);border:1px solid rgba(249,115,22,.4);padding:1px 6px;border-radius:4px;margin-left:7px;vertical-align:middle}',
      '.er-pad{background:#fff;border-radius:6px;height:130px;position:relative;overflow:hidden;touch-action:none;cursor:crosshair}',
      '.er-pad canvas{display:block;width:100%;height:100%}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------ data
  async function loadMeta() {
    if (S.meta) return S.meta;
    S.meta = await api('GET', API + '/meta');
    return S.meta;
  }

  // ==================================================================
  // ROSTER
  // ==================================================================
  async function renderRoster(host) {
    host.innerHTML = '<div class="loading">Loading…</div>';
    var d;
    try { d = await api('GET', API + '/roster'); }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load.') + '</div>'; return; }
    S.roster = d;
    var s = d.stats || {};

    var warn = d.no_city
      ? '<div class="alert alert-warn" style="margin-bottom:20px"><b>' + d.no_city + ' ' +
        (d.no_city === 1 ? 'employee has' : 'employees have') + ' no Home City set.</b><br>' +
        '<span style="font-size:13px">City scoping reads Home City, so until it is filled in those people ' +
        'will not appear here for a city manager. Fix it under Settings &gt; Users.</span></div>'
      : '';

    var approvalsBtn = can('approve_discipline') && s.pending_approval
      ? '<button class="btn btn-secondary" onclick="erOpenApprovals()">Approvals (' + s.pending_approval + ')</button>' : '';

    var rows = (d.employees || []).map(function (u) {
      var c = u.counts || {};
      var chips = [];
      if (c.recognition) chips.push('<span class="badge badge-completed">' + c.recognition + ' positive</span>');
      if (c.coaching) chips.push('<span class="badge badge-waiting">' + c.coaching + ' coaching</span>');
      if (c.performance) chips.push('<span class="badge badge-active">' + c.performance + ' note' + (c.performance === 1 ? '' : 's') + '</span>');
      if (c.disciplinary) chips.push('<span class="badge badge-rejected">' + c.disciplinary + ' formal</span>');
      if (!chips.length) chips.push('<span style="color:var(--text-muted-color);font-size:13px">No records</span>');
      // The whole row opens the file. The button stays because it is the thing
      // people look for, but it stops the click so the row handler does not
      // also fire and open the same file twice.
      return '<tr class="er-row" onclick="erOpenFile(' + u.id + ')">' +
        '<td><div style="display:flex;align-items:center;gap:10px">' +
        '<div class="avatar" style="width:28px;height:28px;font-size:11px">' + esc(initials(u.name)) + '</div>' +
        '<div><div style="color:var(--text);font-weight:500">' + esc(u.name) + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color)">' + esc(u.role || '') + '</div></div></div></td>' +
        '<td>' + esc(u.home_city || '—') + '</td>' +
        '<td>' + chips.join(' ') + '</td>' +
        '<td>' + (u.doc_count || 0) + '</td>' +
        '<td>' + esc(relDays(u.last_activity)) + '</td>' +
        '<td style="text-align:right"><button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();erOpenFile(' + u.id + ')">Open file</button></td>' +
        '</tr>';
    }).join('');

    host.innerHTML =
      '<div class="page-header"><div><h2 style="font-size:22px;font-weight:600">Employee Files</h2>' +
      '<p style="font-size:13px;color:var(--text-muted-color);margin-top:4px">' + (s.people || 0) +
      ' ' + ((s.people === 1) ? 'person' : 'people') + ' you can open</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' + approvalsBtn + '</div></div>' +

      '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-value">' + (s.people || 0) + '</div><div class="stat-label">People in scope</div></div>' +
      '<div class="stat-card"><div class="stat-value" style="color:var(--success)">' + (s.praise_90 || 0) + '</div><div class="stat-label">Recognition &middot; last 90 days</div></div>' +
      '<div class="stat-card"><div class="stat-value" style="color:var(--warning)">' + (s.open_followups || 0) + '</div><div class="stat-label">Open follow-ups</div></div>' +
      '<div class="stat-card"><div class="stat-value" style="color:var(--danger)">' + (s.awaiting_signature || 0) + '</div><div class="stat-label">Awaiting signature</div></div>' +
      '</div>' + warn +

      '<div class="card"><div class="card-header">' +
      '<input id="er-search" placeholder="Search employees…" style="width:260px" oninput="erFilterRoster()">' +
      '<span style="font-size:12px;color:var(--text-muted-color)">Sorted by name</span></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th>Employee</th><th>City</th><th>Records &middot; last 12 months</th><th>Docs</th><th>Last activity</th><th></th>' +
      '</tr></thead><tbody id="er-rows">' + (rows || '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted-color)">Nobody in scope yet.</td></tr>') +
      '</tbody></table></div></div>';
  }

  window.erFilterRoster = function () {
    var q = String(val('er-search') || '').toLowerCase();
    var body = el('er-rows');
    if (!body) return;
    Array.prototype.forEach.call(body.querySelectorAll('tr'), function (tr) {
      tr.style.display = (!q || tr.textContent.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
    });
  };

  // ==================================================================
  // ONE FILE
  // ==================================================================
  window.erOpenFile = async function (id, tab) {
    S.view = 'file'; S.employeeId = id; S.tab = tab || 'timeline';
    var host = content();
    if (!host) return;
    host.innerHTML = '<div class="loading">Loading…</div>';
    try {
      S.file = await api('GET', API + '/employee/' + id);
      await loadMeta();
    } catch (e) {
      host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load.') + '</div>';
      return;
    }
    drawFile();
  };

  function drawFile() {
    var host = content(); if (!host) return;
    var d = S.file, u = d.user;
    var tabs = [
      ['timeline', 'Timeline', (d.records || []).length],
      ['documents', 'Documents', null]
    ];
    host.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;color:var(--text-muted-color);cursor:pointer" onclick="erBackToRoster()">&#8592; Employee Files</div>' +
      '<div class="page-header"><div style="display:flex;align-items:center;gap:14px">' +
      '<div class="avatar" style="width:46px;height:46px;font-size:17px">' + esc(initials(u.name)) + '</div>' +
      '<div><h2 style="font-size:22px;font-weight:600">' + esc(u.name) + '</h2>' +
      '<p style="font-size:13px;color:var(--text-muted-color);margin-top:3px">' + esc(u.role || '') +
      (u.home_city ? ' &middot; ' + esc(u.home_city) : '') +
      (u.supervisor ? ' &middot; Reports to ' + esc(u.supervisor.name) : '') +
      (u.has_email ? '' : ' &middot; <span style="color:var(--warning)">no email on file</span>') +
      '</p></div></div>' +
      (d.can_act && can('create_employee_note')
        ? '<button class="btn btn-primary" onclick="erNewRecord()">+ New Record</button>' : '') +
      '</div>' +
      '<div class="er-tabs">' + tabs.map(function (t) {
        return '<div class="er-tab' + (S.tab === t[0] ? ' active' : '') + '" onclick="erTab(\'' + t[0] + '\')">' +
          t[1] + (t[2] !== null ? '<span class="er-c">' + t[2] + '</span>' : '') + '</div>';
      }).join('') + '</div>' +
      '<div id="er-tabbody"></div>';
    drawTab();
  }

  window.erTab = function (t) { S.tab = t; drawFile(); };
  window.erBackToRoster = function () { S.view = 'roster'; renderRoster(content()); };

  function drawTab() {
    var host = el('er-tabbody'); if (!host) return;
    if (S.tab === 'documents') {
      // Hand straight back to the original documents view from onboarding.js.
      host.innerHTML = '<div id="onb-ef-body"><div class="loading">Loading…</div></div>';
      if (typeof window.onbOpenFile === 'function') window.onbOpenFile(S.employeeId);
      else host.innerHTML = '<div class="alert alert-error">The documents view is unavailable.</div>';
      return;
    }
    host.innerHTML = '<div class="er-two"><div>' + timelineHtml() + '</div><div>' + sideHtml() + '</div></div>';
  }

  function timelineHtml() {
    var recs = S.file.records || [];
    if (!recs.length) {
      return '<div class="card"><div class="empty-state"><h3>Nothing on file yet</h3>' +
        '<p style="font-size:13px">Recognition, coaching notes and formal notices all land here, in order.</p></div></div>';
    }
    return '<div class="er-tl">' + recs.map(eventHtml).join('') + '</div>';
  }

  function eventHtml(r) {
    var tm = TYPE_META[r.type] || TYPE_META.performance;
    var title = (r.type === 'disciplinary' ? (r.level_label || 'Disciplinary action') : tm.label) +
      (r.category ? ' &middot; ' + esc(r.category) : '');
    var eye = r.visible_to_employee
      ? '<span class="er-eye on">Visible to employee</span>'
      : '<span class="er-eye off">Internal only</span>';
    var meta = [esc(shortDate(r.occurred_on || r.created_at))];
    if (r.created_by_name) meta.push(esc(r.created_by_name));
    if (r.type === 'disciplinary' && r.level) meta.push('Level ' + r.level + ' of 5');
    if (r.approver_name && r.approved_at) meta.push('Approved by ' + esc(r.approver_name));
    if (r.signed_at) meta.push('Signed ' + esc(shortDate(r.signed_at)));
    if (r.refused_at) meta.push('Refused ' + esc(shortDate(r.refused_at)));
    if (r.followup_on && !r.followup_outcome) meta.push('Follow-up ' + esc(shortDate(r.followup_on)));
    if (r.followup_outcome) meta.push('Follow-up: ' + esc(r.followup_outcome.replace('_', ' ')));
    meta.push(eye);
    if (r.show_in_wins) meta.push('<span class="er-eye on">In Recent Wins</span>');

    return '<div class="er-ev"><div class="er-dot ' + tm.cls + '">' + tm.dot + '</div>' +
      '<div class="er-card ' + tm.cls + '">' +
      '<div class="er-head"><div class="er-title">' + title + '</div>' + badge(r.status) + '</div>' +
      '<div class="er-body">' + esc(r.body || '') + '</div>' +
      (r.corrective_action ? '<div class="er-body" style="margin-top:8px"><b style="color:var(--text)">Must change:</b> ' + esc(r.corrective_action) + '</div>' : '') +
      (r.employee_response ? '<div class="er-sugg"><b style="color:var(--text)">Employee response</b><br>' + esc(r.employee_response) + '</div>' : '') +
      (r.void_reason ? '<div class="er-meta" style="color:#f87171">Voided: ' + esc(r.void_reason) + '</div>' : '') +
      '<div class="er-meta">' + meta.join(' <span class="sep">&middot;</span> ') + '</div>' +
      actionsHtml(r) + '</div></div>';
  }

  function actionsHtml(r) {
    var a = [];
    var mine = S.file && S.file.can_act;
    if (r.type === 'disciplinary') {
      if ((r.status === 'draft' || r.status === 'returned') && can('create_disciplinary')) {
        a.push(btn('Continue draft', 'btn-primary', 'erEditDisciplinary(' + r.id + ')'));
        a.push(btn('Delete draft', 'btn-ghost', 'erDeleteDraft(' + r.id + ')'));
      }
      if (r.status === 'sent' && mine && can('create_disciplinary')) {
        a.push(btn('Resend', 'btn-secondary', 'erResend(' + r.id + ',false)'));
        a.push(btn('Extend 14 days', 'btn-ghost', 'erResend(' + r.id + ',true)'));
        a.push(btn('Will not sign', 'btn-danger', 'erRefuse(' + r.id + ')'));
      }
      if (r.status === 'expired' && mine && can('create_disciplinary')) {
        a.push(btn('Record what happened', 'btn-danger', 'erRefuse(' + r.id + ')'));
      }
      if (r.followup_on && !r.followup_outcome && ['signed', 'refused', 'expired', 'sent'].indexOf(r.status) !== -1 && mine && can('create_disciplinary')) {
        a.push(btn('Follow-up', 'btn-secondary', 'erFollowup(' + r.id + ')'));
      }
    }
    if (r.status !== 'void' && can('manage_employee_records')) {
      a.push(btn('Void', 'btn-ghost', 'erVoid(' + r.id + ')'));
    }
    a.push(btn('History', 'btn-ghost', 'erHistory(' + r.id + ')'));
    return a.length ? '<div class="er-acts">' + a.join('') + '</div>' : '';
  }

  function btn(label, cls, onclick) {
    return '<button class="btn ' + cls + ' btn-sm" onclick="' + onclick + '">' + label + '</button>';
  }

  /* The right-hand rail.
     Written to state what is TRUE about this person, in that order, rather than
     to lay out every possible bad outcome up front. A file with nothing on it
     used to open with an empty five-rung discipline ladder and a red zero,
     which framed somebody before they had done anything. Two rules came out of
     that and both are load-bearing:

       1. A zero is never coloured. Colour has to mean something, and painting a
          clean file in warning colours spends the meaning on nothing.
       2. A card that has nothing to say does not render. The ladder appears
          once there is a notice on it and not before; the late-deposit card
          appears once something has been marked late.

     The tone is deliberately flat rather than encouraging. A card that
     congratulates somebody for having no records would look ridiculous sitting
     on the file of somebody who has two warnings, and the same words have to
     work on both. */
  function sideHtml() {
    var d = S.file, L = d.ladder || {};
    var levels = (S.meta && S.meta.levels) || [];
    var recs = (d.records || []).filter(function (r) { return r.status !== 'void' && r.status !== 'draft'; });

    var counts = { recognition: 0, coaching: 0, performance: 0, disciplinary: 0 };
    recs.forEach(function (r) { if (counts[r.type] !== undefined) counts[r.type]++; });
    var total = counts.recognition + counts.coaching + counts.performance + counts.disciplinary;

    var lateAvail = !!(d.late_deposits && d.late_deposits.available);
    var lateCount = (d.late_deposits && d.late_deposits.count) || 0;
    var shCount = (d.shortages && d.shortages.count) || 0;
    var shTotal = (d.shortages && d.shortages.total) || 0;

    // Anything actually waiting on somebody. These are the only things that
    // earn a colour on an otherwise quiet file.
    var open = [];
    recs.forEach(function (r) {
      if (r.status === 'sent') open.push('a notice awaiting signature');
      else if (r.status === 'pending_approval') open.push('a notice awaiting approval');
      else if (r.status === 'expired') open.push('a signature request that expired');
      if (r.followup_on && !r.followup_outcome && ['signed', 'refused', 'expired', 'sent'].indexOf(r.status) !== -1) {
        open.push('a follow-up due ' + shortDate(r.followup_on));
      }
    });

    // ---- Standing -----------------------------------------------------------
    var line, dot;
    if (L.highest_live) {
      line = 'Highest live level: ' + esc(levelName(L.highest_live)) + '.';
      dot = 'var(--danger)';
    } else if (total === 0 && !lateCount && !shCount) {
      line = 'Nothing on record in the last 12 months.';
      dot = 'var(--success)';
    } else if (counts.disciplinary === 0 && counts.coaching === 0 && !lateCount && !shCount) {
      line = total + ' record' + (total === 1 ? '' : 's') + ' on file, none of it disciplinary.';
      dot = 'var(--success)';
    } else {
      line = total + ' record' + (total === 1 ? '' : 's') + ' in the last 12 months. No live notice.';
      dot = 'var(--text-muted-color)';
    }
    var second = [];
    if (lateAvail && !lateCount) second.push('No deposits marked late.');
    if (lateCount) second.push(lateCount + ' deposit' + (lateCount === 1 ? '' : 's') + ' marked late.');
    if (shCount) second.push(shCount + ' pay week' + (shCount === 1 ? '' : 's') + ' with cash unaccounted for.');
    if (open.length) {
      // Sentence-cased, because this lands after a full stop rather than
      // mid-sentence: "3 deposits marked late. A notice awaiting signature."
      var o = open.slice(0, 2).join(' and ');
      second.push(o.charAt(0).toUpperCase() + o.slice(1) + '.');
    }

    var standing =
      '<div class="card" style="margin-bottom:14px"><div class="card-header">' +
      '<div class="card-title">Standing</div>' +
      '<span style="font-size:12px;color:var(--text-muted-color)">last 12 months</span></div>' +
      '<div class="card-body">' +
      '<div style="display:flex;gap:9px;align-items:flex-start">' +
      '<div style="width:9px;height:9px;border-radius:50%;background:' + dot + ';margin-top:5px;flex-shrink:0"></div>' +
      '<div><div style="font-size:14px;color:var(--text);line-height:1.5">' + line + '</div>' +
      (second.length
        ? '<div style="font-size:12.5px;color:var(--text-muted-color);margin-top:5px;line-height:1.6">' + second.join(' ') + '</div>'
        : '') +
      '</div></div></div></div>';

    // ---- Late deposits, only when there are some ----------------------------
    var lateCard = '';
    if (lateAvail && lateCount) {
      lateCard = '<div class="card" style="margin-bottom:14px;border-color:#4a3500">' +
        '<div class="card-header" style="border-bottom-color:#4a3500">' +
        '<div class="card-title">Late deposits</div>' +
        '<span style="font-size:12px;color:var(--text-muted-color)">last 12 months</span></div>' +
        '<div class="card-body">' +
        '<div style="font-size:28px;font-weight:700;font-family:\'Fira Code\',ui-monospace,monospace;color:var(--warning)">' + lateCount + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px;line-height:1.6">' +
        'Marked by a manager on the deposit or the Pulsar board. Documenting them pulls the real dates in, ' +
        'so nothing is written from memory.</div>' +
        sparkHtml(d.late_deposits.by_month, d.late_deposits.months) +
        (d.can_act && can('create_employee_note')
          ? '<button class="btn btn-secondary btn-sm" style="margin-top:12px;width:100%;justify-content:center" ' +
            'onclick="erDocumentLate()">Document these</button>' : '') +
        '</div></div>';
    }

    // ---- Unaccounted cash, only when a manager established that it was -------
    // Explained gaps never reach this file. An unlogged expense or a typo
    // closed the row on the reconciliation board and stopped there.
    var shCard = '';
    if (shCount) {
      shCard = '<div class="card" style="margin-bottom:14px;border-color:#4d1515">' +
        '<div class="card-header" style="border-bottom-color:#4d1515">' +
        '<div class="card-title">Cash unaccounted for</div>' +
        '<span style="font-size:12px;color:var(--text-muted-color)">last 12 months</span></div>' +
        '<div class="card-body">' +
        '<div style="font-size:28px;font-weight:700;font-family:\'Fira Code\',ui-monospace,monospace;color:#f87171">' +
        shCount + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px;line-height:1.6">' +
        'Pay week' + (shCount === 1 ? '' : 's') + ' where a manager established the gap was not an expense, a typo ' +
        'or a Pulsar error. $' + Number(shTotal).toFixed(2) + ' in total.</div>' +
        (d.can_act && can('create_employee_note')
          ? '<button class="btn btn-secondary btn-sm" style="margin-top:12px;width:100%;justify-content:center" ' +
            'onclick="erDocumentShortages()">Document these</button>' : '') +
        '</div></div>';
    }

    // ---- The ladder, only once there is something on it ---------------------
    var ladderCard = '';
    if (L.total_count) {
      var steps = levels.map(function (lv) {
        var cls = '';
        if (lv.n <= L.highest_live) cls = ' done';
        if (lv.n === L.highest_live) cls = ' cur';
        var short = lv.label.replace(' Warning (documented)', '').replace(' Warning', '');
        return '<div class="er-step' + cls + '">' + esc(short) + '</div>';
      }).join('');
      ladderCard = '<div class="card" style="margin-bottom:14px"><div class="card-header">' +
        '<div class="card-title">Progressive discipline</div></div>' +
        '<div class="card-body"><div class="er-ladder" style="margin-bottom:12px">' + steps + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color)">' +
        (L.highest_live
          ? 'Highest live level: ' + esc(levelName(L.highest_live)) + '. '
          : 'Nothing live. ' + L.total_count + ' past notice' + (L.total_count === 1 ? '' : 's') + ' outside the window. ') +
        'Ladder position is informational; nothing escalates automatically, and a notice past its window stays ' +
        'on the file but stops counting.</div></div></div>';
    }

    // ---- Counts. A zero is grey, always. ------------------------------------
    function kv(label, n, colour) {
      return '<div class="er-kv"><span>' + label + '</span>' +
        '<span' + (n ? ' style="color:' + colour + '"' : ' style="color:var(--text-muted-color);font-weight:400"') + '>' + n + '</span></div>';
    }
    var countsCard =
      '<div class="card" style="margin-bottom:14px"><div class="card-header"><div class="card-title">Last 12 months</div></div>' +
      '<div class="card-body" style="padding:8px 20px">' +
      kv('Recognition', counts.recognition, 'var(--success)') +
      kv('Coaching notes', counts.coaching, 'var(--warning)') +
      kv('Performance notes', counts.performance, 'var(--text)') +
      kv('Formal discipline', counts.disciplinary, 'var(--danger)') +
      '</div></div>';

    // ---- Add to file --------------------------------------------------------
    // Recognition is the only filled button. A filled red one invites clicking,
    // and that is the action you least want to be easy.
    var add = '';
    if (d.can_act && can('create_employee_note')) {
      add = '<div class="card" style="margin-bottom:14px"><div class="card-header"><div class="card-title">Add to file</div></div>' +
        '<div class="card-body" style="display:flex;flex-direction:column;gap:8px">' +
        '<button class="btn btn-success btn-sm" style="justify-content:flex-start" onclick="erNewRecord(\'recognition\')">Recognition</button>' +
        '<button class="btn btn-secondary btn-sm" style="justify-content:flex-start" onclick="erNewRecord(\'coaching\')">Coaching note</button>' +
        '<button class="btn btn-secondary btn-sm" style="justify-content:flex-start" onclick="erNewRecord(\'performance\')">Performance note</button>' +
        (can('create_disciplinary')
          ? '<button class="btn btn-secondary btn-sm" style="justify-content:flex-start;color:#f87171;border-color:#4d1515" ' +
            'onclick="erNewDisciplinary()">Disciplinary action</button>' : '') +
        '</div></div>';
    }

    var who = '<div class="card"><div class="card-header"><div class="card-title">Who can see this file</div></div>' +
      '<div class="card-body"><div style="font-size:12px;color:var(--text-muted-color);line-height:1.7">' +
      'A file can only be opened by somebody above the person it belongs to. Two admins cannot read each ' +
      'other, and neither can two managers in the same city. Owner and admins reach everyone below them; ' +
      'managers reach their own city and their own downline. ' +
      esc(S.file.user.name.split(' ')[0]) + ' sees only the records marked visible.' +
      '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-light)">' +
      'Opening a disciplinary record is written to the audit log, so ' + esc(S.file.user.name.split(' ')[0]) +
      ' can always be told who has read their file.</div>' +
      '</div></div></div>';

    return standing + shCard + lateCard + ladderCard + countsCard + add + who;
  }

  // Twelve months of late deposits as a bar per month. Empty months are drawn
  // as flat stubs rather than skipped, because the gaps are the point: three in
  // a row reads differently from three spread over a year, and a table of
  // counts hides that difference completely.
  function sparkHtml(byMonth, months) {
    months = months || 12;
    var have = {};
    (byMonth || []).forEach(function (b) { have[b.month] = b.count; });
    var keys = [], now = new Date();
    for (var i = months - 1; i >= 0; i--) {
      var dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.push(dt.getFullYear() + '-' + (dt.getMonth() + 1 < 10 ? '0' : '') + (dt.getMonth() + 1));
    }
    var max = 1;
    keys.forEach(function (k) { if ((have[k] || 0) > max) max = have[k]; });
    if (!Object.keys(have).length) return '';
    var bars = keys.map(function (k) {
      var n = have[k] || 0;
      var pct = n ? Math.max(14, Math.round((n / max) * 100)) : 6;
      return '<div class="er-sb' + (n ? ' hit' : '') + '" style="height:' + pct + '%" title="' + k + ': ' + n + '"></div>';
    }).join('');
    var first = keys[0], last = keys[keys.length - 1];
    return '<div class="er-spark">' + bars + '</div>' +
      '<div class="er-sblab"><span>' + esc(monthLabel(first)) + '</span><span>' + esc(monthLabel(last)) + '</span></div>';
  }

  function monthLabel(ym) {
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = String(ym || '').split('-');
    return (M[parseInt(p[1], 10) - 1] || '') + ' ' + String(p[0] || '').slice(2);
  }

  function levelName(n) {
    var levels = (S.meta && S.meta.levels) || [];
    for (var i = 0; i < levels.length; i++) if (levels[i].n === n) return levels[i].label;
    return '';
  }

  // Pull the real late-deposit dates and open a record pre-filled with them.
  // The manager still writes the judgment; Nova only supplies the facts it
  // already holds, which is the half that gets remembered wrongly.
  window.erDocumentLate = async function () {
    var d;
    try { d = await api('GET', API + '/employee/' + S.employeeId + '/late-deposits'); }
    catch (e) { toast(e.message || 'Could not load the late deposits.', 'error'); return; }
    if (!d.late || !d.late.count) { toast('Nothing marked late.', 'info'); return; }
    var rows = d.late.deposits.map(function (x) {
      return '<div class="er-kv"><span>' + esc(x.date || '') + (x.number ? ' &middot; ' + esc(x.number) : '') + '</span>' +
        '<span style="font-weight:400;color:var(--text-muted-color)">' + esc(x.reason || (x.marked_by ? 'marked by ' + x.marked_by : '')) + '</span></div>';
    }).join('');
    modal('Document late deposits &middot; ' + esc(S.file.user.name),
      '<div style="font-size:13px;color:var(--text-dim);line-height:1.6;margin-bottom:14px">' +
      'These are the deposits a manager marked late in the last 12 months. Pick what kind of record this ' +
      'should be; the dates go in for you and you write the rest.</div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-body" style="padding:6px 16px">' + rows + '</div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>What kind of record</label><div class="er-types">' +
      '<div class="er-type sel" id="er-lk-coaching" onclick="erPickLateKind(\'coaching\')"><b>Coaching note</b>' +
      '<small>A documented conversation. Internal, no signature, no approval.</small></div>' +
      (can('create_disciplinary')
        ? '<div class="er-type" id="er-lk-disciplinary" onclick="erPickLateKind(\'disciplinary\')"><b>Disciplinary notice</b>' +
          '<small>Opens the full form at the level the ladder suggests, needs approval.</small></div>' : '') +
      '</div></div>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" onclick="erStartLateRecord()">Continue</button>', 640);
    S.lateKind = 'coaching';
    S.lateText = d.suggested_text || '';
  };

  window.erPickLateKind = function (k) {
    S.lateKind = k;
    ['coaching', 'disciplinary'].forEach(function (x) {
      var e = el('er-lk-' + x);
      if (e) e.className = 'er-type' + (x === k ? ' sel' : '');
    });
  };

  window.erStartLateRecord = function () {
    var text = S.lateText || '';
    closeModal();
    if (S.lateKind === 'disciplinary') {
      S.draft = null; S.check = null;
      openDisciplinary(null);
      setTimeout(function () {
        var b = el('er-body');
        if (b && !b.value) b.value = text;
        var cat = el('er-cat');
        if (cat) { for (var i = 0; i < cat.options.length; i++) if (cat.options[i].value === 'Cash handling') cat.selectedIndex = i; }
        var sop = el('er-sop');
        if (sop && !sop.value) sop.value = 'Cash deposit policy';
        toast('Dates filled in. Write what must change, then check the wording.', 'info');
      }, 30);
      return;
    }
    window.erNewRecord('coaching');
    setTimeout(function () {
      var b = el('er-body');
      if (b && !b.value) b.value = text;
      var cat = el('er-cat');
      if (cat) { for (var i = 0; i < cat.options.length; i++) if (cat.options[i].value === 'Cash handling') cat.selectedIndex = i; }
    }, 30);
  };

  // Same shape as the late-deposit bridge: pull the real pay weeks and amounts,
  // pre-fill a record with them, and let the manager write the judgment.
  window.erDocumentShortages = async function () {
    var d;
    try { d = await api('GET', API + '/employee/' + S.employeeId + '/shortages'); }
    catch (e) { toast(e.message || 'Could not load the shortages.', 'error'); return; }
    if (!d.shortages || !d.shortages.count) { toast('Nothing unaccounted for.', 'info'); return; }
    var rows = d.shortages.shortages.map(function (x) {
      return '<div class="er-kv"><span>Week of ' + esc(x.period_start) + '</span>' +
        '<span style="color:#f87171">$' + Number(x.amount).toFixed(2) + '</span></div>' +
        (x.note ? '<div style="font-size:12px;color:var(--text-muted-color);padding:0 0 8px">' + esc(x.note) + '</div>' : '');
    }).join('');
    modal('Document unaccounted cash &middot; ' + esc(S.file.user.name),
      '<div style="font-size:13px;color:var(--text-dim);line-height:1.6;margin-bottom:14px">' +
      'These are the pay weeks where a manager established the gap was not an expense, a typo or a Pulsar ' +
      'error. The dates and amounts go in for you; you write the rest.</div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-body" style="padding:6px 16px">' + rows + '</div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>What kind of record</label><div class="er-types">' +
      '<div class="er-type sel" id="er-lk-coaching" onclick="erPickLateKind(\'coaching\')"><b>Coaching note</b>' +
      '<small>A documented conversation. Internal, no signature, no approval.</small></div>' +
      (can('create_disciplinary')
        ? '<div class="er-type" id="er-lk-disciplinary" onclick="erPickLateKind(\'disciplinary\')"><b>Disciplinary notice</b>' +
          '<small>Opens the full form at the level the ladder suggests, needs approval.</small></div>' : '') +
      '</div></div>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" onclick="erStartLateRecord()">Continue</button>', 640);
    S.lateKind = 'coaching';
    S.lateText = d.suggested_text || '';
  };

  // ==================================================================
  // MODAL PLUMBING
  // ==================================================================
  function modal(title, bodyHtml, footerHtml, width) {
    closeModal();
    var wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.id = 'er-modal';
    wrap.innerHTML = '<div class="modal" style="max-width:' + (width || 620) + 'px">' +
      '<div class="modal-header"><div class="modal-title">' + title + '</div>' +
      '<div style="cursor:pointer;color:var(--text-muted-color)" onclick="erCloseModal()">&#10005;</div></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' + footerHtml + '</div></div>';
    document.body.appendChild(wrap);
  }
  function closeModal() { var m = el('er-modal'); if (m && m.parentNode) m.parentNode.removeChild(m); }
  window.erCloseModal = closeModal;

  window.erToggle = function (id) {
    var sw = el(id);
    if (!sw) return;
    var on = sw.className.indexOf('on') !== -1;
    sw.className = 'er-sw' + (on ? '' : ' on');
    sw.setAttribute('data-on', on ? '0' : '1');
    if (id === 'er-vis' && on) {
      // Un-sharing kills Recent Wins with it. A win the person cannot see in
      // their own file is not a win.
      var w = el('er-wins');
      if (w) { w.className = 'er-sw'; w.setAttribute('data-on', '0'); }
    }
    if (id === 'er-wins' && !on) {
      var v = el('er-vis');
      if (v) { v.className = 'er-sw on'; v.setAttribute('data-on', '1'); }
    }
  };
  function swOn(id) { var e = el(id); return !!(e && e.getAttribute('data-on') === '1'); }
  function sw(id, on, label, help) {
    return '<div class="er-toggle" onclick="erToggle(\'' + id + '\')" style="margin-bottom:8px">' +
      '<div class="er-sw' + (on ? ' on' : '') + '" id="' + id + '" data-on="' + (on ? '1' : '0') + '"></div>' +
      '<div><div style="font-size:13px;color:var(--text);font-weight:500">' + label + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color)">' + help + '</div></div></div>';
  }

  // ==================================================================
  // NEW NOTE (recognition / coaching / performance)
  // ==================================================================
  window.erNewRecord = function (type) {
    type = type || 'recognition';
    if (type === 'disciplinary') return window.erNewDisciplinary();
    var cats = (S.meta && S.meta.categories) || [];
    var isPraise = type === 'recognition';
    var body =
      '<div class="form-group"><label>Record type</label><div class="er-types">' +
      typeCard('recognition', type, 'Recognition', 'Praise, a win, a customer callout. Shared with them by default.') +
      typeCard('coaching', type, 'Coaching note', 'A documented conversation. Internal by default, no signature.') +
      typeCard('performance', type, 'Performance note', 'A neutral observation for the record.') +
      (can('create_disciplinary') ? typeCard('disciplinary', type, 'Disciplinary action', 'Formal notice. Opens the full form.') : '') +
      '</div></div>' +
      '<div class="er-grid2">' +
      '<div class="form-group"><label>Date</label><input type="date" id="er-date" value="' + new Date().toISOString().slice(0, 10) + '"></div>' +
      '<div class="form-group"><label>Category</label><select id="er-cat">' +
      cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="form-group"><label>What happened <span style="color:var(--danger)">*</span></label>' +
      '<textarea id="er-body" style="min-height:110px" placeholder="What was observed. Dates and specifics beat adjectives."></textarea></div>' +
      '<div class="form-group"><label>Where it goes</label>' +
      sw('er-vis', isPraise, 'Share with ' + esc(S.file.user.name.split(' ')[0]),
        'Appears in their My File screen.') +
      (isPraise ? sw('er-wins', true, 'Show in Recent Wins',
        'Everyone in their city sees their name and this text on the Home screen. Filing this record IS the post; there is nowhere else to put it.') : '') +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color)">Saving notifies them if it is shared.</div>';
    modal('New Record &middot; ' + esc(S.file.user.name), body,
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="er-save" onclick="erSaveNote(\'' + type + '\')">Save to file</button>');
  };

  function typeCard(key, current, title, help) {
    return '<div class="er-type' + (key === current ? ' sel' : '') + '" onclick="erNewRecord(\'' + key + '\')">' +
      '<b>' + title + '</b><small>' + help + '</small></div>';
  }

  window.erSaveNote = async function (type) {
    var body = String(val('er-body') || '').trim();
    if (!body) { toast('Say what happened.', 'error'); return; }
    var payload = {
      user_id: S.employeeId, type: type, category: val('er-cat'), occurred_on: val('er-date'),
      body: body, visible_to_employee: swOn('er-vis'), show_in_wins: swOn('er-wins')
    };
    var b = el('er-save'); if (b) b.disabled = true;
    try {
      await api('POST', API + '/notes', payload);
      closeModal();
      toast('Added to the file.', 'success');
      window.erOpenFile(S.employeeId, 'timeline');
    } catch (e) {
      if (b) b.disabled = false;
      toast(e.message || 'Could not save.', 'error');
    }
  };

  // ==================================================================
  // DISCIPLINARY FORM
  // ==================================================================
  window.erNewDisciplinary = function () { openDisciplinary(null); };
  window.erEditDisciplinary = function (id) {
    var recs = (S.file && S.file.records) || [];
    for (var i = 0; i < recs.length; i++) if (recs[i].id === id) return openDisciplinary(recs[i]);
    toast('Draft not found.', 'error');
  };

  function openDisciplinary(rec) {
    closeModal();
    S.view = 'disciplinary';
    S.draft = rec || null;
    S.check = (rec && rec.ai_check) || null;
    drawDisciplinary();
  }

  function drawDisciplinary() {
    var host = content(); if (!host) return;
    var d = S.file, L = d.ladder || {}, rec = S.draft || {};
    var levels = (S.meta && S.meta.levels) || [];
    var cats = (S.meta && S.meta.categories) || [];
    var cons = (S.meta && S.meta.consequences) || {};
    var lvl = rec.level || L.suggested_next || 1;
    var today = new Date().toISOString().slice(0, 10);
    var occurred = (rec.occurred_on ? String(rec.occurred_on).slice(0, 10) : today);
    var escDays = rec.escalation_days || (S.meta && S.meta.default_escalation_days) || 90;

    var steps = levels.map(function (l) {
      var cls = '';
      if (l.n <= L.highest_live) cls = ' done';
      if (l.n === lvl) cls = ' cur';
      return '<div class="er-step' + cls + '">' + esc(l.label.replace(' Warning (documented)', '').replace(' Warning', '')) + '</div>';
    }).join('');

    var priors = (L.priors || []).filter(function (p) { return !rec.id || p.id !== rec.id; }).slice(0, 4).map(function (p) {
      return '<div class="er-card neg" style="padding:10px 12px;margin-bottom:8px">' +
        '<div class="er-title" style="font-size:13px">' + esc(p.level_label) + (p.category ? ' &middot; ' + esc(p.category) : '') + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-top:3px">' + esc(shortDate(p.occurred_on || p.created_at)) +
        ' &middot; ' + esc(p.status) + (p.live ? '' : ' &middot; outside the window') + '</div></div>';
    }).join('') || '<div style="font-size:12px;color:var(--text-muted-color)">No prior notices on file.</div>';

    var approverOpts = '';
    if (d.user.supervisor) {
      approverOpts += '<option value="' + d.user.supervisor.id + '">' + esc(d.user.supervisor.name) + ' — their supervisor (default)</option>';
    }
    approverOpts += '<option value="">Choose someone else…</option>';

    host.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;color:var(--text-muted-color);cursor:pointer" onclick="erOpenFile(' + S.employeeId + ')">&#8592; ' + esc(d.user.name) + '</div>' +
      '<div class="page-header"><div><h2 style="font-size:22px;font-weight:600">Disciplinary Action &middot; ' + esc(d.user.name) + ' ' +
      badge(rec.status || 'draft') + '</h2>' +
      '<p style="font-size:13px;color:var(--text-muted-color);margin-top:4px">Nothing reaches ' +
      esc(d.user.name.split(' ')[0]) + ' until an approver signs off and it is sent.</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-secondary" onclick="erSaveDraft()">Save draft</button>' +
      '<button class="btn btn-primary" onclick="erSubmitDisciplinary()">Submit for approval</button></div></div>' +

      (rec.approver_note && rec.status === 'returned'
        ? '<div class="alert alert-warn" style="margin-bottom:20px"><b>Sent back by ' + esc(rec.approver_name || 'your approver') + '</b><br>' +
          '<span style="font-size:13px;white-space:pre-wrap">' + esc(rec.approver_note) + '</span></div>' : '') +

      '<div class="er-two"><div>' +

      '<div class="card" style="margin-bottom:16px"><div class="card-header"><div class="card-title">The notice</div></div>' +
      '<div class="card-body">' +
      '<div class="er-grid3">' +
      '<div class="form-group"><label>Level</label><select id="er-level" onchange="erLevelChanged()">' +
      levels.map(function (l) {
        return '<option value="' + l.n + '"' + (l.n === lvl ? ' selected' : '') + '>' + esc(l.label) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="form-group"><label>Category</label><select id="er-cat">' +
      cats.map(function (c) { return '<option' + (rec.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="form-group"><label>Date of incident</label><input type="date" id="er-date" value="' + occurred + '"></div>' +
      '</div>' +
      '<div class="form-group"><label>Description of the incident <span style="color:var(--danger)">*</span></label>' +
      '<textarea id="er-body" style="min-height:120px" onblur="erCheckWording()">' + esc(rec.body || '') + '</textarea>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">' +
      '<button class="btn btn-secondary btn-sm" onclick="erCheckWording(true)">Check wording</button>' +
      '<span style="font-size:12px;color:var(--text-muted-color)">Runs again when you submit. Red flags block submission.</span></div>' +
      '<div id="er-ai-body"></div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Policy or SOP violated</label>' +
      '<input id="er-sop" placeholder="e.g. SOP-14 Attendance and Punctuality" value="' + esc(rec.sop_label || '') + '"></div>' +
      '</div></div>' +

      '<div class="card" style="margin-bottom:16px"><div class="card-header"><div class="card-title">Corrective action</div></div>' +
      '<div class="card-body">' +
      '<div class="form-group"><label>What must change <span style="color:var(--danger)">*</span></label>' +
      '<textarea id="er-corrective" style="min-height:80px" onblur="erCheckWording()">' + esc(rec.corrective_action || '') + '</textarea>' +
      '<div id="er-ai-corrective_action"></div></div>' +
      '<div class="form-group"><label>Consequence if it does not <span style="color:var(--danger)">*</span></label>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:7px;flex-wrap:wrap">' +
      '<span class="badge badge-active" style="text-transform:none" id="er-cons-tag">Default wording for ' + esc(levelName(lvl)) + '</span>' +
      '<span style="font-size:12px;color:var(--text-muted-color)">Refills when you change the level. Edit it freely.</span></div>' +
      '<textarea id="er-consequence" style="min-height:70px" onblur="erCheckWording()">' +
      esc(rec.consequence || cons[String(lvl)] || '') + '</textarea>' +
      '<div id="er-ai-consequence"></div></div>' +
      '<div class="er-grid2">' +
      '<div class="form-group" style="margin-bottom:0"><label>Follow-up date <span style="color:var(--danger)">*</span></label>' +
      '<input type="date" id="er-followup" value="' + (rec.followup_on ? String(rec.followup_on).slice(0, 10) : addDaysStr(today, 30)) + '">' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:6px">Tasks you on that date to record whether it was corrected. Required.</div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Counts toward the ladder for</label>' +
      '<input type="number" id="er-esc" min="0" max="3650" value="' + escDays + '">' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:6px">Days. After that it stays on the file but stops escalating.</div></div>' +
      '</div></div></div>' +

      '<div class="card"><div class="card-header"><div class="card-title">Approval and delivery</div>' +
      '<span class="badge badge-waiting">Required at every level</span></div>' +
      '<div class="card-body">' +
      '<div class="form-group"><label>Send to</label>' +
      '<select id="er-approver" onchange="erApproverChanged()">' + approverOpts + '</select>' +
      '<select id="er-approver-any" style="display:none;margin-top:8px"><option value="">Loading…</option></select>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:6px">Defaults to the next person up. The second list is every admin and the owner, so you are not stuck when they are away.</div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Note for the approver (optional)</label>' +
      '<textarea id="er-subnote" style="min-height:56px"></textarea></div>' +
      (d.user.has_email ? '' :
        '<div class="alert alert-error" style="margin-top:14px;font-size:13px">' + esc(d.user.name) +
        ' has no email address on file, so the signature request cannot be sent. Add one under Settings &gt; Users first.</div>') +
      '</div></div>' +

      '</div><div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card-header"><div class="card-title">Prior record</div>' +
      '<span style="font-size:12px;color:var(--text-muted-color)">auto-pulled</span></div>' +
      '<div class="card-body"><div class="er-ladder" style="margin-bottom:14px">' + steps + '</div>' +
      '<div class="alert alert-info" style="font-size:12.5px;margin-bottom:14px"><b>The ladder suggests ' +
      esc(L.suggested_label || '') + '.</b> ' + (L.live_count || 0) + ' live notice' + ((L.live_count === 1) ? '' : 's') +
      ' inside the window. You can override the level; the file keeps what you chose.</div>' + priors +
      '</div></div>' +

      '<div class="card"><div class="card-header"><div class="card-title">What the wording check looks for</div></div>' +
      '<div class="card-body"><div style="font-size:12px;color:var(--text-muted-color);line-height:1.8">' +
      '<span style="color:#f87171;font-weight:700">Red, blocks submit</span><br>' +
      'Anything touching a protected class<br>Medical, injury, leave or comp reasons<br>' +
      'Threats, profanity, personal insults<br>Character judgments instead of behaviour<br><br>' +
      '<span style="color:#fbbf24;font-weight:700">Amber, advisory</span><br>' +
      'Guessing at intent or state of mind<br>Absolutes you cannot keep<br>' +
      'Missing dates, times or measurable standards<br>Vague expectations<br><br>' +
      'It never writes the facts for you and never edits anything on its own. What you save is what you typed, ' +
      'and the result is stored with the notice.' +
      '</div></div></div>' +

      '</div></div>';

    if (S.check) paintCheck(S.check);
  }

  function addDaysStr(d, n) {
    var dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  window.erLevelChanged = function () {
    var lvl = parseInt(val('er-level'), 10) || 1;
    var cons = (S.meta && S.meta.consequences) || {};
    var box = el('er-consequence');
    var tag = el('er-cons-tag');
    if (tag) tag.textContent = 'Default wording for ' + levelName(lvl);
    if (!box) return;
    // Only refill when the text is still one of the defaults - never clobber
    // something the manager wrote themselves.
    var current = String(box.value || '').trim();
    var isDefault = !current;
    Object.keys(cons).forEach(function (k) { if (cons[k] && cons[k].trim() === current) isDefault = true; });
    if (isDefault) box.value = cons[String(lvl)] || '';
  };

  window.erApproverChanged = async function () {
    var sel = el('er-approver'), any = el('er-approver-any');
    if (!sel || !any) return;
    if (sel.value) { any.style.display = 'none'; return; }
    any.style.display = '';
    if (any.getAttribute('data-loaded') === '1') return;
    try {
      var users = await api('GET', '/users');
      var opts = (users || []).filter(function (u) {
        return u.active !== false && (u.role === 'admin' || u.role === 'owner') && u.id !== (state.user && state.user.id);
      }).map(function (u) { return '<option value="' + u.id + '">' + esc(u.name) + ' — ' + esc(u.role) + '</option>'; });
      any.innerHTML = '<option value="">Pick an approver…</option>' + opts.join('');
      any.setAttribute('data-loaded', '1');
    } catch (e) { any.innerHTML = '<option value="">Could not load users</option>'; }
  };

  function draftPayload() {
    return {
      id: (S.draft && S.draft.id) || undefined,
      user_id: S.employeeId,
      level: parseInt(val('er-level'), 10) || 1,
      category: val('er-cat'),
      occurred_on: val('er-date'),
      body: String(val('er-body') || '').trim(),
      corrective_action: String(val('er-corrective') || '').trim(),
      consequence: String(val('er-consequence') || '').trim(),
      sop_label: val('er-sop'),
      followup_on: val('er-followup'),
      escalation_days: parseInt(val('er-esc'), 10)
    };
  }

  window.erSaveDraft = async function (quiet) {
    var p = draftPayload();
    if (!p.body) { toast('Describe the incident first.', 'error'); return null; }
    try {
      var out = await api('POST', API + '/disciplinary', p);
      S.draft = out.record;
      if (!quiet) toast('Draft saved.', 'success');
      return out.id;
    } catch (e) { toast(e.message || 'Could not save.', 'error'); return null; }
  };

  window.erSubmitDisciplinary = async function () {
    var p = draftPayload();
    if (!p.body || !p.corrective_action || !p.consequence) {
      toast('The incident, what must change and the consequence are all required.', 'error'); return;
    }
    if (!p.followup_on) { toast('Set a follow-up date.', 'error'); return; }
    var approver = val('er-approver') || val('er-approver-any');
    if (!approver) { toast('Pick an approver.', 'error'); return; }
    var id = await window.erSaveDraft(true);
    if (!id) return;
    try {
      await api('POST', API + '/disciplinary/' + id + '/submit', {
        approver_id: parseInt(approver, 10), note: val('er-subnote')
      });
      toast('Submitted for approval.', 'success');
      window.erOpenFile(S.employeeId, 'timeline');
    } catch (e) {
      if (e && e.check) { S.check = e.check; paintCheck(e.check); }
      toast(e.message || 'Could not submit.', 'error');
      // The 422 body carries the check; api() may only surface the message, so
      // re-run the check locally to show the manager WHICH words are the problem.
      if (!e || !e.check) window.erCheckWording(true);
    }
  };

  window.erCheckWording = async function (explicit) {
    var p = draftPayload();
    if (!p.body && !p.corrective_action && !p.consequence) return;
    if (S.busy) return;
    S.busy = true;
    if (explicit) toast('Checking the wording…', 'info');
    try {
      var out = await api('POST', API + '/check', {
        body: p.body, corrective_action: p.corrective_action, consequence: p.consequence,
        level: p.level, category: p.category
      });
      S.check = out;
      paintCheck(out);
    } catch (e) { /* never block on the check */ }
    S.busy = false;
  };

  function paintCheck(check) {
    var map = { body: 'er-ai-body', corrective_action: 'er-ai-corrective_action', consequence: 'er-ai-consequence' };
    Object.keys(map).forEach(function (f) {
      var host = el(map[f]); if (!host) return;
      var r = (check && check.fields && check.fields[f]) || null;
      if (!r || !r.checked || !r.flags || !r.flags.length) { host.innerHTML = ''; return; }
      var clear = r.reds === 0 && r.ambers === 0;
      var head = clear ? 'Wording check &middot; clear'
        : 'Wording check &middot; ' + r.reds + ' red, ' + r.ambers + ' amber';
      host.innerHTML = '<div class="er-ai' + (clear ? ' clear' : '') + '"><h5>' + head + '</h5>' +
        r.flags.map(function (fl) {
          return '<div class="er-flag"><div class="er-fdot ' + esc(fl.severity) + '"></div><div>' +
            '<b>' + esc(fl.title) + '</b> ' + esc(fl.detail) + '</div></div>';
        }).join('') +
        (r.suggestion ? '<div class="er-sugg"><b style="color:var(--text)">Suggested wording</b><br>' +
          esc(r.suggestion.text) +
          '<div style="display:flex;gap:8px;margin-top:10px">' +
          '<button class="btn btn-primary btn-sm" onclick="erUseSuggestion(\'' + f + '\')">Use this</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="erDismissSuggestion(\'' + f + '\')">Dismiss</button>' +
          '</div></div>' : '') +
        '</div>';
    });
  }

  window.erUseSuggestion = function (field) {
    var r = S.check && S.check.fields && S.check.fields[field];
    if (!r || !r.suggestion) return;
    var id = field === 'body' ? 'er-body' : field === 'corrective_action' ? 'er-corrective' : 'er-consequence';
    var box = el(id); if (!box) return;
    var sug = r.suggestion;
    if (sug.replaces && box.value.indexOf(sug.replaces) !== -1) box.value = box.value.replace(sug.replaces, sug.text);
    else box.value = sug.text;
    toast('Wording replaced. Re-checking.', 'info');
    window.erCheckWording();
  };
  window.erDismissSuggestion = function (field) {
    if (S.check && S.check.fields && S.check.fields[field]) S.check.fields[field].suggestion = null;
    paintCheck(S.check);
  };

  window.erDeleteDraft = async function (id) {
    if (!confirm('Delete this draft? Nothing was ever sent.')) return;
    try { await api('DELETE', API + '/' + id, {}); toast('Draft deleted.', 'info'); window.erOpenFile(S.employeeId); }
    catch (e) { toast(e.message || 'Could not delete.', 'error'); }
  };

  // ==================================================================
  // APPROVALS
  // ==================================================================
  window.erOpenApprovals = async function () {
    var host = content(); if (!host) return;
    host.innerHTML = '<div class="loading">Loading…</div>';
    var list;
    try { list = await api('GET', API + '/approvals'); await loadMeta(); }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load.') + '</div>'; return; }
    if (!list.length) {
      host.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;color:var(--text-muted-color);cursor:pointer" onclick="erBackToRoster()">&#8592; Employee Files</div>' +
        '<div class="card"><div class="empty-state"><h3>Nothing waiting on you</h3></div></div>';
      return;
    }
    host.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;color:var(--text-muted-color);cursor:pointer" onclick="erBackToRoster()">&#8592; Employee Files</div>' +
      '<div class="page-header"><h2 style="font-size:22px;font-weight:600">Approvals</h2></div>' +
      list.map(function (r) {
        return '<div class="card" style="margin-bottom:16px"><div class="card-header">' +
          '<div class="card-title">' + esc(r.level_label) + ' &middot; ' + esc(r.employee_name) + '</div>' +
          '<span class="badge badge-waiting">Pending your approval</span></div>' +
          '<div class="card-body">' +
          '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:12px">Submitted by ' +
          esc(r.created_by_name || '') + ' &middot; ' + esc(shortDate(r.submitted_at)) +
          (r.category ? ' &middot; ' + esc(r.category) : '') + '</div>' +
          field('Description of the incident', r.body) +
          field('What must change', r.corrective_action) +
          field('Consequence if it does not', r.consequence) +
          (r.sop_label ? field('Policy cited', r.sop_label) : '') +
          (r.followup_on ? field('Follow-up date', shortDate(r.followup_on)) : '') +
          checkSummary(r.ai_check) +
          '<div class="form-group" style="margin-top:14px"><label>Note (shown to the author, not the employee)</label>' +
          '<textarea id="er-anote-' + r.id + '" style="min-height:60px"></textarea></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-success" onclick="erApprove(' + r.id + ')">Approve and send</button>' +
          '<button class="btn btn-secondary" onclick="erReturn(' + r.id + ')">Send back for changes</button></div>' +
          '<div style="font-size:12px;color:var(--text-muted-color);margin-top:10px">You cannot edit the notice yourself. ' +
          'Sending it back keeps everything they wrote and reopens it for them.</div>' +
          '</div></div>';
      }).join('');
  };

  function field(label, text) {
    if (!text) return '';
    return '<div style="margin-bottom:10px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted-color);font-weight:600">' +
      esc(label) + '</div><div style="font-size:13.5px;color:var(--text-dim);line-height:1.6;white-space:pre-wrap">' + esc(text) + '</div></div>';
  }

  function checkSummary(check) {
    if (!check || !check.available) return '';
    if (!check.reds && !check.ambers) {
      return '<div class="er-ai clear" style="margin-top:12px"><h5>Wording check &middot; clear when submitted</h5></div>';
    }
    return '<div class="er-ai" style="margin-top:12px"><h5>Wording check &middot; ' + (check.reds || 0) + ' red, ' + (check.ambers || 0) + ' amber at submission</h5>' +
      Object.keys(check.fields || {}).map(function (f) {
        return ((check.fields[f] || {}).flags || []).filter(function (fl) { return fl.severity !== 'green'; }).map(function (fl) {
          return '<div class="er-flag"><div class="er-fdot ' + esc(fl.severity) + '"></div><div><b>' + esc(fl.title) + '</b> ' + esc(fl.detail) + '</div></div>';
        }).join('');
      }).join('') + '</div>';
  }

  window.erApprove = async function (id) {
    if (!confirm('Approve this notice? It will be sent to the employee for signature straight away.')) return;
    try {
      await api('POST', API + '/disciplinary/' + id + '/approve', { note: val('er-anote-' + id) });
      toast('Approved and sent.', 'success');
      window.erOpenApprovals();
    } catch (e) { toast(e.message || 'Could not approve.', 'error'); }
  };
  window.erReturn = async function (id) {
    var note = String(val('er-anote-' + id) || '').trim();
    if (!note) { toast('Say what needs changing.', 'error'); return; }
    try {
      await api('POST', API + '/disciplinary/' + id + '/return', { note: note });
      toast('Sent back.', 'info');
      window.erOpenApprovals();
    } catch (e) { toast(e.message || 'Could not send it back.', 'error'); }
  };

  // ==================================================================
  // SIGNATURE STATUS, REFUSAL, FOLLOW-UP, HISTORY, VOID
  // ==================================================================
  window.erResend = async function (id, extend) {
    try {
      await api('POST', API + '/disciplinary/' + id + '/resend', { extend: !!extend });
      toast(extend ? 'Extended and reminded.' : 'Reminder sent.', 'success');
      window.erOpenFile(S.employeeId);
    } catch (e) { toast(e.message || 'Could not resend.', 'error'); }
  };

  window.erRefuse = function (id) {
    var body =
      '<div class="alert alert-warn" style="font-size:12.5px;margin-bottom:16px">' +
      'A refusal does not void the notice. It stays on the file, it still counts on the ladder, and the ' +
      'delivery trail is what proves it was received. There is no witness field: one person administers a ' +
      'notice here, so the record of when it was sent, opened and reminded does that job instead.</div>' +
      '<div class="form-group"><label>What happened <span style="color:var(--danger)">*</span></label>' +
      '<select id="er-refuse-kind">' +
      '<option value="declined_in_request">They declined it in Nova</option>' +
      '<option value="told_me_directly">They told me directly they will not sign</option>' +
      '<option value="no_response">No response before the request expired</option>' +
      '</select></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Notes</label>' +
      '<textarea id="er-refuse-note" style="min-height:90px" placeholder="What they said, and how the notice was gone through with them."></textarea></div>';
    modal('Record a refusal', body,
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-danger" onclick="erSaveRefusal(' + id + ')">Record refusal and file</button>');
  };

  window.erSaveRefusal = async function (id) {
    try {
      await api('POST', API + '/disciplinary/' + id + '/refuse', {
        kind: val('er-refuse-kind'), note: val('er-refuse-note')
      });
      closeModal(); toast('Refusal recorded.', 'success');
      window.erOpenFile(S.employeeId);
    } catch (e) { toast(e.message || 'Could not record it.', 'error'); }
  };

  window.erFollowup = async function (id) {
    var rec = null;
    ((S.file && S.file.records) || []).forEach(function (r) { if (r.id === id) rec = r; });
    if (!rec) return;
    var signals = null;
    try { signals = await api('GET', API + '/' + id + '/signals'); } catch (e) {}
    var sigHtml = '';
    if (signals && signals.signals && signals.signals.length) {
      sigHtml = '<div class="card" style="margin-bottom:14px"><div class="card-header">' +
        '<div class="card-title" style="font-size:14px">What Nova has seen since</div></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Signal</th><th>Since</th><th>30 days before</th></tr></thead><tbody>' +
        signals.signals.map(function (s) {
          var col = s.good ? 'var(--success)' : (s.since > 0 ? 'var(--warning)' : 'var(--success)');
          return '<tr><td>' + esc(s.label) + '</td>' +
            '<td style="color:' + col + ';font-weight:600">' + s.since + '</td>' +
            '<td>' + (s.before === null ? '—' : s.before) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="card-body" style="border-top:1px solid var(--border);font-size:12px;color:var(--text-muted-color)">' +
        'Evidence, not a verdict. The clock data is what it is; you decide whether the behaviour changed.</div></div>';
    }
    var body = sigHtml +
      '<div class="form-group"><label>Outcome <span style="color:var(--danger)">*</span></label>' +
      '<div class="er-types" style="grid-template-columns:1fr">' +
      '<div class="er-type sel" id="er-out-corrected" onclick="erPickOutcome(\'corrected\')"><b style="color:#4ade80">Corrected</b>' +
      '<small>Closes the follow-up. The notice stays on the file and still counts on the ladder until its window closes.</small></div>' +
      '<div class="er-type" id="er-out-not_corrected" onclick="erPickOutcome(\'not_corrected\')"><b style="color:#f87171">Not corrected</b>' +
      '<small>Closes this follow-up and opens the next level, pre-filled with this notice as the prior.</small></div>' +
      '<div class="er-type" id="er-out-extended" onclick="erPickOutcome(\'extended\')"><b>Extend the follow-up</b>' +
      '<small>Pick a new date. Logged on the record so an extension never looks like it was dropped.</small></div>' +
      '</div></div>' +
      '<div class="form-group" id="er-newdate-wrap" style="display:none"><label>New follow-up date</label>' +
      '<input type="date" id="er-newdate" value="' + addDaysStr(new Date().toISOString().slice(0, 10), 30) + '"></div>' +
      '<div class="form-group"><label>Notes <span style="color:var(--danger)">*</span></label>' +
      '<textarea id="er-fnote" style="min-height:90px"></textarea></div>' +
      sw('er-telltheir', true, 'Tell them it was corrected', 'Half the point of a follow-up is that they hear the good half too.');
    modal('Follow-up &middot; ' + esc(S.file.user.name), body,
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-success" id="er-fsave" onclick="erSaveFollowup(' + id + ')">Record the outcome</button>', 640);
    S.outcome = 'corrected';
  };

  window.erPickOutcome = function (o) {
    S.outcome = o;
    ['corrected', 'not_corrected', 'extended'].forEach(function (k) {
      var e = el('er-out-' + k);
      if (e) e.className = 'er-type' + (k === o ? ' sel' : '');
    });
    var w = el('er-newdate-wrap'); if (w) w.style.display = (o === 'extended') ? '' : 'none';
    var b = el('er-fsave');
    if (b) {
      b.className = 'btn ' + (o === 'not_corrected' ? 'btn-danger' : o === 'extended' ? 'btn-secondary' : 'btn-success');
      b.textContent = o === 'not_corrected' ? 'Record and open the next level' : 'Record the outcome';
    }
  };

  window.erSaveFollowup = async function (id) {
    var note = String(val('er-fnote') || '').trim();
    if (!note) { toast('Write a short note on what happened.', 'error'); return; }
    try {
      var out = await api('POST', API + '/' + id + '/followup', {
        outcome: S.outcome || 'corrected', note: note,
        followup_on: val('er-newdate'), tell_employee: swOn('er-telltheir')
      });
      closeModal();
      toast('Follow-up recorded.', 'success');
      if (out && out.next_level) {
        await window.erOpenFile(S.employeeId);
        S.draft = null;
        openDisciplinary(null);
        var sel = el('er-level');
        if (sel) { sel.value = String(out.next_level); window.erLevelChanged(); }
        toast('Next level pre-filled. Check the wording before you submit.', 'info');
      } else {
        window.erOpenFile(S.employeeId);
      }
    } catch (e) { toast(e.message || 'Could not record it.', 'error'); }
  };

  window.erVoid = async function (id) {
    var reason = prompt('Voiding keeps the record on the file, marked void, with your reason. Why is it being voided?');
    if (!reason) return;
    try {
      await api('POST', API + '/' + id + '/void', { reason: reason });
      toast('Record voided.', 'info');
      window.erOpenFile(S.employeeId);
    } catch (e) { toast(e.message || 'Could not void it.', 'error'); }
  };

  window.erHistory = async function (id) {
    var rows;
    try { rows = await api('GET', API + '/' + id + '/events'); }
    catch (e) { toast(e.message || 'Could not load the history.', 'error'); return; }
    var body = rows.length ? rows.map(function (ev) {
      return '<div style="padding:9px 0;border-bottom:1px solid var(--border-light)">' +
        '<div style="font-size:13px;color:var(--text)">' + esc(String(ev.action).replace(/_/g, ' ')) +
        (ev.user_name ? ' <span style="color:var(--text-muted-color)">by ' + esc(ev.user_name) + '</span>' : '') + '</div>' +
        (ev.note ? '<div style="font-size:12px;color:var(--text-dim);white-space:pre-wrap;margin-top:3px">' + esc(ev.note) + '</div>' : '') +
        '<div style="font-size:11px;color:var(--text-muted-color);margin-top:2px">' + esc(shortDate(ev.created_at)) + '</div></div>';
    }).join('') : '<div style="color:var(--text-muted-color);font-size:13px">Nothing recorded yet.</div>';
    modal('Record history', body, '<button class="btn btn-secondary" onclick="erCloseModal()">Close</button>', 560);
  };

  // ==================================================================
  // WRAPPERS over onboarding.js / app.js
  // ==================================================================
  var origEmployeeFiles = window.renderEmployeeFiles;
  window.renderEmployeeFiles = async function (host) {
    injectCss();
    // Anyone without the new permission keeps exactly the page they have today.
    if (!can('view_employee_records')) {
      if (typeof origEmployeeFiles === 'function') return origEmployeeFiles(host);
      host.innerHTML = '<div class="alert alert-error">Access denied.</div>';
      return;
    }
    S.view = 'roster';
    await renderRoster(host);
  };

  var origMyFile = window.renderMyFile;
  window.renderMyFile = async function (host) {
    injectCss();
    host.innerHTML = '<div id="er-mine"></div><div id="er-docs"></div>';
    var mine = el('er-mine');
    try {
      var d = await api('GET', API + '/me');
      mine.innerHTML = myRecordsHtml(d.records || []);
    } catch (e) { mine.innerHTML = ''; }
    if (typeof origMyFile === 'function') {
      try { await origMyFile(el('er-docs')); } catch (e) {}
    }
  };

  function myRecordsHtml(recs) {
    if (!recs.length) return '';
    var needSign = recs.filter(function (r) { return r.needs_signature; });
    var rest = recs.filter(function (r) { return !r.needs_signature; });
    var out = '<h1 style="margin-bottom:6px">My File</h1>' +
      '<div class="alert alert-info" style="margin-bottom:20px;font-size:13px">' +
      'This is what your manager has shared with you. Internal notes are not shown here.</div>';

    out += needSign.map(function (r) {
      return '<div class="card" style="margin-bottom:16px;border-color:#4a3500">' +
        '<div class="card-header" style="border-bottom-color:#4a3500">' +
        '<div class="card-title">' + esc(r.level_label || 'Notice') + (r.category ? ' &middot; ' + esc(r.category) : '') + '</div>' +
        '<span class="badge badge-awaiting-signature">Needs your signature</span></div>' +
        '<div class="card-body">' +
        '<div class="er-body" style="margin-bottom:10px">' + esc(r.body || '') + '</div>' +
        (r.corrective_action ? field('What must change', r.corrective_action) : '') +
        (r.consequence ? field('Consequence if it does not', r.consequence) : '') +
        '<div style="font-size:12px;color:var(--text-muted-color);margin:10px 0">Issued by ' +
        esc(r.created_by_name || '') + (r.approver_name ? ', approved by ' + esc(r.approver_name) : '') +
        '. Signing confirms you have read it. It does not mean you agree with it, and you can attach a ' +
        'written response of your own.</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-primary btn-sm" onclick="erSignOpen(' + r.id + ')">Review and sign</button>' +
        // Available BEFORE signing on purpose. Somebody who is not going to sign
        // still has to be able to put their side of it on the file.
        (r.employee_response ? '' : '<button class="btn btn-secondary btn-sm" onclick="erRespond(' + r.id + ')">Add a written response</button>') +
        '</div>' +
        (r.employee_response ? '<div class="er-sugg"><b style="color:var(--text)">Your response</b><br>' + esc(r.employee_response) + '</div>' : '') +
        '</div></div>';
    }).join('');

    out += '<div class="card"><div class="card-header"><div class="card-title">Shared with you</div></div>' +
      '<div class="card-body">' + (rest.length ? '<div class="er-tl">' + rest.map(myEventHtml).join('') + '</div>'
        : '<div style="color:var(--text-muted-color);font-size:13px">Nothing else shared yet.</div>') + '</div></div>' +
      '<div style="height:20px"></div>';
    return out;
  }

  function myEventHtml(r) {
    var tm = TYPE_META[r.type] || TYPE_META.performance;
    var title = (r.type === 'disciplinary' ? (r.level_label || 'Notice') : tm.label) +
      (r.category ? ' &middot; ' + esc(r.category) : '');
    var acts = [];
    if (r.type !== 'disciplinary' && !r.acknowledged_at) {
      acts.push(btn('Acknowledge', 'btn-secondary', 'erAcknowledge(' + r.id + ')'));
    }
    if (r.type === 'disciplinary' && !r.employee_response) {
      acts.push(btn('Add a written response', 'btn-secondary', 'erRespond(' + r.id + ')'));
    }
    return '<div class="er-ev"><div class="er-dot ' + tm.cls + '">' + tm.dot + '</div>' +
      '<div class="er-card ' + tm.cls + '">' +
      '<div class="er-head"><div class="er-title">' + title + '</div>' + badge(r.status) + '</div>' +
      '<div class="er-body">' + esc(r.body || '') + '</div>' +
      (r.employee_response ? '<div class="er-sugg"><b style="color:var(--text)">Your response</b><br>' + esc(r.employee_response) + '</div>' : '') +
      '<div class="er-meta">' + esc(shortDate(r.occurred_on || r.created_at)) +
      (r.created_by_name ? ' <span class="sep">&middot;</span> ' + esc(r.created_by_name) : '') +
      (r.signed_at ? ' <span class="sep">&middot;</span> You signed this' : '') +
      (r.acknowledged_at ? ' <span class="sep">&middot;</span> Acknowledged' : '') +
      '</div>' + (acts.length ? '<div class="er-acts">' + acts.join('') + '</div>' : '') +
      '</div></div>';
  }

  window.erAcknowledge = async function (id) {
    try { await api('POST', API + '/me/' + id + '/acknowledge', {}); toast('Thanks.', 'success'); window.renderMyFile(content()); }
    catch (e) { toast(e.message || 'Could not acknowledge.', 'error'); }
  };

  window.erRespond = function (id) {
    modal('Your written response',
      '<div style="font-size:13px;color:var(--text-muted-color);margin-bottom:12px">' +
      'This is attached to the notice permanently and can be read by your manager and by HR. ' +
      'It cannot be edited or removed afterwards, by you or by anyone else.</div>' +
      '<textarea id="er-resp" style="min-height:130px" placeholder="If you see it differently, write it here."></textarea>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" onclick="erSaveResponse(' + id + ')">Attach my response</button>');
  };
  window.erSaveResponse = async function (id) {
    var t = String(val('er-resp') || '').trim();
    if (!t) { toast('Write your response first.', 'error'); return; }
    try {
      await api('POST', API + '/me/' + id + '/response', { text: t });
      closeModal(); toast('Response attached.', 'success'); window.renderMyFile(content());
    } catch (e) { toast(e.message || 'Could not attach it.', 'error'); }
  };

  // ---- signing --------------------------------------------------------------
  var pad = null;
  window.erSignOpen = function (id) {
    modal('Sign this notice',
      '<div style="font-size:13px;color:var(--text-dim);line-height:1.6;margin-bottom:14px">' +
      'Signing confirms you have read this notice. It does not mean you agree with it. ' +
      'You can attach a written response afterwards and it stays with the notice permanently.</div>' +
      '<div class="form-group"><label>Sign below</label><div class="er-pad" id="er-pad"><canvas id="er-canvas"></canvas></div>' +
      '<div style="display:flex;justify-content:space-between;margin-top:6px">' +
      '<span style="font-size:12px;color:var(--text-muted-color)">Draw with a finger or a mouse.</span>' +
      '<span style="font-size:12px;color:var(--primary);cursor:pointer" onclick="erClearPad()">Clear</span></div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Or type your full name</label>' +
      '<input id="er-typed" placeholder="' + esc((state.user && state.user.name) || '') + '"></div>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" onclick="erSign(' + id + ')">Sign</button>');
    setTimeout(setupPad, 30);
  };

  function setupPad() {
    var wrap = el('er-pad'), c = el('er-canvas');
    if (!wrap || !c) return;
    c.width = wrap.clientWidth * 2;
    c.height = wrap.clientHeight * 2;
    var ctx = c.getContext('2d');
    ctx.scale(2, 2);
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#16233d';
    var drawing = false, empty = true;
    function pos(e) {
      var r = c.getBoundingClientRect();
      var p = (e.touches && e.touches[0]) || e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    }
    function start(e) { drawing = true; empty = false; var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); }
    function move(e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); }
    function stop() { drawing = false; }
    c.addEventListener('mousedown', start); c.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    c.addEventListener('touchstart', start); c.addEventListener('touchmove', move); c.addEventListener('touchend', stop);
    pad = { canvas: c, isEmpty: function () { return empty; }, clear: function () { ctx.clearRect(0, 0, c.width, c.height); empty = true; } };
  }
  window.erClearPad = function () { if (pad) pad.clear(); };

  window.erSign = async function (id) {
    var typed = String(val('er-typed') || '').trim();
    var drawn = (pad && !pad.isEmpty()) ? pad.canvas.toDataURL('image/png') : null;
    if (!typed && !drawn) { toast('Draw or type your name first.', 'error'); return; }
    try {
      await api('POST', API + '/me/' + id + '/sign', { typed_name: typed, signature_data: drawn });
      closeModal(); toast('Signed. A copy stays in your file.', 'success');
      window.renderMyFile(content());
    } catch (e) { toast(e.message || 'Could not record your signature.', 'error'); }
  };

  // ---- Recent Wins on the Home screen ---------------------------------------
  var origHome = window.renderHomeScreen;
  if (typeof origHome === 'function') {
    window.renderHomeScreen = async function (host) {
      await origHome(host);
      try { await fillWins(); } catch (e) {}
    };
  }

  async function fillWins() {
    var slot = el('home-wins');
    if (!slot) return;
    injectCss();
    var d;
    try { d = await api('GET', API + '/wins'); } catch (e) { return; }
    var wins = (d && d.wins) || [];
    if (!wins.length) { slot.innerHTML = ''; return; }
    slot.innerHTML =
      '<div class="card" style="margin-bottom:24px;border-color:#1d4429">' +
      '<div class="card-header" style="border-bottom-color:#1d4429">' +
      '<div class="card-title">Recent Wins</div>' +
      (d.city ? '<span style="font-size:12px;color:var(--text-muted-color)">' + esc(d.city) + '</span>' : '') +
      '</div><div class="card-body" style="padding:6px 20px">' +
      wins.map(function (w) {
        return '<div class="er-win">' +
          '<div class="avatar" style="width:34px;height:34px;font-size:12px">' + esc(initials(w.name)) + '</div>' +
          '<div><div><span class="who">' + esc(w.name) + '</span>' +
          (w.category ? ' <span class="cat">&middot; ' + esc(w.category) + '</span>' : '') +
          (w.is_me ? '<span class="er-you">YOU</span>' : '') + '</div>' +
          '<div class="txt">' + esc(w.body || '') + '</div></div></div>';
      }).join('') +
      '</div></div>';
  }

  window.erRefreshWins = fillWins;
})();
