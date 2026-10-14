// ===========================================================================
//  Nova - Dispatch board + duty status ("ready to accept calls")
// ---------------------------------------------------------------------------
//  Techs here do not punch a time clock. "Ready to accept calls" is the switch
//  that decides three things: whether the board is visible, whether dispatch
//  treats you as available, and whether Nova stores your position at all.
//
//  There is NO automatic overnight clear - nights are a real shift - so the
//  board reports how long someone has been marked ready instead, and dispatch
//  can clear a forgotten toggle by hand.
//
//  Classic script like app.js: everything global, inline onclick handlers work.
// ===========================================================================

var _dispDuty = null;
var _dispJobs = [];
var _dispCanManage = false;
var _dispCrew = [];
var _dispTimer = null;
var _dispCities = [];

var DISP_STATUS = {
  new:       { label: 'Unassigned',    color: '#f59e0b' },
  assigned:  { label: 'Not acknowledged', color: '#ef4444' },
  accepted:  { label: 'Acknowledged',  color: '#3b82f6' },
  enroute:   { label: 'On the way',    color: '#a855f7' },
  onscene:   { label: 'On scene',      color: '#22c55e' },
  done:      { label: 'Done',          color: '#71717a' },
  goa:       { label: 'GOA',           color: '#f97316' },
  cancelled: { label: 'Cancelled',     color: '#52525b' }
};
// What a tech's own job offers next, in the tech's own words. Accept is its own
// step: "I have read this" is a different fact from "I have left", and dispatch
// needs both.
var DISP_NEXT = {
  assigned: { to: 'accepted', label: 'Acknowledge call' },
  accepted: { to: 'enroute',  label: 'On my way' },
  enroute:  { to: 'onscene',  label: 'I have arrived' },
  onscene:  { to: 'done',     label: 'Job complete' }
};
var DISP_GOA_FROM = ['accepted', 'enroute', 'onscene'];
var _dispCanAssign = false;
var _dispAcceptMins = 2;
var _dispSeenIds = {};
var _dispMe = null;
// --- Phase 2A/2B ---
var _dispRef = null;          // service types / categories / tags / cities / accounts
var _dispCanSeeViews = false;
var _dispAgeWarn = 20;
var _dispAgeAlert = 45;
var _dispTick = null;
var _dispDetail = null;       // the call currently open on the detail screen
var _dispBackTo = 'dispatch';

// Which board columns this person wants, and in which order. Kept in
// localStorage rather than on the server: it is a per-device preference on a
// screen people run on a wall display and a phone at the same time, and the one
// thing that MUST be server-side (which columns you are allowed to see at all)
// is Call Search's problem, not this board's - nothing here is gated.
var DISP_COLS = [
  { k: 'age',      l: 'Age',           on: true },
  { k: 'status',   l: 'Status',        on: true },
  { k: 'eta',      l: 'ETA',           on: true },
  { k: 'expire',   l: 'Expire',        on: true },
  { k: 'lead',     l: 'Lead',          on: true },
  { k: 'account',  l: 'Account',       on: true },
  { k: 'tags',     l: 'Tags',          on: true },
  { k: 'location', l: 'Location',      on: true },
  { k: 'zip',      l: 'Zip',           on: true },
  { k: 'customer', l: 'Customer',      on: true },
  { k: 'address',  l: 'Address',       on: true },
  { k: 'business', l: 'Business',      on: false },
  { k: 'po',       l: 'PO',            on: false },
  { k: 'byname',   l: 'Dispatched by', on: false },
  { k: 'callid',   l: 'Call ID',       on: true }
];
function dispCols() {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('nova_disp_cols') || 'null'); } catch (e) {}
  if (!Array.isArray(saved) || !saved.length) {
    return DISP_COLS.filter(function (c) { return c.on; }).map(function (c) { return c.k; });
  }
  // Drop anything that is no longer a real column, so an old saved list from a
  // previous version cannot render an empty board.
  var valid = saved.filter(function (k) {
    return DISP_COLS.some(function (c) { return c.k === k; });
  });
  return valid.length ? valid : DISP_COLS.filter(function (c) { return c.on; }).map(function (c) { return c.k; });
}
function dispColLabel(k) {
  for (var i = 0; i < DISP_COLS.length; i++) if (DISP_COLS[i].k === k) return DISP_COLS[i].l;
  return k;
}

function dispBoardCss() {
  return '' +
    '.dispb{width:100%;border-collapse:collapse;min-width:1180px}' +
    '.dispb thead th{text-align:left;font-size:11px;font-weight:700;letter-spacing:.06em;' +
      'text-transform:uppercase;color:var(--text-muted-color);padding:9px 10px;' +
      'border-bottom:1px solid var(--border);white-space:nowrap}' +
    '.dispb tbody td{padding:9px 10px;font-size:13.5px;border-bottom:1px solid var(--border-light);' +
      'vertical-align:middle}' +
    '.dispb tbody tr{cursor:pointer}' +
    '.dispb tbody tr:hover td{background:rgba(249,115,22,.07)}' +
    '.dispb tbody tr.mine td{box-shadow:inset 3px 0 0 var(--primary)}' +
    '.dispb tbody tr.edu td{background:rgba(239,68,68,.07)}' +
    '.disp-age{font-variant-numeric:tabular-nums;font-weight:700}' +
    '.disp-ageok{color:#4ade80}.disp-agewarn{color:#fbbf24}.disp-agebad{color:#f87171}' +
    '.disp-exp{font-variant-numeric:tabular-nums;font-weight:700;display:inline-block;' +
      'padding:1px 7px;border-radius:5px}' +
    '.disp-exp.bad{background:#ef4444;color:#fff}' +
    '.disp-exp.warn{color:#fbbf24}.disp-exp.ok{color:#4ade80}' +
    '.disp-tinystat{font-size:10.5px;color:var(--text-muted-color);font-variant-numeric:tabular-nums;margin-top:2px}' +
    '.disp-tag{display:inline-block;padding:1px 7px;border-radius:5px;font-size:11px;' +
      'font-weight:600;margin:1px 3px 1px 0}' +
    '.disp-retail{background:rgba(136,136,136,.16);color:var(--text-muted-color);padding:1px 7px;' +
      'border-radius:5px;font-size:11px;font-weight:600}' +
    '.disp-edu{background:rgba(239,68,68,.2);color:#fca5a5;padding:1px 7px;border-radius:5px;' +
      'font-size:10.5px;font-weight:800;letter-spacing:.04em}' +
    '.disp-needsvc{background:rgba(245,158,11,.16);color:#fbbf24;padding:1px 7px;border-radius:5px;' +
      'font-size:11px;font-weight:700}' +
    '.disp-dgrid{display:grid;grid-template-columns:1fr 380px;gap:16px;align-items:start}' +
    '@media (max-width:1100px){.disp-dgrid{grid-template-columns:1fr}}' +
    '.disp-f2{display:grid;grid-template-columns:1fr 1fr;gap:14px}' +
    '.disp-f3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}' +
    '@media (max-width:760px){.disp-f2,.disp-f3{grid-template-columns:1fr}}' +
    '.disp-sechead{font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;' +
      'color:var(--primary);margin:2px 0 11px;padding-bottom:6px;border-bottom:1px solid var(--border)}' +
    '.disp-ro label{font-size:11px;font-weight:700;color:var(--text-muted-color);' +
      'text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px}' +
    '.disp-ro .v{background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;' +
      'padding:8px 11px;font-size:14px;min-height:19px;word-break:break-word}' +
    '.disp-ro{margin-bottom:13px}' +
    '.disp-log{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}' +
    '.disp-log table{width:100%;border-collapse:collapse}' +
    '.disp-log th{background:var(--bg-elevated);text-align:left;font-size:10.5px;font-weight:700;' +
      'letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted-color);padding:7px 10px}' +
    '.disp-log td{padding:6px 10px;font-size:12.5px;border-bottom:1px solid var(--border-light);' +
      'vertical-align:top}' +
    '.disp-log td.t{color:var(--text-muted-color);white-space:nowrap;font-variant-numeric:tabular-nums}' +
    '.disp-log td.a{font-weight:700;white-space:nowrap}' +
    '.disp-log tr.vw td{color:var(--text-muted-color);font-style:italic}' +
    '.disp-acctnote{border-left:3px solid var(--warning);background:rgba(245,158,11,.09);' +
      'padding:8px 12px;border-radius:5px;font-size:12.5px;color:#fcd9a0;margin-bottom:13px}' +
    '.disp-colpick{max-height:340px;overflow:auto;border:1px solid var(--border);' +
      'border-radius:var(--radius);padding:8px}' +
    '.disp-colpick label{display:flex;align-items:center;gap:9px;padding:5px 6px;border-radius:5px;' +
      'font-size:13.5px;margin:0}' +
    '.disp-colpick label:hover{background:var(--bg-elevated)}' +
    '.disp-colpick input{width:16px!important;height:16px;padding:0!important;margin:0;' +
      'flex:0 0 auto;accent-color:var(--primary)}';
}

function dispInjectStyles() {
  if (document.getElementById('disp-styles')) return;
  var css =
    '.disp-duty{display:flex;align-items:center;gap:16px;flex-wrap:wrap;background:var(--bg-card,#1a1a1a);' +
      'border:1px solid var(--border,#2e2e2e);border-radius:12px;padding:16px 18px;margin-bottom:16px}' +
    '.disp-duty.on{border-color:#22c55e;box-shadow:0 0 0 1px #22c55e inset}' +
    '.disp-dutydot{width:14px;height:14px;border-radius:50%;flex:none}' +
    '.disp-dutytxt{font-weight:800;font-size:16px}' +
    '.disp-dutysub{font-size:12px;color:var(--text-muted-color,#888);margin-top:2px}' +
    '.disp-big{margin-left:auto;padding:13px 26px;border-radius:10px;border:0;font-weight:800;font-size:15px;' +
      'cursor:pointer;color:#fff;min-width:190px}' +
    '.disp-gate{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:12px;' +
      'padding:34px 26px;text-align:center;max-width:560px;margin:0 auto}' +
    '.disp-gate h3{margin:0 0 8px;font-size:19px}' +
    '.disp-gate p{color:var(--text-muted-color,#888);font-size:14px;line-height:1.6;margin:0 auto 18px;max-width:430px}' +
    '.disp-cols{display:flex;gap:14px;align-items:flex-start}' +
    '.disp-main{flex:1;min-width:0}' +
    '.disp-side{width:270px;flex:none}' +
    '.disp-job{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:10px;' +
      'padding:12px 14px;margin-bottom:9px}' +
    '.disp-job.mine{border-color:var(--primary,#f97316)}' +
    '.disp-job.urgent{border-left:4px solid #ef4444}' +
    '.disp-job.late{box-shadow:0 0 0 1px #f59e0b inset}' +
    '.disp-jobhead{display:flex;align-items:center;gap:9px;flex-wrap:wrap}' +
    '.disp-chip{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:3px 8px;border-radius:20px}' +
    '.disp-num{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--text-muted-color,#888)}' +
    '.disp-cust{font-weight:700;font-size:15px}' +
    '.disp-line{font-size:13px;color:var(--text-dim,#bbb);margin-top:3px}' +
    '.disp-muted{font-size:12px;color:var(--text-muted-color,#888);margin-top:4px}' +
    '.disp-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}' +
    '.disp-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--border,#2e2e2e);background:transparent;' +
      'color:var(--text-dim,#bbb);font-weight:600;font-size:13px;cursor:pointer}' +
    '.disp-btn:hover{border-color:var(--primary,#f97316);color:var(--text,#f0f0f0)}' +
    '.disp-btn.go{background:var(--primary,#f97316);border-color:var(--primary,#f97316);color:#fff}' +
    '.disp-crew{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:10px;padding:9px 12px;margin-bottom:7px}' +
    '.disp-crewname{font-weight:700;display:flex;align-items:center;gap:8px;font-size:14px}' +
    '.disp-warn{color:#f59e0b}' +
    '.disp-sec{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;' +
      'color:var(--text-muted-color,#888);margin:16px 2px 8px}' +
    '@media (max-width:860px){.disp-cols{flex-direction:column}.disp-side{width:100%}.disp-big{margin-left:0;width:100%}}';
  var el = document.createElement('style');
  el.id = 'disp-styles';
  // dispBoardCss() has to be added BEFORE the text goes in. It used to be
  // appended afterwards, so the board table, age/expire colours and the call
  // form grid never got their styles.
  css += dispBoardCss() + dispQueueCss();
  el.textContent = css;
  document.head.appendChild(el);
}


