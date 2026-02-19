const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { analyticsSnapshotRepository } = require('../../../db/repositories');
const { requireRole } = require('../middleware/auth');
const { errorJson } = require('../middleware/errors');

router.post(
  '/snapshot',
  requireRole('owner', 'admin'),
  async (req, res) => {
    try {
      const companyId = req.tenantId;
      const snapshotDate = new Date().toISOString().slice(0, 10);

      const metricsResult = await pool.query(
        `SELECT
          (SELECT jsonb_object_agg(status, cnt) FROM (
            SELECT status, COUNT(*)::int AS cnt
            FROM leads WHERE company_id = $1
            GROUP BY status
          ) s) AS by_status,
          (SELECT jsonb_object_agg(channel, cnt) FROM (
            SELECT channel, COUNT(*)::int AS cnt
            FROM leads WHERE company_id = $1
            GROUP BY channel
          ) c) AS by_channel,
          (SELECT COUNT(*)::int FROM leads WHERE company_id = $1 AND created_at::date = CURRENT_DATE) AS created_today`,
        [companyId]
      );

      const row = metricsResult.rows[0];
      const metrics = {
        by_status: row.by_status ?? {},
        by_channel: row.by_channel ?? {},
        created_today: row.created_today ?? 0,
      };

      const snapshot = await analyticsSnapshotRepository.upsert(companyId, snapshotDate, metrics);

      res.status(201).json({
        snapshot_date: snapshotDate,
        metrics,
        id: snapshot.id,
      });
    } catch (err) {
      errorJson(res, 500, 'INTERNAL_ERROR', err.message);
    }
  }
);

module.exports = router;
