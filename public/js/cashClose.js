// public/js/cashClose.js
// ---------------------------------------------------------------------------
// Weekly Cash Close (2026-09-27). One page per pay week (Mon-Sun):
//   1 Import Pulsar   - reuses the Pulsar Verification import (app.js pv*) in
//                       strict mode: 8 required columns, CSV or .xlsx
//   2 Names & tasks   - link Pulsar names to Nova users, map Pulsar tasks to a class
//   3 Expenses        - one queue for the whole week; the REVIEWER picks category
//                       + class and approves/denies (techs classify nothing)
//   4 Reconcile       - the existing Pulsar reconciliation board, then a sign-off
//   5 Export & close  - QuickBooks journal entries (utils/qboJournal.js), draft CSV,
//                       close (freezes the week), admin reopen with a reason
// Also: the QuickBooks mapping dialog, and the category/class dropdown helpers
// the deposit page uses for expense review.
// Backend: routes/cashClose.js. Classic script, globals on purpose (inline
// onclick handlers). String concatenation, no template literals (CLAUDE.md 1.1).
// ---------------------------------------------------------------------------

var _cc = { week: null, weeks: [], data: null, step: 1, qfilter: 'waiting', el: null, openUnit: {} };
var depExpCats = null;      // [{ key, label }]
var depExpClasses = null;   // ['Locksmith', 'Roadside', 'Dispatch']

/* ------------------------------------------- category / class helpers --- */

async function depLoadExpenseCats(force) {
  if (depExpCats && !force) return depExpCats;
  try {
    var r = await api('GET', '/cash-close/categories');
    depExpCats = (r && r.categories) || [];
    depExpClasses = (r && r.classes) || [];
  } catch (e) { depExpCats = depExpCats || []; depExpClasses = depExpClasses || []; }
  return depExpCats;
}
function depCatLabel(key) {
  if (!key) return '';
  var list = depExpCats || [];
  for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].label;
  return key;
}
function depClassLabel(v) {
  if (!v) return 'No class';
  return v === 'split' ? 'Split by revenue' : v;
}
// A category <select>. id is optional; onchangeJs may be ''.
function depCatSelectHtml(val, onchangeJs, id) {
  var list = depExpCats || [];
  var known = false;
  var opts = list.map(function (c) {
    if (c.key === val) known = true;
    return '<option value="' + escHtml(c.key) + '"' + (c.key === val ? ' selected' : '') + '>' + escHtml(c.label) + '</option>';
  }).join('');
  // A key no longer on the list stays selectable, so a save never silently
  // re-categorizes the line.
  if (val && !known) opts = '<option value="' + escHtml(val) + '" selected>' + escHtml(val) + '</option>' + opts;
  return '<select' + (id ? ' id="' + id + '"' : '') + (onchangeJs ? ' onchange="' + onchangeJs + '"' : '') +
    ' style="min-width:150px;padding:6px 8px;font-size:13px"' + (val ? '' : ' class="cc-need"') + '>' +
    '<option value=""' + (val ? '' : ' selected') + '>Category&hellip;</option>' + opts + '</select>';
}
function depClassSelectHtml(val, id, onchangeJs) {
  var list = depExpClasses || ['Locksmith', 'Roadside', 'Dispatch'];
  var v = val || 'split';
  return '<select' + (id ? ' id="' + id + '"' : '') + (onchangeJs ? ' onchange="' + onchangeJs + '"' : '') +
    ' style="min-width:150px;padding:6px 8px;font-size:13px">' +
    '<option value="split"' + (v === 'split' ? ' selected' : '') + '>Split by revenue</option>' +
    list.map(function (c) { return '<option' + (c === v ? ' selected' : '') + '>' + escHtml(c) + '</option>'; }).join('') +
    '</select>';
}

/* ------------------------------------------------------------ utils --- */

function ccMoney(cents) {
  var n = (parseInt(cents, 10) || 0) / 100;
  var neg = n < 0; if (neg) n = -n;
  return (neg ? '-$' : '$') + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function ccDollars(v) { return ccMoney(Math.round((parseFloat(v) || 0) * 100)); }
function ccMd(ymd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? m[2] + '/' + m[3] : '';
}
function ccMdy(ymd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? m[2] + '/' + m[3] + '/' + m[1] : '';
}
function ccWeekLabel(w) {
  var d = new Date(w + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 6);
  return ccMd(w) + ' to ' + ccMdy(d.toISOString().slice(0, 10));
}
function ccPill(txt, kind) {
  var c = { ok: ['rgba(34,197,94,.15)', '#22c55e'], bad: ['rgba(239,68,68,.15)', '#ef4444'], warn: ['rgba(245,158,11,.15)', '#f59e0b'], mute: ['rgba(127,127,127,.15)', 'var(--text-muted-color)'] }[kind || 'mute'];
  return '<span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:' + c[0] + ';color:' + c[1] + ';white-space:nowrap">' + txt + '</span>';
}

/* ------------------------------------------------------------- page --- */

async function renderCashClose(el, weekParam) {
  _cc.el = el;
  el.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await depLoadExpenseCats(true);
    _cc.weeks = await api('GET', '/cash-close/weeks');
    var w = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(String(weekParam)) ? String(weekParam) : null;
    if (!w) {
      // Default: the most recent week that has an import and is not closed yet;
      // otherwise last week.
      var cand = _cc.weeks.filter(function (x) { return x.status !== 'closed' && x.imported; });
      w = (cand.length ? cand[0] : _cc.weeks[0]).week_start;
    }
    _cc.week = w;
    await ccLoad(true);
  } catch (err) {
    el.innerHTML = '<div class="alert alert-error">' + escHtml(err.message || 'Could not load Weekly Cash Close.') + '</div>';
  }
}

async function ccLoad(pickStep) {
  var d = await api('GET', '/cash-close/week/' + _cc.week);
  _cc.data = d;
  if (pickStep) {
    var s = d.steps || {};
    _cc.step = d.status === 'closed' ? 5 : !s.imported ? 1 : !s.names_tasks ? 2 : !s.expenses ? 3 : !s.reconciled ? 4 : 5;
  }
  ccRender();
}
async function ccReload() {
  try { await ccLoad(false); } catch (err) { showToast(err.message || 'Could not reload', 'error'); }
}
function ccAfterImport() { ccLoad(true); }
function ccPickWeek(w) { _cc.week = w; _cc.openUnit = {}; ccLoad(true); }
function ccGo(step) { _cc.step = step; ccRender(); }