// ---------------------------------------------------------------------------
//  Sound (dispatcher desk only)
// ---------------------------------------------------------------------------
// Tones are generated, not loaded, so there is no audio file to ship, nothing to
// 404, and it works with the app offline. Browsers refuse to make noise until
// the user has interacted with the page, so the first click anywhere arms it.
//
// Only three things earn a sound. If everything beeps, people mute it within a
// week and then the alerts are worse than none.
var _dispAudio = null;
var _dispArmed = false;

function dispSoundOn() {
  try { return localStorage.getItem('nova_dispatch_sound') !== '0'; } catch (e) { return true; }
}
function dispSetSound(on) {
  try { localStorage.setItem('nova_dispatch_sound', on ? '1' : '0'); } catch (e) {}
}
function dispArmAudio() {
  if (_dispArmed) return;
  _dispArmed = true;
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) { _dispAudio = new Ctx(); if (_dispAudio.state === 'suspended') _dispAudio.resume(); }
  } catch (e) { _dispAudio = null; }
}

// notes = [[frequency, startOffsetSeconds, durationSeconds], ...]
function dispTone(notes) {
  if (!dispSoundOn()) return;
  dispArmAudio();
  if (!_dispAudio) return;
  try {
    if (_dispAudio.state === 'suspended') _dispAudio.resume();
    var t0 = _dispAudio.currentTime;
    notes.forEach(function (n) {
      var osc = _dispAudio.createOscillator();
      var gain = _dispAudio.createGain();
      osc.type = 'sine';
      osc.frequency.value = n[0];
      // Ramped, not switched. A square-edged gain change clicks, and a click on
      // every alert is what makes people reach for the mute button.
      gain.gain.setValueAtTime(0.0001, t0 + n[1]);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + n[1] + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
      osc.connect(gain); gain.connect(_dispAudio.destination);
      osc.start(t0 + n[1]); osc.stop(t0 + n[1] + n[2] + 0.05);
    });
  } catch (e) {}
}

function dispSoundNewCall()   { dispTone([[784, 0, 0.16], [1046, 0.17, 0.22]]); }        // rising two-tone
function dispSoundOverdue()   { dispTone([[880, 0, 0.13], [880, 0.19, 0.13], [880, 0.38, 0.2]]); } // insistent triple
function dispSoundUnaccepted(){ dispTone([[660, 0, 0.15], [523, 0.18, 0.28]]); }         // falling, "something is wrong"

// Fires the right sound for what actually changed since the last refresh.
var _dispPrev = null;
function dispSoundForChanges(jobs) {
  if (!_dispCanManage) return;             // techs get a push, not a desk beep
  if (_dispPrev === null) { _dispPrev = dispSnapshot(jobs); return; }  // no noise on first load
  var now = dispSnapshot(jobs);
  var newCall = false, overdue = false, unaccepted = false;
  Object.keys(now).forEach(function (id) {
    var was = _dispPrev[id];
    if (!was) { if (now[id].status === 'new') newCall = true; return; }
    if (!was.overdueUnassigned && now[id].overdueUnassigned) overdue = true;
    if (!was.overdueAccept && now[id].overdueAccept) unaccepted = true;
  });
  _dispPrev = now;
  // One sound per refresh, most urgent wins. Three alerts stacking on top of
  // each other is noise, not information.
  if (overdue) dispSoundOverdue();
  else if (unaccepted) dispSoundUnaccepted();
  else if (newCall) dispSoundNewCall();
}

function dispSnapshot(jobs) {
  var out = {};
  jobs.forEach(function (j) {
    out[j.id] = {
      status: j.status,
      overdueUnassigned: !!j.unassigned_alert_at,
      overdueAccept: dispAcceptOverdue(j)
    };
  });
  return out;
}

// Amber the moment the clock runs out, whether or not the cron has caught up.
function dispAcceptOverdue(j) {
  if (j.status !== 'assigned' || !j.assigned_at || j.accepted_at) return false;
  return (Date.now() - new Date(j.assigned_at).getTime()) / 60000 >= (_dispAcceptMins || 2);
}

function dispStop() { if (_dispTimer) { clearInterval(_dispTimer); _dispTimer = null; } }

// A tech marked ready for most of a day has almost certainly forgotten to turn
// it off. We do not clear it for them (a night shift is real work), we say so.
var DISP_LONG_HOURS = 16;
function dispHrs(h) {
  if (h === null || h === undefined) return '';
  if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
  return (Math.round(h * 10) / 10) + 'h';
}


// ---------------------------------------------------------------------------
//  Modal (matches Nova's existing .modal-overlay markup, no new CSS)
// ---------------------------------------------------------------------------
function dispModal(title, bodyHtml, okLabel, onOk) {
  dispCloseModal();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'disp-modal';
  overlay.innerHTML =
    '<div class="modal">' +
      '<div class="modal-header"><span class="modal-title">' + escHtml(title) + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="dispCloseModal()">&#x2715;</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-secondary" onclick="dispCloseModal()">Cancel</button>' +
        '<button class="btn btn-primary" id="disp-modal-ok">' + escHtml(okLabel) + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  var ok = document.getElementById('disp-modal-ok');
  if (ok) ok.onclick = onOk;
}
function dispCloseModal() {
  var m = document.getElementById('disp-modal');
  if (m) m.parentNode.removeChild(m);
}

async function renderDispatch(content) {
  dispInjectStyles();
  document.addEventListener('click', dispArmAudio, { once: true });
  dispStop();
  content.innerHTML = '<div class="page-header"><div><div class="page-title">Dispatch</div>' +
    '<div class="page-subtitle">Loading...</div></div></div>';

  try { _dispDuty = await api('GET', '/dispatch/duty'); }
  catch (e) { content.innerHTML = '<div class="card"><div class="card-body">Could not load dispatch.</div></div>'; return; }
  _dispCanManage = !!_dispDuty.canManage;

  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Dispatch</div>' +
      '<div class="page-subtitle">' +
        (_dispCanManage ? 'Live board. Assign a call to whoever is ready and closest.'
                        : 'Your calls, and what the rest of the crew is on.') +
      '</div></div></div>' +
    '<div id="disp-duty"></div>' +
    '<div id="disp-body"></div>';

  dispRenderDuty();

  if (!_dispDuty.ready && !_dispCanManage) return dispRenderGate();
  await dispLoadBoard();

  _dispTimer = setInterval(function () {
    if (document.hidden) return;
    if (typeof state !== 'undefined' && state.currentView !== 'dispatch') { dispStop(); return; }
    dispLoadBoard();
  }, 20000);
}

// ---------------------------------------------------------------------------
//  The duty switch
// ---------------------------------------------------------------------------
// The switch belongs on the phone that is in the truck. Dispatch runs this board
// on a desktop and on a wall display, and "ready" typed from a machine sitting on
// a desk is a location fix that means nothing - the whole point of the toggle is
// that it says where the tech actually is. So the card only draws on mobile: the
// native app, or a phone / tablet browser until the app is on every phone.
function dispIsMobile() {
  try {
    if (typeof novaIsNative === 'function' && novaIsNative()) return true;
    if (window.matchMedia('(max-width: 768px)').matches) return true;
    return window.matchMedia('(pointer: coarse)').matches &&
           window.matchMedia('(max-width: 1024px)').matches;
  } catch (e) { return false; }
}

function dispRenderDuty() {
  var host = document.getElementById('disp-duty');
  if (!host) return;
  if (!dispIsMobile()) { host.innerHTML = ''; return; }
  var on = !!_dispDuty.ready;
  var h = _dispDuty.hours_on_duty;
  var longOn = on && h !== null && h >= DISP_LONG_HOURS;

  host.innerHTML =
    '<div class="disp-duty' + (on ? ' on' : '') + '">' +
      '<span class="disp-dutydot" style="background:' + (on ? '#22c55e' : '#71717a') + '"></span>' +
      '<div>' +
        '<div class="disp-dutytxt">' + (on ? 'Ready to accept calls' : 'Not accepting calls') + '</div>' +
        '<div class="disp-dutysub">' +
          (on
            ? ('On duty ' + dispHrs(h) + '. Dispatch can send you work and Nova is sharing your position.' +
               (longOn ? ' <span class="disp-warn">That is a long stretch - turn it off if you are done.</span>' : ''))
            : 'Nova is not recording your location. Turn this on when you start.') +
        '</div>' +
      '</div>' +
      '<button class="disp-big" style="background:' + (on ? '#ef4444' : '#22c55e') + '" onclick="dispToggleDuty()">' +
        (on ? 'Stop accepting calls' : 'Ready to accept calls') +
      '</button>' +
    '</div>';
}

async function dispToggleDuty() {
  var want = !_dispDuty.ready;
  try { _dispDuty = Object.assign(_dispDuty, await api('POST', '/dispatch/duty', { ready: want })); }
  catch (e) {
    if (typeof showToast === 'function') showToast(e.message || 'Could not change your status.', 'error');
    return;
  }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  // Start or stop the browser location watcher to match, so the switch really
  // means what it says instead of only being a flag on the server.
  try {
    if (_dispDuty.ready) { if (typeof novaLocStart === 'function') novaLocStart(true); }
    else if (typeof novaLocStop === 'function') novaLocStop();
  } catch (e) {}
  if (typeof render === 'function') render();
}

function dispRenderGate() {
  var body = document.getElementById('disp-body');
  if (!body) return;
  var mob = dispIsMobile();
  body.innerHTML =
    '<div class="disp-gate">' +
      '<h3>The board opens when you do</h3>' +
      '<p>Calls, addresses and customer details stay hidden until you are ready to accept work. ' +
         (mob
           ? 'Tap the green button above when you start your day, and turn it off when you are done.'
           : 'You go ready in the Nova app on your phone - that is the device dispatch needs a position from, ' +
             'so the switch is not on this screen. Once you are ready there, the board opens here too.') +
      '</p>' +
      (mob ? '<div id="disp-loc" style="text-align:left"></div>' : '') +
    '</div>';
  if (mob && typeof novaLocCard === 'function') novaLocCard(document.getElementById('disp-loc'));
}

// ---------------------------------------------------------------------------
//  The board
// ---------------------------------------------------------------------------
async function dispLoadBoard() {
  var body = document.getElementById('disp-body');
  if (!body) return;
  var data, crew = { people: [] };
  try {
    data = await api('GET', '/dispatch/jobs');
    crew = await api('GET', '/dispatch/duty/all');
  } catch (e) {
    body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message || 'Could not load the board.') + '</div></div>';
    return;
  }
  _dispJobs = data.jobs || [];
  _dispCanManage = !!data.canManage;
  _dispCanAssign = !!data.canAssign;
  if (data.acceptTimeoutMinutes) _dispAcceptMins = data.acceptTimeoutMinutes;
  if (data.ageWarnMinutes) _dispAgeWarn = data.ageWarnMinutes;
  if (data.ageAlertMinutes) _dispAgeAlert = data.ageAlertMinutes;
  _dispCanSeeViews = !!data.canSeeViews;
  if (!_dispRef) { try { _dispRef = await api('GET', '/dispatch/reference'); } catch (e) { _dispRef = null; } }
  _dispCrew = crew.people || [];
  dispSoundForChanges(_dispJobs);
  dispReportViews(_dispJobs);
  if (_dispCanManage && !_dispCities.length) {
    try { _dispCities = await api('GET', '/cities'); } catch (e) { _dispCities = []; }
  }
  _dispMe = data.me;
  dispDrawBoard();
  dispStartTicking();
}

