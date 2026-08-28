/*
 * Weekly leaderboards.
 *
 *   - two cards at the top of Home: top revenue, most batteries sold
 *   - a Leaderboards screen where a manager uploads the week's spreadsheet
 *
 * Neither number can be computed by Nova (revenue lives in Pulsar, batteries
 * are counted at the counter), so both arrive as a sheet. The sheet's shape is
 * whatever the report tool exported, so the upload flow is: pick the file ->
 * the SERVER reads it and says which columns it thinks are which -> a human
 * confirms or changes them -> import.
 *
 * The browser never sends numbers. It sends the file and the column choices,
 * and the server re-reads the file to build the rows. So what lands on the
 * board is always what the file said.
 *
 * House style: string concatenation only, no template literals. Apostrophes
 * inside HTML strings are &#39;.
 */
(function () {
  var API = '/leaderboard';

  var _lbData = null;      // the week list
  var _lbWeek = null;      // the week currently opened, or null for the list
  var _lbFile = null;      // { name, b64 } held between preview and import
  var _lbPrev = null;      // the server's last preview answer
  var _lbBusy = false;

  function el(id) { return document.getElementById(id); }
  function esc(s) { return (typeof escHtml === 'function') ? escHtml(s == null ? '' : s) : String(s == null ? '' : s); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'success'); }
  function val(id) { var e = el(id); return e ? e.value : ''; }
  function canManage() { return (typeof can === 'function') && can('manage_leaderboard'); }

  function money(n) {
    var v = Number(n); if (!isFinite(v)) v = 0;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function count(n) {
    var v = Number(n); if (!isFinite(v)) v = 0;
    return (Math.round(v * 100) / 100).toLocaleString('en-US');
  }
  function fmt(metric, v) { return metric === 'revenue' ? money(v) : count(v); }

  var METRIC_LABEL = { revenue: 'Top Revenue', batteries: 'Most Batteries Sold' };
  var RANK_COLOR = ['#f0b429', '#b8c0cc', '#c98a52'];   // gold, silver, bronze

  function injectCss() {
    if (el('lb-css')) return;
    var st = document.createElement('style');
    st.id = 'lb-css';
    st.textContent =
      '.lb-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:0.5px solid var(--border-color)}' +
      '.lb-row:last-child{border-bottom:none}' +
      '.lb-rank{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'font-size:11px;font-weight:700;flex-shrink:0;background:var(--bg-color);color:var(--text-muted-color)}' +
      '.lb-name{font-size:13px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.lb-val{font-size:13px;font-weight:700;white-space:nowrap}' +
      '.lb-where{font-size:12px;color:var(--text-muted-color);white-space:nowrap;max-width:45%;' +
        'overflow:hidden;text-overflow:ellipsis}' +
      '.lb-you{font-size:9px;font-weight:800;letter-spacing:0.5px;background:#1d4429;color:#4ade80;' +
        'border-radius:4px;padding:1px 5px;margin-left:6px;vertical-align:1px}' +
      '.lb-unmatched{color:var(--text-muted-color);font-style:italic}' +
      '.lb-empty{text-align:center;padding:22px;color:var(--text-muted-color);font-size:13px}' +
      '.lb-cols{max-height:186px;overflow:auto;border:1px solid var(--border-color);border-radius:8px;padding:4px 2px}' +
      '.lb-col{display:flex;align-items:center;gap:8px;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:13px}' +
      '.lb-col:hover{background:var(--bg-color)}' +
      '.lb-col input{width:15px;height:15px;flex-shrink:0;margin:0;accent-color:var(--primary)}' +
      '.lb-col .h{font-weight:600;white-space:nowrap}' +
      '.lb-col .s{color:var(--text-muted-color);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}' +
      '.lb-col.off .h,.lb-col.off .s{opacity:0.55}' +
      '.lb-mini{font-size:11px;color:var(--text-muted-color);margin-bottom:3px}' +
      '@media (max-width:760px){.lb-home-grid{grid-template-columns:1fr !important}}';
    document.head.appendChild(st);
  }

  /* ==================================================================
   *  The Home cards
   * ================================================================== */

  function cardHtml(metric, board) {
    var label = METRIC_LABEL[metric] || metric;
    var body;
    if (!board || !board.top || !board.top.length) {
      body = '<div class="lb-empty">Nothing uploaded for this board yet.</div>';
    } else {
      body = board.top.map(function (r, i) {
        var rc = RANK_COLOR[i];
        // The revenue board shows WHERE, not HOW MUCH - Tony's call, 2026-08-28.
        // The order already says who won; putting each person's weekly take on
        // every employee's home screen says a good deal more than that. The
        // figures are still on the Leaderboards screen, behind the permission.
        // A count of batteries is not the same thing, so that one keeps its
        // number: on that board the number IS the achievement.
        var right = (metric === 'revenue')
          ? '<div class="lb-where">' + esc(r.city_code || '') + '</div>'
          : '<div class="lb-val">' + fmt(metric, r.value) + '</div>';
        return '<div class="lb-row">' +
          '<div class="lb-rank"' + (rc ? (' style="background:' + rc + ';color:#1a1a1a"') : '') + '>' + (i + 1) + '</div>' +
          '<div class="lb-name' + (r.user_id ? '' : ' lb-unmatched') + '">' + esc(r.name) +
            (r.is_me ? '<span class="lb-you">YOU</span>' : '') + '</div>' +
          right +
        '</div>';
      }).join('');
    }
    return '<div class="card"><div class="card-header">' +
      '<span class="card-title">' + label + '</span>' +
      '<span style="font-size:11px;color:var(--text-muted-color)">' +
        (board ? esc(board.week_label) : 'No week yet') + '</span>' +
      '</div><div class="card-body" style="padding:2px 16px 10px">' + body + '</div></div>';
  }

  // app.js leaves the slot on the Home screen; this fills it.
  //
  // With nothing uploaded at all, a manager gets one prompt with a way in and
  // everybody else gets nothing - an employee has no use for an empty board and
  // no way to fill it.
  async function fillLeaders() {
    var slot = el('home-leaders');
    if (!slot) return;
    injectCss();
    var d;
    try { d = await api('GET', API + '/home'); } catch (e) { return; }
    var rev = d && d.revenue, bat = d && d.batteries;
    if (!rev && !bat) {
      slot.innerHTML = canManage()
        ? ('<div class="card" style="margin-bottom:24px;border-style:dashed;cursor:pointer" onclick="navigate(&#39;leaderboards&#39;)">' +
           '<div class="card-body" style="text-align:center;padding:18px">' +
           '<div style="font-size:13px;font-weight:600">Weekly leaderboards</div>' +
           '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px">' +
           'Upload last week&#39;s revenue and battery numbers to put the top five on everyone&#39;s home screen.</div>' +
           '</div></div>')
        : '';
      return;
    }
    slot.innerHTML =
      '<div class="lb-home-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:10px">' +
        cardHtml('revenue', rev) + cardHtml('batteries', bat) +
      '</div>' +
      '<div style="margin:0 0 20px;text-align:right">' +
        (canManage()
          ? ('<span style="font-size:12px;color:var(--primary);cursor:pointer" onclick="navigate(&#39;leaderboards&#39;)">' +
             'Upload this week&#39;s numbers</span>')
          : '') +
      '</div>';
  }

  // Chain onto whatever already wraps the Home screen (employeeRecords.js wraps
  // it for Recent Wins), rather than replacing it.
  var origHome = window.renderHomeScreen;
  if (typeof origHome === 'function') {
    window.renderHomeScreen = async function (host) {
      await origHome(host);
      try { await fillLeaders(); } catch (e) {}
    };
  }

  /* ==================================================================
   *  The Leaderboards screen
   * ================================================================== */

  window.renderLeaderboards = async function (host) {
    injectCss();
    if (!canManage()) { host.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
    if (_lbWeek) return renderWeek(host, _lbWeek);
    host.innerHTML = '<div class="loading">Loading&hellip;</div>';
    try { _lbData = await api('GET', API); }
    catch (e) { host.innerHTML = '<div class="alert alert-error">Could not load leaderboards: ' + esc(e.message || 'error') + '</div>'; return; }

    var weeks = _lbData.weeks || [];
    var rows = weeks.length ? weeks.map(function (w) {
      return '<tr>' +
        '<td><span class="badge ' + (w.metric === 'revenue' ? 'badge-approved' : 'badge-submitted') + '">' +
          esc(METRIC_LABEL[w.metric] || w.metric) + '</span></td>' +
        '<td style="font-weight:600">' + esc(w.week_label) + '</td>' +
        '<td>' + (w.leader ? esc(w.leader) : '&mdash;') + '</td>' +
        '<td style="text-align:right">' + fmt(w.metric, w.total_value) + '</td>' +
        '<td style="text-align:center">' + w.row_count +
          (w.matched_count < w.row_count
            ? ' <span style="color:#f59e0b;font-size:11px">(' + (w.row_count - w.matched_count) + ' unmatched)</span>'
            : '') + '</td>' +
        '<td style="font-size:12px;color:var(--text-muted-color)">' + esc(w.uploaded_by_name || '') + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          '<button class="btn btn-secondary btn-sm" onclick="lbOpen(' + w.id + ')">Open</button> ' +
          '<button class="btn btn-secondary btn-sm" onclick="lbDelete(' + w.id + ')">Remove</button>' +
        '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="lb-empty">No weeks uploaded yet.</td></tr>';

    host.innerHTML =
      '<div class="page-header"><div class="page-title"><h2>Leaderboards</h2>' +
        '<p>Upload the week&#39;s numbers and Nova puts the top five on everyone&#39;s home screen. ' +
        'Two boards: revenue generated and batteries sold. Re-uploading a week replaces it.</p></div>' +
        '<button class="btn btn-primary" onclick="lbUploadModal()">Upload a week</button>' +
      '</div>' +
      '<div class="card"><div class="card-body" style="padding:0">' +
        '<div style="overflow-x:auto"><table class="data-table"><thead><tr>' +
          '<th>Board</th><th>Week</th><th>Leader</th><th style="text-align:right">Total</th>' +
          '<th style="text-align:center">People</th><th>Uploaded by</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '</div></div>';
  };

  window.lbOpen = function (id) { _lbWeek = id; render(); };
  window.lbBack = function () { _lbWeek = null; render(); };

  async function renderWeek(host, id) {
    host.innerHTML = '<div class="loading">Loading&hellip;</div>';
    var d;
    try { d = await api('GET', API + '/week/' + id); }
    catch (e) { host.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'error') + '</div>'; return; }
    var w = d.week, entries = d.entries || [], roster = d.roster || [];
    var unmatched = entries.filter(function (x) { return !x.matched; }).length;

    var opts = '<option value="">&mdash; nobody &mdash;</option>' + roster.map(function (u) {
      return '<option value="' + u.id + '">' + esc(u.name) + (u.home_city ? (' (' + esc(u.home_city) + ')') : '') + '</option>';
    }).join('');

    var rows = entries.map(function (e) {
      return '<tr>' +
        '<td style="text-align:center;font-weight:700">' + e.rank + '</td>' +
        '<td>' + (e.matched
            ? ('<span style="font-weight:600">' + esc(e.name) + '</span>' +
               (e.raw_name !== e.name
                 ? ('<div style="font-size:11px;color:var(--text-muted-color)">sheet said &ldquo;' + esc(e.raw_name) + '&rdquo;</div>')
                 : ''))
            : ('<span class="lb-unmatched">' + esc(e.raw_name) + '</span>' +
               '<div style="font-size:11px;color:#f59e0b">not matched to anyone in Nova</div>')) +
        '</td>' +
        '<td style="text-align:right;font-weight:600">' + fmt(w.metric, e.value) + '</td>' +
        '<td>' + esc(e.city_code || '') + '</td>' +
        '<td style="text-align:right">' +
          '<select id="lb-link-' + e.id + '" class="form-control" style="min-width:190px;display:inline-block;width:auto" ' +
            'onchange="lbLink(' + e.id + ')">' + opts + '</select>' +
        '</td></tr>';
    }).join('');

    host.innerHTML =
      '<div class="page-header"><div class="page-title">' +
        '<button class="btn btn-secondary btn-sm" onclick="lbBack()" style="margin-bottom:8px">&larr; All weeks</button>' +
        '<h2>' + esc(METRIC_LABEL[w.metric] || w.metric) + ' &middot; ' + esc(w.week_label) + '</h2>' +
        '<p>' + esc(w.file_name || 'uploaded file') + (w.sheet_name ? (' &middot; sheet ' + esc(w.sheet_name)) : '') +
        (w.name_column ? (' &middot; name from &ldquo;' + esc(w.name_column) + '&rdquo;') : '') +
        (w.value_column ? (', ' + (w.mode === 'count' ? 'counting ' : 'number from ') + esc(w.value_column)) : '') + '</p></div>' +
      '</div>' +
      (unmatched
        ? ('<div class="alert alert-warn">' + unmatched + ' name' + (unmatched === 1 ? '' : 's') +
           ' on this sheet did not match anybody in Nova. They still count and still show on the board under ' +
           'the name the sheet used &mdash; pick the person on the right to link them. Linking somebody who is ' +
           'already on this board merges the two rows.</div>')
        : '') +
      '<div class="card"><div class="card-body" style="padding:0">' +
        '<div style="overflow-x:auto"><table class="data-table"><thead><tr>' +
          '<th style="text-align:center;width:44px">#</th><th>Name</th>' +
          '<th style="text-align:right">' + (w.mode === 'count' ? 'Calls' : (w.metric === 'revenue' ? 'Revenue' : 'Batteries')) + '</th>' +
          '<th>City</th><th style="text-align:right">Linked to</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '</div></div>';

    // Selects are set after the markup lands so a name carrying quotes can
    // never break a selected="" attribute.
    entries.forEach(function (e) {
      var sel = el('lb-link-' + e.id);
      if (sel) sel.value = e.user_id == null ? '' : String(e.user_id);
    });
  }

  window.lbLink = async function (entryId) {
    var sel = el('lb-link-' + entryId);
    if (!sel) return;
    try {
      await api('POST', API + '/entry/' + entryId, { user_id: sel.value === '' ? null : sel.value });
      toast('Linked.', 'success');
      render();
    } catch (e) { toast(e.message || 'Could not link that row.', 'error'); render(); }
  };

  window.lbDelete = async function (id) {
    if (!confirm('Remove this week from the leaderboards? The home screen falls back to the week before it.')) return;
    try { await api('DELETE', API + '/week/' + id); toast('Removed.', 'success'); _lbWeek = null; render(); }
    catch (e) { toast(e.message || 'Could not remove that week.', 'error'); }
  };

  /* ------------------------------------------------------- the upload ---- */

  window.lbUploadModal = function () {
    _lbFile = null; _lbPrev = null;
    var def = (_lbData && _lbData.default_week) || '';
    var ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.id = 'lb-modal';
    ov.innerHTML =
      '<div class="modal" style="max-width:820px">' +
        '<div class="modal-header"><h3>Upload a week</h3>' +
          '<button class="modal-close" onclick="lbCloseModal()">&times;</button></div>' +
        '<div class="modal-body">' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
            '<div class="form-group" style="flex:1;min-width:200px"><label>Board</label>' +
              '<select id="lb-metric" class="form-control" onchange="lbRefreshPreview(true)">' +
                '<option value="revenue">Top Revenue</option>' +
                '<option value="batteries">Most Batteries Sold</option>' +
              '</select></div>' +
            '<div class="form-group" style="flex:1;min-width:200px"><label>Week starting (Monday)</label>' +
              '<input type="date" id="lb-week" class="form-control" value="' + esc(def) + '"></div>' +
          '</div>' +
          '<div class="form-group"><label>Spreadsheet</label>' +
            '<input type="file" id="lb-file" class="form-control" accept=".xlsx,.xlsm,.csv,.tsv,.txt" onchange="lbPickFile(this)">' +
            '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px">' +
            '.xlsx or .csv. Nova reads the file, keeps the names and numbers, and does not store the file itself.</div>' +
          '</div>' +
          '<div id="lb-step2"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" onclick="lbCloseModal()">Cancel</button>' +
          '<button class="btn btn-primary" id="lb-import-btn" onclick="lbImport()" disabled>Import</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
  };

  window.lbCloseModal = function () {
    var m = el('lb-modal');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    _lbFile = null; _lbPrev = null;
  };

  window.lbPickFile = function (input) {
    var f = input && input.files && input.files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('That file is larger than 8 MB.', 'error'); input.value = ''; return; }
    var reader = new FileReader();
    reader.onload = function () {
      var s = String(reader.result || '');
      var comma = s.indexOf(',');
      _lbFile = { name: f.name, b64: comma === -1 ? s : s.slice(comma + 1) };
      lbRefreshPreview(true);
    };
    reader.onerror = function () { toast('Could not read that file.', 'error'); };
    reader.readAsDataURL(f);
  };

  // Ask the SERVER what the file says. Every column change comes back through
  // here, so what is previewed is produced by the same parser that will do the
  // import - there is no second copy of the reading logic in the browser.
  //
  // reset=true throws the current column picks away (a new file, or a different
  // board, where last time&#39;s picks mean nothing).
  window.lbRefreshPreview = async function (reset) {
    if (!_lbFile) return;
    var body = {
      metric: val('lb-metric') || 'revenue',
      filename: _lbFile.name,
      file_base64: _lbFile.b64
    };
    // Read the pickers BEFORE anything is drawn over them. The loading line
    // below replaces the whole panel, so reading them afterwards sent blanks
    // and the server quietly fell back to its own guess - which is to say,
    // every column you changed by hand snapped back on the next redraw.
    if (!reset && _lbPrev) {
      body.sheet = val('lb-sheet') || _lbPrev.sheet;
      body.header_row = val('lb-header');
      body.name_col = val('lb-name-col');
      body.city_col = val('lb-city-col');
      body.mode = _lbPrev.mode;
      if (_lbPrev.mode === 'count') {
        body.match_col = val('lb-match-col');
        body.match_text = val('lb-match-text');
        body.status_col = val('lb-status-col');
        body.status_values = checkedStatuses();
      } else {
        body.value_cols = checkedValueCols();
      }
    }
    var box = el('lb-step2');
    if (box) box.innerHTML = '<div class="loading">Reading the file&hellip;</div>';
    try { _lbPrev = await api('POST', API + '/preview', body); }
    catch (e) {
      _lbPrev = null;
      if (box) box.innerHTML = '<div class="alert alert-error">' + esc(e.message || 'Could not read that file.') + '</div>';
      var btn0 = el('lb-import-btn'); if (btn0) btn0.disabled = true;
      return;
    }
    drawPreview();
  };

  function colOptions(cols, selected) {
    return cols.map(function (c) {
      var sample = (c.samples || []).slice(0, 2).join(', ');
      return '<option value="' + c.index + '"' + (c.index === selected ? ' selected' : '') + '>' +
        esc(c.header) + (sample ? (' &mdash; ' + esc(sample.slice(0, 34))) : '') + '</option>';
    }).join('');
  }

  // The number is a SET of columns, not one. A Pulsar call export splits the
  // money across Collected Cash / Check / CC / Account and revenue is all four
  // added up, so this is a tick list rather than a dropdown - and the four are
  // ticked for you when Nova recognises them.
  function colChecks(cols, chosen) {
    return '<div class="lb-cols" id="lb-value-cols">' + cols.map(function (c) {
      var on = chosen.indexOf(c.index) !== -1;
      var sample = (c.samples || []).slice(0, 2).join(', ');
      return '<label class="lb-col' + (on ? '' : ' off') + '">' +
        '<input type="checkbox" class="lb-vc" value="' + c.index + '"' + (on ? ' checked' : '') +
          ' onchange="lbRefreshPreview()">' +
        '<span class="h">' + esc(c.header) + '</span>' +
        (sample ? ('<span class="s">' + esc(sample.slice(0, 40)) + '</span>') : '') +
      '</label>';
    }).join('') + '</div>';
  }

  function checkedValueCols() {
    var out = [];
    var boxes = document.querySelectorAll('#lb-value-cols .lb-vc');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) out.push(parseInt(boxes[i].value, 10));
    return out;
  }

  function checkedStatuses() {
    var out = [];
    var boxes = document.querySelectorAll('#lb-status-values .lb-sv');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) out.push(boxes[i].value);
    return out;
  }

  // The counting rule, in the words of the thing it counts: "count a call when
  // Task contains batt, and Status is Completed."
  function countRuleHtml(cols, p) {
    var opts = p.status_options || [];
    var chosen = p.suggestion.status_values || [];
    return '<div class="form-group">' +
      '<label>Count a call when&hellip;</label>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">' +
        '<div style="flex:1;min-width:180px"><div class="lb-mini">this column</div>' +
          '<select id="lb-match-col" class="form-control" onchange="lbRefreshPreview()">' +
            colOptions(cols, p.suggestion.match_col) + '</select></div>' +
        '<div style="width:170px"><div class="lb-mini">contains</div>' +
          '<input id="lb-match-text" class="form-control" value="' + esc(p.suggestion.match_text || '') + '" ' +
          'onchange="lbRefreshPreview()" placeholder="batt"></div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px">' +
        'Not case sensitive, and it matches anywhere in the cell &mdash; ' +
        '&ldquo;batt&rdquo; catches Battery, BATT Jump and Car Battery Replacement alike.</div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>&hellip;and the call ended like this</label>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">' +
        '<div style="flex:1;min-width:180px"><div class="lb-mini">status column</div>' +
          '<select id="lb-status-col" class="form-control" onchange="lbRefreshPreview()">' +
            '<option value="-1"' + (p.suggestion.status_col === -1 ? ' selected' : '') + '>&mdash; do not filter &mdash;</option>' +
            colOptions(cols, p.suggestion.status_col) + '</select></div>' +
        '<div style="flex:1;min-width:190px"><div class="lb-mini">' +
          (opts.length ? 'tick what counts' : 'nothing to tick') + '</div>' +
          '<div class="lb-cols" id="lb-status-values" style="max-height:120px">' +
            (opts.length ? opts.map(function (o) {
              var on = chosen.indexOf(o.value) !== -1;
              return '<label class="lb-col' + (on ? '' : ' off') + '">' +
                '<input type="checkbox" class="lb-sv" value="' + esc(o.value) + '"' + (on ? ' checked' : '') +
                  ' onchange="lbRefreshPreview()">' +
                '<span class="h">' + esc(o.value) + '</span>' +
                '<span class="s">' + o.count + ' row' + (o.count === 1 ? '' : 's') + '</span>' +
              '</label>';
            }).join('')
             : '<div style="padding:8px 9px;font-size:12px;color:var(--text-muted-color)">Pick a status column first.</div>') +
          '</div></div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-muted-color);margin-top:4px">' +
        'Tick nothing and every call counts, cancelled and GOA included.</div>' +
    '</div>';
  }

  function headerOf(cols, i) {
    for (var k = 0; k < cols.length; k++) if (cols[k].index === i) return cols[k].header;
    return null;
  }

  function valueSummary(cols, p) {
    if (p.mode === 'count') {
      if (!(p.suggestion.match_col >= 0) || !p.suggestion.match_text) {
        return 'Say what a call has to contain and Nova will count them.';
      }
      var st = p.suggestion.status_values || [];
      return 'Counting calls where ' + (headerOf(cols, p.suggestion.match_col) || 'that column') +
        ' contains &ldquo;' + esc(p.suggestion.match_text) + '&rdquo;' +
        (st.length ? (' and ' + (headerOf(cols, p.suggestion.status_col) || 'status') + ' is ' +
                      st.map(esc).join(' or ')) : ', any status') + '.';
    }
    var chosen = p.suggestion.values || [];
    if (!chosen.length) return 'Nothing ticked yet, so there is no number to rank on.';
    var names = chosen.map(function (i) { return headerOf(cols, i); }).filter(Boolean);
    return (chosen.length === 1 ? 'Ranking on ' : 'Adding up ') + names.join(' + ') + '.';
  }

  function drawPreview() {
    var box = el('lb-step2');
    if (!box || !_lbPrev) return;
    var p = _lbPrev;
    var metric = val('lb-metric') || 'revenue';
    var cols = p.columns || [];
    var res = p.resolved || [];

    var rows = res.length ? res.map(function (r) {
      return '<tr>' +
        '<td style="text-align:center">' + r.rank + '</td>' +
        '<td>' + esc(r.raw_name) +
          (r.lines > 1 && p.mode !== 'count'
            ? ('<span style="font-size:11px;color:var(--text-muted-color)"> (' + r.lines + ' rows added up)</span>') : '') + '</td>' +
        '<td>' + (r.user_id
            ? ('<span style="color:#22c55e">' + esc(r.matched_name) + '</span>')
            : '<span style="color:#f59e0b">not matched</span>') + '</td>' +
        '<td style="text-align:right;font-weight:600">' + fmt(metric, r.value) + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="4" class="lb-empty">No rows came out of those columns.</td></tr>';

    box.innerHTML =
      '<div style="border-top:1px solid var(--border-color);margin:6px 0 14px"></div>' +
      (p.confident
        ? ''
        : '<div class="alert alert-warn" style="margin-bottom:12px">Nova is not certain which columns these are. Check the pickers below before importing.</div>') +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        ((p.sheets || []).length > 1
          ? ('<div class="form-group" style="flex:1;min-width:150px"><label>Sheet</label>' +
             '<select id="lb-sheet" class="form-control" onchange="lbRefreshPreview(true)">' +
             p.sheets.map(function (s) { return '<option value="' + esc(s) + '"' + (s === p.sheet ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') +
             '</select></div>')
          : ('<input type="hidden" id="lb-sheet" value="' + esc(p.sheet || '') + '">')) +
        '<div class="form-group" style="width:112px"><label>Header row</label>' +
          '<input type="number" id="lb-header" class="form-control" min="0" value="' + (p.header_row || 0) + '" onchange="lbRefreshPreview()"></div>' +
        '<div class="form-group" style="flex:1;min-width:180px"><label>Name column</label>' +
          '<select id="lb-name-col" class="form-control" onchange="lbRefreshPreview()">' + colOptions(cols, p.suggestion.name) + '</select></div>' +
        '<div class="form-group" style="flex:1;min-width:150px"><label>City column (optional)</label>' +
          '<select id="lb-city-col" class="form-control" onchange="lbRefreshPreview()">' +
            '<option value="-1"' + (p.suggestion.city === -1 ? ' selected' : '') + '>&mdash; none &mdash;</option>' +
            colOptions(cols, p.suggestion.city) + '</select></div>' +
      '</div>' +
      (p.mode === 'count'
        ? (countRuleHtml(cols, p) +
           '<div id="lb-value-sum" style="font-size:12px;color:var(--text-muted-color);margin:-6px 0 10px">' + valueSummary(cols, p) + '</div>')
        : ('<div class="form-group">' +
            '<label>Revenue &mdash; tick every column that counts, they are added together</label>' +
            (p.preset_used
              ? ('<div style="font-size:12px;color:#22c55e;margin:-2px 0 6px">Recognised a Pulsar export: the four Collected columns are ticked. ' +
                 'Tech Paid Gross is what the tech earned, not revenue, so it is not.</div>')
              : '') +
            colChecks(cols, p.suggestion.values || []) +
            '<div id="lb-value-sum" style="font-size:12px;color:var(--text-muted-color);margin-top:5px">' + valueSummary(cols, p) + '</div>' +
          '</div>')) +
      '<div style="font-size:12px;color:var(--text-muted-color);margin:2px 0 10px">' +
        p.rows_found + ' ' + (p.rows_found === 1 ? 'person' : 'people') + ' found' +
        (p.skipped && p.skipped.total_row ? (' &middot; ' + p.skipped.total_row + ' total row(s) ignored') : '') +
        (p.skipped && p.skipped.no_value ? (' &middot; ' + p.skipped.no_value + ' row(s) had no readable number') : '') +
        (p.skipped && p.skipped.no_match ? (' &middot; ' + p.skipped.no_match + ' call(s) were something else') : '') +
        (p.skipped && p.skipped.wrong_status ? (' &middot; ' + p.skipped.wrong_status + ' matching call(s) did not end in a status you ticked') : '') +
      '</div>' +
      '<div style="max-height:260px;overflow:auto;border:1px solid var(--border-color);border-radius:8px">' +
        '<table class="data-table"><thead><tr><th style="width:40px;text-align:center">#</th>' +
        '<th>Name in the sheet</th><th>Matched to</th><th style="text-align:right">' +
        (metric === 'revenue' ? 'Revenue' : 'Calls') + '</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '</div>' +
      (res.length > 5
        ? '<div style="font-size:12px;color:var(--text-muted-color);margin-top:6px">The home screen shows the top five. Everyone here is kept, so the ranking survives a name being linked later.</div>'
        : '');

    var btn = el('lb-import-btn');
    var ready = p.mode === 'count'
      ? (p.suggestion.match_col >= 0 && !!p.suggestion.match_text)
      : ((p.suggestion.values || []).length > 0);
    if (btn) btn.disabled = !(p.rows_found > 0 && ready);
  }

  window.lbImport = async function () {
    if (_lbBusy) return;
    if (!_lbFile || !_lbPrev) { toast('Pick a file first.', 'error'); return; }
    var week = val('lb-week');
    if (!week) { toast('Pick the week this file covers.', 'error'); return; }
    var countMode = _lbPrev && _lbPrev.mode === 'count';
    if (countMode) {
      if (!val('lb-match-text')) { toast('Say what the task column has to contain, for example batt.', 'error'); return; }
    } else if (!checkedValueCols().length) {
      toast('Tick at least one column for the number.', 'error'); return;
    }
    _lbBusy = true;
    var btn = el('lb-import-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }
    try {
      var payload = {
        metric: val('lb-metric') || 'revenue',
        week_start: week,
        filename: _lbFile.name,
        file_base64: _lbFile.b64,
        sheet: val('lb-sheet') || _lbPrev.sheet,
        header_row: val('lb-header'),
        name_col: val('lb-name-col'),
        city_col: val('lb-city-col'),
        mode: _lbPrev.mode
      };
      if (countMode) {
        payload.match_col = val('lb-match-col');
        payload.match_text = val('lb-match-text');
        payload.status_col = val('lb-status-col');
        payload.status_values = checkedStatuses();
      } else {
        payload.value_cols = checkedValueCols();
      }
      var out = await api('POST', API + '/import', payload);
      lbCloseModal();
      toast((out.replaced ? 'Week replaced' : 'Week published') + ' - ' + out.rows + ' people, ' +
            out.unmatched + ' unmatched.', 'success');
      _lbWeek = out.week_id;
      render();
    } catch (e) {
      toast(e.message || 'Could not import that file.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Import'; }
    } finally { _lbBusy = false; }
  };
})();
