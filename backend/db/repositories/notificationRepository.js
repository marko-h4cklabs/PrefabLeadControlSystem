const { pool } = require('../index');

async function create(companyId, data) {
  const { leadId, type, title, body, url, message } = data;
  const bodyVal = body ?? message ?? null;
  const result = await pool.query(
    `INSERT INTO notifications (company_id, lead_id, type, title, body, url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, company_id, lead_id, type, title, body, url, is_read, created_at`,
    [companyId, leadId ?? null, type, title, bodyVal ?? null, url ?? null]
  );
  return result.rows[0];
}

async function list(companyId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
  let sql = `
    SELECT id, company_id, lead_id, type, title, body, url, is_read, created_at
    FROM notifications
    WHERE company_id = $1`;
  const params = [companyId];
  if (unreadOnly) {
    sql += ' AND is_read = false';
  }
  sql += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
  params.push(Math.min(limit, 100), offset);
  const result = await pool.query(sql, params);
  return result.rows;
}

async function count(companyId, { unreadOnly = false } = {}) {
  let sql = 'SELECT COUNT(*)::int FROM notifications WHERE company_id = $1';
  const params = [companyId];
  if (unreadOnly) {
    sql += ' AND is_read = false';
  }
  const result = await pool.query(sql, params);
  return result.rows[0]?.count ?? 0;
}

async function unreadCount(companyId) {
  const result = await pool.query(
    'SELECT COUNT(*)::int FROM notifications WHERE company_id = $1 AND is_read = false',
    [companyId]
  );
  return result.rows[0]?.count ?? 0;
}

async function markRead(companyId, id) {
  const result = await pool.query(
    `UPDATE notifications SET is_read = true WHERE company_id = $1 AND id = $2
     RETURNING id, company_id, lead_id, type, title, body, url, is_read, created_at`,
    [companyId, id]
  );
  return result.rows[0] ?? null;
}

async function markAllRead(companyId) {
  await pool.query(
    'UPDATE notifications SET is_read = true WHERE company_id = $1 AND is_read = false',
    [companyId]
  );
}

module.exports = {
  create,
  list,
  count,
  unreadCount,
  markRead,
  markAllRead,
};
