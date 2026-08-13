/* Nova - Data Sync (inbound webhooks)
 * ---------------------------------------------------------------------------
 * The screen for everything utils/webhookIngest.js receives. Three tabs:
 *
 *   Traffic   what is arriving, per event type, INCLUDING what the filter
 *             dropped. This is the screen you watch for a day before deciding
 *             what a firehose source should accept.
 *   Events    the log. Every delivery, its status, and its stored payload.
 *   Sources   the partners, their URLs, their tokens.
 *
 * House style (CLAUDE.md): string concatenation, no backticks, and &#39; for an
 * apostrophe inside an HTML string. Mirrors public/js/ap.js on purpose.
 * --------------------------------------------------------------------------- */

var _syncTab = 'traffic';          // traffic | events | sources
var _syncFilter = { source: '', status: '', q: '' };
var _syncSources = null;
var _syncHandlers = [];
var _syncSigning = false;      // does the server have a key to store signing secrets with
var _syncFormats = [];
var _syncSearchTimer = null;

function syncInjectStyles() {
  if (document.getElementById('sync-styles')) return;
  var css =
    '.sy-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap}' +
    '.sy-tab{padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-muted-color)}' +
    '.sy-tab.on{color:var(--primary);border-bottom-color:var(--primary)}' +
    '.sy-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}' +
    '.sy-card{background:var(--card-bg,rgba(127,127,127,.06));border:1px solid var(--border);border-radius:var(--radius);padding:13px 15px}' +
    '.sy-card .k{font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted-color)}' +
    '.sy-card .v{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:5px}' +
    '.sy-card .s{font-size:12px;color:var(--text-muted-color);margin-top:2px}' +
    '.sy-card.red .v{color:#f87171}.sy-card.amber .v{color:#f59e0b}.sy-card.violet .v{color:#a78bfa}' +
    '.sy-num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.sy-chip{display:inline-block;border-radius:5px;padding:2px 8px;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase}' +
    '.sy-chip.done{background:rgba(74,222,128,.15);color:#4ade80}' +
    '.sy-chip.pending{background:rgba(96,165,250,.15);color:#60a5fa}' +
    '.sy-chip.processing{background:rgba(96,165,250,.15);color:#60a5fa}' +
    '.sy-chip.skipped{background:rgba(148,163,184,.18);color:#94a3b8}' +
    '.sy-chip.parked{background:rgba(167,139,250,.16);color:#a78bfa}' +
    '.sy-chip.failed{background:rgba(248,113,113,.15);color:#f87171}' +
    '.sy-chip.off{background:rgba(148,163,184,.18);color:#94a3b8}' +
    '.sy-chip.on{background:rgba(74,222,128,.15);color:#4ade80}' +
    '.sy-note{font-size:12px;color:var(--text-muted-color);line-height:1.65}' +
    '.sy-warn{background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.35);border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.sy-good{background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.3);border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}' +
    '.sy-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}' +
    '.sy-pre{background:rgba(127,127,127,.08);border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto;max-height:420px;' +
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.55;white-space:pre;margin:0}' +
    '.sy-url{display:flex;align-items:center;gap:8px;background:rgba(127,127,127,.08);border:1px solid var(--border);' +
      'border-radius:8px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all}' +
    '.sy-bar{height:8px;border-radius:99px;background:rgba(127,127,127,.15);overflow:hidden;display:flex;min-width:90px}' +
    '.sy-bar i{display:block;height:100%}' +
    '.sy-bar i.st{background:#4ade80}.sy-bar i.dr{background:rgba(148,163,184,.55)}' +
    '.sy-kv{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:14px}' +
    '.sy-kv .lbl{color:var(--text-muted-color)}' +
    '.sy-row-click{cursor:pointer}' +
    '.sy-row-click:hover{background:rgba(127,127,127,.06)}';
  var st = document.createElement('style');
  st.id = 'sync-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function syncCan(p) {
  try { return can(p); } catch (e) { return false; }
}

function syncModal(title, bodyHtml, okLabel, onOk, wide) {
  syncCloseModal();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'sync-modal';
  overlay.innerHTML =
    '<div class="modal" style="max-width:' + (wide ? '860px' : '620px') + '">' +
      '<div class="modal-header"><span class="modal-title">' + escHtml(title) + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="syncCloseModal()">&#x2715;</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-secondary" onclick="syncCloseModal()">Close</button>' +
        (okLabel ? '<button class="btn btn-primary" id="sync-modal-ok">' + escHtml(okLabel) + '</button>' : '') +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  if (okLabel && onOk) document.getElementById('sync-modal-ok').onclick = onOk;
}

