'use strict';
// Completion Paperwork auto-send - API (Nova).
//
// PHASE 1 (this file today): the Settings card only - read and write the
// delivery knobs in utils/paperworkSettings.js. The queue, the job review /
// Mark Ready to Send, the send endpoints and the daily cron arrive in later
// phases; nothing here can email a customer.
//
// Gated by manage_completion_paperwork, which ships dark (admin/owner only
// until an admin grants it). See utils/permissions.js.
//
// NOTE: no backtick/template-literal strings (Windows-safe per Nova rules).

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const SET = require('../utils/paperworkSettings');

// GET /api/paperwork/settings - the delivery knobs for the Settings card.
router.get('/settings', requireAuth, requirePermission('manage_completion_paperwork'), async function (req, res) {
  try {
    res.json(await SET.getAll());
  } catch (e) {
    console.error('paperwork settings read failed:', e && e.message);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

// PUT /api/paperwork/settings - save the knobs the card sends. Only known keys
// are written, each coerced to shape.
router.put('/settings', requireAuth, requirePermission('manage_completion_paperwork'), async function (req, res) {
  try {
    const saved = await SET.saveAll(req.body || {});
    res.json(saved);
  } catch (e) {
    console.error('paperwork settings save failed:', e && e.message);
    res.status(500).json({ error: 'Could not save settings' });
  }
});

module.exports = router;
