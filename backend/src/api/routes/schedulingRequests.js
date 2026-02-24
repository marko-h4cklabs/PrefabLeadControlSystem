const express = require('express');
const router = express.Router();
const { schedulingRequestRepository, leadRepository, appointmentRepository, notificationRepository } = require('../../../db/repositories');
const googleCalendarService = require('../../services/googleCalendarService');
const { logLeadActivity } = require('../../../services/activityLogger');
const {
  createSchedulingRequestSchema,
  updateSchedulingRequestSchema,
  listSchedulingRequestsSchema,
} = require('../validators/schedulingRequestSchemas');
const {
  createAppointmentSchema,
} = require('../validators/appointmentSchemas');
const { errorJson } = require('../middleware/errors');

function validationError(res, parsed, debugCtx) {
  const err = parsed.error.flatten();
  const fieldMsgs = Object.entries(err.fieldErrors ?? {})
    .map(([f, msgs]) => `${f}: ${(msgs || []).join(', ')}`)
    .filter(Boolean);
  const msg = err.formErrors?.[0] || fieldMsgs.join('; ') || 'Validation failed';
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[scheduling-requests] validation failed:', { msg, fields: Object.keys(err.fieldErrors ?? {}), ...debugCtx });
  }
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg, fields: err.fieldErrors } });
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return String(iso); }
}

function logDbError(tag, err, extra = {}) {
  console.error(`[scheduling-requests] ${tag}:`, { message: err.message, code: err.code, detail: err.detail, ...extra });
}

// POST /api/scheduling-requests
router.post('/', async (req, res) => {
  try {
    const parsed = createSchedulingRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed, { route: 'POST /', bodyKeys: Object.keys(req.body || {}) });

    const companyId = req.tenantId;
    const d = parsed.data;

    const lead = await leadRepository.findById(companyId, d.lead_id);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found or does not belong to your company');

    const request = await schedulingRequestRepository.create({
      companyId,
      leadId: d.lead_id,
      conversationId: d.conversation_id ?? null,
      source: d.source,
      requestType: d.request_type,
      preferredDate: d.preferred_date ?? null,
      preferredTime: d.preferred_time ?? null,
      preferredTimeWindow: d.preferred_time_window ?? {},
      preferredTimezone: d.preferred_timezone,
      availabilityMode: d.availability_mode,
      selectedSlotStartAt: d.selected_slot_start_at ?? null,
      selectedSlotEndAt: d.selected_slot_end_at ?? null,
      notes: d.notes ?? null,
      metadata: d.metadata ?? {},
      createdByUserId: req.user?.id ?? null,
    });

    const leadName = lead.name || lead.channel || 'Lead';
    const prefStr = d.preferred_date ? ` for ${d.preferred_date}${d.preferred_time ? ' ' + d.preferred_time : ''}` : '';

    logLeadActivity({
      companyId, leadId: d.lead_id, eventType: 'scheduling_request_created',
      actorType: d.source === 'chatbot' ? 'system' : (req.user?.role === 'admin' ? 'admin' : 'user'),
      actorUserId: req.user?.id,
      metadata: { schedulingRequestId: request.id, requestType: d.request_type, message: `Scheduling request created: ${d.request_type}${prefStr}` },
    }).catch(() => {});

    notificationRepository.create(companyId, {
      leadId: d.lead_id, type: 'scheduling_request',
      title: 'New scheduling request',
      body: `${leadName} requested ${d.request_type.replace(/_/g, ' ')}${prefStr}`,
      url: `/inbox/${d.lead_id}`,
    }).catch(() => {});

    res.status(201).json(request);
  } catch (err) {
    logDbError('create', err);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create scheduling request');
  }
});

// GET /api/scheduling-requests
router.get('/', async (req, res) => {
  try {
    const parsed = listSchedulingRequestsSchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed, { route: 'GET /' });

    const companyId = req.tenantId;
    const { status, lead_id, request_type, limit, offset } = parsed.data;
    const opts = { status, leadId: lead_id, requestType: request_type, limit, offset };

    const [items, total] = await Promise.all([
      schedulingRequestRepository.list(companyId, opts),
      schedulingRequestRepository.count(companyId, opts),
    ]);

    res.json({ items, total });
  } catch (err) {
    logDbError('list', err);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list scheduling requests');
  }
});

// GET /api/scheduling-requests/:id
router.get('/:id', async (req, res) => {
  try {
    const request = await schedulingRequestRepository.findById(req.tenantId, req.params.id);
    if (!request) return errorJson(res, 404, 'NOT_FOUND', 'Scheduling request not found');
    res.json(request);
  } catch (err) {
    logDbError('get', err, { id: req.params.id });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to fetch scheduling request');
  }
});

