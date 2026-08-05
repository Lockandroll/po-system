/* Nova - Accounts Receivable
 * ---------------------------------------------------------------------------
 * Aging, a ledger per account, and an import that refuses to guess.
 *
 * Two things worth knowing before changing anything here:
 *   1. Balance is DERIVED, never stored. Every figure on this screen comes
 *      from the same view, which is why the ledger can close on the aging
 *      number rather than approximately agreeing with it.
 *   2. Nothing on the import screen moves money until somebody presses Post,
 *      and a line that did not match cleanly can never be auto-applied.
 * --------------------------------------------------------------------------- */

var _arTab = 'aging';
var _arAging = null;
var _arAccount = null;
var _arLedger = null;
var _arBatch = null;
var _arBatches = [];

function arInjectStyles() {
  if (document.getElementById('ar-styles')) return;
  var css =
    '.ar-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px}' +
    '.ar-tab{padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;' +
      'color:var(--text-muted-color)}' +
    '.ar-tab.on{color:var(--primary);border-bottom-color:var(--primary)}' +
    '.ar-num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.ar-late{color:#f87171;font-weight:700}' +
    '.ar-ok{color:#4ade80}' +
    '.ar-note{font-size:12px;color:var(--text-muted-color);line-height:1.65}' +
    '.ar-warn{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.35);' +
      'border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.ar-good{background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.3);' +
      'border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.ar-chip{display:inline-block;border-radius:5px;padding:2px 8px;font-size:11px;font-weight:700;' +
      'letter-spacing:.03em;text-transform:uppercase}' +
    '.ar-chip.matched{background:rgba(74,222,128,.15);color:#4ade80}' +
    '.ar-chip.review{background:rgba(245,158,11,.15);color:#f59e0b}' +
    '.ar-chip.unmatched{background:rgba(248,113,113,.15);color:#f87171}' +
    '.ar-chip.resolved{background:rgba(59,130,246,.15);color:#60a5fa}' +
    '.ar-row-void{opacity:.5;text-decoration:line-through}' +
    '.ar-tot{display:grid;grid-template-columns:1fr auto;gap:6px 20px;font-size:14px;font-variant-numeric:tabular-nums}' +
    '.ar-tot .lbl{color:var(--text-muted-color)}' +
    '.ar-tot .val{text-align:right;font-weight:700}' +
    '.ar-tot .grand{border-top:1px solid var(--border);padding-top:8px;margin-top:4px;font-size:17px;font-weight:800}';
  var st = document.createElement('style');
  st.id = 'ar-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function arModal(title, bodyHtml, okLabel, onOk) {
  arCloseModal();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'ar-modal';
  overlay.innerHTML =
    '<div class="modal" style="max-width:680px">' +
      '<div class="modal-header"><span class="modal-title">' + escHtml(title) + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="arCloseModal()">&#x2715;</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-secondary" onclick="arCloseModal()">Cancel</button>' +
        '<button class="btn btn-primary" id="ar-modal-ok">' + escHtml(okLabel) + '</button>' +
      '</div></div>';
  document.body.appendChild(overlay);
  var ok = document.getElementById('ar-modal-ok');
  // Wrapped, so the click Event never arrives as the first argument.
  if (ok) ok.onclick = function () { onOk(); };
}
function arCloseModal() {
  var m = document.getElementById('ar-modal');
  if (m) m.parentNode.removeChild(m);
}
function arVal(id) { var e = document.getElementById(id); return e ? e.value : ''; }
function arMoney(n) {
  var v = Number(n || 0);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function arErr(msg) {
  var e = document.getElementById('ar-f-err');
  if (e) { e.style.display = 'block'; e.innerHTML = escHtml(msg || 'Could not save.'); }
  else alert(msg);
}

// ---------------------------------------------------------------------------
async function renderAr(content) {
  arInjectStyles();
  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Accounts Receivable</div>' +
      '<div class="page-subtitle">What is owed, who owes it, and how long it has been sitting.</div></div></div>' +
    '<div class="ar-tabs">' +
      '<div class="ar-tab' + (_arTab === 'aging' ? ' on' : '') + '" onclick="arGo(\'aging\')">Aging</div>' +
      '<div class="ar-tab' + (_arTab === 'ledger' ? ' on' : '') + '" onclick="arGo(\'ledger\')">Account ledger</div>' +
      '<div class="ar-tab' + (_arTab === 'import' ? ' on' : '') + '" onclick="arGo(\'import\')">Import &amp; reconcile</div>' +
    '</div><div id="ar-body"></div>';
  await arRender();
}
function arGo(t) {
  _arTab = t;
  renderAr(document.getElementById('content') || document.querySelector('.content'));
}
async function arRender() {
  if (_arTab === 'ledger') return arLoadLedger();
  if (_arTab === 'import') return arLoadImports();
  return arLoadAging();
}

// ---------------------------------------------------------------------------
//  Aging
// ---------------------------------------------------------------------------
async function arLoadAging() {
  var body = document.getElementById('ar-body');
  if (!body) return;
  body.innerHTML = '<div class="card"><div class="card-body">Loading...</div></div>';
  var d;
  try { d = await api('GET', '/ar/aging'); }
  catch (e) { body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  _arAging = d;

  var t = d.totals || {};
  body.innerHTML =
    (d.accounts && d.accounts.length ? '' :
      '<div class="ar-good">Nothing outstanding. An account only appears here once somebody ticks ' +
      '<b>A/R enabled</b> on it - an account that pays at the door was never 90 days late.</div>') +
    '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>Account</th><th>Terms</th>' +
      (d.buckets || []).map(function (b) { return '<th class="ar-num">' + escHtml(b.label) + '</th>'; }).join('') +
      '<th class="ar-num">Total</th><th class="ar-num">Oldest</th><th></th>' +
    '</tr></thead><tbody>' +
    (d.accounts || []).map(function (a) {
      return '<tr>' +
        '<td>' + escHtml(a.name) +
          (a.over_limit ? ' <span class="ar-late">over limit</span>' : '') + '</td>' +
        '<td>Net ' + (a.net_days === null ? 30 : a.net_days) + '</td>' +
        (d.buckets || []).map(function (b) {
          const v = a[b.key];
          return '<td class="ar-num' + (b.key !== 'current' && v ? ' ar-late' : '') + '">' +
            (v ? arMoney(v) : '&mdash;') + '</td>';
        }).join('') +
        '<td class="ar-num"><b>' + arMoney(a.total) + '</b></td>' +
        '<td class="ar-num">' + (a.oldest_days ? a.oldest_days + 'd' : '&mdash;') + '</td>' +
        '<td class="ar-num">' +
          '<button class="btn btn-secondary btn-sm" onclick="arOpenLedger(' + a.account_id + ')">Ledger</button>' +
        '</td></tr>';
    }).join('') +
    '</tbody><tfoot><tr>' +
      '<th colspan="2">Total</th>' +
      (d.buckets || []).map(function (b) { return '<th class="ar-num">' + arMoney(t[b.key]) + '</th>'; }).join('') +
      '<th class="ar-num">' + arMoney(t.total) + '</th><th colspan="2"></th>' +
    '</tr></tfoot></table></div>' +
    '<div class="card" style="margin-top:16px"><div class="card-body"><div class="ar-note">' +
      '<b>The balance is worked out, never stored.</b> Invoice total, less refunds, less payments ' +
      'applied to it, less adjustments. A stored balance drifts the first time anything is edited out ' +
      'of band, and then nobody trusts the aging above it.' +
      '<br><br><b>A credit limit warns, it does not block.</b> Refusing to dispatch because an account ' +
      'is over its limit is a business decision, and it would happen at 2am to a customer standing in a ' +
      'parking lot.' +
    '</div></div></div>';
}

function arOpenLedger(id) {
  _arAccount = id;
  _arTab = 'ledger';
  renderAr(document.getElementById('content') || document.querySelector('.content'));
}

// ---------------------------------------------------------------------------
//  Ledger
// ---------------------------------------------------------------------------
async function arLoadLedger() {
  var body = document.getElementById('ar-body');
  if (!body) return;
  if (!_arAccount) {
    if (!_arAging) { try { _arAging = await api('GET', '/ar/aging'); } catch (e) {} }
    _arAccount = ((_arAging && _arAging.accounts && _arAging.accounts[0]) || {}).account_id || null;
  }
  if (!_arAccount) {
    body.innerHTML = '<div class="card"><div class="card-body">No A/R accounts yet.</div></div>';
    return;
  }
  body.innerHTML = '<div class="card"><div class="card-body">Loading...</div></div>';
  var d;
  try { d = await api('GET', '/ar/accounts/' + _arAccount + '/ledger'); }
  catch (e) { body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  _arLedger = d;

  var picker = (_arAging && _arAging.accounts || []).map(function (a) {
    return '<option value="' + a.account_id + '"' + (a.account_id === _arAccount ? ' selected' : '') + '>' +
      escHtml(a.name) + '</option>';
  }).join('');

  body.innerHTML =
    '<div class="flex-gap" style="margin-bottom:14px;flex-wrap:wrap">' +
      (picker ? '<select onchange="arPickAccount(this.value)" style="width:auto">' + picker + '</select>' : '') +
      '<button class="btn btn-primary btn-sm" onclick="arNewPayment()">Record a payment</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="arNewAdjustment()">Adjustment</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="arEditTerms()">Terms</button>' +
    '</div>' +
    (d.reconciles
      ? ''
      : '<div class="ar-warn"><b>This ledger does not close on the aging figure.</b> Ledger says ' +
        arMoney(d.closing) + ', aging says ' + arMoney(d.balance) + '. One of them has stopped reading ' +
        'the balance view - that is a bug, not a data-entry problem.</div>') +
    (d.unapplied_cash
      ? '<div class="ar-warn"><b>' + arMoney(d.unapplied_cash) + ' is sitting unapplied.</b> It is money ' +
        'in hand, but it has not been pointed at an invoice, so it is not reducing anything below. ' +
        'Apply it from the payment row.</div>'
      : '') +
    '<div class="mk-cols" style="display:grid;grid-template-columns:1fr 300px;gap:16px;align-items:start"><div>' +
      '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th>Date</th><th>Ref</th><th>Description</th>' +
        '<th class="ar-num">Charge</th><th class="ar-num">Credit</th><th class="ar-num">Balance</th>' +
      '</tr></thead><tbody>' +
      ((d.entries || []).length ? d.entries.map(function (e) {
        return '<tr' + (e.voided ? ' class="ar-row-void"' : '') + '>' +
          '<td>' + escHtml(String(e.at || '').slice(0, 10)) + '</td>' +
          '<td>' + escHtml(e.ref || '') + '</td>' +
          '<td>' + escHtml(e.description || '') + '</td>' +
          '<td class="ar-num">' + (e.debit ? arMoney(e.debit) : '') + '</td>' +
          '<td class="ar-num">' + (e.credit ? arMoney(e.credit) : '') + '</td>' +
          '<td class="ar-num"><b>' + arMoney(e.running) + '</b></td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="6" style="text-align:center;padding:26px;color:var(--text-muted-color)">' +
        'Nothing on this account yet.</td></tr>') +
      '</tbody></table></div>' +
    '</div><div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-body">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;' +
          'color:var(--primary);margin-bottom:12px">' + escHtml((d.account || {}).name || '') + '</div>' +
        '<div class="ar-tot">' +
          '<div class="lbl">Open invoices</div><div class="val">' + (d.open || []).length + '</div>' +
          '<div class="lbl">Unapplied cash</div><div class="val">' + arMoney(d.unapplied_cash) + '</div>' +
          '<div class="lbl grand">Balance</div><div class="val grand">' + arMoney(d.balance) + '</div>' +
        '</div>' +
        '<div class="ar-note" style="margin-top:10px">Net ' + ((d.account || {}).net_days || 30) +
          ((d.account || {}).credit_limit ? ' &middot; limit ' + arMoney(d.account.credit_limit) : '') +
          ((d.account || {}).ar_statement_day ? ' &middot; statement on the ' + d.account.ar_statement_day + 'th' : '') +
        '</div>' +
      '</div></div>' +
      ((d.open || []).length ? '<div class="card"><div class="card-body">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;' +
          'color:var(--text-muted-color);margin-bottom:10px">Still open</div>' +
        '<div class="ar-tot">' +
        d.open.map(function (i) {
          return '<div class="lbl">' + escHtml(String(i.invoice_number)) + '</div>' +
            '<div class="val">' + arMoney(i.balance) + '</div>';
        }).join('') + '</div></div></div>' : '') +
    '</div></div>';
}

function arPickAccount(id) { _arAccount = parseInt(id, 10); arLoadLedger(); }

function arOpenOptions() {
  return ((_arLedger && _arLedger.open) || []).map(function (i) {
    return '<option value="' + i.invoice_id + '">' + escHtml(String(i.invoice_number)) +
      ' - ' + arMoney(i.balance) + ' open</option>';
  }).join('');
}

function arNewPayment() {
  const open = (_arLedger && _arLedger.open) || [];
  arModal('Record a payment',
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>Amount</label><input id="ar-p-amount" placeholder="500.00"></div>' +
      '<div class="form-group"><label>Received</label><input type="date" id="ar-p-date" value="' +
        new Date().toISOString().slice(0, 10) + '"></div>' +
      '<div class="form-group"><label>Method</label><select id="ar-p-method">' +
        ['check', 'ach', 'card', 'square', 'other'].map(function (m) {
          return '<option value="' + m + '">' + m + '</option>';
        }).join('') + '</select></div>' +
    '</div>' +
    '<div class="form-group"><label>Reference</label><input id="ar-p-ref" placeholder="Cheque number"></div>' +
    '<div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;' +
      'color:var(--text-muted-color);margin:14px 0 8px">Apply it to</div>' +
    (open.length ? open.map(function (i, n) {
      return '<div style="display:grid;grid-template-columns:1fr 130px;gap:10px;align-items:center;margin-bottom:6px">' +
        '<div style="font-size:13.5px">' + escHtml(String(i.invoice_number)) +
          ' <span class="ar-note">' + arMoney(i.balance) + ' open</span></div>' +
        '<input id="ar-ap-' + n + '" data-inv="' + i.invoice_id + '" placeholder="0.00" class="ar-num">' +
      '</div>';
    }).join('') : '<div class="ar-note">Nothing open on this account. The payment will sit unapplied ' +
      'until an invoice exists to point it at, which is fine and happens more often than you would think.</div>') +
    '<div class="ar-note" style="margin-top:10px">Leave the boxes blank to record the money without ' +
      'applying it. You can apply it later.</div>' +
    '<div id="ar-f-err" class="ar-warn" style="display:none"></div>',
    'Record', function () { arSavePayment(); });
}

async function arSavePayment() {
  const open = (_arLedger && _arLedger.open) || [];
  const lines = [];
  open.forEach(function (i, n) {
    const v = arVal('ar-ap-' + n);
    if (v && parseFloat(v)) lines.push({ invoice_id: i.invoice_id, amount: v });
  });
  try {
    await api('POST', '/ar/payments', {
      account_id: _arAccount, amount: arVal('ar-p-amount'), received_on: arVal('ar-p-date'),
      method: arVal('ar-p-method'), reference: arVal('ar-p-ref'), lines: lines
    });
  } catch (e) { arErr(e.message); return; }
  arCloseModal();
  await arLoadLedger();
}

function arNewAdjustment() {
  arModal('Adjustment',
    '<div class="form-group"><label>Invoice</label><select id="ar-a-inv">' + arOpenOptions() + '</select></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>Kind</label><select id="ar-a-kind">' +
        '<option value="credit">Credit</option>' +
        '<option value="short_pay">Short pay</option>' +
        '<option value="dispute">Dispute</option>' +
        '<option value="writeoff">Write off</option>' +
      '</select></div>' +
      '<div class="form-group"><label>Amount</label><input id="ar-a-amount" placeholder="25.00"></div>' +
    '</div>' +
    '<div class="form-group"><label>Reason</label><textarea id="ar-a-reason" rows="2"></textarea>' +
      '<div class="ar-note">Required. This is the line somebody asks about a year from now.</div></div>' +
    '<div id="ar-f-err" class="ar-warn" style="display:none"></div>',
    'Post', function () { arSaveAdjustment(); });
}

async function arSaveAdjustment() {
  try {
    await api('POST', '/ar/adjustments', {
      invoice_id: arVal('ar-a-inv'), kind: arVal('ar-a-kind'),
      amount: arVal('ar-a-amount'), reason: arVal('ar-a-reason')
    });
  } catch (e) { arErr(e.message); return; }
  arCloseModal();
  await arLoadLedger();
}

function arEditTerms() {
  const a = (_arLedger && _arLedger.account) || {};
  arModal('Terms - ' + (a.name || ''),
    '<div class="form-group"><label class="check"><input type="checkbox" id="ar-t-on"' +
      (a.ar_enabled ? ' checked' : '') + '> On terms (appears in A/R)</label></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>Net days</label><input id="ar-t-net" value="' + (a.net_days === null || a.net_days === undefined ? 30 : a.net_days) + '"></div>' +
      '<div class="form-group"><label>Credit limit</label><input id="ar-t-limit" value="' + (a.credit_limit === null || a.credit_limit === undefined ? '' : Number(a.credit_limit)) + '"></div>' +
      '<div class="form-group"><label>Statement day</label><input id="ar-t-day" value="' + (a.ar_statement_day || '') + '">' +
        '<div class="ar-note">1-28.</div></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>A/R contact</label><input id="ar-t-name" value="' + escHtml(a.ar_contact_name || '') + '"></div>' +
      '<div class="form-group"><label>A/R email</label><input id="ar-t-email" value="' + escHtml(a.ar_contact_email || '') + '"></div>' +
    '</div>' +
    '<div class="ar-note">A credit limit <b>warns</b>. It never stops a call being taken.</div>' +
    '<div id="ar-f-err" class="ar-warn" style="display:none"></div>',
    'Save', function () { arSaveTerms(); });
}

async function arSaveTerms() {
  var on = document.getElementById('ar-t-on');
  try {
    await api('POST', '/ar/accounts/' + _arAccount + '/terms', {
      ar_enabled: !!(on && on.checked), net_days: arVal('ar-t-net'), credit_limit: arVal('ar-t-limit'),
      ar_statement_day: arVal('ar-t-day'), ar_contact_name: arVal('ar-t-name'), ar_contact_email: arVal('ar-t-email')
    });
  } catch (e) { arErr(e.message); return; }
  arCloseModal();
  _arAging = null;
  await arLoadLedger();
}

// ---------------------------------------------------------------------------
//  Import and reconcile
// ---------------------------------------------------------------------------
async function arLoadImports() {
  var body = document.getElementById('ar-body');
  if (!body) return;
  if (_arBatch) return arRenderBatch();
  body.innerHTML = '<div class="card"><div class="card-body">Loading...</div></div>';
  var d;
  try { d = await api('GET', '/ar/import'); }
  catch (e) { body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  _arBatches = d.batches || [];
  if (!_arAging) { try { _arAging = await api('GET', '/ar/aging'); } catch (e) {} }

  body.innerHTML =
    '<div class="flex-gap" style="margin-bottom:14px">' +
      '<button class="btn btn-primary btn-sm" onclick="arNewImport()">Upload a remittance</button>' +
    '</div>' +
    '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>File</th><th>Account</th><th class="ar-num">Lines</th><th class="ar-num">Total</th>' +
      '<th>Status</th><th>Uploaded</th><th></th></tr></thead><tbody>' +
    (_arBatches.length ? _arBatches.map(function (b) {
      return '<tr>' +
        '<td>' + escHtml(b.filename) + '</td>' +
        '<td>' + escHtml(b.account_name || '') + '</td>' +
        '<td class="ar-num">' + b.line_count + '</td>' +
        '<td class="ar-num">' + arMoney(b.total_amount) + '</td>' +
        '<td>' + (b.status === 'posted' ? '<span class="ar-ok">posted</span>' : escHtml(b.status)) + '</td>' +
        '<td>' + escHtml(String(b.uploaded_at || '').slice(0, 10)) + '</td>' +
        '<td class="ar-num"><button class="btn btn-secondary btn-sm" onclick="arOpenBatch(' + b.id + ')">Open</button></td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="7" style="text-align:center;padding:26px;color:var(--text-muted-color)">' +
      'No remittances imported yet.</td></tr>') +
    '</tbody></table></div>' +
    '<div class="card" style="margin-top:16px"><div class="card-body"><div class="ar-note">' +
      '<b>Nothing posts until you press Post</b>, and a line that did not match cleanly can never be ' +
      'applied automatically. An importer that guesses is worse than no importer: you find out three ' +
      'months later, when an account will not reconcile and nobody can say which guess was wrong.' +
      '<br><br><b>The file is matched by its contents, not its name.</b> Re-uploading a remittance that ' +
      'has already been posted is refused outright - posting the same file twice is the most common way ' +
      'A/R imports go wrong, and it is silent.' +
    '</div></div></div>';
}

function arNewImport() {
  const accounts = (_arAging && _arAging.accounts) || [];
  arModal('Upload a remittance',
    '<div class="form-group"><label>Account</label><select id="ar-i-acct">' +
      accounts.map(function (a) {
        return '<option value="' + a.account_id + '">' + escHtml(a.name) + '</option>';
      }).join('') + '</select></div>' +
    '<div class="form-group"><label>File name</label><input id="ar-i-name" placeholder="remittance-aug.csv"></div>' +
    '<div class="form-group"><label>Paste the CSV</label>' +
      '<textarea id="ar-i-text" rows="10" placeholder="Invoice Number,Amount,Check No"></textarea>' +
      '<div class="ar-note">First line is the column headings. Nova guesses which column is which and ' +
      'remembers it for this account.</div></div>' +
    '<div id="ar-f-err" class="ar-warn" style="display:none"></div>',
    'Stage it', function () { arStageImport(); });
}

async function arStageImport() {
  var out;
  try {
    out = await api('POST', '/ar/import/stage', {
      account_id: arVal('ar-i-acct'), filename: arVal('ar-i-name') || 'pasted.csv', text: arVal('ar-i-text')
    });
  } catch (e) { arErr(e.message); return; }
  arCloseModal();
  _arBatch = out.batch_id;
  await arRenderBatch();
}

function arOpenBatch(id) { _arBatch = id; arRenderBatch(); }
function arBackToImports() { _arBatch = null; arLoadImports(); }

async function arRenderBatch() {
  var body = document.getElementById('ar-body');
  if (!body) return;
  body.innerHTML = '<div class="card"><div class="card-body">Loading...</div></div>';
  var d;
  try { d = await api('GET', '/ar/import/' + _arBatch); }
  catch (e) { body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }

  const b = d.batch || {};
  const c = d.counts || {};
  const postable = (c.matched || 0) + (c.resolved || 0);
  window._arBatchOpen = d.open || [];

  body.innerHTML =
    '<div class="flex-gap" style="margin-bottom:14px;flex-wrap:wrap;align-items:center">' +
      '<button class="btn btn-ghost btn-sm" onclick="arBackToImports()">&larr; All imports</button>' +
      '<div style="font-weight:700">' + escHtml(b.filename) + '</div>' +
      '<span class="ar-note">' + escHtml(b.account_name || '') + '</span>' +
      '<span style="margin-left:auto"></span>' +
      (b.status === 'staged'
        ? '<button class="btn btn-secondary btn-sm" onclick="arDiscardBatch()">Discard</button>' +
          '<button class="btn btn-primary btn-sm" onclick="arPostBatch()">Post ' + postable + ' line' +
            (postable === 1 ? '' : 's') + '</button>'
        : '<span class="ar-chip ' + (b.status === 'posted' ? 'matched' : 'unmatched') + '">' + escHtml(b.status) + '</span>') +
    '</div>' +
    (b.status === 'staged'
      ? '<div class="' + ((c.review || c.unmatched) ? 'ar-warn' : 'ar-good') + '">' +
        '<b>' + postable + ' ready to post.</b> ' +
        ((c.review || 0) + (c.unmatched || 0)
          ? ((c.review || 0) + (c.unmatched || 0)) + ' line(s) will be LEFT ALONE until somebody points ' +
            'them at an invoice. Posting now is fine; it just does not touch them.'
          : 'Everything matched.') +
        '</div>'
      : '') +
    '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>#</th><th>Invoice on the line</th><th class="ar-num">Amount</th><th>State</th>' +
      '<th>What Nova thinks</th><th></th></tr></thead><tbody>' +
    (d.lines || []).map(function (l) {
      return '<tr>' +
        '<td>' + l.line_no + '</td>' +
        '<td>' + escHtml(l.invoice_number || '') +
          (l.matched_number && String(l.matched_number) !== String(l.invoice_number)
            ? ' <span class="ar-note">&rarr; ' + escHtml(String(l.matched_number)) + '</span>' : '') + '</td>' +
        '<td class="ar-num">' + arMoney(l.amount) + '</td>' +
        '<td><span class="ar-chip ' + escHtml(l.match_state) + '">' + escHtml(l.match_state) + '</span></td>' +
        '<td class="ar-note">' + escHtml(l.match_note || '') + '</td>' +
        '<td class="ar-num">' + (b.status === 'staged' && l.match_state !== 'matched'
          ? '<button class="btn btn-secondary btn-sm" onclick="arResolveLine(' + l.id + ')">Resolve</button>' : '') +
        '</td></tr>';
    }).join('') +
    '</tbody></table></div>';
}

function arResolveLine(id) {
  const open = window._arBatchOpen || [];
  arModal('Point this line at an invoice',
    '<div class="form-group"><label>Invoice</label><select id="ar-l-inv">' +
      open.map(function (i) {
        return '<option value="' + i.invoice_id + '">' + escHtml(String(i.invoice_number)) +
          ' - ' + arMoney(i.balance) + ' open</option>';
      }).join('') + '</select></div>' +
    '<div class="form-group"><label>Why</label><textarea id="ar-l-note" rows="2"></textarea>' +
      '<div class="ar-note">Required. A guess with no note written down is exactly what makes an ' +
      'account unreconcilable six months later.</div></div>' +
    '<div class="form-group"><label class="check"><input type="checkbox" id="ar-l-skip"> ' +
      'Leave this line alone instead</label></div>' +
    '<div id="ar-f-err" class="ar-warn" style="display:none"></div>',
    'Save', function () { arSaveLine(id); });
}

async function arSaveLine(id) {
  var skip = document.getElementById('ar-l-skip');
  try {
    await api('POST', '/ar/import/lines/' + id, skip && skip.checked
      ? { skip: true, match_note: arVal('ar-l-note') }
      : { invoice_id: arVal('ar-l-inv'), match_note: arVal('ar-l-note') });
  } catch (e) { arErr(e.message); return; }
  arCloseModal();
  await arRenderBatch();
}

async function arPostBatch() {
  if (!confirm('Post this batch?\n\nThis is the step that moves money. Lines that did not match are left alone.')) return;
  var out;
  try { out = await api('POST', '/ar/import/' + _arBatch + '/post', {}); }
  catch (e) { alert(e.message); return; }
  alert('Posted ' + out.posted + ' line(s), ' + arMoney(out.total) + '.' +
    (out.left_alone ? '\n\n' + out.left_alone + ' line(s) were left alone.' : ''));
  _arAging = null;
  await arRenderBatch();
}

async function arDiscardBatch() {
  if (!confirm('Discard this batch? Nothing has been posted from it.')) return;
  try { await api('POST', '/ar/import/' + _arBatch + '/discard', {}); }
  catch (e) { alert(e.message); return; }
  arBackToImports();
}