function ccRender() {
  var el = _cc.el; var d = _cc.data;
  if (!el || !d) return;
  var closed = d.status === 'closed';
  var s = d.steps || {};
  var k = d.kpis || {};
  var weekOpts = (_cc.weeks || []).map(function (x) {
    return '<option value="' + x.week_start + '"' + (x.week_start === _cc.week ? ' selected' : '') + '>Week of ' + ccWeekLabel(x.week_start) +
      (x.status === 'closed' ? ' (closed)' : x.imported ? '' : ' (not imported)') + '</option>';
  }).join('');
  if (!(_cc.weeks || []).some(function (x) { return x.week_start === _cc.week; })) {
    weekOpts = '<option value="' + _cc.week + '" selected>Week of ' + ccWeekLabel(_cc.week) + '</option>' + weekOpts;
  }
  var html =
    '<div class="page-header"><div class="page-title"><h2>Weekly Cash Close</h2><p>Week of ' + ccWeekLabel(_cc.week) +
      (closed ? ' &middot; closed by ' + escHtml(d.closed_by_name || '') + ' ' + escHtml(d.closed_at ? new Date(d.closed_at).toLocaleString() : '') : '') + '</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<select onchange="ccPickWeek(this.value)" style="width:auto;min-width:260px">' + weekOpts + '</select>' +
        '<button class="btn btn-secondary" onclick="qboOpenSettings()">QuickBooks mapping</button>' +
      '</div></div>';
  if (d.reopen_reason && !closed) {
    html += '<div class="alert alert-warning" style="margin-bottom:14px">Reopened by ' + escHtml(d.reopened_by_name || '') + ': ' + escHtml(d.reopen_reason) +
      '. Entries from the earlier close may already be in QuickBooks; delete or adjust them there before importing this week again.</div>';
  }
  html += '<div class="cc-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px">' +
    ccKpi(ccMoney(k.pulsar_cash), 'Pulsar cash collected') +
    ccKpi(ccMoney(k.claimed), 'Deposited + expenses claimed') +
    ccKpi(String(k.pending_expenses || 0), 'Expenses waiting', k.pending_expenses ? '#f59e0b' : '') +
    ccKpi(String(k.no_deposit || 0), 'Techs with no deposit', k.no_deposit ? '#ef4444' : '') +
    '</div>';
  var steps = [
    [1, 'Import Pulsar', s.imported ? (d.import ? (d.import.cash_rows + ' cash calls') : 'done') : 'not yet', s.imported],
    [2, 'Names & tasks', s.names_tasks ? 'all linked' : (s.imported ? 'needs attention' : ''), s.names_tasks],
    [3, 'Expenses', s.expenses ? 'all reviewed' : ((k.pending_expenses || 0) + ' waiting'), s.expenses],
    [4, 'Reconcile', s.reconciled ? 'reviewed' : '', s.reconciled],
    [5, 'Export & close', closed ? 'closed' : '', closed]
  ];
  html += '<div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap">' + steps.map(function (st) {
    var cur = st[0] === _cc.step;
    var bc = cur ? '#f97316' : (st[3] ? 'rgba(34,197,94,.45)' : 'var(--border)');
    return '<button onclick="ccGo(' + st[0] + ')" style="flex:1;min-width:140px;text-align:left;cursor:pointer;padding:10px 12px;border-radius:8px;border:1px solid ' + bc + ';' +
      'background:' + (cur ? 'rgba(249,115,22,.08)' : 'var(--bg-card)') + ';color:inherit">' +
      '<div style="font-weight:700;font-size:13.5px;color:' + (cur ? '#f97316' : 'inherit') + '">' + (st[3] ? '&#10003; ' : '') + st[0] + '. ' + escHtml(st[1]) + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color)">' + escHtml(st[2] || '') + '</div></button>';
  }).join('') + '</div>';
  html += '<div id="cc-step"></div>';
  el.innerHTML = html;
  var body = document.getElementById('cc-step');
  if (_cc.step === 1) body.innerHTML = ccStep1();
  else if (_cc.step === 2) body.innerHTML = ccStep2();
  else if (_cc.step === 3) body.innerHTML = ccStep3();
  else if (_cc.step === 4) { body.innerHTML = ccStep4(); if (!closed) pvLoadRecon(); }
  else body.innerHTML = ccStep5();
}

function ccKpi(v, l, color) {
  return '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px 14px">' +
    '<div style="font-size:20px;font-weight:700' + (color ? ';color:' + color : '') + '">' + v + '</div>' +
    '<div style="font-size:12px;color:var(--text-muted-color)">' + l + '</div></div>';
}
function ccCard(inner) { return '<div class="card"><div class="card-body">' + inner + '</div></div>'; }
function ccClosedNote() {
  return '<div class="alert" style="margin-bottom:12px">This week is closed. What went to QuickBooks is frozen; an admin can reopen it from step 5.</div>';
}

/* ---------------------------------------------------------- step 1 --- */

var CC_REQUIRED = [
  ['Tech ID', 'Who collected the cash (Pulsar puts the name here, Last, First)'],
  ['Pay Period', 'Which week the call belongs to'],
  ['Collected Cash', 'Cash collected on the call, tax included'],
  ['Collected Tax', 'The sales tax inside that cash'],
  ['Task', 'The service, which sets the class (Locksmith / Roadside / Dispatch)'],
  ['Status', 'Only Completed and GOA calls count'],
  ['Call UID', 'Stops a call from being counted twice'],
  ['Location', 'The city, which becomes the QuickBooks Location']
];

