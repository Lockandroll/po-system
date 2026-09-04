require('dotenv').config();
const express = require('express');
require('express-async-errors');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const { initDB } = require('./db');
const { startReminders } = require('./jobs/reminders');
const { startGeicoReport, startGeicoIngest } = require('./jobs/geicoIngest');
const { startGeicoComplaints } = require('./jobs/geicoComplaints');
const { startCleanup } = require('./jobs/cleanup');
const { startScheduledMessages } = require('./jobs/scheduledMessages');
const { startTaskReminders, startRecurringSpawner, startCompletedCleanup } = require('./jobs/taskReminders');
const { startWorkOrders } = require('./jobs/workOrders');
const { startDocExpiry } = require('./jobs/docExpiry');
const { startCoiExpiry } = require('./jobs/coiExpiry');
const { startReviewRatings } = require('./jobs/reviewRatings');
const { startReviewComplaints } = require('./jobs/reviewComplaints');
const { startSignatureReminders } = require('./jobs/signatureReminders');
const { startQuoteReminders } = require('./jobs/quoteReminders');
const { startTimeClock } = require('./jobs/timeclock');
const { startPtoAccrual } = require('./jobs/ptoAccrual');
const { startQuiz } = require('./jobs/quiz');
const { startInspectionReminders } = require('./jobs/inspectionReminders');
const { startAutoDeactivation, startQuarterlyDrill, startOffboardingCleanup } = require('./jobs/offboarding');
const { startGotoTokenRefresh, startGotoIndex, startGotoReconcile } = require('./jobs/gotoSync');
const { startLocationCleanup } = require('./jobs/locationCleanup');
const { startDispatchJobs } = require('./jobs/dispatch');
const { startArJobs } = require('./jobs/ar');
const { startApJobs } = require('./jobs/ap');
const { startWebhookRetry } = require('./jobs/webhookRetry');
const { startCheckinSweeper, startCheckinRetention } = require('./jobs/checkins');
const { startEmployeeRecords, startWinDigest, startShoutoutRelease } = require('./jobs/employeeRecords');
const { startKudosPush } = require('./jobs/kudosPush');
// Guarded on purpose. utils/jobHealth.js and routes/jobHealth.js are NEW files, and
// a new file that does not make it into the commit is how this repo has broken a
// deploy before. A diagnostics module must never be the thing that stops Nova from
// booting - that would be a cruel joke given what it is for.
let jobHealth;
try {
  jobHealth = require('./utils/jobHealth');
} catch (e) {
  console.error('[boot] utils/jobHealth.js is missing or failed to load (' + (e && e.message) +
    '). Jobs run as normal; Settings > Job Health will be empty.');
  const noop = function () {};
  jobHealth = { install: noop, beginRegister: noop, endRegister: noop,
                snapshot: function () { return []; },
                boot: function () { return { installed: false, jobs_registered: 0, crons_registered: 0 }; } };
}

const app = express();

// Trust Railway's reverse proxy so express-rate-limit keys on the real client IP
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Security headers (helmet)
// ---------------------------------------------------------------------------
// Nova had no security headers at all before 2026-08. Three of helmet's
// defaults are deliberately overridden, each because a default would break
// something real:
//
//  * frameguard (X-Frame-Options) is OFF here and applied selectively below.
//    Helmet's default SAMEORIGIN would stop Outlook from rendering the add-in
//    taskpane, which Office loads in an iframe from outlook.office.com.
//  * crossOriginResourcePolicy is 'cross-origin' so the add-in can still pull
//    its icons and assets. The default 'same-origin' would block them.
//  * contentSecurityPolicy is OFF unless CSP_ENABLED=true, because app.js
//    carries 727 inline onclick handlers. A CSP without 'unsafe-inline' would
//    take the entire UI down; see the opt-in policy below for the version that
//    still helps.
//
// Everything else is helmet's default: nosniff, HSTS, referrer policy, DNS
// prefetch control, hidePoweredBy, and friends.
app.use(helmet({
  contentSecurityPolicy: false,
  frameguard: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // includeSubDomains is deliberately OFF: popalockar.com may have subdomains
  // that are not HTTPS-only, and HSTS on a subdomain you forgot about is very
  // hard to undo (browsers cache it for the full max-age).
  hsts: { maxAge: 15552000, includeSubDomains: false, preload: false }
}));

// Clickjacking protection everywhere EXCEPT the Outlook add-in, which is
// legitimately framed by Office. /addin/* is static HTML that renders inside
// the taskpane; /api/addin/* is its API surface and is already scoped to
// add-in tokens in middleware/auth.js.
app.use(function (req, res, next) {
  var p = req.path || '';
  if (p.indexOf('/addin') !== 0 && p.indexOf('/api/addin') !== 0) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  next();
});

