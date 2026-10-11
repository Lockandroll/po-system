// Customer Follow-Ups report (Tony, 2026-10-11).
// Plan: claude/nova-customer-follow-up-plan.md. Screen: public/js/followups.js.
//
//   GET /api/followups/report?from=YYYY-MM-DD&to=YYYY-MM-DD&city=XXX&locksmith=ID
//
// Counts follow-ups that actually went out (review_send_status = 'sent') by the
// day they were sent, then splits them:
//   google       Google review request
//   survey_tech  survey the locksmith picked, with a reason
//   survey_auto  survey Nova picked itself (commercial job, repeat customer)
//   survey_only  account set to Survey only
// "Google %" is google / (google + survey_tech): the locksmith's own choices
// only. Automatic and account-driven surveys are shown but never counted
// against the tech. A locksmith more than followup_flag_points (25) below the
// company figure, with at least followup_flag_min (10) choices, is flagged.
//
// "Reviews posted (est.)" matches new Google reviews for a city, from the review
// feed Nova already reads (routes/reviews.js), to a Google request sent in that
// city 0 to 3 days before. Google does not say who wrote a review, so it is an
// estimate, capped at the number of requests. Null when the feed is not set up.
//
// Gate: view_followup_report (ships dark). Anyone other than admin/owner sees
// only the cities in their user_cities.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const fu = require('../utils/invoiceReviewRequest');

const router = express.Router();

function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : null; }

async function cityGroups() {
  try {
    const g = JSON.parse(await fu.getSetting('followup_city_groups', '{"Suncoast":["Tampa","Clearwater"]}'));
    return (g && typeof g === 'object' && !Array.isArray(g)) ? g : {};
  } catch (e) { return {}; }
}

function blank() {
  return { sent: 0, google: 0, survey_tech: 0, survey_auto: 0, survey_only: 0, opened: 0, google_clicks: 0, surveys_done: 0, survey_sent: 0, reasons: {}, reviews_est: null };
}
function add(b, r) {
  b.sent++;
  if (r.followup_mode === 'google') { b.google++; if (r.clicked) b.google_clicks++; }
  else if (r.followup_mode === 'survey_only') { b.survey_only++; b.survey_sent++; if (r.surveyed) b.surveys_done++; }
  else if (r.followup_mode === 'survey') {
    b.survey_sent++;
    if (r.surveyed) b.surveys_done++;
    if (r.followup_auto) b.survey_auto++;
    else { b.survey_tech++; var k = r.followup_reason || 'none'; b.reasons[k] = (b.reasons[k] || 0) + 1; }
  }
  if (r.opened) b.opened++;
}
function finish(b) {
  b.google_pct = pct(b.google, b.google + b.survey_tech);
  b.opened_pct = pct(b.opened, b.sent);
  b.google_click_pct = pct(b.google_clicks, b.google);
  b.survey_done_pct = pct(b.surveys_done, b.survey_sent);
  b.reviews_est_pct = b.reviews_est == null ? null : pct(b.reviews_est, b.google);
  return b;
}

