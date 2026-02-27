const { Pool } = require('pg');
const logger = require('../src/lib/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
  min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10) || 5000,
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS, 10) || 30000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    try {
      logger.info({
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      }, 'DB pool stats');
    } catch (e) {
      logger.warn({ err: e }, 'Pool stats log failed');
    }
  }, 5 * 60 * 1000);
}

module.exports = { pool };
