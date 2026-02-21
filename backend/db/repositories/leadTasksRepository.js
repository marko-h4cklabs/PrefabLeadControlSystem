const { pool } = require('../index');

function toPlain(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    due_at: row.due_at,
    assigned_user_id: row.assigned_user_id,
    created_by_user_id: row.created_by_user_id,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findById(companyId, leadId, taskId) {
  const result = await pool.query(
    'SELECT id, title, description, status, due_at, assigned_user_id, created_by_user_id, completed_at, created_at, updated_at FROM lead_tasks WHERE company_id = $1 AND lead_id = $2 AND id = $3',
    [companyId, leadId, taskId]
  );
  return toPlain(result.rows[0]) ?? null;
}

async function listByLead(companyId, leadId, { status, limit = 50, offset = 0 } = {}) {
  let sql = `
    SELECT id, title, description, status, due_at, assigned_user_id, created_by_user_id, completed_at, created_at, updated_at
    FROM lead_tasks
    WHERE company_id = $1 AND lead_id = $2`;
  const params = [companyId, leadId];
  if (status) {
    sql += ' AND status = $3';
    params.push(status);
  }
  sql += ' ORDER BY due_at NULLS LAST, created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(Math.min(limit, 100), offset);
  const result = await pool.query(sql, params);
  return result.rows.map(toPlain);
}

async function create({ companyId, leadId, title, description, dueAt, assignedUserId, createdByUserId }) {
  const result = await pool.query(
    `INSERT INTO lead_tasks (company_id, lead_id, title, description, due_at, assigned_user_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, title, description, status, due_at, assigned_user_id, created_by_user_id, completed_at, created_at, updated_at`,
    [companyId, leadId, title, description ?? null, dueAt ?? null, assignedUserId ?? null, createdByUserId ?? null]
  );
  return toPlain(result.rows[0]);
}

async function update({ companyId, leadId, taskId, patch }) {
  const allowed = ['title', 'description', 'status', 'due_at', 'assigned_user_id'];
  const updates = [];
  const params = [companyId, leadId, taskId];
  let i = 4;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!allowed.includes(key)) continue;
    if (key === 'due_at') {
      updates.push(`due_at = $${i++}`);
      params.push(value ?? null);
    } else if (key === 'status') {
      updates.push(`status = $${i++}`);
      params.push(value ?? 'open');
      updates.push(value === 'done' ? 'completed_at = COALESCE(completed_at, NOW())' : 'completed_at = NULL');
    } else if (key === 'assigned_user_id') {
      updates.push(`assigned_user_id = $${i++}`);
      params.push(value ?? null);
    } else {
      updates.push(`${key} = $${i++}`);
      params.push(value);
    }
  }
  if (updates.length === 0) {
    const r = await pool.query(
      'SELECT id, title, description, status, due_at, assigned_user_id, created_by_user_id, completed_at, created_at, updated_at FROM lead_tasks WHERE company_id = $1 AND lead_id = $2 AND id = $3',
      [companyId, leadId, taskId]
    );
    return toPlain(r.rows[0]) ?? null;
  }
  updates.push('updated_at = NOW()');
  const result = await pool.query(
    `UPDATE lead_tasks SET ${updates.join(', ')}
     WHERE company_id = $1 AND lead_id = $2 AND id = $3
     RETURNING id, title, description, status, due_at, assigned_user_id, created_by_user_id, completed_at, created_at, updated_at`,
    params
  );
  return toPlain(result.rows[0]) ?? null;
}

async function remove({ companyId, leadId, taskId }) {
  const result = await pool.query(
    'DELETE FROM lead_tasks WHERE company_id = $1 AND lead_id = $2 AND id = $3 RETURNING id',
    [companyId, leadId, taskId]
  );
  return result.rowCount > 0;
}

async function countByLead(companyId, leadId, { status } = {}) {
  let sql = 'SELECT COUNT(*)::int FROM lead_tasks WHERE company_id = $1 AND lead_id = $2';
  const params = [companyId, leadId];
  if (status) {
    sql += ' AND status = $3';
    params.push(status);
  }
  const result = await pool.query(sql, params);
  return result.rows[0]?.count ?? 0;
}

module.exports = {
  findById,
  listByLead,
  create,
  update,
  remove,
  countByLead,
};