function syncCloseModal() {
  var m = document.getElementById('sync-modal');
  if (m) m.remove();
}

function syncCopy(text, label) {
  try {
    navigator.clipboard.writeText(text);
    showToast((label || 'Copied') + ' to clipboard', 'success');
  } catch (e) {
    showToast('Could not copy. Select it manually.', 'error');
  }
}

// Seconds matter here in a way they do not elsewhere in Nova. This is the
// screen where you ask "did the retry fire", "how long was it parked", "did
// these forty records arrive in one burst or over an hour" - and a date, or
// even a date and minute, cannot answer any of those.
function syncDateStr(v) {
  if (!v) return '';
  try {
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    return String(v).slice(0, 19).replace('T', ' ');
  }
}

function syncNum(n) {
  return Number(n || 0).toLocaleString();
}

/* ------------------------------------------------------------------- shell */

async function renderSync(content) {
  syncInjectStyles();
  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Data Sync</div>' +
      '<div class="page-subtitle">What partners are pushing into Nova, and what happened to it.</div></div>' +
      '<div class="flex-gap">' +
        '<button class="btn btn-secondary btn-sm" onclick="syncRefresh()">Refresh</button>' +
        (syncCan('manage_sync') ? '<button class="btn btn-primary btn-sm" onclick="syncNewSource()">Add a source</button>' : '') +
      '</div></div>' +
    '<div class="sy-tabs">' +
      '<div class="sy-tab' + (_syncTab === 'traffic' ? ' on' : '') + '" onclick="syncGo(\'traffic\')">Traffic</div>' +
      '<div class="sy-tab' + (_syncTab === 'events' ? ' on' : '') + '" onclick="syncGo(\'events\')">Events</div>' +
      '<div class="sy-tab' + (_syncTab === 'sources' ? ' on' : '') + '" onclick="syncGo(\'sources\')">Sources</div>' +
    '</div>' +
    '<div id="sync-body"></div>';

  // The source list feeds the filter dropdowns on every tab, so it is loaded
  // once here rather than per tab.
  try {
    var s = await api('GET', '/sync/sources');
    _syncSources = s.sources || [];
    _syncHandlers = s.handlers || [];
    _syncSigning = !!s.signing_available;
    _syncFormats = s.hmac_formats || [];
  } catch (e) { _syncSources = null; }

  await syncLoad();
}

function syncGo(t) {
  _syncTab = t;
  renderSync(document.getElementById('content') || document.querySelector('.content'));
}

function syncRefresh() {
  renderSync(document.getElementById('content') || document.querySelector('.content'));
}

async function syncLoad() {
  var body = document.getElementById('sync-body');
  if (!body) return;
  body.innerHTML = '<div class="card"><div class="card-body">Loading&hellip;</div></div>';

  if (_syncSources === null) {
    body.innerHTML = '<div class="alert alert-error">Could not read the sync sources.</div>';
    return;
  }

  // Nothing configured yet is the normal first-run state, and the honest thing
  // to show is what to do about it rather than an empty table.
  if (!_syncSources.length) {
    body.innerHTML =
      '<div class="card"><div class="card-body" style="text-align:center;padding:38px 20px">' +
        '<div style="font-size:17px;font-weight:700;margin-bottom:6px">No sync sources yet</div>' +
        '<div class="sy-note" style="max-width:520px;margin:0 auto 18px">' +
          'A source is one partner who can POST data into Nova. Creating one gives you a URL and a ' +
          'secret token to hand them. Their deliveries are stored the moment they arrive, whether or ' +
          'not Nova knows what to do with them yet.' +
        '</div>' +
        (syncCan('manage_sync')
          ? '<button class="btn btn-primary" onclick="syncNewSource()">Add the first source</button>'
          : '<div class="sy-note">Ask an admin to add one.</div>') +
      '</div></div>';
    return;
  }

  if (_syncTab === 'sources') return syncRenderSources(body);
  if (_syncTab === 'events') return syncRenderEvents(body);
  return syncRenderTraffic(body);
}

/* ----------------------------------------------------------------- traffic */