function ccStep1() {
  var d = _cc.data;
  if (d.status === 'closed') return ccClosedNote() + ccCard(ccImportSummary());
  _pvState.ccWeek = _cc.week; _pvState.strict = true;
  var cols = '<table class="table"><thead><tr><th>Column</th><th>What Nova uses it for</th></tr></thead><tbody>' +
    CC_REQUIRED.map(function (c) { return '<tr><td style="white-space:nowrap"><strong>' + c[0] + '</strong></td><td style="font-size:13px;color:var(--text-muted-color)">' + c[1] + '</td></tr>'; }).join('') +
    '</tbody></table><div style="font-size:12px;color:var(--text-muted-color);margin-top:8px">Helpful but optional: <strong>Invoice</strong>, <strong>Account</strong>. Column order does not matter and extra columns are ignored.</div>';
  var drop =
    '<div style="border:2px dashed var(--border);border-radius:12px;padding:22px;text-align:center">' +
      '<div style="font-size:15px;margin-bottom:6px">Pulsar Call Search export for the week of ' + ccWeekLabel(_cc.week) + '</div>' +
      '<div style="font-size:13px;color:var(--text-muted-color);margin-bottom:10px">CSV or Excel (.xlsx)</div>' +
      '<input type="file" id="pv-file" accept=".csv,text/csv,.xlsx" onchange="pvOnFile(this)" />' +
    '</div>' +
    '<div style="font-size:12.5px;color:var(--text-muted-color);margin-top:12px;line-height:1.6"><strong>How to pull it in Pulsar:</strong> Reports &rarr; Call Search &rarr; date range Monday ' +
      ccMdy(_cc.week) + ' to Sunday ' + ccMdy(d.week_end) + ' &rarr; all locations, every status &rarr; turn on every column listed here &rarr; Export.</div>';
  return ccCard(
    (d.import ? '<div style="margin-bottom:14px">' + ccImportSummary() + '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px">Dropping a new file for this week replaces the import.</div></div>' : '') +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;align-items:start">' +
      '<div>' + drop + '</div>' +
      '<div><h4 style="margin:0 0 8px">Required columns</h4>' + cols + '</div>' +
    '</div>' +
    '<select id="pv-period" style="display:none"><option value="' + _cc.week + '" selected></option></select>' +
    '<div id="pv-preview" style="margin-top:16px"></div><div id="pv-recon" style="display:none"></div>'
  ) + (d.import ? '<div style="text-align:right;margin-top:12px"><button class="btn btn-primary" onclick="ccGo(2)">Next: names &amp; tasks</button></div>' : '');
}
function ccImportSummary() {
  var i = _cc.data.import;
  if (!i) return '<div style="color:var(--text-muted-color)">Not imported yet.</div>';
  return ccPill('Imported', 'ok') + ' <strong>' + escHtml(i.filename || 'Pulsar export') + '</strong> &middot; ' + i.cash_rows + ' cash calls &middot; ' +
    ccDollars(i.cash_total) + ' &middot; by ' + escHtml(i.uploaded_by_name || '') + ', ' + escHtml(new Date(i.created_at).toLocaleString());
}

/* ---------------------------------------------------------- step 2 --- */

function ccStep2() {
  var d = _cc.data;
  if (d.status === 'closed') return ccClosedNote();
  if (!d.steps.imported) return ccCard('<div style="color:var(--text-muted-color)">Import the Pulsar export first (step 1).</div>');
  var users = d.users || [];
  var uOpts = '<option value="">Pick the Nova user&hellip;</option>' + users.map(function (u) { return '<option value="' + u.id + '">' + escHtml(u.name) + '</option>'; }).join('');
  var names = d.unlinked.length
    ? '<table class="table"><thead><tr><th>Name in Pulsar</th><th style="text-align:right">Cash calls</th><th style="text-align:right">Cash</th><th>Nova user</th><th></th></tr></thead><tbody>' +
      d.unlinked.map(function (u, i) {
        return '<tr><td><strong>' + escHtml(u.tech_raw) + '</strong></td><td style="text-align:right">' + u.calls + '</td><td style="text-align:right">' + ccDollars(u.cash) + '</td>' +
          '<td><select id="cc-link-' + i + '" style="min-width:220px">' + uOpts + '</select></td>' +
          '<td><button class="btn btn-secondary btn-sm" onclick="ccLinkName(' + i + ')">Link</button></td></tr>';
      }).join('') + '</tbody></table>'
    : '<div>' + ccPill('All linked', 'ok') + ' <span style="color:var(--text-muted-color);font-size:13px">Every Pulsar name this week is tied to a Nova user.</span></div>';
  var classes = d.classes || [];
  var tasks = (d.tasks || []);
  var taskRows = tasks.map(function (t, i) {
    var need = !t.cls;
    var opts = '<option value="">Choose&hellip;</option>' + classes.map(function (c) { return '<option' + (c === t.cls ? ' selected' : '') + '>' + escHtml(c) + '</option>'; }).join('');
    return '<tr' + (need ? ' style="background:rgba(239,68,68,.06)"' : '') + '><td><strong>' + escHtml(t.task || '(blank)') + '</strong></td>' +
      '<td style="text-align:right">' + t.calls + '</td><td style="text-align:right">' + ccDollars(t.cash) + '</td>' +
      '<td style="color:var(--text-muted-color)">' + escHtml(t.group) + '</td>' +
      '<td><select onchange="ccSetTask(' + i + ',this.value)" style="min-width:140px' + (need ? ';border-color:#ef4444' : '') + '">' + opts + '</select>' +
        (t.source === 'suggested' ? '<div style="font-size:11px;color:var(--text-muted-color)">suggested from the royalty rules</div>' : '') + '</td></tr>';
  }).join('');
  return ccCard('<h3 style="margin:0 0 4px">Pulsar names not linked to a Nova user</h3>' +
      '<p style="font-size:13px;color:var(--text-muted-color);margin:0 0 12px">Pick the person once. Nova remembers it for every future import and re-links this week&#39;s calls.</p>' + names) +
    '<div style="height:14px"></div>' +
    ccCard('<h3 style="margin:0 0 4px">Pulsar tasks this week</h3>' +
      '<p style="font-size:13px;color:var(--text-muted-color);margin:0 0 12px">Each task&#39;s revenue goes to the class picked here. Map a task once and every future week uses it. A task with no class holds back the entries that use it.</p>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Pulsar task</th><th style="text-align:right">Calls</th><th style="text-align:right">Cash</th><th>Royalty group</th><th>Class</th></tr></thead><tbody>' +
      (taskRows || '<tr><td colspan="5" style="color:var(--text-muted-color)">No cash calls this week.</td></tr>') + '</tbody></table></div>') +
    '<div style="text-align:right;margin-top:12px"><button class="btn btn-primary" onclick="ccGo(3)">Next: expenses</button></div>';
}

