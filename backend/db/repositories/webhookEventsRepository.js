const { pool } = require('../index');

async function create(companyId, channel, payload) {
  const result = await pool.query(
    `INSERT INTO webhook_events (company_id, channel, payload)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [companyId, channel, JSON.stringify(payload)]
  );
  return result.rows[0];
}

module.exports = { create };
