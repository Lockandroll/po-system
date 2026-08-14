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

var _syncTab = 'traffic';          // traffic | events | sources | outbound
var _syncFilter = { source: '', status: '', q: '' };
var _syncSources = null;
var _syncHandlers = [];
var _syncSigning = false;      // does the server have a key to store signing secrets with
var _syncFormats = [];
var _syncSearchTimer = null;
var _syncAuto = true;          // live refresh on by default - this is a watch screen
var _syncTimer = null;
var _syncLastLoad = null;
var SYNC_POLL_MS = 15000;

/* ------------------------------------------------- partner event type names */

// Pulsar's Header_Types enum, from Duty 2026-08-13. A screen full of bare
// numbers is unreadable, and the numbers are the whole routing key here.
//
// Kept in the UI rather than the server on purpose: it is a display aid, and
// nothing on the server should start BEHAVING differently because a number has
// a name. An unknown code still shows, as itself - the list is not a filter.
//
// NOTE the two corrections to what was said in chat: 2000 is NOT a new digital
// (it is Calls Live ID Added), and digitals are the 5000 range, not 2000/2001.
var PULSAR_TYPES = {
  '61': 'Active Call → New Status → Direct Tech',
  '62': 'Active Call → Clear Tech',
  '63': 'Active Call → Cancelled',
  '64': 'Active Call → Close',
  '65': 'Active Call → Changed',
  '66': 'Active Call → New Status',
  '67': 'Active Call → New Status → Accepted',
  '68': 'Active Call → New Status → Enroute',
  '69': 'Active Call → New Status → OnSite',
  '70': 'Old Pulsar → New Entry',
  '71': 'Active Call → New Status → Approaching',
  '990': 'Analyse Request',
  '991': 'Analyse Response',
  '992': 'Device Log → Response',
  '998': 'Report Log',
  '999': 'Boot User',
  '1001': 'Location Update',
  '1002': 'BB Update',
  '1003': 'Location Map Details Update',
  '1004': 'Location Update → Overrides',
  '1005': 'MA Update → Overrides',
  '1006': 'MA Update → Settings',
  '1007': 'MA Update → Everything',
  '1010': 'Account Update',
  '1011': 'Account Delete',
  '1020': 'Personnel Update',
  '1021': 'Personnel Delete',
  '1025': 'Personnel Status → Logon',
  '1026': 'Personnel Status → Update',
  '1027': 'Personnel Status → Logoff',
  '1030': 'Calls → New',
  '1031': 'Calls → Updated',
  '1032': 'Calls → Closed',
  '1033': 'Calls → Closed → UID',
  '1034': 'Calls → zNew → New',
  '1035': 'Calls → Schedule Updated',
  '1040': 'Calls → ReSend',
  '1041': 'Calls → ReSend ToEveryone',
  '1050': 'Calls → Transfer → New',
  '1051': 'Calls → Transfer → Live',
  '1060': 'Calls → Survey Ready',
  '1061': 'Calls → Digital Receipt Ready',
  '1062': 'Calls → Digital Tech Cancelled',
  '1063': 'Calls → Digital Tech Sent Canned Msg',
  '1072': 'Calls → Flip',
  '1073': 'Calls → Poke',
  '1090': 'Calls → New ETA',
  '1091': 'Calls → New ETA → From Mobile',
  '2000': 'Calls → Live ID Added',
  '2010': 'Calls → Live ID Removed',
  '2020': 'Calls → Call Status Updated',
  '2300': 'Message Tech',
  '2310': 'Jobox → Message Location',
  '2320': 'Jobox → Message Dispatched By',
  '2400': 'Chat Start → User',
  '2401': 'Chat Start → Center',
  '2402': 'Chat Start → Location',
  '2500': 'Chat User → Msg',
  '2502': 'Chat User → Msg RoomBased',
  '3000': 'Schedule → Updated',
  '3010': 'Schedule → Shift → Updated',
  '3011': 'Schedule → Shift → Deleted',
  '4000': 'Vehicles → Updated',
  '5000': 'Digital → New Job',
  '5001': 'Digital → New Transcript PCD Push',
  '5002': 'Digital → Job Fetched',
  '5003': 'Digital → New Approved Digital',
  '5006': 'Digital → GOA Result → Allstate',
  '5007': 'Digital → GOA Result → ISSC',
  '5008': 'Digital → GOA Result → TM',
  '5010': 'Digital → Accepted',
  '5011': 'Digital → Accepted → BigData',
  '5012': 'Digital → Rejected',
  '5014': 'Digital → Expired',
  '5016': 'Digital → Cancelled',
  '5020': 'Digital → Account Offline',
  '5022': 'Digital → Account Online',
  '5024': 'Digital → Account Registered',
  '5026': 'Digital → Account UnRegistered',
  '5029': 'Digital → Account Updated',
  '5030': 'Digital → New MA Job',
  '5036': 'Digital → New Import Job',
  '5077': 'Digital → Additional Service → Result → ISSC',
  '5078': 'Digital → General Message → Result → ISSC',
  '6000': 'Accounting Calls Confirmed',
  '6500': 'EI → Image Uploaded',
  '7010': 'Master Account → Auth Adj Updated',
  '8000': 'Techs → Heartbeat',
  '50000': 'Boot Off'
};

