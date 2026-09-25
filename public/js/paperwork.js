// Completion Paperwork - queue, job review, and the delivery Settings card.
// Classic script (globals), loaded after app.js. Uses api(), state, can(),
// escHtml(), navigate(), apiBustCache() from app.js.
//
// PHASE 2: the operator cockpit. A liaison reviews a finished national-account
// job and marks it Ready to Send (or Hold). The actual send (Send now + the
// 5 PM batch) is a later phase; nothing here emails a customer.
//
// NOTE: no backtick/template-literal strings (Windows-safe per Nova rules);
// &#39; for apostrophes inside HTML attribute strings.

var _pwEl = null;
var _pwQueue = null;
var _pwJob = null;
var _pwTab = 'needs_review';

var PW_CHECK = '<span style="color:#4ade80">&#10003;</span>';
var PW_WARN = '<span style="color:#fbbf24">&#9888;</span>';
var PW_BAD = '<span style="color:#f87171">&#10007;</span>';

function _pwMB(bytes) { return Math.round((bytes / 1048576) * 10) / 10; }
function _pwMoney(v) { return '$' + (parseFloat(v) || 0).toFixed(2); }
function _pwDate(s) {
  if (!s) return '-';
  try { return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return '-'; }
}

// Store name + number without repeating the number when the name already
// carries it ("WINGSTOP#02637" + "02637"), and one number when PO == WO.
function _pwStore(j) {
  var name = String(j.store_name || '').trim(), num = String(j.store_number || '').trim();
  var numPart = (num && name.replace(/\s+/g, '').indexOf(num.replace(/\s+/g, '')) === -1) ? '#' + num : '';
  return [name, numPart].filter(Boolean).join(' ');
}
function _pwJobLabel(j) { return j.po_number ? 'PO ' + j.po_number : ('WO ' + (j.wo_number || j.work_order_id)); }
function _pwWoIfDifferent(j) { return (j.wo_number && String(j.wo_number) !== String(j.po_number || '')) ? j.wo_number : ''; }
function _pwCheckinText(c) {
  if (!c || !c.applies) return '';
  var miss = [];
  if (c.in_required && !c.in_done) miss.push('check-in');
  if (c.out_required && !c.out_done) miss.push('check-out');
  return miss.length ? ('No ' + miss.join(' or ') + ' on file') : 'Check-in on file';
}

function pwStateBadge(st, blocked) {
  if (st === 'ready') return '<span class="badge badge-active">Ready to send</span>';
  if (st === 'sent') return '<span class="badge badge-completed">Sent</span>';
  if (st === 'held') return '<span class="badge badge-rejected">Held</span>';
  if (st === 'failed') return '<span class="badge badge-rejected">Failed</span>';
  if (blocked) return '<span class="badge badge-draft">Blocked</span>';
  return '<span class="badge badge-submitted">Needs review</span>';
}

function pwDeliveryChip(j) {
  var d = j && j.delivery;
  if (!d) return '';
  if (d === 'delivered') return ' <span class="badge badge-completed" title="Delivered to the account mail server">Delivered</span>';
  if (d === 'bounced') return ' <span class="badge badge-rejected" title="The recipient rejected it">Bounced</span>';
  if (d === 'failed') return ' <span class="badge badge-rejected" title="The provider could not send it">Send failed</span>';
  if (d === 'complained') return ' <span class="badge badge-waiting" title="Marked as spam">Spam</span>';
  if (d === 'delayed') return ' <span class="badge badge-draft" title="Delivery delayed">Delayed</span>';
  return '';
}

