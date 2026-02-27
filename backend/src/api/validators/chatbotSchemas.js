const { z } = require('zod');

const companyInfoBodySchema = z
  .object({
    website_url: z.string().max(2048).nullable().optional(),
    business_description: z.string().max(5000).nullable().optional(),
    additional_notes: z.string().max(5000).nullable().optional(),
  })
  .refine((d) => !d.website_url || d.website_url.trim() === '' || /^https?:\/\/[^\s]+$/.test(d.website_url), {
    message: 'Invalid URL',
    path: ['website_url'],
  })
  .transform((d) => {
    const out = {};
    if (d.website_url !== undefined) out.website_url = d.website_url && d.website_url.trim() ? d.website_url.trim() : null;
    if (d.business_description !== undefined) out.business_description = d.business_description ?? null;
    if (d.additional_notes !== undefined) out.additional_notes = d.additional_notes ?? null;
    return out;
  });

const TONE_VALUES = ['professional', 'friendly', 'confident', 'relatable'];
const RESPONSE_LENGTH_VALUES = ['short', 'medium', 'long'];
const PERSONA_VALUES = ['busy', 'explanational', 'casual', 'formal', 'question', 'statement'];
const OPENER_VALUES = ['casual', 'professional', 'direct', 'formal', 'question', 'statement', 'greeting'];
const HANDOFF_VALUES = ['after_quote', 'after_booking', 'never', 'on_request'];
const FOLLOW_UP_VALUES = ['soft', 'direct', 'value_add', 'value_first', 'gentle', 'persistent'];
const COMPETITOR_VALUES = ['deflect', 'acknowledge', 'ignore'];
const PRICE_VALUES = ['reveal', 'ask_first', 'book_first'];
const CLOSING_VALUES = ['soft', 'direct', 'assumptive'];

function toOptionalEnum(allowed) {
  return z
    .unknown()
    .optional()
    .transform((v) => {
      const s = v != null ? String(v).trim() : '';
      if (!s) return undefined;
      const lower = s.toLowerCase();
      return allowed.includes(s) ? s : allowed.includes(lower) ? lower : undefined;
    });
}

const behaviorBodySchema = z
  .object({
    tone: toOptionalEnum(TONE_VALUES),
    response_length: toOptionalEnum(RESPONSE_LENGTH_VALUES),
    emojis_enabled: z.boolean().optional(),
    persona_style: toOptionalEnum(PERSONA_VALUES),
    forbidden_topics: z.array(z.string().trim().max(64)).max(50).optional(),
    agent_name: z.string().trim().max(100).optional(),
    agent_backstory: z.string().trim().max(2000).nullable().optional(),
    opener_style: toOptionalEnum(OPENER_VALUES),
    conversation_goal: z.string().trim().max(500).optional(),
    handoff_trigger: toOptionalEnum(HANDOFF_VALUES),
    follow_up_style: toOptionalEnum(FOLLOW_UP_VALUES),
    human_fallback_message: z.string().trim().max(500).optional(),
    bot_deny_response: z.string().trim().max(500).optional(),
    prohibited_topics: z.string().trim().max(2000).nullable().optional(),
    competitor_mentions: toOptionalEnum(COMPETITOR_VALUES),
    price_reveal: toOptionalEnum(PRICE_VALUES),
    closing_style: toOptionalEnum(CLOSING_VALUES),
    language_code: z.string().trim().max(10).optional(),
    language_codes: z.array(z.string().trim().min(2).max(10)).min(1).max(10).optional(),
    response_delay_seconds: z.number().int().min(0).max(60).optional(),
    max_messages_before_handoff: z.number().int().min(1).max(100).optional(),
    urgency_style: z.string().trim().max(20).optional(),
    social_proof_enabled: z.boolean().optional(),
    social_proof_examples: z.string().trim().max(3000).nullable().optional(),
    human_error_enabled: z.boolean().optional(),
    human_error_types: z.array(z.string().trim().max(30)).max(10).optional(),
    human_error_random: z.boolean().optional(),
    delay_min_seconds: z.number().int().min(0).max(120).optional(),
    delay_max_seconds: z.number().int().min(0).max(120).optional(),
    delay_random_enabled: z.boolean().optional(),
  })
  .transform((d) => {
    const topics = d.forbidden_topics
      ? d.forbidden_topics.map((t) => t.trim()).filter(Boolean).slice(0, 50)
      : undefined;
    const out = { ...d, forbidden_topics: topics };
    Object.keys(out).forEach((k) => {
      if (out[k] === undefined) delete out[k];
    });
    return out;
  });

const PRESET_NAMES = [
  'budget', 'location', 'time_window', 'email_address', 'phone_number', 'full_name',
  'additional_notes', 'pictures', 'object_type', 'doors', 'windows', 'colors',
  'dimensions', 'roof', 'ground_condition', 'utility_connections', 'completion_level',
];

