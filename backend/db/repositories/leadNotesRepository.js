const { pool } = require('../index');

function toPlain(row) {
  if (!row) return null;
  return {
    id: row.id,
    body: row.body,
    created_by_user_id: row.created_by_user_id,
    updated_by_user_id: row.updated_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listByLead(companyId, leadId, { limit = 50, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT id, body, created_by_user_id, updated_by_user_id, created_at, updated_at
     FROM lead_notes
     WHERE company_id = $1 AND lead_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [companyId, leadId, Math.min(limit, 100), offset]
  );
  return result.rows.map(toPlain);
}

async function create({ companyId, leadId, body, createdByUserId }) {
  const result = await pool.query(
    `INSERT INTO lead_notes (company_id, lead_id, body, created_by_user_id, updated_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NOW(), NOW())
     RETURNING id, body, created_by_user_id, updated_by_user_id, created_at, updated_at`,
    [companyId, leadId, body, createdByUserId ?? null]
  );
  return toPlain(result.rows[0]);
}

async function update({ companyId, leadId, noteId, body, updatedByUserId }) {
  const result = await pool.query(
    `UPDATE lead_notes SET body = $4, updated_by_user_id = $5, updated_at = NOW()
     WHERE company_id = $1 AND lead_id = $2 AND id = $3
     RETURNING id, body, created_by_user_id, updated_by_user_id, created_at, updated_at`,
    [companyId, leadId, noteId, body, updatedByUserId ?? null]
  );
  return toPlain(result.rows[0]) ?? null;
}

async function remove({ companyId, leadId, noteId }) {
  const result = await pool.query(
    'DELETE FROM lead_notes WHERE company_id = $1 AND lead_id = $2 AND id = $3 RETURNING id',
    [companyId, leadId, noteId]
  );
  return result.rowCount > 0;
}

async function countByLead(companyId, leadId) {
  const result = await pool.query(
    'SELECT COUNT(*)::int FROM lead_notes WHERE company_id = $1 AND lead_id = $2',
    [companyId, leadId]
  );
  return result.rows[0]?.count ?? 0;
}

module.exports = {
  listByLead,
  create,
  update,
  remove,
  countByLead,
};
