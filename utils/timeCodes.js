// ---------------------------------------------------------------------------
//  Time codes - the windows of the week that decide a price and an ETA
// ---------------------------------------------------------------------------
// A service, at a location, is carved into named windows: Daytime, Evening,
// Overnight and so on. Each window carries its own full charge, additional
// charge, and three ETAs (core / account / EDU).
//
// Everything in here works in MINUTES OF THE WEEK, 0 = Monday 00:00 through
// 10079 = Sunday 23:59. That single representation is what makes a window that
// wraps past midnight, or a window that only runs on weekends, the same kind of
// thing as any other - and it is why the coverage check can be exact rather
// than approximate.
// ---------------------------------------------------------------------------

const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 10080;

// Bitmask, Monday = 1 .. Sunday = 64. 127 = every day.
const DAY_BITS = [1, 2, 4, 8, 16, 32, 64];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function clampMinute(n) {
  n = parseInt(n, 10);
  if (!isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > MINUTES_PER_DAY - 1) return MINUTES_PER_DAY - 1;
  return n;
}

// 'Daytime 8:00 AM - 4:59 PM' is stored as start 480, end 1019 INCLUSIVE. The
// end is inclusive because a dispatcher thinks of 4:59 PM as the last minute
// that is still daytime, not as the first minute that is not.
function expandCode(code) {
  const out = [];
  const start = clampMinute(code.start_minute);
  const end = clampMinute(code.end_minute);
  if (start === null || end === null) return out;
  const days = parseInt(code.days, 10);
  const mask = isFinite(days) ? days : 127;
  for (var d = 0; d < 7; d++) {
    if (!(mask & DAY_BITS[d])) continue;
    const base = d * MINUTES_PER_DAY;
    if (end >= start) {
      out.push([base + start, base + end]);
    } else {
      // Wraps past midnight: 10:00 PM -> 5:59 AM is TWO ranges, and the tail
      // belongs to the following day. Without this the range reads as negative
      // length and every coverage check silently passes.
      out.push([base + start, base + MINUTES_PER_DAY - 1]);
      out.push([(base + MINUTES_PER_DAY) % MINUTES_PER_WEEK,
        ((base + MINUTES_PER_DAY) % MINUTES_PER_WEEK) + end]);
    }
  }
  return out;
}

function fmtMinute(m) {
  const day = Math.floor(m / MINUTES_PER_DAY) % 7;
  const inDay = m % MINUTES_PER_DAY;
  var h = Math.floor(inDay / 60);
  const mi = inDay % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return DAY_NAMES[day] + ' ' + h + ':' + String(mi).padStart(2, '0') + ' ' + ap;
}

// Walk the whole week once and report exactly which minutes nobody covers and
// which minutes two codes both claim. Reporting the FIRST run of each is what
// makes the error message actionable - "Sun 2:00 AM to Sun 5:59 AM is not
// covered" beats "coverage error".
function checkCoverage(codes) {
  const owner = new Array(MINUTES_PER_WEEK).fill(0);
  const overlaps = [];
  const seen = {};
  (codes || []).forEach(function (c) {
    if (c.active === false) return;
    expandCode(c).forEach(function (r) {
      for (var m = r[0]; m <= r[1]; m++) {
        const idx = m % MINUTES_PER_WEEK;
        if (owner[idx]) {
          const key = owner[idx] + '/' + (c.code_id || c.id || '?');
          if (!seen[key]) {
            seen[key] = 1;
            overlaps.push({ from: idx, a: owner[idx], b: (c.code_id || c.id || null) });
          }
        } else {
          owner[idx] = c.code_id || c.id || 1;
        }
      }
    });
  });

  const gaps = [];
  var runStart = null;
  for (var m2 = 0; m2 < MINUTES_PER_WEEK; m2++) {
    if (!owner[m2]) {
      if (runStart === null) runStart = m2;
    } else if (runStart !== null) {
      gaps.push({ from: runStart, to: m2 - 1 });
      runStart = null;
    }
  }
  if (runStart !== null) gaps.push({ from: runStart, to: MINUTES_PER_WEEK - 1 });

  var uncovered = 0;
  gaps.forEach(function (g) { uncovered += (g.to - g.from + 1); });

  return {
    ok: gaps.length === 0 && overlaps.length === 0,
    uncovered_minutes: uncovered,
    gaps: gaps.map(function (g) {
      return { from: g.from, to: g.to, label: fmtMinute(g.from) + ' to ' + fmtMinute(g.to) };
    }),
    overlaps: overlaps.map(function (o) {
      return { at: o.from, a: o.a, b: o.b, label: fmtMinute(o.from) };
    })
  };
}

