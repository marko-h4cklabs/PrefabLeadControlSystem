const express = require('express');
const router = express.Router();
const { appointmentRepository, leadRepository, notificationRepository } = require('../../../db/repositories');
const { logLeadActivity } = require('../../../services/activityLogger');
const {
  createAppointmentSchema,
  updateAppointmentSchema,
  listAppointmentsSchema,
  upcomingSchema,
  cancelSchema,
} = require('../validators/appointmentSchemas');
const { errorJson } = require('../middleware/errors');

function validationError(res, parsed) {
  const err = parsed.error.flatten();
  const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {}).flat()?.[0] ?? 'Validation failed';
  return errorJson(res, 400, 'VALIDATION_ERROR', msg);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

// POST /api/appointments
router.post('/', async (req, res) => {
  try {
    const parsed = createAppointmentSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed);

    const { lead_id, title, appointment_type, status, start_at, end_at, timezone, notes, source, reminder_minutes_before } = parsed.data;
    const companyId = req.tenantId;

    const lead = await leadRepository.findById(companyId, lead_id);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found or does not belong to your company');

    const derivedTitle = title || `${(appointment_type || 'call').replace('_', ' ')} - ${lead.name || lead.channel || 'Lead'}`;

    const appointment = await appointmentRepository.create({
      companyId,
      leadId: lead_id,
      title: derivedTitle,
      appointmentType: appointment_type,
      status,
      startAt: start_at,
      endAt: end_at,
      timezone,
      notes,
      source,
      reminderMinutesBefore: reminder_minutes_before,
      createdByUserId: req.user?.id ?? null,
    });

    logLeadActivity({
      companyId,
      leadId: lead_id,
      eventType: 'appointment_created',
      actorType: req.user?.role === 'admin' ? 'admin' : 'user',
      actorUserId: req.user?.id,
      metadata: { appointmentId: appointment.id, type: appointment_type, startAt: start_at },
    }).catch(() => {});

    const leadName = lead.name || lead.channel || 'Lead';
    notificationRepository.create(companyId, {
      leadId: lead_id,
      type: 'appointment',
      title: 'Appointment scheduled',
      body: `${derivedTitle} with ${leadName} on ${fmtTime(start_at)}`,
      url: `/inbox/${lead_id}`,
    }).catch(() => {});

    res.status(201).json(appointment);
  } catch (err) {
    console.error('[appointments] create error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create appointment');
  }
});

// GET /api/appointments
router.get('/', async (req, res) => {
  try {
    const parsed = listAppointmentsSchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed);

    const { from, to, status, appointment_type, source, lead_id, limit, offset } = parsed.data;
    const companyId = req.tenantId;
    const opts = { from, to, status, appointmentType: appointment_type, source, leadId: lead_id, limit, offset };

    const [items, total] = await Promise.all([
      appointmentRepository.list(companyId, opts),
      appointmentRepository.count(companyId, opts),
    ]);

    res.json({
      items,
      total,
      range: { from: from ?? null, to: to ?? null },
    });
  } catch (err) {
    console.error('[appointments] list error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list appointments');
  }
});

// GET /api/appointments/upcoming
router.get('/upcoming', async (req, res) => {
  try {
    const parsed = upcomingSchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed);

    const items = await appointmentRepository.upcoming(req.tenantId, {
      limit: parsed.data.limit,
      withinDays: parsed.data.within_days,
    });

    res.json({ items });
  } catch (err) {
    console.error('[appointments] upcoming error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to fetch upcoming appointments');
  }
});

// GET /api/appointments/:id
router.get('/:id', async (req, res) => {
  try {
    const appointment = await appointmentRepository.findById(req.tenantId, req.params.id);
    if (!appointment) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');
    res.json(appointment);
  } catch (err) {
    console.error('[appointments] get error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to fetch appointment');
  }
});

// PATCH /api/appointments/:id
router.patch('/:id', async (req, res) => {
  try {
    const parsed = updateAppointmentSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed);

    const companyId = req.tenantId;
    const existing = await appointmentRepository.findById(companyId, req.params.id);
    if (!existing) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    if ((parsed.data.start_at || parsed.data.end_at) && !(parsed.data.start_at && parsed.data.end_at)) {
      const effectiveStart = new Date(parsed.data.start_at || existing.start_at);
      const effectiveEnd = new Date(parsed.data.end_at || existing.end_at);
      if (effectiveEnd <= effectiveStart) {
        return errorJson(res, 400, 'VALIDATION_ERROR', 'end_at must be after start_at');
      }
    }

    const updated = await appointmentRepository.update(companyId, req.params.id, parsed.data);
    if (!updated) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    const eventType = parsed.data.status === 'cancelled' ? 'appointment_cancelled' : 'appointment_updated';
    logLeadActivity({
      companyId,
      leadId: existing.lead_id,
      eventType,
      actorType: req.user?.role === 'admin' ? 'admin' : 'user',
      actorUserId: req.user?.id,
      metadata: { appointmentId: updated.id, changes: Object.keys(parsed.data) },
    }).catch(() => {});

    if (parsed.data.status === 'cancelled' || parsed.data.start_at) {
      const notifTitle = parsed.data.status === 'cancelled' ? 'Appointment cancelled' : 'Appointment rescheduled';
      const leadName = updated.lead?.name || 'Lead';
      notificationRepository.create(companyId, {
        leadId: existing.lead_id,
        type: 'appointment',
        title: notifTitle,
        body: `${updated.title} with ${leadName} – ${fmtTime(updated.start_at)}`,
        url: `/inbox/${existing.lead_id}`,
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) {
    console.error('[appointments] update error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update appointment');
  }
});

// POST /api/appointments/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  try {
    const parsed = cancelSchema.safeParse(req.body || {});
    if (!parsed.success) return validationError(res, parsed);

    const companyId = req.tenantId;
    const existing = await appointmentRepository.findById(companyId, req.params.id);
    if (!existing) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');
    if (existing.status === 'cancelled') return errorJson(res, 409, 'CONFLICT', 'Appointment is already cancelled');

    const cancelled = await appointmentRepository.cancel(companyId, req.params.id, parsed.data.note);
    if (!cancelled) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    logLeadActivity({
      companyId,
      leadId: existing.lead_id,
      eventType: 'appointment_cancelled',
      actorType: req.user?.role === 'admin' ? 'admin' : 'user',
      actorUserId: req.user?.id,
      metadata: { appointmentId: cancelled.id, note: parsed.data.note },
    }).catch(() => {});

    const leadName = cancelled.lead?.name || 'Lead';
    notificationRepository.create(companyId, {
      leadId: existing.lead_id,
      type: 'appointment',
      title: 'Appointment cancelled',
      body: `${cancelled.title} with ${leadName} – ${fmtTime(cancelled.start_at)}`,
      url: `/inbox/${existing.lead_id}`,
    }).catch(() => {});

    res.json(cancelled);
  } catch (err) {
    console.error('[appointments] cancel error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to cancel appointment');
  }
});

module.exports = router;
