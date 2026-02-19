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

const quoteFieldSchema = z.object({
  name: z.string().trim().min(2).max(64),
  type: z.enum(['text', 'number', 'select', 'boolean']),
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
};
