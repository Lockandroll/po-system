'use strict';
/*
 * Weekly revenue report - the Monday send  (Nova)
 * -----------------------------------------------
 * Generates the rolling revenue PDF and emails it to the territory managers.
 *
 * The whole job is four lines of real work, because the generating and the
 * sending live in utils/revenueDeliver.js and are shared with the "Send it
 * now" button on the Revenue page. That sharing is the point: pressing the
 * button is a real rehearsal of the schedule, not an approximation of it.
 *
 * TIMING: 07:30 America/New_York on Mondays. The report covers the week that
 * ended the previous night, so it is complete the moment the week is - there
 * is no waiting on a nightly job. 07:30 puts it in an inbox before the first
 * dispatch of the week rather than in the middle of it.
 *
 * OFF BY DEFAULT. revenue_report_enabled starts false, so this deploys inert
 * and nobody is emailed until somebody turns it on from the Revenue page. A
 * report that starts mailing seven managers the minute the code lands is not
 * a feature.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var cron = require('node-cron');
var SET = require('../utils/revenueSettings');
var DELIVER = require('../utils/revenueDeliver');

var TZ = 'America/New_York';

async function runWeeklyRevenue() {
  try {
    if (!await SET.enabled()) {
      console.log('[revenueReport] skipped: the weekly send is turned off.');
      return;
    }
    var to = await SET.recipients();
    if (!to.length) {
      console.log('[revenueReport] skipped: no recipients configured.');
      return;
    }
    var out = await DELIVER.generate({ triggeredBy: 'schedule' });
    if (out.stale) console.warn('[revenueReport] ' + out.stale);
    if (out.sent) {
      console.log('[revenueReport] sent week ending ' + out.filename + ' to ' + out.recipients.length + ' recipient(s).');
    } else {
      console.error('[revenueReport] NOT sent: ' + (out.error || 'unknown reason'));
    }
  } catch (err) {
    // Never throw out of a cron callback: node-cron has no handler and an
    // unhandled rejection here takes the process down with it.
    console.error('[revenueReport] failed:', err && err.message ? err.message : err);
  }
}

function startRevenueReport() {
  cron.schedule('30 7 * * 1', function () {
    console.log('[revenueReport] Monday weekly revenue run…');
    runWeeklyRevenue();
  }, { timezone: TZ });
  console.log('[revenueReport] Weekly revenue report scheduled (Mondays 07:30 ' + TZ + ')');
}

module.exports = { startRevenueReport: startRevenueReport, runWeeklyRevenue: runWeeklyRevenue };