// PATCH /api/scheduling-requests/:id
router.patch('/:id', async (req, res) => {
  try {
    const parsed = updateSchedulingRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed, { route: 'PATCH /:id' });

    const companyId = req.tenantId;
    const existing = await schedulingRequestRepository.findById(companyId, req.params.id);
    if (!existing) return errorJson(res, 404, 'NOT_FOUND', 'Scheduling request not found');

    const updated = await schedulingRequestRepository.update(companyId, req.params.id, parsed.data);
    if (!updated) return errorJson(res, 404, 'NOT_FOUND', 'Scheduling request not found');

    res.json(updated);
  } catch (err) {
    logDbError('update', err, { id: req.params.id });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update scheduling request');
  }
});

// POST /api/scheduling-requests/:id/convert-to-appointment
router.post('/:id/convert-to-appointment', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const existing = await schedulingRequestRepository.findById(companyId, req.params.id);
    if (!existing) return errorJson(res, 404, 'NOT_FOUND', 'Scheduling request not found');
    if (existing.status === 'converted') return errorJson(res, 409, 'CONFLICT', 'Request already converted');
    if (existing.status === 'cancelled') return errorJson(res, 409, 'CONFLICT', 'Request is cancelled');

    let startAt = existing.selectedSlotStartAt;
    let endAt = existing.selectedSlotEndAt;
    let appointmentType = existing.requestType || 'call';
    let title = null;
    let notes = existing.notes;
    let timezone = existing.preferredTimezone || 'Europe/Zagreb';
    let reminderMinutesBefore = null;

    if (req.body && Object.keys(req.body).length > 0) {
      const body = { ...req.body };
      if (!body.lead_id && !body.leadId) {
        body.lead_id = existing.leadId;
        body.leadId = existing.leadId;
      }
      if (!body.source) body.source = existing.source || 'chatbot';
      const apptParsed = createAppointmentSchema.safeParse(body);
      if (!apptParsed.success) return validationError(res, apptParsed, { route: 'POST /:id/convert' });
      startAt = apptParsed.data.start_at;
      endAt = apptParsed.data.end_at;
      appointmentType = apptParsed.data.appointment_type || appointmentType;
      title = apptParsed.data.title || null;
      notes = apptParsed.data.notes || notes;
      timezone = apptParsed.data.timezone || timezone;
      reminderMinutesBefore = apptParsed.data.reminder_minutes_before ?? null;
    }

    if (!startAt || !endAt) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Cannot convert: no slot times. Provide startAt/endAt in body or ensure request has selected slot.');
    }

    const lead = await leadRepository.findById(companyId, existing.leadId);
    const leadName = lead?.name || lead?.channel || 'Lead';
    const derivedTitle = title || `${appointmentType.replace(/_/g, ' ')} - ${leadName}`;

    const appointment = await appointmentRepository.create({
      companyId,
      leadId: existing.leadId,
      title: derivedTitle,
      appointmentType,
      status: 'scheduled',
      startAt,
      endAt,
      timezone,
      notes,
      source: existing.source || 'chatbot',
      reminderMinutesBefore,
      createdByUserId: req.user?.id ?? null,
    });

    await schedulingRequestRepository.update(companyId, req.params.id, {
      status: 'converted',
      converted_appointment_id: appointment.id,
    });

    googleCalendarService.syncNewAppointmentToGoogle(companyId, appointment, lead).catch((err) =>
      console.error('[scheduling-requests] Google sync:', err.message)
    );

    const updatedRequest = await schedulingRequestRepository.findById(companyId, req.params.id);

    logLeadActivity({
      companyId, leadId: existing.leadId, eventType: 'scheduling_request_converted',
      actorType: req.user?.role === 'admin' ? 'admin' : 'user',
      actorUserId: req.user?.id,
      metadata: {
        schedulingRequestId: existing.id,
        appointmentId: appointment.id,
        message: `Scheduling request converted to appointment: ${derivedTitle} on ${fmtTime(startAt)}`,
      },
    }).catch(() => {});

    logLeadActivity({
      companyId, leadId: existing.leadId, eventType: 'appointment_created',
      actorType: req.user?.role === 'admin' ? 'admin' : 'user',
      actorUserId: req.user?.id,
      metadata: { appointmentId: appointment.id, type: appointmentType, fromSchedulingRequest: true, message: `Appointment scheduled: ${derivedTitle} on ${fmtTime(startAt)}` },
    }).catch(() => {});

    notificationRepository.create(companyId, {
      leadId: existing.leadId, type: 'appointment',
      title: 'Appointment booked from request',
      body: `${derivedTitle} with ${leadName} on ${fmtTime(startAt)}`,
      url: `/inbox/${existing.leadId}`,
    }).catch(() => {});

    res.status(201).json({ request: updatedRequest, appointment });
  } catch (err) {
    logDbError('convert', err, { id: req.params.id });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to convert scheduling request to appointment');
  }
});

module.exports = router;
