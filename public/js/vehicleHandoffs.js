// Vehicle assignment & turn-in sheets.
// Classic script (globals), loaded after app.js. Uses api(), state, can(),
// escHtml(), navigate(), showToast(), novaConfirm/novaPrompt/novaAlert from
// app.js, window.novaSigPad from releases.js and inspPerceptualHash from app.js.
//
// Screens:
//   vehicle-handoffs        the queue (Needs review / With driver / Completed)
//   vehicle-handoff (id)    the manager's view of one sheet, with tabs
//   vehicle-sheet (id)      the driver's phone flow: readings, photos, damage,
//                           checklist, agreement, sign
//   vehicle-sheet-settings  photo slots, checklist, agreement library, diagrams
// Hooks into existing screens (wrapped here rather than edited in app.js):
//   Fleet Registry row buttons + status pill (vhRowActions / vhDriverPill, called
//   from applyFleetFilters), Edit Vehicle's Responsible Employee lock, the
//   vehicle History page cards, and a Home card for a driver with a sheet to do.
//
// Rules live on the server (routes/vehicleHandoffs.js, utils/vehicleHandoff.js).
// This file only asks and draws; the server decides.
//
// NOTE: no backtick/template-literal strings (Windows-safe per Nova rules);
// &#39; for apostrophes inside HTML attribute strings.

var _vh = {
  cfg: null, tpls: {}, sheet: null, tab: 'photos', step: null, tool: 'dent', selMark: null,
  view: 'all', el: null, settings: null, setTab: 'slots', agEdit: null, queueTab: 'review'
};

// ---------------------------------------------------------------- small helpers
function vhE(s) { return escHtml(s == null ? '' : String(s)); }
function vhToast(m, t) { try { if (typeof showToast === 'function') showToast(m, t || 'success'); } catch (e) {} }
function vhErr(e) { vhToast((e && e.message) || 'Something went wrong.', 'error'); }
function vhDate(d, withTime) {
  if (!d) return '-';
  try {
    var o = { month: 'short', day: 'numeric' };
    if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; }
    else o.year = 'numeric';
    return new Date(d).toLocaleString(undefined, o);
  } catch (e) { return '-'; }
}
function vhDay(d) {
  if (!d) return '-';
  var s = String(d).slice(0, 10).split('-');
  if (s.length !== 3) return String(d);
  return new Date(parseInt(s[0], 10), parseInt(s[1], 10) - 1, parseInt(s[2], 10)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function vhKindLabel(k) { return k === 'turn_in' ? 'Turn-in' : 'Assignment'; }
function vhTitle(s) { return (s.kind === 'turn_in' ? 'Vehicle Turn-In' : 'Vehicle Assignment'); }
function vhInitialsOf(name) {
  return String(name || '').split(/\s+/).filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase(); }).join('').slice(0, 3) || 'X';
}
function vhBadge(status, label) {
  var cls = { awaiting_driver: 'badge-waiting', in_progress: 'badge-active', returned: 'badge-rejected', flagged: 'badge-rejected',
    ready_for_review: 'badge-submitted', completed: 'badge-completed', voided: 'badge-canceled' }[status] || 'badge-draft';
  return '<span class="badge ' + cls + '">' + vhE(label || status) + '</span>';
}
var VH_BACK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
function vhBackBtn(view, label, param) {
  return '<button class="btn btn-secondary" style="display:inline-flex;align-items:center;gap:8px;line-height:1;white-space:nowrap" onclick="navigate(&#39;' + view + '&#39;' + (param != null ? ',' + param : '') + ')">' + VH_BACK_SVG + '<span>' + vhE(label) + '</span></button>';
}
var VH_CAM_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

async function vhConfig(force) {
  if (!_vh.cfg || force) _vh.cfg = await api('GET', '/vehicle-handoffs/config');
  return _vh.cfg;
}
// City scope from /config: null = every city (admin/owner), else the codes this
// manager works in. The server enforces it; this only hides buttons that would
// be refused.
function vhInScope(city) {
  var c = _vh.cfg ? _vh.cfg.cities : null;
  if (c === null || c === undefined) return true;
  if (!city) return false;
  return c.indexOf(String(city).trim().toUpperCase()) !== -1;
}
var _vhCfgLoading = false;
async function vhTpl(type) {
  type = type || 'express';
  if (!_vh.tpls[type]) _vh.tpls[type] = await api('GET', '/vehicle-handoffs/diagram/' + encodeURIComponent(type));
  return _vh.tpls[type];
}
function vhKindName(key) {
  var out = key;
  ((_vh.cfg && _vh.cfg.damage_kinds) || []).forEach(function (k) { if (k.key === key) out = k.label; });
  return out;
}

function vhModal(inner, width) {
  vhModalClose();
  var ov = document.createElement('div');
  ov.id = 'vh-modal';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9000;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto';
  ov.innerHTML = '<div class="card" style="width:100%;max-width:' + (width || 560) + 'px;margin:auto">' + inner + '</div>';
  ov.addEventListener('mousedown', function (e) { if (e.target === ov) vhModalClose(); });
  document.body.appendChild(ov);
  return ov;
}
function vhModalClose() { var m = document.getElementById('vh-modal'); if (m && m.parentNode) m.parentNode.removeChild(m); }

// ---------------------------------------------------------------- the diagram
// Draws a template (utils/vehicleDiagram.js data) as SVG. Marks are stored in each
// view's own coordinates; toCanvas turns them into canvas points here, exactly as
// the server and the PDF do.
function vhToCanvas(tpl, view, x, y) {
  var v = tpl.views[view];
  if (!v) return null;
  var lx = v.flip === -1 ? (tpl.mirrorWidth - x) : x;
  return { x: v.x + lx, y: v.y + y };
}
function vhShapeSvg(s, pal) {
  function c(n) { return (!n || n === 'none') ? 'none' : (pal[n] || n); }
  var op = (s.op != null && s.op !== 1) ? ' opacity="' + s.op + '"' : '';
  if (s.t === 'path') return '<path d="' + s.d + '" fill="' + c(s.fill) + '" stroke="' + c(s.stroke) + '" stroke-width="' + s.w + '" stroke-linejoin="round"' + op + '/>';
  if (s.t === 'rect') return '<rect x="' + s.x + '" y="' + s.y + '" width="' + s.w + '" height="' + s.h + '" rx="' + s.rx + '" fill="' + c(s.fill) + '" stroke="' + c(s.stroke) + '" stroke-width="' + s.sw + '"' + op + '/>';
  if (s.t === 'circle') return '<circle cx="' + s.cx + '" cy="' + s.cy + '" r="' + s.r + '" fill="' + c(s.fill) + '" stroke="' + c(s.stroke) + '" stroke-width="' + (s.sw || 0) + '"/>';
  if (s.t === 'line') return '<line x1="' + s.x1 + '" y1="' + s.y1 + '" x2="' + s.x2 + '" y2="' + s.y2 + '" stroke="' + c(s.stroke) + '" stroke-width="' + s.w + '" stroke-linecap="round"/>';
  if (s.t === 'text') return '<text x="' + s.x + '" y="' + s.y + '" fill="' + c(s.fill) + '" font-size="' + s.size + '" text-anchor="middle" font-family="Fira Sans,sans-serif" letter-spacing=".4">' + vhE(s.text) + '</text>';
  return '';
}
// A crop box (canvas coords) around one view, for the phone's one-side-at-a-time view.
function vhViewBox(tpl, view) {
  if (!view || view === 'all' || !tpl.views[view]) return tpl.viewBox.join(' ');
  var v = tpl.views[view], b = v.box;
  var x0 = v.flip === -1 ? v.x + (tpl.mirrorWidth - b[2]) : v.x + b[0];
  var w = b[2] - b[0], h = b[3] - b[1] + 12;
  return (x0 - 4) + ' ' + (v.y + b[1] - 4) + ' ' + (w + 8) + ' ' + (h + 4);
}
function vhDiagram(d, marks, opts) {
  opts = opts || {};
  var tpl = d.template, pal = d.palettes.dark, mc = d.mark_colors;
  var g = '';
  Object.keys(tpl.views).forEach(function (key) {
    var v = tpl.views[key];
    var tr = 'translate(' + v.x + ',' + v.y + ')' + (v.flip === -1 ? ' translate(' + tpl.mirrorWidth + ',0) scale(-1,1)' : '');
    g += '<g transform="' + tr + '">' + (tpl.shapes[key] || []).map(function (s) { return vhShapeSvg(s, pal); }).join('') + '</g>';
  });
  if (opts.labels !== false) {
    (tpl.labels || []).forEach(function (l) {
      g += '<text x="' + l[1] + '" y="' + l[2] + '" fill="' + pal.label + '" font-size="5.2" letter-spacing=".9" text-anchor="middle" font-family="Fira Sans,sans-serif" font-weight="600">' + vhE(l[0]) + '</text>';
    });
  }
  (marks || []).forEach(function (m) {
    var p = vhToCanvas(tpl, m.view, Number(m.x), Number(m.y));
    if (!p) return;
    var col = mc[m.state] || mc.existing;
    var sel = opts.selected && opts.selected === m.id;
    if (sel || m.state === 'new' || m.change === 'worse') g += '<circle cx="' + p.x + '" cy="' + p.y + '" r="8.5" fill="none" stroke="' + (m.change === 'worse' ? mc['new'] : col) + '" stroke-width="' + (sel ? 1.6 : 1) + '" opacity=".8"/>';
    g += '<g data-vhmark="' + m.id + '" style="cursor:pointer"><circle cx="' + p.x + '" cy="' + p.y + '" r="5.4" fill="' + col + '" stroke="#0f0f0f" stroke-width="1"/>' +
      '<text x="' + p.x + '" y="' + (p.y + 2.1) + '" fill="#111" font-size="6" font-weight="700" text-anchor="middle" font-family="Fira Sans,sans-serif" pointer-events="none">' + m.mark_no + '</text></g>';
  });
  return '<svg id="' + (opts.id || 'vh-diagram') + '" viewBox="' + (opts.vb || tpl.viewBox.join(' ')) + '" style="display:block;width:100%;height:auto;' + (opts.interactive ? 'cursor:crosshair;touch-action:manipulation' : '') + '">' + g + '</svg>';
}
function vhLegend() {
  var mc = { existing: '#f59e0b', 'new': '#ef4444', driver: '#3b82f6', repaired: '#22c55e' };
  return '<div style="display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:var(--text-dim);margin-top:8px">' +
    [['existing', 'Existing (on file)'], ['new', 'New at turn-in'], ['driver', 'Added by driver'], ['repaired', 'Repaired']].map(function (x) {
      return '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:11px;height:11px;border-radius:50%;background:' + mc[x[0]] + '"></span>' + x[1] + '</span>';
    }).join('') + '</div>';
}
// Wire taps on an interactive diagram: a mark selects it, empty vehicle adds one.
function vhWireDiagram(svgId, d, onMark, onPoint) {
  var svg = document.getElementById(svgId);
  if (!svg) return;
  svg.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== svg) {
      if (t.getAttribute && t.getAttribute('data-vhmark')) { onMark(parseInt(t.getAttribute('data-vhmark'), 10)); return; }
      t = t.parentNode;
    }
    if (!onPoint) return;
    var pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    var ctm = svg.getScreenCTM();
    if (!ctm) return;
    var cp = pt.matrixTransform(ctm.inverse());
    var tpl = d.template, hit = null;
    Object.keys(tpl.views).forEach(function (key) {
      if (hit) return;
      var v = tpl.views[key];
      var lx = cp.x - v.x, ly = cp.y - v.y;
      if (v.flip === -1) lx = tpl.mirrorWidth - lx;
      if (lx >= v.box[0] && ly >= v.box[1] && lx <= v.box[2] && ly <= v.box[3]) hit = { view: key, x: Math.round(lx * 10) / 10, y: Math.round(ly * 10) / 10 };
    });
    if (hit) onPoint(hit);
    else vhToast('Tap on the vehicle to place the mark.', 'info');
  });
}

