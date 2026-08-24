/* Nova Certificates of Insurance.
 *
 * Three screens plus the dialogs that drive them:
 *   coi          - every account that needs a certificate, by status
 *   coi-account  - one account: its requirements, and every certificate issued
 *   coi-cycle    - the renewal checklist for one policy year
 *
 * The STATUS shown anywhere comes from the server (utils/coi.js), never from a
 * second copy of the rules in here. The only comparison this file does on its
 * own is the live required-vs-entered preview inside the upload dialog, and the
 * banner that lands after saving is the server's answer, not that preview.
 *
 * House style: string concatenation only, no template literals/backticks.
 */

var _coiData = null;
var _coiAcct = null;
var _coiCycle = null;
var _coiDocs = null;
var _coiQ = '';
var _coiStatusFilter = '';
var _coiLimitFields = [];

var COI_ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;vertical-align:-3px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>';
var COI_ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;vertical-align:-3px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
var COI_ICON_MAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;vertical-align:-3px"><path d="M3 5h18v14H3z"/><path d="M3 6l9 7 9-7"/></svg>';
var COI_ICON_PDF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;vertical-align:-3px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

/* ---- small helpers ------------------------------------------------------ */

function coiCan() { return can('manage_coi'); }

var COI_TONE_CLASS = { green: 'badge-approved', amber: 'badge-submitted', red: 'badge-rejected', grey: 'badge-inactive' };

function coiChip(st) {
  if (!st) return '<span class="badge badge-inactive">Unknown</span>';
  return '<span class="badge ' + (COI_TONE_CLASS[st.tone] || 'badge-inactive') + '">' + escHtml(st.label) + '</span>';
}

function coiFmtDate(v) {
  if (!v) return '&mdash;';
  var s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return escHtml(String(v));
  return s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4);
}

