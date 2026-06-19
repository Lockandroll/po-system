// Geico ERS survey ingest + reporting orchestration (DB-aware).
// - ingestRange(): pull survey emails via Graph, resolve city from the Accounts
//   (vendors) table, and upsert into geico_surveys (dedup on po_number).
// - runWeeklyReport(): ensure the week is ingested, then email a CSV from the DB.
// - startGeicoIngest(): daily ingest (rolling 10-day window).
// - startGeicoReport(): weekly email, Mondays 13:00 UTC.

const cron = require('node-cron');
const { pool } = require('../db');
const { getSurveyMessages } = require('../utils/graph');
const {
  parseSurvey, buildCsv, getRecipients, buildEmailHtml, sendReportEmail,
  previousWeekWindow, isoDateUTC, prettyUTC
} = require('./geicoReport');

const SENDER = 'geico@et.geico.com';

function defaultMailbox(opt) {
  return (opt && opt.mailbox) || process.env.GEICO_MAILBOX || 'tony@popalockar.com';
}

// account_number (upper/trimmed) -> city_code, from the Accounts (vendors) table.
async function buildCityMap() {
  const map = {};
  try {
    const { rows } = await pool.query(
      "SELECT UPPER(TRIM(account_number)) AS acct, city_code " +
      "FROM vendors WHERE account_number IS NOT NULL AND city_code IS NOT NULL"
    );
    rows.forEach(function (r) { if (r.acct) map[r.acct] = r.city_code; });
  } catch (err) {
    console.error('[geico] buildCityMap failed:', err.message);
  }
  return map;
}

function resolveCity(map, accountNumber) {
  if (!accountNumber) return null;
  return map[accountNumber.toUpperCase().trim()] || null;
}

// Fetch + parse + upsert a UTC window [startIso, endIso).
async function ingestRange(options) {
  options = options || {};
  const mailbox = defaultMailbox(options);
  const messages = await getSurveyMessages(mailbox, SENDER, options.startIso, options.endIso);
  const cityMap = await buildCityMap();

  let upserted = 0, withCity = 0, skipped = 0;
  for (let i = 0; i < messages.length; i++) {
    const r = parseSurvey(messages[i]);
    if (!r.poNumber) { skipped++; continue; } // po_number is the dedup key
    const cityCode = resolveCity(cityMap, r.accountNumber);
    if (cityCode) withCity++;
    await pool.query(
      'INSERT INTO geico_surveys ' +
      '(po_number, account_number, city_code, service, loss_state, date_of_dispatch, ' +
      ' arrived_on_time, time_to_arrive, rating, date_received, internet_message_id) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ' +
      'ON CONFLICT (po_number) DO UPDATE SET ' +
      '  account_number=EXCLUDED.account_number, city_code=EXCLUDED.city_code, ' +
      '  service=EXCLUDED.service, loss_state=EXCLUDED.loss_state, ' +
      '  date_of_dispatch=EXCLUDED.date_of_dispatch, arrived_on_time=EXCLUDED.arrived_on_time, ' +
      '  time_to_arrive=EXCLUDED.time_to_arrive, rating=EXCLUDED.rating, ' +
      '  date_received=EXCLUDED.date_received, internet_message_id=EXCLUDED.internet_message_id, ' +
      '  updated_at=NOW()',
      [
        r.poNumber, r.accountNumber || null, cityCode, r.service || null, r.lossState || null,
        r.dateOfDispatch || null, r.arrivedOnTime || null, r.timeToArrive || null,
        r.rating || null, r.dateReceived || null, r.internetMessageId || null
      ]
    );
    upserted++;
  }
  return { mailbox: mailbox, fetched: messages.length, upserted: upserted, skipped: skipped, withCity: withCity };
}

