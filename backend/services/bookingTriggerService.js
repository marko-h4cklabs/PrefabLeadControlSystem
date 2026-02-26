/**
 * Centralized booking-flow gating service.
 *
 * Called by the chatbot /chat handler to decide whether to offer booking.
 * Prevents: repeated offers, offers after decline, offers before quote completion,
 * offers when scheduling is disabled.
 */

const BOOKING_INTENT_RE = /\b(schedule|book|appointment|call me|when are you free|can we (talk|meet|call)|set up a (call|meeting)|arrange a (call|meeting)|consultation|pick a time|zakazi|zakazati|dogovor|nazovi|pozovi|možemo li se čuti|termin)\b/i;
const DISMISS_RE = /\b(later|not now|no thanks|don'?t call|no appointment|maybe later|skip|ne treba|ne sada|ne hvala|preskoci)\b/i;
const RESLOT_RE = /\b(more slots|another time|show tomorrow|different time|other time|next week|earlier|later time|drugi termin|drugi dan)\b/i;

const OFFER_COOLDOWN_MESSAGES = 10;

/**
 * Evaluate whether the chatbot should offer booking right now.
 *
 * @param {Object} params
 * @param {boolean} params.quoteComplete        - all required quote fields collected
 * @param {string|null} params.bookingPhase     - current last_asked_field from conversation state
 * @param {Object|null} params.bookingState     - __booking metadata from conversation state
 * @param {Object|null} params.bkgConfig        - normalizeConfig() output
 * @param {boolean} params.bookingActive        - pre-computed: enabled && offersEnabled && mode!='off'
 * @param {boolean} params.stateLoadFailed      - true if chat_conversation_state couldn't be loaded
 * @param {string} params.userMessage           - latest user message text
 * @param {number} params.assistantCountSinceOffer - assistant messages since last booking offer (0 if never offered)
 * @returns {{ shouldOfferBooking: boolean, reason: string, shouldFetchSlots: boolean, bookingStatePatch: Object|null, isSlotRefresh: boolean }}
 */
function evaluateBookingTrigger({
  quoteComplete,
  bookingPhase,
  bookingState,
  bkgConfig,
  bookingActive,
  stateLoadFailed,
  userMessage,
  assistantCountSinceOffer,
}) {
  const result = {
    shouldOfferBooking: false,
    reason: 'none',
    shouldFetchSlots: false,
    bookingStatePatch: null,
    isSlotRefresh: false,
  };

  if (stateLoadFailed) {
    result.reason = 'state_table_error';
    return result;
  }

  if (!bkgConfig || !bookingActive) {
    result.reason = !bkgConfig ? 'config_null' : 'booking_disabled';
    return result;
  }

  const userIntent = looksLikeBookingIntent(userMessage);
  const userDismiss = looksLikeDismiss(userMessage);
  const userWantsReslot = RESLOT_RE.test((userMessage || '').trim());
  const alreadyOffered = !!(bookingState?.offeredAt);
  const alreadyDismissed = !!(bookingState?.dismissed);
  const alreadyBooked = !!(bookingState?.completedAppointmentId);
  const inActiveBookingFlow = isActiveBookingPhase(bookingPhase);

  // Already booked — never re-offer
  if (alreadyBooked) {
    result.reason = 'already_booked';
    return result;
  }

  // User is explicitly dismissing right now
  if (userDismiss && inActiveBookingFlow) {
    result.reason = 'user_dismissing';
    result.bookingStatePatch = { dismissed: true, dismissedAt: new Date().toISOString() };
    return result;
  }

  // Slot refresh request while in SLOTS_SHOWN phase
  if (userWantsReslot && bookingPhase === '__booking_slots_shown') {
    result.shouldOfferBooking = false;
    result.shouldFetchSlots = true;
    result.isSlotRefresh = true;
    result.reason = 'slot_refresh_requested';
    return result;
  }

  // Already in active booking flow — let the state machine handle it, don't re-offer
  if (inActiveBookingFlow) {
    result.reason = 'in_active_booking_flow';
    return result;
  }

  // Explicit user intent overrides cooldowns (but not if dismissed without explicit new intent)
  if (userIntent) {
    // If previously dismissed, explicit intent resets the dismiss
    result.shouldOfferBooking = true;
    result.shouldFetchSlots = bkgConfig.showSlots ?? true;
    result.reason = 'user_intent';
    result.bookingStatePatch = {
      offeredAt: new Date().toISOString(),
      offerSource: 'explicit_user_intent',
      dismissed: false,
    };
    return result;
  }

  // Auto-offer after quote completion
  if (quoteComplete && bkgConfig.askAfterQuote) {
    // Don't auto-offer if previously dismissed
    if (alreadyDismissed) {
      result.reason = 'dismissed_no_new_intent';
      return result;
    }

    // Don't auto-offer if we already offered in this conversation
    if (alreadyOffered) {
      result.reason = 'already_offered';
      return result;
    }

    // Cooldown: don't offer if we're within cooldown window of a terminal booking state
    if (assistantCountSinceOffer > 0 && assistantCountSinceOffer < OFFER_COOLDOWN_MESSAGES) {
      result.reason = 'cooldown_active';
      return result;
    }

    result.shouldOfferBooking = true;
    result.shouldFetchSlots = bkgConfig.showSlots ?? true;
    result.reason = 'auto_after_quote';
    result.bookingStatePatch = {
      offeredAt: new Date().toISOString(),
      offerSource: 'auto_after_quote',
    };
    return result;
  }

  // Quote not complete — no auto-offer
  if (!quoteComplete) {
    result.reason = 'quote_not_complete';
    return result;
  }

  // askAfterQuote disabled + no explicit intent
  result.reason = 'ask_after_quote_disabled';
  return result;
}

function looksLikeBookingIntent(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return BOOKING_INTENT_RE.test(msg.trim());
}

function looksLikeDismiss(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return DISMISS_RE.test(msg.trim());
}

/**
 * Returns true if booking phase is an active (non-terminal) booking state.
 * Terminal states (CONFIRMED, DECLINED, ACCEPTED) should not block normal conversation.
 */
function isActiveBookingPhase(phase) {
  if (!phase || typeof phase !== 'string') return false;
  if (!phase.startsWith('__booking_')) return false;
  const terminal = new Set(['__booking_confirmed', '__booking_declined', '__booking_accepted']);
  return !terminal.has(phase);
}

module.exports = {
  evaluateBookingTrigger,
  looksLikeBookingIntent,
  looksLikeDismiss,
  isActiveBookingPhase,
  OFFER_COOLDOWN_MESSAGES,
};