// ---------------------------------------------------------------------------
//  Queue view: city chips, counters, Waiting / In progress (Tony 2026-10-13)
// ---------------------------------------------------------------------------
// Plan: claude/nova-dispatch-new-call-plan.md, "Live board". Waiting calls are
// in queue order (EDU, then account tier, then whoever is closest to missing
// the promised ETA). In progress is riskiest first. The city chips and the
// counters are a per-device view choice, so they live in localStorage.
var DISP_WAITING = ['new', 'assigned'];
var DISP_RISK_MIN = 5;          // "at risk" = promised ETA within this many minutes

function dispQueueCss() {
  return '' +
    '.disp-chips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}' +
    '.disp-cchip{height:34px;padding:0 12px;border-radius:17px;border:1px solid var(--border,#2e2e2e);background:transparent;' +
      'color:var(--text-dim,#bbb);font:inherit;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px}' +
    '.disp-cchip b{font-variant-numeric:tabular-nums;color:var(--text,#f0f0f0)}' +
    '.disp-cchip.zero{opacity:.55}' +
    '.disp-cchip.on{border-color:var(--primary,#f97316);background:rgba(249,115,22,.14);color:var(--primary,#f97316)}' +
    '.disp-cchip.on b{color:var(--primary,#f97316)}' +
    '.disp-counters{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:0 0 14px}' +
    '.disp-counter{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:10px;padding:9px 12px}' +
    '.disp-counter .n{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}' +
    '.disp-counter .l{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted-color,#888)}' +
    '.disp-counter.hot{border-color:#ef444488}.disp-counter.hot .n{color:#f87171}' +
    '.disp-counter.warm .n{color:#fbbf24}' +
    '.disp-tier{display:inline-block;margin-left:6px;padding:0 6px;border-radius:5px;border:1px solid var(--border,#3a3a3a);' +
      'font-size:10.5px;font-weight:800;color:var(--text-dim,#bbb);vertical-align:1px}' +
    '.disp-tier.t1{border-color:#f9731688;color:#fb923c}' +
    '.disp-ai{display:inline-block;padding:2px 8px;border-radius:6px;background:rgba(168,85,247,.16);color:#d8b4fe;font-size:12px;font-weight:700;white-space:nowrap}' +
    '.disp-send{padding:4px 10px;font-size:12px;white-space:nowrap}' +
    '.disp-ackdue{margin-top:8px;font-size:13px;font-weight:700;color:#fbbf24;font-variant-numeric:tabular-nums}' +
    '.disp-ackdue.late{color:#f87171}' +
    '.disp-nextbtn{display:block;width:100%;margin-top:12px;min-height:50px;font-size:16px;font-weight:800;border-radius:10px}' +
    '.disp-job .disp-acts a.disp-btn{text-decoration:none;display:inline-flex;align-items:center}' +
    '.disp-steps{list-style:none;margin:12px 0 0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;' +
      'font-size:11px;color:var(--text-muted-color,#888)}' +
    '.disp-steps li:before{content:"";display:block;height:4px;border-radius:2px;background:var(--border,#2e2e2e);margin-bottom:4px}' +
    '.disp-steps li.done:before{background:#22c55e}.disp-steps li.cur{color:var(--text,#f0f0f0);font-weight:700}' +
    '.disp-steps li.cur:before{background:var(--primary,#f97316)}' +
    '.disp-minis{display:flex;flex-direction:column;gap:8px}' +
    '.disp-mini{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:10px;padding:11px 13px;cursor:pointer}' +
    '.disp-mini.edu{border-left:4px solid #ef4444}' +
    '.disp-mini .r1{display:flex;justify-content:space-between;gap:8px;align-items:center}' +
    '.disp-mini .r2{font-size:13px;color:var(--text-dim,#bbb);margin-top:3px}' +
    // The tech's address link was default dark blue on the dark card.
    '.disp-line a{color:var(--primary,#f97316)}' +
    // Stacked on a phone the columns must fill the width, not size to their
    // content, or the city chip row pushes the whole page sideways.
    '@media (max-width:860px){.disp-cols{align-items:stretch}.disp-main{width:100%}}' +
    '@media (max-width:1100px){.disp-counters{grid-template-columns:repeat(3,minmax(0,1fr))}}' +
    '@media (max-width:560px){.disp-counters{grid-template-columns:repeat(2,minmax(0,1fr))}' +
      '.disp-chips{flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px}.disp-cchip{flex:none}' +
      '.disp-job.mine .disp-acts .disp-btn{flex:1;justify-content:center;min-height:46px}}';
}

