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

/* ------------------------------------------------------------------ */
/*  Priority-based alias resolution                                    */
/*                                                                     */
/*  For each canonical field, pick the FIRST boolean/value found       */
/*  walking down the priority list. This makes the outcome             */
/*  deterministic regardless of JSON key order.                        */
/* ------------------------------------------------------------------ */

function pickBool(obj, nested, keys) {
  if (nested && typeof nested === 'object') {
    for (const k of keys.filter((k) => k.startsWith('_nested.'))) {
      const nk = k.slice(8);
      if (typeof nested[nk] === 'boolean') return nested[nk];
    }
  }
  for (const k of keys) {
    if (k.startsWith('_nested.')) continue;
    if (typeof obj[k] === 'boolean') return obj[k];
  }
  return undefined;
}

function pickStr(obj, nested, keys) {
  if (nested && typeof nested === 'object') {
    for (const k of keys.filter((k) => k.startsWith('_nested.'))) {
      const nk = k.slice(8);
      if (typeof nested[nk] === 'string' && nested[nk].trim()) return nested[nk].trim();
    }
  }
  for (const k of keys) {
    if (k.startsWith('_nested.')) continue;
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  }
  return undefined;
}

function pickAny(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

/**
 * Normalize frontend payload to canonical snake_case, resolving conflicts.
 *
 * PRECEDENCE (highest → lowest per canonical field):
 *   1. Nested chatbot_booking.{key} (most specific)
 *   2. Canonical snake_case key
 *   3. camelCase alias
 *   4. Lovable / legacy aliases
 *
 * Only canonical keys survive in the output — all aliases are consumed.
 */
function camelOrSnake(obj) {
  if (!obj || typeof obj !== 'object') return obj ?? {};

  const nested = (obj.chatbot_booking && typeof obj.chatbot_booking === 'object')
    ? obj.chatbot_booking : null;
  const conflicts = [];

  function trackConflict(canonical, resolved, sources) {
    const found = sources.filter(([, v]) => v !== undefined);
    if (found.length > 1) {
      conflicts.push({ field: canonical, resolved, sources: found.map(([k, v]) => `${k}=${v}`) });
    }
  }

  // --- enabled (scheduling toggle) ---
  const enabledVal = pickBool(obj, null, [
    'enabled',
    'scheduling_enabled',
    'schedulingEnabled',
  ]);
  trackConflict('enabled', enabledVal, [
    ['enabled', typeof obj.enabled === 'boolean' ? obj.enabled : undefined],
    ['scheduling_enabled', typeof obj.scheduling_enabled === 'boolean' ? obj.scheduling_enabled : undefined],
    ['schedulingEnabled', typeof obj.schedulingEnabled === 'boolean' ? obj.schedulingEnabled : undefined],
  ]);

  // --- chatbot_offer_booking (booking toggle) ---
  const bookingVal = pickBool(obj, nested, [
    '_nested.chatbot_booking_enabled',
    '_nested.enabled',
    'chatbot_offer_booking',
    'chatbotOfferBooking',
    'chatbot_booking_enabled',
    'chatbot_offers_booking',
    'enableChatbotBookingOffers',
    'enable_chatbot_booking_offers',
    'askForBookingAfterQuote',
    'ask_for_booking_after_quote',
  ]);
  {
    const sources = [
      ['chatbot_booking.chatbot_booking_enabled', nested ? (typeof nested.chatbot_booking_enabled === 'boolean' ? nested.chatbot_booking_enabled : undefined) : undefined],
      ['chatbot_booking.enabled', nested ? (typeof nested.enabled === 'boolean' ? nested.enabled : undefined) : undefined],
      ['chatbot_offer_booking', typeof obj.chatbot_offer_booking === 'boolean' ? obj.chatbot_offer_booking : undefined],
      ['chatbotOfferBooking', typeof obj.chatbotOfferBooking === 'boolean' ? obj.chatbotOfferBooking : undefined],
      ['chatbot_booking_enabled', typeof obj.chatbot_booking_enabled === 'boolean' ? obj.chatbot_booking_enabled : undefined],
      ['chatbot_offers_booking', typeof obj.chatbot_offers_booking === 'boolean' ? obj.chatbot_offers_booking : undefined],
      ['enableChatbotBookingOffers', typeof obj.enableChatbotBookingOffers === 'boolean' ? obj.enableChatbotBookingOffers : undefined],
      ['enable_chatbot_booking_offers', typeof obj.enable_chatbot_booking_offers === 'boolean' ? obj.enable_chatbot_booking_offers : undefined],
    ];
    trackConflict('chatbot_offer_booking', bookingVal, sources);
  }

  // --- chatbot_booking_mode ---
  const modeVal = pickStr(obj, nested, [
    '_nested.mode',
    '_nested.chatbot_booking_mode',
    'chatbot_booking_mode',
    'chatbotBookingMode',
  ]);

  // --- chatbot_collect_booking_after_quote ---
  const collectVal = pickBool(obj, nested, [
    '_nested.collectAfterQuote',
    '_nested.chatbot_collect_booking_after_quote',
    'chatbot_collect_booking_after_quote',
    'chatbotCollectBookingAfterQuote',
  ]);

  // --- chatbot_booking_requires_name ---
  const reqNameVal = pickBool(obj, nested, [
    '_nested.requiresName',
    '_nested.chatbot_booking_requires_name',
    'chatbot_booking_requires_name',
    'chatbotBookingRequiresName',
  ]);

  // --- chatbot_booking_requires_phone ---
  const reqPhoneVal = pickBool(obj, nested, [
    '_nested.requiresPhone',
    '_nested.chatbot_booking_requires_phone',
    'chatbot_booking_requires_phone',
    'chatbotBookingRequiresPhone',
  ]);

  // --- chatbot_booking_prompt_style ---
  const promptStyleVal = pickStr(obj, nested, [
    '_nested.promptStyle',
    '_nested.chatbot_booking_prompt_style',
    'chatbot_booking_prompt_style',
    'chatbotBookingPromptStyle',
  ]);

  // --- chatbot_booking_default_type ---
  const defaultTypeVal = pickStr(obj, nested, [
    '_nested.defaultType',
    '_nested.chatbot_booking_default_type',
    'chatbot_booking_default_type',
    'chatbotBookingDefaultType',
  ]);

  // --- chatbot_allow_user_proposed_time ---
  const allowTimeVal = pickBool(obj, nested, [
    '_nested.allowUserProposedTime',
    '_nested.chatbot_allow_user_proposed_time',
    'chatbot_allow_user_proposed_time',
    'chatbotAllowUserProposedTime',
  ]);

  // --- chatbot_show_slots_when_available ---
  const showSlotsVal = pickBool(obj, nested, [
    '_nested.showSlotsWhenAvailable',
    '_nested.chatbot_show_slots_when_available',
    'chatbot_show_slots_when_available',
    'chatbotShowSlotsWhenAvailable',
  ]);

  if (conflicts.length > 0) {
    console.warn('[scheduling-settings] alias conflicts resolved:', JSON.stringify(conflicts));
  }

  // --- Simple aliases (no conflicts expected) ---
  const out = {};
  if (enabledVal !== undefined) out.enabled = enabledVal;
  if (bookingVal !== undefined) out.chatbot_offer_booking = bookingVal;
  if (modeVal !== undefined) out.chatbot_booking_mode = modeVal;
  if (collectVal !== undefined) out.chatbot_collect_booking_after_quote = collectVal;
  if (reqNameVal !== undefined) out.chatbot_booking_requires_name = reqNameVal;
  if (reqPhoneVal !== undefined) out.chatbot_booking_requires_phone = reqPhoneVal;
  if (promptStyleVal !== undefined) out.chatbot_booking_prompt_style = promptStyleVal;
  if (defaultTypeVal !== undefined) out.chatbot_booking_default_type = defaultTypeVal;
  if (allowTimeVal !== undefined) out.chatbot_allow_user_proposed_time = allowTimeVal;
  if (showSlotsVal !== undefined) out.chatbot_show_slots_when_available = showSlotsVal;

  const simpleMap = {
    slotDurationMinutes: 'slot_duration_minutes',
    bufferBeforeMinutes: 'buffer_before_minutes',
    bufferAfterMinutes: 'buffer_after_minutes',
    minNoticeHours: 'min_notice_hours',
    maxDaysAhead: 'max_days_ahead',
    allowedAppointmentTypes: 'allowed_appointment_types',
    allowManualBookingFromLead: 'allow_manual_booking_from_lead',
    reminderDefaults: 'reminder_defaults',
    workingHours: 'working_hours',
  };

  for (const [k, v] of Object.entries(obj)) {
    if (k === 'chatbot_booking') continue;
    const mapped = simpleMap[k] || k;
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
