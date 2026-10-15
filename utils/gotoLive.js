// Live GoTo calls for the New call screen (Tony 2026-10-14: no pop-over while
// a dispatcher is on the phone; let them pick the call they are on from a list).
//
// GoTo's Call Events API sends call states (STARTING / ACTIVE / ENDING) to the
// notification channel Nova already owns for recordings. This file:
//   * subscribes the account to those states (one admin button),
//   * turns each state into a goto_live_calls row (caller, dialed line, who
//     answered, ringing / on the call / ended),
//   * lists the recent ones for the New call screen.
// Field names come from developer.goto.com "How to subscribe to and get call
// events"; the payload is read permissively because GoTo's shapes drift.
// No backticks anywhere in this file (Windows corrupts them in .js).

const { pool } = require('../db');

function digits(v) {
  var d = String(v || '').replace(/[^0-9]/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  return d;
}

// Find the call-state object wherever the notification wraps it.
function findState(node, depth) {
  depth = depth || 0;
  if (!node || typeof node !== 'object' || depth > 5) return null;
  if (node.metadata && node.metadata.conversationSpaceId && node.state && typeof node.state === 'object') return node;
  var keys = Object.keys(node);
  for (var i = 0; i < keys.length; i++) {
    var hit = findState(node[keys[i]], depth + 1);
    if (hit) return hit;
  }
  return null;
}
function isCallEvent(payload) { return !!findState(payload); }

function ptype(p) { return String((p && p.type && (p.type.value || p.type)) || '').toUpperCase(); }
function pstatus(p) { return String((p && p.status && (p.status.value || p.status)) || '').toUpperCase(); }

// Pull caller / dialed line / answering person out of the participants.
// ourLines: digits of our own GoTo numbers (Dispatch settings), when known.
function parse(ev, ourLines) {
  ourLines = ourLines || {};
  var st = ev.state || {}, md = ev.metadata || {};
  var parts = Array.isArray(st.participants) ? st.participants : [];
  var numbers = [];   // { digits, name, ours }
  var lines = [];     // { ext, name, status }
  function addNum(n, name, oursHint) {
    var d = digits(n);
    if (d.length < 7) return;
    if (numbers.some(function (x) { return x.digits === d; })) return;
    numbers.push({ digits: d, name: name || null, ours: !!ourLines[d] || !!oursHint });
  }
  parts.forEach(function (p) {
    var t = ptype(p);
    var ty = (p && p.type) || {};
    if (t === 'LINE' || t === 'EXTENSION' || t === 'USER') {
      lines.push({ ext: ty.extensionNumber || p.extensionNumber || null, name: ty.name || p.name || null, status: pstatus(p) });
    } else {
      // PHONE_NUMBER participants. A phoneNumberId means the number is one of ours.
      var ours = !!(ty.phoneNumberId || p.phoneNumberId);
      addNum(ty.number || p.number, ty.name || p.name, ours);
      var callee = ty.callee || p.callee, caller = ty.caller || p.caller;
      if (caller) addNum(caller.number, caller.name, false);
      if (callee) addNum(callee.number, callee.name, false);
    }
  });
  var dialed = numbers.filter(function (n) { return ourLines[n.digits]; })[0] ||
    (numbers.length > 1 ? numbers.filter(function (n) { return n.ours; })[0] : null) || null;
  var caller = numbers.filter(function (n) { return !dialed || n.digits !== dialed.digits; }).filter(function (n) { return !ourLines[n.digits]; })[0] || null;
  var answered = lines.filter(function (l) { return /CONNECTED|ACTIVE|ANSWERED|TALKING/.test(l.status); })[0] || null;
  var type = String(st.type || '').toUpperCase();
  var ended = type === 'ENDING' || type === 'ENDED' || /^(ENDED|DISCONNECTED|COMPLETED)$/.test(String(st.status || '').toUpperCase());
  return {
    conversation_space_id: String(md.conversationSpaceId),
    direction: md.direction ? String(md.direction).toUpperCase().slice(0, 16) : null,
    seq: parseInt(st.sequenceNumber, 10) || 0,
    caller_digits: caller ? caller.digits : null,
    caller_name: caller && caller.name ? String(caller.name).slice(0, 120) : null,
    dialed_digits: dialed ? dialed.digits : null,
    answered_ext: answered && answered.ext ? String(answered.ext).slice(0, 16) : null,
    answered_name: answered && answered.name ? String(answered.name).slice(0, 120) : null,
    ringing: lines.filter(function (l) { return /RING|ALERT|OFFER/.test(l.status); }).map(function (l) { return l.name || l.ext; }).filter(Boolean).slice(0, 6),
    state: ended ? 'ended' : (answered ? 'active' : 'ringing'),
    created: md.callCreated || st.timestamp || null
  };
}

async function ourLineMap() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'dispatch_goto_lines'");
    const out = {};
    String((r.rows[0] && r.rows[0].value) || '').split(/\r?\n/).forEach(function (ln) {
      var m = /^\s*([0-9]{7,})\s*=/.exec(ln.replace(/[^0-9= A-Za-z]/g, ''));
      if (m) out[digits(m[1])] = 1;
    });
    return out;
  } catch (e) { return {}; }
}

