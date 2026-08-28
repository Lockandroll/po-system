// Nova Releases of Liability.
//
// Four screens plus the dialogs that drive them:
//   releases  - every release, by status
//   release   - one release: the builder, the send dialog, the countersign panel
//               and the audit trail, depending on where it has got to
//   the card on a complaint, injected into renderFeedbackDetail
//   the public signing page at /release/<token>, which runs with no login
//
// The document is drawn server-side by utils/releasePdf.js from the same record
// this screen edits, so what a manager sees here is what the customer signs.
//
// The signature pad below (novaSigPad) is deliberately a separate, self-contained
// implementation rather than a refactor of sigSignPad in app.js. The e-signature
// module is live and its pad works; pulling it apart to share it would put a
// working feature at risk for no user-visible gain. novaSigPad is written to be
// the shared one when somebody does migrate sigSignPad onto it.
//
// House style: string concatenation only, no template literals/backticks.
// Apostrophes inside HTML strings are &#39;.
(function () {
  'use strict';

  var API = '/releases';

  var S = {};          // the release currently open
  var _listFilter = '';

  function el(id) { return document.getElementById(id); }
  function esc(s) { return (typeof escHtml === 'function') ? escHtml(s == null ? '' : s) : String(s == null ? '' : s); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'success'); }
  function val(id) { var e = el(id); return e ? e.value : ''; }
  function canView() { return (typeof can === 'function') && can('view_releases'); }
  function canManage() { return (typeof can === 'function') && can('manage_releases'); }

  function usd(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // A DATE column arrives as 'YYYY-MM-DD' or an ISO stamp. Read the date part
  // literally rather than through the Date constructor, which would shift a
  // bare date back a day for anyone west of UTC.
  function ymd(v) {
    if (!v) return '';
    var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? (m[1] + '-' + m[2] + '-' + m[3]) : '';
  }
  function mdy(v) {
    var d = ymd(v);
    if (!d) return '';
    var p = d.split('-');
    return p[1] + '/' + p[2] + '/' + p[0];
  }
  function whenText(v) {
    if (!v) return '';
    var t = new Date(v);
    if (isNaN(t.getTime())) return String(v);
    return t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  var STATUS_LABEL = {
    draft: 'Draft', sent: 'Waiting on customer', customer_signed: 'Waiting on countersignature',
    completed: 'Completed', declined: 'Declined', voided: 'Voided', expired: 'Expired'
  };
  function statusPill(s) {
    var c = { completed: 'rgba(34,197,94,.15)|#4ade80', customer_signed: 'rgba(249,115,22,.15)|#f97316',
      sent: 'rgba(245,158,11,.15)|#fbbf24', draft: 'rgba(255,255,255,.07)|#999',
      declined: 'rgba(239,68,68,.15)|#f87171', voided: 'rgba(255,255,255,.07)|#888',
      expired: 'rgba(255,255,255,.07)|#888' }[s] || 'rgba(255,255,255,.07)|#888';
    var p = c.split('|');
    return '<span style="display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:20px;background:' +
      p[0] + ';color:' + p[1] + '">' + esc(STATUS_LABEL[s] || s) + '</span>';
  }

  var CARD = 'background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px';
  var INP = 'padding:8px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;outline:none;width:100%;box-sizing:border-box';
  var LBL = 'display:block;font-size:11px;color:var(--text-muted-color);margin-bottom:4px';

  function injectCss() {
    if (el('rel-css')) return;
    var st = document.createElement('style');
    st.id = 'rel-css';
    st.textContent =
      '.rel-grid{display:grid;gap:12px}' +
      '.rel-2{grid-template-columns:1fr 1fr}.rel-3{grid-template-columns:1fr 1fr 1fr}.rel-4{grid-template-columns:repeat(4,1fr)}' +
      '@media(max-width:640px){.rel-2,.rel-3,.rel-4{grid-template-columns:1fr 1fr}}' +
      '.rel-pre{border-color:rgba(249,115,22,.4) !important}' +
      '.rel-doc{background:#fff;color:#111;border-radius:8px;overflow:hidden;font-size:13px}' +
      '.rel-doc .rd-hdr{display:flex}' +
      '.rel-doc .rd-hdr .l{flex:1;background:#141414;color:#fff;padding:14px 16px}' +
      '.rel-doc .rd-hdr .l small{font-size:8px;letter-spacing:.18em;color:#9a9a9a;display:block;margin-bottom:4px}' +
      '.rel-doc .rd-hdr .l h2{font-size:22px;font-weight:700;margin:0;letter-spacing:-.02em;line-height:1.1}' +
      '.rel-doc .rd-hdr .r{width:112px;background:#f26522;display:flex;align-items:center;justify-content:center;text-align:center;color:#fff;font-weight:700;font-style:italic;font-size:14px}' +
      '.rel-doc .rd-meta{background:#2b2b2b;color:#ccc;font-size:9.5px;padding:6px 16px}' +
      '.rel-doc .rd-meta b{color:#fff}' +
      '.rel-doc .rd-body{padding:16px}' +
      '.rel-doc .rd-sh{font-size:12px;font-weight:700;letter-spacing:.05em;margin:16px 0 8px;display:flex;align-items:center;gap:7px}' +
      '.rel-doc .rd-sh:first-child{margin-top:0}' +
      '.rel-doc .rd-sh::before{content:"";width:6px;height:6px;border-radius:50%;background:#f26522;flex:none}' +
      '.rel-doc .rd-grp{font-size:11px;font-weight:700;margin:10px 0 6px}' +
      '.rel-doc .rd-l{font-size:7.5px;letter-spacing:.09em;color:#767676;text-transform:uppercase;margin-bottom:2px}' +
      '.rel-doc .rd-v{background:#dfe3f7;font-size:11.5px;padding:4px 6px;min-height:21px;word-break:break-word}' +
      '.rel-doc .rd-legal{font-size:10.5px;line-height:1.55;color:#333;margin-top:8px}' +
      '.rel-doc .rd-ft{background:#f26522;color:#fff;font-size:8.5px;padding:7px 16px}' +
      '.rel-doc .rd-sig{border:1px dashed #f26522;background:#fff7ef;border-radius:6px;padding:12px;text-align:center;color:#c25000;font-size:12px;cursor:pointer}' +
      '.rel-doc .rd-sig img{max-height:52px}';
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- sig pad
  // Draw or type, canvas to PNG. Everything is torn down on close so a second
  // open never inherits the first pad&#39;s pointer listeners.
  var PAD_FONTS = [
    { f: '"Brush Script MT","Segoe Script","Bradley Hand",cursive', n: 'Script' },
    { f: '"Snell Roundhand","Apple Chancery","Segoe Script",cursive', n: 'Formal' },
    { f: '"Comic Sans MS","Chalkboard SE",cursive', n: 'Casual' }
  ];
  var _padMode = 'draw', _padFont = PAD_FONTS[0].f, _padOnApply = null, _padDrew = false;

  window.novaSigPad = function (opts) {
    opts = opts || {};
    _padMode = 'draw'; _padFont = PAD_FONTS[0].f; _padOnApply = opts.onApply || null; _padDrew = false;
    var fontBtns = PAD_FONTS.map(function (ft, i) {
      return '<button class="btn btn-sm ' + (i === 0 ? 'btn-primary' : 'btn-ghost') + '" data-relfont="' + i +
        '" onclick="relPadFont(' + i + ')" style="font-family:' + ft.f + ';font-size:17px">Abc</button>';
    }).join(' ');
    var ov = document.createElement('div');
    ov.id = 'rel-pad-ov';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = '<div style="background:var(--bg-card);border-radius:12px;padding:16px;max-width:480px;width:100%">' +
      '<div style="font-weight:600;margin-bottom:10px">' + esc(opts.title || 'Add your signature') + '</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:12px">' +
        '<button class="btn btn-sm btn-primary" id="rel-pad-tab-draw" onclick="relPadMode(&#39;draw&#39;)">Draw</button>' +
        '<button class="btn btn-sm btn-ghost" id="rel-pad-tab-type" onclick="relPadMode(&#39;type&#39;)">Type</button>' +
      '</div>' +
      '<div id="rel-pad-draw">' +
        '<canvas id="rel-pad-canvas" width="440" height="170" style="width:100%;height:170px;background:#fff;border:1px solid var(--border);border-radius:8px;touch-action:none;cursor:crosshair"></canvas>' +
      '</div>' +
      '<div id="rel-pad-type" style="display:none">' +
        '<input id="rel-pad-text" style="' + INP + ';margin-bottom:10px" placeholder="Type your name" oninput="relPadPreview()">' +
        '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">' + fontBtns + '</div>' +
        '<div id="rel-pad-preview" style="height:86px;display:flex;align-items:center;justify-content:center;background:#fff;border:1px solid var(--border);border-radius:8px;color:#111;font-size:42px;overflow:hidden;white-space:nowrap"></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
        '<button class="btn btn-ghost btn-sm" onclick="relPadClear()">Clear</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="relPadClose()">Cancel</button>' +
        '<button class="btn btn-primary btn-sm" onclick="relPadApply()">Apply</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    padInit();
    var ti = el('rel-pad-text');
    if (ti && opts.defaultName) { ti.value = opts.defaultName; }
  };

  function padInit() {
    var c = el('rel-pad-canvas');
    if (!c) return;
    // A browser with canvas turned off (or a hardened kiosk profile) hands back
    // null here. Bail out rather than throwing: the Type tab still works, so the
    // customer can still sign.
    var ctx = c.getContext ? c.getContext('2d') : null;
    if (!ctx) { window.relPadMode('type'); return; }
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    var drawing = false;
    function pos(e) {
      var r = c.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
    }
    c.addEventListener('pointerdown', function (e) {
      drawing = true; _padDrew = true; c.setPointerCapture(e.pointerId);
      var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault();
    });
    c.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault();
    });
    c.addEventListener('pointerup', function () { drawing = false; });
    c.addEventListener('pointerleave', function () { drawing = false; });
  }

  window.relPadMode = function (mode) {
    _padMode = mode;
    var dr = el('rel-pad-draw'), ty = el('rel-pad-type');
    if (dr) dr.style.display = (mode === 'draw') ? '' : 'none';
    if (ty) ty.style.display = (mode === 'type') ? '' : 'none';
    var td = el('rel-pad-tab-draw'), tt = el('rel-pad-tab-type');
    if (td) td.className = 'btn btn-sm ' + (mode === 'draw' ? 'btn-primary' : 'btn-ghost');
    if (tt) tt.className = 'btn btn-sm ' + (mode === 'type' ? 'btn-primary' : 'btn-ghost');
    if (mode === 'type') window.relPadPreview();
  };
  window.relPadFont = function (i) {
    _padFont = PAD_FONTS[i] ? PAD_FONTS[i].f : PAD_FONTS[0].f;
    var btns = document.querySelectorAll('[data-relfont]');
    for (var k = 0; k < btns.length; k++) {
      btns[k].className = 'btn btn-sm ' + (parseInt(btns[k].getAttribute('data-relfont'), 10) === i ? 'btn-primary' : 'btn-ghost');
    }
    window.relPadPreview();
  };
  window.relPadPreview = function () {
    var pv = el('rel-pad-preview'), ti = el('rel-pad-text');
    if (!pv) return;
    pv.style.fontFamily = _padFont;
    pv.textContent = (ti && ti.value) ? ti.value : '';
  };
  window.relPadClear = function () {
    var c = el('rel-pad-canvas');
    if (c && c.getContext) {
      var x = c.getContext('2d');
      if (x) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
      _padDrew = false;
    }
    var ti = el('rel-pad-text');
    if (ti) { ti.value = ''; window.relPadPreview(); }
  };
  window.relPadClose = function () { var ov = el('rel-pad-ov'); if (ov) ov.remove(); _padOnApply = null; };
  window.relPadApply = function () {
    var data = null;
    if (_padMode === 'draw') {
      if (!_padDrew) { toast('Draw your signature first, or switch to Type.', 'error'); return; }
      var c = el('rel-pad-canvas');
      data = (c && c.toDataURL) ? c.toDataURL('image/png') : null;
      if (!data) { toast('This browser could not save the drawing. Use Type instead.', 'error'); return; }
    } else {
      var ti = el('rel-pad-text');
      var text = ti ? String(ti.value || '').trim() : '';
      if (!text) { toast('Type your name first.', 'error'); return; }
      var off = document.createElement('canvas');
      off.width = 600; off.height = 200;
      var x = off.getContext ? off.getContext('2d') : null;
      if (!x || !off.toDataURL) { toast('This browser could not save the signature.', 'error'); return; }
      x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 200);
      x.fillStyle = '#111'; x.textAlign = 'center'; x.textBaseline = 'middle';
      var size = 80;
      do { x.font = size + 'px ' + _padFont; size -= 4; } while (size > 20 && x.measureText(text).width > 560);
      x.fillText(text, 300, 105);
      data = off.toDataURL('image/png');
    }
    var cb = _padOnApply;
    window.relPadClose();
    if (cb && data) cb(data);
  };

  // ------------------------------------------------------------- list screen

  window.renderReleases = async function (host) {
    injectCss();
    if (!canView()) { host.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
    host.innerHTML = '<div class="loading">Loading...</div>';
    var data;
    try { data = await api('GET', API + (_listFilter ? ('?status=' + _listFilter) : '')); }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message) + '</div>'; return; }

    var chips = ['', 'draft', 'sent', 'customer_signed', 'completed', 'declined'].map(function (s) {
      var lbl = s === '' ? 'All' : (STATUS_LABEL[s] || s);
      return '<button class="btn btn-sm ' + (_listFilter === s ? 'btn-primary' : 'btn-ghost') +
        '" onclick="relSetFilter(&#39;' + s + '&#39;)">' + esc(lbl) + '</button>';
    }).join(' ');

    var rows = (data.releases || []).map(function (r) {
      return '<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border)">' +
        '<div style="flex:1;min-width:0;cursor:pointer" onclick="navigate(&#39;release&#39;,' + r.id + ')">' +
          '<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.claimant_name || '(no name yet)') + '</div>' +
          '<div style="font-size:12px;color:var(--text-muted-color)">' + esc(r.release_number) + ' &middot; ' + usd(r.settlement_amount) +
          (r.rep_name ? (' &middot; countersigned by ' + esc(r.rep_name)) : '') + '</div>' +
        '</div>' +
        '<div>' + statusPill(r.status) + '</div>' +
        '<button class="btn btn-ghost btn-sm" onclick="navigate(&#39;release&#39;,' + r.id + ')">Open</button>' +
      '</div>';
    }).join('');

    if (!rows) rows = '<div style="padding:44px;text-align:center;color:var(--text-muted-color)">No releases yet.</div>';

    var warn = data.storageReady ? '' :
      '<div class="alert alert-error" style="margin-bottom:12px">File storage isn&#39;t configured yet (R2_* env vars), so signatures can&#39;t be saved. Releases can be drafted but not sent.</div>';

    host.innerHTML =
      '<div class="page-title">Releases of Liability</div>' +
      '<div class="page-subtitle">Receipt of payment and release. Build it from a complaint, send it by text or email, countersign, done.</div>' +
      warn +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin:14px 0;flex-wrap:wrap">' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' + chips + '</div>' +
        (canManage() ? '<button class="btn btn-primary btn-sm" onclick="relCreate(null)">New release</button>' : '') +
      '</div>' +
      '<div class="card"><div class="card-body" style="padding:0">' + rows + '</div></div>';
  };

  window.relSetFilter = function (s) { _listFilter = s; window.renderReleases(el('content')); };

  // Create a draft, optionally seeded from a complaint, then open the builder.
  window.relCreate = async function (feedbackId) {
    try {
      var r = await api('POST', API, feedbackId ? { feedback_id: feedbackId } : {});
      toast('Release ' + r.release_number + ' started');
      navigate('release', r.id);
    } catch (e) { toast(e.message, 'error'); }
  };

  // ---------------------------------------------------------- one release

  window.renderReleaseForm = async function (host, id) {
    injectCss();
    if (!canView()) { host.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
    host.innerHTML = '<div class="loading">Loading...</div>';
    var data;
    try { data = await api('GET', API + '/' + id); }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message) + '</div>'; return; }
    S = data;
    var r = data.release;
    var isDraft = (r.status === 'draft');
    var edit = isDraft && canManage();

    var back = '<div style="margin-bottom:12px"><button class="btn btn-secondary btn-sm" onclick="' +
      (r.feedback_id ? ('navigate(&#39;feedback-detail&#39;,' + r.feedback_id + ')') : 'navigate(&#39;releases&#39;)') +
      '">&larr; Back</button></div>';

    var head = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px">' +
      '<div class="page-title" style="margin:0">Release of Liability</div>' + statusPill(r.status) + '</div>' +
      '<div class="page-subtitle">' + esc(r.release_number) +
      (r.feedback_id ? (' &middot; from complaint #' + r.feedback_id) : '') +
      (isDraft ? ' &middot; fields with an orange edge came from the complaint' : '') + '</div>';

    host.innerHTML = back + head +
      (edit ? builderHtml(r) : summaryHtml(r, data)) +
      countersignHtml(r, data) +
      auditHtml(data.events || []);

    if (edit) relRepList();
  };

  function fld(id, label, value, extra, pre) {
    return '<div><label style="' + LBL + '">' + esc(label) + '</label>' +
      '<input id="' + id + '" class="' + (pre ? 'rel-pre' : '') + '" style="' + INP + '" value="' + esc(value == null ? '' : value) + '"' + (extra || '') + '></div>';
  }

  function builderHtml(r) {
    var missing = (S.missing || []);
    var miss = missing.length
      ? '<div style="' + CARD + ';border-color:rgba(245,158,11,.45)"><div style="font-size:12px;color:var(--text-muted-color);margin-bottom:6px">Still needed before this can be sent</div>' +
        '<div style="font-size:13px">' + esc(missing.join(', ')) + '</div></div>'
      : '';

    return miss +
      '<div style="' + CARD + '">' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:12px">Claimant</div>' +
        '<div class="rel-grid rel-2">' +
          fld('rel-name', 'Printed name *', r.claimant_name, '', !!r.claimant_name) +
          fld('rel-phone', 'Phone number', r.claimant_phone, '', !!r.claimant_phone) +
        '</div>' +
        '<div style="margin-top:12px">' + fld('rel-addr', 'Mailing address *', r.claimant_address, ' placeholder="Street address"') + '</div>' +
        '<div class="rel-grid rel-3" style="margin-top:12px">' +
          fld('rel-city', 'City *', r.claimant_city, '', !!r.claimant_city) +
          fld('rel-state', 'State *', r.claimant_state, ' maxlength="10"') +
          fld('rel-zip', 'ZIP *', r.claimant_zip, ' maxlength="20"') +
        '</div>' +
        '<div style="margin-top:12px">' + fld('rel-email', 'Email &mdash; where the signing link goes', r.claimant_email, '', !!r.claimant_email) + '</div>' +
      '</div>' +

      '<div style="' + CARD + '">' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:12px">Vehicle</div>' +
        '<div class="rel-grid rel-4">' +
          fld('rel-vyear', 'Year', r.vehicle_year, ' maxlength="10"', !!r.vehicle_year) +
          fld('rel-vmake', 'Make', r.vehicle_make, '', !!r.vehicle_make) +
          fld('rel-vmodel', 'Model', r.vehicle_model, '', !!r.vehicle_model) +
          fld('rel-vcolor', 'Color', r.vehicle_color) +
        '</div>' +
        '<div class="rel-grid rel-2" style="margin-top:12px">' +
          fld('rel-plate', 'License plate', r.license_plate) +
          fld('rel-vin', 'VIN (if available)', r.vin) +
        '</div>' +
      '</div>' +

      '<div style="' + CARD + '">' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:12px">Service and settlement</div>' +
        '<div class="rel-grid rel-2">' +
          fld('rel-date', 'Date of service *', ymd(r.service_date), ' type="date"', !!r.service_date) +
          fld('rel-job', 'Job / invoice #', r.job_ref, '', !!r.job_ref) +
        '</div>' +
        '<div style="margin-top:12px"><label style="' + LBL + '">Description of damage *</label>' +
          '<textarea id="rel-dmg" class="' + (r.damage_description ? 'rel-pre' : '') + '" style="' + INP + ';min-height:64px">' + esc(r.damage_description || '') + '</textarea></div>' +
        '<div class="rel-grid rel-2" style="margin-top:12px">' +
          fld('rel-amount', 'Settlement amount paid (USD) *', Number(r.settlement_amount) ? Number(r.settlement_amount).toFixed(2) : '', ' inputmode="decimal"') +
          '<div><label style="' + LBL + '">Countersigned by *</label>' +
            '<select id="rel-rep" style="' + INP + '" onchange="relRepChanged()"><option value="">Loading...</option></select></div>' +
        '</div>' +
        '<div class="rel-grid rel-2" style="margin-top:12px">' +
          fld('rel-reptitle', 'Their title (prints on the form)', r.rep_title) +
        '</div>' +
        '<div style="margin-top:10px;font-size:11px;color:var(--text-muted-color)">Release wording is the company default. ' +
          '<span style="color:var(--primary);cursor:pointer" onclick="relEditBody()">Edit the wording for this release</span></div>' +
        '<textarea id="rel-body" style="display:none">' + esc(r.release_body || '') + '</textarea>' +
      '</div>' +

      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
        '<button class="btn btn-secondary btn-sm" onclick="relSave(' + r.id + ')">Save draft</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="relPreview(' + r.id + ')">Preview PDF</button>' +
        '<button class="btn btn-primary btn-sm" onclick="relSendDialog(' + r.id + ')">Send to customer</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="relInPerson(' + r.id + ')">Sign in person</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="relDelete(' + r.id + ')">Delete draft</button>' +
      '</div>';
  }

  function row(label, value) {
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--border-light)">' +
      '<div style="font-size:12px;color:var(--text-muted-color)">' + esc(label) + '</div>' +
      '<div style="font-size:13px;text-align:right;word-break:break-word">' + (value === '' || value == null ? '&mdash;' : esc(value)) + '</div></div>';
  }

  function summaryHtml(r, data) {
    var veh = [r.vehicle_year, r.vehicle_make, r.vehicle_model, r.vehicle_color].filter(Boolean).join(' ');
    var addr = [r.claimant_address, [r.claimant_city, r.claimant_state].filter(Boolean).join(', '), r.claimant_zip].filter(Boolean).join('  ');
    var actions = '';
    if (canManage()) {
      if (r.status === 'sent') {
        actions = '<button class="btn btn-secondary btn-sm" onclick="relRemind(' + r.id + ')">Resend the link</button> ' +
                  '<button class="btn btn-secondary btn-sm" onclick="relInPerson(' + r.id + ')">Sign in person</button> ' +
                  '<button class="btn btn-ghost btn-sm" onclick="relVoid(' + r.id + ')">Void</button>';
      } else if (r.status !== 'completed') {
        actions = '<button class="btn btn-ghost btn-sm" onclick="relVoid(' + r.id + ')">Void</button>';
      }
    }
    var dl = '<button class="btn btn-secondary btn-sm" onclick="relPreview(' + r.id + ')">' +
      (r.signed_r2_key ? 'Open the signed PDF' : 'Preview PDF') + '</button>';

    return '<div style="' + CARD + '">' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:8px">The release</div>' +
      row('Claimant', r.claimant_name) +
      row('Phone', r.claimant_phone) +
      row('Email', r.claimant_email) +
      row('Mailing address', addr) +
      row('Vehicle', veh) +
      row('Plate / VIN', [r.license_plate, r.vin].filter(Boolean).join('  /  ')) +
      row('Date of service', mdy(r.service_date)) +
      row('Job / invoice #', r.job_ref) +
      row('Damage', r.damage_description) +
      row('Settlement amount', usd(r.settlement_amount)) +
      row('Countersigned by', [r.rep_name, r.rep_title].filter(Boolean).join(', ')) +
      (r.declined_reason ? row('Reason for declining', r.declined_reason) : '') +
      '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' + dl + ' ' + actions + '</div>' +
    '</div>';
  }

  function countersignHtml(r, data) {
    if (r.status === 'customer_signed' && data.canCountersign) {
      return '<div style="' + CARD + ';border-color:rgba(249,115,22,.55)">' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:12px">Your signature</div>' +
        '<div class="rel-grid rel-2" style="margin-bottom:12px">' +
          row('Printed name', r.rep_name) + row('Title', r.rep_title) +
        '</div>' +
        '<div id="rel-rep-sig" style="background:#fff;border-radius:8px;height:86px;display:flex;align-items:center;justify-content:center;color:#999;font-size:12px;cursor:pointer" ' +
          'onclick="relRepSignPad()">Tap to sign</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
          '<button class="btn btn-primary btn-sm" onclick="relCountersign(' + r.id + ')">Countersign and complete</button>' +
        '</div></div>';
    }
    if (r.status === 'customer_signed') {
      return '<div style="' + CARD + '"><div style="font-size:13px;color:var(--text-muted-color)">' +
        esc(r.claimant_name || 'The claimant') + ' has signed. Waiting on ' + esc(r.rep_name || 'the named representative') +
        ' to countersign.</div></div>';
    }
    return '';
  }

  function auditHtml(events) {
    if (!events.length) return '';
    var LABEL = {
      created: 'Release created', sent: 'Sent to the claimant', viewed: 'Opened by the claimant',
      consented: 'Electronic signature consent accepted', signed: 'Signed by the claimant',
      countersigned: 'Countersigned', declined: 'Declined by the claimant', reminder_sent: 'Reminder sent',
      voided: 'Voided', expired: 'Expired', completed: 'Completed and filed'
    };
    var items = events.slice().reverse().map(function (e) {
      var meta = whenText(e.created_at);
      if (e.actor) meta += ' &middot; ' + esc(e.actor);
      if (e.ip) meta += ' &middot; IP ' + esc(e.ip);
      return '<div style="padding:6px 0 6px 15px;position:relative;font-size:12.5px">' +
        '<span style="position:absolute;left:0;top:12px;width:6px;height:6px;border-radius:50%;background:var(--primary)"></span>' +
        esc(LABEL[e.event_type] || e.event_type) +
        '<div style="font-size:11px;color:var(--text-muted-color)">' + meta + '</div></div>';
    }).join('');
    return '<div style="' + CARD + '">' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:6px">Audit trail</div>' + items +
      '<div style="font-size:11px;color:var(--text-muted-color);margin-top:8px">This list is printed as the certificate page on the signed PDF.</div></div>';
  }

  // ------------------------------------------------------------- builder actions

  async function relRepList() {
    var sel = el('rel-rep');
    if (!sel) return;
    try {
      var d = await api('GET', API + '/reps');
      var cur = S.release.rep_user_id ? String(S.release.rep_user_id) : '';
      sel.innerHTML = '<option value="">Choose a representative...</option>' +
        (d.reps || []).map(function (u) {
          return '<option value="' + u.id + '" data-title="' + esc(u.title || '') + '"' + (String(u.id) === cur ? ' selected' : '') + '>' +
            esc(u.name) + (u.title ? (' &mdash; ' + esc(u.title)) : '') + '</option>';
        }).join('');
    } catch (e) { sel.innerHTML = '<option value="">Could not load representatives</option>'; }
  }

  // Picking a rep fills their stored title, but never overwrites a title
  // somebody has already typed for this release.
  window.relRepChanged = function () {
    var sel = el('rel-rep'), t = el('rel-reptitle');
    if (!sel || !t || t.value.trim()) return;
    var opt = sel.options[sel.selectedIndex];
    if (opt) t.value = opt.getAttribute('data-title') || '';
  };

  window.relEditBody = function () {
    var ta = el('rel-body');
    if (!ta) return;
    if (ta.style.display === 'none') {
      ta.style.display = '';
      ta.style.cssText = INP + ';min-height:150px;margin-top:10px;font-size:12px';
      if (!ta.value.trim()) ta.value = '';
      ta.focus();
    } else { ta.style.display = 'none'; }
  };

  function collect() {
    var body = el('rel-body');
    var out = {
      claimant_name: val('rel-name'), claimant_phone: val('rel-phone'), claimant_email: val('rel-email'),
      claimant_address: val('rel-addr'), claimant_city: val('rel-city'),
      claimant_state: val('rel-state'), claimant_zip: val('rel-zip'),
      vehicle_year: val('rel-vyear'), vehicle_make: val('rel-vmake'), vehicle_model: val('rel-vmodel'),
      vehicle_color: val('rel-vcolor'), license_plate: val('rel-plate'), vin: val('rel-vin'),
      service_date: val('rel-date') || null, job_ref: val('rel-job'),
      damage_description: val('rel-dmg'),
      settlement_amount: Number(String(val('rel-amount')).replace(/[^0-9.\-]/g, '')) || 0,
      rep_user_id: val('rel-rep') || null, rep_title: val('rel-reptitle')
    };
    if (body && body.style.display !== 'none' && body.value.trim()) out.release_body = body.value;
    return out;
  }

  async function saveQuiet(id) {
    var d = await api('PUT', API + '/' + id, collect());
    return d;
  }

  window.relSave = async function (id) {
    try {
      var d = await saveQuiet(id);
      toast(d.missing && d.missing.length ? ('Saved. Still needed: ' + d.missing.join(', ')) : 'Saved', d.missing && d.missing.length ? 'info' : 'success');
      navigate('release', id);
    } catch (e) { toast(e.message, 'error'); }
  };

  window.relDelete = async function (id) {
    var ok = await novaConfirm('Delete this draft release? This cannot be undone.');
    if (!ok) return;
    try {
      await api('DELETE', API + '/' + id);
      toast('Draft deleted');
      navigate('releases');
    } catch (e) { toast(e.message, 'error'); }
  };

  // Save first, then render: previewing a form that does not match what is on
  // screen is worse than not previewing at all.
  window.relPreview = async function (id) {
    try {
      if (el('rel-name')) { try { await saveQuiet(id); } catch (e) {} }
      var d = await api('GET', API + '/' + id + '/download');
      if (d.url) { window.open(d.url, '_blank'); return; }
      if (d.preview) {
        var bin = atob(d.preview);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
        window.open(url, '_blank');
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      }
    } catch (e) { toast(e.message, 'error'); }
  };

  window.relVoid = async function (id) {
    var ok = await novaConfirm('Void this release? The signing link stops working immediately.');
    if (!ok) return;
    try { await api('POST', API + '/' + id + '/void', {}); toast('Voided'); navigate('release', id); }
    catch (e) { toast(e.message, 'error'); }
  };

  window.relRemind = async function (id) {
    try { await api('POST', API + '/' + id + '/remind', { channel: 'both' }); toast('Reminder sent'); navigate('release', id); }
    catch (e) { toast(e.message, 'error'); }
  };

  // ------------------------------------------------------------- send dialog

  window.relSendDialog = async function (id) {
    try { if (el('rel-name')) await saveQuiet(id); } catch (e) { toast(e.message, 'error'); return; }
    var d;
    try { d = await api('GET', API + '/' + id); } catch (e) { toast(e.message, 'error'); return; }
    var r = d.release;
    if (d.missing && d.missing.length) {
      novaAlert('Fill these in before sending: ' + d.missing.join(', ') + '.');
      return;
    }
    var reps = [];
    try { reps = (await api('GET', API + '/reps')).reps || []; } catch (e) {}
    var me = (typeof state !== 'undefined' && state.user) ? state.user.id : null;
    var senderOpts = reps.map(function (u) {
      return '<option value="' + u.id + '"' + (String(u.id) === String(me) ? ' selected' : '') + '>' +
        esc(u.name) + (u.email ? (' &mdash; ' + esc(u.email)) : '') + '</option>';
    }).join('');

    var ov = document.createElement('div');
    ov.id = 'rel-send-ov';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = '<div style="background:var(--bg-card);border-radius:12px;padding:18px;max-width:460px;width:100%;max-height:88vh;overflow:auto">' +
      '<div style="font-weight:600;font-size:16px;margin-bottom:14px">Send release to ' + esc(r.claimant_name || 'the customer') + '</div>' +
      '<label style="' + LBL + '">How should it go out?</label>' +
      '<div id="rel-chan" style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">' +
        chanBtn('sms', 'Text', !!r.claimant_phone, !r.claimant_email) +
        chanBtn('email', 'Email', !!r.claimant_email, !!r.claimant_email) +
        chanBtn('both', 'Both', !!(r.claimant_phone && r.claimant_email), false) +
        chanBtn('link', 'Copy link only', true, false) +
      '</div>' +
      '<div id="rel-dest" style="font-size:11.5px;color:var(--text-muted-color);margin-bottom:12px"></div>' +
      '<label style="' + LBL + '">From</label>' +
      '<select id="rel-from" style="' + INP + '">' + senderOpts + '</select>' +
      '<div style="font-size:11px;color:var(--text-muted-color);margin:5px 0 12px">Replies come back to this person, not to no-reply.</div>' +
      '<label style="' + LBL + '">Message (optional)</label>' +
      '<textarea id="rel-msg" style="' + INP + ';min-height:64px" placeholder="Anything you want to say alongside the link."></textarea>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap">' +
        '<label style="font-size:11.5px;color:var(--text-muted-color)">Link expires in ' +
          '<input id="rel-exp" type="number" min="1" max="90" value="14" style="width:52px;padding:3px 6px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:4px;color:var(--text)"> days</label>' +
        '<div><button class="btn btn-ghost btn-sm" onclick="relSendClose()">Cancel</button> ' +
        '<button class="btn btn-primary btn-sm" onclick="relSendGo(' + id + ')">Send</button></div>' +
      '</div></div>';
    document.body.appendChild(ov);
    var pref = r.claimant_phone ? 'sms' : (r.claimant_email ? 'email' : 'link');
    window.relChan(pref);
  };

  function chanBtn(v, label, enabled, selected) {
    return '<button class="btn btn-sm ' + (selected ? 'btn-primary' : 'btn-ghost') + '" data-relchan="' + v + '"' +
      (enabled ? '' : ' disabled title="No contact detail on file for this"') +
      ' onclick="relChan(&#39;' + v + '&#39;)">' + esc(label) + '</button>';
  }

  var _chan = 'email';
  window.relChan = function (v) {
    _chan = v;
    var btns = document.querySelectorAll('[data-relchan]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = 'btn btn-sm ' + (btns[i].getAttribute('data-relchan') === v ? 'btn-primary' : 'btn-ghost');
    }
    var r = S.release || {};
    var dest = el('rel-dest');
    if (!dest) return;
    if (v === 'sms') dest.innerHTML = 'Texting <b>' + esc(r.claimant_phone || 'no number on file') + '</b>';
    else if (v === 'email') dest.innerHTML = 'Emailing <b>' + esc(r.claimant_email || 'no address on file') + '</b>';
    else if (v === 'both') dest.innerHTML = 'Texting <b>' + esc(r.claimant_phone || '&mdash;') + '</b> and emailing <b>' + esc(r.claimant_email || '&mdash;') + '</b>';
    else dest.innerHTML = 'Nothing is sent. You get the link to paste into your own message.';
  };

  window.relSendClose = function () { var ov = el('rel-send-ov'); if (ov) ov.remove(); };

  window.relSendGo = async function (id) {
    var body = {
      channel: _chan,
      from_user_id: val('rel-from') || null,
      message: val('rel-msg'),
      expiry_days: parseInt(val('rel-exp'), 10) || 14
    };
    try {
      var d = await api('POST', API + '/' + id + '/send', body);
      window.relSendClose();
      if (_chan === 'link') {
        await relCopy(d.link);
        novaAlert('The link is on your clipboard and the release is marked as sent:\n\n' + d.link);
      } else {
        toast('Release sent');
      }
      navigate('release', id);
    } catch (e) { toast(e.message, 'error'); }
  };

  async function relCopy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) {}
      ta.remove();
    }
  }

  // ------------------------------------------------------- signing (staff side)

  var _repSigData = null;
  window.relRepSignPad = function () {
    var r = (S && S.release) || {};
    window.novaSigPad({
      title: 'Add your signature',
      defaultName: r.rep_name || '',
      onApply: function (dataUrl) {
        _repSigData = dataUrl;
        var box = el('rel-rep-sig');
        if (box) box.innerHTML = '<img src="' + dataUrl + '" style="max-height:72px" alt="Signature">';
      }
    });
  };

  window.relCountersign = async function (id) {
    if (!_repSigData) { toast('Add your signature first.', 'error'); return; }
    try {
      await api('POST', API + '/' + id + '/rep-sign', { image: _repSigData });
      _repSigData = null;
      toast('Release completed. The PDF is filed and on its way to both parties.');
      navigate('release', id);
    } catch (e) { toast(e.message, 'error'); }
  };

  // The customer signs on a Nova user&#39;s device, standing at the vehicle.
  window.relInPerson = async function (id) {
    try { if (el('rel-name')) await saveQuiet(id); } catch (e) { toast(e.message, 'error'); return; }
    var d;
    try { d = await api('GET', API + '/' + id); } catch (e) { toast(e.message, 'error'); return; }
    if (d.missing && d.missing.length) { novaAlert('Fill these in first: ' + d.missing.join(', ') + '.'); return; }
    var r = d.release;
    var name = await novaPrompt('Type the claimant&#39;s printed name exactly as they give it:', r.claimant_name || '');
    if (name === null || !String(name).trim()) return;
    window.novaSigPad({
      title: 'Claimant signature',
      defaultName: String(name).trim(),
      onApply: async function (dataUrl) {
        try {
          await api('POST', API + '/' + id + '/in-person', { image: dataUrl, printed_name: String(name).trim() });
          toast('Signature recorded. ' + (r.rep_name || 'The representative') + ' has been asked to countersign.');
          navigate('release', id);
        } catch (e) { toast(e.message, 'error'); }
      }
    });
  };

  // ------------------------------------------------------- the complaint card

  // Wraps renderFeedbackDetail rather than editing it, the way
  // employeeRecords.js wraps renderEmployeeFiles: the complaint page renders
  // exactly as it does today, then the card is slotted in above Call recordings.
  var origFeedbackDetail = window.renderFeedbackDetail;
  if (typeof origFeedbackDetail === 'function') {
    window.renderFeedbackDetail = async function (host, id) {
      await origFeedbackDetail(host, id);
      if (!canView()) return;
      injectCss();
      try {
        var d = await api('GET', '/feedback/' + id);
        var card = document.createElement('div');
        card.id = 'rel-fb-card';
        card.style.cssText = CARD + (((d.releases || []).length) ? '' : ';border-color:rgba(249,115,22,.5)');
        card.innerHTML = feedbackCardHtml(d.releases || [], id, d.feedback);
        // Anchor on the recordings card, which is the one element on that page
        // with a stable id. Falls back to appending if the layout ever moves.
        var rec = el('fb-recordings');
        var anchor = rec ? rec.parentNode : null;
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor);
        else host.appendChild(card);
      } catch (e) { /* the complaint page must still work if this fails */ }
    };
  }

  function feedbackCardHtml(releases, feedbackId, fb) {
    var head = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px">' +
      '<div style="font-size:12px;color:var(--text-muted-color)">Release of liability</div>' +
      (releases.length ? statusPill(releases[0].status) : '<span style="font-size:11px;color:var(--text-muted-color)">None yet</span>') +
      '</div>';
    if (!releases.length) {
      return head +
        '<div style="font-size:13px;color:var(--text-muted-color);line-height:1.55;margin-bottom:11px">' +
        'Build a receipt of payment and release from this complaint. Claimant, vehicle and job details are carried over &mdash; you add the settlement amount.</div>' +
        (canManage()
          ? '<button class="btn btn-primary btn-sm" onclick="relCreate(' + feedbackId + ')">Create release of liability</button>'
          : '<div style="font-size:12px;color:var(--text-muted-color)">You can see releases but not create them.</div>');
    }
    var rows = releases.map(function (r) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light)">' +
        '<div style="min-width:0"><div style="font-size:13px;font-weight:500">' + esc(r.release_number) + ' &mdash; ' + usd(r.settlement_amount) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted-color)">' +
          (r.status === 'completed'
            ? ('Signed by ' + esc(r.claimant_name || 'the customer') + (r.rep_name ? (' and ' + esc(r.rep_name)) : '') + ' &middot; ' + whenText(r.completed_at))
            : (STATUS_LABEL[r.status] || r.status) + (r.sent_at ? (' &middot; sent ' + whenText(r.sent_at)) : '')) +
        '</div></div>' +
        '<button class="btn btn-secondary btn-sm" onclick="navigate(&#39;release&#39;,' + r.id + ')">Open</button>' +
      '</div>';
    }).join('');
    var more = canManage()
      ? '<div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="relCreate(' + feedbackId + ')">Start another release</button></div>'
      : '';
    return head + rows + more;
  }

  // ------------------------------------------------- the Templates dialog entry

  // Tony went looking for this under Signatures &rarr; Templates, so that is where
  // it lives. Nova&#39;s own built-in forms list above the uploaded PDF templates;
  // choosing one opens its builder instead of cloning a PDF layout.
  var origShowTemplates = window.sigShowTemplates;
  if (typeof origShowTemplates === 'function') {
    window.sigShowTemplates = async function () {
      await origShowTemplates.apply(this, arguments);
      if (!canManage()) return;
      var ov = el('sig-tmpl-ov');
      if (!ov) return;
      var panel = ov.firstChild;
      if (!panel) return;
      var block = document.createElement('div');
      block.style.cssText = 'margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)';
      block.innerHTML =
        '<div style="font-size:11px;color:var(--text-muted-color);letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px">Nova built-in forms</div>' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div style="flex:1;min-width:0"><div style="font-weight:600">Release of Liability</div>' +
          '<div style="font-size:12px;color:var(--text-muted-color)">Receipt of payment and release. Fills itself in from a complaint.</div></div>' +
          '<button class="btn btn-primary btn-sm" onclick="relFromTemplates()">Use</button>' +
        '</div>';
      // After the modal header, before the uploaded templates.
      var header = panel.firstChild;
      if (header && header.nextSibling) panel.insertBefore(block, header.nextSibling);
      else panel.appendChild(block);
    };
  }

  window.relFromTemplates = function () {
    if (typeof sigTmplClose === 'function') sigTmplClose();
    window.relCreate(null);
  };

  // --------------------------------------------------- the public signing page
  // No login and no JWT: the whole session is the token in the URL, so this uses
  // raw fetch rather than api(), which would attach the staff token.

  window.relGetUrlToken = function () {
    var m = (location.pathname || '').match(/^\/release\/([A-Za-z0-9]+)/);
    if (m) return m[1];
    return new URLSearchParams(location.search).get('release_token') || null;
  };

  var _pubToken = null, _pubRel = null, _pubSig = null;

  async function pubFetch(path, method, body) {
    var opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    var res = await fetch('/api/release/' + path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data || {};
  }

  window.renderReleasePage = async function (host, token) {
    injectCss();
    host.className = 'no-sidebar';
    _pubToken = token; _pubSig = null;
    host.innerHTML = '<div style="padding:60px;text-align:center;color:var(--text-muted-color)">Loading your document...</div>';
    var d;
    try { d = await pubFetch(token); }
    catch (e) { host.innerHTML = pubMessage(e.message); return; }
    _pubRel = d.release;
    host.innerHTML = pubShell(d.release);
  };

  function pubMessage(msg) {
    return '<div style="max-width:520px;margin:60px auto;padding:0 16px">' +
      '<div style="' + CARD + ';text-align:center">' +
      '<div style="font-size:15px;font-weight:600;margin-bottom:8px">This link can&#39;t be used</div>' +
      '<div style="font-size:13px;color:var(--text-muted-color);line-height:1.6">' + esc(msg) + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:14px">If you think this is a mistake, reply to the message that sent you here and we&#39;ll send a fresh link.</div>' +
      '</div></div>';
  }

  function dv(label, value, w) {
    return '<div style="' + (w ? ('flex:' + w + ';min-width:0') : 'flex:1;min-width:0') + '">' +
      '<div class="rd-l">' + esc(label) + '</div><div class="rd-v">' + (value ? esc(value) : '&nbsp;') + '</div></div>';
  }
  function dvRow(cells) { return '<div style="display:flex;gap:8px;margin-bottom:7px">' + cells + '</div>'; }

  function pubShell(r) {
    var doc =
      '<div class="rel-doc">' +
        '<div class="rd-hdr"><div class="l"><small>COMPANY FORM</small><h2>Release of Liability</h2></div>' +
        '<div class="r">Pop-A-Lock</div></div>' +
        '<div class="rd-meta">Document: <b>Receipt of Payment &amp; Release</b> &nbsp; &middot; &nbsp; Company: <b>' + esc(r.company) + '</b></div>' +
        '<div class="rd-body">' +
          '<div class="rd-sh">CLAIM DETAILS</div>' +
          '<div class="rd-grp">Claimant</div>' +
          dvRow(dv('Printed name', r.claimant_name) + dv('Phone number', r.claimant_phone)) +
          dvRow(dv('Mailing address', r.claimant_address)) +
          dvRow(dv('City', r.claimant_city, 2) + dv('State', r.claimant_state, 1) + dv('Zip code', r.claimant_zip, 1)) +
          '<div class="rd-grp">Vehicle</div>' +
          dvRow(dv('Year', r.vehicle_year) + dv('Make', r.vehicle_make) + dv('Model', r.vehicle_model) + dv('Color', r.vehicle_color)) +
          dvRow(dv('License plate', r.license_plate) + dv('VIN (if available)', r.vin)) +
          '<div class="rd-grp">Service</div>' +
          dvRow(dv('Date of service', mdy(r.service_date)) + dv('Job / invoice #', r.job_ref)) +
          dvRow(dv('Description of damage', r.damage_description)) +
          '<div class="rd-sh">RELEASE OF LIABILITY</div>' +
          '<div style="max-width:220px">' + dv('Settlement amount paid (USD)', usd(r.settlement_amount)) + '</div>' +
          '<div class="rd-legal">' + esc(r.release_body) + '</div>' +
          '<div class="rd-sh">ACKNOWLEDGMENT AND SIGNATURES</div>' +
          '<div class="rd-grp">Claimant</div>' +
          '<div class="rd-l">Printed name</div>' +
          '<input id="rel-pub-name" value="' + esc(r.claimant_name || '') + '" placeholder="Type your full name" ' +
            'style="width:100%;box-sizing:border-box;background:#dfe3f7;border:1px solid #c9cfec;border-radius:0;padding:6px;font-size:13px;color:#111">' +
          '<div class="rd-l" style="margin-top:10px">Signature</div>' +
          '<div id="rel-pub-sig" class="rd-sig" onclick="relPubSign()">Tap to sign</div>' +
          '<div class="rd-grp" style="margin-top:14px">' + esc(r.company) + ' Representative</div>' +
          dvRow(dv('Printed name', r.rep_name) + dv('Title', r.rep_title)) +
          '<div style="font-size:10.5px;color:#767676;margin-top:4px">Signed by ' + esc(r.rep_name || 'our representative') + ' after you sign.</div>' +
        '</div>' +
        '<div class="rd-ft">' + esc(r.company) + ' &nbsp;&middot;&nbsp; Receipt of Payment and Release of Liability</div>' +
      '</div>';

    var bar =
      '<div style="' + CARD + ';margin-top:14px">' +
        '<label style="display:flex;gap:9px;align-items:flex-start;cursor:pointer;margin-bottom:12px">' +
          '<input type="checkbox" id="rel-pub-consent" style="width:16px;height:16px;flex:none;margin-top:1px"' + (r.consent_accepted ? ' checked' : '') + '>' +
          '<span style="font-size:12.5px;color:var(--text-dim);line-height:1.5">I agree to sign this document electronically, and that my electronic signature is legally binding.</span>' +
        '</label>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-ghost btn-sm" onclick="relPubDecline()">Decline</button>' +
          '<button class="btn btn-primary" style="flex:1" onclick="relPubSubmit()">Sign and submit</button>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-muted-color);margin-top:10px;text-align:center">' +
          'Reference ' + esc(r.release_number) + '. A signed copy is emailed to you when both parties have signed.</div>' +
      '</div>';

    return '<div style="max-width:640px;margin:0 auto;padding:18px 14px 60px">' + doc + bar + '</div>';
  }

  window.relPubSign = function () {
    var n = el('rel-pub-name');
    window.novaSigPad({
      title: 'Sign here',
      defaultName: n ? n.value : '',
      onApply: function (dataUrl) {
        _pubSig = dataUrl;
        var box = el('rel-pub-sig');
        if (box) box.innerHTML = '<img src="' + dataUrl + '" alt="Your signature">';
      }
    });
  };

  window.relPubSubmit = async function () {
    var consent = el('rel-pub-consent');
    var name = String(val('rel-pub-name') || '').trim();
    if (!consent || !consent.checked) { novaAlert('Please tick the box agreeing to sign electronically.'); return; }
    if (!name) { novaAlert('Please type your printed name.'); return; }
    if (!_pubSig) { novaAlert('Please add your signature.'); return; }
    try {
      await pubFetch(_pubToken + '/consent', 'POST', {});
      await pubFetch(_pubToken + '/submit', 'POST', { image: _pubSig, printed_name: name, consent: true });
      var app = el('app');
      app.innerHTML = '<div style="max-width:520px;margin:60px auto;padding:0 16px">' +
        '<div style="' + CARD + ';text-align:center">' +
        '<div style="font-size:17px;font-weight:600;margin-bottom:10px">Thank you, ' + esc(name.split(' ')[0]) + '.</div>' +
        '<div style="font-size:13px;color:var(--text-dim);line-height:1.65">Your signature has been recorded. ' +
        esc((_pubRel && _pubRel.rep_name) || 'Our representative') + ' will countersign, and a signed copy of the release will be emailed to you.</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-top:14px">Reference ' + esc(_pubRel ? _pubRel.release_number : '') + '</div>' +
        '</div></div>';
    } catch (e) { novaAlert(e.message); }
  };

  window.relPubDecline = async function () {
    var why = await novaPrompt('If you would rather not sign, tell us why and we will follow up:', '');
    if (why === null) return;
    try {
      await pubFetch(_pubToken + '/decline', 'POST', { reason: String(why || '') });
      el('app').innerHTML = '<div style="max-width:520px;margin:60px auto;padding:0 16px">' +
        '<div style="' + CARD + ';text-align:center">' +
        '<div style="font-size:16px;font-weight:600;margin-bottom:8px">Thanks for letting us know.</div>' +
        '<div style="font-size:13px;color:var(--text-dim);line-height:1.6">We have passed this back to the person handling your claim and somebody will be in touch.</div>' +
        '</div></div>';
    } catch (e) { novaAlert(e.message); }
  };

})();