// Who goes (step 5). Shadow mode: roadside says what the AI WOULD do (a person
// still sends it); locksmith gets a one-tap Send for the best-ETA tech.
function dispSuggestHtml(j) {
  var sg = j.suggestion;
  if (!sg) return '';
  var first = escHtml(String(sg.name || '').split(' ')[0]);
  var eta = sg.eta_minutes !== null && sg.eta_minutes !== undefined ? ' &middot; ' + sg.eta_minutes + 'm' : '';
  function btn(label) {
    if (!_dispCanAssign) return '';
    return '<button type="button" class="disp-btn go disp-send" title="' + escHtml(sg.why || '') + '" ' +
      'onclick="event.stopPropagation();dispQuickSend(' + j.id + ',' + sg.user_id + ')">' + label + '</button>';
  }
  if (sg.ai) {
    return '<span class="disp-ai" title="' + escHtml(sg.why || '') + '">AI would send ' + first + eta + '</span> ' + btn('Send');
  }
  return btn('Send ' + first + eta) || first;
}
async function dispQuickSend(id, uid) {
  var r;
  try { r = await api('POST', '/dispatch/jobs/' + id + '/assign', { user_id: uid, suggested_user_id: uid }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (r && r.warning && typeof showToast === 'function') showToast(r.warning, 'error');
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

function dispTier(j) { var t = parseInt(j.account_tier, 10); return t >= 1 && t <= 3 ? t : 9; }
function dispTierBadge(j) {
  var t = dispTier(j);
  return t < 9 ? '<span class="disp-tier t' + t + '">Tier ' + t + '</span>' : '';
}
// What the customer was promised. A call with no promise is treated as due an
// hour after it came in, so it still sorts somewhere sensible.
function dispDueAt(j) {
  if (j.eta_promised_at) return new Date(j.eta_promised_at).getTime();
  return new Date(j.created_at).getTime() + 60 * 60000;
}
function dispPri(j) { return j.priority === 'urgent' ? 0 : j.priority === 'low' ? 2 : 1; }
function dispQueueSort(a, b) {
  var ea = a.is_edu ? 0 : 1, eb = b.is_edu ? 0 : 1;
  if (ea !== eb) return ea - eb;
  var ta = dispTier(a), tb = dispTier(b);
  if (ta !== tb) return ta - tb;
  var pa = dispPri(a), pb = dispPri(b);
  if (pa !== pb) return pa - pb;
  return dispDueAt(a) - dispDueAt(b);
}
// In progress: whoever is closest to missing the promise first; people already
// on scene have kept it, so they go to the bottom.
function dispRiskSort(a, b) {
  var sa = a.status === 'onscene' ? 1 : 0, sb = b.status === 'onscene' ? 1 : 0;
  if (sa !== sb) return sa - sb;
  if (!!a.is_edu !== !!b.is_edu) return a.is_edu ? -1 : 1;
  return dispDueAt(a) - dispDueAt(b);
}
function dispAtRisk(j, now) {
  if (j.status === 'onscene' || !j.eta_promised_at) return false;
  return (new Date(j.eta_promised_at).getTime() - (now || Date.now())) / 60000 <= DISP_RISK_MIN;
}

function dispCityPick() { try { return localStorage.getItem('nova_disp_city') || ''; } catch (e) { return ''; } }
function dispSetCity(code) {
  try { localStorage.setItem('nova_disp_city', code || ''); } catch (e) {}
  dispDrawBoard();
}
function dispCode(c) { return String(c || '').trim(); }

function dispNavUrl(j) {
  if (j.lat !== null && j.lat !== undefined && j.lon !== null && j.lon !== undefined) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + Number(j.lat) + ',' + Number(j.lon);
  }
  return 'https://www.google.com/maps/dir/?api=1&destination=' +
    encodeURIComponent([j.address, j.city_state_zip || j.zip].filter(Boolean).join(', '));
}

function dispStepsHtml(j) {
  var order = ['accepted', 'enroute', 'onscene', 'done'];
  var names = ['Acknowledge', 'On the way', 'On scene', 'Done'];
  var at = order.indexOf(j.status);       // -1 = not acknowledged yet
  return '<ol class="disp-steps" aria-label="Steps">' + names.map(function (n, i) {
    var cls = i <= at ? 'done' : (i === at + 1 ? 'cur' : '');
    return '<li class="' + cls + '"' + (i === at + 1 ? ' aria-current="step"' : '') + '>' + n + '</li>';
  }).join('') + '</ol>';
}

function dispChipsHtml(cityJobs, pick) {
  var cities = ((_dispRef && _dispRef.cities) || []);
  if (cities.length < 2) return '';
  var counts = {};
  cityJobs.forEach(function (j) { var c = dispCode(j.city_code); counts[c] = (counts[c] || 0) + 1; });
  function chip(code, label, n) {
    var on = code === pick;
    return '<button type="button" class="disp-cchip' + (on ? ' on' : '') + (n ? '' : ' zero') + '" aria-pressed="' + on + '"' +
      ' onclick="dispSetCity(&quot;' + escHtml(code) + '&quot;)">' + escHtml(label) + ' <b>' + n + '</b></button>';
  }
  return '<div class="disp-chips" role="group" aria-label="Filter by city">' +
    chip('', 'All', cityJobs.length) +
    cities.map(function (c) { var code = dispCode(c.code); return chip(code, c.name, counts[code] || 0); }).join('') +
    '</div>';
}

function dispCountersHtml(jobs, crew) {
  var now = Date.now();
  var waiting = 0, unack = 0, lateAck = 0, prog = 0, risk = 0;
  jobs.forEach(function (j) {
    if (j.status === 'new') waiting++;
    else if (j.status === 'assigned') { unack++; if (dispAcceptOverdue(j)) lateAck++; }
    else prog++;
    if (dispAtRisk(j, now)) risk++;
  });
  var ready = crew.filter(function (p) { return p.ready; }).length;
  function box(n, label, cls) {
    return '<div class="disp-counter ' + (cls || '') + '"><div class="n">' + n + '</div><div class="l">' + label + '</div></div>';
  }
  return '<div class="disp-counters">' +
    box(waiting, 'Waiting', waiting ? 'warm' : '') +
    box(unack, 'Not acknowledged', lateAck ? 'hot' : (unack ? 'warm' : '')) +
    box(prog, 'In progress', '') +
    box(risk, 'At risk of ETA', risk ? 'hot' : '') +
    box(ready, 'Techs ready', ready ? '' : 'hot') +
    '</div>';
}

// One line per call on a phone, where a 14-column table would scroll sideways.
function dispMiniCard(j) {
  var st = DISP_STATUS[j.status] || DISP_STATUS.new;
  return '<div class="disp-mini' + (j.is_edu ? ' edu' : '') + '" data-job="' + j.id + '">' +
    '<div class="r1"><b>' + escHtml(j.service_type_name || j.service_type || 'Call') + (j.is_edu ? ' &middot; EDU' : '') + '</b>' +
      '<span class="disp-chip" style="background:' + st.color + '22;color:' + st.color + '">' + st.label + '</span></div>' +
    '<div class="r2">' + escHtml([j.address, j.city_name].filter(Boolean).join(' \u00b7 ') || 'No address yet') + '</div>' +
    '<div class="r2"><span class="disp-age" data-age="' + new Date(j.created_at).getTime() + '"></span>' +
      (j.assigned_name ? ' &middot; ' + escHtml(j.assigned_name) : '') + (j.account_name ? ' &middot; ' + escHtml(j.account_name) : '') +
      dispTierBadge(j) + '</div>' +
      (!j.assigned_name && j.suggestion ? '<div class="r2" style="margin-top:6px">' + dispSuggestHtml(j) + '</div>' : '') +
    '</div>';
}
function dispListHtml(jobs, me, emptyText) {
  if (!dispIsMobile()) return dispBoardTable(jobs, me, emptyText);
  if (!jobs.length) return '<div class="text-muted" style="padding:10px 2px">' + escHtml(emptyText) + '</div>';
  return '<div class="disp-minis">' + jobs.map(dispMiniCard).join('') + '</div>';
}

// Draws from what dispLoadBoard fetched; the city chips call this directly so
// switching city does not wait on the network.
function dispDrawBoard() {
  var body = document.getElementById('disp-body');
  if (!body) return;
  var me = _dispMe;
  var pick = dispCityPick();
  var cities = ((_dispRef && _dispRef.cities) || []).map(function (c) { return dispCode(c.code); });
  if (pick && cities.length && cities.indexOf(pick) === -1) pick = '';
  var inCity = pick ? _dispJobs.filter(function (j) { return dispCode(j.city_code) === pick; }) : _dispJobs;
  var crew = pick ? _dispCrew.filter(function (p) { return dispCode(p.home_city) === pick; }) : _dispCrew;

  // Your own calls are never hidden by the city filter.
  var mine = _dispJobs.filter(function (j) { return j.assigned_to === me; }).sort(dispRiskSort);
  var rest = inCity.filter(function (j) { return j.assigned_to !== me; });
  var waiting = rest.filter(function (j) { return DISP_WAITING.indexOf(j.status) !== -1; }).sort(dispQueueSort);
  var going = rest.filter(function (j) { return DISP_WAITING.indexOf(j.status) === -1; }).sort(dispRiskSort);
  var canAdd = _dispCanManage || (typeof can === 'function' && can('add_dispatch_call'));

  body.innerHTML =
    '<div class="disp-cols">' +
      '<div class="disp-main">' +
        '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:12px">' +
          (canAdd ? '<button class="disp-btn go" onclick="dispNewJob()">New call</button>' : '') +
          '<button class="disp-btn" onclick="dispToggleSound()">' + (dispSoundOn() ? 'Sound on' : 'Sound off') + '</button>' +
          (dispIsMobile() ? '' : '<button class="disp-btn" onclick="dispColumnPicker()">Columns</button>') +
          (state && state.user && (state.user.role === 'admin' || state.user.role === 'owner')
            ? '<button class="disp-btn" onclick="dispSettings()">Settings</button>' : '') +
        '</div>' +
        // A tech's own calls stay as cards above the rest. They carry the
        // Acknowledge / On my way buttons, and a tech reads this on a phone.
        (mine.length ? '<div class="disp-sec">Your calls</div>' +
          mine.map(function (j) { return dispJobHtml(j, true); }).join('') : '') +
        dispChipsHtml(_dispJobs, pick) +
        dispCountersHtml(inCity, crew) +
        '<div class="disp-sec">Waiting (' + waiting.length + ')</div>' +
        dispListHtml(waiting, me, 'Nothing waiting.') +
        '<div class="disp-sec">In progress (' + going.length + ')</div>' +
        dispListHtml(going, me, 'Nothing in progress.') +
      '</div>' +
      '<div class="disp-side">' +
        '<div class="disp-sec" style="margin-top:0">Who is ready</div>' +
        dispCrewHtml(crew) +
      '</div>' +
    '</div>';
  dispRunTick();
}

// ---------------------------------------------------------------------------
//  The board table
// ---------------------------------------------------------------------------
// Age and Expire tick every second WITHOUT re-rendering the table. A full
// re-render once a second would fight every hover, every text selection, and
// every open dropdown on the page.
function dispStartTicking() {
  if (_dispTick) clearInterval(_dispTick);
  dispRunTick();
  _dispTick = setInterval(dispRunTick, 1000);
}
function dispFmtAge(sec) {
  if (sec < 0) sec = 0;
  if (sec < 3600) return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}
function dispRunTick() {
  var now = Date.now();
  var ages = document.querySelectorAll('[data-age]');
  for (var i = 0; i < ages.length; i++) {
    var el = ages[i];
    var t = parseInt(el.getAttribute('data-age'), 10);
    if (!isFinite(t)) continue;
    var sec = Math.floor((now - t) / 1000);
    el.textContent = dispFmtAge(sec);
    el.className = 'disp-age ' + (sec >= _dispAgeAlert * 60 ? 'disp-agebad'
      : sec >= _dispAgeWarn * 60 ? 'disp-agewarn' : 'disp-ageok');
  }
  var acks = document.querySelectorAll('[data-ackdue]');
  for (var a = 0; a < acks.length; a++) {
    var dueA = parseInt(acks[a].getAttribute('data-ackdue'), 10);
    if (!isFinite(dueA)) continue;
    var secA = Math.round((dueA - now) / 1000);
    acks[a].textContent = secA > 0
      ? 'Acknowledge within ' + Math.floor(secA / 60) + ':' + String(secA % 60).padStart(2, '0')
      : 'Acknowledge now. Dispatch has been told it is waiting.';
    acks[a].className = 'disp-ackdue' + (secA <= 0 ? ' late' : '');
  }
  var exps = document.querySelectorAll('[data-exp]');
  for (var k = 0; k < exps.length; k++) {
    var e2 = exps[k];
    var due = parseInt(e2.getAttribute('data-exp'), 10);
    if (!isFinite(due)) continue;
    var left = Math.round((due - now) / 60000);
    e2.textContent = left >= 0 ? left + ' min' : '-' + Math.abs(left) + ' min';
    e2.className = 'disp-exp ' + (left < 0 ? 'bad' : left <= 5 ? 'warn' : 'ok');
  }
}

function dispStatusCell(j) {
  var st = DISP_STATUS[j.status] || DISP_STATUS.new;
  var since = j.status_since ? new Date(j.status_since).getTime() : null;
  var line = '';
  if (since) {
    var mins = Math.floor((Date.now() - since) / 60000);
    line = '<div class="disp-tinystat">' +
      (mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm') + ' in status</div>';
  }
  return '<span class="disp-chip" style="background:' + st.color + '22;color:' + st.color + '">' +
    st.label + '</span>' + line;
}

function dispCellFor(k, j, me) {
  var esc = escHtml;
  if (k === 'age') {
    return '<span class="disp-age" data-age="' + new Date(j.created_at).getTime() + '"></span>';
  }
  if (k === 'status') return dispStatusCell(j);
  if (k === 'eta') {
    return j.eta_minutes ? '<span style="font-variant-numeric:tabular-nums">' + esc(j.eta_minutes) + '</span>'
      : '<span class="text-muted">-</span>';
  }
  if (k === 'expire') {
    if (j.status === 'onscene') return '<span class="disp-exp ok">arrived</span>';
    if (j.status === 'done' || j.status === 'goa' || j.status === 'cancelled') return '<span class="text-muted">-</span>';
    if (!j.eta_promised_at) return '<span class="disp-exp warn">no ETA</span>';
    return '<span class="disp-exp" data-exp="' + new Date(j.eta_promised_at).getTime() + '"></span>';
  }
  if (k === 'lead') {
    if (j.assigned_name) return esc(j.assigned_name);
    if (j.suggestion) return dispSuggestHtml(j);
    return j.suggestion_note ? '<span class="text-muted" title="' + esc(j.suggestion_note) + '">-</span>' : '<span class="text-muted">-</span>';
  }
  if (k === 'account') {
    return j.account_name ? '<b>' + esc(j.account_name) + '</b>' + dispTierBadge(j)
      : '<span class="disp-retail">Retail</span>';
  }
  if (k === 'tags') {
    var tags = j.tags || [];
    if (!tags.length) return '<span class="text-muted">-</span>';
    return tags.map(function (t) {
      return '<span class="disp-tag" style="background:' + esc(t.color) + '22;color:' + esc(t.color) + '">' +
        esc(t.name) + '</span>';
    }).join('');
  }
  if (k === 'location') return j.city_name ? esc(j.city_name) : '<span class="text-muted">-</span>';
  if (k === 'zip') return j.zip ? '<span style="font-variant-numeric:tabular-nums">' + esc(j.zip) + '</span>' : '<span class="text-muted">-</span>';
  if (k === 'customer') {
    return (j.is_edu ? '<span class="disp-edu">EDU</span> ' : '') +
      esc(j.customer_name || 'No name given');
  }
  if (k === 'address') return j.address ? '<span style="color:var(--text-dim)">' + esc(j.address) + '</span>' : '<span class="text-muted">-</span>';
  if (k === 'business') return j.business_name ? esc(j.business_name) : '<span class="text-muted">-</span>';
  if (k === 'po') return j.account_po ? esc(j.account_po) : '<span class="text-muted">-</span>';
  if (k === 'byname') return j.created_by_name ? esc(j.created_by_name) : '<span class="text-muted">-</span>';
  if (k === 'callid') return '<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">' +
    esc(j.job_number || ('#' + j.id)) + '</span>';
  return '';
}

function dispBoardTable(jobs, me, emptyText) {
  if (!jobs.length) {
    return '<div class="text-muted" style="padding:10px 2px">' + escHtml(emptyText || 'Nothing on the board.') + '</div>';
  }
  var cols = dispCols();
  // Service type is not optional on the board - it is what decides who can see
  // the call, so a missing one has to be visible rather than merely blank.
  var head = '<th>Service</th>' + cols.map(function (k) {
    return '<th>' + escHtml(dispColLabel(k)) + '</th>';
  }).join('');
  var rows = jobs.map(function (j) {
    var svc = j.service_type_id
      ? escHtml(j.service_type_name || j.service_type || '')
      : '<span class="disp-needsvc">Needs service type</span>';
    var tds = '<td>' + svc + '</td>' + cols.map(function (k) {
      return '<td>' + dispCellFor(k, j, me) + '</td>';
    }).join('');
    var cls = (j.assigned_to === me ? 'mine ' : '') + (j.is_edu ? 'edu' : '');
    return '<tr class="' + cls.trim() + '" data-job="' + j.id + '">' + tds + '</tr>';
  }).join('');
  return '<div class="table-wrap"><table class="dispb"><thead><tr>' + head +
    '</tr></thead><tbody class="disp-tbody">' + rows + '</tbody></table></div>';
}

// One delegated listener rather than an onclick per row, and it ignores a click
// that was really a drag - otherwise nobody can select an address to copy it.
var _dispDownAt = null;
document.addEventListener('mousedown', function (e) {
  _dispDownAt = { x: e.clientX, y: e.clientY };
});
document.addEventListener('click', function (e) {
  var tb = e.target && e.target.closest ? e.target.closest('.disp-tbody, .disp-minis') : null;
  if (!tb) return;
  if (_dispDownAt && (Math.abs(e.clientX - _dispDownAt.x) > 4 || Math.abs(e.clientY - _dispDownAt.y) > 4)) return;
  var tr = e.target.closest ? e.target.closest('[data-job]') : null;
  if (!tr) return;
  var id = parseInt(tr.getAttribute('data-job'), 10);
  if (id) dispOpenCall(id);
});

function dispColumnPicker() {
  var cur = dispCols();
  var rows = DISP_COLS.map(function (c) {
    return '<label><input type="checkbox" class="disp-colbox" value="' + c.k + '"' +
      (cur.indexOf(c.k) !== -1 ? ' checked' : '') + '> ' + escHtml(c.l) + '</label>';
  }).join('');
  dispModal('Board columns',
    '<div class="disp-colpick">' + rows + '</div>' +
    '<div class="text-muted" style="font-size:12px;margin-top:10px;line-height:1.6">' +
      'Saved on this device. Service type and the row click are always there - a board you ' +
      'cannot open a call from is a report, not a board.</div>',
    'Save', function () {
      var boxes = document.querySelectorAll('.disp-colbox');
      var picked = [];
      for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) picked.push(boxes[i].value);
      if (!picked.length) {
        if (typeof showToast === 'function') showToast('Leave at least one column on.', 'error');
        return;
      }
      try { localStorage.setItem('nova_disp_cols', JSON.stringify(picked)); } catch (e) {}
      dispCloseModal();
      dispLoadBoard();
    });
}


// Tell the server which calls actually reached this person's screen. Sent once
// per call per session: the point is proving they saw it, not counting refreshes.
function dispReportViews(jobs) {
  var fresh = jobs.map(function (j) { return j.id; }).filter(function (id) { return !_dispSeenIds[id]; });
  if (!fresh.length) return;
  fresh.forEach(function (id) { _dispSeenIds[id] = 1; });
  api('POST', '/dispatch/viewed', { ids: fresh }).catch(function () {
    // If it did not land, let it be retried on the next board load.
    fresh.forEach(function (id) { delete _dispSeenIds[id]; });
  });
}

// "Seen 9:02 by Mike" is the line that settles an argument about whether a call
// was ever noticed. Dispatch sees the whole list; a tech sees only their own.
function dispViewsLine(j) {
  if (!j.views || !j.views.length) {
    return j.assigned_to ? '<div class="disp-muted disp-warn">Not opened yet</div>' : '';
  }
  var list = _dispCanManage ? j.views : j.views.filter(function (v) { return v.user_id === _dispMe; });
  if (!list.length) return '';
  return '<div class="disp-muted">Seen ' + list.map(function (v) {
    return escHtml(v.name.split(' ')[0]) + ' ' + dispClock(v.first_at) + (v.views > 1 ? ' (' + v.views + 'x)' : '');
  }).join(', ') + '</div>';
}

function dispClock(t) {
  try { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}


function dispToggleSound() {
  var on = !dispSoundOn();
  dispSetSound(on);
  if (on) { dispArmAudio(); dispSoundNewCall(); }   // let them hear what they just turned on
  dispLoadBoard();
}


function dispJobHtml(j, isMine) {
  var st = DISP_STATUS[j.status] || DISP_STATUS.new;
  var lateAccept = dispAcceptOverdue(j);
  var bits = [];

  bits.push('<div class="disp-jobhead">' +
    '<span class="disp-chip" style="background:' + st.color + '22;color:' + st.color + '">' + st.label + '</span>' +
    (j.priority === 'urgent' ? '<span class="disp-chip" style="background:#ef444422;color:#ef4444">Urgent</span>' : '') +
    (lateAccept ? '<span class="disp-chip" style="background:#f59e0b22;color:#f59e0b">No answer ' + _dispAcceptMins + 'm</span>' : '') +
    (j.unassigned_alert_at ? '<span class="disp-chip" style="background:#ef444422;color:#ef4444">Sitting</span>' : '') +
    '<span class="disp-num">' + escHtml(j.job_number || ('#' + j.id)) + '</span>' +
    (j.city_name ? '<span class="disp-num">' + escHtml(j.city_name) + '</span>' : '') +
    '</div>');

  bits.push('<div class="disp-cust" style="margin-top:6px">' + escHtml(j.customer_name || 'No name given') + '</div>');
  if (j.service_type) bits.push('<div class="disp-line">' + escHtml(j.service_type) + '</div>');
  if (j.address) {
    var q = encodeURIComponent([j.address, j.city_state_zip].filter(Boolean).join(', '));
    bits.push('<div class="disp-line"><a href="https://www.google.com/maps/search/?api=1&query=' + q +
      '" target="_blank" rel="noopener">' + escHtml([j.address, j.city_state_zip].filter(Boolean).join(', ')) + '</a></div>');
  }
  // The number itself is NOT here for a tech - see stripPhone() on the server.
  // Managers get it as text because dispatch reads numbers back all day.
  if (j.customer_phone) {
    bits.push('<div class="disp-line"><a href="tel:' + escHtml(j.customer_phone) + '">' + escHtml(j.customer_phone) + '</a></div>');
  }
  if (j.notes) bits.push('<div class="disp-muted">' + escHtml(j.notes) + '</div>');
  if (j.customer_note) bits.push('<div class="disp-muted">Customer: ' + escHtml(j.customer_note) + '</div>');
  if (j.has_id_image) bits.push('<div style="margin-top:6px"><span class="disp-chip" style="background:#22c55e22;color:#4ade80;cursor:pointer" onclick="dispViewId(' + j.id + ')">ID on file</span></div>');
  bits.push('<div class="disp-muted">' + (j.assigned_name ? 'Tech: ' + escHtml(j.assigned_name) : 'Nobody assigned yet') + '</div>');
  if (j.status === 'goa' && j.goa_note) bits.push('<div class="disp-muted">GOA: ' + escHtml(j.goa_note) + '</div>');
  bits.push(dispViewsLine(j));
  bits.push(dispTimesLine(j));

  if (isMine && j.status === 'assigned' && j.assigned_at) {
    bits.push('<div class="disp-ackdue" data-ackdue="' + (new Date(j.assigned_at).getTime() + (_dispAcceptMins || 2) * 60000) + '"></div>');
  }
  var acts = [];
  var big = '';
  if (isMine && DISP_NEXT[j.status]) {
    var nx = DISP_NEXT[j.status];
    big = '<button class="disp-btn go disp-nextbtn" onclick="dispAdvance(' + j.id + ',&quot;' + nx.to + '&quot;)">' + nx.label + '</button>';
  }
  if (isMine && j.status !== 'done' && (j.address || (j.lat !== null && j.lat !== undefined))) {
    acts.push('<a class="disp-btn" href="' + escHtml(dispNavUrl(j)) + '" target="_blank" rel="noopener">Navigate</a>');
  }
  // Calling never shows the number. The button asks the server for it, the
  // server writes down that this person asked, and then the phone dials.
  if (j.has_phone || j.customer_phone) {
    acts.push('<button class="disp-btn" onclick="dispCallCustomer(' + j.id + ')">Call customer</button>');
  }
  if (isMine && DISP_GOA_FROM.indexOf(j.status) !== -1) {
    acts.push('<button class="disp-btn" onclick="dispGoa(' + j.id + ')">GOA</button>');
  }
  if (_dispCanAssign) {
    acts.push('<button class="disp-btn" onclick="dispAssign(' + j.id + ')">' + (j.assigned_to ? 'Reassign' : 'Assign') + '</button>');
  }
  if (_dispCanManage && j.status !== 'done' && j.status !== 'cancelled' && j.status !== 'goa') {
    acts.push('<button class="disp-btn" onclick="dispCancel(' + j.id + ')">Cancel</button>');
  }
  if (big) bits.push(big);
  if (acts.length) bits.push('<div class="disp-acts">' + acts.join('') + '</div>');
  if (isMine) bits.push(dispStepsHtml(j));

  return '<div class="disp-job' + (isMine ? ' mine' : '') + (j.is_edu ? ' urgent' : '') +
    (j.priority === 'urgent' ? ' urgent' : '') +
    (lateAccept ? ' late' : '') + '">' + bits.join('') + '</div>';
}

// The timeline, in the order it happened, only showing what has happened.
function dispTimesLine(j) {
  var parts = [];
  if (j.assigned_at) parts.push('sent ' + dispClock(j.assigned_at));
  if (j.accepted_at) parts.push('acknowledged ' + dispClock(j.accepted_at));
  if (j.enroute_at) parts.push('rolling ' + dispClock(j.enroute_at));
  if (j.arrived_at) parts.push('arrived ' + dispClock(j.arrived_at));
  if (j.completed_at) parts.push('done ' + dispClock(j.completed_at));
  if (j.goa_at) parts.push('GOA ' + dispClock(j.goa_at));
  return parts.length ? '<div class="disp-muted">' + parts.join(' &middot; ') + '</div>' : '';
}

async function dispCallCustomer(id) {
  var r;
  try { r = await api('POST', '/dispatch/jobs/' + id + '/call', {}); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message || 'No number on this call.', 'error'); return; }
  if (!r || !r.phone) return;
  window.location.href = 'tel:' + String(r.phone).replace(/[^0-9+]/g, '');
}

async function dispGoa(id) {
  var note = await novaPrompt('Mark this call Gone On Arrival. Anything worth noting?');
  if (note === null) return;
  try { await api('POST', '/dispatch/jobs/' + id + '/status', { status: 'goa', note: note }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

function dispCrewHtml(list) {
  list = list || _dispCrew;
  var ready = list.filter(function (p) { return p.ready; });
  var off = list.filter(function (p) { return !p.ready; });
  var html = '';
  if (!ready.length) html += '<div class="text-muted" style="padding:6px 2px;font-size:13px">Nobody is accepting calls right now.</div>';
  html += ready.map(function (p) {
    var longOn = p.hours_on_duty !== null && p.hours_on_duty >= DISP_LONG_HOURS;
    return '<div class="disp-crew">' +
      '<div class="disp-crewname"><span class="disp-dutydot" style="width:9px;height:9px;background:#22c55e"></span>' + escHtml(p.name) + '</div>' +
      '<div class="disp-muted">Ready ' + dispHrs(p.hours_on_duty) +
        (longOn ? ' <span class="disp-warn">- probably forgot</span>' : '') +
        (p.home_city ? ' &middot; ' + escHtml(p.home_city) : '') + '</div>' +
      (_dispCanManage ? '<div class="disp-acts"><button class="disp-btn" onclick="dispClearDuty(' + p.user_id + ')">Mark not ready</button></div>' : '') +
      '</div>';
  }).join('');
  if (off.length) {
    html += '<div class="disp-sec">Off duty</div>' +
      off.map(function (p) {
        return '<div class="disp-crew"><div class="disp-crewname">' +
          '<span class="disp-dutydot" style="width:9px;height:9px;background:#52525b"></span>' + escHtml(p.name) + '</div></div>';
      }).join('');
  }
  return html;
}

async function dispAdvance(id, to) {
  try { await api('POST', '/dispatch/jobs/' + id + '/status', { status: to }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message || 'Could not update that call.', 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

async function dispClearDuty(userId) {
  if (!(await novaConfirm('Mark this person as not accepting calls? Their location tracking stops too.'))) return;
  try { await api('POST', '/dispatch/duty/' + userId + '/clear', {}); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

async function dispCancel(id) {
  var reason = await novaPrompt('Why is this call being cancelled?');
  if (reason === null) return;
  try { await api('POST', '/dispatch/jobs/' + id + '/cancel', { reason: reason }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

// ---------------------------------------------------------------------------
//  New call / assign
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
//  New call / edit call
// ---------------------------------------------------------------------------
function dispSvcOptions(sel) {
  var types = (_dispRef && _dispRef.service_types) || [];
  var mine = {};
  (((_dispRef && _dispRef.my_categories) || [])).forEach(function (c) { mine[c.category_code] = c; });
  var out = '<option value="">Pick a service...</option>';
  var cats = (_dispRef && _dispRef.categories) || [];
  cats.forEach(function (c) {
    var group = types.filter(function (t) { return t.category_code === c.code; });
    if (!group.length) return;
    out += '<option disabled>--- ' + escHtml(c.name) + ' ---</option>';
    out += group.map(function (t) {
      return '<option value="' + t.id + '"' + (String(sel) === String(t.id) ? ' selected' : '') + '>' +
        escHtml(t.name) + '</option>';
    }).join('');
  });
  return out;
}

function dispAccountOptions(sel) {
  var accounts = (_dispRef && _dispRef.accounts) || [];
  return '<option value="">Retail (no account)</option>' + accounts.map(function (a) {
    return '<option value="' + a.id + '"' + (String(sel) === String(a.id) ? ' selected' : '') + '>' +
      escHtml(a.name) + (a.po_required ? ' - PO required' : '') + '</option>';
  }).join('');
}

function dispCityOptions(sel) {
  var cities = (_dispRef && _dispRef.cities) || _dispCities || [];
  return '<option value="">Pick a city...</option>' + cities.map(function (c) {
    var code = (c.code || '').trim();
    return '<option value="' + escHtml(code) + '"' + (String(sel) === code ? ' selected' : '') + '>' +
      escHtml(c.name) + '</option>';
  }).join('');
}

function dispJobFormHtml(j) {
  j = j || {};
  function v(x) { return escHtml(x == null ? '' : x); }
  return '' +
    '<div class="disp-sechead">Customer</div>' +
    '<div class="disp-f2">' +
      '<div class="form-group"><label>Call back</label><input id="dj-cb" value="' + v(j.callback_phone || j.customer_phone) + '" placeholder="(555) 555-5555"></div>' +
      '<div class="form-group"><label>Caller ID</label><input id="dj-cid" value="' + v(j.caller_id) + '"></div>' +
    '</div>' +
    '<div class="disp-f2">' +
      '<div class="form-group"><label>Name</label><input id="dj-name" value="' + v(j.customer_name) + '" placeholder="Name on the call"></div>' +
      '<div class="form-group"><label>Business name</label><input id="dj-biz" value="' + v(j.business_name) + '"></div>' +
    '</div>' +
    '<div class="disp-f2">' +
      '<div class="form-group"><label>Address</label><input id="dj-addr" value="' + v(j.address) + '" placeholder="Street address"></div>' +
      '<div class="form-group"><label>Zip</label><input id="dj-zip" value="' + v(j.zip) + '"></div>' +
    '</div>' +
    '<div class="disp-f2">' +
      '<div class="form-group"><label>Cross street</label><input id="dj-cross" value="' + v(j.cross_street) + '"></div>' +
      '<div class="form-group"><label>Vehicle location</label><input id="dj-vloc" value="' + v(j.vehicle_location) + '" placeholder="Front lot, level 2..."></div>' +
    '</div>' +
    '<div class="disp-f2">' +
      '<div class="form-group"><label>Phone (dialled, never shown to a tech)</label><input id="dj-phone" value="' + v(j.customer_phone) + '"></div>' +
      '<div class="form-group"><label>Email</label><input id="dj-email" value="' + v(j.customer_email) + '"></div>' +
    '</div>' +

    '<div class="disp-sechead">Account</div>' +
    '<div class="disp-f2">' +
      '<div class="form-group"><label>Account</label><select id="dj-account" onchange="dispAccountChanged()">' + dispAccountOptions(j.account_id) + '</select></div>' +
      '<div class="form-group"><label>Account PO <span id="dj-po-req" style="color:var(--danger)"></span></label><input id="dj-po" value="' + v(j.account_po) + '"></div>' +
    '</div>' +
    '<div id="dj-acct-note"></div>' +

    '<div class="disp-sechead">Service</div>' +
    '<div class="disp-f2">' +
      '<div class="form-group"><label>Service type</label><select id="dj-service" onchange="dispServiceChanged()">' + dispSvcOptions(j.service_type_id) + '</select></div>' +
      '<div class="form-group"><label>Our city</label><select id="dj-city">' + dispCityOptions((j.city_code || '').trim()) + '</select></div>' +
    '</div>' +
    '<div class="disp-f3">' +
      '<div class="form-group"><label>Priority</label><select id="dj-pri">' +
        '<option value="normal"' + (j.priority === 'normal' || !j.priority ? ' selected' : '') + '>Normal</option>' +
        '<option value="urgent"' + (j.priority === 'urgent' ? ' selected' : '') + '>Urgent</option>' +
        '<option value="low"' + (j.priority === 'low' ? ' selected' : '') + '>Low</option>' +
      '</select></div>' +
      '<div class="form-group"><label>ETA (minutes)</label><input id="dj-eta" type="number" min="0" max="1440" value="' + v(j.eta_minutes) + '"></div>' +
      '<div class="form-group"><label>Price to quote</label><input id="dj-price" value="' + v(j.quoted_price) + '" placeholder="79.95"></div>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:10px">' +
      '<input type="checkbox" id="dj-edu" style="width:16px;height:16px;padding:0;margin:0;accent-color:var(--primary)"' + (j.is_edu ? ' checked' : '') + '>' +
      '<label for="dj-edu" style="margin:0;cursor:pointer">EDU - <b>Emergency Door Unlocking</b> ' +
        '<span style="font-weight:400;font-size:.85em;color:var(--text-muted-color)">(a child or a pet locked in a vehicle - forces urgent and alerts until somebody has it)</span></label>' +
    '</div>' +
    '<div class="form-group"><label>Notes</label><textarea id="dj-notes" rows="3" placeholder="Gate code, anything the tech needs">' + v(j.notes) + '</textarea></div>' +

    '<div class="disp-sechead">Vehicle</div>' +
    '<div class="disp-f3">' +
      '<div class="form-group"><label>Year</label><input id="dj-vyear" value="' + v(j.vehicle_year) + '"></div>' +
      '<div class="form-group"><label>Make</label><input id="dj-vmake" value="' + v(j.vehicle_make) + '"></div>' +
      '<div class="form-group"><label>Model</label><input id="dj-vmodel" value="' + v(j.vehicle_model) + '"></div>' +
    '</div>' +
    '<div class="disp-f3">' +
      '<div class="form-group"><label>Colour</label><input id="dj-vcolor" value="' + v(j.vehicle_color) + '"></div>' +
      '<div class="form-group"><label>Plate</label><input id="dj-plate" value="' + v(j.license_tag) + '"></div>' +
      '<div class="form-group"><label>State</label><input id="dj-tstate" maxlength="4" value="' + v(j.tag_state) + '"></div>' +
    '</div>' +
    '<div class="form-group"><label>VIN</label><input id="dj-vin" value="' + v(j.vin) + '"></div>';
}

// The account decides whether a PO is mandatory - the form only mirrors it. The
// server reads po_required off the account row at close-out and ignores
// anything the client claims, so this is a courtesy, not a gate.
function dispAccountChanged() {
  var sel = document.getElementById('dj-account');
  var note = document.getElementById('dj-acct-note');
  var req = document.getElementById('dj-po-req');
  var id = sel && sel.value ? parseInt(sel.value, 10) : null;
  var acc = (((_dispRef && _dispRef.accounts) || []).filter(function (a) { return a.id === id; }))[0];
  if (req) req.textContent = acc && acc.po_required ? '*' : '';
  if (!note) return;
  note.innerHTML = (acc && acc.dispatch_notes)
    ? '<div class="disp-acctnote"><b>' + escHtml(acc.name) + ':</b> ' + escHtml(acc.dispatch_notes) + '</div>'
    : '';
}

// Prefill the ETA from the catalog, but never stamp over a number a dispatcher
// has already typed - they were told to a customer.
function dispServiceChanged() {
  var sel = document.getElementById('dj-service');
  var eta = document.getElementById('dj-eta');
  if (!sel || !eta || eta.value) return;
  var id = sel.value ? parseInt(sel.value, 10) : null;
  var t = (((_dispRef && _dispRef.service_types) || []).filter(function (x) { return x.id === id; }))[0];
  if (t && t.default_eta_minutes) eta.value = t.default_eta_minutes;
}

function dispNewJob() {
  // NOT a bare reference to dispSaveJob: dispModal wires onOk straight to
  // onclick, so the click Event would arrive as the first argument, read as an
  // existing id, and turn a create into PUT /jobs/NaN.
  // New calls get the full-page screen (public/js/newCall.js). Edit stays a modal.
  if (typeof renderDispatchNew === 'function') return navigate('dispatch-new');
  dispModal('New call', dispJobFormHtml(null), 'Create call', function () { dispSaveJob(null); });
  dispAccountChanged();
}

function dispEditJob(j) {
  dispModal('Edit call ' + (j.job_number || ''), dispJobFormHtml(j), 'Save', function () { dispSaveJob(j.id); });
  dispAccountChanged();
}

function dispFormBody() {
  function v(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function n(id) { var e = document.getElementById(id); return e && e.value ? parseInt(e.value, 10) : null; }
  return {
    customer_name: v('dj-name'), customer_phone: v('dj-phone'), callback_phone: v('dj-cb'),
    caller_id: v('dj-cid'), customer_email: v('dj-email'), business_name: v('dj-biz'),
    address: v('dj-addr'), cross_street: v('dj-cross'), zip: v('dj-zip'),
    vehicle_location: v('dj-vloc'), city_code: v('dj-city'),
    service_type_id: n('dj-service'), account_id: n('dj-account'), account_po: v('dj-po'),
    priority: v('dj-pri'), eta_minutes: v('dj-eta'), quoted_price: v('dj-price'),
    is_edu: (document.getElementById('dj-edu') || {}).checked === true,
    notes: v('dj-notes'),
    vehicle_year: v('dj-vyear'), vehicle_make: v('dj-vmake'), vehicle_model: v('dj-vmodel'),
    vehicle_color: v('dj-vcolor'), license_tag: v('dj-plate'), tag_state: v('dj-tstate'), vin: v('dj-vin')
  };
}

async function dispSaveJob(existingId) {
  // Belt and braces for the same trap: anything that is not a real id is a create.
  existingId = parseInt(existingId, 10);
  if (!isFinite(existingId) || existingId <= 0) existingId = null;
  var body = dispFormBody();
  if (!body.customer_name && !body.address) {
    if (typeof showToast === 'function') showToast('Give the call a customer name or an address.', 'error');
    return;
  }
  if (!body.city_code) {
    if (typeof showToast === 'function') showToast('Pick a city. It decides who can be sent, what it costs and how it is paid.', 'error');
    return;
  }
  try {
    if (existingId) await api('PUT', '/dispatch/jobs/' + existingId, body);
    else await api('POST', '/dispatch/jobs', body);
  } catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  dispCloseModal();
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  if (existingId && state.currentView === 'dispatch-call') return renderDispatchCall(document.getElementById('content'), existingId);
  dispLoadBoard();
}

// ---------------------------------------------------------------------------
//  Assign
// ---------------------------------------------------------------------------
// The list comes from the server, already filtered to the call's city and to
// people whose categories allow that kind of work. The screen does not decide
// any of it - it just draws what it was handed.
async function dispAssign(id, showAll) {
  var data;
  try { data = await api('GET', '/dispatch/jobs/' + id + '/assignable' + (showAll ? '?all=1' : '')); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  var people = data.people || [];
  _dispSuggested = data.best_user_id || null;
  var opts = '<option value="">Nobody (put it back on the board)</option>' + people.map(function (p) {
    var bits = [];
    if (p.eta_minutes !== undefined && p.eta_minutes !== null) bits.push(p.eta_minutes + ' min' + (p.miles !== null && p.miles !== undefined ? ', ' + p.miles + ' mi' : ''));
    if (p.user_id === data.best_user_id) bits.unshift('best ETA');
    if (!p.ready) bits.push('off duty');
    if (p.open_calls) bits.push(p.open_calls + ' open');
    if (p.out_of_city) bits.push('other city');
    return '<option value="' + p.user_id + '"' + (p.user_id === data.best_user_id ? ' selected' : '') + '>' + escHtml(p.name) +
      (bits.length ? ' (' + bits.join(', ') + ')' : '') + '</option>';
  }).join('');

  var crossBlock = '';
  if (data.crossCityAvailable) {
    crossBlock =
      '<div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<input type="checkbox" id="dj-cross-city" style="width:16px;height:16px;padding:0;margin:0;accent-color:var(--primary)"' +
            (showAll ? ' checked' : '') + ' onchange="dispAssign(' + id + ', this.checked)">' +
          '<label for="dj-cross-city" style="margin:0;cursor:pointer"><b>Assign outside the city</b></label>' +
        '</div>' +
        '<div class="text-muted" style="font-size:12px;margin:6px 0 8px">Admin only. The reason is ' +
          'required and goes on the call timeline and the audit log.</div>' +
        '<input id="dj-cross-reason" placeholder="Why is this going out of city?"' +
          (showAll ? '' : ' disabled') + '>' +
      '</div>';
  }

  dispModal('Assign call',
    '<div class="form-group"><label>Send to</label><select id="dj-assign">' + opts + '</select></div>' +
    (data.why ? '<div class="disp-acctnote" style="border-left-color:var(--primary)">' + escHtml(data.why) + '</div>' : '') +
    (people.length ? '' : '<div class="text-muted" style="font-size:12px">Nobody in this city is set up ' +
      'to take this kind of call.</div>') +
    '<div class="text-muted" style="font-size:12px">A tech who is off duty will not see the call ' +
      'and is not sharing their location.</div>' +
    crossBlock,
    'Assign', function () { dispSaveAssign(id); });
}

var _dispSuggested = null;
async function dispSaveAssign(id) {
  var e = document.getElementById('dj-assign');
  var uid = e && e.value ? parseInt(e.value, 10) : null;
  var body = { user_id: uid, suggested_user_id: _dispSuggested };
  var cross = document.getElementById('dj-cross-city');
  if (cross && cross.checked) {
    body.cross_city = true;
    body.cross_city_reason = (document.getElementById('dj-cross-reason') || {}).value || '';
  }
  var r;
  try { r = await api('POST', '/dispatch/jobs/' + id + '/assign', body); }
  catch (err) { if (typeof showToast === 'function') showToast(err.message, 'error'); return; }
  dispCloseModal();
  if (r && r.warning && typeof showToast === 'function') showToast(r.warning, 'error');
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  if (state.currentView === 'dispatch-call') return renderDispatchCall(document.getElementById('content'), id);
  dispLoadBoard();
}

// ---------------------------------------------------------------------------
//  The call detail screen
// ---------------------------------------------------------------------------
function dispOpenCall(id) {
  if (typeof navigate === 'function') return navigate('dispatch-call', id);
}

var DISP_EVENT_LABEL = {
  created: 'Created', edited: 'Edited', assigned: 'Assigned', unassigned: 'Unassigned',
  assigned_cross_city: 'Cross-city', accepted: 'Acknowledged', enroute: 'En-route',
  redispatch: 'Redispatch of', redispatched: 'Redispatched', accept_reminder: 'Reminder sent',
  link_sent: 'Link texted', link_failed: 'Link not sent', customer_opened: 'Customer opened link',
  customer_edit: 'Customer edit', customer_id: 'Customer ID photo', viewed_id: 'Viewed ID',
  override: 'Not the suggested tech',
  onscene: 'On scene', done: 'Completed', goa: 'GOA', cancelled: 'Cancelled',
  called: 'Called', tag_added: 'Tag added', tag_removed: 'Tag removed',
  account_set: 'Account set', edu: 'EDU', edu_cleared: 'EDU cleared'
};

// ---------------------------------------------------------------------------
//  Customer call link + ID photo (step 4, Tony 2026-10-13)
// ---------------------------------------------------------------------------
function dispCustomerLinkCard(j, canManage, isMine) {
  var open = ['new', 'assigned', 'accepted', 'enroute', 'onscene'].indexOf(j.status) !== -1;
  var linkOn = !!(_dispRef && _dispRef.customer_link_enabled) && canManage && open;
  var idBtn = j.has_id_image && (canManage || isMine);
  if (!linkOn && !j.has_id_image) return '';
  var bits = [];
  if (j.has_id_image) {
    bits.push('<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
      '<span class="disp-chip" style="background:#22c55e22;color:#4ade80">ID on file</span>' +
      (idBtn ? '<button class="btn btn-secondary btn-sm" onclick="dispViewId(' + j.id + ')">View ID</button>' : '') + '</div>');
  }
  if (linkOn) {
    var st = j.customer_link_sent_at ? 'Texted ' + dispClock(j.customer_link_sent_at) : 'Not texted yet';
    if (j.customer_link_viewed_at) st += ' &middot; opened ' + dispClock(j.customer_link_viewed_at);
    bits.push('<div class="text-muted" style="font-size:12.5px;margin-top:' + (bits.length ? '12px' : '0') + '">Customer link: ' + st + '</div>' +
      '<div class="flex-gap" style="margin-top:8px">' +
        '<button class="btn btn-secondary btn-sm" onclick="dispSendLink(' + j.id + ',true)">' + (j.customer_link_sent_at ? 'Text it again' : 'Text the link') + '</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="dispSendLink(' + j.id + ',false,this)">Copy link</button>' +
      '</div>');
  }
  return '<div class="card" style="margin-bottom:14px"><div class="card-body">' +
    '<div class="disp-sechead">Customer link</div>' + bits.join('') + '</div></div>';
}

async function dispSendLink(id, send, btn) {
  var r;
  try { r = await api('POST', '/dispatch/jobs/' + id + '/customer-link', { send: !!send }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message || 'Could not get the link.', 'error'); return; }
  if (send) {
    if (typeof showToast === 'function') showToast('Link texted to the customer.', 'success');
    if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
    if (state.currentView === 'dispatch-call') return renderDispatchCall(document.getElementById('content'), id);
    return;
  }
  if (r && r.url) {
    if (typeof copyToClipboard === 'function') copyToClipboard(r.url, btn);
    else { try { await navigator.clipboard.writeText(r.url); } catch (e) {} }
    if (typeof showToast === 'function') showToast('Link copied.', 'success');
  }
}

async function dispViewId(id) {
  var r;
  try { r = await api('GET', '/dispatch/jobs/' + id + '/id-image'); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message || 'Could not load the ID.', 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch/jobs/' + id + '/id-image');
  dispModal('Customer ID',
    '<img src="data:' + escHtml(r.mime || 'image/jpeg') + ';base64,' + r.data + '" alt="Customer driver license" ' +
      'style="width:100%;border-radius:8px;display:block">' +
    '<div class="text-muted" style="font-size:12px;margin-top:8px">Check the name matches the vehicle paperwork before you unlock. Viewing is logged.</div>',
    'Done', dispCloseModal);
}

// Admin-only switches with no other home (Dispatch settings button on the board).
async function dispSettings() {
  var d;
  try { d = await api('GET', '/dispatch/settings'); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  function box(id, on, label, sub) {
    return '<label style="display:flex;gap:10px;align-items:flex-start;margin:0 0 14px;cursor:pointer">' +
      '<input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + ' style="width:18px;height:18px;margin:2px 0 0;padding:0;flex:none;accent-color:var(--primary)">' +
      '<span><b>' + label + '</b><br><span class="text-muted" style="font-size:12.5px">' + sub + '</span></span></label>';
  }
  var warn = [];
  if (!d.sms_ready) warn.push('Text messaging (Twilio) is not set up, so links cannot be texted.');
  if (!d.storage_ready) warn.push('Photo storage (R2) is not set up, so photos cannot be saved.');
  if (!d.app_url) warn.push('APP_URL is not set, so texted links would not have the site address.');
  if (!d.geocode_ready) warn.push('No geocoding key, so calls have no map point and Who goes cannot work out an ETA.');
  if (!d.routing_ready) warn.push('No TomTom key, so ETAs use distance only (no live traffic).');
  dispModal('Dispatch settings',
    box('ds-link', d.dispatch_customer_link === '1', 'Text customers a call link',
      'New calls get a "Text the customer a link" box (ticked by default). The page shows status, the tech and vehicle photo, lets them fix details, add their ID, or cancel until the tech is on scene.') +
    box('ds-photos', d.onboarding_require_customer_photos === '1', 'Require tech + vehicle photos before onboarding sign-off',
      'Only for these roles:') +
    '<input id="ds-roles" value="' + escHtml(d.customer_photo_roles || '') + '" style="margin:-6px 0 14px 28px;width:calc(100% - 28px)">' +
    '<div class="disp-sechead" style="margin-top:6px">Who goes / AI</div>' +
    '<div class="form-group"><label for="ds-ai">AI dispatch</label><select id="ds-ai">' +
      '<option value="off"' + (d.dispatch_ai_mode !== 'shadow' ? ' selected' : '') + '>Off: Who goes still ranks by best ETA</option>' +
      '<option value="shadow"' + (d.dispatch_ai_mode === 'shadow' ? ' selected' : '') + '>Shadow: show and log what AI would do, people still send</option>' +
      '<option value="live" disabled>Live: AI sends roadside calls (not built yet)</option>' +
    '</select></div>' +
    '<div class="disp-f2">' +
      '<div class="form-group"><label for="ds-extra">Accept up to this many more minutes...</label><input id="ds-extra" type="number" min="0" max="60" value="' + escHtml(d.dispatch_ai_extra_eta_minutes) + '"></div>' +
      '<div class="form-group"><label for="ds-miles">...to save at least this many miles</label><input id="ds-miles" type="number" min="0" max="200" value="' + escHtml(d.dispatch_ai_save_miles) + '"></div>' +
    '</div>' +
    '<div class="disp-f2">' +
      '<div class="form-group"><label for="ds-osr">Roadside on-site minutes (until there is history)</label><input id="ds-osr" type="number" min="1" max="480" value="' + escHtml(d.dispatch_onsite_roadside) + '"></div>' +
      '<div class="form-group"><label for="ds-osl">Locksmith on-site minutes (until there is history)</label><input id="ds-osl" type="number" min="1" max="480" value="' + escHtml(d.dispatch_onsite_locksmith) + '"></div>' +
    '</div>' +
    box('ds-t1', d.dispatch_ai_tier1_fastest !== '0', 'Tier 1 accounts always get the fastest tech', 'EDU calls always do. Everyone else follows the mileage rule above.') +
    '<div id="ds-shadow" class="text-muted" style="font-size:12.5px;margin-bottom:12px"></div>' +
    (warn.length ? '<div class="disp-acctnote">' + warn.map(escHtml).join('<br>') + '</div>' : ''),
    'Save', async function () {
      try {
        await api('POST', '/dispatch/settings', {
          dispatch_customer_link: document.getElementById('ds-link').checked,
          onboarding_require_customer_photos: document.getElementById('ds-photos').checked,
          customer_photo_roles: document.getElementById('ds-roles').value,
          dispatch_ai_mode: document.getElementById('ds-ai').value,
          dispatch_ai_extra_eta_minutes: document.getElementById('ds-extra').value,
          dispatch_ai_save_miles: document.getElementById('ds-miles').value,
          dispatch_onsite_roadside: document.getElementById('ds-osr').value,
          dispatch_onsite_locksmith: document.getElementById('ds-osl').value,
          dispatch_ai_tier1_fastest: document.getElementById('ds-t1').checked
        });
      } catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
      dispCloseModal();
      _dispRef = null;
      if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
      if (typeof showToast === 'function') showToast('Saved.', 'success');
      dispLoadBoard();
    });
  dispShadowSummary();
}

async function dispShadowSummary() {
  var host = document.getElementById('ds-shadow');
  if (!host) return;
  var r;
  try { r = await api('GET', '/dispatch/ai-shadow?days=7'); } catch (e) { return; }
  if (!r.total) { host.textContent = 'No shadow results in the last 7 days.'; return; }
  host.innerHTML = '<b>Last 7 days:</b> ' + r.total + ' calls checked (' + r.roadside + ' roadside). ' +
    (r.compared ? 'People sent the same tech as the AI on <b>' + r.agreed + ' of ' + r.compared + '</b> (' + r.agree_pct + '%).' : 'None assigned yet to compare.');
}

function dispRoField(label, value, extra) {
  return '<div class="disp-ro"><label>' + label + '</label><div class="v">' +
    (value === null || value === undefined || value === '' ?
      '<span class="text-muted">-</span>' : escHtml(value)) +
    (extra || '') + '</div></div>';
}

async function renderDispatchCall(content, id) {
  dispInjectStyles();
  dispStop();
  id = parseInt(id, 10);
  if (!id) return navigate('dispatch');
  content.innerHTML = '<div class="page-header"><div><div class="page-title">Call</div>' +
    '<div class="page-subtitle">Loading...</div></div></div>';
  var data;
  try { data = await api('GET', '/dispatch/jobs/' + id); }
  catch (e) {
    content.innerHTML = '<div class="page-header"><div><div class="page-title">Call</div></div></div>' +
      '<div class="card"><div class="card-body">' + escHtml(e.message || 'Could not open that call.') +
      '<div style="margin-top:12px"><button class="btn btn-secondary btn-sm" onclick="navigate(&quot;dispatch&quot;)">Back to the board</button></div>' +
      '</div></div>';
    return;
  }
  if (!_dispRef) { try { _dispRef = await api('GET', '/dispatch/reference'); } catch (e) { _dispRef = null; } }
  _dispDetail = data;
  var j = data.job || {};
  var canManage = !!data.canManage;
  var isMine = j.assigned_to && _dispMe && j.assigned_to === _dispMe;
  var st = DISP_STATUS[j.status] || DISP_STATUS.new;

  // events + views on one timeline, newest last, the way Pulsar reads
  var timeline = (data.events || []).map(function (e) {
    return { at: e.at, kind: 'event', action: DISP_EVENT_LABEL[e.event] || e.event,
      detail: (e.user_name ? e.user_name + (e.detail ? ' - ' + e.detail : '') : (e.detail || '')) };
  });
  (data.views || []).forEach(function (v) {
    timeline.push({ at: v.first_at, kind: 'view', action: 'Viewed',
      detail: v.name + ' opened this call' + (v.views > 1 ? ' (' + v.views + 'x)' : '') });
  });
  timeline.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  var logRows = timeline.map(function (t) {
    return '<tr' + (t.kind === 'view' ? ' class="vw"' : '') + '><td class="t">' + dispClock(t.at) +
      '</td><td class="a">' + escHtml(t.action) + '</td><td>' + escHtml(t.detail) + '</td></tr>';
  }).join('');

  var tagChips = (j.tags || []).map(function (t) {
    return '<span class="disp-tag" style="background:' + escHtml(t.color) + '22;color:' + escHtml(t.color) + '">' +
      escHtml(t.name) + (canManage ? ' <a href="#" onclick="dispRemoveTag(' + j.id + ',' + t.id +
        ');return false" style="color:inherit;text-decoration:none">&times;</a>' : '') + '</span>';
  }).join('') || '<span class="text-muted">-</span>';
  var tagAdd = '';
  if (canManage) {
    var avail = ((_dispRef && _dispRef.tags) || []).filter(function (t) {
      return !(j.tags || []).some(function (x) { return x.id === t.id; });
    });
    if (avail.length) {
      tagAdd = ' <select onchange="if(this.value)dispAddTag(' + j.id + ',this.value)" ' +
        'style="width:auto;display:inline-block;padding:2px 6px;font-size:12px">' +
        '<option value="">+ add tag</option>' +
        avail.map(function (t) { return '<option value="' + t.id + '">' + escHtml(t.name) + '</option>'; }).join('') +
        '</select>';
    }
  }

  var acts = [];
  if (isMine && DISP_NEXT[j.status]) {
    acts.push('<button class="btn btn-success btn-sm" onclick="dispAdvance(' + j.id + ',&quot;' +
      DISP_NEXT[j.status].to + '&quot;)">' + DISP_NEXT[j.status].label + '</button>');
  }
  if (j.has_phone || j.customer_phone) {
    acts.push('<button class="btn btn-secondary btn-sm" onclick="dispCallCustomer(' + j.id + ')">Call customer</button>');
  }
  if (isMine && DISP_GOA_FROM.indexOf(j.status) !== -1) {
    acts.push('<button class="btn btn-danger btn-sm" onclick="dispGoa(' + j.id + ')">GOA</button>');
  }
  if (_dispCanAssign || canManage) {
    acts.push('<button class="btn btn-secondary btn-sm" onclick="dispAssign(' + j.id + ')">' +
      (j.assigned_to ? 'Reassign' : 'Assign') + '</button>');
  }
  // Redispatch: a second call copied from a finished one (linked both ways).
  if ((j.status === 'done' || j.status === 'goa') && (canManage || can('add_dispatch_call')) &&
      typeof renderDispatchNew === 'function') {
    acts.push('<button class="btn btn-secondary btn-sm" onclick="navigate(&quot;dispatch-new&quot;,&quot;r' + j.id + '&quot;)">Redispatch</button>');
  }
  if (canManage) {
    acts.push('<button class="btn btn-secondary btn-sm" onclick="dispEditJob(_dispDetail.job)">Edit</button>');
    if (['done', 'cancelled', 'goa'].indexOf(j.status) === -1) {
      acts.push('<button class="btn btn-ghost btn-sm" onclick="dispCancel(' + j.id + ')">Cancel call</button>');
    }
  }

  var acctNote = j.account_dispatch_notes
    ? '<div class="disp-acctnote"><b>' + escHtml(j.account_name || 'Account') + ':</b> ' +
      escHtml(j.account_dispatch_notes) + '</div>' : '';

  content.innerHTML =
    '<div class="page-header"><div>' +
      '<div class="page-title">' + escHtml(j.job_number || ('Call #' + j.id)) +
        (j.is_edu ? ' <span class="disp-edu">EDU</span>' : '') + '</div>' +
      '<div class="page-subtitle">' + escHtml(j.service_type_name || j.service_type || 'No service type set') +
        (j.city_name ? ' &middot; ' + escHtml(j.city_name) : '') + '</div>' +
    '</div><div>' +
      '<button class="btn btn-secondary btn-sm" onclick="navigate(&quot;dispatch&quot;)">Back to the board</button>' +
    '</div></div>' +

    '<div class="disp-dgrid">' +
      '<div>' +
        '<div class="card" style="margin-bottom:14px"><div class="card-body">' +
          '<div class="disp-sechead">Customer</div>' +
          '<div class="disp-f2">' +
            dispRoField('Call back', j.callback_phone || (j.customer_phone || (j.has_phone ? 'Hidden - use Call customer' : ''))) +
            dispRoField('Caller ID', j.caller_id) +
          '</div>' +
          '<div class="disp-f2">' + dispRoField('Name', j.customer_name) + dispRoField('Business name', j.business_name) + '</div>' +
          '<div class="disp-f2">' + dispRoField('Address', j.address) + dispRoField('Zip', j.zip) + '</div>' +
          '<div class="disp-f2">' + dispRoField('Cross street', j.cross_street) + dispRoField('Vehicle location', j.vehicle_location) + '</div>' +
          dispRoField('Email', j.customer_email) +
          (j.customer_note ? dispRoField('Customer note (from their link)', j.customer_note) : '') +
        '</div></div>' +

        '<div class="card" style="margin-bottom:14px"><div class="card-body">' +
          '<div class="disp-sechead">Account</div>' + acctNote +
          '<div class="disp-f2">' +
            dispRoField('Account', j.account_name || 'Retail (no account)') +
            dispRoField('Account PO', j.account_po,
              (j.account_po_required && !j.account_po ? ' <span style="color:var(--danger);font-size:12px">required to close out</span>' : '')) +
          '</div>' +
        '</div></div>' +

        '<div class="card" style="margin-bottom:14px"><div class="card-body">' +
          '<div class="disp-sechead">Service</div>' +
          '<div class="disp-f2">' +
            dispRoField('Service type', j.service_type_name || j.service_type ||
              null) +
            dispRoField('Priority', j.priority) +
          '</div>' +
          '<div class="disp-f2">' +
            dispRoField('ETA to customer', j.eta_minutes ? j.eta_minutes + ' min' : null,
              j.eta_source ? ' <span class="text-muted" style="font-size:11px">' + escHtml(j.eta_source) + '</span>' : '') +
            dispRoField('Price to quote', j.quoted_price ? '$' + j.quoted_price : null) +
          '</div>' +
          '<div class="disp-ro"><label>Call tags</label><div class="v">' + tagChips + tagAdd + '</div></div>' +
          dispRoField('Notes', j.notes) +
        '</div></div>' +

        '<div class="card"><div class="card-body">' +
          '<div class="disp-sechead">Vehicle</div>' +
          '<div class="disp-f3">' + dispRoField('Year', j.vehicle_year) + dispRoField('Make', j.vehicle_make) + dispRoField('Model', j.vehicle_model) + '</div>' +
          '<div class="disp-f3">' + dispRoField('Colour', j.vehicle_color) +
            dispRoField('Plate', (j.license_tag || '') + (j.tag_state ? ' - ' + j.tag_state : '')) +
            dispRoField('VIN', j.vin) + '</div>' +
        '</div></div>' +
      '</div>' +

      '<div>' +
        '<div class="card" style="margin-bottom:14px"><div class="card-body" style="text-align:center">' +
          '<span class="disp-chip" style="background:' + st.color + '22;color:' + st.color +
            ';font-size:14px;padding:6px 16px">' + st.label + '</span>' +
          '<div style="margin-top:12px">' +
            '<span class="disp-age" data-age="' + new Date(j.created_at).getTime() + '" style="font-size:28px"></span>' +
            '<div class="text-muted" style="font-size:11px;letter-spacing:.06em;text-transform:uppercase">Age of call</div>' +
          '</div>' +
          '<div style="border-top:1px solid var(--border);margin:14px 0;padding-top:12px;text-align:left">' +
            '<label style="font-size:11px;font-weight:700;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:.06em">Assigned to</label>' +
            '<div style="font-weight:600">' + escHtml(j.assigned_name || 'Nobody yet') + '</div>' +
          '</div>' +
          '<div class="flex-gap" style="justify-content:center">' + acts.join('') + '</div>' +
          (j.has_phone && !j.customer_phone ?
            '<div class="text-muted" style="font-size:11px;margin-top:9px">The number is not in this page. ' +
            'Call customer fetches it once and records who asked.</div>' : '') +
        '</div></div>' +

        dispCustomerLinkCard(j, canManage, isMine) +
        '<div class="card"><div class="card-header">' +
          '<div class="card-title">Event log</div>' +
          '<span class="text-muted" style="font-size:12px">' + timeline.length + ' entries' +
            (data.canSeeViews ? '' : ' &middot; views hidden') + '</span>' +
        '</div>' +
        '<div class="disp-log" style="border:none;border-radius:0"><table>' +
          '<thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead>' +
          '<tbody>' + (logRows || '<tr><td colspan="3" class="text-muted">Nothing logged yet.</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>' +
    '</div>';

  dispStartTicking();
}

async function dispAddTag(jobId, tagId) {
  try { await api('POST', '/dispatch/jobs/' + jobId + '/tags', { tag_id: parseInt(tagId, 10) }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  renderDispatchCall(document.getElementById('content'), jobId);
}

async function dispRemoveTag(jobId, tagId) {
  try { await api('DELETE', '/dispatch/jobs/' + jobId + '/tags/' + tagId); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  renderDispatchCall(document.getElementById('content'), jobId);
}