// Minute of the week for a moment, IN THE CITY'S OWN TIME. Not UTC and not the
// browser's - Birmingham is an hour behind Orlando, and a call created at
// 11:58 PM has to land in Overnight, not in tomorrow morning.
function minuteOfWeek(when, timeZone) {
  const d = when instanceof Date ? when : new Date(when);
  var parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'America/New_York',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
  } catch (e) {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
  }
  const get = function (t) {
    const p = parts.filter(function (x) { return x.type === t; })[0];
    return p ? p.value : null;
  };
  const wd = DAY_NAMES.indexOf(get('weekday'));
  var hh = parseInt(get('hour'), 10);
  const mm = parseInt(get('minute'), 10);
  if (hh === 24) hh = 0;   // some ICU builds render midnight as 24
  if (wd < 0 || !isFinite(hh) || !isFinite(mm)) return null;
  return wd * MINUTES_PER_DAY + hh * 60 + mm;
}

// Which code covers a given moment. Returns null rather than guessing: a call
// landing in an uncovered minute has no price and no ETA, and saying so is
// better than quietly charging whatever the first row happened to be.
function codeAt(codes, when, timeZone) {
  const mow = minuteOfWeek(when, timeZone);
  if (mow === null) return null;
  var found = null;
  (codes || []).forEach(function (c) {
    if (found || c.active === false) return;
    const ranges = expandCode(c);
    for (var i = 0; i < ranges.length; i++) {
      const lo = ranges[i][0] % MINUTES_PER_WEEK;
      const hi = ranges[i][1] % MINUTES_PER_WEEK;
      if (hi >= lo) {
        if (mow >= lo && mow <= hi) { found = c; return; }
      } else if (mow >= lo || mow <= hi) { found = c; return; }
    }
  });
  return found;
}

// The ETA a customer is actually told, given who is calling.
//   EDU     -> the emergency number, flat
//   account -> whatever that account's SLA says on the code
//   core    -> the public range, quoted as a range
function etaFor(code, opts) {
  if (!code) return null;
  const o = opts || {};
  if (o.is_edu && code.eta_edu) {
    return { minutes: code.eta_edu, low: code.eta_edu, high: code.eta_edu, source: 'edu' };
  }
  if (o.has_account && code.eta_account) {
    return { minutes: code.eta_account, low: code.eta_account, high: code.eta_account, source: 'account' };
  }
  if (code.eta_core_low) {
    const hi = code.eta_core_high || code.eta_core_low;
    // The promise is measured against the TOP of the range. Promising the
    // bottom of "25 to 45" and then measuring against it would mark two calls
    // out of three late for no reason.
    return { minutes: hi, low: code.eta_core_low, high: hi, source: 'core' };
  }
  return null;
}

function dayMaskToList(mask) {
  const m = parseInt(mask, 10);
  const out = [];
  for (var i = 0; i < 7; i++) if ((isFinite(m) ? m : 127) & DAY_BITS[i]) out.push(DAY_NAMES[i]);
  return out;
}

function listToDayMask(list) {
  if (!Array.isArray(list) || !list.length) return 127;
  var mask = 0;
  list.forEach(function (d) {
    const i = DAY_NAMES.indexOf(String(d).slice(0, 3));
    if (i >= 0) mask |= DAY_BITS[i];
  });
  return mask || 127;
}

function hhmmToMinute(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  var h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function minuteToHhmm(n) {
  const m = clampMinute(n);
  if (m === null) return '';
  var h = Math.floor(m / 60);
  const mi = m % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + String(mi).padStart(2, '0') + ' ' + ap;
}

module.exports = {
  MINUTES_PER_DAY: MINUTES_PER_DAY,
  MINUTES_PER_WEEK: MINUTES_PER_WEEK,
  DAY_NAMES: DAY_NAMES,
  DAY_BITS: DAY_BITS,
  expandCode: expandCode,
  checkCoverage: checkCoverage,
  minuteOfWeek: minuteOfWeek,
  codeAt: codeAt,
  etaFor: etaFor,
  fmtMinute: fmtMinute,
  dayMaskToList: dayMaskToList,
  listToDayMask: listToDayMask,
  hhmmToMinute: hhmmToMinute,
  minuteToHhmm: minuteToHhmm
};
