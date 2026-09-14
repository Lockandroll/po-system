'use strict';
/*
 * Weekly revenue report - the numbers  (Nova)
 * -------------------------------------------
 * Reads cs_calls and builds the model the PDF and the on-screen page both
 * render. Nothing here draws anything and nothing here knows about HTTP: give
 * it a pool and a window, get back a plain object.
 *
 * THE SHAPE OF THE ANSWER
 *   {
 *     window:    { weeks[], first, last, count },
 *     company:   page,                      // all locations combined
 *     locations: [ page, ... ],             // revenue descending
 *     totals:    { revenue, calls, byClass{} },
 *     meta:      { locationMap, generatedAt, activeWeeks[] }
 *   }
 * where a 'page' is
 *   { name, revenue, calls,
 *     weeks: { <monday>: { roadside, battery, locksmith, total, calls } },
 *     cards: { roadside, battery, locksmith, total },
 *     rows:  [ { week_start, roadside, battery, locksmith, calls,
 *                d_roadside, d_battery, d_locksmith } ] }
 *
 * WHY THE LOCATION MERGE HAPPENS HERE AND NOT IN THE TABLE
 *   cs_calls stores location_raw only. Clearwater + Tampa -> Suncoast is
 *   configuration and more consolidations are coming, so the merge is applied
 *   when the numbers are added up. Change the map and the whole history
 *   re-reports correctly with no backfill. See the comment in db.js.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var CSV = require('./revenueCsv');

var CLASSES = CSV.CLASSES;                 // roadside, battery, locksmith - in display order
var DEFAULT_WEEKS = 12;

function n2(v) {
  var x = Number(v);
  if (!isFinite(x)) x = 0;
  return Math.round(x * 100) / 100;
}

/*
 * Percent change, as a number like 12.4 meaning +12.4%.
 *
 * Returns null when there is nothing to compare against. That is a real
 * answer, not a missing one: a class that did $0 last week and $400 this week
 * has not grown by "infinity percent", it has started. The renderers print a
 * dash for null rather than inventing a figure.
 */
function pct(cur, prior) {
  var p = Number(prior) || 0;
  if (p === 0) return null;
  return ((Number(cur) || 0) - p) / Math.abs(p) * 100;
}

function emptyWeek() {
  var w = { total: 0, calls: 0 };
  CLASSES.forEach(function (c) { w[c] = 0; });
  return w;
}

/* --------------------------------------------------------------- the read */

/*
 * One grouped query for the whole window. At 12 weeks x 8 locations x 3
 * classes this is at most a few hundred rows however many calls are behind it,
 * so the report does not get slower as the history grows.
 */
