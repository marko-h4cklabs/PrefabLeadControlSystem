const { z } = require('zod');

const APPOINTMENT_TYPES = ['call', 'site_visit', 'meeting', 'follow_up'];
const BOOKING_MODES = ['off', 'manual_request', 'direct_booking'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TIME_RE = /^\d{2}:\d{2}$/;

const dayHoursEntrySchema = z.object({
  day: z.enum(DAYS),
  start: z.string().regex(TIME_RE, 'must be HH:MM format'),
  end: z.string().regex(TIME_RE, 'must be HH:MM format'),
}).refine((r) => r.start < r.end, { message: 'start must be before end' });

/**
 * Normalize working_hours from any supported shape to canonical array.
 *
 * Accepted inputs:
 *   1) Array of { day, start, end }  (canonical)
 *   2) Object keyed by weekday with array of { start, end } per day
 *      e.g. { monday: [{ start:"09:00", end:"17:00" }] }
 *   3) Object keyed by weekday with single { start, end } per day
 *      e.g. { monday: { start:"09:00", end:"17:00" } }
 *   4) null / undefined / empty → []
 *
 * Output: Array of { day, start, end }
 */
function normalizeWorkingHours(wh) {
  if (wh == null) return [];

  if (Array.isArray(wh)) return wh;

  if (typeof wh === 'object') {
    const result = [];
    for (const day of DAYS) {
      const val = wh[day];
      if (!val) continue;
      if (Array.isArray(val)) {
        for (const range of val) {
          if (range && typeof range === 'object' && range.start && range.end) {
            result.push({ day, start: range.start, end: range.end });
          }
        }
      } else if (typeof val === 'object' && val.start && val.end) {
        result.push({ day, start: val.start, end: val.end });
      }
    }
    return result;
  }

  return [];
}

const workingHoursSchema = z.preprocess(
  normalizeWorkingHours,
  z.array(dayHoursEntrySchema).optional().default([])
);

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
    chatbotBookingMode: 'chatbot_booking_mode',
    chatbotBookingPromptStyle: 'chatbot_booking_prompt_style',
    chatbotCollectBookingAfterQuote: 'chatbot_collect_booking_after_quote',
    chatbotBookingRequiresName: 'chatbot_booking_requires_name',
    chatbotBookingRequiresPhone: 'chatbot_booking_requires_phone',
    chatbotBookingDefaultType: 'chatbot_booking_default_type',
    chatbotAllowUserProposedTime: 'chatbot_allow_user_proposed_time',
    chatbotShowSlotsWhenAvailable: 'chatbot_show_slots_when_available',
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
  chatbot_booking_mode: z.enum(BOOKING_MODES).optional(),
  chatbot_booking_prompt_style: z.string().trim().min(1).max(100).optional(),
  chatbot_collect_booking_after_quote: z.boolean().optional(),
  chatbot_booking_requires_name: z.boolean().optional(),
  chatbot_booking_requires_phone: z.boolean().optional(),
  chatbot_booking_default_type: z.enum(APPOINTMENT_TYPES).optional(),
  chatbot_allow_user_proposed_time: z.boolean().optional(),
  chatbot_show_slots_when_available: z.boolean().optional(),
}));

module.exports = { schedulingSettingsSchema, normalizeWorkingHours };
