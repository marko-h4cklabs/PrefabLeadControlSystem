const { z } = require('zod');

const VALID_CHANNELS = ['messenger', 'instagram', 'whatsapp', 'telegram', 'email'];
const VALID_STATUSES = ['new', 'contacted', 'qualified', 'booked', 'closed_won', 'closed_lost'];

const externalIdRegex = /^[a-z0-9_\-]{2,64}$/;

const listLeadsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(VALID_STATUSES).optional(),
});

const createLeadBodySchema = z.object({
  channel: z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => VALID_CHANNELS.includes(v), {
      message: `channel must be one of: ${VALID_CHANNELS.join(', ')}`,
    }),
  external_id: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'external_id must be 2-64 characters')
    .max(64, 'external_id must be 2-64 characters')
    .regex(externalIdRegex, 'external_id may only contain a-z, 0-9, _, -'),
});

const updateLeadBodySchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
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

module.exports = {
  VALID_CHANNELS,
  VALID_STATUSES,
  listLeadsQuerySchema,
  createLeadBodySchema,
  updateLeadBodySchema,
};
