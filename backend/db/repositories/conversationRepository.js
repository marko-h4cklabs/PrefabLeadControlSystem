const { pool } = require('../index');
const chatbotQuoteFieldsRepository = require('./chatbotQuoteFieldsRepository');
const chatbotBehaviorRepository = require('./chatbotBehaviorRepository');

function toPlainConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    messages: row.messages ?? [],
    current_step: row.current_step ?? 0,
    parsed_fields: row.parsed_fields ?? {},
    quote_snapshot: row.quote_snapshot ?? null,
    settings_snapshot: row.settings_snapshot ?? null,
    last_updated: row.last_updated,
    created_at: row.created_at,
  };
}

async function createIfNotExists(leadId, companyId = null) {
  const existing = await getByLeadId(leadId);
  if (existing) return existing;

  let quoteSnapshot = null;
  let settingsSnapshot = null;
  if (companyId) {
    const [fields, behavior] = await Promise.all([
      chatbotQuoteFieldsRepository.list(companyId),
      chatbotBehaviorRepository.get(companyId),
    ]);
    const enabled = chatbotQuoteFieldsRepository.getEnabledFields(fields ?? []);
    const validTypes = ['text', 'number', 'select_multi', 'composite_dimensions', 'boolean', 'pictures'];
    quoteSnapshot = enabled
      .filter((f) => f && validTypes.includes(f.type))
      .map((f) => ({ ...f, is_enabled: true }));
    settingsSnapshot = behavior ? {
      tone: behavior.tone ?? 'professional',
      response_length: behavior.response_length ?? 'medium',
      emojis_enabled: behavior.emojis_enabled ?? false,
      persona_style: behavior.persona_style ?? 'busy',
      forbidden_topics: Array.isArray(behavior.forbidden_topics) ? behavior.forbidden_topics : [],
      agent_name: behavior.agent_name ?? 'Jarvis',
      agent_backstory: behavior.agent_backstory ?? null,
      opener_style: behavior.opener_style ?? 'casual',
      conversation_goal: behavior.conversation_goal ?? 'collect_quote',
      handoff_trigger: behavior.handoff_trigger ?? 'after_quote',
      follow_up_style: behavior.follow_up_style ?? 'soft',
      human_fallback_message: behavior.human_fallback_message ?? null,
      bot_deny_response: behavior.bot_deny_response ?? null,
    } : null;
  }

  const result = await pool.query(
    `INSERT INTO conversations (lead_id, quote_snapshot, settings_snapshot)
     VALUES ($1, $2::jsonb, $3::jsonb)
     RETURNING *`,
    [leadId, quoteSnapshot ? JSON.stringify(quoteSnapshot) : null, settingsSnapshot ? JSON.stringify(settingsSnapshot) : null]
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

async function appendMessage(leadId, role, content, meta = {}) {
  const message = {
    role,
    content: content ?? '',
    timestamp: new Date().toISOString(),
    ...meta,
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
  const existing = await pool.query(
    'SELECT parsed_fields FROM conversations WHERE lead_id = $1',
    [leadId]
  );
  let final = parsedFields ?? {};
  if (existing.rows[0]) {
    const current = existing.rows[0].parsed_fields ?? {};
    const currentPictures = current.pictures;
    if (Array.isArray(currentPictures) && currentPictures.length > 0 && !Array.isArray(final.pictures)) {
      final = { ...final, pictures: currentPictures };
    }
  }
  const result = await pool.query(
    `UPDATE conversations
     SET parsed_fields = $1::jsonb, last_updated = NOW()
     WHERE lead_id = $2
     RETURNING *`,
    [JSON.stringify(final), leadId]
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
