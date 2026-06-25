// lib/diag.js
// Tiny in-memory ring buffer for diagnosing the MCP/OAuth connect flow.
// Records the last ~120 events; exposed (no secrets) via GET /oauth/debug.
// Safe to remove once the connector flow is confirmed working.

var events = [];

function log(msg) {
  var line = new Date().toISOString() + ' ' + msg;
  events.push(line);
  if (events.length > 120) events.shift();
  try { console.log(line); } catch (e) {}
}

function getEvents() { return events.slice(); }

module.exports = { log: log, getEvents: getEvents };
