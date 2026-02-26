const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { errorJson } = require('../middleware/errors');

const PIPELINE_STAGES = ['new_inquiry', 'contacted', 'qualified', 'proposal_sent', 'call_booked', 'call_done', 'closed_won', 'closed_lost'];

// GET /api/pipeline — leads grouped by pipeline_stage
router.get('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    if (!companyId) return errorJson(res, 401, 'UNAUTHORIZED', 'Authentication required');

    const result = await pool.query(
      `SELECT
        pipeline_stage,
        json_agg(
          json_build_object(
            'id', id,
            'name', name,
            'stage', pipeline_stage,
            'instagram_username', external_id,
            'intent_score', intent_score,
            'budget_detected', budget_detected,
            'deal_value', deal_value,
            'is_hot_lead', COALESCE(is_hot_lead, false),
            'channel', channel,
            'created_at', created_at,
            'updated_at', updated_at
          ) ORDER BY created_at DESC
        ) AS leads
       FROM leads
       WHERE company_id = $1
       GROUP BY pipeline_stage`,
      [companyId]
    );

    const stages = {};
    PIPELINE_STAGES.forEach((s) => { stages[s] = []; });
    (result.rows || []).forEach((row) => {
      const stage = row.pipeline_stage || 'new_inquiry';
      if (stages[stage] !== undefined) {
        stages[stage] = row.leads || [];
      }
    });

    res.json({ stages });
  } catch (err) {
    console.error('[pipeline]', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to load pipeline');
  }
});

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
