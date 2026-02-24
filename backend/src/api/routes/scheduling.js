const express = require('express');
const router = express.Router();
const { getAvailability, isSlotAvailable } = require('../../../services/availabilityService');
const { normalizeSchedulingSettings } = require('../../../services/schedulingNormalizer');
const googleCalendarService = require('../../services/googleCalendarService');
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

    console.info('[scheduling/availability] request', { companyId, startDate, endDate, appointmentType, limit: parsedLimit });

    const result = await getAvailability(companyId, {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      appointmentType: appointmentType || undefined,
      limit: parsedLimit,
    });

    console.info('[scheduling/availability] returning', { slotCount: result.slots.length, reason: result.debug?.reason });

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
 * Pick the first defined value from an object for a list of candidate keys.
 */
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

/**
 * Normalize the incoming book-slot body from any frontend shape into canonical fields.
 * Tolerant to snake_case, camelCase, nested `slot.*`, nested `lead.*`.
 */
function normalizeBookSlotBody(raw) {
  const body = raw || {};
  const slot = (typeof body.slot === 'object' && body.slot) || {};
  const lead = (typeof body.lead === 'object' && body.lead) || {};

  return {
    leadId:          pick(body, 'leadId', 'lead_id') || lead.id || null,
    startAt:         pick(body, 'startAt', 'start_at', 'start', 'slotStart', 'slot_start')
                  || pick(slot, 'startAt', 'start_at', 'start') || null,
    endAt:           pick(body, 'endAt', 'end_at', 'end', 'slotEnd', 'slot_end')
                  || pick(slot, 'endAt', 'end_at', 'end') || null,
    appointmentType: pick(body, 'appointmentType', 'appointment_type', 'type')
                  || pick(slot, 'appointmentType', 'appointment_type') || 'call',
    timezone:        pick(body, 'timezone', 'timeZone') || pick(slot, 'timezone', 'timeZone') || null,
    source:          pick(body, 'source') || 'chatbot',
    title:           pick(body, 'title') || null,
    notes:           pick(body, 'notes') || null,
    reminderMinutesBefore: body.reminder_minutes_before ?? body.reminderMinutesBefore ?? 60,
    conversationId:  pick(body, 'conversationId', 'conversation_id') || null,
  };
}

/**
 * Shared handler for all book-slot routes.
 * Accepts snake_case, camelCase, and nested slot/lead objects.
 */
async function handleBookSlot(req, res) {
  try {
    const companyId = req.tenantId || req.params.companyId;
    if (!companyId) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'company_id could not be resolved');
    }

    const n = normalizeBookSlotBody(req.body);

    console.info('[scheduling/book-slot] hit', {
      companyId,
      hasLeadId: !!n.leadId, hasStartAt: !!n.startAt, hasEndAt: !!n.endAt,
      type: n.appointmentType, source: n.source,
      receivedKeys: Object.keys(req.body || {}),
    });

    let resolvedType = n.appointmentType;
    let typeWarning = null;
    if (resolvedType && !VALID_APPOINTMENT_TYPES.has(resolvedType)) {
      typeWarning = `Unknown appointment_type "${resolvedType}", defaulting to "call"`;
      resolvedType = 'call';
    }

    if (!n.leadId) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'leadId is required',
          details: {
            receivedKeys: Object.keys(req.body || {}),
            normalized: { hasLeadId: false, hasStartAt: !!n.startAt, hasEndAt: !!n.endAt, hasAppointmentType: !!n.appointmentType },
          },
        },
      });
    }
    if (!n.startAt) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'startAt is required (ISO datetime)',
          details: {
            receivedKeys: Object.keys(req.body || {}),
            normalized: { hasLeadId: !!n.leadId, hasStartAt: false, hasEndAt: !!n.endAt, hasAppointmentType: !!n.appointmentType },
          },
        },
      });
    }

    const startDate = new Date(n.startAt);
    if (isNaN(startDate.getTime())) return errorJson(res, 400, 'VALIDATION_ERROR', 'startAt must be a valid ISO datetime');

    const lead = await leadRepository.findById(companyId, n.leadId);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found or does not belong to your company');

    const rawSettings = await schedulingSettingsRepository.get(companyId);
    const cfg = normalizeSchedulingSettings(rawSettings);
    const tz = n.timezone || cfg.timezone || 'Europe/Zagreb';

    let endDate;
    if (n.endAt) {
      endDate = new Date(n.endAt);
      if (isNaN(endDate.getTime())) return errorJson(res, 400, 'VALIDATION_ERROR', 'endAt must be a valid ISO datetime');
    } else {
      endDate = new Date(startDate.getTime() + cfg.slotDurationMinutes * 60000);
    }

    const available = await isSlotAvailable(companyId, startDate.toISOString(), endDate.toISOString());
    if (!available) {
      console.info('[scheduling/book-slot] CONFLICT', { companyId, hasLeadId: true });
      return errorJson(res, 409, 'CONFLICT', 'This time slot is no longer available. Please choose another.');
    }

    const leadName = lead.name || lead.channel || 'Lead';
    const typeLabel = resolvedType.replace(/_/g, ' ');
    const derivedTitle = n.title || `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} - ${leadName}`;

    const appointment = await appointmentRepository.create({
      companyId,
      leadId: n.leadId,
      title: derivedTitle,
      appointmentType: resolvedType,
      status: 'scheduled',
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      timezone: tz,
      notes: n.notes,
      source: n.source,
      reminderMinutesBefore: n.reminderMinutesBefore,
      createdByUserId: req.user?.id || null,
    });

    logLeadActivity({
      companyId, leadId: n.leadId, eventType: 'appointment_created',
      actorType: n.source === 'chatbot' ? 'system' : 'user',
      actorUserId: req.user?.id || null,
      metadata: {
        appointmentId: appointment.id,
        appointmentType: resolvedType,
        source: n.source,
        conversationId: n.conversationId,
        message: `Appointment scheduled: ${typeLabel} on ${startDate.toISOString().slice(0, 16).replace('T', ' ')}`,
      },
    }).catch(() => {});

    notificationRepository.create(companyId, {
      leadId: n.leadId,
      type: 'appointment_created',
      title: `New ${typeLabel} scheduled`,
      body: `${leadName} — ${startDate.toLocaleDateString('en-GB')} at ${startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
      url: `/inbox/${n.leadId}`,
    }).catch(() => {});

    googleCalendarService.syncNewAppointmentToGoogle(companyId, appointment, lead).catch((err) =>
      console.error('[scheduling/book-slot] Google sync:', err.message)
    );

    sendAppointmentConfirmationEmail({
      to: null, leadName, appointmentTitle: derivedTitle,
      appointmentType: resolvedType, startAt: startDate.toISOString(), timezone: tz,
    }).catch(() => {});

    const slotLabel = startDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' })
      + ' at ' + startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const confirmationText = `Great — your ${typeLabel} is scheduled for ${slotLabel} (${tz}). We'll reach out then.`;

    if (n.conversationId) {
      try {
        await chatConversationRepository.updateState(n.conversationId, companyId, { last_asked_field: '__booking_confirmed' });
        await chatConversationRepository.updateBookingState(n.conversationId, companyId, {
          completedAppointmentId: appointment.id,
          confirmedAt: new Date().toISOString(),
          dismissed: false,
        });
        await chatMessagesRepository.appendMessage(n.conversationId, 'assistant', confirmationText);
      } catch (convErr) {
        console.warn('[scheduling/book-slot] conversation state update failed (non-blocking):', convErr.message);
      }
    }

    console.info('[scheduling/book-slot] CREATED', { companyId, appointmentId: appointment.id });

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
