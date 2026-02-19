const { pool } = require('../index');

async function upsert(companyId, snapshotDate, metrics) {
  const result = await pool.query(
    `INSERT INTO analytics_snapshots (company_id, snapshot_date, metrics)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, snapshot_date)
     DO UPDATE SET metrics = $3
     RETURNING *`,
    [companyId, snapshotDate, JSON.stringify(metrics)]
  );
  return result.rows[0];
}

module.exports = { upsert };
