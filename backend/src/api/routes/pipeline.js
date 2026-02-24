const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { errorJson } = require('../middleware/errors');

// GET /api/pipeline/stats — stage counts for dashboard (New, Qualified, Booked, Won)
router.get('/stats', async (req, res) => {
  try {
    const companyId = req.tenantId;
    if (!companyId) return errorJson(res, 401, 'UNAUTHORIZED', 'Authentication required');

    const result = await pool.query(
      `SELECT COALESCE(pipeline_stage, status) AS stage, COUNT(*)::int AS count
       FROM leads
       WHERE company_id = $1
       GROUP BY COALESCE(pipeline_stage, status)`,
      [companyId]
    );
    const byStage = {};
    (result.rows || []).forEach((r) => {
      const s = r.stage || 'new';
      byStage[s] = (byStage[s] || 0) + r.count;
    });
    const summary = {
      new: (byStage['new'] || 0) + (byStage['contacted'] || 0),
      qualified: byStage['qualified'] || 0,
      booked: (byStage['call_booked'] || 0) + (byStage['booked'] || 0),
      won: byStage['closed_won'] || 0,
    };
    res.json({ by_stage: byStage, summary, total: Object.values(byStage).reduce((a, b) => a + b, 0) });
  } catch (err) {
    console.error('[pipeline/stats]', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to load pipeline stats');
  }
});

module.exports = router;
