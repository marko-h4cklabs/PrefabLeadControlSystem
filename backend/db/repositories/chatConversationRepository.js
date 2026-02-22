const { pool } = require('../index');

async function getOrCreateActiveConversation(companyId) {
  const existing = await pool.query(
    `SELECT id, company_id, created_at, updated_at, quote_snapshot
     FROM chat_conversations
     WHERE company_id = $1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [companyId]
  );
  if (existing.rows[0]) return existing.rows[0];
  const conv = await createConversation(companyId);
  return conv;
}

async function createConversation(companyId) {
  const result = await pool.query(
    `INSERT INTO chat_conversations (company_id, updated_at)
     VALUES ($1, NOW())
     RETURNING id, company_id, created_at, updated_at, quote_snapshot`,
    [companyId]
  );
  return result.rows[0];
}

async function getConversation(conversationId, companyId) {
  const result = await pool.query(
    'SELECT id, company_id, created_at, updated_at, quote_snapshot FROM chat_conversations WHERE id = $1 AND company_id = $2',
    [conversationId, companyId]
  );
  return result.rows[0] ?? null;
}

async function updateQuoteSnapshot(conversationId, companyId, snapshot) {
  await pool.query(
    'UPDATE chat_conversations SET quote_snapshot = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2',
    [conversationId, companyId, JSON.stringify(snapshot)]
  );
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

async function getBookingState(conversationId, companyId) {
  const state = await getOrCreateState(conversationId, companyId);
  const fields = state.collected_fields || {};
  return fields.__booking || null;
}

async function updateBookingState(conversationId, companyId, bookingPatch) {
  const state = await getOrCreateState(conversationId, companyId);
  const fields = state.collected_fields || {};
  const current = fields.__booking || {};
  fields.__booking = { ...current, ...bookingPatch, updatedAt: new Date().toISOString() };
  await updateState(conversationId, companyId, { collected_fields: fields });
  return fields.__booking;
}

module.exports = {
  createConversation,
  getConversation,
  getOrCreateActiveConversation,
  getOrCreateState,
  updateState,
  updateQuoteSnapshot,
  getBookingState,
  updateBookingState,
};