function coiMoney(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(String(v).replace(/[,$\s]/g, ''));
  if (!isFinite(n)) return '';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function coiNum(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).replace(/[,$\s]/g, '');
  if (s === '') return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

function coiVal(id) {
  var el = document.getElementById(id);
  return el ? el.value : '';
}

function coiChecked(id) {
  var el = document.getElementById(id);
  return !!(el && el.checked);
}

function coiCloseModal(el) {
  var ov = el && el.closest ? el.closest('.modal-overlay') : null;
  if (ov) ov.remove();
  else { var any = document.querySelector('.modal-overlay'); if (any) any.remove(); }
}

function coiModal(html, width) {
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = '<div class="modal" style="max-width:' + (width || 520) + 'px">' + html + '</div>';
  document.body.appendChild(ov);
  return ov;
}

/* ---- screen 1: the COI list --------------------------------------------- */

async function renderCoi(el) {
  if (!can('view_vendors') && !can('manage_vendors') && !can('manage_coi')) {
    el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return;
  }
  el.innerHTML = '<div class="page-header"><div><div class="page-title">Certificates of Insurance</div>' +
    '<div class="page-subtitle">Loading&hellip;</div></div></div>';
  try { _coiData = await api('GET', '/coi'); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">Could not load certificates: ' + escHtml(e.message || 'error') + '</div>'; return; }

  var p = _coiData.policy || {};
  var c = _coiData.counts || {};
  var cy = _coiData.open_cycle;
  var manage = _coiData.can_manage;

  var sub = p.policy_effective
    ? ('Master policy ' + coiFmtDate(p.policy_effective) + ' &ndash; ' + coiFmtDate(p.policy_expires) +
       (p.carrier ? (' &middot; ' + escHtml(p.carrier)) : ''))
    : 'No master policy recorded yet';

  el.innerHTML =
    '<div class="page-header"><div><div class="page-title">Certificates of Insurance</div>' +
      '<div class="page-subtitle">' + sub + '</div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        (manage ? '<button class="btn btn-secondary" onclick="coiPolicyModal()">Policy details</button>' : '') +
        (manage && !cy ? '<button class="btn btn-primary" onclick="coiStartCycleModal()">Start renewal cycle</button>' : '') +
        (cy ? '<button class="btn btn-primary" onclick="navigate(\'coi-cycle\',' + cy.id + ')">Open ' + escHtml(cy.name) + '</button>' : '') +
      '</div></div>' +
    (!_coiData.storage_ready ? '<div class="alert alert-warn">File storage is not configured, so certificates cannot be uploaded yet. Add the R2_* environment variables in Railway.</div>' : '') +
    '<div class="stats-grid">' +
      coiStat('current', 'Current', c.current || 0, '#22c55e') +
      coiStat('expiring', 'Expiring &le; 60 days', c.expiring || 0, '#f59e0b') +
      coiStat('mismatch', 'Below requirement', c.mismatch || 0, '#f59e0b') +
      coiStat('expired', 'Expired', c.expired || 0, '#ef4444') +
      coiStat('missing', 'Missing', c.missing || 0, '#ef4444') +
      coiStat('not_required', 'Not required', c.not_required || 0, '#666') +
    '</div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center">' +
      '<input type="text" id="coi-search" placeholder="Search accounts or holders..." value="' + escHtml(_coiQ) + '" ' +
        'style="max-width:320px;padding:8px 12px" oninput="coiSetQuery(this.value)" />' +
      '<select style="width:auto;min-width:170px" onchange="coiSetStatus(this.value)">' +
        coiOpt('', 'Status: all') + coiOpt('attention', 'Needs attention') + coiOpt('current', 'Current') +
        coiOpt('expiring', 'Expiring') + coiOpt('mismatch', 'Below requirement') +
        coiOpt('expired', 'Expired') + coiOpt('missing', 'Missing') + coiOpt('not_required', 'Not required') +
      '</select>' +
      (manage ? '<button class="btn btn-secondary" onclick="coiAddAccountModal()">+ Set up an account</button>' : '') +
    '</div>' +
    '<div id="coi-table"></div>';
  coiRenderTable();
}

function coiStat(key, label, value, color) {
  return '<div class="stat-card" style="cursor:pointer" onclick="coiSetStatus(\'' + key + '\')">' +
    '<div class="stat-value" style="color:' + color + '">' + value + '</div>' +
    '<div class="stat-label">' + label + '</div></div>';
}

function coiOpt(v, label) {
  return '<option value="' + v + '"' + (_coiStatusFilter === v ? ' selected' : '') + '>' + label + '</option>';
}

function coiSetQuery(v) { _coiQ = v || ''; coiRenderTable(); }

function coiSetStatus(v) {
  _coiStatusFilter = v || '';
  var sel = document.querySelector('#content select');
  if (sel) sel.value = _coiStatusFilter;
  coiRenderTable();
}

var COI_ATTENTION = ['missing', 'expired', 'expiring', 'mismatch'];

function coiRenderTable() {
  var wrap = document.getElementById('coi-table');
  if (!wrap || !_coiData) return;
  var q = _coiQ.toLowerCase();
  var rows = (_coiData.accounts || []).filter(function (a) {
    if (q && (a.account_name || '').toLowerCase().indexOf(q) === -1 &&
             (a.holder_name || '').toLowerCase().indexOf(q) === -1) return false;
    if (!_coiStatusFilter) return true;
    if (_coiStatusFilter === 'attention') return COI_ATTENTION.indexOf(a.status.key) !== -1;
    return a.status.key === _coiStatusFilter;
  });

  var body = rows.length === 0
    ? '<tr><td colspan="7" style="text-align:center;color:var(--text-muted-color);padding:32px">No accounts match.</td></tr>'
    : rows.map(function (a) {
        var noteColor = a.status.tone === 'red' ? '#ef4444' : (a.status.tone === 'amber' ? '#f59e0b' : 'var(--text-muted-color)');
        return '<tr>' +
          '<td style="font-weight:600;color:var(--text)">' + escHtml(a.account_name) + '</td>' +
          '<td style="font-size:13px">' + escHtml(a.holder_name || '—') + '</td>' +
          '<td>' + coiChip(a.status) + '</td>' +
          '<td style="white-space:nowrap;font-family:\'Fira Code\',monospace;font-size:13px">' + coiFmtDate(a.expires_on) + '</td>' +
          '<td style="font-size:13px;color:' + noteColor + '">' + escHtml(a.status.note || '—') + '</td>' +
          '<td style="font-size:13px">' + coiMethodLabel(a) + '</td>' +
          '<td style="white-space:nowrap"><button class="btn btn-secondary btn-sm" onclick="navigate(\'coi-account\',' + a.account_id + ')">Open</button></td>' +
        '</tr>';
      }).join('');

  wrap.innerHTML = '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>Account</th><th>Certificate holder</th><th>Status</th><th>Expires</th><th>Note</th><th>Sends via</th><th></th></tr></thead>' +
    '<tbody>' + body + '</tbody></table></div></div>' +
    '<div style="margin-top:10px;font-size:12px;color:var(--text-muted-color)">' + rows.length + ' of ' + (_coiData.accounts || []).length + ' accounts shown.</div>';
}

function coiMethodLabel(a) {
  if (a.coi_required === false) return '<span class="muted">&mdash;</span>';
  var m = a.submit_method || 'email';
  if (m === 'portal') return 'Portal';
  if (m === 'mail') return 'Mail';
  return 'Email';
}

// Set up an account that has no COI record yet.
async function coiAddAccountModal() {
  var vendors = [];
  try { vendors = await api('GET', '/vendors'); } catch (e) { vendors = []; }
  var have = {};
  (_coiData.accounts || []).forEach(function (a) { have[a.account_id] = true; });
  var opts = vendors.filter(function (v) { return !have[v.id]; })
    .map(function (v) { return '<option value="' + v.id + '">' + escHtml(v.name) + '</option>'; }).join('');
  if (!opts) { showToast('Every account already has a COI record.', 'info'); return; }
  coiModal(
    '<div class="modal-header"><span class="modal-title">Set up an account</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="coiCloseModal(this)">&#x2715;</button></div>' +
    '<div class="modal-body"><div class="form-group"><label>Account</label>' +
      '<select id="coi-new-acct">' + opts + '</select></div>' +
      '<div style="font-size:13px;color:var(--text-muted-color)">This creates the COI record and opens it so you can enter what that account requires.</div></div>' +
    '<div class="modal-footer"><button class="btn btn-secondary" onclick="coiCloseModal(this)">Cancel</button>' +
      '<button class="btn btn-primary" onclick="coiAddAccountGo(this)">Continue</button></div>');
}

async function coiAddAccountGo(btn) {
  var id = parseInt(coiVal('coi-new-acct'), 10);
  if (!id) return;
  btn.disabled = true;
  try {
    await api('PUT', '/coi/account/' + id, { coi_required: true, submit_method: 'email' });
    coiCloseModal(btn);
    navigate('coi-account', id);
  } catch (e) { btn.disabled = false; showToast(e.message || 'Could not set that up', 'error'); }
}

/* ---- screen 2: one account ---------------------------------------------- */

async function renderCoiAccount(el, accountId) {
  var id = parseInt(accountId, 10);
  if (!id) { el.innerHTML = '<div class="alert alert-error">No account selected.</div>'; return; }
  el.innerHTML = '<div class="page-header"><div><div class="page-title">Loading&hellip;</div></div></div>';
  try { _coiAcct = await api('GET', '/coi/account/' + id); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">Could not load that account: ' + escHtml(e.message || 'error') + '</div>'; return; }
  // Agreements and other account paperwork. A failure here must not blank the
  // whole page - the COI half is still worth showing.
  try { _coiDocs = await api('GET', '/account-docs/account/' + id); }
  catch (e) { _coiDocs = { documents: [], can_manage: false, storage_ready: false }; }

  _coiLimitFields = _coiAcct.limit_fields || [];
  var r = _coiAcct.requirements || {};
  var st = _coiAcct.status;
  var manage = _coiAcct.can_manage;
  var current = (_coiAcct.certificates || []).filter(function (c) { return c.id === _coiAcct.current_id; })[0] || null;

  var banner;
  if (st.key === 'current') {
    banner = '<div class="alert alert-success">Certificate current through <strong>' + coiFmtDate(current && current.expires_on) +
      '</strong>. Meets every requirement below.' + (current && current.sent_at ? (' Sent to the account ' + coiFmtDate(current.sent_at)) : '') + '</div>';
  } else if (st.key === 'mismatch') {
    banner = '<div class="alert alert-error"><strong>This certificate does not meet what the account requires.</strong><br>' +
      coiMismatchList(current && current.mismatch) + '</div>';
  } else if (st.key === 'not_required') {
    banner = '<div class="alert alert-info">This account is marked as not requiring a certificate. Nothing here counts toward the renewal cycle.</div>';
  } else {
    banner = '<div class="alert alert-warn"><strong>' + escHtml(st.label) + '.</strong> ' + escHtml(st.note || '') + '</div>';
  }

  el.innerHTML =
    '<div class="page-header"><div>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:4px;cursor:pointer" onclick="navigate(\'coi\')">&larr; Certificates of Insurance</div>' +
      '<div class="page-title">' + escHtml(_coiAcct.account.name) + '</div>' +
      '<div class="page-subtitle">Certificate of insurance requirements &amp; history</div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        (manage && _coiAcct.storage_ready ? '<button class="btn btn-secondary" onclick="coiUploadModal(' + id + ')">' + COI_ICON_UP + ' Upload certificate</button>' : '') +
        (manage ? '<button class="btn btn-primary" onclick="coiSaveRequirements(this)">Save requirements</button>' : '') +
      '</div></div>' +
    banner +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start" class="coi-cols">' +
      coiHolderCard(r, manage) +
      '<div>' + coiLimitsCard(r, manage) + coiSendCard(r, manage) + '</div>' +
    '</div>' +
    coiHistoryCard(id, manage) +
    coiDocsCard(id);
}

/* ---- agreements and other account paperwork ----------------------------- */

var COI_DOC_KINDS = [['agreement', 'Agreement'], ['w9', 'W-9'], ['rate_sheet', 'Rate sheet'], ['other', 'Other']];

function coiDocKindLabel(k) {
  for (var i = 0; i < COI_DOC_KINDS.length; i++) { if (COI_DOC_KINDS[i][0] === k) return COI_DOC_KINDS[i][1]; }
  return 'Document';
}

function coiDocsCard(accountId) {
  var d = _coiDocs || {};
  var docs = d.documents || [];
  var manage = !!d.can_manage;
  var body = docs.length === 0
    ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted-color);padding:28px">No agreements or other paperwork stored for this account.</td></tr>'
    : docs.map(function (x) {
        return '<tr>' +
          '<td style="color:var(--text);font-weight:500">' + COI_ICON_PDF + ' ' + escHtml(x.title || x.file_name) + '</td>' +
          '<td><span class="badge badge-inactive">' + coiDocKindLabel(x.kind) + '</span></td>' +
          '<td style="font-family:\'Fira Code\',monospace;font-size:13px">' + coiFmtDate(x.effective_on) + '</td>' +
          '<td style="font-family:\'Fira Code\',monospace;font-size:13px">' + coiFmtDate(x.expires_on) + '</td>' +
          '<td style="font-size:13px;max-width:280px">' + (x.notes ? escHtml(x.notes) : '<span class="muted">&mdash;</span>') + '</td>' +
          '<td style="white-space:nowrap">' +
            '<button class="btn btn-ghost btn-sm" title="Open" onclick="coiOpenDoc(' + x.id + ')">' + COI_ICON_DL + '</button>' +
            (manage ? '<button class="btn btn-ghost btn-sm" onclick="coiDocModal(' + accountId + ',' + x.id + ')">Edit</button>' : '') +
            (manage ? '<button class="btn btn-ghost btn-sm" title="Delete" onclick="coiDeleteDoc(' + x.id + ')">&#x2715;</button>' : '') +
          '</td></tr>';
      }).join('');
  return '<div class="card" style="margin-top:20px"><div class="card-header">' +
    '<span class="card-title">Agreements &amp; paperwork</span>' +
    (manage && d.storage_ready ? '<button class="btn btn-secondary btn-sm" onclick="coiDocModal(' + accountId + ')">' + COI_ICON_UP + ' Upload document</button>' : '') +
    '</div><div class="table-wrap"><table>' +
    '<thead><tr><th>Document</th><th>Type</th><th>Effective</th><th>Expires</th><th>Notes</th><th></th></tr></thead>' +
    '<tbody>' + body + '</tbody></table></div></div>';
}

var _coiDocUpload = { accountId: null, docId: null };

function coiDocModal(accountId, docId) {
  _coiDocUpload = { accountId: accountId, docId: docId || null };
  var doc = docId ? ((_coiDocs.documents || []).filter(function (x) { return x.id === docId; })[0] || {}) : null;
  var kindOpts = COI_DOC_KINDS.map(function (k) {
    return '<option value="' + k[0] + '"' + (doc && doc.kind === k[0] ? ' selected' : '') + '>' + k[1] + '</option>';
  }).join('');
  coiModal(
    '<div class="modal-header"><span class="modal-title">' + (doc ? 'Edit document' : 'Upload a document') + '</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="coiCloseModal(this)">&#x2715;</button></div>' +
    '<div class="modal-body">' +
      (doc
        ? '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px;font-size:14px;color:var(--text)">' + COI_ICON_PDF + ' ' + escHtml(doc.file_name) + '</div>'
        : '<div class="form-group"><label>File (PDF)</label><input type="file" id="coi-doc-file" accept="application/pdf,image/*" /></div>') +
      coiField('coi-doc-title', 'Title', doc ? doc.title : '') +
      '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:140px"><label>Type</label><select id="coi-doc-kind">' + kindOpts + '</select></div>' +
        '<div style="flex:1;min-width:130px">' + coiField('coi-doc-eff', 'Effective', doc ? (doc.effective_on || '') : '', 'date') + '</div>' +
        '<div style="flex:1;min-width:130px">' + coiField('coi-doc-exp', 'Expires', doc ? (doc.expires_on || '') : '', 'date') + '</div>' +
      '</div>' +
      '<div class="form-group"><label>Notes</label><textarea id="coi-doc-notes" rows="3" placeholder="Anything about this account worth finding later.">' +
        escHtml(doc ? (doc.notes || '') : '') + '</textarea></div>' +
    '</div>' +
    '<div class="modal-footer"><button class="btn btn-secondary" onclick="coiCloseModal(this)">Cancel</button>' +
      '<button class="btn btn-primary" onclick="coiSaveDoc(this)">Save</button></div>', 560);
}

async function coiSaveDoc(btn) {
  var payload = {
    title: coiVal('coi-doc-title'), kind: coiVal('coi-doc-kind'),
    effective_on: coiVal('coi-doc-eff'), expires_on: coiVal('coi-doc-exp'),
    notes: coiVal('coi-doc-notes')
  };
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    if (_coiDocUpload.docId) {
      await api('PUT', '/account-docs/' + _coiDocUpload.docId, payload);
    } else {
      var input = document.getElementById('coi-doc-file');
      var file = input && input.files && input.files[0];
      if (!file) { showToast('Choose a file first.', 'error'); btn.disabled = false; btn.textContent = 'Save'; return; }
      var res = await api('POST', '/account-docs/account/' + _coiDocUpload.accountId + '/upload-url',
        { name: file.name, mime_type: file.type || 'application/pdf', title: payload.title, kind: payload.kind });
      var put = await fetch(res.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/pdf' } });
      if (!put.ok) throw new Error('Upload failed (' + put.status + ')');
      payload.size_bytes = file.size;
      await api('POST', '/account-docs/' + res.id + '/confirm', payload);
    }
    coiCloseModal(btn);
    showToast('Saved.', 'success');
    await renderCoiAccount(document.getElementById('content'), _coiDocUpload.accountId);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Save';
    showToast(e.message || 'Could not save that document', 'error');
  }
}

async function coiOpenDoc(id) {
  try {
    var res = await api('GET', '/account-docs/' + id + '/download?inline=1');
    window.open(res.url, '_blank', 'noopener');
  } catch (e) { showToast(e.message || 'Could not open that file', 'error'); }
}

async function coiDeleteDoc(id) {
  if (!confirm('Delete this document? The stored file is removed too.')) return;
  try {
    await api('DELETE', '/account-docs/' + id);
    showToast('Deleted.', 'success');
    await renderCoiAccount(document.getElementById('content'), _coiAcct.account.id);
  } catch (e) { showToast(e.message || 'Could not delete that', 'error'); }
}

function coiMismatchList(mm) {
  if (typeof mm === 'string') { try { mm = JSON.parse(mm); } catch (e) { mm = null; } }
  if (!mm || !mm.length) return '';
  return mm.map(function (m) {
    if (m.kind === 'limit') {
      return escHtml(m.label) + ': ' + (m.actual === null ? 'not shown' : coiMoney(m.actual)) +
        ' against ' + coiMoney(m.required) + ' required';
    }
    return escHtml(m.label) + ' is required and is not on the certificate';
  }).join('<br>');
}

function coiField(id, label, value, type) {
  return '<div class="form-group"><label>' + label + '</label>' +
    '<input type="' + (type || 'text') + '" id="' + id + '" value="' + escHtml(value == null ? '' : String(value)) + '" /></div>';
}

function coiCheck(id, label, on) {
  return '<label style="margin:0;display:flex;gap:6px;align-items:center;font-size:13px">' +
    '<input type="checkbox" id="' + id + '" ' + (on ? 'checked' : '') + ' style="width:15px;height:15px;flex:0 0 auto" /> ' + label + '</label>';
}

function coiHolderCard(r, manage) {
  var ai = r.additional_insured;
  if (typeof ai === 'string') { try { ai = JSON.parse(ai); } catch (e) { ai = null; } }
  if (!Array.isArray(ai) || !ai.length) ai = [{ name: '', relationship: '' }];
  return '<div class="card"><div class="card-header"><span class="card-title">Certificate holder</span>' +
      coiCheck('coi-required', 'COI required', r.coi_required !== false) + '</div>' +
    '<div class="card-body">' +
      coiField('coi-holder-name', 'Holder name (verbatim)', r.holder_name) +
      '<div class="form-group"><label>Holder address (verbatim)</label>' +
        '<textarea id="coi-holder-addr" rows="3">' + escHtml(r.holder_address || '') + '</textarea></div>' +
      '<div class="form-group"><label>Additional insured</label><div id="coi-ai-rows">' +
        ai.map(function (row, i) { return coiAiRow(row, i); }).join('') +
      '</div><button class="btn btn-secondary btn-sm" style="margin-top:8px" onclick="coiAddAiRow()">+ Add entity</button></div>' +
      '<div class="form-group"><label>Required wording (verbatim on the certificate)</label>' +
        '<textarea id="coi-wording" rows="3">' + escHtml(r.ai_wording || '') + '</textarea></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:16px">' +
        coiCheck('coi-w-gl', 'Waiver &ndash; GL', r.waiver_gl) +
        coiCheck('coi-w-auto', 'Waiver &ndash; Auto', r.waiver_auto) +
        coiCheck('coi-w-wc', 'Waiver &ndash; WC', r.waiver_wc) +
        coiCheck('coi-pnc', 'Primary &amp; non-contributory', r.primary_noncontrib) +
        coiCheck('coi-wcstat', 'Workers comp (statutory)', r.req_wc_statutory) +
        coiCheck('coi-offcycle', 'Renews on its own date (off-cycle)', r.off_cycle) +
      '</div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-notice', 'Cancellation notice (days)', r.cancel_notice_days, 'number') + '</div>' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-named', 'Named insured', r.named_insured) + '</div>' +
      '</div>' +
      coiField('coi-source', 'Where this requirement came from', r.source_note) +
      (manage ? '' : '<div style="font-size:12px;color:var(--text-muted-color)">Read-only: you do not have the manage COI permission.</div>') +
    '</div></div>';
}

function coiAiRow(row, i) {
  return '<div class="coi-ai-row" style="display:flex;gap:8px;margin-bottom:6px">' +
    '<input type="text" class="coi-ai-name" placeholder="Entity name" value="' + escHtml(row.name || '') + '" style="flex:1" />' +
    '<input type="text" class="coi-ai-rel" placeholder="Relationship" value="' + escHtml(row.relationship || '') + '" style="width:140px" />' +
    '<button class="btn btn-ghost btn-sm" onclick="this.parentNode.remove()">&#x2715;</button></div>';
}

function coiAddAiRow() {
  var box = document.getElementById('coi-ai-rows');
  if (!box) return;
  var div = document.createElement('div');
  div.innerHTML = coiAiRow({}, 0);
  box.appendChild(div.firstChild);
}

function coiLimitsCard(r, manage) {
  var rows = (_coiLimitFields || []).map(function (f) {
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
      '<span style="flex:1;font-size:13px;color:var(--text-dim)">' + escHtml(f.label) + '</span>' +
      '<input type="text" id="coi-req-' + f.key + '" value="' + escHtml(coiMoney(r['req_' + f.key])) + '" ' +
        'style="width:140px;text-align:right;font-family:\'Fira Code\',monospace" /></div>';
  }).join('');
  return '<div class="card" style="margin-bottom:20px"><div class="card-header"><span class="card-title">Required limits</span></div>' +
    '<div class="card-body">' + rows +
    '<div style="font-size:12px;color:var(--text-muted-color);margin-top:10px">Blank means this account does not require that line. Anything set here is what an uploaded certificate is checked against.</div>' +
    '</div></div>';
}

function coiSendCard(r, manage) {
  var m = r.submit_method || 'email';
  return '<div class="card"><div class="card-header"><span class="card-title">Where it goes</span></div><div class="card-body">' +
    '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">' +
      '<div style="flex:1;min-width:150px"><label>Submit method</label><select id="coi-method" onchange="coiMethodChanged()">' +
        '<option value="email"' + (m === 'email' ? ' selected' : '') + '>Email</option>' +
        '<option value="portal"' + (m === 'portal' ? ' selected' : '') + '>Compliance portal</option>' +
        '<option value="mail"' + (m === 'mail' ? ' selected' : '') + '>Mail</option></select></div>' +
      '<div style="flex:1;min-width:170px">' + coiField('coi-emails', 'Send to (comma separated)', r.submit_emails) + '</div>' +
    '</div>' +
    coiField('coi-portal', 'Portal URL', r.submit_portal_url) +
    '<div style="font-size:12px;color:var(--text-muted-color);margin:-8px 0 14px">Portal logins stay on the account record, not here.</div>' +
    '<div class="form-group" style="margin-bottom:0"><label>Notes</label>' +
      '<textarea id="coi-subnotes" rows="2">' + escHtml(r.submit_notes || '') + '</textarea></div>' +
    '</div></div>';
}

function coiMethodChanged() { /* the labels are static; kept so the select has a hook */ }

function coiHistoryCard(accountId, manage) {
  var certs = _coiAcct.certificates || [];
  var body = certs.length === 0
    ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted-color);padding:28px">No certificates stored yet.</td></tr>'
    : certs.map(function (c) {
        var isCurrent = c.id === _coiAcct.current_id;
        var mm = c.mismatch;
        if (typeof mm === 'string') { try { mm = JSON.parse(mm); } catch (e) { mm = null; } }
        var chip = isCurrent
          ? (mm && mm.length ? '<span class="badge badge-rejected">Below requirement</span>' : '<span class="badge badge-approved">Current</span>')
          : '<span class="badge badge-inactive">Superseded</span>';
        return '<tr>' +
          '<td style="color:var(--text);font-weight:500">' + COI_ICON_PDF + ' ' + escHtml(c.file_name) + '</td>' +
          '<td style="font-family:\'Fira Code\',monospace;font-size:13px">' + coiFmtDate(c.effective_on) + '</td>' +
          '<td style="font-family:\'Fira Code\',monospace;font-size:13px">' + coiFmtDate(c.expires_on) + '</td>' +
          '<td>' + chip + '</td>' +
          '<td style="font-size:13px">' + (c.sent_at ? ('Sent ' + coiFmtDate(c.sent_at)) : '<span class="muted">&mdash;</span>') + '</td>' +
          '<td style="white-space:nowrap">' +
            '<button class="btn btn-ghost btn-sm" title="Open" onclick="coiOpenCert(' + c.id + ')">' + COI_ICON_DL + '</button>' +
            (manage ? '<button class="btn btn-ghost btn-sm" title="Email to the account" onclick="coiEmailModal(' + c.id + ')">' + COI_ICON_MAIL + '</button>' : '') +
            (manage ? '<button class="btn btn-ghost btn-sm" title="Edit details" onclick="coiUploadModal(' + accountId + ',' + c.id + ')">Edit</button>' : '') +
            (manage ? '<button class="btn btn-ghost btn-sm" title="Delete" onclick="coiDeleteCert(' + c.id + ')">&#x2715;</button>' : '') +
          '</td></tr>';
      }).join('');
  return '<div class="card" style="margin-top:20px"><div class="card-header"><span class="card-title">Certificate history</span>' +
    (manage && _coiAcct.storage_ready ? '<button class="btn btn-secondary btn-sm" onclick="coiUploadModal(' + accountId + ')">' + COI_ICON_UP + ' Upload certificate</button>' : '') +
    '</div><div class="table-wrap"><table>' +
    '<thead><tr><th>File</th><th>Effective</th><th>Expires</th><th>Status</th><th>Sent to account</th><th></th></tr></thead>' +
    '<tbody>' + body + '</tbody></table></div></div>';
}

