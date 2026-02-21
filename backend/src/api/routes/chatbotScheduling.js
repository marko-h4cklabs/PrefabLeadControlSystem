const express = require('express');
const router = express.Router();
const { schedulingSettingsRepository, schedulingRequestRepository, leadRepository, notificationRepository } = require('../../../db/repositories');
const { logLeadActivity } = require('../../../services/activityLogger');
const { chatbotIntakeSchema } = require('../validators/schedulingRequestSchemas');
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

    res.json({
      enabled: settings.enabled ?? false,
      chatbotOfferBooking: settings.chatbotOfferBooking ?? false,
      chatbotBookingMode: settings.chatbotBookingMode ?? 'manual_request',
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

module.exports = router;