async function ccLinkName(i) {
  var u = _cc.data.unlinked[i];
  var sel = document.getElementById('cc-link-' + i);
  if (!u || !sel || !sel.value) { novaAlert('Pick the Nova user first.'); return; }
  try {
    var cur = await api('GET', '/pulsar/tech-map');
    var map = (cur && cur.map) || {};
    map[String(u.tech_raw).replace(/\s+/g, ' ').trim().toLowerCase()] = parseInt(sel.value, 10);
    await api('PUT', '/pulsar/tech-map', { map: map });
    showToast('Linked ' + u.tech_raw, 'success');
    ccReload();
  } catch (err) { novaAlert(err.message || 'Could not link that name.'); }
}

async function ccSetTask(i, cls) {
  var t = _cc.data.tasks[i];
  if (!t) return;
  try {
    await api('PUT', '/cash-close/task-class', { task: t.task, cls: cls });
    showToast(cls ? ('"' + (t.task || '(blank)') + '" is ' + cls) : 'Mapping removed', 'success');
    ccReload();
  } catch (err) { novaAlert(err.message || 'Could not save that.'); }
}

/* ---------------------------------------------------------- step 3 --- */

function ccStep3() {
  var d = _cc.data;
  if (d.status === 'closed') return ccClosedNote();
  var q = (d.queue || []).filter(function (x) {
    return _cc.qfilter === 'all' ? true : _cc.qfilter === 'waiting' ? x.review_status === 'pending' : x.review_status === _cc.qfilter;
  });
  var counts = { waiting: 0, approved: 0, denied: 0 };
  (d.queue || []).forEach(function (x) { if (x.review_status === 'pending') counts.waiting++; else counts[x.review_status] = (counts[x.review_status] || 0) + 1; });
  var filt = ['waiting', 'approved', 'denied', 'all'].map(function (f) {
    var n = f === 'all' ? (d.queue || []).length : counts[f];
    return '<option value="' + f + '"' + (f === _cc.qfilter ? ' selected' : '') + '>' + f.charAt(0).toUpperCase() + f.slice(1) + ' (' + (n || 0) + ')</option>';
  }).join('');
  var rows = q.map(function (x) {
    var receipt = x.has_photo ? '<button class="btn btn-ghost btn-sm" onclick="ccShowReceipt(' + x.deposit_id + ',' + x.id + ')">Photo</button>'
      : x.file_name ? '<button class="btn btn-ghost btn-sm" onclick="depOpenExpenseFile(' + x.deposit_id + ',' + x.id + ')">' + escHtml(x.file_name) + '</button>'
      : '<span style="color:#ef4444;font-size:12px;font-weight:600">No receipt</span>';
    var decided = x.review_status !== 'pending';
    var canAct = x.can_review !== false;
    var actions = !canAct ? '<span style="font-size:12px;color:var(--text-muted-color)">Another city&#39;s manager reviews this</span>'
      : (x.review_status === 'approved'
        ? '<button class="btn btn-ghost btn-sm" onclick="ccReview(' + x.id + ',\'approved\')">Save</button>'
        : '<button class="btn btn-ghost btn-sm" style="color:#22c55e" onclick="ccReview(' + x.id + ',\'approved\')">Approve</button>') +
        (x.review_status !== 'denied' ? '<button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="ccReview(' + x.id + ',\'denied\')">Deny</button>' : '');
    var classify = !canAct
      ? '<td>' + (x.category ? escHtml(depCatLabel(x.category)) : '&mdash;') + '</td><td>' + (x.review_status === 'denied' ? '&mdash;' : escHtml(depClassLabel(x.qbo_class))) + '</td>'
      : '<td>' + depCatSelectHtml(x.category || '', '', 'cc-cat-' + x.id) + '</td><td>' + depClassSelectHtml(x.qbo_class || 'split', 'cc-cls-' + x.id) + '</td>';
    var status = x.review_status === 'approved' ? ccPill('Approved', 'ok') : x.review_status === 'denied' ? ccPill('Denied', 'bad') : ccPill('Waiting', 'warn');
    return '<tr><td>' + receipt + '</td>' +
      '<td>' + escHtml(x.user_name || '') + '<div style="font-size:11px;color:var(--text-muted-color)">' + escHtml(x.city_code || '') + ' &middot; ' +
        '<a href="#" onclick="navigate(\'view-deposit\',' + x.deposit_id + ');return false" style="color:var(--primary);text-decoration:none;white-space:nowrap">' + escHtml(x.deposit_number) + '</a>' + (x.late ? ' &middot; late' : '') + '</div></td>' +
      '<td>' + escHtml(x.description || '') + (x.no_receipt && x.no_receipt_reason ? '<div style="font-size:11px;color:#f59e0b">No receipt: ' + escHtml(x.no_receipt_reason) + '</div>' : '') +
        (x.review_status === 'denied' && x.review_reason ? '<div style="font-size:11px;color:#ef4444">' + escHtml(x.review_reason) + '</div>' : '') + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' + ccDollars(x.amount) + '</td>' + classify +
      '<td>' + status + (decided && x.reviewed_by_name ? '<div style="font-size:11px;color:var(--text-muted-color)">' + escHtml(x.reviewed_by_name) + '</div>' : '') + '</td>' +
      '<td style="white-space:nowrap">' + actions + '</td></tr>';
  }).join('');
  return ccCard(
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:10px"><div>' +
      '<h3 style="margin:0 0 4px">Expenses to review</h3><div style="font-size:13px;color:var(--text-muted-color)">Every expense line on this week&#39;s deposits (and late ones for closed weeks). The tech only wrote a description; you pick the category and class. "Split by revenue" divides the line by the tech&#39;s Pulsar mix for the week.</div></div>' +
      '<select onchange="_cc.qfilter=this.value;ccRender()" style="width:auto;min-width:150px">' + filt + '</select></div>' +
    '<div class="table-wrap"><table class="table"><thead><tr><th>Receipt</th><th>Tech / deposit</th><th>What the tech wrote</th><th style="text-align:right">Amount</th><th>Category</th><th>Class</th><th>Status</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" style="color:var(--text-muted-color)">Nothing here.</td></tr>') + '</tbody></table></div>'
  ) + '<div style="text-align:right;margin-top:12px"><button class="btn btn-primary" onclick="ccGo(4)">Next: reconcile</button></div>';
}

