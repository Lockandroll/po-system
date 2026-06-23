require('dotenv').config();
const express = require('express');
require('express-async-errors');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { initDB } = require('./db');
const { startReminders } = require('./jobs/reminders');
const { startGeicoReport, startGeicoIngest } = require('./jobs/geicoIngest');
const { startCleanup } = require('./jobs/cleanup');
const { startScheduledMessages } = require('./jobs/scheduledMessages');
const { startTaskReminders, startRecurringSpawner } = require('./jobs/taskReminders');
const { startWorkOrders } = require('./jobs/workOrders');

const app = express();

// Trust Railway's reverse proxy so express-rate-limit keys on the real client IP
app.set('trust proxy', 1);

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

app.use(cors());
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', generalLimiter);
app.use('/api/auth/login', loginLimiter);

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
app.use('/api/push', require('./routes/push'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/reviews', require('./routes/reviews'));

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
    startWorkOrders();
    startGeicoIngest();
    startGeicoReport();
  })
  .catch(err => console.error('DB init error (non-fatal):', err));
