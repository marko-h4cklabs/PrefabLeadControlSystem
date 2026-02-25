/**
 * Booking state machine for ManyChat / Instagram DM conversations.
 *
 * Handles in-chat booking: slot display, selection, confirmation, decline.
 * State is stored in conversations.parsed_fields under __booking_phase and __booking.
 */

const { evaluateBookingTrigger, looksLikeBookingIntent, isActiveBookingPhase } = require('./bookingTriggerService');
const { getAvailability, isSlotAvailable } = require('./availabilityService');
const {
  BOOKING_STATES,
  normalizeConfig,
  formatSlotsMessage,
  isBookingAcceptance,
  isBookingDecline,
  buildBookingQuestion,
} = require('../src/chat/bookingOfferHelper');
const { schedulingSettingsRepository, appointmentRepository, conversationRepository } = require('../db/repositories');
const googleCalendarService = require('../src/services/googleCalendarService');
const { logLeadActivity } = require('./activityLogger');
const { createNotification } = require('../src/services/notificationService');

const SLOT_NUM_RE = /^\s*(\d)\s*$/;
const CONFIRM_RE = /\b(confirm|potvrdi|potvrditi|book it|yes confirm|da potvrdi)\b/i;
const RESLOT_RE = /\b(more slots|another time|show tomorrow|different time|other time|next week|earlier|later time|drugi termin|drugi dan)\b/i;

/**
 * Handle an active booking phase. Called BEFORE AI reply generation.
 *
 * @param {Object} params
 * @param {string} params.leadId
 * @param {string} params.companyId
 * @param {string} params.userMessage
 * @param {string} params.bookingPhase - current __booking_phase from parsed_fields
 * @param {Object} params.bookingData  - current __booking from parsed_fields
 * @param {Object} params.lead         - lead record (for appointment creation)
 * @returns {Promise<{handled: boolean, replyMessage: string}|null>}
 */
async function handleActiveBookingPhase({ leadId, companyId, userMessage, bookingPhase, bookingData, lead }) {
  if (!isActiveBookingPhase(bookingPhase)) return null;

  const msg = (userMessage || '').trim();

  // --- SLOTS_SHOWN: user is looking at numbered slot list ---
  if (bookingPhase === BOOKING_STATES.SLOTS_SHOWN) {
    const offeredSlots = bookingData?.offeredSlots || [];

    // User wants to decline / exit
    if (isBookingDecline(msg)) {
      await conversationRepository.mergeBookingState(leadId, BOOKING_STATES.DECLINED, {
        dismissed: true,
        dismissedAt: new Date().toISOString(),
      });
      console.log('[booking] User declined booking in SLOTS_SHOWN phase');
      return null; // fall through to normal AI reply
    }

    // User wants more/different slots
    if (RESLOT_RE.test(msg)) {
      const avail = await getAvailability(companyId, { limit: 5 });
      const slots = avail.slots || [];
      if (slots.length === 0) {
        await conversationRepository.mergeBookingState(leadId, null, {});
        return { handled: true, replyMessage: "I don't have any available slots right now. I'll have someone from the team reach out to find a time that works." };
      }
      const slotsText = formatSlotsMessage(slots, 5);
      await conversationRepository.mergeBookingState(leadId, BOOKING_STATES.SLOTS_SHOWN, {
        offeredSlots: slots,
        selectedSlot: null,
      });
      return { handled: true, replyMessage: `Here are some other available times:\n${slotsText}\n\nReply with a number to select, or say "no thanks" to skip.` };
    }

    // User selected a slot previously and is now confirming
    if (bookingData?.selectedSlot && CONFIRM_RE.test(msg)) {
      return await confirmBooking({ leadId, companyId, lead, bookingData });
    }

    // User is also accepting with "yes" when a slot was selected
    if (bookingData?.selectedSlot && isBookingAcceptance(msg)) {
      return await confirmBooking({ leadId, companyId, lead, bookingData });
    }

    // User picked a number (1-9)
    const numMatch = msg.match(SLOT_NUM_RE);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < offeredSlots.length) {
        const selected = offeredSlots[idx];
        await conversationRepository.mergeBookingState(leadId, BOOKING_STATES.SLOTS_SHOWN, {
          selectedSlot: selected,
        });
        return {
          handled: true,
          replyMessage: `You selected: ${selected.label}\n\nReply "confirm" to book this time, or pick a different number.`,
        };
      }
    }

    // Unrecognized message in booking flow — exit and let AI handle it
    console.log('[booking] Unrecognized message in SLOTS_SHOWN, exiting booking flow');
    await conversationRepository.mergeBookingState(leadId, null, {
      offeredSlots: offeredSlots,
    });
    return null; // fall through to normal AI
  }

  // --- OFFERED: user was asked "would you like to book?" (no slots shown yet) ---
  if (bookingPhase === BOOKING_STATES.OFFERED) {
    if (isBookingAcceptance(msg) || looksLikeBookingIntent(msg)) {
      // Fetch and show slots
      const avail = await getAvailability(companyId, { limit: 5 });
      const slots = avail.slots || [];
      if (slots.length === 0) {
        await conversationRepository.mergeBookingState(leadId, null, {});
        return { handled: true, replyMessage: "I don't have any available slots right now. I'll have someone from the team reach out to schedule." };
      }
      const slotsText = formatSlotsMessage(slots, 5);
      await conversationRepository.mergeBookingState(leadId, BOOKING_STATES.SLOTS_SHOWN, {
        offeredSlots: slots,
        selectedSlot: null,
      });
      return { handled: true, replyMessage: `Great! ${slotsText}\n\nReply with a number to select a time.` };
    }
    if (isBookingDecline(msg)) {
      await conversationRepository.mergeBookingState(leadId, BOOKING_STATES.DECLINED, {
        dismissed: true,
        dismissedAt: new Date().toISOString(),
      });
      console.log('[booking] User declined booking offer');
      return null;
    }
    // Unrecognized — exit booking
    await conversationRepository.mergeBookingState(leadId, null, {});
    return null;
  }

  // Other phases — clear and fall through
  await conversationRepository.mergeBookingState(leadId, null, {});
  return null;
}