function coiCollectRequirements() {
  var ai = [];
  var rows = document.querySelectorAll('#coi-ai-rows .coi-ai-row');
  for (var i = 0; i < rows.length; i++) {
    var name = rows[i].querySelector('.coi-ai-name').value.trim();
    if (!name) continue;
    ai.push({ name: name, relationship: rows[i].querySelector('.coi-ai-rel').value.trim() });
  }
  var payload = {
    coi_required: coiChecked('coi-required'),
    holder_name: coiVal('coi-holder-name'),
    holder_address: coiVal('coi-holder-addr'),
    additional_insured: ai,
    ai_wording: coiVal('coi-wording'),
    waiver_gl: coiChecked('coi-w-gl'),
    waiver_auto: coiChecked('coi-w-auto'),
    waiver_wc: coiChecked('coi-w-wc'),
    primary_noncontrib: coiChecked('coi-pnc'),
    req_wc_statutory: coiChecked('coi-wcstat'),
    off_cycle: coiChecked('coi-offcycle'),
    cancel_notice_days: coiVal('coi-notice'),
    named_insured: coiVal('coi-named'),
    source_note: coiVal('coi-source'),
    submit_method: coiVal('coi-method'),
    submit_emails: coiVal('coi-emails'),
    submit_portal_url: coiVal('coi-portal'),
    submit_notes: coiVal('coi-subnotes')
  };
  (_coiLimitFields || []).forEach(function (f) { payload['req_' + f.key] = coiNum(coiVal('coi-req-' + f.key)); });
  return payload;
}

