const { pool } = require('../index');

async function createConversation(companyId) {
  const result = await pool.query(
    `INSERT INTO chat_conversations (company_id, updated_at)
     VALUES ($1, NOW())
     RETURNING id, company_id, created_at, updated_at`,
    [companyId]
  );
  return result.rows[0];
}

async function getConversation(conversationId, companyId) {
  const result = await pool.query(
    'SELECT id, company_id, created_at, updated_at FROM chat_conversations WHERE id = $1 AND company_id = $2',
    [conversationId, companyId]
  );
  return result.rows[0] ?? null;
}

async function getOrCreateState(conversationId, companyId) {
  let result = await pool.query(
    `SELECT conversation_id, company_id, collected_fields, last_asked_field, updated_at
     FROM chat_conversation_state WHERE conversation_id = $1 AND company_id = $2`,
    [conversationId, companyId]
  );
  if (result.rows[0]) return result.rows[0];

  await pool.query(
    `INSERT INTO chat_conversation_state (conversation_id, company_id, collected_fields, updated_at)
     VALUES ($1, $2, '{}'::jsonb, NOW())
     ON CONFLICT (conversation_id) DO NOTHING`,
    [conversationId, companyId]
  );
  result = await pool.query(
    `SELECT conversation_id, company_id, collected_fields, last_asked_field, updated_at
     FROM chat_conversation_state WHERE conversation_id = $1 AND company_id = $2`,
    [conversationId, companyId]
  );
  return result.rows[0];
}

async function updateState(conversationId, companyId, patch) {
  const { collected_fields, last_asked_field } = patch;
  const updates = ['updated_at = NOW()'];
  const values = [conversationId, companyId];
  let i = 3;
  if (collected_fields !== undefined) {
    updates.push(`collected_fields = $${i++}`);
    values.push(JSON.stringify(collected_fields));
  }
  if (last_asked_field !== undefined) {
    updates.push(`last_asked_field = $${i++}`);
    values.push(last_asked_field);
  }
  await pool.query(
    `UPDATE chat_conversation_state SET ${updates.join(', ')}
     WHERE conversation_id = $1 AND company_id = $2`,
    values
  );
  const res = await pool.query(
    `SELECT conversation_id, company_id, collected_fields, last_asked_field, updated_at
     FROM chat_conversation_state WHERE conversation_id = $1 AND company_id = $2`,
    [conversationId, companyId]
  );
  return res.rows[0];
}

module.exports = { createConversation, getConversation, getOrCreateState, updateState };