// Reviews-feed estimate, per city code. Returns { CODE: n } or null.
async function reviewEstimate(googleRows, from, to) {
  var getPool = null;
  try { getPool = require('./reviews').getReviewsPool; } catch (e) { return null; }
  var rpool = getPool ? getPool() : null;
  if (!rpool || !googleRows.length) return rpool ? {} : null;
  var resolve = null;
  try { resolve = require('../jobs/reviewComplaints').resolveCityForLocation; } catch (e) { return null; }
  var overrides = {};
  try { overrides = JSON.parse(await fu.getSetting('review_city_map', '{}')) || {}; } catch (e) { overrides = {}; }
  var end = new Date(to + 'T00:00:00'); end.setDate(end.getDate() + 4);
  var revs;
  try {
    revs = (await rpool.query(
      "SELECT location_name, to_char(review_date, 'YYYY-MM-DD') AS d FROM reviews WHERE review_date >= $1::date AND review_date < $2::date",
      [from, ymd(end)]
    )).rows;
  } catch (e) { console.error('[followups] reviews feed:', e.message); return null; }
  var cityOf = {};
  var reqs = {};
  googleRows.forEach(function (r) { var c = r.city_code || ''; (reqs[c] = reqs[c] || []).push(ymd(new Date(r.review_sent_at))); });
  var matched = {};
  for (var i = 0; i < revs.length; i++) {
    var loc = String(revs[i].location_name || '').trim();
    if (!(loc in cityOf)) { try { cityOf[loc] = await resolve(loc, overrides); } catch (e) { cityOf[loc] = null; } }
    var c = cityOf[loc];
    if (!c || !reqs[c]) continue;
    var rd = new Date(revs[i].d + 'T00:00:00').getTime();
    var hit = reqs[c].some(function (d) { var t = new Date(d + 'T00:00:00').getTime(); return rd >= t && rd <= t + 3 * 86400000; });
    if (hit) matched[c] = (matched[c] || 0) + 1;
  }
  Object.keys(matched).forEach(function (c) { matched[c] = Math.min(matched[c], reqs[c].length); });
  return matched;
}

