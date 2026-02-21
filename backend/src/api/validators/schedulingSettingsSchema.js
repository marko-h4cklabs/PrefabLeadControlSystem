const { z } = require('zod');

const APPOINTMENT_TYPES = ['call', 'site_visit', 'meeting', 'follow_up'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TIME_RE = /^\d{2}:\d{2}$/;

const timeRangeSchema = z.object({
  start: z.string().regex(TIME_RE, 'must be HH:MM format'),
  end: z.string().regex(TIME_RE, 'must be HH:MM format'),
}).refine((r) => r.start < r.end, { message: 'start must be before end' });

const workingHoursSchema = z.record(
  z.enum(DAYS),
  z.array(timeRangeSchema)
).optional();

const reminderDefaultsSchema = z.object({
  email: z.boolean().optional().default(true),
  inApp: z.boolean().optional().default(true),
  minutesBefore: z.coerce.number().int().min(0).max(10080).optional().default(60),
}).optional();

function camelOrSnake(obj) {
  if (!obj || typeof obj !== 'object') return obj ?? {};
  const map = {
    slotDurationMinutes: 'slot_duration_minutes',
    bufferBeforeMinutes: 'buffer_before_minutes',
    bufferAfterMinutes: 'buffer_after_minutes',
    minNoticeHours: 'min_notice_hours',
    maxDaysAhead: 'max_days_ahead',
    allowedAppointmentTypes: 'allowed_appointment_types',
    allowManualBookingFromLead: 'allow_manual_booking_from_lead',
    chatbotOfferBooking: 'chatbot_offer_booking',
    reminderDefaults: 'reminder_defaults',
    workingHours: 'working_hours',
  };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[map[k] || k] = v;
  }
  return out;
}

const schedulingSettingsSchema = z.preprocess(camelOrSnake, z.object({
  enabled: z.boolean().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  working_hours: workingHoursSchema,
  slot_duration_minutes: z.coerce.number().int().min(5).max(240).optional(),
  buffer_before_minutes: z.coerce.number().int().min(0).max(120).optional(),
  buffer_after_minutes: z.coerce.number().int().min(0).max(120).optional(),
  min_notice_hours: z.coerce.number().int().min(0).max(168).optional(),
  max_days_ahead: z.coerce.number().int().min(1).max(365).optional(),
  allowed_appointment_types: z.array(z.enum(APPOINTMENT_TYPES)).min(1).optional(),
  allow_manual_booking_from_lead: z.boolean().optional(),
  chatbot_offer_booking: z.boolean().optional(),
  reminder_defaults: reminderDefaultsSchema,
}));

module.exports = { schedulingSettingsSchema };
