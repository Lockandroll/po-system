// Link an invoice to a work order by hand  (Nova, Tony 2026-10-16)
// ----------------------------------------------------------------
// For an invoice a locksmith built from the Invoices screen instead of the
// sign-off sheet. Nova tries to match those on its own (utils/invoiceWoLink.js:
// invoice # typed on the sheet, or same account + PO / WO #). This dialog is
// for the ones it would not guess. Opened from the work order page (Link
// Invoice) and from the Completion Paperwork job review.
// NOTE: no backtick/template-literal strings (Windows-safe per Nova rules).

var _wilState = null;

function _wilMoney(v) { return '$' + (parseFloat(v) || 0).toFixed(2); }
function _wilDate(s) {
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return String(s).split('T')[0];
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2);
}
function _wilStatus(st) {
  var map = { draft: 'Active', awaiting_payment: 'Waiting', paid: 'Completed', partially_refunded: 'Part refunded', refunded: 'Refunded' };
  return map[st] || st || '';
}

function _wilRefresh() {
  apiBustCache('/work-orders/');
  apiBustCache('/paperwork/');
  if (_wilState && typeof _wilState.onDone === 'function') { _wilState.onDone(); return; }
  if (state.currentView) navigate(state.currentView, state.currentParam);
}

function _wilClose() {
  var ov = document.getElementById('wil-overlay');
  if (ov) { ov.classList.add('closing'); setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 140); }
  document.removeEventListener('keydown', _wilKey);
}
function _wilKey(e) { if (e.key === 'Escape') { e.preventDefault(); _wilClose(); } }

async function woLinkInvoiceDialog(woId, onDone) {
  _wilState = { woId: woId, onDone: onDone || null, pick: null, q: '', timer: null };
  var ov = document.createElement('div');
  ov.className = 'nova-dialog-overlay';
  ov.id = 'wil-overlay';
  ov.innerHTML = '<div class="nova-dlg" role="dialog" aria-modal="true" style="max-width:640px;width:100%">' +
    '<div class="nova-dlg-title">Link an invoice to this work order</div>' +
    '<div id="wil-head" style="font-size:13px;color:var(--text-muted-color);margin:4px 0 10px">Loading&hellip;</div>' +
    '<input id="wil-q" type="text" class="nova-dlg-input" placeholder="Search any invoice by number, PO, customer or account" oninput="wilSearch(this.value)" style="width:100%;margin-bottom:10px">' +
    '<div id="wil-list" style="max-height:52vh;overflow:auto;border:1px solid var(--border);border-radius:8px"></div>' +
    '<div id="wil-err" style="margin-top:8px"></div>' +
    '<div class="nova-dlg-actions">' +
      '<button class="btn btn-secondary" onclick="_wilClose()">Cancel</button>' +
      '<button class="btn btn-primary" id="wil-ok" disabled onclick="wilLink()">Link invoice</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  ov.addEventListener('mousedown', function (e) { if (e.target === ov) _wilClose(); });
  document.addEventListener('keydown', _wilKey);
  await wilLoad('');
}

function wilSearch(v) {
  if (!_wilState) return;
  if (_wilState.timer) clearTimeout(_wilState.timer);
  _wilState.timer = setTimeout(function () { wilLoad(v); }, 300);
}

