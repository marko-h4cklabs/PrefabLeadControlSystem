const express = require('express');
const router = express.Router();
const { appointmentRepository } = require('../../../db/repositories');
const { errorJson } = require('../middleware/errors');

// GET /api/calendar/appointments?upcoming=true&limit=5 — dashboard compatibility (delegates to appointments)
router.get('/appointments', async (req, res) => {
  try {
    const companyId = req.tenantId;
    if (!companyId) return errorJson(res, 401, 'UNAUTHORIZED', 'Authentication required');
    const upcoming = req.query.upcoming === 'true' || req.query.upcoming === true;
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 100);
    if (upcoming) {
      const items = await appointmentRepository.upcoming(companyId, { limit, withinDays: 30 });
      return res.json({ items });
    }
    return res.json({ items: [] });
  } catch (err) {
    console.error('[calendar/appointments]', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to load appointments');
  }
});

module.exports = router;