router.get('/report', requireAuth, requirePermission('view_followup_report'), async (req, res) => {
  try {
    var today = new Date();
    var to = validDate(req.query.to) ? req.query.to : ymd(today);
    var fromD = new Date(to + 'T00:00:00'); fromD.setDate(fromD.getDate() - 89);
    var from = validDate(req.query.from) ? req.query.from : ymd(fromD);
    var params = [from, to];
    var where = ["i.review_send_status = 'sent'", 'i.review_sent_at >= $1::date', "i.review_sent_at < ($2::date + INTERVAL '1 day')"];
    var role = req.user && req.user.role;
    if (role !== 'admin' && role !== 'owner') {
      params.push(req.user.id);
      where.push('i.city_code IN (SELECT city_code FROM user_cities WHERE user_id = $' + params.length + ')');
    }
    if (req.query.city) { params.push(String(req.query.city).toUpperCase().slice(0, 3)); where.push('i.city_code = $' + params.length); }
    if (req.query.locksmith) { params.push(parseInt(req.query.locksmith, 10) || 0); where.push('i.locksmith_id = $' + params.length); }
    const rows = (await pool.query(
      'SELECT i.id, i.city_code, i.locksmith_id, i.locksmith_name, i.followup_mode, i.followup_auto, i.followup_reason, i.review_sent_at, ' +
      "EXISTS (SELECT 1 FROM invoice_link_events e WHERE e.invoice_id = i.id AND e.kind = 'page_open') AS opened, " +
      "EXISTS (SELECT 1 FROM invoice_link_events e WHERE e.invoice_id = i.id AND e.kind = 'google_click') AS clicked, " +
      'EXISTS (SELECT 1 FROM invoice_surveys s WHERE s.invoice_id = i.id) AS surveyed ' +
      'FROM invoices i WHERE ' + where.join(' AND ') + ' ORDER BY i.review_sent_at LIMIT 50000',
      params
    )).rows;

    const cities = (await pool.query('SELECT code, name FROM cities')).rows;
    var cityName = {};
    cities.forEach(function (c) { cityName[String(c.code).trim().toUpperCase()] = c.name; });
    var groups = await cityGroups();
    var groupOf = {};
    Object.keys(groups).forEach(function (g) {
      (groups[g] || []).forEach(function (nm) {
        cities.forEach(function (c) { if (String(c.name).toLowerCase() === String(nm).toLowerCase()) groupOf[String(c.code).trim().toUpperCase()] = g; });
      });
    });
    function areaOf(code) { var c = String(code || '').trim().toUpperCase(); return groupOf[c] || cityName[c] || c || 'No city'; }

    var company = blank();
    var areas = {};
    var techs = {};
    rows.forEach(function (r) {
      add(company, r);
      var a = areaOf(r.city_code);
      add(areas[a] = areas[a] || Object.assign(blank(), { area: a, codes: {} }), r);
      areas[a].codes[String(r.city_code || '').trim().toUpperCase()] = true;
      var tk = String(r.locksmith_id || r.locksmith_name || 'unknown');
      add(techs[tk] = techs[tk] || Object.assign(blank(), { locksmith_id: r.locksmith_id, locksmith: r.locksmith_name || 'Unknown', area: a }), r);
    });

    var est = await reviewEstimate(rows.filter(function (r) { return r.followup_mode === 'google'; }), from, to);
    if (est) {
      company.reviews_est = 0;
      Object.keys(areas).forEach(function (a) {
        areas[a].reviews_est = 0;
        Object.keys(areas[a].codes).forEach(function (c) { areas[a].reviews_est += est[c] || 0; });
        company.reviews_est += areas[a].reviews_est;
      });
    }

    finish(company);
    var flagPts = parseFloat(await fu.getSetting('followup_flag_points', '25')) || 25;
    var flagMin = parseInt(await fu.getSetting('followup_flag_min', '10'), 10) || 10;
    var reasons = await fu.getReasons();
    function labelReasons(b) {
      return Object.keys(b.reasons).sort(function (x, y) { return b.reasons[y] - b.reasons[x]; })
        .map(function (k) { return { key: k, label: k === 'none' ? 'No reason given' : fu.reasonLabel(k, reasons), count: b.reasons[k] }; });
    }
    var areaList = Object.keys(areas).sort().map(function (a) { var b = finish(areas[a]); delete b.codes; b.reasons = labelReasons(b); return b; });
    var techList = Object.keys(techs).map(function (k) {
      var b = finish(techs[k]);
      b.reasons = labelReasons(b);
      var n = b.google + b.survey_tech;
      b.flag = company.google_pct != null && b.google_pct != null && n >= flagMin && b.google_pct < company.google_pct - flagPts;
      return b;
    }).sort(function (x, y) { return (x.google_pct == null ? 999 : x.google_pct) - (y.google_pct == null ? 999 : y.google_pct); });
    company.reasons = labelReasons(company);

    // Weekly Google % for the 12 weeks ending at the "to" date (company, after filters).
    var weeks = [];
    var endD = new Date(to + 'T00:00:00');
    for (var w = 11; w >= 0; w--) {
      var ws = new Date(endD); ws.setDate(ws.getDate() - (w * 7) - 6);
      var we = new Date(endD); we.setDate(we.getDate() - (w * 7));
      weeks.push({ start: ymd(ws), end: ymd(we), google: 0, survey_tech: 0 });
    }
    var weekRows = rows;
    if (from > weeks[0].start) {
      var wp = [weeks[0].start, to].concat(params.slice(2));
      weekRows = (await pool.query(
        'SELECT i.followup_mode, i.followup_auto, i.review_sent_at FROM invoices i WHERE ' + where.join(' AND ') + ' LIMIT 50000', wp
      )).rows;
    }
    weekRows.forEach(function (r) {
      var d = ymd(new Date(r.review_sent_at));
      for (var i = 0; i < weeks.length; i++) {
        if (d >= weeks[i].start && d <= weeks[i].end) {
          if (r.followup_mode === 'google') weeks[i].google++;
          else if (r.followup_mode === 'survey' && !r.followup_auto) weeks[i].survey_tech++;
          break;
        }
      }
    });
    weeks.forEach(function (x) { x.google_pct = pct(x.google, x.google + x.survey_tech); });

    res.json({
      from: from, to: to, company: company, areas: areaList, locksmiths: techList, weeks: weeks,
      reviews_feed: est !== null, flag_points: flagPts, flag_min: flagMin,
      cities: cities.map(function (c) { return { code: String(c.code).trim(), name: c.name }; })
    });
  } catch (err) {
    console.error('[followups] report:', err);
    res.status(500).json({ error: 'Failed to build the follow-up report' });
  }
});

module.exports = router;
