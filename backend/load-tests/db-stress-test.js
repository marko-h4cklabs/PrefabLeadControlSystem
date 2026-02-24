/**
 * Database stress test: runs many concurrent queries against the pool.
 * Requires DATABASE_URL (e.g. from .env or export).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function runQuery(label, query, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(query, params);
    const duration = Date.now() - start;
    const rowCount = result.rows ? result.rows.length : 0;
    console.log(`✅ ${label}: ${duration}ms (${rowCount} rows)`);
    return duration;
  } catch (err) {
    console.error(`❌ ${label}: ${err.message}`);
    return null;
  }
}

async function runStressTest() {
  console.log('🔥 Database stress test starting...\n');

  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(runQuery(`Lead query ${i}`, 'SELECT COUNT(*) FROM leads'));
    promises.push(
      runQuery(`Notif query ${i}`, 'SELECT COUNT(*) FROM notifications WHERE is_read = false')
    );
  }

  const start = Date.now();
  const results = await Promise.allSettled(promises);
  const total = Date.now() - start;

  const succeeded = results.filter(
    (r) => r.status === 'fulfilled' && r.value !== null
  ).length;
  console.log(`\n📊 ${succeeded}/${results.length} queries succeeded in ${total}ms`);
  console.log(
    `   Pool: total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`
  );

  await pool.end();
}

runStressTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