// Opt-in Content Security Policy. Set CSP_ENABLED=true to turn it on, and
// CSP_REPORT_ONLY=true first to watch what it WOULD block without breaking
// anything. 'unsafe-inline' on script-src is unavoidable while the inline
// onclick handlers exist, but the rest still earns its keep: it pins where
// scripts, frames and form posts may go, and kills plugin embedding outright.
if (String(process.env.CSP_ENABLED || '').toLowerCase() === 'true') {
  const reportOnly = String(process.env.CSP_REPORT_ONLY || '').toLowerCase() === 'true';
  app.use(helmet.contentSecurityPolicy({
    reportOnly: reportOnly,
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      mediaSrc: ["'self'", 'blob:', 'data:'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // Office hosts must be able to frame the add-in taskpane.
      frameAncestors: ["'self'", 'https://*.office.com', 'https://*.office365.com', 'https://*.live.com', 'https://*.microsoft.com']
    }
  }));
}

// Gzip all responses (app.js bundle + JSON payloads)
app.use(compression());

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in 15 minutes' }
});
// Strict limiter for vault unlock (fresh 2FA + password step-up) to throttle brute force.
const vaultGateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many vault unlock attempts. Try again in 15 minutes.' }
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// This used to be a bare cors(), which reflects every origin. On a Bearer-token
// API that is lower risk than it looks (no cookie is used for API auth, and
// bare cors() sends no credentials), which is exactly why this rolls out in two
// stages rather than as a hard switch on a live operations platform:
//
//   default            allow everything, but LOG each unapproved origin
//   CORS_STRICT=true   actually block unapproved origins
//
// Run on the default for a week, watch the logs and the Audit Log for
// cors_blocked rows, add anything legitimate to CORS_ORIGINS, then set
// CORS_STRICT=true. Flipping it on blind is how you discover an integration
// nobody remembered.
//
// Requests with NO Origin header are always allowed: that covers every
// server-to-server call, and blocking them would kill the Resend inbound
// webhook, Square's webhook and callback, and the Railway health check.
const CORS_STRICT = String(process.env.CORS_STRICT || '').toLowerCase() === 'true';
const corsAllowlist = (function () {
  const list = [];
  if (process.env.APP_URL) list.push(String(process.env.APP_URL).replace(/\/$/, ''));
  String(process.env.CORS_ORIGINS || '').split(',').forEach(function (o) {
    o = o.trim().replace(/\/$/, '');
    if (o) list.push(o);
  });
  return list;
})();
// Office hosts load the Outlook add-in, so they are always allowed.
const OFFICE_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(office|office365|outlook|live|microsoft|sharepoint)\.com$/i;

function corsOriginAllowed(origin) {
  if (!origin) return true;
  const clean = String(origin).replace(/\/$/, '');
  if (corsAllowlist.indexOf(clean) !== -1) return true;
  if (OFFICE_ORIGIN.test(clean)) return true;
  return false;
}

const _corsSeen = new Set();
app.use(cors({
  origin: function (origin, cb) {
    if (corsOriginAllowed(origin)) return cb(null, true);
    // Log each unapproved origin ONCE per boot so a scanner cannot flood the
    // logs, and write one audit row so it shows up where someone will see it.
    if (!_corsSeen.has(origin)) {
      _corsSeen.add(origin);
      console.warn('[cors] unapproved origin: ' + origin + (CORS_STRICT ? ' (BLOCKED)' : ' (allowed — CORS_STRICT is off)'));
      try {
        require('./utils/security').record(null, {
          event: 'cors_blocked',
          user_name: 'Nova',
          details: { origin: origin, enforced: CORS_STRICT }
        });
      } catch (e) { /* never let logging break a request */ }
    }
    return cb(null, !CORS_STRICT);
  }
}));

// Inbound email webhook (Resend) - mounted before express.json so the route can
// read the raw body for Svix signature verification.
app.use('/api/inbound', require('./routes/inbound'));

// Square Point of Sale callback + webhook - mounted here for the same reason:
// the webhook signature is computed over the RAW body, so express.json() must
// not have consumed it first. Mounting early also puts these ahead of
// generalLimiter below, hence the dedicated limiter.
const squareLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Square callbacks.' }
});
app.use('/api/square', squareLimiter, require('./routes/square'));

