const { pool } = require('../index');

async function list(companyId) {
  const result = await pool.query(
    `SELECT id, name, sort_order, is_default, created_at
     FROM company_lead_statuses
     WHERE company_id = $1
     ORDER BY sort_order ASC, name ASC`,
    [companyId]
  );
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: (r.name ?? '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
    sort_order: r.sort_order ?? 0,
    is_default: r.is_default ?? false,
    created_at: r.created_at,
  }));
}

async function getDefault(companyId) {
  const result = await pool.query(
    `SELECT id, name, sort_order, is_default, created_at
     FROM company_lead_statuses
     WHERE company_id = $1 AND is_default = true
     LIMIT 1`,
    [companyId]
  );
  if (result.rows[0]) return result.rows[0];
  const fallback = await pool.query(
    `SELECT id, name, sort_order, is_default, created_at
     FROM company_lead_statuses
     WHERE company_id = $1
     ORDER BY sort_order ASC
     LIMIT 1`,
    [companyId]
  );
  return fallback.rows[0] ?? null;
}

async function findByIdAndCompany(statusId, companyId) {
  const result = await pool.query(
    `SELECT id, name, sort_order, is_default, created_at
     FROM company_lead_statuses
     WHERE id = $1 AND company_id = $2`,
    [statusId, companyId]
  );
  return result.rows[0] ?? null;
}

module.exports = { list, getDefault, findByIdAndCompany };
