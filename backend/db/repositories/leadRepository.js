const { pool } = require('../index');

function toPlainLead(row, statusRow = null) {
  if (!row) return null;
  const lead = {
    id: row.id,
    company_id: row.company_id,
    channel: row.channel,
    external_id: row.external_id,
    score: row.score ?? 0,
    status: row.status,
    status_id: row.status_id ?? null,
    assigned_sales: row.assigned_sales,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (statusRow) {
    lead.status_obj = { id: statusRow.id, name: statusRow.name };
    lead.status_name = statusRow.name;
  } else {
    lead.status_name = null;
  }
  return lead;
}

async function findByCompanyChannelExternalId(companyId, channel, externalId) {
  const result = await pool.query(
    'SELECT * FROM leads WHERE company_id = $1 AND channel = $2 AND external_id = $3',
    [companyId, channel, externalId]
  );
  return toPlainLead(result.rows[0]);
}

async function findById(companyId, leadId) {
  const result = await pool.query(
    `SELECT l.*, cls.id AS status_id_join, cls.name AS status_name
     FROM leads l
     LEFT JOIN company_lead_statuses cls ON l.status_id = cls.id AND cls.company_id = l.company_id
     WHERE l.id = $1 AND l.company_id = $2`,
    [leadId, companyId]
  );
  const r = result.rows[0];
  if (!r) return null;
  const statusRow = r.status_id_join ? { id: r.status_id, name: r.status_name } : null;
  return toPlainLead(
    {
      id: r.id,
      company_id: r.company_id,
      channel: r.channel,
      external_id: r.external_id,
      score: r.score,
      status: r.status,
      status_id: r.status_id,
      assigned_sales: r.assigned_sales,
      created_at: r.created_at,
      updated_at: r.updated_at,
    },
    statusRow
  );
}

async function findAll(companyId, options = {}) {
  const { status, status_id, limit = 50, offset = 0 } = options;
  let query = `SELECT l.*, cls.id AS status_id_join, cls.name AS status_name
    FROM leads l
    LEFT JOIN company_lead_statuses cls ON l.status_id = cls.id AND cls.company_id = l.company_id
    WHERE l.company_id = $1`;
  const params = [companyId];
  let paramIndex = 2;

  if (status) {
    query += ` AND l.status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }
  if (status_id) {
    query += ` AND l.status_id = $${paramIndex}`;
    params.push(status_id);
    paramIndex++;
  }

  query += ' ORDER BY l.created_at DESC';
  query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  params.push(limit, offset);

  const result = await pool.query(query, params);
  return result.rows.map((r) => {
    const statusRow = r.status_id_join ? { id: r.status_id, name: r.status_name } : null;
    return toPlainLead(
      {
        id: r.id,
        company_id: r.company_id,
        channel: r.channel,
        external_id: r.external_id,
        score: r.score,
        status: r.status,
        status_id: r.status_id,
        assigned_sales: r.assigned_sales,
        created_at: r.created_at,
        updated_at: r.updated_at,
      },
      statusRow
    );
  });
}

async function count(companyId, options = {}) {
  const { status, status_id } = options;
  let query = 'SELECT COUNT(*)::int FROM leads WHERE company_id = $1';
  const params = [companyId];
  let paramIndex = 2;

  if (status) {
    query += ` AND status = $${paramIndex++}`;
    params.push(status);
  }
  if (status_id) {
    query += ` AND status_id = $${paramIndex++}`;
    params.push(status_id);
  }

  const result = await pool.query(query, params);
  return result.rows[0]?.count ?? 0;
}

async function create(companyId, data) {
  const defaultStatusResult = await pool.query(
    `SELECT id FROM company_lead_statuses WHERE company_id = $1 AND is_default = true LIMIT 1`,
    [companyId]
  );
  const defaultStatusId = defaultStatusResult.rows[0]?.id ?? null;

  const result = await pool.query(
    `INSERT INTO leads (company_id, channel, external_id, score, status, status_id, assigned_sales)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      companyId,
      data.channel,
      data.external_id ?? null,
      data.score ?? 0,
      data.status ?? 'new',
      data.status_id ?? defaultStatusId,
      data.assigned_sales ?? null,
    ]
  );
  const row = result.rows[0];
  if (row && !row.status_id && defaultStatusId) {
    await pool.query('UPDATE leads SET status_id = $1 WHERE id = $2', [defaultStatusId, row.id]);
    row.status_id = defaultStatusId;
  }
  const statusRow = row?.status_id ? await pool.query(
    'SELECT id, name FROM company_lead_statuses WHERE id = $1',
    [row.status_id]
  ).then((r) => r.rows[0]) : null;
  return toPlainLead(row, statusRow);
}

async function update(companyId, leadId, data) {
  const updates = [];
  const params = [leadId, companyId];
  let paramIndex = 3;
  if (data.channel !== undefined) {
    updates.push(`channel = $${paramIndex++}`);
    params.push(data.channel);
  }
  if (data.external_id !== undefined) {
    updates.push(`external_id = $${paramIndex++}`);
    params.push(data.external_id);
  }
  if (data.score !== undefined) {
    updates.push(`score = $${paramIndex++}`);
    params.push(data.score);
  }
  if (data.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    params.push(data.status);
  }
  if (data.status_id !== undefined) {
    updates.push(`status_id = $${paramIndex++}`);
    params.push(data.status_id);
  }
  if (data.assigned_sales !== undefined) {
    updates.push(`assigned_sales = $${paramIndex++}`);
    params.push(data.assigned_sales);
  }
  if (updates.length === 0) {
    const existing = await findById(companyId, leadId);
    return existing;
  }
  updates.push('updated_at = NOW()');
  const result = await pool.query(
    `UPDATE leads SET ${updates.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
    params
  );
  const row = result.rows[0];
  if (!row) return null;
  const statusRow = row.status_id ? await pool.query(
    'SELECT id, name FROM company_lead_statuses WHERE id = $1',
    [row.status_id]
  ).then((r) => r.rows[0]) : null;
  return toPlainLead(row, statusRow);
}

async function setStatus(companyId, leadId, statusId) {
  const statusRow = await pool.query(
    'SELECT id, name FROM company_lead_statuses WHERE id = $1 AND company_id = $2',
    [statusId, companyId]
  );
  if (!statusRow.rows[0]) return null;
  const result = await pool.query(
    `UPDATE leads SET status_id = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING *`,
    [statusId, leadId, companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return toPlainLead(row, statusRow.rows[0]);
}

module.exports = {
  findById,
  findAll,
  count,
  create,
  update,
  setStatus,
  findByCompanyChannelExternalId,
};
