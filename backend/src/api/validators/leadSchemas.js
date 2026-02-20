const { z } = require('zod');

const VALID_CHANNELS = ['messenger', 'instagram', 'whatsapp', 'telegram', 'email'];
const VALID_STATUSES = ['new', 'contacted', 'qualified', 'booked', 'closed_won', 'closed_lost'];

const externalIdRegex = /^[a-z0-9_\-]{2,64}$/;
// Human name: Unicode letters, diacritics, spaces, apostrophe, hyphen, dot; trim + collapse spaces
const createLeadNameRegex = /^[\p{L}\p{M}\u0027\u2019.\-\s]+$/u;

function collapseSpaces(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

const uuidOptional = z
  .string()
  .optional()
  .refine((v) => !v || v === 'all' || v === '__ALL__' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v), {
    message: 'status_id must be a valid UUID, "all", or "__ALL__"',
  })
  .transform((v) => (v && v.trim() ? v : undefined));

const listLeadsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(VALID_STATUSES).optional(),
  statusId: uuidOptional,
  status_id: uuidOptional,
  query: z
    .string()
    .optional()
    .transform((v) => (v != null ? String(v).trim() : undefined))
    .refine((v) => !v || v.length <= 80, 'query must be at most 80 characters')
    .transform((v) => (v === '' ? undefined : v)),
  source: z.enum(['inbox', 'simulation']).optional(),
});

const createLeadBodySchema = z
  .object({
    channel: z
      .string()
      .trim()
      .min(1, 'channel is required')
      .max(50)
      .transform((v) => v.toLowerCase()),
    name: z
      .string()
      .optional()
      .transform((v) => (v != null ? collapseSpaces(v) : undefined))
      .refine((v) => !v || v.length >= 2, 'name must be at least 2 characters')
      .refine((v) => !v || v.length <= 80, 'name must be at most 80 characters')
      .refine((v) => !v || createLeadNameRegex.test(v), 'name may only contain letters, spaces, apostrophe, hyphen, dot')
      .transform((v) => (v === '' ? undefined : v)),
    external_id: z
      .string()
      .trim()
      .min(2, 'external_id must be 2-64 characters')
      .max(64)
      .regex(externalIdRegex, 'external_id may only contain a-z, 0-9, _, -')
      .optional(),
  })
  .refine((data) => data.name || data.external_id, {
    message: 'Either name or external_id is required',
    path: ['name'],
  });

const updateLeadBodySchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  status_id: z.string().uuid().optional(),
  assigned_sales: z.string().uuid().nullable().optional(),
  channel: z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => VALID_CHANNELS.includes(v), {
      message: `channel must be one of: ${VALID_CHANNELS.join(', ')}`,
    })
    .optional(),
});

// Human name: Unicode letters and spaces; allow empty/null
const nameRegex = /^[\p{L}]+(?:[\s\p{L}]+)*$/u;
const patchNameBodySchema = z.object({
  name: z
    .string()
    .optional()
    .transform((v) => (v != null ? String(v).trim() : ''))
    .refine((v) => v === '' || nameRegex.test(v), {
      message: 'name must contain only letters and spaces',
    })
    .transform((v) => (v === '' ? null : v)),
});

const patchStatusBodySchema = z.object({
  status_id: z.string().uuid(),
});

module.exports = {
  VALID_CHANNELS,
  VALID_STATUSES,
  listLeadsQuerySchema,
  createLeadBodySchema,
  updateLeadBodySchema,
  patchNameBodySchema,
  patchStatusBodySchema,
};
