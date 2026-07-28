// jobs/gotoSync.js
// Keeps the GoTo call index and the OAuth token alive.
//
// Why a scheduled indexer rather than an on-demand lookup: GoTo has no
// server-side phone filter on report-summaries (all eleven plausible parameter
// names were probed against the live account and silently ignored), so finding
// one customer on demand would mean paging the entire window at 100 calls per
// page. Nova indexes instead, and complaint lookups hit its own table.
//
// No backticks in this file (Windows clipboard safety).

'use strict';

var cron = require('node-cron');
var goto = require('../utils/goto');

// GoTo refresh tokens die after 30 days unused, and an expired one needs a human
// to reconnect. Touching it every 15 minutes makes that essentially impossible.
function startGotoTokenRefresh() {
  cron.schedule('*/15 * * * *', async function () {
    if (!goto.configured()) return;
    try {
      var s = await goto.status();
      if (!s.connected) return;
      await goto.getAccessToken(); // refreshes when it is past a third of its life
    } catch (e) {
      console.error('[gotoSync] token refresh:', e.message);
    }
  });
  console.log('GoTo token refresh scheduled (every 15 min)');
}

// Recent calls, often. Cheap: a quiet hour is one page.
function startGotoIndex() {
  cron.schedule('*/10 * * * *', async function () {
    if (!goto.configured()) return;
    try {
      var s = await goto.status();
      if (!s.connected || !s.accountKey) return;
      var stats = await goto.syncDays(1, { maxPages: 60 });
      if (stats.inserted || stats.updated) {
        console.log('[gotoSync] indexed ' + stats.inserted + ' new / ' + stats.updated + ' updated over ' + stats.pages + ' page(s)');
      }
    } catch (e) {
      console.error('[gotoSync] index:', e.message);
    }
  });
  console.log('GoTo call index scheduled (every 10 min)');
}

// A nightly re-read of the last 3 days. This is not redundant with the 10-minute
// pass: recordings and transcripts attach to a call minutes to hours AFTER it
// ends, so a call first seen without one needs looking at again. The upsert only
// ever adds a recording id, never clears one.
function startGotoReconcile() {
  cron.schedule('20 3 * * *', async function () {
    if (!goto.configured()) return;
    try {
      var s = await goto.status();
      if (!s.connected || !s.accountKey) return;
      var stats = await goto.syncDays(3, { maxPages: 200 });
      console.log('[gotoSync] nightly reconcile: ' + stats.seen + ' seen, ' + stats.inserted + ' new, ' + stats.updated + ' updated' + (stats.truncated ? ' (TRUNCATED - raise maxPages)' : ''));
    } catch (e) {
      console.error('[gotoSync] reconcile:', e.message);
    }
  });
  console.log('GoTo nightly reconcile scheduled (03:20)');
}

module.exports = { startGotoTokenRefresh: startGotoTokenRefresh, startGotoIndex: startGotoIndex, startGotoReconcile: startGotoReconcile };
