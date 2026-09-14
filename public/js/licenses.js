// Licensing & compliance, and the register that hangs off both it and Accounts.
//
// Two things live in this file because they shipped together and one of them is
// shared:
//
//   1. openLedger(type, id, name)  -- the register popup. Opened from the
//      Accounts table AND from the Licensing table. Same rows, same totals,
//      same editor; only the subject differs, and the server decides what this
//      user may do with it (routes/ledger.js).
//   2. renderLicenses()            -- the Licensing & Compliance screen, built
//      to read like Accounts because it is the same job: a thing with a portal
//      login, a number, and a renewal you must not miss.
//
// Ships dark behind view_licenses / manage_licenses. The Ledger button on the
// Accounts table is NOT dark -- it rides on view_vendors / manage_vendors,
// which Accounts already has.
//
// House style: string concatenation only, no template literals; &#39; for an
// apostrophe inside an HTML string (CLAUDE.md 1.2).

// ── Shared: the ledger ───────────────────────────────────────────────────────

var _ledger = { type: null, id: null, name: '', data: null, editing: null, draft: null };

var LEDGER_KIND_LABELS = {
  payment: 'Payment', filing: 'Filing', renewal: 'Renewal',
  credit: 'Credit', refund: 'Refund', note: 'Note'
};
var LEDGER_METHOD_LABELS = {
  card: 'Card', ach: 'ACH', check: 'Check', cash: 'Cash',
  online: 'Online', auto_draft: 'Auto-draft', other: 'Other'
};
// Credits and refunds come back OUT, so they read as negative on the register
// even though the column stores a positive number. The server totals them the
// same way (routes/ledger.js totalsOf), so the rows and the header agree.
var LEDGER_NEGATIVE = { credit: 1, refund: 1 };

function ledgerMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  var v = parseFloat(n);
  if (!isFinite(v)) return '';
  return '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ledgerToday() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// type is 'account' or 'license'; the server maps that to the right column and
