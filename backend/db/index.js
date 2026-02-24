const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
  min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10) || 5000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[pool] Unexpected error:', err.message);
});

if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    try {
      console.log(
        `[pool] total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`
      );
    } catch (e) {
      console.warn('[pool] stats log failed:', e.message);
    }
  }, 5 * 60 * 1000);
}

module.exports = { pool };