async function coiSaveRequirements(btn) {
  if (!_coiAcct) return;
  btn.disabled = true;
  try {
    await api('PUT', '/coi/account/' + _coiAcct.account.id, coiCollectRequirements());
    showToast('Requirements saved.', 'success');
    await renderCoiAccount(document.getElementById('content'), _coiAcct.account.id);
  } catch (e) {
    btn.disabled = false;
    showToast(e.message || 'Could not save', 'error');
  }
}

/* ---- upload / edit a certificate ---------------------------------------- */

var _coiUpload = { accountId: null, certId: null, file: null, pendingId: null };

function coiUploadModal(accountId, certId) {
  _coiUpload = { accountId: accountId, certId: certId || null, file: null, pendingId: null };
  var cert = certId ? (_coiAcct.certificates || []).filter(function (c) { return c.id === certId; })[0] : null;
  var r = (_coiAcct && _coiAcct.requirements) || {};
  var limRows = (_coiLimitFields || []).map(function (f) {
    var required = coiMoney(r['req_' + f.key]);
    return '<tr data-key="' + f.key + '">' +
      '<td style="font-size:13px">' + escHtml(f.label) + '</td>' +
      '<td style="text-align:right;font-family:\'Fira Code\',monospace;font-size:13px">' + (required || '<span class="muted">&mdash;</span>') + '</td>' +
      '<td style="text-align:right"><input type="text" id="coi-lim-' + f.key + '" value="' + escHtml(cert ? coiMoney(cert['lim_' + f.key]) : '') + '" ' +
        'oninput="coiPreviewMismatch()" style="width:120px;text-align:right;font-family:\'Fira Code\',monospace" /></td>' +
      '<td style="text-align:center;width:28px" class="coi-mm-mark"></td></tr>';
  }).join('');

  coiModal(
    '<div class="modal-header"><span class="modal-title">' + (cert ? 'Edit certificate' : 'Upload certificate') + '</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="coiCloseModal(this)">&#x2715;</button></div>' +
    '<div class="modal-body" style="max-height:70vh;overflow:auto">' +
      (cert
        ? '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px;font-size:14px;color:var(--text)">' + COI_ICON_PDF + ' ' + escHtml(cert.file_name) + '</div>'
        : '<div class="form-group"><label>Certificate file (PDF)</label>' +
          '<input type="file" id="coi-file" accept="application/pdf,image/*" /></div>') +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
        '<div style="flex:1;min-width:130px"><label>Effective</label><input type="date" id="coi-eff" value="' + escHtml(cert ? (cert.effective_on || '') : '') + '" /></div>' +
        '<div style="flex:1;min-width:130px"><label>Expires</label><input type="date" id="coi-exp" value="' + escHtml(cert ? (cert.expires_on || '') : '') + '" /></div>' +
        '<div style="flex:1.3;min-width:150px"><label>Carrier</label><input type="text" id="coi-carrier" value="' + escHtml(cert ? (cert.carrier || '') : '') + '" /></div>' +
      '</div>' +
      '<div class="form-group"><label>Policy numbers</label><input type="text" id="coi-policies" value="' + escHtml(cert ? (cert.policy_numbers || '') : '') + '" /></div>' +
      '<div style="font-size:12px;font-weight:700;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:.06em;margin:18px 0 8px">Limits on this certificate</div>' +
      '<div id="coi-mm-banner"></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Coverage</th><th style="text-align:right">Required</th>' +
        '<th style="text-align:right">On certificate</th><th></th></tr></thead><tbody>' + limRows + '</tbody></table></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:16px">' +
        coiCheck('coi-has-ai', 'Additional insured shown', cert ? cert.has_ai : false) +
        coiCheck('coi-has-waiver', 'Waiver of subrogation', cert ? cert.has_waiver : false) +
        coiCheck('coi-has-pnc', 'Primary &amp; non-contributory', cert ? cert.has_pnc : false) +
        coiCheck('coi-has-wc', 'Workers comp shown', cert ? cert.has_wc : false) +
      '</div>' +
    '</div>' +
    '<div class="modal-footer"><button class="btn btn-secondary" onclick="coiCloseModal(this)">Cancel</button>' +
      '<button class="btn btn-primary" id="coi-save-cert" onclick="coiSaveCertificate(this)">Save certificate</button></div>', 640);
  coiPreviewMismatch();
  var chk = ['coi-has-ai', 'coi-has-waiver', 'coi-has-pnc', 'coi-has-wc'];
  chk.forEach(function (id) { var e = document.getElementById(id); if (e) e.onchange = coiPreviewMismatch; });
}

