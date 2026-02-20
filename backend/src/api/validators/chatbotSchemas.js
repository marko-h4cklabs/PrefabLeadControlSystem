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

const behaviorBodySchema = z.object({
  tone: z.enum(['professional', 'friendly']).optional(),
  response_length: z.enum(['short', 'medium', 'long']).optional(),
  emojis_enabled: z.boolean().optional(),
  persona_style: z.enum(['busy', 'explanational']).optional(),
  forbidden_topics: z.array(z.string().trim().max(64)).max(50).optional(),
}).transform((d) => {
  const topics = d.forbidden_topics
    ? d.forbidden_topics.map((t) => t.trim()).filter(Boolean).slice(0, 50)
    : undefined;
  return { ...d, forbidden_topics: topics };
});

const PRESET_NAMES = [
  'budget', 'location', 'email_address', 'phone_number', 'full_name',
  'additional_notes', 'doors', 'windows', 'colors', 'dimensions', 'roof',
];

const budgetConfigSchema = z.object({
  units: z.array(z.enum(['EUR', 'USD'])).max(2).optional(),
  defaultUnit: z.enum(['EUR', 'USD']).optional(),
}).refine((d) => !d.defaultUnit || (d.units && d.units.includes(d.defaultUnit)), {
  message: 'defaultUnit must be in units',
  path: ['defaultUnit'],
});

const selectMultiConfigSchema = z.object({
  options: z.array(z.string().trim().min(1).max(40)).max(100).optional(),
});

const dimensionsConfigSchema = z.object({
  enabledParts: z.array(z.enum(['length', 'width', 'height'])).max(3).optional(),
  unit: z.enum(['m', 'cm']).optional(),
});

const presetUpdateSchema = z.object({
  name: z.enum(PRESET_NAMES),
  is_enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
}).refine((d) => {
  if (d.config == null) return true;
  if (d.name === 'budget') return budgetConfigSchema.safeParse(d.config).success;
  if (['location', 'doors', 'windows', 'colors', 'roof'].includes(d.name)) return selectMultiConfigSchema.safeParse(d.config).success;
  if (d.name === 'dimensions') return dimensionsConfigSchema.safeParse(d.config).success;
  return true;
}, { message: 'Invalid config for preset', path: ['config'] });

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
    presets: z.array(presetUpdateSchema).max(11),
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
