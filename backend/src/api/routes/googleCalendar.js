const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { companyRepository } = require('../../../db/repositories');
const googleCalendarService = require('../../services/googleCalendarService');
const { errorJson } = require('../middleware/errors');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');

// Public: OAuth callback (no auth — Google redirects here with code)
router.get('/callback', async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state; // companyId
    if (!code || !state) {
      const base = (process.env.FRONTEND_ORIGIN?.split(',')[0]?.trim() || '/').replace(/\/$/, '');
      return res.redirect(`${base}/settings?google=error&message=missing_params`);
    }
    const tokens = await googleCalendarService.getTokensFromCode(code);
    await googleCalendarService.updateCompanyGoogleTokens(state, tokens);
    const redirectBase = process.env.FRONTEND_ORIGIN?.split(',')[0]?.trim() || '/';
    return res.redirect(`${redirectBase.replace(/\/$/, '')}/settings?google=connected`);
  } catch (err) {
    console.error('[google/callback]', err.message);
    const redirectBase = process.env.FRONTEND_ORIGIN?.split(',')[0]?.trim() || '/';
    return res.redirect(`${redirectBase.replace(/\/$/, '')}/settings?google=error`);
  }
});

// Protected routes below
router.use(authMiddleware, tenantMiddleware);

// GET /api/integrations/google/auth — returns auth URL for frontend redirect
router.get('/auth', async (req, res) => {
  try {
    const companyId = req.tenantId;
    if (!companyId) return errorJson(res, 401, 'UNAUTHORIZED', 'Authentication required');
    const authUrl = googleCalendarService.getAuthUrl(companyId);
    return res.json({ auth_url: authUrl });
  } catch (err) {
    console.error('[google/auth]', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to get auth URL');
  }
});

// DELETE /api/integrations/google/disconnect — clear Google tokens
router.delete('/disconnect', async (req, res) => {
  try {
    const companyId = req.tenantId;
    if (!companyId) return errorJson(res, 401, 'UNAUTHORIZED', 'Authentication required');
    await pool.query(
      `UPDATE companies SET
        google_access_token = NULL,
        google_refresh_token = NULL,
        google_token_expiry = NULL,
        google_calendar_connected = false
       WHERE id = $1`,
      [companyId]
    );
    return res.json({ disconnected: true });
  } catch (err) {
    console.error('[google/disconnect]', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to disconnect');
  }
});

// GET /api/integrations/google/status
router.get('/status', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const company = await companyRepository.findById(companyId);
    const connected = company?.google_calendar_connected === true;
    if (!connected) {
      return res.json({ connected: false, calendar_id: null, upcoming_events_count: 0 });
    }
    const fullCompany = (await pool.query('SELECT id, google_calendar_id, google_access_token, google_refresh_token, google_token_expiry FROM companies WHERE id = $1', [companyId])).rows[0];
    let upcomingCount = 0;
    try {
      const events = await googleCalendarService.getUpcomingEvents(
        { ...fullCompany, google_calendar_id: fullCompany?.google_calendar_id || 'primary' },
        7
      );
      upcomingCount = events.length;
    } catch (_) {
      // ignore
    }
    return res.json({
      connected: true,
      calendar_id: company.google_calendar_id || 'primary',
      upcoming_events_count: upcomingCount,
    });
  } catch (err) {
    console.error('[google/status]', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to get status');
  }
});

// GET /api/integrations/google/upcoming — upcoming events for dashboard
router.get('/upcoming', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const company = await companyRepository.findById(companyId);
    if (!company?.google_calendar_connected) {
      return res.json({ items: [] });
    }
    const fullRow = (await pool.query(
      'SELECT id, google_calendar_id, google_access_token, google_refresh_token, google_token_expiry FROM companies WHERE id = $1',
      [companyId]
    )).rows[0];
    const events = await googleCalendarService.getUpcomingEvents(fullRow, 7);
    return res.json({ items: events });
  } catch (err) {
    console.error('[google/upcoming]', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to get upcoming events');
  }
});

// GET /api/integrations/google/busy?date=YYYY-MM-DD
router.get('/busy', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const dateStr = req.query.date; // YYYY-MM-DD
    if (!dateStr) return errorJson(res, 400, 'VALIDATION_ERROR', 'date (YYYY-MM-DD) required');
    const company = await companyRepository.findById(companyId);
    if (!company?.google_calendar_connected) {
      return res.json({ busy: [] });
    }
    const fullRow = (await pool.query(
      'SELECT id, google_calendar_id, google_access_token, google_refresh_token, google_token_expiry FROM companies WHERE id = $1',
      [companyId]
    )).rows[0];
    const busy = await googleCalendarService.getBusySlots(fullRow, dateStr);
    return res.json({ busy });
  } catch (err) {
    console.error('[google/busy]', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to get busy slots');
  }
});

module.exports = router;
