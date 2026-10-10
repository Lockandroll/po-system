// Policy versions - the screens (routes/documents.js, routes/sops.js,
// routes/onboarding.js /admin/link-health, routes/memos.js publish-to-vault).
//
// Why (Tony, 2026-10-09): the PTO policy changed, the memo went out with the new
// PDF, and onboarding kept showing new hires the old one, because Nova could
// only add a new file, never replace one. Everything here hangs off one idea:
// a policy keeps its id and takes NEW VERSIONS, so whatever points at it follows.
//
//   pvDocVersions(id)        Vault file: versions, upload a new one, where used,
//                            move onboarding steps to another file
//   pvSopVersions(id)        the same for an SOP Library entry
//   pvOnboardingHealth(el)   banner on the onboarding path builder listing steps
//                            that point at a deleted / disabled document
//   pvMemoPublish(memoId)    make a memo's PDF the current version of a Vault file
//
// Classic script, every handler global (pv*). Bare state, never window.state.
// No backticks anywhere in this file (Windows corrupts them in .js).
(function () {
  'use strict';

  var PV = { doc: null, sop: null, pickTarget: null };

  function esc(s) { return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s); }
  function el(id) { return document.getElementById(id); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'info'); }
  function isAdmin() { return !!(state && state.user && (state.user.role === 'admin' || state.user.role === 'owner')); }
  function canMemo() { return isAdmin() || (typeof can === 'function' && can('manage_memos')); }
  function when(d) { if (!d) return ''; var t = new Date(d); return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function size(b) { b = Number(b) || 0; if (b < 1024) return b + ' B'; if (b < 1048576) return Math.round(b / 1024) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
  function stepType(t) { return ({ sop_read: 'Read', acknowledge: 'Acknowledge', quiz: 'Quiz' })[t] || t; }

  function modal(id, title, body, footer, wide) {
    pvClose(id);
    var o = document.createElement('div');
    o.className = 'modal-overlay';
    o.id = id;
    o.innerHTML = '<div class="modal"' + (wide ? ' style="max-width:640px"' : '') + '>' +
      '<div class="modal-header"><span class="modal-title">' + title + '</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="pvClose(&#39;' + id + '&#39;)">&#x2715;</button></div>' +
      '<div class="modal-body" style="overflow:auto">' + body + '</div>' +
      (footer ? '<div class="modal-footer">' + footer + '</div>' : '') + '</div>';
    o.addEventListener('click', function (e) { if (e.target === o) pvClose(id); });
    document.body.appendChild(o);
    return o;
  }
  function pvClose(id) { var m = el(id); if (m) m.remove(); }
  window.pvClose = pvClose;

  function section(title, inner) {
    return '<div style="margin:0 0 16px"><div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted-color);margin:0 0 6px">' + title + '</div>' + inner + '</div>';
  }

  function usageHtml(u, kind) {
    if (!u) return '';
    var lines = [];
    (u.onboarding_steps || []).forEach(function (s) {
      lines.push('<li>Onboarding: <b>' + esc(s.title) + '</b> <span style="color:var(--text-muted-color)">(' + esc(stepType(s.type)) + ', phase ' + (s.phase || 1) + ')</span></li>');
    });
    (u.memos || []).forEach(function (m) {
      lines.push('<li>Memo ' + esc(m.memo_no || '#' + m.id) + ': ' + esc(m.title || '') + ' <span style="color:var(--text-muted-color)">(' + esc(m.status) + ', keeps its own copy)</span></li>');
    });
    if (u.vehicles) lines.push('<li>Linked to ' + u.vehicles + ' vehicle' + (u.vehicles === 1 ? '' : 's') + ' in Fleet</li>');
    if (u.policy_folder) lines.push('<li>In a policy folder: Nova AI and disciplinary notices quote it</li>');
    if (kind === 'sop' && u.active) lines.push('<li>Active in the SOP Library: Nova AI quotes it</li>');
    if (!lines.length) return '<p style="font-size:13px;color:var(--text-muted-color);margin:0">Nothing in Nova links to this yet.</p>';
    return '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7">' + lines.join('') + '</ul>';
  }

  function historyTable(rows, cells) {
    if (!rows.length) return '<p style="font-size:13px;color:var(--text-muted-color);margin:0">No earlier versions.</p>';
    return '<table style="width:100%;border-collapse:collapse;font-size:13px">' + rows.map(function (h) {
      return '<tr style="border-top:1px solid var(--border)">' + cells(h).map(function (c, i, a) {
        return '<td style="padding:6px 4px;vertical-align:top' + (i === a.length - 1 ? ';text-align:right' : '') + '">' + c + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</table>';
  }

  // ======================================================================
  //  VAULT FILE
  // ======================================================================
  window.pvDocVersions = async function (id) {
    var o = modal('pv-doc', 'Versions', '<p>Loading&hellip;</p>', null, true);
    var data, usage = null;
    try { data = await api('GET', '/documents/' + id + '/versions'); }
    catch (e) { o.querySelector('.modal-body').innerHTML = '<div class="alert alert-error">' + esc(e.message) + '</div>'; return; }
    if (isAdmin()) { try { usage = await api('GET', '/documents/' + id + '/usage'); } catch (e) {} }
    PV.doc = { id: id, data: data, usage: usage };
    var c = data.current;
    o.querySelector('.modal-title').innerHTML = 'Versions: ' + esc(c.name);
    var body = '<div id="pv-doc-msg"></div>';
    body += section('Current', '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:14px">' +
      '<span class="doc-badge" style="background:rgba(34,197,94,0.15);color:#4ade80">v' + (c.version || 1) + '</span>' +
      '<span>' + esc(c.version_by_name || c.owner_name || '') + ' &middot; ' + esc(when(c.version_at || c.created_at)) + ' &middot; ' + size(c.size_bytes) + '</span>' +
      '<button class="btn btn-secondary btn-sm" onclick="docDownload(' + id + ',1)">Open</button></div>' +
      (c.version_note ? '<div style="font-size:13px;color:var(--text-muted-color);margin-top:4px">' + esc(c.version_note) + '</div>' : ''));
    if (data.can_edit) {
      body += section('Upload a new version',
        '<p style="font-size:13px;color:var(--text-muted-color);margin:0 0 8px">Replaces this file everywhere it is used, without breaking any links. The current version is kept in the history below.</p>' +
        '<div class="form-group"><input type="file" id="pv-doc-file" /></div>' +
        '<div class="form-group"><label>What changed (optional)</label><input type="text" id="pv-doc-note" maxlength="300" placeholder="e.g. New PTO accrual rate" /></div>' +
        '<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:0 0 10px"><input type="checkbox" id="pv-doc-keepname" checked> Keep the name &quot;' + esc(c.name) + '&quot;</label>' +
        '<button class="btn btn-primary btn-sm" id="pv-doc-up" onclick="pvDocUpload(' + id + ')">Upload new version</button>');
    }
    if (usage) {
      body += section('Where this file is used', usageHtml(usage, 'doc') +
        ((usage.onboarding_steps || []).length ? '<div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="pvDocRelinkPick(' + id + ')">Point these onboarding steps at a different file&hellip;</button></div>' : ''));
    }
    body += section('History', historyTable(data.history || [], function (h) {
      return [
        'v' + h.version,
        esc(h.name || '') + (h.note ? '<div style="color:var(--text-muted-color)">' + esc(h.note) + '</div>' : ''),
        '<span style="color:var(--text-muted-color)">' + esc(h.uploaded_by_name || '') + '<br>' + esc(when(h.uploaded_at)) + '</span>',
        '<span style="color:var(--text-muted-color)">replaced ' + esc(when(h.replaced_at)) + (h.replaced_by_name ? '<br>by ' + esc(h.replaced_by_name) : '') + '</span>',
        '<button class="btn btn-ghost btn-sm" onclick="pvDocOld(' + id + ',' + h.id + ')">Open</button>'
      ];
    }));
    o.querySelector('.modal-body').innerHTML = body;
  };

  window.pvDocOld = async function (id, vid) {
    try { var r = await api('GET', '/documents/' + id + '/versions/' + vid + '/download?inline=1'); window.open(r.url, '_blank', 'noopener'); }
    catch (e) { toast(e.message || 'Could not open that version.', 'error'); }
  };

  window.pvDocUpload = async function (id) {
    var fl = (el('pv-doc-file') || {}).files;
    var f = fl && fl[0];
    var msg = el('pv-doc-msg');
    if (!f) { msg.innerHTML = '<div class="alert alert-error">Choose the new file first.</div>'; return; }
    var btn = el('pv-doc-up'); btn.disabled = true; btn.textContent = 'Uploading...';
    try {
      var keep = !!(el('pv-doc-keepname') || {}).checked;
      var mime = f.type || 'application/octet-stream';
      var res = await api('POST', '/documents/' + id + '/version-url', { name: f.name, mime_type: mime });
      var put = await fetch(res.uploadUrl, { method: 'PUT', body: f, headers: { 'Content-Type': mime } });
      if (!put.ok) throw new Error('The upload to storage failed. Try again.');
      var done = await api('POST', '/documents/' + id + '/version', { key: res.key, name: f.name, mime_type: mime, size_bytes: f.size, keep_name: keep, note: (el('pv-doc-note') || {}).value || '' });
      pvClose('pv-doc');
      if (typeof docReload === 'function' && state.currentView === 'documents') docReload();
      pvAfterNewVersion(id, done.name, done.version, done.usage);
    } catch (e) {
      msg.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Upload failed') + '</div>';
      btn.disabled = false; btn.textContent = 'Upload new version';
    }
  };

  // After a new version lands: say exactly what now shows it, and offer the memo.
  // Tony's default (2026-10-09): offered, never automatic.
  function pvAfterNewVersion(docId, name, version, usage) {
    var body = '<p style="margin:0 0 12px">&quot;' + esc(name) + '&quot; is now on <b>version ' + version + '</b>. Everything below already shows the new version:</p>' +
      usageHtml(usage, 'doc') +
      '<p style="font-size:13px;color:var(--text-muted-color);margin:12px 0 0">Memos keep the copy people signed. To tell everyone about the change, send a memo with this file attached.</p>';
    var foot = '<button class="btn btn-ghost btn-sm" onclick="pvClose(&#39;pv-done&#39;)">Done</button>' +
      (canMemo() ? '<button class="btn btn-primary btn-sm" onclick="pvMemoFromDoc(' + docId + ')">Send a memo about it</button>' : '');
    modal('pv-done', 'New version saved', body, foot);
  }

  // Start a Policy update memo with the new version already attached.
  window.pvMemoFromDoc = async function (docId) {
    try {
      var d = await api('GET', '/documents/' + docId + '/versions');
      var nm = String(d.current.name || 'Policy').replace(/\.[a-z0-9]+$/i, '');
      var r = await api('POST', '/memos', { type: 'Policy update', title: 'Updated: ' + nm, note: 'Here is the updated ' + nm + '.', audience: { mode: 'all' }, require_signature: true });
      try { await api('POST', '/memos/' + r.memo.id + '/from-vault', { document_id: docId }); }
      catch (e) { toast('Memo started, but the file could not be attached: ' + (e.message || ''), 'error'); }
      pvClose('pv-done');
      navigate('memo-edit', r.memo.id);
    } catch (e) { toast(e.message || 'Could not start the memo.', 'error'); }
  };

  // ---- file picker (relink target, memo publish target) ----
  function pickFile(title, intro, onPick, preselect) {
    modal('pv-pick', title,
      (intro ? '<p style="font-size:13px;color:var(--text-muted-color);margin:0 0 10px">' + intro + '</p>' : '') +
      '<div class="form-group"><input type="text" id="pv-pick-q" placeholder="Search the vault" oninput="pvPickSearch()" /></div>' +
      '<div id="pv-pick-list" style="max-height:320px;overflow:auto">Loading&hellip;</div>', null, true);
    PV.pickTarget = { onPick: onPick, preselect: preselect || 0 };
    window.pvPickSearch();
    setTimeout(function () { var q = el('pv-pick-q'); if (q) q.focus(); }, 30);
  }
  var _pickTimer = null;
  window.pvPickSearch = function () {
    clearTimeout(_pickTimer);
    _pickTimer = setTimeout(async function () {
      var box = el('pv-pick-list'); if (!box) return;
      var q = (el('pv-pick-q') || {}).value || '';
      try {
        var r = await api('GET', '/documents/search?limit=60&q=' + encodeURIComponent(q));
        var files = r.files || [];
        if (!files.length) { box.innerHTML = '<p style="font-size:13px;color:var(--text-muted-color)">No files match.</p>'; return; }
        box.innerHTML = files.map(function (f) {
          var pre = PV.pickTarget && PV.pickTarget.preselect === f.id;
          return '<div style="display:flex;gap:10px;align-items:center;padding:8px 4px;border-top:1px solid var(--border)">' +
            '<div style="flex:1;min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.name) + (pre ? ' <span class="doc-badge">memo came from this</span>' : '') + '</div>' +
            '<div style="font-size:12px;color:var(--text-muted-color)">' + esc(f.folder_path || 'Vault') + '</div></div>' +
            '<button class="btn btn-' + (pre ? 'primary' : 'secondary') + ' btn-sm" onclick="pvPickChoose(' + f.id + ')">Choose</button></div>';
        }).join('');
      } catch (e) { box.innerHTML = '<div class="alert alert-error">' + esc(e.message) + '</div>'; }
    }, 200);
  };
  window.pvPickChoose = function (fid) {
    var t = PV.pickTarget; PV.pickTarget = null;
    pvClose('pv-pick');
    if (t && t.onPick) t.onPick(fid);
  };

  window.pvDocRelinkPick = function (id) {
    pickFile('Point onboarding at another file',
      'Every onboarding step that shows this file will show the one you choose instead. Use this when a new policy was uploaded as a separate file instead of a new version.',
      async function (to) {
        if (!(await novaConfirm('Move every onboarding step from this file to the one you picked?'))) return;
        try {
          var r = await api('POST', '/documents/' + id + '/relink', { to_document_id: to });
          toast(r.moved.length + ' onboarding step' + (r.moved.length === 1 ? '' : 's') + ' now show ' + r.to_name + '.', 'success');
          pvClose('pv-doc');
        } catch (e) { toast(e.message || 'Could not move the steps.', 'error'); }
      });
  };

  // ======================================================================
  //  SOP LIBRARY
  // ======================================================================
  window.pvSopVersions = async function (id) {
    var o = modal('pv-sop', 'SOP versions', '<p>Loading&hellip;</p>', null, true);
    var data, usage = null, all = [];
    try { data = await api('GET', '/sops/' + id + '/versions'); }
    catch (e) { o.querySelector('.modal-body').innerHTML = '<div class="alert alert-error">' + esc(e.message) + '</div>'; return; }
    try { usage = await api('GET', '/sops/' + id + '/usage'); } catch (e) {}
    try { all = await api('GET', '/sops'); } catch (e) {}
    PV.sop = { id: id, data: data };
    var c = data.current;
    o.querySelector('.modal-title').innerHTML = 'Versions: ' + esc(c.title);
    var body = '<div id="pv-sop-msg"></div>';
    body += section('Current', '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:14px">' +
      '<span class="doc-badge" style="background:rgba(34,197,94,0.15);color:#4ade80">v' + (c.version || 1) + '</span>' +
      '<span>' + esc(c.updated_by_name || c.uploaded_by_name || '') + ' &middot; ' + esc(when(c.updated_at || c.created_at)) + ' &middot; ' + Math.round((c.char_count || 0) / 1000) + 'k chars' + (c.active ? '' : ' &middot; <b>disabled</b>') + '</span></div>' +
      (c.version_note ? '<div style="font-size:13px;color:var(--text-muted-color);margin-top:4px">' + esc(c.version_note) + '</div>' : ''));
    body += section('Upload a new version',
      '<p style="font-size:13px;color:var(--text-muted-color);margin:0 0 8px">Replaces the text in place. Onboarding read steps and quizzes, and Nova AI, switch to the new wording immediately.</p>' +
      '<div class="form-group"><input type="file" id="pv-sop-file" accept="application/pdf" /></div>' +
      '<div class="form-group"><label>What changed (optional)</label><input type="text" id="pv-sop-note" maxlength="300" /></div>' +
      '<button class="btn btn-primary btn-sm" id="pv-sop-up" onclick="pvSopUpload(' + id + ')">Upload new version</button>');
    var others = (all || []).filter(function (s) { return s.id !== id; });
    body += section('Where this SOP is used', usageHtml(usage, 'sop') +
      (usage && usage.onboarding_steps.length && others.length ?
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><select id="pv-sop-to" style="flex:1;min-width:180px">' +
        others.map(function (s) { return '<option value="' + s.id + '">' + esc(s.title) + (s.active ? '' : ' (disabled)') + '</option>'; }).join('') +
        '</select><button class="btn btn-ghost btn-sm" onclick="pvSopRelink(' + id + ')">Move steps there and disable this one</button></div>' : ''));
    body += section('History', historyTable(data.history || [], function (h) {
      return [
        'v' + h.version,
        esc(h.title || '') + (h.note ? '<div style="color:var(--text-muted-color)">' + esc(h.note) + '</div>' : ''),
        '<span style="color:var(--text-muted-color)">replaced ' + esc(when(h.replaced_at)) + (h.replaced_by_name ? ' by ' + esc(h.replaced_by_name) : '') + '</span>',
        '<button class="btn btn-ghost btn-sm" onclick="pvSopOld(' + id + ',' + h.id + ')">Read</button>'
      ];
    }));
    o.querySelector('.modal-body').innerHTML = body;
  };

  window.pvSopOld = async function (id, vid) {
    try {
      var v = await api('GET', '/sops/' + id + '/versions/' + vid);
      modal('pv-sop-old', 'v' + v.version + ': ' + esc(v.title || ''), '<div style="white-space:pre-wrap;font-size:13px;line-height:1.5">' + esc(v.content || '') + '</div>', null, true);
    } catch (e) { toast(e.message || 'Could not load that version.', 'error'); }
  };

  window.pvSopUpload = async function (id) {
    var fl = (el('pv-sop-file') || {}).files;
    var f = fl && fl[0];
    var msg = el('pv-sop-msg');
    if (!f) { msg.innerHTML = '<div class="alert alert-error">Choose the new PDF first.</div>'; return; }
    var btn = el('pv-sop-up'); btn.disabled = true; btn.textContent = 'Reading PDF...';
    try {
      await loadPdfJs();
      var text = await extractPdfText(f);
      if (!text || text.trim().length < 20) throw new Error('Could not read any text from that PDF. Re-save it as a text-based PDF and try again.');
      btn.textContent = 'Saving...';
      var r = await api('POST', '/sops/' + id + '/version', { content: text, filename: f.name, note: (el('pv-sop-note') || {}).value || '' });
      pvClose('pv-sop');
      if (typeof loadSOPList === 'function') loadSOPList();
      modal('pv-done', 'New version saved', '<p style="margin:0 0 12px">&quot;' + esc(r.sop.title) + '&quot; is now on <b>version ' + r.sop.version + '</b>. Everything below already uses the new text:</p>' + usageHtml(r.usage, 'sop'),
        '<button class="btn btn-primary btn-sm" onclick="pvClose(&#39;pv-done&#39;)">Done</button>');
    } catch (e) {
      msg.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Upload failed') + '</div>';
      btn.disabled = false; btn.textContent = 'Upload new version';
    }
  };

  window.pvSopRelink = async function (id) {
    var to = parseInt((el('pv-sop-to') || {}).value, 10);
    if (!to) return;
    if (!(await novaConfirm('Move every onboarding step to the SOP you picked, and disable this one so Nova AI stops quoting it?'))) return;
    try {
      var r = await api('POST', '/sops/' + id + '/relink', { to_sop_id: to, deactivate: true });
      toast(r.moved.length + ' onboarding step' + (r.moved.length === 1 ? '' : 's') + ' now use ' + r.to_title + '.', 'success');
      pvClose('pv-sop');
      if (typeof loadSOPList === 'function') loadSOPList();
    } catch (e) { toast(e.message || 'Could not move the steps.', 'error'); }
  };

  // ======================================================================
  //  ONBOARDING PATH BUILDER BANNER
  // ======================================================================
  window.pvOnboardingHealth = async function (container) {
    if (!container) return;
    var r;
    try { r = await api('GET', '/onboarding/admin/link-health'); } catch (e) { return; }
    var p = (r && r.problems) || [];
    var old = el('pv-onb-health'); if (old) old.remove();
    if (!p.length) return;
    var div = document.createElement('div');
    div.id = 'pv-onb-health';
    div.className = 'alert alert-error';
    div.style.marginBottom = '12px';
    div.innerHTML = '<b>' + p.length + ' onboarding step' + (p.length === 1 ? ' needs' : 's need') + ' a document fixed</b>' +
      '<ul style="margin:6px 0 0;padding-left:18px">' + p.map(function (x) { return '<li><b>' + esc(x.title) + '</b>: ' + esc(x.problem) + '</li>'; }).join('') + '</ul>' +
      '<div style="font-size:12px;margin-top:6px;opacity:.85">Edit the step to pick a document, or upload a new version of the right file from the Document Vault or SOP Library.</div>';
    container.insertBefore(div, container.firstChild);
  };

  // ======================================================================
  //  MEMO -> VAULT
  // ======================================================================
  window.pvMemoPublish = function (memoId, sourceDocId) {
    pickFile('Make this PDF the current version of a Vault file',
      'Pick the policy this memo replaces. It keeps its id, so onboarding and Nova AI start showing this PDF right away. The old version stays in the file&#39;s history.',
      async function (docId) {
        if (!(await novaConfirm('Replace the current version of that file with the PDF on this memo?'))) return;
        try {
          var r = await api('POST', '/memos/' + memoId + '/publish-to-vault', { document_id: docId });
          modal('pv-done', 'Vault updated', '<p style="margin:0 0 12px">&quot;' + esc(r.name) + '&quot; is now on <b>version ' + r.version + '</b>. Everything below already shows it:</p>' + usageHtml(r.usage, 'doc'),
            '<button class="btn btn-primary btn-sm" onclick="pvClose(&#39;pv-done&#39;)">Done</button>');
        } catch (e) { toast(e.message || 'Could not publish to the vault.', 'error'); }
      }, sourceDocId || 0);
  };
})();
