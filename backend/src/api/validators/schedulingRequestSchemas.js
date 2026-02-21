const { z } = require('zod');

const REQUEST_TYPES = ['call', 'site_visit', 'meeting', 'follow_up'];
const REQUEST_STATUSES = ['open', 'converted', 'closed', 'cancelled'];
const SOURCES = ['chatbot', 'manual'];
const AVAILABILITY_MODES = ['manual', 'slot_selected'];

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KEY_ALIASES = {
  leadId: 'lead_id', lead_id: 'lead_id',
  conversationId: 'conversation_id', conversation_id: 'conversation_id',
  requestType: 'request_type', request_type: 'request_type',
  preferredDate: 'preferred_date', preferred_date: 'preferred_date',
  preferredTime: 'preferred_time', preferred_time: 'preferred_time',
  preferredTimeWindow: 'preferred_time_window', preferred_time_window: 'preferred_time_window',
  preferredTimezone: 'preferred_timezone', preferred_timezone: 'preferred_timezone',
  availabilityMode: 'availability_mode', availability_mode: 'availability_mode',
  selectedSlotStartAt: 'selected_slot_start_at', selected_slot_start_at: 'selected_slot_start_at',
  selectedSlotEndAt: 'selected_slot_end_at', selected_slot_end_at: 'selected_slot_end_at',
  createdByUserId: 'created_by_user_id', created_by_user_id: 'created_by_user_id',
  convertedAppointmentId: 'converted_appointment_id', converted_appointment_id: 'converted_appointment_id',
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

const createSchedulingRequestSchema = z.preprocess(normalizeKeys, z.object({
  lead_id: z.string().regex(uuidRegex, 'lead_id must be a valid UUID'),
  conversation_id: z.preprocess(trimOrUndef, z.string().regex(uuidRegex, 'conversation_id must be a valid UUID').optional().nullable()),
  source: z.preprocess(
    (v) => enumOrUndef(v, SOURCES) ?? undefined,
    z.enum(SOURCES).optional().default('chatbot')
  ),
  request_type: z.preprocess(
    (v) => enumOrUndef(v, REQUEST_TYPES) ?? undefined,
    z.enum(REQUEST_TYPES).optional().default('call')
  ),
  preferred_date: z.preprocess(trimOrUndef, z.string().regex(DATE_RE, 'preferred_date must be YYYY-MM-DD').optional().nullable()),
  preferred_time: z.preprocess(trimOrUndef, z.string().regex(TIME_RE, 'preferred_time must be HH:MM').optional().nullable()),
  preferred_time_window: z.any().optional().default({}),
  preferred_timezone: z.preprocess(trimOrUndef, z.string().min(1).max(100).optional().default('Europe/Zagreb')),
  availability_mode: z.preprocess(
    (v) => enumOrUndef(v, AVAILABILITY_MODES) ?? undefined,
    z.enum(AVAILABILITY_MODES).optional().default('manual')
  ),
  selected_slot_start_at: z.preprocess(trimOrUndef, z.string().refine((v) => !isNaN(Date.parse(v)), 'must be valid ISO datetime').optional().nullable()),
  selected_slot_end_at: z.preprocess(trimOrUndef, z.string().refine((v) => !isNaN(Date.parse(v)), 'must be valid ISO datetime').optional().nullable()),
  notes: z.preprocess(trimOrUndef, z.string().max(5000).optional().nullable()),
  metadata: z.any().optional().default({}),
}).refine((d) => {
  if (d.availability_mode === 'slot_selected') {
    return d.selected_slot_start_at && d.selected_slot_end_at;
  }
  return true;
}, { message: 'selected_slot_start_at and selected_slot_end_at required when availability_mode is slot_selected', path: ['selected_slot_start_at'] }));

const updateSchedulingRequestSchema = z.preprocess(normalizeKeys, z.object({
  status: z.preprocess((v) => enumOrUndef(v, REQUEST_STATUSES), z.enum(REQUEST_STATUSES).optional()),
  request_type: z.preprocess((v) => enumOrUndef(v, REQUEST_TYPES), z.enum(REQUEST_TYPES).optional()),
  preferred_date: z.preprocess(trimOrUndef, z.string().regex(DATE_RE, 'preferred_date must be YYYY-MM-DD').optional().nullable()),
  preferred_time: z.preprocess(trimOrUndef, z.string().regex(TIME_RE, 'preferred_time must be HH:MM').optional().nullable()),
  preferred_time_window: z.any().optional(),
  preferred_timezone: z.preprocess(trimOrUndef, z.string().min(1).max(100).optional()),
  availability_mode: z.preprocess((v) => enumOrUndef(v, AVAILABILITY_MODES), z.enum(AVAILABILITY_MODES).optional()),
  selected_slot_start_at: z.preprocess(trimOrUndef, z.string().refine((v) => !isNaN(Date.parse(v)), 'must be valid ISO datetime').optional().nullable()),
  selected_slot_end_at: z.preprocess(trimOrUndef, z.string().refine((v) => !isNaN(Date.parse(v)), 'must be valid ISO datetime').optional().nullable()),
  notes: z.preprocess(trimOrUndef, z.string().max(5000).optional().nullable()),
  metadata: z.any().optional(),
}));

const listSchedulingRequestsSchema = z.preprocess(normalizeKeys, z.object({
  status: z.preprocess((v) => enumOrUndef(v, REQUEST_STATUSES), z.enum(REQUEST_STATUSES).optional()),
  lead_id: z.preprocess(trimOrUndef, z.string().regex(uuidRegex, 'lead_id must be a valid UUID').optional()),
  request_type: z.preprocess((v) => enumOrUndef(v, REQUEST_TYPES), z.enum(REQUEST_TYPES).optional()),
  limit: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(1).max(200).optional().default(50)),
  offset: z.preprocess((v) => trimOrUndef(v) ?? undefined, z.coerce.number().int().min(0).optional().default(0)),
}));

const chatbotIntakeSchema = z.preprocess(normalizeKeys, z.object({
  lead_id: z.string().regex(uuidRegex, 'lead_id must be a valid UUID'),
  conversation_id: z.preprocess(trimOrUndef, z.string().regex(uuidRegex).optional().nullable()),
  intent: z.object({
    wantsBooking: z.boolean().optional().default(true),
    requestType: z.preprocess(
      (v) => enumOrUndef(v, REQUEST_TYPES) ?? undefined,
      z.enum(REQUEST_TYPES).optional().default('call')
    ),
    preferredDate: z.preprocess(trimOrUndef, z.string().regex(DATE_RE).optional().nullable()),
    preferredTime: z.preprocess(trimOrUndef, z.string().regex(TIME_RE).optional().nullable()),
    preferredTimeWindow: z.any().optional().default({}),
    timezone: z.preprocess(trimOrUndef, z.string().min(1).max(100).optional().default('Europe/Zagreb')),
    notes: z.preprocess(trimOrUndef, z.string().max(5000).optional().nullable()),
  }).optional().default({}),
}));

module.exports = {
  createSchedulingRequestSchema,
  updateSchedulingRequestSchema,
  listSchedulingRequestsSchema,
  chatbotIntakeSchema,
  REQUEST_TYPES,
  REQUEST_STATUSES,
  SOURCES,
  AVAILABILITY_MODES,
};
