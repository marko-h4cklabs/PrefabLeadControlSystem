const { pool } = require('../index');

function toDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    lead_name: row.lead_name ?? null,
    company_id: row.company_id,
    amount: Number(row.amount),
    currency: row.currency ?? 'EUR',
    status: row.status ?? 'won',
    closed_at: row.closed_at,
    notes: row.notes ?? null,
    attribution_source: row.attribution_source ?? null,
    attribution_campaign: row.attribution_campaign ?? null,
    setter_name: row.setter_name ?? null,
    closer_name: row.closer_name ?? null,
    created_at: row.created_at,
    deleted_at: row.deleted_at ?? null,
  };
}

async function create(data) {
  const result = await pool.query(
    `INSERT INTO deals (lead_id, company_id, amount, currency, status, notes, attribution_source, attribution_campaign, setter_name, closer_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      data.lead_id,
      data.company_id,
      data.amount,
      data.currency ?? 'EUR',
      data.status ?? 'won',
      data.notes ?? null,
      data.attribution_source ?? null,
      data.attribution_campaign ?? null,
      data.setter_name ?? null,
      data.closer_name ?? null,
    ]
  );
  return toDto(result.rows[0]);
}

async function list(companyId, opts = {}) {
  const { from, to, setter_name, limit = 100, offset = 0 } = opts;
  let sql = `SELECT d.*, l.name AS lead_name FROM deals d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.company_id = $1 AND d.deleted_at IS NULL`;
  const params = [companyId];
  let idx = 2;
  if (from) {
    sql += ` AND d.closed_at::date >= $${idx}`;
    params.push(from);
    idx++;
  }
  if (to) {
    sql += ` AND d.closed_at::date <= $${idx}`;
    params.push(to);
    idx++;
  }
  if (setter_name) {
    sql += ` AND d.setter_name LIKE $${idx}`;
    params.push(`%${String(setter_name).replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
    idx++;
  }
  sql += ` ORDER BY d.closed_at DESC NULLS LAST, d.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit, offset);
  const result = await pool.query(sql, params);
  return result.rows.map(toDto);
}

async function count(companyId, opts = {}) {
  const { from, to, setter_name } = opts;
  let sql = `SELECT COUNT(*)::int AS n FROM deals WHERE company_id = $1 AND deleted_at IS NULL`;
  const params = [companyId];
  let idx = 2;
  if (from) {
    sql += ` AND closed_at::date >= $${idx}`;
    params.push(from);
    idx++;
  }
  if (to) {
    sql += ` AND closed_at::date <= $${idx}`;
    params.push(to);
    idx++;
  }
  if (setter_name) {
    sql += ` AND setter_name LIKE $${idx}`;
    params.push(`%${String(setter_name).replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
    idx++;
  }
  const result = await pool.query(sql, params);
  return parseInt(result.rows[0]?.n, 10) || 0;
}

async function findById(companyId, id) {
  const result = await pool.query(
    'SELECT * FROM deals WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
    [id, companyId]
  );
  return toDto(result.rows[0]);
}

async function update(companyId, id, data) {
  const allowed = ['amount', 'currency', 'status', 'notes', 'attribution_source', 'attribution_campaign', 'setter_name', 'closer_name'];
  const updates = [];
  const params = [id, companyId];
  let idx = 3;
  for (const key of allowed) {
    if (data[key] !== undefined) {
      updates.push(`${key} = $${idx++}`);
      params.push(key === 'amount' ? Number(data[key]) : data[key]);
    }
  }
  if (updates.length === 0) return findById(companyId, id);
  const result = await pool.query(
    `UPDATE deals SET ${updates.join(', ')} WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL RETURNING *`,
    params
  );
  return toDto(result.rows[0]);
}

async function softDelete(companyId, id) {
  const result = await pool.query(
    'UPDATE deals SET deleted_at = NOW() WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL RETURNING id',
    [id, companyId]
  );
  return result.rowCount > 0;
}

async function getStats(companyId, opts = {}) {
  const { from, to } = opts;
  let where = ' company_id = $1 AND deleted_at IS NULL';
  const params = [companyId];
  let idx = 2;
  if (from) {
    where += ` AND closed_at::date >= $${idx}`;
    params.push(from);
    idx++;
  }
  if (to) {
    where += ` AND closed_at::date <= $${idx}`;
    params.push(to);
    idx++;
  }

  const [totals, thisMonth, lastMonth, byMonth, bySource, setterRank] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total_revenue, COUNT(*)::int AS total_deals,
              COALESCE(AVG(amount), 0)::numeric AS avg_deal_value
       FROM deals WHERE ${where}`,
      params
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS revenue
       FROM deals WHERE company_id = $1 AND deleted_at IS NULL AND closed_at >= date_trunc('month', CURRENT_DATE) AND closed_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'`,
      [companyId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS revenue
       FROM deals WHERE company_id = $1 AND deleted_at IS NULL AND closed_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' AND closed_at < date_trunc('month', CURRENT_DATE)`,
      [companyId]
    ),
    pool.query(
      `SELECT to_char(closed_at, 'YYYY-MM') AS month, COALESCE(SUM(amount), 0)::numeric AS revenue, COUNT(*)::int AS deals
       FROM deals WHERE ${where} AND closed_at IS NOT NULL
       GROUP BY to_char(closed_at, 'YYYY-MM') ORDER BY month DESC LIMIT 24`,
      params
    ),
    pool.query(
      `SELECT attribution_source AS source, COALESCE(SUM(amount), 0)::numeric AS revenue, COUNT(*)::int AS deals
       FROM deals WHERE ${where} AND attribution_source IS NOT NULL
       GROUP BY attribution_source ORDER BY revenue DESC`,
      params
    ),
    pool.query(
      `SELECT setter_name AS name, COUNT(*)::int AS deals, COALESCE(SUM(amount), 0)::numeric AS revenue
       FROM deals WHERE ${where} AND setter_name IS NOT NULL AND setter_name != ''
       GROUP BY setter_name ORDER BY revenue DESC LIMIT 1`,
      params
    ),
  ]);

  const revThis = Number(thisMonth.rows[0]?.revenue ?? 0);
  const revLast = Number(lastMonth.rows[0]?.revenue ?? 0);
  const momGrowth = revLast > 0 ? ((revThis - revLast) / revLast) * 100 : (revThis > 0 ? 100 : 0);

  const totalDeals = parseInt(totals.rows[0]?.total_deals, 10) || 0;
  const totalLeads = await pool.query('SELECT COUNT(*)::int AS n FROM leads WHERE company_id = $1', [companyId]).then((r) => parseInt(r.rows[0]?.n, 10) || 0);
  const conversionRate = totalLeads > 0 ? (totalDeals / totalLeads) * 100 : 0;

  const avgClose = await pool.query(
    `SELECT AVG(EXTRACT(epoch FROM (closed_at - created_at)) / 86400)::numeric AS avg_days
     FROM deals WHERE ${where} AND closed_at IS NOT NULL AND created_at IS NOT NULL`,
    params
  );
  const avgTimeToCloseDays = Number(avgClose.rows[0]?.avg_days ?? 0);

  return {
    total_revenue: Number(totals.rows[0]?.total_revenue ?? 0),
    total_deals: totalDeals,
    avg_deal_value: Number(totals.rows[0]?.avg_deal_value ?? 0),
    revenue_this_month: revThis,
    revenue_last_month: revLast,
    mom_growth_percent: Math.round(momGrowth * 100) / 100,
    best_setter: setterRank.rows[0]
      ? { name: setterRank.rows[0].name, deals: parseInt(setterRank.rows[0].deals, 10) || 0, revenue: Number(setterRank.rows[0].revenue ?? 0) }
      : { name: '', deals: 0, revenue: 0 },
    revenue_by_month: (byMonth.rows || []).map((r) => ({ month: r.month, revenue: Number(r.revenue ?? 0), deals: parseInt(r.deals, 10) || 0 })),
    revenue_by_source: (bySource.rows || []).map((r) => ({ source: r.source ?? '', revenue: Number(r.revenue ?? 0), deals: parseInt(r.deals, 10) || 0 })),
    conversion_rate: Math.round(conversionRate * 100) / 100,
    avg_time_to_close_days: Math.round(avgTimeToCloseDays * 100) / 100,
  };
}

module.exports = {
  create,
  list,
  count,
  findById,
  update,
  softDelete,
  getStats,
};