async function syncRenderTraffic(body) {
  var d;
  try { d = await api('GET', '/sync/stats' + (_syncFilter.source ? '?source=' + encodeURIComponent(_syncFilter.source) : '')); }
  catch (e) { body.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>'; return; }

  var rows = d.types || [];
  var totStored = 0, totDropped = 0;
  rows.forEach(function (r) { totStored += Number(r.stored_count || 0); totDropped += Number(r.dropped_count || 0); });
  var tot = totStored + totDropped;

  var html =
    '<div class="sy-cards">' +
      '<div class="sy-card"><div class="k">Delivered</div><div class="v">' + syncNum(tot) + '</div>' +
        '<div class="s">records seen, all time</div></div>' +
      '<div class="sy-card"><div class="k">Kept</div><div class="v">' + syncNum(totStored) + '</div>' +
        '<div class="s">stored as events</div></div>' +
      '<div class="sy-card"><div class="k">Filtered out</div><div class="v">' + syncNum(totDropped) + '</div>' +
        '<div class="s">' + (totDropped ? 'types not on the accept list' : 'nothing is being dropped') + '</div></div>' +
      '<div class="sy-card"><div class="k">Event types</div><div class="v">' + syncNum(rows.length) + '</div>' +
        '<div class="s">distinct codes seen</div></div>' +
    '</div>';

  html += syncSourcePicker();

  if (!rows.length) {
    html +=
      '<div class="card"><div class="card-body" style="text-align:center;padding:32px 20px">' +
        '<div style="font-weight:700;margin-bottom:6px">Nothing has arrived yet</div>' +
        '<div class="sy-note">Once the partner starts posting, every event type they send shows up here ' +
        'within a minute &mdash; including the ones being filtered out.</div>' +
      '</div></div>';
    body.innerHTML = html;
    return;
  }

  html +=
    '<div class="card"><div class="card-body" style="padding:0;overflow-x:auto">' +
    '<table class="table"><thead><tr>' +
      '<th>Event type</th><th>Source</th><th class="sy-num">Kept</th><th class="sy-num">Dropped</th>' +
      '<th style="width:130px">Mix</th><th>First seen</th><th>Last seen</th>' +
    '</tr></thead><tbody>';

  rows.forEach(function (r) {
    var st = Number(r.stored_count || 0), dr = Number(r.dropped_count || 0), n = st + dr || 1;
    var type = r.event_type === '' || r.event_type === null ? '<span class="sy-note">(no type)</span>'
      : '<span class="sy-mono">' + escHtml(r.event_type) + '</span>';
    html +=
      '<tr>' +
        '<td>' + type + '</td>' +
        '<td class="sy-note">' + escHtml(r.source_slug) + '</td>' +
        '<td class="sy-num">' + syncNum(st) + '</td>' +
        '<td class="sy-num">' + (dr ? syncNum(dr) : '<span class="sy-note">&mdash;</span>') + '</td>' +
        '<td><div class="sy-bar">' +
          '<i class="st" style="width:' + ((st / n) * 100).toFixed(1) + '%"></i>' +
          '<i class="dr" style="width:' + ((dr / n) * 100).toFixed(1) + '%"></i>' +
        '</div></td>' +
        '<td class="sy-note">' + escHtml(syncDateStr(r.first_seen)) + '</td>' +
        '<td class="sy-note">' + escHtml(syncDateStr(r.last_seen)) + '</td>' +
      '</tr>';
  });

  html += '</tbody></table></div></div>' +
    '<div class="sy-note" style="margin-top:10px">' + escHtml(d.note || '') + '</div>';

  body.innerHTML = html;
}

function syncSourcePicker() {
  if (!_syncSources || _syncSources.length < 2) return '';
  var opts = '<option value="">All sources</option>';
  _syncSources.forEach(function (s) {
    opts += '<option value="' + escHtml(s.slug) + '"' + (s.slug === _syncFilter.source ? ' selected' : '') + '>' +
      escHtml(s.name) + '</option>';
  });
  return '<div style="margin-bottom:14px"><select onchange="syncSetSource(this.value)" style="width:240px">' +
    opts + '</select></div>';
}

function syncSetSource(v) {
  _syncFilter.source = v;
  syncLoad();
}

/* ------------------------------------------------------------------ events */

async function syncRenderEvents(body) {
  var qs = [];
  if (_syncFilter.source) qs.push('source=' + encodeURIComponent(_syncFilter.source));
  if (_syncFilter.status) qs.push('status=' + encodeURIComponent(_syncFilter.status));
  if (_syncFilter.q) qs.push('q=' + encodeURIComponent(_syncFilter.q));
  qs.push('limit=200');

  var d;
  try { d = await api('GET', '/sync/events?' + qs.join('&')); }
  catch (e) { body.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>'; return; }

  var counts = {};
  (d.counts || []).forEach(function (c) { counts[c.status] = c.n; });

  var STATUSES = [
    { k: '', l: 'All' },
    { k: 'parked', l: 'Parked' },
    { k: 'failed', l: 'Failed' },
    { k: 'done', l: 'Done' },
    { k: 'skipped', l: 'Skipped' },
    { k: 'pending', l: 'Pending' }
  ];

  var html = '';

  // Parked is not an error, and a growing parked count on a source with no
  // handler is the expected state. Say so, or it reads as a fault.
  if (counts.parked) {
    html += '<div class="sy-warn"><strong>' + syncNum(counts.parked) + ' parked.</strong> ' +
      'These arrived safely but no handler is written for them yet. Nothing is lost &mdash; write the ' +
      'handler, then use Replay to run it over the backlog.</div>';
  }
  if (counts.failed) {
    html += '<div class="sy-warn"><strong>' + syncNum(counts.failed) + ' failed.</strong> ' +
      'A handler threw on these. They retry on their own for about a day, then wait here for a Replay.</div>';
  }

  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">';
  html += '<select onchange="syncSetStatus(this.value)" style="width:170px">';
  STATUSES.forEach(function (s) {
    var n = s.k ? (counts[s.k] || 0) : 0;
    html += '<option value="' + s.k + '"' + (s.k === _syncFilter.status ? ' selected' : '') + '>' +
      escHtml(s.l) + (s.k ? ' (' + syncNum(n) + ')' : '') + '</option>';
  });
  html += '</select>';
  if (_syncSources && _syncSources.length > 1) {
    html += '<select onchange="syncSetSource(this.value)" style="width:200px"><option value="">All sources</option>';
    _syncSources.forEach(function (s) {
      html += '<option value="' + escHtml(s.slug) + '"' + (s.slug === _syncFilter.source ? ' selected' : '') + '>' +
        escHtml(s.name) + '</option>';
    });
    html += '</select>';
  }
  html += '<input id="sync-search" placeholder="Search id, type, or raw body&hellip;" value="' + escHtml(_syncFilter.q) +
    '" oninput="syncOnSearch(this.value)" style="width:260px;flex:1;min-width:180px">';
  if (syncCan('manage_sync') && _syncFilter.source && (_syncFilter.status === 'parked' || _syncFilter.status === 'failed')) {
    html += '<button class="btn btn-secondary btn-sm" onclick="syncReplayBatch()">Replay all shown</button>';
  }
  html += '</div>';

  var rows = d.events || [];
  if (!rows.length) {
    html += '<div class="card"><div class="card-body" style="text-align:center;padding:32px 20px">' +
      '<div class="sy-note">No events match that filter.</div></div></div>';
    body.innerHTML = html;
    return;
  }

  html +=
    '<div class="card"><div class="card-body" style="padding:0;overflow-x:auto">' +
    '<table class="table"><thead><tr>' +
      '<th style="width:70px">#</th><th>Received</th><th>Source</th><th>Type</th><th>Their id</th>' +
      '<th>Status</th><th class="sy-num">Tries</th><th class="sy-num">Size</th><th style="width:1%"></th>' +
    '</tr></thead><tbody>';

  rows.forEach(function (e) {
    var err = e.last_error ? '<div class="sy-note" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      escHtml(e.last_error) + '</div>' : '';
    html +=
      '<tr class="sy-row-click" onclick="syncOpenEvent(' + Number(e.id) + ')">' +
        '<td class="sy-mono">' + Number(e.id) + '</td>' +
        '<td class="sy-note">' + escHtml(syncDateStr(e.received_at)) + '</td>' +
        '<td class="sy-note">' + escHtml(e.source_slug) + '</td>' +
        '<td class="sy-mono">' + escHtml(e.event_type || '') + '</td>' +
        '<td class="sy-mono sy-note">' + escHtml(e.external_id || '') + '</td>' +
        '<td><span class="sy-chip ' + escHtml(e.status) + '">' + escHtml(e.status) + '</span>' +
          syncSigChip(e.sig_state) + err + '</td>' +
        '<td class="sy-num">' + Number(e.attempts || 0) + '</td>' +
        '<td class="sy-num sy-note">' + (e.bytes ? syncNum(e.bytes) : '') + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();syncOpenEvent(' + Number(e.id) + ')">View</button></td>' +
      '</tr>';
  });

  html += '</tbody></table></div></div>';
  body.innerHTML = html;
}

// A signature verdict is only worth showing when it is not the happy path. A
// green "signed" badge on every row is wallpaper; a red one on three rows out
// of ten thousand is the thing you needed to see.
function syncSigChip(v) {
  if (!v) return '';
  if (v.indexOf('ok:') === 0) return '';
  return ' <span class="sy-chip failed" title="Signature check">sig ' + escHtml(v) + '</span>';
}

function syncSetStatus(v) {
  _syncFilter.status = v;
  syncLoad();
}

function syncOnSearch(v) {
  _syncFilter.q = v;
  if (_syncSearchTimer) clearTimeout(_syncSearchTimer);
  _syncSearchTimer = setTimeout(function () { syncLoad(); }, 300);
}

async function syncOpenEvent(id) {
  var e;
  try { e = await api('GET', '/sync/events/' + id); }
  catch (err) { showToast(err.message, 'error'); return; }

  var pretty = '';
  try { pretty = JSON.stringify(e.payload, null, 2); }
  catch (x) { pretty = String(e.raw_body || ''); }
  if (!pretty && e.raw_body) pretty = e.raw_body;
  if (!pretty) pretty = '(the stored payload was trimmed by the retention setting)';

  var body =
    '<div class="sy-kv" style="margin-bottom:16px">' +
      '<div class="lbl">Event</div><div class="sy-mono">#' + Number(e.id) + '</div>' +
      '<div class="lbl">Source</div><div>' + escHtml(e.source_slug) + '</div>' +
      '<div class="lbl">Type</div><div class="sy-mono">' + escHtml(e.event_type || '(none)') + '</div>' +
      '<div class="lbl">Their id</div><div class="sy-mono">' + escHtml(e.external_id || '(none sent)') + '</div>' +
      '<div class="lbl">Status</div><div><span class="sy-chip ' + escHtml(e.status) + '">' + escHtml(e.status) + '</span></div>' +
      '<div class="lbl">Received</div><div>' + escHtml(syncDateStr(e.received_at)) + '</div>' +
      '<div class="lbl">Processed</div><div>' + escHtml(syncDateStr(e.processed_at) || '&mdash;') + '</div>' +
      '<div class="lbl">Attempts</div><div>' + Number(e.attempts || 0) + '</div>' +
      '<div class="lbl">Next try</div><div>' + escHtml(syncDateStr(e.next_attempt_at) || 'not scheduled') + '</div>' +
      '<div class="lbl">From</div><div class="sy-note">' + escHtml(e.ip || '') + '</div>' +
    '</div>' +
    (e.last_error ? '<div class="sy-warn" style="white-space:pre-wrap">' + escHtml(e.last_error) + '</div>' : '') +
    '<div style="font-weight:700;font-size:13px;margin-bottom:6px">Payload as received</div>' +
    '<pre class="sy-pre">' + escHtml(pretty) + '</pre>';

  var canReplay = syncCan('manage_sync');
  syncModal('Event #' + e.id, body, canReplay ? 'Replay' : '', function () {
    syncReplay(e.id);
  }, true);
}

async function syncReplay(id) {
  try {
    var out = await api('POST', '/sync/events/' + id + '/replay', {});
    var st = (out.result && out.result.status) || 'done';
    showToast('Replayed event #' + id + ' — ' + st, st === 'failed' ? 'error' : 'success');
  } catch (e) { showToast(e.message, 'error'); return; }
  syncCloseModal();
  syncLoad();
}

async function syncReplayBatch() {
  var src = _syncFilter.source, st = _syncFilter.status;
  if (!src || !st) return;
  if (!confirm('Re-run the handler over up to 500 ' + st + ' events from ' + src + '?')) return;
  try {
    var out = await api('POST', '/sync/replay-batch', { source: src, status: st, limit: 500 });
    showToast('Replayed ' + out.total + ': ' + out.done + ' done, ' + out.skipped + ' skipped, ' +
      out.failed + ' failed, ' + out.parked + ' still parked', 'success');
  } catch (e) { showToast(e.message, 'error'); return; }
  syncLoad();
}

/* ----------------------------------------------------------------- sources */

function syncRenderSources(body) {
  var html = '<div class="card"><div class="card-body" style="padding:0;overflow-x:auto">' +
    '<table class="table"><thead><tr>' +
      '<th>Source</th><th>URL</th><th>Auth</th><th>Handler</th><th>Accepting</th>' +
      '<th class="sy-num">Events</th><th>Last delivery</th><th style="width:1%"></th>' +
    '</tr></thead><tbody>';

  _syncSources.forEach(function (s) {
    var badges = '<span class="sy-chip ' + (s.enabled ? 'on' : 'off') + '">' + (s.enabled ? 'live' : 'off') + '</span>';
    if (Number(s.parked_count)) badges += ' <span class="sy-chip parked">' + syncNum(s.parked_count) + ' parked</span>';
    if (Number(s.failed_count)) badges += ' <span class="sy-chip failed">' + syncNum(s.failed_count) + ' failed</span>';

    var handler = s.handler_registered
      ? '<span class="sy-mono">' + escHtml(s.handler || s.slug) + '</span>'
      : '<span class="sy-chip parked">none yet</span>';

    var auth = '<div class="sy-note sy-mono">' + escHtml(s.secret_header || 'X-Nova-Token') + '</div>';
    if (s.hmac_mode === 'require') auth += '<span class="sy-chip on">signed</span>';
    else if (s.hmac_mode === 'observe') auth += '<span class="sy-chip parked">observing</span>';

    var accepting = s.accept_types
      ? '<span class="sy-mono">' + escHtml(s.accept_types) + '</span>'
      : '<span class="sy-note">everything</span>';

    html +=
      '<tr>' +
        '<td><div style="font-weight:600">' + escHtml(s.name) + '</div>' +
          '<div class="sy-note sy-mono">' + escHtml(s.slug) + '</div>' +
          '<div style="margin-top:4px">' + badges + '</div></td>' +
        '<td><div class="sy-note sy-mono" style="word-break:break-all;max-width:320px">' + escHtml(s.url) + '</div>' +
          '<button class="btn btn-ghost btn-sm" onclick="syncCopy(' + JSON.stringify(s.url).replace(/"/g, '&quot;') + ',\'URL\')">Copy URL</button></td>' +
        '<td>' + auth + '</td>' +
        '<td>' + handler + '</td>' +
        '<td>' + accepting + '</td>' +
        '<td class="sy-num">' + syncNum(s.event_count) + '</td>' +
        '<td class="sy-note">' + escHtml(syncDateStr(s.last_event_at) || 'never') + '</td>' +
        '<td style="white-space:nowrap">' +
          (syncCan('manage_sync')
            ? '<button class="btn btn-secondary btn-sm" onclick="syncEditSource(' + Number(s.id) + ')">Edit</button> ' +
              '<button class="btn btn-ghost btn-sm" onclick="syncRotate(' + Number(s.id) + ')">New token</button>'
            : '') +
        '</td>' +
      '</tr>';
  });

  html += '</tbody></table></div></div>';

  if (_syncHandlers.length) {
    html += '<div class="sy-note" style="margin-top:10px">Handlers available in this build: ' +
      escHtml(_syncHandlers.join(', ')) + '</div>';
  }

  body.innerHTML = html;
}

function syncSourceForm(s) {
  s = s || {};
  return '' +
    '<div class="form-group"><label>Name</label>' +
      '<input id="sy-f-name" value="' + escHtml(s.name || '') + '" placeholder="Pulsar Syncer"></div>' +
    (s.id ? '' :
      '<div class="form-group"><label>Token</label>' +
        '<input id="sy-f-token" value="" placeholder="leave blank and Nova generates a strong one">' +
        '<div class="sy-note">Only fill this in if the partner has already chosen the value and will not ' +
        'change it. Otherwise leave it blank &mdash; a generated token is longer and more random than ' +
        'anything either side picks by hand.</div></div>' +
      '<div class="form-group"><label>Slug</label>' +
        '<input id="sy-f-slug" value="" placeholder="pulsar">' +
        '<div class="sy-note">Becomes part of the URL you hand the partner. Lowercase letters, ' +
        'numbers, dash or underscore. It cannot be changed later.</div></div>') +
    '<div class="form-group"><label>Handler</label>' +
      '<input id="sy-f-handler" value="' + escHtml(s.handler || '') + '" placeholder="defaults to the slug">' +
      '<div class="sy-note">The function in utils/webhookHandlers.js that knows what this partner&#39;s ' +
      'data means. Leave it alone until one exists &mdash; deliveries park safely in the meantime.</div></div>' +
    '<div class="form-group"><label>Their id field</label>' +
      '<input id="sy-f-dedupe" value="' + escHtml(s.dedupe_path || '') + '" placeholder="id">' +
      '<div class="sy-note">Which field holds their own id for each record, so a resend is not stored twice. ' +
      'Dots walk into nested objects. Pulsar uses <span class="sy-mono">autonum</span>.</div></div>' +
    '<div class="form-group"><label>Their type field</label>' +
      '<input id="sy-f-type" value="' + escHtml(s.event_type_path || '') + '" placeholder="event">' +
      '<div class="sy-note">Which field says what kind of record it is. Pulsar uses ' +
      '<span class="sy-mono">dataHeader</span>.</div></div>' +
    '<div class="form-group"><label>Only accept these types</label>' +
      '<input id="sy-f-accept" value="' + escHtml(s.accept_types || '') + '" placeholder="leave empty to accept everything">' +
      '<div class="sy-note">Comma separated, e.g. <span class="sy-mono">2000,2001</span>. ' +
      '<strong>Leave this empty at first.</strong> Watch the Traffic tab for a day to see what actually ' +
      'arrives, then narrow it. Dropped types keep being counted, so nothing becomes invisible.</div></div>' +
    '<div style="border-top:1px solid var(--border);margin:18px 0 14px;padding-top:14px;font-weight:700;font-size:13px">' +
      'How they authenticate</div>' +
    '<div class="form-group"><label>Token header name</label>' +
      '<input id="sy-f-secretheader" value="' + escHtml(s.secret_header || '') + '" placeholder="X-Nova-Token">' +
      '<div class="sy-note">The header the partner puts the token in. Leave blank for the usual ones ' +
      '(X-Nova-Token, Authorization: Bearer, ?token=). Pulsar sends a header literally called ' +
      '<span class="sy-mono">auth</span>.</div></div>' +
    (s.id ? syncHmacFields(s) : '<div class="sy-note" style="margin-bottom:14px">Signature checking can be ' +
      'set up once the source exists.</div>') +
    (s.id ?
      '<div class="form-group"><label><input type="checkbox" id="sy-f-enabled"' + (s.enabled ? ' checked' : '') + '> ' +
      'Accepting deliveries</label>' +
      '<div class="sy-note">Turning this off answers the partner with a "try again later", so a ' +
      'well-behaved syncer queues instead of dropping what it was going to send.</div></div>' : '') +
    '<div id="sy-f-err" class="alert alert-error" style="display:none"></div>';
}

// Signature settings only appear on an existing source, because storing the
// signing key is a separate write-only call and there is no id to send it to
// until the source has been created.
function syncHmacFields(s) {
  if (!_syncSigning) {
    return '<div class="sy-warn">Signature checking is unavailable until <span class="sy-mono">SYNC_SECRET_KEY</span> ' +
      'is set in Railway to a 32-byte base64 value. Nova will not store a signing key in the clear, so the ' +
      'option stays off rather than pretending to work.</div>';
  }
  var modes = [
    { k: 'off', l: 'Off — do not check signatures' },
    { k: 'observe', l: 'Observe — check and record, but still accept' },
    { k: 'require', l: 'Require — reject anything that does not match' }
  ];
  var opts = '';
  modes.forEach(function (m) {
    opts += '<option value="' + m.k + '"' + ((s.hmac_mode || 'off') === m.k ? ' selected' : '') + '>' + escHtml(m.l) + '</option>';
  });
  var fmts = '<option value="">Any (let Nova work out which one matches)</option>';
  _syncFormats.forEach(function (f) {
    fmts += '<option value="' + escHtml(f) + '"' + (s.hmac_format === f ? ' selected' : '') + '>' + escHtml(f) + '</option>';
  });
  return '' +
    '<div class="form-group"><label>Signature checking</label>' +
      '<select id="sy-f-hmacmode">' + opts + '</select>' +
      '<div class="sy-note"><strong>Start on Observe.</strong> Partners describe their signing scheme in a ' +
      'sentence, and a sentence is not a specification. Observe records which formulation actually matches ' +
      'their real traffic without ever turning anyone away. Once one is winning consistently, pin it below ' +
      'and switch to Require.</div></div>' +
    '<div class="form-group"><label>Signature header</label>' +
      '<input id="sy-f-hmacheader" value="' + escHtml(s.hmac_header || '') + '" placeholder="Pulsar-Signature"></div>' +
    '<div class="form-group"><label>Timestamp header</label>' +
      '<input id="sy-f-hmactsheader" value="' + escHtml(s.hmac_ts_header || '') + '" placeholder="Pulsar-Timestamp"></div>' +
    '<div class="form-group"><label>What they sign</label>' +
      '<select id="sy-f-hmacformat">' + fmts + '</select>' +
      '<div class="sy-note">Leave on Any while observing. The Events tab names the winner on each row.</div></div>' +
    '<div class="form-group"><label>Allowed clock drift (seconds)</label>' +
      '<input id="sy-f-hmacskew" value="' + escHtml(String(s.hmac_max_skew_s === null || s.hmac_max_skew_s === undefined ? 300 : s.hmac_max_skew_s)) + '">' +
      '<div class="sy-note">Only enforced when the timestamp is part of what they sign. If it is not signed, ' +
      'anyone replaying can edit it, so checking it would be theatre &mdash; Nova skips it rather than ' +
      'rejecting good traffic over a clock difference.</div></div>' +
    '<div class="form-group"><label>Signing key</label>' +
      '<input id="sy-f-hmackey" type="password" placeholder="' + (s.hmac_key_set ? 'stored — type to replace' : 'paste the key the partner signs with') + '">' +
      '<div class="sy-note">Encrypted at rest, and <strong>write only</strong> &mdash; it never comes back out ' +
      'of Nova, not even here. Unlike the token, this one cannot be stored as a fingerprint: verifying a ' +
      'signature means recomputing it, which needs the actual key.' +
      (s.hmac_key_set ? ' A key is currently stored. Leave this blank to keep it.' : '') + '</div></div>';
}

function syncFormValues(withSlug) {
  var v = {
    name: (document.getElementById('sy-f-name') || {}).value || '',
    handler: (document.getElementById('sy-f-handler') || {}).value || '',
    dedupe_path: (document.getElementById('sy-f-dedupe') || {}).value || '',
    event_type_path: (document.getElementById('sy-f-type') || {}).value || '',
    accept_types: (document.getElementById('sy-f-accept') || {}).value || '',
    secret_header: (document.getElementById('sy-f-secretheader') || {}).value || ''
  };
  var hm = document.getElementById('sy-f-hmacmode');
  if (hm) {
    v.hmac_mode = hm.value;
    v.hmac_header = (document.getElementById('sy-f-hmacheader') || {}).value || '';
    v.hmac_ts_header = (document.getElementById('sy-f-hmactsheader') || {}).value || '';
    v.hmac_format = (document.getElementById('sy-f-hmacformat') || {}).value || '';
    v.hmac_max_skew_s = Number((document.getElementById('sy-f-hmacskew') || {}).value || 0);
  }
  if (withSlug) {
    v.slug = ((document.getElementById('sy-f-slug') || {}).value || '').trim().toLowerCase();
    var t = ((document.getElementById('sy-f-token') || {}).value || '').trim();
    if (t) v.token = t;
  }
  var en = document.getElementById('sy-f-enabled');
  if (en) v.enabled = !!en.checked;
  return v;
}

function syncFormError(msg) {
  var e = document.getElementById('sy-f-err');
  if (e) { e.style.display = 'block'; e.innerHTML = escHtml(msg || 'Could not save.'); }
}

function syncNewSource() {
  syncModal('Add a sync source',
    '<div class="sy-note" style="margin-bottom:14px">This creates a URL and a secret token for one ' +
    'partner. The token is shown once and cannot be recovered &mdash; copy it before closing.</div>' +
    syncSourceForm(null),
    'Create', async function () {
      var v = syncFormValues(true);
      try {
        var out = await api('POST', '/sync/sources', v);
        syncShowToken(out, 'Source created');
      } catch (e) { syncFormError(e.message); }
    });
}

// The one moment the token exists in plaintext. Everything about this dialog is
// shaped by the fact that closing it destroys the only copy.
function syncShowToken(out, title) {
  syncCloseModal();
  syncModal(title,
    '<div class="sy-good"><strong>Copy the token now.</strong> Only its fingerprint is kept, so there ' +
    'is no way to show it again. If it is lost, generate a new one &mdash; that is normal and takes a second.</div>' +
    '<div class="form-group"><label>Post to this URL</label>' +
      '<div class="sy-url"><span style="flex:1">' + escHtml(out.url) + '</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="syncCopy(' + JSON.stringify(out.url).replace(/"/g, '&quot;') + ',\'URL\')">Copy</button></div></div>' +
    '<div class="form-group"><label>Send this header</label>' +
      '<div class="sy-url"><span style="flex:1">' + escHtml(out.header) + ': ' + escHtml(out.token) + '</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="syncCopy(' + JSON.stringify(out.token).replace(/"/g, '&quot;') + ',\'Token\')">Copy token</button></div></div>' +
    '<div class="sy-note">Give the partner both. They POST JSON to that URL with that header; ' +
    'everything they send is stored the moment it lands.</div>',
    '', null, true);
  _syncSources = null;
  syncRefresh();
}

async function syncEditSource(id) {
  var s = null;
  (_syncSources || []).forEach(function (x) { if (Number(x.id) === Number(id)) s = x; });
  if (!s) return;
  syncModal('Edit ' + s.name, syncSourceForm(s), 'Save', async function () {
    try {
      // The key goes first and separately: it is a different endpoint, and if
      // the mode is being switched to Require the key had better already be
      // stored when that takes effect.
      var keyEl = document.getElementById('sy-f-hmackey');
      if (keyEl && keyEl.value) await api('PUT', '/sync/sources/' + id + '/signing-key', { key: keyEl.value });
      await api('PUT', '/sync/sources/' + id, syncFormValues(false));
      syncCloseModal();
      showToast('Saved', 'success');
      _syncSources = null;
      syncRefresh();
    } catch (e) { syncFormError(e.message); }
  });
}

async function syncRotate(id) {
  if (!confirm('Generate a new token?\n\nThe current one stops working immediately, so the partner ' +
    'will get errors until you send them the new one.')) return;
  try {
    var out = await api('POST', '/sync/sources/' + id + '/rotate', {});
    syncShowToken(out, 'New token');
  } catch (e) { showToast(e.message, 'error'); }
}
