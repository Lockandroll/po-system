// "Who goes": best ETA for a call, with the mileage rule.
// Plan: claude/nova-dispatch-new-call-plan.md, step 5 (Tony, 2026-10-13).
//
// ETA for a tech = time until they are free + drive time to the call.
//   * Time until free walks their open calls in order: the one they are on
//     scene at (average on-site minutes minus time already there), then the
//     one they are driving to, then anything queued behind it. Each leg drives
//     from the previous call's point.
//   * Drive time = straight-line miles x road factor at an average city speed.
//     When a TomTom key is set, the top few candidates are re-timed with live
//     traffic (one routing call each, 2.5 s timeout, falls back on failure).
//   * Average on-site minutes per service type: Nova's own history first
//     (arrived -> done, last 90 days, 5+ calls), then Pulsar Call Data
//     onsite_mins for the matching task (180 days, 5+ calls), then a setting.
// Pick: the fastest ETA, unless someone within dispatch_ai_extra_eta_minutes (5)
// saves at least dispatch_ai_save_miles (10) miles of driving. EDU calls (and
// Tier 1 accounts unless switched off) always go to the fastest.
//
// No backticks anywhere in this file (Windows corrupts them in .js).

const { pool } = require('../db');

const OPEN = ['assigned', 'accepted', 'enroute', 'onscene'];
var _onsiteCache = { at: 0, map: {} };
var _setCache = { at: 0, map: {} };

async function settings() {
  if (Date.now() - _setCache.at < 60000) return _setCache.map;
  const keys = ['dispatch_ai_extra_eta_minutes', 'dispatch_ai_save_miles', 'dispatch_road_factor', 'dispatch_avg_mph',
    'dispatch_onsite_roadside', 'dispatch_onsite_locksmith', 'dispatch_ai_tier1_fastest', 'dispatch_ai_mode',
    'location_stale_minutes', 'location_traffic_key', 'dispatch_routing_key'];
  const r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [keys]);
  const m = {};
  r.rows.forEach(function (x) { m[x.key] = x.value; });
  _setCache = { at: Date.now(), map: m };
  return m;
}
function num(m, k, dflt, lo, hi) {
  var n = parseFloat(m[k]);
  if (!isFinite(n)) n = dflt;
  return Math.min(hi, Math.max(lo, n));
}
async function config() {
  const m = await settings();
  return {
    extraEta: num(m, 'dispatch_ai_extra_eta_minutes', 5, 0, 60),
    saveMiles: num(m, 'dispatch_ai_save_miles', 10, 0, 200),
    roadFactor: num(m, 'dispatch_road_factor', 1.3, 1, 3),
    mph: num(m, 'dispatch_avg_mph', 28, 5, 80),
    onsiteRoadside: num(m, 'dispatch_onsite_roadside', 25, 1, 480),
    onsiteLocksmith: num(m, 'dispatch_onsite_locksmith', 45, 1, 480),
    tier1Fastest: m.dispatch_ai_tier1_fastest !== '0',
    mode: ['off', 'shadow'].indexOf(m.dispatch_ai_mode) !== -1 ? m.dispatch_ai_mode : 'off',
    staleMin: num(m, 'location_stale_minutes', 10, 1, 1440),
    routingKey: m.dispatch_routing_key || m.location_traffic_key || ''
  };
}

