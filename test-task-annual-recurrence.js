'use strict';
/*
 * Pure-function tests for annual task recurrence (jobs/taskReminders.js).
 * No database needed -- recurNextStart/recurDueFromStart/recurAdvanceStart
 * are pure date math over an encoded month*100+day value.
 */
var assert = require('assert');
var { recurNextStart, recurDueFromStart, recurAdvanceStart } = require('./jobs/taskReminders');

var PASS = 0, FAIL = 0;
function ok(cond, label) {
  if (cond) { PASS++; }
  else { FAIL++; console.error('  FAIL: ' + label); }
}
function ymd(d) { return new Date(d).toISOString().slice(0, 10); }
function eqYmd(d, want, label) { ok(ymd(d) === want, label + '  (got ' + ymd(d) + ', want ' + want + ')'); }

// ---- recurNextStart: annual, target 3/15 (encoded 315) ----
eqYmd(recurNextStart('annual', 315, new Date(Date.UTC(2026, 8, 4))), '2027-03-15', 'next start rolls to next year when ref is past the date this year');
eqYmd(recurNextStart('annual', 315, new Date(Date.UTC(2027, 0, 1))), '2027-03-15', 'next start stays in ref year when the date has not passed yet');
eqYmd(recurNextStart('annual', 315, new Date(Date.UTC(2027, 2, 15))), '2027-03-15', 'next start returns the same day when ref lands exactly on it');

// ---- recurDueFromStart: due within/after the send cycle ----
var send315 = recurNextStart('annual', 315, new Date(Date.UTC(2027, 2, 15)));
eqYmd(recurDueFromStart('annual', 320, send315), '2027-03-20', 'due date same year when due month-day is on/after send month-day');
var sendDec20 = recurNextStart('annual', 1220, new Date(Date.UTC(2026, 8, 4)));
eqYmd(sendDec20, '2026-12-20', 'send date for a December schedule');
eqYmd(recurDueFromStart('annual', 105, sendDec20), '2027-01-05', 'due date rolls into next year when due month-day precedes send month-day');

// ---- recurAdvanceStart: always jumps a full year forward ----
eqYmd(recurAdvanceStart('annual', 315, send315), '2028-03-15', 'advance moves to the same month-day one year later');

// ---- Leap day (2/29) clamps to 2/28 in non-leap years, keeps 2/29 in leap years ----
eqYmd(recurNextStart('annual', 229, new Date(Date.UTC(2025, 0, 1))), '2025-02-28', 'Feb 29 target clamps to Feb 28 in a non-leap year');
eqYmd(recurNextStart('annual', 229, new Date(Date.UTC(2028, 0, 1))), '2028-02-29', 'Feb 29 target keeps Feb 29 in a leap year');

// ---- Existing daily/weekly/monthly behavior untouched (spot checks) ----
eqYmd(recurNextStart('daily', null, new Date(Date.UTC(2026, 8, 4))), '2026-09-04', 'daily is unaffected by the annual branch');
eqYmd(recurNextStart('monthly', 31, new Date(Date.UTC(2026, 8, 4))), '2026-09-30', 'monthly clamp-to-last-day is unaffected');

console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