// Twilio voice callbacks for check-in. Mounted here for the LIMITER, not for a
// raw body: one call fires three callbacks and a burst of them should not be
// eating generalLimiter's 200/min alongside the app. The signature is verified
// over the parsed form parameters, so unlike the two above this router is happy
// with express.urlencoded.
const twilioVoiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Twilio callbacks.' }
});
app.use('/api/twilio/voice', twilioVoiceLimiter, require('./routes/twilioVoice'));

// Inbound sync receiver (Pulsar's syncer and anything after it). Mounted here
// for the same reason as the two above: utils/webhookIngest.js stores the RAW
// bytes that arrived, and express.json() would have already consumed them.
// Its own limiter because it sits ahead of generalLimiter, and a deliberately
// generous one - a partner backfilling a day of history is a burst, not abuse,
// and the endpoint can only ever append a row to webhook_events.
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.SYNC_RATE_LIMIT || 600),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'rate_limited', detail: 'Too many sync deliveries. Slow down and retry.' }
});
app.use('/api/sync/in', syncLimiter, require('./routes/sync').inboundRouter);

app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// App version — read once at startup from sw.js (the single source of truth,
// bumped each deploy). Served under /api so the service worker never caches it,
// which means the version badge always reflects the live deploy with no SW lag.
var APP_VERSION = 'unknown';
try {
  var swSrc = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8');
  var vMatch = swSrc.match(/CACHE_VERSION\s*=\s*['"]nova-([^'"]+)['"]/);
  if (vMatch) APP_VERSION = vMatch[1];
} catch (e) { console.error('Could not read app version from sw.js:', e.message); }
app.get('/api/version', async function (req, res) {
  var minVersion = '';
  try { minVersion = await require('./utils/clientVersion').minVersion(); } catch (e) { minVersion = ''; }
  res.json({ version: APP_VERSION, minVersion: minVersion });
});

