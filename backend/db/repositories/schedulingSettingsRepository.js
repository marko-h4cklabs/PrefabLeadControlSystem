const { pool } = require('../index');

const DEFAULTS = {
  enabled: false,
  timezone: 'Europe/Zagreb',
  working_hours: {
    monday: [{ start: '09:00', end: '17:00' }],
    tuesday: [{ start: '09:00', end: '17:00' }],
    wednesday: [{ start: '09:00', end: '17:00' }],
    thursday: [{ start: '09:00', end: '17:00' }],
    friday: [{ start: '09:00', end: '17:00' }],
  },
  slot_duration_minutes: 30,
  buffer_before_minutes: 0,
  buffer_after_minutes: 0,
  min_notice_hours: 2,
  max_days_ahead: 30,
  allowed_appointment_types: ['call'],
  allow_manual_booking_from_lead: true,
  chatbot_offer_booking: false,
  reminder_defaults: { email: true, inApp: true, minutesBefore: 60 },
  chatbot_booking_mode: 'manual_request',
  chatbot_booking_prompt_style: 'neutral',
  chatbot_collect_booking_after_quote: true,
  chatbot_booking_requires_name: false,
  chatbot_booking_requires_phone: false,
  chatbot_booking_default_type: 'call',
  chatbot_allow_user_proposed_time: true,
  chatbot_show_slots_when_available: true,
};

