const express = require('express');
const router = express.Router();
const {
  schedulingSettingsRepository, schedulingRequestRepository, leadRepository,
  notificationRepository, appointmentRepository,
  chatConversationRepository, chatMessagesRepository,
} = require('../../../db/repositories');
const { logLeadActivity } = require('../../../services/activityLogger');
const { sendAppointmentConfirmationEmail } = require('../../../services/appointmentEmailService');
const { chatbotIntakeSchema } = require('../validators/schedulingRequestSchemas');
const { isSlotAvailable } = require('../../../services/availabilityService');
const { BOOKING_STATES, buildBookingPayload } = require('../../chat/bookingOfferHelper');
const { errorJson } = require('../middleware/errors');

function validationError(res, parsed, debugCtx) {
  const err = parsed.error.flatten();
  const fieldMsgs = Object.entries(err.fieldErrors ?? {})
    .map(([f, msgs]) => `${f}: ${(msgs || []).join(', ')}`)
    .filter(Boolean);
  const msg = err.formErrors?.[0] || fieldMsgs.join('; ') || 'Validation failed';
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[chatbot/scheduling] validation failed:', { msg, ...debugCtx });
  }
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg, fields: err.fieldErrors } });
}

// GET /api/chatbot/scheduling/config
router.get('/config', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const settings = await schedulingSettingsRepository.get(companyId);

    const offerBooking = settings.chatbotOfferBooking ?? false;
    const bookingMode = settings.chatbotBookingMode ?? 'manual_request';
    const effectivelyEnabled = offerBooking && bookingMode !== 'off';

    res.json({
      enabled: settings.enabled ?? false,
      chatbotOfferBooking: offerBooking,
      chatbotBookingMode: bookingMode,
      chatbotBookingPromptStyle: settings.chatbotBookingPromptStyle ?? 'neutral',
      chatbotCollectBookingAfterQuote: settings.chatbotCollectBookingAfterQuote ?? true,
      chatbotBookingRequiresName: settings.chatbotBookingRequiresName ?? false,
      chatbotBookingRequiresPhone: settings.chatbotBookingRequiresPhone ?? false,
      chatbotBookingDefaultType: settings.chatbotBookingDefaultType ?? 'call',
      chatbotAllowUserProposedTime: settings.chatbotAllowUserProposedTime ?? true,
      chatbotShowSlotsWhenAvailable: settings.chatbotShowSlotsWhenAvailable ?? true,
      allowedAppointmentTypes: settings.allowedAppointmentTypes ?? ['call'],
      timezone: settings.timezone ?? 'Europe/Zagreb',
      slotDurationMinutes: settings.slotDurationMinutes ?? 30,
      _debug: {
        bookingOffersEnabled: effectivelyEnabled,
        source: 'scheduling_settings',
      },
    });
  } catch (err) {
    console.error('[chatbot/scheduling] config error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to load chatbot scheduling config');
  }
});

// POST /api/chatbot/scheduling/intake
router.post('/intake', async (req, res) => {
  try {
    const parsed = chatbotIntakeSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed, { route: 'POST /intake' });

    const companyId = req.tenantId;
    const { lead_id, conversation_id, intent } = parsed.data;

    const lead = await leadRepository.findById(companyId, lead_id);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found or does not belong to your company');

    const settings = await schedulingSettingsRepository.get(companyId);
    const bookingMode = settings.chatbotBookingMode ?? 'manual_request';

    if (bookingMode === 'off') {
      return res.json({
        action: 'disabled',
        message: 'Chatbot scheduling is disabled for this company.',
      });
    }

    if (!intent.wantsBooking) {
      return res.json({
        action: 'no_intent',
        message: 'Lead did not express scheduling intent.',
      });
    }

    const leadName = lead.name || lead.channel || 'Lead';
    const prefStr = intent.preferredDate ? ` for ${intent.preferredDate}${intent.preferredTime ? ' ' + intent.preferredTime : ''}` : '';

    const request = await schedulingRequestRepository.create({
      companyId,
      leadId: lead_id,
      conversationId: conversation_id ?? null,
      source: 'chatbot',
      requestType: intent.requestType || settings.chatbotBookingDefaultType || 'call',
      preferredDate: intent.preferredDate ?? null,
      preferredTime: intent.preferredTime ?? null,
      preferredTimeWindow: intent.preferredTimeWindow ?? {},
      preferredTimezone: intent.timezone || settings.timezone || 'Europe/Zagreb',
      availabilityMode: 'manual',
      notes: intent.notes ?? null,
      metadata: { rawIntent: intent, bookingMode },
    });

    logLeadActivity({
      companyId, leadId: lead_id, eventType: 'scheduling_request_created',
      actorType: 'system', actorUserId: null,
      metadata: {
        schedulingRequestId: request.id,
        requestType: request.requestType,
        source: 'chatbot',
        message: `Chatbot scheduling request: ${request.requestType}${prefStr}`,
      },
    }).catch(() => {});

    notificationRepository.create(companyId, {
      leadId: lead_id, type: 'scheduling_request',
      title: 'New scheduling request from chatbot',
      body: `${leadName} wants to schedule ${(request.requestType || 'call').replace(/_/g, ' ')}${prefStr}`,
      url: `/inbox/${lead_id}`,
    }).catch(() => {});

    let nextMessageHint = 'Thank you! Our team will contact you shortly to schedule your appointment.';
    if (intent.preferredDate) {
      nextMessageHint = `Thank you! We've noted your preference${prefStr}. Our team will confirm shortly.`;
    }

    res.status(201).json({
      action: 'request_created',
      schedulingRequestId: request.id,
      request,
      nextMessageHint,
    });
  } catch (err) {
    console.error('[chatbot/scheduling] intake error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to process scheduling intake');
  }
});

