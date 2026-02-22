const express = require('express');
const router = express.Router();
const { getAvailability, isSlotAvailable } = require('../../../services/availabilityService');
const { normalizeSchedulingSettings } = require('../../../services/schedulingNormalizer');
const { appointmentRepository, leadRepository, notificationRepository, schedulingSettingsRepository } = require('../../../db/repositories');
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

/**
 * POST /api/scheduling/book
 * Book an appointment slot. Validates availability before creating.
 */
router.post('/book', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const body = req.body || {};
    const { leadId, lead_id, startAt, start_at, appointmentType, appointment_type, title, notes, source } = body;

    const resolvedLeadId = leadId || lead_id;
    const resolvedStartAt = startAt || start_at;
    const resolvedType = appointmentType || appointment_type || 'call';
    const resolvedSource = source || 'manual';

    if (!resolvedLeadId) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'leadId is required');
    }
    if (!resolvedStartAt) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'startAt is required (ISO datetime)');
    }

    const startDate = new Date(resolvedStartAt);
    if (isNaN(startDate.getTime())) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'startAt must be a valid ISO datetime');
    }

    const lead = await leadRepository.findById(companyId, resolvedLeadId);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found or does not belong to your company');
    }

    const rawSettings = await schedulingSettingsRepository.get(companyId);
    const cfg = normalizeSchedulingSettings(rawSettings);
    const endDate = new Date(startDate.getTime() + cfg.slotDurationMinutes * 60000);

    const available = await isSlotAvailable(companyId, resolvedStartAt, endDate.toISOString());
    if (!available) {
      return errorJson(res, 409, 'CONFLICT', 'This time slot is no longer available. Please choose another.');
    }

    const leadName = lead.name || lead.channel || 'Lead';
    const typeLabel = resolvedType.replace(/_/g, ' ');
    const derivedTitle = title || `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} - ${leadName}`;

    const appointment = await appointmentRepository.create({
      companyId,
      leadId: resolvedLeadId,
      title: derivedTitle,
      appointmentType: resolvedType,
      status: 'scheduled',
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      timezone: cfg.timezone,
      notes: notes || null,
      source: resolvedSource,
      reminderMinutesBefore: 60,
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
      to: null,
      leadName,
      appointmentTitle: derivedTitle,
      appointmentType: resolvedType,
      startAt: startDate.toISOString(),
      timezone: cfg.timezone,
    }).catch(() => {});

    res.status(201).json({ appointment });
  } catch (err) {
    console.error('[scheduling/book] error:', err.message, err.code, err.detail);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to book appointment');
  }
});

module.exports = router;
