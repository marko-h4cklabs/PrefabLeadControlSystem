const { z } = require('zod');

const APPOINTMENT_TYPES = ['call', 'site_visit', 'meeting', 'follow_up'];
const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
const APPOINTMENT_SOURCES = ['manual', 'chatbot', 'google_sync'];

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEY_ALIASES = {
  leadId: 'lead_id',
  lead_id: 'lead_id',
  startAt: 'start_at',
  start_at: 'start_at',
  endAt: 'end_at',
  end_at: 'end_at',
  appointmentType: 'appointment_type',
  appointment_type: 'appointment_type',
  type: 'appointment_type',
  reminderMinutesBefore: 'reminder_minutes_before',
  reminder_minutes_before: 'reminder_minutes_before',
  createdByUserId: 'created_by_user_id',
  created_by_user_id: 'created_by_user_id',
  withinDays: 'within_days',
  within_days: 'within_days',
};

function normalizeKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj ?? {};
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    const mapped = KEY_ALIASES[key] || key;
    if (out[mapped] === undefined || out[mapped] === null || out[mapped] === '') {
      out[mapped] = val;
    }
  }
  return out;
}

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

const createAppointmentSchema = z.preprocess(normalizeKeys, z.object({
  lead_id: z.string().regex(uuidRegex, 'lead_id must be a valid UUID'),
  title: z.string().trim().max(500).optional(),
  appointment_type: z.preprocess(
    (v) => enumOrUndef(v, APPOINTMENT_TYPES) ?? undefined,
    z.enum(APPOINTMENT_TYPES).optional().default('call')
  ),
  status: z.preprocess(
    (v) => enumOrUndef(v, APPOINTMENT_STATUSES) ?? undefined,
    z.enum(APPOINTMENT_STATUSES).optional().default('scheduled')
  ),
  start_at: z.string().refine((v) => !isNaN(Date.parse(v)), 'start_at must be valid ISO datetime'),
  end_at: z.string().refine((v) => !isNaN(Date.parse(v)), 'end_at must be valid ISO datetime'),
  timezone: z.string().trim().min(1).max(100).optional().default('Europe/Zagreb'),
  notes: z.string().trim().max(5000).optional().nullable().transform((v) => v || null),
  source: z.preprocess(
    (v) => enumOrUndef(v, APPOINTMENT_SOURCES) ?? undefined,
    z.enum(APPOINTMENT_SOURCES).optional().default('manual')
  ),
  reminder_minutes_before: z.preprocess(
    (v) => (v == null || String(v).trim() === '' ? undefined : v),
    z.coerce.number().int().min(0).max(10080).optional().nullable().transform((v) => v ?? null)
  ),
}).refine((d) => new Date(d.end_at) > new Date(d.start_at), {
  message: 'end_at must be after start_at',
  path: ['end_at'],
}));

const updateAppointmentSchema = z.preprocess(normalizeKeys, z.object({
  title: z.string().trim().max(500).optional(),
  appointment_type: z.preprocess(
    (v) => enumOrUndef(v, APPOINTMENT_TYPES),
    z.enum(APPOINTMENT_TYPES).optional()
  ),
  status: z.preprocess(
    (v) => enumOrUndef(v, APPOINTMENT_STATUSES),
    z.enum(APPOINTMENT_STATUSES).optional()
  ),
  start_at: z.string().refine((v) => !isNaN(Date.parse(v)), 'start_at must be valid ISO datetime').optional(),
  end_at: z.string().refine((v) => !isNaN(Date.parse(v)), 'end_at must be valid ISO datetime').optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(5000).optional().nullable().transform((v) => v === '' ? null : v),
  source: z.preprocess(
    (v) => enumOrUndef(v, APPOINTMENT_SOURCES),
    z.enum(APPOINTMENT_SOURCES).optional()
  ),
  reminder_minutes_before: z.preprocess(
    (v) => (v == null || String(v).trim() === '' ? undefined : v),
    z.coerce.number().int().min(0).max(10080).optional().nullable().transform((v) => v ?? null)
  ),
}).refine((d) => {
  if (d.start_at && d.end_at) return new Date(d.end_at) > new Date(d.start_at);
  return true;
}, { message: 'end_at must be after start_at', path: ['end_at'] }));

const listAppointmentsSchema = z.preprocess(normalizeKeys, z.object({
  from: z.preprocess(dateOrUndef, z.string().refine((v) => !isNaN(Date.parse(v)), 'from must be a valid date').optional()),
  to: z.preprocess(dateOrUndef, z.string().refine((v) => !isNaN(Date.parse(v)), 'to must be a valid date').optional()),
  status: z.preprocess((v) => enumOrUndef(v, APPOINTMENT_STATUSES), z.enum(APPOINTMENT_STATUSES).optional()),
  appointment_type: z.preprocess((v) => enumOrUndef(v, APPOINTMENT_TYPES), z.enum(APPOINTMENT_TYPES).optional()),
  source: z.preprocess((v) => enumOrUndef(v, APPOINTMENT_SOURCES), z.enum(APPOINTMENT_SOURCES).optional()),
  lead_id: z.preprocess(trimOrUndef, z.string().regex(uuidRegex, 'lead_id must be a valid UUID').optional()),
  limit: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(1).max(500).optional().default(100)),
  offset: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(0).optional().default(0)),
}));

const upcomingSchema = z.preprocess(normalizeKeys, z.object({
  limit: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(1).max(100).optional().default(10)),
  within_days: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(1).max(365).optional().default(30)),
}));

const cancelSchema = z.preprocess(normalizeKeys, z.object({
  note: z.string().trim().max(2000).optional().nullable().transform((v) => v || null),
}));

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
