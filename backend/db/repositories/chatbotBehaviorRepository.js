const { pool } = require('../index');

const DEFAULTS = {
  tone: 'professional',
  response_length: 'medium',
  emojis_enabled: false,
  persona_style: 'explanational',
  forbidden_topics: [],
};

async function get(companyId) {
  const result = await pool.query(
    'SELECT tone, response_length, emojis_enabled, persona_style, forbidden_topics FROM chatbot_behavior WHERE company_id = $1',
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return { ...DEFAULTS };
  return {
    tone: row.tone,
    response_length: row.response_length,
    emojis_enabled: row.emojis_enabled ?? false,
    persona_style: row.persona_style,
    forbidden_topics: row.forbidden_topics ?? [],
  };
}

async function upsert(companyId, payload) {
  const tone = payload.tone ?? DEFAULTS.tone;
  const response_length = payload.response_length ?? DEFAULTS.response_length;
  const emojis_enabled = payload.emojis_enabled ?? DEFAULTS.emojis_enabled;
  const persona_style = payload.persona_style ?? DEFAULTS.persona_style;
  const forbidden_topics = Array.isArray(payload.forbidden_topics) ? payload.forbidden_topics : DEFAULTS.forbidden_topics;

  await pool.query(
    `INSERT INTO chatbot_behavior (company_id, tone, response_length, emojis_enabled, persona_style, forbidden_topics, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (company_id) DO UPDATE SET
       tone = $2, response_length = $3, emojis_enabled = $4, persona_style = $5, forbidden_topics = $6, updated_at = NOW()`,
    [companyId, tone, response_length, emojis_enabled, persona_style, forbidden_topics]
  );
  return get(companyId);
}

module.exports = { get, upsert };
