const { pool } = require('../index');

async function create(activity) {
  const {
    companyId,
    leadId,
    eventType,
    actorType = 'system',
    actorUserId = null,
    source = null,
    channel = null,
    metadata = {},
  } = activity;
  const result = await pool.query(
    `INSERT INTO lead_activities (company_id, lead_id, event_type, actor_type, actor_user_id, source, channel, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id, company_id, lead_id, event_type, actor_type, actor_user_id, source, channel, metadata, created_at`,
    [companyId, leadId, eventType, actorType, actorUserId, source, channel, JSON.stringify(metadata)]
  );
  return result.rows[0];
}

async function listByLead(companyId, leadId, { limit = 50, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT id, company_id, lead_id, event_type, actor_type, actor_user_id, source, channel, metadata, created_at
     FROM lead_activities
     WHERE company_id = $1 AND lead_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [companyId, leadId, Math.min(limit, 100), offset]
  );
  return result.rows;
}

async function countByLead(companyId, leadId) {
  const result = await pool.query(
    'SELECT COUNT(*)::int FROM lead_activities WHERE company_id = $1 AND lead_id = $2',
    [companyId, leadId]
  );
  return result.rows[0]?.count ?? 0;
}

module.exports = {
  create,
  listByLead,
  countByLead,
};
