// utils/messageTokens.js
// Resolves dynamic date tokens in recurring task and scheduled-message text.
// Tokens use single braces to match the existing {first_name} convention.
//
// Available tokens (reference date = the day the task/message is sent, in ET):
//   {today} {tomorrow} {yesterday}
//   {prev_week}      -> previous Mon - Sun range (e.g. "Jun 22 - Jun 28")
//   {prev_week_mon}  {prev_week_sun}
//   {this_week}      -> this Mon - Sun range
//   {this_week_mon}  {this_week_sun}
//   {next_month}     -> name of next month (e.g. "July")

var TZ = 'America/New_York';

function etYmd(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function utcFromYmd(s) {
  var p = String(s).slice(0, 10).split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
}
function addDays(d, n) {
  var x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function fmt(d) {
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}
function monthName(d) {
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long' });
}

// ref may be a Date (interpreted in ET) or a 'YYYY-MM-DD' calendar string.
function dateTokenMap(ref) {
  var ymd;
  if (typeof ref === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ref)) ymd = ref.slice(0, 10);
  else ymd = etYmd(ref || new Date());
  var base = utcFromYmd(ymd);
  var dow = base.getUTCDay();                 // 0=Sun .. 6=Sat
  var offsetToMon = (dow === 0) ? -6 : (1 - dow);
  var thisMon = addDays(base, offsetToMon);   // Monday of this week
  var thisSun = addDays(thisMon, 6);
  var prevMon = addDays(thisMon, -7);
  var prevSun = addDays(thisMon, -1);
  var nextMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
  var DASH = ' – ';
  return {
    today: fmt(base),
    tomorrow: fmt(addDays(base, 1)),
    yesterday: fmt(addDays(base, -1)),
    prev_week: fmt(prevMon) + DASH + fmt(prevSun),
    prev_week_mon: fmt(prevMon),
    prev_week_sun: fmt(prevSun),
    this_week: fmt(thisMon) + DASH + fmt(thisSun),
    this_week_mon: fmt(thisMon),
    this_week_sun: fmt(thisSun),
    next_month: monthName(nextMonth)
  };
}

function resolveDateTokens(text, ref) {
  if (!text) return text;
  var map = dateTokenMap(ref);
  return String(text).replace(
    /\{(today|tomorrow|yesterday|prev_week_mon|prev_week_sun|prev_week|this_week_mon|this_week_sun|this_week|next_month)\}/g,
    function (m, key) { return (map[key] != null) ? map[key] : m; }
  );
}

module.exports = { resolveDateTokens, dateTokenMap };
