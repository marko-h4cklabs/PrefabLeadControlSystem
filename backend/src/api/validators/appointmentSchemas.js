const { z } = require('zod');

const APPOINTMENT_TYPES = ['call', 'site_visit', 'meeting', 'follow_up'];
const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
const APPOINTMENT_SOURCES = ['manual', 'chatbot', 'google_sync'];

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trimOrUndef(v) {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function enumOrUndef(v, allowed) {
  const s = trimOrUndef(v);
  if (!s || s === 'all') return undefined;
  const low = s.toLowerCase();
  return allowed.includes(low) ? low : s;
}

function dateOrUndef(v) {
  const s = trimOrUndef(v);
  if (!s) return undefined;
  return s;
}

const createAppointmentSchema = z.object({
  lead_id: z.string().regex(uuidRegex, 'lead_id must be a valid UUID'),
  title: z.string().trim().max(500).optional(),
  appointment_type: z.enum(APPOINTMENT_TYPES).optional().default('call'),
  status: z.enum(APPOINTMENT_STATUSES).optional().default('scheduled'),
  start_at: z.string().refine((v) => !isNaN(Date.parse(v)), 'start_at must be valid ISO datetime'),
  end_at: z.string().refine((v) => !isNaN(Date.parse(v)), 'end_at must be valid ISO datetime'),
  timezone: z.string().trim().min(1).max(100).optional().default('Europe/Zagreb'),
  notes: z.string().trim().max(5000).optional().nullable().transform((v) => v || null),
  source: z.enum(APPOINTMENT_SOURCES).optional().default('manual'),
  reminder_minutes_before: z.coerce.number().int().min(0).max(10080).optional().nullable().transform((v) => v ?? null),
}).refine((d) => new Date(d.end_at) > new Date(d.start_at), {
  message: 'end_at must be after start_at',
  path: ['end_at'],
});

const updateAppointmentSchema = z.object({
  title: z.string().trim().max(500).optional(),
  appointment_type: z.enum(APPOINTMENT_TYPES).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  start_at: z.string().refine((v) => !isNaN(Date.parse(v)), 'start_at must be valid ISO datetime').optional(),
  end_at: z.string().refine((v) => !isNaN(Date.parse(v)), 'end_at must be valid ISO datetime').optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(5000).optional().nullable().transform((v) => v === '' ? null : v),
  source: z.enum(APPOINTMENT_SOURCES).optional(),
  reminder_minutes_before: z.coerce.number().int().min(0).max(10080).optional().nullable().transform((v) => v ?? null),
}).refine((d) => {
  if (d.start_at && d.end_at) return new Date(d.end_at) > new Date(d.start_at);
  return true;
}, { message: 'end_at must be after start_at', path: ['end_at'] });

const listAppointmentsSchema = z.object({
  from: z.preprocess(dateOrUndef, z.string().refine((v) => !isNaN(Date.parse(v)), 'from must be a valid date').optional()),
  to: z.preprocess(dateOrUndef, z.string().refine((v) => !isNaN(Date.parse(v)), 'to must be a valid date').optional()),
  status: z.preprocess((v) => enumOrUndef(v, APPOINTMENT_STATUSES), z.enum(APPOINTMENT_STATUSES).optional()),
  appointment_type: z.preprocess((v) => enumOrUndef(v, APPOINTMENT_TYPES), z.enum(APPOINTMENT_TYPES).optional()),
  type: z.preprocess((v) => enumOrUndef(v, APPOINTMENT_TYPES), z.enum(APPOINTMENT_TYPES).optional()),
  source: z.preprocess((v) => enumOrUndef(v, APPOINTMENT_SOURCES), z.enum(APPOINTMENT_SOURCES).optional()),
  lead_id: z.preprocess(trimOrUndef, z.string().regex(uuidRegex, 'lead_id must be a valid UUID').optional()),
  limit: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(1).max(500).optional().default(100)),
  offset: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(0).optional().default(0)),
}).transform((d) => {
  const { type, ...rest } = d;
  return { ...rest, appointment_type: rest.appointment_type ?? type };
});

const upcomingSchema = z.object({
  limit: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(1).max(100).optional().default(10)),
  within_days: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(1).max(365).optional().default(30)),
  withinDays: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(1).max(365).optional()),
}).transform((d) => ({
  limit: d.limit,
  within_days: d.within_days ?? d.withinDays ?? 30,
}));

const cancelSchema = z.object({
  note: z.string().trim().max(2000).optional().nullable().transform((v) => v || null),
});

module.exports = {
  createAppointmentSchema,
  updateAppointmentSchema,
  listAppointmentsSchema,
  upcomingSchema,
  cancelSchema,
  APPOINTMENT_TYPES,
  APPOINTMENT_STATUSES,
  APPOINTMENT_SOURCES,
};