/**
 * POST /api/chatbot/scheduling/conversations/:conversationId/book-slot
 * Book a slot from the chatbot conversation flow.
 */
router.post('/conversations/:conversationId/book-slot', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { conversationId } = req.params;
    const body = req.body || {};
    const slotStartAt = body.slotStartAt || body.slot_start_at || body.startAt || body.start_at;
    const resolvedType = body.appointmentType || body.appointment_type || 'call';
    const resolvedLeadId = body.leadId || body.lead_id;

    if (!slotStartAt) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'slotStartAt is required (ISO datetime)');
    }
    if (!resolvedLeadId) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'leadId is required to create an appointment');
    }

    const startDate = new Date(slotStartAt);
    if (isNaN(startDate.getTime())) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'slotStartAt must be a valid ISO datetime');
    }

    const conv = await chatConversationRepository.getConversation(conversationId, companyId);
    if (!conv) {
      return errorJson(res, 404, 'NOT_FOUND', 'Conversation not found');
    }

    const lead = await leadRepository.findById(companyId, resolvedLeadId);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found or does not belong to your company');
    }

    const settings = await schedulingSettingsRepository.get(companyId);
    const slotDuration = settings.slotDurationMinutes || settings.slot_duration_minutes || 30;
    const endDate = new Date(startDate.getTime() + slotDuration * 60000);

    const available = await isSlotAvailable(companyId, slotStartAt, endDate.toISOString());
    if (!available) {
      return errorJson(res, 409, 'CONFLICT', 'This time slot is no longer available');
    }

    const leadName = lead.name || lead.channel || 'Lead';
    const typeLabel = resolvedType.replace(/_/g, ' ');
    const title = body.title || `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} - ${leadName}`;

    const appointment = await appointmentRepository.create({
      companyId,
      leadId: resolvedLeadId,
      title,
      appointmentType: resolvedType,
      status: 'scheduled',
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      timezone: settings.timezone || 'Europe/Zagreb',
      notes: body.notes || null,
      source: 'chatbot',
      reminderMinutesBefore: 60,
      createdByUserId: req.user?.id || null,
    });

    await chatConversationRepository.updateState(conversationId, companyId, {
      last_asked_field: BOOKING_STATES.CONFIRMED,
    });
    await chatConversationRepository.updateBookingState(conversationId, companyId, {
      completedAppointmentId: appointment.id,
      confirmedAt: new Date().toISOString(),
    });

    const slotLabel = startDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' })
      + ' at ' + startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const confirmMsg = `Your ${typeLabel} has been confirmed for ${slotLabel}. We look forward to speaking with you!`;
    await chatMessagesRepository.appendMessage(conversationId, 'assistant', confirmMsg);

    logLeadActivity({
      companyId, leadId: resolvedLeadId, eventType: 'appointment_created',
      actorType: 'system', actorUserId: null,
      metadata: {
        appointmentId: appointment.id,
        appointmentType: resolvedType,
        source: 'chatbot',
        conversationId,
        message: `Chatbot booking: ${typeLabel} on ${slotLabel}`,
      },
    }).catch(() => {});

    notificationRepository.create(companyId, {
      leadId: resolvedLeadId,
      type: 'appointment_created',
      title: `Chatbot booking confirmed`,
      body: `${leadName} booked a ${typeLabel} — ${slotLabel}`,
      url: `/inbox/${resolvedLeadId}`,
    }).catch(() => {});

    sendAppointmentConfirmationEmail({
      to: null, leadName, appointmentTitle: title,
      appointmentType: resolvedType,
      startAt: startDate.toISOString(),
      timezone: settings.timezone || 'Europe/Zagreb',
    }).catch(() => {});

    console.info('[chatbot/book-slot] CONFIRMED', { conversationId, appointmentId: appointment.id, leadId: resolvedLeadId });

    res.status(201).json({
      assistant_message: confirmMsg,
      conversation_id: conversationId,
      booking: buildBookingPayload('confirmed', { appointment }),
    });
  } catch (err) {
    console.error('[chatbot/book-slot] error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to book slot');
  }
});

module.exports = router;
