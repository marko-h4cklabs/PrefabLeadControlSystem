/**
 * Diagnostic script: verify company configuration end-to-end.
 * Usage: node scripts/diagnose-company.js [companyId]
 *   If no companyId, lists all companies.
 *
 * Checks: encryption, behavior settings, quote fields, voice config, env vars, recent webhook logs.
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CRITICAL_ENV = ['DATABASE_URL', 'REDIS_URL', 'ANTHROPIC_API_KEY', 'ENCRYPTION_KEY'];
const OPTIONAL_ENV = ['OPENAI_API_KEY', 'SENTRY_DSN', 'ADMIN_ALERT_EMAILS', 'BACKEND_URL', 'FRONTEND_ORIGIN'];

function check(label, ok, detail) {
  const icon = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${icon} ${label}${detail ? ': ' + detail : ''}`);
  return ok;
}

async function run() {
  const companyId = process.argv[2];
  let allOk = true;

  // 1. Environment variables
  console.log('\n=== Environment Variables ===');
  for (const v of CRITICAL_ENV) {
    const val = process.env[v];
    const ok = !!val && val.trim().length > 0;
    if (v === 'ENCRYPTION_KEY') {
      check(v, ok && val.length === 64, ok ? `${val.length} hex chars` : 'MISSING or wrong length');
    } else {
      check(v, ok, ok ? `set (${val.slice(0, 10)}...)` : 'MISSING');
    }
    if (!ok) allOk = false;
  }
  for (const v of OPTIONAL_ENV) {
    const val = process.env[v];
    check(v, true, val ? `set (${val.slice(0, 15)}...)` : 'not set (optional)');
  }

  // 2. Database connection
  console.log('\n=== Database ===');
  try {
    const r = await pool.query('SELECT NOW() AS t');
    check('Connection', true, r.rows[0].t);
  } catch (e) {
    check('Connection', false, e.message);
    allOk = false;
  }

  // 3. Redis connection
  console.log('\n=== Redis ===');
  try {
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
    await redis.ping();
    check('Connection', true, 'PONG');
    await redis.quit();
  } catch (e) {
    check('Connection', false, e.message);
  }

  if (!companyId) {
    // List companies
    console.log('\n=== Companies ===');
    const companies = await pool.query('SELECT id, name, operating_mode FROM companies ORDER BY name');
    for (const c of companies.rows) {
      console.log(`  ${c.id}  ${c.name}  (${c.operating_mode || 'no mode'})`);
    }
    console.log('\nRe-run with: node scripts/diagnose-company.js <companyId>');
    await pool.end();
    return;
  }

  // 4. Company details
  console.log(`\n=== Company: ${companyId} ===`);
  const comp = await pool.query(
    `SELECT id, name, operating_mode, manychat_api_key, manychat_page_id, webhook_token,
            voice_enabled, voice_mode, voice_selected_id,
            meta_page_access_token, instagram_account_id
     FROM companies WHERE id = $1`, [companyId]
  );
  if (!comp.rows[0]) {
    check('Company found', false, 'NOT FOUND');
    await pool.end();
    return;
  }
  const c = comp.rows[0];
  check('Company name', true, c.name);
  check('Operating mode', !!c.operating_mode, c.operating_mode || 'NOT SET');
  check('ManyChat page_id', !!c.manychat_page_id, c.manychat_page_id || 'NOT SET');
  check('Webhook token', !!c.webhook_token, c.webhook_token ? 'set' : 'NOT SET');

  // 5. Encryption check
  console.log('\n=== Encryption ===');
  const rawKey = c.manychat_api_key;
  const isEncrypted = rawKey && rawKey.startsWith('enc:');
  check('API key stored', !!rawKey, rawKey ? `${rawKey.slice(0, 20)}...` : 'NULL');
  check('API key encrypted', isEncrypted, isEncrypted ? 'yes (enc: prefix)' : 'plaintext or null');

  if (rawKey) {
    try {
      const { decrypt } = require('../src/lib/encryption');
      const decrypted = decrypt(rawKey);
      const ok = !!decrypted && decrypted !== rawKey && !decrypted.startsWith('enc:');
      check('Decrypt round-trip', ok || !isEncrypted, ok ? `OK → ${decrypted.slice(0, 10)}...` : (isEncrypted ? 'FAILED - key mismatch?' : 'plaintext, no decryption needed'));
      if (isEncrypted && !ok) allOk = false;
    } catch (e) {
      check('Decrypt round-trip', false, e.message);
      allOk = false;
    }
  }

  // 6. Behavior settings
  console.log('\n=== Chatbot Behavior ===');
  const beh = await pool.query('SELECT * FROM chatbot_behavior WHERE company_id = $1', [companyId]);
  if (!beh.rows[0]) {
    check('Behavior row', false, 'MISSING — bot has no settings!');
    allOk = false;
  } else {
    const b = beh.rows[0];
    check('Agent name', true, b.agent_name || 'default');
    check('Tone', true, b.tone || 'default');
    check('Response length', true, b.response_length || 'default');
    check('Emojis enabled', true, String(b.emojis_enabled));
    check('Language codes', true, JSON.stringify(b.language_codes || b.language_code || 'en'));
    check('Conversation goal', !!b.conversation_goal, b.conversation_goal || 'NOT SET');
    check('Social proof', true, String(!!b.social_proof_enabled));
    check('Human error style', true, String(!!b.human_error_enabled));
    check('Response delay', true, `${b.response_delay_seconds || 0}s`);
    check('Booking trigger', true, String(!!b.booking_trigger_enabled));
  }

  // 7. Quote fields
  console.log('\n=== Quote Fields ===');
  const fields = await pool.query(
    'SELECT name, type, required, is_enabled, priority FROM chatbot_quote_fields WHERE company_id = $1 ORDER BY priority',
    [companyId]
  );
  if (fields.rows.length === 0) {
    check('Quote fields', false, 'NONE configured — data collection will not work');
  } else {
    for (const f of fields.rows) {
      check(
        `${f.name} (${f.type})`,
        f.is_enabled !== false,
        `${f.required ? 'required' : 'optional'}, enabled=${f.is_enabled !== false}, priority=${f.priority}`
      );
    }
  }

  // 8. Voice config
  console.log('\n=== Voice Config ===');
  check('Voice enabled', true, String(!!c.voice_enabled));
  if (c.voice_enabled) {
    check('Voice mode', !!c.voice_mode, c.voice_mode || 'NOT SET');
    check('Voice ID', !!c.voice_selected_id, c.voice_selected_id || 'NOT SET');
    check('OPENAI_API_KEY (for Whisper)', !!process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY ? 'set' : 'MISSING — voice transcription disabled');
  }

  // 9. Recent webhook logs
  console.log('\n=== Recent Webhook Logs (last 10) ===');
  const logs = await pool.query(
    `SELECT subscriber_id, message_preview, processing_time_ms, success, created_at
     FROM manychat_webhook_log WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [companyId]
  );
  if (logs.rows.length === 0) {
    console.log('  No webhook logs found');
  } else {
    for (const l of logs.rows) {
      const icon = l.success ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const preview = (l.message_preview || '').slice(0, 60);
      console.log(`  ${icon} ${l.created_at.toISOString().slice(0, 19)} sub:${l.subscriber_id} ${l.processing_time_ms}ms "${preview}"`);
    }
  }

  // 10. Recent conversations
  console.log('\n=== Recent Conversations ===');
  const convs = await pool.query(
    `SELECT l.name, l.external_id,
            jsonb_array_length(c.messages) as msg_count,
            c.parsed_fields
     FROM conversations c
     JOIN leads l ON l.id = c.lead_id
     WHERE l.company_id = $1
     ORDER BY c.id DESC LIMIT 5`,
    [companyId]
  );
  for (const cv of convs.rows) {
    const fields = cv.parsed_fields ? Object.keys(cv.parsed_fields).filter(k => !k.startsWith('__')).length : 0;
    console.log(`  ${cv.name || cv.external_id}: ${cv.msg_count} msgs, ${fields} fields collected`);
  }

  // 11. Duplicate page_id check
  if (c.manychat_page_id) {
    const dupes = await pool.query(
      'SELECT id, name FROM companies WHERE manychat_page_id = $1 AND id != $2',
      [c.manychat_page_id, companyId]
    );
    if (dupes.rows.length > 0) {
      console.log('\n\x1b[31m!!! DUPLICATE PAGE_ID WARNING !!!\x1b[0m');
      console.log(`  page_id "${c.manychat_page_id}" is shared with:`);
      for (const d of dupes.rows) {
        console.log(`  \x1b[31m✗\x1b[0m ${d.id} (${d.name})`);
      }
      console.log('  This causes webhooks to route to the WRONG company!');
      allOk = false;
    }
  }

  // Summary
  console.log('\n' + (allOk ? '\x1b[32m=== ALL CHECKS PASSED ===\x1b[0m' : '\x1b[31m=== SOME CHECKS FAILED — see above ===\x1b[0m'));

  await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
