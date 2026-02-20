const { pool } = require('../index');
const chatbotQuoteFieldsRepository = require('./chatbotQuoteFieldsRepository');

function toPlainConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    messages: row.messages ?? [],
    current_step: row.current_step ?? 0,
    parsed_fields: row.parsed_fields ?? {},
    quote_snapshot: row.quote_snapshot ?? null,
    last_updated: row.last_updated,
    created_at: row.created_at,
  };
}

async function createIfNotExists(leadId, companyId = null) {
  const existing = await getByLeadId(leadId);
  if (existing) return existing;

  let quoteSnapshot = null;
  if (companyId) {
    const fields = await chatbotQuoteFieldsRepository.list(companyId);
    quoteSnapshot = (fields ?? []).filter((f) => ['text', 'number'].includes(f.type));
  }

  const result = await pool.query(
    `INSERT INTO conversations (lead_id, quote_snapshot)
     VALUES ($1, $2::jsonb)
     RETURNING *`,
    [leadId, quoteSnapshot ? JSON.stringify(quoteSnapshot) : null]
  );
  return toPlainConversation(result.rows[0]);
}

async function getByLeadId(leadId) {
  const result = await pool.query(
    'SELECT * FROM conversations WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1',
    [leadId]
  );
  return toPlainConversation(result.rows[0]);
}

async function appendMessage(leadId, role, content) {
  const message = {
    role,
    content,
    timestamp: new Date().toISOString(),
  };
  const result = await pool.query(
    `UPDATE conversations
     SET messages = messages || $1::jsonb, last_updated = NOW()
     WHERE lead_id = $2
     RETURNING *`,
    [JSON.stringify([message]), leadId]
  );
  return toPlainConversation(result.rows[0]);
}

async function updateParsedFields(leadId, parsedFields) {
  const result = await pool.query(
    `UPDATE conversations
     SET parsed_fields = $1::jsonb, last_updated = NOW()
     WHERE lead_id = $2
     RETURNING *`,
    [JSON.stringify(parsedFields), leadId]
  );
  return toPlainConversation(result.rows[0]);
}

async function updateStep(leadId, step) {
  const result = await pool.query(
    `UPDATE conversations
     SET current_step = $1, last_updated = NOW()
     WHERE lead_id = $2
     RETURNING *`,
    [step, leadId]
  );
  return toPlainConversation(result.rows[0]);
}

module.exports = {
  createIfNotExists,
  getByLeadId,
  appendMessage,
  updateParsedFields,
  updateStep,
};