// Live required-vs-entered preview. Convenience only: the banner shown on the
// account after saving is the server's own comparison.
function coiPreviewMismatch() {
  var r = (_coiAcct && _coiAcct.requirements) || {};
  var problems = [];
  (_coiLimitFields || []).forEach(function (f) {
    var required = coiNum(r['req_' + f.key]);
    var row = document.querySelector('.modal-overlay tr[data-key="' + f.key + '"]');
    var mark = row ? row.querySelector('.coi-mm-mark') : null;
    if (!mark) return;
    if (required === null) { mark.innerHTML = ''; return; }
    var actual = coiNum(coiVal('coi-lim-' + f.key));
    var ok = actual !== null && actual >= required;
    mark.innerHTML = ok ? '<span style="color:#22c55e;font-weight:700">&#10003;</span>' : '<span style="color:#ef4444;font-weight:700">!</span>';
    if (!ok) problems.push(f.label + ' ' + (actual === null ? 'not shown' : coiMoney(actual)) + ' vs ' + coiMoney(required) + ' required');
  });
  var reqAi = r.additional_insured;
  if (typeof reqAi === 'string') { try { reqAi = JSON.parse(reqAi); } catch (e) { reqAi = null; } }
  var wantsAi = !!((reqAi && reqAi.length) || (r.ai_wording || '').trim());
  if (wantsAi && !coiChecked('coi-has-ai')) problems.push('Additional insured is required and is not ticked');
  if ((r.waiver_gl || r.waiver_auto || r.waiver_wc) && !coiChecked('coi-has-waiver')) problems.push('Waiver of subrogation is required and is not ticked');
  if (r.primary_noncontrib && !coiChecked('coi-has-pnc')) problems.push('Primary & non-contributory is required and is not ticked');
  if (r.req_wc_statutory && !coiChecked('coi-has-wc')) problems.push('Workers comp is required and is not ticked');

  var banner = document.getElementById('coi-mm-banner');
  if (!banner) return;
  banner.innerHTML = problems.length
    ? '<div class="alert alert-error"><strong>This certificate does not meet what ' + escHtml(_coiAcct.account.name) + ' requires.</strong><br>' +
      problems.map(escHtml).join('<br>') +
      '<br><span style="opacity:.85">It will still be saved. The account is flagged so you can go back to the agent.</span></div>'
    : '';
}

