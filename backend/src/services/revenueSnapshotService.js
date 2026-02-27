/**
 * Daily revenue snapshot: inserts revenue_snapshots for each company with that day's totals.
 */

const logger = require('../lib/logger');
const { pool } = require('../../db');

async function runDailySnapshot(snapshotDate = null) {
  const date = snapshotDate ? new Date(snapshotDate) : new Date();
  const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD

  const companies = await pool.query('SELECT id FROM companies');
  let inserted = 0;

  for (const row of companies.rows || []) {
    const companyId = row.id;
    try {
      const [revenue, leads, convs, hot] = await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(amount), 0)::numeric AS total_revenue, COUNT(*)::int AS deals_count
           FROM deals WHERE company_id = $1 AND deleted_at IS NULL AND closed_at IS NOT NULL AND closed_at::date <= $2`,
          [companyId, dateStr]
        ),
        pool.query('SELECT COUNT(*)::int AS n FROM leads WHERE company_id = $1', [companyId]),
        pool.query('SELECT COUNT(*)::int AS n FROM chat_conversations WHERE company_id = $1', [companyId]),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM leads WHERE company_id = $1 AND (is_hot_lead = true OR intent_score >= 70)`,
          [companyId]
        ).catch(() => ({ rows: [{ n: 0 }] })),
      ]);

      const total_revenue = Number(revenue.rows[0]?.total_revenue ?? 0);
      const deals_count = parseInt(revenue.rows[0]?.deals_count, 10) || 0;
      const leads_count = parseInt(leads.rows[0]?.n, 10) || 0;
      const conversations_count = parseInt(convs.rows[0]?.n, 10) || 0;
      const hot_leads_count = parseInt(hot.rows[0]?.n, 10) || 0;

      await pool.query(
        `INSERT INTO revenue_snapshots (company_id, snapshot_date, total_revenue, deals_count, leads_count, conversations_count, hot_leads_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, snapshot_date) DO UPDATE SET
           total_revenue = EXCLUDED.total_revenue,
           deals_count = EXCLUDED.deals_count,
           leads_count = EXCLUDED.leads_count,
           conversations_count = EXCLUDED.conversations_count,
           hot_leads_count = EXCLUDED.hot_leads_count`,
        [companyId, dateStr, total_revenue, deals_count, leads_count, conversations_count, hot_leads_count]
      );
      inserted++;
    } catch (err) {
      logger.error('[revenueSnapshot] company', companyId, err.message);
    }
  }

  if (inserted > 0) logger.info('[revenueSnapshot] ran for', inserted, 'companies, date=', dateStr);
  return inserted;
}

module.exports = { runDailySnapshot };