// Pulsar location ids, from Duty 2026-08-13.
//
// ⚠️ THE KEYS ARE STRINGS AND MUST STAY STRINGS. These are 18-digit values -
// larger than JavaScript can hold exactly as a number. Quoted, they are exact;
// unquoted, 201002101610450898 silently becomes 201002101610450900 and every
// lookup misses. Duty flagged the same trap on his side: "if claude stores
// these big numbers make sure you tell him to save it as a string, otherwise
// it'll break". Nova stores them as text end to end, never a numeric column.
//
// This list is PARTIAL - 201002101605265794 has already been seen in real
// traffic and is not in it. Unknown ids render as themselves, never blank.
var PULSAR_LOCATIONS = {
  '201002101610382729': 'Columbus, GA',
  '201002101610416735': 'Clearwater',
  '201002101610432566': 'Jacksonville',
  '201002101610450898': 'Orlando',
  '201002101610470309': 'Tampa',
  '201002101610493226': 'Birmingham',
  '201002101610517900': 'Savannah',
  '201002101611115885': 'Tallahassee'
};

function syncLocationName(id) {
  var s = String(id === null || id === undefined ? '' : id).trim();
  if (!s || s === '0') return '';
  return PULSAR_LOCATIONS[s] || '';
}

// Pulsar ids are timestamps: yyyyMMddHHmmssffff. Handy when gmtStamp is
// DateTime.MinValue, which it always is so far.
function syncIdTime(id) {
  var s = String(id === null || id === undefined ? '' : id).trim();
  if (!/^\d{18}$/.test(s)) return '';
  var d = new Date(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + 'T' +
    s.slice(8, 10) + ':' + s.slice(10, 12) + ':' + s.slice(12, 14) + 'Z');
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function syncTypeLabel(slug, code) {
  if (code === null || code === undefined || code === '') return '';
  if (String(slug) !== 'pulsar') return '';
  return PULSAR_TYPES[String(code)] || '';
}


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
    '.sy-bar i.st{background:#4ade80}.sy-bar i.dr{background:rgba(148,163,184,.55)}.sy-bar i.du{background:#f59e0b}' +
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
        '<button class="btn btn-sm ' + (_syncAuto ? 'btn-secondary' : 'btn-ghost') + '" id="sync-auto-btn" ' +
          'onclick="syncToggleAuto()" title="Refresh this screen automatically">' + (_syncAuto ? 'Live' : 'Paused') + '</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="syncRefresh()">Refresh</button>' +
        (syncCan('manage_sync') ? '<button class="btn btn-primary btn-sm" onclick="syncNewSource()">Add a source</button>' : '') +
      '</div></div>' +
    '<div class="sy-tabs">' +
      '<div class="sy-tab' + (_syncTab === 'traffic' ? ' on' : '') + '" onclick="syncGo(\'traffic\')">Traffic</div>' +
      '<div class="sy-tab' + (_syncTab === 'events' ? ' on' : '') + '" onclick="syncGo(\'events\')">Events</div>' +
      '<div class="sy-tab' + (_syncTab === 'sources' ? ' on' : '') + '" onclick="syncGo(\'sources\')">Sources</div>' +
      // The other direction. Everything to the left of this is what partners
      // send US; this tab is what WE send them.
      '<div class="sy-tab' + (_syncTab === 'outbound' ? ' on' : '') + '" onclick="syncGo(\'outbound\')">Outbound</div>' +
    '</div>' +
    '<div id="sync-body"></div>' +
    '<div id="sync-stamp" class="sy-note" style="margin-top:10px;text-align:right"></div>';

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
  syncStartAuto();
}

function syncGo(t) {
  _syncTab = t;
  renderSync(document.getElementById('content') || document.querySelector('.content'));
}

function syncRefresh() {
  renderSync(document.getElementById('content') || document.querySelector('.content'));
}

// This screen is watched while waiting for a partner to send something, and it
// used to sit there dead until someone hit Refresh. Which meant the honest
// answer to "is anything arriving?" was "I don't know, my page is stale."
//
// The guards matter more than the timer. A poll that fires while a dialog is
// open, or while someone is typing a search, or in a tab nobody is looking at,
// is worse than no poll at all.
function syncStartAuto() {
  if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
  _syncTimer = setInterval(function () {
    // The screen has been navigated away from - stop, and do not leak a timer
    // that quietly calls the API forever.
    if (!document.getElementById('sync-body')) {
      clearInterval(_syncTimer);
      _syncTimer = null;
      return;
    }
    if (!_syncAuto) return;
    if (document.hidden) return;                                 // background tab
    if (document.getElementById('sync-modal')) return;           // never redraw under an open dialog
    var el = document.activeElement;
    if (el && (el.id === 'sync-search' || el.tagName === 'SELECT')) return;  // do not fight the user
    syncLoad();
  }, SYNC_POLL_MS);
}

