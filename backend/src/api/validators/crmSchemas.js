const { z } = require('zod');

const uuidSchema = z.string().uuid();

const crmActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const crmSummaryQuerySchema = z.object({
  activityLimit: z.coerce.number().int().min(1).max(100).optional().default(20),
  notesLimit: z.coerce.number().int().min(1).max(100).optional().default(20),
  tasksLimit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const crmNotesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const crmTasksQuerySchema = z.object({
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Accept body, text, or content (frontend may use different keys) - normalize to body
const createNoteBodySchema = z
  .object({
    body: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
  })
  .transform((o) => ({ body: String(o?.body ?? o?.text ?? o?.content ?? '').trim() }))
  .refine((o) => o.body.length >= 1, { message: 'Note content is required', path: ['body'] })
  .refine((o) => o.body.length <= 5000, { message: 'Note must be at most 5000 characters', path: ['body'] });

const updateNoteBodySchema = z
  .object({
    body: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
  })
  .transform((o) => ({ body: String(o?.body ?? o?.text ?? o?.content ?? '').trim() }))
  .refine((o) => o.body.length >= 1, { message: 'Note content is required', path: ['body'] })
  .refine((o) => o.body.length <= 5000, { message: 'Note must be at most 5000 characters', path: ['body'] });

const createTaskBodySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(250, 'title must be at most 250 characters'),
  description: z
    .string()
    .trim()
    .max(2000, 'description must be at most 2000 characters')
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v)),
  due_at: z
    .string()
    .refine((v) => !v || v === '' || !isNaN(Date.parse(v)), 'due_at must be valid ISO date/datetime')
    .optional()
    .nullable()
    .transform((v) => (v === '' || !v ? null : v)),
  assigned_user_id: uuidSchema.optional().nullable().transform((v) => (v === '' ? null : v)),
});

const updateTaskBodySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(250)
    .optional(),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v)),
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  due_at: z
    .string()
    .refine((v) => !v || v === '' || !isNaN(Date.parse(v)), 'due_at must be valid ISO date/datetime')
    .optional()
    .nullable()
    .transform((v) => (v === '' || !v ? null : v)),
  assigned_user_id: uuidSchema.optional().nullable().transform((v) => (v === '' ? null : v)),
});

module.exports = {
  uuidSchema,
  crmActivityQuerySchema,
  crmSummaryQuerySchema,
  crmNotesQuerySchema,
  crmTasksQuerySchema,
  createNoteBodySchema,
  updateNoteBodySchema,
  createTaskBodySchema,
  updateTaskBodySchema,
};
