// Customer-facing photos in the employee file (dispatch plan step 4, Tony 2026-10-13).
// A tech photo and a vehicle photo, uploaded by the manager. Customers see them
// on the call link once the tech acknowledges the call. No plate information,
// no approval flow.
//
// Wraps window.onbOpenFile (onboarding.js, already wrapped by memos.js), so it
// shows in both employee file screens: the documents-only page and the
// Documents tab of Employee Records. Loads after memos.js.
// No backticks anywhere in this file (Windows corrupts them in .js).
(function () {
  'use strict';
  var orig = window.onbOpenFile;
  if (typeof orig !== 'function') return;

  var SLOTS = [
    { k: 'tech', l: 'Tech photo', hint: 'Head and shoulders, plain background, in uniform.' },
    { k: 'vehicle', l: 'Vehicle photo', hint: 'The service vehicle from the side. The plate does not need to show.' }
  ];

  function css() {
    if (document.getElementById('ep-styles')) return;
    var st = document.createElement('style');
    st.id = 'ep-styles';
    st.textContent =
      '.ep-card{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:12px;padding:16px;margin:0 0 16px}' +
      '.ep-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}' +
      '.ep-head h3{margin:0;font-size:15px;flex:1;min-width:200px}' +
      '.ep-tag{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:3px 8px;border-radius:20px}' +
      '.ep-tag.ok{background:rgba(34,197,94,.15);color:#4ade80}.ep-tag.need{background:rgba(245,158,11,.15);color:#fbbf24}' +
      '.ep-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}' +
      '@media (max-width:640px){.ep-grid{grid-template-columns:minmax(0,1fr)}}' +
      '.ep-slot{border:1px dashed var(--border,#3a3a3a);border-radius:10px;padding:12px;display:flex;gap:12px;align-items:center}' +
      '.ep-slot.has{border-style:solid}' +
      '.ep-img{width:96px;height:96px;border-radius:10px;object-fit:cover;flex:none;background:var(--bg-elevated,#222);' +
        'display:flex;align-items:center;justify-content:center;color:var(--text-muted-color,#888);font-size:11px;text-align:center}' +
      '.ep-img.round{border-radius:50%}' +
      '.ep-name{font-weight:700;font-size:14px}.ep-sub{font-size:12px;color:var(--text-muted-color,#888);margin-top:3px;line-height:1.45}' +
      '.ep-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}' +
      '.ep-msg{font-size:12px;margin-top:8px;color:var(--text-muted-color,#888)}';
    document.head.appendChild(st);
  }

  function fmt(t) {
    try { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; }
  }

  async function draw(id) {
    var body = document.getElementById('onb-ef-body');
    if (!body) return;
    css();
    var host = document.getElementById('ep-card');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ep-card';
      var tb = body.querySelector('.onb-doc-toolbar');
      if (tb && tb.parentNode === body) body.insertBefore(host, tb); else body.insertBefore(host, body.firstChild);
    }
    var d;
    try { d = await api('GET', '/employee-photos/' + id + '?thumbs=1'); }
    catch (e) { host.innerHTML = ''; return; }
    var slots = d.slots || {};
    var have = SLOTS.filter(function (s) { return slots[s.k]; }).length;
    host.className = 'ep-card';
    host.setAttribute('aria-labelledby', 'ep-title');
    host.innerHTML =
      '<div class="ep-head"><h3 id="ep-title">Customer-facing photos</h3>' +
        '<span class="ep-tag ' + (have === 2 ? 'ok' : 'need') + '">' + (have === 2 ? 'Both on file' : (2 - have) + ' missing') + '</span></div>' +
      '<div class="ep-sub" style="margin:-4px 0 12px">Customers see these on their call link once this tech acknowledges the call.' +
        (d.required ? ' Required before onboarding sign-off.' : '') +
        (d.storage_ready ? '' : ' <b style="color:#fbbf24">Photo storage (R2) is not set up, so uploads will fail.</b>') + '</div>' +
      '<div class="ep-grid">' + SLOTS.map(function (s) {
        var p = slots[s.k];
        var img = p && p.data
          ? '<img class="ep-img' + (s.k === 'tech' ? ' round' : '') + '" src="' + escHtml(p.data) + '" alt="' + escHtml(s.l) + '">'
          : '<div class="ep-img' + (s.k === 'tech' ? ' round' : '') + '">' + (p ? 'On file' : 'None yet') + '</div>';
        return '<div class="ep-slot' + (p ? ' has' : '') + '">' + img + '<div style="min-width:0">' +
          '<div class="ep-name">' + escHtml(s.l) + '</div>' +
          '<div class="ep-sub">' + (p ? 'Uploaded ' + escHtml(fmt(p.uploaded_at)) : escHtml(s.hint)) + '</div>' +
          '<div class="ep-acts">' +
            '<label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">' + (p ? 'Replace' : 'Upload') +
              '<input type="file" accept="image/*" style="display:none" onchange="epUpload(' + id + ',&quot;' + s.k + '&quot;,this)"></label>' +
            (p ? '<button type="button" class="btn btn-ghost btn-sm" onclick="epRemove(' + id + ',&quot;' + s.k + '&quot;)">Remove</button>' : '') +
          '</div><div class="ep-msg" id="ep-msg-' + s.k + '" role="status"></div></div></div>';
      }).join('') + '</div>';
  }

  // Shrink before upload: a phone photo is 3-8 MB and the page only needs ~1600px.
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onerror = function () { reject(new Error('That photo could not be read.')); };
      rd.onload = function () {
        var img = new Image();
        img.onerror = function () { resolve(rd.result); };
        img.onload = function () {
          var s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
          var c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          try { resolve(c.toDataURL('image/jpeg', 0.86)); } catch (e) { resolve(rd.result); }
        };
        img.src = rd.result;
      };
      rd.readAsDataURL(file);
    });
  }

  window.epUpload = async function (id, slot, input) {
    if (!input || !input.files || !input.files.length) return;
    var msg = document.getElementById('ep-msg-' + slot);
    if (msg) msg.textContent = 'Uploading...';
    try {
      var data = await shrink(input.files[0]);
      await api('POST', '/employee-photos/' + id + '/' + slot, { data: data });
      if (typeof apiBustCache === 'function') apiBustCache('/employee-photos');
      if (typeof showToast === 'function') showToast('Photo saved.', 'success');
      await draw(id);
    } catch (e) {
      if (msg) msg.textContent = e.message || 'Upload failed.';
      input.value = '';
    }
  };

  window.epRemove = async function (id, slot) {
    var ok = typeof novaConfirm === 'function' ? await novaConfirm('Remove this photo? Customers will see the first initial instead.') : window.confirm('Remove this photo?');
    if (!ok) return;
    try {
      await api('DELETE', '/employee-photos/' + id + '/' + slot, {});
      if (typeof apiBustCache === 'function') apiBustCache('/employee-photos');
      await draw(id);
    } catch (e) { if (typeof showToast === 'function') showToast(e.message || 'Could not remove it.', 'error'); }
  };

  window.onbOpenFile = async function (id) {
    var r = await orig.apply(this, arguments);
    try { await draw(id); } catch (e) {}
    return r;
  };
  window.epDraw = draw;
})();