async function wilLoad(q) {
  if (!_wilState) return;
  _wilState.q = q || '';
  var list = document.getElementById('wil-list');
  if (list) list.innerHTML = '<div class="loading" style="padding:14px">Loading&hellip;</div>';
  var d;
  try { d = await api('GET', '/work-orders/' + _wilState.woId + '/invoice-candidates' + (q ? ('?q=' + encodeURIComponent(q)) : '')); }
  catch (e) { if (list) list.innerHTML = '<div class="alert alert-error" style="margin:10px">' + escHtml(e.message) + '</div>'; return; }
  var w = d.work_order || {};
  var head = document.getElementById('wil-head');
  if (head) {
    var bits = [];
    if (w.account_name) bits.push(escHtml(w.account_name));
    if (w.po_number) bits.push('PO ' + escHtml(w.po_number));
    if (w.wo_number && String(w.wo_number) !== String(w.po_number || '')) bits.push('WO ' + escHtml(w.wo_number));
    head.innerHTML = (bits.length ? bits.join(' &middot; ') : 'This work order') +
      (d.current ? '<div style="margin-top:6px;color:var(--danger)">Already linked to invoice #' + escHtml(String(d.current.invoice_number)) + '. Unlink it first to pick another.</div>' : '') +
      (!w.has_signoff ? '<div style="margin-top:6px;color:var(--danger)">This work order has no sign-off sheet yet.</div>' : '') +
      (q ? '' : '<div style="margin-top:4px">Showing invoices on this account that are not on any job yet. Search to find one on another account.</div>');
  }
  _wilState.rows = d.invoices || [];
  _wilState.pick = null;
  var ok = document.getElementById('wil-ok');
  if (ok) ok.disabled = true;
  if (!list) return;
  if (!_wilState.rows.length) {
    list.innerHTML = '<div style="padding:14px;font-size:13px;color:var(--text-muted-color)">No unlinked invoices found' + (q ? ' for &quot;' + escHtml(q) + '&quot;' : '') + '.</div>';
    return;
  }
  list.innerHTML = _wilState.rows.map(function (i, k) {
    return '<div class="wil-row" id="wil-row-' + k + '" onclick="wilPick(' + k + ')" style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-bottom:1px solid var(--border-light);cursor:pointer">' +
      '<input type="radio" name="wil-pick" style="width:auto;margin-top:3px">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:600;font-size:13.5px">#' + escHtml(String(i.invoice_number)) +
          ' <span style="font-weight:400;color:var(--text-muted-color)">&middot; ' + escHtml(_wilDate(i.invoice_date || i.created_at)) + ' &middot; ' + escHtml(_wilStatus(i.status)) + ' &middot; ' + _wilMoney(i.grand_total) + '</span>' +
          (i.suggested ? ' <span class="badge badge-completed" style="margin-left:4px">Likely match</span>' : '') + '</div>' +
        '<div style="font-size:12.5px;color:var(--text-muted-color);margin-top:2px;overflow-wrap:anywhere">' +
          escHtml(i.customer_name || 'No customer') + ' &middot; PO ' + escHtml(i.customer_po_wo || 'none') + ' &middot; ' + escHtml(i.account_name || 'No account') +
          (i.locksmith ? ' &middot; ' + escHtml(i.locksmith) : '') + '</div>' +
        (i.match ? '<div style="font-size:12px;color:var(--text-muted-color);margin-top:2px">' + escHtml(i.match) + '</div>' : '') +
      '</div></div>';
  }).join('');
}

function wilPick(k) {
  if (!_wilState) return;
  _wilState.pick = _wilState.rows[k] || null;
  (_wilState.rows || []).forEach(function (r, n) {
    var el = document.getElementById('wil-row-' + n);
    if (!el) return;
    el.style.background = n === k ? 'var(--bg-elevated)' : '';
    var rb = el.querySelector('input[type=radio]');
    if (rb) rb.checked = n === k;
  });
  var ok = document.getElementById('wil-ok');
  if (ok) ok.disabled = !_wilState.pick;
}

async function wilLink() {
  if (!_wilState || !_wilState.pick) return;
  var ok = document.getElementById('wil-ok');
  var err = document.getElementById('wil-err');
  if (ok) { ok.disabled = true; ok.textContent = 'Linking...'; }
  try {
    await api('POST', '/work-orders/' + _wilState.woId + '/link-invoice', { invoice_id: _wilState.pick.id });
    var num = _wilState.pick.invoice_number;
    _wilClose();
    showToast('Invoice #' + num + ' linked to the work order', 'success');
    _wilRefresh();
  } catch (e) {
    if (err) err.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>';
    if (ok) { ok.disabled = false; ok.textContent = 'Link invoice'; }
  }
}

async function woUnlinkInvoice(woId, num, onDone) {
  if (!await novaConfirm('Unlink invoice #' + num + ' from this work order? Nova will not re-attach it on its own; you can link it again by hand.', { okText: 'Unlink' })) return;
  _wilState = { woId: woId, onDone: onDone || null };
  try {
    await api('DELETE', '/work-orders/' + woId + '/link-invoice');
    showToast('Invoice #' + num + ' unlinked', 'success');
    _wilRefresh();
  } catch (e) { showToast(e.message, 'error'); }
}
