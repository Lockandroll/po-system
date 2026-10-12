'use strict';
/*
 * Pulsar Call Data - row interpretation  (Nova)
 * --------------------------------------------
 * The Call Data page is a raw dump of the Pulsar "Call Search" export for
 * evaluation. EVERY column of EVERY row is kept, as exported, in a JSONB
 * blob. This file only does two things on top of that:
 *
 *   1. Finds the Call UID, which is the one key the whole store hangs off.
 *   2. Pulls a handful of well-known columns out into typed fields (date,
 *      location, task, tech, status, account, ATA, on-site, revenue) so the
 *      filters, the summaries and the indexes have something to stand on.
 *
 * Everything else stays in the blob, untouched. If the export layout changes
 * (a column added, renamed, dropped) nothing breaks: a new column simply shows
 * up as a new column, and a missing one just leaves the derived field empty.
 *
 * WHY THIS IS NOT utils/revenueCsv.js OR utils/pulsarCash.js
 * ---------------------------------------------------------
 * Same export, different job. Revenue keeps a fixed column set and its numbers
 * feed a report people act on; Cash Deposits replaces a period on import. This
 * store keeps everything, never deletes, and exists to be looked at. Keeping
 * them apart means poking at this one can never move a figure on either of the
 * others. Do not "de-duplicate" them.
 *
 * NOTE: no backtick/template-literal strings anywhere (Windows-safe).
 */

function squash(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function pad2(v) { var s = String(v); return s.length < 2 ? '0' + s : s; }

/*
 * Which export column feeds which derived field. First match wins, so the
 * order inside each list is a priority order. "DT Complete" beats the other
 * dates because it is when the work was finished, which is what every other
 * Call Search report in Nova buckets by.
 */
var EXACT = {
  uid:      ['call uid', 'calluid', 'call_uid', 'call id', 'callid'],
  when:     ['dt complete', 'dt completed', 'date complete', 'date completed', 'dt received', 'dt created', 'call date', 'date'],
  location: ['location', 'city', 'market'],
  task:     ['task', 'task code'],
  tech:     ['tech id', 'tech', 'technician', 'tech name', 'driver'],
  status:   ['status', 'call status'],
  account:  ['account', 'account name']
};

/*
 * headers -> { uid: 'Call UID', when: 'DT Complete', ..., ata: 'ATA (mins)',
 *              onsite: 'Onsite (mins)', money: ['Collected Cash', ...] }
 * A field with no matching column is simply absent.
 */
function detectColumns(headers) {
  var list = (headers || []).map(function (h) { return String(h == null ? '' : h).trim(); });
  var bySquash = {};
  list.forEach(function (h) { if (h !== '' && !bySquash[squash(h)]) bySquash[squash(h)] = h; });
  var out = {};
  Object.keys(EXACT).forEach(function (field) {
    var cands = EXACT[field];
    for (var i = 0; i < cands.length; i++) {
      if (bySquash[cands[i]]) { out[field] = bySquash[cands[i]]; return; }
    }
  });
  list.forEach(function (h) {
    var s = squash(h);
    if (!s) return;
    if (!out.ata && /^ata\b/.test(s)) out.ata = h;
    if (!out.onsite && /^on[\s\-]?site\b/.test(s)) out.onsite = h;
  });
  var money = list.filter(function (h) { return /^collected\b/.test(squash(h)); });
  if (money.length) out.money = money;
  return out;
}

/*
 * "9/13/2026 4:07:11 PM" -> "2026-09-13 16:07:11"
 * "9/13/2026"            -> "2026-09-13 00:00:00"
 * "2026-09-13 16:07"     -> "2026-09-13 16:07:00"
 * Kept as wall-clock time with no zone. The export is local time and so is
 * every question anybody will ask of it ("what happens at 6pm on Fridays").
 */
function parseWhen(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  var y, mo, d, hh = 0, mi = 0, ss = 0, ap = '';
  if (m) {
    mo = +m[1]; d = +m[2]; y = m[3]; if (y.length === 2) y = '20' + y; y = +y;
    if (m[4] != null) { hh = +m[4]; mi = +m[5]; ss = m[6] ? +m[6] : 0; ap = (m[7] || '').toUpperCase(); }
  } else {
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    y = +m[1]; mo = +m[2]; d = +m[3];
    if (m[4] != null) { hh = +m[4]; mi = +m[5]; ss = m[6] ? +m[6] : 0; }
  }
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;          // 2/31 and friends
  return y + '-' + pad2(mo) + '-' + pad2(d) + ' ' + pad2(hh) + ':' + pad2(mi) + ':' + pad2(ss);
}

/* "$1,234.56" -> 1234.56, "($25.00)" -> -25, "" -> null */
function money(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return null;
  var neg = false;
  if (s.charAt(0) === '(' && s.charAt(s.length - 1) === ')') { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  var v = parseFloat(s);
  if (!isFinite(v)) return null;
  return neg ? -v : v;
}

/* "45" -> 45, "45.5" -> 45.5, "1:05" -> 65 (h:mm), "" -> null */
function minutes(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return null;
  var hm = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hm) return (+hm[1]) * 60 + (+hm[2]) + (hm[3] ? (+hm[3]) / 60 : 0);
  var v = parseFloat(s.replace(/,/g, ''));
  return isFinite(v) ? v : null;
}

function clip(s, n) {
  var v = String(s == null ? '' : s).trim();
  if (v === '') return null;
  return v.length > n ? v.slice(0, n) : v;
}

/*
 * One export row (object keyed by header) -> what gets stored.
 * data keeps every non-blank-header column as a trimmed string. Empty cells
 * are kept as "" on purpose: a later export that blanks a cell is a
 * correction, and the merge on re-import has to be able to carry it.
 */
function interpret(row, cols) {
  var data = {};
  Object.keys(row || {}).forEach(function (k) {
    var key = String(k).trim();
    if (!key) return;                                    // the trailing unnamed column
    var v = row[k];
    data[key] = v == null ? '' : String(v).trim();
  });
  var uid = cols.uid ? String(data[cols.uid] || '').trim() : '';
  var when = cols.when ? parseWhen(data[cols.when]) : null;
  var revenue = null;
  if (cols.money) {
    var any = false, sum = 0;
    cols.money.forEach(function (h) { var v = money(data[h]); if (v !== null) { any = true; sum += v; } });
    revenue = any ? Math.round(sum * 100) / 100 : null;
  }
  var ata = cols.ata ? minutes(data[cols.ata]) : null;
  var onsite = cols.onsite ? minutes(data[cols.onsite]) : null;
  return {
    uid: uid.length > 100 ? uid.slice(0, 100) : uid,
    data: data,
    call_at: when,
    call_date: when ? when.slice(0, 10) : null,
    location: cols.location ? clip(data[cols.location], 255) : null,
    task: cols.task ? clip(data[cols.task], 120) : null,
    tech: cols.tech ? clip(data[cols.tech], 255) : null,
    status: cols.status ? clip(data[cols.status], 60) : null,
    account: cols.account ? clip(data[cols.account], 255) : null,
    ata_mins: ata,
    onsite_mins: onsite,
    revenue: revenue
  };
}

module.exports = {
  squash: squash,
  detectColumns: detectColumns,
  parseWhen: parseWhen,
  money: money,
  minutes: minutes,
  interpret: interpret
};