function syncToggleAuto() {
  _syncAuto = !_syncAuto;
  var b = document.getElementById('sync-auto-btn');
  if (b) b.textContent = _syncAuto ? 'Live' : 'Paused';
  if (b) b.className = 'btn btn-sm ' + (_syncAuto ? 'btn-secondary' : 'btn-ghost');
  if (_syncAuto) syncLoad();
}

function syncStamp() {
  var el = document.getElementById('sync-stamp');
  if (!el) return;
  var d = new Date();
  el.textContent = 'updated ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) +
    (_syncAuto ? ' - refreshing every ' + (SYNC_POLL_MS / 1000) + 's' : ' - paused');
}

async function syncLoad() {
  var body = document.getElementById('sync-body');
  if (!body) return;
  body.innerHTML = '<div class="card"><div class="card-body">Loading&hellip;</div></div>';

  // The outbound tab is checked FIRST, before the source checks below. It does
  // not depend on any inbound source existing - you can be sending to Pulsar
  // long before anyone has pointed a webhook at us, and an empty inbound
  // configuration should not hide the outbound screen.
  if (_syncTab === 'outbound') return syncRenderOutbound(body);

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

  _syncLastLoad = Date.now();
  syncStamp();
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
  var totStored = 0, totDropped = 0, totDup = 0;
  rows.forEach(function (r) {
    totStored += Number(r.stored_count || 0);
    totDropped += Number(r.dropped_count || 0);
    totDup += Number(r.duplicate_count || 0);
  });
  var tot = totStored + totDropped + totDup;

  var html =
    '<div class="sy-cards">' +
      '<div class="sy-card"><div class="k">Delivered</div><div class="v">' + syncNum(tot) + '</div>' +
        '<div class="s">records seen, all time</div></div>' +
      '<div class="sy-card"><div class="k">Kept</div><div class="v">' + syncNum(totStored) + '</div>' +
        '<div class="s">stored as events</div></div>' +
      '<div class="sy-card' + (totDup ? ' amber' : '') + '"><div class="k">Duplicates</div><div class="v">' + syncNum(totDup) + '</div>' +
        '<div class="s">' + (totDup ? 'same id seen before' : 'none') + '</div></div>' +
      '<div class="sy-card"><div class="k">Filtered out</div><div class="v">' + syncNum(totDropped) + '</div>' +
        '<div class="s">' + (totDropped ? 'types not on the accept list' : 'nothing is being dropped') + '</div></div>' +
      '<div class="sy-card"><div class="k">Event types</div><div class="v">' + syncNum(rows.length) + '</div>' +
        '<div class="s">distinct codes seen</div></div>' +
    '</div>';

  // The single most confusing thing this screen can show: traffic arriving,
  // nothing appearing in the event log, and no obvious reason. Say it outright.
  if (totDup) {
    html += '<div class="sy-warn"><strong>' + syncNum(totDup) + ' records were treated as duplicates</strong> ' +
      'and produced no event, because their id had been seen before. If those were meant to be new records, ' +
      'the <em>Their id field</em> setting on this source is pointing at something that is not unique &mdash; ' +
      'fix that and the partner can resend.</div>';
  }

  html += syncSourcePicker();
  html += '<div id="sy-rejects"></div>';

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
      '<th>Event type</th><th>Source</th><th class="sy-num">Kept</th><th class="sy-num">Dupes</th><th class="sy-num">Dropped</th>' +
      '<th style="width:130px">Mix</th><th>First seen</th><th>Last seen</th>' +
    '</tr></thead><tbody>';

  rows.forEach(function (r) {
    var st = Number(r.stored_count || 0), dr = Number(r.dropped_count || 0);
    var du = Number(r.duplicate_count || 0), n = st + dr + du || 1;
    var lbl = syncTypeLabel(r.source_slug, r.event_type);
    var type = r.event_type === '' || r.event_type === null ? '<span class="sy-note">(no type)</span>'
      : '<span class="sy-mono">' + escHtml(r.event_type) + '</span>' +
        (lbl ? '<div class="sy-note">' + escHtml(lbl) + '</div>'
             : '<div class="sy-note" style="color:#f0b849">unknown code</div>');
    html +=
      '<tr>' +
        '<td>' + type + '</td>' +
        '<td class="sy-note">' + escHtml(r.source_slug) + '</td>' +
        '<td class="sy-num">' + syncNum(st) + '</td>' +
        '<td class="sy-num">' + (du ? '<span style="color:#f59e0b">' + syncNum(du) + '</span>' : '<span class="sy-note">&mdash;</span>') + '</td>' +
        '<td class="sy-num">' + (dr ? syncNum(dr) : '<span class="sy-note">&mdash;</span>') + '</td>' +
        '<td><div class="sy-bar">' +
          '<i class="st" style="width:' + ((st / n) * 100).toFixed(1) + '%"></i>' +
          '<i class="du" style="width:' + ((du / n) * 100).toFixed(1) + '%"></i>' +
          '<i class="dr" style="width:' + ((dr / n) * 100).toFixed(1) + '%"></i>' +
        '</div></td>' +
        '<td class="sy-note">' + escHtml(syncDateStr(r.first_seen)) + '</td>' +
        '<td class="sy-note">' + escHtml(syncDateStr(r.last_seen)) + '</td>' +
      '</tr>';
  });

  html += '</tbody></table></div></div>' +
    '<div class="sy-note" style="margin-top:10px">' + escHtml(d.note || '') +
    ' The Events tab is always current; only these totals lag.</div>';

  body.innerHTML = html;
  syncLoadRejections();
}