function toDto(row) {
  if (!row) return { ...DEFAULTS };
  return {
    id: row.id,
    companyId: row.company_id,
    enabled: row.enabled ?? DEFAULTS.enabled,
    timezone: row.timezone ?? DEFAULTS.timezone,
    workingHours: row.working_hours ?? DEFAULTS.working_hours,
    slotDurationMinutes: row.slot_duration_minutes ?? DEFAULTS.slot_duration_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes ?? DEFAULTS.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes ?? DEFAULTS.buffer_after_minutes,
    minNoticeHours: row.min_notice_hours ?? DEFAULTS.min_notice_hours,
    maxDaysAhead: row.max_days_ahead ?? DEFAULTS.max_days_ahead,
    allowedAppointmentTypes: row.allowed_appointment_types ?? DEFAULTS.allowed_appointment_types,
    allowManualBookingFromLead: row.allow_manual_booking_from_lead ?? DEFAULTS.allow_manual_booking_from_lead,
    chatbotOfferBooking: row.chatbot_offer_booking ?? DEFAULTS.chatbot_offer_booking,
    reminderDefaults: row.reminder_defaults ?? DEFAULTS.reminder_defaults,
    chatbotBookingMode: row.chatbot_booking_mode ?? DEFAULTS.chatbot_booking_mode,
    chatbotBookingPromptStyle: row.chatbot_booking_prompt_style ?? DEFAULTS.chatbot_booking_prompt_style,
    chatbotCollectBookingAfterQuote: row.chatbot_collect_booking_after_quote ?? DEFAULTS.chatbot_collect_booking_after_quote,
    chatbotBookingRequiresName: row.chatbot_booking_requires_name ?? DEFAULTS.chatbot_booking_requires_name,
    chatbotBookingRequiresPhone: row.chatbot_booking_requires_phone ?? DEFAULTS.chatbot_booking_requires_phone,
    chatbotBookingDefaultType: row.chatbot_booking_default_type ?? DEFAULTS.chatbot_booking_default_type,
    chatbotAllowUserProposedTime: row.chatbot_allow_user_proposed_time ?? DEFAULTS.chatbot_allow_user_proposed_time,
    chatbotShowSlotsWhenAvailable: row.chatbot_show_slots_when_available ?? DEFAULTS.chatbot_show_slots_when_available,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function get(companyId) {
  const result = await pool.query(
    'SELECT * FROM company_scheduling_settings WHERE company_id = $1',
    [companyId]
  );
  if (result.rows[0]) return toDto(result.rows[0]);
  return { ...DEFAULTS, companyId };
}

async function upsert(companyId, data) {
  const result = await pool.query(
    `INSERT INTO company_scheduling_settings
       (company_id, enabled, timezone, working_hours, slot_duration_minutes,
        buffer_before_minutes, buffer_after_minutes, min_notice_hours, max_days_ahead,
        allowed_appointment_types, allow_manual_booking_from_lead, chatbot_offer_booking, reminder_defaults,
        chatbot_booking_mode, chatbot_booking_prompt_style, chatbot_collect_booking_after_quote,
        chatbot_booking_requires_name, chatbot_booking_requires_phone, chatbot_booking_default_type,
        chatbot_allow_user_proposed_time, chatbot_show_slots_when_available)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,
             $14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (company_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       timezone = EXCLUDED.timezone,
       working_hours = EXCLUDED.working_hours,
       slot_duration_minutes = EXCLUDED.slot_duration_minutes,
       buffer_before_minutes = EXCLUDED.buffer_before_minutes,
       buffer_after_minutes = EXCLUDED.buffer_after_minutes,
       min_notice_hours = EXCLUDED.min_notice_hours,
       max_days_ahead = EXCLUDED.max_days_ahead,
       allowed_appointment_types = EXCLUDED.allowed_appointment_types,
       allow_manual_booking_from_lead = EXCLUDED.allow_manual_booking_from_lead,
       chatbot_offer_booking = EXCLUDED.chatbot_offer_booking,
       reminder_defaults = EXCLUDED.reminder_defaults,
       chatbot_booking_mode = EXCLUDED.chatbot_booking_mode,
       chatbot_booking_prompt_style = EXCLUDED.chatbot_booking_prompt_style,
       chatbot_collect_booking_after_quote = EXCLUDED.chatbot_collect_booking_after_quote,
       chatbot_booking_requires_name = EXCLUDED.chatbot_booking_requires_name,
       chatbot_booking_requires_phone = EXCLUDED.chatbot_booking_requires_phone,
       chatbot_booking_default_type = EXCLUDED.chatbot_booking_default_type,
       chatbot_allow_user_proposed_time = EXCLUDED.chatbot_allow_user_proposed_time,
       chatbot_show_slots_when_available = EXCLUDED.chatbot_show_slots_when_available,
       updated_at = NOW()
     RETURNING *`,
    [
      companyId,
      data.enabled ?? DEFAULTS.enabled,
      data.timezone ?? DEFAULTS.timezone,
      JSON.stringify(data.working_hours ?? data.workingHours ?? DEFAULTS.working_hours),
      data.slot_duration_minutes ?? data.slotDurationMinutes ?? DEFAULTS.slot_duration_minutes,
      data.buffer_before_minutes ?? data.bufferBeforeMinutes ?? DEFAULTS.buffer_before_minutes,
      data.buffer_after_minutes ?? data.bufferAfterMinutes ?? DEFAULTS.buffer_after_minutes,
      data.min_notice_hours ?? data.minNoticeHours ?? DEFAULTS.min_notice_hours,
      data.max_days_ahead ?? data.maxDaysAhead ?? DEFAULTS.max_days_ahead,
      JSON.stringify(data.allowed_appointment_types ?? data.allowedAppointmentTypes ?? DEFAULTS.allowed_appointment_types),
      data.allow_manual_booking_from_lead ?? data.allowManualBookingFromLead ?? DEFAULTS.allow_manual_booking_from_lead,
      data.chatbot_offer_booking ?? data.chatbotOfferBooking ?? DEFAULTS.chatbot_offer_booking,
      JSON.stringify(data.reminder_defaults ?? data.reminderDefaults ?? DEFAULTS.reminder_defaults),
      data.chatbot_booking_mode ?? data.chatbotBookingMode ?? DEFAULTS.chatbot_booking_mode,
      data.chatbot_booking_prompt_style ?? data.chatbotBookingPromptStyle ?? DEFAULTS.chatbot_booking_prompt_style,
      data.chatbot_collect_booking_after_quote ?? data.chatbotCollectBookingAfterQuote ?? DEFAULTS.chatbot_collect_booking_after_quote,
      data.chatbot_booking_requires_name ?? data.chatbotBookingRequiresName ?? DEFAULTS.chatbot_booking_requires_name,
      data.chatbot_booking_requires_phone ?? data.chatbotBookingRequiresPhone ?? DEFAULTS.chatbot_booking_requires_phone,
      data.chatbot_booking_default_type ?? data.chatbotBookingDefaultType ?? DEFAULTS.chatbot_booking_default_type,
      data.chatbot_allow_user_proposed_time ?? data.chatbotAllowUserProposedTime ?? DEFAULTS.chatbot_allow_user_proposed_time,
      data.chatbot_show_slots_when_available ?? data.chatbotShowSlotsWhenAvailable ?? DEFAULTS.chatbot_show_slots_when_available,
    ]
  );
  return toDto(result.rows[0]);
}

module.exports = { get, upsert, DEFAULTS };
