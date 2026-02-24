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
  prohibited_topics: null,
  competitor_mentions: 'deflect',
  price_reveal: 'ask_first',
  closing_style: 'soft',
  language_code: 'en',
  response_delay_seconds: 0,
  max_messages_before_handoff: 20,
  urgency_style: 'genuine',
  social_proof_enabled: false,
  social_proof_examples: null,
  booking_trigger_enabled: false,
  booking_trigger_score: 60,
  booking_platform: 'google_calendar',
  calendly_url: null,
  booking_offer_message: null,
  booking_required_fields: ['full_name', 'email_address'],
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
  'prohibited_topics',
  'competitor_mentions',
  'price_reveal',
  'closing_style',
  'language_code',
  'response_delay_seconds',
  'max_messages_before_handoff',
  'urgency_style',
  'social_proof_enabled',
  'social_proof_examples',
  'booking_trigger_enabled',
  'booking_trigger_score',
  'booking_platform',
  'calendly_url',
  'booking_offer_message',
  'booking_required_fields',
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
    prohibited_topics: row.prohibited_topics ?? DEFAULTS.prohibited_topics,
    competitor_mentions: row.competitor_mentions ?? DEFAULTS.competitor_mentions,
    price_reveal: row.price_reveal ?? DEFAULTS.price_reveal,
    closing_style: row.closing_style ?? DEFAULTS.closing_style,
    language_code: row.language_code ?? DEFAULTS.language_code,
    response_delay_seconds: row.response_delay_seconds ?? DEFAULTS.response_delay_seconds,
    max_messages_before_handoff: row.max_messages_before_handoff ?? DEFAULTS.max_messages_before_handoff,
    urgency_style: row.urgency_style ?? DEFAULTS.urgency_style,
    social_proof_enabled: row.social_proof_enabled ?? DEFAULTS.social_proof_enabled,
    social_proof_examples: row.social_proof_examples ?? DEFAULTS.social_proof_examples,
    booking_trigger_enabled: row.booking_trigger_enabled ?? DEFAULTS.booking_trigger_enabled,
    booking_trigger_score: row.booking_trigger_score ?? DEFAULTS.booking_trigger_score,
    booking_platform: row.booking_platform ?? DEFAULTS.booking_platform,
    calendly_url: row.calendly_url ?? DEFAULTS.calendly_url,
    booking_offer_message: row.booking_offer_message ?? DEFAULTS.booking_offer_message,
    booking_required_fields: Array.isArray(row.booking_required_fields) ? row.booking_required_fields : DEFAULTS.booking_required_fields,
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
  const prohibited_topics = payload.prohibited_topics !== undefined ? payload.prohibited_topics : (current.prohibited_topics ?? DEFAULTS.prohibited_topics);
  const competitor_mentions = payload.competitor_mentions !== undefined ? payload.competitor_mentions : (current.competitor_mentions ?? DEFAULTS.competitor_mentions);
  const price_reveal = payload.price_reveal !== undefined ? payload.price_reveal : (current.price_reveal ?? DEFAULTS.price_reveal);
  const closing_style = payload.closing_style !== undefined ? payload.closing_style : (current.closing_style ?? DEFAULTS.closing_style);
  const language_code = payload.language_code !== undefined ? payload.language_code : (current.language_code ?? DEFAULTS.language_code);
  const response_delay_seconds = payload.response_delay_seconds !== undefined ? payload.response_delay_seconds : (current.response_delay_seconds ?? DEFAULTS.response_delay_seconds);
  const max_messages_before_handoff = payload.max_messages_before_handoff !== undefined ? payload.max_messages_before_handoff : (current.max_messages_before_handoff ?? DEFAULTS.max_messages_before_handoff);
  const urgency_style = payload.urgency_style !== undefined ? payload.urgency_style : (current.urgency_style ?? DEFAULTS.urgency_style);
  const social_proof_enabled = payload.social_proof_enabled !== undefined ? payload.social_proof_enabled : (current.social_proof_enabled ?? DEFAULTS.social_proof_enabled);
  const social_proof_examples = payload.social_proof_examples !== undefined ? payload.social_proof_examples : (current.social_proof_examples ?? DEFAULTS.social_proof_examples);
  const booking_trigger_enabled = payload.booking_trigger_enabled !== undefined ? payload.booking_trigger_enabled : (current.booking_trigger_enabled ?? DEFAULTS.booking_trigger_enabled);
  const booking_trigger_score = payload.booking_trigger_score !== undefined ? payload.booking_trigger_score : (current.booking_trigger_score ?? DEFAULTS.booking_trigger_score);
  const booking_platform = payload.booking_platform !== undefined ? payload.booking_platform : (current.booking_platform ?? DEFAULTS.booking_platform);
  const calendly_url = payload.calendly_url !== undefined ? payload.calendly_url : (current.calendly_url ?? DEFAULTS.calendly_url);
  const booking_offer_message = payload.booking_offer_message !== undefined ? payload.booking_offer_message : (current.booking_offer_message ?? DEFAULTS.booking_offer_message);
  const booking_required_fields = payload.booking_required_fields !== undefined
    ? (Array.isArray(payload.booking_required_fields) ? payload.booking_required_fields : DEFAULTS.booking_required_fields)
    : (current.booking_required_fields ?? DEFAULTS.booking_required_fields);

  await pool.query(
    `INSERT INTO chatbot_behavior (
      company_id, tone, response_length, emojis_enabled, persona_style, forbidden_topics,
      agent_name, agent_backstory, opener_style, conversation_goal, handoff_trigger,
      follow_up_style, human_fallback_message, bot_deny_response,
      prohibited_topics, competitor_mentions, price_reveal, closing_style, language_code,
      response_delay_seconds, max_messages_before_handoff, urgency_style, social_proof_enabled, social_proof_examples,
      booking_trigger_enabled, booking_trigger_score, booking_platform, calendly_url, booking_offer_message, booking_required_fields, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, NOW())
    ON CONFLICT (company_id) DO UPDATE SET
      tone = $2, response_length = $3, emojis_enabled = $4, persona_style = $5, forbidden_topics = $6,
      agent_name = $7, agent_backstory = $8, opener_style = $9, conversation_goal = $10, handoff_trigger = $11,
      follow_up_style = $12, human_fallback_message = $13, bot_deny_response = $14,
      prohibited_topics = $15, competitor_mentions = $16, price_reveal = $17, closing_style = $18, language_code = $19,
      response_delay_seconds = $20, max_messages_before_handoff = $21, urgency_style = $22, social_proof_enabled = $23, social_proof_examples = $24,
      booking_trigger_enabled = $25, booking_trigger_score = $26, booking_platform = $27, calendly_url = $28, booking_offer_message = $29, booking_required_fields = $30, updated_at = NOW()`,
    [
      companyId, tone, response_length, emojis_enabled, persona_style, forbidden_topics,
      agent_name, agent_backstory, opener_style, conversation_goal, handoff_trigger,
      follow_up_style, human_fallback_message, bot_deny_response,
      prohibited_topics, competitor_mentions, price_reveal, closing_style, language_code,
      response_delay_seconds, max_messages_before_handoff, urgency_style, social_proof_enabled, social_proof_examples,
      booking_trigger_enabled, booking_trigger_score, booking_platform, calendly_url, booking_offer_message, booking_required_fields,
    ]
  );
  return get(companyId);
}

module.exports = { get, upsert };