// Query stored surveys for a [startDate, endDate) window, normalized for CSV.
async function getWeekRows(startDate, endDate) {
  const { rows } = await pool.query(
    "SELECT to_char(g.date_received,'YYYY-MM-DD') AS date_received, " +
    "       g.account_number, COALESCE(c.name,'') AS city_name, g.po_number, " +
    "       g.service, g.loss_state, to_char(g.date_of_dispatch,'MM/DD/YYYY') AS date_of_dispatch, " +
    "       g.arrived_on_time, g.time_to_arrive, g.rating " +
    "FROM geico_surveys g LEFT JOIN cities c ON c.code = g.city_code " +
    "WHERE g.date_received >= $1 AND g.date_received < $2 " +
    "ORDER BY g.date_received ASC, c.name ASC NULLS LAST",
    [startDate, endDate]
  );
  return rows.map(function (r) {
    return {
      dateReceived: r.date_received || '', accountNumber: r.account_number || '',
      cityName: r.city_name || '', poNumber: r.po_number || '', service: r.service || '',
      lossState: r.loss_state || '', dateOfDispatch: r.date_of_dispatch || '',
      arrivedOnTime: r.arrived_on_time || '', timeToArrive: r.time_to_arrive || '',
      rating: r.rating || ''
    };
  });
}

// Ingest the target week, then build + (optionally) email the CSV from the DB.
async function runWeeklyReport(options) {
  options = options || {};
  let win;
  if (options.startIso && options.endIso) {
    const s = new Date(options.startIso), e = new Date(options.endIso);
    const lastDay = new Date(e.getTime() - 86400000);
    win = {
      startIso: s.toISOString(), endIso: e.toISOString(),
      startDate: isoDateUTC(s), endDate: isoDateUTC(e),
      label: prettyUTC(s) + ' - ' + prettyUTC(lastDay), fileDate: isoDateUTC(s)
    };
  } else {
    win = previousWeekWindow(options.now || new Date());
  }

  const ingest = await ingestRange({ startIso: win.startIso, endIso: win.endIso, mailbox: options.mailbox });
  const rows = await getWeekRows(win.startDate, win.endDate);
  const csv = buildCsv(rows);
  const filename = 'geico-surveys-' + win.fileDate + '.csv';
  const subject = 'Geico ERS Survey Report - ' + win.label + ' (' + rows.length + ')';
  const recipients = options.recipients || getRecipients();

  const summary = {
    window: win.label, startDate: win.startDate, endDate: win.endDate,
    count: rows.length, withCity: ingest.withCity, filename: filename,
    recipients: recipients, ingest: ingest, csv: csv
  };
  if (options.dryRun) { summary.sent = false; return summary; }

  const csvBase64 = Buffer.from(csv, 'utf8').toString('base64');
  const html = buildEmailHtml(rows.length, win.label, filename);
  const result = await sendReportEmail(recipients, subject, html, filename, csvBase64);
  summary.sent = true;
  summary.providerId = result && result.id ? result.id : null;
  return summary;
}

function startGeicoIngest() {
  // Daily at 19:30 UTC - re-ingest a rolling 10-day window (idempotent upsert).
  cron.schedule('30 19 * * *', function () {
    const end = new Date();
    const start = new Date(end.getTime() - 10 * 86400000);
    console.log('[geico-ingest] Daily ingest ' + start.toISOString() + ' .. ' + end.toISOString());
    ingestRange({ startIso: start.toISOString(), endIso: end.toISOString() })
      .then(function (s) { console.log('[geico-ingest] upserted ' + s.upserted + ' (city ' + s.withCity + ', skipped ' + s.skipped + ')'); })
      .catch(function (err) { console.error('[geico-ingest] failed:', err.message); });
  });
  console.log('[geico-ingest] Daily ingest scheduled (19:30 UTC)');
}

function startGeicoReport() {
  // Mondays 13:00 UTC (~8 AM Central) - email the prior Mon-Sun week.
  cron.schedule('0 13 * * 1', function () {
    console.log('[geico-report] Running weekly Geico survey report...');
    runWeeklyReport()
      .then(function (s) { console.log('[geico-report] Sent ' + s.count + ' surveys (' + s.window + ') to ' + s.recipients.join(', ')); })
      .catch(function (err) { console.error('[geico-report] failed:', err.message); });
  });
  console.log('[geico-report] Weekly Geico survey report scheduled (Mondays 13:00 UTC)');
}

module.exports = {
  ingestRange, runWeeklyReport, getWeekRows, buildCityMap, resolveCity,
  startGeicoIngest, startGeicoReport
};
