const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10) || 5000,
});

module.exports = { pool };