async function ccReview(expenseId, status) {
  var x = (_cc.data.queue || []).filter(function (q) { return q.id === expenseId; })[0];
  if (!x) return;
  var body = { status: status };
  var catEl = document.getElementById('cc-cat-' + expenseId);
  var clsEl = document.getElementById('cc-cls-' + expenseId);
  if (status === 'denied') {
    var reason = await novaPrompt('Why is this expense being denied? The tech will see this.', '', { title: 'Deny expense', okText: 'Deny it' });
    if (reason === null || reason === undefined) return;
    reason = String(reason).trim();
    if (!reason) { novaAlert('Please give a reason for denying this expense.'); return; }
    body.reason = reason;
  } else {
    if (catEl && !catEl.value) { novaAlert('Pick a category first.'); return; }
  }
  if (catEl) body.category = catEl.value || null;
  if (clsEl) body.qbo_class = clsEl.value || null;
  try {
    await api('POST', '/deposits/' + x.deposit_id + '/expenses/' + expenseId + '/review', body);
    ccReload();
  } catch (err) { novaAlert(err.message || 'Could not save that decision.'); }
}

async function ccShowReceipt(depId, expenseId) {
  try {
    var dep = await api('GET', '/deposits/' + depId);
    var ex = (dep.expenses || []).filter(function (e) { return e.id === expenseId; })[0];
    if (ex && ex.receipt_image) depShowImage(ex.receipt_image);
    else novaAlert('No photo on that line.');
  } catch (err) { novaAlert(err.message || 'Could not open the receipt.'); }
}

/* ---------------------------------------------------------- step 4 --- */

function ccStep4() {
  var d = _cc.data;
  if (d.status === 'closed') return ccClosedNote();
  if (!d.steps.imported) return ccCard('<div style="color:var(--text-muted-color)">Import the Pulsar export first (step 1).</div>');
  var s = d.steps;
  return ccCard(
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
      '<div><h3 style="margin:0 0 4px">Reconcile cash</h3><div style="font-size:13px;color:var(--text-muted-color)">Pulsar cash against what each tech deposited plus approved expenses. Use the actions on each row (remind, record a shortage, mark a deposit missed, carry an overage). Techs with no deposit go to QuickBooks as cash held by that tech; their late deposit clears it in a later week.</div></div>' +
      (s.reconciled
        ? '<div style="text-align:right">' + ccPill('Reviewed by ' + escHtml(s.reconciled_by || ''), 'ok') + '<div><button class="btn btn-ghost btn-sm" onclick="ccMarkReconciled(false)">Undo</button></div></div>'
        : '<button class="btn btn-primary" onclick="ccMarkReconciled(true)">I have reviewed every flag</button>') +
    '</div>' +
    '<select id="pv-period" style="display:none"><option value="' + _cc.week + '" selected></option></select>' +
    '<div id="pv-recon" style="margin-top:14px"><div class="loading">Loading…</div></div>'
  ) + '<div style="text-align:right;margin-top:12px"><button class="btn btn-primary" onclick="ccGo(5)">Next: export</button></div>';
}

async function ccMarkReconciled(done) {
  try {
    await api('PUT', '/cash-close/week/' + _cc.week + '/reconciled', { done: done });
    await ccLoad(false);
    if (done) ccGo(5);
  } catch (err) { novaAlert(err.message || 'Could not save.'); }
}

/* ---------------------------------------------------------- step 5 --- */