async function loadGrouped(pool, firstWeek, lastWeek) {
  var r = await pool.query(
    'SELECT week_start, location_raw, service_class, ' +
    '       COALESCE(SUM(revenue), 0)::float8 AS revenue, COUNT(*)::int AS calls ' +
    '  FROM cs_calls ' +
    ' WHERE week_start >= $1::date AND week_start <= $2::date ' +
    ' GROUP BY week_start, location_raw, service_class',
    [firstWeek, lastWeek]
  );
  return r.rows.map(function (row) {
    // pg hands a DATE back as a local-midnight Date. Read the LOCAL parts:
    // toISOString() on a negative-offset server would shift Monday to Sunday
    // and silently move a week's revenue into the week before it.
    var d = row.week_start;
    var ymd;
    if (d instanceof Date) {
      ymd = d.getFullYear() + '-' +
        (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + '-' +
        (d.getDate() < 10 ? '0' : '') + d.getDate();
    } else {
      ymd = String(d).slice(0, 10);
    }
    return {
      week_start: ymd,
      location_raw: row.location_raw,
      service_class: row.service_class,
      revenue: Number(row.revenue) || 0,
      calls: Number(row.calls) || 0
    };
  });
}

/* -------------------------------------------------------------- the model */

/*
 * Build one page (a location, or the company) from its week buckets.
 *
 * ROLLING AVERAGE, stated once so both renderers agree: the average is taken
 * over the ACTIVE weeks in the window BEFORE the latest one. Active means the
 * company had at least one call that week, which keeps a window that reaches
 * back further than the history does from diluting the average with zeroes
 * that only mean "we had not started importing yet". Excluding the latest week
 * is deliberate - an average that contains the number it is being compared to
 * pulls itself toward that number and flattens exactly the movement the card
 * exists to show.
 */
function buildPage(name, weeks, window_, activeWeeks) {
  var latest = window_[window_.length - 1];
  var prior = window_.length > 1 ? window_[window_.length - 2] : null;

  var revenue = 0, calls = 0;
  window_.forEach(function (w) {
    var b = weeks[w] || emptyWeek();
    revenue += b.total;
    calls += b.calls;
  });

  // Weeks the average is taken over.
  var avgWeeks = activeWeeks.filter(function (w) { return w !== latest; });

  function card(key) {
    var cur = (weeks[latest] || emptyWeek())[key];
    var prev = prior ? (weeks[prior] || emptyWeek())[key] : null;
    var avg = null;
    if (avgWeeks.length) {
      var sum = 0;
      avgWeeks.forEach(function (w) { sum += (weeks[w] || emptyWeek())[key]; });
      avg = n2(sum / avgWeeks.length);
    }
    return {
      value: n2(cur),
      prior: prior ? n2(prev) : null,
      d_prior: prior ? pct(cur, prev) : null,
      average: avg,
      d_average: avg === null ? null : pct(cur, avg),
      avg_weeks: avgWeeks.length
    };
  }

  var cards = { total: card('total') };
  CLASSES.forEach(function (c) { cards[c] = card(c); });

  // One row per week in the window, each class with its change on the week
  // before it. There is deliberately NO combined column and no total row here:
  // the table is a week-over-week comparison WITHIN each service class, and
  // the combined figure lives on the Total Revenue card instead.
  var rows = window_.map(function (w, i) {
    var b = weeks[w] || emptyWeek();
    var pb = i > 0 ? (weeks[window_[i - 1]] || emptyWeek()) : null;
    var row = { week_start: w, calls: b.calls };
    CLASSES.forEach(function (c) {
      row[c] = n2(b[c]);
      row['d_' + c] = pb ? pct(b[c], pb[c]) : null;
    });
    return row;
  });

  return {
    name: name,
    revenue: n2(revenue),
    calls: calls,
    weeks: weeks,
    cards: cards,
    rows: rows
  };
}

/*
 * Build the whole report.
 *
 * opts:
 *   endWeek       ISO Monday of the latest week to include. Defaults to the
 *                 most recent COMPLETE week - never the week in progress,
 *                 which would read as a collapse in revenue rather than as
 *                 four days that have not happened yet.
 *   weeks         how many weeks in the window (default 12).
 *   locationMap   squashed source name -> display name.
 *   today         ISO date, for tests.
 */
async function buildReport(pool, opts) {
  opts = opts || {};
  var today = opts.today || new Date().toISOString().slice(0, 10);
  var count = Math.max(2, Math.min(52, parseInt(opts.weeks, 10) || DEFAULT_WEEKS));
  var endWeek = opts.endWeek && /^\d{4}-\d{2}-\d{2}$/.test(opts.endWeek)
    ? CSV.mondayOf(opts.endWeek)
    : CSV.latestCompleteWeek(today);
  var window_ = CSV.weekWindow(endWeek, count);
  var map = opts.locationMap || CSV.DEFAULT_LOCATION_MAP;

  var grouped = await loadGrouped(pool, window_[0], endWeek);

  // location -> week -> bucket, plus the same for the company.
  var byLoc = {}, company = {}, seenWeeks = {};
  window_.forEach(function (w) { company[w] = emptyWeek(); });

  grouped.forEach(function (g) {
    var loc = CSV.mapLocation(g.location_raw, map);
    if (!loc) return;
    if (!byLoc[loc]) {
      byLoc[loc] = {};
      window_.forEach(function (w) { byLoc[loc][w] = emptyWeek(); });
    }
    var b = byLoc[loc][g.week_start];
    if (!b) return;                       // outside the window; the query already excludes it
    var cls = CLASSES.indexOf(g.service_class) !== -1 ? g.service_class : CSV.CLASS_ROADSIDE;
    b[cls] = n2(b[cls] + g.revenue);
    b.total = n2(b.total + g.revenue);
    b.calls += g.calls;
    var cb = company[g.week_start];
    cb[cls] = n2(cb[cls] + g.revenue);
    cb.total = n2(cb.total + g.revenue);
    cb.calls += g.calls;
    if (g.calls > 0) seenWeeks[g.week_start] = true;
  });

  // Weeks the company actually had calls in, in window order.
  var activeWeeks = window_.filter(function (w) { return !!seenWeeks[w]; });

  var locations = Object.keys(byLoc).map(function (name) {
    return buildPage(name, byLoc[name], window_, activeWeeks);
  }).sort(function (a, b) {
    return b.revenue - a.revenue || String(a.name).localeCompare(String(b.name));
  });

  var companyPage = buildPage('All Locations', company, window_, activeWeeks);

  var byClass = {};
  CLASSES.forEach(function (c) {
    var s = 0;
    window_.forEach(function (w) { s += company[w][c]; });
    byClass[c] = n2(s);
  });

  return {
    window: {
      weeks: window_,
      first: window_[0],
      last: endWeek,
      lastEnd: CSV.addDays(endWeek, 6),
      count: count
    },
    company: companyPage,
    locations: locations,
    totals: {
      revenue: companyPage.revenue,
      calls: companyPage.calls,
      byClass: byClass,
      perCall: companyPage.calls ? n2(companyPage.revenue / companyPage.calls) : 0
    },
    meta: {
      classes: CLASSES,
      classLabels: CSV.CLASS_LABEL,
      locationMap: map,
      activeWeeks: activeWeeks,
      generatedAt: new Date().toISOString()
    }
  };
}

/* ------------------------------------------------------------- statistics */

/*
 * What has actually been ingested, for the page header and the staleness
 * warning. Separate from the report so a page can say "your newest data is 3
 * weeks old" even when the report itself renders fine.
 */
async function historySummary(pool) {
  var r = await pool.query(
    'SELECT COUNT(*)::int AS calls, ' +
    '       MIN(call_date) AS first_date, MAX(call_date) AS last_date, ' +
    '       COALESCE(SUM(revenue), 0)::float8 AS revenue, ' +
    '       COUNT(DISTINCT week_start)::int AS weeks, ' +
    '       COUNT(DISTINCT location_raw)::int AS locations ' +
    '  FROM cs_calls');
  var row = r.rows[0] || {};
  function ymd(d) {
    if (!d) return null;
    if (d instanceof Date) {
      return d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) +
        '-' + (d.getDate() < 10 ? '0' : '') + d.getDate();
    }
    return String(d).slice(0, 10);
  }
  return {
    calls: Number(row.calls) || 0,
    revenue: n2(row.revenue),
    weeks: Number(row.weeks) || 0,
    locations: Number(row.locations) || 0,
    first_date: ymd(row.first_date),
    last_date: ymd(row.last_date)
  };
}

module.exports = {
  DEFAULT_WEEKS: DEFAULT_WEEKS,
  CLASSES: CLASSES,
  n2: n2,
  pct: pct,
  emptyWeek: emptyWeek,
  buildPage: buildPage,
  loadGrouped: loadGrouped,
  buildReport: buildReport,
  historySummary: historySummary
};
