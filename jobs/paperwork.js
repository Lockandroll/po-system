'use strict';
/*
 * Completion Paperwork - the daily send (Nova)
 * --------------------------------------------
 * Runs every 15 minutes and fires the batch once per day at or after the
 * configured send time (America/New_York), guarded by a last-run date so a
 * restart still catches up and never double-sends. OFF by default
 * (completion_send_enabled = false), so this deploys inert.
 *
 * The generating and sending live in utils/paperworkDeliver.js and are shared
 * with the Send now / Run batch buttons, so pressing a button is a real
 * rehearsal of the schedule.
 *
 * NOTE: no backtick/template-literal strings (Windows-safe per Nova rules).
 */
var cron = require('node-cron');
var SET = require('../utils/paperworkSettings');
var DELIVER = require('../utils/paperworkDeliver');
var QUEUE = require('../utils/paperworkQueue');

var TZ = 'America/New_York';
var LAST_RUN_KEY = 'completion_last_run_date';
var STALE_RUN_KEY = 'completion_stale_last_date';

function etDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function etHM() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

async function tick() {
  try {
    if (!(await SET.enabled())) return;
    var sendTime = await SET.sendTime();
    if (etHM() < sendTime) return;
    var today = etDateStr();
    if ((await SET.get(LAST_RUN_KEY, '')) === today) return;
    await SET.put(LAST_RUN_KEY, today);
    console.log('[paperwork] running daily batch for ' + today + ' (send time ' + sendTime + ' ' + TZ + ')');
    var out = await DELIVER.runBatch({ triggeredBy: 'schedule' });
    console.log('[paperwork] batch done: ' + out.sent + ' sent, ' + out.failed + ' failed of ' + out.total);
  } catch (err) {
    console.error('[paperwork] tick failed:', err && err.message ? err.message : err);
  }
}

// Stale-job reminder. Independent of completion_send_enabled on purpose: jobs
// piling up in Needs Review is worth knowing about before the auto-send is on.
// Business days only (no weekends, nothing in the holidays table), once a day
// at or after completion_stale_time, guarded by a last-run date like the batch.
async function staleTick() {
  try {
    var days = await SET.staleDays();
    if (!days) return;
    var today = etDateStr();
    var dow = new Date(today + 'T12:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6) return;
    var hol = await QUEUE.holidaySet();
    if (hol[today]) return;
    var at = SET.normTime(await SET.get('completion_stale_time', '08:00'), '08:00');
    if (etHM() < at) return;
    if ((await SET.get(STALE_RUN_KEY, '')) === today) return;
    await SET.put(STALE_RUN_KEY, today);
    var out = await DELIVER.staleDigest({});
    console.log('[paperwork] stale digest: ' + (out.jobs ? out.jobs.length : 0) + ' job(s), ' + (out.sent ? 'emailed' : ('not emailed' + (out.skipped ? ' (' + out.skipped + ')' : ''))));
  } catch (err) {
    console.error('[paperwork] stale tick failed:', err && err.message ? err.message : err);
  }
}

function startPaperworkSender() {
  cron.schedule('*/15 * * * *', function () { tick(); staleTick(); }, { timezone: TZ });
  console.log('[paperwork] completion-paperwork sender scheduled (every 15m, fires at the configured time, ' + TZ + ')');
}

module.exports = { startPaperworkSender: startPaperworkSender, tick: tick, staleTick: staleTick };
