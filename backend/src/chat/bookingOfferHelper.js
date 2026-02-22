/**
 * Booking-offer flow helpers for the chatbot.
 * Centralizes config normalization, state tracking, and intent detection
 * so both simulation and real chat share the same logic.
 */

const BOOKING_STATES = {
  PREREQ_NAME: '__booking_prereq_name',
  PREREQ_PHONE: '__booking_prereq_phone',
  OFFERED: '__booking_offered',
  ACCEPTED: '__booking_accepted',
  DECLINED: '__booking_declined',
};

const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|alright|please|absolutely|definitely|of course|da|naravno|svakako|rado|moze|mozemo|hajde|dobro|u redu|može)\b/i;
const NO_RE = /\b(no|nah|nope|not now|not really|later|skip|maybe later|ne|nema|ne treba|ne sada|možda kasnije|preskoci|ne hvala)\b/i;

/**
 * Normalize scheduling config from any alias combination into a flat object.
 * Resolves camelCase, snake_case, nested chatbot_booking.*, and legacy keys.
 */
function normalizeConfig(cfg) {
  if (!cfg) return null;
  const cb = (typeof cfg.chatbot_booking === 'object' && cfg.chatbot_booking) || {};
  return {
    schedulingEnabled: !!(cfg.enabled ?? cfg.scheduling_enabled ?? cfg.schedulingEnabled),
    bookingOffersEnabled: !!(
      cfg.chatbotOfferBooking ?? cfg.chatbot_offer_booking
      ?? cfg.chatbot_booking_enabled ?? cfg.enable_chatbot_booking_offers
      ?? cb.enabled ?? cb.chatbot_booking_enabled
    ),
    bookingMode: cfg.chatbotBookingMode ?? cfg.chatbot_booking_mode ?? cb.mode ?? 'manual_request',
    askAfterQuote: (cfg.chatbotCollectBookingAfterQuote ?? cfg.chatbot_collect_booking_after_quote) !== false,
    requireName: !!(
      cfg.chatbotBookingRequiresName ?? cfg.chatbot_booking_requires_name
      ?? cfg.require_name ?? cb.require_name ?? cb.requiresName
    ),
    requirePhone: !!(
      cfg.chatbotBookingRequiresPhone ?? cfg.chatbot_booking_requires_phone
      ?? cfg.require_phone ?? cb.require_phone ?? cb.requiresPhone
    ),
    defaultType: cfg.chatbotBookingDefaultType ?? cfg.chatbot_booking_default_type ?? cb.defaultType ?? 'call',
    promptStyle: cfg.chatbotBookingPromptStyle ?? cfg.chatbot_booking_prompt_style ?? cb.promptStyle ?? 'neutral',
    showSlots: !!(cfg.chatbotShowSlotsWhenAvailable ?? cfg.chatbot_show_slots_when_available ?? cb.showSlotsWhenAvailable),
    allowCustomTime: (cfg.chatbotAllowUserProposedTime ?? cfg.chatbot_allow_user_proposed_time ?? cb.allowUserProposedTime) !== false,
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

module.exports = {
  BOOKING_STATES,
  normalizeConfig,
  isInBookingFlow,
  isBookingAcceptance,
  isBookingDecline,
  buildBookingQuestion,
  looksLikeBookingOffer,
};