/**
 * After normal AI reply, evaluate if booking should be offered.
 *
 * @param {Object} params
 * @param {string} params.leadId
 * @param {string} params.companyId
 * @param {string} params.userMessage
 * @param {boolean} params.quoteComplete - true if all required quote fields collected
 * @param {string|null} params.bookingPhase
 * @param {Object|null} params.bookingData
 * @returns {Promise<{offerMessage: string, bookingPhase: string}|null>}
 */
async function evaluatePostReplyBooking({ leadId, companyId, userMessage, quoteComplete, bookingPhase, bookingData }) {
  try {
    const rawConfig = await schedulingSettingsRepository.get(companyId);
    const bkgConfig = normalizeConfig(rawConfig);
    if (!bkgConfig) return null;

    const bookingActive = bkgConfig.schedulingEnabled && bkgConfig.bookingOffersEnabled && bkgConfig.bookingMode !== 'off';
    if (!bookingActive) return null;

    // Count assistant messages since last offer (approximate: use offeredAt from booking data)
    let assistantCountSinceOffer = 0;
    if (bookingData?.offeredAt) {
      try {
        const conv = await conversationRepository.getByLeadId(leadId);
        const msgs = conv?.messages || [];
        const offeredAt = new Date(bookingData.offeredAt).getTime();
        assistantCountSinceOffer = msgs.filter(
          (m) => m.role === 'assistant' && new Date(m.timestamp).getTime() > offeredAt
        ).length;
      } catch (_) {
        assistantCountSinceOffer = 999;
      }
    }

    const trigger = evaluateBookingTrigger({
      quoteComplete,
      bookingPhase: bookingPhase || null,
      bookingState: bookingData || null,
      bkgConfig,
      bookingActive,
      stateLoadFailed: false,
      userMessage,
      assistantCountSinceOffer,
    });

    console.log('[booking] evaluateBookingTrigger result:', trigger.reason, 'shouldOffer:', trigger.shouldOfferBooking);

    if (!trigger.shouldOfferBooking) return null;

    // Fetch available slots
    const avail = await getAvailability(companyId, { limit: 5 });
    const slots = avail.slots || [];

    if (slots.length === 0) {
      // No slots — offer without slot list
      const question = buildBookingQuestion(bkgConfig);
      await conversationRepository.mergeBookingState(leadId, BOOKING_STATES.OFFERED, {
        offeredAt: new Date().toISOString(),
        offerSource: trigger.reason,
      });
      return {
        offerMessage: `\n\n${question} (I'll check available times once you confirm)`,
        bookingPhase: BOOKING_STATES.OFFERED,
      };
    }

    // Show slots with offer
    const slotsText = formatSlotsMessage(slots, 5);
    const question = buildBookingQuestion(bkgConfig);

    await conversationRepository.mergeBookingState(leadId, BOOKING_STATES.SLOTS_SHOWN, {
      offeredAt: new Date().toISOString(),
      offerSource: trigger.reason,
      offeredSlots: slots,
      selectedSlot: null,
    });

    return {
      offerMessage: `\n\n${question}\n\n${slotsText}\n\nReply with a number to select a time, or "no thanks" to skip.`,
      bookingPhase: BOOKING_STATES.SLOTS_SHOWN,
    };
  } catch (err) {
    console.error('[booking] evaluatePostReplyBooking error:', err.message);
    return null;
  }
}