function ccStep5() {
  var d = _cc.data;
  var closed = d.status === 'closed';
  var units = d.units || [];
  var ready = units.filter(function (u) { return !u.problems.length; });
  var blocked = units.length - ready.length;
  var html = '';
  if (!closed && d.config_problems && d.config_problems.length) {
    html += '<div class="alert alert-error" style="margin-bottom:12px">The QuickBooks mapping is not finished: ' + escHtml(d.config_problems.join(' ')) +
      ' <a href="#" onclick="qboOpenSettings();return false">Open the mapping</a>.</div>';
  }
  var tot = { inc: {}, os: 0 };
  ready.forEach(function (u) { tot.os += u.over_short; });
  (d.totals || []).forEach(function (t) { if (t.cls && t.credit) tot.inc[t.cls] = (tot.inc[t.cls] || 0) + t.credit; });
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px">' +
    ccKpi(String(ready.length), 'Journal entries ready' + (blocked ? ' (' + blocked + ' held back)' : '')) +
    Object.keys(tot.inc).sort().map(function (c) { return ccKpi(ccMoney(tot.inc[c]), c + ' (credits)'); }).join('') +
    ccKpi((tot.os > 0 ? '+' : '') + ccMoney(tot.os), 'Cash over/short (net)', tot.os < 0 ? '#ef4444' : '') +
    '</div>';

  var rows = units.map(function (u) {
    var open = !!_cc.openUnit[u.key];
    var kind = u.kind === 'held' ? ccPill('No deposit: held', 'warn') : u.kind === 'late' ? ccPill('Late deposit', 'mute') : '';
    var status = u.problems.length
      ? '<div style="color:#ef4444;font-size:12px;max-width:320px;white-space:normal">' + u.problems.map(escHtml).join('<br>') + '</div>'
      : ccPill(closed ? 'Exported' : 'Ready', 'ok');
    var classMix = Object.keys(u.class_cash || {}).sort().map(function (c) { return escHtml(c) + ' ' + ccMoney(u.class_cash[c]); }).join(' &middot; ');
    var line = '<tr' + (u.problems.length ? ' style="opacity:.85"' : '') + '>' +
      '<td style="white-space:nowrap"><strong>' + escHtml(u.journal_no) + '</strong><div><a href="#" onclick="ccToggleUnit(\'' + escHtml(u.key) + '\');return false" style="font-size:12px;color:var(--text-muted-color);text-decoration:none">' +
        (open ? '&#9662; ' : '&#9656; ') + u.lines.length + ' lines</a></div></td>' +
      '<td>' + escHtml(u.user_name) + ' ' + kind + '<div style="font-size:11px;color:var(--text-muted-color)">' + escHtml(u.location || '') + '</div></td>' +
      '<td style="text-align:right">' + ccMoney(u.pulsar_cash) + (classMix ? '<div style="font-size:11px;color:var(--text-muted-color)">' + classMix + '</div>' : '') + '</td>' +
      '<td style="text-align:right' + (u.over_short < 0 ? ';color:#ef4444' : '') + '">' + (u.kind === 'held' ? '&mdash;' : (u.over_short > 0 ? '+' : '') + ccMoney(u.over_short)) + '</td>' +
      '<td>' + status + '</td></tr>';
    if (open) {
      line += '<tr><td></td><td colspan="4" style="padding-top:0"><table style="width:100%;font-size:12px;border-collapse:collapse">' +
        '<tr style="color:var(--text-muted-color)"><td style="padding:4px 8px">Account</td><td style="padding:4px 8px;text-align:right">Debit</td><td style="padding:4px 8px;text-align:right">Credit</td><td style="padding:4px 8px">Class</td><td style="padding:4px 8px">Location</td><td style="padding:4px 8px">Description</td></tr>' +
        u.lines.map(function (l) {
          return '<tr><td style="padding:3px 8px;white-space:nowrap">' + (l.account ? escHtml(l.account) : '<span style="color:#ef4444">(no account)</span>') + '</td>' +
            '<td style="padding:3px 8px;text-align:right">' + (l.debit ? ccMoney(l.debit) : '') + '</td>' +
            '<td style="padding:3px 8px;text-align:right">' + (l.credit ? ccMoney(l.credit) : '') + '</td>' +
            '<td style="padding:3px 8px">' + escHtml(l.cls || '') + '</td><td style="padding:3px 8px">' + escHtml(l.location || '') + '</td>' +
            '<td style="padding:3px 8px;color:var(--text-muted-color)">' + escHtml(l.description || '') + '</td></tr>';
        }).join('') + '</table></td></tr>';
    }
    return line;
  }).join('');
  html += ccCard('<h3 style="margin:0 0 10px">Journal entries (one per tech per week)</h3>' +
    '<div class="table-wrap"><table class="table"><thead><tr><th>Journal No.</th><th>Tech</th><th style="text-align:right">Pulsar cash</th><th style="text-align:right">Over / short</th><th>Status</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="5" style="color:var(--text-muted-color)">No cash activity this week.</td></tr>') + '</tbody></table></div>');

  var totRows = (d.totals || []).map(function (t) {
    return '<tr><td>' + escHtml(t.account) + '</td><td>' + escHtml(t.cls || '') + '</td><td style="text-align:right">' + (t.debit ? ccMoney(t.debit) : '') + '</td><td style="text-align:right">' + (t.credit ? ccMoney(t.credit) : '') + '</td></tr>';
  }).join('');
  var dsum = 0, csum = 0;
  (d.totals || []).forEach(function (t) { dsum += t.debit; csum += t.credit; });
  html += '<div style="height:14px"></div>' + ccCard('<h3 style="margin:0 0 10px">Totals going to QuickBooks' + (closed ? '' : ' (ready entries)') + '</h3>' +
    '<table class="table"><thead><tr><th>Account</th><th>Class</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th></tr></thead><tbody>' + totRows +
    '<tr style="font-weight:700"><td>Totals</td><td></td><td style="text-align:right">' + ccMoney(dsum) + '</td><td style="text-align:right">' + ccMoney(csum) + '</td></tr></tbody></table>' +
    '<div style="display:flex;gap:16px;align-items:flex-start;margin-top:14px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:260px;font-size:12.5px;color:var(--text-muted-color);line-height:1.6"><strong style="color:inherit">In QuickBooks:</strong> Settings &rarr; Import data &rarr; Journal entries &rarr; upload the file &rarr; check the column mapping &rarr; Import. ' +
        'Turn on class and location tracking, turn account numbers off, and turn off the duplicate journal number warning first.' +
        (closed ? '' : ' <strong style="color:#f59e0b">Until the week is closed the file is a DRAFT</strong> for checking; closing freezes the week and its deposits.') + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;min-width:240px">' +
        '<button class="btn ' + (closed ? 'btn-primary' : 'btn-secondary') + '" onclick="ccDownload()">' + (closed ? 'Download CSV' : 'Download draft CSV') + '</button>' +
        (closed
          ? (d.can_reopen ? '<button class="btn btn-secondary" onclick="ccReopen()">Reopen week</button>' : '')
          : '<button class="btn btn-primary" onclick="ccClose()">Close the week</button>') +
      '</div></div>');
  return html;
}

function ccToggleUnit(k) { _cc.openUnit[k] = !_cc.openUnit[k]; ccRender(); }