// Rendered after the main table so a slow query cannot hold up the numbers
// everyone actually came for.
async function syncLoadRejections() {
  var el = document.getElementById('sy-rejects');
  if (!el) return;
  var d;
  try { d = await api('GET', '/sync/rejections'); } catch (e) { return; }
  var rows = (d.rejections || []).filter(function (r) {
    return !_syncFilter.source || r.source_slug === _syncFilter.source || !r.source_slug;
  });
  if (!rows.length) { el.innerHTML = ''; return; }

  var total = 0;
  rows.forEach(function (r) { total += Number(r.hits || 0); });

  var REASONS = {
    no_token: 'sent no token at all',
    wrong_token: 'sent the wrong token',
    unknown_source: 'posted to a URL with no source behind it',
    source_disabled: 'the source was switched off',
    bad_signature: 'the signature did not match',
    invalid_json: 'the body was not valid JSON',
    invalid_payload: 'the body was not an object or array',
    invalid_batch_item: 'an array element was not an object',
    empty_body: 'sent an empty body',
    payload_too_large: 'the body was over the size limit',
    body_never_sent: 'announced a body then never sent it, and gave up waiting',
    batch_too_large: 'too many records in one POST'
  };

  var h = '<div class="sy-warn" style="margin-top:18px"><strong>' + syncNum(total) +
    ' deliveries were turned away</strong> and produced no event. If a partner says they are sending ' +
    'and nothing is arriving, this is usually the answer.</div>' +
    '<div class="card"><div class="card-body" style="padding:0;overflow-x:auto">' +
    '<table class="table"><thead><tr><th>What happened</th><th>URL</th><th>From</th>' +
    '<th class="sy-num">Times</th><th>Last</th></tr></thead><tbody>';

  rows.forEach(function (r) {
    h += '<tr>' +
      '<td>' + escHtml(REASONS[r.reason] || r.reason) + '<div class="sy-note sy-mono">' + escHtml(r.reason) + '</div></td>' +
      '<td class="sy-mono sy-note">' + escHtml(r.source_slug || '(none)') + '</td>' +
      '<td class="sy-mono sy-note">' + escHtml(r.ip || '') + '</td>' +
      '<td class="sy-num">' + syncNum(r.hits) + '</td>' +
      '<td class="sy-note">' + escHtml(syncDateStr(r.last_seen)) + '</td>' +
    '</tr>';
  });
  h += '</tbody></table></div></div>';
  el.innerHTML = h;
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
  html += '<input id="sync-search" placeholder="Search id, type, sender IP, or raw body&hellip;" value="' + escHtml(_syncFilter.q) +
    '" oninput="syncOnSearch(this.value)" style="width:260px;flex:1;min-width:180px">';
  if (syncCan('manage_sync') && _syncFilter.source && (_syncFilter.status === 'parked' || _syncFilter.status === 'failed')) {
    html += '<button class="btn btn-secondary btn-sm" onclick="syncReplayBatch()">Replay all shown</button>';
  }
  // Only offered with a source AND a real search term - see the guard rails on
  // the endpoint. Without both, there is nothing safe to delete.
  if (syncCan('manage_sync') && _syncFilter.source && _syncFilter.q && _syncFilter.q.trim().length >= 4) {
    html += '<button class="btn btn-ghost btn-sm" style="color:#f87171" onclick="syncPurge()">Delete matching&hellip;</button>';
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
      '<th style="width:70px">#</th><th>Received</th><th>From</th><th>Type</th><th>Their id</th>' +
      '<th>Status</th><th class="sy-num">Tries</th><th class="sy-num">Size</th><th style="width:1%"></th>' +
    '</tr></thead><tbody>';

  rows.forEach(function (e) {
    var err = e.last_error ? '<div class="sy-note" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      escHtml(e.last_error) + '</div>' : '';
    html +=
      '<tr class="sy-row-click" onclick="syncOpenEvent(' + Number(e.id) + ')">' +
        '<td class="sy-mono">' + Number(e.id) + '</td>' +
        '<td class="sy-note">' + escHtml(syncDateStr(e.received_at)) + '</td>' +
        '<td class="sy-mono sy-note" style="cursor:pointer" title="Click to see only this sender" ' +
          'onclick="event.stopPropagation();syncOnSearch(' + JSON.stringify(String(e.ip || '')).replace(/"/g, '&quot;') + ');' +
          'var b=document.getElementById(\'sync-search\');if(b)b.value=' +
          JSON.stringify(String(e.ip || '')).replace(/"/g, '&quot;') + ';">' + escHtml(e.ip || '') + '</td>' +
        '<td><span class="sy-mono">' + escHtml(e.event_type || '') + '</span>' +
          (syncTypeLabel(e.source_slug, e.event_type)
            ? '<div class="sy-note">' + escHtml(syncTypeLabel(e.source_slug, e.event_type)) + '</div>' : '') + '</td>' +
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
      '<div class="lbl">Type</div><div><span class="sy-mono">' + escHtml(e.event_type || '(none)') + '</span>' +
        (syncTypeLabel(e.source_slug, e.event_type)
          ? ' <span class="sy-note">' + escHtml(syncTypeLabel(e.source_slug, e.event_type)) + '</span>' : '') + '</div>' +
      '<div class="lbl">Their id</div><div class="sy-mono">' + escHtml(e.external_id || '(none sent)') + '</div>' +
      '<div class="lbl">Status</div><div><span class="sy-chip ' + escHtml(e.status) + '">' + escHtml(e.status) + '</span></div>' +
      '<div class="lbl">Received</div><div>' + escHtml(syncDateStr(e.received_at)) + '</div>' +
      '<div class="lbl">Processed</div><div>' + escHtml(syncDateStr(e.processed_at) || '&mdash;') + '</div>' +
      '<div class="lbl">Attempts</div><div>' + Number(e.attempts || 0) + '</div>' +
      '<div class="lbl">Next try</div><div>' + escHtml(syncDateStr(e.next_attempt_at) || 'not scheduled') + '</div>' +
      '<div class="lbl">From</div><div class="sy-note">' + escHtml(e.ip || '') + '</div>' +
    '</div>' +
    (e.last_error ? '<div class="sy-warn" style="white-space:pre-wrap">' + escHtml(e.last_error) + '</div>' : '') +
    syncDecoded(e) +
    '<div style="font-weight:700;font-size:13px;margin-bottom:6px">Payload as received</div>' +
    '<pre class="sy-pre">' + escHtml(pretty) + '</pre>';

  var canReplay = syncCan('manage_sync');
  syncModal('Event #' + e.id, body, canReplay ? 'Replay' : '', function () {
    syncReplay(e.id);
  }, true);
}

// Translates the opaque parts of a Pulsar envelope into something a human can
// act on. Shown ABOVE the raw payload, never instead of it - the raw bytes stay
// the source of truth, this is only a reading aid.
function syncDecoded(e) {
  if (String(e.source_slug) !== 'pulsar') return '';
  var p = e.payload || {};
  var rows = [];

  var loc = syncLocationName(p.locationID);
  if (loc) {
    rows.push(['Location', escHtml(loc) + ' <span class="sy-note sy-mono">' + escHtml(String(p.locationID)) + '</span>']);
  } else if (p.locationID && String(p.locationID) !== '0') {
    rows.push(['Location', '<span class="sy-mono">' + escHtml(String(p.locationID)) + '</span> ' +
      '<span class="sy-note">not in the known list</span>']);
  }

  // dataTarget is composite and its shape DIFFERS BY EVENT TYPE - '(}' on call
  // status, ':' on digitals. Split on whichever is present rather than assuming.
  var dt = String(p.dataTarget || '');
  if (dt) {
    var parts = dt.indexOf('(}') !== -1 ? dt.split('(}') : (dt.indexOf(':') !== -1 ? dt.split(':') : [dt]);
    if (parts.length > 1) {
      var head = syncIdTime(parts[0]);
      rows.push(['Reference', parts.map(function (x, i) {
        return '<span class="sy-mono">' + escHtml(x) + '</span>' +
          (i === 0 && head ? ' <span class="sy-note">(' + escHtml(head) + ')</span>' : '');
      }).join(' <span class="sy-note">&middot;</span> ')]);
    }
  }

  var tt = syncIdTime(p.targetID);
  if (tt) rows.push(['Record created', escHtml(tt) + ' <span class="sy-note">derived from targetID</span>']);

  // Worth saying out loud - it looks like a date and is not one.
  if (String(p.gmtStamp || '').indexOf('0001-01-01') === 0) {
    rows.push(['Their timestamp', '<span class="sy-note">not set (0001-01-01) &mdash; use Received above</span>']);
  }

  if (!rows.length) return '';
  return '<div style="font-weight:700;font-size:13px;margin-bottom:6px">Decoded</div>' +
    '<div class="sy-kv" style="margin-bottom:16px">' +
    rows.map(function (r) { return '<div class="lbl">' + r[0] + '</div><div>' + r[1] + '</div>'; }).join('') +
    '</div>';
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

// Deleting real partner data would be a serious mistake, so the confirm names
// the term, the source and the count rather than asking "are you sure".
async function syncPurge() {
  var src = _syncFilter.source, q = (_syncFilter.q || '').trim();
  if (!src || q.length < 4) return;
  if (!confirm('Permanently delete every ' + src + ' event matching "' + q + '"?\n\n' +
    'This cannot be undone. Only use it for test traffic.')) return;
  var resetCounters = confirm('Also reset the traffic counters for ' + src + '?\n\n' +
    'OK  = clear the Traffic and Rejections tallies too, so the numbers match what is left.\n' +
    'Cancel = delete the events but keep the historical counts.');
  try {
    var out = await api('POST', '/sync/events/purge', { source: src, q: q, reset_counters: resetCounters });
    showToast('Deleted ' + out.deleted + ' event(s)' + (out.counters_reset ? ' and reset the counters' : ''), 'success');
  } catch (e) { showToast(e.message, 'error'); return; }
  _syncFilter.q = '';
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

    if (s.dedupe_mode === 'off') auth += ' <span class="sy-chip parked">dupes allowed</span>';
    else if (s.dedupe_mode === 'bytes') auth += ' <span class="sy-chip off">dupes by content</span>';

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
    '<div class="form-group"><label>Duplicate checking</label>' +
      '<select id="sy-f-dedupemode">' +
        '<option value="id"' + ((s.dedupe_mode || 'id') === 'id' ? ' selected' : '') + '>Use their id field</option>' +
        '<option value="bytes"' + (s.dedupe_mode === 'bytes' ? ' selected' : '') + '>Compare the raw record instead</option>' +
        '<option value="off"' + (s.dedupe_mode === 'off' ? ' selected' : '') + '>Off &mdash; store everything</option>' +
      '</select>' +
      '<div class="sy-note"><strong>Off is a reasonable place to start.</strong> Getting the id field wrong ' +
      'means real records disappear with no error, which is far worse than a few repeated rows &mdash; and ' +
      'until a handler exists, a repeat costs nothing but a row. Switch to <em>Use their id field</em> once ' +
      'you have confirmed which field is genuinely unique. The partner&#39;s id is recorded on every event ' +
      'either way.</div></div>' +
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
    dedupe_mode: (document.getElementById('sy-f-dedupemode') || {}).value || 'id',
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

/* ---------------------------------------------------------------- outbound */
/*
 * The other direction: what Nova asked Pulsar to do.
 *
 * This screen exists mainly so that arming the integration is a deliberate,
 * visible act rather than an environment variable nobody remembers setting. It
 * shows, at a glance: which mode we are in, whether the credentials are loaded,
 * which endpoint URLs we actually have, and every call we have made.
 *
 * It never displays a credential. The server sends back "set, ends 4A2B" and
 * that is all there is to render - see utils/pulsarOut.js credFingerprint().
 */

var _syncOut = null;

async function syncRenderOutbound(body) {
  var st, calls;
  try {
    st = await api('GET', '/pulsar-out/status');
    calls = await api('GET', '/pulsar-out/calls?limit=50');
  } catch (e) {
    body.innerHTML = '<div class="alert alert-error">Could not read the outbound status. ' + escHtml(e.message) + '</div>';
    return;
  }
  _syncOut = st;

  var mode = String(st.mode || 'off');
  var banner;
  if (mode === 'off') {
    banner = '<div class="sy-note" style="background:rgba(148,163,184,.1);border:1px solid var(--border);' +
      'border-radius:var(--radius);padding:11px 14px;margin-bottom:14px">' +
      '<b>Outbound is switched off.</b> Nothing Nova does can change anything in Pulsar right now. ' +
      'Set <span class="sy-mono">PULSAR_OUT_MODE</span> to <span class="sy-mono">dry</span> to rehearse ' +
      'requests without sending them, or <span class="sy-mono">live</span> to arm it.</div>';
  } else if (mode === 'dry') {
    banner = '<div class="sy-warn"><b>Dry run.</b> Requests are built and logged in full, but nothing ' +
      'is sent. What you see in the log below is byte for byte what would have gone out.</div>';
  } else {
    banner = '<div class="sy-good"><b>Live.</b> Actions on this screen change real dispatch state in ' +
      'Pulsar. Every one is logged below and written to the audit log.</div>';
  }

  // Credentials and URLs. A missing URL is the single most likely reason an
  // action is unavailable, so it is stated plainly rather than left to be
  // discovered by a failed call.
  var eps = st.endpoints || {};
  var cfg =
    '<div class="card" style="margin-bottom:14px"><div class="card-body">' +
      '<div class="sy-kv">' +
        '<div class="lbl">Mode</div><div><span class="sy-chip ' + (mode === 'live' ? 'on' : 'off') + '">' + escHtml(mode) + '</span></div>' +
        '<div class="lbl">sKey</div><div class="sy-mono">' + escHtml(st.skey || 'not set') + '</div>' +
        '<div class="lbl">Token</div><div class="sy-mono">' + escHtml(st.token || 'not set') + '</div>' +
        '<div class="lbl">API URL</div><div class="sy-mono" style="word-break:break-all">' + escHtml(eps.api || '') + '</div>' +
        '<div class="lbl">Import URL</div><div class="sy-mono" style="word-break:break-all">' +
          (eps['import'] ? escHtml(eps['import']) : '<span class="sy-note">not set - add_call is unavailable until Pulsar provisions one</span>') + '</div>' +
        '<div class="lbl">GPS URL</div><div class="sy-mono" style="word-break:break-all">' +
          (eps.gps ? escHtml(eps.gps) : '<span class="sy-note">not set - gps is unavailable until Pulsar provisions one</span>') + '</div>' +
      '</div>' +
      '<div class="sy-note" style="margin-top:12px">The key values themselves are never sent to this ' +
        'screen. Only the last four characters, so you can tell one key from another.</div>' +
    '</div></div>';

  // The actions. "Verified" means somebody watched it work against the real
  // API - not that it matches the documentation.
  var acts = (st.actions || []).map(function (a) {
    var can = st.ready && a.available && mode !== 'off';
    var why = !st.ready ? 'credentials are not set'
            : !a.available ? 'no URL configured for the ' + a.endpoint + ' endpoint'
            : mode === 'off' ? 'outbound is switched off' : '';
    return '<tr>' +
      '<td><span class="sy-mono">' + escHtml(a.name) + '</span>' +
        '<div class="sy-note">' + escHtml(a.describe || '') + '</div></td>' +
      '<td class="sy-note">' + escHtml(a.endpoint) + '</td>' +
      '<td>' + (a.verified
          ? '<span class="sy-chip done">verified</span>'
          : '<span class="sy-chip ' + (a.draft ? 'parked' : 'off') + '">' + (a.draft ? 'draft' : 'unverified') + '</span>') + '</td>' +
      '<td class="sy-note sy-mono">' + escHtml((a.required || []).join(', ') || '-') + '</td>' +
      '<td class="sy-note">' + (a.expect_header ? 'watch for ' + escHtml(String(a.expect_header)) : '<span class="sy-note">&mdash;</span>') + '</td>' +
      '<td style="text-align:right">' +
        (can
          ? '<button class="btn btn-secondary btn-sm" onclick="syncOutRun(\'' + escHtml(a.name) + '\')">Run</button>'
          : '<span class="sy-note" title="' + escHtml(why) + '">unavailable</span>') +
      '</td>' +
    '</tr>';
  }).join('');

  var actions =
    '<div class="card" style="margin-bottom:14px">' +
      '<div class="card-header"><span class="card-title">What Nova can ask Pulsar to do</span></div>' +
      '<div class="card-body" style="padding:0">' +
        '<table class="table"><thead><tr>' +
          '<th>Action</th><th>Endpoint</th><th>State</th><th>Needs</th><th>Echo</th><th></th>' +
        '</tr></thead><tbody>' + acts + '</tbody></table>' +
      '</div>' +
      '<div class="card-body sy-note" style="border-top:1px solid var(--border)">' +
        '<b>Verified</b> means somebody has watched that action succeed against the real API, not that ' +
        'it matches the documentation. An unverified action is refused in live mode unless you tick ' +
        '"send it anyway" - so a wrong guess costs a rejection in the log below rather than a real ' +
        'technician sent to a real address.' +
      '</div>' +
    '</div>';

  var rows = (calls.calls || []).map(function (c) {
    var chip = c.status === 'done' ? 'done'
             : c.status === 'dry' ? 'pending'
             : c.status === 'failed' ? 'parked'
             : c.status === 'dead' ? 'failed' : 'processing';
    return '<tr class="sy-row-click" onclick="syncOutDetail(' + c.id + ')">' +
      '<td class="sy-mono">' + c.id + '</td>' +
      '<td class="sy-mono">' + escHtml(c.action) + '</td>' +
      '<td><span class="sy-chip ' + chip + '">' + escHtml(c.status) + '</span></td>' +
      '<td class="sy-note">' + (c.http_status === null || c.http_status === undefined ? '&mdash;' : c.http_status) + '</td>' +
      '<td class="sy-note">' + (c.duration_ms === null || c.duration_ms === undefined ? '&mdash;' : c.duration_ms + 'ms') + '</td>' +
      '<td class="sy-note">' + escHtml(c.user_name || 'system') + '</td>' +
      '<td class="sy-note">' + escHtml(syncDateStr(c.created_at)) + '</td>' +
      '<td class="sy-note" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        escHtml(c.error || '') + '</td>' +
    '</tr>';
  }).join('');

  var log =
    '<div class="card">' +
      '<div class="card-header"><span class="card-title">Call log</span></div>' +
      '<div class="card-body" style="padding:0">' +
        (rows
          ? '<table class="table"><thead><tr><th>#</th><th>Action</th><th>Status</th><th>HTTP</th>' +
            '<th>Took</th><th>By</th><th>When</th><th>Problem</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="card-body sy-note" style="text-align:center;padding:30px">' +
            'Nothing sent yet. Start with <span class="sy-mono">auth_test</span> - it is fully documented, ' +
            'it changes nothing in Pulsar, and if it comes back clean then the credentials and both ' +
            'header names are right.</div>') +
      '</div>' +
    '</div>';

  body.innerHTML = banner + cfg + actions + log;
}

// The parameter form. The fields vary per action and their list is still
// growing on Pulsar's side, so this is a JSON box rather than a generated form:
// a box accepts a field we have never heard of, and a generated form silently
// drops it.
function syncOutRun(name) {
  var spec = ((_syncOut && _syncOut.actions) || []).filter(function (a) { return a.name === name; })[0] || {};
  var seed = {};
  (spec.required || []).forEach(function (k) { seed[k] = ''; });

  var warn = '';
  if (!spec.verified && (_syncOut || {}).mode === 'live') {
    warn = '<div class="sy-warn">This action has not been confirmed against the real API' +
      (spec.draft ? ', and Pulsar documents the endpoint as a draft' : '') +
      '. Nothing will be sent unless you tick the box below.</div>';
  }
  if ((_syncOut || {}).mode === 'dry') {
    warn += '<div class="sy-note" style="margin-bottom:10px">Dry run: this will be built and logged, ' +
      'but not sent.</div>';
  }

  syncModal('Run ' + name, warn +
    '<div class="sy-note" style="margin-bottom:8px">' + escHtml(spec.describe || '') + '</div>' +
    '<div class="form-group"><label class="form-label">Parameters (JSON)</label>' +
      '<textarea id="sy-out-params" class="form-input sy-mono" rows="10">' +
        escHtml(JSON.stringify(seed, null, 2)) + '</textarea>' +
      '<div class="sy-note" style="margin-top:6px">Pulsar ids are 18 digits and must be quoted as ' +
        'strings. An id passed as a bare number loses its last two digits before it ever reaches ' +
        'this code, so the request will be refused rather than sent to the wrong record.</div>' +
    '</div>' +
    (spec.verified ? '' :
      '<label class="sy-note" style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
        '<input type="checkbox" id="sy-out-force"> Send it anyway, even though it is unverified' +
      '</label>') +
    '<div id="sy-out-err" class="alert alert-error" style="display:none;margin-top:10px"></div>',
    'Send', async function () {
      var errEl = document.getElementById('sy-out-err');
      var raw = document.getElementById('sy-out-params').value;
      var params;
      try { params = JSON.parse(raw || '{}'); }
      catch (e) {
        errEl.style.display = 'block';
        errEl.textContent = 'That is not valid JSON: ' + e.message;
        return;
      }
      var forceEl = document.getElementById('sy-out-force');
      try {
        var out = await api('POST', '/pulsar-out/actions/' + encodeURIComponent(name),
          { params: params, force: !!(forceEl && forceEl.checked) });
        syncCloseModal();
        if (out.dry) {
          showToast('Dry run recorded as call #' + out.id + '. Nothing was sent.', 'success');
        } else if (out.ok && out.uncertain) {
          showToast('Sent, but Pulsar answered in a shape we do not recognise. Watch the Events tab.', 'success');
        } else if (out.ok) {
          showToast('Sent' + (out.expect_header ? ' - now watch Events for ' + out.expect_header : ''), 'success');
        } else {
          showToast('Pulsar refused it: ' + (out.error || 'no reason given'), 'error');
        }
        syncRefresh();
      } catch (e) {
        errEl.style.display = 'block';
        errEl.textContent = e.message;
      }
    }, true);
}

async function syncOutDetail(id) {
  var c;
  try {
    var d = await api('GET', '/pulsar-out/calls?limit=200');
    c = (d.calls || []).filter(function (r) { return r.id === id; })[0];
  } catch (e) { showToast(e.message, 'error'); return; }
  if (!c) return;

  var pretty = function (s) {
    if (!s) return '';
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return String(s); }
  };

  syncModal('Outbound call #' + c.id,
    '<div class="sy-kv" style="margin-bottom:14px">' +
      '<div class="lbl">Action</div><div class="sy-mono">' + escHtml(c.action) + '</div>' +
      '<div class="lbl">Endpoint</div><div class="sy-mono">' + escHtml(c.request_shape || '') + '</div>' +
      '<div class="lbl">Mode</div><div>' + escHtml(c.mode) + '</div>' +
      '<div class="lbl">Status</div><div>' + escHtml(c.status) + '</div>' +
      '<div class="lbl">HTTP</div><div>' + (c.http_status === null ? '&mdash;' : c.http_status) + '</div>' +
      '<div class="lbl">Took</div><div>' + (c.duration_ms === null ? '&mdash;' : c.duration_ms + 'ms') + '</div>' +
      '<div class="lbl">Attempts</div><div>' + escHtml(String(c.attempts)) + '</div>' +
      '<div class="lbl">By</div><div>' + escHtml(c.user_name || 'system') + '</div>' +
      '<div class="lbl">Sent</div><div>' + escHtml(syncDateStr(c.created_at)) + '</div>' +
      (c.error ? '<div class="lbl">Problem</div><div style="color:#f87171">' + escHtml(c.error) + '</div>' : '') +
    '</div>' +
    '<div class="sy-note" style="margin-bottom:4px">Request sent (credentials removed before storage)</div>' +
    '<pre class="sy-pre">' + escHtml(pretty(c.request_body)) + '</pre>' +
    '<div class="sy-note" style="margin:12px 0 4px">Response</div>' +
    '<pre class="sy-pre">' + escHtml(pretty(c.response_body) || '(none)') + '</pre>',
    syncCan('pulsar_write') ? 'Send again' : null,
    async function () {
      try {
        await api('POST', '/pulsar-out/calls/' + c.id + '/resend', {});
        syncCloseModal();
        showToast('Sent again', 'success');
        syncRefresh();
      } catch (e) { showToast(e.message, 'error'); }
    }, true);
}
