// The customer call page (/c/<token>, routes/callLink.js). NOT part of the Nova
// app: no login, nothing else loaded. Classic script, string building only,
// no backticks (Windows corrupts them in .js).
(function () {
  var token = document.body.getAttribute('data-token') || '';
  var base = '/c/' + token;
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function post(path, body) {
    return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
          return j;
        });
      });
  }
  function msg(el, text, ok) { if (!el) return; el.textContent = text || ''; el.className = 'msg ' + (ok ? 'ok' : 'err'); }
  function show(el, on) { if (el) el.className = on ? '' : 'hide'; }

  // ---- edit details
  var ed = $('ed'), edOpen = $('ed-open');
  if (ed && edOpen) {
    edOpen.addEventListener('click', function () {
      var open = ed.className === 'hide';
      show(ed, open); show($('dl'), !open);
      edOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
      edOpen.textContent = open ? 'Close' : 'Edit';
      if (open) { var f = $('f-address'); if (f) f.focus(); }
    });
    $('ed-cancel').addEventListener('click', function () { edOpen.click(); });
    ed.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      var body = {};
      Array.prototype.forEach.call(ed.querySelectorAll('[name]'), function (i) { body[i.name] = i.value; });
      busy = true;
      var btn = ed.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Saving...';
      post('/edit', body).then(function () {
        msg($('ed-msg'), 'Saved. Your technician has been told.', true);
        setTimeout(function () { location.reload(); }, 900);
      }).catch(function (err) {
        msg($('ed-msg'), err.message);
        btn.disabled = false; btn.textContent = 'Save changes'; busy = false;
      });
    });
  }

  // ---- driver's license photo: shrink on the phone first, so a 12 MP photo
  // uploads in a second on a weak signal.
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onerror = function () { reject(new Error('That photo could not be read.')); };
      rd.onload = function () {
        var img = new Image();
        img.onerror = function () { resolve(rd.result); };   // not decodable here (HEIC): send as is
        img.onload = function () {
          var max = 1600, w = img.naturalWidth, h = img.naturalHeight;
          var s = Math.min(1, max / Math.max(w, h));
          var c = document.createElement('canvas');
          c.width = Math.round(w * s); c.height = Math.round(h * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          try { resolve(c.toDataURL('image/jpeg', 0.85)); } catch (e) { resolve(rd.result); }
        };
        img.src = rd.result;
      };
      rd.readAsDataURL(file);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-id-file]'), function (inp) {
    inp.addEventListener('change', function () {
      if (!inp.files || !inp.files.length || busy) return;
      busy = true;
      msg($('id-msg'), 'Uploading...', true);
      shrink(inp.files[0]).then(function (data) { return post('/id', { data: data }); }).then(function () {
        msg($('id-msg'), 'Got it. Your ID is on file.', true);
        setTimeout(function () { location.reload(); }, 900);
      }).catch(function (err) { msg($('id-msg'), err.message); busy = false; inp.value = ''; });
    });
  });

  // ---- cancel
  var cx = $('cx'), cxOpen = $('cx-open'), reason = '';
  if (cx && cxOpen) {
    cxOpen.addEventListener('click', function () {
      show(cx, true); cxOpen.className = 'hide'; cxOpen.setAttribute('aria-expanded', 'true');
      var first = cx.querySelector('.chip'); if (first) first.focus();
    });
    $('cx-back').addEventListener('click', function () { show(cx, false); cxOpen.className = 'btn danger'; cxOpen.setAttribute('aria-expanded', 'false'); });
    Array.prototype.forEach.call(cx.querySelectorAll('.chip'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(cx.querySelectorAll('.chip'), function (x) { x.className = 'chip'; x.setAttribute('aria-pressed', 'false'); });
        b.className = 'chip on'; b.setAttribute('aria-pressed', 'true');
        reason = b.getAttribute('data-reason');
      });
    });
    cx.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      busy = true;
      var btn = cx.querySelector('button[type=submit]');
      btn.disabled = true;
      post('/cancel', { reason: reason, other: ($('cx-other') || {}).value || '' }).then(function () {
        location.reload();
      }).catch(function (err) { msg($('cx-msg'), err.message); btn.disabled = false; busy = false; });
    });
  }

  // ---- keep the status fresh while the customer waits, but never under a
  // half-typed form.
  setInterval(function () {
    if (busy || document.hidden) return;
    if (ed && ed.className !== 'hide') return;
    if (cx && cx.className !== 'hide') return;
    location.reload();
  }, 60000);
})();
