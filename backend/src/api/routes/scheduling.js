const express = require('express');
const router = express.Router();
const { getAvailability, isSlotAvailable } = require('../../../services/availabilityService');
const { normalizeSchedulingSettings } = require('../../../services/schedulingNormalizer');
const { appointmentRepository, leadRepository, notificationRepository, schedulingSettingsRepository, chatConversationRepository, chatMessagesRepository } = require('../../../db/repositories');
const { logLeadActivity } = require('../../../services/activityLogger');
const { sendAppointmentConfirmationEmail } = require('../../../services/appointmentEmailService');
const { errorJson } = require('../middleware/errors');

/**
 * GET /api/scheduling/availability
 * Returns available appointment slots for the tenant company.
 */
router.get('/availability', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { startDate, endDate, appointmentType, limit } = req.query;
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50) : 10;

    const result = await getAvailability(companyId, {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      appointmentType: appointmentType || undefined,
      limit: parsedLimit,
    });

    res.json({
      slots: result.slots,
      settingsSummary: result.settingsSummary || {
        enabled: true,
        timezone: result.timezone,
        slotDurationMinutes: result.slotDurationMinutes,
      },
      debug: result.debug,
    });
  } catch (err) {
    console.error('[scheduling/availability] error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to compute availability');
  }
});

const VALID_APPOINTMENT_TYPES = new Set(['call', 'site_visit', 'meeting', 'follow_up', 'consultation', 'video_call']);

/**
 * Shared handler for all book-slot routes.
 * Accepts both snake_case and camelCase body fields.
 */
async function handleBookSlot(req, res) {
  try {
    const companyId = req.tenantId || req.params.companyId;
    if (!companyId) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'company_id could not be resolved');
    }
    const body = req.body || {};

    const resolvedLeadId = body.leadId || body.lead_id;
    const resolvedStartAt = body.startAt || body.start_at;
    const resolvedEndAt = body.endAt || body.end_at;
    let resolvedType = body.appointmentType || body.appointment_type || 'call';
    const resolvedSource = body.source || 'chatbot';
    const resolvedTimezone = body.timezone || null;
    const resolvedTitle = body.title || null;
    const resolvedNotes = body.notes || null;
    const resolvedReminder = body.reminder_minutes_before ?? body.reminderMinutesBefore ?? 60;
    const conversationId = body.conversationId || body.conversation_id || null;

    console.info('[scheduling/book-slot] hit', { companyId, leadId: resolvedLeadId, startAt: resolvedStartAt, type: resolvedType, source: resolvedSource });

    let typeWarning = null;
    if (resolvedType && !VALID_APPOINTMENT_TYPES.has(resolvedType)) {
      typeWarning = `Unknown appointment_type "${resolvedType}", defaulting to "call"`;
      resolvedType = 'call';
    }

    if (!resolvedLeadId) return errorJson(res, 400, 'VALIDATION_ERROR', 'leadId is required');
    if (!resolvedStartAt) return errorJson(res, 400, 'VALIDATION_ERROR', 'startAt is required (ISO datetime)');

    const startDate = new Date(resolvedStartAt);
    if (isNaN(startDate.getTime())) return errorJson(res, 400, 'VALIDATION_ERROR', 'startAt must be a valid ISO datetime');

    const lead = await leadRepository.findById(companyId, resolvedLeadId);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found or does not belong to your company');

    const rawSettings = await schedulingSettingsRepository.get(companyId);
    const cfg = normalizeSchedulingSettings(rawSettings);
    const tz = resolvedTimezone || cfg.timezone || 'Europe/Zagreb';

    let endDate;
    if (resolvedEndAt) {
      endDate = new Date(resolvedEndAt);
      if (isNaN(endDate.getTime())) return errorJson(res, 400, 'VALIDATION_ERROR', 'endAt must be a valid ISO datetime');
    } else {
      endDate = new Date(startDate.getTime() + cfg.slotDurationMinutes * 60000);
    }

    const available = await isSlotAvailable(companyId, startDate.toISOString(), endDate.toISOString());
    if (!available) {
      console.info('[scheduling/book-slot] CONFLICT', { companyId, leadId: resolvedLeadId, startAt: resolvedStartAt });
      return errorJson(res, 409, 'CONFLICT', 'This time slot is no longer available. Please choose another.');
    }

    const leadName = lead.name || lead.channel || 'Lead';
    const typeLabel = resolvedType.replace(/_/g, ' ');
    const derivedTitle = resolvedTitle || `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} - ${leadName}`;

    const appointment = await appointmentRepository.create({
      companyId,
      leadId: resolvedLeadId,
      title: derivedTitle,
      appointmentType: resolvedType,
      status: 'scheduled',
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      timezone: tz,
      notes: resolvedNotes,
      source: resolvedSource,
      reminderMinutesBefore: resolvedReminder,
      createdByUserId: req.user?.id || null,
    });

    logLeadActivity({
      companyId, leadId: resolvedLeadId, eventType: 'appointment_created',
      actorType: resolvedSource === 'chatbot' ? 'system' : 'user',
      actorUserId: req.user?.id || null,
      metadata: {
        appointmentId: appointment.id,
        appointmentType: resolvedType,
        source: resolvedSource,
        conversationId,
        message: `Appointment scheduled: ${typeLabel} on ${startDate.toISOString().slice(0, 16).replace('T', ' ')}`,
      },
    }).catch(() => {});

    notificationRepository.create(companyId, {
      leadId: resolvedLeadId,
      type: 'appointment_created',
      title: `New ${typeLabel} scheduled`,
      body: `${leadName} — ${startDate.toLocaleDateString('en-GB')} at ${startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
      url: `/inbox/${resolvedLeadId}`,
    }).catch(() => {});

    sendAppointmentConfirmationEmail({
      to: null, leadName, appointmentTitle: derivedTitle,
      appointmentType: resolvedType, startAt: startDate.toISOString(), timezone: tz,
    }).catch(() => {});

    const slotLabel = startDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' })
      + ' at ' + startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const confirmationText = `Great — your ${typeLabel} is scheduled for ${slotLabel} (${tz}). We'll reach out then.`;

    // Update conversation booking state if conversationId provided
    if (conversationId) {
      try {
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: '__booking_confirmed' });
        await chatConversationRepository.updateBookingState(conversationId, companyId, {
          completedAppointmentId: appointment.id,
          confirmedAt: new Date().toISOString(),
          dismissed: false,
        });
        await chatMessagesRepository.appendMessage(conversationId, 'assistant', confirmationText);
      } catch (convErr) {
        console.warn('[scheduling/book-slot] conversation state update failed (non-blocking):', convErr.message);
      }
    }

    console.info('[scheduling/book-slot] CREATED', { companyId, appointmentId: appointment.id, leadId: resolvedLeadId, conversationId });

    const response = {
      success: true,
      appointment,
      booking: {
        confirmed: true,
        startAt: startDate.toISOString(),
        endAt: endDate.toISOString(),
        timezone: tz,
        appointmentId: appointment.id,
        confirmationText,
      },
    };
    if (typeWarning) response.warning = typeWarning;
    res.status(201).json(response);
  } catch (err) {
    console.error('[scheduling/book-slot] error:', err.message, err.code, err.detail);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to book appointment');
  }
}

router.post('/book', handleBookSlot);
router.post('/book-slot', handleBookSlot);

module.exports = router;
module.exports.handleBookSlot = handleBookSlot;