// One call state in. Out-of-order states never move a call backwards.
async function ingest(payload) {
  const ev = findState(payload);
  if (!ev) return { ok: false, reason: 'not_a_call_event' };
  const p = parse(ev, await ourLineMap());
  if (p.direction === 'OUTBOUND') return { ok: true, skipped: 'outbound' };
  await pool.query(
    'INSERT INTO goto_live_calls (conversation_space_id, direction, caller_digits, caller_name, dialed_digits, answered_ext, answered_name, ' +
    '  ringing, state, seq, started_at, answered_at, ended_at, updated_at) ' +
    // $9 is cast: it is used as a value and inside the CASEs (Postgres 42P08 otherwise).
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::varchar,$10,COALESCE($11::timestamptz, NOW()), CASE WHEN $9::varchar = 'active' THEN NOW() END, CASE WHEN $9::varchar = 'ended' THEN NOW() END, NOW()) " +
    'ON CONFLICT (conversation_space_id) DO UPDATE SET ' +
    '  direction = COALESCE(goto_live_calls.direction, EXCLUDED.direction), ' +
    '  caller_digits = COALESCE(goto_live_calls.caller_digits, EXCLUDED.caller_digits), ' +
    '  caller_name = COALESCE(goto_live_calls.caller_name, EXCLUDED.caller_name), ' +
    '  dialed_digits = COALESCE(goto_live_calls.dialed_digits, EXCLUDED.dialed_digits), ' +
    '  answered_ext = COALESCE(EXCLUDED.answered_ext, goto_live_calls.answered_ext), ' +
    '  answered_name = COALESCE(EXCLUDED.answered_name, goto_live_calls.answered_name), ' +
    '  ringing = CASE WHEN EXCLUDED.seq >= goto_live_calls.seq THEN EXCLUDED.ringing ELSE goto_live_calls.ringing END, ' +
    "  state = CASE WHEN goto_live_calls.state = 'ended' THEN 'ended' WHEN EXCLUDED.seq >= goto_live_calls.seq OR EXCLUDED.state = 'ended' THEN EXCLUDED.state ELSE goto_live_calls.state END, " +
    '  seq = GREATEST(goto_live_calls.seq, EXCLUDED.seq), ' +
    "  answered_at = COALESCE(goto_live_calls.answered_at, CASE WHEN EXCLUDED.state = 'active' THEN NOW() END), " +
    "  ended_at = COALESCE(goto_live_calls.ended_at, CASE WHEN EXCLUDED.state = 'ended' THEN NOW() END), " +
    '  updated_at = NOW()',
    [p.conversation_space_id, p.direction, p.caller_digits, p.caller_name, p.dialed_digits, p.answered_ext, p.answered_name,
      p.ringing.join(', ') || null, p.state, p.seq, p.created]);
  return { ok: true, state: p.state };
}

// Recent inbound calls for the New call list: still ringing or on the line,
// or ended in the last 10 minutes, and not already turned into a call.
async function recent() {
  try { await pool.query("DELETE FROM goto_live_calls WHERE updated_at < NOW() - INTERVAL '2 days'"); } catch (e) {}
  const r = await pool.query(
    'SELECT * FROM goto_live_calls WHERE used_job_id IS NULL AND caller_digits IS NOT NULL ' +
    "AND started_at > NOW() - INTERVAL '45 minutes' " +
    "AND (state <> 'ended' OR ended_at > NOW() - INTERVAL '10 minutes') " +
    "ORDER BY (state = 'ended'), started_at DESC LIMIT 20");
  return r.rows;
}

// Connect: ask GoTo to send live call states to the channel Nova already has.
async function subscribe() {
  const goto = require('./goto');
  const w = await pool.query('SELECT channel_id FROM goto_webhook WHERE id = 1');
  const channelId = w.rows.length ? w.rows[0].channel_id : null;
  if (!channelId) throw new Error('GoTo notifications are not connected yet. Connect them in Settings, Integrations, GoTo first.');
  const acct = await goto.resolveAccountKey();
  if (!acct) throw new Error('No GoTo account key. Set it in Settings, Integrations, GoTo first.');
  var resp, note;
  try {
    resp = await goto.gotoFetch('/call-events/v1/subscriptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, retries: 0,
      body: JSON.stringify({ channelId: channelId, accountKeys: [{ id: String(acct), events: ['STARTING', 'ACTIVE', 'ENDING'] }] })
    });
    note = JSON.stringify(resp).slice(0, 600);
  } catch (e) {
    if (/CONFLICT|already/i.test(e.message)) { note = 'already subscribed'; }
    else throw e;
  }
  const acc = resp && Array.isArray(resp.accountKeys) ? resp.accountKeys[0] : null;
  if (acc && acc.status && Number(acc.status) >= 400 && !/CONFLICT|already/i.test(String(acc.message || ''))) {
    throw new Error('GoTo refused the subscription: ' + (acc.message || acc.status));
  }
  await pool.query("INSERT INTO settings (key, value) VALUES ('dispatch_goto_live', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify({ at: new Date().toISOString(), channel: String(channelId), note: note })]);
  return { ok: true, note: note };
}

async function status() {
  var sub = null;
  try {
    const s = await pool.query("SELECT value FROM settings WHERE key = 'dispatch_goto_live'");
    sub = s.rows.length ? JSON.parse(s.rows[0].value) : null;
  } catch (e) { sub = null; }
  var last = null, today = 0;
  try {
    const r = await pool.query("SELECT MAX(updated_at) AS last, COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '1 day')::int AS n FROM goto_live_calls");
    last = r.rows[0].last; today = r.rows[0].n;
  } catch (e) {}
  return { connected: !!sub, subscribed_at: sub ? sub.at : null, last_event_at: last, calls_24h: today };
}

module.exports = { isCallEvent: isCallEvent, findState: findState, parse: parse, ingest: ingest, recent: recent,
  subscribe: subscribe, status: status, digits: digits };