// ---------------------------------------------------------------- camera
// Nova's own camera, same approach as inspection photos: the server stamps the
// time at the shutter and the upload goes straight to storage. No camera roll.
var _vhCam = { stream: null, ctx: null };
function vhCamClose() {
  if (_vhCam.stream) { try { _vhCam.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
  _vhCam.stream = null; _vhCam.ctx = null;
  var ov = document.getElementById('vh-cam');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
}
async function vhCamera(sheetId, label, hint, body, onDone) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    novaAlert('This browser cannot open the camera. Vehicle photos need a current version of Chrome, Safari or Edge.');
    return;
  }
  vhCamClose();
  _vhCam.ctx = { sheetId: sheetId, body: body, onDone: onDone };
  var ov = document.createElement('div');
  ov.id = 'vh-cam';
  ov.setAttribute('style', 'position:fixed;inset:0;z-index:10000;background:#000;display:flex;flex-direction:column');
  ov.innerHTML =
    '<div style="padding:10px 14px;color:#fff;font-size:13px;display:flex;align-items:center;gap:10px;background:rgba(0,0,0,.85)">' +
      '<div style="flex:1"><div style="font-weight:600">' + vhE(label) + '</div>' + (hint ? '<div style="color:#bbb;font-size:12px">' + vhE(hint) + '</div>' : '') + '</div>' +
      '<button type="button" class="btn btn-secondary btn-sm" onclick="vhCamClose()">Cancel</button></div>' +
    '<div style="flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center">' +
      '<video id="vh-cam-video" autoplay playsinline muted style="max-width:100%;max-height:100%;object-fit:contain"></video>' +
      '<div style="position:absolute;inset:8%;border:2px dashed rgba(255,255,255,.35);border-radius:10px;pointer-events:none"></div></div>' +
    '<div style="padding:14px;text-align:center;background:rgba(0,0,0,.85)">' +
      '<div id="vh-cam-status" style="color:#bbb;font-size:12px;min-height:16px;margin-bottom:8px">Starting the camera...</div>' +
      '<button type="button" id="vh-cam-shoot" onclick="vhCamShoot(this)" disabled style="width:66px;height:66px;border-radius:50%;border:4px solid #fff;background:#f97316;cursor:pointer"></button></div>';
  document.body.appendChild(ov);
  var status = document.getElementById('vh-cam-status');
  try {
    _vhCam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    var vid = document.getElementById('vh-cam-video');
    if (!vid) { vhCamClose(); return; }
    vid.srcObject = _vhCam.stream;
    document.getElementById('vh-cam-shoot').disabled = false;
    if (status) status.textContent = 'Line it up inside the frame and tap the shutter.';
  } catch (e) {
    var name = (e && e.name) || '';
    var msg = 'Nova could not open the camera.';
    if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Camera access is blocked for Nova. Allow the camera for this site, then try again.';
    else if (name === 'NotFoundError' || name === 'OverconstrainedError') msg = 'No camera was found on this device.';
    else if (name === 'NotReadableError') msg = 'The camera is in use by another app. Close it and try again.';
    if (status) { status.style.color = '#f87171'; status.textContent = msg; }
  }
}
async function vhCamShoot(btn) {
  var video = document.getElementById('vh-cam-video');
  var status = document.getElementById('vh-cam-status');
  var ctx = _vhCam.ctx;
  if (!video || !video.videoWidth || !ctx) return;
  btn.disabled = true;
  if (status) { status.style.color = '#bbb'; status.textContent = 'Saving...'; }
  try {
    var vw = video.videoWidth, vhh = video.videoHeight;
    var scale = Math.min(1, 1920 / Math.max(vw, vhh));
    var cv = document.createElement('canvas');
    cv.width = Math.round(vw * scale); cv.height = Math.round(vhh * scale);
    cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
    var phash = (typeof inspPerceptualHash === 'function') ? inspPerceptualHash(cv) : null;
    var blob = await new Promise(function (resolve) { cv.toBlob(resolve, 'image/jpeg', 0.85); });
    if (!blob) throw new Error('The camera did not return an image. Try again.');
    var shot = await api('POST', '/vehicle-handoffs/' + ctx.sheetId + '/photos/shoot', ctx.body);
    var put = await fetch(shot.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    if (!put.ok) throw new Error('The photo did not upload. Check your signal and try again.');
    var sheet = await api('POST', '/vehicle-handoffs/photos/' + shot.photo_id + '/confirm', { phash: phash });
    var cb = ctx.onDone;
    vhCamClose();
    if (cb) cb(sheet);
    vhToast('Photo saved.');
  } catch (e) {
    if (status) { status.style.color = '#f87171'; status.textContent = (e && e.message) || 'Could not save the photo.'; }
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- Fleet Registry hooks
function vhRowActions(v) {
  var canManage = can('manage_vehicle_handoffs'), canView = can('view_vehicle_handoffs');
  // Fleet Registry renders synchronously; fetch the scope once in the background
  // and let the next render use it.
  if (!_vh.cfg && !_vhCfgLoading && (canManage || canView)) { _vhCfgLoading = true; vhConfig().catch(function () {}).then(function () { _vhCfgLoading = false; }); }
  if (!vhInScope(v.city_code)) return '';
  if (v.open_handoff_id) {
    return (canView || canManage) ? '<button class="btn btn-secondary btn-sm" onclick="navigate(&#39;vehicle-handoff&#39;,' + v.open_handoff_id + ')">Open sheet</button> ' : '';
  }
  if (!canManage || !v.active) return '';
  if (v.assigned_user_id) return '<button class="btn btn-secondary btn-sm" onclick="vhStart(&#39;turn_in&#39;,' + v.id + ')">Turn in</button> ';
  return '<button class="btn btn-primary btn-sm" onclick="vhStart(&#39;assign&#39;,' + v.id + ')">Assign</button> ';
}
function vhDriverPill(v) {
  if (!v.open_handoff_status) return '';
  var txt = {
    awaiting_driver: v.open_handoff_kind === 'turn_in' ? 'Turn-in started' : 'Waiting on driver',
    in_progress: v.open_handoff_kind === 'turn_in' ? 'Turn-in in progress' : 'Assignment in progress',
    returned: 'Sent back to driver', flagged: 'Driver flagged a problem', ready_for_review: 'Ready for review'
  }[v.open_handoff_status] || '';
  var col = v.open_handoff_status === 'ready_for_review' || v.open_handoff_status === 'flagged' ? 'background:#3a2a10;color:#fbbf24' : 'background:#1a0d2e;color:#a78bfa';
  return txt ? '<div style="margin-top:3px"><span style="display:inline-block;font-size:11px;font-weight:700;border-radius:10px;padding:2px 8px;' + col + '">' + vhE(txt) + '</span></div>' : '';
}

// ---------------------------------------------------------------- start a sheet
async function vhStart(kind, vehicleId) {
  var cfg, users = [], vehicles = [];
  try {
    cfg = await vhConfig(true);
    vehicles = await api('GET', '/vehicles/all');
    // The user list is gated by view_users (managers have it by default). Without
    // it the dialog still opens; the driver list is just empty, and the server
    // still decides who may start what.
    users = await api('GET', '/users').catch(function () { return []; });
  } catch (e) { vhErr(e); return; }
  var veh = null;
  vehicles.forEach(function (v) { if (v.id === vehicleId) veh = v; });
  var active = (users || []).filter(function (u) { return u.active && (!u.home_city || vhInScope(u.home_city)); }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  var userOpts = '<option value="">Pick a driver</option>' + active.map(function (u) {
    return '<option value="' + u.id + '">' + vhE(u.name) + (u.home_city ? ' · ' + vhE(u.home_city) : '') + '</option>';
  }).join('');
  var vehOpts = vehicles.filter(function (v) { return v.active && !v.open_handoff_id && vhInScope(v.city_code); }).map(function (v) {
    return '<option value="' + v.id + '"' + (v.id === vehicleId ? ' selected' : '') + '>' + vhE(v.year + ' ' + v.make_model + (v.license_plate ? ' · ' + v.license_plate : '') + (v.driver_name ? ' · ' + v.driver_name : ' · unassigned')) + '</option>';
  }).join('');
  var agRows = (cfg.agreements || []).map(function (a) {
    var on = a.is_default && (a.use_on === 'both' || a.use_on === (kind || 'assign'));
    return '<label style="display:flex;align-items:center;gap:10px;font-size:14px;margin-bottom:6px;color:var(--text);font-weight:400"><input type="checkbox" class="vh-ag" value="' + a.id + '"' + (on ? ' checked' : '') + ' style="width:auto"/> ' + vhE(a.name) +
      ' <span style="font-size:12px;color:var(--text-muted-color)">' + (a.use_on === 'turn_in' ? 'turn-ins' : (a.use_on === 'both' ? 'both' : 'assignments')) + (a.is_default ? ', default' : '') + '</span></label>';
  }).join('');
  var isTurnIn = kind === 'turn_in';
  var reasonOpts = [['reassignment', 'Reassignment'], ['separation', 'Separation'], ['shop', 'Vehicle to shop'], ['sold_retired', 'Sold / retired'], ['other', 'Other']]
    .map(function (r) { return '<option value="' + r[0] + '">' + r[1] + '</option>'; }).join('');
  var html =
    '<div class="card-header"><span class="card-title">' + (isTurnIn ? 'Start vehicle turn-in' : 'Start vehicle assignment') + '</span>' +
      (veh ? '<span style="font-size:12.5px;color:var(--text-muted-color)">' + vhE(veh.year + ' ' + veh.make_model + (veh.license_plate ? ' · ' + veh.license_plate : '')) + '</span>' : '') + '</div>' +
    '<div class="card-body">' +
      '<div id="vh-start-err"></div>' +
      (veh ? '<input type="hidden" id="vh-start-veh" value="' + veh.id + '"/>' :
        '<div class="form-group"><label>Vehicle</label><select id="vh-start-veh">' + vehOpts + '</select></div>') +
      (isTurnIn
        ? '<div class="form-group"><label>Driver turning it in</label><div style="font-weight:600">' + vhE((veh && veh.driver_name) || 'Current driver') + '</div></div>' +
          '<div class="form-group"><label>Reason</label><select id="vh-start-reason">' + reasonOpts + '</select></div>' +
          '<div class="form-group"><label>After turn-in</label>' +
            '<label style="display:flex;gap:8px;font-size:14px;margin-bottom:6px;color:var(--text);font-weight:400"><input type="radio" name="vh-after" value="pool" checked style="width:auto"/> Return to pool (unassigned)</label>' +
            '<label style="display:flex;gap:8px;font-size:14px;align-items:center;color:var(--text);font-weight:400"><input type="radio" name="vh-after" value="reassign" style="width:auto"/> Reassign right after to <select id="vh-start-next" style="width:auto;margin-left:6px">' + userOpts + '</select></label></div>'
        : '<div class="form-group"><label>Driver</label><select id="vh-start-driver">' + userOpts + '</select></div>' +
          '<div class="form-group"><label>Effective date</label><input type="date" id="vh-start-eff" value="' + new Date().toLocaleDateString('en-CA') + '"/></div>') +
      '<div class="form-group"><label>Complete by (optional)</label><input type="datetime-local" id="vh-start-due"/></div>' +
      '<div class="form-group"><label>Who fills it out</label>' +
        '<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px;color:var(--text);font-weight:400"><input type="radio" name="vh-fill" value="driver" checked style="width:auto;margin-top:3px"/><span><b>The driver</b> (recommended)<br><span style="font-size:12.5px;color:var(--text-muted-color)">They take the photos, check the damage, do the checklist and sign on their phone. You review and countersign.</span></span></label>' +
        '<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:6px;color:var(--text);font-weight:400"><input type="radio" name="vh-fill" value="manager" style="width:auto;margin-top:3px"/><span><b>Me, in person</b><br><span style="font-size:12.5px;color:var(--text-muted-color)">You fill it out; the driver still initials and signs on their own login.</span></span></label></div>' +
      '<div class="form-group"><label>Agreements</label>' + (agRows || '<div style="font-size:13px;color:var(--text-muted-color)">No live agreements. Add one in Settings.</div>') + '</div>' +
      '<div class="form-group" style="margin:0"><label>Note to driver (optional)</label><input type="text" id="vh-start-note" maxlength="500" placeholder="Where the van is, where the keys are"/></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px"><button class="btn btn-secondary" onclick="vhModalClose()">Cancel</button>' +
      '<button class="btn btn-primary" id="vh-start-go" onclick="vhStartGo(&#39;' + (kind || '') + '&#39;)">Start sheet</button></div>' +
    '</div>';
  vhModal(html, 560);
}
async function vhStartGo(kind) {
  var err = document.getElementById('vh-start-err');
  var btn = document.getElementById('vh-start-go');
  function v(id) { var x = document.getElementById(id); return x ? x.value : ''; }
  var vehicleId = parseInt(v('vh-start-veh'), 10);
  if (!kind) {
    // Started from the queue: the vehicle decides the kind.
    var vs = await api('GET', '/vehicles/all');
    vs.forEach(function (x) { if (x.id === vehicleId) kind = x.assigned_user_id ? 'turn_in' : 'assign'; });
  }
  var fill = (document.querySelector('input[name="vh-fill"]:checked') || {}).value || 'driver';
  var after = (document.querySelector('input[name="vh-after"]:checked') || {}).value || 'pool';
  var ags = Array.prototype.slice.call(document.querySelectorAll('.vh-ag:checked')).map(function (c) { return parseInt(c.value, 10); });
  var due = v('vh-start-due');
  var body = {
    kind: kind, vehicle_id: vehicleId, filled_by: fill, agreement_ids: ags, note: v('vh-start-note'),
    due_at: due ? new Date(due).toISOString() : null
  };
  if (kind === 'assign') { body.driver_user_id = parseInt(v('vh-start-driver'), 10) || null; body.effective_date = v('vh-start-eff'); }
  else { body.reason = v('vh-start-reason') || 'reassignment'; body.after_turn_in = after; body.reassign_to_user_id = after === 'reassign' ? (parseInt(v('vh-start-next'), 10) || null) : null; }
  try {
    btn.disabled = true;
    var s = await api('POST', '/vehicle-handoffs', body);
    vhModalClose();
    vhToast(fill === 'driver' ? 'Sheet started. The driver has been notified.' : 'Sheet started.');
    navigate('vehicle-handoff', s.id);
  } catch (e) {
    btn.disabled = false;
    if (err) err.innerHTML = '<div class="alert alert-error">' + vhE(e.message) + '</div>';
  }
}

// ---------------------------------------------------------------- queue
async function renderVehicleHandoffs(el) {
  _vh.el = el;
  el.innerHTML = '<div class="loading">Loading&hellip;</div>';
  var data;
  try { await vhConfig(); data = await api('GET', '/vehicle-handoffs?tab=' + encodeURIComponent(_vh.queueTab)); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">' + vhE(e.message) + '</div>'; return; }
  var c = data.counts || {};
  var tabs = [['review', 'Needs review', c.review], ['driver', 'With driver', c.driver], ['completed', 'Completed'], ['voided', 'Voided'], ['open', 'All open']];
  var rows = (data.sheets || []).map(function (s) {
    return '<tr style="cursor:pointer" onclick="navigate(&#39;vehicle-handoff&#39;,' + s.id + ')">' +
      '<td><strong style="color:var(--primary)">' + vhE(s.handoff_number) + '</strong></td>' +
      '<td>' + vhKindLabel(s.kind) + '</td><td>' + vhE(s.vehicle_name) + '</td><td>' + vhE(s.driver_name || '-') + '</td>' +
      '<td>' + vhE(s.city_code || '') + '</td><td>' + vhBadge(s.status, s.status_label) + '</td>' +
      '<td style="font-size:13px;white-space:nowrap">' + (s.due_at ? vhDate(s.due_at, true) : '-') + '</td>' +
      '<td style="font-size:13px;white-space:nowrap">' + vhDate(s.updated_at, true) + '</td></tr>';
  }).join('');
  el.innerHTML =
    '<div class="page-header"><div><div class="page-title">Vehicle Assignments</div><div class="page-subtitle">Signed assignment and turn-in sheets. The responsible employee on a vehicle changes only when a sheet is countersigned.</div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        (vhIsAdminOwner() ? '<button class="btn btn-secondary" onclick="navigate(&#39;vehicle-sheet-settings&#39;)">Settings</button>' : '') +
        (can('manage_vehicle_handoffs') ? '<button class="btn btn-primary" onclick="vhStart(null,null)">+ Start sheet</button>' : '') +
      '</div></div>' +
    '<div style="display:flex;gap:0;margin-bottom:16px;border-bottom:1px solid var(--border);flex-wrap:wrap">' + tabs.map(function (t) {
      var on = t[0] === _vh.queueTab;
      return '<div onclick="_vh.queueTab=&#39;' + t[0] + '&#39;;renderVehicleHandoffs(_vh.el)" style="cursor:pointer;padding:10px 16px;font-size:14px;font-weight:' + (on ? 600 : 500) + ';color:' + (on ? 'var(--primary)' : 'var(--text-dim)') + ';border-bottom:2px solid ' + (on ? 'var(--primary)' : 'transparent') + ';margin-bottom:-1px">' + t[1] + (t[2] ? ' <span style="font-size:12px;font-weight:700;color:var(--primary)">' + t[2] + '</span>' : '') + '</div>';
    }).join('') + '</div>' +
    '<div class="card"><div class="card-body" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Sheet</th><th>Type</th><th>Vehicle</th><th>Driver</th><th>City</th><th>Status</th><th>Due</th><th>Updated</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-muted-color)">Nothing here. Start a sheet from Fleet Registry with Assign or Turn in.</td></tr>') +
    '</tbody></table></div></div></div>';
}

// ---------------------------------------------------------------- one sheet (manager)
async function renderVehicleHandoff(el, id) {
  _vh.el = el;
  el.innerHTML = '<div class="loading">Loading&hellip;</div>';
  try {
    await vhConfig();
    var s = await api('GET', '/vehicle-handoffs/' + id);
    _vh.tplData = await vhTpl(s.v_body_type);
    if (!_vh.sheet || _vh.sheet.id !== s.id) { _vh.tab = 'photos'; _vh.selMark = null; }
    _vh.sheet = s;
    if (s.access.is_driver && !s.access.can_manage) { navigate('vehicle-sheet', s.id); return; }
    vhRenderManager();
  } catch (e) { el.innerHTML = '<div class="alert alert-error">' + vhE(e.message) + '</div>'; }
}
function vhSet(s) { _vh.sheet = s; if (_vh.mode === 'driver') vhRenderDriver(); else vhRenderManager(); }

function vhStepBar(s) {
  var driverDone = !!s.driver_signed_at || s.driver_not_present;
  var steps = [
    ['Started', true, false],
    [s.filled_by === 'manager' ? 'Manager fills out' : 'Driver fills out', driverDone || s.status === 'ready_for_review', VH_OPEN_FILL.indexOf(s.status) !== -1],
    [s.driver_not_present ? 'Driver not present' : 'Driver signs', driverDone, false],
    ['Manager countersigns', s.status === 'completed', s.status === 'ready_for_review'],
    ['Fleet updated', s.status === 'completed', false]
  ];
  return '<div class="vh-steps" style="display:flex;margin-bottom:18px;border:1px solid var(--border);border-radius:8px;overflow:hidden;flex-wrap:wrap">' + steps.map(function (st, i) {
    var col = st[1] ? '#86efac' : (st[2] ? 'var(--primary)' : 'var(--text-muted-color)');
    return '<div style="flex:1;min-width:120px;padding:10px 14px;font-size:13px;color:' + col + ';background:' + (st[2] ? 'rgba(249,115,22,.1)' : 'var(--bg-card)') + ';border-right:1px solid var(--border);font-weight:' + (st[2] ? 600 : 400) + '"><b style="display:block;font-size:11px;opacity:.8">' + (i + 1) + '</b>' + st[0] + '</div>';
  }).join('') + '</div>';
}
var VH_OPEN_FILL = ['awaiting_driver', 'in_progress', 'returned', 'flagged'];

function vhSubtabs(items, active, fn) {
  return '<div style="display:flex;gap:0;margin:-6px 0 18px;border-bottom:1px solid var(--border);flex-wrap:wrap">' + items.map(function (t) {
    var on = t[0] === active;
    return '<div onclick="' + fn + '(&#39;' + t[0] + '&#39;)" style="cursor:pointer;padding:10px 16px;font-size:14px;font-weight:' + (on ? 600 : 500) + ';color:' + (on ? 'var(--primary)' : 'var(--text-dim)') + ';border-bottom:2px solid ' + (on ? 'var(--primary)' : 'transparent') + ';margin-bottom:-1px;display:flex;gap:8px;align-items:center">' + t[1] +
      (t[2] ? '<span style="font-size:12px;font-weight:600;color:' + (t[3] || 'var(--text-muted-color)') + '">' + t[2] + '</span>' : '') + '</div>';
  }).join('') + '</div>';
}
function vhMgrTab(t) { _vh.tab = t; vhRenderManager(); }

function vhCounts(s) {
  var covered = {};
  (s.photos || []).forEach(function (p) { if (p.status === 'ready' && p.slot_key !== 'mark') covered[p.slot_key] = true; });
  var slots = s.photo_slots || [];
  var shot = slots.filter(function (x) { return covered[x.key]; }).length;
  var marks = s.marks || [];
  var newCount = marks.filter(function (m) { return m.state === 'new'; }).length;
  var worse = marks.filter(function (m) { return m.change === 'worse'; }).length;
  var drv = marks.filter(function (m) { return m.state === 'driver'; }).length;
  var missing = (s.checklist || []).filter(function (c) { return c.state === 'missing'; }).length;
  var unanswered = (s.checklist || []).filter(function (c) { return !c.state; }).length;
  return { shot: shot, slots: slots.length, marks: marks.filter(function (m) { return m.status === 'open'; }).length, newCount: newCount, worse: worse, drv: drv, missing: missing, unanswered: unanswered };
}

function vhRenderManager() {
  _vh.mode = 'manager';
  var s = _vh.sheet, el = _vh.el, a = s.access;
  var k = vhCounts(s);
  var dmgMeta = s.kind === 'turn_in' ? (k.newCount + ' new' + (k.worse ? ' · ' + k.worse + ' worse' : '')) : (k.marks + ' mark' + (k.marks === 1 ? '' : 's'));
  var tabs = [
    ['photos', 'Photos', k.shot + ' of ' + k.slots, k.shot === k.slots ? '#86efac' : '#fcd34d'],
    ['damage', 'Damage', dmgMeta + (k.drv ? ' · ' + k.drv + ' to confirm' : ''), (k.newCount || k.worse || k.drv) ? '#fca5a5' : ''],
    ['checklist', s.kind === 'turn_in' ? 'Returned items' : 'Checklist', k.unanswered ? k.unanswered + ' open' : (k.missing ? k.missing + ' missing' : 'done'), k.unanswered || k.missing ? '#fcd34d' : '#86efac'],
    ['agreement', 'Agreement', '', ''],
    ['review', s.status === 'completed' ? 'Signed' : 'Review & sign', s.status === 'ready_for_review' ? 'ready' : '', '#86efac']
  ];
  var banner = '';
  if (s.status === 'flagged') banner = '<div class="alert alert-error" style="margin-bottom:14px"><b>' + vhE(s.driver_name) + ' flagged a problem:</b> ' + vhE(s.flag_reason) + '</div>';
  else if (s.status === 'returned') banner = '<div class="alert alert-warn" style="margin-bottom:14px"><b>Sent back to the driver:</b> ' + vhE(s.returned_reason) + '</div>';
  else if (s.status === 'awaiting_driver') banner = '<div class="alert alert-info" style="margin-bottom:14px">Waiting on ' + vhE(s.driver_name) + (s.due_at ? ', due ' + vhDate(s.due_at, true) : '') + '. They have been notified.</div>';
  else if (s.status === 'voided') banner = '<div class="alert alert-error" style="margin-bottom:14px"><b>Voided:</b> ' + vhE(s.voided_reason) + '</div>';
  else if (s.status === 'completed') banner = '<div class="alert alert-success" style="margin-bottom:14px">Completed ' + vhDate(s.completed_at, true) + '. ' + (s.kind === 'assign' ? vhE(s.driver_name) + ' is now the responsible employee.' : 'The vehicle was turned in.') + '</div>';
  if (s.note) banner += '<div style="font-size:13px;color:var(--text-muted-color);margin:-6px 0 14px">Note to driver: ' + vhE(s.note) + '</div>';
  var body = '';
  if (_vh.tab === 'photos') body = vhMgrPhotos(s);
  else if (_vh.tab === 'damage') body = vhDamagePanel(s, false);
  else if (_vh.tab === 'checklist') body = vhChecklistPanel(s, a.can_fill);
  else if (_vh.tab === 'agreement') body = vhAgreementPanel(s, false);
  else body = vhReviewPanel(s);
  el.innerHTML =
    '<div class="page-header"><div><div class="page-title">' + vhTitle(s) + ' <span style="color:var(--text-muted-color);font-weight:500">' + vhE(s.handoff_number) + '</span> ' + vhBadge(s.status, s.status_label) + '</div>' +
      '<div class="page-subtitle">' + vhE(s.vehicle_name) + (s.v_vin ? ' · VIN ' + vhE(s.v_vin) : '') + ' · ' + vhE(s.city_code || s.v_city || '') + ' · Driver: ' + vhE(s.driver_name || '-') + (s.filled_by === 'driver' ? ' · filled out by the driver' : ' · filled out in person') + '</div></div>' +
      vhBackBtn('vehicle-handoffs', 'Vehicle Assignments') + '</div>' +
    vhStepBar(s) + banner + vhSubtabs(tabs, _vh.tab, 'vhMgrTab') + '<div id="vh-body">' + body + '</div>';
  if (_vh.tab === 'damage') vhWireDamage(false);
  if (_vh.tab === 'review' && (s.has_driver_signature || s.has_manager_signature)) vhLoadSignatures(s.id);
}

function vhReadingsCard(s, editable) {
  var fuel = ((_vh.cfg && _vh.cfg.fuel_levels) || ['E', '1/4', '1/2', '3/4', 'F']);
  return '<div class="card" style="margin-bottom:18px"><div class="card-header"><span class="card-title">Readings</span></div><div class="card-body">' +
    '<div class="form-row">' +
      '<div class="form-group"><label>Odometer (miles)</label>' + (editable
        ? '<input type="number" inputmode="numeric" id="vh-odo" value="' + (s.odometer != null ? s.odometer : '') + '" placeholder="' + (s.v_mileage ? 'Last on file ' + s.v_mileage : 'Read it off the dash') + '" onchange="vhSaveReadings()"/>'
        : '<div style="font-weight:600;font-size:15px">' + (s.odometer != null ? Number(s.odometer).toLocaleString() + ' mi' : '-') + '</div>') + '</div>' +
      '<div class="form-group"><label>Fuel</label>' + (editable
        ? '<select id="vh-fuel" onchange="vhSaveReadings()"><option value="">Pick</option>' + fuel.map(function (f) { return '<option' + (s.fuel_level === f ? ' selected' : '') + '>' + f + '</option>'; }).join('') + '</select>'
        : '<div style="font-weight:600;font-size:15px">' + vhE(s.fuel_level || '-') + '</div>') + '</div>' +
      '<div class="form-group"><label>Effective</label><div style="font-weight:600;font-size:15px">' + vhDay(s.effective_date) + '</div></div>' +
    '</div>' + vhPriorReadings(s) + '</div></div>';
}
function vhPriorReadings(s) {
  var p = s.prior;
  if (s.kind !== 'turn_in' || !p) return '';
  var delta = (p.odometer != null && s.odometer != null) ? Number(s.odometer) - Number(p.odometer) : null;
  return '<div style="font-size:13px;color:var(--text-muted-color);margin-top:4px">At assignment (' + vhE(p.handoff_number) + ', ' + vhDay(p.effective_date) + '): ' +
    (p.odometer != null ? Number(p.odometer).toLocaleString() + ' mi' : 'no reading') + (p.fuel_level ? ', fuel ' + vhE(p.fuel_level) : '') +
    (delta != null ? ' &middot; <b style="color:' + (delta < 0 ? '#fca5a5' : 'var(--text)') + '">' + (delta >= 0 ? '+' : '') + delta.toLocaleString() + ' mi</b>' + (delta < 0 ? ' (lower than at assignment, check the reading)' : '') : '') + '</div>';
}
async function vhSaveReadings() {
  var odo = document.getElementById('vh-odo'), fuel = document.getElementById('vh-fuel');
  var body = {};
  if (odo) body.odometer = odo.value === '' ? null : parseInt(odo.value, 10);
  if (fuel) body.fuel_level = fuel.value || null;
  try { var s = await api('PUT', '/vehicle-handoffs/' + _vh.sheet.id, body); _vh.sheet = s; vhToast('Saved.'); } catch (e) { vhErr(e); }
}

function vhPhotoTile(s, slot, idx, forDriver) {
  var a = s.access;
  var photos = (s.photos || []).filter(function (p) { return p.slot_key === slot.key; });
  var ready = photos.filter(function (p) { return p.status === 'ready'; })[0];
  var rejected = photos.filter(function (p) { return p.status === 'rejected'; });
  var owedRetake = rejected.filter(function (r) { return !photos.some(function (p) { return p.replaces_photo_id === r.id && p.status === 'ready'; }); })[0];
  var border = owedRetake ? '#ef4444' : (ready ? 'var(--border)' : (slot.required !== false ? '#f97316' : 'var(--border)'));
  var inner = ready && ready.url
    ? '<img src="' + vhE(ready.url) + '" alt="' + vhE(slot.label) + '" style="width:100%;height:100%;object-fit:cover;display:block" onclick="vhViewPhoto(&#39;' + vhE(ready.url) + '&#39;)"/>'
    : '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted-color);font-size:12px;gap:6px">' + VH_CAM_SVG + (a.can_fill ? 'Tap to shoot' : 'Not taken yet') + '</div>';
  var chip = owedRetake ? '<span style="font-size:10.5px;font-weight:700;border-radius:10px;padding:2px 7px;background:#2d0d0d;color:#fca5a5">Retake</span>'
    : (ready ? '<span style="font-size:10.5px;font-weight:700;border-radius:10px;padding:2px 7px;background:#0d2d17;color:#86efac">&#10003; ' + vhDate(ready.captured_at, true) + '</span>'
      : (slot.required !== false ? '<span style="font-size:10.5px;font-weight:700;border-radius:10px;padding:2px 7px;background:#3a2210;color:#fdba74">Required</span>' : ''));
  var actions = '';
  if (a.can_fill) actions += '<button class="btn btn-secondary btn-sm" onclick="vhShootSlot(' + idx + ',' + (owedRetake ? owedRetake.id : 'null') + ')">' + (ready ? 'Reshoot' : 'Shoot') + '</button>';
  if (ready && a.can_review && !forDriver) actions += ' <button class="btn btn-ghost btn-sm" style="color:#fca5a5" onclick="vhRejectPhoto(' + ready.id + ')">Send back</button>';
  return '<div style="border:1px solid ' + border + ';border-radius:8px;overflow:hidden;background:var(--bg-elevated)">' +
    '<div style="height:120px;background:#1b1b1b;cursor:' + (a.can_fill && !ready ? 'pointer' : 'default') + '"' + (a.can_fill && !ready ? ' onclick="vhShootSlot(' + idx + ',' + (owedRetake ? owedRetake.id : 'null') + ')"' : '') + '>' + inner + '</div>' +
    '<div style="padding:8px 10px;font-size:12.5px"><div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start"><strong>' + vhE(slot.label) + '</strong>' + chip + '</div>' +
      (owedRetake ? '<div style="font-size:11.5px;color:#fca5a5;margin-top:3px">' + vhE(owedRetake.reject_reason || '') + '</div>' : (slot.hint ? '<div style="font-size:11px;color:var(--text-muted-color);margin-top:2px">' + vhE(slot.hint) + '</div>' : '')) +
      (actions ? '<div style="margin-top:6px">' + actions + '</div>' : '') + '</div></div>';
}
function vhViewPhoto(url) {
  vhModal('<div class="card-body" style="padding:8px"><img src="' + vhE(url) + '" style="width:100%;border-radius:6px;display:block"/><div style="text-align:right;margin-top:8px"><button class="btn btn-secondary btn-sm" onclick="vhModalClose()">Close</button></div></div>', 900);
}
function vhShootSlot(idx, replacesId) {
  var s = _vh.sheet, slot = (s.photo_slots || [])[idx];
  if (!slot) return;
  vhCamera(s.id, slot.label, slot.hint, { slot_key: slot.key, replaces_photo_id: replacesId || null }, function (ns) { vhSet(ns); });
}
async function vhRejectPhoto(photoId) {
  var reason = await novaPrompt('What is wrong with this photo? The driver sees this.', '', { title: 'Send photo back', okText: 'Send back' });
  if (!reason) return;
  try { vhSet(await api('POST', '/vehicle-handoffs/photos/' + photoId + '/reject', { reason: reason })); vhToast('Sent back to the driver.'); } catch (e) { vhErr(e); }
}
// Turn-in: each slot beside the same angle from the assignment it closes.
function vhPairRows(s) {
  var p = s.prior;
  var byKey = {};
  ((p && p.photos) || []).forEach(function (ph) { if (ph.slot_key && !byKey[ph.slot_key]) byKey[ph.slot_key] = ph; });
  return (s.photo_slots || []).map(function (slot, i) {
    var b = byKey[slot.key];
    var before = '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-elevated)">' +
      '<div style="height:120px;background:#1b1b1b">' + (b && b.url
        ? '<img src="' + vhE(b.url) + '" alt="' + vhE(slot.label) + ' at assignment" style="width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in" onclick="vhViewPhoto(&#39;' + vhE(b.url) + '&#39;)"/>'
        : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted-color);font-size:12px;text-align:center;padding:0 10px">' + (p ? 'No ' + vhE(slot.label) + ' photo on ' + vhE(p.handoff_number) : 'No assignment sheet on file') + '</div>') + '</div>' +
      '<div style="padding:8px 10px;font-size:12.5px"><strong>At assignment</strong><div style="font-size:11px;color:var(--text-muted-color);margin-top:2px">' + (b ? vhDate(b.captured_at, true) : '-') + '</div></div></div>';
    return '<div class="vh-pair" style="margin-bottom:14px"><div style="font-size:13px;font-weight:600;margin-bottom:6px">' + vhE(slot.label) + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' + before + vhPhotoTile(s, slot, i, false) + '</div></div>';
  }).join('');
}
function vhMgrPhotos(s) {
  if (s.kind === 'turn_in') {
    var head = s.prior ? 'Compared with ' + vhE(s.prior.handoff_number) + ' (' + vhE(s.prior.driver_name || '') + ', ' + vhDay(s.prior.effective_date) + ')'
      : 'No completed assignment sheet for this vehicle, so there is nothing to compare against';
    return vhReadingsCard(s, s.access.can_fill) +
      '<div class="card"><div class="card-header"><span class="card-title">At assignment vs. turn-in <span style="font-weight:400;font-size:13px;color:var(--text-muted-color)">' + head + '</span></span></div>' +
      '<div class="card-body"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:4px 18px" class="vh-pairs">' + vhPairRows(s) + '</div></div></div>';
  }
  var tiles = (s.photo_slots || []).map(function (slot, i) { return vhPhotoTile(s, slot, i, false); }).join('');
  return vhReadingsCard(s, s.access.can_fill) +
    '<div class="card"><div class="card-header"><span class="card-title">Condition photos <span style="font-weight:400;font-size:13px;color:var(--text-muted-color)">Nova&#39;s camera only, time-stamped by the server</span></span></div>' +
    '<div class="card-body"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">' + tiles + '</div></div></div>';
}

// ---------------------------------------------------------------- damage
function vhDamagePanel(s, forDriver) {
  var a = s.access, d = _vh.tplData;
  var kinds = (_vh.cfg.damage_kinds || []);
  var tools = a.can_add_marks ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' + kinds.map(function (k) {
    return '<button class="btn btn-sm ' + (_vh.tool === k.key ? 'btn-primary' : 'btn-secondary') + '" onclick="_vh.tool=&#39;' + k.key + '&#39;;vhRedraw()"><b style="font-family:Fira Code,monospace">' + k.code + '</b>&nbsp;' + vhE(k.label) + '</button>';
  }).join('') + '</div><div style="font-size:12.5px;color:var(--text-muted-color);margin-bottom:8px">Pick a type, then tap the spot on the van. Tap a number to open it.</div>' : '';
  var viewTabs = forDriver ? '<div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap">' + [['all', 'All'], ['ds', 'Driver'], ['ps', 'Passenger'], ['front', 'Front'], ['rear', 'Rear'], ['top', 'Top']].map(function (t) {
    return '<button class="btn btn-sm ' + (_vh.view === t[0] ? 'btn-primary' : 'btn-secondary') + '" style="padding:4px 10px" onclick="_vh.view=&#39;' + t[0] + '&#39;;vhRedraw()">' + t[1] + '</button>';
  }).join('') + '</div>' : '';
  var svg = vhDiagram(d, s.marks, { interactive: true, selected: _vh.selMark, vb: forDriver ? vhViewBox(d.template, _vh.view) : null });
  var marks = (s.marks || []);
  var list = marks.length ? marks.map(function (m) { return vhMarkRow(s, m); }).join('') : '<div style="font-size:13px;color:var(--text-muted-color);padding:10px 0">No damage marked on this vehicle.</div>';
  var reviewBtns = '';
  if (a.can_add_marks && !s.damage_reviewed_at) reviewBtns += '<button class="btn btn-primary btn-sm" onclick="vhDamageReviewed()">' + (marks.length ? 'Marks look right' : 'No damage found') + '</button> ';
  else if (s.damage_reviewed_at) reviewBtns += '<span style="font-size:12.5px;color:#86efac">&#10003; Damage checked ' + vhDate(s.damage_reviewed_at, true) + '</span> ';
  if (!forDriver && s.kind === 'turn_in' && a.can_review) {
    reviewBtns += s.manager_damage_checked_at ? '<span style="font-size:12.5px;color:#86efac;margin-left:8px">&#10003; Manager check done</span>'
      : ' <button class="btn btn-secondary btn-sm" onclick="vhDamageChecked()">Damage checked (manager)</button>';
  }
  var editor = _vh.selMark ? vhMarkEditor(s) : '';
  var diag = '<div style="background:#141414;border:1px solid var(--border);border-radius:8px;padding:8px">' + svg + '</div>' + vhLegend();
  if (forDriver) {
    return viewTabs + tools + diag + '<div style="margin-top:12px">' + editor + '</div>' +
      '<div style="margin-top:12px">' + list + '</div><div style="margin-top:12px">' + reviewBtns + '</div>';
  }
  return '<div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:18px" class="vh-dmg-grid">' +
    '<div class="card"><div class="card-header"><span class="card-title">Damage diagram</span><span style="font-size:12.5px;color:var(--text-muted-color)">' + vhE(d.template.label) + '</span></div><div class="card-body">' + tools + diag +
      '<div style="margin-top:12px">' + reviewBtns + '</div></div></div>' +
    '<div>' + editor + '<div class="card"><div class="card-header"><span class="card-title">Marked damage (' + marks.length + ')</span></div><div class="card-body" style="padding-top:4px">' + list + '</div></div></div></div>';
}
function vhMarkRow(s, m) {
  var mc = { existing: '#f59e0b', 'new': '#ef4444', driver: '#3b82f6', repaired: '#22c55e' };
  var photo = m.photo_id ? (s.photos || []).filter(function (p) { return p.id === m.photo_id; })[0] : null;
  var tag = m.state === 'driver' ? 'Added by driver, not confirmed' : (m.change === 'worse' ? 'Got worse on this sheet' : (m.change === 'repaired' ? 'Marked repaired on this sheet' : (m.state === 'new' ? 'New at this turn-in' : 'On file')));
  return '<div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="vhSelMark(' + m.id + ')">' +
    '<span style="width:24px;height:24px;border-radius:50%;background:' + (mc[m.state] || mc.existing) + ';color:#111;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + m.mark_no + '</span>' +
    '<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:600">' + vhE(vhKindName(m.kind)) + (m.location ? ' <span style="font-weight:400;color:var(--text-muted-color)">· ' + vhE(m.location) + '</span>' : '') + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color)">' + vhE(m.severity) + ' · ' + tag + (m.note ? ' · ' + vhE(m.note) : '') + '</div></div>' +
    (photo && photo.url ? '<img src="' + vhE(photo.url) + '" style="width:54px;height:40px;object-fit:cover;border-radius:5px"/>' : '') + '</div>';
}
function vhSelMark(id) { _vh.selMark = (_vh.selMark === id) ? null : id; vhRedraw(); }
function vhRedraw() { if (_vh.mode === 'driver') vhRenderDriver(); else vhRenderManager(); }
function vhMarkEditor(s) {
  var m = (s.marks || []).filter(function (x) { return x.id === _vh.selMark; })[0];
  if (!m) return '';
  var a = s.access;
  var mine = m.created_handoff_id === s.id;
  var mgr = a.can_manage && !a.is_driver;
  var editable = a.can_add_marks && mine && (!a.is_driver || m.created_by === state.user.id || mgr);
  var kinds = (_vh.cfg.damage_kinds || []).map(function (k) { return '<option value="' + k.key + '"' + (m.kind === k.key ? ' selected' : '') + '>' + vhE(k.label) + '</option>'; }).join('');
  var sev = ['minor', 'moderate', 'major'].map(function (v) { return '<option value="' + v + '"' + (m.severity === v ? ' selected' : '') + '>' + v.charAt(0).toUpperCase() + v.slice(1) + '</option>'; }).join('');
  var out = '<div class="card" style="margin-bottom:14px"><div class="card-header"><span class="card-title">Mark #' + m.mark_no + '</span><button class="btn btn-ghost btn-sm" onclick="vhSelMark(' + m.id + ')">Close</button></div><div class="card-body">';
  if (editable) {
    out += '<div class="form-row"><div class="form-group"><label>Type</label><select id="vh-mk-kind">' + kinds + '</select></div><div class="form-group"><label>Severity</label><select id="vh-mk-sev">' + sev + '</select></div></div>' +
      '<div class="form-group"><label>Location</label><input type="text" id="vh-mk-loc" maxlength="120" value="' + vhE(m.location || '') + '" placeholder="e.g. rear bumper, passenger corner"/></div>' +
      '<div class="form-group"><label>Note</label><input type="text" id="vh-mk-note" maxlength="500" value="' + vhE(m.note || '') + '"/></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" onclick="vhSaveMark(' + m.id + ')">Save</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="vhMarkPhoto(' + m.id + ')">' + (m.photo_id ? 'Retake close-up' : 'Take close-up') + '</button>' +
      '<button class="btn btn-ghost btn-sm" style="color:#ef4444;margin-left:auto" onclick="vhDeleteMark(' + m.id + ')">Remove mark</button></div>';
  } else {
    out += '<div style="font-size:14px;margin-bottom:8px"><b>' + vhE(vhKindName(m.kind)) + '</b> · ' + vhE(m.severity) + (m.location ? ' · ' + vhE(m.location) : '') + '</div>' +
      (m.note ? '<div style="font-size:13px;color:var(--text-dim);margin-bottom:8px">' + vhE(m.note) + '</div>' : '') +
      '<div style="font-size:12px;color:var(--text-muted-color)">Recorded ' + vhDate(m.created_at, true) + (m.created_by_name ? ' by ' + vhE(m.created_by_name) : '') + '</div>';
  }
  // Review happens after the driver signs, when the sheet is no longer editable,
  // so confirm / remove / re-check key off can_review, not can_add_marks.
  if (mgr && a.can_review) {
    if (m.state === 'driver') out += '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" onclick="vhMarkPatch(' + m.id + ',{confirmed:true})">Confirm this damage</button>' +
      (mine && !editable ? '<button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="vhDeleteMark(' + m.id + ')">Remove mark</button>' : '') + '</div>';
    if (!mine && m.status === 'open') {
      out += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)"><div style="font-size:12px;color:var(--text-muted-color);margin-bottom:6px">Re-check on this sheet</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button class="btn btn-sm ' + (!m.change ? 'btn-primary' : 'btn-secondary') + '" onclick="vhMarkPatch(' + m.id + ',{change:null})">Unchanged</button>' +
        '<button class="btn btn-sm ' + (m.change === 'worse' ? 'btn-primary' : 'btn-secondary') + '" onclick="vhMarkChange(' + m.id + ',&#39;worse&#39;)">Got worse</button>' +
        '<button class="btn btn-sm ' + (m.change === 'repaired' ? 'btn-primary' : 'btn-secondary') + '" onclick="vhMarkChange(' + m.id + ',&#39;repaired&#39;)">Repaired</button></div>' +
        (m.change_note ? '<div style="font-size:12px;color:var(--text-dim);margin-top:6px">' + vhE(m.change_note) + '</div>' : '') + '</div>';
    }
  }
  return out + '</div></div>';
}
function vhWireDamage(forDriver) {
  var s = _vh.sheet;
  vhWireDiagram('vh-diagram', _vh.tplData, function (id) { vhSelMark(id); }, s.access.can_add_marks ? function (pt) { vhAddMark(pt); } : null);
}
async function vhAddMark(pt) {
  try {
    var ns = await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/marks', { view: pt.view, x: pt.x, y: pt.y, kind: _vh.tool, severity: 'minor' });
    var newest = null;
    (ns.marks || []).forEach(function (m) { if (m.created_handoff_id === ns.id && (!newest || m.id > newest.id)) newest = m; });
    _vh.selMark = newest ? newest.id : null;
    vhSet(ns);
  } catch (e) { vhErr(e); }
}
async function vhSaveMark(id) {
  function v(x) { var e = document.getElementById(x); return e ? e.value : undefined; }
  try { vhSet(await api('PUT', '/vehicle-handoffs/' + _vh.sheet.id + '/marks/' + id, { kind: v('vh-mk-kind'), severity: v('vh-mk-sev'), location: v('vh-mk-loc'), note: v('vh-mk-note') })); vhToast('Mark saved.'); } catch (e) { vhErr(e); }
}
async function vhMarkPatch(id, body) {
  try { vhSet(await api('PUT', '/vehicle-handoffs/' + _vh.sheet.id + '/marks/' + id, body)); } catch (e) { vhErr(e); }
}
async function vhMarkChange(id, change) {
  var note = await novaPrompt(change === 'worse' ? 'What changed? (e.g. chip has spread into a 4 in. crack)' : 'Repaired how? (e.g. VR-2026-0031)', '', { title: change === 'worse' ? 'Got worse' : 'Repaired', okText: 'Save' });
  if (note === null) return;
  var body = { change: change, change_note: note };
  if (change === 'worse') body.severity = 'major';
  vhMarkPatch(id, body);
}
async function vhDeleteMark(id) {
  if (!(await novaConfirm('Remove this damage mark?', { okText: 'Remove' }))) return;
  _vh.selMark = null;
  try { vhSet(await api('DELETE', '/vehicle-handoffs/' + _vh.sheet.id + '/marks/' + id)); } catch (e) { vhErr(e); }
}
function vhMarkPhoto(id) {
  var m = (_vh.sheet.marks || []).filter(function (x) { return x.id === id; })[0];
  vhCamera(_vh.sheet.id, 'Close-up of damage #' + (m ? m.mark_no : ''), 'Fill the frame with the damage', { mark_id: id }, function (ns) { vhSet(ns); });
}
async function vhDamageReviewed() {
  try { vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/damage-reviewed', {})); } catch (e) { vhErr(e); }
}
async function vhDamageChecked() {
  try { vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/damage-checked', {})); vhToast('Damage check recorded.'); } catch (e) { vhErr(e); }
}

// ---------------------------------------------------------------- checklist
function vhChecklistPanel(s, editable) {
  var here = s.kind === 'turn_in' ? 'Returned' : 'Present';
  var rows = (s.checklist || []).map(function (c, i) {
    var seg = editable
      ? '<span style="display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-left:auto">' +
          '<span onclick="vhCheck(' + i + ',&#39;present&#39;)" style="cursor:pointer;padding:5px 12px;font-size:12.5px;' + (c.state === 'present' ? 'background:#0d2d17;color:#86efac;font-weight:600' : 'color:var(--text-muted-color)') + '">' + here + '</span>' +
          '<span onclick="vhCheck(' + i + ',&#39;missing&#39;)" style="cursor:pointer;padding:5px 12px;font-size:12.5px;' + (c.state === 'missing' ? 'background:#2d0d0d;color:#fca5a5;font-weight:600' : 'color:var(--text-muted-color)') + '">Missing</span></span>'
      : '<span style="margin-left:auto;font-size:12.5px;font-weight:600;color:' + (c.state === 'present' ? '#86efac' : (c.state === 'missing' ? '#fca5a5' : 'var(--text-muted-color)')) + '">' + (c.state === 'present' ? here : (c.state === 'missing' ? 'Missing' : 'Not answered')) + '</span>';
    var extra = '';
    if (c.extra && editable) extra = '<input type="text" style="width:90px;padding:4px 8px;margin-left:8px" placeholder="' + (c.extra === 'count' ? 'How many' : 'Last 4') + '" value="' + vhE(c.value || '') + '" onchange="vhCheckVal(' + i + ',this.value)"/>';
    else if (c.value) extra = '<span style="font-size:12.5px;color:var(--text-muted-color);margin-left:8px">(' + vhE(c.value) + ')</span>';
    return '<div style="display:flex;align-items:center;gap:6px;padding:9px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-elevated);margin-bottom:6px;font-size:14px;flex-wrap:wrap">' +
      '<span>' + vhE(c.label) + (c.required === false ? ' <span style="font-size:11.5px;color:var(--text-muted-color)">optional</span>' : '') + '</span>' + extra + seg + '</div>';
  }).join('');
  return '<div class="card"><div class="card-header"><span class="card-title">' + (s.kind === 'turn_in' ? 'Returned items' : 'Equipment checklist') + '</span></div><div class="card-body">' + rows +
    '<div class="form-group" style="margin:10px 0 0"><label>Note for the manager</label>' + (editable || s.access.can_sign
      ? '<input type="text" id="vh-dnote" maxlength="1000" value="' + vhE(s.driver_note || '') + '" onchange="vhSaveNote()" placeholder="Anything missing or wrong"/>'
      : '<div style="font-size:14px">' + vhE(s.driver_note || '-') + '</div>') + '</div></div></div>';
}
async function vhCheck(i, st) {
  var c = (_vh.sheet.checklist || [])[i];
  if (!c) return;
  try { vhSet(await api('PUT', '/vehicle-handoffs/' + _vh.sheet.id, { checklist: [{ key: c.key, state: c.state === st ? null : st }] })); } catch (e) { vhErr(e); }
}
async function vhCheckVal(i, v) {
  var c = (_vh.sheet.checklist || [])[i];
  if (!c) return;
  try { _vh.sheet = await api('PUT', '/vehicle-handoffs/' + _vh.sheet.id, { checklist: [{ key: c.key, value: v }] }); } catch (e) { vhErr(e); }
}
async function vhSaveNote() {
  var n = document.getElementById('vh-dnote');
  try { _vh.sheet = await api('PUT', '/vehicle-handoffs/' + _vh.sheet.id, { driver_note: n ? n.value : '' }); vhToast('Saved.'); } catch (e) { vhErr(e); }
}

// ---------------------------------------------------------------- agreements
function vhAgreementPanel(s, forDriver) {
  var canInit = s.access.can_sign && forDriver;
  var mine = vhInitialsOf(state.user && state.user.name);
  return (s.agreements || []).map(function (a) {
    var initials = a.initials || {};
    var items = (a.statements || []).map(function (st) {
      var val = initials[st.key];
      var box = val ? '<span style="border:1px solid #166534;color:#86efac;font-family:Fira Code,monospace;font-weight:600;background:#0d2d17;border-radius:6px;padding:4px 14px">' + vhE(val) + '</span>'
        : '<span style="border:1px dashed #555;border-radius:6px;padding:4px 14px;font-size:13px;color:var(--text-muted-color)">' + (canInit ? 'Tap to initial' : 'Not initialed') + '</span>';
      var isCam = st.key === 'camera';
      return '<div style="border:1px solid ' + (isCam ? '#1e3a5f' : 'var(--border)') + ';background:' + (isCam ? '#0d1e30' : 'var(--bg-card)') + ';border-radius:8px;padding:12px;margin-bottom:10px;font-size:13.5px;line-height:1.45">' +
        '<strong style="color:' + (isCam ? '#93c5fd' : 'var(--text)') + '">' + vhE(st.title) + '</strong>' + (st.required === false ? ' <span style="font-size:11.5px;color:var(--text-muted-color)">optional</span>' : '') +
        '<div style="color:' + (isCam ? '#bfdbfe' : 'var(--text-dim)') + ';margin-top:4px">' + vhE(st.body) + '</div>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:8px"' + (canInit ? ' onclick="vhInitial(' + a.id + ',&#39;' + vhE(st.key) + '&#39;,' + (val ? 'true' : 'false') + ')" style="cursor:pointer"' : '') + '><span style="cursor:' + (canInit ? 'pointer' : 'default') + '">' + box + '</span></div></div>';
    }).join('');
    return '<div class="card" style="margin-bottom:14px"><div class="card-header"><span class="card-title">' + vhE(a.agreement_name) + '</span><span style="font-size:12.5px;color:var(--text-muted-color)">v' + a.version + '</span></div><div class="card-body">' +
      (canInit ? '<div style="font-size:12.5px;color:var(--text-muted-color);margin-bottom:10px">Read each statement and tap the box to initial it as <b>' + vhE(_vh.initials || mine) + '</b>. <a href="#" onclick="vhChangeInitials();return false" style="color:var(--primary)">Change initials</a></div>' : '') +
      items + '</div></div>';
  }).join('') || '<div class="alert alert-info">No agreement is attached to this sheet.</div>';
}
async function vhChangeInitials() {
  var v = await novaPrompt('Your initials (1 to 4 letters)', _vh.initials || vhInitialsOf(state.user && state.user.name), { title: 'Initials', okText: 'Use these' });
  if (!v) return;
  _vh.initials = String(v).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  vhRedraw();
}
async function vhInitial(agId, key, clear) {
  var ini = clear ? null : (_vh.initials || vhInitialsOf(state.user && state.user.name));
  try { vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/agreements/' + agId + '/initial', { key: key, initials: ini })); } catch (e) { vhErr(e); }
}

// ---------------------------------------------------------------- review (manager)
function vhReviewPanel(s) {
  var a = s.access;
  var missing = s.status === 'ready_for_review' || s.driver_not_present ? s.missing_for_countersign : s.missing_for_sign;
  var list = (missing || []).length && s.status !== 'completed' && s.status !== 'voided'
    ? '<div class="alert alert-warn" style="margin-bottom:14px"><b>Still needed:</b><ul style="margin:6px 0 0 18px;padding:0">' + missing.map(function (m) { return '<li>' + vhE(m) + '</li>'; }).join('') + '</ul></div>' : '';
  var turnInCard = '';
  if (s.kind === 'turn_in') {
    turnInCard = '<div class="card" style="margin-bottom:14px"><div class="card-header"><span class="card-title">Turn-in</span></div><div class="card-body" style="font-size:14px">' +
      'Reason: <b>' + vhE({ reassignment: 'Reassignment', separation: 'Separation', shop: 'Vehicle to shop', sold_retired: 'Sold / retired', other: 'Other' }[s.reason] || s.reason || '-') + '</b><br>' +
      'After turn-in: <b>' + (s.after_turn_in === 'reassign' ? 'Reassign to ' + vhE(s.reassign_to_name || '-') : 'Return to pool') + '</b>' + '</div></div>';
  }
  var sigs = '<div class="card" style="margin-bottom:14px"><div class="card-header"><span class="card-title">Signatures</span></div><div class="card-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">' +
    '<div><div style="font-size:12px;color:var(--text-muted-color);margin-bottom:6px">DRIVER</div>' +
      (s.driver_not_present ? '<div style="font-size:14px">Driver not present: ' + vhE(s.driver_not_present_reason) + '</div>'
        : (s.has_driver_signature ? '<div id="vh-sig-driver" style="height:80px;background:#fff;border-radius:6px"></div><div style="font-size:12.5px;color:var(--text-muted-color);margin-top:6px">' + vhE(s.driver_name) + ' · ' + vhDate(s.driver_signed_at, true) +
            (s.driver_gps_lat != null ? ' · location shared' : ' · location not shared') + '</div>' : '<div style="font-size:14px;color:var(--text-muted-color)">Not signed yet.</div>')) + '</div>' +
    '<div><div style="font-size:12px;color:var(--text-muted-color);margin-bottom:6px">MANAGER</div>' +
      (s.has_manager_signature ? '<div id="vh-sig-manager" style="height:80px;background:#fff;border-radius:6px"></div><div style="font-size:12.5px;color:var(--text-muted-color);margin-top:6px">' + vhE(s.manager_name) + ' · ' + vhDate(s.manager_signed_at, true) + '</div>' : '<div style="font-size:14px;color:var(--text-muted-color)">Not countersigned.</div>') + '</div>' +
    '</div></div>';
  var btns = [];
  if (s.status === 'completed') btns.push('<button class="btn btn-primary" onclick="vhOpenPdf()">Open signed PDF</button>');
  if (a.can_review && s.filled_by === 'manager' && s.status === 'in_progress') btns.push('<button class="btn btn-primary" onclick="vhSendToDriver()">Send to ' + vhE(s.driver_name) + ' to sign</button>');
  if (a.can_countersign) btns.push('<button class="btn btn-primary" onclick="vhCountersign()">Countersign &amp; ' + (s.kind === 'assign' ? 'assign' : 'turn in') + '</button>');
  if (a.can_review && s.kind === 'turn_in' && s.status !== 'ready_for_review') btns.push('<button class="btn btn-secondary" onclick="vhWithoutDriver()">Complete without the driver</button>');
  if (a.can_review && s.status !== 'awaiting_driver' && !(s.filled_by === 'manager' && s.status === 'in_progress')) btns.push('<button class="btn btn-secondary" onclick="vhSendBack()">Send back' + (s.filled_by === 'driver' ? ' to ' + vhE(s.driver_name) : '') + '</button>');
  if (a.can_review) btns.push('<button class="btn btn-ghost" style="color:#ef4444" onclick="vhVoid()">Void sheet</button>');
  return list + turnInCard + sigs +
    (btns.length ? '<div class="card"><div class="card-body">' + (a.can_countersign ? '<div style="font-size:13px;color:var(--text-dim);margin-bottom:12px">Countersigning ' + (s.kind === 'assign' ? 'makes ' + vhE(s.driver_name) + ' the responsible employee on this vehicle, starts their history,' : 'turns the vehicle in, closes ' + vhE(s.driver_name) + '&#39;s history,') + ' counts as this month&#39;s inspection, and files the signed PDF.</div>' : '') +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' + btns.join('') + '</div></div></div>' : '');
}
async function vhLoadSignatures(id) {
  try {
    var sg = await api('GET', '/vehicle-handoffs/' + id + '/signatures');
    var d = document.getElementById('vh-sig-driver'), m = document.getElementById('vh-sig-manager');
    if (d && sg.driver) d.innerHTML = '<img src="' + sg.driver + '" style="height:100%;max-width:100%;object-fit:contain;display:block;margin:auto"/>';
    if (m && sg.manager) m.innerHTML = '<img src="' + sg.manager + '" style="height:100%;max-width:100%;object-fit:contain;display:block;margin:auto"/>';
  } catch (e) { /* signatures are a nicety on this screen */ }
}
function vhSign(title, cb) {
  if (typeof window.novaSigPad !== 'function') { novaAlert('The signature pad did not load. Reload the page and try again.'); return; }
  window.novaSigPad({ title: title, defaultName: state.user && state.user.name, onApply: cb });
}
function vhCountersign() {
  vhSign('Countersign ' + _vh.sheet.handoff_number, async function (data) {
    try { vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/countersign', { signature_data: data })); vhToast('Countersigned. Fleet is updated.'); }
    catch (e) { vhErr(e); }
  });
}
async function vhWithoutDriver() {
  var reason = await novaPrompt('Why is the driver not signing? (e.g. separated, did not return)', '', { title: 'Complete without the driver', okText: 'Continue' });
  if (!reason) return;
  vhSign('Sign as the manager', async function (data) {
    try { vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/complete-without-driver', { reason: reason, signature_data: data })); vhToast('Turn-in completed.'); }
    catch (e) { vhErr(e); }
  });
}
async function vhSendBack() {
  var reason = await novaPrompt('What needs fixing? The driver sees this.', '', { title: 'Send back', okText: 'Send back' });
  if (!reason) return;
  try { vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/send-back', { reason: reason })); vhToast('Sent back.'); } catch (e) { vhErr(e); }
}
async function vhSendToDriver() {
  try { vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/send-to-driver', {})); vhToast('Sent to the driver to sign.'); } catch (e) { vhErr(e); }
}
async function vhVoid() {
  var reason = await novaPrompt('Why is this sheet being voided?', '', { title: 'Void sheet', okText: 'Void' });
  if (!reason) return;
  try { vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/void', { reason: reason })); vhToast('Voided.'); } catch (e) { vhErr(e); }
}
async function vhOpenPdf() {
  try { var r = await api('GET', '/vehicle-handoffs/' + _vh.sheet.id + '/pdf'); if (r && r.url) window.open(r.url, '_blank'); } catch (e) { vhErr(e); }
}

// ---------------------------------------------------------------- driver flow (phone-first)
async function renderVehicleSheet(el, id) {
  _vh.el = el;
  el.innerHTML = '<div class="loading">Loading&hellip;</div>';
  try {
    await vhConfig();
    var s = await api('GET', '/vehicle-handoffs/' + id);
    _vh.tplData = await vhTpl(s.v_body_type);
    if (!_vh.sheet || _vh.sheet.id !== s.id) { _vh.step = null; _vh.selMark = null; _vh.view = 'ds'; }
    _vh.sheet = s;
    if (!s.access.is_driver) { navigate('vehicle-handoff', s.id); return; }
    vhRenderDriver();
  } catch (e) { el.innerHTML = '<div class="alert alert-error">' + vhE(e.message) + '</div>'; }
}
function vhDriverSteps(s) {
  var k = vhCounts(s);
  var fills = s.filled_by === 'driver';
  var ags = s.agreements || [];
  var left = 0, total = 0;
  ags.forEach(function (a) { (a.statements || []).forEach(function (st) { if (st.required !== false) { total++; if (!(a.initials || {})[st.key]) left++; } }); });
  return [
    ['readings', 'Readings', (s.odometer != null && s.fuel_level) ? (Number(s.odometer).toLocaleString() + ' mi · fuel ' + s.fuel_level) : (fills ? 'Odometer, fuel' : 'Filled in by your manager'), s.odometer != null && !!s.fuel_level],
    ['photos', 'Photos', k.shot + ' of ' + k.slots, k.shot >= (s.photo_slots || []).filter(function (x) { return x.required !== false; }).length],
    ['damage', 'Damage', k.marks + ' on file' + (k.drv ? ' · ' + k.drv + ' added' : ''), !!s.damage_reviewed_at],
    ['checklist', s.kind === 'turn_in' ? 'Returned items' : 'Checklist', k.unanswered ? k.unanswered + ' to answer' : (k.missing ? k.missing + ' missing' : 'done'), !k.unanswered],
    ['agreement', 'Agreement', total ? (total - left) + ' of ' + total + ' initialed' : 'none', left === 0],
    ['sign', 'Sign', s.driver_signed_at ? 'Signed ' + vhDate(s.driver_signed_at, true) : '', !!s.driver_signed_at]
  ];
}
function vhDrvStep(st) { _vh.step = st; _vh.selMark = null; vhRenderDriver(); window.scrollTo(0, 0); }
function vhRenderDriver() {
  _vh.mode = 'driver';
  var s = _vh.sheet, el = _vh.el, a = s.access;
  var head = '<div style="max-width:560px;margin:0 auto">' +
    '<div style="font-size:12px;color:var(--text-muted-color)">' + vhE(s.handoff_number) + ' · from ' + vhE(s.created_by_name || 'your manager') + (s.due_at ? ' · due ' + vhDate(s.due_at, true) : '') + '</div>' +
    '<div style="font-size:21px;font-weight:700;margin:4px 0 2px">' + (s.kind === 'turn_in' ? 'Turn in your vehicle' : 'Your vehicle sheet') + '</div>' +
    '<div style="font-size:13.5px;color:var(--text-dim);margin-bottom:12px">' + vhE(s.vehicle_name) + '</div>';
  var foot = '</div>';
  var banner = '';
  if (s.status === 'returned' && s.returned_reason) banner = '<div class="alert alert-warn" style="margin-bottom:12px"><b>Sent back:</b> ' + vhE(s.returned_reason) + '</div>';
  if (s.note) banner += '<div class="alert alert-info" style="margin-bottom:12px">' + vhE(s.created_by_name || 'Manager') + ': ' + vhE(s.note) + '</div>';
  if (s.status === 'ready_for_review') { el.innerHTML = head + '<div class="alert alert-success">Signed. Waiting for ' + vhE(s.created_by_name || 'your manager') + ' to countersign.</div>' + foot; return; }
  if (s.status === 'completed') { el.innerHTML = head + '<div class="alert alert-success">Done. ' + (s.kind === 'assign' ? 'You are the responsible employee on this vehicle.' : 'Your turn-in is complete.') + '</div><button class="btn btn-secondary" onclick="vhOpenPdf()">Open the signed PDF</button>' + foot; return; }
  if (s.status === 'voided') { el.innerHTML = head + '<div class="alert alert-error">This sheet was canceled: ' + vhE(s.voided_reason) + '</div>' + foot; return; }
  if (s.status === 'flagged') banner += '<div class="alert alert-warn" style="margin-bottom:12px">You flagged a problem: ' + vhE(s.flag_reason) + '. Your manager has been told. You can keep going once it is sorted out.</div>';
  if (!a.can_sign) { el.innerHTML = head + '<div class="alert alert-info">Your manager is still filling this out. You will get a text when it is ready for you to sign.</div>' + foot; return; }

  if (!_vh.step) {
    var steps = vhDriverSteps(s).map(function (st, i) {
      var done = st[3];
      var ic = done ? '<span style="width:28px;height:28px;border-radius:50%;background:#0d2d17;color:#86efac;display:flex;align-items:center;justify-content:center;font-weight:700">&#10003;</span>'
        : '<span style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);color:var(--text-dim);display:flex;align-items:center;justify-content:center">' + (i + 1) + '</span>';
      return '<div onclick="vhDrvStep(&#39;' + st[0] + '&#39;)" style="cursor:pointer;display:flex;gap:12px;align-items:center;padding:13px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:var(--bg-card)">' + ic +
        '<div style="flex:1"><div style="font-weight:600;font-size:15px">' + st[1] + '</div><div style="font-size:12.5px;color:var(--text-muted-color)">' + vhE(st[2]) + '</div></div><span style="color:var(--text-muted-color);font-size:20px">&#8250;</span></div>';
    }).join('');
    el.innerHTML = head + banner + steps + '<div style="font-size:12px;color:var(--text-muted-color);margin-top:6px">Saved as you go. You can stop and come back.</div>' +
      '<button class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:14px" onclick="vhFlag()">Something is wrong</button>' + foot;
    return;
  }
  var back = '<button class="btn btn-ghost btn-sm" style="margin-bottom:8px;padding-left:0" onclick="vhDrvStep(null)">&#8249; All steps</button>';
  var order = ['readings', 'photos', 'damage', 'checklist', 'agreement', 'sign'];
  var nextStep = order[order.indexOf(_vh.step) + 1];
  var next = nextStep ? '<button class="btn btn-primary" style="width:100%;justify-content:center;min-height:46px;margin-top:14px" onclick="vhDrvStep(&#39;' + nextStep + '&#39;)">Next</button>' : '';
  var body = '';
  if (_vh.step === 'readings') body = vhReadingsCard(s, a.can_fill) + next;
  else if (_vh.step === 'photos') {
    body = '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">' + (s.photo_slots || []).map(function (slot, i) { return vhPhotoTile(s, slot, i, true); }).join('') + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:10px">Nova&#39;s camera only. Each photo is stamped with the time it was taken.</div>' + next;
  }
  else if (_vh.step === 'damage') {
    body = '<div style="font-size:13.5px;color:var(--text-dim);margin-bottom:10px">Walk around the van. Tap a number to see it. If you find damage that is not marked, add it now, or you may be held to it at turn-in.</div>' + vhDamagePanel(s, true) + (s.damage_reviewed_at ? next : '');
  }
  else if (_vh.step === 'checklist') body = vhChecklistPanel(s, a.can_fill) + next;
  else if (_vh.step === 'agreement') body = vhAgreementPanel(s, true) + next;
  else if (_vh.step === 'sign') {
    var miss = s.missing_for_sign || [];
    body = (miss.length ? '<div class="alert alert-warn" style="margin-bottom:12px"><b>Before you sign:</b><ul style="margin:6px 0 0 18px;padding:0">' + miss.map(function (m) { return '<li>' + vhE(m) + '</li>'; }).join('') + '</ul></div>'
        : '<div class="alert alert-success" style="margin-bottom:12px">Everything is done. Read the box below and sign.</div>') +
      '<label style="display:flex;gap:10px;font-size:14px;line-height:1.45;margin-bottom:14px;color:var(--text);font-weight:400"><input type="checkbox" id="vh-consent" style="width:auto;margin-top:3px"/>' +
        (s.kind === 'turn_in' ? 'I am returning this vehicle in the condition shown in the photos, damage marks and checklist, and I agree to the statements I initialed.' : 'I received this vehicle in the condition shown in the photos, damage marks and checklist, and I agree to the statements I initialed.') + '</label>' +
      '<div style="font-size:12.5px;color:var(--text-muted-color);margin-bottom:14px">Signing as <b style="color:var(--text)">' + vhE(state.user && state.user.name) + '</b> on your own Nova login. Time, location and device are recorded with your signature.</div>' +
      '<button class="btn btn-primary" style="width:100%;justify-content:center;min-height:48px"' + (miss.length ? ' disabled' : '') + ' onclick="vhDriverSign()">Sign' + (s.kind === 'turn_in' ? ' turn-in' : ' and accept vehicle') + '</button>' +
      '<button class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:8px" onclick="vhFlag()">Something is wrong</button>';
  }
  el.innerHTML = head + banner + back + '<div style="font-size:18px;font-weight:700;margin-bottom:10px">' + vhE(vhDriverSteps(s).filter(function (x) { return x[0] === _vh.step; })[0][1]) + '</div>' + body + foot;
  if (_vh.step === 'damage') vhWireDamage(true);
}
async function vhFlag() {
  var reason = await novaPrompt('What is wrong? Your manager gets this right away.', '', { title: 'Something is wrong', okText: 'Send' });
  if (!reason) return;
  try { vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/flag', { reason: reason })); vhToast('Your manager has been told.'); } catch (e) { vhErr(e); }
}
function vhGps() {
  return new Promise(function (resolve) {
    if (!navigator.geolocation) return resolve(null);
    var done = false;
    setTimeout(function () { if (!done) { done = true; resolve(null); } }, 6000);
    try {
      navigator.geolocation.getCurrentPosition(function (p) { if (!done) { done = true; resolve(p.coords); } }, function () { if (!done) { done = true; resolve(null); } }, { enableHighAccuracy: true, timeout: 5500, maximumAge: 60000 });
    } catch (e) { if (!done) { done = true; resolve(null); } }
  });
}
function vhDriverSign() {
  var c = document.getElementById('vh-consent');
  if (!c || !c.checked) { vhToast('Tick the box first.', 'error'); return; }
  vhSign('Sign ' + _vh.sheet.handoff_number, async function (data) {
    var g = await vhGps();
    try {
      vhSet(await api('POST', '/vehicle-handoffs/' + _vh.sheet.id + '/driver-sign', {
        consent: true, signature_data: data,
        gps_lat: g ? g.latitude : null, gps_lon: g ? g.longitude : null, gps_accuracy: g ? g.accuracy : null
      }));
      _vh.step = null;
      vhToast('Signed. Your manager will countersign.');
    } catch (e) { vhErr(e); }
  });
}

// ---------------------------------------------------------------- settings
// Settings and agreements are company-wide: admin/owner only (the server enforces it).
function vhIsAdminOwner() { return !!(state.user && (state.user.role === 'admin' || state.user.role === 'owner')); }
async function renderVehicleSheetSettings(el) {
  _vh.el = el;
  if (!vhIsAdminOwner()) { el.innerHTML = '<div class="alert alert-info">Vehicle sheet settings and agreements are managed by an admin or owner.</div>'; return; }
  el.innerHTML = '<div class="loading">Loading&hellip;</div>';
  try { _vh.settings = await api('GET', '/vehicle-handoffs/settings'); _vh.tplData = await vhTpl('express'); await vhConfig(true); }
  catch (e) { el.innerHTML = '<div class="alert alert-error">' + vhE(e.message) + '</div>'; return; }
  vhRenderSettings();
}
function vhSetTab(t) { _vh.setTab = t; _vh.agEdit = null; vhRenderSettings(); }
function vhRenderSettings() {
  var el = _vh.el, st = _vh.settings;
  var tabs = [['slots', 'Photo slots'], ['checklist', 'Checklist items'], ['agreements', 'Agreements'], ['diagrams', 'Diagrams']];
  var body = '';
  if (_vh.setTab === 'slots') body = vhListEditor('slots', st.photo_slots, [['label', 'Name', 'text'], ['hint', 'Hint for the photographer', 'text']]);
  else if (_vh.setTab === 'checklist') body = vhListEditor('checklist', st.checklist, [['label', 'Item', 'text'], ['extra', 'Also ask for', 'extra']]);
  else if (_vh.setTab === 'agreements') body = vhAgreementLibrary();
  else body = '<div class="card"><div class="card-header"><span class="card-title">' + vhE(_vh.tplData.template.label) + '</span><span style="font-size:12.5px;color:var(--text-muted-color)">' + vhE(_vh.tplData.template.models) + '</span></div><div class="card-body"><div style="background:#141414;border-radius:8px;padding:8px;max-width:760px">' + vhDiagram(_vh.tplData, [], {}) + '</div>' +
    '<div style="font-size:13px;color:var(--text-muted-color);margin-top:10px">Every vehicle uses this diagram today. More body types can be added later without moving any signed mark: each mark is stored against its view, not the picture.</div></div></div>';
  el.innerHTML = '<div class="page-header"><div><div class="page-title">Settings · Vehicle Assignment Sheets</div><div class="page-subtitle">What every new sheet asks for. Sheets already started keep the version they were started with.</div></div>' + vhBackBtn('vehicle-handoffs', 'Vehicle Assignments') + '</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap">' + tabs.map(function (t) { return '<button class="btn btn-sm ' + (_vh.setTab === t[0] ? 'btn-primary' : 'btn-secondary') + '" onclick="vhSetTab(&#39;' + t[0] + '&#39;)">' + t[1] + '</button>'; }).join('') + '</div>' + body;
}
// Photo slots and checklist items share one list editor.
function vhListEditor(which, list, fields) {
  var rows = (list || []).map(function (item, i) {
    var f = fields.map(function (fd) {
      if (fd[2] === 'extra') {
        return '<select data-vhf="' + fd[0] + '" data-vhi="' + i + '" style="width:auto"><option value=""' + (!item.extra ? ' selected' : '') + '>Nothing else</option><option value="count"' + (item.extra === 'count' ? ' selected' : '') + '>A count</option><option value="last4"' + (item.extra === 'last4' ? ' selected' : '') + '>Last 4 digits</option></select>';
      }
      return '<input type="text" data-vhf="' + fd[0] + '" data-vhi="' + i + '" value="' + vhE(item[fd[0]] || '') + '" placeholder="' + vhE(fd[1]) + '" style="flex:1;min-width:140px"/>';
    }).join('');
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-elevated);margin-bottom:6px;flex-wrap:wrap">' +
      '<span style="display:flex;flex-direction:column"><button class="btn btn-ghost btn-sm" style="padding:0 6px;min-height:0" onclick="vhListMove(&#39;' + which + '&#39;,' + i + ',-1)">&#9650;</button><button class="btn btn-ghost btn-sm" style="padding:0 6px;min-height:0" onclick="vhListMove(&#39;' + which + '&#39;,' + i + ',1)">&#9660;</button></span>' +
      f + '<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-dim);margin:0;white-space:nowrap"><input type="checkbox" data-vhf="required" data-vhi="' + i + '"' + (item.required !== false ? ' checked' : '') + ' style="width:auto"/> Required</label>' +
      '<button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="vhListRemove(&#39;' + which + '&#39;,' + i + ')">Remove</button></div>';
  }).join('');
  return '<div class="card" style="max-width:900px"><div class="card-header"><span class="card-title">' + (which === 'slots' ? 'Photo slots' : 'Checklist items') + '</span><button class="btn btn-secondary btn-sm" onclick="vhListAdd(&#39;' + which + '&#39;)">+ Add</button></div><div class="card-body" id="vh-list-' + which + '">' + rows +
    '<div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn btn-primary" onclick="vhListSave(&#39;' + which + '&#39;)">Save</button></div></div></div>';
}
function vhListRead(which) {
  var key = which === 'slots' ? 'photo_slots' : 'checklist';
  var list = (_vh.settings[key] || []).map(function (x) { return Object.assign({}, x); });
  document.querySelectorAll('#vh-list-' + which + ' [data-vhi]').forEach(function (inp) {
    var i = parseInt(inp.getAttribute('data-vhi'), 10), f = inp.getAttribute('data-vhf');
    if (!list[i]) return;
    list[i][f] = inp.type === 'checkbox' ? inp.checked : (f === 'extra' ? (inp.value || null) : inp.value);
  });
  _vh.settings[key] = list;
  return list;
}
function vhListMove(which, i, d) {
  var list = vhListRead(which), j = i + d;
  if (j < 0 || j >= list.length) return;
  var t = list[i]; list[i] = list[j]; list[j] = t;
  vhRenderSettings();
}
function vhListRemove(which, i) { var list = vhListRead(which); list.splice(i, 1); vhRenderSettings(); }
function vhListAdd(which) { var list = vhListRead(which); list.push({ label: '', required: true }); vhRenderSettings(); }
async function vhListSave(which) {
  var list = vhListRead(which);
  var body = {};
  body[which === 'slots' ? 'photo_slots' : 'checklist'] = list;
  try {
    var r = await api('PUT', '/vehicle-handoffs/settings', body);
    _vh.settings.photo_slots = r.photo_slots; _vh.settings.checklist = r.checklist;
    vhToast('Saved. New sheets use this list.');
    vhRenderSettings();
  } catch (e) { vhErr(e); }
}

function vhAgreementLibrary() {
  var st = _vh.settings;
  var rows = (st.agreements || []).map(function (a) {
    var badge = a.status === 'live' ? '<span class="badge badge-completed">Live</span>' : (a.status === 'draft' ? '<span class="badge badge-draft">Draft</span>' : '<span class="badge badge-cancelled">Archived</span>');
    var acts = a.status === 'archived'
      ? '<button class="btn btn-secondary btn-sm" onclick="vhAgEdit(' + a.id + ')">View</button> <button class="btn btn-secondary btn-sm" onclick="vhAgAct(' + a.id + ',&#39;copy&#39;)">Copy</button> <button class="btn btn-ghost btn-sm" style="color:#22c55e" onclick="vhAgAct(' + a.id + ',&#39;restore&#39;)">Restore</button>'
      : '<button class="btn btn-secondary btn-sm" onclick="vhAgEdit(' + a.id + ')">Edit</button> <button class="btn btn-secondary btn-sm" onclick="vhAgAct(' + a.id + ',&#39;copy&#39;)">Copy</button> ' +
        (a.signed_count > 0 ? '<button class="btn btn-ghost btn-sm" style="color:#a78bfa" onclick="vhAgAct(' + a.id + ',&#39;archive&#39;)">Archive</button>' : '<button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="vhAgAct(' + a.id + ',&#39;delete&#39;)">Delete</button>');
    return '<tr style="' + (a.status === 'archived' ? 'opacity:.6' : '') + '"><td><strong>' + vhE(a.name) + '</strong><div style="font-size:12px;color:var(--text-muted-color)">' + (a.use_on === 'turn_in' ? 'Turn-ins' : (a.use_on === 'both' ? 'Assignments and turn-ins' : 'Assignments')) + (a.is_default ? ', on by default' : '') + '</div></td>' +
      '<td>' + badge + '</td><td style="font-size:13px">v' + a.version + '</td><td style="font-size:13px">' + (a.statements || []).length + ' statements</td><td style="font-size:13px">' + (a.signed_count || 0) + ' signed</td><td style="white-space:nowrap">' + acts + '</td></tr>';
  }).join('');
  return '<div class="card" style="margin-bottom:18px"><div class="card-header"><span class="card-title">Agreements</span><button class="btn btn-primary btn-sm" onclick="vhAgEdit(0)">+ New agreement</button></div><div class="card-body" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Agreement</th><th>Status</th><th>Version</th><th>Content</th><th>Used</th><th></th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted-color)">No agreements yet.</td></tr>') + '</tbody></table></div></div></div>' +
    '<div class="alert alert-info" style="font-size:13px;margin-bottom:18px">An agreement nobody has signed can be deleted. Once anyone signs it, it can only be archived: it leaves the picker, and every signed sheet keeps the exact text that person agreed to. Changing the wording of a signed agreement saves it as a new version.</div>' +
    (_vh.agEdit ? vhAgEditor() : '');
}
function vhAgEdit(id) {
  if (!id) _vh.agEdit = { id: 0, name: '', use_on: 'assign', is_default: false, status: 'draft', version: 1, statements: [{ title: '', body: '', required: true }] };
  else {
    var a = (_vh.settings.agreements || []).filter(function (x) { return x.id === id; })[0];
    _vh.agEdit = JSON.parse(JSON.stringify(a));
  }
  vhRenderSettings();
  setTimeout(function () { var e = document.getElementById('vh-ag-editor'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
}
function vhAgRead() {
  var a = _vh.agEdit;
  if (!a) return null;
  function v(id) { var x = document.getElementById(id); return x ? x.value : ''; }
  a.name = v('vh-ag-name'); a.use_on = v('vh-ag-use') || 'assign';
  var d = document.getElementById('vh-ag-default'); a.is_default = !!(d && d.checked);
  a.statements = (a.statements || []).map(function (st, i) {
    var r = document.getElementById('vh-st-req-' + i);
    return { key: st.key, title: v('vh-st-title-' + i), body: v('vh-st-body-' + i), required: r ? r.checked : true };
  });
  return a;
}
function vhAgEditor() {
  var a = _vh.agEdit, ro = a.status === 'archived';
  var sts = (a.statements || []).map(function (st, i) {
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--bg-elevated)">' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap"><input type="text" id="vh-st-title-' + i + '" value="' + vhE(st.title) + '" placeholder="Title, e.g. Vehicle camera" style="flex:1;min-width:160px"' + (ro ? ' disabled' : '') + '/>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;margin:0;color:var(--text-dim)"><input type="checkbox" id="vh-st-req-' + i + '"' + (st.required !== false ? ' checked' : '') + ' style="width:auto"' + (ro ? ' disabled' : '') + '/> Required</label>' +
        (ro ? '' : '<button class="btn btn-ghost btn-sm" onclick="vhStMove(' + i + ',-1)">&#9650;</button><button class="btn btn-ghost btn-sm" onclick="vhStMove(' + i + ',1)">&#9660;</button><button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="vhStRemove(' + i + ')">Remove</button>') + '</div>' +
      '<textarea id="vh-st-body-' + i + '" rows="3" style="width:100%" placeholder="The wording the driver initials"' + (ro ? ' disabled' : '') + '>' + vhE(st.body) + '</textarea></div>';
  }).join('');
  return '<div class="card" id="vh-ag-editor"><div class="card-header"><span class="card-title">' + (a.id ? vhE(a.name) + ' · edit' : 'New agreement') + '</span>' + (a.id ? '<span class="badge ' + (a.status === 'live' ? 'badge-completed' : 'badge-draft') + '">v' + a.version + ' ' + vhE(a.status) + '</span>' : '') + '</div><div class="card-body">' +
    '<div class="form-row"><div class="form-group"><label>Name</label><input type="text" id="vh-ag-name" value="' + vhE(a.name) + '" maxlength="120"' + (ro ? ' disabled' : '') + '/></div>' +
    '<div class="form-group"><label>Use on</label><select id="vh-ag-use"' + (ro ? ' disabled' : '') + '><option value="assign"' + (a.use_on === 'assign' ? ' selected' : '') + '>Assignments</option><option value="turn_in"' + (a.use_on === 'turn_in' ? ' selected' : '') + '>Turn-ins</option><option value="both"' + (a.use_on === 'both' ? ' selected' : '') + '>Both</option></select></div></div>' +
    '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin-bottom:14px;color:var(--text)"><input type="checkbox" id="vh-ag-default"' + (a.is_default ? ' checked' : '') + ' style="width:auto"' + (ro ? ' disabled' : '') + '/> On by default for new sheets</label>' +
    '<div style="font-size:12px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Statements</div>' + sts +
    (ro ? '' : '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px"><button class="btn btn-secondary" onclick="vhStAdd()">+ Add statement</button><button class="btn btn-secondary" onclick="vhAgPreview()">Preview as driver</button>' +
      (a.status !== 'live' ? '<button class="btn btn-secondary" onclick="vhAgSave(&#39;draft&#39;)">Save draft</button>' : '') +
      '<button class="btn btn-primary" onclick="vhAgSave(&#39;live&#39;)">' + (a.status === 'live' ? 'Save' : 'Publish') + '</button></div>') +
    '</div></div>';
}
function vhStMove(i, d) { var a = vhAgRead(), j = i + d; if (j < 0 || j >= a.statements.length) return; var t = a.statements[i]; a.statements[i] = a.statements[j]; a.statements[j] = t; vhRenderSettings(); }
function vhStRemove(i) { var a = vhAgRead(); a.statements.splice(i, 1); vhRenderSettings(); }
function vhStAdd() { var a = vhAgRead(); a.statements.push({ title: '', body: '', required: true }); vhRenderSettings(); }
function vhAgPreview() {
  var a = vhAgRead();
  var sample = { access: { can_sign: false }, agreements: [{ id: 0, agreement_name: a.name || 'Agreement', version: a.version || 1, statements: a.statements, initials: {} }] };
  vhModal('<div class="card-header"><span class="card-title">What the driver sees</span><button class="btn btn-ghost btn-sm" onclick="vhModalClose()">Close</button></div><div class="card-body" style="max-width:420px;margin:0 auto">' + vhAgreementPanel(sample, false) + '</div>', 520);
}
async function vhAgSave(status) {
  var a = vhAgRead();
  var body = { name: a.name, use_on: a.use_on, is_default: a.is_default, statements: a.statements, status: status };
  try {
    var r = a.id ? await api('PUT', '/vehicle-handoffs/agreements/' + a.id, body) : await api('POST', '/vehicle-handoffs/agreements', body);
    if (a.id && r.version !== a.version) vhToast('Saved as v' + r.version + '. Signed sheets keep the version they were signed under.');
    else vhToast(status === 'live' ? 'Saved and live.' : 'Draft saved.');
    _vh.settings = await api('GET', '/vehicle-handoffs/settings');
    _vh.agEdit = null;
    vhRenderSettings();
  } catch (e) { vhErr(e); }
}
async function vhAgAct(id, act) {
  try {
    if (act === 'delete') {
      if (!(await novaConfirm('Delete this agreement? Nobody has signed it, so it is removed for good.', { okText: 'Delete' }))) return;
      await api('DELETE', '/vehicle-handoffs/agreements/' + id);
    } else {
      await api('POST', '/vehicle-handoffs/agreements/' + id + '/' + act, {});
    }
    _vh.settings = await api('GET', '/vehicle-handoffs/settings');
    _vh.agEdit = null;
    vhRenderSettings();
    vhToast({ copy: 'Copied as a draft.', archive: 'Archived.', restore: 'Restored.', 'delete': 'Deleted.' }[act]);
  } catch (e) { vhErr(e); }
}

// ---------------------------------------------------------------- wraps of existing screens
(function () {
  // Edit Vehicle: the Responsible Employee changes through a sheet. Admin/owner may
  // override with a reason (routes/vehicles.js enforces the same rule).
  var origEdit = window.renderEditVehicle;
  if (typeof origEdit === 'function') {
    window.renderEditVehicle = async function (el, id) {
      await origEdit(el, id);
      try {
        var sel = document.getElementById('ve-driver');
        if (!sel) return;
        var original = sel.value;
        var admin = state.user && (state.user.role === 'admin' || state.user.role === 'owner');
        var grp = sel.parentNode;
        var note = document.createElement('div');
        note.style.cssText = 'font-size:12px;color:var(--text-muted-color);margin-top:6px';
        if (!admin) {
          sel.disabled = true;
          note.innerHTML = 'Changes through <b>Assign</b> / <b>Turn in</b> on Fleet Registry, so every handoff is signed.';
          grp.appendChild(note);
          return;
        }
        note.innerHTML = 'Normally changed with <b>Assign</b> / <b>Turn in</b>. Changing it here is an override and needs a reason.';
        var reason = document.createElement('input');
        reason.type = 'text'; reason.id = 've-driver-reason'; reason.placeholder = 'Reason for the override (required)';
        reason.style.cssText = 'margin-top:8px;display:none';
        grp.appendChild(note); grp.appendChild(reason);
        sel.addEventListener('change', function () { reason.style.display = (sel.value !== original) ? 'block' : 'none'; if (sel.value === original) reason.value = ''; });
      } catch (e) { /* the edit form still works without the hint */ }
    };
  }

  // Vehicle history: Assignment sheets, Current damage, Who had it.
  var origHist = window.renderVehicleHistory;
  if (typeof origHist === 'function') {
    window.renderVehicleHistory = async function (el, vehicleId) {
      await origHist(el, vehicleId);
      if (!can('view_vehicle_handoffs')) return;
      try {
        var d = await api('GET', '/vehicle-handoffs/vehicle/' + vehicleId);
        var tplData = await vhTpl(d.vehicle.body_type);
        await vhConfig();
        var sheets = (d.sheets || []).map(function (s) {
          return '<tr style="cursor:pointer" onclick="navigate(&#39;vehicle-handoff&#39;,' + s.id + ')"><td><strong style="color:var(--primary)">' + vhE(s.handoff_number) + '</strong></td><td>' + vhKindLabel(s.kind) + '</td><td>' + vhE(s.driver_name || '-') + '</td>' +
            '<td style="font-size:13px;white-space:nowrap">' + vhDate(s.completed_at || s.created_at) + '</td><td>' + (s.odometer != null ? Number(s.odometer).toLocaleString() : '-') + '</td><td>' + vhBadge(s.status, s.status_label) + '</td></tr>';
        }).join('');
        var hist = (d.history || []).map(function (h) {
          var miles = (h.end_odometer != null && h.start_odometer != null) ? (Number(h.end_odometer) - Number(h.start_odometer)).toLocaleString() + ' mi' : '';
          return '<div style="display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);font-size:14px"><span><strong>' + vhE(h.user_name || '(unknown)') + '</strong><div style="font-size:12px;color:var(--text-muted-color)">' + vhDay(h.start_date) + ' to ' + (h.end_date ? vhDay(h.end_date) : 'present') + '</div></span>' +
            '<span style="text-align:right;font-size:12.5px;color:var(--text-muted-color)">' + miles + '<div>' + (h.source === 'backfill' ? 'from Fleet records' : (h.source === 'override' ? 'admin override' : 'signed sheet')) + '</div></span></div>';
        }).join('');
        var canStart = can('manage_vehicle_handoffs') && !(d.sheets || []).some(function (s) { return ['awaiting_driver', 'in_progress', 'returned', 'flagged', 'ready_for_review'].indexOf(s.status) !== -1; });
        var startBtn = canStart ? (d.vehicle.assigned_user_id ? '<button class="btn btn-secondary btn-sm" onclick="vhStart(&#39;turn_in&#39;,' + d.vehicle.id + ')">Turn in</button>' : '<button class="btn btn-primary btn-sm" onclick="vhStart(&#39;assign&#39;,' + d.vehicle.id + ')">Assign</button>') : '';
        var html = '<div style="display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:18px;margin-bottom:20px" class="vh-hist-grid">' +
          '<div class="card"><div class="card-header"><span class="card-title">Assignment sheets</span>' + startBtn + '</div><div class="card-body" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Sheet</th><th>Type</th><th>Driver</th><th>Date</th><th>Odometer</th><th>Status</th></tr></thead><tbody>' +
            (sheets || '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted-color)">No sheets yet.</td></tr>') + '</tbody></table></div></div></div>' +
          '<div><div class="card" style="margin-bottom:18px"><div class="card-header"><span class="card-title">Current damage <span style="font-weight:400;font-size:13px;color:' + ((d.marks || []).length ? '#fca5a5' : 'var(--text-muted-color)') + '">' + (d.marks || []).length + ' open mark' + ((d.marks || []).length === 1 ? '' : 's') + '</span></span></div><div class="card-body"><div style="background:#141414;border-radius:8px;padding:6px">' + vhDiagram(tplData, d.marks || [], { id: 'vh-hist-diagram' }) + '</div>' +
            '<div style="font-size:12px;color:var(--text-muted-color);margin-top:8px">Every mark from every sheet, until a repair closes it.</div></div></div>' +
          '<div class="card"><div class="card-header"><span class="card-title">Who had it</span></div><div class="card-body" style="padding-top:4px">' + (hist || '<div style="font-size:13px;color:var(--text-muted-color);padding:8px 0">No history yet.</div>') +
            '<div style="font-size:12px;color:var(--text-muted-color);margin-top:10px">Answers "who was driving on this date?" for a ticket, toll or camera clip.</div></div></div></div></div>';
        var hdr = el.querySelector('.page-header');
        var wrap = document.createElement('div');
        wrap.innerHTML = html;
        if (hdr && hdr.parentNode) hdr.parentNode.insertBefore(wrap, hdr.nextSibling);
        else el.insertBefore(wrap, el.firstChild);
      } catch (e) { /* the rest of the history page still stands */ }
    };
  }

  // Home: a card for a driver who has a vehicle sheet to do.
  var origHome = window.renderHomeScreen;
  if (typeof origHome === 'function') {
    window.renderHomeScreen = async function (host) {
      await origHome.apply(this, arguments);
      try {
        var mine = await api('GET', '/vehicle-handoffs/mine');
        if (!mine || !mine.length) return;
        var cards = mine.map(function (s) {
          return '<div class="card" style="margin-bottom:14px;border-color:var(--primary)"><div class="card-body" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
            '<div style="flex:1;min-width:200px"><div style="font-weight:700;font-size:16px">' + (s.kind === 'turn_in' ? 'Turn in your vehicle' : 'Sign for your vehicle') + '</div>' +
            '<div style="font-size:13px;color:var(--text-dim)">' + vhE(s.vehicle_name) + ' · ' + vhE(s.handoff_number) + (s.due_at ? ' · due ' + vhDate(s.due_at, true) : '') + '</div>' +
            (s.status === 'returned' && s.returned_reason ? '<div style="font-size:12.5px;color:#fcd34d;margin-top:4px">Sent back: ' + vhE(s.returned_reason) + '</div>' : '') + '</div>' +
            '<button class="btn btn-primary" onclick="navigate(&#39;vehicle-sheet&#39;,' + s.id + ')">' + (s.status === 'awaiting_driver' ? 'Start' : 'Continue') + '</button></div></div>';
        }).join('');
        var box = document.createElement('div');
        box.id = 'vh-home-cards';
        box.innerHTML = cards;
        var target = host || document.getElementById('content');
        if (target && !document.getElementById('vh-home-cards')) {
          var hdr = target.querySelector('.page-header');
          if (hdr && hdr.parentNode) hdr.parentNode.insertBefore(box, hdr.nextSibling);
          else target.insertBefore(box, target.firstChild);
        }
      } catch (e) { /* home still renders without it */ }
    };
  }
})();

// Narrow screens: stack the two-column grids.
(function () {
  try {
    var st = document.createElement('style');
    st.textContent = '@media (max-width: 900px){ .vh-dmg-grid, .vh-hist-grid, .vh-pairs { grid-template-columns: 1fr !important; } }';
    document.head.appendChild(st);
  } catch (e) {}
})();
