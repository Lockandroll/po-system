/* Nova - Accounts Payable
 * ---------------------------------------------------------------------------
 * Bills we owe: entered, tracked to a due date, marked paid. A job raises a
 * task a few days before each is due (jobs/ap.js), so chasing a payment happens
 * in the same task list everyone already uses.
 *
 * House style (CLAUDE.md): string concatenation, no backticks, and &#39; for an
 * apostrophe inside an HTML string. Mirrors public/js/ar.js on purpose.
 * --------------------------------------------------------------------------- */

var _apStatus = 'open';     // open | overdue | paid | all
var _apData = null;         // last /ap/bills response
var _apMeta = null;         // { users, vendors, settings, categories, methods }
var _apQuery = '';

function apInjectStyles() {
  if (document.getElementById('ap-styles')) return;
  var css =
    '.ap-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap}' +
    '.ap-tab{padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-muted-color)}' +
    '.ap-tab.on{color:var(--primary);border-bottom-color:var(--primary)}' +
    '.ap-num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.ap-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}' +
    '.ap-card{background:var(--card-bg,rgba(127,127,127,.06));border:1px solid var(--border);border-radius:var(--radius);padding:13px 15px}' +
    '.ap-card .k{font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted-color)}' +
    '.ap-card .v{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:5px}' +
    '.ap-card .s{font-size:12px;color:var(--text-muted-color);margin-top:2px}' +
    '.ap-card.red .v{color:#f87171}.ap-card.amber .v{color:#f59e0b}' +
    '.ap-chip{display:inline-block;border-radius:5px;padding:2px 8px;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase}' +
    '.ap-chip.unpaid{background:rgba(96,165,250,.15);color:#60a5fa}' +
    '.ap-chip.paid{background:rgba(74,222,128,.15);color:#4ade80}' +
    '.ap-chip.overdue{background:rgba(248,113,113,.15);color:#f87171}' +
    '.ap-chip.due{background:rgba(245,158,11,.15);color:#f59e0b}' +
    '.ap-chip.review{background:rgba(245,158,11,.18);color:#f59e0b}' +
    '.ap-chip.void{background:rgba(148,163,184,.18);color:#94a3b8;text-decoration:line-through}' +
    '.ap-note{font-size:12px;color:var(--text-muted-color);line-height:1.65}' +
    '.ap-warn{background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.35);border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.ap-good{background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.3);border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.ap-att{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;font-size:13px}' +
    '.ap-kv{display:grid;grid-template-columns:120px 1fr;gap:6px 14px;font-size:14px}' +
    '.ap-kv .lbl{color:var(--text-muted-color)}';
  var st = document.createElement('style');
  st.id = 'ap-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function apModal(title, bodyHtml, okLabel, onOk, wide) {
  apCloseModal();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'ap-modal';
  overlay.innerHTML =
    '<div class="modal" style="max-width:' + (wide ? '760px' : '620px') + '">' +
      '<div class="modal-header"><span class="modal-title">' + escHtml(title) + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="apCloseModal()">&#x2715;</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-secondary" onclick="apCloseModal()">Cancel</button>' +
        (okLabel ? '<button class="btn btn-primary" id="ap-modal-ok">' + escHtml(okLabel) + '</button>' : '') +
      '</div></div>';
  document.body.appendChild(overlay);
  var ok = document.getElementById('ap-modal-ok');
  if (ok && onOk) ok.onclick = function () { onOk(); };
}
function apCloseModal() {
  var m = document.getElementById('ap-modal');
  if (m) m.parentNode.removeChild(m);
}
function apVal(id) { var e = document.getElementById(id); return e ? e.value : ''; }
function apChecked(id) { var e = document.getElementById(id); return !!(e && e.checked); }
function apMoney(n) {
  var v = Number(n || 0);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function apErr(msg) {
  var e = document.getElementById('ap-f-err');
  if (e) { e.style.display = 'block'; e.innerHTML = escHtml(msg || 'Could not save.'); }
  else alert(msg);
}
function apDateStr(v) { return v ? String(v).slice(0, 10) : ''; }
function apToday() { return (_apData && _apData.today) || new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
async function renderAp(content) {
  apInjectStyles();
  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Accounts Payable</div>' +
      '<div class="page-subtitle">Bills we owe, what is due, and what has been paid.</div></div>' +
      '<div class="flex-gap">' +
        '<button class="btn btn-secondary btn-sm" onclick="apOpenSettings()">Settings</button>' +
        '<button class="btn btn-primary btn-sm" onclick="apNewBill()">Add a bill</button>' +
      '</div></div>' +
    '<div class="ap-tabs">' +
      '<div class="ap-tab' + (_apStatus === 'open' ? ' on' : '') + '" onclick="apGo(\'open\')">Open</div>' +
      '<div class="ap-tab' + (_apStatus === 'overdue' ? ' on' : '') + '" onclick="apGo(\'overdue\')">Overdue</div>' +
      '<div class="ap-tab' + (_apStatus === 'paid' ? ' on' : '') + '" onclick="apGo(\'paid\')">Paid</div>' +
      '<div class="ap-tab' + (_apStatus === 'all' ? ' on' : '') + '" onclick="apGo(\'all\')">All</div>' +
      '<div style="margin-left:auto"><input id="ap-search" placeholder="Search payee, bill #..." ' +
        'value="' + escHtml(_apQuery) + '" oninput="apOnSearch(this.value)" style="width:220px"></div>' +
    '</div>' +
    '<div id="ap-summary"></div>' +
    '<div id="ap-body"></div>';
  if (!_apMeta) { try { _apMeta = await api('GET', '/ap/meta'); } catch (e) {} }
  await apLoad();
}

function apGo(t) {
  _apStatus = t;
  renderAp(document.getElementById('content') || document.querySelector('.content'));
}
var _apSearchTimer = null;
function apOnSearch(v) {
  _apQuery = v;
  if (_apSearchTimer) clearTimeout(_apSearchTimer);
  _apSearchTimer = setTimeout(function () { apLoad(); }, 250);
}

async function apLoad() {
  var body = document.getElementById('ap-body');
  var sum = document.getElementById('ap-summary');
  if (!body) return;
  body.innerHTML = '<div class="card"><div class="card-body">Loading...</div></div>';
  var qs = '?status=' + encodeURIComponent(_apStatus);
  if (_apQuery && _apQuery.trim()) qs += '&q=' + encodeURIComponent(_apQuery.trim());
  var d;
  try { d = await api('GET', '/ap/bills' + qs); }
  catch (e) { body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  _apData = d;

  var s = d.summary || {};
  if (sum) {
    sum.innerHTML =
      '<div class="ap-cards">' +
        '<div class="ap-card' + (s.overdue_total ? ' red' : '') + '"><div class="k">Overdue</div>' +
          '<div class="v">' + apMoney(s.overdue_total) + '</div><div class="s">' + (s.overdue_count || 0) + ' bill(s)</div></div>' +
        '<div class="ap-card' + (s.due_soon_total ? ' amber' : '') + '"><div class="k">Due this week</div>' +
          '<div class="v">' + apMoney(s.due_soon_total) + '</div><div class="s">' + (s.due_soon_count || 0) + ' bill(s)</div></div>' +
        '<div class="ap-card"><div class="k">Unpaid total</div>' +
          '<div class="v">' + apMoney(s.unpaid_total) + '</div><div class="s">' + (s.unpaid_count || 0) + ' bill(s)</div></div>' +
        (s.review_count ? '<div class="ap-card amber"><div class="k">Drafts to review</div>' +
          '<div class="v">' + s.review_count + '</div><div class="s">from email</div></div>' : '') +
      '</div>';
  }
  apRenderTable(d);
}

function apStatusChip(b) {
  var today = apToday();
  var due = apDateStr(b.due_date);
  if (b.status === 'void') return '<span class="ap-chip void">void</span>';
  if (b.status === 'review') return '<span class="ap-chip review">draft</span>';
  if (b.status === 'paid') return '<span class="ap-chip paid">paid</span>';
  if (due && due < today) return '<span class="ap-chip overdue">overdue</span>';
  if (due && due === today) return '<span class="ap-chip due">due today</span>';
  return '<span class="ap-chip unpaid">unpaid</span>';
}

function apRenderTable(d) {
  var body = document.getElementById('ap-body');
  if (!body) return;
  var bills = d.bills || [];
  if (!bills.length) {
    body.innerHTML = '<div class="ap-good">Nothing here. Add a bill, or forward one to your Accounts Payable ' +
      'email address to start a draft.</div>';
    return;
  }
  body.innerHTML =
    '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>Payee</th><th>Bill #</th><th>Category</th><th class="ap-num">Amount</th>' +
      '<th>Due</th><th>Status</th><th>Assigned</th><th></th>' +
    '</tr></thead><tbody>' +
    bills.map(function (b) {
      var name = b.payee || b.vendor_name || '(no payee)';
      var files = b.attachment_count ? ' <span class="ap-note">&middot; ' + b.attachment_count + ' file' + (b.attachment_count === 1 ? '' : 's') + '</span>' : '';
      return '<tr style="cursor:pointer" onclick="apOpenBill(' + b.id + ')">' +
        '<td>' + escHtml(name) + files + '</td>' +
        '<td>' + escHtml(b.bill_number || '') + '</td>' +
        '<td>' + escHtml(b.category || '') + '</td>' +
        '<td class="ap-num">' + apMoney(b.status === 'paid' && b.paid_amount != null ? b.paid_amount : b.amount) + '</td>' +
        '<td>' + (b.status === 'paid' ? '<span class="ap-note">paid ' + escHtml(apDateStr(b.paid_on)) + '</span>' : escHtml(apDateStr(b.due_date)) || '&mdash;') + '</td>' +
        '<td>' + apStatusChip(b) + '</td>' +
        '<td>' + escHtml(b.assignee_name || '') + '</td>' +
        '<td class="ap-num">' +
          (b.status === 'unpaid' ? '<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();apPayById(' + b.id + ')">Mark paid</button>' :
            b.status === 'review' ? '<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();apOpenBill(' + b.id + ')">Review</button>' : '') +
        '</td></tr>';
    }).join('') +
    '</tbody></table></div>';
}

// ---------------------------------------------------------------------------
//  Option builders
// ---------------------------------------------------------------------------
function apVendorOptions(selectedId) {
  var vs = (_apMeta && _apMeta.vendors) || [];
  return '<option value="">&mdash; none / type a payee below &mdash;</option>' +
    vs.map(function (v) {
      return '<option value="' + v.id + '"' + (String(v.id) === String(selectedId) ? ' selected' : '') + '>' + escHtml(v.name) + '</option>';
    }).join('');
}
function apUserOptions(selectedId, firstLabel) {
  var us = (_apMeta && _apMeta.users) || [];
  return '<option value="">' + escHtml(firstLabel || '— use the fallback —') + '</option>' +
    us.map(function (u) {
      return '<option value="' + u.id + '"' + (String(u.id) === String(selectedId) ? ' selected' : '') + '>' + escHtml(u.name) + '</option>';
    }).join('');
}
function apCategoryOptions(selected) {
  var cs = (_apMeta && _apMeta.categories) || [];
  return '<option value="">&mdash;</option>' +
    cs.map(function (c) {
      return '<option value="' + escHtml(c) + '"' + (String(c) === String(selected || '') ? ' selected' : '') + '>' + escHtml(c) + '</option>';
    }).join('');
}
function apMethodOptions(selected) {
  var ms = (_apMeta && _apMeta.methods) || ['check', 'ach', 'card', 'cash', 'wire', 'other'];
  return ms.map(function (m) {
    return '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + '</option>';
  }).join('');
}

// ---------------------------------------------------------------------------
//  Add / edit
// ---------------------------------------------------------------------------
function apBillFormHtml(b) {
  b = b || {};
  var rec = !!b.recurring;
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>Vendor (optional)</label><select id="ap-f-vendor">' + apVendorOptions(b.vendor_id) + '</select></div>' +
      '<div class="form-group"><label>Payee</label><input id="ap-f-payee" value="' + escHtml(b.payee || '') + '" placeholder="Who gets paid"></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>Amount</label><input id="ap-f-amount" value="' + (b.amount && Number(b.amount) > 0 ? Number(b.amount) : '') + '" placeholder="0.00"></div>' +
      '<div class="form-group"><label>Bill date</label><input type="date" id="ap-f-billdate" value="' + escHtml(apDateStr(b.bill_date)) + '"></div>' +
      '<div class="form-group"><label>Due date</label><input type="date" id="ap-f-due" value="' + escHtml(apDateStr(b.due_date)) + '"></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>Bill #</label><input id="ap-f-billnum" value="' + escHtml(b.bill_number || '') + '"></div>' +
      '<div class="form-group"><label>Category</label><select id="ap-f-cat">' + apCategoryOptions(b.category) + '</select></div>' +
      '<div class="form-group"><label>Assigned to</label><select id="ap-f-assignee">' + apUserOptions(b.assigned_to) + '</select></div>' +
    '</div>' +
    '<div class="form-group"><label>Description / memo</label><textarea id="ap-f-desc" rows="2">' + escHtml(b.description || '') + '</textarea></div>' +
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:center">' +
      '<label class="check"><input type="checkbox" id="ap-f-rec"' + (rec ? ' checked' : '') + ' onchange="var e=document.getElementById(\'ap-f-recwrap\');if(e)e.style.display=this.checked?\'block\':\'none\'"> Recurring monthly</label>' +
      '<div id="ap-f-recwrap" style="display:' + (rec ? 'block' : 'none') + '"><input id="ap-f-recday" value="' + escHtml(b.recurrence_day || '') + '" placeholder="Day of month (1-28)" style="width:200px">' +
        '<div class="ap-note">Blank uses the due date&#39;s day. When you mark one paid, next month&#39;s bill is created automatically.</div></div>' +
    '</div>' +
    '<div id="ap-f-err" class="ap-warn" style="display:none"></div>';
}

function apNewBill() {
  apModal('Add a bill', apBillFormHtml(null), 'Add bill', function () { apSaveBill(null, false); }, true);
}

function apEditBill(b) {
  var draft = b.status === 'review';
  apModal(draft ? 'Confirm draft bill' : 'Edit bill',
    (draft ? '<div class="ap-warn">This draft came in by email. Nova guessed the amount and due date - check them, then save to make it a live bill.</div>' : '') +
    apBillFormHtml(b),
    draft ? 'Save as live bill' : 'Save',
    function () { apSaveBill(b.id, draft); }, true);
}

async function apSaveBill(id, confirmLive) {
  var body = {
    vendor_id: apVal('ap-f-vendor') || null,
    payee: apVal('ap-f-payee'),
    amount: apVal('ap-f-amount'),
    bill_date: apVal('ap-f-billdate'),
    due_date: apVal('ap-f-due'),
    bill_number: apVal('ap-f-billnum'),
    category: apVal('ap-f-cat'),
    assigned_to: apVal('ap-f-assignee') || null,
    description: apVal('ap-f-desc'),
    recurring: apChecked('ap-f-rec'),
    recurrence_day: apVal('ap-f-recday')
  };
  if (confirmLive) body.confirm = true;
  try {
    if (id) await api('PUT', '/ap/bills/' + id, body);
    else await api('POST', '/ap/bills', body);
  } catch (e) { apErr(e.message); return; }
  apCloseModal();
  await apLoad();
}

// ---------------------------------------------------------------------------
//  Detail
// ---------------------------------------------------------------------------
async function apOpenBill(id) {
  var d;
  try { d = await api('GET', '/ap/bills/' + id); }
  catch (e) { alert(e.message); return; }
  var b = d.bill || {};
  var atts = d.attachments || [];
  var name = b.payee || b.vendor_name || '(no payee)';

  var actions = '';
  if (b.status === 'unpaid') actions += '<button class="btn btn-primary btn-sm" onclick="apPayFrom(' + b.id + ')">Mark paid</button>';
  if (b.status === 'review') actions += '<button class="btn btn-primary btn-sm" onclick="apEditFrom(' + b.id + ')">Confirm bill</button>';
  if (b.status !== 'review' && b.status !== 'void') actions += '<button class="btn btn-secondary btn-sm" onclick="apEditFrom(' + b.id + ')">Edit</button>';
  if (b.status === 'paid') actions += '<button class="btn btn-secondary btn-sm" onclick="apUnpay(' + b.id + ')">Mark unpaid</button>';
  if (b.status === 'unpaid' || b.status === 'review') actions += '<button class="btn btn-secondary btn-sm" onclick="apVoid(' + b.id + ')">Void</button>';
  if (b.status === 'unpaid' || b.status === 'review') actions += '<button class="btn btn-ghost btn-sm" onclick="apDelete(' + b.id + ')">Delete</button>';

  var kv =
    '<div class="ap-kv">' +
      '<div class="lbl">Status</div><div>' + apStatusChip(b) + '</div>' +
      '<div class="lbl">Amount</div><div><b>' + apMoney(b.amount) + '</b></div>' +
      '<div class="lbl">Due</div><div>' + (escHtml(apDateStr(b.due_date)) || '&mdash;') +
        (b.recurring ? ' <span class="ap-note">&middot; recurring monthly</span>' : '') + '</div>' +
      (b.bill_number ? '<div class="lbl">Bill #</div><div>' + escHtml(b.bill_number) + '</div>' : '') +
      (b.category ? '<div class="lbl">Category</div><div>' + escHtml(b.category) + '</div>' : '') +
      (b.bill_date ? '<div class="lbl">Bill date</div><div>' + escHtml(apDateStr(b.bill_date)) + '</div>' : '') +
      '<div class="lbl">Assigned</div><div>' + (escHtml(b.assignee_name || '') || '<span class="ap-note">fallback</span>') + '</div>' +
      (b.status === 'paid' ? '<div class="lbl">Paid</div><div>' + apMoney(b.paid_amount) + ' on ' + escHtml(apDateStr(b.paid_on)) +
        (b.paid_method ? ' (' + escHtml(b.paid_method) + ')' : '') + (b.paid_reference ? ' &middot; ' + escHtml(b.paid_reference) : '') + '</div>' : '') +
      (b.description ? '<div class="lbl">Memo</div><div>' + escHtml(b.description) + '</div>' : '') +
    '</div>';

  var attHtml =
    '<div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted-color);margin:16px 0 8px">Attachments</div>' +
    (atts.length ? atts.map(function (a) {
      return '<div class="ap-att"><div>' + escHtml(a.filename || 'file') +
        ' <span class="ap-note">' + (a.size_bytes ? Math.round(a.size_bytes / 1024) + ' KB' : '') + '</span></div>' +
        '<div class="flex-gap">' +
          '<button class="btn btn-secondary btn-sm" onclick="apDownloadAttachment(' + a.id + ')">Open</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="apDeleteAttachment(' + a.id + ',' + b.id + ')">&#x2715;</button>' +
        '</div></div>';
    }).join('') : '<div class="ap-note">No files yet.</div>') +
    '<button class="btn btn-secondary btn-sm" style="margin-top:8px" onclick="apAttachFile(' + b.id + ')">Attach a file</button>';

  apModal(name, kv + attHtml, null, null, false);
  var footer = document.querySelector('#ap-modal .modal-footer');
  if (footer) footer.innerHTML = actions + '<button class="btn btn-secondary" onclick="apCloseModal()">Close</button>';
}

function apEditFrom(id) {
  var b = apFind(id);
  if (b) apEditBill(b); else apReloadThen(id, apEditBill);
}
function apPayFrom(id) { apPayById(id); }
function apFind(id) {
  var bills = (_apData && _apData.bills) || [];
  for (var i = 0; i < bills.length; i++) if (bills[i].id === id) return bills[i];
  return null;
}
async function apReloadThen(id, fn) {
  try { var d = await api('GET', '/ap/bills/' + id); fn(d.bill); } catch (e) { alert(e.message); }
}

// ---------------------------------------------------------------------------
//  Pay
// ---------------------------------------------------------------------------
function apPayById(id) {
  var b = apFind(id);
  var amount = b ? Number(b.amount) : '';
  var name = b ? (b.payee || b.vendor_name || 'bill') : 'bill';
  apModal('Mark paid - ' + name,
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>Amount</label><input id="ap-pay-amt" value="' + (amount || '') + '"></div>' +
      '<div class="form-group"><label>Paid on</label><input type="date" id="ap-pay-date" value="' + apToday() + '"></div>' +
      '<div class="form-group"><label>Method</label><select id="ap-pay-method">' + apMethodOptions('check') + '</select></div>' +
    '</div>' +
    '<div class="form-group"><label>Reference</label><input id="ap-pay-ref" placeholder="Check # / confirmation"></div>' +
    (b && b.recurring ? '<div class="ap-note">This bill is recurring - marking it paid creates next month&#39;s bill automatically.</div>' : '') +
    '<div id="ap-f-err" class="ap-warn" style="display:none"></div>',
    'Mark paid', function () { apDoPay(id); });
}

async function apDoPay(id) {
  var out;
  try {
    out = await api('POST', '/ap/bills/' + id + '/pay', {
      amount: apVal('ap-pay-amt'), paid_on: apVal('ap-pay-date'),
      method: apVal('ap-pay-method'), reference: apVal('ap-pay-ref')
    });
  } catch (e) { apErr(e.message); return; }
  apCloseModal();
  await apLoad();
}

async function apUnpay(id) {
  if (!confirm('Mark this bill unpaid again?')) return;
  try { await api('POST', '/ap/bills/' + id + '/unpay', {}); } catch (e) { alert(e.message); return; }
  apCloseModal();
  await apLoad();
}

function apVoid(id) {
  apModal('Void this bill',
    '<div class="ap-note">Voiding keeps the record but takes it off what is owed. A paid bill cannot be voided - mark it unpaid first.</div>' +
    '<div class="form-group" style="margin-top:10px"><label>Reason</label><input id="ap-void-reason" placeholder="Why is this being voided?"></div>' +
    '<div id="ap-f-err" class="ap-warn" style="display:none"></div>',
    'Void it', function () { apDoVoid(id); });
}
async function apDoVoid(id) {
  try { await api('POST', '/ap/bills/' + id + '/void', { reason: apVal('ap-void-reason') }); }
  catch (e) { apErr(e.message); return; }
  apCloseModal();
  await apLoad();
}

async function apDelete(id) {
  if (!confirm('Delete this bill for good?\n\nUse this only for a mistake or a draft. Paid bills are voided, not deleted.')) return;
  try { await api('DELETE', '/ap/bills/' + id); } catch (e) { alert(e.message); return; }
  apCloseModal();
  await apLoad();
}

// ---------------------------------------------------------------------------
//  Attachments
// ---------------------------------------------------------------------------
function apAttachFile(billId) {
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.onchange = async function () {
    var file = inp.files && inp.files[0];
    if (!file) return;
    var pre;
    try {
      pre = await api('POST', '/ap/bills/' + billId + '/attachments/upload-url',
        { filename: file.name, content_type: file.type || 'application/octet-stream' });
    } catch (e) { alert('Could not start the upload: ' + e.message); return; }
    try {
      var put = await fetch(pre.url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      if (!put.ok) throw new Error('Upload failed (' + put.status + ')');
    } catch (e) { alert('Upload to storage failed: ' + e.message); return; }
    try {
      await api('POST', '/ap/bills/' + billId + '/attachments/confirm',
        { key: pre.key, filename: file.name, content_type: file.type || 'application/octet-stream', size_bytes: file.size });
    } catch (e) { alert('Could not save the attachment: ' + e.message); return; }
    apOpenBill(billId);
  };
  inp.click();
}
async function apDownloadAttachment(id) {
  try { var r = await api('GET', '/ap/attachments/' + id + '/download'); window.open(r.url, '_blank'); }
  catch (e) { alert(e.message); }
}
async function apDeleteAttachment(id, billId) {
  if (!confirm('Remove this attachment?')) return;
  try { await api('DELETE', '/ap/attachments/' + id); } catch (e) { alert(e.message); return; }
  apOpenBill(billId);
}

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------
function apOpenSettings() {
  var st = (_apMeta && _apMeta.settings) || {};
  apModal('Accounts Payable settings',
    '<div class="form-group"><label>Fallback reminder recipient</label>' +
      '<select id="ap-set-user">' + apUserOptions(st.reminder_user_id, '— nobody (leave reminders unassigned) —') + '</select>' +
      '<div class="ap-note">Used when a bill has nobody assigned. A bill with its own assignee always goes to that person.</div></div>' +
    '<div class="form-group"><label>Remind this many days before due</label>' +
      '<input id="ap-set-lead" value="' + escHtml(st.reminder_lead_days == null ? 3 : st.reminder_lead_days) + '" style="width:120px">' +
      '<div class="ap-note">The reminder task is created this many days before each bill&#39;s due date. Default 3.</div></div>' +
    '<div id="ap-f-err" class="ap-warn" style="display:none"></div>',
    'Save settings', function () { apSaveSettings(); });
}
async function apSaveSettings() {
  var out;
  try {
    out = await api('POST', '/ap/settings', {
      reminder_user_id: apVal('ap-set-user') || null,
      reminder_lead_days: apVal('ap-set-lead')
    });
  } catch (e) { apErr(e.message); return; }
  if (_apMeta) _apMeta.settings = out.settings;
  apCloseModal();
}