function miles(a, b) {
  if (!a || !b || a.lat === null || b.lat === null || a.lat === undefined || b.lat === undefined) return null;
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function drive(a, b, cfg) {
  const m = miles(a, b);
  if (m === null) return null;
  const road = m * cfg.roadFactor;
  return { miles: road, minutes: road / cfg.mph * 60 };
}

// Average on-site minutes, per service type id. Cached for 30 minutes.
async function onsiteMinutes(serviceTypeId, category, cfg) {
  if (Date.now() - _onsiteCache.at > 30 * 60000) _onsiteCache = { at: Date.now(), map: {} };
  const key = String(serviceTypeId || 'none');
  if (_onsiteCache.map[key] !== undefined) return _onsiteCache.map[key];
  var val = null, src = null;
  if (serviceTypeId) {
    try {
      const r = await pool.query(
        "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - arrived_at)) / 60) AS med, COUNT(*)::int AS n " +
        "FROM dispatch_jobs WHERE service_type_id = $1 AND status = 'done' AND arrived_at IS NOT NULL AND completed_at > arrived_at " +
        "AND completed_at > NOW() - INTERVAL '90 days' AND completed_at - arrived_at < INTERVAL '8 hours'", [serviceTypeId]);
      if (r.rows[0] && r.rows[0].n >= 5) { val = Number(r.rows[0].med); src = 'nova'; }
    } catch (e) {}
    if (val === null) {
      try {
        const r2 = await pool.query(
          'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c.onsite_mins) AS med, COUNT(*)::int AS n ' +
          'FROM cd_calls c JOIN service_types st ON st.id = $1 ' +
          'WHERE c.onsite_mins BETWEEN 1 AND 480 AND c.call_date > CURRENT_DATE - 180 ' +
          'AND (LOWER(TRIM(c.task)) = LOWER(st.name) OR LOWER(TRIM(c.task)) = LOWER(st.code))', [serviceTypeId]);
        if (r2.rows[0] && r2.rows[0].n >= 5) { val = Number(r2.rows[0].med); src = 'pulsar'; }
      } catch (e) {}
    }
  }
  if (val === null) { val = category === 'roadside' ? cfg.onsiteRoadside : cfg.onsiteLocksmith; src = 'setting'; }
  const out = { minutes: Math.round(val), source: src };
  _onsiteCache.map[key] = out;
  return out;
}

// Live-traffic minutes for one leg (TomTom). null on any failure.
async function trafficMinutes(a, b, cfg) {
  if (!cfg.routingKey || typeof fetch !== 'function') return null;
  const url = 'https://api.tomtom.com/routing/1/calculateRoute/' + a.lat + ',' + a.lon + ':' + b.lat + ',' + b.lon +
    '/json?traffic=true&travelMode=car&key=' + encodeURIComponent(cfg.routingKey);
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(function () { ctl.abort(); }, 2500) : null;
  try {
    const r = await fetch(url, ctl ? { signal: ctl.signal } : {});
    if (!r.ok) return null;
    const j = await r.json();
    const s = j && j.routes && j.routes[0] && j.routes[0].summary;
    if (!s) return null;
    return { minutes: s.travelTimeInSeconds / 60, miles: s.lengthInMeters / 1609.34 };
  } catch (e) { return null; } finally { if (timer) clearTimeout(timer); }
}

// The people who could take a call: active, home city = the call's city,
// allowed that kind of work, marked ready. Same rules as /jobs/:id/assignable.
async function candidates(cityCode, category) {
  const params = [String(cityCode || '').trim()];
  var sql =
    'SELECT u.id, u.name, tl.lat, tl.lon, tl.recorded_at FROM users u ' +
    'JOIN tech_duty d ON d.user_id = u.id AND d.ready = true ' +
    'LEFT JOIN tech_locations tl ON tl.user_id = u.id ' +
    'WHERE u.active = true AND TRIM(u.home_city) = $1';
  if (category) {
    params.push(category);
    sql += ' AND EXISTS (SELECT 1 FROM user_service_categories usc WHERE usc.user_id = u.id AND usc.category_code = $2 AND usc.can_be_assigned = true)';
  }
  return (await pool.query(sql, params)).rows;
}

async function openCallsFor(userIds) {
  if (!userIds.length) return {};
  const r = await pool.query(
    'SELECT j.id, j.assigned_to, j.status, j.lat, j.lon, j.arrived_at, j.assigned_at, j.service_type_id, st.category_code ' +
    'FROM dispatch_jobs j LEFT JOIN service_types st ON st.id = j.service_type_id ' +
    'WHERE j.assigned_to = ANY($1) AND j.status = ANY($2)', [userIds, OPEN]);
  const by = {};
  const order = { onscene: 0, enroute: 1, accepted: 2, assigned: 3 };
  r.rows.forEach(function (j) { (by[j.assigned_to] = by[j.assigned_to] || []).push(j); });
  Object.keys(by).forEach(function (k) {
    by[k].sort(function (a, b) {
      return (order[a.status] - order[b.status]) || (new Date(a.assigned_at) - new Date(b.assigned_at));
    });
  });
  return by;
}

function num1(x) { return x === null || x === undefined ? null : Math.round(x * 10) / 10; }

/**
 * Rank everyone who could take a call.
 * call: { id?, lat, lon, city_code, service_type_id, category, is_edu, account_tier }
 * opts: { traffic: bool (default true), exclude_job_id }
 * -> { ranked: [{user_id, name, eta_minutes, miles, free_in, open_calls, has_fix, stale, legs}],
 *      pick: {...} | null, why: string, reason_code, mode, config }
 */
async function rank(call, opts) {
  opts = opts || {};
  const cfg = await config();
  const people = await candidates(call.city_code, call.category);
  const target = (call.lat !== null && call.lat !== undefined) ? { lat: Number(call.lat), lon: Number(call.lon) } : null;
  const queues = await openCallsFor(people.map(function (p) { return p.id; }));
  const now = Date.now();
  const out = [];
  for (const p of people) {
    const fixAge = p.recorded_at ? (now - new Date(p.recorded_at).getTime()) / 60000 : null;
    var at = (p.lat !== null && p.lat !== undefined) ? { lat: Number(p.lat), lon: Number(p.lon) } : null;
    var free = 0, chainOk = true;
    const q = (queues[p.id] || []).filter(function (j) { return j.id !== opts.exclude_job_id; });
    for (const j of q) {
      const os = await onsiteMinutes(j.service_type_id, j.category_code, cfg);
      const jp = j.lat !== null && j.lat !== undefined ? { lat: Number(j.lat), lon: Number(j.lon) } : null;
      if (j.status === 'onscene') {
        const there = j.arrived_at ? (now - new Date(j.arrived_at).getTime()) / 60000 : 0;
        free += Math.max(5, os.minutes - there);   // nobody is "about to be free" in under 5 min
      } else {
        const leg = drive(at, jp, cfg);
        if (!leg) chainOk = false;
        free += (leg ? leg.minutes : 15) + os.minutes;
      }
      if (jp) at = jp;
    }
    const leg = drive(at, target, cfg);
    out.push({
      user_id: p.id, name: p.name, open_calls: q.length, has_fix: !!(p.lat !== null && p.lat !== undefined),
      stale: fixAge !== null && fixAge > cfg.staleMin, fix_age_minutes: fixAge === null ? null : Math.round(fixAge),
      free_in: Math.round(free), drive_minutes: leg ? leg.minutes : null, miles: leg ? leg.miles : null,
      eta_minutes: leg ? free + leg.minutes : null, estimate: chainOk ? 'distance' : 'partial', _from: at
    });
  }
  // Live traffic for the closest few only - cost control (plan: top 3).
  if (target && opts.traffic !== false && cfg.routingKey) {
    const top = out.filter(function (r) { return r.eta_minutes !== null; })
      .sort(function (a, b) { return a.eta_minutes - b.eta_minutes; }).slice(0, 3);
    await Promise.all(top.map(async function (r) {
      const t = await trafficMinutes(r._from, target, cfg);
      if (t) { r.eta_minutes = r.free_in + t.minutes; r.drive_minutes = t.minutes; r.miles = t.miles; r.estimate = 'traffic'; }
    }));
  }
  out.forEach(function (r) { delete r._from; r.eta_minutes = r.eta_minutes === null ? null : Math.round(r.eta_minutes); r.miles = num1(r.miles); r.drive_minutes = r.drive_minutes === null ? null : Math.round(r.drive_minutes); });
  out.sort(function (a, b) {
    if (a.eta_minutes === null && b.eta_minutes === null) return a.open_calls - b.open_calls || a.name.localeCompare(b.name);
    if (a.eta_minutes === null) return 1;
    if (b.eta_minutes === null) return -1;
    return a.eta_minutes - b.eta_minutes || (a.miles || 0) - (b.miles || 0);
  });
  const res = { ranked: out, pick: null, why: '', reason_code: null, mode: cfg.mode,
    config: { extra_eta_minutes: cfg.extraEta, save_miles: cfg.saveMiles, traffic: !!cfg.routingKey } };
  if (!people.length) { res.why = 'Nobody in this city is ready for this kind of call.'; res.reason_code = 'nobody_ready'; return res; }
  if (!target) { res.why = 'No map point for this address yet, so there is no ETA. Pick by hand.'; res.reason_code = 'no_point'; return res; }
  const timed = out.filter(function (r) { return r.eta_minutes !== null && !r.stale; });
  if (!timed.length) { res.why = 'Nobody ready has a recent phone location, so there is no ETA.'; res.reason_code = 'no_fix'; return res; }
  const fastest = timed[0];
  var pick = fastest, code = 'fastest';
  const fastOnly = call.is_edu || (cfg.tier1Fastest && parseInt(call.account_tier, 10) === 1);
  if (!fastOnly && cfg.saveMiles > 0) {
    const alt = timed.filter(function (r) {
      return r !== fastest && r.eta_minutes <= fastest.eta_minutes + cfg.extraEta && r.miles !== null && fastest.miles !== null &&
        fastest.miles - r.miles >= cfg.saveMiles;
    }).sort(function (a, b) { return a.miles - b.miles; })[0];
    if (alt) { pick = alt; code = 'mileage'; }
  }
  res.pick = pick;
  res.reason_code = code;
  const first = String(pick.name || '').split(' ')[0];
  if (code === 'mileage') {
    res.why = first + ': ' + (pick.eta_minutes - fastest.eta_minutes) + ' min slower than ' + String(fastest.name).split(' ')[0] +
      ' but saves ' + Math.round(fastest.miles - pick.miles) + ' miles.';
  } else {
    res.why = first + ': fastest, about ' + pick.eta_minutes + ' min' +
      (pick.free_in ? ' (free in ' + pick.free_in + ', then ' + pick.drive_minutes + ' min drive)' : ' (' + pick.miles + ' mi)') +
      (call.is_edu ? '. EDU always goes to the fastest.' : (fastOnly ? '. Tier 1 goes to the fastest.' : '.'));
  }
  return res;
}

module.exports = { rank: rank, config: config, miles: miles, onsiteMinutes: onsiteMinutes, _reset: function () { _onsiteCache = { at: 0, map: {} }; _setCache = { at: 0, map: {} }; } };