/**
 * Confirm a booking: create appointment, sync calendar, update state.
 */
async function confirmBooking({ leadId, companyId, lead, bookingData }) {
  const slot = bookingData.selectedSlot;
  if (!slot || !slot.startAt) {
    return { handled: true, replyMessage: "Something went wrong with the selected slot. Let's try again — would you like to see available times?" };
  }

  // Double-check slot availability
  const available = await isSlotAvailable(companyId, slot.startAt, slot.endAt || slot.endAt);
  if (!available) {
    // Slot taken — refresh
    const avail = await getAvailability(companyId, { limit: 5 });
    const slots = avail.slots || [];
    if (slots.length === 0) {
      await conversationRepository.mergeBookingState(leadId, null, {});
      return { handled: true, replyMessage: "That slot was just taken and there are no other slots available. I'll have someone reach out to schedule." };
    }
    const slotsText = formatSlotsMessage(slots, 5);
    await conversationRepository.mergeBookingState(leadId, BOOKING_STATES.SLOTS_SHOWN, {
      offeredSlots: slots,
      selectedSlot: null,
    });
    return { handled: true, replyMessage: `That time was just taken. Here are the current available times:\n${slotsText}\n\nReply with a number to select.` };
  }

  // Create appointment
  const leadName = lead.name || 'Instagram Lead';
  const title = `Call with ${leadName}`;
  const endAt = slot.endAt || new Date(new Date(slot.startAt).getTime() + 30 * 60000).toISOString();

  const appointment = await appointmentRepository.create({
    companyId,
    leadId,
    title,
    appointmentType: slot.appointmentType || slot.appointment_type || 'call',
    status: 'scheduled',
    startAt: slot.startAt,
    endAt,
    timezone: slot.timezone || 'Europe/Zagreb',
    source: 'chatbot',
    reminderMinutesBefore: 60,
  });

  // Update booking state to confirmed
  await conversationRepository.mergeBookingState(leadId, BOOKING_STATES.CONFIRMED, {
    completedAppointmentId: appointment.id,
    confirmedAt: new Date().toISOString(),
    dismissed: false,
  });

  // Side effects (non-blocking)
  googleCalendarService.syncNewAppointmentToGoogle(companyId, appointment, lead).catch((err) => {
    console.warn('[booking] Google Calendar sync failed:', err.message);
  });
  logLeadActivity({
    companyId,
    leadId,
    eventType: 'appointment_created',
    actorType: 'ai',
    source: 'instagram',
    channel: 'instagram',
    metadata: { appointmentId: appointment.id, source: 'dm_booking' },
  }).catch(() => {});
  createNotification(
    companyId,
    'appointment_booked',
    'New appointment booked via Instagram DM',
    `${leadName} booked: ${slot.label}`,
    leadId
  ).catch(() => {});

  console.log('[booking] Appointment confirmed:', appointment.id, 'for lead:', leadId);

  return {
    handled: true,
    replyMessage: `Your ${slot.appointmentType || 'call'} is confirmed for ${slot.label}! You'll receive a reminder before the appointment. Looking forward to speaking with you!`,
  };
}

module.exports = {
  handleActiveBookingPhase,
  evaluatePostReplyBooking,
};
