const { z } = require('zod');

const APPOINTMENT_TYPES = ['call', 'site_visit', 'meeting', 'follow_up'];
const BOOKING_MODES = ['off', 'manual_request', 'direct_booking'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TIME_RE = /^\d{2}:\d{2}$/;

const SHORT_TO_FULL = {
  mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday',
  fri: 'friday', sat: 'saturday', sun: 'sunday',
};

function fullDayName(d) {
  if (!d || typeof d !== 'string') return null;
  const low = d.trim().toLowerCase();
  return SHORT_TO_FULL[low] || (DAYS.includes(low) ? low : null);
}

const dayHoursEntrySchema = z.object({
  day: z.enum(DAYS),
  start: z.string().regex(TIME_RE, 'must be HH:MM format'),
  end: z.string().regex(TIME_RE, 'must be HH:MM format'),
}).refine((r) => r.start < r.end, { message: 'start must be before end' });

/**
 * Normalize working_hours from any supported shape to canonical flat array.
 *
 * Accepted inputs:
 *   1) Array of { day, start, end }  (canonical)
 *   2) Array of { day, enabled?, ranges: [{ start, end }] }  (Lovable UI shape)
 *   3) Object keyed by weekday with array of { start, end } per day
 *   4) Object keyed by weekday with single { start, end } per day
 *   5) null / undefined / empty → []
 *
 * Day names accept both full ("monday") and abbreviated ("mon").
 * Disabled days (enabled===false or empty ranges) produce zero entries.
 *
 * Output: Array of { day, start, end } (canonical flat)
 */
function normalizeWorkingHours(wh) {
  if (wh == null) return [];

  if (Array.isArray(wh)) {
    const result = [];
    for (const item of wh) {
      if (!item || typeof item !== 'object') continue;
      const dayName = fullDayName(item.day);
      if (!dayName) continue;

      if (Array.isArray(item.ranges)) {
        if (item.enabled === false) continue;
        for (const range of item.ranges) {
          if (range && typeof range === 'object' && range.start && range.end) {
            result.push({ day: dayName, start: range.start, end: range.end });
          }
        }
        continue;
      }

      if (item.start && item.end) {
        result.push({ day: dayName, start: item.start, end: item.end });
      }
    }
    return result;
  }

  if (typeof wh === 'object') {
    const result = [];
    for (const day of DAYS) {
      const val = wh[day] || wh[day.slice(0, 3)];
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

/**
 * Normalize frontend payload to canonical snake_case keys.
 *
 * Handles all known frontend aliases:
 *   camelCase (chatbotOfferBooking)
 *   Lovable aliases (enableChatbotBookingOffers, askForBookingAfterQuote)
 *   Nested chatbot_booking.enabled block
 */
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
    reminderDefaults: 'reminder_defaults',
    workingHours: 'working_hours',

    chatbotOfferBooking: 'chatbot_offer_booking',
    enableChatbotBookingOffers: 'chatbot_offer_booking',
    enable_chatbot_booking_offers: 'chatbot_offer_booking',
    askForBookingAfterQuote: 'chatbot_offer_booking',
    ask_for_booking_after_quote: 'chatbot_offer_booking',

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
    if (k === 'chatbot_booking' && v && typeof v === 'object') {
      if (v.enabled !== undefined) out.chatbot_offer_booking = v.enabled;
      if (v.mode !== undefined) out.chatbot_booking_mode = v.mode;
      if (v.promptStyle !== undefined) out.chatbot_booking_prompt_style = v.promptStyle;
      if (v.collectAfterQuote !== undefined) out.chatbot_collect_booking_after_quote = v.collectAfterQuote;
      if (v.requiresName !== undefined) out.chatbot_booking_requires_name = v.requiresName;
      if (v.requiresPhone !== undefined) out.chatbot_booking_requires_phone = v.requiresPhone;
      if (v.defaultType !== undefined) out.chatbot_booking_default_type = v.defaultType;
      if (v.allowUserProposedTime !== undefined) out.chatbot_allow_user_proposed_time = v.allowUserProposedTime;
      if (v.showSlotsWhenAvailable !== undefined) out.chatbot_show_slots_when_available = v.showSlotsWhenAvailable;
      continue;
    }
    const mapped = map[k] || k;
    if (out[mapped] === undefined) out[mapped] = v;
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