const BUDGET_UNITS = ['EUR', 'USD'];
const DIMENSION_PARTS = ['length', 'width', 'height'];

/**
 * Normalizes and validates preset config per preset type.
 * Strips unknown keys, applies defaults, ensures consistency (e.g. defaultUnit in units).
 * Returns normalized config or throws with preset name + invalid key for 400 response.
 */
function normalizePresetConfig(name, raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return getDefaultConfigForPreset(name);
  }

  if (name === 'budget') {
    let units = Array.isArray(raw.units)
      ? raw.units.filter((u) => BUDGET_UNITS.includes(u))
      : [...BUDGET_UNITS];
    if (units.length === 0) units = [...BUDGET_UNITS];
    let defaultUnit = raw.defaultUnit;
    if (!defaultUnit || !BUDGET_UNITS.includes(defaultUnit)) defaultUnit = 'EUR';
    if (!units.includes(defaultUnit)) defaultUnit = units[0] ?? 'EUR';
    return { units, defaultUnit, group: 'basic' };
  }

  if (['location', 'time_window', 'doors', 'windows', 'colors', 'roof', 'object_type', 'ground_condition', 'utility_connections', 'completion_level'].includes(name)) {
    const options = Array.isArray(raw.options)
      ? raw.options.map((o) => String(o).trim()).filter((s) => s.length >= 1 && s.length <= 40).slice(0, 100)
      : (name === 'completion_level' ? ['Structural phase', 'Fully finished turnkey'] : []);
    return { options, group: ['location', 'time_window', 'object_type'].includes(name) ? 'basic' : 'detailed' };
  }

  if (name === 'dimensions') {
    let enabledParts = Array.isArray(raw.enabledParts)
      ? raw.enabledParts.filter((p) => DIMENSION_PARTS.includes(p))
      : [...DIMENSION_PARTS];
    if (enabledParts.length === 0) enabledParts = [...DIMENSION_PARTS];
    const unit = raw.unit === 'cm' ? 'cm' : 'm';
    return { enabledParts, unit, group: 'detailed' };
  }

  if (['email_address', 'phone_number', 'full_name', 'additional_notes'].includes(name)) {
    return { group: 'basic' };
  }

  if (name === 'pictures') {
    return { group: 'basic' };
  }

  return {};
}

function getDefaultConfigForPreset(name) {
  if (name === 'budget') return { units: ['EUR', 'USD'], defaultUnit: 'EUR', group: 'basic' };
  if (['location', 'time_window', 'doors', 'windows', 'colors', 'roof', 'object_type', 'ground_condition', 'utility_connections'].includes(name)) return { options: [], group: ['location', 'time_window', 'object_type'].includes(name) ? 'basic' : 'detailed' };
  if (name === 'completion_level') return { options: ['Structural phase', 'Fully finished turnkey'], group: 'detailed' };
  if (name === 'dimensions') return { enabledParts: ['length', 'width', 'height'], unit: 'm', group: 'detailed' };
  if (name === 'pictures') return { group: 'basic' };
  if (['email_address', 'phone_number', 'full_name', 'additional_notes'].includes(name)) return { group: 'basic' };
  return {};
}

const presetUpdateSchema = z
  .object({
    name: z.enum(PRESET_NAMES),
    is_enabled: z.boolean().optional(),
    priority: z.number().int().min(0).optional(),
    config: z.unknown().optional(),
  })
  .transform((d) => ({
    name: d.name,
    is_enabled: d.is_enabled,
    priority: d.priority,
    config: normalizePresetConfig(d.name, d.config),
  }));

const quotePresetsBodySchema = z.preprocess(
  (val) => {
    if (val == null) return { presets: [] };
    if (Array.isArray(val)) return { presets: val };
    if (typeof val === 'object') {
      if (Array.isArray(val.fields)) return { presets: val.fields };
      if (Array.isArray(val.presets)) return val;
      return { presets: [] };
    }
    return { presets: [] };
  },
  z.object({
    presets: z.array(presetUpdateSchema).max(20),
  })
);

const quoteFieldSchema = z.object({
  name: z.string().trim().min(2).max(64),
  type: z.enum(['text', 'number'], { errorMap: () => ({ message: 'type must be "text" or "number" only' }) }),
  units: z.string().trim().max(32).nullable().optional().or(z.literal('')),
  priority: z.number().int().min(0).default(100),
  required: z.boolean().default(true),
});

const quoteFieldsBodySchema = z.object({
  fields: z.array(quoteFieldSchema).max(50),
}).transform((d) => ({
  fields: d.fields.map((f) => ({
    ...f,
    units: f.units && f.units.trim() ? f.units.trim() : null,
  })),
}));

module.exports = {
  companyInfoBodySchema,
  behaviorBodySchema,
  quoteFieldsBodySchema,
  quotePresetsBodySchema,
  PRESET_NAMES,
};
