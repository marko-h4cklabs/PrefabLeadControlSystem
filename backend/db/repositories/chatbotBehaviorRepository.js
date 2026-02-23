const { pool } = require('../index');

const DEFAULTS = {
  tone: 'professional',
  response_length: 'medium',
  emojis_enabled: false,
  persona_style: 'busy',
  forbidden_topics: [],
  agent_name: 'Jarvis',
  agent_backstory: null,
  opener_style: 'casual',
  conversation_goal: 'collect_quote',
  handoff_trigger: 'after_quote',
  follow_up_style: 'soft',
  human_fallback_message: 'Let me get someone from the team to follow up with you directly.',
  bot_deny_response: 'Nope, real person here 😄 What can I help you with?',
};

const COLUMNS = [
  'tone',
  'response_length',
  'emojis_enabled',
  'persona_style',
  'forbidden_topics',
  'agent_name',
  'agent_backstory',
  'opener_style',
  'conversation_goal',
  'handoff_trigger',
  'follow_up_style',
  'human_fallback_message',
  'bot_deny_response',
];

function rowToObject(row) {
  if (!row) return null;
  return {
    tone: row.tone ?? DEFAULTS.tone,
    response_length: row.response_length ?? DEFAULTS.response_length,
    emojis_enabled: row.emojis_enabled ?? false,
    persona_style: row.persona_style ?? DEFAULTS.persona_style,
    forbidden_topics: row.forbidden_topics ?? [],
    agent_name: row.agent_name ?? DEFAULTS.agent_name,
    agent_backstory: row.agent_backstory ?? DEFAULTS.agent_backstory,
    opener_style: row.opener_style ?? DEFAULTS.opener_style,
    conversation_goal: row.conversation_goal ?? DEFAULTS.conversation_goal,
    handoff_trigger: row.handoff_trigger ?? DEFAULTS.handoff_trigger,
    follow_up_style: row.follow_up_style ?? DEFAULTS.follow_up_style,
    human_fallback_message: row.human_fallback_message ?? DEFAULTS.human_fallback_message,
    bot_deny_response: row.bot_deny_response ?? DEFAULTS.bot_deny_response,
  };
}

async function get(companyId) {
  const result = await pool.query(
    `SELECT ${COLUMNS.join(', ')} FROM chatbot_behavior WHERE company_id = $1`,
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return { ...DEFAULTS };
  return rowToObject(row);
}

async function upsert(companyId, payload) {
  const current = await get(companyId);

  const tone = payload.tone !== undefined ? payload.tone : (current.tone ?? DEFAULTS.tone);
  const response_length = payload.response_length !== undefined ? payload.response_length : (current.response_length ?? DEFAULTS.response_length);
  const emojis_enabled = payload.emojis_enabled !== undefined ? payload.emojis_enabled : (current.emojis_enabled ?? DEFAULTS.emojis_enabled);
  const persona_style = payload.persona_style !== undefined ? payload.persona_style : (current.persona_style ?? DEFAULTS.persona_style);
  const forbidden_topics = payload.forbidden_topics !== undefined
    ? (Array.isArray(payload.forbidden_topics) ? payload.forbidden_topics : DEFAULTS.forbidden_topics)
    : (current.forbidden_topics ?? DEFAULTS.forbidden_topics);
  const agent_name = payload.agent_name !== undefined ? payload.agent_name : (current.agent_name ?? DEFAULTS.agent_name);
  const agent_backstory = payload.agent_backstory !== undefined ? payload.agent_backstory : (current.agent_backstory ?? DEFAULTS.agent_backstory);
  const opener_style = payload.opener_style !== undefined ? payload.opener_style : (current.opener_style ?? DEFAULTS.opener_style);
  const conversation_goal = payload.conversation_goal !== undefined ? payload.conversation_goal : (current.conversation_goal ?? DEFAULTS.conversation_goal);
  const handoff_trigger = payload.handoff_trigger !== undefined ? payload.handoff_trigger : (current.handoff_trigger ?? DEFAULTS.handoff_trigger);
  const follow_up_style = payload.follow_up_style !== undefined ? payload.follow_up_style : (current.follow_up_style ?? DEFAULTS.follow_up_style);
  const human_fallback_message = payload.human_fallback_message !== undefined ? payload.human_fallback_message : (current.human_fallback_message ?? DEFAULTS.human_fallback_message);
  const bot_deny_response = payload.bot_deny_response !== undefined ? payload.bot_deny_response : (current.bot_deny_response ?? DEFAULTS.bot_deny_response);

  await pool.query(
    `INSERT INTO chatbot_behavior (
      company_id, tone, response_length, emojis_enabled, persona_style, forbidden_topics,
      agent_name, agent_backstory, opener_style, conversation_goal, handoff_trigger,
      follow_up_style, human_fallback_message, bot_deny_response, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
    ON CONFLICT (company_id) DO UPDATE SET
      tone = $2, response_length = $3, emojis_enabled = $4, persona_style = $5, forbidden_topics = $6,
      agent_name = $7, agent_backstory = $8, opener_style = $9, conversation_goal = $10, handoff_trigger = $11,
      follow_up_style = $12, human_fallback_message = $13, bot_deny_response = $14, updated_at = NOW()`,
    [
      companyId, tone, response_length, emojis_enabled, persona_style, forbidden_topics,
      agent_name, agent_backstory, opener_style, conversation_goal, handoff_trigger,
      follow_up_style, human_fallback_message, bot_deny_response,
    ]
  );
  return get(companyId);
}

module.exports = { get, upsert };
