// Employee Records - the structured half of Employee Files.
//
// Loaded AFTER js/onboarding.js on purpose. onboarding.js owns the documents
// half of the employee file (encrypted HR docs) and defines
// window.renderEmployeeFiles / window.onbOpenFile / window.renderMyFile. This
// file wraps those three rather than editing them:
//
//   * renderEmployeeFiles - replaced with the roster + timeline UI, but ONLY for
//     someone holding view_employee_records. Anyone else falls straight through
//     to the original documents-only page, so nothing a manager sees today
//     changes until an admin ticks the box in Roles & Access.
//   * renderMyFile        - wrapped. The shared records render above, then the
//     original My Documents list renders into a child div underneath.
//   * renderHomeScreen    - wrapped, to fill the Recent Wins placeholder.
//
// No backticks anywhere in this file (Windows corrupts them in .js).
(function () {
  'use strict';

  var API = '/employee-records';

  // ------------------------------------------------------------------ state
  var S = {
    view: 'roster',     // roster | file | disciplinary | approve | followup
    employeeId: null,
    recordId: null,
    file: null,
    roster: null,
    meta: null,
    draft: null,
    check: null,
    policy: null,
    // Files picked in the New Record modal, which has no record id yet. They are
    // held here and uploaded the moment the note comes back with one.
    queue: [],
    busy: false
  };

  var TYPE_META = {
    recognition: { label: 'Recognition', dot: '+', cls: 'pos', accent: '#22c55e' },
    coaching: { label: 'Coaching note', dot: '~', cls: 'coach', accent: '#f59e0b' },
    performance: { label: 'Performance note', dot: 'i', cls: 'note', accent: '#60a5fa' },
    disciplinary: { label: 'Disciplinary action', dot: '!', cls: 'neg', accent: '#ef4444' }
  };

  var STATUS_BADGE = {
    draft: ['badge-draft', 'Draft'],
    returned: ['badge-waiting', 'Sent back'],
    pending_approval: ['badge-waiting', 'Pending approval'],
    sent: ['badge-awaiting-signature', 'Awaiting signature'],
    signed: ['badge-signed', 'Signed'],
    refused: ['badge-rejected', 'Refused'],
    expired: ['badge-rejected', 'Expired'],
    closed: ['badge-completed', 'Closed'],
    void: ['badge-void', 'Void'],
    active: ['', '']
  };

  function esc(s) { return (typeof escHtml === 'function') ? escHtml(s) : String(s === null || s === undefined ? '' : s); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t); }
  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value : ''; }
  function checked(id) { var e = el(id); return !!(e && e.checked); }
  function content() { return document.getElementById('content'); }

  function shortDate(d) {
    if (!d) return '';
    try { return (typeof formatDate === 'function') ? formatDate(d) : String(d).slice(0, 10); }
    catch (e) { return String(d).slice(0, 10); }
  }

  function relDays(d) {
    if (!d) return '';
    var then = new Date(d).getTime();
    if (!isFinite(then)) return '';
    var days = Math.floor((Date.now() - then) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30) return days + ' days ago';
    if (days < 60) return 'Last month';
    return Math.floor(days / 30) + ' months ago';
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    return ((parts[0] || '')[0] || '?').toUpperCase() + ((parts[1] || '')[0] || '').toUpperCase();
  }

  function badge(status) {
    var b = STATUS_BADGE[status];
    if (!b || !b[0]) return '';
    return '<span class="badge ' + b[0] + '">' + b[1] + '</span>';
  }

  // ------------------------------------------------------------------ files
  //
  // Supporting documentation. The bytes go browser -> R2 direct through a
  // presigned URL and never travel through Nova's API, the same way A/P bill
  // attachments and HR documents already work. Three calls: ask for a URL, PUT
  // the file, tell the server it landed.
  //
  // An attachment hangs off a record and inherits that record's visibility, so
  // anything attached to a shared notice is openable by the employee. The form
  // says so out loud, because "supporting documentation" is exactly where a
  // manager's private working notes would otherwise end up.
  var MAX_FILE_BYTES = 25 * 1024 * 1024;

  function fileSize(n) {
    if (n === null || n === undefined) return '';
    n = Number(n);
    if (!isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }

  function fileTag(name, type) {
    var nm = String(name || '');
    var ext = nm.indexOf('.') !== -1 ? nm.split('.').pop() : '';
    if (ext && ext.length <= 4) return ext.toUpperCase();
    if (String(type || '').indexOf('image/') === 0) return 'IMG';
    return 'DOC';
  }

  function pickFiles(cb) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.onchange = function () { cb(Array.prototype.slice.call(inp.files || [])); };
    inp.click();
  }

  // One file against a record that already exists. Never throws: a third file
  // that fails must not lose the two that already went up.
  async function uploadTo(recordId, file) {
    if (file.size > MAX_FILE_BYTES) {
      toast(file.name + ' is larger than 25MB. Attach a smaller copy.', 'error');
      return false;
    }
    var ctype = file.type || 'application/octet-stream';
    var pre;
    try {
      pre = await api('POST', API + '/' + recordId + '/attachments/upload-url',
        { filename: file.name, content_type: ctype, size_bytes: file.size });
    } catch (e) { toast(e.message || 'Could not start the upload.', 'error'); return false; }
    try {
      var put = await fetch(pre.url, { method: 'PUT', body: file, headers: { 'Content-Type': ctype } });
      if (!put.ok) throw new Error('storage returned ' + put.status);
    } catch (e) { toast('Upload failed: ' + (e.message || 'storage unreachable'), 'error'); return false; }
    try {
      await api('POST', API + '/' + recordId + '/attachments/confirm',
        { key: pre.key, filename: file.name, content_type: ctype, size_bytes: file.size });
    } catch (e) { toast(e.message || 'Could not save the attachment.', 'error'); return false; }
    return true;
  }

  // Sequential rather than parallel on purpose: these are photos off a phone on
  // a truck, and six concurrent PUTs on a bad connection is how all six fail.
  async function uploadAll(recordId, files) {
    var ok = 0;
    for (var i = 0; i < files.length; i++) {
      if (await uploadTo(recordId, files[i])) ok++;
    }
    if (ok) toast(ok + ' file' + (ok === 1 ? '' : 's') + ' attached.', 'success');
    return ok;
  }

  window.erOpenAttachment = async function (id) {
    try {
      var r = await api('GET', API + '/attachments/' + id + '/download');
      window.open(r.url, '_blank');
    } catch (e) { toast(e.message || 'Could not open that document.', 'error'); }
  };

  // Read-only chips, for the timeline and My File. Renders nothing when there is
  // nothing attached - an empty "Attachments" heading on every record would
  // just be noise on the 95% of records that have none.
  function attachChips(list) {
    if (!list || !list.length) return '';
    return '<div class="er-chips">' + list.map(function (a) {
      return '<div class="er-chip" onclick="erOpenAttachment(' + a.id + ')" title="' +
        esc(a.filename || '') + '"><span class="er-fic" style="width:18px;height:18px;font-size:8px">' +
        esc(fileTag(a.filename, a.content_type)) + '</span><b>' + esc(a.filename || 'Attachment') + '</b></div>';
    }).join('') + '</div>';
  }

  // The editable list, for a record you are still writing.
  function attachRows(list) {
    if (!list || !list.length) return '';
    return '<div class="er-files">' + list.map(function (a) {
      return '<div class="er-file">' +
        '<div class="er-fic">' + esc(fileTag(a.filename, a.content_type)) + '</div>' +
        '<div class="nm" onclick="erOpenAttachment(' + a.id + ')">' + esc(a.filename || 'Attachment') + '</div>' +
        '<div class="sz">' + esc(fileSize(a.size_bytes)) + '</div>' +
        '<div class="rm" title="Remove" onclick="erRemoveAttachment(' + a.id + ')">&#10005;</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  // The same list for files that are only picked, not uploaded yet.
  function queueRows() {
    var q = S.queue || [];
    if (!q.length) return '';
    return '<div class="er-files">' + q.map(function (f, i) {
      return '<div class="er-file">' +
        '<div class="er-fic">' + esc(fileTag(f.name, f.type)) + '</div>' +
        '<div class="nm plain">' + esc(f.name) + '</div>' +
        '<div class="sz">' + esc(fileSize(f.size)) + '</div>' +
        '<div class="rm" title="Remove" onclick="erUnqueue(' + i + ')">&#10005;</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  window.erQueueFiles = function () {
    pickFiles(function (files) {
      if (!files.length) return;
      S.queue = (S.queue || []).concat(files);
      var host = el('er-queue');
      if (host) host.innerHTML = queueRows();
    });
  };

  window.erUnqueue = function (i) {
    (S.queue || []).splice(i, 1);
    var host = el('er-queue');
    if (host) host.innerHTML = queueRows();
  };

  // Attach to a record that already exists, from the timeline.
  window.erAttachTo = function (id) {
    pickFiles(async function (files) {
      if (!files.length) return;
      if (await uploadAll(id, files)) window.erOpenFile(S.employeeId, S.tab);
    });
  };

  window.erRemoveAttachment = async function (aid) {
    if (!confirm('Remove this document from the record?')) return;
    try { await api('DELETE', API + '/attachments/' + aid, {}); }
    catch (e) { toast(e.message || 'Could not remove it.', 'error'); return; }
    toast('Removed.', 'info');
    if (S.view === 'disciplinary' && S.draft && S.draft.id) await refreshAttachments(S.draft.id);
    else window.erOpenFile(S.employeeId, S.tab);
  };

  async function refreshAttachments(id) {
    var host = el('er-attach-list');
    if (!host) return;
    try {
      var out = await api('GET', API + '/' + id + '/attachments');
      if (S.draft) S.draft.attachments = out.attachments || [];
      host.innerHTML = attachRows(out.attachments || []);
    } catch (e) { /* the list is cosmetic - the files are filed either way */ }
  }

  // ------------------------------------------------------------------ css
  var cssDone = false;
  function injectCss() {
    if (cssDone) return;
    cssDone = true;
    var st = document.createElement('style');
    st.textContent = [
      '.er-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:20px;flex-wrap:wrap}',
      '.er-tab{padding:10px 16px;font-size:14px;font-weight:500;color:var(--text-muted-color);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}',
      '.er-tab:hover{color:var(--text)}',
      '.er-tab.active{color:var(--primary);border-bottom-color:var(--primary);font-weight:600}',
      '.er-tab .er-c{font-size:11px;color:var(--text-muted-color);margin-left:5px}',
      '.er-tl{position:relative;padding-left:30px}',
      '.er-tl:before{content:"";position:absolute;left:9px;top:10px;bottom:10px;width:2px;background:var(--border)}',
      '.er-ev{position:relative;margin-bottom:14px}',
      '.er-dot{position:absolute;left:-30px;top:14px;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:3px solid var(--bg-card)}',
      '.er-dot.pos{background:#22c55e;color:#04240f}.er-dot.neg{background:#ef4444;color:#2d0505}',
      '.er-dot.coach{background:#f59e0b;color:#2d1c00}.er-dot.note{background:#60a5fa;color:#06182d}',
      '.er-card{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:13px 15px}',
      '.er-card.pos{border-left:3px solid #22c55e}.er-card.neg{border-left:3px solid #ef4444}',
      '.er-card.coach{border-left:3px solid #f59e0b}.er-card.note{border-left:3px solid #60a5fa}',
      '.er-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:5px;flex-wrap:wrap}',
      '.er-title{font-size:14px;font-weight:600;color:var(--text)}',
      '.er-body{font-size:13px;color:var(--text-dim);line-height:1.55;white-space:pre-wrap}',
      '.er-meta{font-size:12px;color:var(--text-muted-color);margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.er-meta .sep{opacity:.4}',
      '.er-eye{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px}',
      '.er-eye.on{background:#0d1e30;color:#60a5fa;border:1px solid #1e3a5f}',
      '.er-eye.off{background:#1a1a1a;color:#777;border:1px solid #2a2a2a}',
      '.er-acts{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}',
      '.er-ladder{display:flex;gap:5px}',
      '.er-step{flex:1;text-align:center;padding:8px 3px;border-radius:6px;font-size:10.5px;line-height:1.3;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text-muted-color)}',
      '.er-step.done{background:#2d2100;color:#f59e0b;border-color:#4a3500}',
      '.er-step.cur{background:#2d0d0d;color:#f87171;border-color:#4d1515;font-weight:700}',
      '.er-kv{display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid var(--border-light)}',
      '.er-kv:last-child{border-bottom:none}',
      '.er-kv span:first-child{color:var(--text-muted-color)}',
      '.er-kv span:last-child{color:var(--text);font-weight:600}',
      '.er-type{border:1px solid var(--border);background:var(--bg-elevated);border-radius:var(--radius);padding:11px 12px;cursor:pointer;text-align:left}',
      '.er-type.sel{border-color:var(--primary);background:rgba(249,115,22,0.10)}',
      '.er-type b{display:block;font-size:13px;color:var(--text);margin-bottom:2px}',
      '.er-type small{font-size:11px;color:var(--text-muted-color);line-height:1.4;display:block}',
      '.er-types{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '@media(max-width:640px){.er-types{grid-template-columns:1fr}}',
      '.er-toggle{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-elevated);cursor:pointer}',
      '.er-sw{width:38px;height:22px;border-radius:20px;background:#333;position:relative;flex-shrink:0;transition:background .15s}',
      '.er-sw:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#888;transition:left .15s,background .15s}',
      '.er-sw.on{background:rgba(249,115,22,.35)}.er-sw.on:after{left:19px;background:var(--primary)}',
      '.er-ai{border:1px solid #3b1f6e;background:#150c26;border-radius:var(--radius);padding:12px 14px;margin-top:10px}',
      '.er-ai.clear{border-color:#134d27;background:#0b1c12}',
      '.er-ai h5{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:#c084fc;font-weight:700;margin-bottom:9px}',
      '.er-ai.clear h5{color:#4ade80}',
      '.er-flag{display:flex;gap:9px;padding:8px 0;border-top:1px solid rgba(255,255,255,.06);font-size:12.5px;line-height:1.55;color:var(--text-dim)}',
      '.er-flag:first-of-type{border-top:none;padding-top:0}',
      '.er-flag b{color:var(--text)}',
      '.er-fdot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex-shrink:0}',
      '.er-fdot.red{background:#ef4444}.er-fdot.amber{background:#f59e0b}.er-fdot.green{background:#22c55e}',
      '.er-sugg{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:11px 13px;margin-top:10px;font-size:12.5px;line-height:1.6;color:var(--text-dim)}',
      '.er-bar{height:7px;border-radius:4px;background:var(--bg-elevated);overflow:hidden;margin:9px 0 6px}',
      '.er-bar i{display:block;height:100%;background:var(--warning)}',
      '.er-two{display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start}',
      '@media(max-width:1000px){.er-two{grid-template-columns:1fr}}',
      '.er-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}',
      '.er-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
      '@media(max-width:640px){.er-grid3,.er-grid2{grid-template-columns:1fr}}',
      '.er-row{cursor:pointer}',
      '.er-spark{display:flex;align-items:flex-end;gap:3px;height:44px;margin:12px 0 6px}',
      '.er-sb{flex:1;min-width:4px;border-radius:2px 2px 0 0;background:var(--bg-elevated);position:relative}',
      '.er-sb.hit{background:var(--warning)}',
      '.er-sblab{display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-muted-color)}',
      '.er-row:hover td{background:rgba(249,115,22,0.06)}',
      '.er-nav-count{display:inline-block;min-width:18px;padding:0 5px;margin-left:7px;border-radius:9px;background:var(--warning,#f59e0b);color:#2d1c00;font-size:11px;font-weight:800;line-height:18px;text-align:center;vertical-align:middle}',
      '.er-notice{border-color:#4a3500}',
      '.er-notice-dot{width:34px;height:34px;border-radius:50%;background:#f59e0b;color:#2d1c00;font-size:19px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
      '.er-win{display:flex;gap:12px;padding:13px 0;border-bottom:1px solid var(--border-light)}',
      '.er-win:last-child{border-bottom:none}',
      '.er-win .who{font-size:13.5px;font-weight:600;color:var(--text)}',
      '.er-win .cat{font-size:12px;color:var(--text-muted-color)}',
      '.er-win .lab{font-size:12px;font-weight:600;color:var(--text-muted-color)}',
      '.er-win .txt{font-size:13px;color:var(--text-dim);line-height:1.55;margin-top:4px;white-space:pre-wrap}',
      '.er-city{font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--text-muted-color);border:1px solid var(--border);border-radius:4px;padding:1px 5px;margin-left:6px;vertical-align:middle}',
      '.er-win .by{font-size:11.5px;color:var(--text-muted-color);margin-top:6px}',
      '.er-win .by b{color:var(--text-dim);font-weight:600}',
      '.er-so{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-elevated);padding:14px 16px;margin-bottom:12px}',
      '.er-so-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:7px}',
      '.er-so-body{font-size:13px;color:var(--text-dim);line-height:1.55;white-space:pre-wrap}',
      '.er-so-meta{font-size:11.5px;color:var(--text-muted-color);margin-top:9px}',
      '.er-so-st{font-size:10.5px;font-weight:800;letter-spacing:.06em;padding:2px 8px;border-radius:20px;text-transform:uppercase}',
      '.er-so-st.pending{background:#2d2100;color:#f59e0b}',
      '.er-so-st.approved{background:#0b1c12;color:#4ade80}',
      '.er-so-st.declined{background:#1a1a1a;color:#8a8a8a}',
      '.er-you{font-size:10px;font-weight:800;letter-spacing:.08em;background:rgba(249,115,22,.16);color:var(--primary);border:1px solid rgba(249,115,22,.4);padding:1px 6px;border-radius:4px;margin-left:7px;vertical-align:middle}',
      '.er-pad{background:#fff;border-radius:6px;height:130px;position:relative;overflow:hidden;touch-action:none;cursor:crosshair}',
      '.er-pad canvas{display:block;width:100%;height:100%}',
      '.er-files{display:flex;flex-direction:column;gap:6px;margin:9px 0}',
      '.er-file{display:flex;align-items:center;gap:9px;padding:8px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);font-size:12.5px}',
      '.er-file .nm{color:var(--text);font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
      '.er-file .nm:hover{color:var(--primary);text-decoration:underline}',
      '.er-file .nm.plain{cursor:default}.er-file .nm.plain:hover{color:var(--text);text-decoration:none}',
      '.er-file .sz{color:var(--text-muted-color);font-size:11px;white-space:nowrap}',
      '.er-file .rm{color:var(--text-muted-color);cursor:pointer;font-size:13px;padding:0 3px;flex-shrink:0}',
      '.er-file .rm:hover{color:#f87171}',
      '.er-fic{width:24px;height:24px;border-radius:5px;background:var(--bg-card);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:var(--text-muted-color);flex-shrink:0}',
      '.er-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}',
      '.er-chip{display:inline-flex;align-items:center;gap:6px;max-width:240px;padding:3px 10px;border-radius:20px;background:var(--bg-elevated);border:1px solid var(--border);font-size:11.5px;color:var(--text-dim);cursor:pointer}',
      '.er-chip:hover{border-color:var(--primary);color:var(--text)}',
      '.er-chip b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.er-polrow{display:flex;gap:8px;align-items:center}',
      '.er-polrow select{flex:1;min-width:0}',
      '.er-pol-list{margin-top:10px}',
      '.er-pol{border:1px solid #3b1f6e;background:#150c26;border-radius:var(--radius);padding:11px 13px;margin-bottom:8px}',
      '.er-pol.empty{color:var(--text-muted-color);font-size:12.5px;line-height:1.6;margin-top:10px;background:none;border-style:dashed;border-color:var(--border)}',
      '.er-pol-h{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:7px}',
      '.er-pol-h b{font-size:13px;color:var(--text)}',
      '.er-pol-q{font-size:12.5px;color:var(--text-dim);line-height:1.6;border-left:2px solid #6d28d9;padding-left:10px;font-style:italic}',
      '.er-pol-w{font-size:12px;color:var(--text-muted-color);margin-top:7px;line-height:1.55}',
      '.er-pol-note{font-size:11.5px;color:var(--text-muted-color);line-height:1.5}',
      // ---- kudos ----
      '.er-kud-row{display:flex;align-items:center;gap:10px;margin-top:9px;flex-wrap:wrap}',
      '.er-kud{display:inline-flex;align-items:center;gap:6px;font-family:inherit;font-size:12px;font-weight:600;',
      '  padding:5px 11px;border-radius:20px;background:#111c14;border:1px solid #1d4429;color:#6ee7a0;cursor:pointer}',
      '.er-kud:hover{background:#16281c;border-color:#2f7a4d}',
      '.er-kud:disabled{cursor:default}',
      '.er-kud.sent{background:#123020;border-color:#2f7a4d;color:#8ef0b4}',
      '.er-kud.given{background:#0e1a12;border-color:#1d4429;color:#4d8a63;cursor:default}',
      '.er-kud.given:hover{background:#0e1a12;border-color:#1d4429}',
      '.er-ktally{font-size:11.5px;color:var(--text-muted-color)}',
      '.er-ktally b{color:#6ee7a0;font-weight:700}',
      '.er-klock{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;letter-spacing:.05em;',
      '  color:#5c6b60;border:1px solid #1f2b23;border-radius:4px;padding:1px 6px}',
      '.er-cel-ov{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:2600;display:flex;align-items:center;',
      '  justify-content:center;padding:24px}',
      '.er-cel{position:relative;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;background:var(--bg-card);',
      '  border:1px solid #1d4429;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.6)}',
      '.er-cel-top{background:linear-gradient(180deg,#10251a 0%,var(--bg-card) 100%);padding:26px 26px 20px;',
      '  text-align:center;border-bottom:1px solid #1d4429}',
      '.er-cel-top .em{font-size:40px;line-height:1}',
      '.er-cel-top h4{font-size:21px;font-weight:800;color:var(--text);margin:12px 0 6px}',
      '.er-cel-top p{font-size:13px;color:var(--text-dim);line-height:1.6;margin:0}',
      '.er-cel-faces{display:flex;justify-content:center;margin-top:16px}',
      '.er-cel-faces .avatar{width:38px;height:38px;font-size:13px;border:2px solid var(--bg-card);margin-left:-8px}',
      '.er-cel-faces .avatar:first-child{margin-left:0}',
      '.er-cel-faces .more{background:#374151;color:#9ca3af}',
      '.er-cel-body{padding:20px 26px 24px}',
      '.er-cel-q{background:var(--bg);border:1px solid var(--border);border-left:3px solid #22c55e;border-radius:6px;',
      '  padding:12px 14px;font-size:13px;color:var(--text-dim);line-height:1.6;white-space:pre-wrap}',
      '.er-cel-q b{color:var(--text)}',
      '.er-cel-names{font-size:12.5px;color:var(--text-muted-color);margin-top:14px;line-height:1.6}',
      '.er-cel-names b{color:var(--text-dim);font-weight:600}',
      '.er-cel-foot{display:flex;justify-content:flex-end;padding:0 26px 24px}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------ data
  async function loadMeta() {
    if (S.meta) return S.meta;
    S.meta = await api('GET', API + '/meta');
    return S.meta;
  }

  // ==================================================================
  // ROSTER
  // ==================================================================
  async function renderRoster(host) {
    host.innerHTML = '<div class="loading">Loading…</div>';
    var d, soCount = 0;
    try {
      // The shout-out queue rides along with the roster rather than getting its
      // own screen load. It is allowed to fail on its own: a queue that will not
      // load must not stop somebody opening an employee file.
      var jobs = [api('GET', API + '/roster')];
      var mayApprove = (typeof can === 'function') && can('create_employee_note');
      if (mayApprove) jobs.push(api('GET', API + '/shoutouts/pending').catch(function () { return null; }));
      var got = await Promise.all(jobs);
      d = got[0];
      soCount = (got[1] && (got[1].shoutouts || []).length) || 0;
    }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load.') + '</div>'; return; }
    S.roster = d;
    var s = d.stats || {};

    var warn = d.no_city
      ? '<div class="alert alert-warn" style="margin-bottom:20px"><b>' + d.no_city + ' ' +
        (d.no_city === 1 ? 'employee has' : 'employees have') + ' no Home City set.</b><br>' +
        '<span style="font-size:13px">City scoping reads Home City, so until it is filled in those people ' +
        'will not appear here for a city manager. Fix it under Settings &gt; Users.</span></div>'
      : '';

    var approvalsBtn = can('approve_discipline') && s.pending_approval
      ? '<button class="btn btn-secondary" onclick="erOpenApprovals()">Approvals (' + s.pending_approval + ')</button>' : '';

    // Shown whenever the viewer could approve one, count or no count. The
    // discipline button above hides itself at zero because nobody goes looking
    // for an empty approvals list; this one is where peer recognition lives, and
    // a queue nobody can find is a queue nobody clears.
    var shoutBtn = ((typeof can === 'function') && can('create_employee_note'))
      ? '<button class="btn ' + (soCount ? 'btn-primary' : 'btn-secondary') +
        '" onclick="erOpenShoutouts()">Shout-outs' + (soCount ? ' (' + soCount + ')' : '') + '</button>' : '';

    var rows = (d.employees || []).map(function (u) {
      var c = u.counts || {};
      var chips = [];
      if (c.recognition) chips.push('<span class="badge badge-completed">' + c.recognition + ' positive</span>');
      if (c.coaching) chips.push('<span class="badge badge-waiting">' + c.coaching + ' coaching</span>');
      if (c.performance) chips.push('<span class="badge badge-active">' + c.performance + ' note' + (c.performance === 1 ? '' : 's') + '</span>');
      if (c.disciplinary) chips.push('<span class="badge badge-rejected">' + c.disciplinary + ' formal</span>');
      if (!chips.length) chips.push('<span style="color:var(--text-muted-color);font-size:13px">No records</span>');
      // The whole row opens the file. The button stays because it is the thing
      // people look for, but it stops the click so the row handler does not
      // also fire and open the same file twice.
      return '<tr class="er-row" onclick="erOpenFile(' + u.id + ')">' +
        '<td><div style="display:flex;align-items:center;gap:10px">' +
        '<div class="avatar" style="width:28px;height:28px;font-size:11px">' + esc(initials(u.name)) + '</div>' +
        '<div><div style="color:var(--text);font-weight:500">' + esc(u.name) + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color)">' + esc(u.role || '') + '</div></div></div></td>' +
        '<td>' + esc(u.home_city || '—') + '</td>' +
        '<td>' + chips.join(' ') + '</td>' +
        '<td>' + (u.doc_count || 0) + '</td>' +
        '<td>' + esc(relDays(u.last_activity)) + '</td>' +
        '<td style="text-align:right"><button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();erOpenFile(' + u.id + ')">Open file</button></td>' +
        '</tr>';
    }).join('');

    host.innerHTML =
      '<div class="page-header"><div><h2 style="font-size:22px;font-weight:600">Employee Files</h2>' +
      '<p style="font-size:13px;color:var(--text-muted-color);margin-top:4px">' + (s.people || 0) +
      ' ' + ((s.people === 1) ? 'person' : 'people') + ' you can open</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' + shoutBtn + approvalsBtn + '</div></div>' +

      '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-value">' + (s.people || 0) + '</div><div class="stat-label">People in scope</div></div>' +
      '<div class="stat-card"><div class="stat-value" style="color:var(--success)">' + (s.praise_90 || 0) + '</div><div class="stat-label">Recognition &middot; last 90 days</div></div>' +
      '<div class="stat-card"><div class="stat-value" style="color:var(--warning)">' + (s.open_followups || 0) + '</div><div class="stat-label">Open follow-ups</div></div>' +
      '<div class="stat-card"><div class="stat-value" style="color:var(--danger)">' + (s.awaiting_signature || 0) + '</div><div class="stat-label">Awaiting signature</div></div>' +
      '</div>' + warn +

      '<div class="card"><div class="card-header">' +
      '<input id="er-search" placeholder="Search employees…" style="width:260px" oninput="erFilterRoster()">' +
      '<span style="font-size:12px;color:var(--text-muted-color)">Sorted by name</span></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th>Employee</th><th>City</th><th>Records &middot; last 12 months</th><th>Docs</th><th>Last activity</th><th></th>' +
      '</tr></thead><tbody id="er-rows">' + (rows || '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted-color)">Nobody in scope yet.</td></tr>') +
      '</tbody></table></div></div>';
  }

  window.erFilterRoster = function () {
    var q = String(val('er-search') || '').toLowerCase();
    var body = el('er-rows');
    if (!body) return;
    Array.prototype.forEach.call(body.querySelectorAll('tr'), function (tr) {
      tr.style.display = (!q || tr.textContent.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
    });
  };

  // ==================================================================
  // ONE FILE
  // ==================================================================
  window.erOpenFile = async function (id, tab) {
    S.view = 'file'; S.employeeId = id; S.tab = tab || 'timeline';
    var host = content();
    if (!host) return;
    host.innerHTML = '<div class="loading">Loading…</div>';
    try {
      S.file = await api('GET', API + '/employee/' + id);
      await loadMeta();
    } catch (e) {
      host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load.') + '</div>';
      return;
    }
    drawFile();
  };

  function drawFile() {
    var host = content(); if (!host) return;
    var d = S.file, u = d.user;
    var tabs = [
      ['timeline', 'Timeline', (d.records || []).length],
      ['documents', 'Documents', null]
    ];
    host.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;color:var(--text-muted-color);cursor:pointer" onclick="erBackToRoster()">&#8592; Employee Files</div>' +
      '<div class="page-header"><div style="display:flex;align-items:center;gap:14px">' +
      '<div class="avatar" style="width:46px;height:46px;font-size:17px">' + esc(initials(u.name)) + '</div>' +
      '<div><h2 style="font-size:22px;font-weight:600">' + esc(u.name) + '</h2>' +
      '<p style="font-size:13px;color:var(--text-muted-color);margin-top:3px">' + esc(u.role || '') +
      (u.home_city ? ' &middot; ' + esc(u.home_city) : '') +
      (u.supervisor ? ' &middot; Reports to ' + esc(u.supervisor.name) : '') +
      (u.has_email ? '' : ' &middot; <span style="color:var(--warning)">no email on file</span>') +
      '</p></div></div>' +
      (d.can_act && can('create_employee_note')
        ? '<button class="btn btn-primary" onclick="erNewRecord()">+ New Record</button>' : '') +
      '</div>' +
      '<div class="er-tabs">' + tabs.map(function (t) {
        return '<div class="er-tab' + (S.tab === t[0] ? ' active' : '') + '" onclick="erTab(\'' + t[0] + '\')">' +
          t[1] + (t[2] !== null ? '<span class="er-c">' + t[2] + '</span>' : '') + '</div>';
      }).join('') + '</div>' +
      '<div id="er-tabbody"></div>';
    drawTab();
  }

  window.erTab = function (t) { S.tab = t; drawFile(); };
  window.erBackToRoster = function () { S.view = 'roster'; renderRoster(content()); };

  function drawTab() {
    var host = el('er-tabbody'); if (!host) return;
    if (S.tab === 'documents') {
      // Hand straight back to the original documents view from onboarding.js.
      host.innerHTML = '<div id="onb-ef-body"><div class="loading">Loading…</div></div>';
      if (typeof window.onbOpenFile === 'function') window.onbOpenFile(S.employeeId);
      else host.innerHTML = '<div class="alert alert-error">The documents view is unavailable.</div>';
      return;
    }
    host.innerHTML = '<div class="er-two"><div>' + timelineHtml() + '</div><div>' + sideHtml() + '</div></div>';
  }

  function timelineHtml() {
    var recs = S.file.records || [];
    if (!recs.length) {
      return '<div class="card"><div class="empty-state"><h3>Nothing on file yet</h3>' +
        '<p style="font-size:13px">Recognition, coaching notes and formal notices all land here, in order.</p></div></div>';
    }
    return '<div class="er-tl">' + recs.map(eventHtml).join('') + '</div>';
  }

  function eventHtml(r) {
    var tm = TYPE_META[r.type] || TYPE_META.performance;
    var title = (r.type === 'disciplinary' ? (r.level_label || 'Disciplinary action') : tm.label) +
      (r.category ? ' &middot; ' + esc(r.category) : '');
    var eye = r.visible_to_employee
      ? '<span class="er-eye on">Visible to employee</span>'
      : '<span class="er-eye off">Internal only</span>';
    var meta = [esc(shortDate(r.occurred_on || r.created_at))];
    if (r.created_by_name) meta.push(esc(r.created_by_name));
    if (r.type === 'disciplinary' && r.level) meta.push('Level ' + r.level + ' of 5');
    if (r.approver_name && r.approved_at) meta.push('Approved by ' + esc(r.approver_name));
    if (r.signed_at) meta.push('Signed ' + esc(shortDate(r.signed_at)));
    if (r.refused_at) meta.push('Refused ' + esc(shortDate(r.refused_at)));
    if (r.followup_on && !r.followup_outcome) meta.push('Follow-up ' + esc(shortDate(r.followup_on)));
    if (r.followup_outcome) meta.push('Follow-up: ' + esc(r.followup_outcome.replace('_', ' ')));
    meta.push(eye);
    if (r.show_in_wins) meta.push('<span class="er-eye on">In Recent Wins</span>');

    return '<div class="er-ev"><div class="er-dot ' + tm.cls + '">' + tm.dot + '</div>' +
      '<div class="er-card ' + tm.cls + '">' +
      '<div class="er-head"><div class="er-title">' + title + '</div>' + badge(r.status) + '</div>' +
      '<div class="er-body">' + esc(r.body || '') + '</div>' +
      (r.corrective_action ? '<div class="er-body" style="margin-top:8px"><b style="color:var(--text)">Must change:</b> ' + esc(r.corrective_action) + '</div>' : '') +
      (r.employee_response ? '<div class="er-sugg"><b style="color:var(--text)">Employee response</b><br>' + esc(r.employee_response) + '</div>' : '') +
      (r.void_reason ? '<div class="er-meta" style="color:#f87171">Voided: ' + esc(r.void_reason) + '</div>' : '') +
      attachChips(r.attachments) +
      '<div class="er-meta">' + meta.join(' <span class="sep">&middot;</span> ') + '</div>' +
      actionsHtml(r) + '</div></div>';
  }

  function actionsHtml(r) {
    var a = [];
    var mine = S.file && S.file.can_act;
    if (r.type === 'disciplinary') {
      if ((r.status === 'draft' || r.status === 'returned') && can('create_disciplinary')) {
        a.push(btn('Continue draft', 'btn-primary', 'erEditDisciplinary(' + r.id + ')'));
        a.push(btn('Delete draft', 'btn-ghost', 'erDeleteDraft(' + r.id + ')'));
      }
      if (r.status === 'sent' && mine && can('create_disciplinary')) {
        a.push(btn('Resend', 'btn-secondary', 'erResend(' + r.id + ',false)'));
        a.push(btn('Extend 14 days', 'btn-ghost', 'erResend(' + r.id + ',true)'));
        a.push(btn('Will not sign', 'btn-danger', 'erRefuse(' + r.id + ')'));
      }
      if (r.status === 'expired' && mine && can('create_disciplinary')) {
        a.push(btn('Record what happened', 'btn-danger', 'erRefuse(' + r.id + ')'));
      }
      if (r.followup_on && !r.followup_outcome && ['signed', 'refused', 'expired', 'sent'].indexOf(r.status) !== -1 && mine && can('create_disciplinary')) {
        a.push(btn('Follow-up', 'btn-secondary', 'erFollowup(' + r.id + ')'));
      }
    }
    // Attaching to an ALREADY ISSUED notice is allowed on purpose. The notice
    // text is append-only, but the evidence for it often arrives afterwards -
    // the customer sends the email on Thursday - and every add and remove lands
    // in the record history with a name on it.
    if (mine && r.status !== 'void' && can('create_employee_note')) {
      a.push(btn('Attach file', 'btn-ghost', 'erAttachTo(' + r.id + ')'));
    }
    if (r.status !== 'void' && can('manage_employee_records')) {
      a.push(btn('Void', 'btn-ghost', 'erVoid(' + r.id + ')'));
    }
    a.push(btn('History', 'btn-ghost', 'erHistory(' + r.id + ')'));
    return a.length ? '<div class="er-acts">' + a.join('') + '</div>' : '';
  }

  function btn(label, cls, onclick) {
    return '<button class="btn ' + cls + ' btn-sm" onclick="' + onclick + '">' + label + '</button>';
  }

  /* The right-hand rail.
     Written to state what is TRUE about this person, in that order, rather than
     to lay out every possible bad outcome up front. A file with nothing on it
     used to open with an empty five-rung discipline ladder and a red zero,
     which framed somebody before they had done anything. Two rules came out of
     that and both are load-bearing:

       1. A zero is never coloured. Colour has to mean something, and painting a
          clean file in warning colours spends the meaning on nothing.
       2. A card that has nothing to say does not render. The ladder appears
          once there is a notice on it and not before; the late-deposit card
          appears once something has been marked late.

     The tone is deliberately flat rather than encouraging. A card that
     congratulates somebody for having no records would look ridiculous sitting
     on the file of somebody who has two warnings, and the same words have to
     work on both. */
  function sideHtml() {
    var d = S.file, L = d.ladder || {};
    var levels = (S.meta && S.meta.levels) || [];
    var recs = (d.records || []).filter(function (r) { return r.status !== 'void' && r.status !== 'draft'; });

    var counts = { recognition: 0, coaching: 0, performance: 0, disciplinary: 0 };
    recs.forEach(function (r) { if (counts[r.type] !== undefined) counts[r.type]++; });
    var total = counts.recognition + counts.coaching + counts.performance + counts.disciplinary;

    var lateAvail = !!(d.late_deposits && d.late_deposits.available);
    var lateCount = (d.late_deposits && d.late_deposits.count) || 0;
    // Of those, the pay weeks where no deposit was ever submitted.
    var lateMissed = (d.late_deposits && d.late_deposits.missed_count) || 0;
    var shCount = (d.shortages && d.shortages.count) || 0;
    var shTotal = (d.shortages && d.shortages.total) || 0;

    // Anything actually waiting on somebody. These are the only things that
    // earn a colour on an otherwise quiet file.
    var open = [];
    recs.forEach(function (r) {
      if (r.status === 'sent') open.push('a notice awaiting signature');
      else if (r.status === 'pending_approval') open.push('a notice awaiting approval');
      else if (r.status === 'expired') open.push('a signature request that expired');
      if (r.followup_on && !r.followup_outcome && ['signed', 'refused', 'expired', 'sent'].indexOf(r.status) !== -1) {
        open.push('a follow-up due ' + shortDate(r.followup_on));
      }
    });

    // ---- Standing -----------------------------------------------------------
    var line, dot;
    if (L.highest_live) {
      line = 'Highest live level: ' + esc(levelName(L.highest_live)) + '.';
      dot = 'var(--danger)';
    } else if (total === 0 && !lateCount && !shCount) {
      line = 'Nothing on record in the last 12 months.';
      dot = 'var(--success)';
    } else if (counts.disciplinary === 0 && counts.coaching === 0 && !lateCount && !shCount) {
      line = total + ' record' + (total === 1 ? '' : 's') + ' on file, none of it disciplinary.';
      dot = 'var(--success)';
    } else {
      line = total + ' record' + (total === 1 ? '' : 's') + ' in the last 12 months. No live notice.';
      dot = 'var(--text-muted-color)';
    }
    var second = [];
    if (lateAvail && !lateCount) second.push('No deposits marked late.');
    if (lateCount) second.push(lateCount + ' deposit' + (lateCount === 1 ? '' : 's') + ' marked late' +
      (lateMissed ? ', ' + lateMissed + ' of which ' + (lateMissed === 1 ? 'was' : 'were') + ' never deposited at all' : '') + '.');
    if (shCount) second.push(shCount + ' pay week' + (shCount === 1 ? '' : 's') + ' with cash unaccounted for.');
    if (open.length) {
      // Sentence-cased, because this lands after a full stop rather than
      // mid-sentence: "3 deposits marked late. A notice awaiting signature."
      var o = open.slice(0, 2).join(' and ');
      second.push(o.charAt(0).toUpperCase() + o.slice(1) + '.');
    }

    var standing =
      '<div class="card" style="margin-bottom:14px"><div class="card-header">' +
      '<div class="card-title">Standing</div>' +
      '<span style="font-size:12px;color:var(--text-muted-color)">last 12 months</span></div>' +
      '<div class="card-body">' +
      '<div style="display:flex;gap:9px;align-items:flex-start">' +
      '<div style="width:9px;height:9px;border-radius:50%;background:' + dot + ';margin-top:5px;flex-shrink:0"></div>' +
      '<div><div style="font-size:14px;color:var(--text);line-height:1.5">' + line + '</div>' +
      (second.length
        ? '<div style="font-size:12.5px;color:var(--text-muted-color);margin-top:5px;line-height:1.6">' + second.join(' ') + '</div>'
        : '') +
      '</div></div></div></div>';

    // ---- Late deposits, only when there are some ----------------------------
    var lateCard = '';
    if (lateAvail && lateCount) {
      lateCard = '<div class="card" style="margin-bottom:14px;border-color:#4a3500">' +
        '<div class="card-header" style="border-bottom-color:#4a3500">' +
        '<div class="card-title">Late deposits</div>' +
        '<span style="font-size:12px;color:var(--text-muted-color)">last 12 months</span></div>' +
        '<div class="card-body">' +
        '<div style="font-size:28px;font-weight:700;font-family:\'Fira Code\',ui-monospace,monospace;color:var(--warning)">' + lateCount + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px;line-height:1.6">' +
        'Marked by a manager on the deposit or the Pulsar board. Documenting them pulls the real dates in, ' +
        'so nothing is written from memory.' +
        (lateMissed ? ' <span style="color:#f87171">' + lateMissed + ' of these ' + (lateMissed === 1 ? 'is a pay week' : 'are pay weeks') +
          ' where cash was collected and no deposit was submitted.</span>' : '') + '</div>' +
        sparkHtml(d.late_deposits.by_month, d.late_deposits.months) +
        (d.can_act && can('create_employee_note')
          ? '<button class="btn btn-secondary btn-sm" style="margin-top:12px;width:100%;justify-content:center" ' +
            'onclick="erDocumentLate()">Document these</button>' : '') +
        '</div></div>';
    }

    // ---- Unaccounted cash, only when a manager established that it was -------
    // Explained gaps never reach this file. An unlogged expense or a typo
    // closed the row on the reconciliation board and stopped there.
    var shCard = '';
    if (shCount) {
      shCard = '<div class="card" style="margin-bottom:14px;border-color:#4d1515">' +
        '<div class="card-header" style="border-bottom-color:#4d1515">' +
        '<div class="card-title">Cash unaccounted for</div>' +
        '<span style="font-size:12px;color:var(--text-muted-color)">last 12 months</span></div>' +
        '<div class="card-body">' +
        '<div style="font-size:28px;font-weight:700;font-family:\'Fira Code\',ui-monospace,monospace;color:#f87171">' +
        shCount + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px;line-height:1.6">' +
        'Pay week' + (shCount === 1 ? '' : 's') + ' where a manager established the gap was not an expense, a typo ' +
        'or a Pulsar error. $' + Number(shTotal).toFixed(2) + ' in total.</div>' +
        (d.can_act && can('create_employee_note')
          ? '<button class="btn btn-secondary btn-sm" style="margin-top:12px;width:100%;justify-content:center" ' +
            'onclick="erDocumentShortages()">Document these</button>' : '') +
        '</div></div>';
    }

    // ---- The ladder, only once there is something on it ---------------------
    var ladderCard = '';
    if (L.total_count) {
      var steps = levels.map(function (lv) {
        var cls = '';
        if (lv.n <= L.highest_live) cls = ' done';
        if (lv.n === L.highest_live) cls = ' cur';
        var short = lv.label.replace(' Warning (documented)', '').replace(' Warning', '');
        return '<div class="er-step' + cls + '">' + esc(short) + '</div>';
      }).join('');
      ladderCard = '<div class="card" style="margin-bottom:14px"><div class="card-header">' +
        '<div class="card-title">Progressive discipline</div></div>' +
        '<div class="card-body"><div class="er-ladder" style="margin-bottom:12px">' + steps + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color)">' +
        (L.highest_live
          ? 'Highest live level: ' + esc(levelName(L.highest_live)) + '. '
          : 'Nothing live. ' + L.total_count + ' past notice' + (L.total_count === 1 ? '' : 's') + ' outside the window. ') +
        'Ladder position is informational; nothing escalates automatically, and a notice past its window stays ' +
        'on the file but stops counting.</div></div></div>';
    }

    // ---- Counts. A zero is grey, always. ------------------------------------
    function kv(label, n, colour) {
      return '<div class="er-kv"><span>' + label + '</span>' +
        '<span' + (n ? ' style="color:' + colour + '"' : ' style="color:var(--text-muted-color);font-weight:400"') + '>' + n + '</span></div>';
    }
    var countsCard =
      '<div class="card" style="margin-bottom:14px"><div class="card-header"><div class="card-title">Last 12 months</div></div>' +
      '<div class="card-body" style="padding:8px 20px">' +
      kv('Recognition', counts.recognition, 'var(--success)') +
      kv('Coaching notes', counts.coaching, 'var(--warning)') +
      kv('Performance notes', counts.performance, 'var(--text)') +
      kv('Formal discipline', counts.disciplinary, 'var(--danger)') +
      '</div></div>';

    // ---- Add to file --------------------------------------------------------
    // Recognition is the only filled button. A filled red one invites clicking,
    // and that is the action you least want to be easy.
    var add = '';
    if (d.can_act && can('create_employee_note')) {
      add = '<div class="card" style="margin-bottom:14px"><div class="card-header"><div class="card-title">Add to file</div></div>' +
        '<div class="card-body" style="display:flex;flex-direction:column;gap:8px">' +
        '<button class="btn btn-success btn-sm" style="justify-content:flex-start" onclick="erNewRecord(\'recognition\')">Recognition</button>' +
        '<button class="btn btn-secondary btn-sm" style="justify-content:flex-start" onclick="erNewRecord(\'coaching\')">Coaching note</button>' +
        '<button class="btn btn-secondary btn-sm" style="justify-content:flex-start" onclick="erNewRecord(\'performance\')">Performance note</button>' +
        (can('create_disciplinary')
          ? '<button class="btn btn-secondary btn-sm" style="justify-content:flex-start;color:#f87171;border-color:#4d1515" ' +
            'onclick="erNewDisciplinary()">Disciplinary action</button>' : '') +
        '</div></div>';
    }

    var who = '<div class="card"><div class="card-header"><div class="card-title">Who can see this file</div></div>' +
      '<div class="card-body"><div style="font-size:12px;color:var(--text-muted-color);line-height:1.7">' +
      'A file can only be opened by somebody above the person it belongs to. Two admins cannot read each ' +
      'other, and neither can two managers in the same city. Owner and admins reach everyone below them; ' +
      'managers reach their own city and their own downline. ' +
      esc(S.file.user.name.split(' ')[0]) + ' sees only the records marked visible.' +
      '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-light)">' +
      'Opening a disciplinary record is written to the audit log, so ' + esc(S.file.user.name.split(' ')[0]) +
      ' can always be told who has read their file.</div>' +
      '</div></div></div>';

    return standing + shCard + lateCard + ladderCard + countsCard + add + who;
  }

  // Twelve months of late deposits as a bar per month. Empty months are drawn
  // as flat stubs rather than skipped, because the gaps are the point: three in
  // a row reads differently from three spread over a year, and a table of
  // counts hides that difference completely.
  function sparkHtml(byMonth, months) {
    months = months || 12;
    var have = {};
    (byMonth || []).forEach(function (b) { have[b.month] = b.count; });
    var keys = [], now = new Date();
    for (var i = months - 1; i >= 0; i--) {
      var dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.push(dt.getFullYear() + '-' + (dt.getMonth() + 1 < 10 ? '0' : '') + (dt.getMonth() + 1));
    }
    var max = 1;
    keys.forEach(function (k) { if ((have[k] || 0) > max) max = have[k]; });
    if (!Object.keys(have).length) return '';
    var bars = keys.map(function (k) {
      var n = have[k] || 0;
      var pct = n ? Math.max(14, Math.round((n / max) * 100)) : 6;
      return '<div class="er-sb' + (n ? ' hit' : '') + '" style="height:' + pct + '%" title="' + k + ': ' + n + '"></div>';
    }).join('');
    var first = keys[0], last = keys[keys.length - 1];
    return '<div class="er-spark">' + bars + '</div>' +
      '<div class="er-sblab"><span>' + esc(monthLabel(first)) + '</span><span>' + esc(monthLabel(last)) + '</span></div>';
  }

  function monthLabel(ym) {
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = String(ym || '').split('-');
    return (M[parseInt(p[1], 10) - 1] || '') + ' ' + String(p[0] || '').slice(2);
  }

  function levelName(n) {
    var levels = (S.meta && S.meta.levels) || [];
    for (var i = 0; i < levels.length; i++) if (levels[i].n === n) return levels[i].label;
    return '';
  }

  // Pull the real late-deposit dates and open a record pre-filled with them.
  // The manager still writes the judgment; Nova only supplies the facts it
  // already holds, which is the half that gets remembered wrongly.
  window.erDocumentLate = async function () {
    var d;
    try { d = await api('GET', API + '/employee/' + S.employeeId + '/late-deposits'); }
    catch (e) { toast(e.message || 'Could not load the late deposits.', 'error'); return; }
    if (!d.late || !d.late.count) { toast('Nothing marked late.', 'info'); return; }
    var rows = d.late.deposits.map(function (x) {
      // A pay week that never produced a deposit has no number to show and its
      // date is the day it was due, so it says what it is instead.
      var label = x.missed
        ? 'Week of ' + esc(x.period_start || x.date || '') + ' &middot; no deposit submitted'
        : esc(x.date || '') + (x.number ? ' &middot; ' + esc(x.number) : '');
      return '<div class="er-kv"><span' + (x.missed ? ' style="color:#f87171"' : '') + '>' + label + '</span>' +
        '<span style="font-weight:400;color:var(--text-muted-color)">' + esc(x.reason || (x.marked_by ? 'marked by ' + x.marked_by : '')) + '</span></div>';
    }).join('');
    modal('Document late deposits &middot; ' + esc(S.file.user.name),
      '<div style="font-size:13px;color:var(--text-dim);line-height:1.6;margin-bottom:14px">' +
      'These are the deposits a manager marked late in the last 12 months, including any pay week where no ' +
      'deposit was submitted at all. Pick what kind of record this should be; the dates go in for you and you ' +
      'write the rest.</div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-body" style="padding:6px 16px">' + rows + '</div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>What kind of record</label><div class="er-types">' +
      '<div class="er-type sel" id="er-lk-coaching" onclick="erPickLateKind(\'coaching\')"><b>Coaching note</b>' +
      '<small>A documented conversation. Internal, no signature, no approval.</small></div>' +
      (can('create_disciplinary')
        ? '<div class="er-type" id="er-lk-disciplinary" onclick="erPickLateKind(\'disciplinary\')"><b>Disciplinary notice</b>' +
          '<small>Opens the full form at the level the ladder suggests, needs approval.</small></div>' : '') +
      '</div></div>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" onclick="erStartLateRecord()">Continue</button>', 640);
    S.lateKind = 'coaching';
    S.lateText = d.suggested_text || '';
  };

  window.erPickLateKind = function (k) {
    S.lateKind = k;
    ['coaching', 'disciplinary'].forEach(function (x) {
      var e = el('er-lk-' + x);
      if (e) e.className = 'er-type' + (x === k ? ' sel' : '');
    });
  };

  window.erStartLateRecord = function () {
    var text = S.lateText || '';
    closeModal();
    if (S.lateKind === 'disciplinary') {
      S.draft = null; S.check = null;
      openDisciplinary(null);
      setTimeout(function () {
        var b = el('er-body');
        if (b && !b.value) b.value = text;
        var cat = el('er-cat');
        if (cat) { for (var i = 0; i < cat.options.length; i++) if (cat.options[i].value === 'Cash handling') cat.selectedIndex = i; }
        var sop = el('er-sop');
        if (sop && !sop.value) sop.value = 'Cash deposit policy';
        toast('Dates filled in. Write what must change, then check the wording.', 'info');
      }, 30);
      return;
    }
    window.erNewRecord('coaching');
    setTimeout(function () {
      var b = el('er-body');
      if (b && !b.value) b.value = text;
      var cat = el('er-cat');
      if (cat) { for (var i = 0; i < cat.options.length; i++) if (cat.options[i].value === 'Cash handling') cat.selectedIndex = i; }
    }, 30);
  };

  // Same shape as the late-deposit bridge: pull the real pay weeks and amounts,
  // pre-fill a record with them, and let the manager write the judgment.
  window.erDocumentShortages = async function () {
    var d;
    try { d = await api('GET', API + '/employee/' + S.employeeId + '/shortages'); }
    catch (e) { toast(e.message || 'Could not load the shortages.', 'error'); return; }
    if (!d.shortages || !d.shortages.count) { toast('Nothing unaccounted for.', 'info'); return; }
    var rows = d.shortages.shortages.map(function (x) {
      return '<div class="er-kv"><span>Week of ' + esc(x.period_start) + '</span>' +
        '<span style="color:#f87171">$' + Number(x.amount).toFixed(2) + '</span></div>' +
        (x.note ? '<div style="font-size:12px;color:var(--text-muted-color);padding:0 0 8px">' + esc(x.note) + '</div>' : '');
    }).join('');
    modal('Document unaccounted cash &middot; ' + esc(S.file.user.name),
      '<div style="font-size:13px;color:var(--text-dim);line-height:1.6;margin-bottom:14px">' +
      'These are the pay weeks where a manager established the gap was not an expense, a typo or a Pulsar ' +
      'error. The dates and amounts go in for you; you write the rest.</div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-body" style="padding:6px 16px">' + rows + '</div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>What kind of record</label><div class="er-types">' +
      '<div class="er-type sel" id="er-lk-coaching" onclick="erPickLateKind(\'coaching\')"><b>Coaching note</b>' +
      '<small>A documented conversation. Internal, no signature, no approval.</small></div>' +
      (can('create_disciplinary')
        ? '<div class="er-type" id="er-lk-disciplinary" onclick="erPickLateKind(\'disciplinary\')"><b>Disciplinary notice</b>' +
          '<small>Opens the full form at the level the ladder suggests, needs approval.</small></div>' : '') +
      '</div></div>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" onclick="erStartLateRecord()">Continue</button>', 640);
    S.lateKind = 'coaching';
    S.lateText = d.suggested_text || '';
  };

  // ==================================================================
  // MODAL PLUMBING
  // ==================================================================
  function modal(title, bodyHtml, footerHtml, width) {
    closeModal();
    var wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.id = 'er-modal';
    wrap.innerHTML = '<div class="modal" style="max-width:' + (width || 620) + 'px">' +
      '<div class="modal-header"><div class="modal-title">' + title + '</div>' +
      '<div style="cursor:pointer;color:var(--text-muted-color)" onclick="erCloseModal()">&#10005;</div></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' + footerHtml + '</div></div>';
    document.body.appendChild(wrap);
  }
  function closeModal() { var m = el('er-modal'); if (m && m.parentNode) m.parentNode.removeChild(m); }
  window.erCloseModal = closeModal;

  window.erToggle = function (id) {
    var sw = el(id);
    if (!sw) return;
    var on = sw.className.indexOf('on') !== -1;
    sw.className = 'er-sw' + (on ? '' : ' on');
    sw.setAttribute('data-on', on ? '0' : '1');
    if (id === 'er-vis' && on) {
      // Un-sharing kills Recent Wins with it. A win the person cannot see in
      // their own file is not a win.
      var w = el('er-wins');
      if (w) { w.className = 'er-sw'; w.setAttribute('data-on', '0'); }
    }
    if (id === 'er-wins' && !on) {
      var v = el('er-vis');
      if (v) { v.className = 'er-sw on'; v.setAttribute('data-on', '1'); }
    }
  };
  function swOn(id) { var e = el(id); return !!(e && e.getAttribute('data-on') === '1'); }
  function sw(id, on, label, help) {
    return '<div class="er-toggle" onclick="erToggle(\'' + id + '\')" style="margin-bottom:8px">' +
      '<div class="er-sw' + (on ? ' on' : '') + '" id="' + id + '" data-on="' + (on ? '1' : '0') + '"></div>' +
      '<div><div style="font-size:13px;color:var(--text);font-weight:500">' + label + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color)">' + help + '</div></div></div>';
  }

  // ==================================================================
  // NEW NOTE (recognition / coaching / performance)
  // ==================================================================
  window.erNewRecord = function (type, keepQueue) {
    type = type || 'recognition';
    // Clicking a type card rebuilds this whole modal, so it passes keepQueue -
    // otherwise switching from Coaching to Performance would silently drop the
    // files somebody had already picked.
    if (!keepQueue) S.queue = [];
    if (type === 'disciplinary') return window.erNewDisciplinary();
    var cats = (S.meta && S.meta.categories) || [];
    var isPraise = type === 'recognition';
    var body =
      '<div class="form-group"><label>Record type</label><div class="er-types">' +
      typeCard('recognition', type, 'Recognition', 'Praise, a win, a customer callout. Shared with them by default.') +
      typeCard('coaching', type, 'Coaching note', 'A documented conversation. Internal by default, no signature.') +
      typeCard('performance', type, 'Performance note', 'A neutral observation for the record.') +
      (can('create_disciplinary') ? typeCard('disciplinary', type, 'Disciplinary action', 'Formal notice. Opens the full form.') : '') +
      '</div></div>' +
      '<div class="er-grid2">' +
      '<div class="form-group"><label>Date</label><input type="date" id="er-date" value="' + new Date().toISOString().slice(0, 10) + '"></div>' +
      '<div class="form-group"><label>Category</label><select id="er-cat">' +
      cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="form-group"><label>What happened <span style="color:var(--danger)">*</span></label>' +
      '<textarea id="er-body" style="min-height:110px" placeholder="What was observed. Dates and specifics beat adjectives."></textarea></div>' +
      '<div class="form-group"><label>Where it goes</label>' +
      sw('er-vis', isPraise, 'Share with ' + esc(S.file.user.name.split(' ')[0]),
        'Appears in their My File screen.') +
      (isPraise ? sw('er-wins', true, 'Show in Recent Wins',
        'Everyone in their city sees their name and this text on the Home screen. Filing this record IS the post; there is nowhere else to put it.') : '') +
      '</div>' +
      '<div class="form-group"><label>Supporting documentation</label>' +
      '<div id="er-queue">' + queueRows() + '</div>' +
      '<button class="btn btn-secondary btn-sm" onclick="erQueueFiles()">Add files</button>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:8px;line-height:1.6">' +
      'Uploaded when you save. Up to 25MB each. If this record is shared, the files are shared with it.</div></div>' +
      '<div style="font-size:12px;color:var(--text-muted-color)">Saving notifies them if it is shared.</div>';
    modal('New Record &middot; ' + esc(S.file.user.name), body,
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="er-save" onclick="erSaveNote(\'' + type + '\')">Save to file</button>');
  };

  function typeCard(key, current, title, help) {
    return '<div class="er-type' + (key === current ? ' sel' : '') + '" onclick="erNewRecord(\'' + key + '\', true)">' +
      '<b>' + title + '</b><small>' + help + '</small></div>';
  }

  window.erSaveNote = async function (type) {
    var body = String(val('er-body') || '').trim();
    if (!body) { toast('Say what happened.', 'error'); return; }
    var payload = {
      user_id: S.employeeId, type: type, category: val('er-cat'), occurred_on: val('er-date'),
      body: body, visible_to_employee: swOn('er-vis'), show_in_wins: swOn('er-wins')
    };
    var b = el('er-save'); if (b) b.disabled = true;
    try {
      var out = await api('POST', API + '/notes', payload);
      if ((S.queue || []).length && out && out.id) await uploadAll(out.id, S.queue);
      S.queue = [];
      closeModal();
      toast('Added to the file.', 'success');
      window.erOpenFile(S.employeeId, 'timeline');
    } catch (e) {
      if (b) b.disabled = false;
      toast(e.message || 'Could not save.', 'error');
    }
  };

  // ==================================================================
  // DISCIPLINARY FORM
  // ==================================================================
  window.erNewDisciplinary = function () { openDisciplinary(null); };
  window.erEditDisciplinary = function (id) {
    var recs = (S.file && S.file.records) || [];
    for (var i = 0; i < recs.length; i++) if (recs[i].id === id) return openDisciplinary(recs[i]);
    toast('Draft not found.', 'error');
  };

  function openDisciplinary(rec) {
    closeModal();
    S.view = 'disciplinary';
    S.draft = rec || null;
    S.check = (rec && rec.ai_check) || null;
    S.policy = null;
    drawDisciplinary();
  }

  function drawDisciplinary() {
    var host = content(); if (!host) return;
    var d = S.file, L = d.ladder || {}, rec = S.draft || {};
    var levels = (S.meta && S.meta.levels) || [];
    var cats = (S.meta && S.meta.categories) || [];
    var cons = (S.meta && S.meta.consequences) || {};
    var lvl = rec.level || L.suggested_next || 1;
    var today = new Date().toISOString().slice(0, 10);
    var occurred = (rec.occurred_on ? String(rec.occurred_on).slice(0, 10) : today);
    var escDays = rec.escalation_days || (S.meta && S.meta.default_escalation_days) || 90;

    // Three states for the policy field: nothing cited, one of the library SOPs
    // (sop_id), or something typed by hand (sop_label with no sop_id). An older
    // record made before the library existed lands in the third.
    // A policy comes from one of two places, so the option value carries which:
    // "sop:4" is the SOP library, "doc:9" is a file in a policy folder of the
    // Document Vault. They are grouped so it is obvious which is which.
    var pols = (S.meta && S.meta.policies) || [];
    var sopMode = rec.sop_id ? ('sop:' + rec.sop_id)
      : (rec.policy_document_id ? ('doc:' + rec.policy_document_id)
        : (rec.sop_label ? 'other' : ''));
    var polGroups = [];
    pols.forEach(function (pd) {
      var g = pd.group || 'Policies';
      var found = null;
      polGroups.forEach(function (x) { if (x.name === g) found = x; });
      if (!found) { found = { name: g, items: [] }; polGroups.push(found); }
      found.items.push(pd);
    });
    var polOpts = '<option value=""' + (sopMode === '' ? ' selected' : '') + '>None cited</option>' +
      polGroups.map(function (g) {
        return '<optgroup label="' + esc(g.name) + '">' + g.items.map(function (pd) {
          return '<option value="' + esc(pd.value) + '"' + (sopMode === pd.value ? ' selected' : '') + '>' +
            esc(pd.title) + '</option>';
        }).join('') + '</optgroup>';
      }).join('') +
      '<option value="other"' + (sopMode === 'other' ? ' selected' : '') + '>Other (type it in)</option>';

    var steps = levels.map(function (l) {
      var cls = '';
      if (l.n <= L.highest_live) cls = ' done';
      if (l.n === lvl) cls = ' cur';
      return '<div class="er-step' + cls + '">' + esc(l.label.replace(' Warning (documented)', '').replace(' Warning', '')) + '</div>';
    }).join('');

    var priors = (L.priors || []).filter(function (p) { return !rec.id || p.id !== rec.id; }).slice(0, 4).map(function (p) {
      return '<div class="er-card neg" style="padding:10px 12px;margin-bottom:8px">' +
        '<div class="er-title" style="font-size:13px">' + esc(p.level_label) + (p.category ? ' &middot; ' + esc(p.category) : '') + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted-color);margin-top:3px">' + esc(shortDate(p.occurred_on || p.created_at)) +
        ' &middot; ' + esc(p.status) + (p.live ? '' : ' &middot; outside the window') + '</div></div>';
    }).join('') || '<div style="font-size:12px;color:var(--text-muted-color)">No prior notices on file.</div>';

    var approverOpts = '';
    if (d.user.supervisor) {
      approverOpts += '<option value="' + d.user.supervisor.id + '">' + esc(d.user.supervisor.name) + ' — their supervisor (default)</option>';
    }
    approverOpts += '<option value="">Choose someone else…</option>';

    host.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;color:var(--text-muted-color);cursor:pointer" onclick="erOpenFile(' + S.employeeId + ')">&#8592; ' + esc(d.user.name) + '</div>' +
      '<div class="page-header"><div><h2 style="font-size:22px;font-weight:600">Disciplinary Action &middot; ' + esc(d.user.name) + ' ' +
      badge(rec.status || 'draft') + '</h2>' +
      '<p style="font-size:13px;color:var(--text-muted-color);margin-top:4px">Nothing reaches ' +
      esc(d.user.name.split(' ')[0]) + ' until an approver signs off and it is sent.</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-secondary" onclick="erSaveDraft()">Save draft</button>' +
      '<button class="btn btn-primary" onclick="erSubmitDisciplinary()">Submit for approval</button></div></div>' +

      (rec.approver_note && rec.status === 'returned'
        ? '<div class="alert alert-warn" style="margin-bottom:20px"><b>Sent back by ' + esc(rec.approver_name || 'your approver') + '</b><br>' +
          '<span style="font-size:13px;white-space:pre-wrap">' + esc(rec.approver_note) + '</span></div>' : '') +

      '<div class="er-two"><div>' +

      '<div class="card" style="margin-bottom:16px"><div class="card-header"><div class="card-title">The notice</div></div>' +
      '<div class="card-body">' +
      '<div class="er-grid3">' +
      '<div class="form-group"><label>Level</label><select id="er-level" onchange="erLevelChanged()">' +
      levels.map(function (l) {
        return '<option value="' + l.n + '"' + (l.n === lvl ? ' selected' : '') + '>' + esc(l.label) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="form-group"><label>Category</label><select id="er-cat">' +
      cats.map(function (c) { return '<option' + (rec.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="form-group"><label>Date of incident</label><input type="date" id="er-date" value="' + occurred + '"></div>' +
      '</div>' +
      '<div class="form-group"><label>Description of the incident <span style="color:var(--danger)">*</span></label>' +
      '<textarea id="er-body" style="min-height:120px">' + esc(rec.body || '') + '</textarea>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">' +
      '<button class="btn btn-secondary btn-sm" onclick="erCheckWording(true)">Check wording</button>' +
      '<span style="font-size:12px;color:var(--text-muted-color)">Only runs when you click it, and once more when you submit. Red flags block submission.</span></div>' +
      '<div id="er-ai-body"></div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Policy or SOP violated</label>' +
      '<div class="er-polrow"><select id="er-sop-id" onchange="erSopChanged()">' + polOpts + '</select>' +
      '<button class="btn btn-secondary btn-sm" onclick="erSuggestPolicy()">Suggest policy</button></div>' +
      '<input id="er-sop" placeholder="e.g. SOP-14 Attendance and Punctuality" value="' + esc(rec.sop_label || '') +
      '" style="margin-top:8px' + (sopMode === 'other' ? '' : ';display:none') + '">' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:6px;line-height:1.6">' +
      (pols.length
        ? 'From your SOP library and any Document Vault folder marked as a policy source. Suggest policy reads the incident above and offers only clauses it can quote out of a real document.'
        : 'Nothing indexed yet, so type the policy name. Upload SOPs under Settings &gt; SOPs, or mark a vault folder as a policy source, and they show up in this list.') +
      '</div><div id="er-pol-out"></div></div>' +
      '</div></div>' +

      '<div class="card" style="margin-bottom:16px"><div class="card-header"><div class="card-title">Corrective action</div></div>' +
      '<div class="card-body">' +
      '<div class="form-group"><label>What must change <span style="color:var(--danger)">*</span></label>' +
      '<textarea id="er-corrective" style="min-height:80px">' + esc(rec.corrective_action || '') + '</textarea>' +
      '<div id="er-ai-corrective_action"></div></div>' +
      '<div class="form-group"><label>Consequence if it does not <span style="color:var(--danger)">*</span></label>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:7px;flex-wrap:wrap">' +
      '<span class="badge badge-active" style="text-transform:none" id="er-cons-tag">Default wording for ' + esc(levelName(lvl)) + '</span>' +
      '<span style="font-size:12px;color:var(--text-muted-color)">Refills when you change the level. Edit it freely.</span></div>' +
      '<textarea id="er-consequence" style="min-height:70px">' +
      esc(rec.consequence || cons[String(lvl)] || '') + '</textarea>' +
      '<div id="er-ai-consequence"></div></div>' +
      '<div class="er-grid2">' +
      '<div class="form-group" style="margin-bottom:0"><label>Follow-up date <span style="color:var(--danger)">*</span></label>' +
      '<input type="date" id="er-followup" value="' + (rec.followup_on ? String(rec.followup_on).slice(0, 10) : addDaysStr(today, 30)) + '">' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:6px">Tasks you on that date to record whether it was corrected. Required.</div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Counts toward the ladder for</label>' +
      '<input type="number" id="er-esc" min="0" max="3650" value="' + escDays + '">' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:6px">Days. After that it stays on the file but stops escalating.</div></div>' +
      '</div></div></div>' +

      '<div class="card" style="margin-bottom:16px"><div class="card-header">' +
      '<div class="card-title">Supporting documentation</div>' +
      '<span style="font-size:12px;color:var(--text-muted-color)">optional</span></div>' +
      '<div class="card-body">' +
      '<div id="er-attach-list">' + attachRows(rec.attachments || []) + '</div>' +
      '<button class="btn btn-secondary btn-sm" onclick="erAddAttachments()">Add files</button>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:9px;line-height:1.6">' +
      'The photo, the signed policy page, the customer email, the timesheet. Up to 25MB each, and they stay ' +
      'with the notice permanently. ' + esc(d.user.name.split(' ')[0]) + ' can open anything attached here once ' +
      'the notice is sent, so this is for the evidence, not for your working notes.</div>' +
      '</div></div>' +

      '<div class="card"><div class="card-header"><div class="card-title">Approval and delivery</div>' +
      '<span class="badge badge-waiting">Required at every level</span></div>' +
      '<div class="card-body">' +
      '<div class="form-group"><label>Send to</label>' +
      '<select id="er-approver" onchange="erApproverChanged()">' + approverOpts + '</select>' +
      '<select id="er-approver-any" style="display:none;margin-top:8px"><option value="">Loading…</option></select>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:6px">Defaults to the next person up. The second list is every admin and the owner, so you are not stuck when they are away.</div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Note for the approver (optional)</label>' +
      '<textarea id="er-subnote" style="min-height:56px"></textarea></div>' +
      (d.user.has_email ? '' :
        '<div class="alert alert-error" style="margin-top:14px;font-size:13px">' + esc(d.user.name) +
        ' has no email address on file, so the signature request cannot be sent. Add one under Settings &gt; Users first.</div>') +
      '</div></div>' +

      '</div><div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card-header"><div class="card-title">Prior record</div>' +
      '<span style="font-size:12px;color:var(--text-muted-color)">auto-pulled</span></div>' +
      '<div class="card-body"><div class="er-ladder" style="margin-bottom:14px">' + steps + '</div>' +
      '<div class="alert alert-info" style="font-size:12.5px;margin-bottom:14px"><b>The ladder suggests ' +
      esc(L.suggested_label || '') + '.</b> ' + (L.live_count || 0) + ' live notice' + ((L.live_count === 1) ? '' : 's') +
      ' inside the window. You can override the level; the file keeps what you chose.</div>' + priors +
      '</div></div>' +

      '<div class="card"><div class="card-header"><div class="card-title">What the wording check looks for</div></div>' +
      '<div class="card-body"><div style="font-size:12px;color:var(--text-muted-color);line-height:1.8">' +
      '<span style="color:#f87171;font-weight:700">Red, blocks submit</span><br>' +
      'Anything touching a protected class<br>Medical, injury, leave or comp reasons<br>' +
      'Threats, profanity, personal insults<br>Character judgments instead of behaviour<br><br>' +
      '<span style="color:#fbbf24;font-weight:700">Amber, advisory</span><br>' +
      'Guessing at intent or state of mind<br>Absolutes you cannot keep<br>' +
      'Missing dates, times or measurable standards<br>Vague expectations<br><br>' +
      'It never writes the facts for you and never edits anything on its own, and it does not run while you ' +
      'type - only when you click Check wording, and once more when you submit. What you save is what you ' +
      'typed, and the result is stored with the notice.' +
      '</div></div></div>' +

      '</div></div>';

    if (S.check) paintCheck(S.check);
  }

  function addDaysStr(d, n) {
    var dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  window.erLevelChanged = function () {
    var lvl = parseInt(val('er-level'), 10) || 1;
    var cons = (S.meta && S.meta.consequences) || {};
    var box = el('er-consequence');
    var tag = el('er-cons-tag');
    if (tag) tag.textContent = 'Default wording for ' + levelName(lvl);
    if (!box) return;
    // Only refill when the text is still one of the defaults - never clobber
    // something the manager wrote themselves.
    var current = String(box.value || '').trim();
    var isDefault = !current;
    Object.keys(cons).forEach(function (k) { if (cons[k] && cons[k].trim() === current) isDefault = true; });
    if (isDefault) box.value = cons[String(lvl)] || '';
  };

  // A file has to hang off a record, so an unsaved notice is saved first. That
  // is also why the incident description is required before you can attach
  // anything: erSaveDraft refuses an empty one, and says so.
  window.erAddAttachments = function () {
    pickFiles(async function (files) {
      if (!files.length) return;
      var id = (S.draft && S.draft.id) || null;
      if (!id) {
        id = await window.erSaveDraft(true);
        if (!id) return;
        toast('Draft saved, so the files have somewhere to go.', 'info');
      }
      await uploadAll(id, files);
      await refreshAttachments(id);
    });
  };

  // ---- policy ---------------------------------------------------------------
  //
  // sop_id is the citation; sop_label is what gets printed on the notice. When a
  // library SOP is picked the label is filled from its title, so the notice
  // reads the same whether the policy came from the list or was typed.
  // "sop:4" / "doc:9" / "other" / "". Returns the pair the server stores; exactly
  // one of the two is ever set.
  function citation() {
    var v = String(val('er-sop-id') || '');
    var m = /^(sop|doc):([0-9]+)$/.exec(v);
    if (!m) return { sop_id: null, policy_document_id: null };
    return m[1] === 'sop'
      ? { sop_id: parseInt(m[2], 10), policy_document_id: null }
      : { sop_id: null, policy_document_id: parseInt(m[2], 10) };
  }

  window.erSopChanged = function () {
    var sel = el('er-sop-id'), box = el('er-sop');
    if (!sel || !box) return;
    var other = String(sel.value || '') === 'other';
    box.style.display = other ? '' : 'none';
    if (!other) {
      var opt = sel.options && sel.options[sel.selectedIndex];
      box.value = sel.value ? String((opt && (opt.text || opt.textContent)) || '') : '';
    }
  };

  window.erSuggestPolicy = async function () {
    var body = String(val('er-body') || '').trim();
    if (!body) { toast('Describe the incident first. The suggestion reads what you wrote.', 'error'); return; }
    if (S.busy) return;
    S.busy = true;
    var host = el('er-pol-out');
    if (host) host.innerHTML = '<div class="er-pol empty">Reading your policy documents&hellip;</div>';
    try {
      var d = await api('POST', API + '/policy-suggest', { body: body, category: val('er-cat') });
      S.policy = d;
      paintPolicy(d);
    } catch (e) {
      if (host) host.innerHTML = '';
      toast(e.message || 'Could not read your policy documents.', 'error');
    }
    S.busy = false;
  };

  // An empty list is a normal answer, so it gets a real explanation rather than
  // silence. "The AI is switched off" and "your SOP library does not cover this
  // yet" are two different problems with two different fixes.
  function paintPolicy(d) {
    var host = el('er-pol-out'); if (!host) return;
    if (!d) { host.innerHTML = ''; return; }
    var cands = d.candidates || [];
    if (!cands.length) {
      var why;
      if (d.reason === 'no_key') why = 'The AI is not configured on this deployment, so there is nothing to suggest from. Pick the policy yourself.';
      else if (d.reason === 'ai_failed') why = 'Could not reach the model just now. Pick the policy yourself, or try again.';
      else why = 'Nothing in your policy documents covers what you described. Pick one yourself, or add the policy under Settings &gt; SOPs or your policy folder in Documents, and try again.';
      host.innerHTML = '<div class="er-pol empty">' + why + '</div>';
      return;
    }
    host.innerHTML = '<div class="er-pol-list">' + cands.map(function (c, i) {
      return '<div class="er-pol">' +
        '<div class="er-pol-h"><b>' + esc(c.title) + '</b>' +
        '<button class="btn btn-primary btn-sm" onclick="erUsePolicy(' + i + ')">Use this</button></div>' +
        '<div class="er-pol-q">' + esc(c.quote) + '</div>' +
        (c.why ? '<div class="er-pol-w">' + esc(c.why) + '</div>' : '') +
        '</div>';
    }).join('') +
      '<div class="er-pol-note">Each line above is quoted from the SOP itself. Anything the model could not ' +
      'quote out of a real document was dropped rather than shown to you.</div></div>';
  }

  window.erUsePolicy = function (i) {
    var c = S.policy && S.policy.candidates && S.policy.candidates[i];
    if (!c) return;
    var want = (c.source === 'document') ? ('doc:' + c.document_id) : ('sop:' + c.sop_id);
    var sel = el('er-sop-id'), box = el('er-sop');
    if (box) box.value = c.title;
    if (sel) {
      sel.value = want;
      if (String(sel.value) !== want) {
        // The SOP was deactivated between loading this form and now. Keep the
        // citation as free text rather than silently dropping it on the floor.
        sel.value = 'other';
        if (box) box.style.display = '';
        toast('That policy is no longer in the list, so it has been kept as typed text.', 'info');
        return;
      }
    }
    if (box) box.style.display = 'none';
    toast('Policy set to ' + c.title + '.', 'success');
  };

  window.erApproverChanged = async function () {
    var sel = el('er-approver'), any = el('er-approver-any');
    if (!sel || !any) return;
    if (sel.value) { any.style.display = 'none'; return; }
    any.style.display = '';
    if (any.getAttribute('data-loaded') === '1') return;
    try {
      var users = await api('GET', '/users');
      var opts = (users || []).filter(function (u) {
        return u.active !== false && (u.role === 'admin' || u.role === 'owner') && u.id !== (state.user && state.user.id);
      }).map(function (u) { return '<option value="' + u.id + '">' + esc(u.name) + ' — ' + esc(u.role) + '</option>'; });
      any.innerHTML = '<option value="">Pick an approver…</option>' + opts.join('');
      any.setAttribute('data-loaded', '1');
    } catch (e) { any.innerHTML = '<option value="">Could not load users</option>'; }
  };

  function draftPayload() {
    return {
      id: (S.draft && S.draft.id) || undefined,
      user_id: S.employeeId,
      level: parseInt(val('er-level'), 10) || 1,
      category: val('er-cat'),
      occurred_on: val('er-date'),
      body: String(val('er-body') || '').trim(),
      corrective_action: String(val('er-corrective') || '').trim(),
      consequence: String(val('er-consequence') || '').trim(),
      sop_id: citation().sop_id,
      policy_document_id: citation().policy_document_id,
      sop_label: val('er-sop'),
      followup_on: val('er-followup'),
      escalation_days: parseInt(val('er-esc'), 10)
    };
  }

  window.erSaveDraft = async function (quiet) {
    var p = draftPayload();
    if (!p.body) { toast('Describe the incident first.', 'error'); return null; }
    try {
      var out = await api('POST', API + '/disciplinary', p);
      S.draft = out.record;
      if (!quiet) toast('Draft saved.', 'success');
      return out.id;
    } catch (e) { toast(e.message || 'Could not save.', 'error'); return null; }
  };

  window.erSubmitDisciplinary = async function () {
    var p = draftPayload();
    if (!p.body || !p.corrective_action || !p.consequence) {
      toast('The incident, what must change and the consequence are all required.', 'error'); return;
    }
    if (!p.followup_on) { toast('Set a follow-up date.', 'error'); return; }
    var approver = val('er-approver') || val('er-approver-any');
    if (!approver) { toast('Pick an approver.', 'error'); return; }
    var id = await window.erSaveDraft(true);
    if (!id) return;
    try {
      await api('POST', API + '/disciplinary/' + id + '/submit', {
        approver_id: parseInt(approver, 10), note: val('er-subnote')
      });
      toast('Submitted for approval.', 'success');
      window.erOpenFile(S.employeeId, 'timeline');
    } catch (e) {
      if (e && e.check) { S.check = e.check; paintCheck(e.check); }
      toast(e.message || 'Could not submit.', 'error');
      // The 422 body carries the check; api() may only surface the message, so
      // re-run the check locally to show the manager WHICH words are the problem.
      if (!e || !e.check) window.erCheckWording(true);
    }
  };

  window.erCheckWording = async function (explicit) {
    var p = draftPayload();
    if (!p.body && !p.corrective_action && !p.consequence) return;
    if (S.busy) return;
    S.busy = true;
    if (explicit) toast('Checking the wording…', 'info');
    try {
      var out = await api('POST', API + '/check', {
        body: p.body, corrective_action: p.corrective_action, consequence: p.consequence,
        level: p.level, category: p.category
      });
      S.check = out;
      paintCheck(out);
    } catch (e) { /* never block on the check */ }
    S.busy = false;
  };

  function paintCheck(check) {
    var map = { body: 'er-ai-body', corrective_action: 'er-ai-corrective_action', consequence: 'er-ai-consequence' };
    Object.keys(map).forEach(function (f) {
      var host = el(map[f]); if (!host) return;
      var r = (check && check.fields && check.fields[f]) || null;
      if (!r || !r.checked || !r.flags || !r.flags.length) { host.innerHTML = ''; return; }
      var clear = r.reds === 0 && r.ambers === 0;
      var head = clear ? 'Wording check &middot; clear'
        : 'Wording check &middot; ' + r.reds + ' red, ' + r.ambers + ' amber';
      host.innerHTML = '<div class="er-ai' + (clear ? ' clear' : '') + '"><h5>' + head + '</h5>' +
        r.flags.map(function (fl) {
          return '<div class="er-flag"><div class="er-fdot ' + esc(fl.severity) + '"></div><div>' +
            '<b>' + esc(fl.title) + '</b> ' + esc(fl.detail) + '</div></div>';
        }).join('') +
        (r.suggestion ? '<div class="er-sugg"><b style="color:var(--text)">Suggested wording</b><br>' +
          esc(r.suggestion.text) +
          '<div style="display:flex;gap:8px;margin-top:10px">' +
          '<button class="btn btn-primary btn-sm" onclick="erUseSuggestion(\'' + f + '\')">Use this</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="erDismissSuggestion(\'' + f + '\')">Dismiss</button>' +
          '</div></div>' : '') +
        '</div>';
    });
  }

  window.erUseSuggestion = function (field) {
    var r = S.check && S.check.fields && S.check.fields[field];
    if (!r || !r.suggestion) return;
    var id = field === 'body' ? 'er-body' : field === 'corrective_action' ? 'er-corrective' : 'er-consequence';
    var box = el(id); if (!box) return;
    var sug = r.suggestion;
    if (sug.replaces && box.value.indexOf(sug.replaces) !== -1) box.value = box.value.replace(sug.replaces, sug.text);
    else box.value = sug.text;
    // Deliberately does NOT re-run the check. The check runs when you ask for it
    // and when you submit, and nowhere else - it used to fire on every blur,
    // which spent a model call on the pre-filled consequence line before the
    // manager had typed a word.
    if (S.check && S.check.fields && S.check.fields[field]) S.check.fields[field] = null;
    paintCheck(S.check);
    toast('Wording replaced. Click Check wording when you want it looked at again.', 'info');
  };
  window.erDismissSuggestion = function (field) {
    if (S.check && S.check.fields && S.check.fields[field]) S.check.fields[field].suggestion = null;
    paintCheck(S.check);
  };

  window.erDeleteDraft = async function (id) {
    if (!confirm('Delete this draft? Nothing was ever sent.')) return;
    try { await api('DELETE', API + '/' + id, {}); toast('Draft deleted.', 'info'); window.erOpenFile(S.employeeId); }
    catch (e) { toast(e.message || 'Could not delete.', 'error'); }
  };

  // ==================================================================
  // APPROVALS
  // ==================================================================
  window.erOpenApprovals = async function () {
    var host = content(); if (!host) return;
    host.innerHTML = '<div class="loading">Loading…</div>';
    var list;
    try { list = await api('GET', API + '/approvals'); await loadMeta(); }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load.') + '</div>'; return; }
    if (!list.length) {
      host.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;color:var(--text-muted-color);cursor:pointer" onclick="erBackToRoster()">&#8592; Employee Files</div>' +
        '<div class="card"><div class="empty-state"><h3>Nothing waiting on you</h3></div></div>';
      return;
    }
    host.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;color:var(--text-muted-color);cursor:pointer" onclick="erBackToRoster()">&#8592; Employee Files</div>' +
      '<div class="page-header"><h2 style="font-size:22px;font-weight:600">Approvals</h2></div>' +
      list.map(function (r) {
        return '<div class="card" style="margin-bottom:16px"><div class="card-header">' +
          '<div class="card-title">' + esc(r.level_label) + ' &middot; ' + esc(r.employee_name) + '</div>' +
          '<span class="badge badge-waiting">Pending your approval</span></div>' +
          '<div class="card-body">' +
          '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:12px">Submitted by ' +
          esc(r.created_by_name || '') + ' &middot; ' + esc(shortDate(r.submitted_at)) +
          (r.category ? ' &middot; ' + esc(r.category) : '') + '</div>' +
          field('Description of the incident', r.body) +
          field('What must change', r.corrective_action) +
          field('Consequence if it does not', r.consequence) +
          (r.sop_label ? field('Policy cited', r.sop_label) : '') +
          (r.followup_on ? field('Follow-up date', shortDate(r.followup_on)) : '') +
          checkSummary(r.ai_check) +
          (r.attachments && r.attachments.length
            ? '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted-color);font-weight:600;margin-top:12px">Supporting documentation</div>'
            : '') +
          attachChips(r.attachments) +
          '<div class="form-group" style="margin-top:14px"><label>Note (shown to the author, not the employee)</label>' +
          '<textarea id="er-anote-' + r.id + '" style="min-height:60px"></textarea></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-success" onclick="erApprove(' + r.id + ')">Approve and send</button>' +
          '<button class="btn btn-secondary" onclick="erReturn(' + r.id + ')">Send back for changes</button></div>' +
          '<div style="font-size:12px;color:var(--text-muted-color);margin-top:10px">You cannot edit the notice yourself. ' +
          'Sending it back keeps everything they wrote and reopens it for them.</div>' +
          '</div></div>';
      }).join('');
  };

  function field(label, text) {
    if (!text) return '';
    return '<div style="margin-bottom:10px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted-color);font-weight:600">' +
      esc(label) + '</div><div style="font-size:13.5px;color:var(--text-dim);line-height:1.6;white-space:pre-wrap">' + esc(text) + '</div></div>';
  }

  function checkSummary(check) {
    if (!check || !check.available) return '';
    if (!check.reds && !check.ambers) {
      return '<div class="er-ai clear" style="margin-top:12px"><h5>Wording check &middot; clear when submitted</h5></div>';
    }
    return '<div class="er-ai" style="margin-top:12px"><h5>Wording check &middot; ' + (check.reds || 0) + ' red, ' + (check.ambers || 0) + ' amber at submission</h5>' +
      Object.keys(check.fields || {}).map(function (f) {
        return ((check.fields[f] || {}).flags || []).filter(function (fl) { return fl.severity !== 'green'; }).map(function (fl) {
          return '<div class="er-flag"><div class="er-fdot ' + esc(fl.severity) + '"></div><div><b>' + esc(fl.title) + '</b> ' + esc(fl.detail) + '</div></div>';
        }).join('');
      }).join('') + '</div>';
  }

  window.erApprove = async function (id) {
    if (!confirm('Approve this notice? It will be sent to the employee for signature straight away.')) return;
    try {
      await api('POST', API + '/disciplinary/' + id + '/approve', { note: val('er-anote-' + id) });
      toast('Approved and sent.', 'success');
      window.erOpenApprovals();
    } catch (e) { toast(e.message || 'Could not approve.', 'error'); }
  };
  window.erReturn = async function (id) {
    var note = String(val('er-anote-' + id) || '').trim();
    if (!note) { toast('Say what needs changing.', 'error'); return; }
    try {
      await api('POST', API + '/disciplinary/' + id + '/return', { note: note });
      toast('Sent back.', 'info');
      window.erOpenApprovals();
    } catch (e) { toast(e.message || 'Could not send it back.', 'error'); }
  };

  // ==================================================================
  // SIGNATURE STATUS, REFUSAL, FOLLOW-UP, HISTORY, VOID
  // ==================================================================
  window.erResend = async function (id, extend) {
    try {
      await api('POST', API + '/disciplinary/' + id + '/resend', { extend: !!extend });
      toast(extend ? 'Extended and reminded.' : 'Reminder sent.', 'success');
      window.erOpenFile(S.employeeId);
    } catch (e) { toast(e.message || 'Could not resend.', 'error'); }
  };

  window.erRefuse = function (id) {
    var body =
      '<div class="alert alert-warn" style="font-size:12.5px;margin-bottom:16px">' +
      'A refusal does not void the notice. It stays on the file, it still counts on the ladder, and the ' +
      'delivery trail is what proves it was received. There is no witness field: one person administers a ' +
      'notice here, so the record of when it was sent, opened and reminded does that job instead.</div>' +
      '<div class="form-group"><label>What happened <span style="color:var(--danger)">*</span></label>' +
      '<select id="er-refuse-kind">' +
      '<option value="declined_in_request">They declined it in Nova</option>' +
      '<option value="told_me_directly">They told me directly they will not sign</option>' +
      '<option value="no_response">No response before the request expired</option>' +
      '</select></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Notes</label>' +
      '<textarea id="er-refuse-note" style="min-height:90px" placeholder="What they said, and how the notice was gone through with them."></textarea></div>';
    modal('Record a refusal', body,
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-danger" onclick="erSaveRefusal(' + id + ')">Record refusal and file</button>');
  };

  window.erSaveRefusal = async function (id) {
    try {
      await api('POST', API + '/disciplinary/' + id + '/refuse', {
        kind: val('er-refuse-kind'), note: val('er-refuse-note')
      });
      closeModal(); toast('Refusal recorded.', 'success');
      window.erOpenFile(S.employeeId);
    } catch (e) { toast(e.message || 'Could not record it.', 'error'); }
  };

  window.erFollowup = async function (id) {
    var rec = null;
    ((S.file && S.file.records) || []).forEach(function (r) { if (r.id === id) rec = r; });
    if (!rec) return;
    var signals = null;
    try { signals = await api('GET', API + '/' + id + '/signals'); } catch (e) {}
    var sigHtml = '';
    if (signals && signals.signals && signals.signals.length) {
      sigHtml = '<div class="card" style="margin-bottom:14px"><div class="card-header">' +
        '<div class="card-title" style="font-size:14px">What Nova has seen since</div></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Signal</th><th>Since</th><th>30 days before</th></tr></thead><tbody>' +
        signals.signals.map(function (s) {
          var col = s.good ? 'var(--success)' : (s.since > 0 ? 'var(--warning)' : 'var(--success)');
          return '<tr><td>' + esc(s.label) + '</td>' +
            '<td style="color:' + col + ';font-weight:600">' + s.since + '</td>' +
            '<td>' + (s.before === null ? '—' : s.before) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="card-body" style="border-top:1px solid var(--border);font-size:12px;color:var(--text-muted-color)">' +
        'Evidence, not a verdict. The clock data is what it is; you decide whether the behaviour changed.</div></div>';
    }
    var body = sigHtml +
      '<div class="form-group"><label>Outcome <span style="color:var(--danger)">*</span></label>' +
      '<div class="er-types" style="grid-template-columns:1fr">' +
      '<div class="er-type sel" id="er-out-corrected" onclick="erPickOutcome(\'corrected\')"><b style="color:#4ade80">Corrected</b>' +
      '<small>Closes the follow-up. The notice stays on the file and still counts on the ladder until its window closes.</small></div>' +
      '<div class="er-type" id="er-out-not_corrected" onclick="erPickOutcome(\'not_corrected\')"><b style="color:#f87171">Not corrected</b>' +
      '<small>Closes this follow-up and opens the next level, pre-filled with this notice as the prior.</small></div>' +
      '<div class="er-type" id="er-out-extended" onclick="erPickOutcome(\'extended\')"><b>Extend the follow-up</b>' +
      '<small>Pick a new date. Logged on the record so an extension never looks like it was dropped.</small></div>' +
      '</div></div>' +
      '<div class="form-group" id="er-newdate-wrap" style="display:none"><label>New follow-up date</label>' +
      '<input type="date" id="er-newdate" value="' + addDaysStr(new Date().toISOString().slice(0, 10), 30) + '"></div>' +
      '<div class="form-group"><label>Notes <span style="color:var(--danger)">*</span></label>' +
      '<textarea id="er-fnote" style="min-height:90px"></textarea></div>' +
      sw('er-telltheir', true, 'Tell them it was corrected', 'Half the point of a follow-up is that they hear the good half too.');
    modal('Follow-up &middot; ' + esc(S.file.user.name), body,
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-success" id="er-fsave" onclick="erSaveFollowup(' + id + ')">Record the outcome</button>', 640);
    S.outcome = 'corrected';
  };

  window.erPickOutcome = function (o) {
    S.outcome = o;
    ['corrected', 'not_corrected', 'extended'].forEach(function (k) {
      var e = el('er-out-' + k);
      if (e) e.className = 'er-type' + (k === o ? ' sel' : '');
    });
    var w = el('er-newdate-wrap'); if (w) w.style.display = (o === 'extended') ? '' : 'none';
    var b = el('er-fsave');
    if (b) {
      b.className = 'btn ' + (o === 'not_corrected' ? 'btn-danger' : o === 'extended' ? 'btn-secondary' : 'btn-success');
      b.textContent = o === 'not_corrected' ? 'Record and open the next level' : 'Record the outcome';
    }
  };

  window.erSaveFollowup = async function (id) {
    var note = String(val('er-fnote') || '').trim();
    if (!note) { toast('Write a short note on what happened.', 'error'); return; }
    try {
      var out = await api('POST', API + '/' + id + '/followup', {
        outcome: S.outcome || 'corrected', note: note,
        followup_on: val('er-newdate'), tell_employee: swOn('er-telltheir')
      });
      closeModal();
      toast('Follow-up recorded.', 'success');
      if (out && out.next_level) {
        await window.erOpenFile(S.employeeId);
        S.draft = null;
        openDisciplinary(null);
        var sel = el('er-level');
        if (sel) { sel.value = String(out.next_level); window.erLevelChanged(); }
        toast('Next level pre-filled. Check the wording before you submit.', 'info');
      } else {
        window.erOpenFile(S.employeeId);
      }
    } catch (e) { toast(e.message || 'Could not record it.', 'error'); }
  };

  window.erVoid = async function (id) {
    var reason = prompt('Voiding keeps the record on the file, marked void, with your reason. Why is it being voided?');
    if (!reason) return;
    try {
      await api('POST', API + '/' + id + '/void', { reason: reason });
      toast('Record voided.', 'info');
      window.erOpenFile(S.employeeId);
    } catch (e) { toast(e.message || 'Could not void it.', 'error'); }
  };

  window.erHistory = async function (id) {
    var rows;
    try { rows = await api('GET', API + '/' + id + '/events'); }
    catch (e) { toast(e.message || 'Could not load the history.', 'error'); return; }
    var body = rows.length ? rows.map(function (ev) {
      return '<div style="padding:9px 0;border-bottom:1px solid var(--border-light)">' +
        '<div style="font-size:13px;color:var(--text)">' + esc(String(ev.action).replace(/_/g, ' ')) +
        (ev.user_name ? ' <span style="color:var(--text-muted-color)">by ' + esc(ev.user_name) + '</span>' : '') + '</div>' +
        (ev.note ? '<div style="font-size:12px;color:var(--text-dim);white-space:pre-wrap;margin-top:3px">' + esc(ev.note) + '</div>' : '') +
        '<div style="font-size:11px;color:var(--text-muted-color);margin-top:2px">' + esc(shortDate(ev.created_at)) + '</div></div>';
    }).join('') : '<div style="color:var(--text-muted-color);font-size:13px">Nothing recorded yet.</div>';
    modal('Record history', body, '<button class="btn btn-secondary" onclick="erCloseModal()">Close</button>', 560);
  };


  // ==================================================================
  // PEER SHOUT-OUTS
  // ==================================================================
  //
  // An employee recognizing a COWORKER. It is a nomination, not a record: the
  // modal says that out loud, because somebody who thinks they are posting
  // straight to the Home screen and then waits two days for it to appear has
  // been misled by the UI, not by the manager who was reading it.
  //
  // Everything on this side is gated by submit_shoutout, which ships dark like
  // the rest of this module. Approving is gated by create_employee_note, and the
  // server re-checks canActOn() per row on top of that - the queue below only
  // ever shows rows the viewer is actually allowed to clear.
  var SO = { people: null, pending: [] };

  window.erShoutout = async function () {
    injectCss();
    if (!SO.people) {
      try { var d = await api('GET', API + '/shoutouts/people'); SO.people = d.people || []; }
      catch (e) { toast(e.message || 'Could not load your coworkers.', 'error'); return; }
    }
    if (!SO.people.length) { toast('Nobody to send one to yet.', 'info'); return; }
    var opts = '<option value="">Pick a coworker...</option>' + SO.people.map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.name) +
        (p.home_city ? ' (' + esc(p.home_city) + ')' : '') + '</option>';
    }).join('');
    modal('Send a shout-out',
      '<div class="form-group"><label>Who</label><select id="er-so-to">' + opts + '</select></div>' +
      '<div class="form-group"><label>What for ' +
      '<span style="color:var(--text-muted-color);font-weight:400">(optional)</span></label>' +
      '<input id="er-so-cat" maxlength="60" placeholder="Customer service, Teamwork, Safety..."></div>' +
      '<div class="form-group"><label>What did they do?</label>' +
      '<textarea id="er-so-body" rows="5" maxlength="2000" ' +
      'placeholder="Be specific: what happened, and why it mattered."></textarea></div>' +
      '<div class="alert alert-info" style="font-size:12.5px;margin:0">A manager reads it before it goes ' +
      'anywhere. If it goes out, it lands on their file and on Recent Wins with <b>your</b> name on it.</div>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="er-so-send" onclick="erShoutoutSend()">Send it</button>', 560);
  };

  window.erShoutoutSend = async function () {
    var to = parseInt(val('er-so-to'), 10) || 0;
    var body = String(val('er-so-body') || '').trim();
    if (!to) { toast('Pick a coworker first.', 'error'); return; }
    if (!body) { toast('Say what they did.', 'error'); return; }
    var b = el('er-so-send');
    if (b) { b.disabled = true; b.textContent = 'Sending...'; }
    try {
      await api('POST', API + '/shoutouts', {
        to_user_id: to,
        category: String(val('er-so-cat') || '').trim(),
        body: body
      });
      closeModal();
      toast('Sent. A manager will take a look at it.', 'success');
      // If My File is open behind the modal, the sent list under it is now stale.
      if (typeof state !== 'undefined' && state && state.currentView === 'my-documents') {
        try { await window.renderMyFile(content()); } catch (e) {}
      }
    } catch (e) {
      toast(e.message || 'Could not send it.', 'error');
      if (b) { b.disabled = false; b.textContent = 'Send it'; }
    }
  };

  // ---- what I have sent, shown on My File ----------------------------------
  //
  // Deliberately only on the AUTHOR&#39;s screen. A pending shout-out is invisible
  // to the person it is about, so that a declined one is never something they
  // find out existed.
  async function mySentShoutoutsHtml() {
    if (!((typeof can === 'function') && can('submit_shoutout'))) return '';
    var rows;
    try { var d = await api('GET', API + '/shoutouts/mine'); rows = d.shoutouts || []; }
    catch (e) { return ''; }
    var list = rows.length ? rows.map(function (s) {
      var st = String(s.status || 'pending');
      var lab = st === 'approved' ? 'Posted' : (st === 'declined' ? 'Not posted' : 'With a manager');
      return '<div class="er-so">' +
        '<div class="er-so-head"><div style="font-size:13.5px;font-weight:600;color:var(--text)">' +
        'For ' + esc(s.to_name || '') + (s.category ? ' <span class="cat" style="font-weight:400;font-size:12px;color:var(--text-muted-color)">&middot; ' + esc(s.category) + '</span>' : '') +
        '</div><span class="er-so-st ' + esc(st) + '">' + lab + '</span></div>' +
        '<div class="er-so-body">' + esc(s.body || '') + '</div>' +
        (st === 'declined' && s.decline_reason
          ? '<div class="er-sugg" style="margin-top:9px">' + esc(s.decline_reason) + '</div>' : '') +
        '<div class="er-so-meta">' + esc(shortDate(s.created_at)) + '</div></div>';
    }).join('') : '<div style="color:var(--text-muted-color);font-size:13px">' +
      'You have not sent one yet. Caught somebody doing good work?</div>';

    return '<div class="card" style="margin-bottom:16px"><div class="card-header">' +
      '<div class="card-title">Shout-outs you sent</div>' +
      '<button class="btn btn-secondary btn-sm" onclick="erShoutout()">+ Shout-out</button>' +
      '</div><div class="card-body">' + list + '</div></div>';
  }

  // ---- the approval queue ---------------------------------------------------
  window.erOpenShoutouts = async function () {
    var host = content(); if (!host) return;
    host.innerHTML = '<div class="loading">Loading...</div>';
    var list;
    try { var d = await api('GET', API + '/shoutouts/pending'); list = d.shoutouts || []; }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not load.') + '</div>'; return; }
    SO.pending = list;
    var back = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;' +
      'color:var(--text-muted-color);cursor:pointer" onclick="erBackToRoster()">&#8592; Employee Files</div>';
    if (!list.length) {
      host.innerHTML = back + '<div class="card"><div class="empty-state"><h3>No shout-outs waiting</h3>' +
        '<p style="font-size:13px;color:var(--text-muted-color)">When somebody recognizes a coworker, ' +
        'it lands here before it goes anywhere else.</p></div></div>';
      return;
    }
    host.innerHTML = back +
      '<div class="page-header"><div><h2 style="font-size:22px;font-weight:600">Shout-outs</h2>' +
      '<p style="font-size:13px;color:var(--text-muted-color);margin-top:4px">' + list.length +
      ' waiting on you. Approving adds it to the file and credits whoever wrote it, not you.</p></div></div>' +
      list.map(function (s) {
        return '<div class="er-so">' +
          '<div class="er-so-head">' +
          '<div style="display:flex;align-items:center;gap:10px">' +
          '<div class="avatar" style="width:30px;height:30px;font-size:11px">' + esc(initials(s.to_name)) + '</div>' +
          '<div><div style="font-size:14px;font-weight:600;color:var(--text)">' + esc(s.to_name || '') + '</div>' +
          '<div style="font-size:11.5px;color:var(--text-muted-color)">' + esc(s.to_role || '') +
          (s.to_city ? ' &middot; ' + esc(s.to_city) : '') + '</div></div></div>' +
          (s.category ? '<span class="badge badge-active">' + esc(s.category) + '</span>' : '') +
          '</div>' +
          '<div class="er-so-body">' + esc(s.body || '') + '</div>' +
          '<div class="er-so-meta">Written by <b style="color:var(--text-dim)">' + esc(s.from_name || '') +
          '</b> &middot; ' + esc(shortDate(s.created_at)) + '</div>' +
          '<div class="er-acts">' +
          '<button class="btn btn-primary btn-sm" onclick="erSoApprove(' + s.id + ')">Review and approve</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="erSoDecline(' + s.id + ')">Decline</button>' +
          '</div></div>';
      }).join('');
  };

  function soById(id) {
    for (var i = 0; i < SO.pending.length; i++) if (SO.pending[i].id === id) return SO.pending[i];
    return null;
  }

  // The approver may tidy the wording before it goes on a permanent file and
  // onto a shared screen - that is half of what approval is for. The original is
  // kept on the record&#39;s event trail, so an edit is never a silent rewrite.
  window.erSoApprove = function (id) {
    var s = soById(id);
    if (!s) { toast('Reload the page and try again.', 'error'); return; }
    modal('Approve this shout-out',
      '<div style="font-size:13px;color:var(--text-muted-color);margin-bottom:14px">' +
      'For <b style="color:var(--text)">' + esc(s.to_name) + '</b>, written by ' + esc(s.from_name) + '.</div>' +
      '<div class="form-group"><label>Category ' +
      '<span style="color:var(--text-muted-color);font-weight:400">(optional)</span></label>' +
      '<input id="er-so-acat" maxlength="60" value="' + esc(s.category || '') + '"></div>' +
      '<div class="form-group"><label>Wording</label>' +
      '<textarea id="er-so-abody" rows="5" maxlength="8000">' + esc(s.body || '') + '</textarea>' +
      '<div style="font-size:11.5px;color:var(--text-muted-color);margin-top:5px">' +
      'Edit it if it needs tidying. The original is kept on the record history either way.</div></div>' +
      sw('er-so-awins', true, 'Show on Recent Wins',
        'Off means it still goes on their file and they are still told about it, it just does not go on the Home screen.'),
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="er-so-ago" onclick="erSoApproveGo(' + id + ')">Approve</button>', 600);
  };

  window.erSoApproveGo = async function (id) {
    var b = el('er-so-ago');
    if (b) { b.disabled = true; b.textContent = 'Approving...'; }
    try {
      await api('POST', API + '/shoutouts/' + id + '/approve', {
        body: String(val('er-so-abody') || '').trim(),
        category: String(val('er-so-acat') || '').trim(),
        show_in_wins: swOn('er-so-awins')
      });
      closeModal();
      toast('Approved. It is on their file now.', 'success');
      await window.erOpenShoutouts();
    } catch (e) {
      toast(e.message || 'Could not approve it.', 'error');
      if (b) { b.disabled = false; b.textContent = 'Approve'; }
    }
  };

  window.erSoDecline = function (id) {
    var s = soById(id);
    if (!s) { toast('Reload the page and try again.', 'error'); return; }
    modal('Decline this shout-out',
      '<div class="alert alert-info" style="font-size:12.5px">' + esc(s.to_name) + ' was never told this ' +
      'existed and will not be told now. Only ' + esc(s.from_name) + ' hears back.</div>' +
      '<div class="form-group"><label>What should ' + esc(s.from_name) + ' know? ' +
      '<span style="color:var(--text-muted-color);font-weight:400">(optional)</span></label>' +
      '<textarea id="er-so-dr" rows="3" maxlength="500" ' +
      'placeholder="Kept short and kind. It is sent to them as written."></textarea></div>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-danger" id="er-so-dgo" onclick="erSoDeclineGo(' + id + ')">Decline</button>', 560);
  };

  window.erSoDeclineGo = async function (id) {
    var b = el('er-so-dgo');
    if (b) { b.disabled = true; b.textContent = 'Working...'; }
    try {
      await api('POST', API + '/shoutouts/' + id + '/decline', { reason: String(val('er-so-dr') || '').trim() });
      closeModal();
      toast('Declined.', 'info');
      await window.erOpenShoutouts();
    } catch (e) {
      toast(e.message || 'Could not decline it.', 'error');
      if (b) { b.disabled = false; b.textContent = 'Decline'; }
    }
  };

  // ==================================================================
  // WRAPPERS over onboarding.js / app.js
  // ==================================================================
  var origEmployeeFiles = window.renderEmployeeFiles;
  window.renderEmployeeFiles = async function (host) {
    injectCss();
    // Anyone without the new permission keeps exactly the page they have today.
    if (!can('view_employee_records')) {
      if (typeof origEmployeeFiles === 'function') return origEmployeeFiles(host);
      host.innerHTML = '<div class="alert alert-error">Access denied.</div>';
      return;
    }
    S.view = 'roster';
    await renderRoster(host);
  };

  var origMyFile = window.renderMyFile;
  window.renderMyFile = async function (host) {
    injectCss();
    host.innerHTML = '<div id="er-mine"></div><div id="er-sent"></div><div id="er-docs"></div>';
    var mine = el('er-mine');
    try {
      var d = await api('GET', API + '/me');
      mine.innerHTML = myRecordsHtml(d.records || []);
      // The file is loaded, so the sidebar count is reconciled from it rather
      // than by asking again. Every action that changes it - sign, refuse,
      // acknowledge - re-renders this screen, so the badge follows for free.
      setPending((d.records || []).filter(function (r) { return r.needs_signature; }).length);
    } catch (e) { mine.innerHTML = ''; }
    // Shout-outs this person has SENT, and where each one got to. Its own fetch
    // and its own slot so a failure here cannot take the file down with it.
    try {
      var sent = el('er-sent');
      if (sent) sent.innerHTML = await mySentShoutoutsHtml();
    } catch (e) {}
    if (typeof origMyFile === 'function') {
      try { await origMyFile(el('er-docs')); } catch (e) {}
    }
  };

  function myRecordsHtml(recs) {
    if (!recs.length) return '';
    var needSign = recs.filter(function (r) { return r.needs_signature; });
    var rest = recs.filter(function (r) { return !r.needs_signature; });
    var out = '<h1 style="margin-bottom:6px">My File</h1>' +
      '<div class="alert alert-info" style="margin-bottom:20px;font-size:13px">' +
      'This is what your manager has shared with you. Internal notes are not shown here.</div>';

    out += needSign.map(function (r) {
      return '<div class="card" style="margin-bottom:16px;border-color:#4a3500">' +
        '<div class="card-header" style="border-bottom-color:#4a3500">' +
        '<div class="card-title">' + esc(r.level_label || 'Notice') + (r.category ? ' &middot; ' + esc(r.category) : '') + '</div>' +
        '<span class="badge badge-awaiting-signature">Needs your signature</span></div>' +
        '<div class="card-body">' +
        '<div class="er-body" style="margin-bottom:10px">' + esc(r.body || '') + '</div>' +
        (r.corrective_action ? field('What must change', r.corrective_action) : '') +
        (r.consequence ? field('Consequence if it does not', r.consequence) : '') +
        attachChips(r.attachments) +
        '<div style="font-size:12px;color:var(--text-muted-color);margin:10px 0">Issued by ' +
        esc(r.created_by_name || '') + (r.approver_name ? ', approved by ' + esc(r.approver_name) : '') +
        '. Signing confirms you have read it. It does not mean you agree with it, and you can attach a ' +
        'written response of your own.</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-primary btn-sm" onclick="erSignOpen(' + r.id + ')">Review and sign</button>' +
        // Available BEFORE signing on purpose. Somebody who is not going to sign
        // still has to be able to put their side of it on the file.
        (r.employee_response ? '' : '<button class="btn btn-secondary btn-sm" onclick="erRespond(' + r.id + ')">Add a written response</button>') +
        '</div>' +
        (r.employee_response ? '<div class="er-sugg"><b style="color:var(--text)">Your response</b><br>' + esc(r.employee_response) + '</div>' : '') +
        '</div></div>';
    }).join('');

    out += '<div class="card"><div class="card-header"><div class="card-title">Shared with you</div></div>' +
      '<div class="card-body">' + (rest.length ? '<div class="er-tl">' + rest.map(myEventHtml).join('') + '</div>'
        : '<div style="color:var(--text-muted-color);font-size:13px">Nothing else shared yet.</div>') + '</div></div>' +
      '<div style="height:20px"></div>';
    return out;
  }

  function myEventHtml(r) {
    var tm = TYPE_META[r.type] || TYPE_META.performance;
    var title = (r.type === 'disciplinary' ? (r.level_label || 'Notice') : tm.label) +
      (r.category ? ' &middot; ' + esc(r.category) : '');
    var acts = [];
    if (r.type !== 'disciplinary' && !r.acknowledged_at) {
      acts.push(btn('Acknowledge', 'btn-secondary', 'erAcknowledge(' + r.id + ')'));
    }
    if (r.type === 'disciplinary' && !r.employee_response) {
      acts.push(btn('Add a written response', 'btn-secondary', 'erRespond(' + r.id + ')'));
    }
    return '<div class="er-ev"><div class="er-dot ' + tm.cls + '">' + tm.dot + '</div>' +
      '<div class="er-card ' + tm.cls + '">' +
      '<div class="er-head"><div class="er-title">' + title + '</div>' + badge(r.status) + '</div>' +
      '<div class="er-body">' + esc(r.body || '') + '</div>' +
      (r.employee_response ? '<div class="er-sugg"><b style="color:var(--text)">Your response</b><br>' + esc(r.employee_response) + '</div>' : '') +
      attachChips(r.attachments) +
      '<div class="er-meta">' + esc(shortDate(r.occurred_on || r.created_at)) +
      (r.created_by_name ? ' <span class="sep">&middot;</span> ' + esc(r.created_by_name) : '') +
      (r.signed_at ? ' <span class="sep">&middot;</span> You signed this' : '') +
      (r.acknowledged_at ? ' <span class="sep">&middot;</span> Acknowledged' : '') +
      '</div>' + (acts.length ? '<div class="er-acts">' + acts.join('') + '</div>' : '') +
      '</div></div>';
  }

  window.erAcknowledge = async function (id) {
    try { await api('POST', API + '/me/' + id + '/acknowledge', {}); toast('Thanks.', 'success'); window.renderMyFile(content()); }
    catch (e) { toast(e.message || 'Could not acknowledge.', 'error'); }
  };

  window.erRespond = function (id) {
    modal('Your written response',
      '<div style="font-size:13px;color:var(--text-muted-color);margin-bottom:12px">' +
      'This is attached to the notice permanently and can be read by your manager and by HR. ' +
      'It cannot be edited or removed afterwards, by you or by anyone else.</div>' +
      '<textarea id="er-resp" style="min-height:130px" placeholder="If you see it differently, write it here."></textarea>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" onclick="erSaveResponse(' + id + ')">Attach my response</button>');
  };
  window.erSaveResponse = async function (id) {
    var t = String(val('er-resp') || '').trim();
    if (!t) { toast('Write your response first.', 'error'); return; }
    try {
      await api('POST', API + '/me/' + id + '/response', { text: t });
      closeModal(); toast('Response attached.', 'success'); window.renderMyFile(content());
    } catch (e) { toast(e.message || 'Could not attach it.', 'error'); }
  };

  // ---- signing --------------------------------------------------------------
  var pad = null;
  window.erSignOpen = function (id) {
    modal('Sign this notice',
      '<div style="font-size:13px;color:var(--text-dim);line-height:1.6;margin-bottom:14px">' +
      'Signing confirms you have read this notice. It does not mean you agree with it. ' +
      'You can attach a written response afterwards and it stays with the notice permanently.</div>' +
      '<div class="form-group"><label>Sign below</label><div class="er-pad" id="er-pad"><canvas id="er-canvas"></canvas></div>' +
      '<div style="display:flex;justify-content:space-between;margin-top:6px">' +
      '<span style="font-size:12px;color:var(--text-muted-color)">Draw with a finger or a mouse.</span>' +
      '<span style="font-size:12px;color:var(--primary);cursor:pointer" onclick="erClearPad()">Clear</span></div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Or type your full name</label>' +
      '<input id="er-typed" placeholder="' + esc((state.user && state.user.name) || '') + '"></div>',
      '<button class="btn btn-secondary" onclick="erCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" onclick="erSign(' + id + ')">Sign</button>');
    setTimeout(setupPad, 30);
  };

  function setupPad() {
    var wrap = el('er-pad'), c = el('er-canvas');
    if (!wrap || !c) return;
    c.width = wrap.clientWidth * 2;
    c.height = wrap.clientHeight * 2;
    var ctx = c.getContext('2d');
    ctx.scale(2, 2);
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#16233d';
    var drawing = false, empty = true;
    function pos(e) {
      var r = c.getBoundingClientRect();
      var p = (e.touches && e.touches[0]) || e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    }
    function start(e) { drawing = true; empty = false; var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); }
    function move(e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); }
    function stop() { drawing = false; }
    c.addEventListener('mousedown', start); c.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    c.addEventListener('touchstart', start); c.addEventListener('touchmove', move); c.addEventListener('touchend', stop);
    pad = { canvas: c, isEmpty: function () { return empty; }, clear: function () { ctx.clearRect(0, 0, c.width, c.height); empty = true; } };
  }
  window.erClearPad = function () { if (pad) pad.clear(); };

  window.erSign = async function (id) {
    var typed = String(val('er-typed') || '').trim();
    var drawn = (pad && !pad.isEmpty()) ? pad.canvas.toDataURL('image/png') : null;
    if (!typed && !drawn) { toast('Draw or type your name first.', 'error'); return; }
    try {
      await api('POST', API + '/me/' + id + '/sign', { typed_name: typed, signature_data: drawn });
      closeModal(); toast('Signed. A copy stays in your file.', 'success');
      window.renderMyFile(content());
    } catch (e) { toast(e.message || 'Could not record your signature.', 'error'); }
  };

  // ---- Recent Wins on the Home screen ---------------------------------------
  var origHome = window.renderHomeScreen;
  if (typeof origHome === 'function') {
    window.renderHomeScreen = async function (host) {
      await origHome(host);
      try { await fillWins(); } catch (e) {}
      try { await fillNotice(); } catch (e) {}
      // Last, and deliberately so: the celebration is a dialog over the finished
      // home screen, not a thing that lands while it is still drawing itself.
      try { await fillKudos(); } catch (e) {}
    };
  }

  async function fillWins() {
    var slot = el('home-wins');
    if (!slot) return;
    injectCss();
    var d;
    try { d = await api('GET', API + '/wins'); } catch (e) { d = null; }
    var wins = (d && d.wins) || [];
    var mayShout = (typeof can === 'function') && can('submit_shoutout');

    // This slot is now the right-hand half of the Home pair (Needs Approval on
    // the left) - it took the Recent Activity card&#39;s place on 2026-08-28. With
    // nothing to show, collapse the row to one column rather than leaving a
    // gap: a quiet week should look like a shorter page, not a broken one.
    //
    // Unless the viewer can send a shout-out. Then the card stays and carries
    // the button, because a week with no recognition on it is exactly when that
    // button is worth being able to find.
    if (!wins.length && !mayShout) {
      slot.innerHTML = '';
      var pair0 = el('home-pair');
      if (pair0) pair0.style.gridTemplateColumns = '1fr';
      return;
    }
    var pair = el('home-pair');
    if (pair) pair.style.gridTemplateColumns = '1fr 1fr';

    var head =
      '<div class="card-header" style="border-bottom-color:#1d4429">' +
      '<div class="card-title">Recent Wins</div>' +
      '<div style="display:flex;align-items:center;gap:10px">' +
      ((d && d.city) ? '<span style="font-size:12px;color:var(--text-muted-color)">' + esc(d.city) + '</span>' : '') +
      // The card went company-wide 2026-08-28, so the header no longer stamps a
      // single city on the list. Each row carries its own instead - see below.
      (mayShout ? '<button class="btn btn-secondary btn-sm" onclick="erShoutout()">+ Shout-out</button>' : '') +
      '</div></div>';

    var body = wins.length ? wins.map(function (w) {
      // The credit line names whoever WROTE the recognition. On a peer
      // shout-out that is the coworker, not the manager who released it: the
      // server keeps created_by and approver_id apart precisely so this line can
      // say the right name. See the shout-out block in routes/employeeRecords.js.
      var by = w.by
        ? '<div class="by">' + (w.peer ? 'Shout-out from ' : 'Recognized by ') + '<b>' + esc(w.by) + '</b></div>'
        : '';
      return '<div class="er-win">' +
        '<div class="avatar" style="width:34px;height:34px;font-size:12px">' + esc(initials(w.name)) + '</div>' +
        '<div><div><span class="lab">Employee:</span> <span class="who">' + esc(w.name) + '</span>' +
        (w.city ? ' <span class="er-city">' + esc(w.city) + '</span>' : '') +
        (w.category ? ' <span class="cat">&middot; ' + esc(w.category) + '</span>' : '') +
        (w.is_me ? '<span class="er-you">YOU</span>' : '') + '</div>' +
        '<div class="txt">' + esc(w.body || '') + '</div>' + by + kudosRowHtml(w) + '</div></div>';
    }).join('')
      : '<div style="padding:16px 0;font-size:13px;color:var(--text-muted-color);line-height:1.6">' +
        'Nothing here yet. Caught somebody doing good work? Send them a shout-out.</div>';

    slot.innerHTML =
      '<div class="card" style="margin:0;border-color:#1d4429">' + head +
      '<div class="card-body" style="padding:6px 20px">' + body + '</div></div>';
  }

  // ---- "You have a notice to sign" -----------------------------------------
  //
  // A notice used to be announced in exactly one place: an email. That email
  // pointed at ?view=my-file, a view that does not exist, so it landed people on
  // the home screen with no explanation - and nothing on the home screen said
  // why. Three surfaces now carry it: this banner, a count on the My Documents
  // row, and the file itself.
  //
  // All of them read ONE number, from /me/pending, and deliberately NOT from
  // GET /me. That route stamps opened_at, which is half of the delivery trail
  // that stands in for a witness signature on a notice nobody signs. A badge
  // that marked a notice as read merely by drawing itself would destroy the
  // evidence it exists to protect.
  var PEND = { count: 0, loaded: false, inflight: null };

  function setPending(n) {
    n = n || 0;
    PEND.loaded = true;
    if (n === PEND.count) return;
    PEND.count = n;
    redrawNav();
  }

  // Repaints the sidebar only. render() would throw the user's scroll position
  // away, and this can land at any moment - it is a background fetch.
  function redrawNav() {
    try {
      var nav = document.querySelector('.sidebar-nav');
      if (nav && typeof buildNavHtml === 'function') nav.innerHTML = buildNavHtml();
    } catch (e) {}
  }

  // Callers COALESCE onto one fetch rather than each starting their own. The
  // sidebar kicks one off on first paint and the home banner asks for a fresh
  // one a moment later; without this the banner got back the stale number the
  // sidebar had not finished replacing, decided nothing was pending, and hid
  // itself - on exactly the load where somebody has a notice waiting.
  function refreshPending(force) {
    if (PEND.inflight) return PEND.inflight;
    if (PEND.loaded && !force) return Promise.resolve(PEND.count);
    if (typeof state === 'undefined' || !state || !state.token || !state.user) return Promise.resolve(0);
    PEND.inflight = (async function () {
      var n = PEND.count;
      try {
        var d = await api('GET', API + '/me/pending');
        n = (d && d.count) || 0;
      } catch (e) {
        // Fail quiet. The route does too, and for the same reason: a badge is
        // not worth an error across somebody's home screen.
      }
      PEND.inflight = null;
      setPending(n);
      return PEND.count;
    })();
    return PEND.inflight;
  }

  // The sidebar count. navModel() is a function declaration in app.js, so it is
  // reassignable here for the same reason renderMyFile is (see the header), and
  // buildNavHtml drops a nav label into the HTML unescaped - which is what lets
  // a badge ride along on the label without app.js's nav code changing at all.
  var origNavModel = window.navModel;
  if (typeof origNavModel === 'function') {
    window.navModel = function () {
      var model = origNavModel.apply(this, arguments);
      // First paint after login, wherever the user lands. Fire and forget: the
      // fetch repaints the sidebar itself when it comes back, and the loaded
      // flag holds it to one call for the session.
      if (!PEND.loaded && !PEND.inflight) { try { refreshPending(); } catch (e) {} }
      if (PEND.count > 0) stampBadge(model);
      return model;
    };
  }

  function stampBadge(nodes) {
    for (var i = 0; i < (nodes || []).length; i++) {
      var n = nodes[i];
      if (!n) continue;
      if (n.children) { stampBadge(n.children); continue; }
      if (n.view === 'my-documents' && String(n.label).indexOf('er-nav-count') === -1) {
        n.label = n.label + '<span class="er-nav-count">' + PEND.count + '</span>';
      }
    }
  }

  // The banner. Sits in the slot app.js renders above My Tasks.
  async function fillNotice() {
    var slot = el('home-notice');
    if (!slot) return;
    injectCss();
    var n = await refreshPending(true);
    if (!n) { slot.innerHTML = ''; return; }
    slot.innerHTML =
      '<div class="card er-notice" style="margin-bottom:24px">' +
      '<div class="card-body" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
      '<div class="er-notice-dot">!</div>' +
      '<div style="flex:1;min-width:210px">' +
      '<div style="font-size:15px;font-weight:700;color:var(--text)">' +
      (n === 1 ? 'A notice in your file needs your signature'
               : n + ' notices in your file need your signature') + '</div>' +
      '<div style="font-size:12.5px;color:var(--text-muted-color);margin-top:3px;line-height:1.55">' +
      'Signing confirms you have read it. It does not mean you agree with it, and you can attach a ' +
      'written response of your own.</div></div>' +
      '<button class="btn btn-primary" onclick="navigate(&#39;my-documents&#39;)">Open my file</button>' +
      '</div></div>';
  }

  // ==================================================================
  // KUDOS
  // ==================================================================
  //
  // The one-tap reaction under a win. Three surfaces:
  //
  //   the pill        - on every win the viewer is allowed to press
  //   the tally       - count + names, drawn ONLY for the person the win is
  //                     about and for anybody holding view_employee_records.
  //                     The server decides that; kudos_count is simply absent
  //                     from the payload for everybody else, so there is no
  //                     client-side rule here that could be wrong.
  //   the celebration - a dialog on the recipient's next home screen.
  //
  // The rule that shapes all three: A ZERO IS NEVER DRAWN. No "0 kudos", no
  // empty celebration, no push about nothing. A win nobody has pressed looks
  // exactly like a win nobody has scrolled to, because the alternative is
  // publishing which compliments fell flat.

  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

  // The row under the credit line. Returns '' - not an empty div - when there is
  // nothing to say, so a win with no button and no tally keeps its old spacing.
  function kudosRowHtml(w) {
    var bits = [];
    if (w.kudos_open) {
      bits.push(w.kudos_mine
        ? '<button class="er-kud given" disabled>&#10003; You gave kudos</button>'
        : '<button class="er-kud" onclick="erGiveKudos(' + w.id + ',this)">&#128079; Send kudos</button>');
    }
    if (w.kudos_count) {
      var names = (w.kudos_from || []).slice(0, 4).map(firstName).filter(Boolean);
      var more = w.kudos_count - names.length;
      bits.push('<span class="er-ktally">&#128079; <b>' + w.kudos_count + ' kudos</b>' +
        (names.length ? ' <span>from ' + esc(names.join(', ')) + (more > 0 ? ' +' + more : '') + '</span>' : '') +
        '</span>');
      // Said out loud on the row, because somebody looking at a number on a
      // shared screen deserves to know who else can see it.
      bits.push('<span class="er-klock">&#128274; ' +
        (w.is_me ? 'ONLY YOU &amp; MANAGERS SEE THIS' : 'NOT SHOWN TO EVERYONE') + '</span>');
    }
    if (!bits.length) return '';
    return '<div class="er-kud-row">' + bits.join('') + '</div>';
  }

  window.erGiveKudos = async function (id, btn) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    var d = null;
    try {
      d = await api('POST', API + '/wins/' + id + '/kudos', {});
    } catch (e) {
      // Put the button back. The one thing that must not happen is a pill that
      // says nothing and does nothing.
      btn.disabled = false;
      toast((e && e.message) || 'Could not send the kudos.', 'error');
      return;
    }
    btn.className = 'er-kud sent';
    btn.innerHTML = '&#10003; Kudos sent';
    confettiFrom(btn);

    var row = btn.parentNode;
    if (!row) return;
    var tally = row.querySelector('.er-ktally');
    if (d && d.kudos_count != null && tally) {
      // Only somebody already entitled to the number gets one back.
      tally.innerHTML = '&#128079; <b>' + d.kudos_count + ' kudos</b>';
    } else if (!tally) {
      // Everybody else gets the thing they actually want to know: that it landed.
      var note = document.createElement('span');
      note.className = 'er-ktally';
      note.style.color = '#6ee7a0';
      note.textContent = 'They will see it next time they open Nova.';
      row.appendChild(note);
    }
  };

  // ---- confetti -------------------------------------------------------------
  //
  // Hand-rolled on a canvas rather than pulled from a library: there is no build
  // step here and no bundler, and this is forty lines. Fixed to the viewport so
  // it can fire from a button in a card or from the middle of a dialog without
  // either of them needing to become a positioning context.
  //
  // Silent, always. Half of these presses happen on a customer&#39;s driveway.
  function confettiFrom(anchor) {
    if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
    var r = anchor.getBoundingClientRect();
    burstAt(r.left + r.width / 2, r.top + r.height / 2);
  }

  function burstAt(cx, cy) {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch (e) {}
    if (!document.body || typeof requestAnimationFrame !== 'function') return;
    var cv = document.createElement('canvas');
    var ctx = null;
    try { ctx = cv.getContext('2d'); } catch (e) { return; }
    if (!ctx) return;

    var dpr = window.devicePixelRatio || 1;
    var W = window.innerWidth, H = window.innerHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3000';
    document.body.appendChild(cv);
    ctx.scale(dpr, dpr);

    var COLORS = ['#f97316', '#22c55e', '#60a5fa', '#f59e0b', '#a855f7', '#f0f0f0', '#ef4444'];
    var bits = [];
    for (var i = 0; i < 70; i++) {
      var a = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
      var sp = 3.5 + Math.random() * 7;
      bits.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.4,
        w: 5 + Math.random() * 4, h: 8 + Math.random() * 5,
        c: COLORS[(Math.random() * COLORS.length) | 0],
        round: Math.random() < 0.28
      });
    }

    var t0 = Date.now();
    var LIFE = 1500;
    function frame() {
      var age = Date.now() - t0;
      if (age > LIFE) { if (cv.parentNode) cv.parentNode.removeChild(cv); return; }
      ctx.clearRect(0, 0, W, H);
      var fade = age > LIFE - 400 ? (LIFE - age) / 400 : 1;
      for (var j = 0; j < bits.length; j++) {
        var b = bits[j];
        b.vy += 0.22; b.vx *= 0.99; b.vy *= 0.99;
        b.x += b.vx; b.y += b.vy; b.rot += b.vr;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);
        ctx.globalAlpha = fade;
        ctx.fillStyle = b.c;
        if (b.round) { ctx.beginPath(); ctx.arc(0, 0, b.w / 2, 0, 6.2832); ctx.fill(); }
        else { ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); }
        ctx.restore();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---- the celebration ------------------------------------------------------
  var CEL = { shown: false, ids: [] };

  async function fillKudos() {
    if (CEL.shown) return;
    if (typeof state === 'undefined' || !state || !state.token || !state.user) return;
    // Never on top of somebody else&#39;s dialog, and never while an admin is
    // previewing another person with View As - the celebration belongs to the
    // person it is about, and marking it seen from a preview would spend it.
    if (state.viewAsId) return;
    if (document.querySelector('.modal-overlay') || document.querySelector('.er-cel-ov')) return;

    var d;
    try { d = await api('GET', API + '/kudos/unseen'); } catch (e) { return; }
    var batches = (d && d.batches) || [];
    // Rule 1. Nothing to celebrate is not an empty celebration.
    if (!batches.length) return;
    CEL.shown = true;
    injectCss();
    showCelebration(batches);
  }

  function showCelebration(batches) {
    var total = 0, allNames = [], i;
    for (i = 0; i < batches.length; i++) {
      total += batches[i].count || 0;
      allNames = allNames.concat(batches[i].names || []);
    }
    if (!total) return;
    CEL.ids = batches.map(function (b) { return b.record_id; });

    // De-duplicate for the faces: one person who pressed on two of your wins is
    // one face, not two.
    var seen = {}, uniq = [];
    for (i = 0; i < allNames.length; i++) {
      var n = String(allNames[i] || '').trim();
      if (!n || seen[n.toLowerCase()]) continue;
      seen[n.toLowerCase()] = true;
      uniq.push(n);
    }

    var faces = uniq.slice(0, 4).map(function (n) {
      return '<div class="avatar">' + esc(initials(n)) + '</div>';
    }).join('');
    if (uniq.length > 4) {
      faces += '<div class="avatar more">+' + (uniq.length - 4) + '</div>';
    }

    var blocks = batches.map(function (b) {
      var head = [];
      if (b.category) head.push(esc(b.category));
      if (b.city) head.push(esc(b.city));
      var names = (b.names || []).filter(Boolean);
      return '<div class="er-cel-q" style="margin-top:12px">' +
        (head.length ? '<b>' + head.join(' &middot; ') + '</b><br>' : '') +
        esc(b.body || '') +
        (b.by ? '<br><span style="color:var(--text-muted-color);font-size:12px">' +
          (b.peer ? 'Shout-out from ' : 'Recognized by ') + esc(b.by) + '</span>' : '') +
        '</div>' +
        (names.length ? '<div class="er-cel-names">From ' + names.map(function (n) {
          return '<b>' + esc(n) + '</b>';
        }).join(', ') + '.</div>' : '');
    }).join('');

    var ov = document.createElement('div');
    ov.className = 'er-cel-ov';
    ov.id = 'er-cel';
    ov.innerHTML =
      '<div class="er-cel">' +
      '<div class="er-cel-top">' +
      '<div class="em">&#128079;</div>' +
      '<h4>' + (total === 1 ? 'Somebody gave you kudos' : total + ' people gave you kudos') + '</h4>' +
      '<p>Your coworkers saw your ' + (batches.length === 1 ? 'win' : 'wins') +
      ' on the Home screen and hit the button.</p>' +
      '<div class="er-cel-faces">' + faces + '</div>' +
      '</div>' +
      '<div class="er-cel-body">' + blocks + '</div>' +
      '<div class="er-cel-foot"><button class="btn btn-primary" onclick="erCelDone()">Nice</button></div>' +
      '</div>';
    // Clicking the backdrop counts as seeing it. It was on their screen; making
    // them hunt for the right button to dismiss their own good news is silly.
    ov.onclick = function (ev) { if (ev.target === ov) window.erCelDone(); };
    document.body.appendChild(ov);

    var card = ov.firstChild;
    if (card && card.getBoundingClientRect) {
      var r = card.getBoundingClientRect();
      burstAt(r.left + r.width / 2, r.top + 120);
    }
  }

  // Dismiss - and ONLY here is seen_at stamped. Not on the fetch. A tab opened
  // and closed in somebody&#39;s pocket must not spend their confetti.
  window.erCelDone = async function () {
    var ov = el('er-cel');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var ids = CEL.ids.slice();
    CEL.ids = [];
    if (!ids.length) return;
    try { await api('POST', API + '/kudos/seen', { record_ids: ids }); } catch (e) {}
    // The tally on their own win is now stale by exactly the number they were
    // just shown. Repaint the card if it is still on screen.
    try { if (el('home-wins')) await fillWins(); } catch (e) {}
  };

  window.erRefreshWins = fillWins;
  window.erFillNotice = fillNotice;
  window.erRefreshPending = function () { return refreshPending(true); };
})();
