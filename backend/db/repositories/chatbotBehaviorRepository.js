const { pool } = require('../index');

const DEFAULTS = {
  tone: 'professional',
  response_length: 'medium',
  emojis_enabled: false,
  persona_style: 'balanced',
  forbidden_topics: [],
  agent_name: 'Alex',
  agent_backstory: null,
  opener_style: 'casual',
  conversation_goal: 'Book a sales call',
  handoff_trigger: 'after_quote',
  follow_up_style: 'gentle',
  human_fallback_message: 'Let me get someone from the team to follow up with you directly.',
  bot_deny_response: "I'm a real person, just quick at responding!",
  prohibited_topics: null,
  competitor_mentions: 'deflect',
  price_reveal: 'ask_first',
  closing_style: 'soft',
  language_code: 'en',
  language_codes: ['en'],
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
  human_error_enabled: false,
  human_error_types: [],
  human_error_random: false,
  no_trailing_period: false,
  conversation_approach: 'field_focused',
  delay_min_seconds: 0,
  delay_max_seconds: 0,
  delay_random_enabled: false,
  follow_ups_enabled: true,
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
  'language_codes',
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
  'human_error_enabled',
  'human_error_types',
  'human_error_random',
  'no_trailing_period',
  'conversation_approach',
  'delay_min_seconds',
  'delay_max_seconds',
  'delay_random_enabled',
  'follow_ups_enabled',
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
    language_codes: Array.isArray(row.language_codes) && row.language_codes.length > 0
      ? row.language_codes
      : (row.language_code ? [row.language_code] : DEFAULTS.language_codes),
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
    human_error_enabled: row.human_error_enabled ?? DEFAULTS.human_error_enabled,
    human_error_types: Array.isArray(row.human_error_types) ? row.human_error_types : DEFAULTS.human_error_types,
    human_error_random: row.human_error_random ?? DEFAULTS.human_error_random,
    no_trailing_period: row.no_trailing_period ?? DEFAULTS.no_trailing_period,
    conversation_approach: row.conversation_approach ?? DEFAULTS.conversation_approach,
    delay_min_seconds: row.delay_min_seconds ?? DEFAULTS.delay_min_seconds,
    delay_max_seconds: row.delay_max_seconds ?? DEFAULTS.delay_max_seconds,
    delay_random_enabled: row.delay_random_enabled ?? DEFAULTS.delay_random_enabled,
    follow_ups_enabled: row.follow_ups_enabled ?? DEFAULTS.follow_ups_enabled,
  };
}

async function get(companyId, mode = 'autopilot') {
  // PK is company_id only — one row per company. Just fetch by company_id.
  const result = await pool.query(
    `SELECT ${COLUMNS.join(', ')} FROM chatbot_behavior WHERE company_id = $1`,
    [companyId]
  );
  return result.rows[0] ? rowToObject(result.rows[0]) : { ...DEFAULTS };
}

async function upsert(companyId, payload, mode = 'autopilot') {
  // Only allow known columns; remove undefined so we explicitly set only what was passed
  const fields = Object.entries(payload)
    .filter(([k]) => COLUMNS.includes(k))
    .filter(([_, v]) => v !== undefined);
  if (fields.length === 0) return get(companyId, mode);

  const columns = fields.map(([col]) => col);
  const values = fields.map(([_, v]) => v);

  // PK is company_id only — one row per company. Check if ANY row exists.
  const check = await pool.query(
    `SELECT 1 FROM chatbot_behavior WHERE company_id = $1`,
    [companyId]
  );

  if (check.rows.length > 0) {
    // UPDATE the existing row (also set operating_mode so GET can find it)
    const setClauses = columns.map((col, i) => `"${col}" = $${i + 2}`).join(', ');
    try {
      await pool.query(
        `UPDATE chatbot_behavior SET ${setClauses}, operating_mode = $${columns.length + 2}, updated_at = NOW() WHERE company_id = $1`,
        [companyId, ...values, mode]
      );
    } catch (err) {
      // operating_mode column may not exist
      if (err.message && err.message.includes('operating_mode')) {
        await pool.query(
          `UPDATE chatbot_behavior SET ${setClauses}, updated_at = NOW() WHERE company_id = $1`,
          [companyId, ...values]
        );
      } else {
        throw err;
      }
    }
  } else {
    // INSERT new row
    try {
      const colsList = columns.map((c) => `"${c}"`).join(', ');
      const placeholders = columns.map((_, i) => `$${i + 3}`).join(', ');
      await pool.query(
        `INSERT INTO chatbot_behavior (company_id, operating_mode, ${colsList}, updated_at)
         VALUES ($1, $2, ${placeholders}, NOW())`,
        [companyId, mode, ...values]
      );
    } catch (err) {
      if (err.message && err.message.includes('operating_mode')) {
        const colsList = columns.map((c) => `"${c}"`).join(', ');
        const placeholders = columns.map((_, i) => `$${i + 2}`).join(', ');
        await pool.query(
          `INSERT INTO chatbot_behavior (company_id, ${colsList}, updated_at)
           VALUES ($1, ${placeholders}, NOW())`,
          [companyId, ...values]
        );
      } else {
        throw err;
      }
    }
  }
  return get(companyId, mode);
}

module.exports = { get, upsert };