async function renderCompletionPaperwork(el) {
  if (!can('view_completion_paperwork')) { el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
  _pwEl = el;
  var param = state.currentParam;
  if (param === 'settings') return pwRenderSettings(el);
  if (param != null && /^[0-9]+$/.test(String(param))) return pwRenderJob(el, parseInt(param, 10));
  return pwRenderQueue(el);
}

// ---------- Queue ----------
async function pwRenderQueue(el) {
  el.innerHTML = '<div class="loading">Loading&hellip;</div>';
  try { _pwQueue = await api('GET', '/paperwork/queue'); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>'; return; }
  pwDrawQueue();
}

function pwCount(k) { return (_pwQueue && _pwQueue[k]) ? _pwQueue[k].length : 0; }

function pwDrawQueue() {
  if (!_pwEl) return;
  var settingsBtn = can('manage_completion_paperwork')
    ? '<button class="btn btn-secondary btn-sm" onclick="navigate(\'completion-paperwork\',\'settings\')">Settings</button>' : '';
  var tabs = [
    ['needs_review', 'Needs Review'],
    ['ready', 'Ready to Send'],
    ['sent', 'Sent'],
    ['held', 'Held / Issues']
  ].map(function (t) {
    var n = pwCount(t[0]);
    var active = _pwTab === t[0];
    return '<div onclick="pwSetTab(\'' + t[0] + '\')" style="padding:10px 15px;cursor:pointer;font-size:14px;font-weight:500;border-bottom:2px solid ' +
      (active ? 'var(--primary)' : 'transparent') + ';color:' + (active ? 'var(--text)' : 'var(--text-muted-color)') + '">' +
      escHtml(t[1]) + (n ? ' <span style="font-size:11px;font-weight:700;background:' + (active ? 'var(--primary)' : 'var(--bg-elevated)') + ';color:' + (active ? '#111' : 'var(--text-dim)') + ';border-radius:10px;padding:0 7px">' + n + '</span>' : '') + '</div>';
  }).join('');

  var rows = (_pwQueue && _pwQueue[_pwTab]) ? _pwQueue[_pwTab] : [];
  var body;
  if (!rows.length) {
    body = '<div style="padding:28px;text-align:center;color:var(--text-muted-color);font-size:14px">Nothing here right now.</div>';
  } else {
    body = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Job</th><th>Account</th><th>Store / City</th><th>Completed</th><th>Invoice</th><th>Readiness</th><th>State</th><th></th>' +
      '</tr></thead><tbody>' + rows.map(pwQueueRow).join('') + '</tbody></table></div>';
  }

  _pwEl.innerHTML =
    '<div class="page-header" style="display:flex;align-items:center;justify-content:space-between">' +
      '<div class="page-title">Completion Paperwork</div>' + settingsBtn + '</div>' +
    '<div style="color:var(--text-muted-color);font-size:13px;margin:-6px 0 12px">Verify finished national-account jobs and mark them ready to send.</div>' +
    '<div style="display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:14px">' + tabs + '</div>' +
    '<div class="card"><div class="card-body" style="padding:0">' + body + '</div></div>';
}

function pwSetTab(t) { _pwTab = t; pwDrawQueue(); }

function pwQueueRow(j) {
  var r = j.readiness || {};
  var so = (r.trips_signed || 0) + '/' + (r.trips_total || 0);
  var soOk = (r.trips_total > 0 && r.trips_signed >= r.trips_total);
  var chips =
    (soOk ? PW_CHECK : PW_WARN) + ' <span style="color:var(--text-muted-color);font-size:12px">Sign-offs ' + so + '</span> &nbsp; ' +
    (r.invoice_finished ? PW_CHECK : PW_BAD) + ' <span style="color:var(--text-muted-color);font-size:12px">' + (r.invoice_finished ? 'Invoice' : 'No invoice') + '</span> &nbsp; ' +
    (r.photo_count > 0 ? PW_CHECK : PW_WARN) + ' <span style="color:var(--text-muted-color);font-size:12px">' + (r.photo_count || 0) + ' photo' + (r.photo_count === 1 ? '' : 's') + '</span>' +
    ((r.checkin && r.checkin.applies) ? ' &nbsp; ' + (r.checkin.ok ? PW_CHECK : PW_WARN) + ' <span style="color:var(--text-muted-color);font-size:12px">' + (r.checkin.ok ? 'Check-in' : 'No check-in') + '</span>' : '');
  var store = escHtml(_pwStore(j) || '-');
  var city = j.city_state_zip ? '<div style="color:var(--text-muted-color);font-size:12px">' + escHtml(j.city_state_zip) + '</div>' : '';
  var inv = j.invoice_id
    ? '<span style="color:var(--text)">#' + escHtml(j.invoice_number || j.invoice_id) + '</span><div style="color:var(--text-muted-color);font-size:12px">' + _pwMoney(j.grand_total) + '</div>'
    : '<span class="badge badge-draft">Not finished</span>';
  var actLabel = (j.paperwork_state === 'sent') ? 'View' : 'Review';
  var act = '<button class="btn btn-primary btn-sm" onclick="navigate(\'completion-paperwork\',' + j.work_order_id + ')">' + actLabel + '</button>';
  return '<tr>' +
    '<td><span style="color:var(--text);font-weight:600">' + escHtml(_pwJobLabel(j)) + '</span>' +
      '<div style="color:var(--text-muted-color);font-size:12px">' + (_pwWoIfDifferent(j) ? 'WO ' + escHtml(_pwWoIfDifferent(j)) + ' &middot; ' : '') + (r.trips_total || 0) + ' trip' + (r.trips_total === 1 ? '' : 's') + '</div></td>' +
    '<td>' + escHtml(j.account_name || '-') + (j.delivery_method === 'portal' ? ' <span class="badge badge-draft" title="Uploaded in the account portal, not emailed">Portal</span>' : '') + '</td>' +
    '<td>' + store + city + '</td>' +
    '<td>' + _pwDate(j.last_trip_completed_at || j.completed_at) +
      ((_pwTab === 'needs_review' && j.age_bdays != null) ? '<div style="font-size:12px;color:' + (j.stale ? '#f87171;font-weight:600' : 'var(--text-muted-color)') + '">' + j.age_bdays + ' business day' + (j.age_bdays === 1 ? '' : 's') + (j.stale ? ' &#9888;' : '') + '</div>' : '') +
      ((j.paperwork_state === 'sent' && j.billed_at) ? '<div style="font-size:12px;color:var(--text-muted-color)">Billed ' + _pwDate(j.billed_at) + '</div>' : '') + '</td>' +
    '<td>' + inv + '</td>' +
    '<td>' + chips + '</td>' +
    '<td>' + pwStateBadge(j.paperwork_state, r.blocked) + pwDeliveryChip(j) + '</td>' +
    '<td>' + act + '</td>' +
    '</tr>';
}

// ---------- Job review ----------
async function pwRenderJob(el, id) {
  el.innerHTML = '<div class="loading">Loading&hellip;</div>';
  var d;
  try { d = await api('GET', '/paperwork/job/' + id); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>'; return; }
  _pwJob = d;
  var j = d.job, r = j.readiness || {};

  function rlRow(ok, warn, title, detail) {
    var mark = ok ? PW_CHECK : (warn ? PW_WARN : PW_BAD);
    return '<div style="display:flex;gap:12px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--border-light)">' +
      '<div style="width:22px;text-align:center;font-size:15px">' + mark + '</div>' +
      '<div><div style="font-size:13.5px;font-weight:600;color:var(--text)">' + escHtml(title) + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:2px">' + detail + '</div></div></div>';
  }
  var recips = d.recipients || { to: [], cc: [], replyTo: '' };
  var acct = d.account || {};
  var isPortal = acct.delivery === 'portal';
  var readinessCard =
    '<div class="card"><div class="card-header"><div class="card-title">Readiness</div>' +
      (r.ready ? '<span class="badge badge-completed">Ready to send</span>' : '<span class="badge badge-draft">Blocked</span>') + '</div>' +
    '<div class="card-body" style="padding-top:4px;padding-bottom:4px">' +
      rlRow(r.final_trip_signed, false, 'Final trip signed off', 'The last trip is marked Work 100% complete and signed on site.') +
      rlRow(r.invoice_finished, false, 'Invoice ' + (j.invoice_number ? '#' + escHtml(j.invoice_number) + ' finished' : 'finished'), r.invoice_finished ? (_pwMoney(j.grand_total) + ' &middot; ' + escHtml(j.invoice_status || '')) : 'No finished invoice on this job yet. Finish the invoice and it becomes ready.') +
      rlRow(r.trips_signed >= r.trips_total && r.trips_total > 0, r.trips_total === 0, (r.trips_signed) + ' of ' + (r.trips_total) + ' sign-off sheet' + (r.trips_total === 1 ? '' : 's') + ' signed', 'One PDF per trip.') +
      rlRow(r.photo_count > 0, true, r.photo_count + ' job photo' + (r.photo_count === 1 ? '' : 's'), 'Attached as separate images and embedded in the sign-offs.') +
      ((r.checkin && r.checkin.applies) ? rlRow(r.checkin.ok, true, _pwCheckinText(r.checkin), r.checkin.ok ? 'The account asked for a check-in and it is on file.' : 'The work order says this account requires it. Many accounts reject a bill without it. If the tech called in from his own phone, you can still send.') : '') +
      (isPortal ? rlRow(true, false, 'Portal account', 'Upload the PDFs in the account portal, then click Submitted in portal.')
        : rlRow(recips.to.length > 0, false, 'Recipients resolved', recips.to.length + ' account inbox &middot; ' + recips.cc.length + ' Cc' + (recips.replyTo ? ' &middot; reply-to set' : '') + (recips.overridden ? ' &middot; custom for this job' : ''))) +
    '</div></div>';

  var man = d.manifest || [];
  // Each attachment opens the real record it is built from (Tony 2026-09-24:
  // "I need to be able to open this invoice and sign off sheet"). The invoice
  // also gets Edit, gated like the Edit button on the invoice page itself: a
  // paid invoice is only editable by admin/owner/manager/coordinator
  // (LOCKED_EDIT_ROLES in routes/invoices.js), and the server re-checks on PUT.
  // pwOpen/pwEditInvoice remember this job so Back on those pages returns here.
  var sheets = d.sheets || [];
  function sheetIdFor(m) {
    if (m.id) return m.id;
    for (var i = 0; i < sheets.length; i++) { if (Number(sheets[i].trip_number || 1) === Number(m.trip || 1)) return sheets[i].id; }
    return sheets.length ? sheets[0].id : null;
  }
  var woId = j.work_order_id;
  var canOpenSo = can('view_signoffs'), canOpenInv = can('view_invoices');
  var invEditRoles = ['admin', 'owner', 'manager', 'locksmith_coordinator'];
  var canEditInv = invEditRoles.indexOf(state.user && state.user.role) !== -1 && j.invoice_status !== 'canceled';
  var attList = man.map(function (m) {
    if (m.kind === 'photos') {
      var lastSo = sheets.length ? sheets[sheets.length - 1].id : null;
      var phBtn = (canOpenSo && lastSo) ? pwAttBtn('View on sign-off', 'pwOpen(\'signoff\',' + lastSo + ',' + woId + ')') : '';
      return pwAttRow('IMG', m.count + ' job photos', _pwMB(m.bytes) + ' MB &middot; separate images', phBtn);
    }
    if (m.kind === 'signoff') {
      var sid = sheetIdFor(m);
      var soOpen = (canOpenSo && sid) ? 'pwOpen(\'signoff\',' + sid + ',' + woId + ')' : '';
      var soPdf = sid ? pwAttBtn('View PDF', 'pwViewPdf(' + woId + ',\'signoff\',' + sid + ',this)') : '';
      return pwAttRow('PDF', m.name, 'sign-off sheet', soPdf + (soOpen ? pwAttBtn('Open sign-off', soOpen) : ''), sid ? 'pwViewPdf(' + woId + ',\'signoff\',' + sid + ')' : '');
    }
    var iid = m.id || j.invoice_id;
    var invOpen = (canOpenInv && iid) ? 'pwOpen(\'invoice\',' + iid + ',' + woId + ')' : '';
    var btns = (iid ? pwAttBtn('View PDF', 'pwViewPdf(' + woId + ',\'invoice\',' + iid + ',this)') : '') +
      (invOpen ? pwAttBtn('Open invoice', invOpen) : '') +
      ((canEditInv && iid) ? pwAttBtn('Edit', 'pwEditInvoice(' + iid + ',' + woId + ')') : '');
    return pwAttRow('PDF', m.name, 'invoice', btns, iid ? 'pwViewPdf(' + woId + ',\'invoice\',' + iid + ')' : '');
  }).join('');
  var maxBytes = (d.max_mb || 20) * 1048576;
  var pct = Math.min(100, Math.round((d.size_bytes / maxBytes) * 100));
  var over = d.size_bytes > maxBytes;
  var sizeBar =
    '<div style="display:flex;align-items:center;gap:12px;padding:12px 0 2px">' +
      '<div style="flex-shrink:0;font-size:12px;color:var(--text-muted-color);font-weight:600">Package size (est.)</div>' +
      '<div style="flex:1;height:8px;border-radius:5px;background:#242424;overflow:hidden"><div style="width:' + pct + '%;height:100%;background:' + (over ? 'var(--danger)' : 'var(--success)') + '"></div></div>' +
      '<div style="flex-shrink:0;font-size:12px;color:' + (over ? '#f87171' : 'var(--text-dim)') + '">' + _pwMB(d.size_bytes) + ' of ' + (d.max_mb || 20) + ' MB</div>' +
    '</div>' +
    (over ? '<div style="font-size:12px;color:#f6b2b2;background:#2d0d0d;border:1px solid #4d1515;border-radius:6px;padding:8px 11px;margin-top:8px">Over the ' + (d.max_mb || 20) + ' MB limit. At send time you can drop photos to get under; they stay embedded in the sign-off PDFs.</div>' : '');
  var attCard =
    '<div class="card"><div class="card-header"><div class="card-title">Attachments</div><span style="font-size:12px;color:var(--text-muted-color)">' + man.length + ' item' + (man.length === 1 ? '' : 's') + '</span></div>' +
    '<div class="card-body" style="padding-top:6px">' + (attList || '<div style="color:var(--text-muted-color);font-size:13px">Nothing to attach.</div>') + sizeBar + '</div></div>';

  var emailCard =
    '<div class="card"><div class="card-header"><div class="card-title">Email preview</div></div><div class="card-body">' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:3px">Subject</div>' +
      '<div style="font-size:14px;color:var(--text);font-weight:600;margin-bottom:12px">' + escHtml(d.subject || '') + '</div>' +
      '<div style="background:#fff;border-radius:8px;padding:14px;max-height:320px;overflow:auto">' + (d.body_html || '') + '</div>' +
    '</div></div>';

  var canSend = can('send_completion_paperwork');
  var actions = '';
  var isSent = j.paperwork_state === 'sent' || j.wo_status === 'paperwork_sent';
  if (canSend && isPortal && !isSent) {
    if (acct.portal_url) actions += '<a class="btn btn-secondary" style="width:100%;justify-content:center;margin-bottom:8px" href="' + escHtml(/^https?:/i.test(acct.portal_url) ? acct.portal_url : 'https://' + acct.portal_url) + '" target="_blank" rel="noopener">Open the account portal &#8599;</a>';
    if (r.ready) actions += '<button class="btn btn-success" style="width:100%;justify-content:center;margin-bottom:8px" onclick="pwPortalSubmitted(' + j.work_order_id + ')">Submitted in portal</button>';
    if (j.paperwork_state === 'none' || j.paperwork_state === 'failed') actions += '<button class="btn btn-secondary" style="width:100%;justify-content:center;margin-bottom:8px" onclick="pwHold(' + j.work_order_id + ')">Hold this job</button>';
    if (j.paperwork_state === 'held' || j.paperwork_state === 'failed') actions += '<button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="pwReset(' + j.work_order_id + ')">Back to needs review</button>';
  } else if (canSend) {
    if (r.ready && (j.paperwork_state === 'none' || j.paperwork_state === 'held')) {
      actions += '<button class="btn btn-primary btn-lg" style="width:100%;justify-content:center;margin-bottom:8px" onclick="pwMarkReady(' + j.work_order_id + ')">Mark Ready to Send</button>';
    }
    if (r.ready && j.paperwork_state !== 'sent' && j.paperwork_state !== 'sending') {
      actions += '<button class="btn btn-success" style="width:100%;justify-content:center;margin-bottom:8px" onclick="pwSendNow(' + j.work_order_id + ')">Send now</button>';
    }
    if (j.paperwork_state === 'none' || j.paperwork_state === 'ready' || j.paperwork_state === 'failed') {
      actions += '<button class="btn btn-secondary" style="width:100%;justify-content:center;margin-bottom:8px" onclick="pwHold(' + j.work_order_id + ')">Hold this job</button>';
    }
    if (j.paperwork_state === 'ready' || j.paperwork_state === 'held' || j.paperwork_state === 'failed') {
      actions += '<button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="pwReset(' + j.work_order_id + ')">Back to needs review</button>';
    }
    if (isSent && !isPortal) {
      actions += '<button class="btn btn-secondary" style="width:100%;justify-content:center;margin-bottom:8px" onclick="pwShowResend()">Resend to another address</button>' +
        '<div id="pw-resend-box" style="display:none;margin-bottom:10px"></div>';
    }
  }
  if (canSend) {
    if (isSent && can('manage_completion_paperwork')) {
      actions += '<button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="pwReopenSent(' + j.work_order_id + ')">Move back to needs review</button>';
    }
  }
  var sendNote = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-light);font-size:12px;color:var(--text-muted-color)">' +
    (isSent ? ('Sent' + (j.billed_at ? '. Billed to the account ' + _pwDate(j.billed_at) + '; A/R ages from that date.' : '.'))
      : isPortal ? 'This account takes paperwork through its portal, so it never goes in the email batch. Use View PDF on each attachment to download it, upload them in the portal, then click Submitted in portal.'
      : ((j.paperwork_state === 'ready' ? 'Queued for the next 5:00 PM batch.' : 'Marking ready queues this job for the 5:00 PM batch.') + ' Send now emails it to the account immediately.')) +
    '</div>';
  var sendCard = '<div class="card"><div class="card-header"><div class="card-title">Send</div></div><div class="card-body">' +
    (actions || '<div style="font-size:13px;color:var(--text-muted-color)">You do not have send access.</div>') + (canSend ? sendNote : '') + '</div></div>';

  function recipList(label, arr, tag) {
    if (!arr || !arr.length) return '<div style="font-size:11px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 2px">' + label + '</div><div style="font-size:13px;color:var(--text-muted-color)">none</div>';
    return '<div style="font-size:11px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 2px">' + label + '</div>' +
      arr.map(function (e) { return '<div style="font-size:13px;padding:5px 0;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;gap:8px"><span>' + escHtml(e) + '</span>' + (tag ? '<span style="font-size:11px;color:var(--text-muted-color)">' + tag + '</span>' : '') + '</div>'; }).join('');
  }
  var canEditRecips = canSend && !isPortal && ['none', 'ready', 'held', 'failed'].indexOf(j.paperwork_state) !== -1;
  var recipHeadBtns = canEditRecips
    ? '<span style="display:flex;gap:6px">' + (recips.overridden ? '<button class="btn btn-ghost btn-sm" onclick="pwClearRecipients(' + j.work_order_id + ')" title="Go back to the account&#39;s saved recipients">Use account default</button>' : '') +
      '<button class="btn btn-secondary btn-sm" onclick="pwEditRecipients()">Edit</button></span>' : '';
  var recipCard = isPortal ? '' : '<div class="card"><div class="card-header"><div class="card-title">Recipients</div>' + recipHeadBtns + '</div><div class="card-body" style="padding-top:4px">' +
    '<div id="pw-recip-edit" style="display:none"></div>' +
    (recips.overridden ? '<div style="font-size:12px;color:#fbbf24;margin-top:6px">Custom for this job only. The account&#39;s saved recipients are unchanged.</div>' : '') +
    recipList('To', recips.to, recips.overridden ? 'this job' : 'account') +
    recipList('Cc', recips.cc, '') +
    (recips.replyTo ? '<div style="font-size:11px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 2px">Reply-to</div><div style="font-size:13px">' + escHtml(recips.replyTo) + '</div>' : '') +
    (recips.to.length ? '' : '<div style="font-size:12px;color:#f6b2b2;margin-top:8px">No To address. Set it in Invoice Setup &rarr; Configure for this account.</div>') +
    '</div></div>';

  var sends = d.sends || [];
  var histCard = !sends.length ? '' : '<div class="card"><div class="card-header"><div class="card-title">History</div></div><div class="card-body" style="padding-top:4px">' +
    sends.map(function (x) {
      var what = x.kind === 'portal' ? 'Submitted in portal' + (x.portal_ref ? ' &middot; ref ' + escHtml(x.portal_ref) : '')
        : (x.kind === 'resend' ? 'Resent' : 'Sent') + ' to ' + escHtml((x.to_emails || []).join(', '));
      var st = x.status === 'failed' ? ' <span class="badge badge-rejected">Failed</span>' : pwDeliveryChip({ delivery: x.last_event });
      return '<div style="font-size:12.5px;padding:7px 0;border-bottom:1px solid var(--border-light)">' +
        '<div style="color:var(--text)">' + what + st + '</div>' +
        '<div style="color:var(--text-muted-color);font-size:11.5px">' + escHtml(new Date(x.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + (x.sent_by_name ? ' &middot; ' + escHtml(x.sent_by_name) : ' &middot; batch') +
        (x.error ? '<div style="color:#f87171">' + escHtml(x.error) + '</div>' : '') + '</div></div>';
    }).join('') + '</div></div>';

  var head = escHtml(j.account_name || '') + ' &middot; ' + escHtml(_pwJobLabel(j));
  var sub = [escHtml(_pwStore(j)), j.city_state_zip ? escHtml(j.city_state_zip) : '', _pwWoIfDifferent(j) ? 'WO ' + escHtml(_pwWoIfDifferent(j)) : '', 'Completed ' + _pwDate(j.last_trip_completed_at || j.completed_at)].filter(Boolean).join(' &middot; ');

  el.innerHTML =
    '<div style="margin-bottom:6px"><span style="color:var(--primary);cursor:pointer;font-size:13px" onclick="navigate(\'completion-paperwork\')">&larr; Completion Paperwork</span></div>' +
    '<div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">' +
      '<div><div class="page-title">' + head + '</div>' +
      '<div style="color:var(--text-muted-color);font-size:13px;margin-top:2px">' + sub + '</div></div>' +
      '<div style="flex-shrink:0">' + pwStateBadge(j.paperwork_state, r.blocked) + pwDeliveryChip(j) + '</div></div>' +
    '<div id="pw-job-msg"></div>' +
    '<div style="display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start;margin-top:8px" class="pw-job-grid">' +
      '<div>' + readinessCard + '<div style="height:16px"></div>' + attCard + '<div style="height:16px"></div>' + emailCard + '</div>' +
      '<div>' + sendCard + (recipCard ? '<div style="height:16px"></div>' + recipCard : '') + (histCard ? '<div style="height:16px"></div>' + histCard : '') + '</div>' +
    '</div>';
}

// btns: optional right-aligned buttons. openJs: optional onclick for the
// icon + name, so clicking the file itself opens it too.
function pwAttRow(kind, name, meta, btns, openJs) {
  var bg = kind === 'PDF' ? '#7f1d1d' : '#334155';
  var click = openJs ? ' onclick="' + openJs + '" style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;cursor:pointer" title="Open"' : ' style="display:flex;align-items:center;gap:12px;flex:1;min-width:0"';
  return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-light)">' +
    '<div' + click + '>' +
    '<div style="width:30px;height:36px;border-radius:5px;background:' + bg + ';color:#fff;font-size:9px;font-weight:700;display:flex;align-items:flex-end;justify-content:center;padding-bottom:3px;flex-shrink:0">' + kind + '</div>' +
    '<div style="min-width:0"><div style="font-size:13px;color:' + (openJs ? 'var(--primary)' : 'var(--text)') + ';font-weight:500">' + escHtml(name) + '</div>' +
    '<div style="font-size:11.5px;color:var(--text-muted-color)">' + meta + '</div></div></div>' +
    (btns ? '<div style="display:flex;gap:6px;flex-shrink:0">' + btns + '</div>' : '') +
    '</div>';
}
function pwAttBtn(label, js) {
  return '<button class="btn btn-secondary btn-sm" onclick="' + js + '">' + label + '</button>';
}

// Show the exact PDF the email will attach (built server-side by the send
// path). The tab is opened synchronously so popup blockers allow it, then
// pointed at the blob once it arrives; if no tab could open (some phones /
// the Android shell) it downloads instead.
async function pwViewPdf(woId, kind, ref, btn) {
  var label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Building&hellip;'; }
  var win = null;
  try { win = window.open('', '_blank'); } catch (e) { win = null; }
  if (win) { try { win.document.write('<p style="font-family:sans-serif;padding:20px">Building PDF&hellip;</p>'); } catch (e) {} }
  try {
    var res = await fetch('/api/paperwork/job/' + woId + '/pdf?kind=' + encodeURIComponent(kind) + '&ref=' + encodeURIComponent(ref),
      { headers: state.token ? { 'Authorization': 'Bearer ' + state.token } : {} });
    if (!res.ok) {
      var msg = 'Could not build the PDF';
      try { var j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    var blob = await res.blob();
    var url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    if (win && !win.closed) win.location.href = url;
    else {
      var cd = res.headers.get('Content-Disposition') || '';
      var mm = /filename="([^"]+)"/.exec(cd);
      var a = document.createElement('a'); a.href = url; a.download = mm ? mm[1] : (kind + '.pdf');
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  } catch (e) {
    if (win && !win.closed) { try { win.close(); } catch (x) {} }
    _pwMsg(escHtml(e.message), false);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}

// Open an attachment's source record, remembering which paperwork job we came
// from so the Back button on the invoice / sign-off page returns to this job
// instead of the Invoices or Sign-Off list.
var _pwReturn = null;
function pwOpen(kind, id, woId) {
  _pwReturn = { kind: kind, id: String(id), wo: woId };
  navigate(kind === 'invoice' ? 'view-invoice' : 'view-signoff', id);
}
function pwEditInvoice(id, woId) {
  // Edit saves back to view-invoice, whose Back then lands here.
  _pwReturn = { kind: 'invoice', id: String(id), wo: woId };
  navigate('edit-invoice', id);
}
// Called by the Back buttons in app.js (renderViewInvoice / renderViewSignoff).
// Returns true when it handled the navigation.
function pwReturnNav(kind, id) {
  if (!_pwReturn || _pwReturn.kind !== kind || _pwReturn.id !== String(id)) return false;
  var wo = _pwReturn.wo; _pwReturn = null;
  navigate('completion-paperwork', wo);
  return true;
}
function pwReturnLabel(kind, id) {
  return (_pwReturn && _pwReturn.kind === kind && _pwReturn.id === String(id)) ? '&larr; Completion Paperwork' : '';
}

function _pwMsg(html, ok) {
  var m = document.getElementById('pw-job-msg');
  if (m) m.innerHTML = '<div class="alert ' + (ok ? 'alert-success' : 'alert-error') + '" style="margin:8px 0">' + html + '</div>';
}

async function pwMarkReady(id) {
  try { await api('PUT', '/paperwork/job/' + id + '/ready', { overrides: null }); apiBustCache('/paperwork/queue'); navigate('completion-paperwork'); }
  catch (e) { _pwMsg(escHtml(e.message), false); }
}
async function pwHold(id) {
  try { await api('PUT', '/paperwork/job/' + id + '/hold', {}); apiBustCache('/paperwork/queue'); navigate('completion-paperwork'); }
  catch (e) { _pwMsg(escHtml(e.message), false); }
}
async function pwReset(id) {
  try { await api('PUT', '/paperwork/job/' + id + '/reset', {}); apiBustCache('/paperwork/queue'); pwRenderJob(_pwEl, id); }
  catch (e) { _pwMsg(escHtml(e.message), false); }
}
function _pwEmailsInput(id, arr, ph) {
  return '<input type="text" id="' + id + '" value="' + escHtml((arr || []).join(', ')) + '" placeholder="' + ph + '" style="width:100%;margin-bottom:8px" />';
}
function pwEditRecipients() {
  var box = document.getElementById('pw-recip-edit'); if (!box || !_pwJob) return;
  var rc = _pwJob.recipients || {};
  box.style.display = 'block';
  box.innerHTML = '<div style="font-size:11px;color:var(--text-muted-color);margin:8px 0 3px">To (this job only, comma separated)</div>' + _pwEmailsInput('pw-rc-to', rc.to, 'billing@account.com') +
    '<div style="font-size:11px;color:var(--text-muted-color);margin-bottom:3px">Cc (replaces the Cc list for this job, internal Cc included)</div>' + _pwEmailsInput('pw-rc-cc', rc.cc, 'ar@popalockar.com') +
    '<div style="display:flex;gap:6px;margin-bottom:6px"><button class="btn btn-primary btn-sm" onclick="pwSaveRecipients(' + _pwJob.job.work_order_id + ')">Save for this job</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="pwCancelRecipients()">Cancel</button></div>';
}
function pwCancelRecipients() { var b = document.getElementById('pw-recip-edit'); if (b) b.style.display = 'none'; }
async function pwSaveRecipients(id) {
  try {
    await api('PUT', '/paperwork/job/' + id + '/recipients', { to: document.getElementById('pw-rc-to').value, cc: document.getElementById('pw-rc-cc').value });
    apiBustCache('/paperwork/queue'); pwRenderJob(_pwEl, id);
  } catch (e) { _pwMsg(escHtml(e.message), false); }
}
async function pwClearRecipients(id) {
  try { await api('PUT', '/paperwork/job/' + id + '/recipients', { clear: true }); apiBustCache('/paperwork/queue'); pwRenderJob(_pwEl, id); }
  catch (e) { _pwMsg(escHtml(e.message), false); }
}
// Resend the same package to another address (Sent tab). Defaults the Cc to
// what the last email went to, leaves To blank on purpose.
function pwShowResend() {
  var box = document.getElementById('pw-resend-box'); if (!box || !_pwJob) return;
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  var last = (_pwJob.sends || []).filter(function (x) { return x.kind !== 'portal'; })[0] || {};
  box.style.display = 'block';
  box.innerHTML = '<div style="font-size:11px;color:var(--text-muted-color);margin:4px 0 3px">To</div>' + _pwEmailsInput('pw-rs-to', [], 'the address they say never got it') +
    '<div style="font-size:11px;color:var(--text-muted-color);margin-bottom:3px">Cc</div>' + _pwEmailsInput('pw-rs-cc', last.cc_emails || (_pwJob.recipients || {}).cc, '') +
    '<button class="btn btn-primary btn-sm" style="width:100%;justify-content:center" onclick="pwResend(' + _pwJob.job.work_order_id + ', this)">Resend the package</button>';
}
async function pwResend(id, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = 'Sending&hellip;'; }
  try {
    await api('POST', '/paperwork/job/' + id + '/resend', { to: document.getElementById('pw-rs-to').value, cc: document.getElementById('pw-rs-cc').value });
    apiBustCache('/paperwork/queue'); await pwRenderJob(_pwEl, id); _pwMsg('Resent.', true);
  } catch (e) { _pwMsg(escHtml(e.message), false); if (btn) { btn.disabled = false; btn.innerHTML = 'Resend the package'; } }
}
async function pwPortalSubmitted(id) {
  var ref = await novaPrompt('Uploaded in the portal? Add the portal confirmation or invoice # if it gave you one (optional).', '', { title: 'Submitted in portal', okText: 'Mark submitted' });
  if (ref === null || ref === false) return;
  try { await api('POST', '/paperwork/job/' + id + '/portal-submitted', { ref: String(ref || '') }); apiBustCache('/paperwork/queue'); pwRenderJob(_pwEl, id); }
  catch (e) { _pwMsg(escHtml(e.message), false); }
}

async function pwReopenSent(id) {
  if (!await novaConfirm('Move this job back to Needs Review? The email that already went out is not recalled; this only puts the job back in the queue so it can be sent again.', { title: 'Reopen sent job', okText: 'Move back' })) return;
  return pwReset(id);
}
async function pwSendNow(id) {
  if (!(await novaConfirm('Send this completion paperwork to the account now? It emails them immediately.'))) return;
  _pwMsg('Sending&hellip;', true);
  try {
    var out = await api('POST', '/paperwork/job/' + id + '/send-now', {});
    apiBustCache('/paperwork/queue');
    if (out && out.sent) { navigate('completion-paperwork'); }
    else { _pwMsg(escHtml((out && out.error) || 'The send did not complete.'), false); }
  } catch (e) { _pwMsg(escHtml(e.message), false); }
}

// ---------- Delivery Settings card ----------
async function pwRenderSettings(el) {
  if (!can('manage_completion_paperwork')) { el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
  el.innerHTML = '<div class="loading">Loading&hellip;</div>';
  var s;
  try { s = await api('GET', '/paperwork/settings'); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>'; return; }
  var cc = (s.completion_internal_cc || []).join(', ');
  el.innerHTML =
    '<div style="margin-bottom:6px"><span style="color:var(--primary);cursor:pointer;font-size:13px" onclick="navigate(\'completion-paperwork\')">&larr; Completion Paperwork</span></div>' +
    '<div class="page-header"><div class="page-title">Completion Paperwork Delivery</div></div>' +
    '<div id="pw-set-msg"></div>' +
    '<div class="card" style="max-width:720px"><div class="card-body">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:6px"><input type="checkbox" id="pw-s-enabled" style="width:auto"' + (s.completion_send_enabled ? ' checked' : '') + ' /> <span style="font-weight:600">Send queued paperwork automatically</span></label>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin:-2px 0 14px">Off by default. When on, Nova sends every job marked Ready at the time below. The 5:00 PM batch itself goes live in a later update.</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">' +
        '<div class="form-group"><label>Send time (24h, HH:MM)</label><input type="text" id="pw-s-time" value="' + escHtml(s.completion_send_time || '17:00') + '" placeholder="17:00" /></div>' +
        '<div class="form-group"><label>Max attachment size (MB)</label><input type="number" id="pw-s-max" value="' + escHtml(s.completion_max_attach_mb || 20) + '" min="1" max="40" /></div>' +
      '</div>' +
      '<div class="form-group"><label>Standing internal Cc (comma separated, added to every send)</label><input type="text" id="pw-s-cc" value="' + escHtml(cc) + '" placeholder="tony@popalockar.com, russ@popalockar.com" /></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">' +
        '<div class="form-group"><label>From (blank = the system default, Nova &lt;noreply@&hellip;&gt;)</label><input type="text" id="pw-s-from" value="' + escHtml(s.completion_from || '') + '" placeholder="Pop-A-Lock Billing &lt;billing@popalockar.com&gt;" />' +
          '<div style="font-size:11.5px;color:var(--text-muted-color);margin-top:4px">Use the form <b>Name &lt;address&gt;</b>. The name is what the account sees in their inbox. The address must be on popalockar.com (the domain verified with the email provider), or the send fails. Replies go to the Reply-to below, not this address.</div></div>' +
        '<div class="form-group"><label>Default reply-to</label><input type="text" id="pw-s-reply" value="' + escHtml(s.completion_reply_to || '') + '" placeholder="lscall@popalockar.com" /></div>' +
      '</div>' +
      '<div class="form-group"><label>Subject template ({po}, {invoice}, {account}, {wo})</label><input type="text" id="pw-s-subj" value="' + escHtml(s.completion_subject_template || '') + '" /></div>' +
      '<div class="form-group"><label>Signature block (blank = company info)</label><textarea id="pw-s-sig" rows="3" style="width:100%;resize:vertical">' + escHtml(s.completion_signature || '') + '</textarea></div>' +
      '<div style="border-top:1px solid var(--border-light);margin:6px 0 14px;padding-top:14px">' +
        '<div style="font-size:12px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:8px">Stale job reminder</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:10px">Jobs that sit in Needs Review this many business days (weekends and holidays skipped) are flagged red in the queue and emailed in one list each business-day morning. 0 turns it off. Runs even while the 5 PM auto-send is off.</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">' +
          '<div class="form-group"><label>Flag after (business days)</label><input type="number" id="pw-s-stale-days" min="0" max="30" value="' + escHtml(s.completion_stale_days == null ? 2 : s.completion_stale_days) + '" /></div>' +
          '<div class="form-group"><label>Email time (24h, HH:MM)</label><input type="text" id="pw-s-stale-time" value="' + escHtml(s.completion_stale_time || '08:00') + '" placeholder="08:00" /></div>' +
        '</div>' +
        '<div class="form-group"><label>Email the list to (comma separated)</label><input type="text" id="pw-s-stale-to" value="' + escHtml((s.completion_stale_notify || []).join(', ')) + '" placeholder="tony@popalockar.com" /></div>' +
        '<div style="display:flex;gap:8px;margin-bottom:6px"><button class="btn btn-secondary" onclick="pwStaleCheck(true)">Preview who is stale</button><button class="btn btn-secondary" onclick="pwStaleCheck(false)">Send the reminder now</button></div>' +
        '<div id="pw-stale-status" style="font-size:13px;color:var(--text-muted-color)"></div>' +
      '</div>' +
      '<div style="border-top:1px solid var(--border-light);margin:6px 0 14px;padding-top:14px">' +
        '<div style="font-size:12px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:8px">Run</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:10px"><button class="btn btn-primary" onclick="pwRunNow()">Run batch now</button><button class="btn btn-secondary" onclick="pwDryRun()">Dry run (preview counts)</button></div>' +
        '<div id="pw-runstatus" style="font-size:13px;color:var(--text-muted-color)"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" onclick="pwSaveSettings()">Save settings</button></div>' +
    '</div></div>';
  pwLoadRunStatus();
}

async function pwLoadRunStatus() {
  var box = document.getElementById('pw-runstatus'); if (!box) return;
  try {
    var s = await api('GET', '/paperwork/run-status');
    var t = s.today || {};
    box.innerHTML = 'Last daily run: <span style="color:var(--text-dim)">' + escHtml(s.last_run_date || 'never') + '</span> &middot; today: ' + (t.sent || 0) + ' sent, ' + (t.failed || 0) + ' failed.';
  } catch (e) { box.innerHTML = ''; }
}
async function pwRunNow() {
  if (!(await novaConfirm('Send every job marked Ready to its account now?'))) return;
  var box = document.getElementById('pw-runstatus'); if (box) box.innerHTML = 'Running&hellip;';
  try { var out = await api('POST', '/paperwork/run-now', {}); if (box) box.innerHTML = 'Batch: ' + (out.sent || 0) + ' sent, ' + (out.failed || 0) + ' failed of ' + (out.total || 0) + '.'; }
  catch (e) { if (box) box.innerHTML = '<span style="color:#f87171">' + escHtml(e.message) + '</span>'; }
}
async function pwDryRun() {
  var box = document.getElementById('pw-runstatus'); if (box) box.innerHTML = 'Building&hellip;';
  try { var out = await api('POST', '/paperwork/dry-run', {}); if (box) box.innerHTML = 'Dry run: ' + (out.total || 0) + ' job(s) would send now.'; }
  catch (e) { if (box) box.innerHTML = '<span style="color:#f87171">' + escHtml(e.message) + '</span>'; }
}

async function pwStaleCheck(dry) {
  var box = document.getElementById('pw-stale-status'); if (box) box.innerHTML = 'Checking&hellip;';
  if (!dry && !(await novaConfirm('Email the stale-job list now? Save settings first if you just changed the recipients.'))) { if (box) box.innerHTML = ''; return; }
  try {
    var out = await api('POST', '/paperwork/stale-check', { dry_run: !!dry });
    var jobs = out.jobs || [];
    var list = jobs.map(function (j) { return escHtml(_pwJobLabel(j)) + ' (' + escHtml(j.account_name || '') + ', ' + j.age_bdays + 'd)'; }).join(', ');
    if (box) box.innerHTML = (out.skipped === 'off' ? 'The reminder is off (0 days).' :
      (jobs.length ? jobs.length + ' stale: ' + list : 'Nothing is stale right now.') +
      (dry ? '' : (out.sent ? ' Emailed.' : (out.skipped === 'no recipients' ? ' Not emailed: no recipients set.' : ''))));
  } catch (e) { if (box) box.innerHTML = '<span style="color:#f87171">' + escHtml(e.message) + '</span>'; }
}

async function pwSaveSettings() {
  var g = function (id) { var e = document.getElementById(id); return e ? e.value : undefined; };
  var patch = {
    completion_send_enabled: (document.getElementById('pw-s-enabled') || {}).checked === true,
    completion_send_time: g('pw-s-time'),
    completion_max_attach_mb: g('pw-s-max'),
    completion_internal_cc: g('pw-s-cc'),
    completion_from: g('pw-s-from'),
    completion_reply_to: g('pw-s-reply'),
    completion_subject_template: g('pw-s-subj'),
    completion_signature: g('pw-s-sig'),
    completion_stale_days: g('pw-s-stale-days'),
    completion_stale_time: g('pw-s-stale-time'),
    completion_stale_notify: g('pw-s-stale-to')
  };
  var m = document.getElementById('pw-set-msg');
  try {
    await api('PUT', '/paperwork/settings', patch);
    if (m) m.innerHTML = '<div class="alert alert-success" style="margin:8px 0">Settings saved.</div>';
    setTimeout(function () { if (m) m.innerHTML = ''; }, 2500);
  } catch (e) { if (m) m.innerHTML = '<div class="alert alert-error" style="margin:8px 0">' + escHtml(e.message) + '</div>'; }
}
