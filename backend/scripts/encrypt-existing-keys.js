#!/usr/bin/env node
/**
 * One-time migration: encrypt existing plaintext ManyChat API keys.
 *
 * Usage:
 *   ENCRYPTION_KEY=<64-hex-chars> DATABASE_URL=<url> node scripts/encrypt-existing-keys.js
 *
 * Safe to run multiple times — skips already-encrypted keys (enc: prefix).
 * Dry-run by default. Pass --commit to actually write.
 */
require('dotenv').config();
const { Pool } = require('pg');
const { encrypt, decrypt, isConfigured } = require('../src/lib/encryption');

const DRY_RUN = !process.argv.includes('--commit');

async function main() {
  if (!isConfigured()) {
    console.error('ERROR: ENCRYPTION_KEY not set or invalid (need 64 hex chars)');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const result = await pool.query(
      "SELECT id, manychat_api_key FROM companies WHERE manychat_api_key IS NOT NULL AND manychat_api_key != ''"
    );

    let encrypted = 0;
    let skipped = 0;

    for (const row of result.rows) {
      if (row.manychat_api_key.startsWith('enc:')) {
        skipped++;
        continue;
      }

      const encryptedKey = encrypt(row.manychat_api_key);

      // Verify round-trip
      const decrypted = decrypt(encryptedKey);
      if (decrypted !== row.manychat_api_key) {
        console.error(`ABORT: Round-trip failed for company ${row.id}`);
        process.exit(1);
      }

      if (DRY_RUN) {
        console.log(`[DRY RUN] Would encrypt key for company ${row.id} (${row.manychat_api_key.slice(-6)})`);
      } else {
        await pool.query('UPDATE companies SET manychat_api_key = $1 WHERE id = $2', [encryptedKey, row.id]);
        console.log(`Encrypted key for company ${row.id}`);
      }
      encrypted++;
    }

    console.log(`\nDone. Encrypted: ${encrypted}, Already encrypted: ${skipped}, Total: ${result.rows.length}`);
    if (DRY_RUN && encrypted > 0) {
      console.log('\nThis was a dry run. Run with --commit to apply changes.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
