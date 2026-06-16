require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const { startReminders } = require('./jobs/reminders');

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/cities', require('./routes/cities'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/addresses', require('./routes/addresses'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/vr', require('./routes/vr'));
app.use('/api/suggestions', require('./routes/suggestions'));

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
  })
  .catch(err => console.error('DB init error (non-fatal):', err));