function coiCertPayload() {
  var payload = {
    effective_on: coiVal('coi-eff'),
    expires_on: coiVal('coi-exp'),
    carrier: coiVal('coi-carrier'),
    policy_numbers: coiVal('coi-policies'),
    has_ai: coiChecked('coi-has-ai'),
    has_waiver: coiChecked('coi-has-waiver'),
    has_pnc: coiChecked('coi-has-pnc'),
    has_wc: coiChecked('coi-has-wc')
  };
  (_coiLimitFields || []).forEach(function (f) { payload['lim_' + f.key] = coiNum(coiVal('coi-lim-' + f.key)); });
  return payload;
}

async function coiSaveCertificate(btn) {
  var payload = coiCertPayload();
  if (!payload.expires_on) { showToast('Enter the expiration date.', 'error'); return; }
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    if (_coiUpload.certId) {
      await api('PUT', '/coi/certificates/' + _coiUpload.certId, payload);
    } else {
      var input = document.getElementById('coi-file');
      var file = input && input.files && input.files[0];
      if (!file) { showToast('Choose the certificate file first.', 'error'); btn.disabled = false; btn.textContent = 'Save certificate'; return; }
      var res = await api('POST', '/coi/account/' + _coiUpload.accountId + '/upload-url',
        { name: file.name, mime_type: file.type || 'application/pdf' });
      // Straight to R2 with the presigned URL - the bytes never touch Nova.
      var put = await fetch(res.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/pdf' } });
      if (!put.ok) throw new Error('Upload failed (' + put.status + ')');
      payload.size_bytes = file.size;
      await api('POST', '/coi/certificates/' + res.id + '/confirm', payload);
    }
    coiCloseModal(btn);
    showToast('Certificate saved.', 'success');
    await renderCoiAccount(document.getElementById('content'), _coiUpload.accountId);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Save certificate';
    showToast(e.message || 'Could not save the certificate', 'error');
  }
}

async function coiOpenCert(id) {
  try {
    var res = await api('GET', '/coi/certificates/' + id + '/download?inline=1');
    window.open(res.url, '_blank', 'noopener');
  } catch (e) { showToast(e.message || 'Could not open that file', 'error'); }
}

async function coiDeleteCert(id) {
  if (!confirm('Delete this certificate? The stored file is removed too.')) return;
  try {
    await api('DELETE', '/coi/certificates/' + id);
    showToast('Certificate deleted.', 'success');
    await renderCoiAccount(document.getElementById('content'), _coiAcct.account.id);
  } catch (e) { showToast(e.message || 'Could not delete that', 'error'); }
}

function coiEmailModal(certId) {
  var r = (_coiAcct && _coiAcct.requirements) || {};
  if ((r.submit_method || 'email') === 'portal') {
    coiModal(
      '<div class="modal-header"><span class="modal-title">Submit through the portal</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="coiCloseModal(this)">&#x2715;</button></div>' +
      '<div class="modal-body"><p style="font-size:14px;color:var(--text-dim);line-height:1.6">' +
        'This account takes certificates through a compliance portal, so the upload has to be done by hand.' +
        (r.submit_portal_url ? ('<br><br><a href="' + escHtml(r.submit_portal_url) + '" target="_blank" rel="noopener" style="color:var(--primary)">' + escHtml(r.submit_portal_url) + '</a>') : '') +
        (r.submit_notes ? ('<br><br>' + escHtml(r.submit_notes)) : '') +
        '<br><br>The account login lives on the account record, under Accounts.</p></div>' +
      '<div class="modal-footer"><button class="btn btn-secondary" onclick="coiCloseModal(this)">Close</button>' +
        '<button class="btn btn-primary" onclick="coiMarkSubmitted(' + certId + ', this)">Mark as submitted</button></div>');
    return;
  }
  coiModal(
    '<div class="modal-header"><span class="modal-title">Email the certificate</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="coiCloseModal(this)">&#x2715;</button></div>' +
    '<div class="modal-body">' +
      coiField('coi-email-to', 'To (comma separated)', r.submit_emails) +
      '<div class="form-group"><label>Message (optional)</label><textarea id="coi-email-msg" rows="3"></textarea></div>' +
      '<div style="font-size:12px;color:var(--text-muted-color)">The certificate is attached automatically and a copy goes to you.</div></div>' +
    '<div class="modal-footer"><button class="btn btn-secondary" onclick="coiCloseModal(this)">Cancel</button>' +
      '<button class="btn btn-primary" onclick="coiSendCert(' + certId + ', this)">Send</button></div>');
}

async function coiSendCert(certId, btn) {
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    var res = await api('POST', '/coi/certificates/' + certId + '/email',
      { to: coiVal('coi-email-to'), message: coiVal('coi-email-msg') });
    coiCloseModal(btn);
    showToast('Sent to ' + res.sent_to, 'success');
    await renderCoiAccount(document.getElementById('content'), _coiAcct.account.id);
  } catch (e) { btn.disabled = false; btn.textContent = 'Send'; showToast(e.message || 'Could not send', 'error'); }
}

// A portal submission has no email to record, so this just stamps the send.
async function coiMarkSubmitted(certId, btn) {
  btn.disabled = true;
  try {
    await api('POST', '/coi/certificates/' + certId + '/mark-submitted', {});
    coiCloseModal(btn);
    showToast('Marked as submitted.', 'success');
    await renderCoiAccount(document.getElementById('content'), _coiAcct.account.id);
  } catch (e) { btn.disabled = false; showToast(e.message || 'Could not update', 'error'); }
}

/* ---- policy details ------------------------------------------------------ */

