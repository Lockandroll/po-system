'use strict';
/*
 * Sync retry sweep + payload retention.
 * -------------------------------------
 * Every delivery is processed inline the moment it lands, so on a healthy day
 * this job finds nothing. It exists for the two days that are not healthy:
 *
 *   * a handler threw (partner sent a shape we did not expect, the database was
 *     briefly unavailable, a downstream API was down) and the event is waiting
 *     on its backoff, and
 *   * the process restarted between the INSERT and the inline processing. That
 *     row is 'pending' with nobody coming for it, and without this sweep it
 *     would sit there forever.
 *
 * The second case is the reason the sweep runs every minute rather than every
 * fifteen: a Railway deploy in the middle of a delivery burst is not rare.
 *
 * NOTE: no backtick characters anywhere in this file (Windows-safe per the Nova
 * editing rules).
 */

var cron = require('node-cron');
var { pool } = require('../db');
var ingest = require('../utils/webhookIngest');
var pulsarOut = require('../utils/pulsarOut');

var RETRY_CRON = process.env.SYNC_RETRY_CRON || '* * * * *';
var BATCH = Number(process.env.SYNC_RETRY_BATCH || 50);

// How long the stored copy of a payload is kept AFTER it has been successfully
// processed. The row itself (id, type, status, timings) is kept forever - it is
// tiny, and it is the record of what a partner claims they sent. Only the bulky
// raw_body / payload columns are dropped, because some partners send megabytes
// per event and a year of that is real money on Railway.
//
// 0 or unset means keep the payloads forever.
var _keep = parseInt(process.env.SYNC_PAYLOAD_RETENTION_DAYS, 10);
var PAYLOAD_RETENTION_DAYS = (!isNaN(_keep) && _keep > 0) ? _keep : 0;

var running = false;

async function sweep() {
  if (running) return;      // a slow handler must not stack up a second sweep
  running = true;
  try {
    var out = await ingest.runDue(BATCH);
    if (out.processed) console.log('[sync] retry sweep processed ' + out.processed + ' event(s)');
  } catch (err) {
    console.error('[sync] retry sweep failed: ' + err.message);
  }
  // The outbound side rides the same minute. Its own try/catch, because an
  // inbound failure must not stop us retrying a dispatch instruction and an
  // outbound failure must not stop us draining the inbound queue - the two
  // directions share a schedule, not a fate.
  try {
    if (pulsarOut.mode() !== 'off') {
      var o = await pulsarOut.runDue(25);
      if (o.claimed) console.log('[pulsar-out] retried ' + o.claimed + ' call(s), ' + o.done + ' succeeded');
    }
  } catch (err) {
    console.error('[pulsar-out] retry sweep failed: ' + err.message);
  } finally {
    running = false;
  }
}

// Nightly. Only touches rows that are finished AND old; a parked or failed
// event keeps its payload no matter how old it is, because that payload is
// exactly what a replay needs.
async function trimPayloads() {
  if (PAYLOAD_RETENTION_DAYS <= 0) return;
  try {
    var r = await pool.query(
      'UPDATE webhook_events SET raw_body = NULL, payload = NULL ' +
      "WHERE status IN ('done','skipped') AND processed_at < NOW() - make_interval(days => $1) " +
      'AND (raw_body IS NOT NULL OR payload IS NOT NULL)',
      [PAYLOAD_RETENTION_DAYS]
    );
    if (r.rowCount) console.log('[sync] trimmed payloads from ' + r.rowCount + ' event(s) older than ' + PAYLOAD_RETENTION_DAYS + ' days');
  } catch (err) {
    console.error('[sync] payload trim failed: ' + err.message);
  }
}

// Per-type traffic counters live in memory between flushes so that a firehose
// does not turn one stats row into a global write lock. A restart loses at most
// one interval of counts, which is fine for statistics and would not be fine
// for events - hence the different treatment.
async function flushStats() {
  try {
    await ingest.flushStats();
  } catch (err) {
    console.error('[sync] stats flush failed: ' + err.message);
  }
  try {
    await ingest.flushRejections();
  } catch (err) {
    console.error('[sync] rejection flush failed: ' + err.message);
  }
}

function startWebhookRetry() {
  cron.schedule(RETRY_CRON, sweep);
  cron.schedule('* * * * *', flushStats);
  cron.schedule('25 4 * * *', trimPayloads);
  console.log('[sync] retry sweep scheduled (' + RETRY_CRON + '), payload retention ' +
    (PAYLOAD_RETENTION_DAYS > 0 ? PAYLOAD_RETENTION_DAYS + ' days' : 'forever'));
}

module.exports = { startWebhookRetry: startWebhookRetry, sweep: sweep, trimPayloads: trimPayloads, flushStats: flushStats };
