const { pool } = require('../index');

function toPlainLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_id: row.company_id,
    channel: row.channel,
    external_id: row.external_id,
    score: row.score ?? 0,
    status: row.status,
    assigned_sales: row.assigned_sales,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findById(companyId, leadId) {
  const result = await pool.query(
    'SELECT * FROM leads WHERE id = $1 AND company_id = $2',
    [leadId, companyId]
  );
  return toPlainLead(result.rows[0]);
}

async function findAll(companyId, options = {}) {
  const { status, limit = 50, offset = 0 } = options;
  let query = 'SELECT * FROM leads WHERE company_id = $1';
  const params = [companyId];
  let paramIndex = 2;

  if (status) {
    query += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  query += ' ORDER BY created_at DESC';
  query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  params.push(limit, offset);

  const result = await pool.query(query, params);
  return result.rows.map(toPlainLead);
}

async function count(companyId, options = {}) {
  const { status } = options;
  let query = 'SELECT COUNT(*)::int FROM leads WHERE company_id = $1';
  const params = [companyId];

  if (status) {
    query += ' AND status = $2';
    params.push(status);
  }

  const result = await pool.query(query, params);
  return result.rows[0].count;
}

async function create(companyId, data) {
  const result = await pool.query(
    `INSERT INTO leads (company_id, channel, external_id, score, status, assigned_sales)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      companyId,
      data.channel,
      data.external_id ?? null,
      data.score ?? 0,
      data.status ?? 'new',
      data.assigned_sales ?? null,
    ]
  );
  return toPlainLead(result.rows[0]);
}

async function update(companyId, leadId, data) {
  const result = await pool.query(
    `UPDATE leads SET
       channel = COALESCE($3, channel),
       external_id = COALESCE($4, external_id),
       score = COALESCE($5, score),
       status = COALESCE($6, status),
       assigned_sales = COALESCE($7, assigned_sales),
       updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [
      leadId,
      companyId,
      data.channel,
      data.external_id,
      data.score,
      data.status,
      data.assigned_sales,
    ]
  );
  return toPlainLead(result.rows[0]);
}

module.exports = {
  findById,
  findAll,
  count,
  create,
  update,
};