function coiPolicyModal() {
  var p = (_coiData && _coiData.policy) || {};
  coiModal(
    '<div class="modal-header"><span class="modal-title">Our policy &amp; agent</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="coiCloseModal(this)">&#x2715;</button></div>' +
    '<div class="modal-body" style="max-height:70vh;overflow:auto">' +
      coiField('coi-p-named', 'Named insured', p.named_insured || 'Lock and Roll LLC') +
      '<div class="form-group"><label>Address</label><textarea id="coi-p-addr" rows="2">' + escHtml(p.address || '') + '</textarea></div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-p-eff', 'Policy effective', p.policy_effective, 'date') + '</div>' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-p-exp', 'Policy expires', p.policy_expires, 'date') + '</div>' +
      '</div>' +
      coiField('coi-p-carrier', 'Carrier', p.carrier) +
      '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-p-agency', 'Agency', p.agency) + '</div>' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-p-agent', 'Agent name', p.agent_name) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-p-email', 'Agent email', p.agent_email) + '</div>' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-p-phone', 'Agent phone', p.agent_phone) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:130px">' + coiField('coi-p-gl', 'GL policy #', p.policy_gl) + '</div>' +
        '<div style="flex:1;min-width:130px">' + coiField('coi-p-auto', 'Auto policy #', p.policy_auto) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:130px">' + coiField('coi-p-umb', 'Umbrella policy #', p.policy_umbrella) + '</div>' +
        '<div style="flex:1;min-width:130px">' + coiField('coi-p-wc', 'WC policy #', p.policy_wc) + '</div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color)">This is what the packet cover page tells the agent, and what the renewal reminder counts down to.</div>' +
    '</div>' +
    '<div class="modal-footer"><button class="btn btn-secondary" onclick="coiCloseModal(this)">Cancel</button>' +
      '<button class="btn btn-primary" onclick="coiSavePolicy(this)">Save</button></div>', 560);
}

async function coiSavePolicy(btn) {
  btn.disabled = true;
  try {
    await api('PUT', '/coi/policy', {
      named_insured: coiVal('coi-p-named'), address: coiVal('coi-p-addr'),
      policy_effective: coiVal('coi-p-eff'), policy_expires: coiVal('coi-p-exp'),
      carrier: coiVal('coi-p-carrier'), agency: coiVal('coi-p-agency'),
      agent_name: coiVal('coi-p-agent'), agent_email: coiVal('coi-p-email'),
      agent_phone: coiVal('coi-p-phone'), policy_gl: coiVal('coi-p-gl'),
      policy_auto: coiVal('coi-p-auto'), policy_umbrella: coiVal('coi-p-umb'),
      policy_wc: coiVal('coi-p-wc')
    });
    coiCloseModal(btn);
    showToast('Policy saved.', 'success');
    await renderCoi(document.getElementById('content'));
  } catch (e) { btn.disabled = false; showToast(e.message || 'Could not save', 'error'); }
}

/* ---- renewal cycle ------------------------------------------------------- */

function coiStartCycleModal() {
  var p = (_coiData && _coiData.policy) || {};
  var year = new Date().getFullYear();
  coiModal(
    '<div class="modal-header"><span class="modal-title">Start a renewal cycle</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="coiCloseModal(this)">&#x2715;</button></div>' +
    '<div class="modal-body">' +
      coiField('coi-cy-name', 'Name', year + '–' + (year + 1) + ' Renewal') +
      '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-cy-eff', 'Policy effective', p.policy_effective, 'date') + '</div>' +
        '<div style="flex:1;min-width:150px">' + coiField('coi-cy-exp', 'Policy expires', p.policy_expires, 'date') + '</div>' +
      '</div>' +
      '<div style="font-size:13px;color:var(--text-muted-color);line-height:1.6">Every account that requires a certificate is copied onto the checklist as it stands right now. Accounts marked off-cycle are listed separately and are not part of the batch.</div>' +
    '</div>' +
    '<div class="modal-footer"><button class="btn btn-secondary" onclick="coiCloseModal(this)">Cancel</button>' +
      '<button class="btn btn-primary" onclick="coiCreateCycle(this)">Start cycle</button></div>');
}

async function coiCreateCycle(btn) {
  btn.disabled = true;
  try {
    var res = await api('POST', '/coi/cycles', {
      name: coiVal('coi-cy-name'), policy_effective: coiVal('coi-cy-eff'), policy_expires: coiVal('coi-cy-exp')
    });
    coiCloseModal(btn);
    showToast(res.accounts + ' account' + (res.accounts === 1 ? '' : 's') + ' on the checklist.', 'success');
    navigate('coi-cycle', res.cycle.id);
  } catch (e) { btn.disabled = false; showToast(e.message || 'Could not start the cycle', 'error'); }
}

var COI_ITEM_LABEL = { needed: 'Not started', requested: 'Requested', received: 'Received from agent',
  sent: 'Sent to account', confirmed: 'Confirmed', waived: 'Waived' };
var COI_ITEM_CLASS = { needed: 'badge-inactive', requested: 'badge-submitted', received: 'badge-order-placed',
  sent: 'badge-active', confirmed: 'badge-approved', waived: 'badge-inactive' };
var COI_ITEM_COLOR = { needed: '#3a3a3a', requested: '#f59e0b', received: '#a78bfa',
  sent: '#60a5fa', confirmed: '#22c55e', waived: '#555' };
var COI_ITEM_ORDER = ['confirmed', 'sent', 'received', 'requested', 'needed', 'waived'];

async function renderCoiCycle(el, cycleId) {
  var id = parseInt(cycleId, 10);
  el.innerHTML = '<div class="page-header"><div><div class="page-title">Loading&hellip;</div></div></div>';
  try { _coiCycle = await api('GET', '/coi/cycles/' + id); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">Could not load that cycle: ' + escHtml(e.message || 'error') + '</div>'; return; }

  var cy = _coiCycle.cycle;
  var items = _coiCycle.items || [];
  var manage = _coiCycle.can_manage;
  var counts = {};
  COI_ITEM_ORDER.forEach(function (k) { counts[k] = 0; });
  items.forEach(function (i) { counts[i.status] = (counts[i.status] || 0) + 1; });
  var total = items.length || 1;
  var waiting = (counts.requested || 0) + (counts.needed || 0);

  var bar = COI_ITEM_ORDER.map(function (k) {
    if (!counts[k]) return '';
    return '<div style="width:' + ((counts[k] / total) * 100).toFixed(2) + '%;background:' + COI_ITEM_COLOR[k] + '"></div>';
  }).join('');
  var legend = COI_ITEM_ORDER.filter(function (k) { return counts[k]; }).map(function (k) {
    return '<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + COI_ITEM_COLOR[k] + ';margin-right:5px"></span>' +
      COI_ITEM_LABEL[k] + ' ' + counts[k] + '</span>';
  }).join('');

  el.innerHTML =
    '<div class="page-header"><div>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:4px;cursor:pointer" onclick="navigate(\'coi\')">&larr; Certificates of Insurance</div>' +
      '<div class="page-title">' + escHtml(cy.name) + '</div>' +
      '<div class="page-subtitle">Policy ' + coiFmtDate(cy.policy_effective) + ' &ndash; ' + coiFmtDate(cy.policy_expires) +
        ' &middot; opened ' + coiFmtDate(cy.created_at) + (cy.created_by_name ? (' by ' + escHtml(cy.created_by_name)) : '') +
        (cy.status === 'closed' ? ' &middot; CLOSED' : '') + '</div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-secondary" onclick="coiOpenPacket(' + cy.id + ')">' + COI_ICON_PDF + ' Download agent packet</button>' +
        (manage ? '<button class="btn btn-secondary" onclick="coiEmailPacketModal(' + cy.id + ')">' + COI_ICON_MAIL + ' Email packet to agent</button>' : '') +
        (manage && cy.status === 'open' ? '<button class="btn btn-primary" onclick="coiCloseCycle(' + cy.id + ')">Close cycle</button>' : '') +
      '</div></div>' +
    '<div class="card" style="margin-bottom:20px"><div class="card-body" style="padding:18px 20px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;flex-wrap:wrap">' +
        '<div style="font-size:14px;font-weight:600">' + (counts.confirmed || 0) + ' of ' + items.length + ' confirmed' +
          (waiting ? (' &middot; ' + waiting + ' still waiting on the agent') : '') + '</div>' +
        '<div style="font-size:13px;color:var(--text-muted-color);font-family:\'Fira Code\',monospace">' +
          (cy.packet_generated_at ? ('packet generated ' + coiFmtDate(cy.packet_generated_at)) : 'packet not generated yet') + '</div></div>' +
      '<div style="height:10px;border-radius:6px;background:#2a2a2a;overflow:hidden;display:flex">' + bar + '</div>' +
      '<div style="display:flex;gap:18px;margin-top:10px;font-size:12px;color:var(--text-muted-color);flex-wrap:wrap">' + legend + '</div>' +
      (manage && cy.status === 'open' && counts.needed
        ? '<div style="margin-top:14px"><button class="btn btn-secondary btn-sm" onclick="coiMarkAllRequested(' + cy.id + ')">Mark all ' + counts.needed + ' as requested</button></div>'
        : '') +
    '</div></div>' +
    '<div class="card"><div class="card-header"><span class="card-title">Checklist</span></div><div class="table-wrap"><table>' +
      '<thead><tr><th>Account</th><th>Status</th><th>Last activity</th><th>Sends via</th><th>Next step</th></tr></thead><tbody>' +
      (items.length === 0
        ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted-color);padding:28px">No accounts on this cycle.</td></tr>'
        : items.map(function (i) { return coiItemRow(cy, i, manage); }).join('')) +
      '</tbody></table></div></div>' +
    coiOffCycleCard();
}

