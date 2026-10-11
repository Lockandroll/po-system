// The customer invoice page (/i/<token>, routes/invoiceLink.js). NOT part of the
// Nova app: no login, no app.js, nothing else loaded. Plain classic script, string
// concatenation only (CLAUDE.md 1.1).
(function () {
  var token = document.body.getAttribute('data-token') || '';
  var base = '/i/' + token;

  function post(path, body) {
    return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); });
  }
  function setMsg(el, text, ok) { if (!el) return; el.textContent = text || ''; el.className = 'msg ' + (ok ? 'ok' : 'err'); }

  // Share (phones). On a computer there is no share sheet, so the button stays hidden
  // and Download is the way to keep a copy.
  var shareBtn = document.getElementById('share-btn');
  if (shareBtn && navigator.share) {
    shareBtn.style.display = '';
    shareBtn.addEventListener('click', function () {
      navigator.share({ title: document.body.getAttribute('data-title') || 'Invoice', url: location.origin + base }).catch(function () {});
    });
  }

  // Email me a copy.
  var ecToggle = document.getElementById('ec-toggle');
  var ec = document.getElementById('ec');
  if (ecToggle && ec) {
    ecToggle.addEventListener('click', function () {
      ec.className = ec.className.indexOf(' on') === -1 ? 'ec on' : 'ec';
      var inp = document.getElementById('ec-email');
      if (inp && ec.className.indexOf(' on') !== -1) inp.focus();
    });
    var ecSend = document.getElementById('ec-send');
    ecSend.addEventListener('click', function () {
      var email = (document.getElementById('ec-email').value || '').trim();
      var msg = document.getElementById('ec-msg');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setMsg(msg, 'Enter a valid email address.'); return; }
      ecSend.disabled = true;
      post('/email-copy', { email: email }).then(function () {
        setMsg(msg, 'Sent to ' + email + '. It can take a minute to arrive.', true);
      }).catch(function (e) { setMsg(msg, e.message); }).then(function () { ecSend.disabled = false; });
    });
  }

  // The survey.
  var answers = {};
  var groups = document.querySelectorAll('[data-q]');
  Array.prototype.forEach.call(groups, function (g) {
    var q = g.getAttribute('data-q');
    Array.prototype.forEach.call(g.querySelectorAll('[data-v]'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(g.querySelectorAll('[data-v]'), function (x) { x.className = x.className.replace(/ on\b/, ''); });
        b.className += ' on';
        answers[q] = b.getAttribute('data-v');
      });
    });
  });
  var svSend = document.getElementById('sv-send');
  if (svSend) {
    svSend.addEventListener('click', function () {
      var msg = document.getElementById('sv-msg');
      if (!answers.overall) { setMsg(msg, 'Please pick how your overall experience was.'); return; }
      svSend.disabled = true;
      post('/survey', {
        overall: answers.overall,
        arrived: answers.arrived || null,
        price_explained: answers.price_explained || null,
        professional: answers.professional || null,
        comment: (document.getElementById('sv-comment') || {}).value || '',
        call_me: answers.call_me === 'yes'
      }).then(function () {
        var sec = document.getElementById('survey');
        sec.innerHTML = '<div class="ok"><div class="ck">&#10003;</div><div><b>Thank you.</b><br>' +
          (answers.call_me === 'yes' ? 'Your feedback went to the local manager, and because you asked, they will call you within one business day.' : 'Your feedback went straight to the local manager.') +
          '</div></div>';
      }).catch(function (e) { setMsg(msg, e.message); svSend.disabled = false; });
    });
  }
})();
