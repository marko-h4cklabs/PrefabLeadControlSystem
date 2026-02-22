/**
 * Booking-offer flow helpers for the chatbot.
 * Centralizes state tracking and intent detection
 * so both simulation and real chat share the same logic.
 */

const { normalizeSchedulingSettings } = require('../../services/schedulingNormalizer');

const BOOKING_STATES = {
  PREREQ_NAME: '__booking_prereq_name',
  PREREQ_PHONE: '__booking_prereq_phone',
  OFFERED: '__booking_offered',
  SLOTS_SHOWN: '__booking_slots_shown',
  CUSTOM_TIME: '__booking_custom_time',
  ACCEPTED: '__booking_accepted',
  CONFIRMED: '__booking_confirmed',
  DECLINED: '__booking_declined',
};

const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|alright|please|absolutely|definitely|of course|da|naravno|svakako|rado|moze|mozemo|hajde|dobro|u redu|može|book|schedule|call me)\b/i;
const NO_RE = /\b(no|nah|nope|not now|not really|later|skip|maybe later|ne|nema|ne treba|ne sada|možda kasnije|preskoci|ne hvala)\b/i;

/**
 * Normalize scheduling config into a chatbot-friendly flat object.
 * Delegates to the shared normalizer for alias resolution, then maps
 * to the short property names used by the booking flow.
 */
function normalizeConfig(cfg) {
  if (!cfg) return null;
  const n = normalizeSchedulingSettings(cfg);
  return {
    schedulingEnabled: n.enabled,
    bookingOffersEnabled: n.chatbotOfferBooking,
    chatbotBookingEnabled: n.chatbotOfferBooking,
    bookingMode: n.chatbotBookingMode,
    askAfterQuote: n.chatbotCollectBookingAfterQuote,
    requireName: n.chatbotBookingRequiresName,
    requirePhone: n.chatbotBookingRequiresPhone,
    defaultType: n.chatbotBookingDefaultType,
    promptStyle: n.chatbotBookingPromptStyle,
    showSlots: n.chatbotShowSlotsWhenAvailable,
    allowCustomTime: n.chatbotAllowUserProposedTime,
    slotDurationMinutes: n.slotDurationMinutes,
    timezone: n.timezone,
  };
}

function isInBookingFlow(phase) {
  return typeof phase === 'string' && phase.startsWith('__booking_');
}

function isBookingAcceptance(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return YES_RE.test(msg.trim());
}

function isBookingDecline(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return NO_RE.test(msg.trim());
}

function buildBookingQuestion(config) {
  const type = (config?.defaultType || 'call').replace(/_/g, ' ');
  return `Would you like to schedule a ${type} to discuss your project further?`;
}

function looksLikeBookingOffer(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return (lower.includes('schedule') || lower.includes('book')) && lower.includes('?');
}

function formatSlotsMessage(slots, maxShow = 5) {
  if (!slots || slots.length === 0) return null;
  const shown = slots.slice(0, maxShow);
  const lines = shown.map((s, i) => `${i + 1}. ${s.label}`);
  return 'Here are some available times:\n' + lines.join('\n');
}

function buildBookingPayload(mode, extra = {}) {
  return {
    mode,
    slots: extra.slots || [],
    appointment: extra.appointment || null,
    requiredBeforeBooking: extra.requiredBeforeBooking || null,
    ...extra,
  };
}

module.exports = {
  BOOKING_STATES,
  normalizeConfig,
  isInBookingFlow,
  isBookingAcceptance,
  isBookingDecline,
  buildBookingQuestion,
  looksLikeBookingOffer,
  formatSlotsMessage,
  buildBookingPayload,
};
