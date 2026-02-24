/**
 * Hot lead alerts for the current company: list mine, dismiss.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { errorJson } = require('../middleware/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/hot-leads/my — unresolved hot lead alerts for the current company only.
 */
router.get('/my', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await pool.query(
      `SELECT a.id, a.lead_id, a.company_id, a.trigger_reason, a.intent_score, a.created_at,
              l.name AS lead_name, l.channel AS lead_channel
       FROM hot_lead_alerts a
       JOIN leads l ON l.id = a.lead_id
       WHERE a.company_id = $1 AND a.dismissed_at IS NULL
       ORDER BY a.created_at DESC`,
      [companyId]
    );
    const data = (result.rows || []).map((r) => ({
      id: r.id,
      lead_id: r.lead_id,
      company_id: r.company_id,
      trigger_reason: r.trigger_reason,
      intent_score: r.intent_score,
      created_at: r.created_at,
      lead_name: r.lead_name,
      lead_channel: r.lead_channel,
    }));
    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/hot-leads/:alertId/dismiss — mark a hot lead alert as dismissed.
 */
router.post('/:alertId/dismiss', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const alertId = req.params.alertId;
    if (!alertId || !UUID_REGEX.test(alertId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid alert ID required');
    }
    const result = await pool.query(
      'UPDATE hot_lead_alerts SET dismissed_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING id',
      [alertId, companyId]
    );
    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Alert not found');
    }
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