async function ccDownload() {
  try {
    var r = await api('GET', '/cash-close/week/' + _cc.week + '/csv');
    ccSaveFile(r.csv, r.filename);
  } catch (err) { novaAlert(err.message || 'Could not build the CSV.'); }
}
function ccSaveFile(text, name) {
  var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name || 'nova-cash-JE.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

async function ccClose() {
  var ok = await novaConfirm('Close the week of ' + ccWeekLabel(_cc.week) + '? Its deposits lock and the QuickBooks file is frozen. Only an admin can reopen it.', { title: 'Close the week', okText: 'Close it' });
  if (!ok) return;
  try {
    var r = await api('POST', '/cash-close/week/' + _cc.week + '/close', {});
    showToast('Week closed: ' + r.entries + ' journal entries', 'success');
    ccSaveFile(r.csv, r.filename);
    await ccLoad(false);
  } catch (err) { novaAlert(err.message || 'Could not close the week.'); }
}

async function ccReopen() {
  var reason = await novaPrompt('Why is this week being reopened? This goes in the audit log. Remember to delete or adjust the entries already imported into QuickBooks.', '', { title: 'Reopen week', okText: 'Reopen' });
  if (reason === null || reason === undefined) return;
  reason = String(reason).trim();
  if (!reason) { novaAlert('A reason is required.'); return; }
  try {
    await api('POST', '/cash-close/week/' + _cc.week + '/reopen', { reason: reason });
    showToast('Week reopened', 'success');
    await ccLoad(true);
  } catch (err) { novaAlert(err.message || 'Could not reopen the week.'); }
}

/* ------------------------------------------------ mapping dialog --- */

var qboCfg = null, qboCfgCities = [], qboCfgTasks = [], qboCfgCanEdit = false, qboTab = 'accounts';

function qboCloseModal(id) { var el = document.getElementById(id); if (el && el.parentNode) el.parentNode.removeChild(el); }

async function qboOpenSettings() {
  qboCloseModal('qbo-settings-modal');
  var wrap = document.createElement('div');
  wrap.className = 'modal-overlay'; wrap.id = 'qbo-settings-modal';
  wrap.innerHTML = '<div class="modal" style="max-width:780px"><div class="modal-header"><div class="modal-title">QuickBooks mapping</div>' +
    '<button class="btn btn-ghost btn-sm" onclick="qboCloseModal(\'qbo-settings-modal\')">&times;</button></div>' +
    '<div class="modal-body" id="qbo-settings-body"><div class="loading">Loading…</div></div><div class="modal-footer" id="qbo-settings-footer"></div></div>';
  document.body.appendChild(wrap);
  try {
    var r = await api('GET', '/cash-close/config');
    qboCfg = JSON.parse(JSON.stringify(r.config));
    qboCfgCities = r.cities || []; qboCfgTasks = r.tasks || []; qboCfgCanEdit = !!r.can_edit;
    qboRenderSettings();
  } catch (err) {
    var b = document.getElementById('qbo-settings-body');
    if (b) b.innerHTML = '<div class="alert alert-error">' + escHtml(err.message || 'Could not load the mapping') + '</div>';
  }
}

function qboIn(path, val, ph) {
  return '<input type="text" value="' + escHtml(val || '') + '" placeholder="' + escHtml(ph || '') + '"' +
    (qboCfgCanEdit ? '' : ' disabled') + ' oninput="qboCfgSet(\'' + path + '\',this.value)" />';
}
function qboCfgSet(path, v) {
  var parts = path.split('.');
  var o = qboCfg;
  for (var i = 0; i < parts.length - 1; i++) o = o[/^\d+$/.test(parts[i]) ? parseInt(parts[i], 10) : parts[i]];
  o[parts[parts.length - 1]] = v;
}
function qboTabBtn(k, l) {
  return '<button class="btn btn-sm ' + (qboTab === k ? 'btn-primary' : 'btn-secondary') + '" onclick="qboTab=\'' + k + '\';qboRenderSettings()">' + l + '</button>';
}

function qboRenderSettings() {
  var body = document.getElementById('qbo-settings-body');
  if (!body || !qboCfg) return;
  var dis = qboCfgCanEdit ? '' : ' disabled';
  var h = '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">' + qboTabBtn('accounts', 'Accounts') + qboTabBtn('tasks', 'Pulsar tasks &rarr; Class') + qboTabBtn('cities', 'Cities') + '</div>';
  if (!qboCfgCanEdit) h += '<div class="alert" style="margin-bottom:12px">Only an admin can change the accounts. Task classes can also be set from step 2 of the weekly close.</div>';
  if (qboTab === 'accounts') {
    h += '<p style="font-size:12px;color:var(--text-muted-color);margin:0 0 12px">Names must match your QuickBooks chart of accounts exactly. Sub-accounts as <strong>Parent:Sub</strong>.</p>';
    h += '<div class="form-group"><label>Revenue goes to</label><select' + dis + ' onchange="qboCfg.revenue_mode=this.value;qboRenderSettings()">' +
      '<option value="income"' + (qboCfg.revenue_mode !== 'clearing' ? ' selected' : '') + '>Income accounts by class, with sales tax split out</option>' +
      '<option value="clearing"' + (qboCfg.revenue_mode === 'clearing' ? ' selected' : '') + '>Cash Clearing by class (if cash sales already reach QuickBooks another way)</option></select></div>';
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px">' +
      '<div class="form-group"><label>Bank account (debit: deposited)</label>' + qboIn('bank_account', qboCfg.bank_account, 'e.g. Checking') + '</div>' +
      '<div class="form-group"><label>Cash over / short</label>' + qboIn('over_short_account', qboCfg.over_short_account, 'e.g. Cash Over and Short') + '</div>' +
      '<div class="form-group"><label>Cash held by techs (no deposit yet)</label>' + qboIn('held_account', qboCfg.held_account, 'e.g. Cash Held by Techs') + '</div>' +
      (qboCfg.revenue_mode === 'clearing'
        ? '<div class="form-group"><label>Cash Clearing</label>' + qboIn('clearing_account', qboCfg.clearing_account, 'e.g. Cash Clearing') + '</div>'
        : '<div class="form-group"><label>Default sales tax account</label>' + qboIn('tax_account', qboCfg.tax_account, 'e.g. Sales Tax Payable') + '</div>') +
      '</div>';
    if (qboCfg.revenue_mode !== 'clearing') {
      h += '<h4 style="margin:6px 0 8px">Income by class (credit)</h4><table class="table"><thead><tr><th>Class</th><th>QuickBooks income account</th></tr></thead><tbody>' +
        qboCfg.classes.map(function (c) { return '<tr><td>' + escHtml(c) + '</td><td>' + qboIn('income_accounts.' + c, qboCfg.income_accounts[c], 'e.g. Sales:' + c) + '</td></tr>'; }).join('') + '</tbody></table>';
    }
    h += '<h4 style="margin:14px 0 8px">Expense categories (picked by the reviewer)</h4><table class="table"><thead><tr><th>Category</th><th>QuickBooks expense account</th>' + (qboCfgCanEdit ? '<th></th>' : '') + '</tr></thead><tbody>';
    qboCfg.categories.forEach(function (c, i) {
      h += '<tr><td>' + qboIn('categories.' + i + '.label', c.label, 'Label') + '</td><td>' + qboIn('categories.' + i + '.account', c.account, 'QuickBooks account') + '</td>' +
        (qboCfgCanEdit ? '<td><button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="qboCfg.categories.splice(' + i + ',1);qboRenderSettings()">Remove</button></td>' : '') + '</tr>';
    });
    h += '</tbody></table>' + (qboCfgCanEdit ? '<button class="btn btn-secondary btn-sm" onclick="qboCfg.categories.push({key:\'\',label:\'\',account:\'\'});qboRenderSettings()">+ Add category</button>' : '');
    h += '<h4 style="margin:14px 0 8px">Classes</h4><div class="form-group"><label>Comma separated, must exist in QuickBooks</label>' +
      '<input type="text" value="' + escHtml(qboCfg.classes.join(', ')) + '"' + dis + ' onchange="qboSetClasses(this.value)" /></div>' +
      '<div class="form-group"><label>Default class (a "split" expense on a tech with no Pulsar cash)</label><select' + dis + ' onchange="qboCfg.default_class=this.value">' +
      qboCfg.classes.map(function (c) { return '<option' + (c === qboCfg.default_class ? ' selected' : '') + '>' + escHtml(c) + '</option>'; }).join('') + '</select></div>';
  } else if (qboTab === 'tasks') {
    h += '<p style="font-size:12px;color:var(--text-muted-color);margin:0 0 12px">Every task seen in Pulsar imports in the last 90 days. Locksmith and roadside tasks are suggested from the royalty rules; lockouts and trunks ("Opening") and anything else need a pick. A task with no class holds back the entries that use it.</p>' +
      '<table class="table"><thead><tr><th>Pulsar task</th><th style="text-align:right">Calls (90 days)</th><th>Royalty group</th><th>Class</th></tr></thead><tbody>' +
      qboCfgTasks.map(function (t, i) {
        var mapped = qboCfg.task_classes[String(t.task || '').replace(/\s+/g, ' ').trim().toLowerCase()] || '';
        var shown = mapped || (t.source === 'suggested' ? t.cls : '');
        var need = !shown;
        return '<tr' + (need ? ' style="background:rgba(239,68,68,.06)"' : '') + '><td><strong>' + escHtml(t.task || '(blank)') + '</strong></td><td style="text-align:right">' + t.calls + '</td>' +
          '<td style="color:var(--text-muted-color)">' + escHtml(t.group) + '</td><td><select onchange="qboSetTaskClass(' + i + ',this.value)"' + (need ? ' style="border-color:#ef4444"' : '') + '>' +
          '<option value="">' + (t.source === 'suggested' && !mapped ? 'Suggested: ' + escHtml(t.cls) : 'Choose&hellip;') + '</option>' +
          qboCfg.classes.map(function (c) { return '<option' + (c === mapped ? ' selected' : '') + '>' + escHtml(c) + '</option>'; }).join('') + '</select></td></tr>';
      }).join('') + '</tbody></table>';
  } else {
    h += '<table class="table"><thead><tr><th>Nova city</th><th>QuickBooks Location</th>' + (qboCfg.revenue_mode !== 'clearing' ? '<th>Sales tax account</th>' : '') + '</tr></thead><tbody>' +
      qboCfgCities.map(function (c) {
        var code = String(c.code).toUpperCase();
        return '<tr><td>' + escHtml(c.name) + ' (' + escHtml(code) + ')</td>' +
          '<td><input type="text" value="' + escHtml(qboCfg.city_locations[code] || '') + '" placeholder="' + escHtml(c.name) + '"' + dis + ' oninput="qboSetMap(\'city_locations\',\'' + escHtml(code) + '\',this.value)" /></td>' +
          (qboCfg.revenue_mode !== 'clearing' ? '<td><input type="text" value="' + escHtml(qboCfg.city_tax_accounts[code] || '') + '" placeholder="' + escHtml(qboCfg.tax_account || 'default') + '"' + dis +
            ' oninput="qboSetMap(\'city_tax_accounts\',\'' + escHtml(code) + '\',this.value)" /></td>' : '') + '</tr>';
      }).join('') + '</tbody></table>' +
      '<p style="font-size:12px;color:var(--text-muted-color)">Florida, Georgia and Alabama file separately: give each state its own sales tax liability account. A blank tax account uses the default.</p>';
  }
  body.innerHTML = h;
  var f = document.getElementById('qbo-settings-footer');
  if (f) f.innerHTML = '<button class="btn btn-secondary" onclick="qboCloseModal(\'qbo-settings-modal\')">' + (qboCfgCanEdit ? 'Cancel' : 'Close') + '</button>' +
    (qboCfgCanEdit ? '<button class="btn btn-primary" id="qbo-save-btn" onclick="qboSaveSettings()">Save mapping</button>' : '');
}

function qboSetClasses(v) {
  qboCfg.classes = String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  qboRenderSettings();
}
function qboSetMap(field, code, v) { if (v && v.trim()) qboCfg[field][code] = v.trim(); else delete qboCfg[field][code]; }
async function qboSetTaskClass(i, cls) {
  var t = qboCfgTasks[i];
  if (!t) return;
  var k = String(t.task || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (qboCfgCanEdit) { if (cls) qboCfg.task_classes[k] = cls; else delete qboCfg.task_classes[k]; qboRenderSettings(); return; }
  // Non-admins save task classes straight away (same as step 2).
  try { await api('PUT', '/cash-close/task-class', { task: t.task, cls: cls }); if (cls) qboCfg.task_classes[k] = cls; else delete qboCfg.task_classes[k]; showToast('Saved', 'success'); qboRenderSettings(); }
  catch (err) { novaAlert(err.message || 'Could not save.'); }
}

async function qboSaveSettings() {
  var btn = document.getElementById('qbo-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    await api('PUT', '/cash-close/config', { config: qboCfg });
    await depLoadExpenseCats(true);
    showToast('QuickBooks mapping saved', 'success');
    qboCloseModal('qbo-settings-modal');
    if (state.currentView === 'cash-close') ccReload();
  } catch (err) {
    novaAlert('Could not save: ' + (err.message || 'unknown error'));
    if (btn) { btn.disabled = false; btn.textContent = 'Save mapping'; }
  }
}
