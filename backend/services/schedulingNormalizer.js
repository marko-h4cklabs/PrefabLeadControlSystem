/**
 * Single source of truth for scheduling settings normalization.
 * Accepts any alias combination (camelCase, snake_case, nested chatbot_booking.*)
 * and returns one canonical camelCase object.
 * Used by: settings routes, availability engine, chatbot booking flow.
 */

const SHORT_TO_FULL = {
  mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday',
  fri: 'friday', sat: 'saturday', sun: 'sunday',
};

function fullDayName(d) {
  if (!d) return '';
  const lower = d.toLowerCase().trim();
  return SHORT_TO_FULL[lower] || lower;
}

/**
 * Normalize working hours from any shape to canonical:
 * [{ day: "monday", enabled: true, ranges: [{ start: "09:00", end: "17:00" }] }]
 */
function normalizeWorkingHours(wh) {
  if (!wh) return [];

  if (typeof wh === 'object' && !Array.isArray(wh)) {
    const result = [];
    for (const [day, ranges] of Object.entries(wh)) {
      const dayName = fullDayName(day);
      if (!dayName) continue;
      const rangeArr = Array.isArray(ranges) ? ranges : (ranges?.start ? [ranges] : []);
      result.push({
        day: dayName,
        enabled: rangeArr.length > 0,
        ranges: rangeArr.filter(r => r.start && r.end).map(r => ({ start: r.start, end: r.end })),
      });
    }
    return result;
  }

  if (!Array.isArray(wh)) return [];

  return wh.map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const dayName = fullDayName(entry.day);
    if (!dayName) return null;

    if (Array.isArray(entry.ranges)) {
      return {
        day: dayName,
        enabled: entry.enabled !== false,
        ranges: entry.ranges.filter(r => r?.start && r?.end).map(r => ({ start: r.start, end: r.end })),
      };
    }

    if (entry.start && entry.end) {
      return {
        day: dayName,
        enabled: true,
        ranges: [{ start: entry.start, end: entry.end }],
      };
    }

    return { day: dayName, enabled: false, ranges: [] };
  }).filter(Boolean);
}

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function pickBool(obj, ...keys) {
  const v = pick(obj, ...keys);
  return v === undefined ? undefined : !!v;
}