app.use('/api/', generalLimiter);
app.use('/api/auth/login', loginLimiter);
// Throttle 2FA verification and password-reset requests (brute force / inbox spam).
app.use('/api/auth/verify-2fa', loginLimiter);
app.use('/api/auth/forgot-password', loginLimiter);
app.use('/api/vault/challenge', vaultGateLimiter);
app.use('/api/vault/verify-gate', vaultGateLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/cities', require('./routes/cities'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/addresses', require('./routes/addresses'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/coi', require('./routes/coi'));
app.use('/api/account-docs', require('./routes/accountDocs'));
app.use('/api/parts', require('./routes/parts'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/voice', require('./routes/voice'));
app.use('/api/sops', require('./routes/sops'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/vr', require('./routes/vr'));
app.use('/api/suggestions', require('./routes/suggestions'));
app.use('/api/running', require('./routes/running'));
app.use('/api/royalty', require('./routes/royalty'));
app.use('/api/geico', require('./routes/geico'));
app.use('/api/deposits', require('./routes/deposits'));
app.use('/api/pulsar', require('./routes/pulsar'));
// Nova -> Pulsar. Ships disarmed: PULSAR_OUT_MODE is 'off' until somebody sets
// it, so mounting this does not by itself give Nova the ability to change
// anything in their system. See utils/pulsarOut.js.
app.use('/api/pulsar-out', require('./routes/pulsarOut'));
app.use('/api/signoffs', require('./routes/signoffs'));
app.use('/api/scheduled', require('./routes/scheduled'));
try { app.use('/api/job-health', require('./routes/jobHealth')); }
catch (e) { console.error('[boot] routes/jobHealth.js not loaded (' + (e && e.message) + '); the Job Health screen will 404.'); }
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/task-templates', require('./routes/taskTemplates'));
app.use('/api/work-orders', require('./routes/workOrders'));
app.use('/api/checkins', require('./routes/checkins'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/timeclock', require('./routes/timeclock'));
app.use('/api/push', require('./routes/push'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/refunds', require('./routes/refunds'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/goto', require('./routes/goto'));
// Judi (MidTN Dispatch AI receptionist) call history for Call Lookup.
// A separate system from the GoTo index above; one contact can appear in both.
app.use('/api/judi', require('./routes/judi'));
app.use('/api/mcp', require('./routes/mcp'));
app.use('/api/addin', require('./routes/addin'));
app.use('/api/vault', require('./routes/vault'));
app.use('/api/signatures', require('./routes/signatures'));
app.use('/api/sign', require('./routes/signatures').publicRouter);
app.use('/api/pto', require('./routes/pto'));
app.use('/api/onboarding', require('./routes/onboarding'));
// Employee records - the structured half of Employee Files. Every route inside
// is behind a permission no role has yet, so on deploy only admin and owner
// can reach it (see utils/permissions.js).
app.use('/api/employee-records', require('./routes/employeeRecords'));
const offboardingRoutes = require('./routes/offboarding');
app.use('/api/offboarding', offboardingRoutes);
app.use('/api/exit-interviews', offboardingRoutes.exitInterviewRouter);
app.use('/api/quiz', require('./routes/quiz'));
app.use('/api/quiz-take', require('./routes/quiz').publicRouter);
// Customer quote approval. No JWT: everything hangs off a 64-char token on the
// quote row. The /quote/:token URL itself needs nothing - app.get('*') already
// serves the SPA, which routes on the path (see render() in public/js/app.js).
app.use('/api/quote-approve', require('./routes/quotes').publicRouter);
app.use('/api/ptt', require('./routes/ptt'));
app.use('/api/inspections', require('./routes/inspections'));
app.use('/api/assets', require('./routes/assets'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/dispatch', require('./routes/dispatch'));
// Dispatch Phase 2A/2B. Both ship dark - every route inside is behind a
// permission that no role has yet (see utils/permissions.js).
app.use('/api/service-types', require('./routes/serviceTypes'));
app.use('/api/call-search', require('./routes/callSearch'));
app.use('/api/time-codes', require('./routes/timeCodes'));
app.use('/api/coverage', require('./routes/coverage'));
app.use('/api/pay', require('./routes/pay'));
app.use('/api/ar', require('./routes/ar'));
app.use('/api/ap', require('./routes/ap'));
app.use('/api/sync', require('./routes/sync'));
// Release of Liability. Mounted twice, like the signatures module: the authed
// router for staff, and a public token router for the customer signing page.
// The /release/:token URL itself needs no route - app.get('*') already serves the
// SPA, which routes on the path (see render() in public/js/app.js).
//
// Ships dark: every authed route is behind a permission no role has yet.
app.use('/api/releases', require('./routes/releases'));
app.use('/api/release', require('./routes/releases').publicRouter);

// OAuth 2.1 authorization server for the remote MCP (must be before the SPA catch-all).
//
// These paths sit on '/', NOT under '/api/', so generalLimiter above never saw
// them: until 2026-08 /oauth/register, /oauth/authorize and /oauth/token had NO
// rate limit of any kind. /oauth/authorize POST is a full password prompt, and
// /oauth/register creates a permanent database row while being unauthenticated
// by protocol design (RFC 7591).
const oauthRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,   // a real client registers once, ever
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', error_description: 'Too many client registrations. Try again later.' }
});
const oauthAuthorizeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,   // matches the login limiter's intent; a couple of retries is normal
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', error_description: 'Too many connection attempts. Try again in 15 minutes.' }
});
const oauthTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Access tokens last an hour, so a healthy client refreshes about once an
  // hour. 120 per 15 minutes leaves enormous headroom for several connected
  // clients behind one NAT while still capping a grinder.
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', error_description: 'Too many token requests.' }
});
app.use('/oauth/register', oauthRegisterLimiter);
app.use('/oauth/authorize', oauthAuthorizeLimiter);
app.use('/oauth/token', oauthTokenLimiter);
app.use('/', require('./routes/oauth'));

// Unknown API routes return JSON 404 instead of the SPA shell
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => console.log('PO System running on port ' + PORT));

// ---------------------------------------------------------------------------
// Expect: 100-continue
// ---------------------------------------------------------------------------
// .NET / WCF clients send headers with 'Expect: 100-continue' and then WAIT for
// a '100 Continue' before transmitting a single byte of the body. If that
// interim response never reaches them, they sit there until their own timeout
// and abort - the server sees a request whose Content-Length was announced and
// whose body never arrived:
//
//     BadRequestError: request aborted   expected: 3787, received: 0
//
// Node already answers this automatically when nothing is listening for
// 'checkContinue'. This handler exists for two reasons anyway:
//
//   1. It makes the behaviour explicit and reviewable rather than implicit.
//   2. It LOGS it. Without this there is no way to tell, from inside the app,
//      whether a partner is even getting that far - which cost an evening.
//
// It cannot fix a proxy in front of us that swallows the 1xx response. If these
// log lines appear and the partner still times out, the interim response is
// being eaten upstream and the fix has to be on their side
// (ServicePointManager.Expect100Continue = false).
let _continueSeen = 0;
let _continueLoggedAt = 0;
server.on('checkContinue', function (req, res) {
  _continueSeen++;
  const now = Date.now();
  // Throttled to once a minute: a syncer that uses this sends it on every
  // request, and the log is not the place to count them.
  if (now - _continueLoggedAt > 60000) {
    _continueLoggedAt = now;
    console.log('[http] Expect: 100-continue from ' +
      ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress) +
      ' for ' + req.method + ' ' + req.url + ' (' + _continueSeen + ' so far) - answering 100 Continue');
  }
  res.writeContinue();
  app(req, res);
});

// Scheduled jobs used to live INSIDE initDB().then(...), which meant one failing
// migration statement silently disabled every timer in Nova: work order intake, task
// reminders, the time clock, PTO accrual, GEICO, AR/AP, webhook retry, all of it. The
// site kept serving pages perfectly, so nothing looked wrong from the outside. Hit in
// production 2026-08-18 by a duplicate key in the webhook_events back-fill (see db.js).
//
// Jobs now start whether or not the migrations finished, and each one is isolated so a
// single scheduler throwing on startup cannot take the rest down with it.
//
// Each start is also bracketed by utils/jobHealth, which wraps node-cron so every
// timer registered in here is attributed to the scheduler that created it and
// records its own last run. That is what feeds Settings > Job Health, and it is
// the thing that would have made this outage visible on day one instead of day five.
let _jobsStarted = false;
function _startJob(name, fn) {
  jobHealth.beginRegister(name);
  try {
    fn();
    jobHealth.endRegister(name, null);
  } catch (e) {
    const msg = (e && e.message ? e.message : String(e));
    console.error('[boot] scheduled job failed to start: ' + name + ' (' + msg + ')');
    jobHealth.endRegister(name, msg);
  }
}
function startScheduledJobs() {
  if (_jobsStarted) return;
  _jobsStarted = true;
  // Must happen before the first _startJob: it patches the cron module the job
  // files already hold a reference to, and only calls made after this are seen.
  try { jobHealth.install(); }
  catch (e) { console.error('[boot] job health tracking unavailable: ' + (e && e.message)); }
  _startJob('startReminders', startReminders);
  _startJob('startCleanup', startCleanup);
  _startJob('startScheduledMessages', startScheduledMessages);
  _startJob('startTaskReminders', startTaskReminders);
  _startJob('startRecurringSpawner', startRecurringSpawner);
  _startJob('startCompletedCleanup', startCompletedCleanup);
  _startJob('startWorkOrders', startWorkOrders);
  _startJob('startTimeClock', startTimeClock);
  _startJob('startDocExpiry', startDocExpiry);
  _startJob('startCoiExpiry', startCoiExpiry);
  _startJob('startReviewRatings', startReviewRatings);
  _startJob('startReviewComplaints', startReviewComplaints);
  _startJob('startSignatureReminders', startSignatureReminders);
  _startJob('startQuoteReminders', startQuoteReminders);
  _startJob('startPtoAccrual', startPtoAccrual);
  _startJob('startGeicoIngest', startGeicoIngest);
  _startJob('startGeicoReport', startGeicoReport);
  _startJob('startGeicoComplaints', startGeicoComplaints);
  _startJob('startQuiz', startQuiz);
  _startJob('startInspectionReminders', startInspectionReminders);
  _startJob('startAutoDeactivation', startAutoDeactivation);
  _startJob('startQuarterlyDrill', startQuarterlyDrill);
  _startJob('startOffboardingCleanup', startOffboardingCleanup);
  _startJob('startGotoTokenRefresh', startGotoTokenRefresh);
  _startJob('startGotoIndex', startGotoIndex);
  _startJob('startGotoReconcile', startGotoReconcile);
  _startJob('startLocationCleanup', startLocationCleanup);
  _startJob('startDispatchJobs', startDispatchJobs);
  _startJob('startArJobs', startArJobs);
  _startJob('startApJobs', startApJobs);
  _startJob('startWebhookRetry', startWebhookRetry);
  _startJob('startCheckinSweeper', startCheckinSweeper);
  _startJob('startCheckinRetention', startCheckinRetention);
  _startJob('startEmployeeRecords', startEmployeeRecords);
  _startJob('startWinDigest', startWinDigest);
  // NOT through _startJob: that registers a Settings > Job Health row, and this
  // is a one-shot boot task with no schedule - it would sit on that board
  // forever as a job that has never run.
  try { startShoutoutRelease(); }
  catch (e) { console.error('[boot] shout-out release failed to schedule: ' + (e && e.message)); }
  _startJob('startKudosPush', startKudosPush);
  console.log('[boot] scheduled jobs started (' + 36 + ')');
}

initDB()
  .then(() => {
    console.log('Database initialized');
  })
  .catch(err => {
    console.error('DB init error (non-fatal):', err);
    console.error('[boot] MIGRATIONS DID NOT FINISH. Scheduled jobs are starting anyway; any that ' +
      'depend on a table the failed statement was meant to create may error. Fix the error above and redeploy.');
  })
  .then(startScheduledJobs);