// to the right permission, so nothing here needs to know which is which.
async function openLedger(type, id, name) {
  _ledger = { type: type, id: id, name: name || '', data: null, editing: null, draft: null };
  var overlay = document.getElementById('ledger-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'ledger-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = '<div class="modal" style="max-width:820px"><div class="modal-body" style="padding:32px;text-align:center;color:var(--text-muted-color)">Loading the register…</div></div>';
  try {
    _ledger.data = await api('GET', '/ledger/' + type + '/' + id);
  } catch (e) {
    overlay.innerHTML = '<div class="modal" style="max-width:520px">' +
      '<div class="modal-header"><span class="modal-title">Register</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="closeLedger()">&#x2715;</button></div>' +
      '<div class="modal-body"><div class="alert alert-error">' + escHtml(e.message || 'Could not open the register.') + '</div></div>' +
      '<div class="modal-footer"><button class="btn btn-secondary" onclick="closeLedger()">Close</button></div></div>';
    return;
  }
  ledgerRender();
}

function closeLedger() {
  var o = document.getElementById('ledger-overlay');
  if (o) o.remove();
  _ledger = { type: null, id: null, name: '', data: null, editing: null, draft: null };
}

function ledgerRender() {
  var o = document.getElementById('ledger-overlay');
  if (!o || !_ledger.data) return;
  var d = _ledger.data;
  var canManage = !!d.can_manage;
  var t = d.totals || { paid: 0, credited: 0, net: 0 };
  var subjectName = (d.subject && d.subject.name) || _ledger.name;

  var head =
    '<div class="modal-header">' +
      '<span class="modal-title">Register &mdash; ' + escHtml(subjectName) + '</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="closeLedger()">&#x2715;</button>' +
    '</div>';

  // The three numbers anyone opening this actually came for.
  var totals =
    '<div style="display:flex;gap:18px;flex-wrap:wrap;padding:12px 14px;margin-bottom:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface-color)">' +
      '<div><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted-color)">Paid</div>' +
        '<div style="font-size:18px;font-weight:700">' + (ledgerMoney(t.paid) || '$0.00') + '</div></div>' +
      (t.credited ? '<div><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted-color)">Credited back</div>' +
        '<div style="font-size:18px;font-weight:700;color:var(--success,#22c55e)">' + ledgerMoney(t.credited) + '</div></div>' : '') +
      (t.credited ? '<div><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted-color)">Net</div>' +
        '<div style="font-size:18px;font-weight:700">' + (ledgerMoney(t.net) || '$0.00') + '</div></div>' : '') +
      '<div><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted-color)">Entries</div>' +
        '<div style="font-size:18px;font-weight:700">' + (d.entries || []).length + '</div></div>' +
    '</div>';

  var rows = (d.entries || []).map(function (e) {
    var neg = LEDGER_NEGATIVE[e.kind];
    var amt = ledgerMoney(e.amount);
    return '<tr>' +
      '<td style="white-space:nowrap">' + escHtml(formatDate(e.entry_date)) + '</td>' +
      '<td style="white-space:nowrap"><span class="badge badge-inactive">' + escHtml(LEDGER_KIND_LABELS[e.kind] || e.kind) + '</span></td>' +
      '<td style="text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:600' +
        (neg ? ';color:var(--success,#22c55e)' : '') + '">' +
        (amt ? ((neg ? '-' : '') + amt) : '<span style="color:var(--text-muted-color);font-weight:400">&mdash;</span>') + '</td>' +
      '<td>' + escHtml(e.reason || '') +
        (e.notes ? '<div style="font-size:12px;color:var(--text-muted-color);white-space:pre-wrap;margin-top:2px">' + escHtml(e.notes) + '</div>' : '') + '</td>' +
      '<td style="white-space:nowrap;font-size:12px;color:var(--text-muted-color)">' +
        escHtml(e.period_label || '') +
        (e.method ? '<div>' + escHtml(LEDGER_METHOD_LABELS[e.method] || e.method) + '</div>' : '') +
        (e.reference ? '<div style="font-family:monospace">' + escHtml(e.reference) + '</div>' : '') + '</td>' +
      '<td style="white-space:nowrap;font-size:12px;color:var(--text-muted-color)">' + escHtml(e.created_by_name || '') + '</td>' +
      (canManage
        ? '<td style="white-space:nowrap">' +
            '<button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:12px" onclick="ledgerEdit(' + e.id + ')">Edit</button>' +
            '<button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:12px;color:var(--danger,#ef4444)" onclick="ledgerDelete(' + e.id + ')">Delete</button>' +
          '</td>'
        : '') +
    '</tr>';
  }).join('');

  var table =
    '<div class="table-wrap" style="max-height:340px;overflow:auto">' +
      '<table><thead><tr><th>Date</th><th>Type</th><th style="text-align:right">Amount</th>' +
        '<th>What for</th><th>Details</th><th>By</th>' + (canManage ? '<th></th>' : '') + '</tr></thead>' +
      '<tbody>' + (rows || ('<tr><td colspan="' + (canManage ? 7 : 6) + '" style="text-align:center;color:var(--text-muted-color);padding:28px">' +
        'Nothing recorded yet.' + (canManage ? ' Add the first entry below.' : '') + '</td></tr>')) + '</tbody></table>' +
    '</div>';

  var editor = canManage ? ledgerEditorHtml() : '';

  o.innerHTML = '<div class="modal" style="max-width:880px">' + head +
    '<div class="modal-body"><div id="ledger-msg"></div>' + totals + table + editor + '</div>' +
    '<div class="modal-footer"><button class="btn btn-secondary" onclick="closeLedger()">Close</button></div></div>';
}

function ledgerEditorHtml() {
  var d = _ledger.draft || {};
  var isEdit = _ledger.editing !== null && _ledger.editing !== undefined;
  var kinds = (_ledger.data && _ledger.data.kinds) || ['payment'];
  var methods = (_ledger.data && _ledger.data.methods) || [];
  if (!_ledger.draft) {
    return '<div style="margin-top:16px;text-align:right">' +
      '<button class="btn btn-primary" onclick="ledgerNew()">+ Add entry</button></div>';
  }
  return '<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">' +
      (isEdit ? 'Edit entry' : 'New entry') + '</div>' +
    '<div class="form-row">' +
      '<div class="form-group"><label>Date *</label><input type="date" id="lg-date" value="' + escHtml(d.entry_date || ledgerToday()) + '" /></div>' +
      '<div class="form-group"><label>Type</label><select id="lg-kind">' +
        kinds.map(function (k) {
          return '<option value="' + escHtml(k) + '"' + (d.kind === k ? ' selected' : '') + '>' + escHtml(LEDGER_KIND_LABELS[k] || k) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="form-group"><label>Amount</label><input type="text" id="lg-amount" inputmode="decimal" value="' + escHtml(d.amount === null || d.amount === undefined ? '' : String(d.amount)) + '" placeholder="340.00" /></div>' +
    '</div>' +
    '<div class="form-group"><label>What for</label><input type="text" id="lg-reason" value="' + escHtml(d.reason || '') + '" placeholder="e.g. 2026 occupational tax" /></div>' +
    '<div class="form-row">' +
      '<div class="form-group"><label>Period</label><input type="text" id="lg-period" value="' + escHtml(d.period_label || '') + '" placeholder="2026 / Q1 2026" /></div>' +
      '<div class="form-group"><label>Method</label><select id="lg-method"><option value="">&mdash;</option>' +
        methods.map(function (m) {
          return '<option value="' + escHtml(m) + '"' + (d.method === m ? ' selected' : '') + '>' + escHtml(LEDGER_METHOD_LABELS[m] || m) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="form-group"><label>Confirmation #</label><input type="text" id="lg-reference" value="' + escHtml(d.reference || '') + '" placeholder="Check or confirmation" /></div>' +
    '</div>' +
    '<div class="form-group"><label>Notes</label><textarea id="lg-notes" rows="2" placeholder="Anything the next person will need">' + escHtml(d.notes || '') + '</textarea></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="btn btn-secondary" onclick="ledgerCancelEdit()">Cancel</button>' +
      '<button class="btn btn-primary" onclick="ledgerSave()">' + (isEdit ? 'Save changes' : 'Add entry') + '</button>' +
    '</div></div>';
}

function ledgerNew() {
  _ledger.editing = null;
  _ledger.draft = { entry_date: ledgerToday(), kind: 'payment', amount: '', reason: '', period_label: '', method: '', reference: '', notes: '' };
  ledgerRender();
}

function ledgerEdit(id) {
  var e = ((_ledger.data || {}).entries || []).filter(function (x) { return x.id === id; })[0];
  if (!e) return;
  _ledger.editing = id;
  _ledger.draft = Object.assign({}, e);
  ledgerRender();
}

function ledgerCancelEdit() {
  _ledger.editing = null;
  _ledger.draft = null;
  ledgerRender();
}

function ledgerCollect() {
  function v(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  return {
    entry_date: v('lg-date'),
    kind: v('lg-kind'),
    amount: v('lg-amount').trim() === '' ? null : v('lg-amount'),
    reason: v('lg-reason').trim() || null,
    period_label: v('lg-period').trim() || null,
    method: v('lg-method') || null,
    reference: v('lg-reference').trim() || null,
    notes: v('lg-notes').trim() || null
  };
}

async function ledgerSave() {
  var payload = ledgerCollect();
  var msg = document.getElementById('ledger-msg');
  if (!payload.entry_date) {
    if (msg) msg.innerHTML = '<div class="alert alert-error">Pick a date.</div>';
    return;
  }
  try {
    if (_ledger.editing) await api('PUT', '/ledger/entry/' + _ledger.editing, payload);
    else await api('POST', '/ledger/' + _ledger.type + '/' + _ledger.id, payload);
    _ledger.editing = null;
    _ledger.draft = null;
    _ledger.data = await api('GET', '/ledger/' + _ledger.type + '/' + _ledger.id);
    ledgerRender();
    // The Licensing table shows each row&#39;s total and last-paid date, so it
    // is stale the moment an entry lands. Accounts does not, so it is left be.
    if (_ledger.type === 'license' && state.currentView === 'licenses') {
      _licensesData = null;
      renderLicenses(document.getElementById('content'));
    }
  } catch (err) {
    if (msg) msg.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>';
  }
}

async function ledgerDelete(id) {
  if (!await novaConfirm('Delete this entry? The record of what was paid goes with it.')) return;
  try {
    await api('DELETE', '/ledger/entry/' + id);
    _ledger.data = await api('GET', '/ledger/' + _ledger.type + '/' + _ledger.id);
    ledgerRender();
    if (_ledger.type === 'license' && state.currentView === 'licenses') {
      _licensesData = null;
      renderLicenses(document.getElementById('content'));
    }
  } catch (err) {
    var msg = document.getElementById('ledger-msg');
    if (msg) msg.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>';
  }
}

// ── Licensing & Compliance ───────────────────────────────────────────────────

var _licensesData = null;
var _licensesCanManage = false;
var _licenseCities = [];
var _licenseUsers = [];
var _licenseSearch = '';

var LICENSE_KIND_LABELS = {
  business_license: 'Business licence',
  occupational_tax: 'Occupational tax',
  sales_tax: 'Sales tax',
  contractor: 'Contractor',
  alarm: 'Alarm / locksmith',
  franchise: 'Franchise',
  vehicle: 'Vehicle / DOT',
  insurance: 'Insurance',
  other: 'Other'
};
var LICENSE_INTERVAL_LABELS = {
  annual: 'Annually', biennial: 'Every 2 years', quarterly: 'Quarterly',
  monthly: 'Monthly', none: 'Does not renew'
};
// Same pill classes the Accounts COI column uses, so the two compliance
// surfaces look like one thing rather than two.
var LICENSE_STATUS_CLASS = { green: 'badge-approved', amber: 'badge-submitted', red: 'badge-rejected', grey: 'badge-inactive' };

async function renderLicenses(el) {
  if (!can('view_licenses') && !can('manage_licenses')) {
    el.innerHTML = '<div class="alert alert-error">Access denied.</div>';
    return;
  }
  try {
    var res = await api('GET', '/licenses');
    _licensesData = res.licenses || [];
    _licensesCanManage = !!res.can_manage;
  } catch (e) {
    _licensesData = [];
    _licensesCanManage = false;
  }
  try { _licenseCities = await api('GET', '/cities'); } catch (e) { _licenseCities = []; }
  if (_licensesCanManage) {
    try { _licenseUsers = await api('GET', '/licenses/pickable-users'); } catch (e) { _licenseUsers = []; }
  } else { _licenseUsers = []; }

  el.innerHTML =
    '<div class="page-header"><div><div class="page-title">Licensing &amp; Compliance</div>' +
      '<div class="page-subtitle">Licences, registrations and the taxes that keep each territory open</div></div>' +
      (_licensesCanManage ? '<button class="btn btn-primary" onclick="showLicenseModal()">+ Add Licence</button>' : '') + '</div>' +
    '<div id="license-msg"></div>' + licenseRenewalBanner() +
    '<div style="margin-bottom:16px"><input type="text" id="licenses-search" placeholder="Search by name, authority, number or jurisdiction..." value="' + escHtml(_licenseSearch) + '" style="width:100%;max-width:440px;padding:8px 12px;background:var(--surface-color);border:1px solid rgba(249,115,22,0.35);border-radius:6px;color:var(--text-color);font-size:14px;outline:none;box-shadow:0 0 0 1px rgba(249,115,22,0.15)" oninput="licensesFilter(this.value)" /></div>' +
    '<div id="licenses-table-wrap"></div>';
  licensesRenderTable();
}

function licensesFilter(v) {
  _licenseSearch = v || '';
  licensesRenderTable();
}

// One line at the top when something needs renewing. Counted from the same
// server-computed statuses the rows show, so the banner and the pills can never
// disagree about how many there are.
function licenseRenewalBanner() {
  var bad = { expired: 0, expiring: 0, unknown: 0 };
  var total = 0;
  (_licensesData || []).forEach(function (l) {
    var k = (l.status || {}).key;
    if (bad[k] !== undefined) { bad[k]++; total++; }
  });
  if (!total) return '';
  var bits = [];
  if (bad.expired) bits.push(bad.expired + ' expired');
  if (bad.expiring) bits.push(bad.expiring + ' due within 60 days');
  if (bad.unknown) bits.push(bad.unknown + ' with no renewal date on file');
  return '<div class="alert alert-warn"><strong>' + total + ' licence' + (total === 1 ? '' : 's') +
    ' need' + (total === 1 ? 's' : '') + ' attention.</strong> ' + bits.join(', ') + '.</div>';
}

function licenseCityLabel(code) {
  if (!code) return 'All';
  var c = (_licenseCities || []).filter(function (x) { return x.code === code; })[0];
  return c ? c.name : code;
}

function licenseCityOptions(selected) {
  var opts = '<option value="">All</option>';
  (_licenseCities || []).forEach(function (c) {
    opts += '<option value="' + escHtml(c.code) + '"' + (c.code === selected ? ' selected' : '') + '>' + escHtml(c.name) + '</option>';
  });
  return opts;
}

function licenseStatusCell(l) {
  var st = l.status || {};
  var cls = LICENSE_STATUS_CLASS[st.tone] || 'badge-inactive';
  return '<span class="badge ' + cls + '">' + escHtml(st.label || '') + '</span>' +
    (st.note ? '<div style="font-size:11px;color:var(--text-muted-color);margin-top:2px">' + escHtml(st.note) + '</div>' : '');
}

function licensesRenderTable() {
  var wrap = document.getElementById('licenses-table-wrap');
  if (!wrap) return;
  var q = (_licenseSearch || '').toLowerCase();
  var rows = (_licensesData || []).filter(function (l) {
    if (!q) return true;
    return ((l.name || '') + ' ' + (l.authority || '') + ' ' + (l.license_number || '') + ' ' +
            (l.jurisdiction || '') + ' ' + (l.username || '')).toLowerCase().indexOf(q) !== -1;
  });
  var canManage = _licensesCanManage;

  wrap.innerHTML =
    '<div class="card"><div class="table-wrap">' +
      '<table><thead><tr>' +
        '<th>Licence</th><th>Type</th><th>Authority</th><th>Number</th><th>Jurisdiction</th>' +
        '<th>Renews</th><th>Status</th><th>Portal</th><th>Fee</th><th>Register</th>' +
        (canManage ? '<th></th>' : '') +
      '</tr></thead><tbody>' +
      (rows.length === 0
        ? '<tr><td colspan="' + (canManage ? 11 : 10) + '" style="text-align:center;color:var(--text-muted-color);padding:32px">No licences found.</td></tr>'
        : rows.map(function (l) {
            var pw = l.password || '';
            return '<tr' + (l.active === false ? ' class="user-row-inactive"' : '') + '>' +
              '<td style="font-weight:600;color:var(--text);max-width:220px">' + escHtml(l.name) +
                ((l.restricted_to && l.restricted_to.length) ? '<span class="vn-restricted">RESTRICTED</span>' : '') +
                (l.responsible_name ? '<div style="font-size:11px;color:var(--text-muted-color);font-weight:400">' + escHtml(l.responsible_name) + '</div>' : '') + '</td>' +
              '<td style="white-space:nowrap;font-size:13px">' + escHtml(LICENSE_KIND_LABELS[l.kind] || l.kind) + '</td>' +
              '<td style="max-width:200px;font-size:13px">' + escHtml(l.authority || '—') + '</td>' +
              '<td style="font-family:monospace;font-size:13px">' + escHtml(l.license_number || '—') + '</td>' +
              '<td style="font-size:13px">' + escHtml(l.jurisdiction || licenseCityLabel(l.city_code)) + '</td>' +
              '<td style="white-space:nowrap;font-size:13px">' + (l.expires_on ? escHtml(formatDate(l.expires_on)) : '—') +
                '<div style="font-size:11px;color:var(--text-muted-color)">' + escHtml(LICENSE_INTERVAL_LABELS[l.renewal_interval] || '') + '</div></td>' +
              '<td style="white-space:nowrap">' + licenseStatusCell(l) + '</td>' +
              '<td style="white-space:nowrap;font-size:13px">' + licensePortalCell(l) + '</td>' +
              '<td style="white-space:nowrap;font-size:13px">' + (l.renewal_fee != null ? escHtml(ledgerMoney(l.renewal_fee)) : '—') + '</td>' +
              '<td style="white-space:nowrap">' + licenseLedgerCell(l) + '</td>' +
              (canManage
                ? '<td style="white-space:nowrap">' +
                    '<button class="btn btn-secondary btn-sm" onclick="showLicenseModal(' + l.id + ')">Edit</button> ' +
                    '<button class="btn btn-danger btn-sm" onclick="deleteLicense(' + l.id + ')">' + icons.trash + '</button>' +
                  '</td>'
                : '') +
            '</tr>';
          }).join('')) +
      '</tbody></table>' +
    '</div></div>';
}

// The portal cell: open the site with the password already on the clipboard,
// exactly as the Accounts table does, because the reason you are here at all is
// that something has to be renewed tonight.
function licensePortalCell(l) {
  if (!l.website && !l.username) return '<span style="color:var(--text-muted-color)">—</span>';
  var site = l.website
    ? '<a href="#" onclick="vendorOpenSite(\'' + escHtml(l.website).replace(/'/g, "\\'") + '\',\'' +
        escHtml(l.password || '').replace(/'/g, "\\'") + '\');return false;" style="color:var(--primary)">Open</a>'
    : '';
  var user = l.username
    ? '<div style="font-family:monospace;font-size:12px;color:var(--text-muted-color)">' + escHtml(l.username) + '</div>'
    : '';
  var sq = (l.security_questions && l.security_questions.length)
    ? '<button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:11px;border:1px solid var(--border);margin-top:2px" onclick="licenseViewQuestions(' + l.id + ')">Q&amp;A (' + l.security_questions.length + ')</button>'
    : '';
  return site + user + sq;
}

function licenseLedgerCell(l) {
  var label = l.ledger_count
    ? (escHtml(ledgerMoney(l.ledger_total)) + ' &middot; ' + l.ledger_count)
    : 'Open';
  return '<button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:12px;border:1px solid var(--border)" ' +
    'onclick="openLedger(\'license\',' + l.id + ',\'' + escHtml(l.name || '').replace(/'/g, "\\'") + '\')">' + label + '</button>' +
    (l.last_entry_on ? '<div style="font-size:11px;color:var(--text-muted-color);margin-top:2px">last ' + escHtml(formatDate(l.last_entry_on)) + '</div>' : '');
}

// Read-only security-question popup, same contract as the Accounts one:
// answers start masked, Show and Copy work per row so reading one never exposes
// the rest, and the plaintext is dropped when the popup closes.
var _licenseSqViewing = [];

function licenseViewQuestions(id) {
  var l = (_licensesData || []).filter(function (x) { return x.id === id; })[0];
  if (!l) return;
  var rows = l.security_questions || [];
  _licenseSqViewing = rows;
  var body = rows.map(function (r, i) {
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px">' +
      '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">' + escHtml(r.q || '(no question recorded)') + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span id="lsq-' + i + '" style="font-family:monospace;letter-spacing:1px;font-size:13px;word-break:break-all">' +
          ((r.a || '') ? '••••••••' : '<span style="color:var(--text-muted-color);font-family:inherit;letter-spacing:0">no answer saved</span>') + '</span>' +
        ((r.a || '')
          ? '<button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:12px" onclick="licenseSqReveal(' + i + ',this)">Show</button>' +
            '<button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:12px" onclick="licenseSqCopy(' + i + ',this)">Copy</button>'
          : '') +
      '</div></div>';
  }).join('');
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'license-sq-overlay';
  overlay.innerHTML =
    '<div class="modal" style="max-width:480px">' +
      '<div class="modal-header"><span class="modal-title">Security Questions &mdash; ' + escHtml(l.name || '') + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="licenseCloseQuestions()">&#x2715;</button></div>' +
      '<div class="modal-body">' + (body || '<div style="color:var(--text-muted-color);font-size:13px">None saved.</div>') + '</div>' +
      '<div class="modal-footer"><button class="btn btn-secondary" onclick="licenseCloseQuestions()">Close</button></div>' +
    '</div>';
  document.body.appendChild(overlay);
}

function licenseCloseQuestions() {
  _licenseSqViewing = [];
  var o = document.getElementById('license-sq-overlay');
  if (o) o.remove();
}

function licenseSqReveal(i, btn) {
  var el = document.getElementById('lsq-' + i);
  if (!el) return;
  var row = _licenseSqViewing[i] || {};
  if (btn.textContent === 'Show') { el.textContent = row.a || ''; btn.textContent = 'Hide'; }
  else { el.textContent = '••••••••'; btn.textContent = 'Show'; }
}

function licenseSqCopy(i, btn) {
  var row = _licenseSqViewing[i] || {};
  copyToClipboard(row.a || '', btn);
}

// ── The add / edit modal ─────────────────────────────────────────────────────
// Mirrors the Accounts modal field for field where the fields are the same, so
// somebody who can edit one can edit the other without relearning anything.

function showLicenseModal(id) {
  var isEdit = !!id;
  var l = isEdit ? ((_licensesData || []).filter(function (x) { return x.id === id; })[0] || {}) : {};
  var sq = l.security_questions || [];
  var allow = Array.isArray(l.restricted_to) ? l.restricted_to : [];
  var isRestricted = allow.length > 0;

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'license-modal-overlay';
  overlay.innerHTML =
    '<div class="modal" style="max-width:560px">' +
      '<div class="modal-header"><span class="modal-title">' + (isEdit ? 'Edit Licence' : 'Add Licence') + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'license-modal-overlay\').remove()">&#x2715;</button></div>' +
      '<div class="modal-body">' +
        '<div id="license-modal-error"></div>' +
        '<div class="form-group"><label>Licence Name *</label><input type="text" id="lm-name" value="' + escHtml(l.name || '') + '" placeholder="e.g. Birmingham Occupational Tax" /></div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>Type</label><select id="lm-kind">' +
            Object.keys(LICENSE_KIND_LABELS).map(function (k) {
              return '<option value="' + k + '"' + (l.kind === k ? ' selected' : '') + '>' + escHtml(LICENSE_KIND_LABELS[k]) + '</option>';
            }).join('') + '</select></div>' +
          '<div class="form-group"><label>Licence / Account #</label><input type="text" id="lm-number" value="' + escHtml(l.license_number || '') + '" /></div>' +
        '</div>' +
        '<div class="form-group"><label>Issuing Authority</label><input type="text" id="lm-authority" value="' + escHtml(l.authority || '') + '" placeholder="e.g. City of Birmingham Revenue Department" /></div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>Jurisdiction</label><input type="text" id="lm-jurisdiction" value="' + escHtml(l.jurisdiction || '') + '" placeholder="e.g. Birmingham, AL" /></div>' +
          '<div class="form-group"><label>City Assigned</label><select id="lm-city">' + licenseCityOptions(l.city_code || '') + '</select></div>' +
        '</div>' +
        '<div style="border-top:1px solid var(--border);margin:16px 0 12px;padding-top:12px;font-size:13px;font-weight:600;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:0.05em">Renewal</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>Issued</label><input type="date" id="lm-issued" value="' + escHtml(l.issued_on || '') + '" /></div>' +
          '<div class="form-group"><label>Renews / Expires</label><input type="date" id="lm-expires" value="' + escHtml(l.expires_on || '') + '" /></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>How often</label><select id="lm-interval">' +
            Object.keys(LICENSE_INTERVAL_LABELS).map(function (k) {
              return '<option value="' + k + '"' + ((l.renewal_interval || 'annual') === k ? ' selected' : '') + '>' + escHtml(LICENSE_INTERVAL_LABELS[k]) + '</option>';
            }).join('') + '</select></div>' +
          '<div class="form-group"><label>Typical fee</label><input type="text" id="lm-fee" inputmode="decimal" value="' + escHtml(l.renewal_fee == null ? '' : String(l.renewal_fee)) + '" placeholder="340.00" /></div>' +
        '</div>' +
        '<div class="form-group"><label>Who owns it</label><select id="lm-owner"><option value="">&mdash;</option>' +
          (_licenseUsers || []).map(function (u) {
            return '<option value="' + u.id + '"' + (l.responsible_user_id === u.id ? ' selected' : '') + '>' + escHtml(u.name) + '</option>';
          }).join('') + '</select></div>' +
        '<div style="border-top:1px solid var(--border);margin:16px 0 12px;padding-top:12px;font-size:13px;font-weight:600;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:0.05em">Portal Login</div>' +
        '<div class="form-group"><label>Website</label><input type="url" id="lm-website" value="' + escHtml(l.website || '') + '" placeholder="https://..." /></div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>Username</label><input type="text" id="lm-username" value="' + escHtml(l.username || '') + '" autocomplete="off" /></div>' +
          '<div class="form-group"><label>Password</label>' +
            '<div style="display:flex;gap:8px;align-items:center">' +
              '<input type="password" id="lm-password" value="' + escHtml(l.password || '') + '" autocomplete="off" style="flex:1" />' +
              '<button type="button" class="btn btn-secondary btn-sm" style="white-space:nowrap" onclick="licenseTogglePw()">Show</button>' +
            '</div></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 0 8px">' +
          '<span style="font-size:13px;font-weight:600;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:0.05em">Security Questions</span>' +
          '<button type="button" class="btn btn-secondary btn-sm" onclick="licenseSqAddRow()">+ Add Question</button>' +
        '</div>' +
        '<div style="color:var(--text-muted-color);font-size:12px;margin-bottom:8px">Optional. Answers are hidden by default and are only sent to people who can see this licence&#39;s password.</div>' +
        '<div id="lm-sq-list">' + (sq.length ? sq.map(function (r) { return licenseSqRowHtml(r.q, r.a); }).join('') : '<div id="lm-sq-empty" style="color:var(--text-muted-color);font-size:13px;padding:4px 0">No security questions on this licence.</div>') + '</div>' +
        '<div class="form-group" style="margin-top:16px"><label>Notes</label><textarea id="lm-notes" placeholder="Filing quirks, who to call, what they always ask for...">' + escHtml(l.notes || '') + '</textarea></div>' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:12px 0"><input type="checkbox" id="lm-active" style="width:auto"' + (l.active === false ? '' : ' checked') + ' /> <span>Active &mdash; we still hold this licence</span></label>' +
        '<div style="border-top:1px solid var(--border);margin:16px 0 12px;padding-top:12px;font-size:13px;font-weight:600;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:0.05em">Restrict Visibility</div>' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px"><input type="checkbox" id="lm-restrict" style="width:auto"' + (isRestricted ? ' checked' : '') + ' onchange="licenseToggleRestrict()" /> <span>Only specific people can see this licence</span></label>' +
        '<div id="lm-restrict-box" style="' + (isRestricted ? '' : 'display:none') + '">' +
          '<input type="text" placeholder="Search people..." oninput="licenseFilterUsers(this.value)" style="width:100%;padding:7px 10px;margin-bottom:8px;background:var(--surface-color);border:1px solid var(--border);border-radius:6px;color:var(--text-color);font-size:13px" />' +
          '<div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:6px">' +
            ((_licenseUsers && _licenseUsers.length)
              ? _licenseUsers.map(function (u) {
                  return '<label class="lm-user-row" data-name="' + escHtml((u.name || '').toLowerCase()) + '" style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer">' +
                    '<input type="checkbox" class="lm-user" value="' + u.id + '" style="width:auto"' + (allow.indexOf(u.id) !== -1 ? ' checked' : '') + ' /> ' +
                    '<span>' + escHtml(u.name) + ' <span style="color:var(--text-muted-color);font-size:12px">' + escHtml(roleLabel(u.role)) + '</span></span></label>';
                }).join('')
              : '<div style="color:var(--text-muted-color);font-size:13px;padding:6px">No users available.</div>') +
          '</div>' +
          '<div style="color:var(--text-muted-color);font-size:12px;margin-top:6px">Admins and owners can always see every licence.</div>' +
        '</div>' +
      '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-secondary" onclick="document.getElementById(\'license-modal-overlay\').remove()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="saveLicense(' + (id || 'null') + ')">Save</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
}

function licenseTogglePw() {
  var input = document.getElementById('lm-password');
  var btn = input.nextElementSibling;
  if (input.type === 'password') { input.type = 'text'; btn.textContent = 'Hide'; }
  else { input.type = 'password'; btn.textContent = 'Show'; }
}

function licenseToggleRestrict() {
  var b = document.getElementById('lm-restrict-box');
  var c = document.getElementById('lm-restrict');
  if (b && c) b.style.display = c.checked ? '' : 'none';
}

function licenseFilterUsers(q) {
  q = (q || '').toLowerCase();
  var rows = document.querySelectorAll('.lm-user-row');
  for (var i = 0; i < rows.length; i++) {
    var n = rows[i].getAttribute('data-name') || '';
    rows[i].style.display = (!q || n.indexOf(q) !== -1) ? 'flex' : 'none';
  }
}

// These two must stay in step with SQ_MAX_ROWS / SQ_MAX_LEN in
// routes/licenses.js. The server REJECTS anything past them rather than
// trimming, so the maxlength below is what stops you from typing an answer that
// cannot be saved.
var LICENSE_SQ_MAX_ROWS = 25;
var LICENSE_SQ_MAX_LEN = 300;

function licenseSqRowHtml(q, a) {
  return '<div class="lm-sq-row" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '<input type="text" class="lm-sq-q" maxlength="' + LICENSE_SQ_MAX_LEN + '" value="' + escHtml(q || '') + '" placeholder="Question, e.g. Mother&#39;s maiden name" style="flex:1" />' +
      '<button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;color:var(--danger)" title="Remove this question" onclick="licenseSqRemoveRow(this)">&#x2715;</button>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:8px">' +
      '<input type="password" class="lm-sq-a" maxlength="' + LICENSE_SQ_MAX_LEN + '" value="' + escHtml(a || '') + '" placeholder="Answer" autocomplete="off" style="flex:1" />' +
      '<button type="button" class="btn btn-secondary btn-sm" style="white-space:nowrap" onclick="licenseSqToggleAnswer(this)">Show</button>' +
    '</div></div>';
}

function licenseSqAddRow() {
  var box = document.getElementById('lm-sq-list');
  if (!box) return;
  if (box.querySelectorAll('.lm-sq-row').length >= LICENSE_SQ_MAX_ROWS) {
    showToast('A licence can hold at most ' + LICENSE_SQ_MAX_ROWS + ' security questions.', 'error');
    return;
  }
  var empty = document.getElementById('lm-sq-empty');
  if (empty) empty.remove();
  box.insertAdjacentHTML('beforeend', licenseSqRowHtml('', ''));
  var inputs = box.querySelectorAll('.lm-sq-q');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function licenseSqRemoveRow(btn) {
  var row = btn.closest('.lm-sq-row');
  if (row) row.remove();
  var box = document.getElementById('lm-sq-list');
  if (box && !box.querySelector('.lm-sq-row')) {
    box.innerHTML = '<div id="lm-sq-empty" style="color:var(--text-muted-color);font-size:13px;padding:4px 0">No security questions on this licence.</div>';
  }
}

function licenseSqToggleAnswer(btn) {
  var input = btn.previousElementSibling;
  if (!input) return;
  if (input.type === 'password') { input.type = 'text'; btn.textContent = 'Hide'; }
  else { input.type = 'password'; btn.textContent = 'Show'; }
}

function licenseSqCollect() {
  var out = [];
  var rows = document.querySelectorAll('#lm-sq-list .lm-sq-row');
  for (var i = 0; i < rows.length; i++) {
    var q = ((rows[i].querySelector('.lm-sq-q') || {}).value || '').trim();
    var a = ((rows[i].querySelector('.lm-sq-a') || {}).value || '').trim();
    if (!q && !a) continue;
    out.push({ q: q, a: a });
  }
  return out;
}

async function saveLicense(id) {
  function v(elId) { var el = document.getElementById(elId); return el ? el.value : ''; }
  var name = v('lm-name').trim();
  var errBox = document.getElementById('license-modal-error');
  if (!name) {
    if (errBox) errBox.innerHTML = '<div class="alert alert-error">Licence name is required.</div>';
    return;
  }
  var payload = {
    name: name,
    kind: v('lm-kind'),
    authority: v('lm-authority').trim() || null,
    license_number: v('lm-number').trim() || null,
    jurisdiction: v('lm-jurisdiction').trim() || null,
    city_code: v('lm-city') || null,
    website: v('lm-website').trim() || null,
    username: v('lm-username').trim() || null,
    // Always sent from this modal, so emptying the box really does clear the
    // stored password. The server leaves the column alone only when the key is
    // absent entirely (routes/licenses.js passwordOf).
    password: v('lm-password') || null,
    issued_on: v('lm-issued') || null,
    expires_on: v('lm-expires') || null,
    renewal_interval: v('lm-interval'),
    renewal_fee: v('lm-fee').trim() || null,
    responsible_user_id: v('lm-owner') || null,
    notes: v('lm-notes').trim() || null,
    active: !!(document.getElementById('lm-active') || {}).checked,
    security_questions: licenseSqCollect()
  };
  var restrict = !!(document.getElementById('lm-restrict') || {}).checked;
  var ids = [];
  if (restrict) {
    var cbs = document.querySelectorAll('.lm-user:checked');
    for (var i = 0; i < cbs.length; i++) ids.push(parseInt(cbs[i].value, 10));
  }
  payload.restricted_to = restrict ? ids : null;

  try {
    if (id) await api('PUT', '/licenses/' + id, payload);
    else await api('POST', '/licenses', payload);
    var o = document.getElementById('license-modal-overlay');
    if (o) o.remove();
    await renderLicenses(document.getElementById('content'));
  } catch (err) {
    if (errBox) errBox.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>';
  }
}

async function deleteLicense(id) {
  var l = (_licensesData || []).filter(function (x) { return x.id === id; })[0] || {};
  var n = l.ledger_count || 0;
  var warn = n
    ? 'Delete this licence? Its ' + n + ' register entr' + (n === 1 ? 'y goes' : 'ies go') +
      ' with it. If you have simply stopped holding it, mark it inactive instead.'
    : 'Delete this licence? This cannot be undone.';
  if (!await novaConfirm(warn)) return;
  try {
    await api('DELETE', '/licenses/' + id);
    await renderLicenses(document.getElementById('content'));
  } catch (err) {
    var msg = document.getElementById('license-msg');
    if (msg) msg.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>';
  }
}
