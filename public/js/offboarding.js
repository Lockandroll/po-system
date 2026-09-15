// Nova Offboarding Module
// 6 screens: list, start wizard (3 screens), detail, templates admin, exit form (public), responses+insights

const offboarding = (() => {
  // Nova's global api() is api(method, path, body) and reads localStorage.po_token.
  // This module speaks fetch-style, so it keeps its own thin adapter rather than
  // calling the global with the wrong signature.
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (localStorage.getItem('po_token') || ''),
        ...(opts.headers || {})
      }
    });
    // Every authenticated response carries a fresh rolling token.
    const fresh = res.headers.get('X-New-Token');
    if (fresh) { try { localStorage.setItem('po_token', fresh); } catch (e) {} }
    if (!res.ok) {
      const raw = await res.text();
      let msg = raw;
      try { msg = JSON.parse(raw).error || raw; } catch (e) {}
      const e = new Error(msg);
      e.rawBody = raw;
      throw e;
    }
    return res.json();
  }

  // app.js hands each view the element it renders into (#content).
  function host(container) {
    return container || document.getElementById('content');
  }

  function go(view, param) {
    if (typeof navigate === 'function') return navigate(view, param);
    location.hash = param != null ? ('#' + view + '/' + param) : ('#' + view);
  }

  async function renderListScreen(container) {
    const root = host(container);
    const { status = '', type = '', year = '' } = (typeof state === 'object' && state.offboardingFilters) || {};

    let url = '/api/offboarding';
    if (status || type || year) {
      const params = new URLSearchParams();
      if (status) params.append('status', status);
      if (type) params.append('type', type);
      if (year) params.append('year', year);
      url += '?' + params;
    }

    try {
      const records = await api(url);

      root.innerHTML = `
        <div class="offboarding-list ob-page">
          <header class="page-header">
            <h1>Offboarding</h1>
            <div class="header-actions">
              ${(typeof can === 'function' && can('view_exit_interviews')) ? `<button class="btn btn-secondary" onclick="navigate('exit-interviews')">Exit Interviews</button>` : ''}
              ${(typeof can === 'function' && can('manage_offboarding')) ? `<button class="btn btn-secondary" onclick="navigate('offboarding-setup')">Setup</button>` : ''}
              <button class="btn btn-primary" id="btn-start-offboarding">Start Offboarding</button>
            </div>
          </header>

          <div class="filters">
            <select id="filter-status" class="filter-select">
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="pending_finalize">Pending Finalize</option>
              <option value="finalized">Finalized</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select id="filter-type" class="filter-select">
              <option value="">All types</option>
              <option value="voluntary">Voluntary</option>
              <option value="involuntary">Involuntary</option>
              <option value="job_abandonment">Job Abandonment</option>
              <option value="retirement">Retirement</option>
            </select>
            <input type="number" id="filter-year" class="filter-input" placeholder="Year" />
            <button class="btn btn-sm" id="btn-apply-filters">Apply Filters</button>
          </div>

          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Type</th>
                <th>Last Day</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${records.length ? records.map(r => `
                <tr>
                  <td><strong>${r.name}</strong></td>
                  <td><span class="badge">${roleLabel(r.role)}</span></td>
                  <td><span class="badge badge-${r.type}">${r.type}</span></td>
                  <td>${fmtDate(r.last_day)}</td>
                  <td>
                    <div class="progress-track"><div class="progress-bar" style="width: ${(r.done_steps / r.total_steps * 100) || 0}%"></div></div>
                    <small>${r.done_steps}/${r.total_steps}</small>
                  </td>
                  <td><span class="badge badge-${r.status}">${r.status}</span></td>
                  <td><a href="javascript:void(0)" class="link" onclick="navigate('offboarding-detail', ${r.id})">View</a></td>
                </tr>
              `).join('') : '<tr><td colspan="7" class="text-muted">Nobody is leaving. Good.</td></tr>'}
            </tbody>
          </table>
        </div>
      `;

      document.getElementById('btn-start-offboarding').addEventListener('click', () => renderStartWizard(root));
      document.getElementById('btn-apply-filters').addEventListener('click', () => {
        const s = document.getElementById('filter-status').value;
        const t = document.getElementById('filter-type').value;
        const y = document.getElementById('filter-year').value;
        const params = new URLSearchParams();
        if (s) params.append('status', s);
        if (t) params.append('type', t);
        if (y) params.append('year', y);
        state.offboardingFilters = { status: s, type: t, year: y };
        renderListScreen(root);
      });
    } catch (err) {
      root.innerHTML = `<div class="error">Error loading offboardings: ${err.message}</div>`;
    }
  }

  async function renderStartWizard(container) {
    const root = host(container);
    root.innerHTML = `
      <div class="ob-page"><div class="wizard-container">
        <div class="wizard-screen" id="wizard-screen">
          <header class="page-header"><h2>Start Offboarding</h2></header>
          <div class="wizard-content"></div>
        </div>
      </div></div>
    `;

    let step = 1;
    const formData = { users: [] };

    async function showScreen1() {
      const users = await api('/api/offboarding/eligible');
      const types = ['voluntary', 'involuntary', 'job_abandonment', 'retirement', 'end_of_contract', 'other'];

      document.querySelector('.wizard-content').innerHTML = `
        <form id="wizard-form-1">
          <div class="form-group">
            <label>Who is leaving?</label>
            <select id="user-id" required class="form-control">
              <option value="">Select employee...</option>
              ${users.map(u => `<option value="${u.id}">${u.name} (${roleLabel(u.role)})</option>`).join('')}
            </select>
          </div>

          <div class="form-group">
            <label>Type of departure</label>
            <select id="dep-type" required class="form-control">
              ${types.map(t => `<option value="${t}">${prettify(t)}</option>`).join('')}
            </select>
          </div>

          <p class="text-muted" style="font-size:13px;margin:-4px 0 18px">Why they are leaving comes from their own exit form, not from here.</p>

          <div class="form-group">
            <label><input type="checkbox" id="eligible-rehire" /> Eligible for rehire</label>
            <textarea id="rehire-notes" class="form-control" placeholder="Rehire notes..." rows="2" disabled></textarea>
          </div>

          <div class="wizard-buttons">
            <button type="button" class="btn btn-secondary" id="btn-cancel-wizard">Cancel</button>
            <button type="button" class="btn btn-primary" id="btn-next-1">Next</button>
          </div>
        </form>
      `;

      document.getElementById('btn-cancel-wizard').addEventListener('click', () => go('offboarding'));
      document.getElementById('btn-next-1').addEventListener('click', () => {
        const _sel = document.getElementById('user-id');
        formData.user_id = parseInt(_sel.value);
        formData.user_name = _sel.options[_sel.selectedIndex] ? _sel.options[_sel.selectedIndex].text : '';
        formData.type = document.getElementById('dep-type').value;
        formData.eligible_for_rehire = document.getElementById('eligible-rehire').checked;
        formData.rehire_notes = document.getElementById('rehire-notes').value;
        showScreen2();
      });

      document.getElementById('eligible-rehire').addEventListener('change', (e) => {
        document.getElementById('rehire-notes').disabled = !e.target.checked;
      });
    }

    async function showScreen2() {
      document.querySelector('.wizard-content').innerHTML = `
        <form id="wizard-form-2">
          <div class="form-group">
            <label>Notice date</label>
            <input type="date" id="notice-date" class="form-control" value="${todayStr()}" required />
            <small class="text-muted">The day they told you, or the day you told them.</small>
          </div>

          <div class="form-group">
            <label>Last day</label>
            <input type="date" id="last-day" class="form-control" required />
            <small class="text-muted">Their last day on the payroll. The record waits on paperwork after this.</small>
          </div>

          <div class="form-group">
            <label>Final check date</label>
            <input type="date" id="final-check-date" class="form-control" />
            <small class="text-muted">The last date their final paycheck will be issued. Leave blank if it is not set yet.</small>
          </div>

          <div class="form-group">
            <label>Where to reach them afterwards</label>
            <input type="email" id="contact-email" class="form-control" placeholder="personal@email.com" />
            <small class="text-muted">Their work address stops working when access is revoked, and everything after that &mdash; the exit form, the separation agreement, their signed copy &mdash; goes here. Ask for it now while you still can.</small>
          </div>

          <div class="form-group">
            <label>Revoke access</label>
            <div class="radio-stack">
              <label class="radio-row">
                <input type="radio" name="revoke-when" value="on_date" checked />
                <span>On this date
                  <input type="date" id="revoke-date" class="form-control revoke-inline" />
                </span>
              </label>
              <label class="radio-row">
                <input type="radio" name="revoke-when" value="immediate" />
                <span>The moment I press Begin <em class="text-muted">- walk-outs and involuntary terminations</em></span>
              </label>
              <label class="radio-row">
                <input type="radio" name="revoke-when" value="on_finalize" />
                <span>Only when I finalize the record <em class="text-muted">- you switch it off by hand</em></span>
              </label>
            </div>
            <small class="text-muted" id="revoke-hint">Their login stops working at the end of the day you pick. It follows the last day unless you change it.</small>
          </div>

          <div class="wizard-buttons">
            <button type="button" class="btn btn-secondary btn-wizard-back">Back</button>
            <button type="button" class="btn btn-primary" id="btn-next-2">Review</button>
          </div>
        </form>
      `;

      const lastDay = document.getElementById('last-day');
      const revokeDate = document.getElementById('revoke-date');
      let revokeTouched = false;

      // The revoke date follows the last day until somebody sets it themselves; after
      // that it stays where they put it, because that is the whole point of the field.
      lastDay.addEventListener('input', () => { if (!revokeTouched) revokeDate.value = lastDay.value; });
      revokeDate.addEventListener('input', () => { revokeTouched = true; });
      revokeDate.addEventListener('click', (e) => { e.stopPropagation(); });

      function syncRevoke() {
        const mode = document.querySelector('input[name="revoke-when"]:checked').value;
        revokeDate.disabled = mode !== 'on_date';
        const hint = document.getElementById('revoke-hint');
        if (mode === 'immediate') hint.textContent = 'Their login and every trusted device are gone the moment you press Begin on the next screen.';
        else if (mode === 'on_finalize') hint.textContent = 'Nothing happens automatically. The account stays live until you finalize the record.';
        else hint.textContent = 'Their login stops working at the end of the day you pick. It follows the last day unless you change it.';
      }
      document.querySelectorAll('input[name="revoke-when"]').forEach(r => r.addEventListener('change', syncRevoke));
      syncRevoke();

      document.querySelectorAll('.btn-wizard-back').forEach(b => b.addEventListener('click', () => showScreen1()));
      document.getElementById('btn-next-2').addEventListener('click', () => {
        const mode = document.querySelector('input[name="revoke-when"]:checked').value;
        if (!lastDay.value) { alert('Pick their last day.'); return; }
        if (mode === 'on_date' && !revokeDate.value) { alert('Pick the day their access should stop, or choose one of the other two.'); return; }
        formData.notice_date = document.getElementById('notice-date').value;
        formData.last_day = lastDay.value;
        formData.final_check_date = document.getElementById('final-check-date').value || null;
        formData.contact_email = document.getElementById('contact-email').value.trim() || null;
        // 'end_of_last_day' is kept as the stored value for a dated revoke so older
        // records keep their meaning; the date is what the job actually reads.
        formData.deactivate_mode = mode === 'on_date' ? 'end_of_last_day' : mode;
        formData.access_revoke_date = mode === 'on_date' ? revokeDate.value : (mode === 'immediate' ? todayStr() : null);
        showScreen3();
      });
    }

    async function showScreen3() {
      // The checklist this person will actually get (core + any role add-on).
      const preview = await api(`/api/offboarding/preview?user_id=${formData.user_id}&type=${encodeURIComponent(formData.type)}`);
      const previewSteps = preview.steps || [];

      document.querySelector('.wizard-content').innerHTML = `
        <div class="review-screen">
          <h3>Review & Begin</h3>
          <dl class="review-list">
            <dt>Employee:</dt><dd id="review-name">${formData.user_name || '—'}</dd>
            <dt>Type:</dt><dd>${prettify(formData.type)}</dd>
            <dt>Last day:</dt><dd>${fmtDate(formData.last_day)}</dd>
            <dt>Final check:</dt><dd>${formData.final_check_date ? fmtDate(formData.final_check_date) : 'not set'}</dd>
            <dt>Reach them at:</dt><dd>${formData.contact_email ? esc(formData.contact_email) : 'not set — you will be asked again before anything is sent'}</dd>
            <dt>Access ends:</dt><dd>${revokeSummary(formData)}</dd>
          </dl>

          <h4>Checklist Preview (${previewSteps.length} steps)</h4>
          <div class="checklist-preview">
            ${previewSteps.length ? previewSteps.map((s, i) => `
              <div class="step-preview" style="margin-bottom: 8px;">
                <span class="step-number">${i + 1}</span>
                <span class="step-title">${s.title}</span>
                ${s.required ? '<span class="badge badge-danger">Required</span>' : ''}
                ${s.auto_key ? '<span class="badge badge-info">Auto</span>' : ''}
              </div>
            `).join('') : '<p class="text-muted">No steps loaded</p>'}
          </div>

          <div class="form-group">
            <label><input type="checkbox" id="confirm" required /> I confirm the information above is correct</label>
          </div>

          <div class="wizard-buttons">
            <button type="button" class="btn btn-secondary btn-wizard-back">Back</button>
            <button type="button" class="btn btn-primary" id="btn-begin" disabled>Begin Offboarding</button>
          </div>
        </div>
      `;

      document.querySelectorAll('.btn-wizard-back').forEach(b => b.addEventListener('click', () => showScreen2()));
      document.getElementById('confirm').addEventListener('change', (e) => {
        document.getElementById('btn-begin').disabled = !e.target.checked;
      });

      document.getElementById('btn-begin').addEventListener('click', async () => {
        try {
          const result = await api('/api/offboarding', { method: 'POST', body: JSON.stringify(formData) });
          go('offboarding-detail', result.id);
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
    }

    showScreen1();
  }

  // =========================================================================
  // Receipt of Property.
  //
  // A card on the offboarding record, and a full-width screen behind it. The
  // screen is not a sidebar card on purpose: a dozen items with two dropdowns
  // each does not fit in 320px, and squeezing it there is how people stop
  // reading the rows.
  //
  // The two dropdowns are the whole idea. OUTCOME is what happened to the item,
  // DISPOSITION is where it went afterwards. They are separate questions because
  // they are separate facts - "he handed it back" does not say where it is now.
  //
  // House style in this block: string concatenation, &#39; for apostrophes.
  // =========================================================================
  var _prop = null;        // the receipt currently open on the screen
  var _propPickers = null; // cities + people, fetched once per screen

  var PROP_OUTCOMES = [
    ['returned', 'Returned'], ['not_returned', 'Not returned'],
    ['lost', 'Lost'], ['stolen', 'Stolen'], ['kept', 'Kept by agreement']
  ];
  var PROP_GONE = ['not_returned', 'lost', 'stolen', 'kept'];
  var PROP_CONDITIONS = ['', 'new', 'good', 'fair', 'poor'];
  var PROP_STATUS_LABEL = {
    draft: 'Draft, not posted',
    posted: 'Posted',
    reversed: 'Reversed'
  };

  function propIsGone(o) { return PROP_GONE.indexOf(o) !== -1; }

  // Mirrors allowedDispositions() in utils/property.js. The server refuses the
  // impossible pairs regardless; this only stops the browser offering them, so a
  // manager never picks something that is going to bounce.
  function propAllowedDispositions(outcome, tracked) {
    if (propIsGone(outcome)) return [['writeoff', 'Written off']];
    if (!tracked) return [['person', 'Assigned on'], ['retire', 'Retired'], ['none', 'No action']];
    return [['stock', 'Back to stock'], ['person', 'Assigned on'],
            ['repair', 'Needs repair'], ['retire', 'Retired']];
  }

  function propMoney(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ---------------------------------------------------------------- the card

  function propCardShell() {
    return '<div class="ob-prop-card" id="prop-card">' +
      '<h3>Receipt of Property</h3>' +
      '<div id="prop-card-body"><p class="text-muted">Loading&hellip;</p></div>' +
    '</div>';
  }

  async function propFill(obId) {
    var host = document.getElementById('prop-card-body');
    if (!host) return;
    var d;
    try { d = await api('/api/property/by-offboarding/' + obId); }
    catch (e) { host.innerHTML = '<p class="text-muted">' + esc(e.message) + '</p>'; return; }

    var r = d.receipt;
    var html = '';
    if (!r) {
      var waiting = d.holdings_waiting || 0;
      html = '<p class="text-muted">' +
        (waiting
          ? ('They hold <strong>' + waiting + '</strong> tracked item' + (waiting === 1 ? '' : 's') +
             '. Start the receipt and it pulls them all in.')
          : 'Nothing tracked is assigned to them. Start a receipt anyway for keys, cards and badges.') +
        '</p>' +
        (canManage() ? '<button class="btn btn-primary btn-block" id="prop-start">Start the receipt</button>' : '');
    } else {
      var t = d.totals || {};
      html = '<p class="text-muted" style="margin-bottom:8px"><strong>' + esc(r.receipt_number) + '</strong> &middot; ' +
        (r.status === 'draft' ? '<span style="color:var(--warning)">Draft, not posted</span>'
          : esc(PROP_STATUS_LABEL[r.status] || r.status)) + '</p>';
      if (r.nothing_to_return) {
        html += '<p class="text-muted" style="font-size:12px">Nothing to hand back.</p>';
      } else {
        html += '<div class="ob-mini"><span>Lines</span><b>' + (t.lines || 0) + '</b></div>' +
          '<div class="ob-mini"><span>Returned</span><b style="color:var(--success)">' + (t.returned || 0) + '</b></div>';
        if (t.gone) {
          html += '<div class="ob-mini"><span>Not returned</span><b style="color:#f87171">' + t.gone +
            ' &middot; ' + propMoney(t.value_not_returned) + '</b></div>';
        }
        if (t.to_person) html += '<div class="ob-mini"><span>Assigned on</span><b>' + t.to_person + '</b></div>';
      }
      html += '<button class="btn ' + (r.status === 'draft' ? 'btn-primary' : 'btn-secondary') +
        ' btn-block" id="prop-open" style="margin-top:10px">' +
        (r.status === 'draft' ? 'Open the receipt' : 'View the receipt') + '</button>';
      if (r.status === 'draft') {
        html += '<p class="text-muted" style="font-size:12px;margin:9px 0 0">The agreement can&#39;t be sent until this is posted.</p>';
      }
    }
    host.innerHTML = html;

    document.getElementById('prop-start')?.addEventListener('click', async function () {
      try {
        await api('/api/property', { method: 'POST', body: JSON.stringify({ offboarding_id: obId }) });
        go('offboarding-property', obId);
      } catch (e) { alert('Error: ' + e.message); }
    });
    document.getElementById('prop-open')?.addEventListener('click', function () {
      go('offboarding-property', obId);
    });
  }

  // ---------------------------------------------------------------- the screen

  async function renderPropertyScreen(obId, container) {
    var root = host(container);
    root.innerHTML = '<div class="loading">Loading&hellip;</div>';

    var d, ob;
    try {
      ob = await api('/api/offboarding/' + obId);
      d = await api('/api/property/by-offboarding/' + obId);
    } catch (e) {
      root.innerHTML = '<div class="error">Error loading the receipt: ' + esc(e.message) + '</div>';
      return;
    }
    if (!d.receipt) {
      root.innerHTML = '<div class="error">No receipt has been started for this offboarding yet.</div>';
      return;
    }
    if (!_propPickers) {
      try { _propPickers = await api('/api/property/pickers'); }
      catch (e) { _propPickers = { cities: [], people: [] }; }
    }
    _prop = d;

    var r = d.receipt;
    var lines = d.lines || [];
    var t = d.totals || {};
    var posted = r.status === 'posted';
    var editable = !posted && canManage();

    root.innerHTML =
      '<div class="ob-page prop-page">' +
        '<header class="page-header">' +
          '<div>' +
            '<div class="prop-crumb"><a href="#" id="prop-back">Offboarding</a> &rsaquo; ' + esc(ob.name) + ' &rsaquo; Receipt of Property</div>' +
            '<h1>Receipt of Property</h1>' +
            '<div class="meta-chips">' +
              '<span class="chip chip-plain">' + esc(r.receipt_number) + '</span>' +
              '<span class="chip ' + (posted ? 'chip-finalized' : 'chip-pending_finalize') + '">' +
                esc(PROP_STATUS_LABEL[r.status] || r.status) + '</span>' +
              '<span class="chip chip-plain">' + esc(ob.name) + (ob.title ? (' &middot; ' + esc(ob.title)) : '') + '</span>' +
              '<span class="chip chip-plain">Last day ' + fmtDate(ob.last_day) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="header-actions">' +
            (editable ? '<button class="btn btn-secondary" id="prop-add">Add a line</button>' : '') +
            (editable ? '<button class="btn btn-primary" id="prop-post">Post receipt</button>' : '') +
            (posted && canManage() ? '<button class="btn btn-danger" id="prop-reverse">Reverse</button>' : '') +
          '</div>' +
        '</header>' +

        (posted ? (
          '<div class="prop-posted-banner">Posted ' + fmtDate(r.posted_at) +
          '. The lines are frozen and the equipment has moved. Reverse it if something needs changing.</div>'
        ) : '') +

        '<div class="prop-summary">' +
          propStat('Lines', t.lines || 0, 'on this receipt') +
          propStat('Returned', t.returned || 0, 'handed back', 'var(--success)') +
          propStat('Not returned', t.gone || 0, propMoney(t.value_not_returned || 0) + ' of equipment', (t.gone ? '#f87171' : null)) +
          propStat('Value in hand', propMoney(t.value_in_hand || 0), 'at last issued cost') +
        '</div>' +

        (lines.length ? propTable(lines, editable) :
          '<p class="text-muted">Nothing on this receipt yet. Add the keys, cards and badges by hand, ' +
          'or mark it as nothing to hand back.</p>') +

        '<div class="prop-foot">' +
          '<p class="note" id="prop-summary-note">' + esc(d.summary || '') + '</p>' +
          '<div class="header-actions">' +
            (editable ? '<button class="btn btn-secondary" id="prop-save">Save draft</button>' : '') +
            (editable && !lines.filter(function (l) { return l.tracked; }).length
              ? '<button class="btn btn-secondary" id="prop-none">Nothing to hand back</button>' : '') +
            (editable ? '<button class="btn btn-primary" id="prop-post2">Post receipt</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>';

    propWire(obId, r, lines, editable);
  }

  function propStat(label, value, sub, color) {
    return '<div class="prop-stat">' +
      '<h4>' + esc(label) + '</h4>' +
      '<p class="big"' + (color ? (' style="color:' + color + '"') : '') + '>' + esc(value) + '</p>' +
      '<p class="sub">' + esc(sub) + '</p>' +
    '</div>';
  }

  function propSelect(id, opts, current, cls) {
    return '<select class="prop-sel' + (cls ? (' ' + cls) : '') + '" data-field="' + id.split('|')[0] +
      '" data-line="' + id.split('|')[1] + '">' +
      opts.map(function (o) {
        var v = o[0], lbl = o[1];
        return '<option value="' + esc(v) + '"' + (String(v) === String(current == null ? '' : current) ? ' selected' : '') + '>' +
          esc(lbl) + '</option>';
      }).join('') + '</select>';
  }

  function propTable(lines, editable) {
    var cities = (_propPickers && _propPickers.cities) || [];
    var people = (_propPickers && _propPickers.people) || [];
    var tracked = lines.filter(function (l) { return l.tracked; });
    var adhoc = lines.filter(function (l) { return !l.tracked; });

    var head = '<tr>' +
      '<th style="width:24%">Item</th><th style="width:13%">Serial / tag</th><th style="width:5%">Qty</th>' +
      '<th style="width:11%">Condition back</th><th style="width:13%">What happened</th>' +
      '<th style="width:18%">Where it goes</th><th style="width:16%">Note</th></tr>';

    function group(title, rows) {
      if (!rows.length) return '';
      return '<tr class="prop-grp"><td colspan="7">' + esc(title) + '</td></tr>' +
        rows.map(function (l) { return propRow(l, editable, cities, people); }).join('');
    }

    return '<div class="prop-table-wrap"><table class="prop-table"><thead>' + head + '</thead><tbody>' +
      group('Tracked equipment — from their record', tracked) +
      group('Added by hand — not tracked equipment', adhoc) +
      '</tbody></table></div>';
  }

  function propRow(l, editable, cities, people) {
    var gone = propIsGone(l.outcome);
    var dot = gone ? 'd-bad' : (l.disposition === 'repair' ? 'd-warn' : 'd-ok');
    var dispOpts = propAllowedDispositions(l.outcome, !!l.tracked);

    // "Back to stock" and "assigned on" both need a target, so the destination
    // rides in the same dropdown rather than appearing as a second one that is
    // empty most of the time.
    var whereOpts = [];
    dispOpts.forEach(function (o) {
      if (o[0] === 'stock') {
        cities.forEach(function (c) { whereOpts.push(['stock:' + c.code, c.name + ' — back to stock']); });
        if (!cities.length) whereOpts.push(['stock:', 'Back to stock']);
      } else if (o[0] === 'person') {
        people.forEach(function (p) { whereOpts.push(['person:' + p.id, p.name + ' — assign']); });
        if (!people.length) whereOpts.push(['person:', 'Assign to somebody']);
      } else {
        whereOpts.push([o[0] + ':', o[1]]);
      }
    });
    var whereCurrent = l.disposition + ':' +
      (l.disposition === 'stock' ? (l.dest_city_code || '') : (l.disposition === 'person' ? (l.dest_user_id || '') : ''));

    var condOpts = PROP_CONDITIONS.map(function (x) { return [x, x ? (x.charAt(0).toUpperCase() + x.slice(1)) : '—']; });

    var dis = editable ? '' : ' disabled';
    return '<tr data-line-row="' + l.id + '">' +
      '<td><span class="prop-dot ' + dot + '"></span><span class="prop-name">' + esc(l.label) + '</span>' +
        '<div class="prop-sub">' + esc(l.category || (l.tracked ? 'Equipment' : 'Not tracked')) +
        (l.unit_cost ? (' &middot; ' + propMoney(l.unit_cost)) : '') + '</div></td>' +
      '<td>' + (l.asset_tag ? esc(l.asset_tag) : '—') +
        (l.serial_number ? ('<div class="prop-sub">SN ' + esc(l.serial_number) + '</div>') : '') + '</td>' +
      '<td><input class="prop-inp prop-qty" type="number" min="1" data-field="qty" data-line="' + l.id +
        '" value="' + esc(l.qty || 1) + '"' + dis + '></td>' +
      '<td>' + (gone
        ? '<select class="prop-sel" disabled><option>—</option></select>'
        : propSelect('condition_in|' + l.id, condOpts, l.condition_in || '')) + '</td>' +
      '<td>' + propSelect('outcome|' + l.id, PROP_OUTCOMES, l.outcome, gone ? 'bad' : '') + '</td>' +
      '<td>' + propSelect('where|' + l.id, whereOpts, whereCurrent,
        gone ? 'bad' : (l.disposition === 'repair' ? 'warn' : '')) + '</td>' +
      '<td><input class="prop-inp" data-field="note" data-line="' + l.id + '" value="' + esc(l.note || '') +
        '" placeholder="—"' + dis + '>' +
        (l.posted_note ? ('<div class="prop-sub">' + esc(l.posted_note) + '</div>') : '') +
        (editable && !l.tracked ? ' <button class="prop-x" data-del-line="' + l.id + '" title="Remove this line">&times;</button>' : '') +
        '</td>' +
    '</tr>';
  }

  // Read the grid back out of the DOM. One place that knows the shape, used by
  // save and by post, so the two can never disagree about what is on the page.
  function propCollect(lines) {
    return lines.map(function (l) {
      var row = document.querySelector('[data-line-row="' + l.id + '"]');
      if (!row) return l;
      function val(field) {
        var el = row.querySelector('[data-field="' + field + '"]');
        return el ? el.value : null;
      }
      var where = String(val('where') || ':');
      var bits = where.split(':');
      var disposition = bits[0] || 'none';
      var target = bits.slice(1).join(':');
      return {
        id: l.id,
        outcome: val('outcome') || l.outcome,
        disposition: disposition,
        condition_in: val('condition_in') || null,
        dest_city_code: disposition === 'stock' ? (target || null) : null,
        dest_user_id: disposition === 'person' ? (target || null) : null,
        note: val('note'),
        qty: val('qty') || l.qty,
        // Carried so the client-side totals and the post summary can be redrawn
        // without another round trip.
        unit_cost: l.unit_cost, tracked: l.tracked, holding_id: l.holding_id, label: l.label
      };
    });
  }

  function propWire(obId, r, lines, editable) {
    document.getElementById('prop-back')?.addEventListener('click', function (e) {
      e.preventDefault(); go('offboarding-detail', obId);
    });

    // Changing what happened to an item changes where it is allowed to go, so
    // the row is redrawn rather than left offering a choice the server refuses.
    document.querySelectorAll('[data-field="outcome"]').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        await propSave(obId, lines, true);
      });
    });

    async function propSave(obId2, ls, redraw) {
      try {
        var payload = propCollect(ls);
        var res = await api('/api/property/' + r.id + '/lines', {
          method: 'PUT', body: JSON.stringify({ lines: payload })
        });
        if (redraw) { await renderPropertyScreen(obId2); return res; }
        return res;
      } catch (e) { alert('Error: ' + e.message); throw e; }
    }

    document.getElementById('prop-save')?.addEventListener('click', async function () {
      try { await propSave(obId, lines, false); if (typeof showToast === 'function') showToast('Saved.', 'success'); }
      catch (e) {}
    });

    document.getElementById('prop-add')?.addEventListener('click', async function () {
      var label = prompt('What is it? (fuel card, shop keys, badge, uniform…)');
      if (!label) return;
      try {
        await api('/api/property/' + r.id + '/lines', { method: 'POST', body: JSON.stringify({ label: label }) });
        await renderPropertyScreen(obId);
      } catch (e) { alert('Error: ' + e.message); }
    });

    document.querySelectorAll('[data-del-line]').forEach(function (b) {
      b.addEventListener('click', async function () {
        try {
          await api('/api/property/' + r.id + '/lines/' + b.dataset.delLine, { method: 'DELETE' });
          await renderPropertyScreen(obId);
        } catch (e) { alert('Error: ' + e.message); }
      });
    });

    async function doPost() {
      try {
        await propSave(obId, lines, false);
        var res = await api('/api/property/' + r.id + '/post', { method: 'POST', body: '{}' });
        if (typeof showToast === 'function') {
          showToast('Posted. ' + (res.holdings_closed || 0) + ' holding' +
            ((res.holdings_closed === 1) ? '' : 's') + ' closed.', 'success');
        }
        go('offboarding-detail', obId);
      } catch (e) { alert(e.message); }
    }
    document.getElementById('prop-post')?.addEventListener('click', doPost);
    document.getElementById('prop-post2')?.addEventListener('click', doPost);

    document.getElementById('prop-none')?.addEventListener('click', async function () {
      try {
        await api('/api/property/' + r.id + '/none', { method: 'POST', body: '{}' });
        go('offboarding-detail', obId);
      } catch (e) { alert(e.message); }
    });

    document.getElementById('prop-reverse')?.addEventListener('click', async function () {
      var why = prompt('Reversing puts the equipment back on their record and takes it out of stock again. Why?');
      if (why === null) return;
      try {
        await api('/api/property/' + r.id + '/reverse', { method: 'POST', body: JSON.stringify({ reason: why }) });
        await renderPropertyScreen(obId);
      } catch (e) { alert(e.message); }
    });
  }

  // =========================================================================
  // Separation agreement card.
  //
  // The offboarding detail screen draws an empty shell (sepCardShell) and this
  // fills it from /api/separation/by-offboarding/:id. Two round trips rather
  // than one because the card needs the signing link and the countersign gate,
  // and neither of those belongs in the detail payload that every viewer of the
  // record gets - a live signing token is a credential.
  //
  // House style in this block: string concatenation, &#39; for apostrophes.
  // =========================================================================
  var _sep = null;

  // esc() is the module's own escaper, declared further down and hoisted. It
  // escapes apostrophes too, which matters because these strings go into
  // attributes.
  function sepEl(id) { return document.getElementById(id); }
  function sepVal(id) { var e = sepEl(id); return e ? e.value : ''; }
  function canManage() { return (typeof can !== 'function') || can('manage_offboarding'); }

  var SEP_STATUS_LABEL = {
    draft: 'Not sent yet',
    sent: 'Waiting on them to sign',
    employee_signed: 'Signed &mdash; needs countersignature',
    completed: 'Signed by both',
    declined: 'They declined it',
    voided: 'Withdrawn',
    expired: 'Link expired'
  };

  // One field, asked for in several places. The address a departing person can
  // actually read once their work mailbox is off - used by the exit form, the
  // separation agreement and the signed copies that follow. It lives on the
  // offboarding record, so every one of these writes to the same place.
  function contactEmailField(ob) {
    return '<label class="text-muted" style="font-size:12px">Where to reach them (their work address is usually off by now)</label>' +
      '<input class="form-control" id="ob-contact-email" value="' + esc(ob.contact_email || '') +
      '" placeholder="personal@email.com" style="margin-bottom:6px;font-size:12px" />';
  }

  function sepCardShell() {
    return '<div class="exit-form-card" id="sep-card">' +
      '<h3>Separation Agreement</h3>' +
      '<div id="sep-card-body"><p class="text-muted">Loading&hellip;</p></div>' +
    '</div>';
  }

  async function sepFill(obId) {
    var host = sepEl('sep-card-body');
    if (!host) return;
    var d;
    try { d = await api('/api/separation/by-offboarding/' + obId); }
    catch (e) { host.innerHTML = '<p class="text-muted">' + esc(e.message) + '</p>'; return; }
    // Only the draft editor offers a countersigner picker, so the list is only
    // fetched when it will be drawn. A failure here hides the picker and leaves
    // the rest of the card working - the default countersigner is already set.
    d.signers = [];
    if (d.agreement && d.agreement.status === 'draft' && canManage()) {
      try { d.signers = await api('/api/separation/signers'); } catch (e) { d.signers = []; }
    }
    _sep = d;
    host.innerHTML = sepBody(d);
    sepWire(obId, d);
  }

  function sepBody(d) {
    var a = d.agreement;
    if (!a) {
      return '<p class="text-muted">Nothing drafted yet. This is the document they sign &mdash; last day, final pay, property returned.</p>' +
        (canManage() ? '<button class="btn btn-primary btn-block" id="sep-start">Start agreement</button>' : '');
    }

    var out = '<p class="text-muted" style="margin-bottom:8px">' +
      '<strong>' + esc(a.agreement_number) + '</strong> &middot; ' + (SEP_STATUS_LABEL[a.status] || esc(a.status)) + '</p>';

    if (a.status === 'draft') {
      // The property receipt has to be posted before this can go out, because the
      // agreement prints that list. Said here rather than only on the failed send.
      if (d.receipt_blocker) {
        out += '<p class="text-muted" style="font-size:12px;color:var(--warning)">' + esc(d.receipt_blocker) + '</p>';
      }
      out += sepEditor(a, d) +
        (canManage() ? (
          '<button class="btn btn-primary btn-block" id="sep-send" style="margin-top:8px">Email it to them</button>' +
          '<button class="btn btn-secondary btn-block" id="sep-inperson" style="margin-top:6px">They&#39;re here &mdash; sign now</button>'
        ) : '');
      return out;
    }

    if (a.status === 'sent') {
      out += '<p class="text-muted" style="font-size:12px;margin-bottom:4px">Sent to ' + esc(a.employee_email || '') + '</p>';
      if (d.link) {
        out += '<input class="form-control" id="sep-link" readonly value="' + esc(d.link) + '" style="font-size:12px" />' +
               '<button class="btn btn-sm btn-block" id="sep-copy" style="margin-top:6px">Copy link</button>';
      }
      if (canManage()) {
        out += '<button class="btn btn-sm btn-block" id="sep-remind" style="margin-top:6px">Resend the email</button>' +
               '<button class="btn btn-secondary btn-block" id="sep-inperson" style="margin-top:6px">They&#39;re here &mdash; sign now</button>' +
               '<button class="btn btn-sm btn-block" id="sep-void" style="margin-top:6px">Withdraw</button>';
      }
      return out;
    }

    if (a.status === 'employee_signed') {
      out += '<p class="text-muted" style="font-size:12px">Signed by ' + esc(a.employee_printed_name || a.employee_name || 'them') +
             ' on ' + fmtDate(a.employee_signed_at) + '.</p>';
      if (d.can_countersign) {
        out += '<button class="btn btn-primary btn-block" id="sep-countersign">Countersign it</button>';
      } else {
        out += '<p class="text-muted" style="font-size:12px">Waiting on ' + esc(a.rep_name || 'the named manager') + ' to countersign.</p>';
      }
      return out;
    }

    if (a.status === 'completed') {
      out += '<p class="text-muted" style="font-size:12px">' + esc(a.employee_printed_name || a.employee_name || 'They') +
             ' signed ' + fmtDate(a.employee_signed_at) + '; ' + esc(a.rep_name || 'the manager') +
             ' countersigned ' + fmtDate(a.rep_signed_at) + '.</p>' +
             '<button class="btn btn-sm btn-block" id="sep-download">Download the signed PDF</button>';
      return out;
    }

    // declined / voided / expired
    if (a.declined_reason) {
      out += '<p class="text-muted" style="font-size:12px">Reason given: ' + esc(a.declined_reason) + '</p>';
    }
    if (canManage()) {
      out += '<button class="btn btn-secondary btn-block" id="sep-reopen">Reopen as a draft</button>';
    }
    return out;
  }

  // The draft editor. Everything here is printed on the document the person
  // signs, so it is edited in one place and only while the agreement is a draft.
  function sepEditor(a, d) {
    var signers = d.signers || [];
    var sel = '';
    if (signers.length) {
      sel = '<label class="text-muted" style="font-size:12px">Who countersigns</label>' +
        '<select class="form-control" id="sep-rep" style="margin-bottom:6px">' +
        signers.map(function (s) {
          return '<option value="' + s.id + '"' + (Number(s.id) === Number(a.rep_user_id) ? ' selected' : '') + '>' +
            esc(s.name) + (s.title ? (' &mdash; ' + esc(s.title)) : '') + '</option>';
        }).join('') + '</select>';
    }
    return '<div style="margin-bottom:8px">' +
      '<label class="text-muted" style="font-size:12px">Where to email it (their work address is usually off by now)</label>' +
      '<input class="form-control" id="sep-email" value="' + esc(a.employee_email || '') + '" placeholder="personal@email.com" style="margin-bottom:6px" />' +
      '<label class="text-muted" style="font-size:12px">Final check date</label>' +
      '<input class="form-control" type="date" id="sep-final" value="' + esc(String(a.final_check_date || '').slice(0, 10)) + '" style="margin-bottom:6px" />' +
      '<label class="text-muted" style="font-size:12px">Accrued time off being paid (hours)</label>' +
      '<input class="form-control" type="number" step="0.01" min="0" id="sep-pto" value="' + esc(a.pto_payout_hours == null ? '' : a.pto_payout_hours) + '" style="margin-bottom:6px" />' +
      '<label class="text-muted" style="font-size:12px">Separation pay (leave blank if none)</label>' +
      '<input class="form-control" type="number" step="0.01" min="0" id="sep-sev" value="' + esc(a.severance_amount == null ? '' : a.severance_amount) + '" style="margin-bottom:6px" />' +
      '<label class="text-muted" style="font-size:12px">Property notes / anything still out</label>' +
      '<input class="form-control" id="sep-prop" value="' + esc(a.property_notes || '') + '" placeholder="All returned" style="margin-bottom:6px" />' +
      sel +
      '<details style="margin-bottom:6px"><summary class="text-muted" style="font-size:12px;cursor:pointer">The wording</summary>' +
      '<textarea class="form-control" id="sep-body" rows="8" style="margin-top:6px;font-size:12px">' + esc(a.terms_body || d.default_body || '') + '</textarea>' +
      '<p class="text-muted" style="font-size:11px;margin-top:4px">Edited here for this one person. The company-wide default lives in Settings under separation_body_default.</p>' +
      '</details>' +
      '<button class="btn btn-sm btn-block" id="sep-save">Save the draft</button>' +
    '</div>';
  }

  function sepDraftPayload() {
    var p = {
      employee_email: sepVal('sep-email'),
      final_check_date: sepVal('sep-final') || null,
      pto_payout_hours: sepVal('sep-pto'),
      severance_amount: sepVal('sep-sev'),
      property_notes: sepVal('sep-prop'),
      terms_body: sepVal('sep-body')
    };
    var rep = sepEl('sep-rep');
    if (rep && rep.value) p.rep_user_id = rep.value;
    return p;
  }

  // Save before every action that sends or signs. Without this, a manager who
  // types a personal email address and hits Send straight away sends to the old
  // one, which is the address that no longer works.
  async function sepSaveDraft(a) {
    if (!sepEl('sep-email')) return;
    await api('/api/separation/' + a.id, { method: 'PUT', body: JSON.stringify(sepDraftPayload()) });
  }

  function sepWire(obId, d) {
    var a = d.agreement;

    var start = sepEl('sep-start');
    if (start) start.addEventListener('click', async function () {
      try {
        await api('/api/separation', { method: 'POST', body: JSON.stringify({ offboarding_id: obId }) });
        await sepFill(obId);
      } catch (e) { alert('Error: ' + e.message); }
    });
    if (!a) return;

    var save = sepEl('sep-save');
    if (save) save.addEventListener('click', async function () {
      try { await sepSaveDraft(a); if (typeof showToast === 'function') showToast('Draft saved.', 'success'); }
      catch (e) { alert('Error: ' + e.message); }
    });

    var send = sepEl('sep-send');
    if (send) send.addEventListener('click', async function () {
      try {
        await sepSaveDraft(a);
        await api('/api/separation/' + a.id + '/send', { method: 'POST', body: JSON.stringify({ email: sepVal('sep-email') }) });
        await sepFill(obId);
        if (typeof showToast === 'function') showToast('Sent. They have a signing link.', 'success');
      } catch (e) { alert('Error: ' + e.message); }
    });

    var remind = sepEl('sep-remind');
    if (remind) remind.addEventListener('click', async function () {
      try {
        await api('/api/separation/' + a.id + '/remind', { method: 'POST', body: '{}' });
        if (typeof showToast === 'function') showToast('Reminder sent.', 'success');
      } catch (e) { alert('Error: ' + e.message); }
    });

    var copy = sepEl('sep-copy');
    if (copy) copy.addEventListener('click', function () {
      var box = sepEl('sep-link');
      box.select();
      try { navigator.clipboard.writeText(box.value); } catch (e) { document.execCommand('copy'); }
      if (typeof showToast === 'function') showToast('Link copied.', 'success');
    });

    // In person: the same signature, captured on this device with the manager
    // standing there. The server records who was holding the device.
    var inperson = sepEl('sep-inperson');
    if (inperson) inperson.addEventListener('click', async function () {
      try { await sepSaveDraft(a); } catch (e) { alert('Error: ' + e.message); return; }
      var printed = prompt('Their full name, typed by them:', a.employee_name || '');
      if (!printed) return;
      if (typeof window.novaSigPad !== 'function') { alert('The signature pad did not load. Reload the page and try again.'); return; }
      window.novaSigPad({
        title: 'Hand them the device to sign',
        defaultName: printed,
        onApply: async function (dataUrl) {
          try {
            await api('/api/separation/' + a.id + '/in-person', {
              method: 'POST', body: JSON.stringify({ printed_name: printed, image: dataUrl })
            });
            await sepFill(obId);
          } catch (e) { alert('Error: ' + e.message); }
        }
      });
    });

    var counter = sepEl('sep-countersign');
    if (counter) counter.addEventListener('click', function () {
      if (typeof window.novaSigPad !== 'function') { alert('The signature pad did not load. Reload the page and try again.'); return; }
      window.novaSigPad({
        title: 'Countersign',
        defaultName: a.rep_name || '',
        onApply: async function (dataUrl) {
          try {
            await api('/api/separation/' + a.id + '/rep-sign', { method: 'POST', body: JSON.stringify({ image: dataUrl }) });
            // Countersigning ticks the checklist step, so the whole record is
            // refetched rather than just this card.
            go('offboarding-detail', obId);
          } catch (e) { alert('Error: ' + e.message); }
        }
      });
    });

    var vo = sepEl('sep-void');
    if (vo) vo.addEventListener('click', async function () {
      var why = prompt('Withdraw this agreement. Why?');
      if (why === null) return;
      try {
        await api('/api/separation/' + a.id + '/void', { method: 'POST', body: JSON.stringify({ reason: why }) });
        await sepFill(obId);
      } catch (e) { alert('Error: ' + e.message); }
    });

    var re = sepEl('sep-reopen');
    if (re) re.addEventListener('click', async function () {
      try {
        await api('/api/separation/' + a.id + '/reopen', { method: 'POST', body: '{}' });
        await sepFill(obId);
      } catch (e) { alert('Error: ' + e.message); }
    });

    var dl = sepEl('sep-download');
    if (dl) dl.addEventListener('click', async function () {
      try {
        var r = await api('/api/separation/' + a.id + '/download');
        if (r && r.url) window.open(r.url, '_blank');
      } catch (e) { alert('Error: ' + e.message); }
    });
  }

  async function renderDetailScreen(id, container) {
    const root = host(container);

    try {
      const ob = await api(`/api/offboarding/${id}`);
      const steps = ob.steps || [];
      const events = ob.events || [];

      root.innerHTML = `
        <div class="offboarding-detail ob-page">
          <header class="page-header">
            <div>
              <h1>${ob.name}</h1>
              <div class="meta-chips">
                <span class="chip chip-${ob.type}">${ob.type}</span>
                <span class="chip chip-${ob.status}">${ob.status}</span>
                <span class="chip chip-plain">Last day: ${fmtDate(ob.last_day)}</span>
                <span class="chip chip-plain">Final check: ${ob.final_check_date ? fmtDate(ob.final_check_date) : 'not set'}</span>
                <span class="chip chip-plain">Access ends: ${revokeSummary(ob)}</span>
              </div>
            </div>
            <div class="header-actions">
              ${ob.status === 'draft' ? `<button class="btn btn-primary" id="btn-begin-ob">Begin</button>` : ''}
              ${['draft', 'active', 'pending_finalize'].includes(ob.status) ? `<button class="btn btn-danger" id="btn-cancel-ob">Cancel</button>` : ''}
              ${ob.status === 'pending_finalize' ? `<button class="btn btn-success" id="btn-finalize-ob">Finalize</button>` : ''}
            </div>
          </header>

          <div class="detail-layout ob-detail-layout">
            <div class="steps-panel">
              <h2>Checklist</h2>
              ${['access', 'property', 'payroll', 'knowledge', 'interview', 'comms', 'hr', 'final'].map(cat => {
                const catSteps = steps.filter(s => s.category === cat);
                if (!catSteps.length) return '';
                return `
                  <div class="step-category">
                    <h4 class="category-name">${cat}</h4>
                    ${catSteps.map(s => `
                      <div class="step-item step-${s.status}">
                        <div class="step-header">
                          <span class="step-title">${s.title}</span>
                          ${s.required ? '<span class="badge badge-danger">Required</span>' : ''}
                          ${s.auto_key ? '<span class="badge badge-info">Auto</span>' : ''}
                        </div>
                        <div class="step-controls">
                          ${s.status === 'pending' ? `
                            ${s.auto_key === 'separation_agreement' ? `
                              <span class="text-muted" style="font-size:12px">Ticks itself once both parties sign &mdash; see the Separation Agreement card. Skip it if there is a reason not to have one.</span>
                              <button class="btn btn-sm btn-secondary" data-step-id="${s.id}">Skip</button>
                            ` : s.auto_key ? `
                              <button class="btn btn-sm" data-step-id="${s.id}" data-auto-key="${s.auto_key}">Run</button>
                            ` : `
                              <input type="text" placeholder="Note..." class="step-note" data-step-id="${s.id}" />
                              <button class="btn btn-sm btn-primary" data-step-id="${s.id}">Complete</button>
                              <button class="btn btn-sm btn-secondary" data-step-id="${s.id}">Skip</button>
                            `}
                          ` : `<span class="status-badge">${s.status}</span>`}
                        </div>
                      </div>
                    `).join('')}
                  </div>
                `;
              }).join('')}
            </div>

            <div class="sidebar">
              ${propCardShell()}
              ${sepCardShell()}
              <div class="exit-form-card">
                <h3>Exit Form</h3>
                ${ob.interview ? `
                  <p class="text-muted">Status: <strong>${ob.interview.status}</strong></p>
                  ${ob.interview.token && ob.interview.status !== 'submitted' ? `
                    <input class="form-control" id="exit-link" readonly value="${location.origin}/exit/${ob.interview.token}" style="font-size:12px" />
                    <button class="btn btn-sm btn-block" id="btn-copy-exit-link" style="margin-top:6px">Copy link</button>
                    <button class="btn btn-sm btn-block" id="btn-resend-interview" style="margin-top:6px">Send it again</button>
                  ` : ''}
                  ${ob.interview.status === 'submitted' ? '<p class="text-muted">Answers are in — see Exit Interviews.</p>' : ''}
                ` : `
                  <p class="text-muted">Not sent yet</p>
                  ${contactEmailField(ob)}
                  <button class="btn btn-primary btn-block" id="btn-send-interview">Email it to them</button>
                  <button class="btn btn-sm btn-block" id="btn-sms-interview" style="margin-top:6px">Text it instead</button>
                  <button class="btn btn-sm btn-block" id="btn-link-interview" style="margin-top:6px">Just give me the link</button>
                `}
              </div>

              <div class="activity-feed">
                <h3>Activity</h3>
                <div class="events-list">
                  ${events.length ? events.slice(0, 10).map(e => `
                    <div class="event-item">
                      <small class="text-muted">${new Date(e.created_at).toLocaleString()}</small>
                      <p><strong>${e.kind}</strong></p>
                      ${e.detail ? `<small>${JSON.stringify(e.detail).slice(0, 100)}</small>` : ''}
                    </div>
                  `).join('') : '<p class="text-muted">No events yet</p>'}
                </div>
              </div>
            </div>
          </div>

          ${ob.status === 'pending_finalize' ? `
            <div class="finalize-panel">
              <h3>Ready to Finalize?</h3>
              <p>Check that all required steps are complete before finalizing. This will archive the completion packet.</p>
            </div>
          ` : ''}
        </div>
      `;

      // Wire up step actions
      document.querySelectorAll('[data-step-id]').forEach(btn => {
        if (btn.dataset.autoKey) {
          btn.addEventListener('click', () => runAutomation(id, btn.dataset.stepId, btn.dataset.autoKey));
        } else if (btn.textContent === 'Complete') {
          btn.addEventListener('click', () => completeStep(id, btn.dataset.stepId));
        } else if (btn.textContent === 'Skip') {
          btn.addEventListener('click', () => skipStep(id, btn.dataset.stepId));
        }
      });

      document.getElementById('btn-begin-ob')?.addEventListener('click', () => beginOffboarding(id));
      document.getElementById('btn-cancel-ob')?.addEventListener('click', () => cancelOffboarding(id));
      document.getElementById('btn-finalize-ob')?.addEventListener('click', () => finalizeOffboarding(id));
      document.getElementById('btn-send-interview')?.addEventListener('click', () => sendExitForm(id, 'email'));
      document.getElementById('btn-sms-interview')?.addEventListener('click', () => sendExitForm(id, 'sms'));
      document.getElementById('btn-link-interview')?.addEventListener('click', () => sendExitForm(id, 'link'));
      document.getElementById('btn-resend-interview')?.addEventListener('click', () => sendExitForm(id, 'both'));
      // Drawn last: each does its own fetch and must not hold up the checklist.
      propFill(id);
      sepFill(id);

      document.getElementById('btn-copy-exit-link')?.addEventListener('click', () => {
        const box = document.getElementById('exit-link');
        box.select();
        try { navigator.clipboard.writeText(box.value); } catch (e) { document.execCommand('copy'); }
        if (typeof showToast === 'function') showToast('Link copied.', 'success');
      });
    } catch (err) {
      root.innerHTML = `<div class="error">Error loading offboarding: ${err.message}</div>`;
    }
  }

  async function beginOffboarding(id) {
    try {
      await api(`/api/offboarding/${id}/begin`, { method: 'POST' });
      go('offboarding-detail', id);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function cancelOffboarding(id) {
    const reason = prompt('Reason for cancellation:');
    if (!reason) return;
    try {
      const res = await api(`/api/offboarding/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      // Say what cancelling actually did. The server switches the login back on when
      // offboarding is what turned it off, but shifts and PTO it deleted are gone and
      // only a human can put those back -- so those come back as manual_reversals and
      // the person needs to see them. Before 2026-09-15 this response was thrown away.
      const notes = [];
      if (res && res.reactivated) notes.push('Account switched back on. They will re-verify 2FA on next login.');
      if (res && res.manual_reversals && res.manual_reversals.length) {
        notes.push('Still needs doing by hand:');
        res.manual_reversals.forEach(function (m) { notes.push('  - ' + m); });
      }
      if (notes.length) alert('Offboarding cancelled.\n\n' + notes.join('\n'));
      go('offboarding');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function completeStep(id, stepId) {
    const note = document.querySelector(`[data-step-id="${stepId}"]`).value;
    try {
      await api(`/api/offboarding/${id}/steps/${stepId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ note })
      });
      go('offboarding-detail', id);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function skipStep(id, stepId) {
    const reason = prompt('Why skip this step?');
    if (!reason) return;
    try {
      await api(`/api/offboarding/${id}/steps/${stepId}/skip`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
      go('offboarding-detail', id);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function runAutomation(id, stepId, autoKey) {
    try {
      await api(`/api/offboarding/${id}/run/${autoKey}`, { method: 'POST' });
      go('offboarding-detail', id);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function finalizeOffboarding(id) {
    if (!confirm('Finalize this offboarding? This action is final.')) return;
    try {
      await api(`/api/offboarding/${id}/finalize`, { method: 'POST' });
      go('offboarding');
    } catch (err) {
      // The server names the steps that are still open -- show them, not just
      // 'Required steps incomplete'.
      let msg = err.message;
      try {
        const parsed = JSON.parse(err.rawBody || '{}');
        if (parsed.blockers && parsed.blockers.length) {
          msg = 'Still open:\n\n• ' + parsed.blockers.join('\n• ');
        }
      } catch (e) {}
      alert(msg);
    }
  }

  // channel: 'email' | 'sms' | 'both' | 'link'. Until 2026-09-15 this module
  // could only mint a link and the manager pasted it somewhere by hand.
  async function sendExitForm(id, channel) {
    try {
      const box = document.getElementById('ob-contact-email');
      const res = await api(`/api/offboarding/${id}/interview`, {
        method: 'POST',
        body: JSON.stringify({
          mode: 'self_serve',
          channel: channel || 'link',
          contact_email: box ? box.value.trim() : undefined
        })
      });
      // Say what actually happened rather than assuming it worked: an address
      // that was never captured is the commonest reason nothing arrives.
      const dv = res && res.delivery;
      if (dv) {
        const went = [];
        if (dv.email) went.push('emailed');
        if (dv.sms) went.push('texted');
        if (went.length && typeof showToast === 'function') showToast('Exit form ' + went.join(' and ') + '.', 'success');
        if (!went.length) alert((dv.errors || ['Nothing was sent.']).join('\n') + '\n\nThe link is on the card either way.');
      }

      go('offboarding-detail', id);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function renderExitInterviewsScreen(container) {
    const root = host(container);
    try {
      const responses = await api('/api/exit-interviews');
      const insights = await api('/api/exit-interviews/insights');

      root.innerHTML = `
        <div class="exit-interviews-screen ob-page">
          <header class="page-header">
            <h1>Exit Interview Responses</h1>
            <p class="text-muted">Only Ben and Tony can view this. It won't affect final checks or references.</p>
          </header>

          <div class="tabs">
            <button class="tab-btn active" data-tab="responses">Responses (${responses.length})</button>
            <button class="tab-btn" data-tab="insights">Insights</button>
          </div>

          <div class="tab-content" id="responses">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Tenure</th>
                  <th>Reason</th>
                  <th>Would Return</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                ${responses.map(r => `
                  <tr>
                    <td>${r.name}</td>
                    <td>${roleLabel(r.role)}</td>
                    <td>${tenure(r.hire_date, r.last_day)}</td>
                    <td>${(r.reason_category || '—').replace(/-/g, ' ')}</td>
                    <td>${r.would_return || '—'}</td>
                    <td>${r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div class="tab-content" id="insights" style="display: none;">
            <div class="insights-grid">
              <div class="card">
                <h4>Total Finalized</h4>
                <p class="big-number">${insights.total_finalized}</p>
              </div>
              <div class="card">
                <h4>By Role</h4>
                <ul>
                  ${insights.departures_by_role?.length ? insights.departures_by_role.map(r => `<li>${roleLabel(r.role)}: ${r.count}</li>`).join('') : '<li class="text-muted">Nothing yet</li>'}
                </ul>
              </div>
              <div class="card">
                <h4>Would Return</h4>
                <ul>
                  ${insights.would_return_trend?.length ? insights.would_return_trend.map(r => `<li>${r.would_return || 'no answer'}: ${r.count}</li>`).join('') : '<li class="text-muted">No answers yet</li>'}
                </ul>
              </div>
              <div class="card">
                <h4>By Tenure</h4>
                <ul>
                  ${insights.departures_by_tenure?.length ? insights.departures_by_tenure.map(r => `<li>${r.tenure_band}: ${r.count}</li>`).join('') : '<li class="text-muted">Nothing yet</li>'}
                </ul>
              </div>
              <div class="card">
                <h4>Reasons Given</h4>
                <ul>
                  ${insights.reasons?.length ? insights.reasons.map(r => `<li>${(r.reason_category || '').replace(/-/g, ' ')}: ${r.count}</li>`).join('') : '<li class="text-muted">Nothing yet</li>'}
                </ul>
              </div>
            </div>
          </div>
        </div>
      `;

      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
          e.target.classList.add('active');
          document.getElementById(e.target.dataset.tab).style.display = 'block';
        });
      });
    } catch (err) {
      root.innerHTML = `<div class="error">Error loading responses: ${err.message}</div>`;
    }
  }


  // =========================================================================
  // Setup: the checklist and the exit form questions.
  //
  // Checklist steps are one flat list; each step names the roles it applies to
  // (none ticked = everybody), which is the same shape as onboarding_steps.roles.
  // Editing here NEVER changes an offboarding that is already running - live
  // steps are a frozen copy taken when the record is created.
  // =========================================================================
  const ROLE_KEYS = ['roadside_technician', 'locksmith', 'locksmith_coordinator', 'dispatcher', 'manager', 'admin'];
  const DEPARTURE_TYPES = ['voluntary', 'involuntary', 'job_abandonment', 'retirement', 'end_of_contract', 'other'];
  const AUTO_LABELS = {
    deactivate_user: 'Switch the account off',
    clear_future_shifts: 'Clear shifts after the last day',
    cancel_future_pto: 'Decline pending time off',
    vault_sweep: 'Vault membership + rotation list',
    timeclock_final_check: 'Flag open punches / unapproved weeks',
    pto_payout_note: 'Snapshot the PTO balance',
    reassign_open_tasks: 'Move open tasks to their supervisor',
    completion_packet: 'Build the completion packet',
    // Not an automation: the step is satisfied by a signed separation agreement,
    // which routes/separation.js ticks off. Listed so the step editor names it.
    separation_agreement: 'Signed separation agreement'
  };
  const CATEGORY_LABELS = {
    access: 'Access', property: 'Property', payroll: 'Payroll', knowledge: 'Knowledge',
    interview: 'Exit form', comms: 'Communications', hr: 'HR', final: 'Final'
  };
  let setupTab = 'checklist';
  let editingStep = null;   // step id, or 'new'
  let editingQ = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function roleWord(r) { return roleLabel(r); }

  async function renderSetupScreen(container) {
    const root = host(container);
    try {
      const [stepData, questions] = await Promise.all([
        api('/api/offboarding/template-steps'),
        api('/api/offboarding/questions')
      ]);

      root.innerHTML = `
        <div class="offboarding-setup ob-page">
          <header class="page-header">
            <h1>Offboarding Setup</h1>
            <div class="header-actions">
              <button class="btn btn-secondary" onclick="navigate('offboarding')">Back to Offboarding</button>
            </div>
          </header>

          <div class="tabs">
            <button class="tab-btn ${setupTab === 'checklist' ? 'active' : ''}" id="tab-checklist">Checklist (${stepData.steps.length})</button>
            <button class="tab-btn ${setupTab === 'questions' ? 'active' : ''}" id="tab-questions">Exit form questions (${questions.filter(q => q.active).length})</button>
          </div>

          <div id="setup-body"></div>
        </div>
      `;

      document.getElementById('tab-checklist').addEventListener('click', () => { setupTab = 'checklist'; editingQ = null; renderSetupScreen(root); });
      document.getElementById('tab-questions').addEventListener('click', () => { setupTab = 'questions'; editingStep = null; renderSetupScreen(root); });

      if (setupTab === 'checklist') drawChecklistTab(root, stepData);
      else drawQuestionsTab(root, questions);
    } catch (err) {
      root.innerHTML = `<div class="alert alert-error">Could not load setup: ${esc(err.message)}</div>`;
    }
  }

  function drawChecklistTab(root, data) {
    const steps = data.steps || [];
    const body = document.getElementById('setup-body');
    body.innerHTML = `
      <p class="text-muted setup-note">One list for everybody. A step with roles on it only appears for those roles; a step with none appears for everyone. Changes apply to offboardings you start from now on, never to one already running.</p>
      <div class="setup-toolbar"><button class="btn btn-primary btn-sm" id="btn-add-step">Add step</button></div>
      <div id="step-editor"></div>
      <div class="setup-list">
        ${steps.map((st, i) => `
          <div class="setup-row" data-step-row="${st.id}">
            <div class="setup-order">
              <button class="btn btn-ghost btn-xs" data-move="up" data-id="${st.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">&#9650;</button>
              <button class="btn btn-ghost btn-xs" data-move="down" data-id="${st.id}" ${i === steps.length - 1 ? 'disabled' : ''} aria-label="Move down">&#9660;</button>
            </div>
            <div class="setup-main">
              <div class="setup-title">${esc(st.title)}</div>
              <div class="setup-meta">
                <span class="chip">${CATEGORY_LABELS[st.category] || st.category}</span>
                ${st.required ? '<span class="badge badge-danger">Required</span>' : '<span class="chip">Optional</span>'}
                ${st.auto_key ? `<span class="badge badge-info">${esc(AUTO_LABELS[st.auto_key] || st.auto_key)}</span>` : ''}
                ${st.wants_evidence ? '<span class="chip">Wants evidence</span>' : ''}
                ${(st.roles && st.roles.length)
                  ? st.roles.map(r => `<span class="chip chip-role">${esc(roleWord(r))}</span>`).join('')
                  : '<span class="chip chip-all">Everyone</span>'}
                ${(st.applies_to && st.applies_to.length) ? st.applies_to.map(t => `<span class="chip">${esc(prettify(t))} only</span>`).join('') : ''}
              </div>
            </div>
            <div class="setup-actions">
              <button class="btn btn-sm" data-edit-step="${st.id}">Edit</button>
              <button class="btn btn-sm btn-secondary" data-del-step="${st.id}">Remove</button>
            </div>
          </div>
        `).join('') || '<p class="text-muted">No steps yet. Add the first one.</p>'}
      </div>
    `;

    document.getElementById('btn-add-step').addEventListener('click', () => { editingStep = 'new'; drawStepForm(root, null); });
    body.querySelectorAll('[data-edit-step]').forEach(b => b.addEventListener('click', () => {
      editingStep = b.dataset.editStep;
      drawStepForm(root, steps.find(x => String(x.id) === String(editingStep)));
    }));
    body.querySelectorAll('[data-del-step]').forEach(b => b.addEventListener('click', async () => {
      const st = steps.find(x => String(x.id) === String(b.dataset.delStep));
      if (!confirm('Remove "' + st.title + '" from the checklist? Offboardings already running keep it.')) return;
      await api('/api/offboarding/template-steps/' + st.id, { method: 'DELETE' });
      renderSetupScreen(root);
    }));
    body.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', async () => {
      const ids = steps.map(x => x.id);
      const idx = ids.indexOf(parseInt(b.dataset.id, 10));
      const to = b.dataset.move === 'up' ? idx - 1 : idx + 1;
      if (to < 0 || to >= ids.length) return;
      ids.splice(to, 0, ids.splice(idx, 1)[0]);
      await api('/api/offboarding/template-steps/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
      renderSetupScreen(root);
    }));
  }

  function drawStepForm(root, st) {
    const editor = document.getElementById('step-editor');
    const s = st || { title: '', category: 'access', required: true, wants_evidence: false, auto_key: null, roles: null, applies_to: null, description: '' };
    editor.innerHTML = `
      <div class="setup-editor">
        <h3>${st ? 'Edit step' : 'New step'}</h3>
        <div class="form-group"><label>Step</label>
          <input type="text" id="st-title" class="form-control" value="${esc(s.title)}" placeholder="e.g. Collect fuel card" /></div>
        <div class="form-group"><label>Note for whoever does it (optional)</label>
          <input type="text" id="st-desc" class="form-control" value="${esc(s.description || '')}" /></div>
        <div class="setup-grid">
          <div class="form-group"><label>Group</label>
            <select id="st-cat" class="form-control">
              ${(data_categories()).map(c => `<option value="${c}" ${s.category === c ? 'selected' : ''}>${CATEGORY_LABELS[c] || c}</option>`).join('')}
            </select></div>
          <div class="form-group"><label>Automation</label>
            <select id="st-auto" class="form-control">
              <option value="">None - somebody ticks it by hand</option>
              ${Object.keys(AUTO_LABELS).map(k => `<option value="${k}" ${s.auto_key === k ? 'selected' : ''}>${AUTO_LABELS[k]}</option>`).join('')}
            </select></div>
        </div>
        <div class="form-group"><label>Who gets this step</label>
          <div class="checkbox-group">
            ${ROLE_KEYS.map(r => `<label><input type="checkbox" class="st-role" value="${r}" ${(s.roles || []).indexOf(r) > -1 ? 'checked' : ''} /> ${esc(roleWord(r))}</label>`).join('')}
          </div>
          <small class="text-muted">Tick nothing for everybody.</small>
        </div>
        <div class="form-group"><label>Only on these departures</label>
          <div class="checkbox-group">
            ${DEPARTURE_TYPES.map(t => `<label><input type="checkbox" class="st-type" value="${t}" ${(s.applies_to || []).indexOf(t) > -1 ? 'checked' : ''} /> ${prettify(t)}</label>`).join('')}
          </div>
          <small class="text-muted">Tick nothing for every kind of departure.</small>
        </div>
        <div class="checkbox-group">
          <label><input type="checkbox" id="st-req" ${s.required ? 'checked' : ''} /> Required - blocks Finalize until it is done or skipped</label>
          <label><input type="checkbox" id="st-eviq" ${s.wants_evidence ? 'checked' : ''} /> Ask for a note or photo as proof</label>
        </div>
        <div id="st-error" class="text-muted" style="display:none;color:#f87171;font-size:13px;margin-bottom:10px"></div>
        <div class="wizard-buttons">
          <button class="btn btn-primary" id="st-save">${st ? 'Save step' : 'Add step'}</button>
          <button class="btn btn-secondary" id="st-cancel">Cancel</button>
        </div>
      </div>
    `;
    editor.scrollIntoView({ block: 'nearest' });
    document.getElementById('st-cancel').addEventListener('click', () => { editingStep = null; editor.innerHTML = ''; });
    document.getElementById('st-save').addEventListener('click', async () => {
      const payload = {
        title: document.getElementById('st-title').value,
        description: document.getElementById('st-desc').value || null,
        category: document.getElementById('st-cat').value,
        auto_key: document.getElementById('st-auto').value || null,
        required: document.getElementById('st-req').checked,
        wants_evidence: document.getElementById('st-eviq').checked,
        roles: Array.from(document.querySelectorAll('.st-role:checked')).map(c => c.value),
        applies_to: Array.from(document.querySelectorAll('.st-type:checked')).map(c => c.value)
      };
      try {
        if (st) await api('/api/offboarding/template-steps/' + st.id, { method: 'PATCH', body: JSON.stringify(payload) });
        else await api('/api/offboarding/template-steps', { method: 'POST', body: JSON.stringify(payload) });
        editingStep = null;
        renderSetupScreen(root);
      } catch (e) {
        const box = document.getElementById('st-error');
        box.style.display = 'block'; box.textContent = e.message;
      }
    });
  }

  function data_categories() { return ['access', 'property', 'payroll', 'knowledge', 'interview', 'comms', 'hr', 'final']; }

  function drawQuestionsTab(root, questions) {
    const live = questions.filter(q => q.active);
    const retired = questions.filter(q => !q.active);
    const body = document.getElementById('setup-body');
    const row = (q) => `
      <div class="setup-row ${q.active ? '' : 'setup-row-off'}">
        <div class="setup-order">
          ${q.active ? `
            <button class="btn btn-ghost btn-xs" data-qmove="up" data-id="${q.id}" aria-label="Move up">&#9650;</button>
            <button class="btn btn-ghost btn-xs" data-qmove="down" data-id="${q.id}" aria-label="Move down">&#9660;</button>` : ''}
        </div>
        <div class="setup-main">
          <div class="setup-title">${esc(q.prompt)}</div>
          <div class="setup-meta">
            <span class="chip">${q.qtype === 'text' ? 'Free text' : q.qtype === 'select' ? 'Dropdown' : 'Pick one'}</span>
            ${q.required ? '<span class="badge badge-danger">Required</span>' : '<span class="chip">Optional</span>'}
            ${q.question_key === 'would_return' ? '<span class="badge badge-info">Feeds Would Return</span>' : ''}
            ${q.question_key === 'reason' ? '<span class="badge badge-info">Feeds Reasons</span>' : ''}
            ${!q.active ? '<span class="chip">Retired</span>' : ''}
          </div>
          ${(q.options && q.options.options) ? `<div class="setup-answers">${q.options.options.map(o => `<span class="chip chip-answer">${esc(o)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="setup-actions">
          <button class="btn btn-sm" data-edit-q="${q.id}">Edit</button>
          ${q.active ? `<button class="btn btn-sm btn-secondary" data-del-q="${q.id}">Retire</button>` : ''}
        </div>
      </div>`;

    body.innerHTML = `
      <p class="text-muted setup-note">These are the questions on the exit form. Two of them feed the Insights tiles - reword them freely, the wiring follows the question, not the words. Retiring a question keeps every answer already given.</p>
      <div class="setup-toolbar"><button class="btn btn-primary btn-sm" id="btn-add-q">Add question</button></div>
      <div id="q-editor"></div>
      <div class="setup-list">${live.map(row).join('') || '<p class="text-muted">No questions yet.</p>'}</div>
      ${retired.length ? `<h3 class="setup-subhead">Retired</h3><div class="setup-list">${retired.map(row).join('')}</div>` : ''}
    `;

    document.getElementById('btn-add-q').addEventListener('click', () => { editingQ = 'new'; drawQuestionForm(root, null); });
    body.querySelectorAll('[data-edit-q]').forEach(b => b.addEventListener('click', () => {
      drawQuestionForm(root, questions.find(x => String(x.id) === String(b.dataset.editQ)));
    }));
    body.querySelectorAll('[data-del-q]').forEach(b => b.addEventListener('click', async () => {
      const q = questions.find(x => String(x.id) === String(b.dataset.delQ));
      const tile = q.question_key === 'would_return' ? 'Would Return' : q.question_key === 'reason' ? 'Reasons' : null;
      const warn = tile ? '\n\nThis is the question the ' + tile + ' tile on Insights reads. Point another question at that tile first, or the tile stops filling in.' : '';
      if (!confirm('Take "' + q.prompt + '" off the form? Answers already given stay.' + warn)) return;
      await api('/api/offboarding/questions/' + q.id, { method: 'DELETE' });
      renderSetupScreen(root);
    }));
    body.querySelectorAll('[data-qmove]').forEach(b => b.addEventListener('click', async () => {
      const ids = live.map(x => x.id);
      const idx = ids.indexOf(parseInt(b.dataset.id, 10));
      const to = b.dataset.qmove === 'up' ? idx - 1 : idx + 1;
      if (to < 0 || to >= ids.length) return;
      ids.splice(to, 0, ids.splice(idx, 1)[0]);
      await api('/api/offboarding/questions/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
      renderSetupScreen(root);
    }));
  }

  function drawQuestionForm(root, q) {
    const editor = document.getElementById('q-editor');
    const d = q || { prompt: '', qtype: 'radio', options: { options: ['', ''] }, required: true, question_key: null, active: true };
    const opts = (d.options && d.options.options) || [];
    editor.innerHTML = `
      <div class="setup-editor">
        <h3>${q ? 'Edit question' : 'New question'}</h3>
        <div class="form-group"><label>Question</label>
          <input type="text" id="q-prompt" class="form-control" value="${esc(d.prompt)}" placeholder="e.g. Did you feel the schedule was fair?" /></div>
        <div class="setup-grid">
          <div class="form-group"><label>Answer style</label>
            <select id="q-type" class="form-control">
              <option value="radio" ${d.qtype === 'radio' ? 'selected' : ''}>Pick one (buttons)</option>
              <option value="select" ${d.qtype === 'select' ? 'selected' : ''}>Pick one (dropdown)</option>
              <option value="text" ${d.qtype === 'text' ? 'selected' : ''}>Free text</option>
            </select></div>
          <div class="form-group"><label>Feeds an Insights tile</label>
            <select id="q-key" class="form-control">
              <option value="" ${!d.question_key ? 'selected' : ''}>No</option>
              <option value="would_return" ${d.question_key === 'would_return' ? 'selected' : ''}>Would Return</option>
              <option value="reason" ${d.question_key === 'reason' ? 'selected' : ''}>Reason for leaving</option>
            </select></div>
        </div>
        <div class="form-group" id="q-answers-wrap">
          <label>Answers</label>
          <div id="q-answers">${opts.map(o => answerRow(o)).join('') || answerRow('') + answerRow('')}</div>
          <button class="btn btn-sm btn-secondary" id="q-add-answer" type="button">Add answer</button>
        </div>
        <div class="checkbox-group">
          <label><input type="checkbox" id="q-req" ${d.required ? 'checked' : ''} /> Required - they cannot send the form without it</label>
        </div>
        <div id="q-error" style="display:none;color:#f87171;font-size:13px;margin-bottom:10px"></div>
        <div class="wizard-buttons">
          <button class="btn btn-primary" id="q-save">${q ? 'Save question' : 'Add question'}</button>
          <button class="btn btn-secondary" id="q-cancel">Cancel</button>
        </div>
      </div>
    `;
    editor.scrollIntoView({ block: 'nearest' });

    const syncType = () => {
      document.getElementById('q-answers-wrap').style.display =
        document.getElementById('q-type').value === 'text' ? 'none' : '';
    };
    syncType();
    document.getElementById('q-type').addEventListener('change', syncType);
    document.getElementById('q-add-answer').addEventListener('click', () => {
      document.getElementById('q-answers').insertAdjacentHTML('beforeend', answerRow(''));
      wireAnswerRows();
    });
    wireAnswerRows();
    document.getElementById('q-cancel').addEventListener('click', () => { editingQ = null; editor.innerHTML = ''; });
    document.getElementById('q-save').addEventListener('click', async () => {
      const qtype = document.getElementById('q-type').value;
      const answers = Array.from(document.querySelectorAll('.q-answer')).map(i => i.value.trim()).filter(Boolean);
      const payload = {
        prompt: document.getElementById('q-prompt').value,
        qtype: qtype,
        options: qtype === 'text' ? null : { options: answers },
        required: document.getElementById('q-req').checked,
        question_key: document.getElementById('q-key').value || null
      };
      try {
        if (q) await api('/api/offboarding/questions/' + q.id, { method: 'PATCH', body: JSON.stringify(payload) });
        else await api('/api/offboarding/questions', { method: 'POST', body: JSON.stringify(payload) });
        editingQ = null;
        renderSetupScreen(root);
      } catch (e) {
        const box = document.getElementById('q-error');
        box.style.display = 'block'; box.textContent = e.message;
      }
    });
  }

  function answerRow(value) {
    return '<div class="q-answer-row"><input type="text" class="form-control q-answer" value="' + esc(value) + '" placeholder="Answer" />' +
      '<button type="button" class="btn btn-sm btn-secondary q-answer-del" aria-label="Remove answer">&times;</button></div>';
  }
  function wireAnswerRows() {
    document.querySelectorAll('.q-answer-del').forEach(b => {
      b.onclick = () => { const rows = document.querySelectorAll('.q-answer-row'); if (rows.length > 1) b.parentElement.remove(); };
    });
  }

  function todayStr() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  // A yyyy-mm-dd string is parsed as UTC midnight, which prints as the day before in
  // every US timezone. Read the parts instead.
  function fmtDate(v) {
    if (!v) return '\u2014';
    const p = String(v).slice(0, 10).split('-');
    return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString() : new Date(v).toLocaleDateString();
  }
  function revokeSummary(ob) {
    if (ob.deactivate_mode === 'immediate') return 'The moment you press Begin';
    if (ob.deactivate_mode === 'on_finalize') return 'When you finalize the record';
    const d = ob.access_revoke_date || ob.last_day;
    return fmtDate(d) + (String(d).slice(0, 10) === String(ob.last_day).slice(0, 10) ? ' (their last day)' : '');
  }

  // 'end_of_last_day' -> 'End of last day'. String.replace with a plain string only
  // swaps the FIRST match, which is how 'end of_last_day' used to reach the screen.
  function prettify(v) {
    const t = String(v || '').replace(/_/g, ' ');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }

  // Whole months between hire and last day, rendered the way people say it.
  function tenure(hire, last) {
    if (!hire) return '—';
    const a = new Date(hire), b = last ? new Date(last) : new Date();
    const months = Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
    if (months < 12) return months + ' mo';
    const y = Math.floor(months / 12), m = months % 12;
    return y + ' yr' + (m ? ' ' + m + ' mo' : '');
  }

  const ROLE_LABELS = {
    locksmith: 'Locksmith',
    locksmith_coordinator: 'Locksmith Coordinator',
    dispatcher: 'Dispatcher',
    roadside_technician: 'Roadside Technician',
    manager: 'Manager',
    admin: 'Admin',
    owner: 'Owner'
  };
  // Map a role key (returned by the list + /eligible endpoints) to a label.
  function roleLabel(role) {
    return ROLE_LABELS[role] || (role || '—');
  }

  return {
    renderListScreen,
    renderStartWizard,
    renderSetupScreen,
    renderDetailScreen,
    renderPropertyScreen,
    renderExitInterviewsScreen
  };
})();

// app.js routes to these; nothing self-starts on page load.
window.offboarding = offboarding;
function renderOffboardingList(content) { return offboarding.renderListScreen(content); }
function renderOffboardingDetail(content, id) { return offboarding.renderDetailScreen(id, content); }
function renderOffboardingStart(content) { return offboarding.renderStartWizard(content); }
function renderExitInterviews(content) { return offboarding.renderExitInterviewsScreen(content); }
function renderOffboardingSetup(content) { return offboarding.renderSetupScreen(content); }
function renderOffboardingProperty(content, id) { return offboarding.renderPropertyScreen(id, content); }

// ---------------------------------------------------------------------------
// Public exit form -- /exit/<token>. No login: the whole session is the token in
// the URL, exactly like /sign, /quote and /release. app.get('*') already serves
// this page, so there is no server route for the path itself.
// ---------------------------------------------------------------------------
function obGetExitToken() {
  try {
    var m = (location.pathname || '').match(/^\/exit\/([a-f0-9]{64})/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function obExitShell(inner) {
  return '<div style="flex:1;width:100%;min-height:100vh;background:var(--bg)">' +
    '<div style="background:#14171c;padding:13px 18px;display:flex;align-items:center;gap:9px">' +
      '<span style="width:24px;height:24px;border-radius:6px;background:#f97316;display:grid;place-items:center;font-size:12px">&#128274;</span>' +
      '<span style="font-weight:700;font-size:15px;color:#fff">Lock and Roll LLC</span>' +
    '</div>' +
    '<div style="max-width:640px;margin:0 auto;padding:28px 18px 60px">' + inner + '</div>' +
  '</div>';
}

async function renderExitFormPage(app, token) {
  app.className = 'no-sidebar';
  app.innerHTML = obExitShell('<div class="loading">Loading…</div>');

  var data;
  try {
    var res = await fetch('/api/offboarding/exit/' + token);
    if (!res.ok) throw new Error((await res.json()).error || 'This link is no longer valid.');
    data = await res.json();
  } catch (e) {
    app.innerHTML = obExitShell(
      '<h2 style="margin:0 0 8px">This link has expired</h2>' +
      '<p style="color:var(--text-muted-color)">' + escHtml(e.message) + ' If you still want to tell us something, reply to the email this link came from.</p>');
    return;
  }

  if (data.interview.status === 'submitted') {
    app.innerHTML = obExitShell(
      '<h2 style="margin:0 0 8px">Thanks &mdash; we got it</h2>' +
      '<p style="color:var(--text-muted-color)">Your answers are in. Nothing else to do.</p>');
    return;
  }

  // Which questions are required is set per question in Offboarding -> Setup.
  var qs = data.questions || [];
  var body = qs.map(function (q) {
    var required = !!q.required;
    var opts = (q.options && q.options.options) || [];
    var field;
    if (q.qtype === 'radio') {
      field = opts.map(function (o) {
        return '<label style="display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:7px;cursor:pointer">' +
          '<input type="radio" name="q' + q.id + '" value="' + escHtml(o) + '" /> ' + escHtml(o) + '</label>';
      }).join('');
    } else if (q.qtype === 'select') {
      field = '<select class="form-control" name="q' + q.id + '"><option value="">Choose one…</option>' +
        opts.map(function (o) { return '<option value="' + escHtml(o) + '">' + escHtml(o) + '</option>'; }).join('') + '</select>';
    } else {
      field = '<textarea class="form-control" name="q' + q.id + '" rows="4" placeholder="Type as much or as little as you want…"></textarea>';
    }
    return '<div class="form-group" data-qid="' + q.id + '" data-required="' + (required ? '1' : '0') + '" style="margin-bottom:22px">' +
      '<label style="display:block;font-weight:600;margin-bottom:9px">' + escHtml(q.prompt) +
        (required ? '' : ' <span style="font-weight:400;color:var(--text-muted-color)">(optional)</span>') + '</label>' +
      field + '</div>';
  }).join('');

  app.innerHTML = obExitShell(
    '<h2 style="margin:0 0 6px">Before you go</h2>' +
    '<p style="margin:0 0 4px;color:var(--text-muted-color)">Five questions. It takes about two minutes.</p>' +
    '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:16px 0 24px;font-size:13px">' +
      'Only Ben and Tony read this. It won&#39;t affect your final check or your references.' +
    '</div>' +
    '<form id="exit-form">' + body +
      '<div id="exit-error" style="display:none;color:#f87171;margin-bottom:12px;font-size:13px"></div>' +
      '<button type="submit" class="btn btn-primary" id="exit-submit">Send it</button>' +
    '</form>');

  document.getElementById('exit-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var answers = [];
    var missing = 0;
    document.querySelectorAll('[data-qid]').forEach(function (group) {
      var qid = parseInt(group.dataset.qid, 10);
      var q = qs.find(function (x) { return x.id === qid; });
      var el = group.querySelector('select, textarea');
      var value = el ? el.value.trim() : '';
      if (!el) {
        var picked = group.querySelector('input[type="radio"]:checked');
        value = picked ? picked.value : '';
      }
      if (!value) { if (group.dataset.required === '1') missing++; return; }
      answers.push({ question_id: qid, question_snapshot: { prompt: q.prompt, qtype: q.qtype }, value_text: value, value_num: null });
    });
    var err = document.getElementById('exit-error');
    if (missing) {
      err.style.display = 'block';
      err.textContent = missing === 1 ? 'One question still needs an answer.' : 'There are ' + missing + ' questions still to answer.';
      return;
    }
    err.style.display = 'none';
    var btn = document.getElementById('exit-submit');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      var r = await fetch('/api/offboarding/exit/' + token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: answers, submit: true })
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Could not send.');
      app.innerHTML = obExitShell(
        '<h2 style="margin:0 0 8px">Thanks &mdash; we got it</h2>' +
        '<p style="color:var(--text-muted-color)">Your answers are in. Nothing else to do.</p>');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Send it';
      err.style.display = 'block'; err.textContent = e.message;
    }
  });
}

// ---------------------------------------------------------------------------
// Public separation agreement -- /separation/<token>. No login: the whole
// session is the token in the URL, exactly like /exit, /sign, /quote and
// /release. app.get('*') already serves this page, so there is no server route
// for the path itself.
//
// This one carries more weight than the exit form above it. By the time the
// link is opened the person's Nova account is normally switched off, so this
// page is the only way they can reach anything of ours, and what they sign here
// becomes a PDF that both sides keep. It shows the document in full, on the
// page, before anything is signed -- never a "click to agree" summary.
// ---------------------------------------------------------------------------
function obGetSepToken() {
  try {
    var m = (location.pathname || '').match(/^\/separation\/([a-f0-9]{64})/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

var _sepPubToken = null, _sepPubDoc = null, _sepPubSig = null;

async function sepPubFetch(path, method, body) {
  var opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  var res = await fetch('/api/sep/' + path, opts);
  var data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
  return data || {};
}

function sepPubMoney(n) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function sepPubDate(v) {
  if (!v) return '—';
  var p = String(v).slice(0, 10).split('-');
  return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString() : new Date(v).toLocaleDateString();
}

function sepPubHours(h) {
  var v = Number(h);
  if (!isFinite(v) || v <= 0) return 'None';
  var days = Math.round((v / 8) * 100) / 100;
  return (Math.round(v * 100) / 100) + ' hours (' + days + ' day' + (days === 1 ? '' : 's') + ')';
}

function sepPubRow(label, value) {
  return '<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">' +
    '<div style="flex:1;font-size:12.5px;color:var(--text-muted-color)">' + escHtml(label) + '</div>' +
    '<div style="flex:1;font-size:13px;font-weight:600;text-align:right">' + escHtml(value) + '</div>' +
  '</div>';
}

// The wording is authored as plain text with blank lines between paragraphs. It
// is escaped and then split on blank lines -- never injected as HTML, because
// it is editable in Settings and on the record, and neither is a place that
// should be able to put markup on a page.
function sepPubBody(text) {
  return String(text || '').split(/\n\s*\n/).map(function (p) {
    return '<p style="margin:0 0 11px;font-size:13px;line-height:1.65;color:var(--text-dim)">' +
      escHtml(p).replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

// The property list, as the person signing sees it. What each item was and
// whether it came back - and nothing about where it went afterwards, because
// which shelf a returned tool landed on is not their business. Value appears
// only against what did not come back, which is the part they are agreeing to.
var SEP_PUB_OUTCOME = {
  returned: ['Returned', '#22c55e'], not_returned: ['Not returned', '#f87171'],
  lost: ['Lost', '#f87171'], stolen: ['Stolen', '#f87171'], kept: ['Kept by agreement', '#fbbf24']
};

function sepPubProperty(a) {
  var rows = a.property || [];
  if (!rows.length) {
    if (!a.nothing_to_return) return '';
    return '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:16px">' +
      '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted-color);font-weight:600;margin-bottom:8px">Property received</div>' +
      '<p style="margin:0;font-size:13px;color:var(--text-dim)">You held no company property to return.</p></div>';
  }
  var t = a.property_totals || {};
  var head = 'Property received' + (a.property_recorded_at
    ? (' \u2014 recorded ' + sepPubDate(a.property_recorded_at)) : '');
  var body = rows.map(function (r) {
    var o = SEP_PUB_OUTCOME[r.outcome] || [r.outcome, 'var(--text-dim)'];
    var sub = [];
    if (r.serial_number) sub.push(escHtml(r.serial_number));
    if (r.qty > 1) sub.push('Qty ' + r.qty);
    if (r.note) sub.push(escHtml(r.note));
    if (r.value != null) sub.push(sepPubMoney(r.value));
    return '<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);align-items:flex-start">' +
      '<div style="flex:1;font-size:13px">' + escHtml(r.label) +
        (sub.length ? ('<small style="display:block;color:var(--text-muted-color);font-size:11.5px">' + sub.join(' &middot; ') + '</small>') : '') +
      '</div>' +
      '<div style="flex:none;font-size:12px;font-weight:600;color:' + o[1] + '">' + escHtml(o[0]) + '</div>' +
    '</div>';
  }).join('');
  var foot = t.not_returned
    ? ('<div style="display:flex;gap:10px;border-top:1px solid var(--border);margin-top:6px;padding-top:10px">' +
       '<div style="flex:1;font-size:12.5px;color:var(--text-muted-color)">Not returned</div>' +
       '<div style="flex:1;font-size:13px;font-weight:600;text-align:right;color:#f87171">' +
       t.not_returned + ' item' + (t.not_returned === 1 ? '' : 's') + ' &middot; ' + sepPubMoney(t.value_not_returned) + '</div></div>')
    : '';
  return '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:16px">' +
    '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted-color);font-weight:600;margin-bottom:8px">' +
    escHtml(head) + '</div>' + body + foot +
    '<p style="margin:10px 0 0;font-size:11.5px;color:var(--text-muted-color)">If any of this is wrong, say so before you sign &mdash; there is a button for that below.</p>' +
  '</div>';
}

async function renderSeparationPage(app, token) {
  app.className = 'no-sidebar';
  _sepPubToken = token; _sepPubSig = null;
  app.innerHTML = obExitShell('<div class="loading">Loading&hellip;</div>');

  var data;
  try { data = await sepPubFetch(token); }
  catch (e) {
    app.innerHTML = obExitShell(
      '<h2 style="margin:0 0 8px">This link can&#39;t be used</h2>' +
      '<p style="color:var(--text-muted-color)">' + escHtml(e.message) +
      ' If you think that is a mistake, reply to the email this link came from and we will send a fresh one.</p>');
    return;
  }
  var a = data.agreement;
  _sepPubDoc = a;

  var doc =
    '<h2 style="margin:0 0 4px">Separation Agreement</h2>' +
    '<p style="color:var(--text-muted-color);font-size:13px;margin:0 0 18px">' +
      escHtml(a.company) + ' &middot; ' + escHtml(a.agreement_number) + '</p>' +

    '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:16px">' +
      sepPubRow('Name', a.employee_name || '') +
      (a.job_title ? sepPubRow('Position', a.job_title) : '') +
      sepPubRow('Last day', sepPubDate(a.last_day)) +
      sepPubRow('Final check', a.final_check_date ? sepPubDate(a.final_check_date) : 'Per payroll schedule') +
      sepPubRow('Accrued time off paid', sepPubHours(a.pto_payout_hours)) +
      (Number(a.severance_amount) > 0 ? sepPubRow('Separation pay', sepPubMoney(a.severance_amount)) : '') +
      sepPubRow('Company property', (a.property && a.property.length) ? 'See the list below' : (a.property_notes || 'All returned')) +
    '</div>' +

    sepPubProperty(a) +

    '<div style="margin-bottom:18px">' + sepPubBody(a.terms_body) + '</div>' +

    '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 16px">' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-bottom:6px">YOUR SIGNATURE</div>' +
      '<label style="font-size:12px;color:var(--text-muted-color)">Printed name</label>' +
      '<input id="sep-pub-name" class="form-control" value="' + escHtml(a.employee_name || '') +
        '" placeholder="Type your full name" style="margin-bottom:10px" />' +
      '<div id="sep-pub-sig" onclick="sepPubSign()" style="border:1px dashed var(--border);border-radius:8px;' +
        'min-height:74px;display:grid;place-items:center;cursor:pointer;color:var(--text-muted-color);font-size:13px;background:#fff">' +
        'Tap to sign</div>' +
      '<label style="display:flex;gap:9px;align-items:flex-start;cursor:pointer;margin:12px 0 4px">' +
        '<input type="checkbox" id="sep-pub-consent" style="width:16px;height:16px;flex:none;margin-top:1px"' +
          (a.consent_accepted ? ' checked' : '') + '>' +
        '<span style="font-size:12.5px;color:var(--text-dim);line-height:1.5">I agree to sign this document ' +
        'electronically, and that my electronic signature is legally binding.</span>' +
      '</label>' +
      '<div id="sep-pub-error" style="display:none;color:#f87171;font-size:12.5px;margin:8px 0"></div>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button class="btn btn-secondary btn-sm" onclick="sepPubDecline()">I&#39;d rather not</button>' +
        '<button class="btn btn-primary" style="flex:1" id="sep-pub-submit" onclick="sepPubSubmit()">Sign and send</button>' +
      '</div>' +
      '<p style="font-size:11.5px;color:var(--text-muted-color);margin:12px 0 0;text-align:center">' +
        escHtml(a.rep_name || 'A manager') + ' countersigns after you, and a signed copy is emailed to you.</p>' +
    '</div>';

  app.innerHTML = obExitShell(doc);
}

function sepPubSign() {
  var n = document.getElementById('sep-pub-name');
  if (typeof window.novaSigPad !== 'function') {
    var box = document.getElementById('sep-pub-error');
    if (box) { box.style.display = 'block'; box.textContent = 'The signature pad did not load. Please reload the page.'; }
    return;
  }
  window.novaSigPad({
    title: 'Sign here',
    defaultName: n ? n.value : '',
    onApply: function (dataUrl) {
      _sepPubSig = dataUrl;
      var slot = document.getElementById('sep-pub-sig');
      if (slot) slot.innerHTML = '<img src="' + dataUrl + '" alt="Your signature" style="max-height:66px">';
    }
  });
}

async function sepPubSubmit() {
  var err = document.getElementById('sep-pub-error');
  function fail(msg) { if (err) { err.style.display = 'block'; err.textContent = msg; } }
  var name = String((document.getElementById('sep-pub-name') || {}).value || '').trim();
  var consent = document.getElementById('sep-pub-consent');
  if (!name) return fail('Please type your printed name.');
  if (!_sepPubSig) return fail('Please add your signature.');
  if (!consent || !consent.checked) return fail('Please tick the box agreeing to sign electronically.');
  if (err) err.style.display = 'none';

  var btn = document.getElementById('sep-pub-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    await sepPubFetch(_sepPubToken + '/consent', 'POST', {});
    var r = await sepPubFetch(_sepPubToken + '/submit', 'POST',
      { image: _sepPubSig, printed_name: name, consent: true });
    document.getElementById('app').innerHTML = obExitShell(
      '<h2 style="margin:0 0 8px">Thanks, ' + escHtml(name.split(' ')[0]) + '.</h2>' +
      '<p style="color:var(--text-muted-color);line-height:1.65">Your signature is recorded. ' +
      escHtml((r && r.rep_name) || (_sepPubDoc && _sepPubDoc.rep_name) || 'A manager') +
      ' countersigns it, and a signed copy lands in your inbox after that. Nothing else to do.</p>');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign and send'; }
    fail(e.message);
  }
}

async function sepPubDecline() {
  var why = prompt('If you would rather not sign, tell us why and somebody will follow up:');
  if (why === null) return;
  try {
    await sepPubFetch(_sepPubToken + '/decline', 'POST', { reason: String(why || '') });
    document.getElementById('app').innerHTML = obExitShell(
      '<h2 style="margin:0 0 8px">Thanks for letting us know.</h2>' +
      '<p style="color:var(--text-muted-color);line-height:1.65">We have passed this to the manager handling your ' +
      'offboarding and somebody will be in touch.</p>');
  } catch (e) {
    var err = document.getElementById('sep-pub-error');
    if (err) { err.style.display = 'block'; err.textContent = e.message; }
  }
}