function pickNum(obj, ...keys) {
  const v = pick(obj, ...keys);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize raw scheduling settings (from DB/API) into canonical object.
 * @param {Object} raw - Raw settings object (any key convention)
 * @returns {Object} Normalized canonical settings
 */
function normalizeSchedulingSettings(raw) {
  if (!raw) return getDefaults();
  const cb = (typeof raw.chatbot_booking === 'object' && raw.chatbot_booking) || {};

  const enabled = pickBool(raw, 'enabled', 'scheduling_enabled', 'schedulingEnabled') ?? false;
  const timezone = pick(raw, 'timezone') || 'Europe/Zagreb';
  const wh = raw.workingHours ?? raw.working_hours ?? [];

  return {
    enabled,
    timezone,
    workingHours: normalizeWorkingHours(wh),
    slotDurationMinutes: pickNum(raw, 'slotDurationMinutes', 'slot_duration_minutes') ?? 30,
    bufferBeforeMinutes: pickNum(raw, 'bufferBeforeMinutes', 'buffer_before_minutes') ?? 0,
    bufferAfterMinutes: pickNum(raw, 'bufferAfterMinutes', 'buffer_after_minutes') ?? 0,
    minNoticeHours: pickNum(raw, 'minNoticeHours', 'min_notice_hours', 'minimum_notice_hours') ?? 2,
    maxDaysAhead: pickNum(raw, 'maxDaysAhead', 'max_days_ahead') ?? 30,
    allowedAppointmentTypes: raw.allowedAppointmentTypes ?? raw.allowed_appointment_types ?? raw.default_appointment_types ?? ['call'],
    allowManualBookingFromLead: pickBool(raw, 'allowManualBookingFromLead', 'allow_manual_booking_from_lead', 'allow_manual_booking') ?? true,

    chatbotOfferBooking: pickBool(raw,
      'chatbotOfferBooking', 'chatbot_offer_booking',
      'chatbot_booking_enabled', 'chatbot_offers_booking',
      'enable_chatbot_booking_offers',
    ) ?? pickBool(cb, 'enabled', 'chatbot_booking_enabled') ?? false,

    chatbotBookingMode: pick(raw, 'chatbotBookingMode', 'chatbot_booking_mode', 'booking_mode') ?? cb.mode ?? 'manual_request',
    chatbotBookingPromptStyle: pick(raw, 'chatbotBookingPromptStyle', 'chatbot_booking_prompt_style', 'booking_prompt_style') ?? cb.promptStyle ?? 'neutral',

    chatbotCollectBookingAfterQuote: pickBool(raw,
      'chatbotCollectBookingAfterQuote', 'chatbot_collect_booking_after_quote',
      'ask_after_quote',
    ) ?? pickBool(cb, 'ask_after_quote', 'collectAfterQuote') ?? true,

    chatbotBookingRequiresName: pickBool(raw,
      'chatbotBookingRequiresName', 'chatbot_booking_requires_name',
      'require_name',
    ) ?? pickBool(cb, 'require_name', 'requiresName', 'chatbot_booking_requires_name') ?? false,

    chatbotBookingRequiresPhone: pickBool(raw,
      'chatbotBookingRequiresPhone', 'chatbot_booking_requires_phone',
      'require_phone',
    ) ?? pickBool(cb, 'require_phone', 'requiresPhone', 'chatbot_booking_requires_phone') ?? false,

    chatbotBookingDefaultType: pick(raw,
      'chatbotBookingDefaultType', 'chatbot_booking_default_type', 'default_booking_type',
    ) ?? cb.defaultType ?? 'call',

    chatbotAllowUserProposedTime: pickBool(raw,
      'chatbotAllowUserProposedTime', 'chatbot_allow_user_proposed_time', 'allow_custom_time',
    ) ?? pickBool(cb, 'allowUserProposedTime') ?? true,

    chatbotShowSlotsWhenAvailable: pickBool(raw,
      'chatbotShowSlotsWhenAvailable', 'chatbot_show_slots_when_available', 'show_available_slots',
    ) ?? pickBool(cb, 'showSlotsWhenAvailable') ?? true,

    reminderDefaults: raw.reminderDefaults ?? raw.reminder_defaults ?? { email: true, inApp: true, minutesBefore: 60 },
  };
}

function getDefaults() {
  return normalizeSchedulingSettings({});
}

/**
 * Convert normalized working hours to flat array for DB storage / availability engine.
 * Input: [{ day, enabled, ranges }]  Output: [{ day, start, end }]
 */
function workingHoursToFlat(wh) {
  const result = [];
  for (const entry of (wh || [])) {
    if (!entry.enabled) continue;
    for (const r of (entry.ranges || [])) {
      if (r.start && r.end) result.push({ day: entry.day, start: r.start, end: r.end });
    }
  }
  return result;
}

/**
 * Build a day-map from normalized working hours for slot generation.
 * Returns { monday: [{ start, end }, ...], ... }
 */
function workingHoursToDayMap(wh) {
  const map = {};
  for (const entry of (wh || [])) {
    if (!entry.enabled && entry.enabled !== undefined) continue;
    const day = fullDayName(entry.day);
    if (!day) continue;
    if (!map[day]) map[day] = [];
    for (const r of (entry.ranges || [])) {
      if (r.start && r.end) map[day].push({ start: r.start, end: r.end });
    }
    if (entry.start && entry.end && (!entry.ranges || entry.ranges.length === 0)) {
      map[day].push({ start: entry.start, end: entry.end });
    }
  }
  return map;
}

module.exports = {
  normalizeSchedulingSettings,
  normalizeWorkingHours,
  workingHoursToFlat,
  workingHoursToDayMap,
  getDefaults,
  fullDayName,
};
