// Company memos - People > Memos (routes/memos.js).
//
// Five screens and three hooks:
//   renderMemos        the list, with the page totals (manage_memos)
//   renderMemoEdit     New Memo / edit a draft: the memo, who gets it, what they
//                      have to do. Autosaves (CLAUDE.md 9): the server draft is
//                      saved as you type, and an IndexedDB copy covers the gap
//                      if that save fails or the tab dies first.
//   renderMemoTracker  one memo: who viewed, who signed, who has not
//   renderMyMemo       a recipient reading and signing one memo, in the shell
//   memoGate           the full-screen lock. app.js render() asks it first
//                      thing after the onboarding gate; app.js _apiFetch hands
//                      it any 403 { memo_lock } via memoHandleLock.
//   + wraps renderHomeScreen (banner), renderMyFile (My File) and onbOpenFile
//     (the Memos card inside someone's Employee File).
//
// Load order: AFTER app.js, onboarding.js and employeeRecords.js, because it
// wraps what those define. Classic script, every handler global (mm*).
// Uses bare the bare name state, never window.state (nova-window-state-gotcha).
// No backticks anywhere in this file (Windows corrupts them in .js).
(function () {
  'use strict';

  var API = '/memos';
  var MM = { meta: null, editId: null, form: null, preview: null, saveTimer: null, previewTimer: null, saving: false,
    lastSavedAt: null, tracker: null, tab: 'all', q: '', city: '', role: '', listTab: 'sent', pad: null, reader: null };

  function esc(s) { return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s); }
  function el(id) { return document.getElementById(id); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'info'); }
  function content() { return el('content'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function fmtDate(d) { return d ? ((typeof formatDate === 'function') ? formatDate(d) : String(d).slice(0, 10)) : ''; }
  function fmtWhen(d) {
    if (!d) return '';
    var t = new Date(d);
    return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function isAdminLike() { return !!(state.user && (state.user.role === 'admin' || state.user.role === 'owner' || state.user.isOwner)); }
  function canManage() { return (typeof can === 'function') ? can('manage_memos') : isAdminLike(); }

  var ICON = {
    lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    dl: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>',
    bell: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 21h4"/></svg>',
    plus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    memo: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v13l-4 4H4z"/><path d="M8 9h8M8 13h6"/></svg>'
  };

  // ------------------------------------------------------------------ css
  var _css = false;
  function injectCss() {
    if (_css) return; _css = true;
    var s = document.createElement('style');
    s.id = 'mm-css';
    s.textContent = [
      '.mm-two{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;align-items:start}',
      '@media(max-width:1100px){.mm-two{grid-template-columns:1fr}}',
      '.mm-sticky{position:sticky;top:16px}',
      '.mm-two .card{margin-bottom:16px}',
      '.mm-sub input,.mm-sub select{width:auto!important;max-width:240px}',
      '.mm-filters select{width:auto!important;min-width:150px}',
      '.mm-filters input{width:auto!important}',
      '.mm-seg{display:inline-flex;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:3px;gap:3px;flex-wrap:wrap}',
      '.mm-seg button{background:none;border:none;padding:6px 12px;border-radius:6px;font-size:13px;color:var(--text-muted-color);font-weight:500;cursor:pointer;font-family:inherit}',
      '.mm-seg button.on{background:var(--primary);color:#111;font-weight:600}',
      '.mm-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.mm-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:20px;font-size:12.5px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text-dim);cursor:pointer;font-family:inherit}',
      '.mm-chip.on{border-color:var(--primary);color:var(--primary);background:rgba(249,115,22,.10)}',
      '.mm-chip small{opacity:.7}',
      '.mm-opt{display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--border-light)}',
      '.mm-opt:last-child{border-bottom:none}',
      '.mm-opt b{display:block;font-size:14px;color:var(--text);margin-bottom:3px}',
      '.mm-opt p{font-size:12.5px;color:var(--text-muted-color);line-height:1.5;margin:0}',
      '.mm-sw{width:40px;height:22px;border-radius:22px;background:#3a3a3a;position:relative;flex-shrink:0;margin-top:2px;border:none;cursor:pointer;padding:0}',
      '.mm-sw:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#bbb;transition:left .15s}',
      '.mm-sw.on{background:var(--primary)}.mm-sw.on:after{left:21px;background:#fff}',
      'html[data-theme="light"] .mm-sw{background:#d1d5db}',
      '.mm-sub{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--text-dim)}',
      '.mm-label{font-size:13px;font-weight:500;color:var(--text-dim);margin-bottom:6px;display:block}',
      '.mm-mute{font-size:12.5px;color:var(--text-muted-color)}',
      '.mm-hash{font-family:"Fira Code",monospace;font-size:11.5px;color:var(--text-muted-color);word-break:break-all}',
      '.mm-file{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px dashed var(--border);border-radius:var(--radius);background:var(--bg-elevated)}',
      '.mm-file .ic{width:34px;height:40px;border-radius:4px;background:#3a0e0e;color:#fca5a5;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
      '.mm-file b{display:block;font-size:13.5px;color:var(--text);word-break:break-all}',
      '.mm-file small{font-size:12px;color:var(--text-muted-color)}',
      '.mm-drop{border:1.5px dashed var(--border);border-radius:var(--radius);padding:14px;background:var(--bg-elevated)}',
      '.mm-thumbs{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}',
      '.mm-thumbs canvas{width:118px;height:auto;background:#fff;border-radius:2px;box-shadow:0 2px 6px rgba(0,0,0,.35)}',
      '.mm-sum{font-size:13px;color:var(--text-dim);line-height:1.55}',
      '.mm-sum .row{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light)}',
      '.mm-sum .row:last-child{border-bottom:none}',
      '.mm-sum .k{width:16px;flex-shrink:0;color:var(--primary)}',
      '.mm-sum b{color:var(--text)}',
      '.mm-bar{height:8px;border-radius:8px;background:var(--bg-elevated);overflow:hidden;display:flex}',
      '.mm-bar i{display:block;height:100%}',
      '.mm-prog{min-width:200px}',
      '.mm-prog .l{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--text-muted-color);margin:0 0 4px}',
      '.mm-prog .l b{color:var(--text-dim);font-weight:600}',
      '.mm-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);flex-wrap:wrap;padding:0 12px}',
      '.mm-tabs button{background:none;border:none;border-bottom:2px solid transparent;padding:12px;font-size:13px;font-weight:600;color:var(--text-muted-color);margin-bottom:-1px;cursor:pointer;font-family:inherit}',
      '.mm-tabs button.on{color:var(--text);border-bottom-color:var(--primary)}',
      '.mm-tabs em{font-style:normal;background:var(--bg-elevated);border-radius:10px;padding:1px 7px;margin-left:5px;font-size:11.5px}',
      '.mm-tabs button.on em{background:rgba(249,115,22,.18);color:var(--primary)}',
      '.mm-person{display:flex;align-items:center;gap:10px}',
      '.mm-person .avatar{width:30px;height:30px;font-size:12px}',
      '.mm-person b{display:block;color:var(--text);font-weight:600;font-size:14px}',
      '.mm-person small{font-size:12px;color:var(--text-muted-color)}',
      '.mm-when{font-size:13px;color:var(--text-dim);white-space:nowrap}',
      '.mm-when small{display:block;font-size:11.5px;color:var(--text-muted-color)}',
      '.mm-lockpill{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:#2d0d0d;color:#f87171;border:1px solid #4d1515;white-space:nowrap}',
      'html[data-theme="light"] .mm-lockpill{background:#fdeaea;color:#dc2626;border-color:#f6c9c9}',
      '.mm-p{display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;white-space:nowrap}',
      '.mm-p.g{background:#0d2d17;color:#22c55e}.mm-p.a{background:#3a2a10;color:#fbbf24}.mm-p.r{background:#2d0d0d;color:#f87171}.mm-p.b{background:#0d1e30;color:#60a5fa}.mm-p.m{background:#2a2a2a;color:#aaa}.mm-p.v{background:#22123a;color:#c4a5fd}',
      'html[data-theme="light"] .mm-p.g{background:#e4f7ec;color:#15803d}html[data-theme="light"] .mm-p.a{background:#fff4e0;color:#b9770b}html[data-theme="light"] .mm-p.r{background:#fdeaea;color:#dc2626}html[data-theme="light"] .mm-p.b{background:#e7f0fe;color:#2563eb}html[data-theme="light"] .mm-p.m{background:#eceef1;color:#5b6470}html[data-theme="light"] .mm-p.v{background:#f3eafe;color:#7c3aed}',
      '.mm-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.mm-row-click{cursor:pointer}',
      '.mm-pick{max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius);margin-top:10px}',
      '.mm-pick label{display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border-light);font-size:13.5px;color:var(--text-dim);cursor:pointer}',
      '.mm-pick label small{color:var(--text-muted-color);margin-left:auto;font-size:12px}',
      // reader
      '.mm-lockbar{background:#1a0d0d;border-bottom:1px solid #4d1515;color:#fca5a5;padding:12px 16px;display:flex;gap:10px;align-items:center;font-size:13.5px;font-weight:600}',
      'html[data-theme="light"] .mm-lockbar{background:#fdeaea;color:#b91c1c;border-color:#f6c9c9}',
      '.mm-read{max-width:780px;margin:0 auto;padding:20px 16px 40px}',
      '.mm-memohead{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12.5px;color:var(--text-muted-color);margin-bottom:6px}',
      '.mm-memotitle{font-size:22px;font-weight:700;color:var(--text);margin-bottom:6px}',
      '.mm-from{display:grid;grid-template-columns:76px 1fr;gap:4px 10px;font-size:13px;color:var(--text-dim);padding:12px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:12px 0 16px}',
      '.mm-from span:nth-child(odd){color:var(--text-muted-color)}',
      '.mm-note{font-size:15px;color:var(--text);margin:0 0 14px;line-height:1.5}',
      '.mm-body{font-size:14px;color:var(--text-dim);line-height:1.65;white-space:pre-wrap;margin-bottom:14px}',
      '.mm-pages{background:#3a3d42;border-radius:var(--radius);padding:12px;display:flex;flex-direction:column;gap:12px;align-items:center}',
      '.mm-pages canvas{width:100%;max-width:640px;height:auto;background:#fff;border-radius:2px;box-shadow:0 2px 8px rgba(0,0,0,.35)}',
      '.mm-pgbar{display:flex;justify-content:space-between;align-items:center;width:100%;max-width:640px;color:#ddd;font-size:12.5px;gap:10px}',
      '.mm-pgbar a{color:#fdba74;cursor:pointer}',
      '.mm-ack{background:var(--bg-elevated);border:1px solid var(--border);border-left:3px solid var(--primary);border-radius:var(--radius);padding:12px 14px;font-size:13.5px;color:var(--text-dim);line-height:1.55}',
      '.mm-endmark{text-align:center;font-size:12.5px;margin:14px 0;color:var(--text-muted-color)}',
      '.mm-endmark.done{color:#22c55e}',
      '.mm-pad{background:#fff;border-radius:6px;height:140px;position:relative;overflow:hidden;touch-action:none;cursor:crosshair}',
      '.mm-pad canvas{display:block;width:100%;height:100%}',
      '.mm-signarea.off{opacity:.45;pointer-events:none}',
      '.mm-banner{display:flex;gap:12px;align-items:flex-start;background:#1d1408;border:1px solid #4a2c0b;border-radius:var(--radius);padding:14px;margin-bottom:16px}',
      '.mm-banner b{display:block;color:#fdba74;font-size:14px;margin-bottom:3px}',
      '.mm-banner p{font-size:13px;color:#e8c9a8;line-height:1.45;margin:0}',
      'html[data-theme="light"] .mm-banner{background:#fff4e0;border-color:#ffe2b0}html[data-theme="light"] .mm-banner b{color:#b45309}html[data-theme="light"] .mm-banner p{color:#78350f}',
      '.mm-memocard{border-left:3px solid #a78bfa;background:var(--bg-elevated);border-radius:var(--radius);padding:12px 14px;margin-bottom:10px;border-top:1px solid var(--border);border-right:1px solid var(--border);border-bottom:1px solid var(--border)}',
      '.mm-memocard .t{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-weight:600;color:var(--text);font-size:14px}',
      '.mm-memocard .m{font-size:12px;color:var(--text-muted-color);margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}',
      '.mm-memocard .a{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}',
      '@media(max-width:600px){.mm-trk th.mm-hide,.mm-trk td.mm-hide{display:none}.table-wrap table.mm-trk{min-width:0}.mm-trk td,.mm-trk th{padding:10px 8px;white-space:normal!important}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function pill(cls, text) { return '<span class="mm-p ' + cls + '">' + esc(text) + '</span>'; }
  function lockPill(text) { return '<span class="mm-lockpill">' + ICON.lock.replace(/14/g, '11') + esc(text || 'Locks Nova') + '</span>'; }
  function initials(n) { return String(n || '?').split(/\s+/).map(function (p) { return p.charAt(0); }).join('').slice(0, 2).toUpperCase(); }

  function download(path, fallbackName) {
    return api('GET', path).then(function (r) {
      if (typeof invDownloadBase64 === 'function') invDownloadBase64(r.data, r.mime || 'application/pdf', r.filename || fallbackName || 'memo.pdf');
    }).catch(function (e) { toast(e.message || 'Could not build the PDF.', 'error'); });
  }

  // ------------------------------------------------------------------ modal
  function modal(title, bodyHtml, footerHtml, width) {
    closeModal();
    var wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.id = 'mm-modal';
    wrap.innerHTML = '<div class="modal" style="max-width:' + (width || 520) + 'px">' +
      '<div class="modal-header"><div class="modal-title">' + title + '</div>' +
      '<div style="cursor:pointer;color:var(--text-muted-color)" onclick="mmCloseModal()">&#10005;</div></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      (footerHtml ? '<div class="modal-footer">' + footerHtml + '</div>' : '') + '</div>';
    document.body.appendChild(wrap);
  }
  function closeModal() { var m = el('mm-modal'); if (m && m.parentNode) m.parentNode.removeChild(m); }
  window.mmCloseModal = closeModal;

  // ------------------------------------------------------------------ pdf.js
  function b64ToBytes(b64) {
    var bin = atob(b64); var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function getPdfLib() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (typeof loadPdfJs === 'function') return loadPdfJs();
    return Promise.reject(new Error('The PDF reader is not available.'));
  }
  // Render every page of a PDF into host as canvases. maxPages limits it for
  // thumbnails. Returns the page count.
  async function renderPdfInto(host, bytes, opts) {
    opts = opts || {};
    var lib = await getPdfLib();
    var pdf = await lib.getDocument({ data: bytes }).promise;
    var n = opts.maxPages ? Math.min(opts.maxPages, pdf.numPages) : pdf.numPages;
    for (var i = 1; i <= n; i++) {
      var page = await pdf.getPage(i);
      var base = page.getViewport({ scale: 1 });
      var targetW = opts.width || Math.min(1280, Math.max(600, (host.clientWidth || 640) * (window.devicePixelRatio || 1)));
      var vp = page.getViewport({ scale: targetW / base.width });
      var cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
      cv.setAttribute('data-page', String(i));
      host.appendChild(cv);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    }
    return pdf.numPages;
  }

  // ======================================================================
  //  LIST
  // ======================================================================
  window.renderMemos = async function (host) {
    injectCss();
    host.innerHTML = '<div class="loading">Loading…</div>';
    var d;
    try { d = await api('GET', API); } catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load memos.') + '</div>'; return; }
    MM.list = d;
    drawList(host);
  };

  function drawList(host) {
    var d = MM.list || { memos: [], stats: {} };
    var st = d.stats || {};
    var groups = { sent: [], draft: [], withdrawn: [] };
    d.memos.forEach(function (m) {
      if (m.status === 'draft') groups.draft.push(m);
      else if (m.status === 'withdrawn') groups.withdrawn.push(m);
      else groups.sent.push(m);
    });
    var tab = MM.listTab;
    var rows = groups[tab] || [];
    var body;
    if (!rows.length) {
      body = '<div class="empty-state" style="padding:40px 20px;text-align:center"><h3 style="margin-bottom:6px">' +
        (tab === 'draft' ? 'No drafts' : tab === 'withdrawn' ? 'Nothing withdrawn' : 'No memos sent yet') + '</h3>' +
        '<p class="mm-mute">' + (tab === 'sent' ? 'New Memo sends a note or a PDF to everyone, a location, a role or picked people.' : '') + '</p></div>';
    } else {
      body = '<div class="table-wrap"><table class="mm-trk"><thead><tr><th>Memo</th><th class="mm-hide">Sent</th><th class="mm-hide">Audience</th><th class="mm-hide">Requires</th>' +
        '<th class="mm-hide">Sign by</th><th>' + (tab === 'draft' ? 'Last saved' : 'Progress') + '</th><th>Status</th></tr></thead><tbody>' +
        rows.map(listRow).join('') + '</tbody></table></div>';
    }
    host.innerHTML =
      '<div class="page-header"><div><h1 style="font-size:24px">Memos</h1><div class="mm-mute" style="margin-top:4px">Send a note or a PDF to everyone at once. Each copy lands in the person&#39;s file, and you can see who read and signed it.</div></div>' +
      '<button class="btn btn-primary" onclick="mmNew()">' + ICON.plus + ' New Memo</button></div>' +
      '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-label">Open memos</div><div class="stat-value">' + (st.open_memos || 0) + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">People still to sign</div><div class="stat-value" style="color:var(--warning)">' + (st.people_outstanding || 0) + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Locked out of Nova now</div><div class="stat-value" style="color:var(--danger)">' + (st.locked_now || 0) + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Past sign-by date</div><div class="stat-value">' + (st.overdue || 0) + '</div></div></div>' +
      '<div class="card"><div class="mm-tabs">' +
      ['sent', 'draft', 'withdrawn'].map(function (k) {
        return '<button class="' + (k === tab ? 'on' : '') + '" onclick="mmListTab(\'' + k + '\')">' + (k === 'sent' ? 'Sent' : k === 'draft' ? 'Drafts' : 'Withdrawn') + '<em>' + groups[k].length + '</em></button>';
      }).join('') + '</div>' + body + '</div>';
  }
  window.mmListTab = function (k) { MM.listTab = k; drawList(content()); };

  function progHtml(m) {
    var c = m.counts || {};
    var n = Math.max(1, c.total || 0);
    var word = m.require_signature ? 'Signed' : 'Acknowledged';
    return '<div class="mm-prog"><div class="l"><span>Viewed <b>' + (c.viewed || 0) + '/' + (c.total || 0) + '</b></span><span>' + word + ' <b>' + (c.completed || 0) + '/' + (c.total || 0) + '</b></span></div>' +
      '<div class="mm-bar"><i style="width:' + ((c.completed || 0) / n * 100) + '%;background:#22c55e"></i><i style="width:' + (Math.max(0, (c.viewed || 0) - (c.completed || 0)) / n * 100) + '%;background:#60a5fa"></i></div></div>';
  }

  function statusPill(m) {
    var c = m.counts || {};
    if (m.status === 'draft') return pill('m', 'Draft');
    if (m.status === 'withdrawn') return pill('m', 'Withdrawn');
    if (m.status === 'superseded') return pill('m', 'Replaced');
    var open = (c.total || 0) - (c.completed || 0) - (c.excused || 0);
    if (open <= 0) return pill('g', 'Complete');
    if (c.overdue) return pill('r', c.overdue + ' overdue');
    return pill('a', m.require_signature ? 'Out for signature' : 'Waiting');
  }

  function listRow(m) {
    var go = m.status === 'draft' ? 'navigate(\'memo-edit\',' + m.id + ')' : 'navigate(\'memo\',' + m.id + ')';
    var req = (m.require_signature ? pill('b', 'Signature') : pill('m', 'Acknowledge')) + (m.lock_until_done ? ' ' + lockPill() : '');
    return '<tr class="mm-row-click" onclick="' + go + '"><td><div style="font-weight:600;color:var(--text)">' + esc(m.title || '(untitled)') + '</div>' +
      '<div class="mm-hash">' + esc(m.memo_no || 'Draft') + ' &middot; ' + esc(m.type || '') + (m.file_name ? ' &middot; PDF' : '') + '</div></td>' +
      '<td class="mm-when mm-hide">' + (m.sent_at ? fmtDate(m.sent_at) + '<small>by ' + esc(m.sent_by_name || '') + '</small>' : '<span class="mm-mute">Not sent</span>') + '</td>' +
      '<td class="mm-hide">' + esc(m.audience_label) + (m.status !== 'draft' ? ' &middot; ' + ((m.counts || {}).total || 0) : '') + '</td>' +
      '<td class="mm-hide">' + req + '</td>' +
      '<td class="mm-when mm-hide">' + (m.sign_by ? fmtDate(m.sign_by) : '<span class="mm-mute">-</span>') + '</td>' +
      '<td>' + (m.status === 'draft' ? '<span class="mm-when">' + fmtWhen(m.updated_at) + '</span>' : progHtml(m)) + '</td>' +
      '<td>' + statusPill(m) + '</td></tr>';
  }

  window.mmNew = async function () {
    try {
      var r = await api('POST', API, { type: 'Announcement', audience: { mode: 'all' }, require_signature: true });
      navigate('memo-edit', r.memo.id);
    } catch (e) { toast(e.message || 'Could not start a memo.', 'error'); }
  };

  // ======================================================================
  //  NEW MEMO / EDIT DRAFT
  // ======================================================================
  function draftKey(id) { return 'memo:' + id + ':' + ((state.user && state.user.id) || 0); }

  function formFrom(m) {
    return {
      type: m.type || 'Announcement', title: m.title || '', note: m.note || '', body: m.body || '',
      effective_date: m.effective_date || '', sign_by: m.sign_by || '',
      require_signature: m.require_signature !== false, lock_until_done: !!m.lock_until_done,
      lock_starts_at: m.lock_starts_at || null, audience: m.audience || { mode: 'all' },
      include_future_hires: !!m.include_future_hires, exclude_sender: m.exclude_sender !== false,
      notify_push: m.notify_push !== false, notify_sms: m.notify_sms !== false, notify_email: m.notify_email !== false,
      remind_every_days: (m.remind_every_days == null ? 2 : m.remind_every_days),
      mode: (m.has_file && m.body) ? 'both' : (m.body && !m.has_file ? 'text' : 'pdf'),
      lock_mode: m.lock_starts_at ? 'date' : 'now'
    };
  }

  window.renderMemoEdit = async function (host, id) {
    injectCss();
    if (!id) { host.innerHTML = '<div class="loading">Starting a memo…</div>'; return window.mmNew(); }
    host.innerHTML = '<div class="loading">Loading…</div>';
    try {
      var both = await Promise.all([api('GET', API + '/meta'), api('GET', API + '/' + id)]);
      MM.meta = both[0];
      var m = both[1].memo;
      if (m.status !== 'draft') { navigate('memo', id); return; }
      MM.editId = id; MM.memo = m; MM.form = formFrom(m); MM.lastSavedAt = m.updated_at; MM.preview = null;
    } catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load the memo.') + '</div>'; return; }
    drawEdit(host);
    refreshPreview();
    drawThumbs();
    // A copy on this device that is newer than the server's means the last
    // server save never landed. Offer it back rather than losing it.
    if (typeof novaDraftGet === 'function') {
      novaDraftGet(draftKey(id)).then(function (d) {
        if (!d || !d.form || !d.at) return;
        if (MM.lastSavedAt && new Date(d.at) <= new Date(MM.lastSavedAt)) { novaDraftDel(draftKey(id)); return; }
        var bar = el('mm-restore');
        if (bar) bar.innerHTML = '<div class="alert alert-warn" style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<span>There are unsaved changes from ' + esc(fmtWhen(d.at)) + ' on this device.</span>' +
          '<span><button class="btn btn-primary btn-sm" onclick="mmRestoreDraft()">Restore draft</button> <button class="btn btn-ghost btn-sm" onclick="mmDiscardLocal()">Discard</button></span></div>';
        MM._local = d.form;
      });
    }
  };
  window.mmRestoreDraft = function () { if (MM._local) { MM.form = MM._local; drawEdit(content()); drawThumbs(); queueSave(); refreshPreview(); } };
  window.mmDiscardLocal = function () { if (typeof novaDraftDel === 'function') novaDraftDel(draftKey(MM.editId)); var b = el('mm-restore'); if (b) b.innerHTML = ''; };

  function sw(id, on, handler) { return '<button type="button" class="mm-sw' + (on ? ' on' : '') + '" id="' + id + '" onclick="' + handler + '" aria-pressed="' + (on ? 'true' : 'false') + '"></button>'; }
  function seg(name, opts, cur) {
    return '<div class="mm-seg">' + opts.map(function (o) {
      return '<button type="button" class="' + (o[0] === cur ? 'on' : '') + '" onclick="mmSet(\'' + name + '\',\'' + o[0] + '\')">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function chk(on, label, handler) {
    return '<label style="display:flex;gap:10px;align-items:flex-start;font-size:13.5px;color:var(--text-dim);margin-bottom:8px;cursor:pointer">' +
      '<input type="checkbox"' + (on ? ' checked' : '') + ' onchange="' + handler + '" style="margin-top:2px"><span>' + label + '</span></label>';
  }

  function drawEdit(host) {
    var f = MM.form, m = MM.memo, meta = MM.meta;
    var a = f.audience || { mode: 'all' };
    var typeOpts = meta.types.slice();
    if (f.type && typeOpts.indexOf(f.type) === -1) typeOpts.unshift(f.type);

    var counts = {};
    meta.people.forEach(function (p) { counts[p.city || '-'] = (counts[p.city || '-'] || 0) + 1; });
    var roleCounts = {};
    meta.people.forEach(function (p) { roleCounts[p.role] = (roleCounts[p.role] || 0) + 1; });

    var who = '';
    if (a.mode === 'cities') {
      who = '<div class="mm-chips">' + meta.cities.map(function (c) {
        var on = (a.cities || []).indexOf(c.code) !== -1;
        return '<button type="button" class="mm-chip' + (on ? ' on' : '') + '" onclick="mmToggleList(\'cities\',\'' + esc(c.code) + '\')">' + esc(c.name) + ' <small>' + (counts[c.code] || 0) + '</small></button>';
      }).join('') + '</div>';
    } else if (a.mode === 'roles') {
      who = '<div class="mm-chips">' + meta.roles.map(function (r) {
        var on = (a.roles || []).indexOf(r.key) !== -1;
        return '<button type="button" class="mm-chip' + (on ? ' on' : '') + '" onclick="mmToggleList(\'roles\',\'' + esc(r.key) + '\')">' + esc(r.label) + ' <small>' + (roleCounts[r.key] || 0) + '</small></button>';
      }).join('') + '</div>';
    } else if (a.mode === 'people') {
      var picked = a.user_ids || [];
      who = '<input id="mm-pick-q" placeholder="Search names&hellip;" oninput="mmPickFilter(this.value)" style="width:100%">' +
        '<div class="mm-pick" id="mm-pick">' + meta.people.map(function (p) {
          return '<label data-n="' + esc(String(p.name).toLowerCase()) + '"><input type="checkbox"' + (picked.indexOf(p.id) !== -1 ? ' checked' : '') +
            ' onchange="mmToggleList(\'user_ids\',' + p.id + ')"> ' + esc(p.name) + '<small>' + esc(p.role_label) + (p.city ? ' &middot; ' + esc(p.city) : '') + '</small></label>';
        }).join('') + '</div>';
    } else {
      who = '<div class="mm-mute">Everyone who is active and has finished onboarding' + (f.exclude_sender ? ', except you' : '') + '.</div>';
    }

    var fileBlock;
    if (m.has_file) {
      fileBlock = '<div class="mm-drop"><div class="mm-file" style="border:none;padding:0;background:none"><div class="ic">PDF</div>' +
        '<div style="flex:1;min-width:0"><b>' + esc(m.file_name) + '</b><small>' + plural(m.file_pages || 0, 'page') + ' &middot; ' + Math.max(1, Math.round((m.file_size || 0) / 1024)) + ' KB</small></div>' +
        '<label class="btn btn-secondary btn-sm" style="cursor:pointer">Replace<input type="file" accept="application/pdf,.pdf" style="display:none" onchange="mmUpload(this)"></label>' +
        ' <button class="btn btn-ghost btn-sm" onclick="mmRemoveFile()">Remove</button></div>' +
        '<div class="mm-thumbs" id="mm-thumbs"></div></div>';
    } else {
      fileBlock = '<label class="mm-drop" style="display:block;text-align:center;cursor:pointer;padding:26px 14px">' +
        '<div style="font-weight:600;color:var(--text);margin-bottom:4px">Attach the PDF</div>' +
        '<div class="mm-mute">Up to ' + (meta.max_file_mb || 25) + ' MB. Everyone reads it inside Nova, page by page.</div>' +
        '<input type="file" accept="application/pdf,.pdf" style="display:none" onchange="mmUpload(this)"></label>' +
        (meta.r2_ready ? '' : '<div class="alert alert-warn" style="margin-top:8px;font-size:13px">File storage (R2) is not set up on this server, so a PDF cannot be attached yet.</div>');
    }
    fileBlock += '<div id="mm-upload-note" class="mm-mute" style="margin-top:6px"></div>';

    var showPdf = f.mode === 'pdf' || f.mode === 'both';
    var showText = f.mode === 'text' || f.mode === 'both';
    var lockStart = f.lock_starts_at ? String(f.lock_starts_at) : '';
    var lockLocal = '';
    if (lockStart) { var dt = new Date(lockStart); if (!isNaN(dt)) { var z = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000); lockLocal = z.toISOString().slice(0, 16); } }

    host.innerHTML =
      '<div class="page-header"><div><div class="mm-mute"><a style="cursor:pointer;color:inherit" onclick="navigate(\'memos\')">Memos</a> &rsaquo; ' + (m.supersedes_id ? 'Revision' : 'New') + '</div>' +
      '<h1 style="font-size:24px">' + (m.supersedes_id ? 'Revise memo' : 'New Memo') + '</h1></div>' +
      '<div style="display:flex;gap:10px;align-items:center"><span class="mm-mute" id="mm-saved"></span>' +
      '<button class="btn btn-ghost btn-sm" onclick="mmDeleteDraft()">Delete draft</button></div></div>' +
      '<div id="mm-restore"></div>' +
      (m.supersedes_id ? '<div class="alert alert-info" style="margin-bottom:16px;font-size:13px">This is a revision. Sending it replaces the earlier memo, and everyone signs again. Their signed copies of the earlier memo stay in their files.</div>' : '') +
      '<div class="mm-two"><div>' +

      '<div class="card"><div class="card-header"><div class="card-title">1. The memo</div></div><div class="card-body" style="padding:20px">' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:14px">' +
      '<div><span class="mm-label">Memo type</span><select id="mm-type" onchange="mmField(\'type\',this.value)" style="width:100%">' +
      typeOpts.map(function (t) { return '<option' + (t === f.type ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
      '<div><span class="mm-label">Effective date <span class="mm-mute">(optional)</span></span><input type="date" id="mm-eff" value="' + esc(f.effective_date || '') + '" onchange="mmField(\'effective_date\',this.value)" style="width:100%"></div></div>' +
      '<div style="margin-bottom:14px"><span class="mm-label">Title</span><input id="mm-title" maxlength="200" value="' + esc(f.title) + '" placeholder="e.g. PTO Policy Change" oninput="mmField(\'title\',this.value)" style="width:100%"></div>' +
      '<span class="mm-label">What are you sending?</span>' +
      '<div style="margin-bottom:14px">' + seg('mode', [['pdf', 'A document (PDF)'], ['text', 'Write a memo'], ['both', 'Both']], f.mode) + '</div>' +
      (showPdf ? fileBlock : '') +
      (showText ? '<div style="margin-top:14px"><span class="mm-label">Memo text</span><textarea id="mm-body" maxlength="20000" style="width:100%;min-height:200px" oninput="mmField(\'body\',this.value)" placeholder="Write the memo here.">' + esc(f.body) + '</textarea></div>' : '') +
      '<div style="margin-top:14px"><span class="mm-label">Short note on top <span class="mm-mute">(optional' + (showPdf && !showText ? ', leave blank to send just the PDF' : '') + ')</span></span>' +
      '<input id="mm-note" maxlength="600" value="' + esc(f.note) + '" placeholder="e.g. Here is the updated PTO policy." oninput="mmField(\'note\',this.value)" style="width:100%"></div>' +
      '</div></div>' +

      '<div class="card"><div class="card-header"><div class="card-title">2. Who gets it</div><span class="mm-p b" id="mm-count-pill">&hellip;</span></div><div class="card-body" style="padding:20px">' +
      '<div style="margin-bottom:14px">' + seg('audience_mode', [['all', 'Everyone'], ['cities', 'By location'], ['roles', 'By role'], ['people', 'Pick people']], a.mode) + '</div>' +
      '<div style="margin-bottom:14px">' + who + '</div>' +
      chk(f.exclude_sender, 'Leave me out. You wrote it, so you are not asked to sign it.', 'mmField(\'exclude_sender\',this.checked)') +
      chk(f.include_future_hires, 'Also send to anyone hired later. They get it once they finish onboarding.', 'mmField(\'include_future_hires\',this.checked)') +
      '</div></div>' +

      '<div class="card"><div class="card-header"><div class="card-title">3. What they have to do</div></div><div class="card-body" style="padding:6px 20px">' +
      '<div class="mm-opt">' + sw('mm-sw-sig', f.require_signature, 'mmFlip(\'require_signature\')') + '<div style="flex:1"><b>Require a signature</b><p>They type their full name and sign with a finger or mouse. Off means a single &quot;I have read this&quot; button instead.</p></div></div>' +
      '<div class="mm-opt">' + sw('mm-sw-lock', f.lock_until_done, 'mmFlip(\'lock_until_done\')') + '<div style="flex:1"><b>Lock Nova until they ' + (f.require_signature ? 'sign' : 'confirm') + '</b>' +
      '<p>Every screen is replaced by this memo until it is done. The time clock stays open, so nobody is kept from clocking in or out. Admins and owners get a banner instead of the lock.</p>' +
      (f.lock_until_done ? '<div class="mm-sub">Lock starts ' + seg('lock_mode', [['now', 'As soon as it is sent'], ['date', 'On a date']], f.lock_mode) +
        (f.lock_mode === 'date' ? ' <input type="datetime-local" id="mm-lockat" value="' + esc(lockLocal) + '" onchange="mmLockAt(this.value)">' : '') + '</div>' : '') +
      '</div></div>' +
      '<div class="mm-opt"><div style="width:40px;flex-shrink:0"></div><div style="flex:1"><b>Sign by</b><p>After this date they show as overdue on the tracker. Optional.</p>' +
      '<div class="mm-sub"><input type="date" id="mm-signby" value="' + esc(f.sign_by || '') + '" onchange="mmField(\'sign_by\',this.value)"></div></div></div>' +
      '<div class="mm-opt"><div style="width:40px;flex-shrink:0"></div><div style="flex:1"><b>Tell them</b><p>Sent the moment you press Send, honouring each person&#39;s own text and email settings.</p>' +
      '<div class="mm-sub">' +
      ['push', 'sms', 'email'].map(function (k) {
        var on = f['notify_' + k];
        return '<button type="button" class="mm-chip' + (on ? ' on' : '') + '" onclick="mmFlip(\'notify_' + k + '\')">' + (on ? '&#10003; ' : '') + (k === 'push' ? 'Push' : k === 'sms' ? 'Text' : 'Email') + '</button>';
      }).join('') +
      ' <select onchange="mmField(\'remind_every_days\',this.value)">' +
      [[0, 'No reminders'], [1, 'Remind daily'], [2, 'Remind every 2 days'], [3, 'Remind every 3 days'], [7, 'Remind weekly']].map(function (o) {
        return '<option value="' + o[0] + '"' + (Number(f.remind_every_days) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div></div></div>' +
      '</div></div>' +

      '</div><div class="mm-sticky"><div class="card"><div class="card-header"><div class="card-title">Before you send</div></div>' +
      '<div class="card-body" style="padding:14px 20px"><div class="mm-sum" id="mm-summary"></div></div>' +
      '<div style="padding:0 20px 18px;display:flex;flex-direction:column;gap:8px">' +
      '<button class="btn btn-secondary" style="justify-content:center" onclick="mmPreviewAsEmployee()">Preview as an employee</button>' +
      '<button class="btn btn-primary" style="justify-content:center" id="mm-send-btn" onclick="mmConfirmSend()">Send memo</button></div></div></div>' +
      '</div>';
    drawSaved();
    drawSummary();
  }

  function drawSaved() {
    var s = el('mm-saved'); if (!s) return;
    if (MM.saving) { s.textContent = 'Saving…'; s.style.color = ''; return; }
    if (MM.saveError) { s.textContent = 'Not saved to Nova yet (kept on this device)'; s.style.color = 'var(--warning)'; return; }
    s.innerHTML = MM.lastSavedAt ? '&#10003; Draft saved ' + esc(new Date(MM.lastSavedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) : '';
    s.style.color = '#22c55e';
  }

  function payload() {
    var f = MM.form;
    return {
      type: f.type, title: f.title, note: f.note,
      body: (f.mode === 'pdf') ? '' : f.body,
      effective_date: f.effective_date || null, sign_by: f.sign_by || null,
      require_signature: f.require_signature, lock_until_done: f.lock_until_done,
      lock_starts_at: (f.lock_until_done && f.lock_mode === 'date') ? f.lock_starts_at : null,
      audience: f.audience, include_future_hires: f.include_future_hires, exclude_sender: f.exclude_sender,
      notify_push: f.notify_push, notify_sms: f.notify_sms, notify_email: f.notify_email,
      remind_every_days: Number(f.remind_every_days)
    };
  }

  function queueSave() {
    if (typeof novaDraftPut === 'function') novaDraftPut(draftKey(MM.editId), { form: MM.form, at: new Date().toISOString() });
    clearTimeout(MM.saveTimer);
    MM.saveTimer = setTimeout(saveNow, 900);
  }
  async function saveNow() {
    clearTimeout(MM.saveTimer);
    if (!MM.editId) return;
    MM.saving = true; drawSaved();
    try {
      var r = await api('PUT', API + '/' + MM.editId, payload());
      MM.memo = r.memo; MM.lastSavedAt = r.memo.updated_at; MM.saveError = false;
      if (typeof novaDraftDel === 'function') novaDraftDel(draftKey(MM.editId));
    } catch (e) { MM.saveError = true; }
    MM.saving = false; drawSaved();
  }
  // Flush on the way out, the same as the invoice editor.
  window.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && MM.saveTimer && state.currentView === 'memo-edit') saveNow(); });

  window.mmField = function (k, v) {
    if (k === 'exclude_sender' || k === 'include_future_hires') v = !!v;
    MM.form[k] = v;
    queueSave();
    if (k === 'exclude_sender') refreshPreview();
    drawSummary();
  };
  window.mmFlip = function (k) {
    MM.form[k] = !MM.form[k];
    queueSave();
    drawEdit(content()); drawThumbs(); drawSummary();
  };
  window.mmSet = function (name, v) {
    var f = MM.form;
    if (name === 'mode') f.mode = v;
    else if (name === 'lock_mode') { f.lock_mode = v; if (v === 'now') f.lock_starts_at = null; }
    else if (name === 'audience_mode') { f.audience = Object.assign({ cities: [], roles: [], user_ids: [] }, f.audience || {}, { mode: v }); refreshPreview(); }
    queueSave();
    drawEdit(content()); drawThumbs();
  };
  window.mmLockAt = function (v) {
    var d = v ? new Date(v) : null;
    MM.form.lock_starts_at = (d && !isNaN(d)) ? d.toISOString() : null;
    queueSave(); drawSummary();
  };
  window.mmToggleList = function (key, val) {
    var a = MM.form.audience = Object.assign({ cities: [], roles: [], user_ids: [] }, MM.form.audience || {});
    var list = (a[key] || []).slice();
    var i = list.indexOf(val);
    if (i === -1) list.push(val); else list.splice(i, 1);
    a[key] = list;
    queueSave();
    refreshPreview();
    if (key !== 'user_ids') { drawEdit(content()); drawThumbs(); }
  };
  window.mmPickFilter = function (q) {
    q = String(q || '').toLowerCase();
    var box = el('mm-pick'); if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('label'), function (l) {
      l.style.display = (!q || (l.getAttribute('data-n') || '').indexOf(q) !== -1) ? '' : 'none';
    });
  };

  function refreshPreview() {
    clearTimeout(MM.previewTimer);
    MM.previewTimer = setTimeout(async function () {
      try {
        MM.preview = await api('POST', API + '/audience-preview', { audience: MM.form.audience, exclude_sender: MM.form.exclude_sender });
      } catch (e) { MM.preview = null; }
      var p = el('mm-count-pill'); if (p) p.textContent = MM.preview ? plural(MM.preview.count, 'person', 'people') : '?';
      drawSummary();
    }, 250);
  }

  function sendProblems() {
    var f = MM.form, m = MM.memo, p = [];
    if (!String(f.title || '').trim()) p.push('Give it a title.');
    var hasPdf = !!m.has_file, hasText = !!String(f.body || '').trim();
    if ((f.mode === 'pdf' && !hasPdf) || (f.mode === 'text' && !hasText) || (f.mode === 'both' && (!hasPdf || !hasText))) {
      p.push(f.mode === 'text' ? 'Write the memo.' : (f.mode === 'pdf' ? 'Attach the PDF.' : 'Attach the PDF and write the memo.'));
    }
    if (MM.preview && !MM.preview.count) p.push('Nobody matches who it is for.');
    if (f.lock_until_done && f.lock_mode === 'date' && !f.lock_starts_at) p.push('Pick when the lock starts.');
    return p;
  }

  function drawSummary() {
    var box = el('mm-summary'); if (!box) return;
    var f = MM.form, pv = MM.preview;
    var n = pv ? pv.count : null;
    var ch = [];
    if (f.notify_push) ch.push('a push'); if (f.notify_sms) ch.push('a text'); if (f.notify_email) ch.push('an email');
    var chTxt = ch.length ? (ch.length === 1 ? ch[0] : ch.slice(0, -1).join(', ') + ' and ' + ch[ch.length - 1]) : 'no notification (they will see it in Nova)';
    var cities = pv ? Object.keys(pv.by_city || {}).length : 0;
    var rows = [];
    rows.push(['', (n == null ? '&hellip;' : '<b>' + plural(n, 'person', 'people') + '</b>' + (cities > 1 ? ' in ' + cities + ' locations' : '')) + ' get ' + chTxt + ' right away.']);
    rows.push(['', 'Each one must <b>' + (f.require_signature ? 'sign' : 'confirm they read it') + '</b>. Their ' + (f.require_signature ? 'signed' : '') + ' copy' + (MM.memo.has_file ? ', with the full PDF,' : '') + ' is filed in their Employee File.']);
    if (f.lock_until_done) {
      var lc = pv ? pv.lock_count : null;
      var when = (f.lock_mode === 'date' && f.lock_starts_at) ? ' starting ' + esc(fmtWhen(f.lock_starts_at)) : '';
      rows.push(['danger', '<b style="color:var(--danger)">Nova locks for ' + (lc == null ? '&hellip;' : lc) + '</b>' + when + ' until they ' + (f.require_signature ? 'sign' : 'confirm') + '. Time clock stays open.' +
        (pv && pv.exempt && pv.exempt.length ? ' ' + esc(pv.exempt.join(', ')) + ' get a banner instead.' : '')]);
    }
    if (f.sign_by) rows.push(['', 'Sign by <b>' + esc(fmtDate(f.sign_by)) + '</b>.']);
    rows.push(['', 'Once sent, it can not be edited. A fix is a revision that everyone signs again.']);
    var probs = sendProblems();
    box.innerHTML = rows.map(function (r) {
      return '<div class="row"><span class="k"' + (r[0] === 'danger' ? ' style="color:var(--danger)"' : '') + '>&#9679;</span><span>' + r[1] + '</span></div>';
    }).join('') + (probs.length ? '<div class="alert alert-warn" style="margin-top:10px;font-size:13px">' + probs.map(esc).join('<br>') + '</div>' : '');
    var btn = el('mm-send-btn');
    if (btn) { btn.disabled = probs.length > 0 || n == null; btn.textContent = 'Send memo' + (n ? ' to ' + plural(n, 'person', 'people') : ''); }
  }

  // ---- upload: presign -> PUT to R2 -> confirm ----
  window.mmUpload = async function (input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    var note = el('mm-upload-note');
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Attach a PDF.', 'error'); return; }
    if (file.size > (MM.meta.max_file_mb || 25) * 1048576) { toast('That PDF is too large.', 'error'); return; }
    try {
      if (note) note.textContent = 'Uploading ' + file.name + '…';
      await saveNow();
      var u = await api('POST', API + '/' + MM.editId + '/upload-url', { filename: file.name, content_type: 'application/pdf', size: file.size });
      var put = await fetch(u.url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
      if (!put.ok) throw new Error('The upload did not go through (' + put.status + ').');
      if (note) note.textContent = 'Checking the PDF…';
      var r = await api('POST', API + '/' + MM.editId + '/file', { key: u.key, filename: file.name });
      MM.memo = r.memo; MM.lastSavedAt = r.memo.updated_at;
      if (note) note.textContent = '';
      drawEdit(content()); drawThumbs(); drawSummary();
      toast('PDF attached.', 'success');
    } catch (e) {
      if (note) note.textContent = '';
      toast(e.message || 'Upload failed.', 'error');
    }
  };
  window.mmRemoveFile = async function () {
    if (!(await novaConfirm('Remove the attached PDF from this draft?', { okText: 'Remove it' }))) return;
    try { var r = await api('DELETE', API + '/' + MM.editId + '/file'); MM.memo = r.memo; drawEdit(content()); drawSummary(); }
    catch (e) { toast(e.message || 'Could not remove it.', 'error'); }
  };
  async function drawThumbs() {
    var host = el('mm-thumbs');
    if (!host || !MM.memo || !MM.memo.has_file) return;
    try {
      var f = await api('GET', API + '/' + MM.editId + '/file');
      if (!el('mm-thumbs')) return;
      host.innerHTML = '';
      await renderPdfInto(host, b64ToBytes(f.data), { maxPages: 6, width: 300 });
    } catch (e) { host.innerHTML = '<span class="mm-mute">Preview unavailable.</span>'; }
  }

  window.mmDeleteDraft = async function () {
    if (!(await novaConfirm('Delete this draft? This can not be undone.', { okText: 'Delete draft' }))) return;
    try {
      clearTimeout(MM.saveTimer);
      await api('DELETE', API + '/' + MM.editId);
      if (typeof novaDraftDel === 'function') novaDraftDel(draftKey(MM.editId));
      MM.editId = null; navigate('memos');
    } catch (e) { toast(e.message || 'Could not delete.', 'error'); }
  };

  window.mmPreviewAsEmployee = async function () {
    await saveNow();
    var m = Object.assign({}, MM.memo, { sent_by_name: state.user.name, sent_at: new Date().toISOString(), memo_no: 'MEMO-PREVIEW' });
    modal('Preview: what they will see', '<div id="mm-prev-host" style="max-height:70vh;overflow:auto;margin:-4px"></div>', '<button class="btn btn-secondary" onclick="mmCloseModal()">Close</button>', 760);
    var host = el('mm-prev-host');
    drawReader(host, m, { preview: true });
  };

  window.mmConfirmSend = async function () {
    await saveNow();
    var probs = sendProblems();
    if (probs.length) { toast(probs[0], 'error'); return; }
    var f = MM.form, pv = MM.preview || {};
    var noText = (pv.no_text || []);
    var rows = [
      '<b>' + plural(pv.count || 0, 'person', 'people') + '</b> are notified now' + (f.notify_push || f.notify_sms || f.notify_email ? '' : ' (in Nova only)') + '.',
      f.lock_until_done ? '<b style="color:var(--danger)">Nova locks for ' + (pv.lock_count || 0) + '</b> ' + (f.lock_mode === 'date' && f.lock_starts_at ? 'from ' + esc(fmtWhen(f.lock_starts_at)) : 'on their next tap') + ' until they ' + (f.require_signature ? 'sign' : 'confirm') + '. The time clock stays open.' : 'Nova is not locked. They see a banner until they ' + (f.require_signature ? 'sign' : 'confirm') + '.',
      'The memo locks. To change it later you issue a revision, and everyone signs again.'
    ];
    if (f.notify_sms && noText.length) rows.push(plural(noText.length, 'person', 'people') + ' will not get a text (no mobile number, or texts turned off): ' + esc(noText.slice(0, 8).join(', ')) + (noText.length > 8 ? ' and ' + (noText.length - 8) + ' more' : '') + '.');
    modal('Send &quot;' + esc(f.title) + '&quot;?',
      '<div class="mm-sum">' + rows.map(function (r, i) { return '<div class="row"><span class="k">' + (i + 1) + '</span><span>' + r + '</span></div>'; }).join('') + '</div>',
      '<button class="btn btn-secondary" onclick="mmCloseModal()">Go back</button><button class="btn btn-primary" id="mm-send-go" onclick="mmSend()">Send to ' + plural(pv.count || 0, 'person', 'people') + '</button>');
  };
  window.mmSend = async function () {
    var b = el('mm-send-go'); if (b) { b.disabled = true; b.textContent = 'Sending…'; }
    try {
      var r = await api('POST', API + '/' + MM.editId + '/send');
      closeModal();
      if (typeof novaDraftDel === 'function') novaDraftDel(draftKey(MM.editId));
      toast('Sent to ' + plural(r.recipients, 'person', 'people') + '.', 'success');
      var id = MM.editId; MM.editId = null;
      navigate('memo', id);
    } catch (e) {
      if (b) { b.disabled = false; b.textContent = 'Send'; }
      toast(e.message || 'Could not send.', 'error');
    }
  };

  // ======================================================================
  //  TRACKER
  // ======================================================================
  window.renderMemoTracker = async function (host, id) {
    injectCss();
    host.innerHTML = '<div class="loading">Loading…</div>';
    try { MM.tracker = await api('GET', API + '/' + id); }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load the memo.') + '</div>'; return; }
    if (MM.tracker.memo.status === 'draft') { navigate('memo-edit', id); return; }
    drawTracker(host);
    drawTrackerThumbs();
  };

  var TABS = [['open', 'Not signed'], ['viewed', 'Viewed, not signed'], ['not_opened', 'Not opened'], ['done', 'Signed'], ['all', 'Everyone'], ['excused', 'Excused']];
  function tabMatch(r, tab) {
    if (tab === 'all') return true;
    if (tab === 'open') return r.status === 'viewed' || r.status === 'not_opened';
    if (tab === 'viewed') return r.status === 'viewed';
    if (tab === 'not_opened') return r.status === 'not_opened';
    if (tab === 'done') return r.status === 'signed' || r.status === 'acknowledged';
    if (tab === 'excused') return r.status === 'excused';
    return true;
  }

  function drawTracker(host) {
    var t = MM.tracker, m = t.memo, c = t.counts, recs = t.recipients;
    var sigWord = m.require_signature ? 'Signed' : 'Acknowledged';
    var need = c.total - c.excused;
    var open = c.viewed_open + c.not_opened;
    var tabs = TABS.map(function (x) {
      var n = recs.filter(function (r) { return tabMatch(r, x[0]); }).length;
      var label = m.require_signature ? x[1] : x[1].replace('signed', 'acknowledged').replace('Signed', 'Acknowledged');
      return '<button class="' + (MM.tab === x[0] ? 'on' : '') + '" onclick="mmTrackTab(\'' + x[0] + '\')">' + label + '<em>' + n + '</em></button>';
    }).join('');
    var cityOpts = {}; var roleOpts = {};
    recs.forEach(function (r) { if (r.user_city) cityOpts[r.user_city] = 1; if (r.user_role) roleOpts[r.user_role] = r.role_label; });
    var q = MM.q.toLowerCase();
    var shown = recs.filter(function (r) {
      return tabMatch(r, MM.tab) && (!q || String(r.user_name || '').toLowerCase().indexOf(q) !== -1) &&
        (!MM.city || r.user_city === MM.city) && (!MM.role || r.user_role === MM.role);
    });
    var live = m.status === 'sent';
    var banner = '';
    if (m.status === 'superseded' && t.related.superseded_by) banner = '<div class="alert alert-info" style="margin-bottom:16px">Replaced by <a style="cursor:pointer;text-decoration:underline" onclick="navigate(\'memo\',' + t.related.superseded_by.id + ')">' + esc(t.related.superseded_by.memo_no || 'a revision') + '</a>. Signatures here stay in everyone&#39;s file; nobody is asked to sign this one any more.</div>';
    if (m.status === 'withdrawn') banner = '<div class="alert alert-warn" style="margin-bottom:16px">Withdrawn ' + esc(fmtWhen(m.withdrawn_at)) + ' by ' + esc(m.withdrawn_by_name || '') + ': ' + esc(m.withdrawn_reason || '') + '. Nobody is locked or reminded. Every record is kept.</div>';
    if (t.related.supersedes) banner += '<div class="alert alert-info" style="margin-bottom:16px;font-size:13px">This is a revision of <a style="cursor:pointer;text-decoration:underline" onclick="navigate(\'memo\',' + t.related.supersedes.id + ')">' + esc(t.related.supersedes.memo_no) + '</a>.</div>';

    var row = function (r) {
      var st = r.status === 'signed' ? pill('g', 'Signed') : r.status === 'acknowledged' ? pill('g', 'Acknowledged') :
        r.status === 'excused' ? pill('m', 'Excused') : r.status === 'viewed' ? pill('b', m.require_signature ? 'Viewed, not signed' : 'Viewed') : pill('a', 'Not opened');
      if (r.locked) st += ' ' + lockPill('Locked');
      if (r.overdue) st += ' ' + pill('r', 'Overdue');
      if (r.active === false) st += ' ' + pill('m', 'Inactive');
      var viewed = r.first_viewed_at ? fmtWhen(r.first_viewed_at) + '<small>' + plural(r.view_count || 1, 'view') + (r.reached_end_at ? ' &middot; read to the end' : '') + '</small>' : '<span class="mm-mute">-</span>';
      var done = r.completed_at ? fmtWhen(r.completed_at) + '<small>' + (r.completion === 'signed' ? 'typed + drawn' : 'acknowledged') + '</small>' :
        (r.status === 'excused' ? '<small style="display:block;max-width:180px;white-space:normal;color:var(--text-muted-color)">' + esc(r.excused_reason || '') + (r.excused_by_name ? ' (' + esc(r.excused_by_name) + ')' : '') + '</small>' : '<span class="mm-mute">-</span>');
      var act;
      if (r.completed_at) act = '<button class="btn btn-secondary btn-sm" onclick="mmCopy(' + m.id + ',' + r.user_id + ')">' + ICON.dl + ' PDF</button>';
      else if (r.status === 'excused') act = live ? '<button class="btn btn-ghost btn-sm" onclick="mmUnexcuse(' + r.user_id + ')">Undo</button>' : '';
      else act = live ? '<button class="btn btn-secondary btn-sm" onclick="mmRemind([' + r.user_id + '])">' + ICON.bell + ' Remind</button> <button class="btn btn-ghost btn-sm" onclick="mmExcuse(' + r.user_id + ')">Excuse</button>' : '';
      return '<tr><td><div class="mm-person"><div class="avatar">' + esc(initials(r.user_name)) + '</div><div><b>' + esc(r.user_name) + '</b><small>' + esc(r.role_label || '') + (r.added_late ? ' &middot; added later' : '') + '</small></div></div></td>' +
        '<td class="mm-hide">' + esc(r.user_city || '') + '</td>' +
        '<td class="mm-when mm-hide">' + fmtWhen(r.delivered_at) + '<small>' + esc(r.delivered_via || 'Nova') + '</small></td>' +
        '<td class="mm-when mm-hide">' + viewed + '</td><td class="mm-when mm-hide">' + done + '</td>' +
        '<td style="white-space:nowrap">' + st + '</td><td style="white-space:nowrap">' + act + '</td></tr>';
    };

    var n = Math.max(1, c.total);
    host.innerHTML =
      '<div class="page-header" style="align-items:flex-start"><div><div class="mm-mute"><a style="cursor:pointer;color:inherit" onclick="navigate(\'memos\')">Memos</a> &rsaquo; ' + esc(m.memo_no || '') + '</div>' +
      '<h1 style="font-size:24px;margin:2px 0 8px">' + esc(m.title) + '</h1>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' + statusPill(Object.assign({}, m, { counts: { total: c.total, completed: c.completed, excused: c.excused, overdue: c.overdue } })) +
      pill('v', m.type) + (m.require_signature ? pill('b', 'Signature') : pill('m', 'Acknowledge')) + (m.lock_until_done ? lockPill(m.lock_starts_at && new Date(m.lock_starts_at) > new Date() ? 'Locks ' + fmtWhen(m.lock_starts_at) : 'Locks Nova') : '') +
      pill('m', 'Sent ' + fmtWhen(m.sent_at) + ' by ' + (m.sent_by_name || '')) + (m.sign_by ? pill('m', 'Sign by ' + fmtDate(m.sign_by)) : '') + pill('m', m.audience_label) + '</div></div>' +
      '<div class="mm-actions"><button class="btn btn-secondary" onclick="mmReport()">' + ICON.dl + ' Status report PDF</button>' +
      (c.completed ? '<button class="btn btn-secondary" onclick="mmAllCopies()">' + ICON.dl + ' All ' + sigWord.toLowerCase() + ' copies (' + c.completed + ')</button>' : '') +
      (live && open ? '<button class="btn btn-primary" onclick="mmRemind(null)">' + ICON.bell + ' Remind the ' + open + ' outstanding</button>' : '') +
      (live ? '<button class="btn btn-ghost" onclick="mmMore()">More &#9662;</button>' : '') + '</div></div>' + banner +
      '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-label">Sent to</div><div class="stat-value">' + c.total + '</div><div class="mm-mute">' + (c.excused ? c.excused + ' excused' : '&nbsp;') + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Viewed</div><div class="stat-value" style="color:#60a5fa">' + c.viewed + '</div><div class="mm-mute">' + Math.round(c.viewed / n * 100) + '% opened it</div></div>' +
      '<div class="stat-card"><div class="stat-label">' + sigWord + '</div><div class="stat-value" style="color:var(--success)">' + c.completed + '</div><div class="mm-mute">' + (need ? Math.round(c.completed / need * 100) : 0) + '% of ' + need + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Not ' + sigWord.toLowerCase() + '</div><div class="stat-value" style="color:var(--warning)">' + open + '</div><div class="mm-mute">' + c.viewed_open + ' opened it, ' + c.not_opened + ' never did</div></div>' +
      (m.lock_until_done ? '<div class="stat-card"><div class="stat-label">Locked out now</div><div class="stat-value" style="color:var(--danger)">' + c.locked + '</div><div class="mm-mute">clears as they ' + (m.require_signature ? 'sign' : 'confirm') + '</div></div>' : '') +
      '</div>' +
      '<div class="card"><div style="padding:16px 20px 6px"><div class="mm-bar" style="height:12px"><i style="width:' + (c.completed / n * 100) + '%;background:#22c55e"></i><i style="width:' + (c.viewed_open / n * 100) + '%;background:#60a5fa"></i><i style="width:' + (c.not_opened / n * 100) + '%;background:#f59e0b"></i><i style="width:' + (c.excused / n * 100) + '%;background:#666"></i></div>' +
      '<div style="display:flex;gap:18px;font-size:12px;color:var(--text-muted-color);margin:8px 0 6px;flex-wrap:wrap"><span><b style="color:#22c55e">&#9632;</b> ' + sigWord + ' ' + c.completed + '</span><span><b style="color:#60a5fa">&#9632;</b> Viewed, not ' + sigWord.toLowerCase() + ' ' + c.viewed_open + '</span><span><b style="color:#f59e0b">&#9632;</b> Not opened ' + c.not_opened + '</span>' + (c.excused ? '<span><b style="color:#777">&#9632;</b> Excused ' + c.excused + '</span>' : '') + '</div></div>' +
      '<div class="mm-tabs">' + tabs + '</div>' +
      '<div class="mm-filters" style="display:flex;gap:10px;padding:12px 16px;flex-wrap:wrap"><input placeholder="Search name&hellip;" value="' + esc(MM.q) + '" oninput="mmTrackQ(this.value)" style="flex:1;min-width:180px">' +
      '<select onchange="mmTrackCity(this.value)"><option value="">All locations</option>' + Object.keys(cityOpts).sort().map(function (k) { return '<option' + (k === MM.city ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select>' +
      '<select onchange="mmTrackRole(this.value)"><option value="">All roles</option>' + Object.keys(roleOpts).sort().map(function (k) { return '<option value="' + esc(k) + '"' + (k === MM.role ? ' selected' : '') + '>' + esc(roleOpts[k]) + '</option>'; }).join('') + '</select></div>' +
      '<div class="table-wrap" id="mm-trk-table"><table class="mm-trk"><thead><tr><th>Employee</th><th class="mm-hide">Location</th><th class="mm-hide">Delivered</th><th class="mm-hide">Viewed</th><th class="mm-hide">' + sigWord + '</th><th>Status</th><th></th></tr></thead><tbody>' +
      (shown.length ? shown.map(row).join('') : '<tr><td colspan="7" class="mm-mute" style="text-align:center;padding:24px">Nobody here.</td></tr>') + '</tbody></table></div>' +
      '<div style="padding:12px 20px" class="mm-mute">Showing ' + shown.length + ' of ' + c.total + '</div></div>' +
      '<div class="card"><div class="card-header" style="flex-wrap:wrap;gap:6px"><div class="card-title">The memo as sent</div><span class="mm-hash">fingerprint ' + esc(String(m.content_hash || '').slice(0, 4)) + '&hellip;' + esc(String(m.content_hash || '').slice(-4)) + ' &middot; every signature is tied to exactly this</span></div>' +
      '<div class="card-body" style="padding:18px 20px">' +
      (m.note ? '<p class="mm-note">' + esc(m.note) + '</p>' : '') + (m.body ? '<div class="mm-body">' + esc(m.body) + '</div>' : '') +
      (m.has_file ? '<div class="mm-file"><div class="ic">PDF</div><div style="flex:1;min-width:0"><b>' + esc(m.file_name) + '</b><small>' + plural(m.file_pages || 0, 'page') + ' &middot; read to the last page by ' + c.reached_end + ' of ' + need + '</small></div><button class="btn btn-secondary btn-sm" onclick="mmOpenPdf(' + m.id + ')">Open</button></div><div class="mm-thumbs" id="mm-trk-thumbs"></div>' : '') +
      '<div class="mm-mute" style="margin-top:12px">' + esc(m.ack_text) + '</div></div></div>' +
      '<div class="card"><div class="card-header"><div class="card-title">History</div></div><div class="card-body" style="padding:12px 20px">' +
      (t.events.length ? t.events.slice(0, MM.allHistory ? 200 : 12).map(function (e) {
        var who = e.user_id ? (recs.filter(function (r) { return r.user_id === e.user_id; })[0] || {}).user_name : null;
        return '<div style="display:flex;gap:10px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--border-light)"><span class="mm-when" style="min-width:120px">' + fmtWhen(e.created_at) + '</span><span style="color:var(--text-dim)">' + esc(eventText(e, who)) + '</span></div>';
      }).join('') + (!MM.allHistory && t.events.length > 12 ? '<div style="padding-top:10px"><a style="cursor:pointer;color:var(--primary);font-size:13px" onclick="mmAllHistory()">Show all ' + t.events.length + '</a></div>' : '') : '<span class="mm-mute">Nothing yet.</span>') + '</div></div>';
  }

  function eventText(e, who) {
    var d = e.detail || {};
    var actor = e.actor_name || 'Nova';
    switch (e.action) {
      case 'created': return actor + ' started the draft' + (d.revision_of ? ' (revision of ' + d.revision_of + ')' : '');
      case 'file_attached': return actor + ' attached ' + (d.name || 'a PDF');
      case 'sent': return actor + ' sent it to ' + plural(d.recipients || 0, 'person', 'people');
      case 'viewed': return (who || actor) + ' opened it';
      case 'read_to_end': return (who || actor) + ' read to the end';
      case 'signed': return (who || actor) + ' signed' + (d.device ? ' on ' + d.device : '');
      case 'acknowledged': return (who || actor) + ' acknowledged it';
      case 'reminded': return (d.automatic ? 'Automatic reminder to ' : actor + ' reminded ') + (who ? who : plural(d.count || 0, 'person', 'people'));
      case 'excused': return actor + ' excused ' + (who || 'someone') + ': ' + (d.reason || '');
      case 'unexcused': return actor + ' un-excused ' + (who || 'someone');
      case 'withdrawn': return actor + ' withdrew it: ' + (d.reason || '');
      case 'superseded': return 'Replaced by ' + (d.by || 'a revision');
      case 'added_late': return (who || 'A new hire') + ' was added after finishing onboarding';
      case 'exported_copy': return actor + ' downloaded ' + (who ? who + '&#39;s' : 'a') + ' signed copy';
      case 'exported_all': return actor + ' downloaded all signed copies';
      default: return actor + ' ' + String(e.action || '').replace(/_/g, ' ');
    }
  }

  async function drawTrackerThumbs() {
    var host = el('mm-trk-thumbs');
    if (!host || !MM.tracker || !MM.tracker.memo.has_file) return;
    try {
      var f = await api('GET', API + '/' + MM.tracker.memo.id + '/file');
      host.innerHTML = '';
      await renderPdfInto(host, b64ToBytes(f.data), { maxPages: 6, width: 300 });
    } catch (e) { host.innerHTML = ''; }
  }

  window.mmAllHistory = function () { MM.allHistory = true; drawTracker(content()); drawTrackerThumbs(); };
  window.mmTrackTab = function (k) { MM.tab = k; drawTracker(content()); drawTrackerThumbs(); };
  window.mmTrackQ = function (v) { MM.q = v || ''; var t = el('mm-trk-table'); drawTracker(content()); drawTrackerThumbs(); var inp = content().querySelector('input'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } };
  window.mmTrackCity = function (v) { MM.city = v || ''; drawTracker(content()); drawTrackerThumbs(); };
  window.mmTrackRole = function (v) { MM.role = v || ''; drawTracker(content()); drawTrackerThumbs(); };

  async function reloadTracker() { var id = MM.tracker.memo.id; MM.tracker = await api('GET', API + '/' + id); drawTracker(content()); drawTrackerThumbs(); }

  window.mmRemind = async function (ids) {
    var m = MM.tracker.memo;
    if (!ids && !(await novaConfirm('Send a reminder to everyone who has not ' + (m.require_signature ? 'signed' : 'confirmed') + ' yet?', { okText: 'Send reminders' }))) return;
    try {
      var r = await api('POST', API + '/' + m.id + '/remind', ids ? { user_ids: ids } : {});
      toast('Reminded ' + plural(r.reminded, 'person', 'people') + '.', 'success');
      await reloadTracker();
    } catch (e) { toast(e.message || 'Could not send the reminder.', 'error'); }
  };
  window.mmExcuse = async function (uid) {
    var r = (MM.tracker.recipients.filter(function (x) { return x.user_id === uid; })[0] || {});
    var reason = await novaPrompt('Why is ' + (r.user_name || 'this person') + ' excused? (for example: on leave until Nov 2). They stop being reminded and locked.', '', { title: 'Excuse', okText: 'Excuse' });
    if (reason == null) return;
    if (!String(reason).trim()) { toast('Give a reason.', 'error'); return; }
    try { await api('POST', API + '/' + MM.tracker.memo.id + '/recipients/' + uid + '/excuse', { reason: reason }); await reloadTracker(); }
    catch (e) { toast(e.message || 'Could not excuse.', 'error'); }
  };
  window.mmUnexcuse = async function (uid) {
    try { await api('DELETE', API + '/' + MM.tracker.memo.id + '/recipients/' + uid + '/excuse'); await reloadTracker(); }
    catch (e) { toast(e.message || 'Could not undo.', 'error'); }
  };
  window.mmCopy = function (memoId, uid) { return download(API + '/' + memoId + '/recipients/' + uid + '/pdf'); };
  window.mmReport = function () { return download(API + '/' + MM.tracker.memo.id + '/report'); };
  window.mmAllCopies = function () { toast('Building the PDF…', 'info'); return download(API + '/' + MM.tracker.memo.id + '/signed-copies'); };
  window.mmOpenPdf = async function (memoId, mine) {
    modal('Document', '<div class="mm-pages" id="mm-pdf-modal" style="max-height:72vh;overflow:auto"><div class="mm-mute" style="color:#ddd">Loading…</div></div>', '<button class="btn btn-secondary" onclick="mmCloseModal()">Close</button>', 820);
    try {
      var f = await api('GET', mine ? (API + '/me/' + memoId + '/file') : (API + '/' + memoId + '/file'));
      var host = el('mm-pdf-modal'); host.innerHTML = '';
      await renderPdfInto(host, b64ToBytes(f.data));
    } catch (e) { var h = el('mm-pdf-modal'); if (h) h.innerHTML = '<div style="color:#fca5a5">' + esc(e.message || 'Could not open the document.') + '</div>'; }
  };
  window.mmMore = function () {
    modal('More', '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<button class="btn btn-secondary" style="justify-content:flex-start" onclick="mmRevise()"><b>Revise and resend</b>&nbsp;&nbsp;<span class="mm-mute">fix it, everyone signs again</span></button>' +
      '<button class="btn btn-secondary" style="justify-content:flex-start" onclick="mmWithdraw()"><b>Withdraw</b>&nbsp;&nbsp;<span class="mm-mute">stop it, release the lock, keep every record</span></button></div>', '<button class="btn btn-ghost" onclick="mmCloseModal()">Close</button>', 460);
  };
  window.mmRevise = async function () {
    closeModal();
    try { var r = await api('POST', API + '/' + MM.tracker.memo.id + '/revise'); navigate('memo-edit', r.memo.id); }
    catch (e) { toast(e.message || 'Could not start a revision.', 'error'); }
  };
  window.mmWithdraw = async function () {
    closeModal();
    var reason = await novaPrompt('Why is this memo being withdrawn? Nobody will be locked or reminded after this, and every record is kept.', '', { title: 'Withdraw memo', okText: 'Withdraw' });
    if (reason == null) return;
    if (!String(reason).trim()) { toast('Give a reason.', 'error'); return; }
    try { await api('POST', API + '/' + MM.tracker.memo.id + '/withdraw', { reason: reason }); toast('Withdrawn.', 'info'); await reloadTracker(); }
    catch (e) { toast(e.message || 'Could not withdraw.', 'error'); }
  };

  // ======================================================================
  //  READER - one memo, for the person it was sent to.
  //  Used by the lock screen, by My Memo inside the shell, and by Preview.
  // ======================================================================
  function drawReader(host, m, opts) {
    opts = opts || {};
    var mine = m.my || {};
    var done = !!mine.completed_at;
    var needEnd = !!(m.has_file || m.body);
    var reached = !!mine.reached_end_at || !needEnd;
    var live = m.status === 'sent' && !done && !mine.excused_at && !opts.preview;
    MM.reader = { memo: m, opts: opts, reached: reached, pad: null };

    var status = '';
    if (done) status = '<div class="alert alert-success" style="margin-bottom:14px">You ' + (mine.completion === 'acknowledged' ? 'confirmed you read this' : 'signed this') + ' ' + esc(fmtWhen(mine.completed_at)) + '. A copy is in your file.</div>';
    else if (m.status === 'superseded') status = '<div class="alert alert-info" style="margin-bottom:14px">This memo was replaced by a newer version. You do not need to sign this one.</div>';
    else if (m.status === 'withdrawn') status = '<div class="alert alert-info" style="margin-bottom:14px">This memo was withdrawn. You do not need to do anything.</div>';

    var ack = '';
    if (live || opts.preview) {
      ack = '<div class="mm-endmark' + (reached ? ' done' : '') + '" id="mm-endmark">' + (needEnd ? (reached ? '&#10003; You reached the end' : 'Scroll to the end to ' + (m.require_signature ? 'sign' : 'confirm')) : '') + '</div>' +
        '<div class="mm-signarea' + (reached ? '' : ' off') + '" id="mm-signarea">' +
        '<div class="mm-ack">' + esc(m.ack_text) + '</div>' +
        (m.require_signature
          ? '<div style="margin-top:16px"><span class="mm-label">Type your full name</span><input id="mm-typed" maxlength="160" autocomplete="name" style="width:100%" placeholder="' + esc((state.user && state.user.name) || '') + '"></div>' +
            '<div style="margin-top:14px"><span class="mm-label" style="display:flex;justify-content:space-between">Sign below <a style="color:var(--primary);cursor:pointer;font-weight:500" onclick="mmClearPad()">Clear</a></span>' +
            '<div class="mm-pad" id="mm-pad"><canvas id="mm-canvas"></canvas></div></div>' +
            '<button class="btn btn-primary" id="mm-sign-btn" style="width:100%;justify-content:center;margin-top:16px;padding:13px;font-size:15px" onclick="mmSignNow()">' + (opts.lock ? 'Sign and unlock Nova' : 'Sign') + '</button>'
          : '<button class="btn btn-primary" id="mm-sign-btn" style="width:100%;justify-content:center;margin-top:16px;padding:13px;font-size:15px" onclick="mmAckNow()">' + (opts.lock ? 'I have read this, unlock Nova' : 'I have read this') + '</button>') +
        '</div>';
    }
    var copyBtn = done ? '<button class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="mmMyCopy(' + m.id + ')">' + ICON.dl + (mine.completion === 'acknowledged' ? ' Download my copy' : ' Download my signed copy') + '</button>' : '';

    host.innerHTML =
      '<div class="card" style="padding:20px;margin-bottom:0">' +
      '<div class="mm-memohead"><span>' + esc(m.memo_no || '') + ' &middot; ' + esc(m.type || '') + '</span><span>' + (m.sign_by ? 'Sign by ' + esc(fmtDate(m.sign_by)) : '') + '</span></div>' +
      '<div class="mm-memotitle">' + esc(m.title) + '</div>' +
      '<div class="mm-from"><span>From</span><span>' + esc(m.sent_by_name || '') + '</span><span>To</span><span>' + esc(m.audience_label === 'Everyone' ? 'All employees' : ((state.user && state.user.name) || '')) + '</span>' +
      '<span>Date</span><span>' + esc(fmtDate(m.sent_at)) + '</span>' + (m.effective_date ? '<span>Effective</span><span>' + esc(fmtDate(m.effective_date)) + '</span>' : '') + '</div>' +
      status +
      (m.note ? '<p class="mm-note">' + esc(m.note) + '</p>' : '') +
      (m.body ? '<div class="mm-body">' + esc(m.body) + '</div>' : '') +
      (m.has_file ? '<div class="mm-pages" id="mm-reader-pages"><div class="mm-pgbar"><span>' + esc(m.file_name) + ' &middot; ' + plural(m.file_pages || 0, 'page') + '</span><a onclick="mmOpenPdf(' + m.id + ',' + (opts.preview ? 'false' : 'true') + ')">Full screen</a></div><div id="mm-reader-canvas" style="width:100%;display:flex;flex-direction:column;gap:12px;align-items:center"><div style="color:#ddd;font-size:13px">Loading the document…</div></div></div>' : '') +
      '<div id="mm-end-sentinel" style="height:1px"></div>' +
      ack + copyBtn +
      (opts.lock ? '<div style="display:flex;justify-content:center;gap:6px;margin-top:14px" class="mm-mute">' + ICON.clock + '<span>Need to clock in or out first? <a style="color:var(--primary);cursor:pointer" onclick="mmClockPass()">Open the time clock</a></span></div>' : '') +
      '</div>';

    if (!opts.preview && !done) api('POST', API + '/me/' + m.id + '/view').catch(function () {});
    if (m.has_file) loadReaderPdf(m, opts);
    else armEnd(m, opts);
    if (live && m.require_signature) setTimeout(setupPad, 40);
  }

  async function loadReaderPdf(m, opts) {
    var host = el('mm-reader-canvas');
    try {
      var f = await api('GET', opts.preview ? (API + '/' + m.id + '/file') : (API + '/me/' + m.id + '/file'));
      if (!el('mm-reader-canvas')) return;
      host.innerHTML = '';
      await renderPdfInto(host, b64ToBytes(f.data));
    } catch (e) {
      // pdf.js unavailable (offline CDN) or a broken file: fall back to opening
      // it in the phone's own viewer. Opening it counts as reaching the end.
      if (host) host.innerHTML = '<div style="color:#ddd;font-size:13px;text-align:center">The document could not be shown here. ' +
        '<a style="color:#fdba74;cursor:pointer" onclick="mmOpenExternal(' + m.id + ')">Open it</a> instead.</div>';
    }
    armEnd(m, opts);
  }
  window.mmOpenExternal = async function (id) {
    try {
      var f = await api('GET', API + '/me/' + id + '/file');
      var blob = new Blob([b64ToBytes(f.data)], { type: 'application/pdf' });
      window.open(URL.createObjectURL(blob), '_blank');
      markEnd();
    } catch (e) { toast(e.message || 'Could not open it.', 'error'); }
  };

  function armEnd(m, opts) {
    if (!MM.reader || MM.reader.reached) return;
    var s = el('mm-end-sentinel');
    if (!s) return;
    if (!('IntersectionObserver' in window)) { markEnd(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { io.disconnect(); markEnd(); } });
    }, { root: null, threshold: 0 });
    io.observe(s);
  }
  function markEnd() {
    if (!MM.reader || MM.reader.reached) return;
    MM.reader.reached = true;
    var mk = el('mm-endmark'); if (mk) { mk.className = 'mm-endmark done'; mk.innerHTML = '&#10003; You reached the end'; }
    var sa = el('mm-signarea'); if (sa) sa.className = 'mm-signarea';
    if (!MM.reader.opts.preview) api('POST', API + '/me/' + MM.reader.memo.id + '/end').catch(function () {});
  }

  function setupPad() {
    var wrap = el('mm-pad'), c = el('mm-canvas');
    if (!wrap || !c) return;
    c.width = wrap.clientWidth * 2; c.height = wrap.clientHeight * 2;
    var ctx = c.getContext('2d');
    ctx.scale(2, 2);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    var drawing = false, empty = true;
    function pos(e) { var r = c.getBoundingClientRect(); var p = (e.touches && e.touches[0]) || e; return { x: p.clientX - r.left, y: p.clientY - r.top }; }
    function start(e) { drawing = true; empty = false; var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); }
    function move(e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); }
    function stop() { drawing = false; }
    c.addEventListener('mousedown', start); c.addEventListener('mousemove', move); window.addEventListener('mouseup', stop);
    c.addEventListener('touchstart', start, { passive: false }); c.addEventListener('touchmove', move, { passive: false }); c.addEventListener('touchend', stop);
    if (MM.reader) MM.reader.pad = { canvas: c, isEmpty: function () { return empty; }, clear: function () { ctx.clearRect(0, 0, c.width, c.height); empty = true; } };
  }
  window.mmClearPad = function () { if (MM.reader && MM.reader.pad) MM.reader.pad.clear(); };

  async function afterDone() {
    var r = MM.reader;
    state._memoLock = undefined;
    if (typeof apiBustCache === 'function') apiBustCache();
    if (r && r.opts.lock) { state._memoLockShowing = false; toast('Thanks. Nova is unlocked.', 'success'); render(); return; }
    toast('Done. A copy is in your file.', 'success');
    if (state.currentView === 'my-memo') window.renderMyMemo(content(), r.memo.id);
  }
  window.mmSignNow = async function () {
    var r = MM.reader; if (!r) return;
    var typed = String((el('mm-typed') || {}).value || '').trim();
    if (typed.length < 2) { toast('Type your full name.', 'error'); return; }
    if (!r.pad || r.pad.isEmpty()) { toast('Sign in the box.', 'error'); return; }
    var b = el('mm-sign-btn'); if (b) { b.disabled = true; b.textContent = 'Signing…'; }
    try {
      await api('POST', API + '/me/' + r.memo.id + '/sign', { typed_name: typed, signature_data: r.pad.canvas.toDataURL('image/png') });
      await afterDone();
    } catch (e) {
      if (b) { b.disabled = false; b.textContent = r.opts.lock ? 'Sign and unlock Nova' : 'Sign'; }
      if (e.data && e.data.need_end) { r.reached = false; armEnd(r.memo, r.opts); }
      toast(e.message || 'Could not record your signature.', 'error');
    }
  };
  window.mmAckNow = async function () {
    var r = MM.reader; if (!r) return;
    var b = el('mm-sign-btn'); if (b) b.disabled = true;
    try { await api('POST', API + '/me/' + r.memo.id + '/acknowledge'); await afterDone(); }
    catch (e) { if (b) b.disabled = false; toast(e.message || 'Could not record it.', 'error'); }
  };
  window.mmMyCopy = function (id) { return download(API + '/me/' + id + '/pdf'); };

  // ---- one memo inside the shell (email / banner links land here) ----
  window.renderMyMemo = async function (host, id) {
    injectCss();
    host.innerHTML = '<div class="loading">Loading…</div>';
    var d;
    try { d = await api('GET', API + '/me/' + id); }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not open that memo.') + '</div>'; return; }
    host.innerHTML = '<div class="mm-read" style="padding:0 0 30px" id="mm-reader-host"></div>';
    drawReader(el('mm-reader-host'), d.memo, {});
  };

  // ======================================================================
  //  THE LOCK
  // ======================================================================
  // Called by app.js render() right after the onboarding gate. Returns true
  // when it has taken over the screen.
  window.memoGate = async function (app) {
    if (!state.user || !state.token || state.viewAs || state.viewAsId) return false;
    if (state._memoLock === undefined) {
      try { var r = await api('GET', API + '/me/lock'); state._memoLock = r.memo || null; }
      catch (e) { state._memoLock = null; }
    }
    if (!state._memoLock) { state._memoLockShowing = false; return false; }
    // The time clock is the one screen allowed through. Anything else ends the pass.
    if (state._memoClockPass && state.currentView === 'timeclock') return false;
    state._memoClockPass = false;
    injectCss();
    app.className = 'no-sidebar';
    state._memoLockShowing = true;
    var m = state._memoLock;
    app.innerHTML = '<div style="min-height:100vh;width:100%;background:var(--bg)">' +
      '<div class="mm-lockbar">' + ICON.lock.replace(/14/g, '18') + '<span>Nova is locked until you ' + (m.require_signature ? 'sign' : 'read') + ' this memo. It takes about a minute.</span></div>' +
      '<div class="mm-read" id="mm-lock-host"></div>' +
      '<div style="text-align:center;padding:0 16px 30px"><a class="mm-mute" style="cursor:pointer" onclick="logout()">Sign out</a></div></div>';
    drawReader(el('mm-lock-host'), m, { lock: true });
    return true;
  };
  window.mmClockPass = function () {
    state._memoClockPass = true;
    state._memoLockShowing = false;
    navigate('timeclock');
    setTimeout(function () {
      var c = content();
      if (c && !el('mm-clock-back')) {
        var bar = document.createElement('div');
        bar.id = 'mm-clock-back';
        bar.className = 'mm-banner';
        bar.innerHTML = '<div style="color:#fdba74">' + ICON.memo + '</div><div style="flex:1"><b>A memo is still waiting for you</b><p>Clock in or out here, then go back and ' + (state._memoLock && state._memoLock.require_signature ? 'sign' : 'read') + ' it to unlock the rest of Nova.</p>' +
          '<button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="mmBackToMemo()">Back to the memo</button></div>';
        c.insertBefore(bar, c.firstChild);
      }
    }, 400);
  };
  window.mmBackToMemo = function () { state._memoClockPass = false; render(); };

  // app.js _apiFetch calls this on any 403 { memo_lock }. A memo arrived (or a
  // lock date passed) while the app was open: forget what we knew and redraw,
  // which puts the lock screen up. Ignored while it is already up, and while
  // the person is on their time-clock pass, so background polls cannot loop.
  window.memoHandleLock = function (data) {
    if (state._memoLockShowing || state._memoClockPass) return;
    if (state._memoHandling) return;
    state._memoHandling = true;
    try { if (typeof invDraftSave === 'function') invDraftSave(true); } catch (e) {}
    state._memoLock = undefined;
    setTimeout(function () { state._memoHandling = false; render(); }, 0);
  };

  // ======================================================================
  //  HOOKS: Home banner, My File, Employee Files
  // ======================================================================
  var origHome = window.renderHomeScreen;
  if (typeof origHome === 'function') {
    window.renderHomeScreen = async function (host) {
      var out = await origHome.apply(this, arguments);
      try {
        var d = await api('GET', API + '/me/pending');
        var list = (d.memos || []).filter(function (m) { return m.my && m.my.open; });
        if (list.length && host && host.isConnected !== false) {
          injectCss();
          var box = document.createElement('div');
          box.id = 'mm-home-banners';
          box.innerHTML = list.slice(0, 3).map(function (m) {
            return '<div class="mm-banner"><div style="color:#fdba74;margin-top:2px">' + ICON.memo + '</div><div style="flex:1"><b>New memo: ' + esc(m.title) + '</b>' +
              '<p>From ' + esc(m.sent_by_name || 'Nova') + '. Please ' + (m.require_signature ? 'read and sign it' : 'read it and tap &quot;I have read this&quot;') + (m.sign_by ? ' by ' + esc(fmtDate(m.sign_by)) : '') + '.</p>' +
              '<button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="navigate(\'my-memo\',' + m.id + ')">Read memo</button></div></div>';
          }).join('');
          var old = el('mm-home-banners'); if (old && old.parentNode) old.parentNode.removeChild(old);
          host.insertBefore(box, host.firstChild);
        }
      } catch (e) {}
      return out;
    };
  }

  function copyLabel(my) { return my.completion === 'acknowledged' ? ' Copy (PDF)' : ' Signed copy (PDF)'; }
  function memoCardsHtml(list, forUid) {
    return list.map(function (m) {
      var my = m.my || {};
      var st = my.completed_at ? pill('g', my.completion === 'acknowledged' ? 'Acknowledged' : 'Signed') :
        (my.excused_at ? pill('m', 'Excused') : (m.status === 'sent' ? pill('a', m.require_signature ? 'Waiting for signature' : 'Waiting') : pill('m', m.status === 'superseded' ? 'Replaced' : 'Withdrawn')));
      var meta = ['Delivered ' + fmtWhen(my.delivered_at)];
      if (my.first_viewed_at) meta.push('Viewed ' + plural(my.view_count || 1, 'time'));
      if (my.completed_at) meta.push((my.completion === 'acknowledged' ? 'Acknowledged ' : 'Signed ') + fmtWhen(my.completed_at));
      var acts = forUid
        ? (my.completed_at ? '<button class="btn btn-secondary btn-sm" onclick="mmUserCopy(' + forUid + ',' + m.id + ')">' + ICON.dl + copyLabel(my) + '</button>' : '')
        : ((my.open ? '<button class="btn btn-primary btn-sm" onclick="navigate(\'my-memo\',' + m.id + ')">' + (m.require_signature ? 'Read and sign' : 'Read') + '</button>' : '<button class="btn btn-secondary btn-sm" onclick="navigate(\'my-memo\',' + m.id + ')">View memo</button>') +
          (my.completed_at ? ' <button class="btn btn-secondary btn-sm" onclick="mmMyCopy(' + m.id + ')">' + ICON.dl + copyLabel(my) + '</button>' : ''));
      return '<div class="mm-memocard"><div class="t"><span>Memo: ' + esc(m.title) + '</span><span>' + pill('v', 'Memo') + ' ' + st + '</span></div>' +
        '<div class="m"><span>' + esc(m.memo_no || '') + '</span>' + (m.file_name ? '<span>&middot; ' + esc(m.file_name) + '</span>' : '') + (m.effective_date ? '<span>&middot; effective ' + esc(fmtDate(m.effective_date)) + '</span>' : '') + '</div>' +
        '<div class="m">' + meta.map(esc).join(' &middot; ') + '</div>' + (acts ? '<div class="a">' + acts + '</div>' : '') + '</div>';
    }).join('');
  }
  window.mmUserCopy = function (uid, memoId) { return download(API + '/user/' + uid + '/' + memoId + '/pdf'); };

  var origMyFile = window.renderMyFile;
  if (typeof origMyFile === 'function') {
    window.renderMyFile = async function (host) {
      var out = await origMyFile.apply(this, arguments);
      try {
        var d = await api('GET', API + '/me');
        var list = d.memos || [];
        if (list.length && host) {
          injectCss();
          var card = document.createElement('div');
          card.className = 'card';
          card.id = 'mm-myfile';
          card.style.marginBottom = '16px';
          card.innerHTML = '<div class="card-header"><div class="card-title">Memos</div></div><div class="card-body">' + memoCardsHtml(list, null) + '</div>';
          var old = el('mm-myfile'); if (old && old.parentNode) old.parentNode.removeChild(old);
          host.insertBefore(card, host.firstChild);
        }
      } catch (e) {}
      return out;
    };
  }

  var origOpenFile = window.onbOpenFile;
  if (typeof origOpenFile === 'function') {
    window.onbOpenFile = async function (id, opts) {
      var out = await origOpenFile.apply(this, arguments);
      try {
        var d = await api('GET', API + '/user/' + id);
        var body = el('onb-ef-body');
        var list = d.memos || [];
        if (body && list.length) {
          injectCss();
          var card = document.createElement('div');
          card.id = 'mm-userfile';
          card.style.margin = '0 0 16px';
          card.innerHTML = '<h3 style="font-size:15px;margin:0 0 10px">Memos</h3>' + memoCardsHtml(list, id);
          var old = el('mm-userfile'); if (old && old.parentNode) old.parentNode.removeChild(old);
          var anchor = body.querySelector('.onb-doc-toolbar');
          if (anchor) body.insertBefore(card, anchor); else body.insertBefore(card, body.firstChild);
        }
      } catch (e) { /* 403 = not allowed to see this file's memos; the documents still show */ }
      return out;
    };
  }

  // Exposed for tests.
  window._mm = { MM: MM, drawReader: drawReader, markEnd: markEnd, tabMatch: tabMatch, sendProblems: sendProblems, formFrom: formFrom, payload: payload };
})();
