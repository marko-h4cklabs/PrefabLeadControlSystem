/**
 * Migration runner for PostgreSQL.
 * Runs .sql files from db/migrations/ in alphabetical order.
 * Tracks applied migrations in _migrations table.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { pool } = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      run_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations() {
  const result = await pool.query('SELECT name FROM _migrations ORDER BY id');
  return new Set(result.rows.map((r) => r.name));
}

function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function runMigration(client, name, sql) {
  await client.query(sql);
  await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
}

async function migrate() {
  let client;
  try {
    await ensureMigrationsTable();
    const applied = await getAppliedMigrations();
    const files = getMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log('[migrate] No pending migrations.');
      return;
    }

    console.log(`[migrate] ${pending.length} pending migration(s): ${pending.join(', ')}`);

    client = await pool.connect();

    await client.query('BEGIN');

    for (const file of pending) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      await runMigration(client, file, sql);
      console.log(`[migrate] Ran: ${file}`);
    }

    await client.query('COMMIT');
    console.log('[migrate] Done.');
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[migrate] Error:', err.message);
    process.exit(1);
  } finally {
    client?.release();
    await pool.end();
  }
}

migrate();
