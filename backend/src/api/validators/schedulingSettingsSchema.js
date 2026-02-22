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
/*  For each canonical field the FIRST defined value in the priority   */
/*  list wins. Nested chatbot_booking.* beats top-level keys.         */
/*  All alias keys are consumed — only canonical keys reach Zod.      */
/* ------------------------------------------------------------------ */

function firstBool(sources) {
  for (const [, v] of sources) {
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

function firstStr(sources) {
  for (const [, v] of sources) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function logConflicts(canonical, resolved, sources) {
  const defined = sources.filter(([, v]) => v !== undefined);
  if (defined.length > 1) {
    const conflicting = defined.some(([, v]) => v !== resolved);
    if (conflicting) {
      console.warn(
        `[scheduling-settings] CONFLICT on "${canonical}": winner=${JSON.stringify(resolved)} from:`,
        defined.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
      );
    }
  }
}

/**
 * All known alias keys that map to canonical scheduling settings fields.
 * These are stripped from the output so only canonical keys survive.
 */
const CONSUMED_ALIASES = new Set([
  'chatbot_booking',
  'scheduling_enabled', 'schedulingEnabled',
  'chatbotOfferBooking', 'chatbot_booking_enabled', 'chatbot_offers_booking',
  'enableChatbotBookingOffers', 'enable_chatbot_booking_offers',
  'askForBookingAfterQuote', 'ask_for_booking_after_quote',
  'chatbotBookingMode', 'chatbotBookingPromptStyle',
  'chatbotCollectBookingAfterQuote', 'chatbotBookingRequiresName',
  'chatbotBookingRequiresPhone', 'chatbotBookingDefaultType',
  'chatbotAllowUserProposedTime', 'chatbotShowSlotsWhenAvailable',
  'slotDurationMinutes', 'bufferBeforeMinutes', 'bufferAfterMinutes',
  'minNoticeHours', 'maxDaysAhead', 'allowedAppointmentTypes',
  'allowManualBookingFromLead', 'reminderDefaults', 'workingHours',
]);

/**
 * Normalize frontend payload to canonical snake_case, resolving conflicts.
 *
 * PRECEDENCE per field (highest → lowest):
 *   1. Nested chatbot_booking.{key}
 *   2. Canonical snake_case key
 *   3. camelCase alias
 *   4. Lovable / legacy aliases
 */
function camelOrSnake(obj) {
  if (!obj || typeof obj !== 'object') return obj ?? {};

  const nested = (obj.chatbot_booking && typeof obj.chatbot_booking === 'object')
    ? obj.chatbot_booking : null;
  const n = nested || {};

  // --- enabled ---
  // scheduling_enabled is more specific than generic enabled
  const enabledSrc = [
    ['scheduling_enabled', obj.scheduling_enabled],
    ['schedulingEnabled', obj.schedulingEnabled],
    ['enabled', obj.enabled],
  ];
  const enabledVal = firstBool(enabledSrc);
  logConflicts('enabled', enabledVal, enabledSrc);

  // --- chatbot_offer_booking ---
  const bookingSrc = [
    ['chatbot_booking.chatbot_booking_enabled', n.chatbot_booking_enabled],
    ['chatbot_booking.enabled', n.enabled],
    ['chatbot_offer_booking', obj.chatbot_offer_booking],
    ['chatbotOfferBooking', obj.chatbotOfferBooking],
    ['chatbot_booking_enabled', obj.chatbot_booking_enabled],
    ['chatbot_offers_booking', obj.chatbot_offers_booking],
    ['enableChatbotBookingOffers', obj.enableChatbotBookingOffers],
    ['enable_chatbot_booking_offers', obj.enable_chatbot_booking_offers],
    ['askForBookingAfterQuote', obj.askForBookingAfterQuote],
    ['ask_for_booking_after_quote', obj.ask_for_booking_after_quote],
  ];
  const bookingVal = firstBool(bookingSrc);
  logConflicts('chatbot_offer_booking', bookingVal, bookingSrc);

  // --- chatbot_booking_mode ---
  const modeSrc = [
    ['chatbot_booking.mode', n.mode],
    ['chatbot_booking.chatbot_booking_mode', n.chatbot_booking_mode],
    ['chatbot_booking_mode', obj.chatbot_booking_mode],
    ['chatbotBookingMode', obj.chatbotBookingMode],
  ];
  const modeVal = firstStr(modeSrc);

  // --- chatbot_collect_booking_after_quote ---
  const collectSrc = [
    ['chatbot_booking.collectAfterQuote', n.collectAfterQuote],
    ['chatbot_booking.chatbot_collect_booking_after_quote', n.chatbot_collect_booking_after_quote],
    ['chatbot_collect_booking_after_quote', obj.chatbot_collect_booking_after_quote],
    ['chatbotCollectBookingAfterQuote', obj.chatbotCollectBookingAfterQuote],
  ];
  const collectVal = firstBool(collectSrc);

  // --- chatbot_booking_requires_name ---
  const reqNameSrc = [
    ['chatbot_booking.requiresName', n.requiresName],
    ['chatbot_booking.chatbot_booking_requires_name', n.chatbot_booking_requires_name],
    ['chatbot_booking_requires_name', obj.chatbot_booking_requires_name],
    ['chatbotBookingRequiresName', obj.chatbotBookingRequiresName],
  ];
  const reqNameVal = firstBool(reqNameSrc);

  // --- chatbot_booking_requires_phone ---
  const reqPhoneSrc = [
    ['chatbot_booking.requiresPhone', n.requiresPhone],
    ['chatbot_booking.chatbot_booking_requires_phone', n.chatbot_booking_requires_phone],
    ['chatbot_booking_requires_phone', obj.chatbot_booking_requires_phone],
    ['chatbotBookingRequiresPhone', obj.chatbotBookingRequiresPhone],
  ];
  const reqPhoneVal = firstBool(reqPhoneSrc);

  // --- chatbot_booking_prompt_style ---
  const promptSrc = [
    ['chatbot_booking.promptStyle', n.promptStyle],
    ['chatbot_booking.chatbot_booking_prompt_style', n.chatbot_booking_prompt_style],
    ['chatbot_booking_prompt_style', obj.chatbot_booking_prompt_style],
    ['chatbotBookingPromptStyle', obj.chatbotBookingPromptStyle],
  ];
  const promptStyleVal = firstStr(promptSrc);

  // --- chatbot_booking_default_type ---
  const typeSrc = [
    ['chatbot_booking.defaultType', n.defaultType],
    ['chatbot_booking.chatbot_booking_default_type', n.chatbot_booking_default_type],
    ['chatbot_booking_default_type', obj.chatbot_booking_default_type],
    ['chatbotBookingDefaultType', obj.chatbotBookingDefaultType],
  ];
  const defaultTypeVal = firstStr(typeSrc);

  // --- chatbot_allow_user_proposed_time ---
  const allowTimeSrc = [
    ['chatbot_booking.allowUserProposedTime', n.allowUserProposedTime],
    ['chatbot_booking.chatbot_allow_user_proposed_time', n.chatbot_allow_user_proposed_time],
    ['chatbot_allow_user_proposed_time', obj.chatbot_allow_user_proposed_time],
    ['chatbotAllowUserProposedTime', obj.chatbotAllowUserProposedTime],
  ];
  const allowTimeVal = firstBool(allowTimeSrc);

  // --- chatbot_show_slots_when_available ---
  const showSlotsSrc = [
    ['chatbot_booking.showSlotsWhenAvailable', n.showSlotsWhenAvailable],
    ['chatbot_booking.chatbot_show_slots_when_available', n.chatbot_show_slots_when_available],
    ['chatbot_show_slots_when_available', obj.chatbot_show_slots_when_available],
    ['chatbotShowSlotsWhenAvailable', obj.chatbotShowSlotsWhenAvailable],
  ];
  const showSlotsVal = firstBool(showSlotsSrc);

  // Build output with ONLY canonical keys
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

  // Simple camelCase→snake_case for non-contentious fields
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
    if (CONSUMED_ALIASES.has(k)) continue;
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
