// Roster matcher shared by the Geico and Swoop survey pages. Moved out of
// routes/geico.js unchanged (2026-10-05) so both import the same rules.
const { pool } = require('../db');
const PC = require('./pulsarCash');

// Geico writes the technician as "Last, First" ("Benson, Chris"); Nova stores
// people as "Chris Benson". This is the same roster matcher the Pulsar cash
// import uses (routes/pulsar.js), minus the saved-override tier - there is no
// hand-kept map for Geico:
//   1. users.pulsar_name        (the field that exists precisely for this)
//   2. users.name / nickname
//   3. last name + first initial, ONLY when exactly one ACTIVE user answers to
//      it. Nova has several people sharing a last name, so "same last name"
//      alone can never match.
// Anything else stays unmatched and is stored as raw text - a wrong link is far
// worse than an unlinked name, because the leaderboard would credit the wrong
// person and nobody would know to look.
async function buildEmployeeResolver() {
  const { rows } = await pool.query('SELECT id, name, pulsar_name, nickname, active FROM users');
  const exact = {};     // squashed key -> { id, tier }
  const initial = {};   // "lastname f" -> [ids]
  const byId = {};

  function claim(key, id, tier) {
    if (!key) return;
    const prior = exact[key];
    if (!prior || tier < prior.tier) exact[key] = { id: id, tier: tier };
  }

  rows.forEach(function (row) {
    byId[row.id] = { id: row.id, name: row.name, active: row.active };
    claim(PC.squash(row.pulsar_name), row.id, 1);
    claim(PC.squash(row.name), row.id, 2);
    String(row.nickname == null ? '' : row.nickname).split(',').forEach(function (nick) {
      claim(PC.squash(nick), row.id, 2);
    });
    const forms = [row.name].concat(String(row.nickname == null ? '' : row.nickname).split(','));
    forms.forEach(function (form) {
      const toks = PC.squash(form).split(' ').filter(Boolean);
      if (toks.length < 2) return;
      const key = toks[toks.length - 1] + ' ' + toks[0].charAt(0);
      if (!initial[key]) initial[key] = [];
      if (initial[key].indexOf(row.id) === -1) initial[key].push(row.id);
    });
  });

  return {
    byId: byId,
    // Returns { user_id, name, tier } - user_id null when nobody matched.
    resolve: function (raw) {
      const nm = PC.normalizeTechName(raw);
      let best = null;
      for (let i = 0; i < nm.keys.length; i++) {
        const hit = exact[nm.keys[i]];
        if (hit && (!best || hit.tier < best.tier)) best = hit;
      }
      if (best) return { user_id: best.id, name: byId[best.id].name, tier: best.tier };
      if (nm.last && nm.first) {
        const key = PC.squash(nm.last) + ' ' + PC.squash(nm.first).charAt(0);
        const ids = (initial[key] || []).filter(function (id) { return byId[id] && byId[id].active; });
        if (ids.length === 1) return { user_id: ids[0], name: byId[ids[0]].name, tier: 3 };
      }
      return { user_id: null, name: null, tier: 99 };
    }
  };
}


module.exports = { buildEmployeeResolver: buildEmployeeResolver };