function coiItemRow(cy, i, manage) {
  var next = { needed: ['requested', 'Mark requested'], requested: ['received', 'Mark received'],
    received: ['sent', 'Mark sent'], sent: ['confirmed', 'Mark confirmed'] }[i.status];
  var last = i.confirmed_at || i.sent_at || i.requested_at || i.updated_at;
  var method = i.submit_method === 'portal' ? 'Portal' : (i.submit_method === 'mail' ? 'Mail' : 'Email');
  var action = '<span class="muted" style="font-size:13px">Done</span>';
  if (manage && cy.status === 'open' && next) {
    action = '<button class="btn btn-secondary btn-sm" onclick="coiSetItem(' + cy.id + ',' + i.id + ',\'' + next[0] + '\')">' + next[1] + '</button>';
    if (i.status === 'received' && i.submit_method !== 'portal') {
      action = '<button class="btn btn-secondary btn-sm" onclick="navigate(\'coi-account\',' + i.account_id + ')">Open to send</button>';
    }
    if (i.status === 'requested') {
      action = '<button class="btn btn-secondary btn-sm" onclick="navigate(\'coi-account\',' + i.account_id + ')">Upload certificate</button>';
    }
  }
  return '<tr>' +
    '<td style="font-weight:600;color:var(--text);cursor:pointer" onclick="navigate(\'coi-account\',' + i.account_id + ')">' + escHtml(i.account_name) + '</td>' +
    '<td><span class="badge ' + (COI_ITEM_CLASS[i.status] || 'badge-inactive') + '">' + (COI_ITEM_LABEL[i.status] || i.status) + '</span></td>' +
    '<td style="font-family:\'Fira Code\',monospace;font-size:13px">' + coiFmtDate(last) + '</td>' +
    '<td style="font-size:13px">' + method + '</td>' +
    '<td style="white-space:nowrap">' + action + '</td></tr>';
}

function coiOffCycleCard() {
  var off = (_coiCycle && _coiCycle.off_cycle) || [];
  if (!off.length) return '';
  return '<div class="card" style="margin-top:20px"><div class="card-header"><span class="card-title">Off-cycle accounts</span>' +
    '<span style="font-size:12px;color:var(--text-muted-color)">Renew on their own contract date &middot; not counted above</span></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Account</th><th>Expires</th><th></th></tr></thead><tbody>' +
    off.map(function (a) {
      return '<tr><td style="font-weight:600;color:var(--text)">' + escHtml(a.account_name) + '</td>' +
        '<td style="font-family:\'Fira Code\',monospace;font-size:13px">' + coiFmtDate(a.expires_on) + '</td>' +
        '<td><button class="btn btn-secondary btn-sm" onclick="navigate(\'coi-account\',' + a.account_id + ')">Open</button></td></tr>';
    }).join('') + '</tbody></table></div></div>';
}

async function coiSetItem(cycleId, itemId, status) {
  try {
    await api('PUT', '/coi/cycles/' + cycleId + '/items/' + itemId, { status: status });
    await renderCoiCycle(document.getElementById('content'), cycleId);
  } catch (e) { showToast(e.message || 'Could not update', 'error'); }
}

async function coiMarkAllRequested(cycleId) {
  try {
    var res = await api('POST', '/coi/cycles/' + cycleId + '/mark-requested', {});
    showToast(res.updated + ' marked as requested.', 'success');
    await renderCoiCycle(document.getElementById('content'), cycleId);
  } catch (e) { showToast(e.message || 'Could not update', 'error'); }
}

async function coiCloseCycle(cycleId) {
  if (!confirm('Close this renewal cycle? The checklist stays readable as history.')) return;
  try {
    await api('POST', '/coi/cycles/' + cycleId + '/close', {});
    showToast('Cycle closed.', 'success');
    await renderCoiCycle(document.getElementById('content'), cycleId);
  } catch (e) { showToast(e.message || 'Could not close the cycle', 'error'); }
}

async function coiOpenPacket(cycleId) {
  showToast('Building the packet…', 'info');
  try {
    var res = await api('GET', '/coi/cycles/' + cycleId + '/packet');
    invDownloadBase64(res.data, res.mime || 'application/pdf', res.filename || 'COI-request-packet.pdf');
    await renderCoiCycle(document.getElementById('content'), cycleId);
  } catch (e) { showToast(e.message || 'Could not build the packet', 'error'); }
}

function coiEmailPacketModal(cycleId) {
  var p = (_coiCycle && _coiCycle.policy) || {};
  coiModal(
    '<div class="modal-header"><span class="modal-title">Email the packet to the agent</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="coiCloseModal(this)">&#x2715;</button></div>' +
    '<div class="modal-body">' +
      coiField('coi-pk-to', 'To', p.agent_email) +
      '<div class="form-group"><label>Message (optional)</label><textarea id="coi-pk-msg" rows="3"></textarea></div>' +
      '<div style="font-size:12px;color:var(--text-muted-color)">The packet PDF is generated fresh and attached.</div></div>' +
    '<div class="modal-footer"><button class="btn btn-secondary" onclick="coiCloseModal(this)">Cancel</button>' +
      '<button class="btn btn-primary" onclick="coiSendPacket(' + cycleId + ', this)">Send</button></div>');
}

async function coiSendPacket(cycleId, btn) {
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    var res = await api('POST', '/coi/cycles/' + cycleId + '/email-packet',
      { to: coiVal('coi-pk-to'), message: coiVal('coi-pk-msg') });
    coiCloseModal(btn);
    showToast('Packet sent to ' + res.sent_to, 'success');
    await renderCoiCycle(document.getElementById('content'), cycleId);
  } catch (e) { btn.disabled = false; btn.textContent = 'Send'; showToast(e.message || 'Could not send the packet', 'error'); }
}
