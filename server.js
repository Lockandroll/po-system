require('dotenv').config();
const express = require('express');
require('express-async-errors');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { initDB } = require('./db');
const { startReminders } = require('./jobs/reminders');
const { startGeicoReport, startGeicoIngest } = require('./jobs/geicoIngest');
const { startCleanup } = require('./jobs/cleanup');
const { startScheduledMessages } = require('./jobs/scheduledMessages');
const { startTaskReminders, startRecurringSpawner, startCompletedCleanup } = require('./jobs/taskReminders');
const { startWorkOrders } = require('./jobs/workOrders');
const { startDocExpiry } = require('./jobs/docExpiry');
const { startReviewRatings } = require('./jobs/reviewRatings');
const { startSignatureReminders } = require('./jobs/signatureReminders');
const { startTimeClock } = require('./jobs/timeclock');
const { startPtoAccrual } = require('./jobs/ptoAccrual');
const { startQuiz } = require('./jobs/quiz');
const { startInspectionReminders } = require('./jobs/inspectionReminders');

const app = express();

// Trust Railway's reverse proxy so express-rate-limit keys on the real client IP
app.set('trust proxy', 1);

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

app.use(cors());

// Inbound email webhook (Resend) - mounted before express.json so the route can
// read the raw body for Svix signature verification.
app.use('/api/inbound', require('./routes/inbound'));

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
app.get('/api/version', function (req, res) { res.json({ version: APP_VERSION }); });

app.use('/api/', generalLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/vault/challenge', vaultGateLimiter);
app.use('/api/vault/verify-gate', vaultGateLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/cities', require('./routes/cities'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/addresses', require('./routes/addresses'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/parts', require('./routes/parts'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/voice', require('./routes/voice'));
app.use('/api/sops', require('./routes/sops'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/vr', require('./routes/vr'));
app.use('/api/suggestions', require('./routes/suggestions'));
app.use('/api/running', require('./routes/running'));
app.use('/api/geico', require('./routes/geico'));
app.use('/api/deposits', require('./routes/deposits'));
app.use('/api/signoffs', require('./routes/signoffs'));
app.use('/api/scheduled', require('./routes/scheduled'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/work-orders', require('./routes/workOrders'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/timeclock', require('./routes/timeclock'));
app.use('/api/push', require('./routes/push'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/mcp', require('./routes/mcp'));
app.use('/api/addin', require('./routes/addin'));
app.use('/api/vault', require('./routes/vault'));
app.use('/api/signatures', require('./routes/signatures'));
app.use('/api/sign', require('./routes/signatures').publicRouter);
app.use('/api/pto', require('./routes/pto'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.use('/api/quiz', require('./routes/quiz'));
app.use('/api/quiz-take', require('./routes/quiz').publicRouter);
app.use('/api/ptt', require('./routes/ptt'));
app.use('/api/inspections', require('./routes/inspections'));

// OAuth 2.1 authorization server for the remote MCP (must be before the SPA catch-all)
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

app.listen(PORT, () => console.log('PO System running on port ' + PORT));

initDB()
  .then(() => {
    console.log('Database initialized');
    startReminders();
    startCleanup();
    startScheduledMessages();
    startTaskReminders();
    startRecurringSpawner();
    startCompletedCleanup();
    startWorkOrders();
    startTimeClock();
    startDocExpiry();
    startReviewRatings();
    startSignatureReminders();
    startPtoAccrual();
    startGeicoIngest();
    startGeicoReport();
    startQuiz();
    startInspectionReminders();
  })
  .catch(err => console.error('DB init error (non-fatal):', err));
